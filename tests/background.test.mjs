// Service-worker tests.
//
// background.js is a classic script that wires listeners onto `chrome` at load, so
// each "worker instance" here is a fresh VM context with its own stub. That is not
// just isolation: it is how an MV3 eviction is reproduced. Chrome tears an idle
// worker down after ~30 seconds and every module-scope variable dies with it, while
// chrome.storage.session survives — so starting a second context over the *same*
// session store is exactly what the browser does, and the only way to cover the
// state the recorder depends on across that boundary.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'src/background.js'), 'utf8');
/** Injection must load exactly what the manifest's content_scripts does, in order. */
const MANIFEST_CONTENT_SCRIPTS = JSON.parse(
  readFileSync(join(ROOT, 'manifests/manifest.chrome.json'), 'utf8')
).content_scripts[0].js;

const TAB = 42;
const WINDOW = 7;

/** Let the handlers' `ready().then(...)` chains settle. */
const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * One running service worker.
 *
 * @param session shared backing object for chrome.storage.session — pass the same
 *                one to a second worker to model an eviction and restart.
 */
function startWorker(session = {}, options = {}) {
  const listeners = {
    message: [],
    connect: [],
    installed: [],
    menuClicked: [],
    tabRemoved: [],
    tabUpdated: [],
    tabCreated: [],
    tabAttached: [],
    windowRemoved: [],
  };
  const sent = []; // chrome.tabs.sendMessage
  const relayed = []; // chrome.runtime.sendMessage (broadcast to popup/panel)
  const injected = []; // chrome.scripting.executeScript
  const menus = [];
  const opened = [];

  let lastError = null;
  /** Tabs whose content script is "missing", so sendMessage reports lastError. */
  const unreachable = new Set(options.unreachableTabs ?? []);
  /** Tabs the browser refuses to inject into (chrome://, the Web Store, PDFs). */
  const restricted = new Set(options.restrictedTabs ?? []);
  restricted.forEach((id) => unreachable.add(id));
  let activeTab = options.activeTab === undefined ? { id: TAB, windowId: WINDOW } : options.activeTab;
  /** windowId -> the active tab of that window. */
  const activeByWindow = new Map();
  if (activeTab) activeByWindow.set(activeTab.windowId, activeTab);
  /** What a content script answers, beyond PING. (tabId, msg, frameId) -> response */
  const respond = options.respond ?? (() => undefined);

  const deliver = (tabId, msg, frameId, cb) => {
    if (!cb) return;
    lastError = unreachable.has(tabId) ? { message: 'Could not establish connection.' } : null;
    let res;
    if (!lastError) res = msg.type === 'PING' ? { ok: true } : respond(tabId, msg, frameId);
    try {
      cb(res);
    } finally {
      lastError = null;
    }
  };

  const chrome = {
    runtime: {
      id: 'test-extension-id',
      get lastError() {
        return lastError;
      },
      sendMessage: (msg, cb) => {
        relayed.push(msg);
        if (cb) cb();
      },
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onConnect: { addListener: (fn) => listeners.connect.push(fn) },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
    },
    tabs: {
      query: (q, cb) => {
        const t = typeof q.windowId === 'number' ? activeByWindow.get(q.windowId) : activeTab;
        cb(t ? [t] : []);
      },
      // chrome.tabs.sendMessage(tabId, msg, options?, callback?) — the options form
      // is how a message is aimed at one frame.
      sendMessage: (tabId, msg, optionsOrCb, maybeCb) => {
        const opts = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
        const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
        sent.push({ tabId, msg, frameId: opts ? opts.frameId : undefined });
        deliver(tabId, msg, opts ? opts.frameId : undefined, cb);
      },
      onRemoved: { addListener: (fn) => listeners.tabRemoved.push(fn) },
      onUpdated: { addListener: (fn) => listeners.tabUpdated.push(fn) },
      onCreated: { addListener: (fn) => listeners.tabCreated.push(fn) },
      onAttached: { addListener: (fn) => listeners.tabAttached.push(fn) },
    },
    windows: {
      onRemoved: { addListener: (fn) => listeners.windowRemoved.push(fn) },
    },
    scripting: {
      executeScript: (opts, cb) => {
        injected.push(opts);
        const tabId = opts.target?.tabId;
        if (restricted.has(tabId)) {
          lastError = { message: 'Cannot access contents of the page.' };
          try {
            if (cb) cb();
          } finally {
            lastError = null;
          }
          return;
        }
        // A successful injection makes the tab reachable again.
        unreachable.delete(tabId);
        if (cb) cb();
      },
    },
    contextMenus: {
      removeAll: (cb) => cb && cb(),
      create: (item, cb) => {
        menus.push(item);
        if (cb) cb();
      },
      onClicked: { addListener: (fn) => listeners.menuClicked.push(fn) },
    },
    sidePanel: {
      open: (arg) => {
        opened.push(arg);
        return Promise.resolve();
      },
    },
    storage: {
      session: {
        get: (keys, cb) => {
          const out = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) if (k in session) out[k] = session[k];
          cb(out);
        },
        set: (obj, cb) => {
          // Stored values are copies, as in the browser.
          Object.assign(session, JSON.parse(JSON.stringify(obj)));
          if (cb) cb();
        },
      },
      local: {
        get: (_k, cb) => cb({}),
        set: (o, cb) => {
          localSets.push(o);
          if (cb) cb();
        },
      },
    },
  };
  const localSets = [];

  const context = { chrome, setTimeout, clearTimeout, console };
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: 'src/background.js' });

  /** A side-panel port. hello: the window it announces (PANEL_HELLO), or none. */
  function connectPanel(hello) {
    const posted = [];
    const onMsg = [];
    const onDisc = [];
    const port = {
      name: 'll-sidepanel',
      postMessage: (m) => posted.push(m),
      onMessage: { addListener: (fn) => onMsg.push(fn) },
      onDisconnect: { addListener: (fn) => onDisc.push(fn) },
    };
    listeners.connect.forEach((fn) => fn(port));
    const api = {
      posted,
      post: (m) => onMsg.forEach((fn) => fn(m)),
      disconnect: () => onDisc.forEach((fn) => fn()),
    };
    if (typeof hello === 'number') api.post({ type: 'PANEL_HELLO', windowId: hello });
    return api;
  }

  return {
    session,
    sent,
    relayed,
    injected,
    menus,
    opened,
    localSets,
    listeners,
    connectPanel,
    setActiveTab: (t) => {
      activeTab = t;
      if (t) activeByWindow.set(t.windowId, t);
    },
    /** Make a tab active in its window without focusing that window. */
    setWindowActiveTab: (t) => activeByWindow.set(t.windowId, t),
    /** Deliver a runtime message and hand back whatever sendResponse was given. */
    send(msg) {
      return this.sendFrom(msg, {});
    },
    /** Same, with an explicit sender — this is how tab and frameId reach the worker. */
    sendFrom(msg, sender) {
      let response;
      let keptOpen = false;
      for (const fn of listeners.message) {
        if (fn(msg, sender, (r) => (response = r)) === true) keptOpen = true;
      }
      return {
        get response() {
          return response;
        },
        keptOpen,
      };
    },
    install: () => listeners.installed.forEach((fn) => fn({ reason: 'install' })),
    navigate: (tabId, status, tab) => listeners.tabUpdated.forEach((fn) => fn(tabId, { status }, tab)),
    closeTab: (tabId) => listeners.tabRemoved.forEach((fn) => fn(tabId, {})),
    createTab: (tab) => listeners.tabCreated.forEach((fn) => fn(tab)),
    closeWindow: (windowId) => listeners.windowRemoved.forEach((fn) => fn(windowId)),
  };
}

