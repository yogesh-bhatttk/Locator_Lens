// @vitest-environment jsdom
//
// Round 3, content side: settings the options page writes (test-id attributes, the
// legacy customAttributes key, secret variable names), the element fingerprint on
// ELEMENT_PICKED / POM_RESULT, and globalThis.__LocatraHealthCheck — the function
// BACKGROUND runs in every frame to re-check watched locators.

/* global LLCodegen */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_SCRIPTS = ['src/codegen.js', 'src/content-locator-engine.js', 'src/content.js'];

let handlers = [];
let sent = [];
let storageListeners = [];
const allHandlers = [];

function stopAll() {
  for (const h of allHandlers) {
    try {
      h({ type: 'STOP_RECORDING' }, {}, () => {});
      h({ type: 'STOP_INSPECT' }, {}, () => {});
    } catch {
      /* torn down */
    }
  }
}

function load({ storage = {} } = {}) {
  stopAll();
  if (globalThis.chrome && globalThis.chrome.runtime) delete globalThis.chrome.runtime.id;
  handlers = [];
  sent = [];
  storageListeners = [];
  globalThis.__LocatraTrustSyntheticEvents = true;
  globalThis.chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      sendMessage: (msg) => sent.push(msg),
      onMessage: {
        addListener: (fn) => {
          handlers.push(fn);
          allHandlers.push(fn);
        },
        removeListener: () => {},
      },
    },
    storage: {
      local: { get: (keys, cb) => cb(storage) },
      onChanged: { addListener: (fn) => storageListeners.push(fn), removeListener: () => {} },
    },
  };
  delete globalThis.__LocatorLensEngine;
  delete globalThis.LLCodegen;
  for (const file of CONTENT_SCRIPTS) {
    vm.runInThisContext(readFileSync(join(ROOT, file), 'utf8'), { filename: file });
  }
}

/** A same-origin iframe with its own copy of the content scripts. */
function loadIntoFrame(frame, storage = {}) {
  const w = frame.contentWindow;
  w.__LocatraTrustSyntheticEvents = true;
  w.chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      sendMessage: () => {},
      onMessage: { addListener: () => {} },
    },
    storage: { local: { get: (k, cb) => cb(storage) }, onChanged: { addListener: () => {} } },
  };
  for (const file of CONTENT_SCRIPTS)
    vm.runInContext(readFileSync(join(ROOT, file), 'utf8'), w, { filename: file });
  return w;
}

function send(msg) {
  let response;
  for (const h of handlers) h(msg, {}, (r) => (response = r));
  return response;
}

const changed = (changes) => storageListeners.forEach((fn) => fn(changes, 'local'));
const picks = () => sent.filter((m) => m.type === 'ELEMENT_PICKED').map((m) => m.data);
const recorded = () => sent.filter((m) => m.type === 'RECORDED_ACTION').map((m) => m.data);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function pick(el) {
  send({ type: 'START_INSPECT' });
  document.elementFromPoint = () => el;
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  send({ type: 'STOP_INSPECT' });
  return picks().at(-1);
}

const health = (items) => globalThis.__LocatraHealthCheck(items);
const role = (r, name, extra = {}) => ({ kind: 'role', role: r, name, ...extra });
const E = () => globalThis.__LocatorLensEngine;

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  delete document.elementFromPoint;
  load();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Settings ────────────────────────────────────────────────────────────────

