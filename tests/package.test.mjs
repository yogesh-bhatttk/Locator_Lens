// Guards the store-submission contract.
//
// The extension was rejected once for what shipped in the archive rather than for
// how the code behaves, so these assertions run against the built artifact — the
// exact bytes that get uploaded — not against the source tree.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { createZip } from '../scripts/lib/zip.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['chrome', 'firefox'];

beforeAll(() => {
  execFileSync('node', [join(ROOT, 'scripts/build.mjs'), 'all'], { cwd: ROOT, stdio: 'pipe' });
}, 60_000);

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

describe.each(TARGETS)('%s package', (target) => {
  const dir = join(ROOT, 'dist', target);
  const read = (rel) => readFileSync(join(dir, rel), 'utf8');
  const manifest = () => JSON.parse(read('manifest.json'));

  it('exists', () => {
    expect(existsSync(dir)).toBe(true);
  });

  it('contains no remotely-loaded script or stylesheet', () => {
    // This is the rule that got the submission rejected: a generated report page
    // in the repo root pulled vis-network from unpkg.com, and the old "zip the
    // whole project" flow had no way to leave it out.
    for (const rel of filesIn(dir)) {
      if (!/\.(js|html|css|json)$/.test(rel)) continue;
      expect(read(rel), `${rel} loads a remote resource`).not.toMatch(
        /<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']https?:\/\//i
      );
    }
  });

  it('contains no dynamic code execution', () => {
    for (const rel of filesIn(dir).filter((f) => f.endsWith('.js'))) {
      const src = read(rel);
      expect(src, `${rel} uses eval()`).not.toMatch(/\beval\s*\(/);
      expect(src, `${rel} uses new Function()`).not.toMatch(/new\s+Function\s*\(/);
    }
  });

  it('makes no network calls, as the listing and privacy policy claim', () => {
    for (const rel of filesIn(dir).filter((f) => f.endsWith('.js'))) {
      expect(read(rel), `${rel} contains a network API`).not.toMatch(/\b(?:fetch|XMLHttpRequest)\s*\(/);
    }
  });

  it('ships only extension files — no docs, tests, tooling or VCS metadata', () => {
    const allowed = /^(manifest\.json|icons\/[\w.-]+\.png|src\/[\w.-]+\.(js|html))$/;
    for (const rel of filesIn(dir)) {
      expect(rel, `${rel} should not be in the package`).toMatch(allowed);
    }
  });

  it('excludes the directories that must never ship', () => {
    const all = filesIn(dir).join('\n');
    for (const forbidden of ['node_modules', 'graphify-out', 'tests/', 'scripts/', '.git', 'screenshots']) {
      expect(all, `package contains ${forbidden}`).not.toContain(forbidden);
    }
  });

  // The rejection this suite exists for came from uploading an archive built out of
  // a stale directory. Two versions of the same package sitting in dist/ is the
  // setup for repeating that by hand.
  it('leaves exactly one package for this target in dist/', () => {
    const zips = readdirSync(join(ROOT, 'dist')).filter((f) => f.startsWith(`locatorlens-${target}-`));
    expect(zips, `found ${zips.join(', ')}`).toHaveLength(1);
    expect(zips[0]).toBe(`locatorlens-${target}-${manifest().version}.zip`);
  });

  it('declares manifest v3 and a three-part version', () => {
    expect(manifest().manifest_version).toBe(3);
    expect(manifest().version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('includes every file the manifest references', () => {
    const m = manifest();
    const present = new Set(filesIn(dir));
    const refs = [
      m.background?.service_worker,
      ...(m.background?.scripts ?? []),
      m.action?.default_popup,
      m.side_panel?.default_path,
      m.sidebar_action?.default_panel,
      m.sidebar_action?.default_icon,
      ...Object.values(m.icons ?? {}),
      ...Object.values(m.action?.default_icon ?? {}),
      ...(m.content_scripts ?? []).flatMap((cs) => cs.js ?? []),
    ].filter(Boolean);

    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(present, `manifest references missing ${ref}`).toContain(ref);
  });

  it('loads content scripts in an order that satisfies their dependencies', () => {
    // content.js reads __LocatorLensEngine and window.LLCodegen at call time, both
    // of which are defined by earlier files in this list.
    const js = manifest().content_scripts[0].js;
    expect(js.indexOf('src/codegen.js')).toBeLessThan(js.indexOf('src/content.js'));
    expect(js.indexOf('src/content-locator-engine.js')).toBeLessThan(js.indexOf('src/content.js'));
  });

  it('requests no permission beyond the documented set', () => {
    const documented = ['activeTab', 'scripting', 'storage', 'contextMenus', 'sidePanel'];
    for (const p of manifest().permissions) expect(documented, `undocumented permission ${p}`).toContain(p);
  });

  // Chrome Web Store rejection "Purple Potassium", 2026: the submitted package
  // requested `tabs`, which nothing needed. Everything this extension calls on
  // chrome.tabs works without it.
  it('does not request the "tabs" permission', () => {
    expect(manifest().permissions).not.toContain('tabs');
    expect(manifest().optional_permissions ?? []).not.toContain('tabs');
  });

  it('never reads a tab property that would require the tabs permission', () => {
    // url / title / favIconUrl are the only things `tabs` unlocks. Reading one
    // would mean the permission is genuinely needed and the manifest is wrong.
    const bg = readFileSync(join(dir, 'src/background.js'), 'utf8');
    expect(bg).not.toMatch(/\btabs?\[0\]\.(url|title|favIconUrl)\b/);
    expect(bg).not.toMatch(/\b(?:changeInfo|info)\.(url|title|favIconUrl)\b/);
  });

  // The rejection was for a permission nothing needed. "Every permission is
  // justified" is checked below, but that check only ever sees what is declared —
  // it cannot object to a permission being added. This pins the set exactly, so
  // growing it is a deliberate edit to this list and shows up in review.
  it('declares exactly the reviewed permission set, no more', () => {
    const expected =
      target === 'firefox'
        ? ['activeTab', 'contextMenus', 'scripting', 'storage'] // no sidePanel: Firefox uses sidebar_action
        : ['activeTab', 'contextMenus', 'scripting', 'sidePanel', 'storage'];
    expect([...manifest().permissions].sort()).toEqual(expected);
  });

  it('asks for the two schemes it uses, not every scheme there is', () => {
    // <all_urls> also covers file://, ftp:// and more. The extension analyses web
    // pages and has no use for those, and "narrowest permission that works" is the
    // policy a reviewer applies.
    const m = manifest();
    expect(m.host_permissions).toEqual(['http://*/*', 'https://*/*']);
    expect(m.content_scripts[0].matches).toEqual(['http://*/*', 'https://*/*']);
    expect(m.optional_permissions ?? []).toEqual([]);
    expect(m.optional_host_permissions ?? []).toEqual([]);
  });

  it('backs every declared permission with an API the code actually calls', () => {
    const code = filesIn(dir)
      .filter((f) => f.endsWith('.js') || f.endsWith('.html'))
      .map((f) => read(f))
      .join('\n');

    // activeTab grants host access rather than an API, so it has no call signature.
    const evidence = {
      scripting: /chrome\.scripting\./,
      storage: /chrome\.storage\./,
      contextMenus: /chrome\.contextMenus\./,
      sidePanel: /chrome(?:\.sidePanel\b|\[["']sidePanel["']\])/,
    };

    for (const p of manifest().permissions) {
      if (p === 'activeTab') continue;
      expect(evidence[p], `no evidence rule for permission "${p}"`).toBeDefined();
      expect(code, `permission "${p}" is declared but unused`).toMatch(evidence[p]);
    }
  });

  it('declares a side-panel surface appropriate to the browser', () => {
    const m = manifest();
    if (target === 'chrome') {
      expect(m.side_panel?.default_path).toBeTruthy();
      expect(m.permissions).toContain('sidePanel');
    } else {
      expect(m.sidebar_action?.default_panel).toBeTruthy();
      // sidePanel is a Chrome-only API; declaring it makes AMO reject the manifest.
      expect(m.permissions).not.toContain('sidePanel');
      expect(m.browser_specific_settings?.gecko?.id).toBeTruthy();
    }
  });
});

describe('archive', () => {
  it('produces a valid, byte-identical zip on every build', () => {
    const version = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')).version;
    const zipPath = join(ROOT, 'dist', `locatorlens-chrome-${version}.zip`);
    const first = readFileSync(zipPath);

    execFileSync('node', [join(ROOT, 'scripts/build.mjs'), 'chrome'], { cwd: ROOT, stdio: 'pipe' });
    expect(readFileSync(zipPath).equals(first)).toBe(true);
  }, 60_000);

  it('writes a well-formed central directory', () => {
    const zip = createZip([
      { name: 'b.txt', data: Buffer.from('bbbb') },
      { name: 'a.txt', data: Buffer.from('a'.repeat(500)) },
    ]);
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(zip.readUInt16LE(zip.length - 14)).toBe(2); // entry count in the EOCD
  });

  it('orders entries by name regardless of input order', () => {
    const zip = createZip([
      { name: 'z.txt', data: Buffer.from('z') },
      { name: 'a.txt', data: Buffer.from('a') },
    ]);
    expect(zip.indexOf('a.txt')).toBeLessThan(zip.indexOf('z.txt'));
  });
});

describe('version consistency', () => {
  it('reports the same version in package.json and all three manifests', () => {
    const versions = [
      'package.json',
      'manifest.json',
      'manifests/manifest.chrome.json',
      'manifests/manifest.firefox.json',
    ].map((f) => JSON.parse(readFileSync(join(ROOT, f), 'utf8')).version);
    expect(new Set(versions).size, `versions differ: ${versions.join(', ')}`).toBe(1);
  });

  it('keeps the root manifest identical to one of the per-browser manifests', () => {
    // The root manifest is what `Load unpacked` uses; it must be a real target,
    // not a third hand-maintained copy that drifts.
    const root = readFileSync(join(ROOT, 'manifest.json'), 'utf8').trim();
    const chrome = readFileSync(join(ROOT, 'manifests/manifest.chrome.json'), 'utf8').trim();
    const firefox = readFileSync(join(ROOT, 'manifests/manifest.firefox.json'), 'utf8').trim();
    expect([chrome, firefox]).toContain(root);
  });
});

// The manifest is only half of a submission. The other half is the text pasted into
// the Chrome Web Store dashboard, and a justification table that disagrees with the
// manifest — listing a permission that was dropped, or missing one that was added —
// is the kind of contradiction that costs a review cycle. The rejection this repo
// carries was about the gap between what was declared and what was needed; this
// closes the matching gap between what is declared and what is claimed.
describe('submission paperwork matches the manifest', () => {
  const doc = () => readFileSync(join(ROOT, 'STORE_SUBMISSION.md'), 'utf8');

  /** The permissions named in the "Permission justifications" table. */
  function justifiedPermissions() {
    const text = doc();
    const start = text.indexOf('## 4. Permission justifications');
    expect(start, 'the justification section moved or was renamed').toBeGreaterThan(-1);
    const section = text.slice(start, text.indexOf('\n## ', start + 1));
    const names = [];
    for (const line of section.split('\n')) {
      if (!line.startsWith('|') || /^\|\s*-+/.test(line) || /\|\s*Permission\s*\|/.test(line)) continue;
      const m = /`([^`]+)`/.exec(line);
      if (m) names.push(m[1]);
    }
    return names;
  }

  const declared = (file) => JSON.parse(readFileSync(join(ROOT, file), 'utf8'));

  it('justifies every permission either browser declares, and nothing else', () => {
    const chrome = declared('manifests/manifest.chrome.json').permissions;
    const firefox = declared('manifests/manifest.firefox.json').permissions;
    const union = [...new Set([...chrome, ...firefox])].sort();

    const justified = justifiedPermissions();
    const hostRows = justified.filter((n) => n.startsWith('host_permissions'));
    const apiRows = justified.filter((n) => !n.startsWith('host_permissions')).sort();

    expect(apiRows, 'justification table does not match the declared permissions').toEqual(union);
    expect(hostRows, 'host access needs exactly one justification row').toHaveLength(1);
  });

  it('states the host grant the manifest actually asks for', () => {
    // A row still promising <all_urls> after the grant was narrowed would be a
    // reviewer reading one thing and installing another.
    const hosts = declared('manifests/manifest.chrome.json').host_permissions;
    const row = justifiedPermissions().find((n) => n.startsWith('host_permissions'));
    for (const pattern of hosts) {
      expect(row, `host justification omits ${pattern}`).toContain(pattern);
    }
    expect(row, 'the host row still promises <all_urls>').not.toContain('<all_urls>');
  });

  it('quotes the description the manifest ships', () => {
    const description = declared('manifests/manifest.chrome.json').description;
    expect(doc(), 'listing description drifted from the manifest').toContain(description);
  });
});