/** The message the worker sends a tab to resume capture after a page load. */
const rearms = (worker, tabId = TAB) =>
  worker.sent.filter((s) => s.tabId === tabId && s.msg.type === 'START_RECORDING' && s.msg.rearm === true);

describe('context menus', () => {
  it('clears before creating, so an update cannot half-register the menu', () => {
    const w = startWorker();
    w.install();
    expect(w.menus.map((m) => m.id)).toEqual(['ll-copy-locator', 'll-toggle-panel']);
  });
});

describe('message hygiene', () => {
  it('ignores anything that is not a typed message', () => {
    const w = startWorker();
    for (const junk of [null, undefined, {}, { type: 42 }, 'START_INSPECT']) {
      expect(() => w.send(junk)).not.toThrow();
    }
    expect(w.sent).toHaveLength(0);
  });
});

describe('inspect state', () => {
  // The popup opens the panel itself, on its click's gesture (C8). Doing it from
  // here, after an async tab query, lost the gesture: open() was rejected, the
  // rejection swallowed, and the popup claimed the panel was open.
  it('activates the tab and tells the UI, without trying to open the panel', async () => {
    const w = startWorker();
    const q = w.send({ type: 'START_INSPECT', windowId: WINDOW });
    expect(q.keptOpen).toBe(true);
    await flush();
    expect(w.opened).toEqual([]);
    expect(w.relayed).toContainEqual({ type: 'START_INSPECT', windowId: WINDOW, tabId: TAB });
    expect(w.sent.some((s) => s.tabId === TAB && s.msg.type === 'START_INSPECT')).toBe(true);
    expect(q.response).toEqual({ ok: true });
  });

  it('keeps the response channel open for the async state query', async () => {
    const w = startWorker();
    const q = w.send({ type: 'GET_INSPECT_STATE' });
    expect(q.keptOpen).toBe(true);
    await flush();
    expect(q.response).toEqual({ active: false });
  });

  it('survives a worker eviction', async () => {
    const first = startWorker();
    first.send({ type: 'START_INSPECT' });
    await flush();

    // ── the worker is evicted here; only storage.session carries over ──
    const second = startWorker(first.session);
    const q = second.send({ type: 'GET_INSPECT_STATE' });
    await flush();
    expect(q.response).toEqual({ active: true });
  });

  it('drops the tab when it starts navigating', async () => {
    const w = startWorker();
    w.send({ type: 'START_INSPECT' });
    await flush();
    w.navigate(TAB, 'loading');
    await flush();

    expect(w.relayed.find((m) => m.type === 'STOP_INSPECT')).toMatchObject({ tabId: TAB });
    const q = w.send({ type: 'GET_INSPECT_STATE' });
    await flush();
    expect(q.response).toEqual({ active: false });
  });
});

