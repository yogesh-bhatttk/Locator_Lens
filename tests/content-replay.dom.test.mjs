// @vitest-environment jsdom
//
// F1 · in-page replay. BACKGROUND sends every REPLAY_STEP to all frames of the tab;
// the content script decides whether it owns the step, waits for exactly one
// actionable element, performs the action (or evaluates the assertion) with
// synthetic events, and answers { ok, error?, matchCount, skipped? }.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_SCRIPTS = ['src/codegen.js', 'src/content-locator-engine.js', 'src/content.js'];

let handlers = [];
let sent = [];
const allHandlers = [];
// C5: how BACKGROUND answers a REPLAY_SECRET_REQUEST — (msg, reply) => void; the
// default refuses, a test that leaves `reply` uncalled models no answer at all.
let secretResponder = (msg, reply) => reply({ ok: false });

function load() {
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
  globalThis.__LocatraTrustSyntheticEvents = true;
  globalThis.chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      sendMessage: (msg, reply) => {
        sent.push(msg);
        if (msg.type === 'REPLAY_SECRET_REQUEST' && reply) secretResponder(msg, reply);
      },
      onMessage: {
        addListener: (fn) => {
          handlers.push(fn);
          allHandlers.push(fn);
        },
      },
    },
    storage: {
      local: { get: (keys, cb) => cb({}) },
      onChanged: { addListener: () => {} },
    },
  };
  secretResponder = (msg, reply) => reply({ ok: false });
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

/**
 * Deliver a REPLAY_STEP to every listener in `hs`, as chrome.tabs.sendMessage
 * does. Resolves with the first answer, or { unanswered, returned } when no
 * listener calls sendResponse (the handler's return values are kept).
 */
function replayVia(hs, step, extra = {}) {
  const msg = {
    type: 'REPLAY_STEP',
    runId: 'run-1',
    index: 0,
    step,
    timeoutMs: 300,
    highlight: false,
    ...extra,
  };
  return new Promise((done) => {
    let answered = false;
    const returned = hs.map((h) =>
      h(msg, {}, (r) => {
        if (!answered) {
          answered = true;
          done(r);
        }
      })
    );
    if (!returned.includes(true) && !answered) done({ unanswered: true, returned });
  });
}
const replay = (step, extra) => replayVia(handlers, step, extra);

const role = (r, name, extra = {}) => ({ kind: 'role', role: r, name, ...extra });
const recorded = () => sent.filter((m) => m.type === 'RECORDED_ACTION').map((m) => m.data);

/** Every event of the given types that reaches `el`, in order. */
function spy(el, types) {
  const seen = [];
  types.forEach((t) => el.addEventListener(t, (e) => seen.push(e.type + (e.key ? ':' + e.key : ''))));
  return seen;
}

function loadIntoFrame(frame) {
  const w = frame.contentWindow;
  const frameHandlers = [];
  w.__LocatraTrustSyntheticEvents = true;
  w.chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      sendMessage: () => {},
      onMessage: { addListener: (fn) => frameHandlers.push(fn) },
    },
    storage: { local: { get: (k, cb) => cb({}) }, onChanged: { addListener: () => {} } },
  };
  // runInContext (not w.eval) so coverage attributes the frame's run to src/.
  for (const file of CONTENT_SCRIPTS)
    vm.runInContext(readFileSync(join(ROOT, file), 'utf8'), w, { filename: file });
  return { w, frameHandlers };
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  load();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('frame ownership', () => {
  it('the top frame answers a step whose target is not frame-wrapped', async () => {
    document.body.innerHTML = '<button>Go</button>';
    const res = await replay({ action: 'click', target: role('button', 'Go') });
    expect(res).toEqual({ ok: true, matchCount: 1 });
  });

  it('the top frame stays silent (returns false, never responds) for a frame step', async () => {
    document.body.innerHTML = '<button>Go</button>';
    const res = await replay({
      action: 'click',
      target: { kind: 'frame', selector: '#pay', index: 0, child: role('button', 'Go') },
    });
    expect(res.unanswered).toBe(true);
    expect(res.returned).toEqual([false]);
  });

  it('a frame answers only steps wrapped in its own frame path', async () => {
    document.body.innerHTML = '<iframe id="pay"></iframe><iframe id="other"></iframe>';
    const pay = loadIntoFrame(document.getElementById('pay'));
    const other = loadIntoFrame(document.getElementById('other'));
    pay.w.document.body.innerHTML = '<button>Pay now</button>';
    other.w.document.body.innerHTML = '<button>Pay now</button>';
    const clicks = [];
    pay.w.document.querySelector('button').addEventListener('click', () => clicks.push('pay'));
    other.w.document.querySelector('button').addEventListener('click', () => clicks.push('other'));

    const step = {
      action: 'click',
      target: { kind: 'frame', selector: '#pay', index: 0, child: role('button', 'Pay now') },
    };
    const everyone = [...handlers, ...pay.frameHandlers, ...other.frameHandlers];
    const res = await replayVia(everyone, step);
    expect(res).toEqual({ ok: true, matchCount: 1 });
    expect(clicks).toEqual(['pay']);

    // An unwrapped target belongs to the top document, never to a frame.
    const top = await replayVia(pay.frameHandlers, { action: 'click', target: role('button', 'Pay now') });
    expect(top.unanswered).toBe(true);
  });

  it('accepts a recorded selector that differs textually but still addresses the frame', async () => {
    document.body.innerHTML = '<div id="wrap"><iframe id="pay" name="card"></iframe></div>';
    const pay = loadIntoFrame(document.getElementById('pay'));
    pay.w.document.body.innerHTML = '<button>Pay</button>';
    const ok = await replayVia(pay.frameHandlers, {
      action: 'click',
      target: { kind: 'frame', selector: 'iframe[name="card"]', index: 0, child: role('button', 'Pay') },
    });
    expect(ok.ok).toBe(true);
    const wrongSelector = await replayVia(pay.frameHandlers, {
      action: 'click',
      target: { kind: 'frame', selector: 'iframe[name="other"]', index: 0, child: role('button', 'Pay') },
    });
    expect(wrongSelector.unanswered).toBe(true);
    const tooDeep = await replayVia(pay.frameHandlers, {
      action: 'click',
      target: {
        kind: 'frame',
        selector: '#pay',
        index: 0,
        child: { kind: 'frame', selector: '#inner', index: 0, child: role('button', 'Pay') },
      },
    });
    expect(tooDeep.unanswered).toBe(true);
  });

  it('a cross-origin frame path (no selector) is matched by index', async () => {
    document.body.innerHTML = '<iframe></iframe><iframe></iframe>';
    const second = loadIntoFrame(document.querySelectorAll('iframe')[1]);
    second.w.document.body.innerHTML = '<button>Ok</button>';
    const mine = await replayVia(second.frameHandlers, {
      action: 'click',
      target: { kind: 'frame', selector: null, index: 1, child: role('button', 'Ok') },
    });
    expect(mine.ok).toBe(true);
    const notMine = await replayVia(second.frameHandlers, {
      action: 'click',
      target: { kind: 'frame', selector: null, index: 0, child: role('button', 'Ok') },
    });
    expect(notMine.unanswered).toBe(true);
  });

  it('a press belongs to the frame holding keyboard focus', async () => {
    document.body.innerHTML = '<iframe id="f"></iframe><input id="top">';
    const frame = loadIntoFrame(document.getElementById('f'));
    frame.w.document.body.innerHTML = '<input id="inner">';
    const step = { action: 'press', value: 'Escape', target: null };

    document.getElementById('top').focus();
    expect((await replayVia(handlers, step)).ok).toBe(true);
    expect((await replayVia(frame.frameHandlers, step)).unanswered).toBe(true);

    frame.w.document.getElementById('inner').focus();
    document.getElementById('f').focus();
    expect((await replayVia(handlers, step)).unanswered).toBe(true);
    expect((await replayVia(frame.frameHandlers, step)).ok).toBe(true);
  });

  it('ignores a malformed message instead of answering', async () => {
    const res = await replayVia(handlers, null);
    expect(res.unanswered).toBe(true);
  });
});

