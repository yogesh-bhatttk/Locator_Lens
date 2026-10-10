// @vitest-environment jsdom
//
// Role parity between the locator engine and the Selenium / Cypress / WebdriverIO role
// selectors (codegen.js roleCss / roleNodeXpath). Every row of the engine's
// Playwright-verified role tables (tests/locator-engine-roles.dom.test.mjs, read from
// that file so the two can never drift apart) is rendered, and for its role the
// element set the engine assigns that role to must equal the set the CSS selector
// and the XPath select. A selector that misses an element the engine gave a role
// made the exported test fail to find what Playwright finds; one that matches more
// made `nth` and "first match" point at a different element.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let E;
let I;
beforeAll(async () => {
  vm.runInThisContext(readFileSync(join(ROOT, 'src/content-locator-engine.js'), 'utf8'), {
    filename: 'src/content-locator-engine.js',
  });
  E = globalThis.__LocatorLensEngine;
  await import('../src/codegen.js');
  I = globalThis.LLCodegen._internals;
});

/** Every `// pw-verified:roles` table of the engine's role tests, row by row. */
function pwVerifiedRows() {
  const src = readFileSync(join(ROOT, 'tests/locator-engine-roles.dom.test.mjs'), 'utf8');
  const rows = [];
  const re = /\/\/ pw-verified:roles\s*\n\s*const (\w+) = (\[[\s\S]*?\n\s*\]);\s*\n\s*\/\/ end pw-verified/g;
  let m;
  while ((m = re.exec(src))) {
    for (const row of new Function(`return ${m[2]};`)()) rows.push([m[1], ...row]);
  }
  return rows;
}

// Rows whose subject has no role a locator would be generated for.
const NO_LOCATOR_ROLES = [null, 'none', 'presentation', 'generic'];

// What CSS cannot express, so the selectors knowingly differ from the engine here
// (codegen.js lists the same gaps above ROLE_NATIVE). Keyed by the row's markup.
const KNOWN_GAPS = {
  // role=none/presentation is ignored on a focusable element or one with a global
  // ARIA attribute; the selectors only take the implicit role without any role attribute.
  '<button id="subject" role="presentation">X</button>': 'none/presentation conflict',
  '<a id="subject" role="none" href="#">x</a>': 'none/presentation conflict',
  '<input id="subject" role="none">': 'none/presentation conflict',
  '<select id="subject" role="none"></select>': 'none/presentation conflict',
  '<h1 id="subject" role="none" aria-describedby="d">x</h1>': 'none/presentation conflict',
  '<h1 id="subject" role="none" aria-label="L">x</h1>': 'none/presentation conflict',
  // A role attribute of unknown tokens only leaves the implicit role in place.
  '<button id="subject" role="bogus">x</button>': 'invalid-only role attribute',
  // list= makes a combobox only when it names a <datalist> (an IDREF lookup).
  '<input id="subject" list="dl3"><div id="dl3"></div>': 'list= IDREF target',
  '<input id="subject" list="nope">': 'list= IDREF target',
};

function elementsWithRole(role) {
  return [...document.querySelectorAll('*')].filter((el) => E.getRole(el) === role);
}

function byXpath(xpath) {
  const r = document.evaluate(xpath, document, null, 7, null);
  return Array.from({ length: r.snapshotLength }, (_, i) => r.snapshotItem(i));
}

function render(html) {
  document.body.innerHTML = html;
}

describe('the role selectors select what the engine (and Playwright) call that role', () => {
  const rows = pwVerifiedRows();

  it('reads the engine tables', () => {
    expect(rows.length).toBeGreaterThan(60);
  });

  const cases = rows.filter(
    ([, html, role, opts]) => !NO_LOCATOR_ROLES.includes(role) && !(opts && opts.shadow) && !KNOWN_GAPS[html]
  );

  it.each(cases)('%s: %s → %s', (table, html, role) => {
    render(html);
    const want = elementsWithRole(role);
    expect(want.length).toBeGreaterThan(0);
    expect([...document.querySelectorAll(I.roleCss(role))], 'CSS').toEqual(want);
    expect(byXpath(`//*[${I.roleNodeXpath(role)}]`), 'XPath').toEqual(want);
  });

  it.each(Object.entries(KNOWN_GAPS))('known gap, still differs: %s (%s)', (html) => {
    const row = rows.find((r) => r[1] === html);
    expect(row, 'the row is still in the engine table').toBeTruthy();
    render(html);
    const want = elementsWithRole(row[2]);
    // If this starts passing, the gap was closed: move the row back into the parity set.
    expect([...document.querySelectorAll(I.roleCss(row[2]))]).not.toEqual(want);
  });

  it('skips only the shadow-DOM rows (a document-level selector cannot see into them; C3 covers it)', () => {
    const shadow = rows.filter(([, , role, opts]) => opts && opts.shadow && !NO_LOCATOR_ROLES.includes(role));
    expect(shadow.map((r) => r[2])).toEqual(['banner']);
  });
});

