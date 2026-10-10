// @vitest-environment jsdom
//
// F3 · automatic assertion suggestions (URL changes, feedback after a submit) and
// F4 · the rect/viewport every targeted RECORDED_ACTION carries for step thumbnails.

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

function load({ storage = {}, ready } = {}) {
  for (const h of allHandlers) {
    try {
      h({ type: 'STOP_RECORDING' }, {}, () => {});
      h({ type: 'STOP_INSPECT' }, {}, () => {});
    } catch {
      /* torn down */
    }
  }
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
      },
    },
    storage: {
      local: { get: (keys, cb) => cb(storage) },
      onChanged: { addListener: (fn) => storageListeners.push(fn) },
    },
  };
  delete globalThis.__LocatorLensEngine;
  delete globalThis.LLCodegen;
  for (const file of CONTENT_SCRIPTS) {
    vm.runInThisContext(readFileSync(join(ROOT, file), 'utf8'), { filename: file });
  }
}

function send(msg) {
  let response;
  for (const h of handlers) h(msg, {}, (r) => (response = r));
  return response;
}

const recorded = () => sent.filter((m) => m.type === 'RECORDED_ACTION').map((m) => m.data);
const suggestions = () => recorded().filter((s) => s.suggested);
const advance = (ms) => vi.advanceTimersByTimeAsync(ms);

