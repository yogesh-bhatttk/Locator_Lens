// @vitest-environment jsdom
//
// Loads the three content scripts in manifest order into one jsdom page, behind a
// chrome stub, and drives them through the message API the background uses. This is
// the closest thing to "the extension actually runs" that can live in CI, and it
// covers the wiring that unit-testing each file separately would miss.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The order the manifest declares. content.js depends on both of the others.
const CONTENT_SCRIPTS = ['src/codegen.js', 'src/content-locator-engine.js', 'src/content.js'];

let messageHandlers;
let storageValues;
/** Every message the current instance sent through the default sendMessage stub. */
let outbox;

/**
 * Every handler registered across all loads in this file. jsdom keeps one document
 * for the whole file, so a re-loaded content script adds a second set of listeners
 * to it. Without telling the previous instance to stand down, an earlier one stays
 * in recording mode and keeps emitting steps into the next test.
 */
const allHandlers = [];

/**
 * Fresh page + fresh copy of the content scripts, as if the tab had just loaded.
 * `ready` is background's answer to the CONTENT_READY self-arming handshake
 * (undefined = no answer). `keepPrevious` skips politely stopping the previous
 * instance, so its liveness-based teardown is what gets exercised.
 */
function loadContentScripts({ ready, keepPrevious = false } = {}) {
  if (!keepPrevious) {
    for (const handler of allHandlers) {
      try {
        handler({ type: 'STOP_RECORDING' }, {}, () => {});
        handler({ type: 'STOP_INSPECT' }, {}, () => {});
      } catch {
        /* an instance whose globals have already been torn down */
      }
    }
  }

  // The previous page's extension context is gone. Its instance's liveness probe
  // now reports dead, so the fresh injection below tears it down and takes over —
  // the same path an extension reload/update takes in a still-open tab.
  if (globalThis.chrome && globalThis.chrome.runtime) delete globalThis.chrome.runtime.id;

  messageHandlers = [];
  storageValues = {};
  outbox = [];

  // jsdom-dispatched events are all untrusted (isTrusted === false), and the
  // content script ignores untrusted clicks/input as page automation. This
  // test-only seam (a global only the content script's own world can see) makes
  // it treat them as user events; the "synthetic events" suite turns it off.
  globalThis.__LocatraTrustSyntheticEvents = true;

  globalThis.chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      sendMessage: (msg, cb) => {
        outbox.push(msg);
        if (msg && msg.type === 'CONTENT_READY' && ready !== undefined && cb) cb(ready);
      },
      onMessage: {
        addListener: (fn) => {
          messageHandlers.push(fn);
          allHandlers.push(fn);
        },
      },
    },
    storage: {
      local: {
        get: (keys, cb) => cb(storageValues),
        set: (obj, cb) => {
          Object.assign(storageValues, obj);
          if (cb) cb();
        },
      },
      onChanged: { addListener: () => {} },
    },
  };

  // Each injection is a fresh script run. content.js no longer trusts a bare
  // window flag (it checks the previous instance's liveness), but the engine
  // globals are cleared so each load really re-evaluates them.
  delete globalThis.__LocatorLensEngine;
  delete globalThis.LLCodegen;

  for (const file of CONTENT_SCRIPTS) {
    vm.runInThisContext(readFileSync(join(ROOT, file), 'utf8'), { filename: file });
  }
}

/** Deliver a message the way chrome.runtime does, returning the handler's response. */
function send(msg) {
  let response;
  for (const handler of messageHandlers) handler(msg, {}, (r) => (response = r));
  return response;
}

/**
 * jsdom implements no layout, so it has no elementFromPoint — the hit-testing the
 * picker relies on. Point it at a chosen element to simulate the cursor being there.
 */
function pointAt(el) {
  document.elementFromPoint = () => el;
}

beforeEach(() => {
  // A fresh tab means a fresh document: the injected stylesheet lives in <head>,
  // so clearing only <body> would leak it into the next test.
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.body.className = '';
  delete document.elementFromPoint;
  loadContentScripts();
});

describe('injection', () => {
  it('publishes both engines onto the page globals', () => {
    expect(globalThis.LLCodegen).toBeDefined();
    expect(globalThis.__LocatorLensEngine).toBeDefined();
  });

  it('starts inert — no overlay and no styles until asked', () => {
    expect(document.getElementById('ll-overlay')).toBeNull();
    expect(document.getElementById('ll-styles')).toBeNull();
  });

  it('registers a message listener', () => {
    expect(messageHandlers.length).toBeGreaterThan(0);
  });
});

describe('inspect lifecycle', () => {
  it('builds the overlay and marks the body on START_INSPECT', () => {
    expect(send({ type: 'START_INSPECT' })).toEqual({ ok: true });
    expect(document.getElementById('ll-overlay')).not.toBeNull();
    expect(document.getElementById('ll-tooltip')).not.toBeNull();
    expect(document.getElementById('ll-traversal-bar')).not.toBeNull();
    expect(document.body.classList.contains('ll-inspecting')).toBe(true);
  });

  it('tears everything down on STOP_INSPECT', () => {
    send({ type: 'START_INSPECT' });
    expect(send({ type: 'STOP_INSPECT' })).toEqual({ ok: true });
    expect(document.getElementById('ll-overlay')).toBeNull();
    expect(document.getElementById('ll-tooltip')).toBeNull();
    expect(document.getElementById('ll-traversal-bar')).toBeNull();
    expect(document.body.classList.contains('ll-inspecting')).toBe(false);
  });

  it('is idempotent across repeated start/stop cycles', () => {
    for (let i = 0; i < 3; i++) {
      send({ type: 'START_INSPECT' });
      send({ type: 'START_INSPECT' });
      send({ type: 'STOP_INSPECT' });
    }
    expect(document.querySelectorAll('#ll-overlay')).toHaveLength(0);
    expect(document.querySelectorAll('#ll-styles')).toHaveLength(1);
  });
});

const LAB_MARK = '[data-locatra-lab]';

