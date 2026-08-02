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
  };
  const sent = []; // chrome.tabs.sendMessage
  const relayed = []; // chrome.runtime.sendMessage (broadcast to popup/panel)
  const injected = []; // chrome.scripting.executeScript
  const menus = [];
  const opened = [];

  let lastError = null;
  /** Tabs whose content script is "missing", so sendMessage reports lastError. */
  const unreachable = new Set(options.unreachableTabs ?? []);
  let activeTab = options.activeTab === undefined ? { id: TAB, windowId: WINDOW } : options.activeTab;

  const withLastError = (tabId, cb) => {
    if (!cb) return;
    lastError = unreachable.has(tabId) ? { message: 'Could not establish connection.' } : null;
    try {
      cb(undefined);
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
      query: (_q, cb) => cb(activeTab ? [activeTab] : []),
      // chrome.tabs.sendMessage(tabId, msg, options?, callback?) — the options form
      // is how a message is aimed at one frame.
      sendMessage: (tabId, msg, optionsOrCb, maybeCb) => {
        const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
        const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
        sent.push({ tabId, msg, frameId: options ? options.frameId : undefined });
        withLastError(tabId, cb);
      },
      onRemoved: { addListener: (fn) => listeners.tabRemoved.push(fn) },
      onUpdated: { addListener: (fn) => listeners.tabUpdated.push(fn) },
    },
    scripting: {
      executeScript: (opts, cb) => {
        injected.push(opts);
        // A successful injection makes the tab reachable again.
        unreachable.delete(opts.target?.tabId);
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
        get: (key, cb) => cb(key in session ? { [key]: session[key] } : {}),
        set: (obj, cb) => {
          Object.assign(session, obj);
          if (cb) cb();
        },
      },
      local: {
        get: (_k, cb) => cb({}),
        set: (_o, cb) => cb && cb(),
      },
    },
  };

  const context = { chrome, setTimeout, clearTimeout, console };
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: 'src/background.js' });

  return {
    session,
    sent,
    relayed,
    injected,
    menus,
    opened,
    listeners,
    setActiveTab: (t) => {
      activeTab = t;
    },
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
    navigate: (tabId, status) => listeners.tabUpdated.forEach((fn) => fn(tabId, { status })),
    closeTab: (tabId) => listeners.tabRemoved.forEach((fn) => fn(tabId)),
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
  it('activates the tab, opens the panel and tells the UI', async () => {
    const w = startWorker();
    w.send({ type: 'START_INSPECT' });
    await flush();
    expect(w.opened).toEqual([{ windowId: WINDOW }]);
    expect(w.relayed).toContainEqual({ type: 'START_INSPECT' });
    expect(w.sent.some((s) => s.tabId === TAB && s.msg.type === 'START_INSPECT')).toBe(true);
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

    expect(w.relayed).toContainEqual({ type: 'STOP_INSPECT' });
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
    await flush(150); // the retry is scheduled 80ms after injection

    expect(second.injected).toHaveLength(1);
    expect(second.injected[0].files).toEqual([
      'src/codegen.js',
      'src/content-locator-engine.js',
      'src/content.js',
    ]);
    expect(rearms(second)).toHaveLength(2); // the failed probe, then the retry
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

  it('answers a reopened side panel asking whether recording is live', async () => {
    const first = startWorker();
    first.send({ type: 'START_RECORDING' });
    await flush();

    const second = startWorker(first.session);
    const q = second.send({ type: 'GET_RECORDING_STATE' });
    expect(q.keptOpen).toBe(true);
    await flush();
    expect(q.response).toEqual({ active: true, anyTab: true });
  });

  it('reports no recording when there never was one', async () => {
    const w = startWorker();
    const q = w.send({ type: 'GET_RECORDING_STATE' });
    await flush();
    expect(q.response).toEqual({ active: false, anyTab: false });
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

  it('forwards a recorded action as a slim, structured-clone-safe payload', async () => {
    const w = startWorker();
    const posted = [];
    w.listeners.connect.forEach((fn) =>
      fn({
        name: 'll-sidepanel',
        postMessage: (m) => posted.push(m),
        onDisconnect: { addListener: () => {} },
      })
    );

    w.send({
      type: 'RECORDED_ACTION',
      data: {
        action: 'click',
        target: { kind: 'role', role: 'button', name: 'Go' },
        eventId: 'e1',
        sequence: 3,
        // Large arrays fail structuredClone through the port; the relay must drop them.
        locators: new Array(50).fill({ code: 'x' }),
      },
    });
    await flush();

    expect(posted[0].data).toMatchObject({ action: 'click', eventId: 'e1', sequence: 3 });
    expect(posted[0].data.target).toEqual({ kind: 'role', role: 'button', name: 'Go' });
    expect(posted[0].data.locators).toBeUndefined();
  });
});

describe('stress test relay', () => {
  it('always answers the panel, even when the page cannot be reached', async () => {
    const w = startWorker({}, { unreachableTabs: [TAB] });
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

  it('defaults the stress test to the top frame when nothing was picked', async () => {
    const w = startWorker();
    w.send({ type: 'RUN_STRESS_TEST' });
    await flush();
    expect(w.sent.find((m) => m.msg.type === 'RUN_STRESS_TEST').frameId).toBe(0);
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
