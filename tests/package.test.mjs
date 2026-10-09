// Guards the store-submission contract.
//
// Three layers:
//   1. The policy checks themselves (scripts/lib/policy.mjs), driven with fixtures
//      that MUST fail. The build calls the same functions, so a check that silently
//      stops matching is caught here rather than discovered by a reviewer.
//   2. The packages actually built from this tree — built into a temp directory,
//      so running the suite never touches (or deletes archives from) dist/ — and
//      their archives read back through independent zip readers.
//   3. The paperwork (README, privacy policy, store guide, build notes) checked
//      against the manifests, because a justification that disagrees with the
//      manifest costs a review cycle just like a bad package does.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { build, TARGET_NAMES } from '../scripts/build.mjs';
import {
  htmlReferences,
  injectedFiles,
  manifestReferences,
  PERMISSION_EVIDENCE,
  HOST_ACCESS_PERMISSIONS,
  BANNED_PERMISSIONS,
  scanSource,
  stripJsComments,
  verifyPackage,
  verifyPermissions,
} from '../scripts/lib/policy.mjs';
import { createZip, crc32, readZip } from '../scripts/lib/zip.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const declared = (file) => JSON.parse(readFileSync(join(ROOT, file), 'utf8'));

// ── 1. policy helpers ───────────────────────────────────────────────────────────

describe('source rules', () => {
  // Each fixture must produce at least one problem. Named after the hole it closes.
  const mustFail = {
    'remote <script>': '<script src="https://cdn.example.com/x.js"></script>',
    'protocol-relative <script>': '<script src="//cdn.example.com/x.js"></script>',
    'remote stylesheet <link>': '<link rel="stylesheet" href="https://fonts.example.com/a.css">',
    'remote <iframe>': '<iframe src="https://example.com/embed"></iframe>',
    'remote <img>': "<img src='//tracker.example.com/p.gif'>",
    'dynamic import()': "const m = await import('https://esm.example.com/lib.js');",
    'static import from URL': "import x from 'https://esm.example.com/lib.js';",
    'script.src assignment': "const s = document.createElement('script'); s.src = 'https://x.example/a.js';",
    'protocol-relative src assignment': 's.src = "//x.example/a.js";',
    'setAttribute src': "el.setAttribute('src', 'https://x.example/a.js');",
    'CSS @import url()': '<style>@import url(https://fonts.example.com/a.css);</style>',
    'CSS @import string': '@import "https://fonts.example.com/a.css";',
    'CSS url() in a JS string': "el.style.background = 'url(//img.example.com/a.png)';",
    'eval()': 'eval(code);',
    'new Function()': "const f = new Function('return 1');",
    'importScripts()': "importScripts('x.js');",
    'setTimeout with a string': "setTimeout('doThing()', 10);",
    'setInterval with a template string': 'setInterval(`tick()`, 10);',
    'fetch()': 'fetch(url).then(r => r.json());',
    'window.fetch()': 'window.fetch(url);',
    XMLHttpRequest: 'const x = new XMLHttpRequest();',
    'navigator.sendBeacon()': "navigator.sendBeacon('/log', data);",
    WebSocket: "const ws = new WebSocket('wss://x.example');",
    EventSource: "const es = new EventSource('/stream');",
    'fetch after a regex containing //': 'const re = /\\/\\//; fetch(url);',
    'fetch after a regex containing a quote': 'const re = /[\'"]/g; fetch(url);',
    'fetch inside a template substitution': 'const s = `${await fetch(url)}`;',
  };

  for (const [label, code] of Object.entries(mustFail)) {
    const name = /^\s*</.test(code) || code.startsWith('@import') ? 'x.html' : 'x.js';
    it(`rejects ${label}`, () => {
      const file = code.startsWith('@import') ? 'x.css' : name;
      expect(scanSource(file, code), code).not.toEqual([]);
    });
  }

  // And these must pass — each was, or would be, a false positive.
  const mustPass = {
    'the word fetch in a line comment': '// nothing here calls fetch(), by design\nconst a = 1;',
    'eval( in a block comment': '/* eval( is banned */ const a = 1;',
    'fetch( in an HTML comment': '<!-- fetch( --><p>hi</p>',
    'fetch in prose': "const msg = 'we never fetch anything';",
    'prefetch()': 'prefetch(x);',
    'page.evaluate()': 'await page.evaluate(() => 1);',
    'setTimeout with a function': 'setTimeout(() => go(), 10);',
    'local <script src>': '<script src="popup.js"></script>',
    'an anchor to a website': '<a href="https://github.com/x">source</a>',
    'a URL in a string': "const docs = 'https://playwright.dev';",
    'a regex with a URL scheme': 'const re = /https?:\\/\\//;',
    'a string that looks like a comment': "const s = '// not a comment'; const t = '/* nor this */';",
    'an apostrophe in HTML prose': "<p>Don't worry</p><script>const a = 1;</script>",
  };
  for (const [label, code] of Object.entries(mustPass)) {
    const file = /^\s*</.test(code) ? 'x.html' : 'x.js';
    it(`accepts ${label}`, () => {
      expect(scanSource(file, code)).toEqual([]);
    });
  }
});

