// @vitest-environment jsdom
//
// What the locator engine *produces*: the live match counts behind every badge, the
// locator cards (code, matchCount, ranking, the exact/truncated variants, chained
// parents, the CSS fallback) and the report around them.
//
// Every `pw-verified` table was checked against Playwright 1.59.1 in Chromium:
// `counts` rows by building the same Playwright locator and calling .count();
// `locators` rows by evaluating each card's displayed `code` against the page and
// comparing .count() — and, for cards marked unique, that the one match is the
// analysed element. The engine claims Playwright's semantics, so Playwright is the
// expected value; a row that disagrees with Playwright is an engine bug.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ATTRS = ['data-testid', 'data-qa', 'data-cy', 'data-test', 'data-automation-id', 'data-e2e'];

let E;
beforeAll(() => {
  vm.runInThisContext(readFileSync(join(ROOT, 'src/content-locator-engine.js'), 'utf8'), {
    filename: 'src/content-locator-engine.js',
  });
  E = globalThis.__LocatorLensEngine;
});

beforeEach(() => {
  document.body.innerHTML = '';
});

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

function analyse(el, attrs = DEFAULT_ATTRS) {
  return E.generateLocators(el, attrs);
}

const LOREM =
  'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua';
const UNBROKEN = 'Supercalifragilisticexpialidociousandthensomemorelettersuntilitisreallyverylongindeedok';
const role = (r, name, o = {}) => ({ kind: 'role', role: r, ...(name != null ? { name } : {}), ...o });
const byText = (value, o = {}) => ({ kind: 'text', value, ...o });
const byLabel = (value, o = {}) => ({ kind: 'label', value, ...o });
const byAttr = (kind, value, o = {}) => ({ kind, value, ...o });
const css = (value) => ({ kind: 'css', value });
const testid = (value, attr = 'data-testid') => ({ kind: 'testid', attr, value });
const chain = (parent, child) => ({ kind: 'chain', parent, child });

