// src/thumbs-store.js: the IndexedDB store for step screenshots, shared by the
// worker (writes) and the side panel (reads). Run as the real shipping file in a VM
// context over a small in-memory IndexedDB (tests/background-harness.mjs).

import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

import { FakeKeyRange, THUMBS_STORE, fakeIndexedDB, flush } from './background-harness.mjs';

const DAY = 24 * 60 * 60 * 1000;

function load(globals = {}) {
  const context = { Promise, Date, setTimeout, ...globals };
  vm.createContext(context);
  vm.runInContext(THUMBS_STORE, context, { filename: 'src/thumbs-store.js' });
  return context;
}

function store(opts = {}) {
  const idb = fakeIndexedDB(opts);
  const ctx = load({ indexedDB: idb, IDBKeyRange: FakeKeyRange });
  return { idb, api: ctx.LLThumbs, ctx };
}

const blob = () => new Blob(['img'], { type: 'image/jpeg' });
const rec = (eventId, extra = {}) => ({
  eventId,
  windowId: 7,
  blob: blob(),
  width: 360,
  height: 225,
  ...extra,
});

describe('thumbs-store: shape', () => {
  it('exposes the documented promise API on globalThis.LLThumbs', () => {
    const { api } = store();
    for (const fn of ['put', 'get', 'getMany', 'delete', 'deleteMany', 'clearWindow', 'prune']) {
      expect(typeof api[fn]).toBe('function');
    }
    expect(api.DB_NAME).toBe('locatra');
    expect(api.STORE).toBe('thumbs');
    expect(api.MAX_AGE_MS).toBe(14 * DAY);
  });

  it('loading it twice keeps the first instance (panel + worker share one origin)', () => {
    const ctx = load({ indexedDB: fakeIndexedDB() });
    const first = ctx.LLThumbs;
    vm.runInContext(THUMBS_STORE, ctx);
    expect(ctx.LLThumbs).toBe(first);
  });

  it('creates the thumbs store with windowId and createdAt indexes on first open', async () => {
    const { api, idb } = store();
    await api.put(rec('a'));
    const db = idb.databases.get('locatra');
    expect(db.version).toBe(1);
    const def = db.stores.get('thumbs');
    expect(def.keyPath).toBe('eventId');
    expect([...def.indexes.keys()].sort()).toEqual(['createdAt', 'windowId']);
  });

  it('adds missing indexes to a store that already exists', async () => {
    const { api, idb } = store({ preexisting: { thumbs: { indexes: ['windowId'] } } });
    await api.put(rec('a'));
    expect([...idb.databases.get('locatra').stores.get('thumbs').indexes.keys()].sort()).toEqual([
      'createdAt',
      'windowId',
    ]);
  });

  it('opens the database once and reuses the connection', async () => {
    const { api, idb } = store();
    await api.put(rec('a'));
    await api.get('a');
    await api.getMany(['a']);
    expect(idb.log.opens).toBe(1);
  });
});

describe('thumbs-store: CRUD', () => {
  it('round-trips a record', async () => {
    const { api } = store();
    const r = rec('evt-1', { createdAt: 1234 });
    expect(await api.put(r)).toBe(true);
    const got = await api.get('evt-1');
    expect(got).toEqual({
      eventId: 'evt-1',
      windowId: 7,
      blob: r.blob,
      width: 360,
      height: 225,
      createdAt: 1234,
    });
  });

  it('normalises optional fields: unknown size and window are null, createdAt defaults to now', async () => {
    const { api } = store();
    const before = Date.now();
    await api.put({ eventId: 'e', blob: blob(), windowId: 'seven', width: 'wide' });
    const got = await api.get('e');
    expect(got.windowId).toBeNull();
    expect(got.width).toBeNull();
    expect(got.height).toBeNull();
    expect(got.createdAt).toBeGreaterThanOrEqual(before);
  });

  it('refuses records without an eventId or a blob, without touching the database', async () => {
    const { api, idb } = store();
    expect(await api.put(null)).toBe(false);
    expect(await api.put({ blob: blob() })).toBe(false);
    expect(await api.put({ eventId: '', blob: blob() })).toBe(false);
    expect(await api.put({ eventId: 'x' })).toBe(false);
    expect(await api.put({ eventId: NaN, blob: blob() })).toBe(false);
    expect(idb.log.opens).toBe(0);
  });

  it('accepts numeric event ids', async () => {
    const { api } = store();
    expect(await api.put(rec(5))).toBe(true);
    expect((await api.get(5)).eventId).toBe(5);
  });

  it('get answers null for unknown or invalid ids', async () => {
    const { api } = store();
    expect(await api.get('nope')).toBeNull();
    expect(await api.get(undefined)).toBeNull();
    expect(await api.get({})).toBeNull();
  });

  it('getMany answers an array aligned with the ids, null where missing or invalid', async () => {
    const { api } = store();
    await api.put(rec('a'));
    await api.put(rec('c'));
    const got = await api.getMany(['a', 'b', null, 'c']);
    expect(got.map((r) => (r ? r.eventId : null))).toEqual(['a', null, null, 'c']);
    expect(await api.getMany([])).toEqual([]);
    expect(await api.getMany('a')).toEqual([]);
  });

  it('delete and deleteMany remove exactly the given records', async () => {
    const { api } = store();
    for (const id of ['a', 'b', 'c', 'd']) await api.put(rec(id));
    expect(await api.delete('a')).toBe(true);
    expect(await api.deleteMany(['b', 'c', '', null])).toBe(2);
    expect((await api.getMany(['a', 'b', 'c', 'd'])).map((r) => r && r.eventId)).toEqual([
      null,
      null,
      null,
      'd',
    ]);
    expect(await api.deleteMany([])).toBe(0);
    expect(await api.deleteMany(undefined)).toBe(0);
    expect(await api.delete('')).toBe(false);
  });

  it('clearWindow removes only that window’s thumbnails', async () => {
    const { api } = store();
    await api.put(rec('a', { windowId: 7 }));
    await api.put(rec('b', { windowId: 7 }));
    await api.put(rec('c', { windowId: 8 }));
    expect(await api.clearWindow(7)).toBe(2);
    expect((await api.getMany(['a', 'b', 'c'])).map((r) => r && r.eventId)).toEqual([null, null, 'c']);
    expect(await api.clearWindow('7')).toBe(0);
    expect(await api.clearWindow(99)).toBe(0);
  });
});

