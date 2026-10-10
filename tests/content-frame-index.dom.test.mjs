// @vitest-environment jsdom
//
// C4 · the exact `index` of a frame whose <iframe> element sits in a cross-origin
// parent. The frame cannot count its parent's <iframe>s, so it asks (through
// BACKGROUND, modelled here by `route`) the parent's own content script, which maps
// window.frames[k] to its <iframe> elements by WindowProxy identity. jsdom has no
// real origins: "cross-origin" is a frameElement that throws, and the parent's
// window.frames list is stubbed to hold the <object> / shadow-hosted contexts jsdom
// does not create.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_SCRIPTS = ['src/codegen.js', 'src/content-locator-engine.js', 'src/content.js'];
const SOURCES = CONTENT_SCRIPTS.map((file) => [file, readFileSync(join(ROOT, file), 'utf8')]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => sleep(0);

/** The payment frame's document URL, as the browser reports it to the worker. */
const PAY_URL = 'https://pay.example/checkout';

/** Every loaded instance, for the modelled BACKGROUND's broadcast. */
let instances = [];
let stubbedFrames = [];

/**
 * The top page's window.frames, as both of its views see it: the top content script
 * (run in this global) and a child's `parent` (jsdom's own window object, which
 * vitest's global only mirrors).
 */
function stubTopFrames(get) {
  const jsdomWindow = document.querySelector('iframe').contentWindow.parent;
  for (const obj of new Set([globalThis, jsdomWindow])) {
    if (!stubbedFrames.some(([o]) => o === obj))
      stubbedFrames.push([obj, Object.getOwnPropertyDescriptor(obj, 'frames')]);
    Object.defineProperty(obj, 'frames', { configurable: true, get });
  }
}

/**
 * Runs the content scripts in `win` (the top window when it is `window`).
 * onSend(msg, cb): what the extension answers to the instance's sendMessage.
 */
function loadInto(win, onSend) {
  const handlers = [];
  const sent = [];
  win.__LocatraTrustSyntheticEvents = true;
  win.chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      sendMessage: (msg, cb) => {
        sent.push(msg);
        if (onSend) onSend(msg, cb);
      },
      onMessage: { addListener: (fn) => handlers.push(fn), removeListener: () => {} },
    },
    storage: {
      local: { get: (k, cb) => cb({}) },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  };
  if (win === window) {
    delete globalThis.__LocatorLensEngine;
    delete globalThis.LLCodegen;
    for (const [file, src] of SOURCES) vm.runInThisContext(src, { filename: file });
  } else {
    for (const [file, src] of SOURCES) vm.runInContext(src, win, { filename: file });
  }
  /** Delivers like tabs.sendMessage: { answered, response, keptOpen }. */
  const deliver = (msg) => {
    const out = { answered: false, response: undefined, keptOpen: false };
    for (const h of handlers) {
      const ret = h(msg, {}, (r) => {
        out.answered = true;
        out.response = r;
      });
      if (ret === true) out.keptOpen = true;
    }
    return out;
  };
  const inst = { win, handlers, sent, deliver, of: (type) => sent.filter((m) => m.type === type) };
  instances.push(inst);
  return inst;
}

/**
 * The worker's side of FRAME_INDEX_LOOKUP: ask every frame (the first answer wins,
 * as with tabs.sendMessage to all frames) for each hidden level.
 */
function route(msg, senderUrl = PAY_URL) {
  const indices = msg.path.map(() => null);
  for (const j of msg.levels) {
    const ask = { type: 'FRAME_CHILD_INDEX', parentPath: msg.path.slice(0, j), framesIndex: msg.path[j] };
    if (ask.framesIndex < 0) ask.url = senderUrl; // the worker's sender.url
    for (const inst of instances) {
      const r = inst.deliver(ask);
      if (r.answered) {
        if (r.response && r.response.ok && r.response.index >= 0) indices[j] = r.response.index;
        break;
      }
    }
  }
  return { ok: true, indices };
}