describe('auto-wait, strictness, visibility and enabled checks', () => {
  it('waits for an element that appears later', async () => {
    setTimeout(() => {
      document.body.innerHTML = '<button>Later</button>';
    }, 150);
    const res = await replay({ action: 'click', target: role('button', 'Later') }, { timeoutMs: 1000 });
    expect(res).toEqual({ ok: true, matchCount: 1 });
  });

  it('fails with the locator when nothing matches before the timeout', async () => {
    const res = await replay({ action: 'click', target: role('button', 'Missing') });
    expect(res).toEqual({
      ok: false,
      error: "no element matches page.getByRole('button', { name: 'Missing' })",
      matchCount: 0,
    });
  });

  it('fails at once on a strict-mode violation', async () => {
    document.body.innerHTML = '<button>Save</button><button>Save</button>';
    const t0 = Date.now();
    const res = await replay({ action: 'click', target: role('button', 'Save') }, { timeoutMs: 5000 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(res).toEqual({
      ok: false,
      error: "2 elements match page.getByRole('button', { name: 'Save' }) (strict mode)",
      matchCount: 2,
    });
  });

  it('reports a hidden element as not visible', async () => {
    document.body.innerHTML = '<div style="display:none"><input id="q" aria-label="Q"></div>';
    const res = await replay({ action: 'fill', value: 'x', target: { kind: 'id', value: 'q' } });
    expect(res).toEqual({ ok: false, error: 'element is not visible', matchCount: 1 });
  });

  it('reports a disabled element, and waits for it to become enabled', async () => {
    document.body.innerHTML = '<button disabled>Send</button>';
    const res = await replay({ action: 'click', target: role('button', 'Send') });
    expect(res).toEqual({ ok: false, error: 'element is disabled', matchCount: 1 });

    const btn = document.querySelector('button');
    let clicked = 0;
    btn.addEventListener('click', () => clicked++);
    setTimeout(() => btn.removeAttribute('disabled'), 120);
    const later = await replay({ action: 'click', target: role('button', 'Send') }, { timeoutMs: 1000 });
    expect(later.ok).toBe(true);
    expect(clicked).toBe(1);
  });

  it('treats aria-disabled on an ancestor as disabled', async () => {
    document.body.innerHTML = '<div aria-disabled="true"><span role="button">Act</span></div>';
    const res = await replay({ action: 'click', target: role('button', 'Act') });
    expect(res.error).toBe('element is disabled');
  });

  it('hover does not require the element to be enabled', async () => {
    document.body.innerHTML = '<button disabled>Tip</button>';
    const res = await replay({ action: 'hover', target: role('button', 'Tip') });
    expect(res.ok).toBe(true);
  });
});

describe('actions', () => {
  it('click fires pointer/mouse down, up and exactly one click, and focuses the control', async () => {
    document.body.innerHTML = '<button>Buy</button>';
    const btn = document.querySelector('button');
    const seen = spy(btn, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    const res = await replay({ action: 'click', target: role('button', 'Buy') });
    expect(res.ok).toBe(true);
    expect(seen).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    expect(document.activeElement).toBe(btn);
  });

  it('a cancelled pointerdown suppresses the mouse events but still clicks', async () => {
    document.body.innerHTML = '<button>Buy</button>';
    const btn = document.querySelector('button');
    btn.addEventListener('pointerdown', (e) => e.preventDefault());
    const seen = spy(btn, ['mousedown', 'mouseup', 'click']);
    await replay({ action: 'click', target: role('button', 'Buy') });
    expect(seen).toEqual(['click']);
  });

  it('clicking a non-focusable element blurs the focused field', async () => {
    document.body.innerHTML = '<input id="a" aria-label="A"><p id="p">Text here</p>';
    document.getElementById('a').focus();
    await replay({ action: 'click', target: { kind: 'id', value: 'p' } });
    expect(document.activeElement).toBe(document.body);
  });

  it('dblclick fires two clicks and a dblclick', async () => {
    document.body.innerHTML = '<div id="cell" tabindex="0">Cell</div>';
    const seen = spy(document.getElementById('cell'), ['click', 'dblclick']);
    const res = await replay({ action: 'dblclick', target: { kind: 'id', value: 'cell' } });
    expect(res.ok).toBe(true);
    expect(seen).toEqual(['click', 'click', 'dblclick']);
  });

  it('fill uses the native value setter and fires input + change', async () => {
    document.body.innerHTML = '<label>Email <input id="e"></label>';
    const input = document.getElementById('e');
    // A React-style tracker on the instance: writing through it would hide the change.
    const writes = [];
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    Object.defineProperty(input, 'value', {
      configurable: true,
      get() {
        return desc.get.call(this);
      },
      set(v) {
        writes.push(v);
        desc.set.call(this, v);
      },
    });
    expect(proto).toBe(window.HTMLInputElement.prototype);
    const events = [];
    input.addEventListener('input', (e) => events.push(['input', e.target.value]));
    input.addEventListener('change', (e) => events.push(['change', e.target.value]));

    const res = await replay({ action: 'fill', value: 'a@b.co', target: { kind: 'label', value: 'Email' } });
    expect(res).toEqual({ ok: true, matchCount: 1 });
    expect(input.value).toBe('a@b.co');
    expect(writes).toEqual([]);
    expect(events).toEqual([
      ['input', 'a@b.co'],
      ['change', 'a@b.co'],
    ]);
    expect(document.activeElement).toBe(input);
  });

  it('fill sets textContent on a contenteditable', async () => {
    document.body.innerHTML = '<div id="ed" contenteditable="true">old</div>';
    const ed = document.getElementById('ed');
    // jsdom does not implement isContentEditable.
    Object.defineProperty(ed, 'isContentEditable', { value: true });
    const seen = spy(ed, ['input', 'change']);
    const res = await replay({ action: 'fill', value: 'new text', target: { kind: 'id', value: 'ed' } });
    expect(res.ok).toBe(true);
    expect(ed.textContent).toBe('new text');
    expect(seen).toEqual(['input']);
  });

  it('fill refuses non-fields, read-only fields and rejected special values', async () => {
    document.body.innerHTML =
      '<button id="b">B</button><input id="r" readonly><input id="d" type="date"><input id="c" type="checkbox">';
    expect((await replay({ action: 'fill', value: 'x', target: { kind: 'id', value: 'b' } })).error).toBe(
      'element is not an <input>, <textarea> or [contenteditable] element'
    );
    expect((await replay({ action: 'fill', value: 'x', target: { kind: 'id', value: 'c' } })).error).toBe(
      'element is not an <input>, <textarea> or [contenteditable] element'
    );
    expect((await replay({ action: 'fill', value: 'x', target: { kind: 'id', value: 'r' } })).error).toBe(
      'element is not editable (readonly)'
    );
    expect(
      (await replay({ action: 'fill', value: 'not a date', target: { kind: 'id', value: 'd' } })).error
    ).toBe('the <input type=date> rejected the value');
    expect(
      (await replay({ action: 'fill', value: '2024-05-06', target: { kind: 'id', value: 'd' } })).ok
    ).toBe(true);
    expect(document.getElementById('d').value).toBe('2024-05-06');
  });

  it('a sensitive fill asks BACKGROUND for its secret and is skipped without one (C5)', async () => {
    document.body.innerHTML = '<label>Password <input type="password" id="pw"></label>';
    const step = {
      action: 'fill',
      value: '',
      sensitive: true,
      secretName: 'LOCATRA_PASSWORD',
      target: { kind: 'label', value: 'Password' },
    };
    const skippedAs = { ok: false, skipped: true, error: 'no value provided', matchCount: 0 };
    // Refused, an empty value, a malformed answer, or an error from the channel.
    for (const answer of [{ ok: false }, { ok: true, value: '' }, { ok: true, value: 42 }, undefined]) {
      secretResponder = (msg, reply) => reply(answer);
      expect(await replay(step, { runId: 'run-7', index: 3 })).toEqual(skippedAs);
    }
    expect(sent.filter((m) => m.type === 'REPLAY_SECRET_REQUEST')).toEqual(
      Array(4).fill({ type: 'REPLAY_SECRET_REQUEST', runId: 'run-7', index: 3 })
    );
    // Secrets riding on the REPLAY_STEP itself are no longer read.
    expect(await replay(step, { secrets: { LOCATRA_PASSWORD: 'from-the-message' } })).toEqual(skippedAs);
    expect(document.getElementById('pw').value).toBe('');

    secretResponder = (msg, reply) => reply({ ok: true, value: 's3cret!' });
    const ok = await replay(step);
    expect(ok).toEqual({ ok: true, matchCount: 1 });
    expect(document.getElementById('pw').value).toBe('s3cret!');
  });

  it('a secret request nobody answers times out as a missing secret', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<label>Password <input type="password" id="pw"></label>';
    let late = null;
    secretResponder = (msg, reply) => (late = reply); // answers only after the deadline
    const pending = replay({
      action: 'fill',
      value: '',
      sensitive: true,
      target: { kind: 'label', value: 'Password' },
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toMatchObject({ skipped: true, error: 'no value provided' });
    late({ ok: true, value: 'too-late' });
    expect(document.getElementById('pw').value).toBe('');
  });

  it('a secret request that cannot be sent (extension gone) is a missing secret', async () => {
    document.body.innerHTML = '<label>Password <input type="password" id="pw"></label>';
    globalThis.chrome.runtime.sendMessage = () => {
      throw new Error('Extension context invalidated.');
    };
    const res = await replay({
      action: 'fill',
      value: '',
      sensitive: true,
      target: { kind: 'label', value: 'Password' },
    });
    expect(res).toMatchObject({ skipped: true, error: 'no value provided' });
  });

  it('only the frame that owns a sensitive step asks for its secret', async () => {
    document.body.innerHTML = '<iframe id="pay"></iframe>';
    const res = await replay({
      action: 'fill',
      value: '',
      sensitive: true,
      target: { kind: 'frame', selector: '#pay', index: 0, child: { kind: 'label', value: 'Card' } },
    });
    expect(res.unanswered).toBe(true);
    expect(sent.some((m) => m.type === 'REPLAY_SECRET_REQUEST')).toBe(false);
  });

  it('a sensitive toHaveValue compares against the secret and never prints a value (C2)', async () => {
    document.body.innerHTML = '<label>Code <input id="otp" autocomplete="one-time-code"></label>';
    const otp = document.getElementById('otp');
    otp.value = '123456';
    const step = {
      action: 'assert',
      assertType: 'toHaveValue',
      value: '',
      sensitive: true,
      secretName: 'LOCATRA_SECRET',
      target: { kind: 'label', value: 'Code' },
    };
    secretResponder = (msg, reply) => reply({ ok: true, value: '123456' });
    expect(await replay(step)).toEqual({ ok: true, matchCount: 1 });
    secretResponder = (msg, reply) => reply({ ok: true, value: '999999' });
    const failed = await replay(step);
    expect(failed).toMatchObject({
      ok: false,
      error: "toHaveValue: the field's value does not match LOCATRA_SECRET",
    });
    expect(JSON.stringify(failed)).not.toMatch(/123456|999999/);
    // Without a valid name the panel's key for legacy steps is named instead.
    const legacy = await replay({ ...step, secretName: 'not valid!' });
    expect(legacy.error).toBe("toHaveValue: the field's value does not match LOCATRA_PASSWORD");
    secretResponder = (msg, reply) => reply({ ok: false });
    expect(await replay(step)).toMatchObject({ skipped: true, error: 'no value provided' });
    // A non-sensitive toHaveValue asks for nothing.
    sent.length = 0;
    expect(await replay({ ...step, sensitive: false, value: '123456' })).toEqual({ ok: true, matchCount: 1 });
    expect(sent.some((m) => m.type === 'REPLAY_SECRET_REQUEST')).toBe(false);
  });

  it('selectOption matches the option label first, then its value', async () => {
    document.body.innerHTML =
      '<label>Country <select id="s"><option value="us">United States</option><option value="United Kingdom">Canada</option><option value="uk">United Kingdom</option></select></label>';
    const select = document.getElementById('s');
    const seen = spy(select, ['input', 'change']);
    const byLabel = await replay({
      action: 'selectOption',
      value: 'United Kingdom',
      target: { kind: 'label', value: 'Country' },
    });
    expect(byLabel.ok).toBe(true);
    expect(select.value).toBe('uk'); // the label wins over another option's value
    expect(seen).toEqual(['input', 'change']);

    await replay({ action: 'selectOption', value: 'us', target: { kind: 'label', value: 'Country' } });
    expect(select.value).toBe('us');

    const missing = await replay({
      action: 'selectOption',
      value: 'Mars',
      target: { kind: 'label', value: 'Country' },
    });
    expect(missing).toEqual({ ok: false, error: 'no option "Mars" in the <select>', matchCount: 1 });
  });

  it('selectOption with `values` selects every one of them in a multi-select (C1)', async () => {
    document.body.innerHTML =
      '<select id="m" multiple><option selected>A</option><option>B</option><option label="Sea">C</option></select><select id="one"><option>A</option><option>B</option></select>';
    const m = document.getElementById('m');
    const seen = spy(m, ['input', 'change']);
    const target = { kind: 'id', value: 'm' };
    expect(await replay({ action: 'selectOption', value: 'B', values: ['B', 'Sea'], target })).toEqual({
      ok: true,
      matchCount: 1,
    });
    expect(Array.from(m.selectedOptions).map((o) => o.textContent)).toEqual(['B', 'C']);
    expect(seen).toEqual(['input', 'change']);
    expect((await replay({ action: 'selectOption', value: 'B', values: ['B', 'Mars'], target })).error).toBe(
      'no option "Mars" in the <select>'
    );
    expect(Array.from(m.selectedOptions).map((o) => o.textContent)).toEqual(['B', 'C']); // untouched
    // A single value in `values` is just `value`; several on a plain select are refused.
    expect((await replay({ action: 'selectOption', value: 'A', values: ['A'], target })).ok).toBe(true);
    expect(Array.from(m.selectedOptions).map((o) => o.textContent)).toEqual(['A']);
    expect(
      (
        await replay({
          action: 'selectOption',
          value: 'A',
          values: ['A', 'B'],
          target: { kind: 'id', value: 'one' },
        })
      ).error
    ).toBe('element is not a <select multiple>, it cannot select several options');
  });

  it('selectOption refuses disabled options and non-selects; a multi-select keeps one option', async () => {
    document.body.innerHTML =
      '<select id="m" multiple><option selected>A</option><option>B</option><option disabled>C</option></select><button id="b">B</button>';
    const m = document.getElementById('m');
    expect(
      (await replay({ action: 'selectOption', value: 'C', target: { kind: 'id', value: 'm' } })).error
    ).toBe('option "C" is disabled');
    expect(
      (await replay({ action: 'selectOption', value: 'B', target: { kind: 'id', value: 'm' } })).ok
    ).toBe(true);
    expect(Array.from(m.selectedOptions).map((o) => o.textContent)).toEqual(['B']);
    expect(
      (await replay({ action: 'selectOption', value: 'B', target: { kind: 'id', value: 'b' } })).error
    ).toBe('element is not a <select> element');
  });

  it('check / uncheck toggle a checkbox only when its state differs', async () => {
    document.body.innerHTML = '<label><input type="checkbox" id="c"> Terms</label>';
    const box = document.getElementById('c');
    let clicks = 0;
    box.addEventListener('click', () => clicks++);
    const target = { kind: 'id', value: 'c' };
    expect((await replay({ action: 'check', target })).ok).toBe(true);
    expect(box.checked).toBe(true);
    expect((await replay({ action: 'check', target })).ok).toBe(true);
    expect(clicks).toBe(1);
    expect((await replay({ action: 'uncheck', target })).ok).toBe(true);
    expect(box.checked).toBe(false);
    expect(clicks).toBe(2);
  });

  it('checks an ARIA checkbox by clicking it, and reports when the click does nothing', async () => {
    document.body.innerHTML =
      '<div role="checkbox" aria-checked="false" id="a" tabindex="0">Opt in</div><div role="switch" aria-checked="false" id="dead">Dead</div>';
    const a = document.getElementById('a');
    a.addEventListener('click', () =>
      a.setAttribute('aria-checked', String(a.getAttribute('aria-checked') !== 'true'))
    );
    expect((await replay({ action: 'check', target: { kind: 'id', value: 'a' } })).ok).toBe(true);
    expect(a.getAttribute('aria-checked')).toBe('true');
    expect((await replay({ action: 'check', target: { kind: 'id', value: 'dead' } })).error).toBe(
      'clicking did not check the element'
    );
  });

  it('clicks the visible label of a visually hidden checkbox', async () => {
    document.body.innerHTML =
      '<input type="checkbox" id="c" style="display:none"><label for="c" id="l">Remember me</label>';
    const res = await replay({ action: 'check', target: { kind: 'id', value: 'c' } });
    expect(res.ok).toBe(true);
    expect(document.getElementById('c').checked).toBe(true);
  });

  it('refuses to uncheck a radio or check a non-checkbox', async () => {
    document.body.innerHTML = '<input type="radio" id="r" checked aria-label="R"><button id="b">B</button>';
    expect((await replay({ action: 'uncheck', target: { kind: 'id', value: 'r' } })).error).toBe(
      'cannot uncheck a radio button'
    );
    expect((await replay({ action: 'check', target: { kind: 'id', value: 'b' } })).error).toBe(
      'element is not a checkbox or radio button'
    );
  });

  it('hover fires over/enter/move events', async () => {
    document.body.innerHTML = '<a href="#m" id="menu">Menu</a>';
    const seen = spy(document.getElementById('menu'), [
      'pointerover',
      'pointerenter',
      'mouseover',
      'mouseenter',
      'pointermove',
      'mousemove',
    ]);
    const res = await replay({ action: 'hover', target: role('link', 'Menu') });
    expect(res.ok).toBe(true);
    expect(seen).toEqual([
      'pointerover',
      'pointerenter',
      'mouseover',
      'mouseenter',
      'pointermove',
      'mousemove',
    ]);
  });

  it('upload and viewport steps are skipped with a reason; unknown steps fail', async () => {
    expect(
      await replay({ action: 'upload', value: '["a.png"]', target: { kind: 'id', value: 'f' } })
    ).toEqual({
      ok: false,
      skipped: true,
      error: "file uploads can't be replayed in the browser",
      matchCount: 0,
    });
    expect(await replay({ action: 'viewport', value: '800x600', target: null })).toMatchObject({
      skipped: true,
      error: 'viewport is not changed during replay',
    });
    expect(await replay({ action: 'teleport', target: { kind: 'id', value: 'x' } })).toEqual({
      ok: false,
      error: 'unsupported step "teleport"',
      matchCount: 0,
    });
    expect(await replay({ action: 'click', target: null })).toEqual({
      ok: false,
      error: 'the click step has no locator',
      matchCount: 0,
    });
  });

  it('highlights the element briefly with an overlay that is never matched itself', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    document.body.innerHTML = '<button>Go</button>';
    const p = replay({ action: 'click', target: role('button', 'Go') }, { highlight: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(await p).toEqual({ ok: true, matchCount: 1 });
    const hl = document.getElementById('ll-replay-highlight');
    expect(hl).not.toBeNull();
    expect(hl.style.cssText).toContain('pointer-events: none');

    // A css target that would also match the highlight <div> still matches one element.
    document.body.insertAdjacentHTML('afterbegin', '<div class="x">only</div>');
    const css = replay({
      action: 'assert',
      assertType: 'toBeVisible',
      target: { kind: 'css', value: 'div' },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect((await css).matchCount).toBe(1);

    await vi.advanceTimersByTimeAsync(450);
    expect(document.getElementById('ll-replay-highlight')).toBeNull();
  });
});

describe('press', () => {
  it('fires keydown, keypress and keyup on the focused element', async () => {
    document.body.innerHTML = '<input id="q" aria-label="Q">';
    const q = document.getElementById('q');
    q.focus();
    const seen = spy(q, ['keydown', 'keypress', 'keyup']);
    let keyCode = null;
    q.addEventListener('keydown', (e) => (keyCode = e.keyCode));
    const res = await replay({ action: 'press', value: 'Escape', target: null });
    expect(res).toEqual({ ok: true, matchCount: 0 });
    expect(seen).toEqual(['keydown:Escape', 'keyup:Escape']);

    seen.length = 0;
    await replay({ action: 'press', value: 'Enter', target: null });
    expect(seen).toEqual(['keydown:Enter', 'keypress:Enter', 'keyup:Enter']);
    expect(keyCode).toBe(13);
  });

  it('Enter in a form field submits through the form’s submit button', async () => {
    document.body.innerHTML = '<form id="f"><input id="q" aria-label="Q"><button>Search</button></form>';
    const submits = [];
    const form = document.getElementById('f');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submits.push(e.submitter && e.submitter.textContent);
    });
    const clicks = [];
    form.querySelector('button').addEventListener('click', () => clicks.push('button'));
    document.getElementById('q').focus();
    await replay({ action: 'press', value: 'Enter', target: null });
    expect(clicks).toEqual(['button']);
    expect(submits).toEqual(['Search']);
  });

  it('Enter in a form without a submit button uses requestSubmit()', async () => {
    document.body.innerHTML = '<form id="f"><input id="q" aria-label="Q"></form>';
    const form = document.getElementById('f');
    let submitted = 0;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitted++;
    });
    document.getElementById('q').focus();
    await replay({ action: 'press', value: 'Enter', target: null });
    expect(submitted).toBe(1);
  });

  it('a keydown handler that calls preventDefault stops the submit', async () => {
    document.body.innerHTML = '<form id="f"><input id="q" aria-label="Q"></form>';
    const form = document.getElementById('f');
    let submitted = 0;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitted++;
    });
    const q = document.getElementById('q');
    q.addEventListener('keydown', (e) => e.preventDefault());
    q.focus();
    await replay({ action: 'press', value: 'Enter', target: null });
    expect(submitted).toBe(0);
  });

  it('Enter and Space on a button activate it once', async () => {
    document.body.innerHTML = '<button id="b">Go</button>';
    const b = document.getElementById('b');
    let clicks = 0;
    b.addEventListener('click', () => clicks++);
    b.focus();
    await replay({ action: 'press', value: 'Enter', target: null });
    expect(clicks).toBe(1);
    await replay({ action: 'press', value: 'Space', target: null });
    expect(clicks).toBe(2);
    // A modified key does not activate.
    await replay({ action: 'press', value: 'Control+Enter', target: null });
    expect(clicks).toBe(2);
  });

  it('Tab and Shift+Tab move focus through the tab order', async () => {
    document.body.innerHTML =
      '<input id="a" aria-label="A"><button id="skip" tabindex="-1">x</button><input type="hidden"><a id="l" href="#x">Link</a><a id="nohref">No</a><button id="b" disabled>B</button><textarea id="t" aria-label="T"></textarea>';
    const a = document.getElementById('a');
    a.focus();
    await replay({ action: 'press', value: 'Tab', target: null });
    expect(document.activeElement.id).toBe('l');
    await replay({ action: 'press', value: 'Tab', target: null });
    expect(document.activeElement.id).toBe('t');
    await replay({ action: 'press', value: 'Shift+Tab', target: null });
    expect(document.activeElement.id).toBe('l');
  });

  it('Tab honours positive tabindex and continues from a tabindex=-1 element', async () => {
    document.body.innerHTML =
      '<input id="a" aria-label="A"><div id="neg" tabindex="-1">n</div><input id="b" aria-label="B"><input id="first" tabindex="1" aria-label="F">';
    document.body.focus();
    await replay({ action: 'press', value: 'Tab', target: null });
    expect(document.activeElement.id).toBe('first');
    document.getElementById('neg').focus();
    await replay({ action: 'press', value: 'Tab', target: null });
    expect(document.activeElement.id).toBe('b');
    document.getElementById('neg').focus();
    await replay({ action: 'press', value: 'Shift+Tab', target: null });
    expect(document.activeElement.id).toBe('a');
  });

  it('Tab reaches a field inside an open shadow root', async () => {
    document.body.innerHTML = '<input id="a" aria-label="A"><x-field id="host"></x-field>';
    const root = document.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<input id="inner" aria-label="Inner">';
    document.getElementById('a').focus();
    await replay({ action: 'press', value: 'Tab', target: null });
    expect(root.activeElement && root.activeElement.id).toBe('inner');
  });

  it('an empty key fails', async () => {
    expect(await replay({ action: 'press', value: '', target: null })).toEqual({
      ok: false,
      error: 'no key to press',
      matchCount: 0,
    });
  });
});

describe('assertions', () => {
  const assertStep = (assertType, value, target) => ({ action: 'assert', assertType, value, target });

  it('toBeVisible passes on a visible element and explains a hidden one', async () => {
    document.body.innerHTML = '<p id="ok">Hi</p><p id="no" style="visibility:hidden">Hidden</p>';
    expect(await replay(assertStep('toBeVisible', '', { kind: 'id', value: 'ok' }))).toEqual({
      ok: true,
      matchCount: 1,
    });
    expect(await replay(assertStep('toBeVisible', '', { kind: 'id', value: 'no' }))).toEqual({
      ok: false,
      error: 'toBeVisible: expected the element to be visible, but it is hidden',
      matchCount: 1,
    });
  });

  it('toHaveText compares the whole normalized text, showing expected vs actual', async () => {
    document.body.innerHTML = '<h1 id="h">  Order\n   confirmed </h1>';
    expect((await replay(assertStep('toHaveText', 'Order confirmed', { kind: 'id', value: 'h' }))).ok).toBe(
      true
    );
    expect(await replay(assertStep('toHaveText', 'Order', { kind: 'id', value: 'h' }))).toEqual({
      ok: false,
      error: 'toHaveText: expected "Order", got "Order confirmed"',
      matchCount: 1,
    });
  });

  it('retries until the text matches', async () => {
    document.body.innerHTML = '<p id="s">Saving…</p>';
    setTimeout(() => (document.getElementById('s').textContent = 'Saved'), 150);
    const res = await replay(assertStep('toHaveText', 'Saved', { kind: 'id', value: 's' }), {
      timeoutMs: 1000,
    });
    expect(res.ok).toBe(true);
  });

  it('toContainText', async () => {
    document.body.innerHTML = '<p id="p">Thanks for your order #42</p>';
    expect((await replay(assertStep('toContainText', 'order #42', { kind: 'id', value: 'p' }))).ok).toBe(
      true
    );
    expect((await replay(assertStep('toContainText', 'refund', { kind: 'id', value: 'p' }))).error).toBe(
      'toContainText: expected text containing "refund", got "Thanks for your order #42"'
    );
  });

  it('toBeChecked reads native and aria-checked state and honours value "false"', async () => {
    document.body.innerHTML =
      '<input type="checkbox" id="c" checked aria-label="C"><div role="switch" id="s" aria-checked="false">S</div>';
    expect((await replay(assertStep('toBeChecked', 'true', { kind: 'id', value: 'c' }))).ok).toBe(true);
    expect((await replay(assertStep('toBeChecked', 'false', { kind: 'id', value: 's' }))).ok).toBe(true);
    expect((await replay(assertStep('toBeChecked', 'true', { kind: 'id', value: 's' }))).error).toBe(
      'toBeChecked: expected checked, got unchecked'
    );
    expect((await replay(assertStep('toBeChecked', 'false', { kind: 'id', value: 'c' }))).error).toBe(
      'toBeChecked: expected unchecked, got checked'
    );
  });

  it('toHaveValue and toBeEnabled', async () => {
    document.body.innerHTML = '<input id="i" value="abc" aria-label="I"><button id="b" disabled>B</button>';
    expect((await replay(assertStep('toHaveValue', 'abc', { kind: 'id', value: 'i' }))).ok).toBe(true);
    expect((await replay(assertStep('toHaveValue', 'xyz', { kind: 'id', value: 'i' }))).error).toBe(
      'toHaveValue: expected "xyz", got "abc"'
    );
    expect((await replay(assertStep('toBeEnabled', '', { kind: 'id', value: 'i' }))).ok).toBe(true);
    expect((await replay(assertStep('toBeEnabled', '', { kind: 'id', value: 'b' }))).error).toBe(
      'toBeEnabled: expected the element to be enabled, but it is disabled'
    );
  });

  it('toHaveURL compares location.href (redacted) without a target', async () => {
    const href = window.location.href;
    expect(await replay({ action: 'assert', assertType: 'toHaveURL', value: href, target: null })).toEqual({
      ok: true,
      matchCount: 0,
    });
    const res = await replay({
      action: 'assert',
      assertType: 'toHaveURL',
      value: 'https://x.test/done',
      target: null,
    });
    expect(res).toEqual({
      ok: false,
      error: `toHaveURL: expected "https://x.test/done", got "${href}"`,
      matchCount: 0,
    });
  });

  it('an unknown assertion type fails without waiting', async () => {
    expect(await replay(assertStep('toBeShiny', '', { kind: 'id', value: 'x' }))).toEqual({
      ok: false,
      error: 'unsupported assertion toBeShiny',
      matchCount: 0,
    });
  });
});

describe('replay and the recorder', () => {
  it('replayed actions are never recorded, even while recording is live', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    document.body.innerHTML =
      '<form id="f"><label>Name <input id="n"></label><input type="checkbox" id="c" aria-label="C"><select id="s" aria-label="S"><option>A</option><option>B</option></select><button>Save</button></form>';
    document.getElementById('f').addEventListener('submit', (e) => e.preventDefault());
    send({ type: 'START_RECORDING' });
    sent.length = 0;
    const run = async (step) => {
      const p = replay(step);
      await vi.advanceTimersByTimeAsync(0);
      return p;
    };
    expect((await run({ action: 'click', target: role('button', 'Save') })).ok).toBe(true);
    expect((await run({ action: 'fill', value: 'Ada', target: { kind: 'label', value: 'Name' } })).ok).toBe(
      true
    );
    expect((await run({ action: 'check', target: { kind: 'id', value: 'c' } })).ok).toBe(true);
    expect((await run({ action: 'selectOption', value: 'B', target: { kind: 'id', value: 's' } })).ok).toBe(
      true
    );
    expect((await run({ action: 'dblclick', target: { kind: 'id', value: 'n' } })).ok).toBe(true);
    document.getElementById('n').focus();
    expect((await run({ action: 'press', value: 'Enter', target: null })).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(4000);

    expect(recorded()).toEqual([]);
    send({ type: 'STOP_RECORDING' });
  });

  it('replay works while the recorder is paused, and records nothing', async () => {
    document.body.innerHTML = '<button>Next</button>';
    send({ type: 'START_RECORDING' });
    send({ type: 'PAUSE_RECORDING' });
    sent.length = 0;
    let clicked = 0;
    document.querySelector('button').addEventListener('click', () => clicked++);
    expect((await replay({ action: 'click', target: role('button', 'Next') })).ok).toBe(true);
    expect(clicked).toBe(1);
    expect(recorded()).toEqual([]);
    // The panel resumes after the run: the user's own clicks are captured again.
    send({ type: 'RESUME_RECORDING' });
    document
      .querySelector('button')
      .dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true }));
    expect(recorded().map((s) => s.action)).toEqual(['click']);
    send({ type: 'STOP_RECORDING' });
  });

  it('a real (user) click right after a replay is recorded again', async () => {
    document.body.innerHTML = '<button>Next</button>';
    send({ type: 'START_RECORDING' });
    sent.length = 0;
    await replay({ action: 'click', target: role('button', 'Next') });
    document
      .querySelector('button')
      .dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true }));
    expect(recorded().map((s) => s.action)).toEqual(['click']);
    send({ type: 'STOP_RECORDING' });
  });

  it('a replayed click is not taken as a pick while inspecting', async () => {
    document.body.innerHTML = '<button>Pick me</button>';
    send({ type: 'START_INSPECT' });
    document.elementFromPoint = () => document.querySelector('button');
    sent.length = 0;
    let clicked = 0;
    document.querySelector('button').addEventListener('click', () => clicked++);
    expect((await replay({ action: 'click', target: role('button', 'Pick me') })).ok).toBe(true);
    expect(clicked).toBe(1);
    expect(sent.filter((m) => m.type === 'ELEMENT_PICKED')).toEqual([]);
    send({ type: 'STOP_INSPECT' });
    delete document.elementFromPoint;
  });
});