describe('test-id attributes from llSettings', () => {
  it('llSettings.testIdAttributes come first, in their order, before the built-ins', () => {
    load({ storage: { llSettings: { testIdAttributes: ['data-b', 'data-a'] } } });
    document.body.innerHTML = '<button data-testid="t" data-a="a" data-b="b">Pay</button>';
    expect(pick(document.querySelector('button')).locators[0].target).toEqual(
      expect.objectContaining({ kind: 'testid', attr: 'data-b', value: 'b' })
    );
  });

  it('settings outrank the legacy customAttributes key, which still counts', () => {
    load({ storage: { llSettings: { testIdAttributes: ['data-s'] }, customAttributes: ['data-l'] } });
    document.body.innerHTML = '<button data-l="l" data-s="s">A</button><button data-l="only">B</button>';
    const [a, b] = document.querySelectorAll('button');
    expect(pick(a).locators[0].target).toMatchObject({ attr: 'data-s', value: 's' });
    expect(pick(b).locators[0].target).toMatchObject({ attr: 'data-l', value: 'only' });
  });

  it('drops invalid, duplicate and non-string names and keeps at most 20', () => {
    const many = Array.from({ length: 25 }, (_, i) => `data-x${i}`);
    load({
      storage: {
        llSettings: {
          testIdAttributes: ['bad name', 42, null, '<script>', '1abc', 'data-ok', 'data-ok', ...many],
        },
      },
    });
    document.body.innerHTML =
      '<button data-x20="late" data-ok="ok">A</button><button data-x19="x19">B</button><button data-x20="x20">C</button>';
    const [a, b, c] = document.querySelectorAll('button');
    expect(pick(a).locators[0].target).toMatchObject({ attr: 'data-ok' });
    // data-ok + data-x0..data-x18 = 20 names: data-x19 and later are ignored.
    expect(pick(b).locators[0].target.kind).not.toBe('testid');
    expect(pick(c).locators[0].target.kind).not.toBe('testid');
  });

  it('a non-array value, or no llSettings at all, means the built-ins only', () => {
    load({ storage: { llSettings: { testIdAttributes: 'data-hook' }, customAttributes: 'data-hook' } });
    document.body.innerHTML = '<button data-hook="h" data-qa="q">A</button>';
    expect(pick(document.querySelector('button')).locators[0].target).toMatchObject({ attr: 'data-qa' });
  });

  it('follows storage.onChanged for llSettings and customAttributes live', () => {
    load({ storage: { customAttributes: ['data-l'] } });
    document.body.innerHTML = '<button data-l="l" data-s="s" data-qa="q">A</button>';
    const btn = document.querySelector('button');
    expect(pick(btn).locators[0].target).toMatchObject({ attr: 'data-l' });

    changed({ llSettings: { newValue: { testIdAttributes: ['data-s'] } } });
    expect(pick(btn).locators[0].target).toMatchObject({ attr: 'data-s' });

    // The options page migrates the legacy key and removes it: data-l stops counting.
    changed({ customAttributes: { newValue: undefined } });
    changed({ llSettings: { newValue: { testIdAttributes: ['data-s', 'data-l'] } } });
    expect(pick(btn).locators[0].target).toMatchObject({ attr: 'data-s' });
    changed({ llSettings: { newValue: { testIdAttributes: ['data-l'] } } });
    expect(pick(btn).locators[0].target).toMatchObject({ attr: 'data-l' });

    // llSettings removed (reset): back to the built-ins.
    changed({ llSettings: { newValue: undefined } });
    expect(pick(btn).locators[0].target).toMatchObject({ attr: 'data-qa' });
  });

  it('ignores changes from other storage areas', () => {
    document.body.innerHTML = '<button data-s="s" data-qa="q">A</button>';
    storageListeners.forEach((fn) =>
      fn({ llSettings: { newValue: { testIdAttributes: ['data-s'] } } }, 'sync')
    );
    expect(pick(document.querySelector('button')).locators[0].target).toMatchObject({ attr: 'data-qa' });
  });

  it('page object member names use the configured attribute too', async () => {
    load({ storage: { llSettings: { testIdAttributes: ['data-hook'] } } });
    document.body.innerHTML = '<button data-hook="place-order">Buy</button>';
    send({ type: 'POM_SCAN' });
    let data;
    for (let i = 0; i < 100 && !data; i++) {
      data = sent.find((m) => m.type === 'POM_RESULT')?.data;
      await tick(5);
    }
    expect(data.elements[0].name).toBe('placeOrderButton');
  });
});

describe('secret variable names from llSettings', () => {
  const html = `
    <input id="pw" type="password">
    <input id="otp" autocomplete="one-time-code">
    <input id="np" autocomplete="new-password">`;

  function typeInto(id, value) {
    const el = document.getElementById(id);
    el.focus();
    el.value = value;
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
  }

  async function fillsFor(ids) {
    send({ type: 'START_RECORDING' });
    ids.forEach((id) => typeInto(id, 'hunter2'));
    await tick(700);
    send({ type: 'STOP_RECORDING' });
    return recorded().filter((s) => s.action === 'fill');
  }

  it('password fields use secretNames.password, other sensitive fields secretNames.secret', async () => {
    load({ storage: { llSettings: { secretNames: { password: 'APP_PASSWORD', secret: 'APP_OTP' } } } });
    document.body.innerHTML = html;
    const fills = await fillsFor(['pw', 'otp', 'np']);
    expect(fills.map((f) => f.secretName)).toEqual(['APP_PASSWORD', 'APP_OTP', 'APP_PASSWORD']);
    fills.forEach((f) => {
      expect(f.value).toBe('');
      expect(f.sensitive).toBe(true);
      expect(JSON.stringify(f)).not.toContain('hunter2');
    });
    expect(fills[0].fullCode).toContain('process.env.APP_PASSWORD');
  });

  it('invalid or missing names fall back to the defaults, per field', async () => {
    load({ storage: { llSettings: { secretNames: { password: 'has space', secret: 7 } } } });
    document.body.innerHTML = html;
    const fills = await fillsFor(['pw', 'otp']);
    expect(fills.map((f) => f.secretName)).toEqual(['LOCATRA_PASSWORD', 'LOCATRA_SECRET']);
  });

  it('a non-object secretNames means the defaults', async () => {
    load({ storage: { llSettings: { secretNames: 'APP' } } });
    document.body.innerHTML = html;
    const fills = await fillsFor(['pw']);
    expect(fills[0].secretName).toBe('LOCATRA_PASSWORD');
  });

  it('follows storage.onChanged live', async () => {
    document.body.innerHTML = html;
    changed({ llSettings: { newValue: { secretNames: { secret: 'MY_SECRET' } } } });
    const fills = await fillsFor(['pw', 'otp']);
    expect(fills.map((f) => f.secretName)).toEqual(['LOCATRA_PASSWORD', 'MY_SECRET']);
  });
});

