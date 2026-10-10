// @vitest-environment jsdom
//
// resolveTarget() is what in-browser replay acts on, so it must find exactly the
// elements Playwright would — same set, same order — and agree with
// countTargetMatches(), which the badges show. Every `pw-verified:counts` table in
// the other engine suites is re-run here through resolveTarget; the order-sensitive
// rows below (nth, nested chains, shadow DOM, frames) were checked element by element
// against Playwright 1.59.1 in Chromium (locator.evaluateAll vs resolveTarget).
// Also: unwrapFrameTarget(), elementKind() and suggestName() for Page Objects.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
}

const role = (r, name, o = {}) => ({ kind: 'role', role: r, ...(name != null ? { name } : {}), ...o });
const byText = (value, o = {}) => ({ kind: 'text', value, ...o });
const byLabel = (value, o = {}) => ({ kind: 'label', value, ...o });
const css = (value) => ({ kind: 'css', value });
const chain = (parent, child) => ({ kind: 'chain', parent, child });
const keys = (els) => els.map((e) => e.getAttribute('k'));

// ── every pw-verified count, through resolveTarget ───────────────────────────
function verifiedCountRows() {
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
    for (const m of text.matchAll(
      /\/\/ pw-verified:counts\n\s*const (\w+) = (\[[\s\S]*?\n\s*\]);\n\s*\/\/ end pw-verified/g
    )) {
      for (const row of new Function(helpers + consts + '\nreturn ' + m[2])()) rows.push(row);
    }
  }
  return rows;
}

describe('resolveTarget agrees with every pw-verified count', () => {
  const rows = verifiedCountRows();

  it('finds the tables', () => {
    expect(rows.length).toBeGreaterThan(100);
  });

  it.each(rows)('%s %j → %i', (html, target, count, opts) => {
    render(html, opts);
    const els = E.resolveTarget(target);
    expect(els).toHaveLength(count);
    expect(E.countTargetMatches(target)).toBe(count);
    expect(new Set(els).size).toBe(els.length);
    els.forEach((el) => expect(el.nodeType).toBe(1));
  });
});