describe('countTargetMatches mirrors Playwright’s matching rules', () => {
  // pw-verified:counts
  const MATCHING = [
    // getByText: case-insensitive substring by default; exact is case-sensitive equality.
    ['<p>Hello World</p><p>hello world!</p><p>HELLO</p>', byText('hello'), 3],
    ['<p>Hello World</p><p>hello world!</p><p>HELLO</p>', byText('hello world'), 2],
    ['<p>Hello World</p><p>hello world!</p><p>HELLO</p>', byText('Hello World', { exact: true }), 1],
    ['<p>Hello World</p><p>hello world!</p><p>HELLO</p>', byText('hello world', { exact: true }), 0],
    ['<p>Hello World</p><p>hello world!</p><p>HELLO</p>', byText('ello wor'), 2],
    // Whitespace is normalised on both sides, also for exact.
    ['<p>  Multi \n  space\ttext </p><p>Multi space text extra</p>', byText('Multi space text'), 2],
    [
      '<p>  Multi \n  space\ttext </p><p>Multi space text extra</p>',
      byText('Multi space text', { exact: true }),
      1,
    ],
    ['<p>  Multi \n  space\ttext </p><p>Multi space text extra</p>', byText('  multi   SPACE text  '), 2],
    [
      '<p>  Multi \n  space\ttext </p><p>Multi space text extra</p>',
      byText('Multi  space   text', { exact: true }),
      1,
    ],
    // Regex-special characters are plain text.
    ['<p>Price (USD) $5.00 [approx]*</p><p>Price USD 5100 approx</p>', byText('(USD) $5.00'), 1],
    ['<p>Price (USD) $5.00 [approx]*</p><p>Price USD 5100 approx</p>', byText('$5.00 [approx]*'), 1],
    [
      '<p>Price (USD) $5.00 [approx]*</p><p>Price USD 5100 approx</p>',
      byText('Price (USD) $5.00 [approx]*', { exact: true }),
      1,
    ],
    ['<p>Price (USD) $5.00 [approx]*</p><p>Price USD 5100 approx</p>', byText('5.00'), 1],
    // Only the smallest element containing the text matches, never its ancestors —
    // but text split across children belongs to the parent.
    ['<div><span>Alpha</span> <b>Alpha</b></div>', byText('Alpha'), 2],
    ['<section>Alpha<span>Beta</span></section>', byText('Alpha'), 1],
    ['<section>Alpha<span>Beta</span></section>', byText('Beta'), 1],
    ['<section>Alpha<span>Beta</span></section>', byText('Alpha Beta'), 0],
    ['<article><span>Gam</span><span>ma</span></article>', byText('Gamma'), 1],
    ['<article><span>Gam</span><span>ma</span></article>', byText('Gam'), 1],
    // <input type=submit|button> is matched by its value; other inputs are not.
    [
      '<input type="submit" value="Send it"><input type="button" value="Push"><input type="text" value="Typed"><input type="reset" value="Clear">',
      byText('Send it'),
      1,
    ],
    [
      '<input type="submit" value="Send it"><input type="button" value="Push"><input type="text" value="Typed"><input type="reset" value="Clear">',
      byText('Push'),
      1,
    ],
    [
      '<input type="submit" value="Send it"><input type="button" value="Push"><input type="text" value="Typed"><input type="reset" value="Clear">',
      byText('Typed'),
      0,
    ],
    [
      '<input type="submit" value="Send it"><input type="button" value="Push"><input type="text" value="Typed"><input type="reset" value="Clear">',
      byText('Clear'),
      0,
    ],
    // <script>/<style> text is never matched.
    [
      '<div>Real<script>var fake="Fake script"</script><style>/*Styled*/</style></div>',
      byText('Fake script'),
      0,
    ],
    ['<div>Real<script>var fake="Fake script"</script><style>/*Styled*/</style></div>', byText('Styled'), 0],
    ['<div>Real<script>var fake="Fake script"</script><style>/*Styled*/</style></div>', byText('Real'), 1],
    // Shadow-root text is matched, and a host's text includes it.
    [
      '<div id="h5"></div><p>Light dup</p>',
      byText('Shadow dup'),
      1,
      { shadow: [['#h5', '<span>Shadow dup</span>']] },
    ],
    [
      '<div id="h5"></div><p>Light dup</p>',
      byText('dup'),
      2,
      { shadow: [['#h5', '<span>Shadow dup</span>']] },
    ],
    [
      '<div id="h6"><span>Light part</span></div>',
      byText('Light part'),
      1,
      { shadow: [['#h6', '<b>Shadow part</b> <slot></slot>']] },
    ],
    [
      '<div id="h6"><span>Light part</span></div>',
      byText('Shadow part'),
      1,
      { shadow: [['#h6', '<b>Shadow part</b> <slot></slot>']] },
    ],
    [
      '<div id="h6"><span>Light part</span></div>',
      byText('part'),
      2,
      { shadow: [['#h6', '<b>Shadow part</b> <slot></slot>']] },
    ],
    ['<p>In\u200bvisible</p><p>so\u00adft</p>', byText('Invisible'), 1],
    ['<p>In\u200bvisible</p><p>so\u00adft</p>', byText('soft', { exact: true }), 1],
    ['<p>In\u200bvisible</p><p>so\u00adft</p>', byText('In\u200bvisible', { exact: true }), 1],
    // A valueless submit input has no text (its "Submit" is only its accessible name);
    // comments contribute nothing.
    ['<input type="submit">', byText('Submit'), 0],
    ['<p>a<!-- c -->b</p>', byText('ab', { exact: true }), 1],
    // An empty needle matches every leaf; exact-empty matches nothing with text.
    ['<p>a</p><p>b</p>', byText(''), 2],
    ['<p>a</p><p>b</p>', byText('', { exact: true }), 0],
    // getByRole name: case-insensitive substring (Playwright upper-cases both sides).
    [
      '<button>Save Draft</button><button>save</button><button>SAVE ALL</button><button>Saved</button>',
      role('button', 'save'),
      4,
    ],
    [
      '<button>Save Draft</button><button>save</button><button>SAVE ALL</button><button>Saved</button>',
      role('button', 'Save', { exact: true }),
      0,
    ],
    [
      '<button>Save Draft</button><button>save</button><button>SAVE ALL</button><button>Saved</button>',
      role('button', 'save', { exact: true }),
      1,
    ],
    [
      '<button>Save Draft</button><button>save</button><button>SAVE ALL</button><button>Saved</button>',
      role('button', 'ave dr'),
      1,
    ],
    [
      '<button>Save Draft</button><button>save</button><button>SAVE ALL</button><button>Saved</button>',
      role('button', '  save   draft ', { exact: true }),
      0,
    ],
    [
      '<button>Save Draft</button><button>save</button><button>SAVE ALL</button><button>Saved</button>',
      role('button', 'Save  Draft'),
      1,
    ],
    ['<button>a.b (c)</button><button>axb c</button>', role('button', 'a.b'), 1],
    ['<button>a.b (c)</button><button>axb c</button>', role('button', 'x'), 1],
    // Upper- vs lower-casing differ for ß and İ — roles upper-case, text lower-cases.
    ['<button>STRASSE</button><button>straße</button><button>İstanbul</button>', role('button', 'straße'), 2],
    [
      '<button>STRASSE</button><button>straße</button><button>İstanbul</button>',
      role('button', 'istanbul'),
      0,
    ],
    ['<button>STRASSE</button><button>straße</button><button>İstanbul</button>', role('button', 'ß'), 2],
    ['<p>STRASSE</p><p>straße</p><p>İstanbul</p>', byText('straße'), 1],
    ['<p>STRASSE</p><p>straße</p><p>İstanbul</p>', byText('istanbul'), 0],
    ['<p>STRASSE</p><p>straße</p><p>İstanbul</p>', byText('ß'), 1],
    // An empty name is "no name filter".
    ['<button></button><button>Named</button>', role('button', ''), 2],
    // getByLabel: aria-labelledby, then aria-label, then <label>s — any element.
    [
      '<label for="a">Email</label><input id="a"><label>Email again <input></label><button aria-label="Email me">x</button><span id="lb">Email via labelledby</span><div aria-labelledby="lb">d</div><input aria-label="   " placeholder="Email ph">',
      byLabel('Email'),
      4,
    ],
    [
      '<label for="a">Email</label><input id="a"><label>Email again <input></label><button aria-label="Email me">x</button>',
      byLabel('email', { exact: true }),
      0,
    ],
    [
      '<label for="a">Email</label><input id="a"><label>Email again <input></label><button aria-label="Email me">x</button>',
      byLabel('Email', { exact: true }),
      1,
    ],
    ['<span id="lb">Email via labelledby</span><div aria-labelledby="lb">d</div>', byLabel('labelledby'), 1],
    ['<input aria-label="   " placeholder="Email ph">', byLabel('Email ph'), 0],
    // A blank aria-label is no label, and a <div> has no <label>s to fall back to.
    ['<div aria-label=" ">Spaces</div>', byLabel('Spaces'), 0],
    // A wrapping label's text includes the control's own text (option, textarea value).
    [
      '<label>Size <select><option>Large</option></select></label>',
      byLabel('Size Large', { exact: true }),
      1,
    ],
    ['<label>Size <select><option>Large</option></select></label>', byLabel('Size', { exact: true }), 0],
    ['<label>Notes <textarea>draft</textarea></label>', byLabel('Notes draft', { exact: true }), 1],
    [
      '<label for="x">Native</label><input id="x" aria-labelledby="y"><span id="y">Override</span>',
      byLabel('Native'),
      0,
    ],
    [
      '<label for="x">Native</label><input id="x" aria-labelledby="y"><span id="y">Override</span>',
      byLabel('Override'),
      1,
    ],
    [
      '<label for="z">Native2</label><input id="z" aria-labelledby="nope" aria-label="Aria2">',
      byLabel('Native2'),
      0,
    ],
    [
      '<label for="z">Native2</label><input id="z" aria-labelledby="nope" aria-label="Aria2">',
      byLabel('Aria2'),
      1,
    ],
    [
      '<label for="hid">Hidden input label</label><input id="hid" type="hidden"><label>Wrap hidden <input type="hidden"></label>',
      byLabel('Hidden input label'),
      0,
    ],
    [
      '<label for="hid">Hidden input label</label><input id="hid" type="hidden"><label>Wrap hidden <input type="hidden"></label>',
      byLabel('Wrap hidden'),
      0,
    ],
    ['<label for="dv">Div label</label><div id="dv" tabindex="0">d</div>', byLabel('Div label'), 0],
    ['<label>Both <input id="i1"><input id="i2"></label>', byLabel('Both'), 1],
    [
      '<div id="h8"></div>',
      byLabel('Shadow label', { exact: true }),
      1,
      { shadow: [['#h8', '<label for="si">Shadow label</label><input id="si">']] },
    ],
    // A hidden <label> still labels (getByLabel is not an a11y-tree query).
    [
      '<label for="q1" style="display:none">Invisible lbl</label><input id="q1">',
      byLabel('Invisible lbl'),
      1,
    ],
    [
      '<label for="m">Meter L</label><meter id="m"></meter><label for="pg">Prog L</label><progress id="pg"></progress><label for="o">Out L</label><output id="o"></output><label for="b">Btn L</label><button id="b">B</button>',
      byLabel('Meter L'),
      1,
    ],
    [
      '<label for="m">Meter L</label><meter id="m"></meter><label for="pg">Prog L</label><progress id="pg"></progress><label for="o">Out L</label><output id="o"></output><label for="b">Btn L</label><button id="b">B</button>',
      byLabel('Btn L'),
      1,
    ],
    // getByPlaceholder / getByAltText / getByTitle: raw attribute, no whitespace
    // normalisation; substring is case-insensitive, exact is byte-for-byte.
    [
      '<input placeholder="Search Items"><input placeholder="search"><input placeholder=" padded ">',
      byAttr('placeholder', 'search'),
      2,
    ],
    [
      '<input placeholder="Search Items"><input placeholder="search"><input placeholder=" padded ">',
      byAttr('placeholder', 'Search Items', { exact: true }),
      1,
    ],
    [
      '<input placeholder="Search Items"><input placeholder="search"><input placeholder=" padded ">',
      byAttr('placeholder', 'search items', { exact: true }),
      0,
    ],
    [
      '<input placeholder="Search Items"><input placeholder="search"><input placeholder=" padded ">',
      byAttr('placeholder', 'padded', { exact: true }),
      0,
    ],
    [
      '<input placeholder="Search Items"><input placeholder="search"><input placeholder=" padded ">',
      byAttr('placeholder', ' padded ', { exact: true }),
      1,
    ],
    ['<img alt="Company Logo"><img alt="logo">', byAttr('altText', 'LOGO'), 2],
    ['<img alt="Company Logo"><img alt="logo">', byAttr('altText', 'logo', { exact: true }), 1],
    [
      '<span title="Tool Tip">t</span><span title="tip">t</span><div title="">e</div>',
      byAttr('title', 'tip'),
      2,
    ],
    [
      '<span title="Tool Tip">t</span><span title="tip">t</span><div title="">e</div>',
      byAttr('title', ''),
      3,
    ],
    [
      '<div id="h9"></div><input placeholder="Find">',
      byAttr('placeholder', 'Find'),
      2,
      { shadow: [['#h9', '<input placeholder="Find more" title="Shadow title">']] },
    ],
    [
      '<div id="h9"></div>',
      byAttr('title', 'Shadow title'),
      1,
      { shadow: [['#h9', '<input placeholder="Find more" title="Shadow title">']] },
    ],
    // CSS, test id and chains pierce shadow roots.
    ['<div class="x"></div><div class="x"></div>', css('.x'), 2],
    ["<div data-qa='q\"1'></div>", testid('q"1', 'data-qa'), 1],
    [
      '<div id="h"></div><b data-testid="t">x</b>',
      testid('t'),
      2,
      { shadow: [['#h', '<i data-testid="t">y</i>']] },
    ],
    [
      '<div id="card"><x-a id="h"></x-a></div><button>Buy</button>',
      chain(css('#card'), role('button', 'Buy')),
      1,
      { shadow: [['#h', '<button>Buy</button>']] },
    ],
    [
      '<div id="card"><x-a id="h"></x-a></div><button>Buy</button>',
      chain(css('#h'), role('button', 'Buy')),
      1,
      { shadow: [['#h', '<button>Buy</button>']] },
    ],
    // A scope never matches itself for role/css children…
    ['<div class="box"><div class="box">x</div></div>', chain(css('.box'), css('.box')), 1],
    // …but getByText also tests the scope element itself.
    [
      '<ul><li data-testid="r1">Edit</li><li data-testid="r2">Edit</li></ul>',
      chain(testid('r2'), byText('Edit')),
      1,
    ],
    [
      '<ul><li data-testid="r1">Edit</li><li data-testid="r2">View</li></ul>',
      chain(css('ul'), byText('Edit')),
      1,
    ],
  ];
  // end pw-verified

  it.each(MATCHING)('%s %j → %i', (html, target, count, opts) => {
    render(html, opts);
    expect(E.countTargetMatches(target)).toBe(count);
  });

  it('returns null for targets it cannot evaluate', () => {
    render('<p>x</p>');
    expect(E.countTargetMatches(null)).toBeNull();
    expect(E.countTargetMatches({ kind: 'nope', value: 'x' })).toBeNull();
    // Playwright throws on an invalid selector; the engine reports "cannot evaluate".
    expect(E.countTargetMatches(css('[['))).toBeNull();
    expect(E.countTargetMatches(chain(css('[['), byText('x')))).toBeNull();
    expect(E.countTargetMatches(chain(css('p'), css('[[')))).toBeNull();
    expect(E.countTargetMatches({ kind: 'chain', child: css('p') })).toBeNull();
  });

  it('matches an id target by the escaped id', () => {
    // page.locator('#a\\:b').count() === 1 in Playwright.
    render('<div id="a:b"></div><div id="a"></div>');
    expect(E.countTargetMatches({ kind: 'id', value: 'a:b' })).toBe(1);
    expect(E.countTargetMatches({ kind: 'name', value: 'nm' })).toBe(0);
  });
});

