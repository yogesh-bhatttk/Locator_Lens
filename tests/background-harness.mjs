// Shared harness for the background-*.test.mjs suites.
//
// Like tests/background.test.mjs, each worker is a fresh VM context running the
// real src/background.js against a chrome stub — but this stub also models what
// the replay and screenshot code depends on: tabs that load (tabs.update fires
// onUpdated 'loading' then 'complete'), tabs.get, frames that answer
// asynchronously or not at all, captureVisibleTab, storage.onChanged, and the
// image APIs used to downscale a capture. Not a test file itself (no .test.mjs).

/* global Buffer, Blob, atob, setTimeout, console */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BACKGROUND = readFileSync(join(ROOT, 'src/background.js'), 'utf8');
export const THUMBS_STORE = readFileSync(join(ROOT, 'src/thumbs-store.js'), 'utf8');

export const TAB = 42;
export const WINDOW = 7;

/** A frame's way of saying "this message is not mine": no sendResponse at all. */
export const NO_ANSWER = Symbol('no-answer');

/**
 * How tests let time pass. Real timers by default; a suite on fake timers swaps in
 * `(ms) => vi.advanceTimersByTimeAsync(ms)` with setWaiter(), which makes flush(),
 * until() and ask() deterministic — no dependence on how busy the machine is.
 */
let wait = (ms) => new Promise((r) => setTimeout(r, ms));
export function setWaiter(fn) {
  wait = fn || ((ms) => new Promise((r) => setTimeout(r, ms)));
}

/** Let promise chains and timers up to `ms` settle. */
export const flush = (ms = 0) => wait(ms);

/** Poll until fn() is truthy, letting `interval` ms pass between checks. */
export async function until(fn, { timeout = 3000, interval = 5, what = 'condition' } = {}) {
  for (let waited = 0; ; waited += interval) {
    const v = fn();
    if (v) return v;
    if (waited > timeout) throw new Error(`timed out waiting for ${what}`);
    await wait(interval);
  }
}

/** A tiny JPEG-ish data: URL (content is irrelevant to the stubs). */
export const DATA_URL = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes').toString('base64');

/**
 * In-memory stand-in for globalThis.LLThumbs, recording every call.
 * `fail: true` makes put() resolve false (as the real store does on error).
 */
export function memoryThumbs({ fail = false } = {}) {
  const records = new Map();
  const calls = [];
  return {
    records,
    calls,
    put: (rec) => {
      calls.push(['put', rec]);
      if (fail) return Promise.resolve(false);
      records.set(rec.eventId, rec);
      return Promise.resolve(true);
    },
    get: (id) => Promise.resolve(records.get(id) || null),
    getMany: (ids) => Promise.resolve(ids.map((id) => records.get(id) || null)),
    delete: (id) => Promise.resolve(records.delete(id)),
    deleteMany: (ids) => {
      calls.push(['deleteMany', ids]);
      ids.forEach((id) => records.delete(id));
      return Promise.resolve(ids.length);
    },
    clearWindow: (windowId) => {
      calls.push(['clearWindow', windowId]);
      let n = 0;
      for (const [k, v] of records) if (v.windowId === windowId && records.delete(k)) n++;
      return Promise.resolve(n);
    },
    prune: (age) => {
      calls.push(['prune', age]);
      return Promise.resolve(0);
    },
  };
}

/** createImageBitmap + OffscreenCanvas stubs. size: what the "decoded" capture measures. */
export function imageApis({
  width = 1280,
  height = 800,
  failDecode = false,
  noContext = false,
  nullBlob = false,
} = {}) {
  const log = { canvases: [], drawn: [], closed: 0, converted: [] };
  const createImageBitmap = async (blob) => {
    if (failDecode) throw new Error('decode failed');
    return { width, height, source: blob, close: () => log.closed++ };
  };
  class OffscreenCanvas {
    constructor(w, h) {
      this.width = w;
      this.height = h;
      log.canvases.push([w, h]);
    }
    getContext() {
      if (noContext) return null;
      return { drawImage: (...args) => log.drawn.push(args.slice(1)) };
    }
    async convertToBlob(opts) {
      log.converted.push(opts);
      if (nullBlob) return null;
      return new Blob(['thumb'], { type: opts.type });
    }
  }
  return { createImageBitmap, OffscreenCanvas, log };
}