/** Answers lookups asynchronously (as a real worker does); everything else is ignored. */
const autoAnswer = (msg, cb) => {
  if (msg.type === 'FRAME_INDEX_LOOKUP' && cb) setTimeout(() => cb(route(msg)), 0);
};

function crossOrigin(win) {
  Object.defineProperty(win, 'frameElement', {
    configurable: true,
    get() {
      throw new Error('SecurityError: Blocked a frame from accessing a cross-origin frame.');
    },
  });
}

/**
 * The top page: an <object> browsing context, then a web component whose shadow
 * root hosts an iframe, then <iframe id=a>, then the payment <iframe id=pay>.
 * window.frames (document order): [object, shadow iframe, a, pay] → pay is 3 there.
 * The engine's pierce order counts <iframe>s root by root: [a, pay, shadow] → 1.
 */
function buildTop() {
  loadInto(window);
  document.body.innerHTML =
    '<object id="o" data="about:blank"></object><x-card id="h"></x-card>' +
    '<iframe id="a"></iframe><iframe id="pay"></iframe>';
  const sr = document.getElementById('h').attachShadow({ mode: 'open' });
  sr.innerHTML = '<iframe id="s"></iframe>';
  const objectWin = { name: 'object-context' };
  const shadowWin = { name: 'shadow-context' };
  Object.defineProperty(sr.getElementById('s'), 'contentWindow', {
    configurable: true,
    get: () => shadowWin,
  });
  const pay = document.getElementById('pay');
  const list = [objectWin, shadowWin, document.getElementById('a').contentWindow, pay.contentWindow];
  stubTopFrames(() => list);
  return { pay, list, top: instances[instances.length - 1] };
}

function loadPayFrame(pay, onSend = autoAnswer) {
  const w = pay.contentWindow;
  crossOrigin(w);
  const inst = loadInto(w, onSend);
  w.document.body.innerHTML = '<button id="buy">Pay now</button>';
  return inst;
}

const pointer = (w, el) =>
  el.dispatchEvent(new w.PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true }));
const steps = (inst) => inst.of('RECORDED_ACTION').map((m) => m.data);
const code = (w, t) => w.LLCodegen.locatorExpr(t, 'playwright', 'typescript');

afterEach(() => {
  for (const inst of instances) {
    // A live earlier instance makes the next one in the same window stand down.
    try {
      if (inst.win.__LocatorLensInstance) inst.win.__LocatorLensInstance.teardown();
    } catch {
      /* its frame is gone already */
    }
  }
  instances = [];
  for (const [obj, desc] of stubbedFrames) {
    if (desc) Object.defineProperty(obj, 'frames', desc);
    else delete obj.frames;
  }
  stubbedFrames = [];
  document.body.innerHTML = '';
});