describe('thumbs-store: prune', () => {
  it('drops thumbnails older than 14 days by default and keeps newer ones', async () => {
    const { api } = store();
    const now = Date.now();
    await api.put(rec('old', { createdAt: now - 15 * DAY }));
    await api.put(rec('edge', { createdAt: now - 14 * DAY + 60_000 }));
    await api.put(rec('new', { createdAt: now - DAY }));
    expect(await api.prune()).toBe(1);
    expect((await api.getMany(['old', 'edge', 'new'])).map((r) => r && r.eventId)).toEqual([
      null,
      'edge',
      'new',
    ]);
  });

  it('honours a custom age', async () => {
    const { api } = store();
    const now = Date.now();
    await api.put(rec('a', { createdAt: now - 2 * DAY }));
    await api.put(rec('b', { createdAt: now - 10_000 }));
    expect(await api.prune(DAY)).toBe(1);
    expect(await api.get('a')).toBeNull();
    expect(await api.prune(-1)).toBe(0); // invalid age falls back to 14 days
  });

  it('is a no-op without IDBKeyRange', async () => {
    const ctx = load({ indexedDB: fakeIndexedDB() });
    expect(await ctx.LLThumbs.prune()).toBe(0);
  });
});

describe('thumbs-store: degraded environments never reject', () => {
  it('without indexedDB every call resolves to its empty value', async () => {
    const api = load().LLThumbs;
    expect(await api.put(rec('a'))).toBe(false);
    expect(await api.get('a')).toBeNull();
    expect(await api.getMany(['a'])).toEqual([]);
    expect(await api.delete('a')).toBe(false);
    expect(await api.deleteMany(['a'])).toBe(0);
    expect(await api.clearWindow(7)).toBe(0);
  });

  it('an indexedDB getter that throws (privacy mode) counts as unavailable', async () => {
    const context = { Promise, Date, setTimeout };
    Object.defineProperty(context, 'indexedDB', {
      get() {
        throw new Error('SecurityError');
      },
    });
    vm.createContext(context);
    vm.runInContext(THUMBS_STORE, context);
    expect(await context.LLThumbs.put(rec('a'))).toBe(false);
  });

  it('open() throwing resolves the fallback', async () => {
    const { api } = store({ throwOnOpen: true });
    expect(await api.put(rec('a'))).toBe(false);
  });

  it('a failed open is retried on the next call rather than cached', async () => {
    const { api, idb } = store({ failOpen: true, count: 1 });
    expect(await api.put(rec('a'))).toBe(false);
    expect(await api.put(rec('a'))).toBe(true);
    expect(idb.log.opens).toBe(2);
    expect((await api.get('a')).eventId).toBe('a');
  });

  it('a transaction that cannot start resolves the fallback and reopens next time', async () => {
    const { api, idb } = store({ failTransaction: true, failTransactions: 1 });
    expect(await api.get('a')).toBeNull();
    expect(await api.put(rec('a'))).toBe(true);
    expect(idb.log.opens).toBe(2);
  });

  it('a request error fails the transaction to the fallback', async () => {
    const { api } = store({ failRequests: true });
    expect(await api.put(rec('a'))).toBe(false);
    expect(await api.getMany(['a'])).toEqual([]);
    expect(await api.clearWindow(7)).toBe(0);
  });

  it('a request that throws synchronously aborts the transaction', async () => {
    const { api, idb } = store({ throwOnPut: true });
    expect(await api.put(rec('a'))).toBe(false);
    expect(idb.log.aborts).toBe(1);
  });

  it('reopens after another context upgrades or the browser closes the connection', async () => {
    const { api, idb } = store();
    await api.put(rec('a'));
    idb.versionChange('locatra');
    expect(idb.databases.get('locatra').connections[0].closed).toBe(true);
    await api.put(rec('b'));
    expect(idb.log.opens).toBe(2);
    idb.closeAll('locatra');
    await api.get('b');
    expect(idb.log.opens).toBe(3);
  });

  it('a connection whose close() throws on versionchange is still dropped', async () => {
    const { api, idb } = store();
    await api.put(rec('a'));
    const conn = idb.databases.get('locatra').connections[0];
    conn.close = () => {
      throw new Error('already closed');
    };
    idb.versionChange('locatra');
    await flush();
    await api.get('a');
    expect(idb.log.opens).toBe(2);
  });
});