describe('resolveTarget: order and position (pw-verified element by element)', () => {
  it.each([
    // nth picks from the ordered result; out of range is empty.
    [
      '<button k="a">Edit</button><button k="b">Edit</button><button k="c">Edit</button>',
      role('button', 'Edit', { nth: 1 }),
      ['b'],
    ],
    ['<button k="a">Edit</button><button k="b">Edit</button>', role('button', 'Edit', { nth: 5 }), []],
    ['<button k="a">Edit</button><button k="b">Edit</button>', role('button', null, { nth: 0 }), ['a']],
    // A child's nth applies to the whole chain; a parent's nth to the parents.
    [
      '<ul><li><button k="a">Del</button></li><li><button k="b">Del</button></li></ul>',
      chain(css('ul'), role('button', 'Del', { nth: 1 })),
      ['b'],
    ],
    [
      '<ul><li><button k="a">Del</button></li><li><button k="b">Del</button></li></ul>',
      chain(role('listitem', null, { nth: 1 }), role('button', 'Del')),
      ['b'],
    ],
    [
      '<div><button k="a">A</button></div><div><button k="b">A</button></div>',
      chain(css('div'), role('button', null, { nth: 1 })),
      ['b'],
    ],
    // Scope by scope, each element once — not document order.
    [
      '<div class="a"><div class="a"><p k="x">x</p></div><p k="y">y</p></div><p k="z">z</p>',
      chain(css('.a'), css('p')),
      ['x', 'y'],
    ],
    [
      '<section><div class="r"><span class="c" k="1">1</span></div><div class="r"><span class="c" k="2">2</span></div></section><div class="r"><span class="c" k="3">3</span></div>',
      chain(css('section'), chain(css('.r'), css('.c'))),
      ['1', '2'],
    ],
    // Labels come back in document order, not label-source order.
    [
      '<label for="a">Email</label><input id="a" k="1"><label>Email again <input k="2"></label><button aria-label="Email" k="3">x</button><span id="l">Email</span><input aria-labelledby="l" k="4">',
      byLabel('Email'),
      ['1', '2', '3', '4'],
    ],
  ])('%s %j', (html, target, want) => {
    render(html);
    expect(keys(E.resolveTarget(target))).toEqual(want);
    expect(E.countTargetMatches(target)).toBe(want.length);
  });

  it('pierces open shadow roots, light DOM first', () => {
    render('<div id="h"></div><button k="light">Go</button>', {
      shadow: [['#h', '<button k="shadow">Go</button>']],
    });
    expect(keys(E.resolveTarget(role('button', 'Go')))).toEqual(['light', 'shadow']);
    render('<div id="h"></div><p k="light">Hi</p>', { shadow: [['#h', '<p k="shadow">Hi</p>']] });
    expect(keys(E.resolveTarget(byText('Hi')))).toEqual(['light', 'shadow']);
  });

  it('excludes the extension’s own UI — the nodes registered with markOwnUi', () => {
    render('<button k="page">Save</button><div id="ours"><button k="ours">Save</button></div>');
    const ours = document.getElementById('ours');
    E.markOwnUi(ours);
    E.markOwnUi(document.createTextNode('ignored')); // only elements are registered
    try {
      expect(keys(E.resolveTarget(role('button', 'Save')))).toEqual(['page']);
      expect(keys(E.resolveTarget(role('button', 'Save', { nth: 0 })))).toEqual(['page']);
      expect(keys(E.resolveTarget(css('[k]')))).toEqual(['page']);
    } finally {
      E.unmarkOwnUi(ours);
    }
    expect(keys(E.resolveTarget(role('button', 'Save')))).toEqual(['page', 'ours']);
  });

  it('never hides a page subtree because of an ll-/locatra- id (M4)', () => {
    render('<div id="ll-root"><button k="a">Save</button></div><div id="locatra-x"><p k="b">Hi</p></div>');
    expect(keys(E.resolveTarget(role('button', 'Save')))).toEqual(['a']);
    expect(keys(E.resolveTarget(byText('Hi')))).toEqual(['b']);
    // …and such an id is a usable locator of its own.
    const r = E.generateLocators(document.getElementById('ll-root'), []);
    expect(r.locators.some((l) => l.target.kind === 'id' && l.target.value === 'll-root')).toBe(true);
  });

  it('returns an empty array for anything it cannot evaluate', () => {
    render('<p>x</p>');
    expect(E.resolveTarget(null)).toEqual([]);
    expect(E.resolveTarget({ kind: 'nope' })).toEqual([]);
    expect(E.resolveTarget(css('[['))).toEqual([]);
    expect(E.resolveTarget(chain(css('p'), null))).toEqual([]);
    expect(E.resolveTarget(chain(css('p'), { kind: 'frame', selector: 'iframe', child: css('p') }))).toEqual(
      []
    );
    expect(E.countTargetMatches(chain(css('p'), null))).toBeNull();
  });

  it('survives malformed nested chains and unserialisable targets', () => {
    render('<p><b k="b">x</b></p>');
    expect(E.resolveTarget(chain(css('p'), chain(null, css('b'))))).toEqual([]);
    expect(E.resolveTarget(chain(css('p'), chain(css('[['), css('b'))))).toEqual([]);
    expect(keys(E.resolveTarget(chain(css('p'), chain(css('b'), byText('x')))))).toEqual(['b']);
    expect(E.resolveTarget({ kind: 'css', value: 'p', extra: 1n })).toEqual([]);
  });

  it('returns a fresh array each call', () => {
    render('<p k="1">x</p>');
    const a = E.resolveTarget(css('p'));
    a.pop();
    expect(keys(E.resolveTarget(css('p')))).toEqual(['1']);
  });
});