describe('generated locator cards', () => {
  /** [code, matchCount, unique] for every card, in rank order. */
  const cards = (r) => r.locators.map((l) => [l.code, l.matchCount, !!l.unique]);

  // pw-verified:locators
  const EXACT_AND_TRUNCATION = [
    // exact role name
    [
      '<button>Save</button><button id="subject">Sav</button>',
      [
        ["page.getByRole('button', { name: 'Sav', exact: true })", 1, true],
        ["page.getByText('Sav', { exact: true })", 1, true],
        ["page.locator('#subject')", 1, true],
      ],
    ],
    // exact text
    [
      '<p>Total</p><p id="subject">Tot</p>',
      [
        ["page.getByText('Tot', { exact: true })", 1, true],
        ["page.locator('#subject')", 1, true],
        ["page.getByRole('paragraph')", 2, false],
      ],
    ],
    // exact text differing only in case
    [
      '<span>Next</span><span id="subject">next</span>',
      [
        ["page.getByText('next', { exact: true })", 1, true],
        ["page.locator('#subject')", 1, true],
      ],
    ],
    // exact label
    [
      '<label for="a">Name</label><input id="a"><label for="subject">Nam</label><input id="subject">',
      [
        ["page.getByRole('textbox', { name: 'Nam', exact: true })", 1, true],
        ["page.getByLabel('Nam', { exact: true })", 1, true],
        ["page.locator('#subject')", 1, true],
      ],
    ],
    // exact placeholder
    [
      '<input placeholder="Search all"><input id="subject" placeholder="Search">',
      [
        ["page.getByRole('textbox', { name: 'Search', exact: true })", 1, true],
        ["page.getByPlaceholder('Search', { exact: true })", 1, true],
        ["page.locator('#subject')", 1, true],
      ],
    ],
    // exact alt text
    [
      '<img alt="Logo big"><img id="subject" alt="Logo">',
      [
        ["page.getByRole('img', { name: 'Logo', exact: true })", 1, true],
        ["page.getByAltText('Logo', { exact: true })", 1, true],
        ["page.locator('#subject')", 1, true],
      ],
    ],
    // exact title
    [
      '<span title="Help me">a</span><span id="subject" title="Help">b</span>',
      [
        ["page.getByTitle('Help', { exact: true })", 1, true],
        ["page.getByText('b')", 1, true],
        ["page.locator('#subject')", 1, true],
      ],
    ],
    // exact does not help
    [
      '<button>Save</button><button>Save</button><button id="subject">Save</button>',
      [
        ["page.locator('#subject')", 1, true],
        ["page.getByRole('button', { name: 'Save' })", 3, false],
        ["page.getByText('Save')", 3, false],
      ],
    ],
    // long text: word-bounded prefix
    [
      '<p id="subject">' + LOREM + '</p>',
      [
        ["page.getByText('Lorem ipsum dolor sit amet consectetur adipiscing elit sed')", 1, true],
        ["page.getByRole('paragraph')", 1, true],
        ["page.locator('#subject')", 1, true],
      ],
    ],
    // long text prefix shared with another element
    [
      '<p>' + LOREM + ' more</p><p id="subject">' + LOREM + '</p>',
      [
        ["page.locator('#subject')", 1, true],
        ["page.getByText('Lorem ipsum dolor sit amet consectetur adipiscing elit sed')", 2, false],
        ["page.getByRole('paragraph')", 2, false],
      ],
    ],
    // text over 200 chars: no text card
    [
      '<p id="subject">' + 'x'.repeat(250) + '</p>',
      [
        ["page.getByRole('paragraph')", 1, true],
        ["page.locator('#subject')", 1, true],
      ],
    ],
    // long role name
    [
      '<button id="subject">Proceed to the next step of the checkout process and confirm your shipping address now</button><button>Proceed to the next step of the checkout process and confirm your shipping address now please</button>',
      [
        ["page.locator('#subject')", 1, true],
        [
          "page.getByRole('button', { name: 'Proceed to the next step of the checkout process and confirm your shipping' })",
          2,
          false,
        ],
        ["page.getByText('Proceed to the next step of the checkout process and')", 2, false],
      ],
    ],
    // long label
    [
      '<label for="subject">Please enter the full legal name exactly as it appears on your government issued identity document</label><input id="subject">',
      [
        [
          "page.getByRole('textbox', { name: 'Please enter the full legal name exactly as it appears on your government' })",
          1,
          true,
        ],
        [
          "page.getByLabel('Please enter the full legal name exactly as it appears on your government')",
          1,
          true,
        ],
        ["page.locator('#subject')", 1, true],
      ],
    ],
  ];
  // end pw-verified

  // pw-verified:locators
  const CHAINS = [
    // chain: named landmark parent
    [
      '<nav aria-label="Primary"><a href="#">Home</a></nav><nav aria-label="Footer"><a id="subject" href="#">Home</a></nav>',
      [
        ["page.getByRole('navigation', { name: 'Footer' }).getByRole('link', { name: 'Home' })", 1, true],
        ["page.locator('#subject')", 1, true],
        ["page.getByRole('link', { name: 'Home' })", 2, false],
        ["page.getByText('Home')", 2, false],
      ],
    ],
    // chain: id parent
    [
      '<div id="left"><button>Ok</button></div><div id="right"><button id="subject">Ok</button></div>',
      [
        ["page.locator('#right').getByRole('button', { name: 'Ok' })", 1, true],
        ["page.locator('#subject')", 1, true],
        ["page.getByRole('button', { name: 'Ok' })", 2, false],
        ["page.getByText('Ok')", 2, false],
      ],
    ],
    // chain: custom test attribute parent
    [
      '<div data-qa="a"><button>Ok</button></div><div data-qa="b"><button id="subject">Ok</button></div>',
      [
        ["page.locator('[data-qa=\"b\"]').getByRole('button', { name: 'Ok' })", 1, true],
        ["page.locator('#subject')", 1, true],
        ["page.getByRole('button', { name: 'Ok' })", 2, false],
        ["page.getByText('Ok')", 2, false],
      ],
    ],
    // chain: own data-ll-* attribute never used
    [
      '<div data-ll-x="a"><button>Ok</button></div><div data-ll-x="b"><button id="subject">Ok</button></div>',
      [
        ["page.locator('#subject')", 1, true],
        ["page.getByRole('button', { name: 'Ok' })", 2, false],
        ["page.getByText('Ok')", 2, false],
      ],
      { attrs: ['data-ll-x', 'data-testid'] },
    ],
    // chain: no unique parent
    [
      '<section aria-label="S"><div><button>Ok</button></div></section><section aria-label="S"><div><button id="subject">Ok</button></div></section>',
      [
        ["page.locator('#subject')", 1, true],
        ["page.getByRole('button', { name: 'Ok' })", 2, false],
        ["page.getByText('Ok')", 2, false],
      ],
    ],
    // chain: through a shadow host
    [
      '<div data-testid="card-1"><x-c id="h"></x-c></div><button>Buy</button>',
      [
        ["page.locator('#h').getByRole('button', { name: 'Buy' })", 1, true],
        ["page.getByRole('button', { name: 'Buy' })", 2, false],
        ["page.getByText('Buy')", 2, false],
        ["page.locator('button')", 2, false],
      ],
      { subject: '[data-k]', shadow: [['#h', '<button data-k="1">Buy</button>']] },
    ],
    // chain: text child
    [
      '<ul><li data-testid="r1"><span>Edit</span></li><li data-testid="r2"><span id="subject">Edit</span></li></ul>',
      [
        ["page.getByTestId('r2').getByText('Edit')", 1, true],
        ["page.locator('#subject')", 1, true],
        ["page.getByText('Edit')", 2, false],
      ],
    ],
    // chain: parent name over 80 chars is skipped
    [
      '<section aria-label="' +
        'L'.repeat(90) +
        '"><button>Ok</button></section><button>Ok</button><section aria-label="' +
        'M'.repeat(90) +
        '"><button id="subject">Ok</button></section>',
      [
        ["page.locator('#subject')", 1, true],
        ["page.getByRole('button', { name: 'Ok' })", 3, false],
        ["page.getByText('Ok')", 3, false],
      ],
    ],
    // chain: deep ancestor
    [
      '<div data-testid="outer"><div><p><span><b><i><u><s><em><strong><mark><button>Deep</button></mark></strong></em></s></u></i></b></span></p></div></div><button>Deep</button>',
      [
        ["page.getByTestId('outer').getByRole('button', { name: 'Deep' })", 1, true],
        ["page.locator('mark > button')", 1, true],
        ["page.getByRole('button', { name: 'Deep' })", 2, false],
        ["page.getByText('Deep')", 2, false],
      ],
      { subject: 'mark > button' },
    ],
  ];
  // end pw-verified

  // pw-verified:locators
  const CSS_FALLBACK = [
    // css: nth-of-type
    [
      '<ul><li>a</li><li class="item">b</li><li class="item">c</li></ul>',
      [
        ["page.getByText('b')", 1, true],
        ["page.locator('li.item:nth-of-type(2)')", 1, true],
        ["page.getByRole('listitem')", 3, false],
      ],
      { subject: 'li.item' },
    ],
    // css: anchored at body
    [
      '<div><p>a</p></div><div><p>a</p></div><section><div></div><div><p>a</p></div></section>',
      [
        ["page.locator('body > div:nth-of-type(2) > p')", 1, true],
        ["page.getByRole('paragraph')", 3, false],
        ["page.getByText('a')", 3, false],
      ],
      { subject: 'body > div:nth-of-type(2) > p' },
    ],
    // css: stable classes
    [
      '<main><section><div><span>x</span></div></section><section><div><span class="tag">x</span></div></section></main>',
      [
        ["page.locator('span.tag')", 1, true],
        ["page.getByText('x')", 2, false],
      ],
      { subject: 'span.tag' },
    ],
    // css: only an unstable class
    [
      '<div class="css-1x2y3z">a</div><div class="css-1x2y3z">b</div>',
      [
        ["page.getByText('b')", 1, true],
        ["page.locator('div:nth-of-type(2)')", 1, true],
      ],
      { subject: 'div:nth-of-type(2)' },
    ],
    // css: unstable class dropped, stable kept
    [
      '<button class="btn btn-primary sc-AxjAm">Go</button><button class="btn">Go</button>',
      [
        ["page.locator('button.btn.btn-primary:nth-of-type(1)')", 1, true],
        ["page.getByRole('button', { name: 'Go' })", 2, false],
        ["page.getByText('Go')", 2, false],
      ],
      { subject: '.btn-primary' },
    ],
    // css: Tailwind classes escaped
    [
      '<div><button class="md:w-1/2 hover:bg-red-500">X</button><button class="md:w-1/2">Y</button></div>',
      [
        ["page.getByRole('button', { name: 'X' })", 1, true],
        ["page.getByText('X')", 1, true],
        ["page.locator('button.md\\\\:w-1\\\\/2.hover\\\\:bg-red-500:nth-of-type(1)')", 1, true],
      ],
      { subject: 'button' },
    ],
    // css: own ll-/locatra- classes never used
    [
      '<button class="ll-hover locatra-x real">Go</button><button class="real">Go</button>',
      [
        ["page.locator('button.real:nth-of-type(1)')", 1, true],
        ["page.getByRole('button', { name: 'Go' })", 2, false],
        ["page.getByText('Go')", 2, false],
      ],
      { subject: '.ll-hover' },
    ],
    // css: unstable id on the element
    [
      '<button id="btn-12345">Click</button><button>Click</button>',
      [
        ["page.locator('button:nth-of-type(1)')", 1, true],
        ["page.getByRole('button', { name: 'Click' })", 2, false],
        ["page.getByText('Click')", 2, false],
      ],
      { subject: '#btn-12345' },
    ],
    // css: inside a shadow root
    [
      '<div id="host"></div><span class="s">t</span>',
      [
        ["page.locator('#host2').getByText('t')", 1, true],
        ["page.locator('#host2 > span.s')", 1, true],
        ["page.getByText('t')", 2, false],
      ],
      { subject: '#host2 span', shadow: [['#host', '<div id="host2"><span class="s">t</span></div>']] },
    ],
    // css: same path in two shadow roots
    [
      '<x-a id="h1"></x-a><x-a id="h2"></x-a>',
      [
        ["page.locator('#h2').getByText('t')", 1, true],
        ["page.getByText('t')", 2, false],
        ["page.locator('div > i')", 2, false],
      ],
      {
        subject: '[data-k="2"]',
        shadow: [
          ['#h1', '<div><i data-k="1">t</i></div>'],
          ['#h2', '<div><i data-k="2">t</i></div>'],
        ],
      },
    ],
    // css: stable id ancestor anchors the path
    [
      '<div id="panel"><div><span>x</span></div><div><span>x</span></div></div><div><div></div><div><span>x</span></div></div>',
      [
        ["page.locator('#panel > div:nth-of-type(2) > span')", 1, true],
        ["page.locator('#panel').getByText('x')", 2, false],
        ["page.getByText('x')", 3, false],
      ],
      { subject: '#panel > div:nth-of-type(2) > span' },
    ],
    // css: unstable id ancestor is not used as an anchor
    [
      '<div id=":r1:"><p><em>e</em></p></div><p><em>e</em></p>',
      [
        ["page.locator('div > p > em')", 1, true],
        ["page.getByText('e')", 2, false],
        ["page.getByRole('emphasis')", 2, false],
      ],
      { subject: 'div > p > em' },
    ],
  ];
  // end pw-verified

  // pw-verified:locators
  const MISC = [
    // long unbroken name: hard cut at the limit
    [
      '<button id="subject">' + UNBROKEN + ' x</button><button>' + UNBROKEN + '</button>',
      [
        ["page.locator('#subject')", 1, true],
        ["page.getByRole('button', { name: '" + UNBROKEN.slice(0, 80) + "' })", 2, false],
        ["page.getByText('" + UNBROKEN.slice(0, 60) + "')", 2, false],
      ],
    ],
    // label that holds only the control: no empty getByLabel('') card
    [
      '<label><input id="subject"></label>',
      [
        ["page.getByRole('textbox')", 1, true],
        ["page.locator('#subject')", 1, true],
      ],
    ],
    // custom attribute name with a CSS-special character
    [
      '<button id="subject" data.qa="v">Go</button><button>Go</button>',
      [
        ['page.locator(\'[data\\\\.qa="v"]\')', 1, true],
        ["page.locator('#subject')", 1, true],
        ["page.getByRole('button', { name: 'Go' })", 2, false],
        ["page.getByText('Go')", 2, false],
      ],
      { attrs: ['data.qa'] },
    ],
    // test id shared by two elements
    [
      '<button data-testid="t">A</button><button id="subject" data-testid="t">B</button>',
      [
        ["page.getByRole('button', { name: 'B' })", 1, true],
        ["page.getByText('B')", 1, true],
        ["page.locator('#subject')", 1, true],
        ["page.getByTestId('t')", 2, false],
      ],
    ],
    // custom test attribute only
    [
      '<button id="subject" data-cy="go">Go</button>',
      [
        ['page.locator(\'[data-cy="go"]\')', 1, true],
        ["page.getByRole('button', { name: 'Go' })", 1, true],
        ["page.getByText('Go')", 1, true],
        ["page.locator('#subject')", 1, true],
      ],
      { attrs: ['data-cy'] },
    ],
    // empty test id is ignored
    [
      '<button id="subject" data-testid="">Go</button>',
      [
        ["page.getByRole('button', { name: 'Go' })", 1, true],
        ["page.getByText('Go')", 1, true],
        ["page.locator('#subject')", 1, true],
      ],
    ],
    // name attribute
    [
      '<input name="email" id="subject"><input name="email">',
      [
        ["page.locator('#subject')", 1, true],
        ["page.getByRole('textbox')", 2, false],
        ['page.locator(\'[name="email"]\')', 2, false],
      ],
    ],
    // radio in a group
    [
      '<label><input type="radio" name="c" value="r"> Red</label><label><input id="subject" type="radio" name="c" value="b"> Blue</label>',
      [
        ["page.getByRole('radio', { name: 'Blue' })", 1, true],
        ["page.getByLabel('Blue')", 1, true],
        ["page.locator('#subject')", 1, true],
        ['page.locator(\'[name="c"]\')', 2, false],
      ],
    ],
    // labelled checkbox
    [
      '<input type="checkbox" id="subject"><label for="subject">Accept terms</label>',
      [
        ["page.getByRole('checkbox', { name: 'Accept terms' })", 1, true],
        ["page.getByLabel('Accept terms')", 1, true],
        ["page.locator('#subject')", 1, true],
      ],
    ],
    // select in a wrapping label
    [
      '<label>Country <select id="subject"><option>UK</option><option>US</option></select></label>',
      [
        ["page.getByRole('combobox', { name: 'Country' })", 1, true],
        ["page.getByLabel('Country')", 1, true],
        ["page.locator('#subject')", 1, true],
      ],
    ],
    // aria-labelledby input
    [
      '<span id="ln">Username</span><input id="subject" aria-labelledby="ln">',
      [
        ["page.getByRole('textbox', { name: 'Username' })", 1, true],
        ["page.getByLabel('Username')", 1, true],
        ["page.locator('#subject')", 1, true],
      ],
    ],
    // ARIA textbox with aria-label
    [
      '<div id="subject" role="textbox" aria-label="Comment"></div>',
      [
        ["page.getByRole('textbox', { name: 'Comment' })", 1, true],
        ["page.getByLabel('Comment')", 1, true],
        ["page.locator('#subject')", 1, true],
      ],
    ],
    // role without a name
    [
      '<input id="subject" type="checkbox"><input type="checkbox">',
      [
        ["page.locator('#subject')", 1, true],
        ["page.getByRole('checkbox')", 2, false],
      ],
    ],
    // image input
    [
      '<input id="subject" type="image" alt="Submit form">',
      [
        ["page.getByRole('button', { name: 'Submit form' })", 1, true],
        ["page.getByAltText('Submit form')", 1, true],
        ["page.locator('#subject')", 1, true],
      ],
    ],
    // image map area (hidden for aria)
    [
      '<map name="m"><area id="subject" href="#" alt="Region"></map><img usemap="#m" alt="map">',
      [
        ["page.getByAltText('Region')", 1, true],
        ["page.locator('#subject')", 1, true],
        ["page.getByRole('link')", 0, false],
      ],
    ],
    // decorative image
    ['<img id="subject" alt="" src="x.png">', [["page.locator('#subject')", 1, true]]],
    // SVG child element
    [
      '<svg><rect id="subject" class="bar"></rect><rect class="bar"></rect></svg>',
      [["page.locator('#subject')", 1, true]],
    ],
    // hidden element
    [
      '<button id="subject" style="display:none">Gone</button><button>Gone</button>',
      [
        ["page.locator('#subject')", 1, true],
        ["page.getByText('Gone')", 2, false],
        ["page.getByRole('button')", 1, false],
      ],
    ],
    // text belongs to a child
    [
      '<button id="subject"><span>Inner</span></button>',
      [
        ["page.getByRole('button', { name: 'Inner' })", 1, true],
        ["page.locator('#subject')", 1, true],
        ["page.getByText('Inner')", 1, false],
      ],
    ],
    // inside a shadow root
    [
      '<x-host id="xh"></x-host>',
      [
        ["page.getByRole('button', { name: 'Shadow Go' })", 1, true],
        ["page.locator('#xh').getByRole('button', { name: 'Shadow Go' })", 1, true],
        ["page.getByText('Shadow Go')", 1, true],
        ["page.locator('#sb')", 1, true],
      ],
      { subject: '#sb', shadow: [['#xh', '<button id="sb">Shadow Go</button>']] },
    ],
    // quotes and backslash in text
    [
      '<p id="subject">It\'s a "quote" \\ back</p>',
      [
        ["page.getByText('It\\'s a \"quote\" \\\\ back')", 1, true],
        ["page.getByRole('paragraph')", 1, true],
        ["page.locator('#subject')", 1, true],
      ],
    ],
    // textarea with placeholder
    [
      '<textarea id="subject" placeholder="Message"></textarea>',
      [
        ["page.getByRole('textbox', { name: 'Message' })", 1, true],
        ["page.getByPlaceholder('Message')", 1, true],
        ["page.locator('#subject')", 1, true],
      ],
    ],
    // link named by title
    [
      '<a id="subject" href="#" title="Home page"><svg></svg></a>',
      [
        ["page.getByRole('link', { name: 'Home page' })", 1, true],
        ["page.getByTitle('Home page')", 1, true],
        ["page.locator('#subject')", 1, true],
      ],
    ],
    // text matched by three elements
    [
      '<p>Dup</p><p>Dup</p><p id="subject">Dup</p>',
      [
        ["page.locator('#subject')", 1, true],
        ["page.getByRole('paragraph')", 3, false],
        ["page.getByText('Dup')", 3, false],
      ],
    ],
    // submit input
    [
      '<input id="subject" type="submit" value="Send"><input type="submit" value="Send later">',
      [
        ["page.getByRole('button', { name: 'Send', exact: true })", 1, true],
        ["page.locator('#subject')", 1, true],
      ],
    ],
    // checkbox with only a name attribute
    [
      '<input id="subject" type="checkbox" name="agree">',
      [
        ["page.getByRole('checkbox')", 1, true],
        ["page.locator('#subject')", 1, true],
        ['page.locator(\'[name="agree"]\')', 1, true],
      ],
    ],
    // labelled textarea with name
    [
      '<label for="subject">Bio</label><textarea id="subject" name="bio"></textarea>',
      [
        ["page.getByRole('textbox', { name: 'Bio' })", 1, true],
        ["page.getByLabel('Bio')", 1, true],
        ["page.locator('#subject')", 1, true],
        ['page.locator(\'[name="bio"]\')', 1, true],
      ],
    ],
    // reset input
    [
      '<input id="subject" type="reset" value="Clear">',
      [
        ["page.getByRole('button', { name: 'Clear' })", 1, true],
        ["page.locator('#subject')", 1, true],
      ],
    ],
    // test id on a link
    [
      '<a id="subject" href="/x" data-testid="home-link">Home</a>',
      [
        ["page.getByTestId('home-link')", 1, true],
        ["page.getByRole('link', { name: 'Home' })", 1, true],
        ["page.getByText('Home')", 1, true],
        ["page.locator('#subject')", 1, true],
      ],
    ],
    // ARIA button on a span
    [
      '<span id="subject" role="button">Do</span>',
      [
        ["page.getByRole('button', { name: 'Do' })", 1, true],
        ["page.getByText('Do')", 1, true],
        ["page.locator('#subject')", 1, true],
      ],
    ],
  ];
  // end pw-verified

  it.each(EXACT_AND_TRUNCATION)('exact / truncated variants: %s', (html, expected, opts) => {
    expect(cards(analyse(render(html, opts), opts?.attrs))).toEqual(expected);
  });
  it.each(CHAINS)('chained parents: %s', (html, expected, opts) => {
    expect(cards(analyse(render(html, opts), opts?.attrs))).toEqual(expected);
  });
  it.each(CSS_FALLBACK)('CSS fallback: %s', (html, expected, opts) => {
    expect(cards(analyse(render(html, opts), opts?.attrs))).toEqual(expected);
  });
  it.each(MISC)('%s', (html, expected, opts) => {
    expect(cards(analyse(render(html, opts), opts?.attrs))).toEqual(expected);
  });
});

