// @vitest-environment jsdom
//
// The Locatra helpers (C9.4) — locatraFind / locatra_find / Locatra.find /
// Locatra.Find / locatraGet — all run one in-page matcher (codegen.js MATCH_SRC, a
// port of the locator engine). A matcher that finds a different element than the
// engine made the exported test act on something other than what the panel showed,
// so it runs here, in jsdom, against the engine on every Playwright-verified table
// the engine suites keep (roles, accessible names, match counts), read from those
// files so the two can never drift apart. Files embed the matcher compacted (codegen.js
// compactPieces); the readable source, the compact script and the compact Cypress
// declaration all run on every row here, and the compact one is proven the same
// program (one syntax tree, its locals renamed).
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';

import { declaredString } from './codegen-helper-calls.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let E;
let C;
let I;
/** The matcher exactly as WebDriver runs it: executeScript(MATCH_JS, …args). */
let matchScript;
/** The matcher as written (codegen.js MATCH_SRC, readable). */
let matchFunction;
/** The matcher exactly as a Cypress spec declares it (compact). */
let cypressFunction;
beforeAll(async () => {
  vm.runInThisContext(readFileSync(join(ROOT, 'src/content-locator-engine.js'), 'utf8'), {
    filename: 'src/content-locator-engine.js',
  });
  E = globalThis.__LocatorLensEngine;
  await import('../src/codegen.js');
  await import('../src/codegen-java.js');
  await import('../src/codegen-csharp.js');
  await import('../src/codegen-wdio.js');
  C = globalThis.LLCodegen;
  I = C._internals;
  matchScript = new Function(I.MATCH_JS);
  matchFunction = new Function(`${I.tsOnly(I.MATCH_SRC, 'javascript')}\nreturn locatraMatch;`)();
  cypressFunction = new Function(`${cypressMatcher()}\nreturn locatraMatch;`)();
  // jsdom has no pseudo-element styles (it logs "not implemented" and answers with
  // the element's own style); the engine skips them there, and so does this.
  const real = window.getComputedStyle.bind(window);
  window.getComputedStyle = (el, pseudo) => (pseudo ? null : real(el));
});

/** The locatraMatch declaration a Cypress JavaScript spec carries, as written there. */
function cypressMatcher() {
  const spec = C.testScript(
    [{ action: 'click', target: { kind: 'role', role: 'button' } }],
    'cypress',
    'javascript'
  );
  const start = spec.indexOf('\nfunction locatraMatch(') + 1;
  return spec.slice(start, spec.indexOf('\n\n', start));
}

function match(kind, value, name = null, exact = false, level = 0, scope = null) {
  const a = matchScript(kind, value, name, exact, level, scope);
  const b = matchFunction(kind, value, name, exact, level, scope || document);
  const c = cypressFunction(kind, value, name, exact, level, scope || document);
  expect(b).toEqual(a);
  expect(c).toEqual(a);
  return a;
}

function deepFind(selector) {
  const roots = [document];
  for (const root of roots) {
    const hit = root.querySelector(selector);
    if (hit) return hit;
    root.querySelectorAll('*').forEach((e) => e.shadowRoot && roots.push(e.shadowRoot));
  }
  return null;
}

function render(html, opts = {}) {
  document.body.innerHTML = html;
  for (const [host, inner] of opts.shadow ?? [])
    deepFind(host).attachShadow({ mode: 'open' }).innerHTML = inner;
  return deepFind(opts.subject ?? '#subject');
}

function deepAll() {
  const out = [];
  const roots = [document];
  for (const root of roots) {
    root.querySelectorAll('*').forEach((e) => {
      out.push(e);
      if (e.shadowRoot) roots.push(e.shadowRoot);
    });
  }
  return out;
}

const label = (el) => `<${el.localName}${el.id ? '#' + el.id : ''}>`;
const show = (els) => (els || []).map(label);