describe('resolveTarget: scoped to a root', () => {
  it('evaluates inside an element like scope.locator(), getByText including the scope', () => {
    render('<div id="s" k="s"><button k="in">Go</button></div><button k="out">Go</button>');
    const scope = document.getElementById('s');
    expect(keys(E.resolveTarget(role('button', 'Go'), scope))).toEqual(['in']);
    expect(keys(E.resolveTarget(byText('Go'), scope))).toEqual(['in']);
    expect(keys(E.resolveTarget(css('div'), scope))).toEqual([]);
    expect(keys(E.resolveTarget(byText('Go'), document.querySelector('[k="in"]')))).toEqual(['in']);
    expect(keys(E.resolveTarget(role('button', 'Go', { nth: 0 }), scope))).toEqual(['in']);
  });

  it('evaluates inside a shadow root', () => {
    render('<div id="h"></div><button k="out">Go</button>', {
      shadow: [['#h', '<button k="in">Go</button>']],
    });
    expect(keys(E.resolveTarget(role('button', 'Go'), document.getElementById('h').shadowRoot))).toEqual([
      'in',
    ]);
  });

  it('falls back to the document for a non-node root', () => {
    render('<p k="1">x</p>');
    expect(keys(E.resolveTarget(css('p'), { nodeType: 3 }))).toEqual(['1']);
  });
});

describe('resolveTarget: frames', () => {
  function addFrame(id, html, parentDoc = document) {
    const f = parentDoc.createElement('iframe');
    if (id) f.id = id;
    parentDoc.body.appendChild(f);
    f.contentDocument.body.innerHTML = html;
    return f;
  }
  const frame = (selector, child, o = {}) => ({ kind: 'frame', selector, index: 0, child, ...o });

  it('enters a same-origin frame and resolves with that document’s rules', () => {
    render('<label>Card <input k="top"></label>');
    addFrame(
      'pay',
      '<label>Card <input k="in"></label><button k="p1">Pay</button><button k="p2">Pay</button>'
    );
    expect(keys(E.resolveTarget(frame('#pay', byLabel('Card'))))).toEqual(['in']);
    expect(keys(E.resolveTarget(frame('#pay', role('button', 'Pay', { nth: 1 }))))).toEqual(['p2']);
    expect(E.countTargetMatches(frame('#pay', role('button', 'Pay')))).toBe(2);
    // The top document is unaffected by having looked inside.
    expect(keys(E.resolveTarget(byLabel('Card')))).toEqual(['top']);
  });

  it('nests and falls back to the frame index when there is no selector', () => {
    render('<p>top</p>');
    addFrame(null, '<p k="one">one</p>');
    const outer = addFrame(null, '<p>two</p>');
    addFrame('g', '<p k="deep">deep</p>', outer.contentDocument);
    expect(
      keys(E.resolveTarget({ kind: 'frame', selector: null, index: 1, child: frame('#g', byText('deep')) }))
    ).toEqual(['deep']);
    expect(keys(E.resolveTarget({ kind: 'frame', selector: null, child: byText('one') }))).toEqual(['one']);
    expect(E.resolveTarget({ kind: 'frame', selector: null, index: 9, child: byText('one') })).toEqual([]);
  });

  it('cannot evaluate a cross-origin, ambiguous or empty frame', () => {
    render('');
    const f = addFrame('x', '<p>secret</p>');
    Object.defineProperty(f, 'contentDocument', { get: () => null });
    const g = addFrame('y', '<p>secret</p>');
    Object.defineProperty(g, 'contentDocument', {
      get: () => {
        throw new Error('SecurityError');
      },
    });
    expect(E.resolveTarget(frame('#y', byText('secret')))).toEqual([]);
    expect(E.resolveTarget(frame('#x', byText('secret')))).toEqual([]);
    expect(E.countTargetMatches(frame('#x', byText('secret')))).toBeNull();
    addFrame(null, '<p>a</p>');
    addFrame(null, '<p>a</p>');
    expect(E.countTargetMatches(frame('iframe:not(#x)', byText('a')))).toBeNull();
    expect(E.countTargetMatches(frame('#none', byText('a')))).toBe(0);
    expect(E.countTargetMatches(frame('#x'))).toBeNull();
    expect(E.countTargetMatches(frame('p', byText('a')))).toBe(0);
    expect(E.countTargetMatches(frame('[[', byText('a')))).toBeNull();
  });

  it('resolves within every scope of an array root, each match once, in scope order', () => {
    render('<ul k="a"><li k="a1">x</li></ul><ul k="b"><li k="b1">x</li><li k="b2">y</li></ul><p k="p">x</p>');
    const [a, b] = document.querySelectorAll('ul');
    expect(keys(E.resolveTarget(css('li'), [b, a]))).toEqual(['b1', 'b2', 'a1']);
    expect(keys(E.resolveTarget(css('li'), [a, a.firstChild, b]))).toEqual(['a1', 'b1', 'b2']);
    expect(keys(E.resolveTarget(byText('x'), [a, b]))).toEqual(['a1', 'b1']);
    expect(keys(E.resolveTarget(role('listitem', null, { nth: 1 }), [a, b]))).toEqual(['b1']);
    // Documents and non-nodes are not scopes; nothing left means nothing found.
    expect(E.resolveTarget(css('li'), [document, null, 'x'])).toEqual([]);
    expect(E.resolveTarget(css('li'), [])).toEqual([]);
    expect(E.resolveTarget({ kind: 'nope' }, [a])).toEqual([]);
    const throwing = {
      kind: 'chain',
      get parent() {
        throw new Error('boom');
      },
      child: css('li'),
    };
    expect(E.resolveTarget(css('li'), [a, throwing])).toEqual(
      ['a1'].map((k) => document.querySelector(`[k="${k}"]`))
    );
    expect(E.resolveTarget(throwing, [a])).toEqual([]);
  });

  it('resolves against a frame document passed as the root', () => {
    render('<p k="top">x</p>');
    const f = addFrame('f', '<p k="in">x</p>');
    expect(keys(E.resolveTarget(byText('x'), f.contentDocument))).toEqual(['in']);
    expect(keys(E.resolveTarget(byText('x')))).toEqual(['top']);
  });
});

