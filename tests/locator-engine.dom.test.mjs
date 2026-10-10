// @vitest-environment jsdom
//
// The locator engine only makes sense against a real DOM, so these run in jsdom
// and drive the actual shipping file.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ATTRS = ['data-testid', 'data-qa', 'data-cy', 'data-test', 'data-automation-id', 'data-e2e'];

let E;
beforeAll(() => {
  // Run the raw shipping file as a classic script — exactly how the browser and
  // content-script.dom.test.mjs load it. An ESM import() would hand V8 Vite's
  // *transformed* copy under the same URL, and V8 coverage merged from the two
  // differently-shaped copies under-reports the file (the union came out lower than
  // this suite alone).
  vm.runInThisContext(readFileSync(join(ROOT, 'src/content-locator-engine.js'), 'utf8'), {
    filename: 'src/content-locator-engine.js',
  });
  E = globalThis.__LocatorLensEngine;
});

beforeEach(() => {
  document.body.innerHTML = '';
});

/** Render markup and hand back the element carrying id="subject". */
function mount(html) {
  document.body.innerHTML = html;
  return document.getElementById('subject') ?? document.body.firstElementChild;
}

function analyse(el) {
  return E.generateLocators(el, DEFAULT_ATTRS);
}

function methods(result) {
  return result.locators.map((l) => l.method);
}

describe('role resolution', () => {
  it.each([
    ['<button id="subject">Go</button>', 'button'],
    ['<a id="subject" href="/x">Go</a>', 'link'],
    ['<input id="subject" type="checkbox">', 'checkbox'],
    ['<input id="subject" type="radio">', 'radio'],
    ['<input id="subject" type="text">', 'textbox'],
    ['<input id="subject" type="email">', 'textbox'],
    ['<input id="subject" type="search">', 'searchbox'],
    ['<input id="subject" type="number">', 'spinbutton'],
    ['<textarea id="subject"></textarea>', 'textbox'],
    ['<select id="subject"></select>', 'combobox'],
    ['<h2 id="subject">T</h2>', 'heading'],
    ['<nav id="subject"></nav>', 'navigation'],
    // The rest of the implicit-role map. It is the core of the whole tool — an
    // element mapped to the wrong role produces a getByRole locator that silently
    // matches nothing — so every entry is pinned, not just the common ones.
    ['<input id="subject" type="password">', 'textbox'],
    ['<input id="subject" type="tel">', 'textbox'],
    ['<input id="subject" type="url">', 'textbox'],
    ['<input id="subject" type="range">', 'slider'],
    ['<input id="subject" type="submit" value="Go">', 'button'],
    ['<input id="subject" type="reset" value="Reset">', 'button'],
    ['<input id="subject" type="button" value="Go">', 'button'],
    ['<img id="subject" alt="x">', 'img'],
    ['<h1 id="subject">T</h1>', 'heading'],
    ['<h3 id="subject">T</h3>', 'heading'],
    ['<h4 id="subject">T</h4>', 'heading'],
    ['<h5 id="subject">T</h5>', 'heading'],
    ['<h6 id="subject">T</h6>', 'heading'],
    ['<main id="subject"></main>', 'main'],
    ['<table id="subject"></table>', 'table'],
    ['<table><tr id="subject"></tr></table>', 'row'],
    ['<table><tr><td id="subject"></td></tr></table>', 'cell'],
    ['<table><tr><th id="subject"></th></tr><tr><td>1</td></tr></table>', 'columnheader'],
    ['<ul id="subject"></ul>', 'list'],
    ['<ol id="subject"></ol>', 'list'],
    ['<ul><li id="subject"></li></ul>', 'listitem'],
    ['<dialog id="subject"></dialog>', 'dialog'],
    ['<form id="subject" aria-label="Login"></form>', 'form'],
    ['<article id="subject"></article>', 'article'],
    ['<aside id="subject"></aside>', 'complementary'],
    ['<header id="subject"></header>', 'banner'],
    ['<footer id="subject"></footer>', 'contentinfo'],
    ['<section id="subject" aria-label="News"></section>', 'region'],
  ])('derives the implicit role from %s', (html, role) => {
    expect(E.getRole(mount(html))).toBe(role);
  });

  it('lets an explicit role override the implicit one', () => {
    expect(E.getRole(mount('<div id="subject" role="button">x</div>'))).toBe('button');
  });

  it('takes the first token of a space-separated role list', () => {
    expect(E.getRole(mount('<div id="subject" role="button link">x</div>'))).toBe('button');
  });

  it('returns null for an element with no role', () => {
    expect(E.getRole(mount('<div id="subject">x</div>'))).toBeNull();
  });

  it('treats an anchor without href as having no link role', () => {
    expect(E.getRole(mount('<a id="subject">x</a>'))).toBeNull();
  });
});

describe('accessible name computation', () => {
  it('prefers aria-label above everything else', () => {
    const el = mount('<button id="subject" title="t" aria-label="Primary">Text</button>');
    expect(E.getAccessibleName(el)).toBe('Primary');
  });

  it('resolves aria-labelledby against the referenced elements', () => {
    document.body.innerHTML =
      '<span id="a">Hello</span><span id="b">World</span><button id="subject" aria-labelledby="a b">x</button>';
    expect(E.getAccessibleName(document.getElementById('subject'))).toBe('Hello World');
  });

  it('uses a <label for> association for form controls', () => {
    document.body.innerHTML = '<label for="subject">Email address</label><input id="subject">';
    expect(E.getAccessibleName(document.getElementById('subject'))).toBe('Email address');
  });

  it('uses a wrapping label and strips the control text out of it', () => {
    document.body.innerHTML = '<label>Country <select id="subject"><option>UK</option></select></label>';
    expect(E.getAccessibleName(document.getElementById('subject'))).toBe('Country');
  });

  it('falls back to visible text for text-bearing roles', () => {
    expect(E.getAccessibleName(mount('<button id="subject">  Save changes  </button>'))).toBe('Save changes');
  });

  it('falls back to placeholder when no label exists', () => {
    expect(E.getAccessibleName(mount('<input id="subject" placeholder="Search">'))).toBe('Search');
  });

  it('uses the value of a submit input', () => {
    expect(E.getAccessibleName(mount('<input id="subject" type="submit" value="Send">'))).toBe('Send');
  });

  it('returns null when nothing names the element', () => {
    expect(E.getAccessibleName(mount('<div id="subject"></div>'))).toBeNull();
  });
});