describe('target resolution', () => {
  it('uses the engine’s resolveTarget when it exists', async () => {
    document.body.innerHTML = '<button>Go</button>';
    const E = globalThis.__LocatorLensEngine;
    const spyResolve = vi.spyOn(E, 'resolveTarget');
    await replay({ action: 'click', target: role('button', 'Go') });
    expect(spyResolve).toHaveBeenCalledWith(role('button', 'Go'));
  });

  describe('fallback resolver (engine without resolveTarget)', () => {
    beforeEach(() => {
      delete globalThis.__LocatorLensEngine.resolveTarget;
    });
    const visible = (target) => replay({ action: 'assert', assertType: 'toBeVisible', value: '', target });

    it('resolves every target kind the recorder produces', async () => {
      document.body.innerHTML = `
        <button data-testid="buy">Buy now</button>
        <input id="email" name="email" placeholder="you@example.com" aria-label="Email address">
        <img alt="Company logo" src="x.png">
        <span title="Close dialog">x</span>
        <h2>Section</h2><h3>Section</h3>
        <ul><li>One</li><li>Two</li></ul>
        <nav aria-label="Main"><a href="/a">Home</a></nav><a href="/b">Home</a>
        <label for="q">Query</label><input id="q">`;
      const cases = [
        { kind: 'testid', attr: 'data-testid', value: 'buy' },
        { kind: 'id', value: 'email' },
        { kind: 'name', value: 'email' },
        { kind: 'css', value: 'ul > li:nth-of-type(2)' },
        { kind: 'placeholder', value: 'YOU@example' },
        { kind: 'placeholder', value: 'you@example.com', exact: true },
        { kind: 'altText', value: 'logo' },
        { kind: 'title', value: 'close' },
        { kind: 'label', value: 'Query' },
        { kind: 'label', value: 'email address', exact: false },
        { kind: 'text', value: 'Two' },
        { kind: 'text', value: 'One', exact: true },
        { kind: 'role', role: 'button', name: 'buy' },
        { kind: 'role', role: 'heading', name: 'Section', level: 3 },
        { kind: 'role', role: 'listitem', nth: 1 },
        {
          kind: 'chain',
          parent: { kind: 'role', role: 'navigation', name: 'Main' },
          child: role('link', 'Home'),
        },
      ];
      for (const target of cases) {
        const res = await visible(target);
        expect({ target, res }).toEqual({ target, res: { ok: true, matchCount: 1 } });
      }
    });

    it('excludes aria-hidden elements from role matches and fails unknown kinds', async () => {
      document.body.innerHTML = '<div aria-hidden="true"><button>Go</button></div><button>Go</button>';
      expect(await visible(role('button', 'Go'))).toEqual({ ok: true, matchCount: 1 });
      expect((await visible({ kind: 'role', role: 'button', name: 'Go', nth: 4 })).error).toMatch(
        /^no element/
      );
      expect((await visible({ kind: 'wormhole', value: 'x' })).error).toMatch(/^cannot resolve locator/);
      expect(
        (await visible({ kind: 'chain', parent: { kind: 'wormhole' }, child: role('button') })).error
      ).toMatch(/^cannot resolve locator/);
    });

    it('reports an invalid CSS selector as unresolvable', async () => {
      expect((await visible({ kind: 'css', value: 'div[' })).error).toMatch(/^cannot resolve locator/);
    });
  });
});
