// Shared plumbing for the options page suites (tests/options*.dom.test.mjs).
//
// options.js is a classic script that initialises against whatever markup is in the
// document when it runs, so every test mounts the real src/options.html body and
// runs the real file again behind a fresh chrome stub. The stub behaves like
// chrome.storage.local: asynchronous callbacks, get(null) for everything, and
// storage.onChanged events (old/new values) for every set/remove — this page's own
// writes included, as in the browser.

/* global setTimeout, window, document */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OPTIONS_JS = readFileSync(join(ROOT, 'src/options.js'), 'utf8');

/** codegen.js plus every plug-in target module that exists yet, in options.html order. */
export function loadCodegen() {
  delete globalThis.LLCodegen;
  for (const f of ['codegen.js', 'codegen-java.js', 'codegen-csharp.js', 'codegen-wdio.js']) {
    const p = join(ROOT, 'src', f);
    if (existsSync(p)) vm.runInThisContext(readFileSync(p, 'utf8'), { filename: p });
  }
}

export const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/** The real options markup, minus its script tags. */
export function mountOptions() {
  const html = readFileSync(join(ROOT, 'src/options.html'), 'utf8');
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  document.body.innerHTML = (body ? body[1] : '').replace(/<script[\s\S]*?<\/script>/gi, '');
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * A chrome stub. `state` is inspected by the tests:
 *   store            chrome.storage.local contents
 *   ops              ordered log of storage writes ('set:k1,k2' / 'remove:k')
 *   sent             runtime.sendMessage payloads
 *   tabs             tabs.create arguments
 *   permRequests     permissions.request calls
 */
export function makeChrome(opts = {}) {
  const state = {
    store: clone(opts.storage || {}),
    ops: [],
    sent: [],
    tabs: [],
    permRequests: [],
    changeListeners: [],
    permListeners: { added: [], removed: [] },
    lastError: null,
    failNext: {}, // op -> message: the next get/set/remove reports lastError
    granted: opts.granted === undefined ? true : opts.granted,
    commands: opts.commands,
    thumbsResponse: 'thumbsResponse' in opts ? opts.thumbsResponse : { ok: true },
  };
  const later = (fn) => setTimeout(fn, 0);
  const withError = (op, cb) => {
    const msg = state.failNext[op];
    if (msg) {
      delete state.failNext[op];
      chrome.runtime.lastError = { message: msg };
      try {
        cb();
      } finally {
        chrome.runtime.lastError = null;
      }
      return true;
    }
    return false;
  };
  const emit = (changes) => {
    if (!Object.keys(changes).length) return;
    state.changeListeners.forEach((fn) => fn(clone(changes), 'local'));
  };

  const chrome = {
    runtime: {
      lastError: null,
      getManifest: () => opts.manifest || { name: 'Locatra – Smart Locator Automation', version: '9.8.7' },
      sendMessage: (msg, cb) => {
        state.sent.push(msg);
        if (opts.sendThrows) throw new Error('worker gone');
        later(() => {
          if (state.failNext.send) {
            withError('send', () => cb && cb(undefined));
            return;
          }
          if (cb) cb(clone(state.thumbsResponse));
        });
      },
    },
    storage: {
      local: {
        get: (keys, cb) =>
          later(() => {
            if (withError('get', () => cb(undefined))) return;
            if (keys == null) return cb(clone(state.store));
            const list = Array.isArray(keys) ? keys : [keys];
            const out = {};
            list.forEach((k) => {
              if (Object.prototype.hasOwnProperty.call(state.store, k)) out[k] = clone(state.store[k]);
            });
            cb(out);
          }),
        set: (obj, cb) =>
          later(() => {
            if (withError('set', () => cb && cb())) return;
            state.ops.push('set:' + Object.keys(obj).join(','));
            const changes = {};
            Object.keys(obj).forEach((k) => {
              changes[k] = { oldValue: clone(state.store[k]), newValue: clone(obj[k]) };
              state.store[k] = clone(obj[k]);
            });
            if (cb) cb();
            emit(changes);
          }),
        remove: (keys, cb) =>
          later(() => {
            if (withError('remove', () => cb && cb())) return;
            const list = Array.isArray(keys) ? keys : [keys];
            state.ops.push('remove:' + list.join(','));
            const changes = {};
            list.forEach((k) => {
              if (Object.prototype.hasOwnProperty.call(state.store, k)) {
                changes[k] = { oldValue: clone(state.store[k]) };
                delete state.store[k];
              }
            });
            if (cb) cb();
            emit(changes);
          }),
      },
      onChanged: { addListener: (fn) => state.changeListeners.push(fn) },
    },
    permissions: {
      contains: (q, cb) => later(() => cb(state.granted)),
      request: (q, cb) => {
        state.permRequests.push(q);
        if (opts.requestThrows) throw new Error('not a gesture');
        const answer = typeof opts.grantOnRequest === 'boolean' ? opts.grantOnRequest : true;
        if (opts.promiseRequest) {
          return Promise.resolve().then(() => {
            if (answer) state.granted = true;
            if (opts.promiseRequest === 'reject') throw new Error('denied');
            return answer;
          });
        }
        later(() => {
          if (answer) state.granted = true;
          cb(answer);
        });
        return undefined;
      },
      onAdded: { addListener: (fn) => state.permListeners.added.push(fn) },
      onRemoved: { addListener: (fn) => state.permListeners.removed.push(fn) },
    },
    tabs: {
      create: (arg, cb) => {
        state.tabs.push(arg);
        later(() => {
          if (opts.tabsError) withError('tabs', () => cb && cb());
          else if (cb) cb({ id: 1 });
        });
      },
    },
  };
  if (opts.tabsError) state.failNext.tabs = opts.tabsError;
  if (opts.commands !== null) {
    chrome.commands = {
      getAll: (cb) => later(() => cb(clone(state.commands || []))),
    };
  }
  return { chrome, state };
}

/**
 * Mount the page, install the stub (and optionally a Firefox-style `browser`), run
 * options.js and wait for its initial load. Returns the stub state and the page's
 * test seam.
 */
let previousWindowListeners = [];

export async function openOptions(opts = {}) {
  if (opts.mount !== false) mountOptions();
  const { chrome, state } = makeChrome(opts);
  if (opts.beforeInit) opts.beforeInit(chrome, state);
  globalThis.chrome = opts.noChrome ? undefined : chrome;
  if (opts.browser) globalThis.browser = opts.browser;
  else delete globalThis.browser;
  // Each run is a fresh page: listeners an earlier run put on `window` belong to a
  // page that no longer exists, so they are removed (the browser would drop them).
  previousWindowListeners.forEach(([type, fn]) => window.removeEventListener(type, fn));
  previousWindowListeners = [];
  const add = window.addEventListener;
  window.addEventListener = function (type, fn, o) {
    previousWindowListeners.push([type, fn]);
    return add.call(this, type, fn, o);
  };
  try {
    vm.runInThisContext(OPTIONS_JS, { filename: join(ROOT, 'src/options.js') });
  } finally {
    window.addEventListener = add;
  }
  const seam = window.__LocatraOptions;
  await seam.ready;
  await flush();
  return { state, seam, chrome };
}

export const $ = (id) => document.getElementById(id);
export const status = () => $('saveStatus').textContent;

export function setValue(el, value, { change = true } = {}) {
  el.value = value;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  if (change) el.dispatchEvent(new window.Event('change', { bubbles: true }));
}

export function press(el, key, init = {}) {
  const ev = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev;
}

export function toggle(el) {
  el.checked = !el.checked;
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
}
