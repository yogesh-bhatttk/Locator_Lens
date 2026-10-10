// @vitest-environment jsdom
//
// The Locatra helpers (C9.4) — locatraFind / locatra_find / Locatra.find /
// Locatra.Find / locatraGet — all run one in-page matcher (codegen.js MATCH_SRC, a
// port of the locator engine). A matcher that finds a different element than the
// engine made the exported test act on something other than what the panel showed,
// so it runs here, in jsdom, against the engine on every Playwright-verified table
// the engine suites keep (roles, accessible names, match counts), read from those
// files so the two can never drift apart.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let E;
let C;
let I;
/** The matcher exactly as WebDriver runs it: executeScript(MATCH_JS, …args). */
let matchScript;
/** The matcher exactly as a Cypress spec declares it. */
let matchFunction;
beforeAll(async () => {
  vm.runInThisContext(readFileSync(join(ROOT, 'src/content-locator-engine.js'), 'utf8'), {
    filename: 'src/content-locator-engine.js',
  });
  E = globalThis.__LocatorLensEngine;
  await import('../src/codegen.js');
  await import('../src/codegen-wdio.js');
  C = globalThis.LLCodegen;
  I = C._internals;
  matchScript = new Function(I.MATCH_JS);
  matchFunction = new Function(`${I.tsOnly(I.MATCH_SRC, 'javascript')}\nreturn locatraMatch;`)();
  // jsdom has no pseudo-element styles (it logs "not implemented" and answers with
  // the element's own style); the engine skips them there, and so does this.
  const real = window.getComputedStyle.bind(window);
  window.getComputedStyle = (el, pseudo) => (pseudo ? null : real(el));
});

function match(kind, value, name = null, exact = false, level = 0, scope = null) {
  const a = matchScript(kind, value, name, exact, level, scope);
  const b = matchFunction(kind, value, name, exact, level, scope || document);
  expect(b).toEqual(a);
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

  it('embeds verbatim in every host language (String.raw, a raw Python string, @"…", one literal per line)', () => {
    // A backtick or "${" would end / interpolate the JS String.raw template, '"""' the
    // Python raw string; plain ASCII keeps javac's -encoding US-ASCII happy.
    expect(I.MATCH_JS).not.toMatch(/`|\$\{|"""/);
    expect(I.MATCH_JS).toMatch(/^[\x20-\x7e\n]*$/);
    expect(I.MATCH_JS.endsWith('\\')).toBe(false);
  });

  it('rejects an unknown kind loudly', () => {
    render('<p>x</p>');
    expect(() => matchScript('nope', 'x', null, false, 0, null)).toThrow(
      'Locatra: unknown locator kind nope'
    );
  });
});