describe('comment stripping', () => {
  it('removes comments but keeps strings, templates and regexes', () => {
    const src = [
      "const a = '/* keep */'; // drop me",
      'const b = `x ${ { y: 1 }.y } // keep`; /* drop',
      'me too */ const re = /\\/\\/[/]x/g;',
      'const c = a / 2; // drop',
    ].join('\n');
    const out = stripJsComments(src);
    expect(out).toContain("'/* keep */'");
    expect(out).toContain('`x ${ { y: 1 }.y } // keep`');
    expect(out).toContain('/\\/\\/[/]x/g');
    expect(out).toContain('a / 2');
    expect(out).not.toMatch(/drop/);
    expect(out.split('\n')).toHaveLength(4); // line numbers survive
  });

  it('never throws on unterminated input', () => {
    for (const s of ['/* open', "'open", '`open ${', '/[', 'a / b']) {
      expect(() => stripJsComments(s)).not.toThrow();
    }
  });
});

describe('permission checks', () => {
  const base = { permissions: ['storage'], host_permissions: ['http://*/*', 'https://*/*'] };

  it('accepts a permission the code calls', () => {
    expect(verifyPermissions(base, 'chrome.storage.local.get("x")')).toEqual([]);
    expect(verifyPermissions(base, 'browser.storage.local.get("x")')).toEqual([]);
  });

  it('does not count a comment as evidence', () => {
    // verifyPackage strips comments before handing code over; mirror that here.
    const code = stripJsComments('// chrome.storage.local is not used\nconst a = 1;');
    expect(verifyPermissions(base, code)).toHaveLength(1);
  });

  it('fails closed on a permission with no evidence rule', () => {
    expect(verifyPermissions({ permissions: ['bookmarks'] }, 'chrome.bookmarks.get()').join()).toMatch(
      /no entry in PERMISSION_EVIDENCE/
    );
  });

  it('bans tabs in permissions and optional_permissions alike', () => {
    expect(verifyPermissions({ permissions: ['tabs'] }, '').join()).toMatch(/banned/);
    expect(
      verifyPermissions({ optional_permissions: ['tabs'] }, 'chrome.permissions.request({})').join()
    ).toMatch(/banned/);
  });

  it('requires evidence for optional permissions and a permissions.request() call', () => {
    const m = { optional_permissions: ['storage'] };
    expect(verifyPermissions(m, 'chrome.storage.local.get()').join()).toMatch(/permissions\.request/);
    expect(verifyPermissions(m, 'chrome.storage.local.get(); chrome.permissions.request({})')).toEqual([]);
  });

  it('rejects host patterns outside the reviewed set, wherever they appear', () => {
    for (const m of [
      { host_permissions: ['<all_urls>'] },
      { optional_host_permissions: ['*://*/*'] },
      { content_scripts: [{ matches: ['file:///*'], js: [] }] },
      { web_accessible_resources: [{ resources: ['a.png'], matches: ['<all_urls>'] }] },
    ]) {
      expect(verifyPermissions(m, 'chrome.permissions.request({})'), JSON.stringify(m)).not.toEqual([]);
    }
  });

  it('accepts a sensible minimum_chrome_version and rejects nonsense', () => {
    const sp = { permissions: ['sidePanel'] };
    const code = 'chrome.sidePanel.open({})';
    expect(verifyPermissions({ ...sp, minimum_chrome_version: '116' }, code)).toEqual([]);
    expect(verifyPermissions({ ...sp, minimum_chrome_version: 'latest' }, code)).not.toEqual([]);
    expect(verifyPermissions({ ...sp, minimum_chrome_version: '100' }, code)).not.toEqual([]);
  });

  it('has an evidence rule or a recognised category for every permission it knows', () => {
    for (const p of HOST_ACCESS_PERMISSIONS) expect(PERMISSION_EVIDENCE[p]).toBeUndefined();
    for (const p of BANNED_PERMISSIONS.keys()) expect(PERMISSION_EVIDENCE[p]).toBeUndefined();
  });
});

