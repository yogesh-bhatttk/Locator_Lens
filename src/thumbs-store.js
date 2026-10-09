// Locatra – thumbs-store.js
// Step screenshots ("thumbnails") in IndexedDB, shared by the background worker
// (which captures and stores them) and the side panel (which shows them).
//
// Deliberately a plain script with no import/export so it loads everywhere it is
// needed: via importScripts() in Chrome's classic service worker, as a module
// background script listed before background.js in Firefox's manifest, and as a
// classic <script> in the side panel. It only ever touches globalThis.LLThumbs, and
// loading it twice is harmless.
//
// Screenshots never leave the browser: there is no network code here or anywhere
// that reads these records; they stay in this extension's own IndexedDB origin.
//
// Record shape (object store `thumbs`, keyPath `eventId`):
//   { eventId, windowId, blob: Blob (image/jpeg), width, height, createdAt }
// width/height are the stored image's pixel size, or null when unknown.
//
// Every function returns a Promise that never rejects. Without IndexedDB (or when
// the database cannot be opened) each resolves to its "nothing" value: put → false,
// get → null, getMany → [], delete → false, deleteMany/clearWindow/prune → 0.
(function (root) {
  'use strict';
  if (!root || root.LLThumbs) return;

  var DB_NAME = 'locatra';
  var DB_VERSION = 1;
  var STORE = 'thumbs';
  var BY_WINDOW = 'windowId';
  var BY_CREATED = 'createdAt';
  var DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

  var dbPromise = null;

  function factory() {
    try {
      return root.indexedDB || null;
    } catch (e) {
      return null; // some privacy modes throw on access
    }
  }

  function validKey(k) {
    return (typeof k === 'string' && k.length > 0) || (typeof k === 'number' && isFinite(k));
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    var idb = factory();
    if (!idb) return Promise.resolve(null);
    dbPromise = new Promise(function (resolve) {
      var req;
      try {
        req = idb.open(DB_NAME, DB_VERSION);
      } catch (e) {
        resolve(null);
        return;
      }
      req.onupgradeneeded = function () {
        var db = req.result;
        var store = db.objectStoreNames.contains(STORE)
          ? req.transaction.objectStore(STORE)
          : db.createObjectStore(STORE, { keyPath: 'eventId' });
        if (!store.indexNames.contains(BY_WINDOW)) store.createIndex(BY_WINDOW, 'windowId', { unique: false });
        if (!store.indexNames.contains(BY_CREATED)) store.createIndex(BY_CREATED, 'createdAt', { unique: false });
      };
      req.onsuccess = function () {
        var db = req.result;
        // Another context (panel or worker) upgrading the schema: let it, and
        // reopen on our next call.
        db.onversionchange = function () {
          try { db.close(); } catch (e) {}
          dbPromise = null;
        };
        db.onclose = function () { dbPromise = null; };
        resolve(db);
      };
      req.onerror = function () { resolve(null); };
    }).then(function (db) {
      if (!db) dbPromise = null; // try again next time rather than caching a failure
      return db;
    });
    return dbPromise;
  }

  /**
   * Run `body(store, setResult)` in one transaction. Resolves with the last value
   * passed to setResult once the transaction commits, or with `fallback` if
   * anything goes wrong (including the transaction aborting).
   */
  function run(mode, fallback, body) {
    return openDb()
      .then(function (db) {
        if (!db) return fallback;
        return new Promise(function (resolve) {
          var result = fallback;
          var tx;
          try {
            tx = db.transaction(STORE, mode);
          } catch (e) {
            dbPromise = null; // closed underneath us
            resolve(fallback);
            return;
          }
          tx.oncomplete = function () { resolve(result); };
          tx.onerror = function () { resolve(fallback); };
          tx.onabort = function () { resolve(fallback); };
          try {
            body(tx.objectStore(STORE), function (v) { result = v; });
          } catch (e) {
            try { tx.abort(); } catch (err) {}
            resolve(fallback);
          }
        });
      })
      .catch(function () {
        return fallback;
      });
  }

  function put(record) {
    if (!record || !validKey(record.eventId) || !record.blob) return Promise.resolve(false);
    var value = {
      eventId: record.eventId,
      windowId: typeof record.windowId === 'number' ? record.windowId : null,
      blob: record.blob,
      width: typeof record.width === 'number' ? record.width : null,
      height: typeof record.height === 'number' ? record.height : null,
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now()
    };
    return run('readwrite', false, function (store, set) {
      store.put(value);
      set(true);
    });
  }

  function get(eventId) {
    if (!validKey(eventId)) return Promise.resolve(null);
    return run('readonly', null, function (store, set) {
      var req = store.get(eventId);
      req.onsuccess = function () { set(req.result || null); };
    });
  }

  /** @returns Promise<Array<record|null>> aligned with `eventIds`. */
  function getMany(eventIds) {
    var ids = Array.isArray(eventIds) ? eventIds : [];
    if (!ids.length) return Promise.resolve([]);
    var out = ids.map(function () { return null; });
    return run('readonly', [], function (store, set) {
      ids.forEach(function (id, i) {
        if (!validKey(id)) return;
        var req = store.get(id);
        req.onsuccess = function () { out[i] = req.result || null; };
      });
      set(out);
    });
  }

  /** @returns Promise<number> how many of the given ids were submitted for deletion. */
  function deleteMany(eventIds) {
    var ids = (Array.isArray(eventIds) ? eventIds : []).filter(validKey);
    if (!ids.length) return Promise.resolve(0);
    return run('readwrite', 0, function (store, set) {
      ids.forEach(function (id) { store.delete(id); });
      set(ids.length);
    });
  }

  function del(eventId) {
    return deleteMany([eventId]).then(function (n) { return n > 0; });
  }

  /** Delete every thumbnail of one window. @returns Promise<number> deleted. */
  function clearWindow(windowId) {
    if (typeof windowId !== 'number') return Promise.resolve(0);
    return run('readwrite', 0, function (store, set) {
      var req = store.index(BY_WINDOW).getAllKeys(windowId);
      req.onsuccess = function () {
        var keys = req.result || [];
        keys.forEach(function (k) { store.delete(k); });
        set(keys.length);
      };
    });
  }

  /** Delete thumbnails older than maxAgeMs (default 14 days). @returns Promise<number> deleted. */
  function prune(maxAgeMs) {
    var age = typeof maxAgeMs === 'number' && maxAgeMs >= 0 ? maxAgeMs : DEFAULT_MAX_AGE_MS;
    var cutoff = Date.now() - age;
    var KeyRange = root.IDBKeyRange;
    if (!KeyRange || typeof KeyRange.upperBound !== 'function') return Promise.resolve(0);
    return run('readwrite', 0, function (store, set) {
      // Open upper bound: a record exactly at the cutoff is still in its 14 days.
      var req = store.index(BY_CREATED).getAllKeys(KeyRange.upperBound(cutoff, true));
      req.onsuccess = function () {
        var keys = req.result || [];
        keys.forEach(function (k) { store.delete(k); });
        set(keys.length);
      };
    });
  }

  root.LLThumbs = {
    DB_NAME: DB_NAME,
    STORE: STORE,
    MAX_AGE_MS: DEFAULT_MAX_AGE_MS,
    put: put,
    get: get,
    getMany: getMany,
    delete: del,
    deleteMany: deleteMany,
    clearWindow: clearWindow,
    prune: prune
  };
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
