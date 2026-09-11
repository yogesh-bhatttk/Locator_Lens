// @vitest-environment jsdom
//
// The locator engine only makes sense against a real DOM, so these run in jsdom
// and drive the actual shipping file.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const DEFAULT_ATTRS = ['data-testid', 'data-qa', 'data-cy', 'data-test', 'data-automation-id', 'data-e2e'];

let E;
beforeAll(async () => {
  await import('../src/content-locator-engine.js');
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
    ['<table><tr><th id="subject"></th></tr></table>', 'columnheader'],
    ['<ul id="subject"></ul>', 'list'],
    ['<ol id="subject"></ol>', 'list'],
    ['<ul><li id="subject"></li></ul>', 'listitem'],
    ['<dialog id="subject"></dialog>', 'dialog'],
    ['<form id="subject"></form>', 'form'],
    ['<article id="subject"></article>', 'article'],
    ['<aside id="subject"></aside>', 'complementary'],
    ['<header id="subject"></header>', 'banner'],
    ['<footer id="subject"></footer>', 'contentinfo'],
    ['<section id="subject"></section>', 'region'],
    ['<menuitem id="subject"></menuitem>', 'menuitem'],
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
    const result = analyse(mount('<div id="subject"></div>'));
    expect(result.locators.length).toBeGreaterThan(0);
    expect(result.locators.some((l) => l.target.kind === 'css')).toBe(true);
  });

  it('sorts by stability and then renumbers ranks contiguously', () => {
    const result = analyse(mount('<button id="subject" data-testid="t">Save</button>'));
    const weight = { BEST: 4, GOOD: 3, OK: 2, AVOID: 1 };
    const weights = result.locators.map((l) => weight[l.stability]);
    expect([...weights]).toEqual([...weights].sort((a, b) => b - a));
    expect(result.locators.map((l) => l.rank)).toEqual(result.locators.map((_, i) => i + 1));
  });

  it('marks auto-generated class names as AVOID', () => {
    const result = analyse(mount('<div id="subject" class="sc-bdVaJa"></div>'));
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
    const result = analyse(el);
    const css = result.locators.find((l) => l.method === 'locator() CSS');
    expect(() => document.querySelectorAll(css.target.value)).not.toThrow();
    expect(document.querySelectorAll(css.target.value)).toHaveLength(1);
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

  it('escapes an embedded newline in getByText, which is otherwise a syntax error when pasted', () => {
    // A raw \n byte (as opposed to the two-character \n escape) inside a single-quoted
    // JS string literal is invalid syntax — realistic here since innerText/textContent
    // on multi-line content routinely contains one. (jsdom has no layout engine, so a
    // literal newline in the markup — not a <br>, which only becomes one during real
    // rendering — is what stands in for that here.)
    document.body.innerHTML = '<div id="subject">Line one\nLine two</div>';
    const el = document.getElementById('subject');
    const text = E.generateLocators(el, DEFAULT_ATTRS).locators.find((l) => l.target.kind === 'text');
    expect(text.code).toContain('\\n');
    // eslint-disable-next-line no-new-func -- deliberately re-parsing as a JS engine would
    expect(() => new Function('return ' + text.code.replace(/^page\.getByText\(/, '').replace(/\)$/, ''))()).not.toThrow();
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
    const testid = analyse(document.getElementById('subject')).locators.find((l) => l.target.kind === 'testid');
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