function pointer(el) {
  el.dispatchEvent(
    new window.PointerEvent('pointerdown', { bubbles: true, composed: true, button: 0, isPrimary: true })
  );
}
function submit(form) {
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

let originalUrl;
beforeEach(() => {
  originalUrl = window.location.href;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});
afterEach(() => {
  for (const h of allHandlers) {
    try {
      h({ type: 'STOP_RECORDING' }, {}, () => {});
    } catch {
      /* torn down */
    }
  }
  vi.useRealTimers();
  window.history.replaceState(null, '', originalUrl);
});

describe('F3 · URL-change suggestions', () => {
  it('suggests toHaveURL once an SPA URL has been stable for 500 ms', async () => {
    load();
    send({ type: 'START_RECORDING' });
    sent.length = 0;
    window.history.pushState(
      null,
      '',
      '/orders/42?token=9f86d081884c7d659a2feaa0c55ad015&access_token=secret'
    );
    await advance(500); // the poll notices the change
    expect(suggestions()).toEqual([]);
    await advance(500); // …and it held still
    const [s] = suggestions();
    expect(s).toMatchObject({
      action: 'assert',
      assertType: 'toHaveURL',
      target: null,
      suggested: true,
      reason: 'Page navigated to /orders/42?token=REDACTED&access_token=REDACTED',
    });
    expect(s.value).toMatch(/\/orders\/42\?token=REDACTED&access_token=REDACTED$/);
    expect(s.fullCode).toBe(`await expect(page).toHaveURL(${JSON.stringify(s.value)});`);
    expect(s.rect).toBeUndefined();

    await advance(3000);
    expect(suggestions()).toHaveLength(1); // one per distinct URL in a row
  });

  it('a redirect chain yields one suggestion, for where it settled', async () => {
    load();
    send({ type: 'START_RECORDING' });
    sent.length = 0;
    window.history.pushState(null, '', '/login');
    window.dispatchEvent(new window.PopStateEvent('popstate'));
    await advance(200);
    window.history.pushState(null, '', '/callback');
    window.dispatchEvent(new window.PopStateEvent('popstate'));
    await advance(200);
    window.history.pushState(null, '', '/dashboard');
    window.dispatchEvent(new window.Event('hashchange'));
    await advance(600);
    expect(suggestions().map((s) => s.value.replace(/^https?:\/\/[^/]+/, ''))).toEqual(['/dashboard']);
  });

  it('a URL that changes again during the stable window is re-checked, not suggested', async () => {
    load();
    send({ type: 'START_RECORDING' });
    sent.length = 0;
    window.history.pushState(null, '', '/a');
    window.dispatchEvent(new window.PopStateEvent('popstate'));
    await advance(300);
    window.history.pushState(null, '', '/b'); // no event: the stable timer sees it
    await advance(250);
    expect(suggestions()).toEqual([]);
    await advance(600);
    expect(suggestions().map((s) => s.reason)).toEqual(['Page navigated to /b']);
  });

  it('suggests going back to an earlier URL, but not the URL the recording started on', async () => {
    load();
    send({ type: 'START_RECORDING' });
    const start = window.location.pathname;
    sent.length = 0;
    window.history.pushState(null, '', '/next');
    await advance(1000);
    window.history.pushState(null, '', start);
    await advance(1000);
    expect(suggestions().map((s) => s.reason)).toEqual([
      'Page navigated to /next',
      `Page navigated to ${start}`,
    ]);
    // Start page right away, before anything else: no suggestion (the goto covers it).
    load();
    send({ type: 'START_RECORDING' });
    sent.length = 0;
    await advance(2000);
    expect(suggestions()).toEqual([]);
  });

  it('after a full navigation the re-armed top frame suggests the new URL', async () => {
    window.history.replaceState(null, '', '/confirmation');
    load({ ready: { recording: true, paused: false } });
    await advance(500);
    const [s] = suggestions();
    expect(s).toMatchObject({ assertType: 'toHaveURL', reason: 'Page navigated to /confirmation' });
    // No goto/viewport on a rearm.
    expect(recorded().filter((r) => r.action === 'goto')).toEqual([]);
  });

  it('a paused session suggests nothing on its new page, and nothing it navigated through', async () => {
    window.history.replaceState(null, '', '/paused-page');
    load({ ready: { recording: true, paused: true } });
    await advance(1000);
    window.history.pushState(null, '', '/while-paused');
    await advance(1000);
    send({ type: 'RESUME_RECORDING' });
    await advance(2000);
    expect(suggestions()).toEqual([]);
    window.history.pushState(null, '', '/after-resume');
    await advance(1000);
    expect(suggestions().map((s) => s.reason)).toEqual(['Page navigated to /after-resume']);
  });

  it('pausing cancels a pending suggestion', async () => {
    load();
    send({ type: 'START_RECORDING' });
    sent.length = 0;
    window.history.pushState(null, '', '/x');
    await advance(600);
    send({ type: 'PAUSE_RECORDING' });
    await advance(2000);
    expect(suggestions()).toEqual([]);
  });

  it('honours llSettings.autoAssertions from storage and from storage.onChanged', async () => {
    load({ storage: { llSettings: { autoAssertions: false } } });
    send({ type: 'START_RECORDING' });
    sent.length = 0;
    window.history.pushState(null, '', '/off');
    await advance(1500);
    expect(suggestions()).toEqual([]);

    storageListeners.forEach((fn) => fn({ llSettings: { newValue: { autoAssertions: true } } }, 'local'));
    window.history.pushState(null, '', '/on');
    await advance(1500);
    expect(suggestions().map((s) => s.reason)).toEqual(['Page navigated to /on']);

    // A missing key means the defaults (on); an explicit false turns it off again.
    storageListeners.forEach((fn) => fn({ llSettings: { newValue: undefined } }, 'local'));
    window.history.pushState(null, '', '/default');
    await advance(1500);
    storageListeners.forEach((fn) => fn({ llSettings: { newValue: { autoAssertions: false } } }, 'local'));
    window.history.pushState(null, '', '/off-again');
    await advance(1500);
    expect(suggestions().map((s) => s.reason)).toEqual([
      'Page navigated to /on',
      'Page navigated to /default',
    ]);
    // Other namespaces are ignored.
    storageListeners.forEach((fn) => fn({ llSettings: { newValue: { autoAssertions: true } } }, 'sync'));
    window.history.pushState(null, '', '/still-off');
    await advance(1500);
    expect(suggestions()).toHaveLength(2);
  });

  it('stopping the recording stops the URL watch', async () => {
    load();
    send({ type: 'START_RECORDING' });
    send({ type: 'STOP_RECORDING' });
    sent.length = 0;
    window.history.pushState(null, '', '/gone');
    window.dispatchEvent(new window.PopStateEvent('popstate'));
    await advance(2000);
    expect(suggestions()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an iframe never suggests URLs', async () => {
    load();
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
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
    // runInContext (not w.eval) so coverage attributes the frame's run to src/.
    for (const file of CONTENT_SCRIPTS)
      vm.runInContext(readFileSync(join(ROOT, file), 'utf8'), w, { filename: file });
    frameHandlers.forEach((h) => h({ type: 'START_RECORDING', rearm: true }, {}, () => {}));
    await advance(2000);
    expect(frameSent.filter((m) => m.type === 'RECORDED_ACTION')).toEqual([]);
    frameHandlers.forEach((h) => h({ type: 'STOP_RECORDING' }, {}, () => {}));
  });
});

describe('F3 · feedback after a submit', () => {
  function startWithForm(
    html = '<form id="f"><label>Name <input id="n"></label><button>Save</button></form>'
  ) {
    load();
    document.body.innerHTML = html;
    const form = document.getElementById('f');
    if (form) form.addEventListener('submit', (e) => e.preventDefault());
    send({ type: 'START_RECORDING' });
    sent.length = 0;
    return form;
  }

  it('suggests toContainText on an alert that appears after the form is submitted', async () => {
    const form = startWithForm();
    submit(form);
    await advance(400);
    document.body.insertAdjacentHTML('beforeend', '<div role="alert">Profile saved successfully</div>');
    await advance(200);
    const [s] = suggestions();
    expect(s).toMatchObject({
      action: 'assert',
      assertType: 'toContainText',
      value: 'Profile saved successfully',
      suggested: true,
      reason: 'Success message appeared after submit',
    });
    // The engine's best locator for the alert, resolving to exactly that element.
    expect(globalThis.__LocatorLensEngine.resolveTarget(s.target)).toEqual([
      document.querySelector('[role="alert"]'),
    ]);
    expect(s.fullCode).toBe(`await expect(${s.code}).toContainText("Profile saved successfully");`);
    expect(s.viewport).toEqual({ width: window.innerWidth, height: window.innerHeight });
  });

  it('a click on a submit button starts the watch; at most two suggestions per submit', async () => {
    startWithForm();
    pointer(document.querySelector('button'));
    expect(recorded().map((s) => s.action)).toEqual(['click']);
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div class="toast">One</div><div class="snackbar">Two</div><div class="notification">Three</div>'
    );
    await advance(200);
    expect(suggestions().map((s) => s.value)).toEqual(['One', 'Two']);
    await advance(3000);
    expect(suggestions()).toHaveLength(2);
  });

  it('a click on a button named like a submit starts the watch; another button does not', async () => {
    load();
    document.body.innerHTML = '<button id="cancel">Cancel</button><button id="po">Place order</button>';
    send({ type: 'START_RECORDING' });
    pointer(document.getElementById('cancel'));
    document.body.insertAdjacentHTML('beforeend', '<div class="flash">Cancelled</div>');
    await advance(3500);
    expect(suggestions()).toEqual([]);

    pointer(document.getElementById('po'));
    document.body.insertAdjacentHTML('beforeend', '<div class="flash" id="done">Order placed</div>');
    await advance(200);
    expect(suggestions().map((s) => s.value)).toEqual(['Order placed']);
  });

  it('Enter on a submit-like button starts the watch', async () => {
    load();
    document.body.innerHTML = '<input type="submit" value="Sign in" id="go">';
    send({ type: 'START_RECORDING' });
    document
      .getElementById('go')
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    document.body.insertAdjacentHTML('beforeend', '<p class="error-message">Wrong password</p>');
    await advance(200);
    expect(suggestions()).toEqual([
      expect.objectContaining({ value: 'Wrong password', reason: 'Error message appeared after submit' }),
    ]);
  });

  it('nothing is suggested from feedback that appears after the 3 s window', async () => {
    const form = startWithForm();
    submit(form);
    await advance(3100);
    document.body.insertAdjacentHTML('beforeend', '<div role="status">Late</div>');
    await advance(200);
    expect(suggestions()).toEqual([]);
  });

  it('ignores feedback that was already showing, but sees a live region whose text changed', async () => {
    const form = startWithForm(
      '<form id="f"><button>Save</button></form><div role="alert">Old warning</div><div aria-live="polite" id="live">Idle</div>'
    );
    submit(form);
    await advance(100);
    document.querySelector('[role="alert"]').setAttribute('data-x', '1'); // no text change
    document.getElementById('live').textContent = 'Saved 3 items';
    await advance(200);
    expect(suggestions().map((s) => s.value)).toEqual(['Saved 3 items']);
  });

  it('an element revealed by a class/hidden flip counts as new', async () => {
    const form = startWithForm(
      '<form id="f"><button>Save</button></form><div class="banner" id="b" hidden><span>Changes saved</span></div>'
    );
    submit(form);
    document.getElementById('b').removeAttribute('hidden');
    await advance(200);
    expect(suggestions().map((s) => s.value)).toEqual(['Changes saved']);
  });

  it('a dialog with no text is asserted visible; long or empty text is not suggested', async () => {
    const form = startWithForm();
    submit(form);
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div class="message"></div><div class="alert">${'x '.repeat(200)}</div><dialog open></dialog>`
    );
    await advance(200);
    const [s] = suggestions();
    expect(suggestions()).toHaveLength(1);
    expect(s).toMatchObject({ assertType: 'toBeVisible', value: '', reason: 'Dialog appeared after submit' });
    expect(s.fullCode).toMatch(/\.toBeVisible\(\);$/);
  });

  it('never suggests a value typed into a password field', async () => {
    const form = startWithForm(
      '<form id="f"><label>Password <input type="password" id="pw"></label><button>Log in</button></form>'
    );
    document.getElementById('pw').value = 'hunter22';
    submit(form);
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div class="toast" id="t1">Password hunter22 is too weak</div>'
    );
    await advance(200);
    const [s] = suggestions();
    expect(s).toMatchObject({ assertType: 'toBeVisible', value: '', target: { kind: 'id', value: 't1' } });
    expect(JSON.stringify(recorded())).not.toContain('hunter22');
  });

  it('drops a suggestion whose only locator would spell out the secret', async () => {
    const form = startWithForm(
      '<form id="f"><label>Password <input type="password" id="pw"></label><button>Log in</button></form>'
    );
    document.getElementById('pw').value = 'hunter22';
    submit(form);
    // A locator without the secret is still found (a structural one here).
    document.body.insertAdjacentHTML('beforeend', '<div class="toast">hunter22</div>');
    await advance(200);
    expect(suggestions()).toEqual([expect.objectContaining({ assertType: 'toBeVisible', value: '' })]);

    // …and when every candidate, the fallback included, names it: no suggestion.
    const form2 = startWithForm(
      '<form id="f"><label>Password <input type="password" id="pw"></label><button>Log in</button></form>'
    );
    document.getElementById('pw').value = 'hunter22';
    globalThis.__LocatorLensEngine.generateLocators = () => ({
      elementData: {},
      locators: [{ code: "page.getByText('hunter22')", target: { kind: 'text', value: 'hunter22' } }],
    });
    submit(form2);
    document.body.insertAdjacentHTML('beforeend', '<div class="toast" id="t-hunter22">hunter22</div>');
    await advance(200);
    expect(suggestions()).toEqual([]);
    expect(JSON.stringify(recorded())).not.toContain('hunter22');
  });

  it('ignores Locatra’s own toast', async () => {
    const form = startWithForm();
    submit(form);
    // No element to copy from: Locatra shows its own toast.
    send({ type: 'CONTEXT_MENU_COPY' });
    expect(document.getElementById('ll-toast')).not.toBeNull();
    await advance(200);
    expect(suggestions()).toEqual([]);
  });

  it('a page toast whose id merely starts with ll- is the page’s own (M4)', async () => {
    const form = startWithForm();
    submit(form);
    document.body.insertAdjacentHTML('beforeend', '<div id="ll-toast" role="status">Saved</div>');
    await advance(200);
    expect(suggestions().map((s) => s.value)).toEqual(['Saved']);
  });

  it('pausing, stopping or turning the setting off ends the watch', async () => {
    let form = startWithForm();
    submit(form);
    send({ type: 'PAUSE_RECORDING' });
    document.body.insertAdjacentHTML('beforeend', '<div role="alert">A</div>');
    await advance(200);
    send({ type: 'RESUME_RECORDING' });
    await advance(200);

    form = startWithForm();
    submit(form);
    send({ type: 'STOP_RECORDING' });
    document.body.insertAdjacentHTML('beforeend', '<div role="alert">B</div>');
    await advance(200);

    form = startWithForm();
    submit(form);
    storageListeners.forEach((fn) => fn({ llSettings: { newValue: { autoAssertions: false } } }, 'local'));
    document.body.insertAdjacentHTML('beforeend', '<div role="alert">C</div>');
    await advance(200);
    expect(suggestions()).toEqual([]);
  });

  it('a submit while paused or a page hide does not leave an observer behind', async () => {
    const form = startWithForm();
    send({ type: 'PAUSE_RECORDING' });
    submit(form);
    send({ type: 'RESUME_RECORDING' });
    submit(form);
    window.dispatchEvent(new window.Event('pagehide'));
    document.body.insertAdjacentHTML('beforeend', '<div role="alert">After hide</div>');
    await advance(200);
    expect(suggestions()).toEqual([]);
  });

  it('a submit from a page form with an ll- id is watched like any other (M4)', async () => {
    startWithForm('<form id="ll-own"><button>Save</button></form>');
    submit(document.getElementById('ll-own'));
    document.body.insertAdjacentHTML('beforeend', '<div role="alert">Yes</div>');
    await advance(200);
    expect(suggestions().map((s) => s.value)).toEqual(['Yes']);
  });
});

describe('F4 · rect and viewport on recorded steps', () => {
  function box(el, r) {
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

  it('every targeted step carries the element rect and the viewport size', () => {
    load();
    document.body.innerHTML = '<button id="b">Go</button><input type="checkbox" id="c" aria-label="C">';
    box(document.getElementById('b'), { x: 10.26, y: 20, w: 80, h: 24 });
    send({ type: 'START_RECORDING' });
    pointer(document.getElementById('b'));
    const c = document.getElementById('c');
    box(c, { x: 1, y: 2, w: 3, h: 4 });
    c.checked = true;
    c.dispatchEvent(new window.Event('change', { bubbles: true }));
    c.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    const steps = recorded();
    const click = steps.find((s) => s.action === 'click');
    expect(click.rect).toEqual({ x: 10.3, y: 20, width: 80, height: 24 });
    expect(click.viewport).toEqual({ width: window.innerWidth, height: window.innerHeight });
    expect(steps.find((s) => s.action === 'check').rect).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    // goto, viewport and press have no target, so no rect.
    steps
      .filter((s) => ['goto', 'viewport', 'press'].includes(s.action))
      .forEach((s) => {
        expect(s.rect).toBeUndefined();
        expect(s.viewport).toBeUndefined();
      });
  });

  it('a fill flushed after its field was removed carries no rect', async () => {
    load();
    document.body.innerHTML = '<input id="q" aria-label="Q">';
    send({ type: 'START_RECORDING' });
    const q = document.getElementById('q');
    q.value = 'abc';
    q.dispatchEvent(new window.Event('input', { bubbles: true }));
    q.remove();
    await advance(500);
    const fill = recorded().find((s) => s.action === 'fill');
    expect(fill.value).toBe('abc');
    expect(fill.rect).toBeUndefined();
  });

  it('inside a same-origin iframe the rect is offset into top-frame coordinates', async () => {
    load();
    document.body.innerHTML = '<iframe id="f" style="border:0;padding-left:5px;padding-top:7px"></iframe>';
    const frame = document.getElementById('f');
    box(frame, { x: 100, y: 200, w: 400, h: 300 });
    Object.defineProperty(frame, 'clientLeft', { value: 2 });
    Object.defineProperty(frame, 'clientTop', { value: 3 });
    const w = frame.contentWindow;
    const frameSent = [];
    w.__LocatraTrustSyntheticEvents = true;
    w.chrome = {
      runtime: {
        id: 'x',
        lastError: null,
        sendMessage: (m, cb) => {
          frameSent.push(m);
          if (m.type === 'FRAME_INDEX_LOOKUP' && cb) cb({ ok: true, indices: [0] });
        },
        onMessage: { addListener: (fn) => (w.__h = fn) },
      },
      storage: { local: { get: (k, cb) => cb({}) }, onChanged: { addListener: () => {} } },
    };
    // runInContext (not w.eval) so coverage attributes the frame's run to src/.
    for (const file of CONTENT_SCRIPTS)
      vm.runInContext(readFileSync(join(ROOT, file), 'utf8'), w, { filename: file });
    w.document.body.innerHTML = '<button>In frame</button>';
    const btn = w.document.querySelector('button');
    box(btn, { x: 10, y: 20, w: 30, h: 40 });
    w.__h({ type: 'START_RECORDING' }, {}, () => {});
    btn.dispatchEvent(new w.PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true }));
    const step = frameSent.find((m) => m.type === 'RECORDED_ACTION').data;
    expect(step.target.kind).toBe('frame');
    expect(step.rect).toEqual({ x: 100 + 2 + 5 + 10, y: 200 + 3 + 7 + 20, width: 30, height: 40 });
    expect(step.viewport).toEqual({ width: window.innerWidth, height: window.innerHeight });

    // Across an origin boundary the frame element cannot be read: no rect at all.
    Object.defineProperty(w, 'frameElement', { configurable: true, get: () => null });
    btn.dispatchEvent(new w.PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true }));
    for (let i = 0; i < 10; i++) await Promise.resolve(); // held for its exact frame index (C4)
    const second = frameSent.filter((m) => m.type === 'RECORDED_ACTION')[1].data;
    expect(second.rect).toBeUndefined();
    expect(second.viewport).toBeUndefined();
    w.__h({ type: 'STOP_RECORDING' }, {}, () => {});
  });
});
