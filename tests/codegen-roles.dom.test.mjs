// @vitest-environment jsdom
//
// Role parity between the locator engine and the Locatra helpers' in-page matcher
// (codegen.js MATCH_SRC, which every non-Playwright target runs: locatraFind /
// locatra_find / Locatra.find / Locatra.Find / locatraGet). Every row of the engine's
// Playwright-verified role tables (tests/locator-engine-roles.dom.test.mjs, read from
// that file so the two can never drift apart) and the extra rows below is rendered,
// and for EVERY role the element set the engine resolves getByRole(role) to must equal
// the set the matcher finds. A matcher that misses an element the engine gave a role
// made the exported test fail to find what Playwright finds; one that matches more
// made `nth` and "exactly one" disagree with the panel. Checking every role, not just
// the row's, also covers the rows whose subject has no role (a header inside an
// article, a lone <th>). (The role XPath this used to check is gone: C9.4.)
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let E;
let I;
let C;
let matchScript;
beforeAll(async () => {
  vm.runInThisContext(readFileSync(join(ROOT, 'src/content-locator-engine.js'), 'utf8'), {
    filename: 'src/content-locator-engine.js',
  });
  E = globalThis.__LocatorLensEngine;
  await import('../src/codegen.js');
  C = globalThis.LLCodegen;
  I = C._internals;
  // The matcher exactly as WebDriver runs it (executeScript(MATCH_JS, …)).
  matchScript = new Function(I.MATCH_JS);
  const real = window.getComputedStyle.bind(window);
  window.getComputedStyle = (el, pseudo) => (pseudo ? null : real(el));
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

// Corner cases the engine table lacks, with the role the engine gives the subject
// (asserted below, so an engine change shows up here first).
const EXTRA = [
  // Only the first VALID token counts: a later valid token is not the role.
  ['<div id="subject" role="switch checkbox">x</div>', 'switch'],
  ['<div id="subject" role="none button">x</div>', 'none'],
  ['<button id="subject" role="">x</button>', 'button'],
  ['<button id="subject" role="  ">x</button>', 'button'],
  ['<button id="subject" role="none" disabled aria-busy="true">x</button>', 'button'],
  ['<button id="subject" role="none" disabled>x</button>', 'none'],
  ['<fieldset disabled><legend><button id="subject" role="none">x</button></legend></fieldset>', 'button'],
  ['<input id="subject" role="none" hidden>', 'none'],
  ['<input id="subject" role="none" hidden tabindex="0">', 'textbox'],
  ['<div id="subject" role="none" tabindex="">x</div>', null],
  ['<img id="subject" alt="" tabindex="abc">', 'presentation'],
  // The input type as e.type reads it (lower-cased; unknown is text).
  ['<input id="subject" type="CHECKBOX">', 'checkbox'],
  ['<input id="subject" type="password" list="dl"><datalist id="dl"></datalist>', 'textbox'],
  ['<input id="subject" type="bogus" list="dl"><datalist id="dl"></datalist>', 'combobox'],
  ['<input id="subject" type="Email" list="dl"><datalist id="dl"></datalist>', 'combobox'],
  // Landmarks inside every kind of sectioning content, and a sectioning element whose
  // role attribute takes it out of that set.
  ['<aside><header id="subject">h</header></aside>', null],
  ['<main><footer id="subject">f</footer></main>', null],
  ['<div role="region"><footer id="subject">f</footer></div>', null],
  ['<section role="none"><header id="subject">h</header></section>', 'banner'],
  // A lone <th>: no role in a one-row table (wherever that row is), else a column header.
  ['<table><thead><tr><th id="subject">H</th></tr></thead></table>', null],
  ['<table><tr><th id="subject">H</th></tr><tr><td>1</td></tr></table>', 'columnheader'],
  [
    '<table><thead><tr><th id="subject">H</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>',
    'columnheader',
  ],
  // An empty corner cell (no-break space, white space only) does not make a row header.
  [
    '<table><tr><td>&nbsp;</td><th id="subject">Q1</th><th>Q2</th></tr><tr><td>a</td><td>1</td><td>2</td></tr></table>',
    'columnheader',
  ],
  [
    '<table><tr><td>&nbsp;</td><th id="subject">Q1</th></tr><tr><td>a</td><td>1</td></tr></table>',
    'columnheader',
  ],
  [
    '<table><tr><td> \n </td><th id="subject">Q1</th></tr><tr><td>a</td><td>1</td></tr></table>',
    'columnheader',
  ],
  [
    '<table><tr><td>a&nbsp;</td><th id="subject">Q1</th></tr><tr><td>a</td><td>1</td></tr></table>',
    'rowheader',
  ],
  // A <td>'s grid is its nearest table's.
  ['<table role="grid"><tr><td><table><tr><td id="subject">x</td></tr></table></td></tr></table>', 'cell'],
  ['<table role="grid"><tr><td id="subject">x</td></tr></table>', 'gridcell'],
  // A presentational owner keeps its items' roles when it has a global ARIA attribute
  // (aria-label counts under none, not under presentation, which prohibits naming).
  ['<ul role="none" aria-label="x"><li id="subject">x</li></ul>', 'listitem'],
  ['<ul role="presentation" aria-label="x"><li id="subject">x</li></ul>', 'presentation'],
  ['<table><tbody role="none"><tr><td id="subject">x</td></tr></tbody></table>', 'none'],
  ['<table role="none"><tbody><tr><th id="subject">H</th><td>x</td></tr></tbody></table>', 'none'],
  ['<div role="heading" aria-level="7" id="subject">Summary</div><h2>Summary</h2>', 'heading'],
];

// Every role the engine can give an element.
const ROLES = (
  'alert alertdialog application article banner blockquote button caption cell checkbox code columnheader ' +
  'combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form ' +
  'generic grid gridcell group heading img insertion link list listbox listitem log main mark marquee math meter ' +
  'menu menubar menuitem menuitemcheckbox menuitemradio navigation none note option paragraph presentation ' +
  'progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider ' +
  'spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer ' +
  'toolbar tooltip tree treegrid treeitem'
).split(' ');

/** What getByRole(role) resolves to in the engine (hidden elements skipped). */
function engineRole(role, level) {
  return E.resolveTarget({ kind: 'role', role, ...(level ? { level } : {}) });
}

function byMatcher(role, level = 0) {
  return matchScript('role', role, null, false, level, null);
}

function render(html) {
  document.body.innerHTML = html;
}

const ids = (els) => els.map((e) => e.id || e.localName);

describe('the matcher gives every element the role the engine (and Playwright) gives it', () => {
  const rows = pwVerifiedRows();

  it('reads the engine tables', () => {
    expect(rows.length).toBeGreaterThan(60);
  });

  it('the extra rows are what the engine says', () => {
    for (const [html, role] of EXTRA) {
      render(html);
      expect(E.getRole(document.getElementById('subject')), html).toBe(role);
    }
  });

  const cases = rows
    .filter(([, , , opts]) => !(opts && opts.shadow))
    .map(([table, html]) => [table, html])
    .concat(EXTRA.map(([html]) => ['extra', html]));

  it.each(cases)('%s: %s', (table, html) => {
    render(html);
    for (const role of ROLES) {
      expect(ids(byMatcher(role)), role).toEqual(ids(engineRole(role)));
    }
  });
});

describe('explicit role attributes', () => {
  it('match a role listed as one token of several, after unknown tokens', () => {
    render(
      '<div role="foo checkbox" id="a">x</div><div role="checkbox" id="b">y</div>' +
        '<div role=" checkbox  " id="c">z</div><div role="checkboxes" id="d">no</div>' +
        '<div role="switch checkbox" id="e">no</div>'
    );
    expect(ids(byMatcher('checkbox'))).toEqual(['a', 'b', 'c']);
    expect(ids(engineRole('checkbox'))).toEqual(['a', 'b', 'c']);
  });

  // The role XPath read only the first token and could not tell later tokens apart
  // (role="foo switch checkbox" matched checkbox); the matcher walks every token, as
  // Playwright does.
  it('takes the first valid token, wherever it is', () => {
    render('<div role="foo switch checkbox" id="s">x</div><button role="foo bar" id="b">y</button>');
    expect(E.getRole(document.getElementById('s'))).toBe('switch');
    expect(E.getRole(document.getElementById('b'))).toBe('button');
    expect(ids(byMatcher('checkbox'))).toEqual([]);
    expect(ids(byMatcher('switch'))).toEqual(['s']);
    expect(ids(byMatcher('button'))).toEqual(['b']);
  });

  it('narrow a heading by level: the tag for <h1>–<h6>, else aria-level, up to 99', () => {
    render(
      '<div role="heading" aria-level="2" id="h">x</div><h2 id="n">y</h2><h3 id="o">z</h3>' +
        '<h3 role="heading" aria-level="2" id="t">t</h3><h2 role="heading" id="r">r</h2>' +
        '<div role="heading" aria-level="7" id="s">Summary</div>'
    );
    for (const level of [2, 3, 7]) {
      expect(ids(byMatcher('heading', level)), String(level)).toEqual(ids(engineRole('heading', level)));
    }
    expect(ids(byMatcher('heading', 2))).toEqual(['h', 'n', 'r']);
    expect(ids(byMatcher('heading', 7))).toEqual(['s']);
    expect(ids(byMatcher('heading', 3))).toEqual(['o', 't']);
    expect(I.headingLevel(99)).toBe(99);
    expect(I.headingLevel(100)).toBe(0);
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
  ])('%s → %s', (html, role, want) => {
    render(html);
    expect(ids(engineRole(role))).toEqual(want);
    expect(ids(byMatcher(role)), 'matcher').toEqual(want);
  });
});

describe('every framework but Playwright uses the helper', () => {
  it('Selenium, WebdriverIO and Cypress call it, named or not; Playwright keeps getByRole', () => {
    const t = { kind: 'role', role: 'checkbox' };
    expect(C.locatorExpr(t, 'selenium', 'javascript')).toBe(
      "locatraFind(driver, 'role', 'checkbox', null, { nth: 0 })"
    );
    expect(C.locatorExpr(t, 'cypress', 'javascript')).toBe(
      "locatraGet('role', 'checkbox', null, { nth: 0 })"
    );
    expect(C.locatorExpr(t, 'playwright', 'javascript')).toBe("page.getByRole('checkbox')");
    // An unknown role is passed through; the matcher (like Playwright) gives it to nothing.
    expect(C.locatorExpr({ kind: 'role', role: 'doc-tip' }, 'cypress', 'javascript')).toBe(
      "locatraGet('role', 'doc-tip', null, { nth: 0 })"
    );
    render('<div role="doc-tip" id="x">t</div>');
    expect(byMatcher('doc-tip')).toEqual([]);
  });

  it('declares the helper once, only when a role / label / text locator needs it', () => {
    const steps = [
      { action: 'click', target: { kind: 'role', role: 'button', name: 'Go' } },
      { action: 'click', target: { kind: 'role', role: 'link' } },
    ];
    const spec = C.testScript(steps, 'cypress', 'typescript');
    expect(spec.match(/function locatraMatch\(/g)).toHaveLength(1);
    expect(spec.match(/function locatraGet\(/g)).toHaveLength(1);
    expect(spec.indexOf('function locatraMatch')).toBeLessThan(spec.indexOf('function locatraGet'));
    const plain = C.testScript(
      [{ action: 'click', target: { kind: 'testid', attr: 'data-testid', value: 'x' } }],
      'cypress',
      'javascript'
    );
    expect(plain).not.toContain('locatra');
  });
});
