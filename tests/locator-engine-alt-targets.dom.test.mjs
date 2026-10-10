// @vitest-environment jsdom
//
// C9.1 · altTargets: the simple alternatives (test id, id, name, short CSS, short
// XPath) generateLocators() offers next to a role / label / text primary, so that
// Selenium, WebdriverIO, Java and C# can say By.id('username') instead of spelling
// out the accessible-name computation. Every alternative must be a complete target
// that resolves to the analysed element alone. Also the new `xpath` target kind:
// resolveTarget / countTargetMatches / the Playwright code for it.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

afterEach(() => {
  vi.restoreAllMocks();
});

const TEST_ATTRS = ['data-testid', 'data-qa', 'data-cy'];
const analyse = (el) => E.generateLocators(el, TEST_ATTRS);
const $ = (sel) => document.querySelector(sel);

/** Every alternative resolves to `el` and nothing else. */
function expectAllResolveTo(alts, el) {
  for (const t of alts) {
    expect(E.resolveTarget(t)).toEqual([el]);
    expect(E.countTargetMatches(t)).toBe(1);
  }
}

describe('altTargets — which alternatives, in which order', () => {
  it('(a) a textbox named by aria-label: id, name, then an aria-label XPath', () => {
    document.body.innerHTML =
      '<form><input id="username" name="user" aria-label="Username or Email"><input id="pw" type="password"></form>';
    const el = $('#username');
    const r = analyse(el);
    expect(r.locators[0].target).toMatchObject({ kind: 'role', role: 'textbox', name: 'Username or Email' });
    expect(r.altTargets).toEqual([
      { kind: 'id', value: 'username' },
      { kind: 'name', value: 'user' },
      { kind: 'xpath', value: '//input[@aria-label="Username or Email"]' },
    ]);
    expectAllResolveTo(r.altTargets, el);
  });

  it('(b) a lone attribute-less button: short CSS, then its own text', () => {
    document.body.innerHTML = '<main><p>Hi</p><button>Save</button></main>';
    const el = $('button');
    const r = analyse(el);
    expect(r.locators[0].target).toMatchObject({ kind: 'role', role: 'button', name: 'Save' });
    expect(r.altTargets).toEqual([
      { kind: 'css', value: 'button' },
      { kind: 'xpath', value: '//button[normalize-space(.)="Save"]' },
    ]);
    expectAllResolveTo(r.altTargets, el);
  });

  it('skips a positional CSS path when anything else exists', () => {
    document.body.innerHTML = '<button>Save</button><button>Cancel</button>';
    const el = $('button');
    const r = analyse(el);
    expect(r.altTargets).toEqual([{ kind: 'xpath', value: '//button[normalize-space(.)="Save"]' }]);
  });

  it('falls back to a positional CSS path only when nothing else exists', () => {
    document.body.innerHTML =
      '<span id="l1">Close</span><button aria-labelledby="l1"></button><button></button>';
    const el = $('button');
    const r = analyse(el);
    expect(r.locators[0].target).toMatchObject({ kind: 'role', name: 'Close' });
    expect(r.altTargets).toEqual([{ kind: 'css', value: 'button:nth-of-type(1)' }]);
    expectAllResolveTo(r.altTargets, el);
  });

  it('keeps at most three, best first: name, short CSS, XPath', () => {
    document.body.innerHTML =
      '<label for="em">Email</label><input name="email" placeholder="you@example.com" class="field"><b></b>';
    const el = $('input');
    const r = analyse(el);
    expect(r.altTargets).toEqual([
      { kind: 'name', value: 'email' },
      { kind: 'css', value: 'input.field' },
      { kind: 'xpath', value: '//input[@placeholder="you@example.com"]' },
    ]);
    expectAllResolveTo(r.altTargets, el);
  });

  it('a CSS path over 80 characters is not short enough', () => {
    const cls = 'c'.repeat(90);
    document.body.innerHTML = `<button class="${cls}">Go</button><button>Go</button>`;
    const r = analyse($('button'));
    expect(r.locators.some((l) => l.target.kind === 'css' && l.unique)).toBe(true);
    expect(JSON.stringify(r.altTargets || [])).not.toContain(cls);
  });

  it('offers a test id when one is unique but the primary is not it', () => {
    // Only reachable when the test-id card is not unique enough to win, so the
    // order is checked through a page where the test id is shared.
    document.body.innerHTML = '<button data-qa="x">Go</button><button data-qa="x">Stop</button>';
    const r = analyse($('button'));
    expect(r.locators[0].target.kind).toBe('role');
    expect(r.altTargets.some((t) => t.kind === 'testid')).toBe(false);
  });

  it('is omitted when the primary is itself a test id, id, name or CSS', () => {
    document.body.innerHTML =
      '<button data-testid="save">Save</button><div id="panel"></div><span><b></b></span><b></b>';
    expect(analyse($('[data-testid="save"]')).altTargets).toBeUndefined();
    const panel = analyse($('#panel'));
    expect(panel.locators[0].target.kind).toBe('id');
    expect(panel.altTargets).toBeUndefined();
    const b = analyse($('span > b'));
    expect(b.locators[0].target.kind).toBe('css');
    expect(b.altTargets).toBeUndefined();
  });

  it('never uses an unstable id, name or attribute value', () => {
    document.body.innerHTML =
      '<label for=":r1:">Email</label><input id=":r1:" name="field_12345" aria-label="input-48213" title="Email">';
    const el = document.getElementById(':r1:');
    const r = analyse(el);
    const json = JSON.stringify(r.altTargets);
    expect(json).not.toContain(':r1:');
    expect(json).not.toContain('12345');
    expect(json).not.toContain('48213');
    expect(r.altTargets).toEqual([
      { kind: 'css', value: 'input' },
      { kind: 'xpath', value: '//input[@title="Email"]' },
    ]);
    expectAllResolveTo(r.altTargets, el);
  });

  it('addresses a control with a generated id through its <label for>', () => {
    document.body.innerHTML =
      '<label for=":r1:">Email</label><input id=":r1:"><label for=":r2:">Name</label><input id=":r2:">';
    const el = document.getElementById(':r1:');
    const r = analyse(el);
    expect(r.altTargets).toEqual([
      { kind: 'xpath', value: '//input[@id=//label[normalize-space(.)="Email"]/@for]' },
    ]);
    expectAllResolveTo(r.altTargets, el);
  });

  it('a generated id without a <label for> (a wrapping label) gets no label XPath', () => {
    document.body.innerHTML = '<label>Email <input id=":r1:"></label><label>Name <input id=":r2:"></label>';
    const r = analyse(document.getElementById(':r1:'));
    expect(r.locators[0].target.kind).toBe('role');
    expect(JSON.stringify(r.altTargets)).not.toContain('xpath');
  });

  it('an element whose name XPath cannot spell gets no XPath', () => {
    const el = document.createElement('x-é');
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', 'Go');
    document.body.append(el, document.createElement('x-é'));
    const r = analyse(el);
    expect(r.locators[0].target).toMatchObject({ kind: 'role', name: 'Go' });
    expect(JSON.stringify(r.altTargets || [])).not.toContain('xpath');
  });

  it('a button input is addressed by its type and caption', () => {
    document.body.innerHTML = '<input type="text" aria-label="Q"><input type="submit" value="Search">';
    const el = $('[type=submit]');
    const r = analyse(el);
    expect(r.altTargets.at(-1)).toEqual({ kind: 'xpath', value: '//input[@type="submit"][@value="Search"]' });
    expectAllResolveTo(r.altTargets, el);
  });

  it('alt text is used on images, never on other tags', () => {
    document.body.innerHTML = '<img alt="Company logo" src="a.png"><div alt="nope" role="button">x</div>';
    const img = analyse($('img'));
    expect(img.altTargets.at(-1)).toEqual({ kind: 'xpath', value: '//img[@alt="Company logo"]' });
    const div = analyse($('div'));
    expect(JSON.stringify(div.altTargets)).not.toContain('nope');
  });
});