describe('C4 · the parent maps window.frames[k] to its <iframe> index', () => {
  it('counts <iframe>s in the engine’s pierce order, skipping <object>/<frame> contexts', () => {
    const { top } = buildTop();
    const ask = (parentPath, framesIndex) =>
      top.deliver({ type: 'FRAME_CHILD_INDEX', parentPath, framesIndex });
    expect(ask([], 3)).toMatchObject({ answered: true, response: { ok: true, index: 1 } }); // pay
    expect(ask([], 2).response.index).toBe(0); // a
    expect(ask([], 1).response.index).toBe(2); // the shadow-hosted iframe comes last
    // An <object> (or <frame>) context is not an <iframe>; an index past the end is gone.
    expect(ask([], 0).response).toEqual({ ok: true, index: -1 });
    expect(ask([], 9).response).toEqual({ ok: true, index: -1 });
  });

  it('only the frame at parentPath answers; malformed questions get no answer', () => {
    const { top } = buildTop();
    const ask = (msg) => top.deliver(Object.assign({ type: 'FRAME_CHILD_INDEX' }, msg));
    expect(ask({ parentPath: [3], framesIndex: 0 })).toMatchObject({ answered: false, keptOpen: false });
    expect(ask({ parentPath: 'x', framesIndex: 0 }).answered).toBe(false);
    expect(ask({ parentPath: [], framesIndex: -1 }).answered).toBe(false);
    expect(ask({ parentPath: [], framesIndex: 1.5 }).answered).toBe(false);
  });

  it('a nested parent answers for its own children by its window.frames path', () => {
    const { pay } = buildTop();
    const frame = loadPayFrame(pay);
    frame.win.document.body.innerHTML = '<iframe id="inner1"></iframe><iframe id="inner2"></iframe>';
    const r = frame.deliver({ type: 'FRAME_CHILD_INDEX', parentPath: [3], framesIndex: 1 });
    expect(r).toMatchObject({ answered: true, response: { ok: true, index: 1 } });
    // The top frame does not answer a question meant for pay.
    expect(
      instances[0].deliver({ type: 'FRAME_CHILD_INDEX', parentPath: [3], framesIndex: 1 }).answered
    ).toBe(false);
    // pay is not at [2].
    expect(frame.deliver({ type: 'FRAME_CHILD_INDEX', parentPath: [2], framesIndex: 1 }).answered).toBe(
      false
    );
  });

  it('an engine that throws, or a child whose window cannot be compared, maps to -1', () => {
    const { top, pay } = buildTop();
    Object.defineProperty(pay, 'contentWindow', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    expect(top.deliver({ type: 'FRAME_CHILD_INDEX', parentPath: [], framesIndex: 3 }).response.index).toBe(
      -1
    );
    const E = globalThis.__LocatorLensEngine;
    const real = E.deepQueryAll;
    E.deepQueryAll = () => {
      throw new Error('engine gone');
    };
    expect(top.deliver({ type: 'FRAME_CHILD_INDEX', parentPath: [], framesIndex: 2 }).response.index).toBe(
      -1
    );
    E.deepQueryAll = () => null;
    expect(top.deliver({ type: 'FRAME_CHILD_INDEX', parentPath: [], framesIndex: 2 }).response.index).toBe(
      -1
    );
    E.deepQueryAll = real;
  });
});

describe('C4 · a cross-origin frame records its exact index', () => {
  it('fetches the index when recording starts, so the first step is exact and immediate', async () => {
    const { pay } = buildTop();
    const frame = loadPayFrame(pay);
    frame.deliver({ type: 'START_RECORDING' });
    expect(frame.of('FRAME_INDEX_LOOKUP')).toEqual([{ type: 'FRAME_INDEX_LOOKUP', path: [3], levels: [0] }]);
    await tick();
    pointer(frame.win, frame.win.document.getElementById('buy'));
    const [step] = steps(frame); // sent synchronously: nothing was held
    expect(step.target).toMatchObject({ kind: 'frame', selector: null, index: 1, framesIndex: 3 });
    expect(step.code).toBe(code(frame.win, step.target));
    expect(step.fullCode).toContain(step.code);
  });

  it('holds steps until the answer arrives, then sends them in order with exact strings', async () => {
    const { pay } = buildTop();
    const pending = [];
    const frame = loadPayFrame(pay, (msg, cb) => {
      if (msg.type === 'FRAME_INDEX_LOOKUP') pending.push(() => cb(route(msg)));
    });
    frame.deliver({ type: 'START_RECORDING' });
    const btn = frame.win.document.getElementById('buy');
    pointer(frame.win, btn);
    btn.setAttribute('aria-label', 'Confirm');
    pointer(frame.win, btn);
    expect(steps(frame)).toHaveLength(0);
    expect(pending).toHaveLength(1); // one lookup for both
    pending.shift()();
    await tick();
    const [first, second] = steps(frame);
    expect(first.sequence).toBeLessThan(second.sequence);
    for (const s of [first, second]) {
      expect(s.target).toMatchObject({ index: 1, framesIndex: 3 });
      expect(s.code).toBe(code(frame.win, s.target));
      expect(s.code).not.toContain('nth(3)');
      expect(s.fullCode).toBe(`await ${s.code}.click();`);
    }
    // The cache now serves later steps at once; each sent step refreshes it.
    pointer(frame.win, btn);
    expect(steps(frame)).toHaveLength(3);
    expect(steps(frame)[2].target.index).toBe(1);
    expect(pending).toHaveLength(1);
  });

  it('a parent that changes its frames is asked again before the next step', async () => {
    const { pay, list } = buildTop();
    const frame = loadPayFrame(pay);
    frame.deliver({ type: 'START_RECORDING' });
    await tick();
    // A new <iframe> before pay: window.frames grows, the cached answer is stale.
    const extra = document.createElement('iframe');
    document.body.insertBefore(extra, pay);
    list.splice(3, 0, extra.contentWindow);
    pointer(frame.win, frame.win.document.getElementById('buy'));
    expect(steps(frame)).toHaveLength(0);
    await tick();
    await tick();
    expect(steps(frame)[0].target).toMatchObject({ index: 2, framesIndex: 4 });
  });

  it('no answer in time: the steps go with the provisional index, and later ones are not held', async () => {
    const { pay } = buildTop();
    const frame = loadPayFrame(pay, () => {}); // a worker that never answers
    frame.deliver({ type: 'START_RECORDING' });
    const btn = frame.win.document.getElementById('buy');
    pointer(frame.win, btn);
    expect(steps(frame)).toHaveLength(0);
    await sleep(700);
    expect(steps(frame)).toHaveLength(1);
    expect(steps(frame)[0].target).toMatchObject({ index: 3, framesIndex: 3 });
    pointer(frame.win, btn);
    expect(steps(frame)).toHaveLength(2);
  });

  it('an answer without an index for the level keeps the provisional one', async () => {
    const { pay } = buildTop();
    const frame = loadPayFrame(pay, (msg, cb) => {
      if (msg.type === 'FRAME_INDEX_LOOKUP') setTimeout(() => cb({ ok: true, indices: [-1] }), 0);
    });
    frame.deliver({ type: 'START_RECORDING' });
    await tick();
    pointer(frame.win, frame.win.document.getElementById('buy'));
    expect(steps(frame)[0].target).toMatchObject({ index: 3, framesIndex: 3 });
  });

  it('target-less steps queue behind a held one; a torn-down instance drops them', async () => {
    const { pay } = buildTop();
    const pending = [];
    const frame = loadPayFrame(pay, (msg, cb) => {
      if (msg.type === 'FRAME_INDEX_LOOKUP') pending.push(() => cb(route(msg)));
    });
    frame.deliver({ type: 'START_RECORDING' });
    const btn = frame.win.document.getElementById('buy');
    pointer(frame.win, btn);
    btn.focus();
    btn.dispatchEvent(new frame.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    pending.shift()();
    await tick();
    expect(steps(frame).map((s) => s.action)).toEqual(['click', 'press']);

    // Held when the instance goes away: nothing is sent into a dead context.
    const { pay: pay2 } = buildTop();
    const pending2 = [];
    const frame2 = loadPayFrame(pay2, (msg, cb) => {
      if (msg.type === 'FRAME_INDEX_LOOKUP') pending2.push(() => cb(route(msg)));
    });
    frame2.deliver({ type: 'START_RECORDING' });
    pointer(frame2.win, frame2.win.document.getElementById('buy'));
    frame2.win.__LocatorLensInstance.teardown();
    pending2.shift()();
    await tick();
    expect(steps(frame2)).toHaveLength(0);
  });

  it('a frame missing from window.frames (shadow-hosted) is found by its URL', async () => {
    const { pay, top } = buildTop();
    // Chrome lists no shadow-hosted <iframe> in window.frames; say pay is one too.
    const objectWin = { name: 'object-context' };
    const aWin = document.getElementById('a').contentWindow;
    stubTopFrames(() => [objectWin, aWin]);
    Object.defineProperty(pay, 'src', { configurable: true, get: () => PAY_URL + '#step-2' });
    const frame = loadPayFrame(pay);
    frame.deliver({ type: 'START_RECORDING' });
    expect(frame.of('FRAME_INDEX_LOOKUP')[0]).toEqual({
      type: 'FRAME_INDEX_LOOKUP',
      path: [-1],
      levels: [0],
    });
    await tick();
    pointer(frame.win, frame.win.document.getElementById('buy'));
    const [step] = steps(frame);
    expect(step.target).toMatchObject({ kind: 'frame', selector: null, index: 1 });
    expect(step.target.framesIndex).toBeUndefined();

    // The parent's side: unlisted <iframe>s are pay (1) and the shadow one (2).
    const ask = (url) =>
      top.deliver({ type: 'FRAME_CHILD_INDEX', parentPath: [], framesIndex: -1, url }).response;
    expect(ask(PAY_URL)).toEqual({ ok: true, index: 1 });
    expect(ask('https://elsewhere.example/')).toEqual({ ok: true, index: -1 }); // two candidates, neither matches
    // Without a URL there is nothing to go on: not answered at all.
    expect(top.deliver({ type: 'FRAME_CHILD_INDEX', parentPath: [], framesIndex: -1 }).answered).toBe(false);
    // One unlisted <iframe> only: it is the one, wherever it navigated since.
    stubTopFrames(() => [
      objectWin,
      aWin,
      document.getElementById('h').shadowRoot.getElementById('s').contentWindow,
    ]);
    expect(ask('https://navigated.example/')).toEqual({ ok: true, index: 1 });
    // Two with the same src: ambiguous.
    Object.defineProperty(document.getElementById('a'), 'src', { configurable: true, get: () => PAY_URL });
    stubTopFrames(() => [objectWin]);
    expect(ask(PAY_URL)).toEqual({ ok: true, index: -1 });
  });

  it('a frame below one missing from window.frames asks only what can be asked', () => {
    const { pay } = buildTop();
    stubTopFrames(() => []); // pay is unlisted, so its children cannot be addressed by path
    const frame = loadPayFrame(pay);
    frame.win.document.body.innerHTML = '<iframe id="inner"></iframe>';
    const inner = frame.win.document.getElementById('inner').contentWindow;
    crossOrigin(inner);
    const innerInst = loadInto(inner, autoAnswer);
    inner.document.body.innerHTML = '<button id="ok">OK</button>';
    innerInst.deliver({ type: 'START_RECORDING' });
    // Level 0 (pay in the top) has no position and is not the asker: not asked.
    // Level 1 (inner in pay) has a position, but pay has no path: not asked either.
    expect(innerInst.of('FRAME_INDEX_LOOKUP')).toHaveLength(0);
    pointer(inner, inner.document.getElementById('ok'));
    expect(steps(innerInst)).toHaveLength(1); // nothing to wait for: sent at once
    expect(steps(innerInst)[0].target).toMatchObject({
      kind: 'frame',
      index: 0,
      child: { kind: 'frame', index: 0 },
    });
  });

  it('a same-origin frame never asks', () => {
    loadInto(window);
    document.body.innerHTML = '<iframe id="f"></iframe>';
    const w = document.getElementById('f').contentWindow;
    const frame = loadInto(w, autoAnswer);
    w.document.body.innerHTML = '<button>Go</button>';
    frame.deliver({ type: 'START_RECORDING' });
    pointer(w, w.document.querySelector('button'));
    expect(frame.of('FRAME_INDEX_LOOKUP')).toHaveLength(0);
    expect(steps(frame)[0].target).toMatchObject({ selector: '#f', index: 0 });
  });
});

describe('C4 · picks, page objects and replay share the exact index', () => {
  it('a pick made before the answer arrives is generated once it has', async () => {
    const { pay } = buildTop();
    const pending = [];
    const frame = loadPayFrame(pay, (msg, cb) => {
      if (msg.type === 'FRAME_INDEX_LOOKUP') pending.push(() => cb(route(msg)));
    });
    frame.deliver({ type: 'START_INSPECT' });
    frame.win.document
      .getElementById('buy')
      .dispatchEvent(new frame.win.MouseEvent('click', { bubbles: true }));
    expect(frame.of('ELEMENT_PICKED')).toHaveLength(0);
    pending.shift()();
    await tick();
    const pick = frame.of('ELEMENT_PICKED')[0].data;
    expect(pick.locators[0].target).toMatchObject({
      kind: 'frame',
      selector: null,
      index: 1,
      framesIndex: 3,
    });
    expect(pick.elementData.framePath).toEqual(['iframe (index 1)']);
  });

  it('a page-object region in a cross-origin frame waits for the index', async () => {
    const { pay } = buildTop();
    const frame = loadPayFrame(pay);
    frame.win.document.body.innerHTML = '<form id="f"><button>Pay now</button></form>';
    frame.deliver({ type: 'POM_PICK_START' });
    frame.win.document
      .querySelector('button')
      .dispatchEvent(new frame.win.MouseEvent('click', { bubbles: true }));
    let result = null;
    for (let i = 0; i < 50 && !result; i++) {
      await tick();
      result = frame.of('POM_RESULT')[0];
    }
    const el = result.data.elements.find((e) => e.kind === 'button');
    expect(el.target).toMatchObject({ kind: 'frame', index: 1, framesIndex: 3 });
  });

  it('a right-click fetches the index ahead of the context-menu copy', async () => {
    const { pay } = buildTop();
    const frame = loadPayFrame(pay);
    frame.win.document
      .getElementById('buy')
      .dispatchEvent(new frame.win.MouseEvent('contextmenu', { bubbles: true, composed: true }));
    expect(frame.of('FRAME_INDEX_LOOKUP')).toHaveLength(1);
    await tick();
    const copied = [];
    Object.defineProperty(frame.win.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t) => (copied.push(t), Promise.resolve()) },
    });
    expect(frame.deliver({ type: 'CONTEXT_MENU_COPY' }).response).toEqual({ ok: true });
    const exact = code(frame.win, {
      kind: 'frame',
      selector: null,
      index: 1,
      framesIndex: 3,
      child: { kind: 'role', role: 'button', name: 'Pay now' },
    });
    expect(copied).toEqual([exact]);
  });

  it('replay ownership matches the exact index, with or without framesIndex', async () => {
    const { pay } = buildTop();
    const frame = loadPayFrame(pay);
    frame.deliver({ type: 'START_RECORDING' });
    await tick();
    pointer(frame.win, frame.win.document.getElementById('buy'));
    const recordedTarget = steps(frame)[0].target;
    frame.deliver({ type: 'STOP_RECORDING' });
    const replay = (target) =>
      new Promise((done) => {
        const r = frame.deliver({
          type: 'REPLAY_STEP',
          step: { action: 'assert', assertType: 'toBeVisible', target },
          timeoutMs: 100,
        });
        if (!r.keptOpen) done('unanswered');
        else sleep(150).then(() => done('answered'));
      });
    expect(await replay(recordedTarget)).toBe('answered');
    const withoutFramesIndex = Object.assign({}, recordedTarget);
    delete withoutFramesIndex.framesIndex;
    expect(await replay(withoutFramesIndex)).toBe('answered'); // index 1 is this frame now
    expect(await replay(Object.assign({}, withoutFramesIndex, { index: 3 }))).toBe('unanswered');
  });
});