describe('reference checks', () => {
  it('resolves <script src> and <link href> relative to the page', () => {
    const html =
      '<link rel="stylesheet" href="panel.css"><link rel="icon" href="../icons/i.png">' +
      '<!-- <script src="gone.js"></script> -->' +
      '<script src="codegen.js?v=1"></script><script src="https://x.example/a.js"></script>' +
      '<a href="other.html">not loaded</a>';
    expect(htmlReferences('src/sidepanel.html', html).sort()).toEqual(
      ['icons/i.png', 'src/codegen.js', 'src/panel.css'].sort()
    );
  });

  it('finds executeScript files given inline or through a named constant', () => {
    const js =
      "const CONTENT_SCRIPT_FILES = ['src/a.js', 'src/b.js'];\n" +
      'chrome.scripting.executeScript({ target, files: CONTENT_SCRIPT_FILES });\n' +
      "chrome.scripting.executeScript({ target, files: ['src/c.js'] });\n" +
      "// chrome.scripting.executeScript({ files: ['src/commented.js'] });";
    expect(injectedFiles(js).sort()).toEqual(['src/a.js', 'src/b.js', 'src/c.js']);
  });

  it('collects every manifest key that names a file', () => {
    const refs = manifestReferences({
      background: { service_worker: 'bg.js' },
      action: { default_popup: 'p.html', default_icon: 'i.png' },
      options_ui: { page: 'o.html' },
      content_scripts: [{ js: ['c.js'], css: ['c.css'] }],
      web_accessible_resources: [{ resources: ['w/*.png'], matches: ['https://*/*'] }],
    });
    expect(refs.sort()).toEqual(['bg.js', 'c.css', 'c.js', 'i.png', 'o.html', 'p.html', 'w/*.png'].sort());
  });

  const pkg = (files, manifest) => [
    { name: 'manifest.json', data: JSON.stringify({ manifest_version: 3, ...manifest }) },
    ...Object.entries(files).map(([name, data]) => ({ name, data })),
  ];

  it('passes a minimal, consistent package', () => {
    const entries = pkg(
      {
        'bg.js': "const F = ['c.js']; chrome.scripting.executeScript({ files: F });",
        'c.js': 'chrome.storage.local.get();',
        'p.html': '<script src="p.js"></script>',
        'p.js': '1',
        'w/a.png': 'x',
      },
      {
        permissions: ['scripting', 'storage'],
        host_permissions: ['https://*/*'],
        background: { service_worker: 'bg.js' },
        action: { default_popup: 'p.html' },
        web_accessible_resources: [{ resources: ['w/*.png'], matches: ['https://*/*'] }],
      }
    );
    expect(verifyPackage(entries)).toEqual([]);
  });

  it('flags a page script, an injected file and a web-accessible resource that are missing', () => {
    const problems = verifyPackage(
      pkg(
        {
          'bg.js': "chrome.scripting.executeScript({ files: ['missing-content.js'] });",
          'p.html': '<script src="missing-page.js"></script>',
        },
        {
          permissions: ['scripting'],
          background: { service_worker: 'bg.js' },
          action: { default_popup: 'p.html' },
          web_accessible_resources: [{ resources: ['w/*.png'], matches: ['https://*/*'] }],
        }
      )
    ).join('\n');
    expect(problems).toMatch(/missing-content\.js/);
    expect(problems).toMatch(/missing-page\.js/);
    expect(problems).toMatch(/w\/\*\.png/);
  });
});