// ── Fingerprint ─────────────────────────────────────────────────────────────

describe('element fingerprint', () => {
  it('ELEMENT_PICKED carries elementData.fingerprint with the exact field set', () => {
    document.body.innerHTML =
      '<a id="docs" data-testid="docs-link" class="nav-link css-1x2y3z ll-hover primary a b c" title="Read the docs" href="#/docs?access_token=abc&amp;x=1">  Read   the docs </a>';
    const fp = pick(document.querySelector('a')).elementData.fingerprint;
    expect(fp).toEqual({
      tag: 'a',
      id: 'docs',
      testId: 'docs-link',
      testAttr: 'data-testid',
      role: 'link',
      name: null,
      label: 'Read the docs',
      placeholder: null,
      text: 'Read the docs',
      type: null,
      href: '#/docs?access_token=REDACTED&x=1',
      alt: null,
      title: 'Read the docs',
      // own (ll-) and generated (css-…) classes dropped; at most five kept
      classes: ['nav-link', 'primary', 'a', 'b', 'c'],
    });
  });

  it('form controls: name attribute, accessible name as label, type, no text, never the value', () => {
    document.body.innerHTML =
      '<label for="pw">Your password</label><input id="pw" name="password" type="Password" placeholder="••••">';
    const input = document.getElementById('pw');
    input.value = 'hunter2-secret';
    const fp = pick(input).elementData.fingerprint;
    expect(fp).toMatchObject({
      tag: 'input',
      id: 'pw',
      name: 'password',
      label: 'Your password',
      placeholder: '••••',
      type: 'password',
      text: null,
      role: 'textbox',
      testId: null,
      testAttr: null,
    });
    expect(JSON.stringify(fp)).not.toContain('hunter2');
  });

  it('a textarea’s content is not taken as text', () => {
    document.body.innerHTML = '<textarea aria-label="Notes">private draft</textarea>';
    const fp = pick(document.querySelector('textarea')).elementData.fingerprint;
    expect(fp.text).toBeNull();
    expect(fp.label).toBe('Notes');
  });

  it('long values are clipped: text to 80 chars, label to 120, attributes to 200', () => {
    const long = 'word '.repeat(60).trim();
    document.body.innerHTML = `<button id="${'i'.repeat(300)}" data-qa="${'q'.repeat(300)}">${long}</button>`;
    const fp = pick(document.querySelector('button')).elementData.fingerprint;
    expect(fp.text).toHaveLength(80);
    expect(fp.label.length).toBeLessThanOrEqual(120);
    expect(fp.id).toHaveLength(200);
    expect(fp.testId).toHaveLength(200);
    expect(fp.testAttr).toBe('data-qa');
  });

  it('uses the configured test-id attribute, skipping Locatra’s own data-ll-* ones', () => {
    load({ storage: { llSettings: { testIdAttributes: ['data-ll-mark', 'data-hook'] } } });
    document.body.innerHTML = '<button data-ll-mark="x" data-hook="pay">Pay</button>';
    const fp = pick(document.querySelector('button')).elementData.fingerprint;
    expect(fp).toMatchObject({ testAttr: 'data-hook', testId: 'pay' });
  });

  it('an SVG element (className is not a string) still gets classes', () => {
    document.body.innerHTML = '<svg class="icon big" role="img" aria-label="Logo"></svg>';
    const fp = pick(document.querySelector('svg')).elementData.fingerprint;
    expect(fp).toMatchObject({ tag: 'svg', classes: ['icon', 'big'], label: 'Logo' });
  });

  it('a context-menu copy while inspecting carries the fingerprint as well', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    const go = document.getElementById('go');
    send({ type: 'START_INSPECT' });
    go.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
    send({ type: 'CONTEXT_MENU_COPY' });
    expect(picks().at(-1).elementData.fingerprint).toMatchObject({ tag: 'button', id: 'go', text: 'Go' });
  });

  it('every POM_RESULT element carries a fingerprint', async () => {
    document.body.innerHTML = '<form><input id="email" placeholder="Email"><button>Send</button></form>';
    send({ type: 'POM_SCAN' });
    let data;
    for (let i = 0; i < 100 && !data; i++) {
      data = sent.find((m) => m.type === 'POM_RESULT')?.data;
      await tick(5);
    }
    expect(data.elements.map((e) => e.fingerprint)).toEqual([
      expect.objectContaining({ tag: 'input', id: 'email', placeholder: 'Email', label: 'Email' }),
      expect.objectContaining({ tag: 'button', text: 'Send', role: 'button' }),
    ]);
  });

  it('a fingerprint failure never breaks the pick', () => {
    document.body.innerHTML = '<button>Go</button>';
    vi.spyOn(E(), 'getRole').mockImplementation(() => {
      throw new Error('boom');
    });
    const data = pick(document.querySelector('button'));
    expect(data.elementData.fingerprint).toMatchObject({ tag: 'button', role: null });
  });
});