/**
 * Start one worker.
 * options:
 *   tabs: [{id, windowId, active, status}] (default: TAB in WINDOW, active, complete)
 *   respond(tabId, msg, frameId): content answer for non-PING messages. May return
 *     a value, a Promise of one, or NO_ANSWER. Default: NO_ANSWER.
 *   restrictedTabs: tab ids that refuse injection and never answer
 *   unreachableTabs: tab ids with no content script until injected
 *   capture(windowId, opts): returns a data URL, or throws to simulate lastError
 *   navigate(tabId, url): 'normal' (default) | 'hang' (stays loading) | 'error' | 'same-document'
 *   navDelay: ms between 'loading' and 'complete' (default 5)
 *   settings: initial llSettings value in storage.local
 *   thumbs: value for globalThis.LLThumbs (default: memoryThumbs())
 *   image: false to leave out createImageBitmap/OffscreenCanvas, or imageApis() options
 *   session: shared chrome.storage.session backing object (eviction)
 *   noSession: model a browser without storage.session
 *   context: extra globals for the VM context
 *   loadThumbsStore: also run the real src/thumbs-store.js first
 *   allUrls: is the optional <all_urls> host permission granted? true (default) |
 *     false | 'none' (no permissions API) | 'error' (lastError) | 'throw'
 */