describe('card details beyond code and count', () => {
  it('marks ambiguous cards in words and downgrades text that matches three or more', () => {
    const r = analyse(render('<p>Dup</p><p>Dup</p><p id="subject">Dup</p>'));
    const text = r.locators.find((l) => l.target.kind === 'text');
    expect(text.ambiguous).toBe(true);
    expect(text.stability).toBe('OK');
    expect(text.explanation).toContain('Matches 3 elements on this page');
    const id = r.locators.find((l) => l.target.kind === 'id');
    expect(id.ambiguous).toBeUndefined();
    expect(id.rank).toBe(1);
  });

  it('keeps GOOD for text shared by only two elements', () => {
    const r = analyse(render('<p>Dup</p><p id="subject">Dup</p>'));
    const text = r.locators.find((l) => l.target.kind === 'text');
    expect([text.matchCount, text.stability, text.ambiguous]).toEqual([2, 'GOOD', true]);
  });

  it('warns on — and ranks last — a card that does not resolve to the element', () => {
    // getByText('Inner') resolves to the <span>, not the <button> (Playwright: 1 match, the span).
    const r = analyse(render('<button id="subject"><span>Inner</span></button>'));
    const last = r.locators[r.locators.length - 1];
    expect(last.target).toEqual({ kind: 'text', value: 'Inner' });
    expect([last.matchesElement, last.unique]).toEqual([false, false]);
    expect(last.explanation).toContain('does not resolve to the selected element');
  });

  it('switches only the ambiguous card to exact, and rewrites both code fields', () => {
    const r = analyse(render('<button>Save</button><button id="subject">Sav</button>'));
    const byRole = r.locators.find((l) => l.target.kind === 'role');
    expect(byRole.target).toEqual({ kind: 'role', role: 'button', name: 'Sav', level: null, exact: true });
    expect(byRole.fullCode).toBe("await page.getByRole('button', { name: 'Sav', exact: true }).click();");
    expect(byRole).not.toHaveProperty('exactValue');
  });

  it('never makes a truncated prefix exact', () => {
    const r = analyse(render(`<p>${LOREM} more</p><p id="subject">${LOREM}</p>`));
    const text = r.locators.find((l) => l.target.kind === 'text');
    expect(text.target.exact).toBeUndefined();
    expect(text.matchCount).toBe(2);
  });

  it('describes the chained card by its parent', () => {
    const r = analyse(
      render(
        '<nav aria-label="Primary"><a href="#">Home</a></nav><nav aria-label="Footer"><a id="subject" href="#">Home</a></nav>'
      )
    );
    const chained = r.locators.find((l) => l.method === 'Chained/Filtered');
    expect(chained.matchedAttr).toBe('Parent: Footer');
    expect(chained.explanation).toContain('unique parent (navigation)');
    expect(chained.target.parent).toEqual({ kind: 'role', role: 'navigation', name: 'Footer' });
  });

  it('suggests an action that fits the control in fullCode', () => {
    const full = (html) => analyse(render(html)).locators.find((l) => l.target.kind === 'id').fullCode;
    expect(full('<input id="subject" type="checkbox">')).toBe("await page.locator('#subject').check();");
    expect(full('<input id="subject" type="radio">')).toBe("await page.locator('#subject').check();");
    expect(full('<input id="subject" type="submit">')).toBe("await page.locator('#subject').click();");
    expect(full('<input id="subject" type="button">')).toBe("await page.locator('#subject').click();");
    expect(full('<input id="subject" type="email">')).toBe(
      "await page.locator('#subject').fill('your value');"
    );
    expect(full('<textarea id="subject"></textarea>')).toBe(
      "await page.locator('#subject').fill('your text');"
    );
    expect(full('<select id="subject"></select>')).toBe(
      "await page.locator('#subject').selectOption('option text');"
    );
    expect(full('<div id="subject"></div>')).toBe("await page.locator('#subject').click();");
  });

  it('never counts the extension’s own overlay (a deliberate difference from Playwright)', () => {
    // Playwright would count 2 here: the #ll-tooltip copy exists only while the
    // extension is inspecting, never in the page a test runs against.
    const r = analyse(
      render('<div id="ll-tooltip"><button>Hover</button></div><button id="subject">Hover</button>')
    );
    expect(r.locators.find((l) => l.target.kind === 'role').matchCount).toBe(1);
    expect(r.locators.find((l) => l.target.kind === 'text').matchCount).toBe(1);
  });
});