// ── Health check ────────────────────────────────────────────────────────────

describe('__LocatraHealthCheck — counts and statuses', () => {
  it('is published on the content script’s global, synchronously returning one result per item', () => {
    expect(typeof globalThis.__LocatraHealthCheck).toBe('function');
    document.body.innerHTML = '<button>Save</button><button>Save copy</button><button>Other</button>';
    const out = health([
      { id: 'ok', target: role('button', 'Other') },
      { id: 'broken', target: role('button', 'Delete') },
      { id: 'amb', target: role('button', 'Save') },
    ]);
    expect(out).toEqual([
      { id: 'ok', owned: true, count: 1, status: 'ok' },
      { id: 'broken', owned: true, count: 0, status: 'broken' },
      { id: 'amb', owned: true, count: 2, status: 'ambiguous' },
    ]);
  });

  it('counts with the engine’s resolveTarget (shadow DOM included)', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const sr = document.getElementById('host').attachShadow({ mode: 'open' });
    sr.innerHTML = '<button data-testid="deep">Deep</button>';
    const spy = vi.spyOn(E(), 'resolveTarget');
    const [res] = health([{ id: 1, target: { kind: 'testid', attr: 'data-testid', value: 'deep' } }]);
    expect(res).toEqual({ id: 1, owned: true, count: 1, status: 'ok' });
    expect(spy).toHaveBeenCalled();
  });

  it('does not count Locatra’s own overlay', () => {
    document.body.innerHTML = '<button>Inspect</button><div id="ll-tooltip"><button>Inspect</button></div>';
    expect(health([{ id: 1, target: { kind: 'css', value: 'button' } }])[0]).toMatchObject({
      count: 1,
      status: 'ok',
    });
  });

  it('reports a locator it cannot evaluate as an error, not as broken', () => {
    document.body.innerHTML = '<button>Go</button>';
    const [bad, unknown] = health([
      { id: 'css', target: { kind: 'css', value: 'button[[' } },
      { id: 'kind', target: { kind: 'nonsense' } },
    ]);
    expect(bad).toMatchObject({ id: 'css', owned: true, status: 'error', count: 0 });
    expect(bad.error).toMatch(/cannot evaluate locator/);
    expect(unknown).toMatchObject({ status: 'error' });
  });

  it('answers malformed input without throwing', () => {
    expect(health(undefined)).toEqual([]);
    expect(health('nope')).toEqual([]);
    const out = health([
      null,
      7,
      { id: 'nt' },
      { id: 'ft', target: { kind: 'frame', selector: '#x', index: 0 } },
    ]);
    expect(out[0]).toEqual({
      id: null,
      owned: true,
      count: 0,
      status: 'error',
      error: 'not a watched locator',
    });
    expect(out[1]).toMatchObject({ id: null, status: 'error' });
    expect(out[2]).toEqual({
      id: 'nt',
      owned: true,
      count: 0,
      status: 'error',
      error: 'the watched locator has no target',
    });
    // Frame-wrapped: not the top document's.
    expect(out[3]).toEqual({ id: 'ft', owned: false, count: 0, status: 'frame-missing' });
  });

  it('caps the number of items it looks at', () => {
    document.body.innerHTML = '<button>Go</button>';
    const items = Array.from({ length: 2100 }, (_, i) => ({ id: i, target: role('button', 'Go') }));
    expect(health(items)).toHaveLength(2000);
  });

  it('turns an unexpected exception for one item into an error result for that item only', () => {
    document.body.innerHTML = '<button>Go</button>';
    const evil = {
      get target() {
        throw new Error('getter exploded');
      },
      id: 'evil',
    };
    const out = health([evil, { id: 'fine', target: role('button', 'Go') }]);
    expect(out[0]).toEqual({ id: 'evil', owned: true, count: 0, status: 'error', error: 'getter exploded' });
    expect(out[1]).toMatchObject({ id: 'fine', status: 'ok' });
  });

  it('a torn-down instance answers null, and its global is removed', () => {
    const fn = globalThis.__LocatraHealthCheck;
    // A fresh injection over a dead context tears the previous instance down.
    load();
    expect(globalThis.__LocatraHealthCheck).not.toBe(fn);
    expect(fn([{ id: 1, target: role('button', 'x') }])).toBeNull();
    expect(typeof globalThis.__LocatraHealthCheck).toBe('function');
  });
});