describe('zip writer', () => {
  it('rejects unsafe or ambiguous member names', () => {
    const one = (name) => () => createZip([{ name, data: Buffer.from('x') }]);
    expect(one('../evil.js')).toThrow(/escapes/);
    expect(one('a/../../evil.js')).toThrow(/escapes/);
    expect(one('/etc/passwd')).toThrow(/absolute/);
    expect(one('C:/x.js')).toThrow(/absolute/);
    expect(one('a\\b.js')).toThrow(/backslash/);
    expect(one('a//b.js')).toThrow(/empty/);
    expect(() =>
      createZip([
        { name: 'a.js', data: Buffer.from('1') },
        { name: 'a.js', data: Buffer.from('2') },
      ])
    ).toThrow(/duplicate/);
  });

  it('round-trips through its own reader, sorted, with Unix metadata', () => {
    const zip = createZip([
      { name: 'z.txt', data: Buffer.from('z') },
      { name: 'a/b.txt', data: Buffer.from('a'.repeat(500)) },
    ]);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['a/b.txt', 'z.txt']);
    expect(entries[0].data.toString()).toBe('a'.repeat(500));
    expect(entries[0].method).toBe(8); // compressible → deflated
    expect(entries[1].method).toBe(0); // one byte → stored
    for (const e of entries) {
      expect(e.versionMadeBy >> 8, 'host system should be Unix').toBe(3);
      expect(e.externalAttrs >>> 16, 'mode should be S_IFREG|0644').toBe(0o100644);
    }
  });

  it('is detected as corrupt when a byte flips', () => {
    const zip = createZip([{ name: 'a.txt', data: Buffer.from('hello world, hello world') }]);
    const bad = Buffer.from(zip);
    bad[30 + 'a.txt'.length + 2] ^= 0xff; // inside the payload
    expect(() => readZip(bad)).toThrow();
  });

  it('computes the standard CRC-32', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});

// ── 2. built packages ───────────────────────────────────────────────────────────

let OUT;
const built = {};
let distBefore;

const distListing = () => {
  const dist = join(ROOT, 'dist');
  if (!existsSync(dist)) return [];
  return readdirSync(dist)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => `${f}:${statSync(join(dist, f)).mtimeMs}`)
    .sort();
};

beforeAll(() => {
  distBefore = distListing();
  OUT = mkdtempSync(join(tmpdir(), 'locatra-build-'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    for (const t of TARGET_NAMES) built[t] = build(t, OUT);
  } finally {
    log.mockRestore();
  }
}, 60_000);

afterAll(() => {
  if (OUT) rmSync(OUT, { recursive: true, force: true });
});

function filesIn(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) filesIn(abs, base, out);
    else
      out.push(
        abs
          .slice(base.length + 1)
          .split(/[\\/]/)
          .join('/')
      );
  }
  return out;
}

describe('building for tests', () => {
  it('never touches the real dist/', () => {
    expect(distListing()).toEqual(distBefore);
  });
});

