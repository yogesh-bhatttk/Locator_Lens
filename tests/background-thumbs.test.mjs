// Step screenshots in the service worker (F4): capture after a relayed step,
// throttling, downscaling, the settings toggle, THUMBS_DELETE / THUMBS_CLEAR, the
// startup prune and how thumbs-store.js is loaded.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BACKGROUND,
  DATA_URL,
  FakeKeyRange,
  TAB,
  WINDOW,
  fakeIndexedDB,
  flush,
  imageApis,
  memoryThumbs,
  setWaiter,
  startWorker,
  until,
} from './background-harness.mjs';

// Fake timers throughout: the 500 ms capture spacing and every "wait and see" below
// advance a virtual clock (setTimeout and Date) instead of racing a real one, so the
// suite gives the same answer however loaded the machine is.
beforeEach(() => {
  vi.useFakeTimers();
  setWaiter((ms) => vi.advanceTimersByTimeAsync(ms));
});
afterEach(() => {
  setWaiter(null);
  vi.useRealTimers();
});

/** Await a promise whose work runs on (fake) timers, letting time pass meanwhile. */
async function settle(promise) {
  let done = false;
  let value;
  promise.then((v) => {
    done = true;
    value = v;
  });
  await until(() => done, { what: 'promise' });
  return value;
}

let seq = 0;
const step = (extra = {}) => ({
  eventId: 'evt-' + ++seq,
  action: 'click',
  target: { kind: 'css', value: '#b' },
  rect: { x: 1, y: 2, width: 3, height: 4 },
  ...extra,
});

/** A content script in TAB records a step. */
const record = (w, data, tabId = TAB, tab = {}) =>
  w.fromTab({ type: 'RECORDED_ACTION', data }, tabId, { tab });

const thumbsOf = (w) => w.relaysOf('STEP_THUMBNAIL');