describe('__LocatraHealthCheck — heal suggestions from the fingerprint', () => {
  it('suggests the engine’s best unique locator for the element the fingerprint describes', () => {
    document.body.innerHTML =
      '<form><label for="em">Email address</label><input id="em" name="email" type="email"></form>' +
      '<input id="other" name="other" type="email">';
    const target = { kind: 'testid', attr: 'data-testid', value: 'email-input' }; // the attribute was removed
    const fingerprint = {
      tag: 'input',
      id: 'em',
      testId: 'email-input',
      testAttr: 'data-testid',
      role: 'textbox',
      name: 'email',
      label: 'Email address',
      placeholder: null,
      text: null,
      type: 'email',
      href: null,
      alt: null,
      title: null,
      classes: [],
    };
    const [res] = health([{ id: 'w1', target, fingerprint }]);
    expect(res).toMatchObject({ id: 'w1', owned: true, count: 0, status: 'broken' });
    expect(res.suggestion).toBeDefined();
    const nodes = E().resolveTarget(res.suggestion.target);
    expect(nodes).toEqual([document.getElementById('em')]);
    expect(res.suggestion.target).toMatchObject({ unique: true, matchCount: 1 });
    expect(res.suggestion.code).toBe(
      LLCodegen.locatorExpr(res.suggestion.target, 'playwright', 'typescript')
    );
    expect(res.suggestion.code).toMatch(/^page\./);
  });

  it('heals a renamed button found by id even though its text changed', () => {
    document.body.innerHTML = '<button id="login">Log in</button><button id="help">Help</button>';
    const [res] = health([
      {
        id: 'b',
        target: role('button', 'Sign in'),
        fingerprint: {
          tag: 'button',
          id: 'login',
          role: 'button',
          label: 'Sign in',
          text: 'Sign in',
          classes: [],
        },
      },
    ]);
    expect(res.status).toBe('broken');
    expect(E().resolveTarget(res.suggestion.target)).toEqual([document.getElementById('login')]);
  });

  it('for an ambiguous locator it picks the fingerprinted element among the matches', () => {
    document.body.innerHTML =
      '<button data-qa="save-draft">Save</button><button data-qa="save-final">Save</button>';
    const [res] = health([
      {
        id: 'a',
        target: role('button', 'Save'),
        fingerprint: {
          tag: 'button',
          testId: 'save-final',
          testAttr: 'data-qa',
          text: 'Save',
          role: 'button',
        },
      },
    ]);
    expect(res).toMatchObject({ count: 2, status: 'ambiguous' });
    expect(res.suggestion.target).toMatchObject({ kind: 'testid', attr: 'data-qa', value: 'save-final' });
  });

  it('makes no suggestion without a clear winner', () => {
    document.body.innerHTML = '<button class="btn">Pay</button><button class="btn">Pay</button>';
    const [res] = health([
      {
        id: 'tie',
        target: { kind: 'testid', attr: 'data-testid', value: 'pay' },
        fingerprint: { tag: 'button', text: 'Pay', label: 'Pay', role: 'button', classes: ['btn'] },
      },
    ]);
    expect(res).toEqual({ id: 'tie', owned: true, count: 0, status: 'broken' });
  });

  it('makes no suggestion from weak evidence (role and classes alone)', () => {
    document.body.innerHTML = '<button class="btn primary">Totally different</button>';
    const [res] = health([
      {
        id: 'weak',
        target: role('button', 'Pay'),
        fingerprint: { tag: 'button', role: 'button', classes: ['btn', 'primary'] },
      },
    ]);
    expect(res.suggestion).toBeUndefined();
  });

  it('a different input type counts against a candidate', () => {
    document.body.innerHTML = '<input type="checkbox" name="agree"><input type="text" name="agree-text">';
    const [res] = health([
      {
        id: 't',
        target: { kind: 'name', value: 'gone' },
        fingerprint: { tag: 'input', name: 'agree', type: 'text', classes: [] },
      },
    ]);
    // name matches the checkbox (+6) but the type does not (−4): not enough.
    expect(res.suggestion).toBeUndefined();
  });

  it('scores placeholder, alt, title, href and partial text', () => {
    document.body.innerHTML =
      '<input placeholder="Search products"><img alt="Company logo" src="a.png">' +
      '<a href="/pricing?id_token=zzz" title="Plans">Pricing and plans today</a><a href="/x">Pricing</a>';
    const out = health([
      {
        id: 'ph',
        target: { kind: 'placeholder', value: 'Find' },
        fingerprint: { tag: 'input', placeholder: 'search products' },
      },
      {
        id: 'alt',
        target: { kind: 'altText', value: 'Logo!' },
        fingerprint: { tag: 'img', alt: 'Company logo' },
      },
      {
        id: 'link',
        target: { kind: 'text', value: 'Nope' },
        fingerprint: {
          tag: 'a',
          href: '/pricing?id_token=REDACTED',
          title: 'Plans',
          text: 'Pricing and plans',
        },
      },
    ]);
    expect(E().resolveTarget(out[0].suggestion.target)).toEqual([document.querySelector('input')]);
    expect(E().resolveTarget(out[1].suggestion.target)).toEqual([document.querySelector('img')]);
    expect(E().resolveTarget(out[2].suggestion.target)).toEqual([document.querySelector('a')]);
  });

  it('ignores a malformed fingerprint', () => {
    document.body.innerHTML = '<button id="x">X</button>';
    const out = health([
      { id: 1, target: role('button', 'Y'), fingerprint: 'button#x' },
      { id: 2, target: role('button', 'Y'), fingerprint: { tag: 'button) , *', id: 'x' } },
      { id: 3, target: role('button', 'Y'), fingerprint: { id: 'x' } },
    ]);
    out.forEach((r) => expect(r).toEqual({ id: r.id, owned: true, count: 0, status: 'broken' }));
  });

  it('skips an element no unique locator can address', () => {
    document.body.innerHTML = '<span class="tag">x</span><span class="tag">x</span>';
    const [res] = health([
      {
        id: 's',
        target: { kind: 'css', value: '#gone' },
        // Only the first span carries a title in the fingerprint; it is identical to its twin otherwise.
        fingerprint: { tag: 'span', text: 'x', title: 'only-me', classes: ['tag'] },
      },
    ]);
    expect(res.suggestion).toBeUndefined();
  });

  it('the top-level fallbacks work without codegen loaded (code from the engine)', () => {
    document.body.innerHTML = '<button id="pay">Pay</button>';
    const saved = window.LLCodegen;
    delete window.LLCodegen;
    try {
      const [res] = health([
        { id: 1, target: role('button', 'Gone'), fingerprint: { tag: 'button', id: 'pay', text: 'Pay' } },
      ]);
      expect(res.suggestion.code).toMatch(/^page\./);
    } finally {
      window.LLCodegen = saved;
    }
  });

  it('a throwing engine means no suggestion, not a failed check', () => {
    document.body.innerHTML = '<button id="pay">Pay</button>';
    vi.spyOn(E(), 'generateLocators').mockImplementation(() => {
      throw new Error('engine down');
    });
    const [res] = health([
      { id: 1, target: role('button', 'Gone'), fingerprint: { tag: 'button', id: 'pay', text: 'Pay' } },
    ]);
    expect(res).toEqual({ id: 1, owned: true, count: 0, status: 'broken' });
  });

  it('a throwing candidate query means no suggestion', () => {
    document.body.innerHTML = '<button id="pay">Pay</button>';
    vi.spyOn(E(), 'deepQueryAll').mockImplementation(() => {
      throw new Error('query down');
    });
    const [res] = health([
      { id: 1, target: role('button', 'Gone'), fingerprint: { tag: 'button', id: 'pay' } },
    ]);
    expect(res.suggestion).toBeUndefined();
  });
});