export function startWorker(options = {}) {
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
    storageChanged: [],
    permAdded: [],
    permRemoved: [],
  };
  let allUrls = options.allUrls === undefined ? true : options.allUrls;
  const permissionChecks = [];
  const sent = [];
  const relayed = [];
  const injected = [];
  const updates = [];
  const captures = [];
  const session = options.session ?? {};
  const local = { llSettings: options.settings };
  if (options.settings === undefined) delete local.llSettings;

  let lastError = null;
  // Real callbacks run on their own task, so lastError never leaks from an outer
  // callback into a nested one. These stubs call back synchronously, so every
  // callback — failed or not — sets lastError explicitly and restores it after.
  const withError = (err, fn) => {
    const prev = lastError;
    lastError = err;
    try {
      fn();
    } finally {
      lastError = prev;
    }
  };
  const ok = (fn) => withError(null, fn);

  const tabs = new Map();
  for (const t of options.tabs ?? [{ id: TAB, windowId: WINDOW, active: true }]) {
    tabs.set(t.id, { status: 'complete', active: true, ...t });
  }
  const restricted = new Set(options.restrictedTabs ?? []);
  const unreachable = new Set([...(options.unreachableTabs ?? []), ...restricted]);
  const respond = options.respond ?? (() => NO_ANSWER);
  const navDelay = options.navDelay ?? 5;

  const fireUpdated = (tabId, status) => {
    const t = tabs.get(tabId);
    if (!t) return;
    t.status = status;
    listeners.tabUpdated.forEach((fn) => fn(tabId, { status }, { ...t }));
  };

  const deliver = (tabId, msg, frameId, cb) => {
    if (!cb) {
      if (msg.type !== 'PING' && !unreachable.has(tabId) && tabs.has(tabId)) respond(tabId, msg, frameId);
      return;
    }
    if (unreachable.has(tabId) || !tabs.has(tabId)) {
      withError({ message: 'Could not establish connection. Receiving end does not exist.' }, () =>
        cb(undefined)
      );
      return;
    }
    if (msg.type === 'PING') {
      ok(() => cb({ ok: true }));
      return;
    }
    const answer = (value) => {
      if (value === NO_ANSWER) {
        withError({ message: 'The message port closed before a response was received.' }, () =>
          cb(undefined)
        );
      } else ok(() => cb(value));
    };
    const out = respond(tabId, msg, frameId);
    if (out && typeof out.then === 'function') out.then(answer);
    else answer(out);
  };

  const activeIn = (windowId) => {
    for (const t of tabs.values()) if (t.windowId === windowId && t.active) return t;
    return null;
  };
  let focusedWindow = options.focusedWindow ?? [...tabs.values()][0]?.windowId ?? WINDOW;

  const chrome = {
    runtime: {
      id: 'test-extension-id',
      get lastError() {
        return lastError;
      },
      getURL: (p) => 'chrome-extension://test-extension-id/' + p,
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
        const w = typeof q.windowId === 'number' ? q.windowId : focusedWindow;
        const t = activeIn(w);
        cb(t ? [{ ...t }] : []);
      },
      get: (tabId, cb) => {
        const t = tabs.get(tabId);
        if (!t) withError({ message: `No tab with id: ${tabId}.` }, () => cb(undefined));
        else ok(() => cb({ ...t }));
      },
      update: (tabId, props, cb) => {
        updates.push({ tabId, props });
        const t = tabs.get(tabId);
        const mode = options.navigate ? options.navigate(tabId, props.url) : 'normal';
        if (!t || mode === 'error') {
          withError(
            { message: t ? 'Navigation blocked.' : `No tab with id: ${tabId}.` },
            () => cb && cb(undefined)
          );
          return;
        }
        if (cb) ok(() => cb({ ...t }));
        if (mode === 'same-document') return;
        setTimeout(() => {
          fireUpdated(tabId, 'loading');
          if (mode === 'hang') return;
          setTimeout(() => fireUpdated(tabId, 'complete'), navDelay);
        }, 0);
      },
      sendMessage: (tabId, msg, optionsOrCb, maybeCb) => {
        const opts = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
        const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
        sent.push({ tabId, msg, frameId: opts ? opts.frameId : undefined });
        deliver(tabId, msg, opts ? opts.frameId : undefined, cb);
      },
      captureVisibleTab: options.noCapture
        ? undefined
        : (windowId, opts, cb) => {
            captures.push({ windowId, opts, at: Date.now() });
            let url;
            try {
              url = options.capture ? options.capture(windowId, opts) : DATA_URL;
            } catch (e) {
              withError({ message: e.message }, () => cb(undefined));
              return;
            }
            ok(() => cb(url));
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
        if (restricted.has(tabId) || !tabs.has(tabId)) {
          withError({ message: 'Cannot access contents of the page.' }, () => cb && cb());
          return;
        }
        unreachable.delete(tabId);
        if (cb) ok(() => cb());
      },
    },
    contextMenus: {
      removeAll: (cb) => cb && cb(),
      create: (item, cb) => cb && cb(),
      onClicked: { addListener: (fn) => listeners.menuClicked.push(fn) },
    },
    sidePanel: { open: () => Promise.resolve() },
    permissions:
      allUrls === 'none'
        ? undefined
        : {
            contains: (query, cb) => {
              permissionChecks.push(query);
              if (allUrls === 'throw') throw new Error('permissions unavailable');
              if (allUrls === 'error') withError({ message: 'nope' }, () => cb(undefined));
              else ok(() => cb(allUrls === true));
            },
            onAdded: { addListener: (fn) => listeners.permAdded.push(fn) },
            onRemoved: { addListener: (fn) => listeners.permRemoved.push(fn) },
          },
    storage: {
      session: options.noSession
        ? undefined
        : {
            get: (keys, cb) => {
              const out = {};
              for (const k of Array.isArray(keys) ? keys : [keys]) if (k in session) out[k] = session[k];
              cb(out);
            },
            set: (obj, cb) => {
              Object.assign(session, JSON.parse(JSON.stringify(obj)));
              if (cb) cb();
            },
          },
      local: {
        get: (keys, cb) => {
          const out = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) if (k in local) out[k] = local[k];
          cb(out);
        },
        set: (o, cb) => {
          Object.assign(local, o);
          if (cb) cb();
        },
      },
      onChanged: { addListener: (fn) => listeners.storageChanged.push(fn) },
    },
  };

  const thumbs = options.thumbs === undefined ? memoryThumbs() : options.thumbs;
  const image = options.image === false ? null : imageApis(options.image || {});
  const context = {
    chrome,
    setTimeout: (...a) => globalThis.setTimeout(...a),
    clearTimeout: (...a) => globalThis.clearTimeout(...a),
    console,
    Blob,
    atob,
    Date: options.Date ?? Date,
    ...(image ? { createImageBitmap: image.createImageBitmap, OffscreenCanvas: image.OffscreenCanvas } : {}),
    ...(options.context ?? {}),
  };
  if (thumbs) context.LLThumbs = thumbs;
  vm.createContext(context);
  if (options.loadThumbsStore) vm.runInContext(THUMBS_STORE, context, { filename: 'src/thumbs-store.js' });
  vm.runInContext(BACKGROUND, context, { filename: 'src/background.js' });

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
      port,
      posted,
      post: (m) => onMsg.forEach((fn) => fn(m)),
      disconnect: () => onDisc.forEach((fn) => fn()),
      of: (type) => posted.filter((m) => m.type === type),
    };
    if (typeof hello === 'number') api.post({ type: 'PANEL_HELLO', windowId: hello });
    return api;
  }

  function sendFrom(msg, sender) {
    let response;
    let responded = false;
    let keptOpen = false;
    for (const fn of listeners.message) {
      if (
        fn(msg, sender, (r) => {
          response = r;
          responded = true;
        }) === true
      )
        keptOpen = true;
    }
    return {
      get response() {
        return response;
      },
      get responded() {
        return responded;
      },
      keptOpen,
    };
  }

  return {
    context,
    chrome,
    session,
    local,
    tabs,
    sent,
    relayed,
    injected,
    updates,
    captures,
    thumbs,
    image,
    listeners,
    connectPanel,
    sendFrom,
    /** A message from an extension page (panel/popup). */
    send: (msg) => sendFrom(msg, {}),
    /** A message from a content script in `tabId` (frame 0 unless given). */
    fromTab: (msg, tabId = TAB, extra = {}) => {
      const t = tabs.get(tabId) ?? { id: tabId, windowId: WINDOW };
      return sendFrom(msg, {
        tab: { ...t, ...(extra.tab ?? {}) },
        frameId: extra.frameId ?? 0,
        url: 'https://example.com/',
      });
    },
    /** Resolve once sendResponse has been called. */
    async ask(msg, timeout = 3000) {
      const r = sendFrom(msg, {});
      await until(() => r.responded, { timeout, what: `response to ${msg.type}` });
      return r.response;
    },
    fireUpdated,
    /** From now on the tab refuses injection and nothing in it answers. */
    restrict: (tabId) => {
      restricted.add(tabId);
      unreachable.add(tabId);
    },
    setActive: (tabId) => {
      const t = tabs.get(tabId);
      for (const o of tabs.values()) if (o.windowId === t.windowId) o.active = false;
      t.active = true;
    },
    focusWindow: (w) => (focusedWindow = w),
    addTab: (t) => tabs.set(t.id, { status: 'complete', active: false, ...t }),
    closeTab: (tabId) => {
      tabs.delete(tabId);
      listeners.tabRemoved.forEach((fn) => fn(tabId, {}));
    },
    closeWindow: (windowId) => listeners.windowRemoved.forEach((fn) => fn(windowId)),
    permissionChecks,
    /** The user grants or revokes <all_urls> (fires permissions.onAdded/onRemoved). */
    setAllUrls: (granted) => {
      allUrls = granted;
      const which = granted ? listeners.permAdded : listeners.permRemoved;
      which.forEach((fn) => fn({ origins: ['<all_urls>'], permissions: [] }));
    },
    setSettings: (value) => {
      const oldValue = local.llSettings;
      local.llSettings = value;
      listeners.storageChanged.forEach((fn) => fn({ llSettings: { oldValue, newValue: value } }, 'local'));
    },
    /** Messages the worker relayed to a panel, wherever they went (ports or broadcast). */
    relaysOf: (type, ports = []) =>
      [...relayed, ...ports.flatMap((p) => p.posted)].filter((m) => m.type === type),
  };
}