describe('altTargets — sensitive and volatile content', () => {
  it('never reads a field’s value (typed or prefilled) or a textarea’s text', () => {
    document.body.innerHTML =
      '<input type="password" aria-label="Password" value="hunter2-prefill">' +
      '<input type="text" aria-label="Card" value="4242424242424242">' +
      '<textarea aria-label="Notes">my secret note</textarea>';
    const pw = $('[type=password]');
    pw.value = 'hunter2';
    for (const el of document.querySelectorAll('input, textarea')) {
      const json = JSON.stringify(analyse(el).altTargets || []);
      expect(json).not.toMatch(/hunter2|4242|secret note/);
    }
  });

  it('skips text that is too long or looks generated', () => {
    const long = 'word '.repeat(40).trim();
    document.body.innerHTML = `<button>${long}</button><button>Order 1234567</button><a href="#">x</a>`;
    // Nothing else exists, so only the positional CSS path is left.
    expect(analyse($('button')).altTargets).toEqual([{ kind: 'css', value: 'button:nth-of-type(1)' }]);
    const order = analyse(document.querySelectorAll('button')[1]);
    expect(JSON.stringify(order.altTargets || [])).not.toContain('1234567');
  });

  it('does not offer XPath for an SVG element (namespaced names)', () => {
    document.body.innerHTML = '<svg role="img" aria-label="Logo"><title>Logo</title></svg><svg></svg>';
    const r = analyse($('svg'));
    expect(JSON.stringify(r.altTargets || [])).not.toContain('xpath');
  });
});