describe('__LocatraHealthCheck — frames', () => {
  it('only the frame on the target’s frame path owns it; the suggestion keeps the original frame wrapping', () => {
    document.body.innerHTML = '<iframe id="pay" name="card"></iframe><iframe id="other"></iframe>';
    const pay = loadIntoFrame(document.getElementById('pay'));
    const other = loadIntoFrame(document.getElementById('other'));
    pay.document.body.innerHTML = '<button id="submit-pay">Pay now</button>';
    other.document.body.innerHTML = '<button>Pay now</button>';

    const items = [
      {
        id: 'f',
        // Recorded with a selector that differs textually but still addresses #pay,
        // plus a shadowPath the suggestion must carry over.
        target: {
          kind: 'frame',
          selector: 'iframe[name="card"]',
          index: 0,
          shadowPath: ['x-host', 'iframe'],
          child: role('button', 'Pay later'),
        },
        fingerprint: { tag: 'button', id: 'submit-pay', text: 'Pay now', role: 'button' },
      },
      { id: 'top', target: role('button', 'Pay now') },
    ];

    expect(health(items)).toEqual([
      { id: 'f', owned: false, count: 0, status: 'frame-missing' },
      { id: 'top', owned: true, count: 0, status: 'broken' },
    ]);
    expect(other.__LocatraHealthCheck(items)[0]).toEqual({
      id: 'f',
      owned: false,
      count: 0,
      status: 'frame-missing',
    });

    const [mine, notMine] = pay.__LocatraHealthCheck(items);
    expect(notMine).toEqual({ id: 'top', owned: false, count: 0, status: 'frame-missing' });
    expect(mine).toMatchObject({ id: 'f', owned: true, count: 0, status: 'broken' });
    const s = mine.suggestion.target;
    expect(s).toMatchObject({
      kind: 'frame',
      selector: 'iframe[name="card"]',
      index: 0,
      shadowPath: ['x-host', 'iframe'],
    });
    expect(Object.keys(s).sort()).toEqual(['child', 'index', 'kind', 'selector', 'shadowPath']);
    expect(pay.__LocatorLensEngine.resolveTarget(s.child)).toEqual([
      pay.document.getElementById('submit-pay'),
    ]);
    expect(mine.suggestion.code).toBe(
      "page.frameLocator('iframe[name=\"card\"]').getByRole('button', { name: 'Pay now' })"
    );
  });

  it('an ok frame target is counted inside its frame', () => {
    document.body.innerHTML = '<iframe id="f"></iframe>';
    const w = loadIntoFrame(document.getElementById('f'));
    w.document.body.innerHTML = '<a href="/x">Docs</a>';
    const items = [
      { id: 1, target: { kind: 'frame', selector: '#f', index: 0, child: role('link', 'Docs') } },
    ];
    expect(w.__LocatraHealthCheck(items)).toEqual([{ id: 1, owned: true, count: 1, status: 'ok' }]);
  });

  it('a cross-origin path (no selector) is owned by position; a frame wrapper without a child is an error', () => {
    document.body.innerHTML = '<iframe></iframe><iframe></iframe>';
    const second = loadIntoFrame(document.querySelectorAll('iframe')[1]);
    second.document.body.innerHTML = '<button>Ok</button>';
    const out = second.__LocatraHealthCheck([
      { id: 'pos', target: { kind: 'frame', selector: null, index: 1, child: role('button', 'Ok') } },
      { id: 'wrong', target: { kind: 'frame', selector: null, index: 0, child: role('button', 'Ok') } },
      { id: 'empty', target: { kind: 'frame', selector: null, index: 1 } },
    ]);
    expect(out[0]).toEqual({ id: 'pos', owned: true, count: 1, status: 'ok' });
    expect(out[1]).toEqual({ id: 'wrong', owned: false, count: 0, status: 'frame-missing' });
    expect(out[2]).toEqual({
      id: 'empty',
      owned: true,
      count: 0,
      status: 'error',
      error: 'the watched locator has no target inside its frame',
    });
  });

  it('a nested path suggestion is wrapped at every level', () => {
    document.body.innerHTML = '<iframe id="outer"></iframe>';
    const outer = loadIntoFrame(document.getElementById('outer'));
    outer.document.body.innerHTML = '<iframe id="inner"></iframe>';
    const inner = loadIntoFrame(outer.document.getElementById('inner'));
    inner.document.body.innerHTML = '<button id="go">Go!</button>';
    const target = {
      kind: 'frame',
      selector: '#outer',
      index: 0,
      child: { kind: 'frame', selector: '#inner', index: 0, child: role('button', 'Stop') },
    };
    const fingerprint = { tag: 'button', id: 'go', text: 'Go!' };
    expect(outer.__LocatraHealthCheck([{ id: 1, target, fingerprint }])[0].owned).toBe(false);
    const [res] = inner.__LocatraHealthCheck([{ id: 1, target, fingerprint }]);
    expect(res.status).toBe('broken');
    expect(res.suggestion.target).toMatchObject({
      kind: 'frame',
      selector: '#outer',
      child: { kind: 'frame', selector: '#inner', child: { kind: expect.any(String) } },
    });
    expect(res.suggestion.target.child.child.kind).not.toBe('frame');
  });
});