// The bug this file was written for. Recording a checkout flow means navigating, and
// re-arming capture on the new page is driven entirely by the worker's tab set. Once
// the worker had been evicted — which needs nothing more than half a minute of the
// user reading the page — that set came back empty, the navigation was ignored, and
// every step after it was silently dropped from the recording.
describe('recording across a worker eviction', () => {
  it('re-arms capture after a navigation in the same worker', async () => {
    const w = startWorker();
    w.send({ type: 'START_RECORDING' });
    await flush();
    w.navigate(TAB, 'complete');
    await flush();
    expect(rearms(w)).toHaveLength(1);
  });

  it('still re-arms after the worker has been evicted and restarted', async () => {
    const first = startWorker();
    first.send({ type: 'START_RECORDING' });
    await flush();

    const second = startWorker(first.session);
    second.navigate(TAB, 'complete');
    await flush();

    expect(rearms(second)).toHaveLength(1);
  });

  it('re-injects the content script when the new page has no listener yet', async () => {
    const first = startWorker();
    first.send({ type: 'START_RECORDING' });
    await flush();

    const second = startWorker(first.session, { unreachableTabs: [TAB] });
    second.navigate(TAB, 'complete');
    await flush();

    expect(second.injected).toHaveLength(1);
    expect(second.injected[0].files).toEqual(MANIFEST_CONTENT_SCRIPTS);
    expect(rearms(second)).toHaveLength(1);
  });

  // The manifest re-injects only the top frame on a new page. The rearm used to
  // probe that frame first and inject only if it failed — and it never failed, so
  // every iframe on every page after the first navigation went unrecorded.
  it('injects every frame before re-arming, even when the top frame answers', async () => {
    const w = startWorker();
    w.send({ type: 'START_RECORDING', windowId: WINDOW });
    await flush();
    w.injected.length = 0;
    w.sent.length = 0;

    w.navigate(TAB, 'complete');
    await flush();
    expect(w.injected).toHaveLength(1);
    expect(w.injected[0].target).toEqual({ tabId: TAB, allFrames: true });
    expect(rearms(w)).toHaveLength(1);
    expect(rearms(w)[0].frameId).toBeUndefined(); // every frame
  });

  it('stops re-arming after the user stops recording, eviction or not', async () => {
    const first = startWorker();
    first.send({ type: 'START_RECORDING' });
    await flush();
    first.send({ type: 'STOP_RECORDING' });
    await flush();

    const second = startWorker(first.session);
    second.navigate(TAB, 'complete');
    await flush();
    expect(rearms(second)).toHaveLength(0);
  });

  it('forgets a tab that was closed', async () => {
    const first = startWorker();
    first.send({ type: 'START_RECORDING' });
    await flush();
    first.closeTab(TAB);
    await flush();

    const second = startWorker(first.session);
    second.navigate(TAB, 'complete');
    await flush();
    expect(rearms(second)).toHaveLength(0);
  });

  // inspectTabs.delete() || recordingTabs.delete() || pausedTabs.delete() short-
  // circuits on the first `true` — a closed tab that was both inspecting and
  // recording used to have only inspectTabs cleaned up, leaving it stuck in
  // recordingTabs (and pausedTabs) forever, ready to mis-arm if that tab id were
  // ever reused later in the same browser session.
  it('forgets a closed tab that was inspecting and recording at once', async () => {
    const first = startWorker();
    first.send({ type: 'START_INSPECT' });
    await flush();
    first.send({ type: 'START_RECORDING' });
    await flush();
    first.send({ type: 'PAUSE_RECORDING' });
    await flush();
    first.closeTab(TAB);
    await flush();

    const second = startWorker(first.session);
    second.navigate(TAB, 'complete');
    await flush();
    expect(rearms(second)).toHaveLength(0);

    const q = second.send({ type: 'GET_INSPECT_STATE' });
    await flush();
    expect(q.response).toEqual({ active: false });
  });

  it('answers a reopened side panel asking whether recording is live', async () => {
    const first = startWorker();
    first.send({ type: 'START_RECORDING' });
    await flush();

    const second = startWorker(first.session);
    const q = second.send({ type: 'GET_RECORDING_STATE' });
    expect(q.keptOpen).toBe(true);
    await flush();
    expect(q.response).toMatchObject({ active: true, anyTab: true, paused: false });
  });

  it('reports no recording when there never was one', async () => {
    const w = startWorker();
    const q = w.send({ type: 'GET_RECORDING_STATE' });
    await flush();
    expect(q.response).toMatchObject({ active: false, anyTab: false, paused: false });
  });

  // Content scripts track their own pause correctly, but a reopened panel only knows
  // what GET_RECORDING_STATE tells it. Without tracking the pause here too, the panel
  // always rendered "Pause" (i.e. "capture is live") on reopen even while the tab was
  // genuinely paused, with no way back to Resume short of stopping the recording.
  it('remembers that a recording is paused across a worker restart', async () => {
    const first = startWorker();
    first.send({ type: 'START_RECORDING' });
    await flush();
    first.send({ type: 'PAUSE_RECORDING' });
    await flush();

    const second = startWorker(first.session);
    const q = second.send({ type: 'GET_RECORDING_STATE' });
    await flush();
    expect(q.response).toMatchObject({ active: true, anyTab: true, paused: true });
  });

  it('clears the paused flag on resume', async () => {
    const first = startWorker();
    first.send({ type: 'START_RECORDING' });
    await flush();
    first.send({ type: 'PAUSE_RECORDING' });
    await flush();
    first.send({ type: 'RESUME_RECORDING' });
    await flush();

    const second = startWorker(first.session);
    const q = second.send({ type: 'GET_RECORDING_STATE' });
    await flush();
    expect(q.response).toMatchObject({ active: true, anyTab: true, paused: false });
  });

  it('does not carry a stale pause into the next recording session', async () => {
    const first = startWorker();
    first.send({ type: 'START_RECORDING' });
    await flush();
    first.send({ type: 'PAUSE_RECORDING' });
    await flush();
    first.send({ type: 'STOP_RECORDING' });
    await flush();
    first.send({ type: 'START_RECORDING' });
    await flush();

    const second = startWorker(first.session);
    const q = second.send({ type: 'GET_RECORDING_STATE' });
    await flush();
    expect(q.response).toMatchObject({ active: true, anyTab: true, paused: false });
  });

  // The content script re-injected after a full-page navigation is a brand-new JS
  // context with no memory of a prior PAUSE_RECORDING message — it only learns the
  // pause state from whatever the rearm message itself carries. Without this, a
  // paused recording silently went live again on the very next page while the panel
  // kept showing "paused".
  it('carries the current pause state along with a navigation rearm', async () => {
    const w = startWorker();
    w.send({ type: 'START_RECORDING' });
    await flush();
    w.send({ type: 'PAUSE_RECORDING' });
    await flush();

    w.navigate(TAB, 'loading');
    w.navigate(TAB, 'complete');
    await flush();

    expect(rearms(w)).toHaveLength(1);
    expect(rearms(w)[0].msg.paused).toBe(true);
  });

  it('rearms with paused:false for a recording that is not paused', async () => {
    const w = startWorker();
    w.send({ type: 'START_RECORDING' });
    await flush();

    w.navigate(TAB, 'loading');
    w.navigate(TAB, 'complete');
    await flush();

    expect(rearms(w)).toHaveLength(1);
    expect(rearms(w)[0].msg.paused).toBe(false);
  });

  // The side panel is a per-window surface, so two windows can each have their own
  // active recording tab at once. Pause used to be one global flag shared by the
  // whole worker — pausing the tab in one window silently made GET_RECORDING_STATE
  // and the navigation rearm lie about the *other* window's tab being paused too.
  it('keeps pause state independent per recording tab across two windows', async () => {
    const OTHER_TAB = 99;
    const w = startWorker();

    w.send({ type: 'START_RECORDING' }); // window 1, active tab = TAB
    await flush();

    w.setActiveTab({ id: OTHER_TAB, windowId: 8 });
    w.send({ type: 'START_RECORDING' }); // window 2, active tab = OTHER_TAB
    await flush();

    w.send({ type: 'PAUSE_RECORDING' }); // pauses OTHER_TAB only
    await flush();

    w.setActiveTab({ id: TAB, windowId: WINDOW });
    const q1 = w.send({ type: 'GET_RECORDING_STATE' });
    await flush();
    expect(q1.response).toMatchObject({ active: true, anyTab: true, paused: false });

    w.setActiveTab({ id: OTHER_TAB, windowId: 8 });
    const q2 = w.send({ type: 'GET_RECORDING_STATE' });
    await flush();
    expect(q2.response).toMatchObject({ active: true, anyTab: true, paused: true });

    w.navigate(TAB, 'loading');
    w.navigate(TAB, 'complete');
    w.navigate(OTHER_TAB, 'loading');
    w.navigate(OTHER_TAB, 'complete');
    await flush();

    expect(rearms(w, TAB)[0].msg.paused).toBe(false);
    expect(rearms(w, OTHER_TAB)[0].msg.paused).toBe(true);
  });
});