describe('altTargets — XPath quoting and whitespace', () => {
  it('uses single quotes for a value with a double quote', () => {
    document.body.innerHTML = '<button aria-label=\'Say "hi"\'>x</button><button>y</button>';
    const el = $('button');
    const xp = analyse(el).altTargets.find((t) => t.kind === 'xpath');
    expect(xp.value).toBe('//button[@aria-label=\'Say "hi"\']');
    expect(E.resolveTarget(xp)).toEqual([el]);
  });

  it('uses double quotes for a value with an apostrophe', () => {
    document.body.innerHTML = "<button>It's done</button><button>y</button>";
    const el = $('button');
    const xp = analyse(el).altTargets.find((t) => t.kind === 'xpath');
    expect(xp.value).toBe('//button[normalize-space(.)="It\'s done"]');
    expect(E.resolveTarget(xp)).toEqual([el]);
  });

  it('spells a value with both quote kinds as concat()', () => {
    const label = `Say "hi" it's`;
    const el = document.createElement('button');
    el.setAttribute('aria-label', label);
    document.body.append(el, document.createElement('button'));
    const xp = analyse(el).altTargets.find((t) => t.kind === 'xpath');
    expect(xp.value).toBe(`//button[@aria-label=concat("Say ", '"', "hi", '"', " it's")]`);
    expect(E.resolveTarget(xp)).toEqual([el]);
  });

  it('is NBSP-safe: a no-break space in the text is translated first', () => {
    document.body.innerHTML = '<button>Save&nbsp;now</button><button>Other</button>';
    const el = $('button');
    const xp = analyse(el).altTargets.find((t) => t.kind === 'xpath');
    expect(xp.value).toBe('//button[normalize-space(translate(., " ", " "))="Save now"]');
    expect(E.resolveTarget(xp)).toEqual([el]);
  });

  it('normalises surrounding and inner whitespace like normalize-space()', () => {
    document.body.innerHTML = '<a href="/x">\n   Read\n   more  </a><a href="/y">Other</a>';
    const el = $('a');
    const xp = analyse(el).altTargets.find((t) => t.kind === 'xpath');
    expect(xp.value).toBe('//a[normalize-space(.)="Read more"]');
    expect(E.resolveTarget(xp)).toEqual([el]);
  });

  it('skips a candidate over 120 characters and moves on to the next', () => {
    const tip = 'T'.repeat(110);
    document.body.innerHTML = `<button title="${tip}">Go</button><button>Stop</button>`;
    const el = $('button');
    const xp = analyse(el).altTargets.find((t) => t.kind === 'xpath');
    expect(xp.value).toBe('//button[normalize-space(.)="Go"]');
  });

  it('offers no XPath when no candidate is unique', () => {
    document.body.innerHTML =
      '<div><button aria-label="Edit row" title="Edit">Edit</button></div><span id="l">Edit 2</span>' +
      '<button aria-label="Edit row" title="Edit" aria-labelledby="l">Edit</button>';
    const r = analyse($('button'));
    expect(JSON.stringify(r.altTargets || [])).not.toContain('xpath');
  });
});

describe('altTargets — shadow DOM and frames', () => {
  it('no XPath alternative for an element inside a shadow root (XPath does not pierce)', () => {
    document.body.innerHTML = '<x-login id="host"></x-login>';
    const sr = $('#host').attachShadow({ mode: 'open' });
    sr.innerHTML = '<input id="user" aria-label="User name"><button>Go</button>';
    const input = sr.getElementById('user');
    const r = analyse(input);
    expect(r.altTargets).toEqual([{ kind: 'id', value: 'user' }]);
    expect(E.resolveTarget(r.altTargets[0])).toEqual([input]);
    expect(JSON.stringify(analyse(sr.querySelector('button')).altTargets || [])).not.toContain('xpath');
  });

  it('is built against the frame’s own document when analysed from inside it', () => {
    document.body.innerHTML = '<iframe id="pay"></iframe><input id="card" placeholder="4242 4242 4242 4242">';
    const w = $('#pay').contentWindow;
    const doc = w.document;
    doc.body.innerHTML =
      '<label for="card">Card number</label><input id="card" name="card" placeholder="4242 4242 4242 4242">';
    // The frame's own copy of the engine, as content scripts run per frame.
    vm.runInContext(readFileSync(join(ROOT, 'src/content-locator-engine.js'), 'utf8'), w, {
      filename: 'src/content-locator-engine.js',
    });
    const el = doc.getElementById('card');
    const r = w.__LocatorLensEngine.generateLocators(el, TEST_ATTRS);
    expect(r.altTargets).toEqual([
      { kind: 'id', value: 'card' },
      { kind: 'name', value: 'card' },
      { kind: 'xpath', value: '//input[@placeholder="4242 4242 4242 4242"]' },
    ]);
    for (const t of r.altTargets)
      expect(E.resolveTarget({ kind: 'frame', selector: '#pay', index: 0, child: t })).toEqual([el]);
  });
});