describe('__LocatraHealthCheck — 2 s budget', () => {
  it('stops checking once the budget is spent and reports the rest as errors', () => {
    document.body.innerHTML = '<button>Go</button>';
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const items = [
      { id: 1, target: role('button', 'Go') },
      { id: 2, target: role('button', 'Go') },
      { id: 3, target: { kind: 'frame', selector: '#f', index: 0, child: role('button', 'Go') } },
    ];
    const spy = vi.spyOn(E(), 'resolveTarget').mockImplementation((...args) => {
      now += 2500; // the first resolve eats the whole budget
      spy.mockRestore();
      return E().resolveTarget(...args);
    });
    const out = health(items);
    expect(out[0]).toMatchObject({ id: 1, status: 'ok' });
    expect(out[1]).toEqual({
      id: 2,
      owned: true,
      count: 0,
      status: 'error',
      error: 'the health check ran out of time',
    });
    // Ownership is still answered: BACKGROUND must not mistake it for this frame's.
    expect(out[2]).toEqual({ id: 3, owned: false, count: 0, status: 'frame-missing' });
  });

  it('abandons a heal search that runs past the budget (the count still stands)', () => {
    document.body.innerHTML = '<button id="a">A</button><button id="b">B</button>';
    let now = 5_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const realQuery = E().deepQueryAll;
    vi.spyOn(E(), 'deepQueryAll').mockImplementation((...args) => {
      now += 3000;
      return realQuery(...args);
    });
    const [res] = health([
      { id: 1, target: role('button', 'Gone'), fingerprint: { tag: 'button', id: 'a' } },
    ]);
    expect(res).toEqual({ id: 1, owned: true, count: 0, status: 'broken' });
  });

  it('skips the suggestion when the winner is found exactly at the deadline edge', () => {
    document.body.innerHTML = '<button id="a">A</button>';
    let now = 5_000;
    let calls = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      calls++;
      return now;
    });
    const real = E().deepQueryAll;
    vi.spyOn(E(), 'deepQueryAll').mockImplementation((...args) => {
      const r = real(...args);
      return new Proxy(r, {
        get(t, p) {
          // Iterating the last candidate: jump past the deadline before the suggestion is built.
          if (p === Symbol.iterator) {
            return function* () {
              for (const x of t) yield x;
              now += 10_000;
            };
          }
          return Reflect.get(t, p);
        },
      });
    });
    const [res] = health([
      { id: 1, target: role('button', 'Gone'), fingerprint: { tag: 'button', id: 'a' } },
    ]);
    expect(calls).toBeGreaterThan(0);
    expect(res.suggestion).toBeUndefined();
  });

  it('every count is reported first; heals then share what is left of the budget (fake clock)', () => {
    const rows = Array.from({ length: 300 }, (_, i) => `<button data-qa="b${i}">Item ${i}</button>`).join('');
    document.body.innerHTML = rows;
    // Deterministic clock: every Date.now() call costs 5 ms, so scanning the 300
    // candidates once (one call each) uses 1.5 s of the 2 s budget.
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 5));
    const items = Array.from({ length: 10 }, (_, i) => ({
      id: i,
      target: { kind: 'testid', attr: 'data-qa', value: `missing-${i}` },
      fingerprint: { tag: 'button', testId: `b${i * 7}`, testAttr: 'data-qa', text: `Item ${i * 7}` },
    }));
    const out = health(items);
    expect(out.map((r) => [r.status, r.count])).toEqual(items.map(() => ['broken', 0]));
    // The first heal fits; the second runs out of time; the rest are not attempted.
    expect(E().resolveTarget(out[0].suggestion.target)).toEqual([document.querySelector('[data-qa="b0"]')]);
    expect(out.slice(1).filter((r) => r.suggestion)).toEqual([]);
  });
});