describe('locator generation and ranking', () => {
  it('ranks a test id first', () => {
    const result = analyse(mount('<button id="subject" data-testid="save-btn">Save</button>'));
    expect(result.locators[0].target).toEqual({ kind: 'testid', attr: 'data-testid', value: 'save-btn' });
    expect(result.locators[0].rank).toBe(1);
  });

  it('honours a custom test attribute', () => {
    const result = E.generateLocators(mount('<button id="subject" data-qa="q">S</button>'), DEFAULT_ATTRS);
    expect(result.locators[0].target).toEqual({ kind: 'testid', attr: 'data-qa', value: 'q' });
  });

  it('offers getByRole when the element has a role and a name', () => {
    expect(methods(analyse(mount('<button id="subject">Save</button>')))).toContain('getByRole()');
  });

  it('offers getByLabel for a labelled input', () => {
    document.body.innerHTML = '<label for="subject">Email</label><input id="subject">';
    const result = analyse(document.getElementById('subject'));
    const label = result.locators.find((l) => l.target.kind === 'label');
    expect(label.target.value).toBe('Email');
  });

  it('always produces at least a CSS fallback', () => {
    const result = analyse(mount('<div><span></span></div>'));
    expect(result.locators.length).toBeGreaterThan(0);
    expect(result.locators.some((l) => l.target.kind === 'css')).toBe(true);
  });

  it('does not repeat the #id card as an identical CSS fallback card', () => {
    const result = analyse(mount('<div id="subject"></div>'));
    const codes = result.locators.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(result.locators.some((l) => l.target.kind === 'id' || l.target.kind === 'css')).toBe(true);
  });

  it('sorts by stability and then renumbers ranks contiguously', () => {
    const result = analyse(mount('<button id="subject" data-testid="t">Save</button>'));
    const weight = { BEST: 4, GOOD: 3, OK: 2, AVOID: 1 };
    const weights = result.locators.map((l) => weight[l.stability]);
    expect([...weights]).toEqual([...weights].sort((a, b) => b - a));
    expect(result.locators.map((l) => l.rank)).toEqual(result.locators.map((_, i) => i + 1));
  });

  it('marks auto-generated class names as AVOID', () => {
    const result = analyse(mount('<div class="sc-bdVaJa"></div>'));
    const css = result.locators.find((l) => l.method === 'locator() CSS');
    expect(css.stability).toBe('AVOID');
    expect(result.avoidList.some((a) => a.reason.includes('auto-generated'))).toBe(true);
  });

  it('flags an auto-generated id in the avoid list rather than recommending it', () => {
    const result = analyse(mount('<div id="field_123456"></div>'));
    expect(result.locators.some((l) => l.target.kind === 'id')).toBe(false);
    expect(result.avoidList.some((a) => a.locator.includes('field_123456'))).toBe(true);
  });
});

// Regression cover for the escaping fix: an unescaped id produced a selector that
// throws inside querySelectorAll, which the engine then swallowed as "no match".
describe('CSS-special identifiers', () => {
  it('escapes a special-character id in the generated CSS selector', () => {
    document.body.innerHTML = '<div><span id="md:w-1/2" class="x">t</span></div>';
    const el = document.getElementById('md:w-1/2');
    // The CSS fallback is exactly the #id card here, so only that card is kept.
    expect(analyse(el).locators.some((l) => l.target.kind === 'id' || l.target.kind === 'css')).toBe(true);
    const sel = E.buildCSSSelector(el);
    expect(() => document.querySelectorAll(sel)).not.toThrow();
    expect(document.querySelectorAll(sel)).toHaveLength(1);
  });

  it('does not throw while analysing an element with a special-character id', () => {
    document.body.innerHTML = '<button id="a.b[c]">Go</button>';
    expect(() => analyse(document.getElementById('a.b[c]'))).not.toThrow();
  });
});

describe('live uniqueness counts', () => {
  it('reports a unique locator as matching exactly one element', () => {
    const result = analyse(mount('<button id="subject" data-testid="only">Save</button>'));
    const testid = result.locators.find((l) => l.target.kind === 'testid');
    expect(testid.matchCount).toBe(1);
    expect(testid.unique).toBe(true);
  });

  it('counts duplicates and marks the locator ambiguous', () => {
    document.body.innerHTML =
      '<button data-testid="dup">A</button><button data-testid="dup" id="subject">B</button>';
    const result = analyse(document.getElementById('subject'));
    const testid = result.locators.find((l) => l.target.kind === 'testid');
    expect(testid.matchCount).toBe(2);
    expect(testid.unique).toBe(false);
  });

  it('counts by role and accessible name together', () => {
    document.body.innerHTML = '<button>Save</button><button id="subject">Save</button><button>Other</button>';
    const result = analyse(document.getElementById('subject'));
    const role = result.locators.find((l) => l.target.kind === 'role');
    expect(role.matchCount).toBe(2);
  });

  it('counts only the innermost element for a text locator', () => {
    document.body.innerHTML = '<div><span id="subject">Unique text</span></div>';
    const result = analyse(document.getElementById('subject'));
    const text = result.locators.find((l) => l.target.kind === 'text');
    // The wrapping <div> has identical textContent but must not be counted.
    expect(text.matchCount).toBe(1);
  });
});

describe('accessibility audit', () => {
  it('reports a high-severity issue for an image with no alt', () => {
    const issues = analyse(mount('<img id="subject" src="x.png">')).a11y;
    expect(issues.some((i) => i.severity === 'high' && i.message.includes('alt'))).toBe(true);
  });

  it('reports an unlabelled form control', () => {
    const issues = analyse(mount('<input id="subject" type="text">')).a11y;
    expect(issues.some((i) => i.severity === 'high' && i.message.includes('label'))).toBe(true);
  });

  it('reports a redundant explicit role', () => {
    const issues = analyse(mount('<button id="subject" role="button">Go</button>')).a11y;
    expect(issues.some((i) => i.message.includes('Redundant'))).toBe(true);
  });

  it('stays quiet for a properly labelled control', () => {
    document.body.innerHTML = '<label for="subject">Email</label><input id="subject" type="text">';
    expect(analyse(document.getElementById('subject')).a11y).toHaveLength(0);
  });
});