describe('explicit role attributes', () => {
  it('match a role listed as one token of several', () => {
    render(
      '<div role="foo checkbox" id="a">x</div><div role="checkbox" id="b">y</div>' +
        '<div role=" checkbox  " id="c">z</div><div role="checkboxes" id="d">no</div>'
    );
    const ids = (els) => els.map((e) => e.id);
    expect(ids(elementsWithRole('checkbox'))).toEqual(['a', 'b', 'c']);
    expect(ids([...document.querySelectorAll(I.roleCss('checkbox'))])).toEqual(['a', 'b', 'c']);
    expect(ids(byXpath(`//*[${I.roleNodeXpath('checkbox')}]`))).toEqual(['a', 'b', 'c']);
  });

  it('cannot tell an earlier valid token apart in CSS (documented over-match)', () => {
    render('<div role="switch checkbox" id="s">x</div>');
    expect(E.getRole(document.getElementById('s'))).toBe('switch');
    expect(document.querySelectorAll(I.roleCss('checkbox'))).toHaveLength(1);
  });

  it('narrow a heading by aria-level only for a valid level', () => {
    render('<div role="heading" aria-level="2" id="h">x</div><h2 id="n">y</h2><h3 id="o">z</h3>');
    expect([...document.querySelectorAll(I.roleCss('heading', 2))].map((e) => e.id)).toEqual(['h', 'n']);
    expect(byXpath(`//*[${I.roleNodeXpath('heading', 2)}]`).map((e) => e.id)).toEqual(['h', 'n']);
    expect(I.roleCss('heading', '2"]')).toBe(I.roleCss('heading'));
  });
});

describe('the rows the audit found', () => {
  it.each([
    [
      '<select id="s" size="4"><option>A</option></select><select id="c"><option>B</option></select>',
      'listbox',
      ['s'],
    ],
    [
      '<select id="s" size="1"><option>A</option></select><select id="m" size="3" multiple></select>',
      'combobox',
      ['s'],
    ],
    [
      '<table><tr><th id="s">Name</th><td>Bob</td></tr><tr><th id="t">Age</th><td>3</td></tr></table>',
      'rowheader',
      ['s', 't'],
    ],
    [
      '<table><tr><th id="s">Name</th><td>Bob</td></tr><tr><th id="t">Age</th><td>3</td></tr></table>',
      'columnheader',
      [],
    ],
    [
      '<img id="s" alt="" title="Logo"><img id="d" alt=""><img id="k" alt="" tabindex="0">',
      'img',
      ['s', 'k'],
    ],
    ['<p>Posted <time id="s">yesterday</time> <sub id="b">2</sub><sup id="p">3</sup></p>', 'time', ['s']],
    ['<p><sub id="b">2</sub><sup id="p">3</sup></p>', 'subscript', ['b']],
    ['<p><sub id="b">2</sub><sup id="p">3</sup></p>', 'superscript', ['p']],
    ['<math id="m"><mi>x</mi></math>', 'math', ['m']],
  ])('%s → %s', (html, role, ids) => {
    render(html);
    expect(elementsWithRole(role).map((e) => e.id)).toEqual(ids);
    expect(
      [...document.querySelectorAll(I.roleCss(role))].map((e) => e.id),
      'CSS'
    ).toEqual(ids);
    expect(
      byXpath(`//*[${I.roleNodeXpath(role)}]`).map((e) => e.id),
      'XPath'
    ).toEqual(ids);
  });
});