describe('step screenshots: capture', () => {
  it('captures the visible tab after a recorded step, downscales it and announces it', async () => {
    const w = startWorker();
    const panel = w.connectPanel(WINDOW);
    const data = step();
    record(w, data);
    await until(() => panel.of('STEP_THUMBNAIL').length, { what: 'STEP_THUMBNAIL' });

    expect(w.captures).toEqual([
      { windowId: WINDOW, opts: { format: 'jpeg', quality: 60 }, at: expect.any(Number) },
    ]);
    const put = w.thumbs.calls.find((c) => c[0] === 'put')[1];
    expect(put).toEqual({
      eventId: data.eventId,
      windowId: WINDOW,
      blob: expect.any(Object),
      width: 360,
      height: 225, // 1280x800 → 360 wide, aspect kept
      createdAt: expect.any(Number),
    });
    expect(put.blob.type).toBe('image/jpeg');
    expect(w.image.log.canvases).toEqual([[360, 225]]);
    expect(w.image.log.drawn).toEqual([[0, 0, 360, 225]]);
    expect(w.image.log.converted).toEqual([{ type: 'image/jpeg', quality: 0.7 }]);
    expect(w.image.log.closed).toBe(1); // the decoded bitmap is released
    expect(panel.of('STEP_THUMBNAIL')).toEqual([
      { type: 'STEP_THUMBNAIL', windowId: WINDOW, eventId: data.eventId },
    ]);
    // The step itself was relayed first, untouched by the screenshot work.
    expect(panel.of('RECORDED_ACTION')[0].data.rect).toEqual(data.rect);
  });

  it('does not capture suggested steps, viewport steps or steps without an eventId', async () => {
    const w = startWorker();
    record(w, step({ action: 'assert', suggested: true, reason: 'Page navigated to /done' }));
    record(w, step({ action: 'viewport', value: '1x1' }));
    record(w, step({ eventId: undefined }));
    record(w, step({ eventId: '' }));
    record(w, undefined);
    await flush(30);
    expect(w.captures).toEqual([]);
    expect(thumbsOf(w)).toEqual([]);
  });

  it('never captures a sensitive step, or a step taken while a secret shows in a field', async () => {
    const w = startWorker();
    record(w, step({ action: 'fill', value: '', sensitive: true, secretName: 'LOCATRA_SECRET' }));
    record(w, step({ action: 'click', sensitiveOnScreen: true }));
    await flush(30);
    expect(w.captures).toEqual([]);
    expect(thumbsOf(w)).toEqual([]);
  });

  it('a sensitive step cancels a capture already queued for its tab (the paste after a clean click)', async () => {
    const w = startWorker();
    record(w, step()); // the first capture goes now…
    await until(() => w.captures.length === 1);
    record(w, step({ action: 'click' })); // …this one waits for the next slot
    record(w, step({ action: 'fill', value: '', sensitive: true, secretName: 'LOCATRA_SECRET' }));
    await flush(1500);
    expect(w.captures).toHaveLength(1);
    // Also when the sensitive step lands before the clean one was even queued.
    const w2 = startWorker();
    record(w2, step());
    record(w2, step({ action: 'click', sensitiveOnScreen: true }));
    await flush(1500);
    expect(w2.captures).toEqual([]);
    // Only that tab: another tab's queued capture is untouched.
    const w3 = startWorker({
      tabs: [
        { id: TAB, windowId: WINDOW, active: true },
        { id: 70, windowId: 8, active: true },
      ],
    });
    record(w3, step(), 70);
    record(w3, step({ action: 'fill', value: '', sensitive: true }));
    await until(() => w3.captures.length === 1);
    expect(w3.captures[0].windowId).toBe(8);
  });

  it('a secret showing in any frame of the tab blocks its captures (SENSITIVE_ON_SCREEN)', async () => {
    const w = startWorker();
    const flag = (visible, frameId = 3, tabId = TAB) =>
      w.fromTab({ type: 'SENSITIVE_ON_SCREEN', visible }, tabId, { frameId });
    flag(true); // the payment iframe shows a card number
    await flush(5);
    record(w, step()); // "Pay" clicked in the top frame, which sees nothing
    await flush(700);
    expect(w.captures).toEqual([]);
    flag(true, 5);
    flag(false);
    record(w, step());
    await flush(700);
    expect(w.captures).toEqual([]); // frame 5 still shows one
    flag(false, 5);
    await flush(5);
    record(w, step());
    await until(() => w.captures.length === 1);
  });

  it('a frame starting to show a secret voids queued and in-flight captures of its tab', async () => {
    let w;
    let duringCapture = null;
    w = startWorker({
      capture: () => {
        if (duringCapture) duringCapture();
        return DATA_URL;
      },
    });
    // Queued: waiting for its slot when the card number appears.
    record(w, step());
    await until(() => w.captures.length === 1);
    record(w, step());
    await flush(5);
    w.fromTab({ type: 'SENSITIVE_ON_SCREEN', visible: true }, TAB, { frameId: 2 });
    w.fromTab({ type: 'SENSITIVE_ON_SCREEN', visible: false }, TAB, { frameId: 2 }); // and goes again
    await flush(1500);
    expect(w.captures).toHaveLength(1);
    const puts = () => w.thumbs.calls.filter((c) => c[0] === 'put').length;
    await until(() => puts() === 1);
    // In flight: the shot is taken as the value appears; the picture is discarded.
    duringCapture = () => {
      duringCapture = null;
      w.fromTab({ type: 'SENSITIVE_ON_SCREEN', visible: true }, TAB, { frameId: 2 });
      w.fromTab({ type: 'SENSITIVE_ON_SCREEN', visible: false }, TAB, { frameId: 2 });
    };
    const data = step();
    record(w, data);
    await until(() => w.captures.length === 2);
    await flush(100);
    expect(puts()).toBe(1);
    expect(w.thumbs.records.has(data.eventId)).toBe(false);
  });

  it('a sensitive step while the capture is being decoded: discarded before it is stored', async () => {
    let w;
    const decoded = imageApis();
    w = startWorker({
      image: false,
      context: {
        OffscreenCanvas: decoded.OffscreenCanvas,
        createImageBitmap: async (blob) => {
          w.fromTab({ type: 'RECORDED_ACTION', data: step({ action: 'fill', value: '', sensitive: true }) });
          return decoded.createImageBitmap(blob);
        },
      },
    });
    const data = step();
    record(w, data);
    await until(() => w.captures.length === 1);
    await flush(100);
    expect(w.thumbs.calls.filter((c) => c[0] === 'put')).toEqual([]);
    expect(thumbsOf(w)).toEqual([]);
    expect(w.thumbs.records.has(data.eventId)).toBe(false);
  });

  it('SENSITIVE_ON_SCREEN: content scripts only, own frame only, well-formed only', async () => {
    const w = startWorker();
    w.send({ type: 'SENSITIVE_ON_SCREEN', visible: true }); // an extension page
    w.sendFrom({ type: 'SENSITIVE_ON_SCREEN', visible: true }, { tab: { id: TAB, windowId: WINDOW } }); // no frameId
    w.fromTab({ type: 'SENSITIVE_ON_SCREEN', visible: 'yes' });
    w.fromTab({ type: 'SENSITIVE_ON_SCREEN' });
    await flush(5);
    record(w, step());
    await until(() => w.captures.length === 1);
    // A frame clears only its own flag, whatever the message says.
    w.fromTab({ type: 'SENSITIVE_ON_SCREEN', visible: true }, TAB, { frameId: 4 });
    w.fromTab({ type: 'SENSITIVE_ON_SCREEN', visible: false, frameId: 4 }, TAB, { frameId: 0 });
    await flush(5);
    record(w, step());
    await flush(700);
    expect(w.captures).toHaveLength(1);
  });

  it('the flag is cleared by a new document in that frame, a navigation or the tab closing — and survives eviction', async () => {
    const session = {};
    let w = startWorker({ session });
    const flag = (visible, frameId = 3) =>
      w.fromTab({ type: 'SENSITIVE_ON_SCREEN', visible }, TAB, { frameId });
    flag(true);
    await flush(5);
    // The worker is evicted and comes back: the frame still shows the number.
    w = startWorker({ session });
    record(w, step());
    await flush(700);
    expect(w.captures).toEqual([]);
    // That frame loads a new document.
    w.fromTab({ type: 'CONTENT_READY' }, TAB, { frameId: 3 });
    await flush(5);
    record(w, step());
    await until(() => w.captures.length === 1);
    // A top-level navigation drops every frame's flag.
    flag(true, 7);
    await flush(5);
    w.fireUpdated(TAB, 'loading');
    await flush(700);
    record(w, step());
    await until(() => w.captures.length === 2);
    // A closed tab forgets it (a tab id is never reused, but nothing may linger).
    flag(true, 7);
    await flush(5);
    w.closeTab(TAB);
    await flush(5);
    expect(JSON.stringify(session)).not.toMatch(/sensitiveFrames":\[\[/);
  });

  it('only captures when the step’s tab is the active tab of its window', async () => {
    const w = startWorker({
      tabs: [
        { id: TAB, windowId: WINDOW, active: true },
        { id: 50, windowId: WINDOW, active: false },
      ],
    });
    record(w, step(), 50, { active: false }); // background tab, says so itself
    await flush(20);
    expect(w.captures).toEqual([]);

    record(w, step(), 50, { active: undefined }); // sender did not say; checked at capture time
    await flush(20);
    expect(w.captures).toEqual([]);

    record(w, step());
    await until(() => w.captures.length === 1);
  });

  it('skips the capture if the user switched tabs before its slot came up', async () => {
    const w = startWorker({
      tabs: [
        { id: TAB, windowId: WINDOW, active: true },
        { id: 50, windowId: WINDOW, active: false },
      ],
    });
    record(w, step());
    await until(() => w.captures.length === 1);
    record(w, step()); // waits for the next slot (≤ 2 per second)…
    w.setActive(50); // …during which the user switches tabs
    await flush(700);
    expect(w.captures).toHaveLength(1);
  });

  it('captures the tab’s own window, but files the thumbnail under the recording’s window', async () => {
    const w = startWorker({
      tabs: [
        { id: TAB, windowId: WINDOW, active: true },
        { id: 60, windowId: 9, active: true },
      ],
    });
    await w.ask({ type: 'START_RECORDING', windowId: WINDOW });
    w.listeners.tabCreated.forEach((fn) => fn({ id: 60, openerTabId: TAB, windowId: 9 }));
    await flush(5);
    const data = step();
    record(w, data, 60);
    await until(() => thumbsOf(w).length);
    expect(w.captures[0].windowId).toBe(9);
    expect(w.thumbs.records.get(data.eventId).windowId).toBe(WINDOW);
    expect(thumbsOf(w)[0]).toEqual({ type: 'STEP_THUMBNAIL', windowId: WINDOW, eventId: data.eventId });
  });

  it('failures are silent: no thumbnail, nothing thrown, and the next step still gets one', async () => {
    let fail = true;
    const w = startWorker({
      capture: () => {
        if (fail) throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
        return DATA_URL;
      },
    });
    record(w, step());
    await until(() => w.captures.length === 1);
    await flush(10);
    expect(w.thumbs.calls.filter((c) => c[0] === 'put')).toEqual([]);
    expect(thumbsOf(w)).toEqual([]);
    fail = false;
    record(w, step());
    await until(() => thumbsOf(w).length === 1, { timeout: 2000 });
  });

  it('a capture that throws synchronously, or returns nothing usable, is also just skipped', async () => {
    const w = startWorker();
    w.chrome.tabs.captureVisibleTab = () => {
      throw new Error('boom');
    };
    record(w, step());
    await flush(20);
    const w2 = startWorker({ capture: () => 'not-a-data-url' });
    record(w2, step());
    await until(() => w2.captures.length === 1);
    await flush(20);
    const w3 = startWorker({ capture: () => undefined });
    record(w3, step());
    await until(() => w3.captures.length === 1);
    await flush(20);
    for (const x of [w, w2, w3]) expect(thumbsOf(x)).toEqual([]);
  });

  it('a store that cannot save means no STEP_THUMBNAIL', async () => {
    const w = startWorker({ thumbs: memoryThumbs({ fail: true }) });
    record(w, step());
    await until(() => w.thumbs.calls.some((c) => c[0] === 'put'));
    await flush(10);
    expect(thumbsOf(w)).toEqual([]);
  });

  it('without a thumbnail store or the capture API nothing is attempted', async () => {
    const w = startWorker({ thumbs: null });
    record(w, step());
    const w2 = startWorker({ noCapture: true });
    record(w2, step());
    await flush(20);
    expect(w.captures).toEqual([]);
    expect(w2.thumbs.calls.filter((c) => c[0] === 'put')).toEqual([]);
  });
});

describe('step screenshots: downscaling fallbacks', () => {
  const putOf = async (w) => {
    await until(() => w.thumbs.calls.some((c) => c[0] === 'put'));
    return w.thumbs.calls.find((c) => c[0] === 'put')[1];
  };

  it('without createImageBitmap/OffscreenCanvas the original JPEG is stored, size unknown', async () => {
    const w = startWorker({ image: false });
    record(w, step());
    const put = await putOf(w);
    expect(put.width).toBeNull();
    expect(put.height).toBeNull();
    expect(put.blob.type).toBe('image/jpeg');
    expect(put.blob.size).toBe(Buffer.from('fake-jpeg-bytes').length);
  });

  it('a capture already narrow enough is kept as is, with its size', async () => {
    const w = startWorker({ image: { width: 300, height: 200 } });
    record(w, step());
    const put = await putOf(w);
    expect([put.width, put.height]).toEqual([300, 200]);
    expect(w.image.log.canvases).toEqual([]);
  });

  it('an image that cannot be decoded is stored as captured', async () => {
    const w = startWorker({ image: { failDecode: true } });
    record(w, step());
    const put = await putOf(w);
    expect([put.width, put.height]).toEqual([null, null]);
  });

  it('no 2D context, or no blob back from the canvas: the original is kept, with its size', async () => {
    for (const image of [{ noContext: true }, { nullBlob: true }]) {
      const w = startWorker({ image });
      record(w, step());
      const put = await putOf(w);
      expect([put.width, put.height]).toEqual([1280, 800]);
    }
  });

  it('a zero-sized decode is treated as unknown size', async () => {
    const w = startWorker({ image: { width: 0, height: 0 } });
    record(w, step());
    const put = await putOf(w);
    expect(put.width).toBeNull();
  });

  it('a non-base64 data URL is decoded too; a broken one stores nothing', async () => {
    const w = startWorker({ image: false, capture: () => 'data:image/jpeg,abc%20def' });
    record(w, step());
    const put = await putOf(w);
    expect(put.blob.size).toBe(7);
    const w2 = startWorker({ image: false, capture: () => 'data:image/jpeg;base64,***' });
    record(w2, step());
    await until(() => w2.captures.length === 1);
    await flush(20);
    expect(w2.thumbs.calls.filter((c) => c[0] === 'put')).toEqual([]);
  });
});

describe('step screenshots: throttling', () => {
  it('captures at most twice a second, keeping only the newest pending step per tab', async () => {
    const w = startWorker();
    const a = step();
    const b = step();
    const c = step();
    record(w, a);
    await until(() => w.captures.length === 1);
    record(w, b);
    record(w, c); // replaces b in the queue
    await until(() => thumbsOf(w).length === 2, { timeout: 2000 });
    await flush(600);
    expect(w.captures).toHaveLength(2);
    expect(w.captures[1].at - w.captures[0].at).toBeGreaterThanOrEqual(490);
    expect(thumbsOf(w).map((m) => m.eventId)).toEqual([a.eventId, c.eventId]);
    expect(w.thumbs.records.has(b.eventId)).toBe(false);
  });

  it('steps from different tabs each keep their own pending slot', async () => {
    const w = startWorker({
      tabs: [
        { id: 1, windowId: 10, active: true },
        { id: 2, windowId: 20, active: true },
      ],
    });
    const a = step();
    const b = step();
    record(w, a, 1);
    record(w, b, 2);
    await until(() => thumbsOf(w).length === 2, { timeout: 2000 });
    expect(w.captures.map((x) => x.windowId)).toEqual([10, 20]);
    expect(w.captures[1].at - w.captures[0].at).toBeGreaterThanOrEqual(490);
  });
});

describe('step screenshots: the stepScreenshots setting', () => {
  it('off in storage: no capture at all', async () => {
    const w = startWorker({ settings: { autoAssertions: true, stepScreenshots: false } });
    record(w, step());
    await flush(30);
    expect(w.captures).toEqual([]);
  });

  it('missing key or field means on', async () => {
    const w = startWorker({ settings: { autoAssertions: false } });
    record(w, step());
    await until(() => w.captures.length === 1);
    const w2 = startWorker({ settings: 'garbage' });
    record(w2, step());
    await until(() => w2.captures.length === 1);
  });

  it('follows storage.onChanged both ways, and drops what was waiting when switched off', async () => {
    const w = startWorker();
    record(w, step());
    await until(() => w.captures.length === 1);
    record(w, step()); // pending for the next slot
    w.setSettings({ stepScreenshots: false });
    await flush(700);
    expect(w.captures).toHaveLength(1);
    record(w, step());
    await flush(30);
    expect(w.captures).toHaveLength(1);
    w.setSettings({ stepScreenshots: true });
    record(w, step());
    await until(() => w.captures.length === 2, { timeout: 2000 });
  });

  it('ignores changes to other keys and other storage areas', async () => {
    const w = startWorker();
    w.listeners.storageChanged.forEach((fn) =>
      fn({ llSettings: { newValue: { stepScreenshots: false } } }, 'sync')
    );
    w.listeners.storageChanged.forEach((fn) => fn({ other: { newValue: 1 } }, 'local'));
    w.listeners.storageChanged.forEach((fn) => fn(undefined, 'local'));
    record(w, step());
    await until(() => w.captures.length === 1);
  });

  it('a change that arrives before the first read is not overwritten by it', async () => {
    const w = startWorker({ settings: { stepScreenshots: true } });
    w.setSettings({ stepScreenshots: false }); // before any step triggered the initial read
    record(w, step());
    await flush(30);
    expect(w.captures).toEqual([]);
  });

  it('works when storage.local is missing or throws', async () => {
    const w = startWorker();
    delete w.chrome.storage.local;
    record(w, step());
    await until(() => w.captures.length === 1);
    const w2 = startWorker();
    w2.chrome.storage.local.get = () => {
      throw new Error('no storage');
    };
    record(w2, step());
    await until(() => w2.captures.length === 1);
  });
});

describe('THUMBS_DELETE / THUMBS_CLEAR', () => {
  it('deletes the given steps’ thumbnails', async () => {
    const w = startWorker();
    const res = await w.ask({ type: 'THUMBS_DELETE', eventIds: ['a', 'b', '', null, 7] });
    expect(res).toEqual({ ok: true, deleted: 3 });
    expect(w.thumbs.calls).toContainEqual(['deleteMany', ['a', 'b', 7]]);
  });

  it('with nothing valid to delete it answers without touching the store', async () => {
    const w = startWorker();
    expect(await w.ask({ type: 'THUMBS_DELETE', eventIds: 'a' })).toEqual({ ok: true, deleted: 0 });
    expect(w.thumbs.calls.filter((c) => c[0] === 'deleteMany')).toEqual([]);
  });

  it('clears one window’s thumbnails', async () => {
    const w = startWorker();
    w.thumbs.records.set('x', { eventId: 'x', windowId: WINDOW });
    w.thumbs.records.set('y', { eventId: 'y', windowId: 99 });
    expect(await w.ask({ type: 'THUMBS_CLEAR', windowId: WINDOW })).toEqual({ ok: true, deleted: 1 });
    expect([...w.thumbs.records.keys()]).toEqual(['y']);
  });

  it('THUMBS_CLEAR needs a window', async () => {
    const w = startWorker();
    expect(await w.ask({ type: 'THUMBS_CLEAR' })).toEqual({
      ok: false,
      error: 'THUMBS_CLEAR needs a windowId.',
    });
  });

  it('answers ok with nothing deleted when there is no store; reports a store that rejects', async () => {
    const w = startWorker({ thumbs: null });
    expect(await w.ask({ type: 'THUMBS_DELETE', eventIds: ['a'] })).toEqual({ ok: true, deleted: 0 });
    expect(await w.ask({ type: 'THUMBS_CLEAR', windowId: WINDOW })).toEqual({ ok: true, deleted: 0 });
    const t = memoryThumbs();
    t.deleteMany = () => Promise.reject(new Error('x'));
    t.clearWindow = () => Promise.resolve('n/a');
    const w2 = startWorker({ thumbs: t });
    expect(await w2.ask({ type: 'THUMBS_DELETE', eventIds: ['a'] })).toEqual({
      ok: false,
      error: 'Could not delete thumbnails.',
    });
    expect(await w2.ask({ type: 'THUMBS_CLEAR', windowId: WINDOW })).toEqual({ ok: true, deleted: 0 });
  });

  it('is ignored from content scripts', () => {
    const w = startWorker();
    expect(w.fromTab({ type: 'THUMBS_CLEAR', windowId: WINDOW }).responded).toBe(false);
    expect(w.fromTab({ type: 'THUMBS_DELETE', eventIds: ['a'] }).responded).toBe(false);
  });

  it('a step deleted while its capture waits never gets a thumbnail', async () => {
    const w = startWorker();
    record(w, step());
    await until(() => w.captures.length === 1);
    const late = step();
    record(w, late); // pending
    await w.ask({ type: 'THUMBS_DELETE', eventIds: [late.eventId] });
    await flush(700);
    expect(w.captures).toHaveLength(1);
  });

  it('a step deleted (or its window cleared) while its capture is in flight is not stored', async () => {
    for (const how of ['delete', 'clear']) {
      let release;
      const t = memoryThumbs();
      const w = startWorker({ thumbs: t, image: { width: 1280, height: 800 } });
      // Hold the downscale so the deletion lands mid-flight.
      const gate = new Promise((r) => (release = r));
      const original = w.context.OffscreenCanvas.prototype.convertToBlob;
      w.context.OffscreenCanvas.prototype.convertToBlob = async function (o) {
        await gate;
        return original.call(this, o);
      };
      const data = step();
      record(w, data);
      await until(() => w.captures.length === 1);
      if (how === 'delete') await w.ask({ type: 'THUMBS_DELETE', eventIds: [data.eventId] });
      else await w.ask({ type: 'THUMBS_CLEAR', windowId: WINDOW });
      release();
      await flush(20);
      expect(
        t.calls.filter((c) => c[0] === 'put'),
        how
      ).toEqual([]);
      expect(thumbsOf(w), how).toEqual([]);
    }
  });

  it('clearing a window drops its pending captures', async () => {
    const w = startWorker();
    record(w, step());
    await until(() => w.captures.length === 1);
    record(w, step());
    await w.ask({ type: 'THUMBS_CLEAR', windowId: WINDOW });
    await flush(700);
    expect(w.captures).toHaveLength(1);
  });

  it('closing a tab drops its pending capture', async () => {
    const w = startWorker();
    record(w, step());
    await until(() => w.captures.length === 1);
    record(w, step());
    w.closeTab(TAB);
    await flush(700);
    expect(w.captures).toHaveLength(1);
  });

  it('keeps its memory of deleted ids bounded', async () => {
    const w = startWorker();
    const ids = Array.from({ length: 600 }, (_, i) => 'gone-' + i);
    expect((await w.ask({ type: 'THUMBS_DELETE', eventIds: ids })).ok).toBe(true);
  });
});

describe('THUMBS_CLEAR_ALL (settings page: “Clear step screenshots”)', () => {
  it('deletes every window’s thumbnails, answers the count and tells every panel', async () => {
    const w = startWorker();
    const a = w.connectPanel(WINDOW);
    const b = w.connectPanel(99);
    w.thumbs.records.set('x', { eventId: 'x', windowId: WINDOW });
    w.thumbs.records.set('y', { eventId: 'y', windowId: 99 });
    expect(await w.ask({ type: 'THUMBS_CLEAR_ALL' })).toEqual({ ok: true, deleted: 2 });
    expect(w.thumbs.records.size).toBe(0);
    expect(w.thumbs.calls).toContainEqual(['clearAll']);
    // No window: every panel drops what it shows.
    expect(a.of('THUMBS_CLEARED')).toEqual([{ type: 'THUMBS_CLEARED', all: true }]);
    expect(b.of('THUMBS_CLEARED')).toEqual([{ type: 'THUMBS_CLEARED', all: true }]);
  });

  it('falls back to pruning everything with a store that predates clearAll', async () => {
    const t = memoryThumbs();
    delete t.clearAll;
    t.prune = (age) => {
      t.calls.push(['prune', age]);
      return Promise.resolve(3);
    };
    const w = startWorker({ thumbs: t });
    expect(await w.ask({ type: 'THUMBS_CLEAR_ALL' })).toEqual({ ok: true, deleted: 3 });
    expect(t.calls).toContainEqual(['prune', 0]);
  });

  it('answers ok with nothing deleted without a store, and reports a store that rejects', async () => {
    const w = startWorker({ thumbs: null });
    expect(await w.ask({ type: 'THUMBS_CLEAR_ALL' })).toEqual({ ok: true, deleted: 0 });
    const t = memoryThumbs();
    t.clearAll = () => Promise.reject(new Error('x'));
    const w2 = startWorker({ thumbs: t });
    expect(await w2.ask({ type: 'THUMBS_CLEAR_ALL' })).toEqual({
      ok: false,
      error: 'Could not delete thumbnails.',
    });
    expect(w2.relaysOf('THUMBS_CLEARED')).toEqual([]);
    const t3 = memoryThumbs();
    t3.clearAll = () => Promise.resolve('n/a');
    expect(await startWorker({ thumbs: t3 }).ask({ type: 'THUMBS_CLEAR_ALL' })).toEqual({
      ok: true,
      deleted: 0,
    });
  });

  it('is ignored from content scripts', () => {
    const w = startWorker();
    expect(w.fromTab({ type: 'THUMBS_CLEAR_ALL' }).responded).toBe(false);
    expect(w.thumbs.calls.filter((c) => c[0] === 'clearAll')).toEqual([]);
  });

  it('drops pending captures, and a capture in flight is not stored', async () => {
    let release;
    const t = memoryThumbs();
    const w = startWorker({ thumbs: t, image: { width: 1280, height: 800 } });
    const gate = new Promise((r) => (release = r));
    const original = w.context.OffscreenCanvas.prototype.convertToBlob;
    w.context.OffscreenCanvas.prototype.convertToBlob = async function (o) {
      await gate;
      return original.call(this, o);
    };
    record(w, step());
    await until(() => w.captures.length === 1);
    record(w, step()); // waits for the next capture slot
    await w.ask({ type: 'THUMBS_CLEAR_ALL' });
    release();
    await flush(700);
    expect(w.captures).toHaveLength(1);
    expect(t.calls.filter((c) => c[0] === 'put')).toEqual([]);
    expect(thumbsOf(w)).toEqual([]);
    // Steps recorded afterwards get their thumbnails as usual.
    record(w, step());
    await until(() => thumbsOf(w).length === 1, { what: 'a new thumbnail' });
  });
});

describe('thumbnail store lifecycle', () => {
  it('prunes old thumbnails when the worker starts', () => {
    const w = startWorker();
    expect(w.thumbs.calls).toEqual([['prune', undefined]]);
  });

  it('a prune that throws or rejects does not break startup', () => {
    const t = memoryThumbs();
    t.prune = () => Promise.reject(new Error('x'));
    expect(() => startWorker({ thumbs: t })).not.toThrow();
    const t2 = memoryThumbs();
    t2.prune = () => {
      throw new Error('x');
    };
    expect(() => startWorker({ thumbs: t2 })).not.toThrow();
  });

  it('Chrome (classic worker): pulls thumbs-store.js in with importScripts, next to background.js', () => {
    const calls = [];
    const w = startWorker({ thumbs: null, context: { importScripts: (...files) => calls.push(files) } });
    expect(calls).toEqual([['thumbs-store.js']]);
    expect(w.context.LLThumbs).toBeUndefined();
  });

  it('Firefox (module background, store already loaded by the manifest): no importScripts', () => {
    const calls = [];
    startWorker({ context: { importScripts: (...files) => calls.push(files) } });
    expect(calls).toEqual([]);
  });

  it('a failing importScripts leaves the worker running without thumbnails', async () => {
    const w = startWorker({
      thumbs: null,
      context: {
        importScripts: () => {
          throw new Error('NetworkError');
        },
      },
    });
    record(w, step());
    await flush(20);
    expect(w.captures).toEqual([]);
    expect(w.relaysOf('RECORDED_ACTION')).toHaveLength(1);
  });

  it('end to end with the real thumbs-store.js over IndexedDB', async () => {
    const idb = fakeIndexedDB();
    const w = startWorker({
      thumbs: null,
      loadThumbsStore: true,
      context: { indexedDB: idb, IDBKeyRange: FakeKeyRange },
    });
    const data = step();
    record(w, data);
    await until(() => thumbsOf(w).length, { what: 'thumbnail' });
    const stored = await settle(w.context.LLThumbs.get(data.eventId));
    expect(stored).toMatchObject({ eventId: data.eventId, windowId: WINDOW, width: 360, height: 225 });
    expect(await w.ask({ type: 'THUMBS_DELETE', eventIds: [data.eventId] })).toEqual({
      ok: true,
      deleted: 1,
    });
    expect(await settle(w.context.LLThumbs.get(data.eventId))).toBeNull();
  });

  it('the shipped background.js loads thumbs-store.js only by a literal, local path', () => {
    expect(BACKGROUND).toMatch(/importScripts\('thumbs-store\.js'\)/);
  });
});

describe('step screenshots: the optional <all_urls> permission', () => {
  it('asks once whether <all_urls> is granted, and captures when it is', async () => {
    const w = startWorker({ allUrls: true });
    record(w, step());
    await until(() => thumbsOf(w).length === 1);
    record(w, step());
    await until(() => thumbsOf(w).length === 2, { timeout: 2000 });
    expect(w.permissionChecks).toEqual([{ origins: ['<all_urls>'] }]); // cached
  });

  it('known not granted: still tries, since an activeTab grant is enough on that tab', async () => {
    const w = startWorker({ allUrls: false });
    record(w, step());
    await until(() => thumbsOf(w).length === 1); // the capture succeeded (activeTab)
    record(w, step());
    await until(() => thumbsOf(w).length === 2, { timeout: 2000 });
  });

  it('after a refusal without <all_urls> the tab is left alone until it navigates', async () => {
    let refuse = true;
    const w = startWorker({
      allUrls: false,
      capture: () => {
        if (refuse) throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
        return DATA_URL;
      },
    });
    record(w, step());
    await until(() => w.captures.length === 1);
    await flush(600);
    record(w, step());
    record(w, step());
    await flush(700);
    expect(w.captures).toHaveLength(1); // blocked: not asked again
    refuse = false;
    w.fireUpdated(TAB, 'loading'); // a new page
    record(w, step());
    await until(() => thumbsOf(w).length === 1, { timeout: 2000 });
    expect(w.captures).toHaveLength(2);
  });

  it('…or until the user invokes the extension on that tab again', async () => {
    for (const invoke of [
      (w) => w.send({ type: 'START_RECORDING', windowId: WINDOW }),
      (w) => w.send({ type: 'START_INSPECT', windowId: WINDOW }),
      (w) =>
        w.listeners.menuClicked.forEach((fn) =>
          fn({ menuItemId: 'll-toggle-panel' }, { id: TAB, windowId: WINDOW })
        ),
    ]) {
      let refuse = true;
      const w = startWorker({
        allUrls: false,
        capture: () => {
          if (refuse) throw new Error('no grant');
          return DATA_URL;
        },
      });
      record(w, step());
      await until(() => w.captures.length === 1);
      await flush(600);
      refuse = false;
      // A command that does not act on a tab changes nothing.
      w.send({ type: 'GET_RECORDING_STATE', windowId: WINDOW });
      record(w, step());
      await flush(50);
      expect(w.captures).toHaveLength(1);
      invoke(w);
      await flush(5);
      record(w, step());
      await until(() => thumbsOf(w).length === 1, { timeout: 2000, what: String(invoke) });
    }
  });

  it('…or until <all_urls> is granted; other tabs are never affected', async () => {
    let refuse = true;
    const w = startWorker({
      allUrls: false,
      tabs: [
        { id: TAB, windowId: WINDOW, active: true },
        { id: 2, windowId: 20, active: true },
      ],
      capture: (windowId) => {
        if (refuse && windowId === WINDOW) throw new Error('no grant');
        return DATA_URL;
      },
    });
    record(w, step());
    await until(() => w.captures.length === 1);
    record(w, step(), 2);
    await until(() => thumbsOf(w).length === 1, { timeout: 2000 }); // tab 2 unaffected
    refuse = false;
    w.setAllUrls(true);
    await flush(5);
    record(w, step());
    await until(() => thumbsOf(w).length === 2, { timeout: 2000 });
  });

  it('with <all_urls> granted a failed capture does not block the tab', async () => {
    let refuse = true;
    const w = startWorker({
      allUrls: true,
      capture: () => {
        if (refuse) throw new Error('window minimised');
        return DATA_URL;
      },
    });
    record(w, step());
    await until(() => w.captures.length === 1);
    refuse = false;
    await flush(600);
    record(w, step());
    await until(() => thumbsOf(w).length === 1, { timeout: 2000 });
  });

  it('closing a blocked tab forgets it', async () => {
    const w = startWorker({
      allUrls: false,
      capture: () => {
        throw new Error('no grant');
      },
    });
    record(w, step());
    await until(() => w.captures.length === 1);
    expect(() => w.closeTab(TAB)).not.toThrow();
  });

  it('when it cannot be told (no API, an error, a throw) the capture is attempted anyway', async () => {
    for (const allUrls of ['none', 'error', 'throw']) {
      const w = startWorker({ allUrls });
      record(w, step());
      await until(() => w.captures.length === 1, { what: allUrls });
    }
  });

  it('re-checks the permission on every grant and revocation', async () => {
    const w = startWorker({ allUrls: false });
    expect(await w.ask({ type: 'GET_SCREENSHOT_PERMISSION' })).toMatchObject({ granted: false });
    w.setAllUrls(true);
    expect(await w.ask({ type: 'GET_SCREENSHOT_PERMISSION' })).toMatchObject({ granted: true });
    w.setAllUrls(false);
    expect(await w.ask({ type: 'GET_SCREENSHOT_PERMISSION' })).toMatchObject({ granted: false });
    expect(w.permissionChecks).toHaveLength(3);
  });

  it('GET_SCREENSHOT_PERMISSION tells the panel', async () => {
    expect(
      await startWorker({ allUrls: true }).ask({ type: 'GET_SCREENSHOT_PERMISSION', windowId: WINDOW })
    ).toEqual({
      granted: true,
      available: true,
    });
    expect(await startWorker({ allUrls: false }).ask({ type: 'GET_SCREENSHOT_PERMISSION' })).toEqual({
      granted: false,
      available: true,
    });
    expect(await startWorker({ allUrls: 'none' }).ask({ type: 'GET_SCREENSHOT_PERMISSION' })).toEqual({
      granted: false,
      available: false,
    });
    const w = startWorker({ allUrls: false });
    expect(await w.ask({ type: 'GET_SCREENSHOT_PERMISSION' })).toMatchObject({ granted: false });
    w.setAllUrls(true);
    expect(await w.ask({ type: 'GET_SCREENSHOT_PERMISSION' })).toMatchObject({ granted: true });
    expect(w.fromTab({ type: 'GET_SCREENSHOT_PERMISSION' }).responded).toBe(false);
  });
});