describe('resilience', () => {
  it('handles a detached element without throwing', () => {
    const el = document.createElement('button');
    el.textContent = 'Detached';
    expect(() => analyse(el)).not.toThrow();
  });

  it('handles an SVG element, whose className is not a string', () => {
    document.body.innerHTML = '<svg><rect id="subject" class="a b"></rect></svg>';
    expect(() => analyse(document.getElementById('subject'))).not.toThrow();
  });

  it('always returns the documented result shape', () => {
    const result = analyse(mount('<button id="subject">Go</button>'));
    expect(result).toHaveProperty('elementData');
    expect(result).toHaveProperty('locators');
    expect(result).toHaveProperty('avoidList');
    expect(result).toHaveProperty('proTip');
    expect(result).toHaveProperty('a11y');
    expect(Array.isArray(result.locators)).toBe(true);
  });

  it('suggests an action appropriate to the control type', () => {
    expect(analyse(mount('<input id="subject" type="checkbox">')).elementData.suggestedAction).toBe('check');
    expect(analyse(mount('<input id="subject" type="text">')).elementData.suggestedAction).toBe('fill');
    expect(analyse(mount('<select id="subject"></select>')).elementData.suggestedAction).toBe('selectOption');
    expect(analyse(mount('<button id="subject">x</button>')).elementData.suggestedAction).toBe('click');
  });
});

// Every locator card shows a `code` string and carries a structured `target`. The
// two must describe the same element: `code` is what the user reads, `target` is
// what the recorder and the Selenium/Cypress/Python translators actually generate
// from. A divergence produces confident, plausible, wrong test code.
describe('chained locators', () => {
  const row = (id, label) => `<tr data-testid="${id}"><td>${label}</td><td><button>Delete</button></td></tr>`;

  function deleteButtonInSecondRow() {
    document.body.innerHTML = `<table><tbody>${row('row-1', 'Ada')}${row('row-2', 'Grace')}</tbody></table>`;
    return document.querySelector('[data-testid="row-2"] button');
  }

  it('records the parent and the child as a structured chain', () => {
    const chained = analyse(deleteButtonInSecondRow()).locators.find((l) => l.method === 'Chained/Filtered');
    expect(chained).toBeDefined();
    expect(chained.target.kind).toBe('chain');
    expect(chained.target.parent).toEqual({ kind: 'testid', attr: 'data-testid', value: 'row-2' });
    expect(chained.target.child.kind).toBe('role');
    expect(chained.target.child.name).toBe('Delete');
  });

  it('keeps the displayed code and the structured target in agreement', () => {
    const chained = analyse(deleteButtonInSecondRow()).locators.find((l) => l.method === 'Chained/Filtered');
    // The card says getByTestId('row-2')…; the target must not say "any Delete button".
    expect(chained.code).toContain('row-2');
    expect(chained.target.parent.value).toBe('row-2');
  });

  it('counts a chained locator as unique even though the child alone is not', () => {
    const result = analyse(deleteButtonInSecondRow());
    const chained = result.locators.find((l) => l.method === 'Chained/Filtered');
    const bareRole = result.locators.find((l) => l.target.kind === 'role');
    expect(bareRole.matchCount).toBe(2); // two Delete buttons on the page
    expect(chained.matchCount).toBe(1);
    expect(chained.unique).toBe(true);
  });
});

describe('CSS fallback selector', () => {
  it('never produces an empty selector, which is a runtime error everywhere', () => {
    // The context-menu path falls back to document.body when it has no tracked
    // element, and <body> walked zero levels — so the fallback was page.locator('').
    document.body.innerHTML = '<p>hello</p>';
    for (const el of [document.body, document.documentElement]) {
      const css = E.generateLocators(el, DEFAULT_ATTRS).locators.find((l) => l.target.kind === 'css');
      expect(css.target.value, el.tagName).not.toBe('');
      expect(() => document.querySelectorAll(css.target.value)).not.toThrow();
      expect(css.code).not.toContain("locator('')");
    }
  });
});