describe('Selector Lab', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="save">Save</button>
      <button id="cancel">Cancel</button>
      <input placeholder="Email">`;
  });

  // The regression this file exists for: the highlight class was applied but its
  // stylesheet was only ever injected by Start Inspecting, so validating a selector
  // without inspecting first appeared to do nothing at all. Highlights are now
  // inline styles, which need no stylesheet at all.
  it('makes the highlight visible without requiring Inspect first', () => {
    send({ type: 'LAB_VALIDATE', selector: '#save' });
    const save = document.getElementById('save');
    expect(save.style.getPropertyValue('outline')).toContain('solid');
    expect(save.style.getPropertyPriority('outline')).toBe('important');
  });

  it('highlights CSS matches and reports the count', () => {
    expect(send({ type: 'LAB_VALIDATE', selector: 'button' })).toEqual({ ok: true, count: 2 });
    expect(document.querySelectorAll(LAB_MARK)).toHaveLength(2);
  });

  it('resolves an XPath expression', () => {
    expect(send({ type: 'LAB_VALIDATE', selector: '//button' }).count).toBe(2);
  });

  it('resolves a pasted Playwright locator line, boilerplate and all', () => {
    const res = send({
      type: 'LAB_VALIDATE',
      selector: "await page.getByRole('button', { name: 'Save' }).click();",
    });
    expect(res.count).toBe(1);
    expect(document.getElementById('save').hasAttribute('data-locatra-lab')).toBe(true);
  });

  it('resolves getByPlaceholder', () => {
    expect(send({ type: 'LAB_VALIDATE', selector: "page.getByPlaceholder('Email')" }).count).toBe(1);
  });

  it('applies a positional reducer', () => {
    expect(send({ type: 'LAB_VALIDATE', selector: "page.locator('button').first()" }).count).toBe(1);
  });

  it('clears the previous highlights on the next validation', () => {
    send({ type: 'LAB_VALIDATE', selector: 'button' });
    send({ type: 'LAB_VALIDATE', selector: '#save' });
    expect(document.querySelectorAll(LAB_MARK)).toHaveLength(1);
  });

  it('removes every highlight on LAB_CLEAR', () => {
    send({ type: 'LAB_VALIDATE', selector: 'button' });
    expect(send({ type: 'LAB_CLEAR' })).toEqual({ ok: true });
    expect(document.querySelectorAll(LAB_MARK)).toHaveLength(0);
    for (const b of document.querySelectorAll('button')) expect(b.hasAttribute('style')).toBe(false);
  });

  it('reports an invalid selector instead of throwing', () => {
    const res = send({ type: 'LAB_VALIDATE', selector: '<<<not a selector' });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  // A plain CSS selector used to resolve via document.querySelectorAll alone, which
  // never sees into shadow roots — a web-component button was invisible to the Lab
  // even though the rest of the extension advertises shadow-DOM support.
  it('finds a plain CSS match living inside an open shadow root', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const shadow = root.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button class="widget-save">Save</button>';

    const res = send({ type: 'LAB_VALIDATE', selector: '.widget-save' });
    expect(res.count).toBe(1);
    expect(shadow.querySelector('.widget-save').hasAttribute('data-locatra-lab')).toBe(true);
  });

  it('resolves getByRole against an element inside an open shadow root', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const shadow = root.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>Shadow Save</button>';

    const res = send({ type: 'LAB_VALIDATE', selector: "page.getByRole('button', { name: 'Shadow Save' })" });
    expect(res.count).toBe(1);
  });
});

describe('stress test', () => {
  it('reports noTarget when nothing has been picked', () => {
    expect(send({ type: 'RUN_STRESS_TEST' }).data).toMatchObject({ noTarget: true });
  });

  it('passes an element whose role and accessible name are unique', () => {
    document.body.innerHTML = '<button id="only">Unique Action</button><button>Other</button>';
    const target = document.getElementById('only');
    pointAt(target);
    target.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));

    const { data } = send({ type: 'RUN_STRESS_TEST' });
    expect(data).toMatchObject({ survived: true, role: 'button', name: 'Unique Action', tag: 'button' });
  });

  it('fails an element whose role and name are shared with a sibling', () => {
    document.body.innerHTML = '<button id="a">Duplicate</button><button id="b">Duplicate</button>';
    const target = document.getElementById('a');
    pointAt(target);
    target.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));

    expect(send({ type: 'RUN_STRESS_TEST' }).data).toMatchObject({ survived: false, name: 'Duplicate' });
  });

  // document.querySelectorAll (used to count candidates) never sees into shadow
  // roots. A uniquely-named element that happens to live inside one used to count
  // zero candidates — not even itself — and always report "survived: false", which
  // contradicted the extension's advertised shadow-DOM support.
  it('passes a uniquely-identifiable element inside an open shadow root', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const root = document.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<button>Save Changes</button>';
    const target = root.querySelector('button');
    pointAt(target);
    target.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, composed: true }));

    const { data } = send({ type: 'RUN_STRESS_TEST' });
    expect(data).toMatchObject({ survived: true, role: 'button', name: 'Save Changes', tag: 'button' });
  });

  it('still counts a duplicate that only exists inside a shadow root', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const root = document.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<button>Duplicate</button><button>Duplicate</button>';
    const target = root.querySelectorAll('button')[0];
    pointAt(target);
    target.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, composed: true }));

    expect(send({ type: 'RUN_STRESS_TEST' }).data).toMatchObject({ survived: false, name: 'Duplicate' });
  });

  // sendResponse must always fire, even if the analysis throws — otherwise the side
  // panel's "Testing…" state hangs (background only recovers on a port-closed error,
  // which a synchronous throw inside the handler never produces).
  it('answers safely instead of hanging when the analysis throws', () => {
    document.body.innerHTML = '<button id="only">Unique Action</button>';
    const target = document.getElementById('only');
    pointAt(target);
    target.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));

    const E = globalThis.__LocatorLensEngine;
    const original = E.getRole;
    E.getRole = () => {
      throw new Error('boom');
    };
    try {
      const { data } = send({ type: 'RUN_STRESS_TEST' });
      expect(data).toMatchObject({ survived: false, unavailable: true });
    } finally {
      E.getRole = original;
    }
  });
});

describe('recorder capture', () => {
  /** Collect the actions the content script forwards to the background. */
  function captureActions() {
    const sent = [];
    chrome.runtime.sendMessage = (msg) => {
      if (msg && msg.type === 'RECORDED_ACTION') sent.push(msg.data);
    };
    return sent;
  }

  // A checkbox fires pointerdown *and* change. Recording in both places produced
  // the step twice, and the pointerdown copy always said `check` because the
  // element had not toggled yet — so unchecking a box also generated `.check()`.
  it('records a checkbox exactly once', () => {
    document.body.innerHTML = '<label for="tos">Accept terms</label><input type="checkbox" id="tos">';
    const box = document.getElementById('tos');
    const sent = captureActions();

    send({ type: 'START_RECORDING' });
    box.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true }));
    box.checked = true;
    box.dispatchEvent(new window.Event('change', { bubbles: true }));

    const steps = sent.filter((a) => a.action === 'check' || a.action === 'uncheck' || a.action === 'click');
    expect(steps).toHaveLength(1);
    expect(steps[0].action).toBe('check');
  });

  it('records unchecking as uncheck, not check', () => {
    document.body.innerHTML = '<label for="tos">Accept terms</label><input type="checkbox" id="tos" checked>';
    const box = document.getElementById('tos');
    const sent = captureActions();

    send({ type: 'START_RECORDING' });
    box.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true }));
    box.checked = false;
    box.dispatchEvent(new window.Event('change', { bubbles: true }));

    const steps = sent.filter((a) => ['check', 'uncheck', 'click'].includes(a.action));
    expect(steps).toHaveLength(1);
    expect(steps[0].action).toBe('uncheck');
  });

  it('still records an ordinary button click', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    const sent = captureActions();

    send({ type: 'START_RECORDING' });
    document
      .getElementById('go')
      .dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true }));

    expect(sent.filter((a) => a.action === 'click')).toHaveLength(1);
  });

  it('records nothing while paused', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    const sent = captureActions();

    send({ type: 'START_RECORDING' });
    send({ type: 'PAUSE_RECORDING' });
    const before = sent.length;
    document
      .getElementById('go')
      .dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true }));

    expect(sent).toHaveLength(before);
  });

  // A full-page navigation tears down this JS context entirely; the freshly re-injected
  // instance has never seen a PAUSE_RECORDING message, so background has to tell it the
  // recording was paused via the rearm message itself. Without that, a paused recording
  // silently went live again on the next page while the panel kept showing "paused".
  it('stays paused across a navigation rearm when background says so', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    let sent = captureActions();
    send({ type: 'START_RECORDING' });
    send({ type: 'PAUSE_RECORDING' });

    // Simulate the full-page navigation: a brand-new content-script instance.
    loadContentScripts();
    document.body.innerHTML = '<button id="go">Go</button>';
    sent = captureActions();
    send({ type: 'START_RECORDING', rearm: true, paused: true });

    document
      .getElementById('go')
      .dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true }));

    expect(sent.filter((a) => a.action === 'click')).toHaveLength(0);
  });

  it('resumes capturing across a navigation rearm when the recording was not paused', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    send({ type: 'START_RECORDING' });

    loadContentScripts();
    document.body.innerHTML = '<button id="go">Go</button>';
    const sent = captureActions();
    send({ type: 'START_RECORDING', rearm: true, paused: false });

    document
      .getElementById('go')
      .dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true }));

    expect(sent.filter((a) => a.action === 'click')).toHaveLength(1);
  });
});

describe('recorder control messages', () => {
  it('acknowledges the full control surface', () => {
    for (const type of ['START_RECORDING', 'PAUSE_RECORDING', 'RESUME_RECORDING', 'STOP_RECORDING']) {
      expect(send({ type }), type).toEqual({ ok: true });
    }
  });

  it('accepts an assert-mode change', () => {
    expect(send({ type: 'SET_ASSERT_MODE', on: true, assertType: 'toHaveText' })).toEqual({ ok: true });
  });

  it('survives start/stop recording cycles without throwing', () => {
    expect(() => {
      for (let i = 0; i < 3; i++) {
        send({ type: 'START_RECORDING' });
        send({ type: 'STOP_RECORDING' });
      }
    }).not.toThrow();
  });
});

describe('debug logging', () => {
  it('stays silent unless llDebug is set', () => {
    const calls = [];
    const original = console.log;
    console.log = (...args) => calls.push(args);
    try {
      send({ type: 'START_RECORDING' });
      send({ type: 'STOP_RECORDING' });
      send({ type: 'STOP_INSPECT' });
    } finally {
      console.log = original;
    }
    expect(calls).toHaveLength(0);
  });
});

// A content script inherits the *page's* security context, so on any http:// site
// navigator.clipboard is undefined. Calling it threw straight out of the message
// listener, which killed the context-menu copy and its sendResponse with it.
describe('clipboard on a non-secure page', () => {
  beforeEach(() => {
    document.body.innerHTML = '<button id="go">Place order</button>';
    delete navigator.clipboard; // jsdom has none either — this is the http:// case
  });

  it('answers the context-menu copy instead of throwing', () => {
    const target = document.getElementById('go');
    pointAt(target);
    target.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));

    let response;
    expect(() => {
      response = send({ type: 'CONTEXT_MENU_COPY' });
    }).not.toThrow();
    expect(response).toEqual({ ok: true });
  });

  it('tells the user the context-menu copy was blocked instead of doing nothing', async () => {
    const target = document.getElementById('go');
    pointAt(target);
    target.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
    send({ type: 'CONTEXT_MENU_COPY' });
    await new Promise((r) => setTimeout(r, 0));

    const toast = document.getElementById('ll-toast');
    expect(toast).not.toBeNull();
    expect(toast.textContent).toContain('Copy blocked');
    // The toast styles live in the injected sheet, which Inspect never ran here.
    expect(document.getElementById('ll-styles')).not.toBeNull();
  });

  it('reports the copy as blocked rather than showing a false "Copied"', async () => {
    // execCommand is unavailable here too, so nothing reaches the clipboard. Claiming
    // success sent people off to paste an empty buffer.
    send({ type: 'START_INSPECT' });
    const target = document.getElementById('go');
    pointAt(target);
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    const toast = document.getElementById('ll-toast');
    expect(toast).not.toBeNull();
    expect(toast.textContent).toContain('Copy blocked');
    expect(toast.textContent).toContain('Place order');
  });

  it('says Copied when the clipboard write actually succeeds', async () => {
    const written = [];
    navigator.clipboard = {
      writeText: (t) => {
        written.push(t);
        return Promise.resolve();
      },
    };
    send({ type: 'START_INSPECT' });
    const target = document.getElementById('go');
    pointAt(target);
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(written).toHaveLength(1);
    expect(document.getElementById('ll-toast').textContent).toContain('Copied');
    delete navigator.clipboard;
  });
});

describe('recorder teardown', () => {
  it('does not leak a debounced keystroke into the next recording session', async () => {
    // Typing is emitted on a 450ms debounce. Stopping and starting again inside that
    // window used to let the *previous* session's timer fire against the new one, so
    // a fresh recording opened with a fill nobody performed during it. Stop now
    // flushes it into the session it was typed in (rather than dropping it).
    document.body.innerHTML = '<label for="q">Search</label><input id="q">';
    const field = document.getElementById('q');
    const sent = [];
    chrome.runtime.sendMessage = (msg) => {
      if (msg && msg.type === 'RECORDED_ACTION') sent.push(msg.data);
    };

    send({ type: 'START_RECORDING' });
    field.value = 'typed just before stop';
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
    send({ type: 'STOP_RECORDING' });
    const fillsAtStop = sent.filter((a) => a.action === 'fill');
    expect(fillsAtStop).toHaveLength(1);
    expect(fillsAtStop[0].value).toBe('typed just before stop');
    send({ type: 'START_RECORDING' }); // new session, well inside the debounce window

    await new Promise((r) => setTimeout(r, 600)); // past the 450ms debounce
    expect(sent.filter((a) => a.action === 'fill')).toHaveLength(1);
    send({ type: 'STOP_RECORDING' });
  });
});

// ── Regression suite for the full-audit findings ──────────────────────────────

/** Capture every message the content script sends from now on. */
function captureAll() {
  const sent = [];
  chrome.runtime.sendMessage = (msg) => sent.push(msg);
  return sent;
}
const recorded = (sent) => sent.filter((m) => m.type === 'RECORDED_ACTION').map((m) => m.data);
const picks = (sent) => sent.filter((m) => m.type === 'ELEMENT_PICKED').map((m) => m.data);

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
function typeInto(el, value, init = {}) {
  el.value = value;
  el.dispatchEvent(new window.Event('input', { bubbles: true, composed: true, ...init }));
}
function key(el, k, init = {}) {
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, composed: true, ...init }));
}
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Run the three content scripts inside a same-origin <iframe> of the test page, with
 * its own chrome stub — the only way jsdom offers a window whose top is not itself.
 */
function loadIntoFrame(frame) {
  const w = frame.contentWindow;
  const frameHandlers = [];
  const frameSent = [];
  w.__LocatraTrustSyntheticEvents = true;
  w.chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      sendMessage: (msg) => frameSent.push(msg),
      onMessage: { addListener: (fn) => frameHandlers.push(fn) },
    },
    storage: { local: { get: (k, cb) => cb({}) }, onChanged: { addListener: () => {} } },
  };
  // runInContext (not w.eval) so coverage attributes the frame's run to src/.
  for (const file of CONTENT_SCRIPTS)
    vm.runInContext(readFileSync(join(ROOT, file), 'utf8'), w, { filename: file });
  const frameSend = (msg) => {
    let response;
    for (const h of frameHandlers) h(msg, {}, (r) => (response = r));
    return response;
  };
  return { w, frameSend, frameSent };
}

describe('F1 · goto/viewport only from the top frame; idempotent start (C3)', () => {
  it('an iframe does not record its own goto + viewport', () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const { w, frameSend, frameSent } = loadIntoFrame(frame);
    w.document.body.innerHTML = '<button>In frame</button>';

    frameSend({ type: 'START_RECORDING' });
    const steps = recorded(frameSent);
    expect(steps.filter((s) => s.action === 'goto' || s.action === 'viewport')).toHaveLength(0);

    // …but it does capture interactions.
    pointer(w.document.querySelector('button'));
    expect(recorded(frameSent).filter((s) => s.action === 'click')).toHaveLength(1);
    frameSend({ type: 'STOP_RECORDING' });
  });

  it('the top frame records goto + viewport once, however often START_RECORDING arrives', () => {
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    send({ type: 'START_RECORDING' });
    send({ type: 'START_RECORDING', rearm: true, paused: false });
    const steps = recorded(sent);
    expect(steps.filter((s) => s.action === 'goto')).toHaveLength(1);
    expect(steps.filter((s) => s.action === 'viewport')).toHaveLength(1);
  });

  it('a repeated START_RECORDING updates pause and assert state instead of being ignored', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    const go = document.getElementById('go');
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    send({ type: 'START_RECORDING', rearm: true, paused: true });
    pointer(go);
    expect(recorded(sent).filter((s) => s.action === 'click')).toHaveLength(0);

    send({
      type: 'START_RECORDING',
      rearm: true,
      paused: false,
      assertMode: true,
      assertType: 'toBeVisible',
    });
    pointer(go);
    const asserts = recorded(sent).filter((s) => s.action === 'assert');
    expect(asserts).toHaveLength(1);
    expect(asserts[0].assertType).toBe('toBeVisible');
  });
});

describe('F2 · debounced fills are emitted before the step that commits them', () => {
  afterEach(() => vi.useRealTimers());

  it('Enter right after typing records fill, then press — once each', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<input id="q" aria-label="Search">';
    const q = document.getElementById('q');
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    typeInto(q, 'shoes');
    key(q, 'Enter');
    vi.advanceTimersByTime(1000);

    const steps = recorded(sent).filter((s) => s.action === 'fill' || s.action === 'press');
    expect(steps.map((s) => s.action)).toEqual(['fill', 'press']);
    expect(steps[0].value).toBe('shoes');
  });

  it('a click right after typing records the fill first', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<input id="q" aria-label="Search"><button id="go">Go</button>';
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    typeInto(document.getElementById('q'), 'shoes');
    pointer(document.getElementById('go'));
    vi.advanceTimersByTime(1000);

    const steps = recorded(sent).filter((s) => s.action === 'fill' || s.action === 'click');
    expect(steps.map((s) => s.action)).toEqual(['fill', 'click']);
  });

  it('a change inside the debounce window cancels the timer — one fill, not two', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<input id="q" aria-label="Search">';
    const q = document.getElementById('q');
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    typeInto(q, 'shoes');
    q.dispatchEvent(new window.Event('change', { bubbles: true }));
    vi.advanceTimersByTime(1000);

    expect(recorded(sent).filter((s) => s.action === 'fill')).toHaveLength(1);
  });

  it('flushes a pending fill when the page is hidden or unloaded', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<input id="q" aria-label="Search">';
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    typeInto(document.getElementById('q'), 'leaving');
    window.dispatchEvent(new window.Event('pagehide'));

    expect(recorded(sent).filter((s) => s.action === 'fill')).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(recorded(sent).filter((s) => s.action === 'fill')).toHaveLength(1);
  });

  it('flushes a pending fill before pausing', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<input id="q" aria-label="Search">';
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    typeInto(document.getElementById('q'), 'before pause');
    send({ type: 'PAUSE_RECORDING' });

    expect(recorded(sent).filter((s) => s.action === 'fill')).toHaveLength(1);
  });
});

describe('F3 · shadow-DOM fields are recorded', () => {
  function shadowHost(html) {
    document.body.innerHTML = '<div id="host"></div>';
    const root = document.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = html;
    return root;
  }

  it('typing into an input inside an open shadow root records a fill on that input', () => {
    vi.useFakeTimers();
    try {
      const root = shadowHost('<input aria-label="Shadow field">');
      const sent = captureAll();
      send({ type: 'START_RECORDING' });
      typeInto(root.querySelector('input'), 'abc');
      vi.advanceTimersByTime(600);

      const fills = recorded(sent).filter((s) => s.action === 'fill');
      expect(fills).toHaveLength(1);
      expect(fills[0].value).toBe('abc');
      expect(fills[0].code).toContain('Shadow field');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a checkbox inside a shadow root records exactly one check', () => {
    const root = shadowHost('<input type="checkbox" aria-label="Agree">');
    const box = root.querySelector('input');
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    pointer(box);
    box.checked = true;
    // `change` is not composed: it never reaches a document-level listener.
    box.dispatchEvent(new window.Event('change', { bubbles: true }));

    const steps = recorded(sent).filter((s) => ['check', 'uncheck', 'click'].includes(s.action));
    expect(steps.map((s) => s.action)).toEqual(['check']);
  });

  it('a select inside a shadow root records selectOption after keyboard focus', () => {
    const root = shadowHost('<select aria-label="Size"><option>S</option><option>M</option></select>');
    const select = root.querySelector('select');
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    select.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true, composed: true }));
    select.selectedIndex = 1;
    select.dispatchEvent(new window.Event('change', { bubbles: true }));

    const steps = recorded(sent).filter((s) => s.action === 'selectOption');
    expect(steps).toHaveLength(1);
    expect(steps[0].value).toBe('M');
  });

  it('records a composed change once, not once per listener', () => {
    const root = shadowHost('<input type="checkbox" aria-label="Agree">');
    const box = root.querySelector('input');
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    pointer(box);
    box.checked = true;
    box.dispatchEvent(new window.Event('change', { bubbles: true, composed: true }));

    expect(recorded(sent).filter((s) => s.action === 'check')).toHaveLength(1);
  });
});

describe('F4 · self-arming (CONTENT_READY, PING, frame injection requests)', () => {
  afterEach(() => vi.useRealTimers());

  it('announces itself with CONTENT_READY on load', () => {
    expect(outbox.some((m) => m.type === 'CONTENT_READY')).toBe(true);
  });

  it('answers PING synchronously', () => {
    expect(send({ type: 'PING' })).toEqual({ ok: true });
  });

  it('starts recording (no goto) with the pause/assert state background reports', () => {
    loadContentScripts({
      ready: {
        recording: true,
        paused: false,
        assertMode: true,
        assertType: 'toBeVisible',
        inspecting: false,
      },
    });
    document.body.innerHTML = '<button id="go">Go</button>';
    expect(recorded(outbox).filter((s) => s.action === 'goto')).toHaveLength(0);
    const sent = captureAll();
    pointer(document.getElementById('go'));
    expect(recorded(sent).map((s) => s.action)).toEqual(['assert']);
  });

  it('honours a paused session when self-arming', () => {
    loadContentScripts({ ready: { recording: true, paused: true } });
    document.body.innerHTML = '<button id="go">Go</button>';
    const sent = captureAll();
    pointer(document.getElementById('go'));
    expect(recorded(sent)).toHaveLength(0);
  });

  it('starts inspecting when background says the tab is being inspected', () => {
    loadContentScripts({ ready: { recording: false, inspecting: true } });
    expect(document.getElementById('ll-overlay')).not.toBeNull();
  });

  it('stays inert when background does not answer', () => {
    loadContentScripts({ ready: undefined });
    expect(document.getElementById('ll-overlay')).toBeNull();
    expect(send({ type: 'START_RECORDING' })).toEqual({ ok: true });
  });

  it('asks background to inject iframes added while recording — once per burst', async () => {
    vi.useFakeTimers();
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    document.body.appendChild(document.createElement('iframe'));
    const wrap = document.createElement('div');
    wrap.innerHTML = '<iframe></iframe>';
    document.body.appendChild(wrap);
    await Promise.resolve(); // MutationObserver delivery
    vi.advanceTimersByTime(400);
    expect(sent.filter((m) => m.type === 'REQUEST_FRAME_INJECTION')).toHaveLength(1);
  });

  it('does not watch for frames while idle', async () => {
    vi.useFakeTimers();
    const sent = captureAll();
    document.body.appendChild(document.createElement('iframe'));
    await Promise.resolve();
    vi.advanceTimersByTime(400);
    expect(sent.filter((m) => m.type === 'REQUEST_FRAME_INJECTION')).toHaveLength(0);
  });
});

describe('F5 · re-injection after an extension reload', () => {
  it('a live instance still blocks a duplicate injection', () => {
    const before = messageHandlers.length;
    vm.runInThisContext(readFileSync(join(ROOT, 'src/content.js'), 'utf8'), { filename: 'content.js' });
    expect(messageHandlers.length).toBe(before);
  });

  it('a dead instance is torn down and replaced instead of blocking recovery', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    send({ type: 'START_INSPECT' });
    send({ type: 'START_RECORDING' });
    expect(document.getElementById('ll-overlay')).not.toBeNull();

    loadContentScripts({ keepPrevious: true }); // old context dies, a new instance arrives
    // The orphan's overlay and capture are gone; the new instance is live.
    expect(document.getElementById('ll-overlay')).toBeNull();
    expect(document.body.classList.contains('ll-inspecting')).toBe(false);
    const sent = captureAll();
    pointer(document.getElementById('go'));
    expect(recorded(sent)).toHaveLength(0);
    expect(send({ type: 'START_INSPECT' })).toEqual({ ok: true });
    expect(document.getElementById('ll-overlay')).not.toBeNull();
  });

  it('an orphaned instance dismantles itself when it finds its context gone', async () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    const go = document.getElementById('go');
    send({ type: 'START_INSPECT' });
    delete chrome.runtime.id; // Locatra reloaded under the open page
    pointAt(go);
    go.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await tick();

    expect(document.getElementById('ll-overlay')).toBeNull();
    expect(document.getElementById('ll-styles')).toBeNull();
    expect(window.__LocatorLensInstance).toBeUndefined();
  });
});

describe('F6/F20 · parent/child traversal', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div id="card" data-testid="product-card"><span>Shoes</span><button id="buy">Buy now</button></div>';
  });

  it('clicking after ▲ picks the traversed parent, not the leaf under the pointer', () => {
    const buy = document.getElementById('buy');
    const sent = captureAll();
    send({ type: 'START_INSPECT' });
    pointAt(buy);
    buy.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    document
      .getElementById('ll-trav-parent')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    buy.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    const [pick] = picks(sent);
    expect(pick.locators[0].code).toContain('product-card');
  });

  it('Enter picks the traversed element', () => {
    const buy = document.getElementById('buy');
    const sent = captureAll();
    send({ type: 'START_INSPECT' });
    pointAt(buy);
    buy.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    key(document.body, 'ArrowUp');
    key(document.body, 'Enter');
    expect(picks(sent)[0].locators[0].code).toContain('product-card');
  });

  it('moving well away from the traversed element releases the lock', () => {
    const buy = document.getElementById('buy');
    const sent = captureAll();
    send({ type: 'START_INSPECT' });
    pointAt(buy);
    buy.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    key(document.body, 'ArrowUp');
    buy.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, clientX: 900, clientY: 900 }));
    buy.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 900, clientY: 900 }));
    expect(picks(sent)[0].locators[0].code).toContain('Buy now');
  });

  it('places the toolbar flush against the element so reaching it never re-targets', () => {
    const buy = document.getElementById('buy');
    buy.getBoundingClientRect = () => ({
      left: 100,
      top: 100,
      right: 300,
      bottom: 140,
      width: 200,
      height: 40,
    });
    send({ type: 'START_INSPECT' });
    pointAt(buy);
    buy.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    // Flush above it, right edges aligned — never under it, where the next field is.
    const bar = document.getElementById('ll-traversal-bar');
    expect(bar.style.top).toBe('66px');
    expect(bar.style.left).toBe('40px');
  });

  it('▼ skips a shadow root <style> and lands on the first rendered child', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById('host');
    host.attachShadow({ mode: 'open' }).innerHTML =
      '<style>:host{display:block}</style><button>Inner action</button>';
    const sent = captureAll();
    send({ type: 'START_INSPECT' });
    pointAt(host);
    host.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    key(document.body, 'ArrowDown');
    key(document.body, 'Enter');
    expect(picks(sent)[0].locators[0].code).toContain('Inner action');
  });
});

describe('F7/F8/F12 · picking and asserting do not drive the page', () => {
  function pageSpy(el) {
    const seen = [];
    for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click'])
      el.addEventListener(t, () => seen.push(t));
    return seen;
  }
  function fullClick(el, init = {}) {
    pointer(el, init);
    for (const t of ['mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new window.MouseEvent(t, { bubbles: true, button: 0, ...init }));
    }
  }

  it('picking while recording records no click and the page never sees the gesture', () => {
    document.body.innerHTML = '<button id="del">Delete</button>';
    const del = document.getElementById('del');
    const seen = pageSpy(del);
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    send({ type: 'START_INSPECT' });
    pointAt(del);
    fullClick(del);

    expect(recorded(sent).filter((s) => s.action === 'click')).toHaveLength(0);
    expect(picks(sent)).toHaveLength(1);
    expect(seen).toEqual([]);
  });

  it('assert mode records the assertion and swallows the click', () => {
    document.body.innerHTML = '<button id="del">Delete</button>';
    const del = document.getElementById('del');
    const seen = pageSpy(del);
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    send({ type: 'SET_ASSERT_MODE', on: true, assertType: 'toBeVisible' });
    fullClick(del);

    expect(recorded(sent).filter((s) => s.action === 'assert')).toHaveLength(1);
    expect(seen).toEqual([]);
  });

  it('Alt+Click records a hover and swallows the click', () => {
    document.body.innerHTML = '<a id="dl" href="#file">Download</a>';
    const dl = document.getElementById('dl');
    const seen = pageSpy(dl);
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    fullClick(dl, { altKey: true });

    expect(recorded(sent).map((s) => s.action)).toContain('hover');
    expect(seen).toEqual([]);
  });

  describe('untrusted (script-dispatched) events', () => {
    beforeEach(() => {
      globalThis.__LocatraTrustSyntheticEvents = false;
    });
    afterEach(() => {
      globalThis.__LocatraTrustSyntheticEvents = true;
      vi.useRealTimers();
    });

    it('a page calling el.click() while inspecting picks nothing and is not blocked', () => {
      document.body.innerHTML = '<button id="go">Go</button>';
      const go = document.getElementById('go');
      const seen = pageSpy(go);
      const sent = captureAll();
      send({ type: 'START_INSPECT' });
      pointAt(document.body);
      go.click();

      expect(picks(sent)).toHaveLength(0);
      expect(seen).toEqual(['click']);
    });

    it('the recorder ignores script-driven input and change events', () => {
      vi.useFakeTimers();
      document.body.innerHTML =
        '<input id="q" aria-label="Search"><input type="checkbox" id="c" aria-label="C">';
      const sent = captureAll();
      send({ type: 'START_RECORDING' });
      typeInto(document.getElementById('q'), 'prefilled by a script');
      const c = document.getElementById('c');
      c.checked = true;
      c.dispatchEvent(new window.Event('change', { bubbles: true }));
      vi.advanceTimersByTime(1000);

      expect(recorded(sent).filter((s) => ['fill', 'check'].includes(s.action))).toHaveLength(0);
    });
  });
});

describe('F9/F10 · Selector Lab highlights', () => {
  it('never adds a class, so generated CSS locators cannot pick one up', () => {
    document.body.innerHTML = '<div class="card"><span class="price">9</span></div>';
    const price = document.querySelector('.price');
    send({ type: 'LAB_VALIDATE', selector: '.price' });
    expect(price.className).toBe('price');
    const sent = captureAll();
    send({ type: 'START_INSPECT' });
    pointAt(price);
    price.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const all = JSON.stringify(picks(sent)[0].locators);
    expect(all).not.toContain('ll-lab-highlight');
  });

  it('restores an element’s own inline outline on clear', () => {
    document.body.innerHTML = '<button id="b" style="outline: 1px solid red">B</button>';
    const b = document.getElementById('b');
    send({ type: 'LAB_VALIDATE', selector: '#b' });
    expect(b.style.getPropertyValue('outline')).toContain('4px');
    send({ type: 'LAB_CLEAR' });
    expect(b.style.getPropertyValue('outline')).toBe('1px solid red');
    expect(b.hasAttribute('data-locatra-lab')).toBe(false);
  });

  it('is visible inside a shadow root (inline style, not a document stylesheet)', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const root = document.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<button class="in-shadow">X</button>';
    send({ type: 'LAB_VALIDATE', selector: '.in-shadow' });
    expect(root.querySelector('button').style.getPropertyValue('outline')).toContain('solid');
  });
});

describe('F11/F21 · context-menu copy', () => {
  afterEach(() => {
    delete globalThis.browser;
    delete navigator.clipboard;
  });

  it('never falls back to a <body> locator — it asks for another right-click', () => {
    document.body.innerHTML = '<button>Go</button>';
    const res = send({ type: 'CONTEXT_MENU_COPY' });
    expect(res).toEqual({ noTarget: true });
    expect(document.getElementById('ll-toast').textContent).toContain('Right-click the element again');
  });

  it('resolves Firefox targetElementId through menus.getTargetElement', async () => {
    document.body.innerHTML = '<button id="go">Place order</button>';
    const go = document.getElementById('go');
    globalThis.browser = { menus: { getTargetElement: (id) => (id === 42 ? go : null) } };
    expect(send({ type: 'CONTEXT_MENU_COPY', targetElementId: 42 })).toEqual({ ok: true });
    await tick();
    expect(document.getElementById('ll-toast').textContent).toContain('Place order');
  });

  it('rapid repeated copies restore the original outline, not the green flash', async () => {
    navigator.clipboard = { writeText: () => Promise.resolve() };
    document.body.innerHTML = '<button id="go" style="outline: 1px solid red">Go</button>';
    const go = document.getElementById('go');
    pointAt(go);
    go.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
    send({ type: 'CONTEXT_MENU_COPY' });
    await tick();
    send({ type: 'CONTEXT_MENU_COPY' });
    await tick();
    await new Promise((r) => setTimeout(r, 900));
    expect(go.style.outline).toBe('1px solid red');
  });
});

describe('F13 · file, range and date inputs', () => {
  afterEach(() => vi.useRealTimers());

  it('a file input records an upload with the file names, and no click', () => {
    document.body.innerHTML = '<input type="file" id="f" aria-label="Resume" multiple>';
    const f = document.getElementById('f');
    Object.defineProperty(f, 'files', { value: [{ name: 'cv.pdf' }, { name: 'photo.png' }] });
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    pointer(f);
    f.dispatchEvent(new window.Event('change', { bubbles: true }));

    const steps = recorded(sent).filter((s) => s.action !== 'goto' && s.action !== 'viewport');
    expect(steps.map((s) => s.action)).toEqual(['upload']);
    expect(JSON.parse(steps[0].value)).toEqual(['cv.pdf', 'photo.png']);
    expect(steps[0].fullCode).toContain('setInputFiles');
  });

  it('a range slider records a fill with its value and inputType on change', () => {
    document.body.innerHTML = '<input type="range" id="r" aria-label="Volume" min="0" max="100">';
    const r = document.getElementById('r');
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    r.value = '42';
    r.dispatchEvent(new window.Event('change', { bubbles: true }));

    const [fill] = recorded(sent).filter((s) => s.action === 'fill');
    expect(fill).toMatchObject({ value: '42', inputType: 'range' });
  });

  it('a date input records a fill carrying inputType', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<input type="date" id="d" aria-label="Start date">';
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    typeInto(document.getElementById('d'), '2024-01-02');
    vi.advanceTimersByTime(600);

    const [fill] = recorded(sent).filter((s) => s.action === 'fill');
    expect(fill).toMatchObject({ value: '2024-01-02', inputType: 'date' });
  });
});

describe('F14 · keyboard capture', () => {
  it('records modifiers (Shift+Tab)', () => {
    document.body.innerHTML = '<input id="q" aria-label="Q">';
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    key(document.getElementById('q'), 'Tab', { shiftKey: true });
    expect(recorded(sent).find((s) => s.action === 'press').value).toBe('Shift+Tab');
  });

  it('ignores keys that are part of an IME composition', () => {
    document.body.innerHTML = '<input id="q" aria-label="Q">';
    const q = document.getElementById('q');
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    key(q, 'Enter', { isComposing: true });
    const legacy = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(legacy, 'keyCode', { value: 229 });
    q.dispatchEvent(legacy);
    expect(recorded(sent).filter((s) => s.action === 'press')).toHaveLength(0);
  });

  it('Space on a button records exactly one step — the press, not a click too', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    const go = document.getElementById('go');
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    key(go, ' ');
    go.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 0 })); // the synthesized activation
    const steps = recorded(sent).filter((s) => s.action !== 'goto' && s.action !== 'viewport');
    expect(steps.map((s) => [s.action, s.value])).toEqual([['press', ' ']]);
  });

  it('Enter on a button records exactly one step', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    const go = document.getElementById('go');
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    key(go, 'Enter');
    go.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 0 }));
    const steps = recorded(sent).filter((s) => s.action !== 'goto' && s.action !== 'viewport');
    expect(steps.map((s) => [s.action, s.value])).toEqual([['press', 'Enter']]);
  });

  it('Space in a text field or on a native checkbox is not recorded as a press', () => {
    document.body.innerHTML = '<input id="q" aria-label="Q"><input type="checkbox" id="c" aria-label="C">';
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    key(document.getElementById('q'), ' ');
    key(document.getElementById('c'), ' ');
    expect(recorded(sent).filter((s) => s.action === 'press')).toHaveLength(0);
  });
});

describe('F15 · assertion values', () => {
  function assertOn(el, assertType) {
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    send({ type: 'SET_ASSERT_MODE', on: true, assertType });
    pointer(el);
    return recorded(sent).find((s) => s.action === 'assert');
  }

  it('toHaveText keeps the full normalized text (no 200-char cut)', () => {
    const text = 'word '.repeat(80).trim(); // 399 chars
    document.body.innerHTML = `<p id="p">  ${text.replace(/ /g, '\n  ')}  </p>`;
    const step = assertOn(document.getElementById('p'), 'toHaveText');
    expect(step.assertType).toBe('toHaveText');
    expect(step.value).toBe(text);
  });

  it('very long text becomes toContainText with a word-trimmed prefix', () => {
    const text = 'lorem ipsum '.repeat(120).trim();
    document.body.innerHTML = `<p id="p">${text}</p>`;
    const step = assertOn(document.getElementById('p'), 'toHaveText');
    expect(step.assertType).toBe('toContainText');
    expect(step.value.length).toBeLessThanOrEqual(200);
    expect(text.startsWith(step.value)).toBe(true);
    expect(step.value.endsWith(' ')).toBe(false);
    expect(step.fullCode).toContain('toContainText(');
  });

  it('toBeChecked reads aria-checked on a role=checkbox widget', () => {
    document.body.innerHTML = '<div role="checkbox" aria-checked="true" aria-label="Remember me"></div>';
    const step = assertOn(document.querySelector('[role=checkbox]'), 'toBeChecked');
    expect(step.value).toBe('true');
    expect(step.fullCode).toContain('.toBeChecked()');
    expect(step.fullCode).not.toContain('not.');
  });
});

describe('F16 · stress test uses Playwright matching semantics', () => {
  it('fails a button whose name is shared with a role=button element of another tag', () => {
    document.body.innerHTML =
      '<button id="a">Checkout</button><div role="button" tabindex="0">Checkout</div>';
    const target = document.getElementById('a');
    pointAt(target);
    target.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
    expect(send({ type: 'RUN_STRESS_TEST' }).data).toMatchObject({ survived: false });
  });
});

describe('F17/F18 · Selector Lab chaining', () => {
  it('chains into a shadow host’s own shadow root', () => {
    document.body.innerHTML = '<div id="card"></div>';
    document.getElementById('card').attachShadow({ mode: 'open' }).innerHTML = '<button>Buy</button>';
    expect(
      send({ type: 'LAB_VALIDATE', selector: "page.locator('#card').getByRole('button', { name: 'Buy' })" })
        .count
    ).toBe(1);
    expect(send({ type: 'LAB_VALIDATE', selector: "page.locator('#card').locator('button')" }).count).toBe(1);
  });

  it('deduplicates matches reached from several chained roots', () => {
    document.body.innerHTML =
      '<div><div><span>x</span></div></div>' + '<div><span>y</span></div>'.repeat(500);
    const t0 = Date.now();
    expect(send({ type: 'LAB_VALIDATE', selector: "page.locator('div').locator('span')" }).count).toBe(501);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe('F19 · double-click', () => {
  it('a dblclick names the two click steps it replaces', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    const go = document.getElementById('go');
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    pointer(go);
    pointer(go);
    go.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));

    const steps = recorded(sent);
    const clicks = steps.filter((s) => s.action === 'click');
    const dbl = steps.find((s) => s.action === 'dblclick');
    expect(clicks).toHaveLength(2);
    expect(dbl.supersedes).toEqual(clicks.map((c) => c.eventId));
  });
});

describe('F22 · frame selectors are unique in the parent document', () => {
  it('does not address a frame by a name another iframe shares', () => {
    document.body.innerHTML = '<iframe name="embed"></iframe>';
    const frame = document.createElement('iframe');
    frame.setAttribute('name', 'embed');
    document.body.appendChild(frame);
    const { w, frameSend, frameSent } = loadIntoFrame(frame);
    w.document.body.innerHTML = '<button>In frame</button>';
    frameSend({ type: 'START_INSPECT' });
    w.document.querySelector('button').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

    const [pick] = picks(frameSent);
    const target = pick.locators[0].target;
    expect(target.kind).toBe('frame');
    expect(target.selector).not.toBe('iframe[name="embed"]');
    const hits = document.querySelectorAll(target.selector);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toBe(frame);
    expect(pick.frameUrl).toBeTruthy();
    frameSend({ type: 'STOP_INSPECT' });
  });
});

describe('F23 · sensitive values (C4) and page URLs (C11)', () => {
  let originalUrl;
  beforeEach(() => {
    originalUrl = window.location.href;
  });
  afterEach(() => {
    window.history.replaceState(null, '', originalUrl);
    vi.useRealTimers();
  });

  it('a password fill never carries the typed value', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<input type="password" id="pw" aria-label="Password">';
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    typeInto(document.getElementById('pw'), 'hunter2');
    vi.advanceTimersByTime(600);

    const [fill] = recorded(sent).filter((s) => s.action === 'fill');
    expect(fill).toMatchObject({ value: '', sensitive: true, secretName: 'LOCATRA_PASSWORD' });
    expect(fill.fullCode).toContain("process.env.LOCATRA_PASSWORD ?? ''");
    expect(JSON.stringify(sent)).not.toContain('hunter2');
  });

  it('a one-time-code / card field is masked as LOCATRA_SECRET', () => {
    document.body.innerHTML = '<input id="cc" autocomplete="cc-number" aria-label="Card">';
    const cc = document.getElementById('cc');
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    cc.value = '4111111111111111';
    cc.dispatchEvent(new window.Event('change', { bubbles: true }));

    const [fill] = recorded(sent).filter((s) => s.action === 'fill');
    expect(fill).toMatchObject({ value: '', sensitive: true, secretName: 'LOCATRA_SECRET' });
    expect(JSON.stringify(sent)).not.toContain('4111111111111111');
  });

  it('redacts token/password URL params in goto, step.url and the pick’s pageUrl', () => {
    window.history.replaceState(null, '', '/cb?access_token=abc123&q=shoes#id_token=xyz789');
    document.body.innerHTML = '<button id="go">Go</button>';
    const go = document.getElementById('go');
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    send({ type: 'START_INSPECT' });
    pointAt(go);
    go.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    const goto = recorded(sent).find((s) => s.action === 'goto');
    expect(goto.value).toContain('access_token=REDACTED');
    expect(goto.value).toContain('q=shoes');
    expect(goto.value).toContain('id_token=REDACTED');
    expect(goto.url).toContain('access_token=REDACTED');
    const [pick] = picks(sent);
    expect(pick.pageUrl).toContain('access_token=REDACTED');
    expect(pick.frameUrl).toContain('access_token=REDACTED');
    expect(JSON.stringify(sent)).not.toMatch(/abc123|xyz789/);
  });
});

describe('F24 · iframes inside shadow DOM get the content script', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const frameRequests = (sent) => sent.filter((m) => m.type === 'REQUEST_FRAME_INJECTION').length;
  /** MutationObserver delivery (microtasks), then the request debounce. */
  async function settle(ms = 400) {
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(ms);
  }
  function shadowHost(tag = 'pay-widget', parent = document.body) {
    const host = document.createElement(tag);
    parent.appendChild(host);
    return { host, root: host.attachShadow({ mode: 'open' }) };
  }

  it('an iframe added to a shadow root that existed when Inspect started', async () => {
    const { root } = shadowHost();
    const sent = captureAll();
    send({ type: 'START_INSPECT' });
    root.appendChild(document.createElement('iframe'));
    await settle();
    expect(frameRequests(sent)).toBe(1);
  });

  it('an iframe added to a shadow root attached after the host was inserted (late upgrade)', async () => {
    const host = document.createElement('pay-widget');
    document.body.appendChild(host);
    const sent = captureAll();
    send({ type: 'START_RECORDING' });
    // A custom element upgrading later: attachShadow fires no mutation anywhere.
    const root = host.attachShadow({ mode: 'open' });
    await settle(1100); // the upgrade poll adopts the new root
    expect(frameRequests(sent)).toBe(0);
    root.appendChild(document.createElement('iframe'));
    await settle();
    expect(frameRequests(sent)).toBe(1);
    send({ type: 'STOP_RECORDING' });
  });

  it('a late-attached shadow root that already holds an iframe when it is found', async () => {
    const host = document.createElement('chat-widget');
    document.body.appendChild(host);
    const sent = captureAll();
    send({ type: 'START_INSPECT' });
    host.attachShadow({ mode: 'open' }).innerHTML = '<div><iframe src="/chat"></iframe></div>';
    await settle(1400);
    expect(frameRequests(sent)).toBe(1);
  });

  it('a host whose shadow root is attached later is noticed when its light DOM changes', async () => {
    const host = document.createElement('div'); // not a custom element: never polled
    document.body.appendChild(host);
    const sent = captureAll();
    send({ type: 'START_INSPECT' });
    const root = host.attachShadow({ mode: 'open' });
    host.appendChild(document.createElement('span'));
    await settle();
    root.appendChild(document.createElement('iframe'));
    await settle();
    expect(frameRequests(sent)).toBe(1);
  });

  it('an iframe added to a nested shadow root (present at start)', async () => {
    const { root: outer } = shadowHost('app-shell');
    const { root: inner } = shadowHost('pay-widget', outer);
    const sent = captureAll();
    send({ type: 'START_INSPECT' });
    inner.appendChild(document.createElement('iframe'));
    await settle();
    expect(frameRequests(sent)).toBe(1);
  });

  it('nested shadow roots inside a subtree added after start are watched', async () => {
    const sent = captureAll();
    send({ type: 'START_INSPECT' });
    const wrap = document.createElement('section');
    const outerHost = document.createElement('app-shell');
    const outer = outerHost.attachShadow({ mode: 'open' });
    const innerHost = document.createElement('pay-widget');
    outer.appendChild(innerHost);
    const inner = innerHost.attachShadow({ mode: 'open' });
    wrap.appendChild(outerHost);
    document.body.appendChild(wrap);
    await settle();
    expect(frameRequests(sent)).toBe(0); // no frame yet
    inner.appendChild(document.createElement('iframe'));
    await settle();
    expect(frameRequests(sent)).toBe(1);
  });

  it('a host inserted with an iframe already in its shadow root', async () => {
    const sent = captureAll();
    send({ type: 'START_INSPECT' });
    const host = document.createElement('pay-widget');
    host.attachShadow({ mode: 'open' }).innerHTML = '<iframe></iframe>';
    document.body.appendChild(host);
    await settle();
    expect(frameRequests(sent)).toBe(1);
  });

  it('an iframe re-pointed (src change) inside a shadow root', async () => {
    const { root } = shadowHost();
    root.innerHTML = '<iframe src="/a"></iframe>';
    const sent = captureAll();
    send({ type: 'START_INSPECT' });
    await settle();
    expect(frameRequests(sent)).toBe(0);
    root.querySelector('iframe').setAttribute('src', '/b');
    await settle();
    expect(frameRequests(sent)).toBe(1);
  });

  it('an iframe navigating on its own inside a shadow root (load does not leave the root)', async () => {
    const { root } = shadowHost();
    root.innerHTML = '<iframe></iframe>';
    const sent = captureAll();
    send({ type: 'START_INSPECT' });
    await settle();
    root.querySelector('iframe').dispatchEvent(new window.Event('load'));
    await settle();
    expect(frameRequests(sent)).toBe(1);
  });

  it('one request per burst, across light DOM and several shadow roots', async () => {
    const { root: a } = shadowHost('pay-widget');
    const { root: b } = shadowHost('chat-widget');
    const sent = captureAll();
    send({ type: 'START_INSPECT' });
    a.appendChild(document.createElement('iframe'));
    b.appendChild(document.createElement('iframe'));
    document.body.appendChild(document.createElement('iframe'));
    await settle(100);
    a.appendChild(document.createElement('iframe'));
    await settle(400);
    expect(frameRequests(sent)).toBe(1);
  });

  it('does not watch shadow roots while idle', async () => {
    const { root } = shadowHost();
    const sent = captureAll();
    root.appendChild(document.createElement('iframe'));
    root.querySelector('iframe').dispatchEvent(new window.Event('load'));
    await settle(2000);
    expect(frameRequests(sent)).toBe(0);
  });

  it('stop disconnects every observer, listener and timer', async () => {
    const { host, root } = shadowHost();
    const { root: nested } = shadowHost('x-inner', root);
    const late = document.createElement('late-widget'); // polled for an upgrade
    document.body.appendChild(late);
    const balance = new Map();
    for (const r of [root, nested]) {
      const add = r.addEventListener.bind(r);
      const remove = r.removeEventListener.bind(r);
      r.addEventListener = (type, fn, opts) => {
        if (type === 'load') balance.set(r, (balance.get(r) || 0) + 1);
        add(type, fn, opts);
      };
      r.removeEventListener = (type, fn, opts) => {
        if (type === 'load') balance.set(r, (balance.get(r) || 0) - 1);
        remove(type, fn, opts);
      };
    }
    const sent = captureAll();
    send({ type: 'START_INSPECT' });
    send({ type: 'START_RECORDING' });
    expect(balance.get(root)).toBe(1);
    expect(balance.get(nested)).toBe(1);
    send({ type: 'STOP_INSPECT' });
    send({ type: 'STOP_RECORDING' });
    expect(balance.get(root)).toBe(0);
    expect(balance.get(nested)).toBe(0);
    expect(vi.getTimerCount()).toBe(0); // no upgrade poll or pending request left behind

    root.appendChild(document.createElement('iframe'));
    nested.appendChild(document.createElement('iframe'));
    root.querySelector('iframe').dispatchEvent(new window.Event('load'));
    late.attachShadow({ mode: 'open' }).innerHTML = '<iframe></iframe>';
    host.setAttribute('data-x', '1');
    await settle(3000);
    expect(frameRequests(sent)).toBe(0);
  });

  it('an orphaned instance tears its shadow-root watchers down too', async () => {
    const { root } = shadowHost();
    let loadListeners = 0;
    const add = root.addEventListener.bind(root);
    const remove = root.removeEventListener.bind(root);
    root.addEventListener = (type, fn, opts) => {
      if (type === 'load') loadListeners++;
      add(type, fn, opts);
    };
    root.removeEventListener = (type, fn, opts) => {
      if (type === 'load') loadListeners--;
      remove(type, fn, opts);
    };
    const sent = captureAll();
    send({ type: 'START_INSPECT' });
    expect(loadListeners).toBe(1);
    // Extension reloaded under the page: the old context is gone and the next
    // message attempt dismantles the instance.
    delete chrome.runtime.id;
    window.__LocatorLensInstance.teardown();
    expect(loadListeners).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    root.appendChild(document.createElement('iframe'));
    await settle(2000);
    expect(frameRequests(sent)).toBe(0);
  });
});

describe('F25 · frame selectors for an <iframe> inside a shadow root', () => {
  /**
   * jsdom gives an iframe inside a shadow root no window, so the scripts run in a
   * light-DOM carrier frame whose frameElement is pointed at the shadow-hosted one —
   * which is all frameChain() reads.
   */
  function pickInShadowFrame(shadowFrame) {
    const carrier = document.createElement('iframe');
    carrier.setAttribute('data-carrier', '');
    document.body.appendChild(carrier);
    const { w, frameSend, frameSent } = loadIntoFrame(carrier);
    Object.defineProperty(w, 'frameElement', { configurable: true, get: () => shadowFrame });
    w.document.body.innerHTML = '<button>Pay</button>';
    frameSend({ type: 'START_INSPECT' });
    w.document.querySelector('button').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    frameSend({ type: 'STOP_INSPECT' });
    const [pick] = picks(frameSent);
    return pick;
  }

  it('does not use an id that another element in the composed tree shares', () => {
    document.body.innerHTML = '<div id="pay">light</div><pay-widget></pay-widget>';
    const root = document.querySelector('pay-widget').attachShadow({ mode: 'open' });
    root.innerHTML = '<iframe id="pay"></iframe>';
    const pick = pickInShadowFrame(root.querySelector('iframe'));
    const target = pick.locators[0].target;
    expect(target.kind).toBe('frame');
    // `#pay` is unique inside the shadow root, but Playwright's CSS pierces it and
    // would match both.
    expect(target.selector).toBe('html > body > pay-widget > iframe');
    // Selenium/Cypress walk it per tree, where `#pay` is unique inside the root.
    expect(target.shadowPath).toEqual(['pay-widget', '#pay']);
    expect(pick.locators[0].code).toContain("frameLocator('html > body > pay-widget > iframe')");
    expect(pick.proTip).toMatch(/shadow root/);
  });

  it('uses the iframe’s own id when it is unique across every shadow root', () => {
    document.body.innerHTML = '<pay-widget></pay-widget>';
    const root = document.querySelector('pay-widget').attachShadow({ mode: 'open' });
    root.innerHTML = '<iframe id="checkout-frame"></iframe>';
    const pick = pickInShadowFrame(root.querySelector('iframe'));
    expect(pick.locators[0].target.selector).toBe('#checkout-frame');
  });

  it('walks up through nested hosts to a unique id anchor, counting nth-of-type in each tree', () => {
    document.body.innerHTML = '<div id="shell"></div>';
    const outer = document.getElementById('shell').attachShadow({ mode: 'open' });
    outer.innerHTML = '<x-pay></x-pay>';
    const inner = outer.querySelector('x-pay').attachShadow({ mode: 'open' });
    inner.innerHTML = '<iframe name="embed"></iframe><iframe name="embed"></iframe>';
    const pick = pickInShadowFrame(inner.querySelectorAll('iframe')[1]);
    const target = pick.locators[0].target;
    expect(target.selector).toBe('#shell > x-pay > iframe:nth-of-type(2)');
    expect(target.shadowPath).toEqual(['#shell', 'x-pay', 'iframe:nth-of-type(2)']);
    expect(pick.proTip).toMatch(/getShadowRoot\(\) \/ \.shadow\(\)/);
  });

  it('a closed shadow root gets no shadowPath: no test tool can walk into it', () => {
    document.body.innerHTML = '<pay-widget></pay-widget>';
    const root = document.querySelector('pay-widget').attachShadow({ mode: 'closed' });
    root.innerHTML = '<iframe></iframe>';
    const pick = pickInShadowFrame(root.querySelector('iframe'));
    expect(pick.locators[0].target.kind).toBe('frame');
    expect(pick.locators[0].target.shadowPath).toBeUndefined();
    expect(pick.proTip).toMatch(/Cypress needs includeShadowDom/);
  });

  it('the Selenium and Cypress code for the pick walks the shadow path', () => {
    document.body.innerHTML = '<x-ad></x-ad><pay-widget></pay-widget>';
    document.querySelector('x-ad').attachShadow({ mode: 'open' }).innerHTML = '<iframe></iframe>';
    const root = document.querySelector('pay-widget').attachShadow({ mode: 'open' });
    root.innerHTML = '<div><iframe></iframe></div>';
    const target = pickInShadowFrame(root.querySelector('iframe')).locators[0].target;
    expect(target.shadowPath).toEqual(['pay-widget', 'iframe']);
    const py = globalThis.LLCodegen.actionStatement({ action: 'click', target }, 'selenium', 'python');
    expect(py.split('\n')[0]).toBe(
      'driver.switch_to.frame(driver.find_element(By.CSS_SELECTOR, "pay-widget")' +
        '.shadow_root.find_element(By.CSS_SELECTOR, "iframe"))'
    );
    expect(globalThis.LLCodegen.locatorExpr(target, 'cypress', 'javascript')).toMatch(
      /^cy\.get\('pay-widget'\)\.shadow\(\)\.find\('iframe'\)\.its\('0\.contentDocument\.body'\)/
    );
  });

  it('a light-DOM frame’s id is checked against shadow roots as well', () => {
    document.body.innerHTML = '<x-ad></x-ad>';
    document.querySelector('x-ad').attachShadow({ mode: 'open' }).innerHTML = '<iframe id="embed"></iframe>';
    const frame = document.createElement('iframe');
    frame.id = 'embed';
    document.body.appendChild(frame);
    const { w, frameSend, frameSent } = loadIntoFrame(frame);
    w.document.body.innerHTML = '<button>In frame</button>';
    frameSend({ type: 'START_INSPECT' });
    w.document.querySelector('button').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    frameSend({ type: 'STOP_INSPECT' });
    const target = picks(frameSent)[0].locators[0].target;
    const selector = target.selector;
    expect(selector).not.toBe('#embed');
    expect('shadowPath' in target).toBe(false); // light-DOM frame: target shape unchanged
    const hits = document.querySelectorAll(selector);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toBe(frame);
  });
});