describe.each(TARGET_NAMES)('%s package', (target) => {
  const dir = () => join(OUT, target);
  const read = (rel) => readFileSync(join(dir(), rel), 'utf8');
  const manifest = () => JSON.parse(read('manifest.json'));

  it('passes every policy check (the same ones the build enforces)', () => {
    const entries = filesIn(dir()).map((name) => ({ name, data: readFileSync(join(dir(), name)) }));
    expect(verifyPackage(entries)).toEqual([]);
  });

  it('ships only extension files — no docs, tests, tooling or VCS metadata', () => {
    const allowed = /^(manifest\.json|icons\/[\w.-]+\.png|src\/[\w.-]+\.(js|html))$/;
    for (const rel of filesIn(dir())) expect(rel, `${rel} should not be in the package`).toMatch(allowed);
  });

  it('declares manifest v3 and a three-part version', () => {
    expect(manifest().manifest_version).toBe(3);
    expect(manifest().version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('loads content scripts in an order that satisfies their dependencies', () => {
    // content.js reads __LocatorLensEngine and window.LLCodegen at call time, both
    // of which are defined by earlier files in this list.
    const js = manifest().content_scripts[0].js;
    expect(js.indexOf('src/codegen.js')).toBeLessThan(js.indexOf('src/content.js'));
    expect(js.indexOf('src/content-locator-engine.js')).toBeLessThan(js.indexOf('src/content.js'));
  });

  // The rejection was for a permission nothing needed. "Every permission is
  // justified" is enforced by the build, but that check only sees what is declared —
  // it cannot object to a permission being added. This pins the set exactly, so
  // growing it is a deliberate edit here and shows up in review.
  it('declares exactly the reviewed permission set, no more', () => {
    const expected =
      target === 'firefox'
        ? ['activeTab', 'contextMenus', 'scripting', 'storage'] // no sidePanel: Firefox uses sidebar_action
        : ['activeTab', 'contextMenus', 'scripting', 'sidePanel', 'storage'];
    expect([...manifest().permissions].sort()).toEqual(expected);
    expect(manifest().optional_permissions ?? []).toEqual([]);
  });

  it('asks for the two schemes it uses, not every scheme there is', () => {
    const m = manifest();
    expect(m.host_permissions).toEqual(['http://*/*', 'https://*/*']);
    expect(m.content_scripts[0].matches).toEqual(['http://*/*', 'https://*/*']);
    expect(m.optional_host_permissions ?? []).toEqual([]);
  });

  it('never reads a tab property that would require the tabs permission', () => {
    // url / title / favIconUrl are the only things `tabs` unlocks. Reading one
    // would mean the permission is genuinely needed and the manifest is wrong.
    const bg = stripJsComments(read('src/background.js'));
    expect(bg).not.toMatch(/\btabs?\[0\]\.(url|title|favIconUrl)\b/);
    expect(bg).not.toMatch(/\b(?:changeInfo|info)\.(url|title|favIconUrl)\b/);
  });

  it('declares a side-panel surface appropriate to the browser', () => {
    const m = manifest();
    if (target === 'chrome') {
      expect(m.side_panel?.default_path).toBeTruthy();
      expect(m.permissions).toContain('sidePanel');
      // chrome.sidePanel arrived in 114; anything that states a floor must clear it.
      if (m.minimum_chrome_version !== undefined) {
        expect(Number(String(m.minimum_chrome_version).split('.')[0])).toBeGreaterThanOrEqual(114);
      }
    } else {
      expect(m.sidebar_action?.default_panel).toBeTruthy();
      // sidePanel is a Chrome-only API; declaring it makes AMO reject the manifest.
      expect(m.permissions).not.toContain('sidePanel');
      expect(m.browser_specific_settings?.gecko?.id).toBeTruthy();
    }
  });

  it('archives exactly the unpacked tree, every entry intact', () => {
    const zip = readFileSync(built[target].zipPath);
    const entries = readZip(zip); // inflates each member and verifies its CRC-32
    expect(entries.map((e) => e.name).sort()).toEqual(filesIn(dir()).sort());
    for (const e of entries) expect(e.data.equals(readFileSync(join(dir(), e.name))), e.name).toBe(true);
  });

  const hasUnzip = spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0;
  it.skipIf(!hasUnzip)('passes `unzip -t`', () => {
    const out = execFileSync('unzip', ['-t', built[target].zipPath], { encoding: 'utf8' });
    expect(out).toMatch(/No errors detected/);
  });

  const hasPython = spawnSync('python3', ['-c', 'import zipfile'], { stdio: 'ignore' }).status === 0;
  it.skipIf(!hasPython)("passes Python's zipfile.testzip() and reads as regular Unix files", () => {
    const script = [
      'import sys, zipfile, stat',
      'z = zipfile.ZipFile(sys.argv[1])',
      'bad = z.testzip()',
      'assert bad is None, bad',
      'for i in z.infolist():',
      '    assert i.create_system == 3, (i.filename, i.create_system)',
      '    assert stat.S_ISREG(i.external_attr >> 16), i.filename',
      'print(len(z.infolist()))',
    ].join('\n');
    const out = execFileSync('python3', ['-I', '-c', script, built[target].zipPath], { encoding: 'utf8' });
    expect(Number(out.trim())).toBe(filesIn(dir()).length);
  });
});

describe('reproducibility', () => {
  it('produces byte-identical archives from the same tree', () => {
    const again = mkdtempSync(join(tmpdir(), 'locatra-build-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (const t of TARGET_NAMES) {
        const second = build(t, again);
        expect(second.sha, `${t} hash changed between two builds`).toBe(built[t].sha);
      }
    } finally {
      log.mockRestore();
      rmSync(again, { recursive: true, force: true });
    }
  }, 60_000);

  it('leaves exactly one archive per target in its output directory', () => {
    for (const t of TARGET_NAMES) {
      const zips = readdirSync(OUT).filter((f) => f.startsWith(`locatra-${t}-`));
      expect(zips).toEqual([`locatra-${t}-${built[t].version}.zip`]);
    }
  });
});

describe('version consistency', () => {
  it('reports the same version in package.json and all three manifests', () => {
    const versions = [
      'package.json',
      'manifest.json',
      'manifests/manifest.chrome.json',
      'manifests/manifest.firefox.json',
    ].map((f) => declared(f).version);
    expect(new Set(versions).size, `versions differ: ${versions.join(', ')}`).toBe(1);
  });

  it('keeps the root manifest identical to the Chrome manifest', () => {
    // The root manifest is what `Load unpacked` on the repo root uses; it must be a
    // real target, not a third hand-maintained copy that drifts. setup.sh no longer
    // rewrites it, so it is always the Chrome variant.
    const root = readFileSync(join(ROOT, 'manifest.json'), 'utf8').trim();
    const chrome = readFileSync(join(ROOT, 'manifests/manifest.chrome.json'), 'utf8').trim();
    expect(root).toBe(chrome);
  });
});

// ── 3. paperwork ────────────────────────────────────────────────────────────────

describe('documentation matches the manifests', () => {
  const doc = (file) => readFileSync(join(ROOT, file), 'utf8');
  const chrome = () => declared('manifests/manifest.chrome.json');
  const firefox = () => declared('manifests/manifest.firefox.json');

  /** Every permission name the policy module knows about. */
  const KNOWN = new Set([
    ...Object.keys(PERMISSION_EVIDENCE),
    ...HOST_ACCESS_PERMISSIONS,
    ...BANNED_PERMISSIONS.keys(),
  ]);

  /**
   * Body rows of the first table in the first `## ...` section whose heading
   * matches. Only the first table: later ones (e.g. the "calls that need no `tabs`
   * permission" table) mention permissions that are deliberately not declared.
   */
  function tableRows(text, heading) {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => /^##\s/.test(l) && heading.test(l));
    expect(start, `no section matching ${heading}`).toBeGreaterThan(-1);
    const rows = [];
    for (const line of lines.slice(start + 1)) {
      if (/^##\s/.test(line)) break;
      if (!line.startsWith('|')) {
        if (rows.length) break;
        continue;
      }
      if (/^\|\s*:?-+/.test(line)) continue;
      rows.push(line);
    }
    // Drop the header row.
    return rows.slice(1);
  }

  const codeSpans = (s) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

  const DOCS = [
    ['STORE_SUBMISSION.md', /Permission justifications/],
    ['PRIVACY_POLICY.md', /Permissions/],
    ['README.md', /Permissions/],
    ['build_process.md', /Permissions/],
  ];

  describe.each(DOCS)('%s', (file, heading) => {
    it('lists exactly the permissions the manifests declare', () => {
      const union = [...new Set([...chrome().permissions, ...firefox().permissions])].sort();
      const named = [
        ...new Set(
          tableRows(doc(file), heading)
            .flatMap(codeSpans)
            .flatMap((s) => s.split(/[\s+·,]+/))
            .filter((s) => KNOWN.has(s))
        ),
      ].sort();
      expect(named, `${file}: permission table disagrees with the manifests`).toEqual(union);
    });

    it('states the host patterns the manifest asks for, and never <all_urls>', () => {
      const rows = tableRows(doc(file), heading).join('\n');
      for (const pattern of chrome().host_permissions) {
        expect(rows, `${file}: host row omits ${pattern}`).toContain(pattern);
      }
      expect(rows, `${file}: the permission table still promises <all_urls>`).not.toContain('<all_urls>');
    });
  });

  it('gives host access exactly one justification row in the store guide', () => {
    const rows = tableRows(doc('STORE_SUBMISSION.md'), /Permission justifications/).filter((r) =>
      r.includes('host_permissions')
    );
    expect(rows).toHaveLength(1);
  });

  it('quotes the description the manifests ship', () => {
    expect(doc('STORE_SUBMISSION.md'), 'listing description drifted from the manifest').toContain(
      chrome().description
    );
  });

  it('ships the same description to both stores', () => {
    // Two descriptions means two listings to keep honest, and the Firefox one has
    // already drifted once. AMO shows the manifest description on the listing.
    expect(firefox().description).toBe(chrome().description);
  });

  it('never describes features that do not exist', () => {
    // Earlier versions of the privacy policy promised "Export session", "saved POM
    // data" and configurable custom test-id attributes. None has ever had a UI.
    for (const file of ['PRIVACY_POLICY.md', 'STORE_SUBMISSION.md', 'README.md', 'build_process.md']) {
      const text = doc(file);
      expect(text, `${file} mentions Export session`).not.toMatch(/Export session/i);
      expect(text, `${file} mentions POM data`).not.toMatch(/POM data/i);
      expect(text, `${file} mentions configurable test-id attributes`).not.toMatch(
        /custom test-id attribute|custom test attributes/i
      );
    }
  });
});