describe('altTargets — cost', () => {
  it('evaluates no XPath when the primary is already simple', () => {
    document.body.innerHTML = '<button data-testid="go">Go</button>';
    const spy = vi.spyOn(document, 'evaluate');
    analyse($('button'));
    expect(spy).not.toHaveBeenCalled();
  });

  it('stops at the first unique XPath candidate', () => {
    document.body.innerHTML = '<input aria-label="Email" placeholder="you@x" title="Email address"><b></b>';
    const spy = vi.spyOn(document, 'evaluate');
    analyse($('input'));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('memoises the XPath per analysis', () => {
    document.body.innerHTML = '<button title="Go">Go</button><button>Stop</button>';
    const spy = vi.spyOn(document, 'evaluate');
    analyse($('button'));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('xpath target kind', () => {
  it('resolves with document.evaluate, elements only, in document order', () => {
    document.body.innerHTML = '<p k="1">a</p><div><p k="2">b</p></div>';
    const t = { kind: 'xpath', value: '//p' };
    expect(E.resolveTarget(t).map((e) => e.getAttribute('k'))).toEqual(['1', '2']);
    expect(E.countTargetMatches(t)).toBe(2);
    // A text-node result is not an element.
    expect(E.resolveTarget({ kind: 'xpath', value: '//p/text()' })).toEqual([]);
  });

  it('an invalid expression cannot be evaluated: no matches, count null', () => {
    document.body.innerHTML = '<p>a</p>';
    const t = { kind: 'xpath', value: '//p[' };
    expect(E.resolveTarget(t)).toEqual([]);
    expect(E.countTargetMatches(t)).toBeNull();
  });

  it('a document without XPath support cannot evaluate it', () => {
    document.body.innerHTML = '<p>a</p>';
    vi.spyOn(document, 'evaluate', 'get').mockReturnValue(undefined);
    expect(E.countTargetMatches({ kind: 'xpath', value: '//p' })).toBeNull();
  });

  it('resolves inside a same-origin frame and within a scope', () => {
    document.body.innerHTML =
      '<iframe id="f"></iframe><section><button>In</button></section><button>Out</button>';
    const doc = $('#f').contentDocument;
    doc.body.innerHTML = '<button>Pay</button>';
    const framed = { kind: 'frame', selector: '#f', index: 0, child: { kind: 'xpath', value: '//button' } };
    expect(E.resolveTarget(framed)).toEqual([doc.querySelector('button')]);
    expect(E.resolveTarget({ kind: 'xpath', value: '//button' }, $('section'))).toEqual([
      $('section button'),
    ]);
    const chain = {
      kind: 'chain',
      parent: { kind: 'css', value: 'section' },
      child: { kind: 'xpath', value: '//button' },
    };
    expect(E.countTargetMatches(chain)).toBe(1);
  });

  it('never matches the extension’s own UI', () => {
    document.body.innerHTML = '<button>Save</button><div id="tip"><button>Save</button></div>';
    E.markOwnUi($('#tip'));
    try {
      expect(E.resolveTarget({ kind: 'xpath', value: '//button[normalize-space(.)="Save"]' })).toEqual([
        $('button'),
      ]);
      const r = analyse($('button'));
      expect(r.altTargets).toContainEqual({ kind: 'xpath', value: '//button[normalize-space(.)="Save"]' });
    } finally {
      E.unmarkOwnUi($('#tip'));
    }
  });

  it("renders as page.locator('xpath=…')", () => {
    expect(E.codeForTarget({ kind: 'xpath', value: '//button[normalize-space(.)="It\'s"]' })).toBe(
      "page.locator('xpath=//button[normalize-space(.)=\"It\\'s\"]')"
    );
    expect(E.codeForTarget(null)).toBe('');
  });
});