describe('panel heartbeat', () => {
  it('reports the panel as open and survives an eviction', async () => {
    const first = startWorker();
    first.send({ type: 'PANEL_HEARTBEAT' });
    await flush();

    const second = startWorker(first.session);
    const q = second.send({ type: 'GET_PANEL_STATE' });
    expect(q.keptOpen).toBe(true);
    await flush();
    expect(q.response).toEqual({ active: true });
  });

  it('expires a heartbeat older than the TTL', async () => {
    const stale = { llWorkerState: { inspect: [], recording: [], panelLastSeen: Date.now() - 60_000 } };
    const w = startWorker(stale);
    const q = w.send({ type: 'GET_PANEL_STATE' });
    await flush();
    expect(q.response).toEqual({ active: false });
  });
});

describe('side panel relay', () => {
  it('prefers the long-lived port over a broadcast', async () => {
    const w = startWorker();
    const posted = [];
    const port = {
      name: 'll-sidepanel',
      postMessage: (m) => posted.push(m),
      onDisconnect: { addListener: () => {} },
    };
    w.listeners.connect.forEach((fn) => fn(port));

    w.send({ type: 'ELEMENT_PICKED', data: { elementData: { tag: 'button' } } });
    await flush();
    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe('ELEMENT_PICKED');
    expect(w.relayed.filter((m) => m.type === 'ELEMENT_PICKED')).toHaveLength(0);
  });

  it('ignores a port that is not the side panel', async () => {
    const w = startWorker();
    const posted = [];
    w.listeners.connect.forEach((fn) =>
      fn({
        name: 'something-else',
        postMessage: (m) => posted.push(m),
        onDisconnect: { addListener: () => {} },
      })
    );
    w.send({ type: 'ELEMENT_PICKED', data: {} });
    await flush();
    expect(posted).toHaveLength(0);
  });

  it('forwards a recorded action without its raw candidate list', async () => {
    const w = startWorker();
    const { posted } = w.connectPanel();

    w.sendFrom(
      {
        type: 'RECORDED_ACTION',
        data: {
          action: 'click',
          target: { kind: 'role', role: 'button', name: 'Go' },
          eventId: 'e1',
          sequence: 3,
          // The panel never reads these and they are large; the relay drops them.
          locators: new Array(50).fill({ code: 'x' }),
        },
      },
      { tab: { id: TAB, windowId: WINDOW }, frameId: 0 }
    );
    await flush();

    expect(posted[0].data).toMatchObject({ action: 'click', eventId: 'e1', sequence: 3 });
    expect(posted[0].data.target).toEqual({ kind: 'role', role: 'button', name: 'Go' });
    expect(posted[0].data.locators).toBeUndefined();
  });

  // A hand-picked field list silently dropped every field added after it was
  // written (C6): dblclick supersession, sensitive-fill markers, input types.
  it('forwards every other field of a recorded action, tagged with tab and window', async () => {
    const w = startWorker();
    const { posted } = w.connectPanel(WINDOW);
    const data = {
      action: 'fill',
      value: '',
      eventId: 'e9',
      sensitive: true,
      secretName: 'LOCATRA_PASSWORD',
      inputType: 'range',
      supersedes: ['e7', 'e8'],
      frameUrl: 'https://example.com/frame',
    };
    w.sendFrom({ type: 'RECORDED_ACTION', data }, { tab: { id: TAB, windowId: WINDOW }, frameId: 2 });
    await flush();

    const step = posted.find((m) => m.type === 'RECORDED_ACTION');
    expect(step).toMatchObject({ windowId: WINDOW, tabId: TAB });
    expect(step.data).toEqual({ ...data, tabId: TAB, windowId: WINDOW });
  });
});

describe('stress test relay', () => {
  it('always answers the panel, even when the page cannot be reached', async () => {
    const w = startWorker({}, { unreachableTabs: [TAB] });
    // A pick on this tab, made before its content script went away.
    w.sendFrom({ type: 'ELEMENT_PICKED', data: {} }, { tab: { id: TAB, windowId: WINDOW }, frameId: 0 });
    await flush();
    w.send({ type: 'RUN_STRESS_TEST' });
    await flush(150);
    const result = w.relayed.find((m) => m.type === 'STRESS_TEST_RESULT');
    expect(result).toBeDefined();
    expect(result.data).toMatchObject({ survived: false, unavailable: true });
  });
});