// `code` is the string the user actually copies into a real test file — it isn't
// enough for it to *look* right, re-parsing it with a real JS engine has to reproduce
// a working selector. A value embedded without CSS-selector escaping (a literal `"`
// inside a `[attr="..."]`) or without doubling the backslashes cssEscape() inserts
// (dropped by JS's own string-literal parsing) breaks that round trip silently —
// the live uniqueness badge still says "unique" while the copied line throws.
describe('displayed code survives being re-parsed as real JS source', () => {
  function reparseLocatorArg(code) {
    const argSource = code.replace(/^page\.(?:locator|getByTestId)\(/, '').replace(/\)$/, '');
    // eslint-disable-next-line no-new-func -- deliberately re-parsing as a JS engine would
    return new Function('return ' + argSource)();
  }

  it('escapes CSS-special characters in a class-based fallback selector (Tailwind, etc.)', () => {
    document.body.innerHTML = '<div><button class="sm:flex w-1/2">Click</button></div>';
    const btn = document.querySelector('button');
    const css = E.generateLocators(btn, DEFAULT_ATTRS).locators.find((l) => l.method === 'locator() CSS');
    const selector = reparseLocatorArg(css.code);
    expect(() => document.querySelectorAll(selector)).not.toThrow();
    expect(document.querySelectorAll(selector)).toHaveLength(1);
  });

  it('escapes CSS-special characters in the dedicated #id card, not just the CSS fallback', () => {
    document.body.innerHTML = '<span id="md:w-1/2">t</span>';
    const el = document.getElementById('md:w-1/2');
    const idLoc = E.generateLocators(el, DEFAULT_ATTRS).locators.find((l) => l.method === "locator('#id')");
    const selector = reparseLocatorArg(idLoc.code);
    expect(() => document.querySelectorAll(selector)).not.toThrow();
    expect(document.querySelectorAll(selector)).toHaveLength(1);
  });

  it('uses getByTestId() for the standard attribute, which needs no CSS escaping at all', () => {
    document.body.innerHTML = '<button data-testid=\'save "primary" btn\'>Save</button>';
    const btn = document.querySelector('button');
    const testid = E.generateLocators(btn, DEFAULT_ATTRS).locators.find((l) => l.target.kind === 'testid');
    expect(testid.code).toBe('page.getByTestId(\'save "primary" btn\')');
  });

  it('escapes a double quote inside a custom (non data-testid) test attribute', () => {
    document.body.innerHTML = '<button data-qa=\'save "primary" btn\'>Save</button>';
    const btn = document.querySelector('button');
    const testid = E.generateLocators(btn, DEFAULT_ATTRS).locators.find((l) => l.target.kind === 'testid');
    const selector = reparseLocatorArg(testid.code);
    expect(() => document.querySelectorAll(selector)).not.toThrow();
    expect(document.querySelectorAll(selector)).toHaveLength(1);
  });

  it('escapes a double quote inside a name-attribute selector', () => {
    document.body.innerHTML = '<input name=\'field "x"\'>';
    const input = document.querySelector('input');
    const nameLoc = E.generateLocators(input, DEFAULT_ATTRS).locators.find((l) => l.target.kind === 'name');
    const selector = reparseLocatorArg(nameLoc.code);
    expect(() => document.querySelectorAll(selector)).not.toThrow();
    expect(document.querySelectorAll(selector)).toHaveLength(1);
  });

  it('escapes an embedded newline in a displayed value, which is otherwise a syntax error when pasted', () => {
    // A raw \n byte (as opposed to the two-character \n escape) inside a single-quoted
    // JS string literal is invalid syntax. getByText values are whitespace-normalised
    // now (as Playwright matches them), so an attribute value — which getByTitle()
    // passes through verbatim — is what carries a newline here.
    document.body.innerHTML = '<div id="subject" title="Line one\nLine two">x</div>';
    const el = document.getElementById('subject');
    const title = E.generateLocators(el, DEFAULT_ATTRS).locators.find((l) => l.target.kind === 'title');
    expect(title.code).toContain('\\n');
    // eslint-disable-next-line no-new-func -- deliberately re-parsing as a JS engine would
    expect(new Function('return ' + title.code.replace(/^page\.getByTitle\(/, '').replace(/\)$/, ''))()).toBe(
      'Line one\nLine two'
    );
  });
});

describe('shadow DOM', () => {
  /** A labelled control inside a closed-off shadow tree, as a web component ships it. */
  function shadowInput(markup) {
    document.body.innerHTML = '<div id="host"></div>';
    const root = document.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = markup;
    return root;
  }

  it('resolves aria-labelledby against the shadow root, not the document', () => {
    // IDREFs are scoped to their root. document.getElementById can never see inside
    // a shadow tree, so a properly-labelled component read as unnamed.
    const root = shadowInput('<span id="lbl">Card number</span><input id="f" aria-labelledby="lbl">');
    expect(E.getAccessibleName(root.getElementById('f'))).toBe('Card number');
  });

  it('resolves a <label for> association inside a shadow root', () => {
    const root = shadowInput('<label for="f">Expiry date</label><input id="f">');
    const el = root.getElementById('f');
    expect(E.getAccessibleName(el)).toBe('Expiry date');
    const label = E.generateLocators(el, DEFAULT_ATTRS).locators.find((l) => l.target.kind === 'label');
    expect(label.target.value).toBe('Expiry date');
  });

  it('does not confuse a same-id element in the light DOM for the shadow one', () => {
    document.body.innerHTML = '<span id="lbl">Light DOM label</span><div id="host"></div>';
    const root = document.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<span id="lbl">Shadow label</span><input id="f" aria-labelledby="lbl">';
    expect(E.getAccessibleName(root.getElementById('f'))).toBe('Shadow label');
  });

  // Uniqueness counts drive the "unique"/ambiguous badge shown to the user. Every
  // counting path (querySelector-by-attribute, text scan, role scan) used to run only
  // against document.querySelectorAll, which never sees into a shadow root — so a
  // duplicate living inside a web component was invisible and a genuinely ambiguous
  // locator was reported as unique.
  it('counts a duplicate testid living inside a shadow root, not just in the light DOM', () => {
    document.body.innerHTML = '<button id="subject" data-testid="dup">Save</button><div id="host"></div>';
    document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
      '<button data-testid="dup">Save</button>';
    const testid = analyse(document.getElementById('subject')).locators.find(
      (l) => l.target.kind === 'testid'
    );
    expect(testid.matchCount).toBe(2);
    expect(testid.unique).toBe(false);
  });

  it('counts a duplicate visible text living inside a shadow root', () => {
    document.body.innerHTML = '<span id="subject">Shared label</span><div id="host"></div>';
    document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<span>Shared label</span>';
    const text = analyse(document.getElementById('subject')).locators.find((l) => l.target.kind === 'text');
    expect(text.matchCount).toBe(2);
  });

  it('finds candidates by tag inside a shadow root (what the Stress Test relies on)', () => {
    document.body.innerHTML = '<div id="host"></div><button>Light</button>';
    document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
      '<button>Shadow one</button><button>Shadow two</button>';
    const buttons = E.deepQueryAll('button', document, Infinity);
    expect(buttons).toHaveLength(3);
  });

  it('still returns null for a syntactically invalid selector', () => {
    expect(E.deepQueryAll('[', document, Infinity)).toBeNull();
  });
});

describe('heading levels', () => {
  it.each([1, 2, 3, 4, 5, 6])('passes level %i through to the getByRole locator', (level) => {
    document.body.innerHTML = `<h${level} id="subject">Title</h${level}>`;
    const role = analyse(document.getElementById('subject')).locators.find((l) => l.target.kind === 'role');
    expect(role.target.level).toBe(level);
    expect(role.code).toContain(`level: ${level}`);
  });
});