// ── a minimal in-memory IndexedDB ──────────────────────────────────────────────
// Just enough of the API for src/thumbs-store.js: open/upgrade, one transaction at a
// time per call, put/get/delete, index(name).getAllKeys(key | range), oncomplete
// after every request (including ones issued from onsuccess) has run.

export const FakeKeyRange = {
  only: (v) => ({ includes: (k) => k === v }),
  upperBound: (v, open = false) => ({ includes: (k) => (open ? k < v : k <= v) }),
};

/**
 * failOpen: open() reports an error (count: how many opens fail, default all)
 * throwOnOpen: open() throws synchronously
 * failTransaction: db.transaction() throws (count via failTransactions)
 * failRequests: every request errors (the transaction then errors)
 * preexisting: { [storeName]: { indexes: [] } } a store that exists before upgrade
 */
export function fakeIndexedDB(opts = {}) {
  const databases = new Map();
  const log = { opens: 0, transactions: 0, aborts: 0, upgrades: 0 };
  let openFailures = opts.failOpen ? (opts.count ?? Infinity) : 0;
  let txFailures = opts.failTransaction ? (opts.failTransactions ?? Infinity) : 0;
  const later = (fn) => setTimeout(fn, 0);

  function makeStore(def, tx) {
    const req = (op) => {
      const r = {};
      tx._pending++;
      later(() => {
        try {
          if (opts.failRequests) throw new Error('request failed');
          r.result = op();
          if (r.onsuccess) r.onsuccess();
        } catch (e) {
          r.error = e;
          if (r.onerror) r.onerror();
          tx._fail(e);
        }
        tx._pending--;
        tx._maybeComplete();
      });
      return r;
    };
    return {
      get indexNames() {
        return { contains: (n) => def.indexes.has(n) };
      },
      createIndex: (name, keyPath) => def.indexes.set(name, keyPath),
      put: (value) => {
        if (opts.throwOnPut) throw new Error('DataError');
        return req(() => {
          def.data.set(value[def.keyPath], value);
          return value[def.keyPath];
        });
      },
      get: (key) => req(() => def.data.get(key)),
      delete: (key) => req(() => void def.data.delete(key)),
      index: (name) => ({
        getAllKeys: (query) =>
          req(() => {
            const keyPath = def.indexes.get(name);
            const match = query && typeof query.includes === 'function' ? query.includes : (k) => k === query;
            return [...def.data.values()].filter((v) => match(v[keyPath])).map((v) => v[def.keyPath]);
          }),
      }),
    };
  }

  function makeTx(db, mode) {
    const tx = {
      mode,
      _pending: 0,
      _done: false,
      _fail(e) {
        if (tx._done) return;
        tx._done = true;
        tx.error = e;
        later(() => tx.onerror && tx.onerror());
      },
      _maybeComplete() {
        later(() => {
          if (tx._done || tx._pending) return;
          tx._done = true;
          if (tx.oncomplete) tx.oncomplete();
        });
      },
      objectStore: (name) => {
        const def = db.stores.get(name);
        if (!def) throw new Error('NotFoundError');
        return makeStore(def, tx);
      },
      abort: () => {
        log.aborts++;
        if (tx._done) return;
        tx._done = true;
        later(() => tx.onabort && tx.onabort());
      },
    };
    tx._maybeComplete();
    return tx;
  }

  function connection(db) {
    const conn = {
      closed: false,
      objectStoreNames: { contains: (n) => db.stores.has(n) },
      createObjectStore: (name, { keyPath }) => {
        const def = { keyPath, indexes: new Map(), data: new Map() };
        db.stores.set(name, def);
        return makeStore(def, { _pending: 0, _fail() {}, _maybeComplete() {} });
      },
      transaction: () => {
        log.transactions++;
        if (txFailures > 0) {
          txFailures--;
          throw new Error('InvalidStateError');
        }
        return makeTx(db, 'readwrite');
      },
      close: () => {
        conn.closed = true;
      },
    };
    db.connections.push(conn);
    return conn;
  }

  const factory = {
    log,
    databases,
    open(name, version) {
      log.opens++;
      if (opts.throwOnOpen) throw new Error('SecurityError');
      const r = {};
      later(() => {
        if (openFailures > 0) {
          openFailures--;
          r.error = new Error('open failed');
          if (r.onerror) r.onerror();
          return;
        }
        let db = databases.get(name);
        if (!db) {
          db = { version: 0, stores: new Map(), connections: [] };
          for (const [storeName, def] of Object.entries(opts.preexisting ?? {})) {
            db.stores.set(storeName, {
              keyPath: 'eventId',
              indexes: new Map((def.indexes ?? []).map((i) => [i, i])),
              data: new Map(),
            });
          }
          databases.set(name, db);
        }
        r.result = connection(db);
        if (db.version < version) {
          log.upgrades++;
          db.version = version;
          r.transaction = makeTx(db, 'versionchange');
          if (r.onupgradeneeded) r.onupgradeneeded();
        }
        if (r.onsuccess) r.onsuccess();
      });
      return r;
    },
    /** Simulate another context upgrading the database. */
    versionChange(name) {
      const db = databases.get(name);
      for (const c of db.connections) if (c.onversionchange) c.onversionchange();
    },
    /** Simulate the browser closing the connection. */
    closeAll(name) {
      const db = databases.get(name);
      for (const c of db.connections) if (c.onclose) c.onclose();
    },
  };
  return factory;
}