// Content scripts are declared for the top frame only, so anything inside an iframe
// is unreachable until a feature is switched on and the worker injects there. These
// cover both halves: arming every frame, and aiming a reply-bearing message at the
// one frame that can answer it.
describe('frames', () => {
  const injectedAllFrames = (w) => w.injected.filter((i) => i.target?.allFrames === true);

  it('injects into every frame when inspect starts, then broadcasts', async () => {
    const w = startWorker();
    w.send({ type: 'START_INSPECT' });
    await flush();

    expect(injectedAllFrames(w)).toHaveLength(1);
    const starts = w.sent.filter((m) => m.msg.type === 'START_INSPECT');
    expect(starts).toHaveLength(1);
    // No frameId: every frame overlays and hit-tests its own document.
    expect(starts[0].frameId).toBeUndefined();
  });

  it('injects into every frame when recording starts', async () => {
    const w = startWorker();
    w.send({ type: 'START_RECORDING' });
    await flush();
    expect(injectedAllFrames(w)).toHaveLength(1);
    expect(w.sent.filter((m) => m.msg.type === 'START_RECORDING' && m.frameId === undefined)).toHaveLength(1);
  });

  it('sends the context-menu copy only to the frame that was right-clicked', () => {
    const w = startWorker();
    w.listeners.menuClicked.forEach((fn) => fn({ menuItemId: 'll-copy-locator', frameId: 3 }, { id: TAB }));
    const copies = w.sent.filter((m) => m.msg.type === 'CONTEXT_MENU_COPY');
    expect(copies).toHaveLength(1);
    expect(copies[0].frameId).toBe(3);
  });

  it('falls back to the top frame when the menu reports no frame', () => {
    const w = startWorker();
    w.listeners.menuClicked.forEach((fn) => fn({ menuItemId: 'll-copy-locator' }, { id: TAB }));
    expect(w.sent.find((m) => m.msg.type === 'CONTEXT_MENU_COPY').frameId).toBe(0);
  });

  it('runs the stress test in the frame that made the pick', async () => {
    const w = startWorker();
    w.sendFrom({ type: 'ELEMENT_PICKED', data: {} }, { tab: { id: TAB }, frameId: 5 });
    await flush();

    w.send({ type: 'RUN_STRESS_TEST' });
    await flush();
    const runs = w.sent.filter((m) => m.msg.type === 'RUN_STRESS_TEST');
    expect(runs).toHaveLength(1);
    expect(runs[0].frameId).toBe(5);
  });

  it('remembers the picking frame across a worker eviction', async () => {
    const first = startWorker();
    first.sendFrom({ type: 'ELEMENT_PICKED', data: {} }, { tab: { id: TAB }, frameId: 4 });
    await flush();

    const second = startWorker(first.session);
    second.send({ type: 'RUN_STRESS_TEST' });
    await flush();
    expect(second.sent.find((m) => m.msg.type === 'RUN_STRESS_TEST').frameId).toBe(4);
  });

  // Frame 0 would fall back to whatever was hovered and describe an element the
  // user never chose (C11).
  it('reports noTarget instead of testing anything when nothing was picked on the tab', async () => {
    const w = startWorker();
    w.send({ type: 'RUN_STRESS_TEST', windowId: WINDOW });
    await flush();
    expect(w.sent.find((m) => m.msg.type === 'RUN_STRESS_TEST')).toBeUndefined();
    const result = w.relayed.find((m) => m.type === 'STRESS_TEST_RESULT');
    expect(result).toMatchObject({ windowId: WINDOW, tabId: TAB, data: { noTarget: true } });
  });

  it('validates in the top frame but clears highlights in every frame', async () => {
    const w = startWorker();
    w.send({ type: 'LAB_VALIDATE', selector: 'button' });
    w.send({ type: 'LAB_CLEAR' });
    await flush();

    expect(w.sent.find((m) => m.msg.type === 'LAB_VALIDATE').frameId).toBe(0);
    expect(w.sent.find((m) => m.msg.type === 'LAB_CLEAR').frameId).toBeUndefined();
  });
});

// ── Fix round: window scoping, sessions, self-arming, activation feedback ────────

const OTHER_WINDOW = 8;
const OTHER_TAB = 99;
const pageSender = (tabId = TAB, windowId = WINDOW, frameId = 0) => ({
  tab: { id: tabId, windowId },
  frameId,
});
const sentTo = (w, tabId, type) => w.sent.filter((s) => s.tabId === tabId && s.msg.type === type);