// ── Regression cover for the Playwright-parity audit ────────────────────────────
// Each block below pins one finding. The expected values were confirmed against
// real Playwright (1.59, Chromium) with the same markup: the engine's matchCount
// for every generated locator equals `await locator.count()` there.

/** The locator card of a given target kind. */
function card(result, kind) {
  return result.locators.find((l) => l.target.kind === kind);
}

describe('#1 CSS fallback keeps the path below an id-bearing ancestor', () => {
  it('does not collapse to the bare ancestor id', () => {
    document.body.innerHTML =
      '<div id="main"><span><button class="a">Go</button></span><button class="a">Other</button></div>';
    const el = document.querySelector('span > button');
    const sel = E.buildCSSSelector(el);
    expect(sel).not.toBe('#main');
    const hits = document.querySelectorAll(sel);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toBe(el);
  });

  it('anchors at the ancestor id when the path alone is ambiguous', () => {
    document.body.innerHTML = '<div id="main"><p><b>x</b></p></div><section><p><b>x</b></p></section>';
    const el = document.querySelector('#main b');
    const sel = E.buildCSSSelector(el);
    expect(sel.startsWith('#main > ')).toBe(true);
    expect([...document.querySelectorAll(sel)]).toEqual([el]);
  });

  it('every generated CSS fallback resolves to exactly the analysed element', () => {
    document.body.innerHTML =
      '<ul><li><a href="#">A</a></li><li><a href="#">A</a></li></ul><ul><li><a href="#">A</a></li></ul>';
    for (const a of document.querySelectorAll('a')) {
      expect([...document.querySelectorAll(E.buildCSSSelector(a))]).toEqual([a]);
    }
  });
});

describe('#2 counts use Playwright default matching (substring, case-insensitive) and emit exact when needed (C5)', () => {
  it('counts a role name as a case-insensitive substring', () => {
    document.body.innerHTML = '<button id="subject">Save</button><button>SAVE draft</button>';
    expect(E.countTargetMatches({ kind: 'role', role: 'button', name: 'save' })).toBe(2);
    expect(E.countTargetMatches({ kind: 'role', role: 'button', name: 'Save', exact: true })).toBe(1);
  });

  it('switches to { exact: true } when only the exact match is unique', () => {
    document.body.innerHTML = '<button id="subject">Save</button><button>Save draft</button>';
    const role = card(analyse(document.getElementById('subject')), 'role');
    expect(role.target).toMatchObject({ kind: 'role', role: 'button', name: 'Save', exact: true });
    expect(role.code).toBe("page.getByRole('button', { name: 'Save', exact: true })");
    expect(role.matchCount).toBe(1);
    expect(role.unique).toBe(true);
  });

  it.each([
    ['text', '<p id="subject">Total</p><p>Total price</p>', "page.getByText('Total', { exact: true })"],
    [
      'label',
      '<label for="subject">Name</label><input id="subject"><label for="o">Name 2</label><input id="o">',
      "page.getByLabel('Name', { exact: true })",
    ],
    [
      'placeholder',
      '<input id="subject" placeholder="Email"><input placeholder="email address">',
      "page.getByPlaceholder('Email', { exact: true })",
    ],
    [
      'altText',
      '<img id="subject" alt="Logo" src="x.png"><img alt="Logo dark" src="y.png">',
      "page.getByAltText('Logo', { exact: true })",
    ],
    [
      'title',
      '<span id="subject" title="Edit">e</span><span title="Edit profile">f</span>',
      "page.getByTitle('Edit', { exact: true })",
    ],
  ])('emits the exact variant for %s', (kind, html, code) => {
    document.body.innerHTML = html;
    const loc = card(analyse(document.getElementById('subject')), kind);
    expect(loc.code).toBe(code);
    expect(loc.target.exact).toBe(true);
    expect(loc.unique).toBe(true);
  });

  it('leaves a locator non-exact when the default match is already unique', () => {
    const role = card(analyse(mount('<button id="subject">Save</button>')), 'role');
    expect(role.target.exact).toBeUndefined();
    expect(role.code).not.toContain('exact');
  });

  it('exports countTargetMatches and isOwnArtifactClass', () => {
    document.body.innerHTML = '<p>Hello world</p><p>hello there</p>';
    expect(E.countTargetMatches({ kind: 'text', value: 'HELLO' })).toBe(2);
    expect(E.countTargetMatches({ kind: 'text', value: 'Hello world', exact: true })).toBe(1);
    expect(E.countTargetMatches({ kind: 'nonsense' })).toBeNull();
    expect(E.isOwnArtifactClass('ll-hover')).toBe(true);
    expect(E.isOwnArtifactClass('locatra-lab')).toBe(true);
    expect(E.isOwnArtifactClass('roll-up')).toBe(false);
  });

  it('never builds a locator from the extension’s own classes or attributes', () => {
    document.body.innerHTML =
      '<div><span class="ll-hover locatra-lab x">a</span><span class="x">b</span></div>';
    const el = document.querySelector('span');
    const result = E.generateLocators(el, [...DEFAULT_ATTRS, 'data-ll-subject']);
    el.setAttribute('data-ll-subject', '1');
    for (const l of result.locators) {
      expect(l.code).not.toMatch(/ll-|locatra-/);
    }
    expect(E.generateLocators(el, ['data-ll-subject']).locators.some((l) => l.target.kind === 'testid')).toBe(
      false
    );
  });

  it('does not count the extension’s own overlay/tooltip text', () => {
    document.body.innerHTML = '<button id="subject">Save</button><div id="tip"><span>Save</span></div>';
    const tip = document.getElementById('tip');
    E.markOwnUi(tip); // what content.js does for its overlay and tooltip
    try {
      expect(card(analyse(document.getElementById('subject')), 'text').matchCount).toBe(1);
    } finally {
      E.unmarkOwnUi(tip);
    }
  });
});

