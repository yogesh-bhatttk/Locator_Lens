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
    document.body.innerHTML = '<span id="a">Hello</span><span id="b">World</span><button id="subject" aria-labelledby="a b">x</button>';
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