describe('activation on pages that refuse the content script (C9)', () => {
  it('reports a restricted page to the inspect caller and does not keep the tab', async () => {
    const w = startWorker({}, { restrictedTabs: [TAB] });
    const q = w.send({ type: 'START_INSPECT', windowId: WINDOW });
    await flush();

    expect(q.response).toMatchObject({ ok: false });
    expect(q.response.error).toMatch(/can't run on this page/);
    expect(sentTo(w, TAB, 'START_INSPECT')).toHaveLength(0);
    expect(w.relayed).toContainEqual({ type: 'STOP_INSPECT', windowId: WINDOW, tabId: TAB });

    const state = w.send({ type: 'GET_INSPECT_STATE', windowId: WINDOW });
    await flush();
    expect(state.response).toEqual({ active: false });
  });

  it('reports a restricted page to the record caller and rolls the session back', async () => {
    const w = startWorker({}, { restrictedTabs: [TAB] });
    const q = w.send({ type: 'START_RECORDING', windowId: WINDOW });
    expect(q.keptOpen).toBe(true);
    await flush();

    expect(q.response).toMatchObject({ ok: false });
    expect(sentTo(w, TAB, 'START_RECORDING')).toHaveLength(0);
    const state = w.send({ type: 'GET_RECORDING_STATE', windowId: WINDOW });
    await flush();
    expect(state.response.active).toBe(false);

    w.navigate(TAB, 'complete');
    await flush();
    expect(rearms(w)).toHaveLength(0);
  });

  // A page left open across an extension update has an orphaned script that no
  // longer answers. Injection replaces it, and the PING proves the new one is live.
  it('starts on a page whose old content script is gone, once injection succeeds', async () => {
    const w = startWorker({}, { unreachableTabs: [TAB] });
    const q = w.send({ type: 'START_RECORDING', windowId: WINDOW });
    await flush();
    expect(q.response).toEqual({ ok: true });
    expect(sentTo(w, TAB, 'START_RECORDING')).toHaveLength(1);
  });

  it('pings the top frame after injecting, before arming', async () => {
    const w = startWorker();
    w.send({ type: 'START_INSPECT', windowId: WINDOW });
    await flush();
    const types = w.sent.map((s) => `${s.msg.type}@${s.frameId}`);
    expect(types.indexOf('PING@0')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('PING@0')).toBeLessThan(types.indexOf('START_INSPECT@undefined'));
  });
});

describe('recording sessions per window (C2)', () => {
  it('stops, pauses and asserts on the recording tab, not on whichever tab is active', async () => {
    const w = startWorker();
    w.send({ type: 'START_RECORDING', windowId: WINDOW });
    await flush();

    // The user switches to another tab in the same window.
    w.setActiveTab({ id: 43, windowId: WINDOW });
    w.send({ type: 'PAUSE_RECORDING', windowId: WINDOW });
    w.send({ type: 'SET_ASSERT_MODE', windowId: WINDOW, on: true, assertType: 'toHaveText' });
    w.send({ type: 'STOP_RECORDING', windowId: WINDOW });
    await flush();

    for (const type of ['PAUSE_RECORDING', 'SET_ASSERT_MODE', 'STOP_RECORDING']) {
      expect(sentTo(w, TAB, type), type).toHaveLength(1);
      expect(sentTo(w, 43, type), type).toHaveLength(0);
    }
    expect(sentTo(w, TAB, 'SET_ASSERT_MODE')[0].msg).toMatchObject({ on: true, assertType: 'toHaveText' });
  });

  it('reports assert mode with the session so a reopened panel can restore it', async () => {
    const first = startWorker();
    first.send({ type: 'START_RECORDING', windowId: WINDOW });
    first.send({ type: 'SET_ASSERT_MODE', windowId: WINDOW, on: true, assertType: 'toBeVisible' });
    await flush();

    const second = startWorker(first.session);
    const q = second.send({ type: 'GET_RECORDING_STATE', windowId: WINDOW });
    await flush();
    expect(q.response).toEqual({
      active: true,
      paused: false,
      assertMode: true,
      assertType: 'toBeVisible',
      tabIds: [TAB],
      anyTab: true,
    });
  });

  it("stopping one window's recording leaves the other window's running", async () => {
    const w = startWorker();
    w.send({ type: 'START_RECORDING', windowId: WINDOW });
    w.setWindowActiveTab({ id: OTHER_TAB, windowId: OTHER_WINDOW });
    w.send({ type: 'START_RECORDING', windowId: OTHER_WINDOW });
    await flush();

    w.send({ type: 'STOP_RECORDING', windowId: OTHER_WINDOW });
    await flush();
    expect(sentTo(w, TAB, 'STOP_RECORDING')).toHaveLength(0);
    expect(sentTo(w, OTHER_TAB, 'STOP_RECORDING')).toHaveLength(1);

    const q = w.send({ type: 'GET_RECORDING_STATE', windowId: WINDOW });
    await flush();
    expect(q.response.active).toBe(true);

    w.navigate(TAB, 'complete');
    w.navigate(OTHER_TAB, 'complete');
    await flush();
    expect(rearms(w, TAB)).toHaveLength(1);
    expect(rearms(w, OTHER_TAB)).toHaveLength(0);
  });

  it('acts on the window named in the message, not the focused one', async () => {
    const w = startWorker();
    w.setWindowActiveTab({ id: OTHER_TAB, windowId: OTHER_WINDOW });
    w.send({ type: 'START_RECORDING', windowId: OTHER_WINDOW });
    w.send({ type: 'START_INSPECT', windowId: OTHER_WINDOW });
    await flush();
    expect(sentTo(w, OTHER_TAB, 'START_RECORDING')).toHaveLength(1);
    expect(sentTo(w, OTHER_TAB, 'START_INSPECT')).toHaveLength(1);
    expect(sentTo(w, TAB, 'START_RECORDING')).toHaveLength(0);
    expect(sentTo(w, TAB, 'START_INSPECT')).toHaveLength(0);
  });

  it('brings tabs opened from a recording tab into the session', async () => {
    const w = startWorker();
    const panel = w.connectPanel(WINDOW);
    w.send({ type: 'START_RECORDING', windowId: WINDOW });
    await flush();

    // window.open() can put the new tab in a new window; it still belongs here.
    w.createTab({ id: 50, windowId: 30, openerTabId: TAB });
    w.createTab({ id: 51, windowId: WINDOW, openerTabId: 1234 }); // unrelated opener
    await flush();
    w.navigate(50, 'complete');
    w.navigate(51, 'complete');
    await flush();
    expect(rearms(w, 50)).toHaveLength(1);
    expect(rearms(w, 51)).toHaveLength(0);

    w.sendFrom({ type: 'RECORDED_ACTION', data: { action: 'click', eventId: 'p1' } }, pageSender(50, 30));
    await flush();
    expect(panel.posted.find((m) => m.type === 'RECORDED_ACTION')).toMatchObject({
      windowId: WINDOW,
      tabId: 50,
    });

    w.send({ type: 'STOP_RECORDING', windowId: WINDOW });
    await flush();
    expect(sentTo(w, 50, 'STOP_RECORDING')).toHaveLength(1);
    expect(sentTo(w, TAB, 'STOP_RECORDING')).toHaveLength(1);
  });

  it('carries pause and assert state with a navigation rearm', async () => {
    const w = startWorker();
    w.send({ type: 'START_RECORDING', windowId: WINDOW });
    w.send({ type: 'SET_ASSERT_MODE', windowId: WINDOW, on: true, assertType: 'toHaveValue' });
    w.send({ type: 'PAUSE_RECORDING', windowId: WINDOW });
    await flush();
    w.navigate(TAB, 'complete');
    await flush();
    expect(rearms(w)[0].msg).toMatchObject({ paused: true, assertMode: true, assertType: 'toHaveValue' });
  });

  it('ends a session whose window closes', async () => {
    const w = startWorker();
    w.send({ type: 'START_RECORDING', windowId: WINDOW });
    await flush();
    w.closeWindow(WINDOW);
    await flush();
    const q = w.send({ type: 'GET_RECORDING_STATE', windowId: WINDOW });
    await flush();
    expect(q.response.active).toBe(false);
  });
});

describe('content scripts arming themselves (C3)', () => {
  it('tells a fresh frame in a recording tab to record, with the session state', async () => {
    const w = startWorker();
    w.send({ type: 'START_RECORDING', windowId: WINDOW });
    w.send({ type: 'SET_ASSERT_MODE', windowId: WINDOW, on: true, assertType: 'toBeChecked' });
    w.send({ type: 'PAUSE_RECORDING', windowId: WINDOW });
    await flush();

    const q = w.sendFrom({ type: 'CONTENT_READY' }, pageSender(TAB, WINDOW, 6));
    expect(q.keptOpen).toBe(true);
    await flush();
    expect(q.response).toEqual({
      recording: true,
      paused: true,
      assertMode: true,
      assertType: 'toBeChecked',
      inspecting: false,
    });
  });

  it('tells a fresh frame in an inspected tab to inspect, and others to do nothing', async () => {
    const w = startWorker();
    w.send({ type: 'START_INSPECT', windowId: WINDOW });
    await flush();
    const inTab = w.sendFrom({ type: 'CONTENT_READY' }, pageSender(TAB));
    const elsewhere = w.sendFrom({ type: 'CONTENT_READY' }, pageSender(OTHER_TAB, OTHER_WINDOW));
    await flush();
    expect(inTab.response).toMatchObject({ recording: false, inspecting: true });
    expect(elsewhere.response).toMatchObject({ recording: false, inspecting: false });
  });

  it('injects new frames once per burst of requests, only while a feature is on', async () => {
    const w = startWorker();
    w.send({ type: 'START_RECORDING', windowId: WINDOW });
    await flush();
    w.injected.length = 0;

    w.sendFrom({ type: 'REQUEST_FRAME_INJECTION' }, pageSender());
    w.sendFrom({ type: 'REQUEST_FRAME_INJECTION' }, pageSender(TAB, WINDOW, 3));
    w.sendFrom({ type: 'REQUEST_FRAME_INJECTION' }, pageSender(OTHER_TAB, OTHER_WINDOW)); // idle tab
    expect(w.injected).toHaveLength(0);
    await flush(450);
    expect(w.injected.map((i) => i.target)).toEqual([{ tabId: TAB, allFrames: true }]);
  });
});

describe('window-scoped relays (C1)', () => {
  it("delivers a page's events only to its own window's panel", async () => {
    const w = startWorker();
    const mine = w.connectPanel(WINDOW);
    const other = w.connectPanel(OTHER_WINDOW);
    const unannounced = w.connectPanel(); // has not said hello yet

    w.sendFrom({ type: 'ELEMENT_PICKED', data: { pickId: 'p' } }, pageSender(OTHER_TAB, OTHER_WINDOW));
    w.sendFrom({ type: 'LAB_STATUS_UPDATE', count: 2, via: 'css' }, pageSender(OTHER_TAB, OTHER_WINDOW));
    w.sendFrom({ type: 'LAB_ERROR', error: 'bad' }, pageSender(OTHER_TAB, OTHER_WINDOW));
    w.sendFrom({ type: 'STOP_INSPECT' }, pageSender(OTHER_TAB, OTHER_WINDOW));
    await flush();

    // (PANEL_BUFFER_REPLAYED is the hello handshake's end marker, not a relay.)
    const relays = (port) => port.posted.filter((m) => m.type !== 'PANEL_BUFFER_REPLAYED');
    expect(relays(mine)).toHaveLength(0);
    expect(relays(other).map((m) => m.type)).toEqual([
      'ELEMENT_PICKED',
      'LAB_STATUS_UPDATE',
      'LAB_ERROR',
      'STOP_INSPECT',
    ]);
    for (const m of relays(other)) expect(m).toMatchObject({ windowId: OTHER_WINDOW, tabId: OTHER_TAB });
    expect(relays(other)[1]).toMatchObject({ count: 2, via: 'css' });
    expect(relays(unannounced)).toHaveLength(4);
  });

  it("tells only the navigating tab's window that inspecting stopped", async () => {
    const w = startWorker();
    const mine = w.connectPanel(WINDOW);
    const other = w.connectPanel(OTHER_WINDOW);
    w.send({ type: 'START_INSPECT', windowId: WINDOW });
    await flush();
    mine.posted.length = 0;

    w.navigate(TAB, 'loading', { id: TAB, windowId: WINDOW });
    await flush();
    expect(mine.posted.filter((m) => m.type === 'STOP_INSPECT')).toEqual([
      { type: 'STOP_INSPECT', windowId: WINDOW, tabId: TAB },
    ]);
    expect(other.posted.filter((m) => m.type === 'STOP_INSPECT')).toHaveLength(0);
  });

  it('stops the inspected tab of the window even after the user switched tabs', async () => {
    const w = startWorker();
    w.send({ type: 'START_INSPECT', windowId: WINDOW });
    await flush();
    w.setActiveTab({ id: 43, windowId: WINDOW });
    w.send({ type: 'STOP_INSPECT', windowId: WINDOW });
    await flush();
    expect(sentTo(w, TAB, 'STOP_INSPECT')).toHaveLength(1);
  });

  it('carries the window on stress-test results', async () => {
    const w = startWorker(
      {},
      { respond: (_t, m) => (m.type === 'RUN_STRESS_TEST' ? { data: { survived: true } } : undefined) }
    );
    w.sendFrom({ type: 'ELEMENT_PICKED', data: {} }, pageSender(TAB, WINDOW, 2));
    await flush();
    w.send({ type: 'RUN_STRESS_TEST', windowId: WINDOW });
    await flush();
    expect(w.relayed.find((m) => m.type === 'STRESS_TEST_RESULT')).toEqual({
      type: 'STRESS_TEST_RESULT',
      data: { survived: true },
      windowId: WINDOW,
      tabId: TAB,
    });
  });

  it('tracks whether the panel is open per window', async () => {
    const w = startWorker();
    w.send({ type: 'PANEL_HEARTBEAT', windowId: WINDOW });
    await flush();
    const mine = w.send({ type: 'GET_PANEL_STATE', windowId: WINDOW });
    const other = w.send({ type: 'GET_PANEL_STATE', windowId: OTHER_WINDOW });
    await flush();
    expect(mine.response).toEqual({ active: true });
    expect(other.response).toEqual({ active: false });
  });

  it('reports the panel closed as soon as its port goes away', async () => {
    const w = startWorker();
    const panel = w.connectPanel(WINDOW);
    w.send({ type: 'PANEL_HEARTBEAT', windowId: WINDOW });
    await flush();
    panel.disconnect();
    await flush();
    const q = w.send({ type: 'GET_PANEL_STATE', windowId: WINDOW });
    await flush();
    expect(q.response).toEqual({ active: false });
  });
});

describe('steps recorded while the panel is closed (C7)', () => {
  it('relays a dblclick supersession after the steps it refers to, to the session window', async () => {
    const w = startWorker();
    const panel = w.connectPanel(WINDOW);
    w.send({ type: 'START_RECORDING', windowId: WINDOW });
    await flush();
    w.sendFrom(
      { type: 'RECORDED_ACTION', data: { action: 'dblclick', eventId: 'd', supersedes: ['a', 'b'] } },
      pageSender()
    );
    w.sendFrom({ type: 'RECORDED_ACTION_SUPERSEDE', eventIds: ['a', 'b'] }, pageSender());
    await flush();
    const relays = panel.posted.filter((m) => m.type.startsWith('RECORDED_ACTION'));
    expect(relays.map((m) => m.type)).toEqual(['RECORDED_ACTION', 'RECORDED_ACTION_SUPERSEDE']);
    expect(relays[0].data.supersedes).toEqual(['a', 'b']);
    expect(relays[1]).toEqual({
      type: 'RECORDED_ACTION_SUPERSEDE',
      eventIds: ['a', 'b'],
      windowId: WINDOW,
      tabId: TAB,
    });
  });

  it('buffers steps per window and replays them to the panel when it says hello', async () => {
    const first = startWorker();
    first.send({ type: 'START_RECORDING', windowId: WINDOW });
    await flush();
    first.sendFrom({ type: 'RECORDED_ACTION', data: { action: 'click', eventId: 'a' } }, pageSender());
    first.sendFrom({ type: 'RECORDED_ACTION', data: { action: 'fill', eventId: 'b' } }, pageSender());
    await flush();

    // The worker is evicted before anyone opens the panel.
    const second = startWorker(first.session);
    const other = second.connectPanel(OTHER_WINDOW);
    const panel = second.connectPanel(WINDOW);
    await flush();
    const steps = panel.posted.filter((m) => m.type === 'RECORDED_ACTION');
    expect(steps.map((m) => m.data.eventId)).toEqual(['a', 'b']);
    expect(steps[0]).toMatchObject({ windowId: WINDOW, tabId: TAB });
    expect(other.posted.filter((m) => m.type === 'RECORDED_ACTION')).toHaveLength(0);

    // Kept until acknowledged, then gone.
    panel.post({ type: 'PANEL_BUFFER_ACK', windowId: WINDOW });
    await flush();
    const third = startWorker(second.session);
    const again = third.connectPanel(WINDOW);
    await flush();
    expect(again.posted.filter((m) => m.type === 'RECORDED_ACTION')).toHaveLength(0);
  });

  it('caps the buffer at 1000 steps, dropping the oldest', async () => {
    const w = startWorker();
    for (let i = 0; i < 1005; i++) {
      w.sendFrom({ type: 'RECORDED_ACTION', data: { action: 'click', eventId: `e${i}` } }, pageSender());
    }
    await flush();
    const panel = w.connectPanel(WINDOW);
    await flush();
    const steps = panel.posted.filter((m) => m.type === 'RECORDED_ACTION');
    expect(steps).toHaveLength(1000);
    expect(steps[0].data.eventId).toBe('e5');
  });
});

describe('last pick (C11)', () => {
  it('stores the picked element with the tab and window it came from', async () => {
    const w = startWorker();
    w.sendFrom({ type: 'ELEMENT_PICKED', data: { pickId: 'x', pageUrl: 'https://a.test/' } }, pageSender());
    await flush();
    expect(w.localSets.at(-1)).toEqual({
      lastElement: { pickId: 'x', pageUrl: 'https://a.test/', tabId: TAB, windowId: WINDOW },
    });
  });

  for (const [what, act] of [
    ['closes', (w) => w.closeTab(TAB)],
    ['navigates', (w) => w.navigate(TAB, 'loading', { id: TAB, windowId: WINDOW })],
  ]) {
    it(`forgets the pick when its tab ${what}`, async () => {
      const w = startWorker();
      w.sendFrom({ type: 'ELEMENT_PICKED', data: {} }, pageSender(TAB, WINDOW, 3));
      await flush();
      act(w);
      await flush();
      w.send({ type: 'RUN_STRESS_TEST', windowId: WINDOW });
      await flush();
      expect(w.sent.filter((m) => m.msg.type === 'RUN_STRESS_TEST')).toHaveLength(0);
      expect(w.relayed.find((m) => m.type === 'STRESS_TEST_RESULT').data).toMatchObject({ noTarget: true });
    });
  }

  it('does not run against a pick made on a different tab', async () => {
    const w = startWorker();
    w.sendFrom({ type: 'ELEMENT_PICKED', data: {} }, pageSender(OTHER_TAB, OTHER_WINDOW, 3));
    await flush();
    w.send({ type: 'RUN_STRESS_TEST', windowId: WINDOW });
    await flush();
    expect(w.relayed.find((m) => m.type === 'STRESS_TEST_RESULT').data).toMatchObject({ noTarget: true });
  });
});

describe('context menu (C10, finding 13)', () => {
  it('names the panel item for what it does', () => {
    const w = startWorker();
    w.install();
    expect(w.menus.find((m) => m.id === 'll-toggle-panel').title).toMatch(/Open Results Panel/);
    expect(w.menus.find((m) => m.id === 'll-toggle-panel').title).not.toMatch(/Close/);
  });

  it('opens the panel synchronously from the menu click', () => {
    const w = startWorker();
    w.listeners.menuClicked.forEach((fn) =>
      fn({ menuItemId: 'll-toggle-panel' }, { id: TAB, windowId: WINDOW })
    );
    expect(w.opened).toEqual([{ windowId: WINDOW }]);
  });

  it('passes the right-clicked element id through to the frame', () => {
    const w = startWorker();
    w.listeners.menuClicked.forEach((fn) =>
      fn({ menuItemId: 'll-copy-locator', frameId: 2, targetElementId: 77 }, { id: TAB })
    );
    expect(w.sent.find((m) => m.msg.type === 'CONTEXT_MENU_COPY')).toEqual({
      tabId: TAB,
      frameId: 2,
      msg: { type: 'CONTEXT_MENU_COPY', targetElementId: 77 },
    });
  });
});

describe('state shape', () => {
  it('persists window-keyed state that survives a JSON round trip', async () => {
    const w = startWorker();
    w.send({ type: 'START_RECORDING', windowId: WINDOW });
    w.send({ type: 'START_INSPECT', windowId: WINDOW });
    await flush();
    const saved = w.session.llWorkerState;
    expect(saved.sessions).toEqual([
      { windowId: WINDOW, tabIds: [TAB], paused: false, assertMode: false, assertType: null },
    ]);
    expect(saved.inspect).toEqual([[TAB, WINDOW]]);
  });
});