describe('#3 no scan cap: every element on the page is counted', () => {
  const filler = '<span>f</span>'.repeat(4500);

  it('finds a unique element that comes after the first 4000 nodes', () => {
    document.body.innerHTML = `<div>${filler}</div><button id="subject">Tail button</button>`;
    const result = analyse(document.getElementById('subject'));
    expect(card(result, 'role').matchCount).toBe(1);
    expect(card(result, 'text').matchCount).toBe(1);
  });

  it('counts a duplicate that lives past the cap and inside a shadow root', () => {
    document.body.innerHTML = `<p id="subject">Dup</p><div>${filler}</div><p>Dup</p><div id="host"></div>`;
    document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<p>Dup</p>';
    expect(card(analyse(document.getElementById('subject')), 'text').matchCount).toBe(3);
  });
});

describe('#4 ranking prefers unique locators', () => {
  it('never puts an ambiguous locator first while a unique one exists', () => {
    document.body.innerHTML =
      '<ul><li><button id="subject">Delete</button></li><li><button>Delete</button></li></ul>';
    const result = analyse(document.getElementById('subject'));
    expect(result.locators[0].unique).toBe(true);
    const firstAmbiguous = result.locators.findIndex((l) => !l.unique);
    const lastUnique = result.locators.map((l) => l.unique).lastIndexOf(true);
    expect(lastUnique).toBeLessThan(firstAmbiguous);
    const role = card(result, 'role');
    expect(role.matchCount).toBe(2);
    expect(role.ambiguous).toBe(true);
    expect(role.explanation).toMatch(/not unique/);
  });

  it('ranks a locator that misses the element below everything else', () => {
    document.body.innerHTML = '<a href="/" id="subject"><span>Home</span></a>';
    const result = analyse(document.getElementById('subject'));
    const text = card(result, 'text');
    // getByText('Home') resolves to the <span> (smallest element), not the <a>.
    expect(text.matchesElement).toBe(false);
    expect(text.unique).toBe(false);
    expect(result.locators.at(-1)).toBe(text);
  });
});

describe('#5 accessible name precedence', () => {
  it('lets aria-labelledby win over aria-label', () => {
    document.body.innerHTML =
      '<span id="l">Close dialog</span><button id="subject" aria-label="X" aria-labelledby="l">X</button>';
    expect(E.getAccessibleName(document.getElementById('subject'))).toBe('Close dialog');
  });

  it('falls back to aria-label when the labelledby ids do not exist', () => {
    document.body.innerHTML = '<button id="subject" aria-label="Close" aria-labelledby="missing">X</button>';
    expect(E.getAccessibleName(document.getElementById('subject'))).toBe('Close');
  });
});

describe('#6 getByText targets resolve to the element they were built from', () => {
  it('whitespace-normalises the text the same way the matcher does', () => {
    document.body.innerHTML = '<div><p id="subject">Hello\n     <b>world</b></p></div>';
    const text = card(analyse(document.getElementById('subject')), 'text');
    expect(text.target.value).toBe('Hello world');
    expect(text.matchCount).toBe(1);
    expect(text.unique).toBe(true);
  });

  it('matches itself for text between 61 and 100 characters (no exact compare of a truncated value)', () => {
    const long = 'This is a fairly long paragraph text that goes beyond sixty characters ok';
    document.body.innerHTML = `<p id="subject">${long}</p>`;
    const text = card(analyse(document.getElementById('subject')), 'text');
    expect(text.target.value).toBe(long);
    expect(text.unique).toBe(true);
  });

  it('uses a word-bounded prefix for long text and never marks it exact', () => {
    const long = Array.from({ length: 25 }, (_, i) => 'word' + i).join(' ');
    document.body.innerHTML = `<p id="subject">${long}</p><p>${long}</p>`;
    const text = card(analyse(document.getElementById('subject')), 'text');
    expect(long.startsWith(text.target.value)).toBe(true);
    expect(text.target.value.length).toBeLessThanOrEqual(60);
    expect(text.target.exact).toBeUndefined();
    expect(text.matchCount).toBe(2);
  });

  it('does not downgrade unique text because its ancestors have the same text', () => {
    document.body.innerHTML = '<div><section><span id="subject">Only here</span></section></div>';
    const text = card(analyse(document.getElementById('subject')), 'text');
    expect(text.stability).toBe('GOOD');
    expect(text.unique).toBe(true);
  });
});

describe('#7 implicit roles match Playwright', () => {
  it.each([
    ['<select id="subject" multiple></select>', 'listbox'],
    ['<select id="subject" size="3"></select>', 'listbox'],
    ['<input id="subject" list="dl"><datalist id="dl"></datalist>', 'combobox'],
    ['<input id="subject" type="search" list="dl"><datalist id="dl"></datalist>', 'combobox'],
    ['<input id="subject" type="email" list="dl"><datalist id="dl"></datalist>', 'combobox'],
    ['<article><header id="subject">h</header></article>', null],
    ['<main><footer id="subject">f</footer></main>', null],
    ['<header id="subject">h</header>', 'banner'],
    ['<section id="subject">s</section>', null],
    ['<form id="subject"></form>', null],
    ['<input id="subject" type="image" alt="Go">', 'button'],
    ['<input id="subject" type="file">', 'button'],
    ['<input id="subject" type="date">', 'textbox'],
    ['<input id="subject" type="color">', 'textbox'],
    ['<input id="subject" type="hidden">', null],
    ['<select><option id="subject">a</option></select>', 'option'],
    ['<table><tr><th id="subject">R</th><td>1</td></tr></table>', 'rowheader'],
    ['<table><tr><th id="subject" scope="col">C</th></tr></table>', 'columnheader'],
    ['<table><tr><th id="subject">Only</th></tr></table>', null],
    ['<table role="grid"><tr><td id="subject">1</td></tr></table>', 'gridcell'],
    ['<img id="subject" alt="" src="x.png">', 'presentation'],
    ['<img id="subject" alt="" title="Spacer" src="x.png">', 'img'],
    ['<img id="subject" src="x.png">', 'img'],
    ['<div id="subject" role="foo button">x</div>', 'button'],
    ['<div id="subject" role="foo">x</div>', null],
    ['<ul role="presentation"><li id="subject">x</li></ul>', 'presentation'],
    ['<div id="subject" role="presentation" tabindex="0">x</div>', null],
    ['<fieldset id="subject"></fieldset>', 'group'],
    ['<p id="subject">x</p>', 'paragraph'],
  ])('%s → %s', (html, role) => {
    expect(E.getRole(mount(html))).toBe(role);
  });

  it('does not offer getByRole("presentation") for a decorative image', () => {
    const result = analyse(mount('<img id="subject" alt="" src="x.png">'));
    expect(result.locators.some((l) => l.target.kind === 'role')).toBe(false);
  });
});