describe('unwrapFrameTarget', () => {
  it('splits a target into its frame path and the inner target', () => {
    const inner = role('button', 'Pay');
    const t = {
      kind: 'frame',
      selector: '#outer',
      index: 0,
      child: {
        kind: 'frame',
        selector: null,
        index: 2,
        framesIndex: 3,
        shadowPath: ['#h', 'iframe'],
        child: inner,
      },
    };
    expect(E.unwrapFrameTarget(t)).toEqual({
      framePath: [
        { selector: '#outer', index: 0 },
        { selector: null, index: 2, framesIndex: 3, shadowPath: ['#h', 'iframe'] },
      ],
      inner,
    });
    expect(E.unwrapFrameTarget(inner)).toEqual({ framePath: [], inner });
    expect(E.unwrapFrameTarget(null)).toEqual({ framePath: [], inner: null });
    expect(E.unwrapFrameTarget({ kind: 'frame', selector: '#f' })).toEqual({
      framePath: [{ selector: '#f', index: 0 }],
      inner: null,
    });
  });
});

describe('elementKind and suggestName', () => {
  function subject(html) {
    render(html);
    return document.querySelector('[data-s]');
  }

  it.each([
    ['<input data-s>', 'input'],
    ['<input data-s type="email">', 'input'],
    ['<input data-s type="checkbox">', 'checkbox'],
    ['<input data-s type="radio">', 'radio'],
    ['<input data-s type="submit">', 'button'],
    ['<textarea data-s></textarea>', 'textarea'],
    ['<select data-s></select>', 'select'],
    ['<button data-s>x</button>', 'button'],
    ['<a data-s href="/">x</a>', 'link'],
    ['<a data-s>x</a>', 'other'],
    ['<div data-s role="switch">x</div>', 'checkbox'],
    ['<div data-s role="menuitemradio">x</div>', 'radio'],
    ['<span data-s role="button">x</span>', 'button'],
    ['<span data-s role="link">x</span>', 'link'],
    ['<div data-s contenteditable="true">x</div>', 'other'],
  ])('%s is %s', (html, kind) => {
    expect(E.elementKind(subject(html))).toBe(kind);
  });

  it('handles non-elements', () => {
    expect(E.elementKind(null)).toBe('other');
    expect(E.suggestName(null)).toBe('element');
    expect(E.suggestName(document.createTextNode('x'))).toBe('element');
  });

  it.each([
    ['<label for="em">Email address</label><input id="em" data-s>', 'emailAddressInput'],
    ['<button data-s>Place order</button>', 'placeOrderButton'],
    ['<button data-s data-testid="submit-btn">Go now</button>', 'submitButton'],
    ['<input data-s data-testid="email-input" aria-label="E-mail">', 'emailInput'],
    ['<input data-s data-testid="a8f3c2d91e" aria-label="Search">', 'searchInput'],
    ['<input data-s placeholder="Your city">', 'yourCityInput'],
    ['<textarea data-s aria-label="Order notes"></textarea>', 'orderNotesField'],
    ['<label>Country <select data-s><option>DE</option></select></label>', 'countrySelect'],
    [
      '<label><input type="checkbox" data-s> I accept the terms and conditions</label>',
      'iAcceptTheTermsCheckbox',
    ],
    ['<label><input type="radio" data-s> Express</label>', 'expressRadio'],
    ['<a data-s href="/help">Help centre</a>', 'helpCentreLink'],
    ['<div data-s role="switch" aria-label="Dark mode"></div>', 'darkModeCheckbox'],
    ['<div data-s role="tab">Billing</div>', 'billingTab'],
    ['<h2 data-s>Order summary</h2>', 'orderSummaryHeading'],
    ['<div data-s contenteditable="true" role="textbox" aria-label="Bio"></div>', 'bioInput'],
    ['<input data-s id="shipping-zip">', 'shippingZipInput'],
    ['<input data-s name="postal_code">', 'postalCodeInput'],
    ['<input data-s>', 'input'],
    ['<button data-s></button>', 'button'],
    ['<div data-s></div>', 'div'],
    ['<p data-s>Paragraphs have no name</p>', 'p'],
    ['<x-foo data-s></x-foo>', 'xFoo'],
    ['<button data-s>Button</button>', 'button'],
    ['<button data-s>2FA code</button>', 'el2faCodeButton'],
    ['<button data-s>Café crème</button>', 'cafeCremeButton'],
    ['<span data-s data-testid="delete">x</span>', 'deleteElement'],
    ['<div data-s data-qa="class"></div>', 'classElement'],
    ['<span data-s data-qa="userMenu">x</span>', 'userMenu'],
  ])('%s → %s', (html, name) => {
    const el = subject(html);
    const got = E.suggestName(el);
    expect(got).toBe(name);
    expect(got).toMatch(/^[a-z][A-Za-z0-9]*$/);
  });

  it('uses the configured test attributes when given', () => {
    const el = subject('<button data-s data-hook="buy-now" data-testid="x1">Purchase</button>');
    expect(E.suggestName(el, ['data-hook'])).toBe('buyNowButton');
    expect(E.suggestName(el, ['data-ll-x', 'data-hook'])).toBe('buyNowButton');
    expect(E.suggestName(el)).toBe('x1Button');
  });

  it('caps long names at four words', () => {
    const el = subject('<button data-s>Add this item to my shopping cart now</button>');
    expect(E.suggestName(el)).toBe('addThisItemToButton');
  });
});