describe('the report around the cards', () => {
  it('treats a missing custom-attribute list as none', () => {
    const r = E.generateLocators(render('<button id="subject" data-testid="t">Go</button>'));
    expect(r.locators.some((l) => l.target.kind === 'testid')).toBe(false);
    expect(r.locators[0].code).toBe("page.getByRole('button', { name: 'Go' })");
  });

  it('answers the exported class/id heuristics for empty input', () => {
    expect(E.isUnstableClass('')).toBe(false);
    expect(E.isUnstableClass(undefined)).toBe(false);
    expect(E.isUnstableId('')).toBe(false);
    expect(E.isUnstableId(null)).toBe(false);
    expect(E.isOwnArtifactClass('')).toBe(false);
    expect(E.isOwnArtifactClass('ll-hover')).toBe(true);
    expect(E.isOwnArtifactClass('locatra-badge')).toBe(true);
  });

  it('lists unstable classes and ids in the avoid list, escaped', () => {
    const r = analyse(render('<button id="subject" class="btn sc-bdVaJa css-1x2y3z">Go</button>'));
    expect(r.avoidList[0]).toEqual({
      locator: "page.locator('.sc-bdVaJa')",
      reason: expect.stringContaining('"sc-bdVaJa" is an auto-generated class'),
    });
    expect(r.locators.find((l) => l.method === 'locator() CSS')).toBeUndefined(); // #subject card already covers it
    const r2 = analyse(render('<button id="1234567">Go</button>', { subject: 'button' }));
    expect(r2.avoidList.map((a) => a.locator)).toEqual([
      "page.locator('#\\\\31 234567')",
      "page.locator('button:nth-child(n)')",
      'XPath (//button[...])',
    ]);
  });

  it('leaves the XPath warning out when a test id or aria-label is present', () => {
    const xpath = (html) => analyse(render(html)).avoidList.some((a) => a.locator.startsWith('XPath'));
    expect(xpath('<button id="subject">Go</button>')).toBe(true);
    expect(xpath('<button id="subject" data-testid="go">Go</button>')).toBe(false);
    expect(xpath('<button id="subject" aria-label="Go">Go</button>')).toBe(false);
  });

  it('picks the pro tip from the element’s situation', () => {
    const tip = (html, opts) => analyse(render(html, opts)).proTip;
    expect(
      tip('<x-host id="xh"></x-host>', { subject: '#sb', shadow: [['#xh', '<button id="sb">Go</button>']] })
    ).toMatch(/^Found inside Shadow DOM \(<x-host#xh>\)/);
    expect(
      tip('<y-host></y-host>', { subject: '#sb', shadow: [['y-host', '<button id="sb">Go</button>']] })
    ).toMatch(/^Found inside Shadow DOM \(<y-host>\)/);
    expect(tip('<input id="subject">')).toContain(
      'add a <data-testid="input-element"> attribute to this <input>'
    );
    expect(tip('<a id="subject" href="#" data-testid="home">Home</a>')).toContain(
      "expect(page.getByRole('link', { name: '...' })).toBeVisible()"
    );
    expect(tip('<input id="subject" data-testid="email">')).toContain(
      "await expect(page.getByRole('textbox')).toBeVisible()"
    );
    // No role: a tag name is not a role — Playwright's getByRole('div') matches
    // nothing — so the assertion goes through the test id instead.
    expect(tip('<div id="subject" data-testid="panel">Panel</div>')).toContain(
      "await expect(page.getByTestId('panel')).toBeVisible()"
    );
  });

  it('reports the element metadata the side panel shows', () => {
    const el = render(
      '<a id="subject" href="/docs" class="nav-link ll-hover sc-bdVaJa" data-cy="docs" title="Docs" aria-label="Documentation">Docs</a>'
    );
    expect(analyse(el).elementData).toEqual({
      tag: 'a',
      type: null,
      id: 'subject',
      visibleText: 'Docs',
      ariaLabel: 'Documentation',
      placeholder: null,
      alt: null,
      testId: 'docs',
      role: 'link',
      title: 'Docs',
      name: null,
      href: '/docs',
      classes: ['nav-link', 'sc-bdVaJa'],
      hasUnstableClasses: true,
      isInShadow: false,
      shadowHost: null,
      suggestedAction: 'click',
    });
    const input = analyse(render('<input id="subject" type="reset" name="r" placeholder="p">')).elementData;
    expect([
      input.role,
      input.type,
      input.name,
      input.placeholder,
      input.suggestedAction,
      input.href,
    ]).toEqual(['button', 'reset', 'r', 'p', 'click', null]);
    expect(analyse(render('<textarea id="subject"></textarea>')).elementData.suggestedAction).toBe('fill');
    // No role falls back to the tag name.
    expect(analyse(render('<div id="subject"></div>')).elementData.role).toBe('div');
  });

  it('audits div/span buttons and unnamed interactive elements', () => {
    const messages = (el) => analyse(el).a11y.map((i) => `${i.severity}: ${i.message.split('.')[0]}`);
    expect(messages(render('<div id="subject" role="button"></div>'))).toEqual([
      'low: Consider using a <button> instead of a <div> for better native keyboard support',
      'low: Interactive <div> has no accessible name',
    ]);
    const span = render('<span id="subject">click me</span>');
    span.onclick = () => {};
    expect(messages(span)).toEqual([
      'low: Consider using a <button> instead of a <div> for better native keyboard support',
    ]);
    expect(messages(render('<a id="subject" href="#"></a>'))).toEqual([
      'low: Interactive <a> has no accessible name',
    ]);
    // Submit/button inputs are named by their value and are not "form controls lacking a label".
    expect(messages(render('<input id="subject" type="submit">'))).toEqual([]);
    expect(messages(render('<input id="subject" type="hidden">'))).toEqual([]);
  });
});

describe('CSS escaping without CSS.escape', () => {
  // jsdom has no CSS.escape, so the engine's own port of the CSSOM algorithm runs.
  // Expected values are Chromium's CSS.escape() output for the same ids.
  const CHROMIUM_CSS_ESCAPE = [
    ['1abc', '\\31 abc'],
    ['-1x', '-\\31 x'],
    ['-', '\\-'],
    ['a\u0001b', 'a\\1 b'],
    ['a b', 'a\\ b'],
    ['é', 'é'],
    ['x\x7f', 'x\\7f '],
    ['--x', '--x'],
    ['_u', '_u'],
    ['a.b[c]', 'a\\.b\\[c\\]'],
    ['\u0000x', '\uFFFDx'],
  ];

  it.each(CHROMIUM_CSS_ESCAPE)('escapes the id %j like Chromium', (id, escaped) => {
    document.body.innerHTML = '<p>x</p><p>y</p>';
    const p = document.querySelectorAll('p')[1];
    p.setAttribute('id', id);
    const card = analyse(p).locators.find((l) => l.target.kind === 'id');
    expect(card.target.value).toBe(id);
    expect(card.code).toBe(`page.locator('#${escaped.replace(/\\/g, '\\\\')}')`);
  });

  it('resolves the escaped selectors to the element', () => {
    for (const [id] of CHROMIUM_CSS_ESCAPE.filter(([i]) => !i.includes('\u0000'))) {
      document.body.innerHTML = '<p>x</p><p>y</p>';
      const p = document.querySelectorAll('p')[1];
      p.setAttribute('id', id);
      const sel = E.buildCSSSelector(p);
      expect(sel.startsWith('#'), id).toBe(true);
      expect(document.querySelectorAll(sel)[0]).toBe(p);
    }
  });

  describe('when the platform has CSS.escape and codegen is loaded', () => {
    afterEach(() => {
      delete globalThis.CSS;
      delete globalThis.LLCodegen;
    });

    it('delegates identifier escaping to CSS.escape', () => {
      const calls = [];
      globalThis.CSS = { escape: (s) => (calls.push(s), `native-${s}`) };
      document.body.innerHTML = '<p>x</p><p id="k">y</p>';
      const card = analyse(document.getElementById('k')).locators.find((l) => l.target.kind === 'id');
      expect(card.code).toBe("page.locator('#native-k')");
      expect(calls).toContain('k');
    });

    it('delegates JS string quoting to LLCodegen.q, so the two cannot drift', () => {
      globalThis.LLCodegen = { q: (v) => `<<${v}>>` };
      const card = analyse(render('<button id="subject">Go</button>')).locators.find(
        (l) => l.target.kind === 'role'
      );
      expect(card.code).toBe('page.getByRole(<<button>>, { name: <<Go>> })');
    });
  });
});

describe('buildCSSSelector edge cases', () => {
  it('returns "body" for nothing or a non-element, instead of throwing', () => {
    expect(E.buildCSSSelector(null)).toBe('body');
    expect(E.buildCSSSelector(undefined)).toBe('body');
    document.body.innerHTML = 'text';
    expect(E.buildCSSSelector(document.body.firstChild)).toBe('body');
  });

  it('builds against the element’s own document (an iframe’s parent document)', () => {
    const doc = document.implementation.createHTMLDocument('other');
    doc.body.innerHTML = '<ul><li>a</li><li>b</li></ul>';
    const li = doc.querySelectorAll('li')[1];
    expect(E.buildCSSSelector(li)).toBe('li:nth-of-type(2)');
    expect(E.buildCSSSelector(li, doc)).toBe('li:nth-of-type(2)');
    expect(doc.querySelector('li:nth-of-type(2)')).toBe(li);
    expect(E.buildCSSSelector(doc.body)).toBe('body');
    expect(E.buildCSSSelector(doc.documentElement)).toBe('html');
    // No window behind that document: no computed style, so visible and named.
    expect(E.getAccessibleName(doc.body.appendChild(doc.createElement('button'))) ?? '').toBe('');
  });

  it('falls back to the bare path when there is no <body> to anchor at', () => {
    const doc = document.implementation.createDocument('http://www.w3.org/1999/xhtml', 'html', null);
    const root = doc.documentElement;
    const wrap = root.appendChild(doc.createElementNS('http://www.w3.org/1999/xhtml', 'div'));
    wrap.appendChild(doc.createElementNS('http://www.w3.org/1999/xhtml', 'span'));
    const span = wrap.appendChild(doc.createElementNS('http://www.w3.org/1999/xhtml', 'span'));
    const sel = E.buildCSSSelector(span);
    expect(sel).toBe('span:nth-of-type(2)');
    expect(doc.querySelectorAll(sel)[0]).toBe(span);
  });
});

describe('deepQueryAll', () => {
  it('defaults to the whole document and pierces shadow roots', () => {
    render('<b>1</b><div id="h"></div>', { shadow: [['#h', '<b>2</b>']] });
    expect(E.deepQueryAll('b').map((b) => b.textContent)).toEqual(['1', '2']);
  });

  it('searches 256 levels of nested shadow roots and survives deeper ones', () => {
    // Playwright itself has no depth limit; the engine stops descending at 256 so a
    // pathological chain cannot blow the stack. Every realistic page is far shallower.
    let host = document.body.appendChild(document.createElement('div'));
    for (let depth = 1; depth <= 300; depth++) {
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<b>${depth}</b><div></div>`;
      host = root.lastElementChild;
    }
    const found = E.deepQueryAll('b');
    expect(found).toHaveLength(256);
    expect(found[255].textContent).toBe('256');
  });
});