describe('#8 submit/button input names', () => {
  it('uses value before title', () => {
    expect(
      E.getAccessibleName(mount('<input id="subject" type="submit" value="Go" title="Submit the form">'))
    ).toBe('Go');
  });

  it('defaults an empty submit to "Submit"', () => {
    expect(E.getAccessibleName(mount('<input id="subject" type="submit">'))).toBe('Submit');
  });
});

describe('#9 getByLabel agrees with what Playwright matches', () => {
  it('offers getByLabel for an input labelled only by aria-labelledby', () => {
    document.body.innerHTML = '<span id="l">Card number</span><input id="subject" aria-labelledby="l">';
    const label = card(analyse(document.getElementById('subject')), 'label');
    expect(label.target.value).toBe('Card number');
    expect(label.unique).toBe(true);
  });

  it('counts any element carrying the label text, not only form controls', () => {
    document.body.innerHTML = '<input id="subject" aria-label="Close"><button aria-label="Close">x</button>';
    expect(card(analyse(document.getElementById('subject')), 'label').matchCount).toBe(2);
  });

  it('uses aria-label before a <label for>, as getByLabel itself does', () => {
    // getByLabel uses aria-label before <label>, so 'Search' is what resolves here.
    document.body.innerHTML = '<label for="subject">Query</label><input id="subject" aria-label="Search">';
    const label = card(analyse(document.getElementById('subject')), 'label');
    expect(label.target.value).toBe('Search');
    expect(label.unique).toBe(true);
  });

  it('falls back to the full label text when the control sits mid-label', () => {
    document.body.innerHTML =
      '<label>Show <select id="subject"><option>10</option></select> per page</label>';
    const label = card(analyse(document.getElementById('subject')), 'label');
    expect(label.target.value).toBe('Show 10 per page');
    expect(label.unique).toBe(true);
  });
});

describe('#10 isUnstableClass', () => {
  it.each([
    'sc-bdVaJa',
    'css-1x2y3z',
    'css-1dbjc4n-Button',
    'emotion-0',
    'jss12',
    'makeStyles-root-12',
    'MuiButton-root-123',
    'Button_root__a1B2c',
    'styles_btn__3xK9a',
    'Header-module__title___2s5dH',
    '_3xK9a',
    'svelte-1xyz2ab',
    'ng-tns-c12-3',
    'ng-touched',
    'e1q3ycj70',
    'x-12345',
  ])('flags %s as generated', (cls) => {
    expect(E.isUnstableClass(cls)).toBe(true);
  });

  it.each([
    'btn-primary',
    'text-center',
    'form-control',
    'nav-wrapper',
    'col-md-6',
    'mt-4',
    'w-1/2',
    'sm:flex',
    'MuiButton-root',
    'card__title',
    'is-active',
    'h-[300px]',
    'grid-cols-12',
    'md:w-1/2',
    'ant-btn-primary',
    'fa-2x',
    'container',
    'text-2xl',
    'css-grid',
    'nav_bar__items',
    'h264-player',
    'col12',
  ])('keeps %s as hand-written', (cls) => {
    expect(E.isUnstableClass(cls)).toBe(false);
  });
});

describe('#11 isUnstableId', () => {
  it.each([
    ':r0:',
    ':R1a:',
    '«r1»',
    'radix-:r3:',
    'mat-input-0',
    'mui-123',
    'headlessui-menu-button-1',
    'react-select-2-input',
    '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    '3f2504e04f8911d39a0c0305e82c3301',
    'ember123',
    'field_123456',
    '12345',
    'section-a3f9b2c1',
  ])('flags %s', (id) => {
    expect(E.isUnstableId(id)).toBe(true);
  });

  it.each(['user-name', 'main', 'step-2', 'login-form', 'email', 'section2', 'h1-title', '__next', 'app'])(
    'keeps %s',
    (id) => {
      expect(E.isUnstableId(id)).toBe(false);
    }
  );

  it('does not use a React useId id in the CSS fallback', () => {
    document.body.innerHTML = '<div><label for=":r0:">Name</label><input id=":r0:"></div>';
    const result = analyse(document.getElementById(':r0:'));
    expect(result.locators.some((l) => l.target.kind === 'id')).toBe(false);
    expect(card(result, 'css').target.value).not.toContain('r0');
  });
});

describe('#12 hidden elements are not counted for getByRole', () => {
  it('ignores display:none, [hidden], visibility:hidden and aria-hidden copies', () => {
    document.body.innerHTML =
      '<div hidden><button>Delete</button></div><div style="display:none"><button>Delete</button></div>' +
      '<div aria-hidden="true"><button>Delete</button></div><button style="visibility:hidden">Delete</button>' +
      '<button id="subject">Delete</button>';
    const result = analyse(document.getElementById('subject'));
    expect(card(result, 'role').matchCount).toBe(1);
    // getByText does not filter hidden elements, in Playwright either.
    expect(card(result, 'text').matchCount).toBe(5);
  });

  it('leaves hidden descendants out of the name', () => {
    expect(
      E.getAccessibleName(
        mount('<button id="subject">Visible<span style="display:none">Hidden</span></button>')
      )
    ).toBe('Visible');
  });
});

describe('#13 heading level is part of the count', () => {
  it('does not count a same-named heading at another level', () => {
    document.body.innerHTML = '<h1>Intro</h1><h2 id="subject">Intro</h2>';
    const role = card(analyse(document.getElementById('subject')), 'role');
    expect(role.target.level).toBe(2);
    expect(role.matchCount).toBe(1);
    expect(E.countTargetMatches({ kind: 'role', role: 'heading', name: 'Intro' })).toBe(2);
  });

  it('reads aria-level for an ARIA heading', () => {
    document.body.innerHTML = '<div role="heading" aria-level="3" id="subject">T</div>';
    expect(card(analyse(document.getElementById('subject')), 'role').target.level).toBe(3);
  });
});

