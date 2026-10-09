// @vitest-environment jsdom
//
// Broader coverage of content.js paths the main suite does not reach: Selector Lab
// locator kinds, the stress test's fallback counter, settings from storage, the
// recorder's fallbacks and modifiers, inspect positioning and traversal edges,
// toasts and clipboard, frames that cannot be read, and the instance lifecycle.

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

function load({ storage = {}, ready, keepPrevious = false, scripts = CONTENT_SCRIPTS } = {}) {
  if (!keepPrevious) stopAll();
  if (globalThis.chrome && globalThis.chrome.runtime) delete globalThis.chrome.runtime.id;
  handlers = [];
  sent = [];
  storageListeners = [];
  globalThis.__LocatraTrustSyntheticEvents = true;
  globalThis.chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      sendMessage: (msg, cb) => {
        sent.push(msg);
        if (msg && msg.type === 'CONTENT_READY' && ready !== undefined && cb) cb(ready);
      },
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
  for (const file of scripts) {
    vm.runInThisContext(readFileSync(join(ROOT, file), 'utf8'), { filename: file });
  }
}

function send(msg) {
  let response;
  for (const h of handlers) h(msg, {}, (r) => (response = r));
  return response;
}

const recorded = () => sent.filter((m) => m.type === 'RECORDED_ACTION').map((m) => m.data);
const picks = () => sent.filter((m) => m.type === 'ELEMENT_PICKED').map((m) => m.data);
const tick = () => new Promise((r) => setTimeout(r, 0));
const pointAt = (el) => (document.elementFromPoint = () => el);
function pointer(el, init = {}) {
  el.dispatchEvent(
    new window.PointerEvent('pointerdown', {
      bubbles: true,
      composed: true,
      button: 0,
      isPrimary: true,
      ...init,
    })
  );
}
function key(el, k, init = {}) {
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, composed: true, ...init }));
}
function rect(el, r) {
  el.getBoundingClientRect = () => ({
    left: r.x,
    top: r.y,
    x: r.x,
    y: r.y,
    width: r.w,
    height: r.h,
    right: r.x + r.w,
    bottom: r.y + r.h,
  });
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.body.className = '';
  delete document.elementFromPoint;
  load();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Selector Lab locator kinds', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <label for="email">Email</label><input id="email">
      <button data-testid="buy">Buy</button>
      <span title="Close dialog">x</span>
      <img alt="Company logo" src="logo.png">
      <p>Hello <b>world</b></p>
      <div aria-hidden="true"><p>Hello hidden</p></div>
      <ul><li>One</li><li>Two</li><li>Three</li></ul>`;
  });
  const count = (selector) => send({ type: 'LAB_VALIDATE', selector }).count;

  it('resolves getByLabel, getByTestId, getByTitle and getByAltText', () => {
    expect(count("page.getByLabel('Email')")).toBe(1);
    expect(count("page.getByLabel('Emai', { exact: true })")).toBe(0);
    expect(count("page.getByTestId('buy')")).toBe(1);
    expect(count("page.getByTitle('close')")).toBe(1);
    expect(count("page.getByAltText('Company logo', { exact: true })")).toBe(1);
  });

  it('getByText keeps the innermost visible match', () => {
    expect(count("page.getByText('world')")).toBe(1);
    const res = send({ type: 'LAB_VALIDATE', selector: "page.getByText('Hello')" });
    expect(res.count).toBe(1);
    expect(document.querySelector('p').hasAttribute('data-locatra-lab')).toBe(true);
  });

  it('reducers: last(), nth(), filter({ hasText })', () => {
    expect(count("page.locator('li').last()")).toBe(1);
    expect(document.querySelectorAll('li')[2].hasAttribute('data-locatra-lab')).toBe(true);
    expect(count("page.locator('li').nth(1)")).toBe(1);
    expect(document.querySelectorAll('li')[1].hasAttribute('data-locatra-lab')).toBe(true);
    expect(count("page.locator('li').nth(9)")).toBe(0);
    expect(count("page.locator('li').filter({ hasText: 'Thr' })")).toBe(1);
  });

  it('locator() accepts xpath= and // expressions, and css= prefixes', () => {
    expect(count("page.locator('xpath=//li')")).toBe(3);
    expect(count("page.locator('//li[2]')")).toBe(1);
    expect(count("page.locator('css=ul > li')")).toBe(3);
    expect(count("page.locator('[[bad')")).toBe(0);
  });

  it('unknown chain methods are ignored; a chain with no locator falls back to CSS', () => {
    expect(count("page.getByRole('listitem').click()")).toBe(3);
    expect(count("page.frameLocator('#f').getByRole('button')")).toBe(1);
    expect(send({ type: 'LAB_VALIDATE', selector: 'page.getByRole()' }).count).toBe(0);
  });

  it('reports truncated when a chain exceeds the scan budget', () => {
    document.body.innerHTML = Array.from({ length: 300 }, () => '<div><span>a</span></div>').join('');
    const E = globalThis.__LocatorLensEngine;
    const deep = E.deepQueryAll;
    E.deepQueryAll = (sel, root) => {
      const r = deep(sel, root, Infinity) || [];
      return r.concat(new Array(200000).fill(r[0]));
    };
    const res = send({ type: 'LAB_VALIDATE', selector: "page.locator('div').locator('span')" });
    expect(res.truncated).toBe(true);
    expect(sent.find((m) => m.type === 'LAB_STATUS_UPDATE').truncated).toBe(true);
  });

  it('works without the engine’s deepQueryAll', () => {
    delete globalThis.__LocatorLensEngine.deepQueryAll;
    expect(count('li')).toBe(3);
    expect(count("page.locator('li')")).toBe(3);
  });
});

describe('stress test fallbacks', () => {
  function pick(el) {
    pointAt(el);
    el.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
  }

  it('counts role + name itself when the engine has no countTargetMatches', () => {
    delete globalThis.__LocatorLensEngine.countTargetMatches;
    document.body.innerHTML = '<button id="a">Save</button><button>Save draft</button><button>Other</button>';
    pick(document.getElementById('a'));
    // "Save" is a substring of "Save draft", but exactly one is named "Save".
    expect(send({ type: 'RUN_STRESS_TEST' }).data).toMatchObject({ survived: true, name: 'Save' });
    document.body.innerHTML = '<button id="b">Dup</button><button>Dup</button>';
    pick(document.getElementById('b'));
    expect(send({ type: 'RUN_STRESS_TEST' }).data).toMatchObject({ survived: false });
  });

  it('an exact-name twin-free locator survives even when the loose name is shared', () => {
    document.body.innerHTML = '<button id="a">Save</button><button>Save draft</button>';
    pick(document.getElementById('a'));
    expect(send({ type: 'RUN_STRESS_TEST' }).data).toMatchObject({ survived: true });
  });

  it('reports unavailable when the engine is missing', () => {
    delete globalThis.__LocatorLensEngine;
    expect(send({ type: 'RUN_STRESS_TEST' }).data).toEqual({ survived: false, unavailable: true });
  });

  it('an element without a role or name does not survive', () => {
    document.body.innerHTML = '<div id="plain"></div>';
    pick(document.getElementById('plain'));
    expect(send({ type: 'RUN_STRESS_TEST' }).data).toMatchObject({ survived: false });
  });
});

describe('settings from storage', () => {
  it('custom test attributes from storage, and from storage.onChanged, drive the locators', () => {
    load({ storage: { customAttributes: ['data-hook'], llFramework: 'cypress', llLanguage: 'javascript' } });
    document.body.innerHTML = '<button data-hook="pay">Pay</button>';
    send({ type: 'START_INSPECT' });
    const btn = document.querySelector('button');
    pointAt(btn);
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(picks()[0].locators[0].target).toMatchObject({ kind: 'testid', attr: 'data-hook', value: 'pay' });
    send({ type: 'STOP_INSPECT' });

    storageListeners.forEach((fn) =>
      fn(
        {
          customAttributes: { newValue: ['data-other'] },
          llFramework: { newValue: undefined },
          llLanguage: { newValue: undefined },
        },
        'local'
      )
    );
    document.body.innerHTML = '<button data-other="x">X</button>';
    sent.length = 0;
    send({ type: 'START_INSPECT' });
    const x = document.querySelector('button');
    pointAt(x);
    x.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(picks()[0].locators[0].target).toMatchObject({ attr: 'data-other' });
    storageListeners.forEach((fn) => fn({ customAttributes: { newValue: undefined } }, 'local'));
  });

  it('the quick-copy toast uses the panel’s framework', async () => {
    load({ storage: { llFramework: 'cypress', llLanguage: 'javascript' } });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });
    try {
      document.body.innerHTML = '<button id="go">Go</button>';
      send({ type: 'START_INSPECT' });
      const go = document.getElementById('go');
      pointAt(go);
      go.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await tick();
      expect(document.querySelector('#ll-toast .ll-toast-code').textContent).toMatch(/^cy\./);
    } finally {
      delete navigator.clipboard;
    }
  });

  it('a storage read error leaves the defaults', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    stopAll();
    delete chrome.runtime.id;
    globalThis.chrome = {
      ...chrome,
      runtime: { ...chrome.runtime, id: 'test-extension-id', lastError: { message: 'read failed' } },
      storage: {
        local: { get: (keys, cb) => cb({ llDebug: true }) },
        onChanged: { addListener: () => {}, removeListener: () => {} },
      },
    };
    handlers = [];
    chrome.runtime.onMessage = {
      addListener: (fn) => handlers.push(fn) && allHandlers.push(fn),
      removeListener() {},
    };
    delete globalThis.__LocatorLensEngine;
    for (const file of CONTENT_SCRIPTS)
      vm.runInThisContext(readFileSync(join(ROOT, file), 'utf8'), { filename: file });
    chrome.runtime.lastError = null;
    // The failed read never turned debug logging on.
    send({ type: 'START_RECORDING' });
    send({ type: 'STOP_RECORDING' });
    expect(log).not.toHaveBeenCalled();
  });
});

describe('debug logging', () => {
  it('logs and warns only when llDebug is on', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    load({ storage: { llDebug: true } });
    send({ type: 'START_RECORDING' });
    send({ type: 'STOP_RECORDING' });
    expect(log.mock.calls.some((c) => c[0] === '[Locatra]')).toBe(true);
    // A failing generateLocators during recording is reported through debugWarn.
    globalThis.__LocatorLensEngine.generateLocators = () => {
      throw new Error('engine down');
    };
    document.body.innerHTML = '<button id="b">B</button>';
    send({ type: 'START_RECORDING' });
    pointer(document.getElementById('b'));
    expect(warn.mock.calls.some((c) => c[0] === '[Locatra]')).toBe(true);
    storageListeners.forEach((fn) => fn({ llDebug: { newValue: false } }, 'local'));
    send({ type: 'STOP_RECORDING' });
  });
});

describe('recorder fallbacks and details', () => {
  function breakEngine() {
    globalThis.__LocatorLensEngine.generateLocators = () => {
      throw new Error('engine down');
    };
  }

  it('falls back to #id / tag locators when the engine fails', async () => {
    vi.useFakeTimers();
    breakEngine();
    document.body.innerHTML =
      '<button id="go">Go</button><span>s</span><input id="q"><select id="s"><option>One</option></select><input type="checkbox" id="c">';
    send({ type: 'START_RECORDING' });
    sent.length = 0;
    pointer(document.getElementById('go'));
    pointer(document.querySelector('span'));
    const q = document.getElementById('q');
    pointer(q);
    q.value = "it's";
    q.dispatchEvent(new window.Event('input', { bubbles: true }));
    vi.advanceTimersByTime(500);
    document.getElementById('s').dispatchEvent(new window.Event('change', { bubbles: true }));
    const c = document.getElementById('c');
    c.dispatchEvent(new window.Event('change', { bubbles: true }));
    c.checked = true;
    c.dispatchEvent(new window.Event('change', { bubbles: true }));

    const steps = recorded();
    expect(steps.map((s) => [s.action, s.fullCode])).toEqual([
      ['click', "await page.locator('#go').click();"],
      ['click', "await page.locator('span').first().click();"],
      ['click', "await page.locator('#q').click();"],
      ['fill', "await page.locator('#q').fill('it\\'s');"],
      ['selectOption', "await page.locator('#s').selectOption('One');"],
      ['uncheck', "await page.locator('#c').uncheck();"],
      ['check', "await page.locator('#c').check();"],
    ]);
    send({ type: 'STOP_RECORDING' });
  });

  it('records hover (Alt+Click) and the assertion types', () => {
    document.body.innerHTML = `
      <a href="#" id="menu">Menu</a>
      <input id="v" value="42" aria-label="Amount">
      <button id="e">Enabled</button>
      <label id="lbl"><input type="checkbox" id="cb" checked> Agree</label>
      <div role="checkbox" aria-checked="true"><span id="inner">Fancy</span></div>`;
    send({ type: 'START_RECORDING' });
    sent.length = 0;
    pointer(document.getElementById('menu'), { altKey: true });
    const assert = (type, el) => {
      send({ type: 'SET_ASSERT_MODE', on: true, assertType: type });
      pointer(el);
    };
    assert('toHaveValue', document.getElementById('v'));
    assert('toBeEnabled', document.getElementById('e'));
    assert('toBeChecked', document.getElementById('lbl'));
    assert('toBeChecked', document.getElementById('inner'));
    assert('toContainText', document.getElementById('menu'));
    send({ type: 'SET_ASSERT_MODE', on: false });

    const steps = recorded();
    expect(steps[0]).toMatchObject({ action: 'hover', fullCode: expect.stringMatching(/\.hover\(\);$/) });
    expect(steps.slice(1).map((s) => [s.assertType, s.value])).toEqual([
      ['toHaveValue', '42'],
      ['toBeEnabled', ''],
      ['toBeChecked', 'true'],
      ['toBeChecked', 'true'],
      ['toContainText', 'Menu'],
    ]);
    expect(steps[1].fullCode).toMatch(/toHaveValue\("42"\);$/);
    expect(steps[2].fullCode).toMatch(/toBeEnabled\(\);$/);
    expect(steps[3].target).toMatchObject({ kind: expect.any(String) });
    send({ type: 'STOP_RECORDING' });
  });

  it('records Control/Alt/Meta modifiers and ignores non-primary pointers and other buttons', () => {
    document.body.innerHTML = '<button id="b">B</button><input id="i" aria-label="I">';
    send({ type: 'START_RECORDING' });
    sent.length = 0;
    const b = document.getElementById('b');
    pointer(b, { button: 2 });
    pointer(b, { isPrimary: false });
    key(document.getElementById('i'), 'Enter', { ctrlKey: true, altKey: true, metaKey: true });
    key(document.getElementById('i'), 'a');
    expect(recorded().map((s) => [s.action, s.value])).toEqual([['press', 'Control+Alt+Meta+Enter']]);
    send({ type: 'STOP_RECORDING' });
  });

  it('a select’s Space and a role=button Space are handled correctly', () => {
    document.body.innerHTML =
      '<select id="s" aria-label="S"><option>a</option></select><div role="button" id="rb" tabindex="0">RB</div><div id="plain" tabindex="0">P</div>';
    send({ type: 'START_RECORDING' });
    sent.length = 0;
    key(document.getElementById('s'), ' ');
    key(document.getElementById('plain'), ' ');
    key(document.getElementById('rb'), ' ');
    expect(recorded().map((s) => s.value)).toEqual([' ']);
    send({ type: 'STOP_RECORDING' });
  });

  it('records a contenteditable fill with its text', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="ed" contenteditable="true" aria-label="Notes"></div>';
    const ed = document.getElementById('ed');
    Object.defineProperty(ed, 'isContentEditable', { value: true });
    send({ type: 'START_RECORDING' });
    sent.length = 0;
    ed.textContent = 'Line one';
    ed.dispatchEvent(new window.Event('input', { bubbles: true }));
    vi.advanceTimersByTime(500);
    expect(recorded().map((s) => [s.action, s.value])).toEqual([['fill', 'Line one']]);
    send({ type: 'STOP_RECORDING' });
  });

  it('a native change with the value already recorded is not recorded twice', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<input id="q" aria-label="Q">';
    const q = document.getElementById('q');
    send({ type: 'START_RECORDING' });
    sent.length = 0;
    q.value = 'abc';
    q.dispatchEvent(new window.Event('input', { bubbles: true }));
    vi.advanceTimersByTime(500);
    q.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(recorded().filter((s) => s.action === 'fill')).toHaveLength(1);
    send({ type: 'STOP_RECORDING' });
  });

  it('a visibility change to hidden flushes; visible does not', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<input id="q" aria-label="Q">';
    const q = document.getElementById('q');
    send({ type: 'START_RECORDING' });
    sent.length = 0;
    q.value = 'x';
    q.dispatchEvent(new window.Event('input', { bubbles: true }));
    document.dispatchEvent(new window.Event('visibilitychange'));
    expect(recorded()).toEqual([]); // still visible: the debounce keeps running
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      document.dispatchEvent(new window.Event('visibilitychange'));
      expect(recorded().map((s) => s.action)).toEqual(['fill']);
    } finally {
      delete document.visibilityState;
    }
    send({ type: 'STOP_RECORDING' });
  });

  it('keeps only the last few clicks for dblclick supersedes', () => {
    document.body.innerHTML = '<button id="b">B</button>';
    send({ type: 'START_RECORDING' });
    sent.length = 0;
    const b = document.getElementById('b');
    for (let i = 0; i < 6; i++) pointer(b);
    b.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    const clicks = recorded().filter((s) => s.action === 'click');
    const dbl = recorded().find((s) => s.action === 'dblclick');
    expect(dbl.supersedes).toEqual([clicks[4].eventId, clicks[5].eventId]);
    send({ type: 'STOP_RECORDING' });
  });

  it('never records a click on its own overlay; ignores an untrusted dblclick or keydown', () => {
    document.body.innerHTML = '<button id="b">B</button>';
    send({ type: 'START_RECORDING' });
    send({ type: 'START_INSPECT' });
    send({ type: 'STOP_INSPECT' });
    sent.length = 0;
    globalThis.__LocatraTrustSyntheticEvents = false;
    try {
      const b = document.getElementById('b');
      b.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
      key(b, 'Enter');
      pointer(b);
    } finally {
      globalThis.__LocatraTrustSyntheticEvents = true;
    }
    expect(recorded()).toEqual([]);
    send({ type: 'STOP_RECORDING' });
  });

  it('falls back to mousedown capture where PointerEvent does not exist', () => {
    const PE = window.PointerEvent;
    delete window.PointerEvent;
    try {
      load();
      document.body.innerHTML = '<button id="b">B</button>';
      send({ type: 'START_RECORDING' });
      sent.length = 0;
      document
        .getElementById('b')
        .dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
      expect(recorded().map((s) => s.action)).toEqual(['click']);
      send({ type: 'STOP_RECORDING' });
    } finally {
      window.PointerEvent = PE;
    }
  });

  it('generates event ids without crypto.randomUUID', () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
    try {
      document.body.innerHTML = '<button id="b">B</button>';
      send({ type: 'START_RECORDING' });
      const ids = recorded().map((s) => s.eventId);
      expect(ids.every((id) => /^[0-9a-z]+-[0-9a-z]+$/.test(id))).toBe(true);
      send({ type: 'STOP_RECORDING' });
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: original });
    }
  });
});

describe('inspect overlay positioning and traversal', () => {
  it('flips the tooltip above an element near the bottom and keeps it inside the right edge', () => {
    document.body.innerHTML = '<button id="b">B</button>';
    const b = document.getElementById('b');
    rect(b, { x: window.innerWidth - 50, y: window.innerHeight - 30, w: 40, h: 20 });
    send({ type: 'START_INSPECT' });
    pointAt(b);
    b.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    const tip = document.getElementById('ll-tooltip');
    expect(parseFloat(tip.style.top)).toBeLessThan(window.innerHeight - 30);
    expect(parseFloat(tip.style.left)).toBeLessThanOrEqual(window.innerWidth - 300);
    const bar = document.getElementById('ll-traversal-bar');
    expect(parseFloat(bar.style.top)).toBeLessThan(window.innerHeight - 30);
    send({ type: 'STOP_INSPECT' });
  });

  it('moves the tooltip above the element when the bar covers it and there is no room below', () => {
    document.body.innerHTML = '<button id="b">B</button>';
    const b = document.getElementById('b');
    rect(b, { x: 300, y: window.innerHeight - 110, w: 200, h: 30 });
    send({ type: 'START_INSPECT' });
    pointAt(b);
    b.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    const tip = document.getElementById('ll-tooltip');
    expect(parseFloat(tip.style.top)).toBeLessThan(window.innerHeight - 110);
    send({ type: 'STOP_INSPECT' });
  });

  it('▲ crosses a shadow boundary to the host; ▼ button and slot traversal', () => {
    document.body.innerHTML = '<div id="outer"><x-card id="host"><b id="slotted">Slotted</b></x-card></div>';
    const host = document.getElementById('host');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<span id="inner">Inner</span><slot></slot>';
    send({ type: 'START_INSPECT' });
    const inner = root.getElementById('inner');
    pointAt(inner);
    inner.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, composed: true }));
    key(document.body, 'ArrowUp');
    expect(document.getElementById('ll-tooltip').textContent).toContain('<x-card#host>');
    document.getElementById('ll-trav-child').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(document.getElementById('ll-tooltip').textContent).toContain('<span#inner>');
    // ▼ on a leaf, ▲ to the top: nothing changes past <body>.
    key(document.body, 'ArrowDown');
    key(document.body, 'ArrowUp');
    key(document.body, 'ArrowUp');
    key(document.body, 'ArrowUp');
    key(document.body, 'ArrowUp');
    expect(document.getElementById('ll-tooltip').textContent).toContain('<div#outer>');
    send({ type: 'STOP_INSPECT' });
  });

  it('a right click or a click on its own UI picks nothing; Esc stops inspecting', () => {
    document.body.innerHTML = '<button id="b">B</button>';
    send({ type: 'START_INSPECT' });
    const b = document.getElementById('b');
    pointAt(b);
    b.dispatchEvent(new window.MouseEvent('click', { bubbles: true, button: 2 }));
    pointAt(document.getElementById('ll-overlay'));
    b.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(picks()).toEqual([]);
    key(document.body, 'Escape');
    expect(sent.map((m) => m.type)).toContain('STOP_INSPECT');
    expect(document.getElementById('ll-overlay')).toBeNull();
  });

  it('hit-testing descends into open shadow roots', () => {
    document.body.innerHTML = '<x-btn id="host"></x-btn>';
    const host = document.getElementById('host');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<button>Deep</button>';
    root.elementFromPoint = () => root.querySelector('button');
    send({ type: 'START_INSPECT' });
    pointAt(host);
    host.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(picks()[0].locators[0].code).toContain('Deep');
    send({ type: 'STOP_INSPECT' });
  });

  it('a pick flashes the overlay and restores it', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="b">B</button>';
    send({ type: 'START_INSPECT' });
    const b = document.getElementById('b');
    pointAt(b);
    b.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(document.getElementById('ll-overlay').style.background).toContain('0.25');
    vi.advanceTimersByTime(350);
    expect(document.getElementById('ll-overlay').style.background).toContain('0.05');
    send({ type: 'STOP_INSPECT' });
  });

  it('a page without a body is not inspected', () => {
    const body = document.body;
    body.remove();
    try {
      send({ type: 'START_INSPECT' });
      expect(document.getElementById('ll-overlay')).toBeNull();
    } finally {
      document.documentElement.appendChild(body);
    }
  });
});

describe('toasts, clipboard and context-menu copy', () => {
  it('the toast fades out after 3 s and is removed', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="b">B</button>';
    const b = document.getElementById('b');
    pointAt(b);
    b.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
    send({ type: 'CONTEXT_MENU_COPY' });
    return Promise.resolve().then(async () => {
      await vi.advanceTimersByTimeAsync(0);
      const toast = document.getElementById('ll-toast');
      expect(toast).not.toBeNull();
      vi.advanceTimersByTime(3000);
      expect(toast.classList.contains('ll-toast-out')).toBe(true);
      vi.advanceTimersByTime(400);
      expect(document.getElementById('ll-toast')).toBeNull();
    });
  });

  it('the textarea fallback copies and restores the page selection', async () => {
    document.body.innerHTML = '<p id="p">Some text</p><button id="b">Copy me</button>';
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('p'));
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);
    document.execCommand = vi.fn(() => true);
    try {
      const b = document.getElementById('b');
      pointAt(b);
      b.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
      send({ type: 'CONTEXT_MENU_COPY' });
      await tick();
      expect(document.execCommand).toHaveBeenCalledWith('copy');
      expect(document.getSelection().toString()).toBe('Some text');
      expect(document.querySelector('textarea')).toBeNull();
      expect(b.style.outline).toContain('solid');
    } finally {
      delete document.execCommand;
    }
  });

  it('a rejected clipboard write falls back to the textarea', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });
    document.execCommand = () => true;
    try {
      document.body.innerHTML = '<button id="b">B</button>';
      const b = document.getElementById('b');
      pointAt(b);
      b.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
      send({ type: 'CONTEXT_MENU_COPY' });
      await tick();
      await tick();
      expect(b.style.outline).toContain('solid');
    } finally {
      delete navigator.clipboard;
      delete document.execCommand;
    }
  });

  it('a context-menu copy while inspecting also reports the pick to the panel', () => {
    document.body.innerHTML = '<button id="b">B</button>';
    send({ type: 'START_INSPECT' });
    const b = document.getElementById('b');
    pointAt(b);
    b.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
    expect(send({ type: 'CONTEXT_MENU_COPY' })).toEqual({ ok: true });
    expect(picks()).toHaveLength(1);
    expect(picks()[0].pickId).toBeTruthy();
    send({ type: 'STOP_INSPECT' });
  });

  it('a Firefox target that is a text node resolves to its element', () => {
    document.body.innerHTML = '<button id="b">Text</button>';
    globalThis.browser = { menus: { getTargetElement: () => document.getElementById('b').firstChild } };
    try {
      expect(send({ type: 'CONTEXT_MENU_COPY', targetElementId: 7 })).toEqual({ ok: true });
      globalThis.browser.menus.getTargetElement = () => {
        throw new Error('gone');
      };
      expect(send({ type: 'CONTEXT_MENU_COPY', targetElementId: 7 })).toEqual({ noTarget: true });
    } finally {
      delete globalThis.browser;
    }
  });
});

describe('frames that cannot be read', () => {
  function loadIntoFrame(frame) {
    const w = frame.contentWindow;
    const frameHandlers = [];
    const frameSent = [];
    w.__LocatraTrustSyntheticEvents = true;
    w.chrome = {
      runtime: {
        id: 'x',
        lastError: null,
        sendMessage: (m) => frameSent.push(m),
        onMessage: { addListener: (fn) => frameHandlers.push(fn) },
      },
      storage: { local: { get: (k, cb) => cb({}) }, onChanged: { addListener: () => {} } },
    };
    for (const file of CONTENT_SCRIPTS)
      vm.runInContext(readFileSync(join(ROOT, file), 'utf8'), w, { filename: file });
    const frameSend = (msg) => {
      let r;
      for (const h of frameHandlers) h(msg, {}, (x) => (r = x));
      return r;
    };
    return { w, frameSend, frameSent };
  }

  it('a frame whose element cannot be read is addressed by index, with a note', () => {
    document.body.innerHTML = '<iframe></iframe><iframe id="f"></iframe>';
    const { w, frameSend, frameSent } = loadIntoFrame(document.getElementById('f'));
    Object.defineProperty(w, 'frameElement', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    w.document.body.innerHTML = '<button>Pay</button>';
    frameSend({ type: 'START_INSPECT' });
    w.document.querySelector('button').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    const pick = frameSent.find((m) => m.type === 'ELEMENT_PICKED').data;
    expect(pick.locators[0].target).toMatchObject({ kind: 'frame', selector: null, index: 1 });
    expect(pick.proTip).toContain('cross-origin');
    expect(pick.elementData.framePath).toEqual(['iframe (index 1)']);
    frameSend({ type: 'STOP_INSPECT' });
  });

  it('a REPLAY_STEP in a frame whose ancestors cannot be read relies on focus and index', async () => {
    document.body.innerHTML = '<iframe id="f"></iframe>';
    const frame = document.getElementById('f');
    const w = frame.contentWindow;
    const frameHandlers = [];
    w.chrome = {
      runtime: {
        id: 'x',
        lastError: null,
        sendMessage: () => {},
        onMessage: { addListener: (fn) => frameHandlers.push(fn) },
      },
      storage: { local: { get: (k, cb) => cb({}) }, onChanged: { addListener: () => {} } },
    };
    for (const file of CONTENT_SCRIPTS)
      vm.runInContext(readFileSync(join(ROOT, file), 'utf8'), w, { filename: file });
    const replayIn = (step) =>
      new Promise((done) => {
        const returned = frameHandlers.map((h) => h({ type: 'REPLAY_STEP', step, timeoutMs: 100 }, {}, done));
        if (!returned.includes(true)) done('unanswered');
      });
    w.document.body.innerHTML = '<input id="i" aria-label="I">';
    w.document.getElementById('i').focus();
    Object.defineProperty(w, 'frameElement', { configurable: true, get: () => null });

    // Focus cannot be traced through the parent: the frame's own focused field decides.
    expect(await replayIn({ action: 'press', value: 'Escape', target: null })).toEqual({
      ok: true,
      matchCount: 0,
    });
    // A recorded selector cannot be checked against an unreadable frame element: the index decides.
    const inFrame = (index) => ({
      action: 'assert',
      assertType: 'toBeVisible',
      target: { kind: 'frame', selector: '#f', index, child: { kind: 'id', value: 'i' } },
    });
    expect(await replayIn(inFrame(0))).toEqual({ ok: true, matchCount: 1 });
    expect(await replayIn(inFrame(3))).toBe('unanswered');
    // An unfocused cross-origin frame does not claim a press.
    w.document.activeElement.blur();
    expect(await replayIn({ action: 'press', value: 'Escape', target: null })).toBe('unanswered');
  });
});

describe('instance lifecycle', () => {
  it('a prior instance whose liveness probe throws is replaced', () => {
    window.__LocatorLensInstance = {
      isAlive: () => {
        throw new Error('dead');
      },
      teardown: () => {
        throw new Error('also dead');
      },
    };
    load({ keepPrevious: true });
    expect(window.__LocatorLensInstance.isAlive()).toBe(true);
  });

  it('tears itself down when sendMessage throws and the context is gone', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="b">B</button>';
    send({ type: 'START_RECORDING' });
    chrome.runtime.sendMessage = () => {
      throw new Error('Extension context invalidated.');
    };
    delete chrome.runtime.id;
    pointer(document.getElementById('b'));
    vi.advanceTimersByTime(1);
    expect(window.__LocatorLensInstance).toBeUndefined();
    // A torn-down instance ignores every message.
    expect(send({ type: 'PING' })).toBeUndefined();
  });

  it('a CONTENT_READY answer that arrives with lastError set is ignored', () => {
    stopAll();
    delete chrome.runtime.id;
    const runtime = {
      id: 'test-extension-id',
      lastError: null,
      sendMessage: (msg, cb) => {
        sent.push(msg);
        if (msg.type !== 'CONTENT_READY') return;
        runtime.lastError = { message: 'Could not establish connection' };
        cb({ recording: true });
        runtime.lastError = null;
      },
      onMessage: { addListener: (fn) => handlers.push(fn) && allHandlers.push(fn), removeListener() {} },
    };
    globalThis.chrome = { runtime, storage: chrome.storage };
    handlers = [];
    sent = [];
    delete globalThis.__LocatorLensEngine;
    for (const file of CONTENT_SCRIPTS)
      vm.runInThisContext(readFileSync(join(ROOT, file), 'utf8'), { filename: file });
    document.body.innerHTML = '<button id="b">B</button>';
    pointer(document.getElementById('b'));
    expect(recorded()).toEqual([]); // not armed by the failed answer
  });

  it('waits for the body before inspecting when background says the tab is inspected', () => {
    const body = document.body;
    body.remove();
    try {
      load({ ready: { inspecting: true } });
      expect(document.getElementById('ll-overlay')).toBeNull();
      document.documentElement.appendChild(body);
      document.dispatchEvent(new window.Event('DOMContentLoaded'));
      expect(document.getElementById('ll-overlay')).not.toBeNull();
    } finally {
      if (!body.isConnected) document.documentElement.appendChild(body);
      send({ type: 'STOP_INSPECT' });
    }
  });

  it('a malformed CONTENT_READY answer is ignored', () => {
    load({ ready: 'yes' });
    expect(document.getElementById('ll-overlay')).toBeNull();
  });

  it('without the engine, picks carry no locators but nothing throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    load({ scripts: ['src/codegen.js', 'src/content.js'] });
    document.body.innerHTML = '<button id="b">B</button>';
    send({ type: 'START_INSPECT' });
    const b = document.getElementById('b');
    pointAt(b);
    b.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(picks()[0].locators).toEqual([]);
    expect(error).toHaveBeenCalled();
    send({ type: 'STOP_INSPECT' });
  });

  it('a REPLAY_STEP whose step throws while running answers with the error', async () => {
    document.body.innerHTML = '<button>B</button>';
    const step = {
      action: 'press',
      target: null,
      get value() {
        throw new Error('bad step');
      },
    };
    const res = await new Promise((done) => {
      for (const h of handlers) h({ type: 'REPLAY_STEP', step }, {}, done);
    });
    expect(res).toEqual({ ok: false, error: 'bad step', matchCount: 0 });
  });
});