/** Every `// pw-verified:<kind>` table of the engine suites, row by row. */
function verifiedRows(kind) {
  const helpers = `
    const role = (role, name, o = {}) => ({ kind: 'role', role, ...(name != null ? { name } : {}), ...o });
    const byText = (value, o = {}) => ({ kind: 'text', value, ...o });
    const byLabel = (value, o = {}) => ({ kind: 'label', value, ...o });
    const byAttr = (kind, value, o = {}) => ({ kind, value, ...o });
    const css = (value) => ({ kind: 'css', value });
    const testid = (value, attr = 'data-testid') => ({ kind: 'testid', attr, value });
    const chain = (parent, child) => ({ kind: 'chain', parent, child });`;
  const rows = [];
  for (const file of readdirSync(join(ROOT, 'tests')).filter((f) => /^locator-engine.*\.mjs$/.test(f))) {
    const text = readFileSync(join(ROOT, 'tests', file), 'utf8');
    const consts = [
      ...text.matchAll(
        /\n\s*const ([A-Z_0-9]+) =\s*\n?\s*((?:'[^'\n]*'|"[^"\n]*"|`[^`]*`)(?:\s*\+\s*(?:'[^'\n]*'|"[^"\n]*"))*);/g
      ),
    ]
      .map((m) => `const ${m[1]} = ${m[2]};`)
      .join('\n');
    const re = new RegExp(
      `// pw-verified:${kind}\\s*\\n\\s*const (\\w+) = (\\[[\\s\\S]*?\\n\\s*\\]);\\s*\\n\\s*// end pw-verified`,
      'g'
    );
    for (const m of text.matchAll(re)) {
      for (const row of new Function(helpers + consts + '\nreturn ' + m[2])()) rows.push([m[1], ...row]);
    }
  }
  return rows;
}

// Every role the engine can give an element (the VALID list of the matcher).
const ROLES = (
  'alert alertdialog application article banner blockquote button caption cell checkbox code columnheader ' +
  'combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form ' +
  'generic grid gridcell group heading img insertion link list listbox listitem log main mark marquee math meter ' +
  'menu menubar menuitem menuitemcheckbox menuitemradio navigation none note option paragraph presentation ' +
  'progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider ' +
  'spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer ' +
  'toolbar tooltip tree treegrid treeitem'
).split(' ');

/**
 * What the generated code finds for a target: the helper for role / label / text
 * (scoped to each parent of a chain in turn, as the engine scopes `parent >> child`),
 * the engine itself for the native kinds; a role's nth applies to the whole result.
 */
function viaHelper(t, scopes = null) {
  if (t.kind === 'chain') {
    const parents = viaHelper(t.parent, scopes);
    return t.child ? viaHelper(t.child, parents) : parents;
  }
  const plain = { ...t };
  delete plain.nth;
  const spec = I.helperSpec({ ...plain, matchCount: 1 });
  const find = (scope) =>
    spec
      ? match(spec.kind, spec.value, spec.name, spec.exact, spec.level, scope)
      : (E.resolveTarget(plain) || []).filter(
          (e) => !scope || (scope !== e && (scope.contains(e) || deepContains(scope, e)))
        );
  let out = [];
  if (!scopes) out = find(null);
  else {
    const seen = new Set();
    for (const p of scopes) for (const e of find(p)) if (!seen.has(e)) seen.add(e) && out.push(e);
  }
  return I.hasNth(t) ? out.slice(t.nth, t.nth + 1) : out;
}

function deepContains(a, n) {
  for (; n; n = n.nodeType === 11 ? n.host : n.parentNode) if (n === a) return true;
  return false;
}

describe('the in-page matcher finds what the engine finds', () => {
  const roleRows = verifiedRows('roles');
  const nameRows = verifiedRows('names');
  const countRows = verifiedRows('counts');

  it('reads the engine tables', () => {
    expect(roleRows.length).toBeGreaterThan(60);
    expect(nameRows.length).toBeGreaterThan(60);
    expect(countRows.length).toBeGreaterThan(100);
  });

  it.each(roleRows)('roles %s: %s', (table, html, role, opts) => {
    render(html, opts);
    for (const r of ROLES) {
      expect(show(match('role', r)), r).toEqual(show(E.resolveTarget({ kind: 'role', role: r })));
    }
  });

  it.each(nameRows)('names %s: %s → %j', (table, html, expected, opts) => {
    const subject = render(html, opts);
    const role = E.getRole(subject);
    if (role && expected) {
      for (const exact of [true, false]) {
        const t = { kind: 'role', role, name: expected, exact };
        expect(show(match('role', role, expected, exact)), `exact ${exact}`).toEqual(
          show(E.resolveTarget(t))
        );
      }
    }
    // Every element of the page, by the name the engine computes for it.
    for (const el of deepAll()) {
      const r = E.getRole(el);
      const name = E.getAccessibleName(el);
      if (!r || !name) continue;
      const want = E.resolveTarget({ kind: 'role', role: r, name, exact: true });
      expect(show(match('role', r, name, true)), `${label(el)} ${r} ${JSON.stringify(name)}`).toEqual(
        show(want)
      );
    }
  });

  // Collected before beforeAll() runs, so without codegen's own needsHelper().
  const helperKind = (t) =>
    t.kind === 'chain'
      ? helperKind(t.parent) || (!!t.child && helperKind(t.child))
      : ['role', 'label', 'text'].includes(t.kind);
  const helperRows = countRows.filter(([, , t]) => helperKind(t));
  it('has rows for every helper kind', () => {
    const kinds = new Set();
    const walk = (t) => (t.kind === 'chain' ? (walk(t.parent), t.child && walk(t.child)) : kinds.add(t.kind));
    helperRows.forEach(([, , t]) => walk(t));
    for (const k of ['role', 'label', 'text']) expect(kinds.has(k), k).toBe(true);
    expect(helperRows.some(([, , t]) => t.kind === 'chain')).toBe(true);
    expect(helperRows.every(([, , t]) => I.needsHelper(t))).toBe(true);
  });

  it.each(helperRows)('counts %s: %s %j', (table, html, target, count, opts) => {
    render(html, opts);
    const want = E.resolveTarget(target);
    expect(want).toHaveLength(count);
    expect(show(viaHelper(target))).toEqual(show(want));
  });
});

// The user's case: getByRole('textbox', { name: 'Username or Email' }) on a field that
// also has id="username". The engine offers the id as an alternative (C9.1); every
// framework but Playwright renders it (C9.2); without it, the helper call is short.
describe('from the engine to the exported line', () => {
  it('renders By.id for a picked field with an id, and a one-line helper call without one', () => {
    render(
      '<form><label for="username">Username or Email</label><input id="username" name="log">' +
        '<label>Password <input type="password" id="pw-82f3a9c1d"></label><button>Log in</button></form>'
    );
    const pick = (sel) => E.generateLocators(document.querySelector(sel), []);
    const user = pick('#username');
    const primary = user.locators[0].target;
    expect(primary.kind).toBe('role');
    expect(Array.isArray(user.altTargets) && user.altTargets.length).toBeTruthy();
    const step = { action: 'fill', target: primary, altTargets: user.altTargets, value: 'ada' };
    expect(C.actionStatement(step, 'selenium', 'typescript')).toContain(
      "driver.findElement(By.id('username'))"
    );
    expect(C.actionStatement(step, 'selenium', 'python')).toContain('driver.find_element(By.ID, "username")');
    expect(C.actionStatement(step, 'webdriverio', 'javascript')).toBe(
      "await $('#username').setValue('ada');"
    );
    expect(C.actionStatement(step, 'cypress', 'javascript')).toContain("cy.get('#username')");
    expect(C.actionStatement(step, 'playwright', 'typescript')).toContain("page.getByRole('textbox'");
    // Without an alternative the role target is one short helper call, never XPath.
    const bare = C.actionStatement({ ...step, altTargets: undefined }, 'selenium', 'typescript');
    expect(bare).toContain("locatraFind(driver, 'role', 'textbox', 'Username or Email')");
    expect(bare.length).toBeLessThan(200);
    expect(bare).not.toMatch(/xpath|normalize-space/i);
    // The button has no id, test id or name: its own text, as a short XPath, is offered.
    const login = pick('button');
    const alt = (login.altTargets || []).find((t) => t.kind === 'xpath');
    if (alt) {
      expect(show(match('xpath', alt.value))).toEqual(['<button>']);
      expect(
        C.locatorExpr(
          C.preferredTarget(login.locators[0].target, login.altTargets, 'cypress'),
          'cypress',
          'javascript'
        )
      ).not.toContain('xpath');
    }
  });
});

describe('matching details', () => {
  it('normalises no-break spaces, soft hyphens and zero-width spaces like the engine', () => {
    render(
      '<button id="a">Add&nbsp;to&nbsp;cart</button><button id="b">Bundes\u00adregierung</button>' +
        '<p id="c">Sa\u200bve now</p><label for="d">E&nbsp;mail</label><input id="d">'
    );
    expect(show(match('role', 'button', 'Add to cart', true))).toEqual(['<button#a>']);
    expect(show(match('role', 'button', 'Bundesregierung', true))).toEqual(['<button#b>']);
    expect(show(match('text', 'Save now', null, true))).toEqual(['<p#c>']);
    expect(show(match('label', 'E mail', null, true))).toEqual(['<input#d>']);
  });

  it('is case-insensitive substring by default and whole-string, case-sensitive when exact', () => {
    render('<button id="a">Save draft</button><button id="b">save</button>');
    expect(show(match('role', 'button', 'SAVE'))).toEqual(['<button#a>', '<button#b>']);
    expect(show(match('role', 'button', 'save', true))).toEqual(['<button#b>']);
    expect(show(match('text', 'DRAFT'))).toEqual(['<button#a>']);
    expect(show(match('text', 'draft', null, true))).toEqual([]);
  });

  it('skips elements hidden from the accessibility tree for roles only', () => {
    render(
      '<button id="a" style="display:none">Go</button><button id="b" aria-hidden="true">Go</button><button id="c">Go</button>'
    );
    expect(show(match('role', 'button', 'Go'))).toEqual(['<button#c>']);
    expect(show(match('text', 'Go', null, true))).toEqual(['<button#a>', '<button#b>', '<button#c>']);
  });

  it('narrows a heading by level', () => {
    render('<h2 id="a">T</h2><h3 id="b">T</h3><div role="heading" aria-level="2" id="c">T</div>');
    expect(show(match('role', 'heading', 'T', false, 2))).toEqual(['<h2#a>', '<div#c>']);
    expect(show(match('role', 'heading', null, false, 3))).toEqual(['<h3#b>']);
  });

  it('searches inside a scope element (a chain parent or a frame body), through shadow roots', () => {
    render(
      '<div id="r1"><button id="a">Delete</button></div><div id="r2"><button id="b">Delete</button>' +
        '<x-host id="h"></x-host></div>',
      { shadow: [['#h', '<button id="c">Delete</button>']] }
    );
    expect(show(match('role', 'button', 'Delete'))).toEqual(['<button#a>', '<button#b>', '<button#c>']);
    expect(show(match('role', 'button', 'Delete', false, 0, document.getElementById('r2')))).toEqual([
      '<button#b>',
      '<button#c>',
    ]);
    // getByText may match the scope element itself; the other kinds never do.
    const r1 = document.getElementById('r1');
    expect(show(match('text', 'Delete', null, true, 0, document.getElementById('a')))).toEqual([
      '<button#a>',
    ]);
    expect(show(match('role', 'button', null, false, 0, document.getElementById('a')))).toEqual([]);
    expect(show(match('label', 'x', null, false, 0, r1))).toEqual([]);
  });

  it('evaluates an XPath (Cypress best effort), relative to a scope element', () => {
    render('<div id="r"><a id="a">x</a></div><a id="b">y</a>');
    expect(show(match('xpath', '//a'))).toEqual(['<a#a>', '<a#b>']);
    expect(show(match('xpath', '//a', null, false, 0, document.getElementById('r')))).toEqual(['<a#a>']);
    expect(show(match('xpath', '//a/text()'))).toEqual([]);
  });

  it('evaluates an XPath exactly as the engine resolves kind xpath', () => {
    render('<div id="r"><a id="a" title="x">x</a></div><a id="b">y</a><p>t</p>');
    for (const value of ['//a', '//a[@title="x"]', '(//a)[2]', '//p/text()', '//nope']) {
      expect(show(match('xpath', value)), value).toEqual(show(E.resolveTarget({ kind: 'xpath', value })));
    }
  });

  it('the label each aria-labelledby element gives is matched on its own (getByLabel)', () => {
    render('<span id="a">Amount</span><span id="u">USD</span><input id="i" aria-labelledby="a u">');
    for (const [value, exact] of [
      ['Amount USD', true],
      ['USD', true],
      ['amount', false],
    ]) {
      expect(show(match('label', value, null, exact)), value).toEqual(
        show(E.resolveTarget({ kind: 'label', value, exact }))
      );
    }
  });

  it('embeds as one script in every host language, every line within 120 columns', () => {
    // A backtick or "${" would end / interpolate the JS String.raw template; plain
    // ASCII keeps javac's -encoding US-ASCII happy.
    expect(I.MATCH_JS).not.toMatch(/`|\$\{/);
    expect(I.MATCH_JS).toMatch(/^[\x20-\x7e\n]*$/);
    const line = I.MATCH_JS.replace(/\n/g, '');
    expect(line).toBe(I.matchSource('javascript') + I.MATCH_RUN);
    const target = { kind: 'role', role: 'button', name: 'Go' };
    // (A String.raw template starts on the line after its backtick.)
    const embedded = [
      ['selenium', 'javascript', 'LOCATRA_JS', `\n${I.MATCH_JS}`],
      ['selenium', 'typescript', 'LOCATRA_JS', `\n${I.MATCH_JS}`],
      ['webdriverio', 'typescript', 'LOCATRA_JS', `\n${I.MATCH_JS}`],
      ['selenium', 'python', 'LOCATRA_JS', line],
      ['selenium', 'java', 'JS', line],
      ['selenium', 'csharp', 'Js', line],
    ];
    for (const [fw, lang, name, want] of embedded) {
      const files = [
        C.testScript([{ action: 'click', target }], fw, lang),
        C.pageObject({ elements: [{ name: 'go', kind: 'button', target }] }, fw, lang),
      ];
      for (const code of files) {
        expect(declaredString(code, name, lang), `${fw}/${lang}`).toBe(want);
        for (const l of code.split('\n')) expect(l.length, `${fw}/${lang}: ${l}`).toBeLessThanOrEqual(120);
      }
    }
    // The line breaks fall where JavaScript reads the same program either way.
    expect(shape(parse(I.MATCH_JS))).toBe(shape(parse(line)));
    expect(shape(parse(cypressMatcher()))).toBe(shape(parse(I.matchSource('javascript'))));
  });

  it('rejects an unknown kind loudly', () => {
    render('<p>x</p>');
    expect(() => matchScript('nope', 'x', null, false, 0, null)).toThrow(
      'Locatra: unknown locator kind nope'
    );
  });
});

// ── the compact matcher is the readable one ────────────────────────────────────
// ESLint's own parser and scope analysis (installed with ESLint) read both programs.
const fromEslint = createRequire(join(ROOT, 'node_modules/eslint/package.json'));
const espree = fromEslint('espree');
const eslintScope = fromEslint('eslint-scope');
// (A WebDriver script is a function body: it may return.)
const parse = (src) =>
  espree.parse(src, { ecmaVersion: 2022, range: true, ecmaFeatures: { globalReturn: true } });
const POSITION = new Set(['start', 'end', 'range', 'loc', 'raw']);
/** A syntax tree without positions or raw spellings: what the program says, not its layout. */
const shape = (ast) => JSON.stringify(ast, (k, v) => (POSITION.has(k) ? undefined : v));

describe('the compact matcher is the readable program, compacted', () => {
  it('has the syntax tree of MATCH_SRC with each local variable renamed, and nothing else', () => {
    const readable = I.tsOnly(I.MATCH_SRC, 'javascript');
    const names = I.matchNames();
    const ast = parse(readable);
    const scopes = eslintScope.analyze(ast, { ecmaVersion: 2022 });
    // Rename every declaration and reference of each renamed variable (by scope
    // analysis, so a property, a key or a global of the same spelling stays).
    const edits = new Map();
    const declared = new Set();
    for (const scope of scopes.scopes) {
      for (const v of scope.variables) {
        if (!v.defs.length) continue;
        declared.add(v.name);
        if (!Object.hasOwn(names, v.name)) continue;
        for (const id of [...v.identifiers, ...v.references.map((r) => r.identifier)]) {
          edits.set(id.range[0], [id.range[1], names[v.name]]);
        }
      }
    }
    let renamed = readable;
    for (const [start, [end, to]] of [...edits].sort((a, b) => b[0] - a[0])) {
      renamed = renamed.slice(0, start) + to + renamed.slice(end);
    }
    expect(shape(parse(I.matchSource('javascript')))).toBe(shape(parse(renamed)));
    // Only the matcher's own locals are renamed, each to a name no identifier of the
    // readable source spells (so no rename captures or shadows another binding).
    const spelled = new Set();
    JSON.stringify(ast, (k, v) => {
      if (v && v.type === 'Identifier') spelled.add(v.name);
      return v;
    });
    const short = Object.values(names);
    expect(new Set(short).size).toBe(short.length);
    for (const [from, to] of Object.entries(names)) {
      expect(declared.has(from), from).toBe(true);
      expect(spelled.has(to), `${from} -> ${to}`).toBe(false);
    }
    expect(Object.keys(names)).not.toContain('locatraMatch');
    expect(short.length).toBeGreaterThan(50);
  });

  it('keeps the TypeScript annotations on the same program', () => {
    expect(I.matchSource('typescript')).toMatch(
      /^function locatraMatch\(\w+:string,\w+:string,\w+:string\|null,\w+:boolean,\w+:number,\w+:any\):any\[\]\{/
    );
  });

  it('refuses source it cannot compact safely', () => {
    expect(() => I.compactPieces('const a = `x`;')).toThrow(/unsupported syntax/);
    expect(() => I.compactPieces('const a = 1; /* b */')).toThrow(/unsupported syntax/);
    expect(() => I.compactPieces('const value = 1; const o = { value };')).toThrow(/shorthand property/);
    // Kept apart: two words, and "+" / "-" that would merge into "++" / "--".
    expect(I.compactPieces('const total = a + +b - -c; // why\nreturn  total;').join('')).toMatch(
      /^const \w+=a\+ \+b- -c;return \w+;$/
    );
  });

  it('renames parameters of every form, never a property, key or global', () => {
    const src =
      'function keep(alpha, beta = f(gamma)) { const delta = (epsilon) => epsilon + alpha; ' +
      'const zeta = eta => eta; try { g(); } catch (theta) { h(theta); } ' +
      'return { alpha: alpha.beta, delta: document.title + delta(zeta(beta)) }; }';
    const out = I.compactPieces(src, ['keep']).join('');
    // Every local is renamed; a property (.beta), a key (alpha:, delta:) and a global stay.
    expect(out).not.toMatch(/(?<![.\w])(?:alpha|beta|delta|epsilon|zeta|eta|theta)\b(?!:)/);
    expect(out).toMatch(/^function keep\(\w{1,2},\w{1,2}=f\(gamma\)\)/);
    expect(out).toContain('{alpha:');
    expect(out).toContain('.beta,delta:document.title+');
    // A TypeScript annotation that starts with a word keeps its space.
    expect(I.compactPieces('const x = y$T{ as any};').join('')).toBe('const x=y$T{ as any};');
  });

  it('cuts long text where a host language concatenates it again', () => {
    const quote = (s) => JSON.stringify(s);
    expect(I.literalLines('aaa bbb ccc', 9, quote)).toEqual(['"aaa "', '"bbb ccc"']);
    // A word longer than the width is cut inside, never past it.
    const long = I.literalLines(`x ${'y'.repeat(30)} z`, 12, quote);
    expect(long.every((l) => l.length <= 12)).toBe(true);
    expect(long.map((l) => JSON.parse(l)).join('')).toBe(`x ${'y'.repeat(30)} z`);
    // No chunk ends in a backslash; each costs at most the width.
    const cost = (c) => (c === '\\' ? 2 : 1);
    const chunks = I.chunkText('ab\\cd\\ef', 4, cost);
    expect(chunks).toEqual(['ab', '\\cd', '\\ef']);
    for (const c of chunks) {
      expect(c.endsWith('\\')).toBe(false);
      expect([...c].reduce((n, ch) => n + cost(ch), 0)).toBeLessThanOrEqual(4);
    }
    expect(I.wrapPieces(['a', '"b"', ';', 'c'], 4, (c) => (c === '"' ? 2 : 1))).toEqual(['a', '"b"', ';c']);
  });

  it('is a fraction of the readable source', () => {
    expect(I.MATCH_JS.length).toBeLessThan(I.MATCH_SRC.length * 0.75);
    expect(I.MATCH_JS.split('\n').length).toBeLessThan(150);
  });
});