describe('#14 name from content', () => {
  it.each([
    ['<div id="subject" role="checkbox" aria-checked="false">Accept terms</div>', 'Accept terms'],
    ['<div id="subject" role="switch">Dark mode</div>', 'Dark mode'],
    ['<table><tr><td id="subject">Price</td></tr></table>', 'Price'],
    ['<div role="row" id="subject"><span>r1</span> <span>c1</span></div>', 'r1 c1'],
    ['<ul role="tree"><li role="treeitem" id="subject">Node</li></ul>', 'Node'],
    ['<div role="tooltip" id="subject">Tip</div>', 'Tip'],
    ['<button id="subject"><img alt="Trash" src="x.png"> Delete</button>', 'Trash Delete'],
    ['<a id="subject" href="#"><span aria-label="Home icon"></span> Home</a>', 'Home icon Home'],
    ['<button id="subject"><div>One</div><div>Two</div></button>', 'One Two'],
  ])('%s → %s', (html, name) => {
    expect(E.getAccessibleName(mount(html))).toBe(name);
  });

  it('uses the content name of a role="checkbox" for getByRole', () => {
    const role = card(analyse(mount('<div id="subject" role="checkbox">Accept terms</div>')), 'role');
    expect(role.code).toBe("page.getByRole('checkbox', { name: 'Accept terms' })");
  });
});

describe('#15 attribute selector values with control characters', () => {
  it('escapes a newline in a custom test attribute so the selector is valid and matches', () => {
    document.body.innerHTML = '<button data-qa="a\nb" id="subject">q</button>';
    const testid = card(analyse(document.getElementById('subject')), 'testid');
    expect(testid.code).toContain('\\\\a ');
    expect(testid.matchCount).toBe(1);
    // eslint-disable-next-line no-new-func -- deliberately re-parsing as a JS engine would
    const selector = new Function(
      'return ' + testid.code.replace(/^page\.locator\(/, '').replace(/\)$/, '')
    )();
    expect(document.querySelectorAll(selector)).toHaveLength(1);
  });
});

describe('#16 per-analysis work stays bounded on a large page', () => {
  it('analyses a control among hundreds of labelled controls correctly', () => {
    const rows = Array.from(
      { length: 400 },
      (_, i) => `<div><label for="f${i}">Field ${i}</label><input id="f${i}"></div>`
    ).join('');
    document.body.innerHTML = rows;
    const result = analyse(document.getElementById('f399'));
    const label = card(result, 'label');
    expect(label.target).toMatchObject({ value: 'Field 399' });
    expect(label.unique).toBe(true);
  });

  it('deepQueryAll still honours its optional cap and returns copies', () => {
    document.body.innerHTML = '<i></i><i></i><i></i>';
    const a = E.deepQueryAll('i', document, 2);
    expect(a).toHaveLength(2);
    a.length = 0;
    expect(E.deepQueryAll('i', document)).toHaveLength(3);
  });
});

describe('#17 dedupe, escaped avoid-list entries, composed chain containment', () => {
  it('escapes an unstable id in the avoid list so the shown selector is valid', () => {
    document.body.innerHTML = '<input id=":r0:">';
    const avoid = analyse(document.getElementById(':r0:')).avoidList.find((a) => a.locator.includes('r0'));
    // eslint-disable-next-line no-new-func -- deliberately re-parsing as a JS engine would
    const sel = new Function('return ' + avoid.locator.replace(/^page\.locator\(/, '').replace(/\)$/, ''))();
    expect(document.querySelectorAll(sel)).toHaveLength(1);
  });

  it('counts a chain whose child lives in the parent’s shadow root', () => {
    document.body.innerHTML = '<div data-testid="card"><x-card id="host"></x-card></div><button>Buy</button>';
    document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<button>Buy</button>';
    const chain = {
      kind: 'chain',
      parent: { kind: 'testid', attr: 'data-testid', value: 'card' },
      child: { kind: 'role', role: 'button', name: 'Buy' },
    };
    expect(E.countTargetMatches(chain)).toBe(1);
  });

  it('builds a chained locator through a shadow host', () => {
    document.body.innerHTML = '<div id="host"></div><button>Hi</button>';
    const root = document.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<section aria-label="Card"><button>Hi</button></section>';
    const result = analyse(root.querySelector('button'));
    const chained = result.locators.find((l) => l.method === 'Chained/Filtered');
    expect(chained.code).toBe(
      "page.getByRole('region', { name: 'Card' }).getByRole('button', { name: 'Hi' })"
    );
    expect(chained.unique).toBe(true);
    expect(result.locators[0].unique).toBe(true);
  });
});

describe('#18 deepQueryAll scope and order', () => {
  function build() {
    document.body.innerHTML =
      '<button id="b1"></button><div id="h1"></div><button id="b2"></button><div id="h2"></div>';
    const r1 = document.getElementById('h1').attachShadow({ mode: 'open' });
    r1.innerHTML = '<button id="s1a"></button><div id="n1"></div><button id="s1b"></button>';
    r1.getElementById('n1').attachShadow({ mode: 'open' }).innerHTML = '<button id="nn"></button>';
    document.getElementById('h2').innerHTML = '<button id="l2"></button>';
    document.getElementById('h2').attachShadow({ mode: 'open' }).innerHTML =
      '<slot></slot><button id="s2"></button>';
  }

  it('returns elements in the same order as Playwright (light DOM first, then shadow roots)', () => {
    build();
    // Verified in Chromium: page.locator('button') → b1,b2,l2,s1a,s1b,nn,s2
    expect(E.deepQueryAll('button', document).map((e) => e.id)).toEqual([
      'b1',
      'b2',
      'l2',
      's1a',
      's1b',
      'nn',
      's2',
    ]);
  });

  it('includes the scope element’s own shadow root', () => {
    build();
    // Verified in Chromium: page.locator('#h2').locator('button') → l2,s2
    expect(E.deepQueryAll('button', document.getElementById('h2')).map((e) => e.id)).toEqual(['l2', 's2']);
  });
});
