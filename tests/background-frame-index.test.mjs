// C4 · FRAME_INDEX_LOOKUP: a subframe behind a cross-origin parent asks the worker
// where its hidden levels sit among their parents' <iframe>s. The worker asks the
// top frame directly (frameId 0) and a deeper parent by broadcasting its
// window.frames path (FRAME_CHILD_INDEX); `respond` models what the frames answer.

import { describe, expect, it } from 'vitest';

import { NO_ANSWER, TAB, startWorker, until } from './background-harness.mjs';

const childAsks = (sent) => sent.filter((s) => s.msg.type === 'FRAME_CHILD_INDEX');

/** A lookup from a subframe; resolves with the worker's answer. */
async function lookup(w, msg, frameId = 5) {
  const r = w.fromTab(Object.assign({ type: 'FRAME_INDEX_LOOKUP' }, msg), TAB, { frameId });
  expect(r.keptOpen).toBe(true);
  await until(() => r.responded, { what: 'lookup answer' });
  return r.response;
}

describe('C4 · FRAME_INDEX_LOOKUP routing', () => {
  it('asks the top frame (frameId 0) about a first-level frame', async () => {
    const w = startWorker({
      respond: (tabId, msg, frameId) =>
        msg.type === 'FRAME_CHILD_INDEX' && frameId === 0 && msg.framesIndex === 3
          ? { ok: true, index: 1 }
          : NO_ANSWER,
    });
    expect(await lookup(w, { path: [3], levels: [0] })).toEqual({ ok: true, indices: [1] });
    expect(childAsks(w.sent)).toEqual([
      { tabId: TAB, frameId: 0, msg: { type: 'FRAME_CHILD_INDEX', parentPath: [], framesIndex: 3 } },
    ]);
  });

  it('asks a nested parent by its window.frames path, to every frame', async () => {
    const w = startWorker({
      respond: (tabId, msg, frameId) => {
        if (msg.type !== 'FRAME_CHILD_INDEX') return NO_ANSWER;
        if (frameId === 0 && msg.parentPath.length === 0) return { ok: true, index: 1 };
        // Delivered to every frame: only the one at [3] owns the question.
        if (frameId === undefined && msg.parentPath.join() === '3' && msg.framesIndex === 2)
          return { ok: true, index: 0 };
        return NO_ANSWER;
      },
    });
    expect(await lookup(w, { path: [3, 2], levels: [0, 1, 1] })).toEqual({ ok: true, indices: [1, 0] });
    expect(childAsks(w.sent).map((s) => [s.frameId, s.msg.parentPath])).toEqual([
      [0, []],
      [undefined, [3]],
    ]);
  });

  it('a frame with no window.frames position is described by the browser’s URL for it', async () => {
    const w = startWorker({
      respond: (tabId, msg, frameId) =>
        msg.type === 'FRAME_CHILD_INDEX' && frameId === undefined && msg.framesIndex === -1
          ? { ok: true, index: 2 }
          : NO_ANSWER,
    });
    const r = w.sendFrom(
      { type: 'FRAME_INDEX_LOOKUP', path: [2, -1], levels: [1], url: 'https://spoofed.example/' },
      { tab: { id: TAB, windowId: 7 }, frameId: 8, url: 'https://pay.example/checkout' }
    );
    await until(() => r.responded, { what: 'lookup answer' });
    expect(r.response).toEqual({ ok: true, indices: [null, 2] });
    expect(childAsks(w.sent)[0].msg).toEqual({
      type: 'FRAME_CHILD_INDEX',
      parentPath: [2],
      framesIndex: -1,
      url: 'https://pay.example/checkout',
    });
    // A sender without a URL cannot be found that way: that level is dropped.
    const noUrl = w.sendFrom(
      { type: 'FRAME_INDEX_LOOKUP', path: [-1], levels: [0] },
      { tab: { id: TAB, windowId: 7 }, frameId: 8 }
    );
    expect(noUrl.response).toEqual({ ok: false });
    const partly = w.sendFrom(
      { type: 'FRAME_INDEX_LOOKUP', path: [1, -1], levels: [0, 1] },
      { tab: { id: TAB, windowId: 7 }, frameId: 8 }
    );
    await until(() => partly.responded, { what: 'partial answer' });
    expect(partly.response).toEqual({ ok: true, indices: [null, null] });
    expect(
      childAsks(w.sent)
        .slice(1)
        .map((s) => s.msg)
    ).toEqual([{ type: 'FRAME_CHILD_INDEX', parentPath: [], framesIndex: 1 }]);
  });

  it('only asks about the levels named; the others stay null', async () => {
    const w = startWorker({ respond: () => ({ ok: true, index: 4 }) });
    expect(await lookup(w, { path: [0, 1, 2], levels: [1] })).toEqual({ ok: true, indices: [null, 4, null] });
    expect(childAsks(w.sent)).toHaveLength(1);
    expect(childAsks(w.sent)[0].msg).toEqual({ type: 'FRAME_CHILD_INDEX', parentPath: [0], framesIndex: 1 });
  });

  it('a parent that does not answer, cannot place the child, or answers nonsense gives null', async () => {
    for (const answer of [
      NO_ANSWER,
      { ok: true, index: -1 },
      { ok: false },
      { ok: true, index: 1.5 },
      null,
    ]) {
      const w = startWorker({ respond: () => answer });
      expect(await lookup(w, { path: [2], levels: [0] })).toEqual({ ok: true, indices: [null] });
    }
  });

  it('a tab (or frame) that went away gives null', async () => {
    const w = startWorker({ unreachableTabs: [TAB] });
    expect(await lookup(w, { path: [2], levels: [0] })).toEqual({ ok: true, indices: [null] });
    const w2 = startWorker();
    w2.chrome.tabs.sendMessage = () => {
      throw new Error('No tab with id');
    };
    expect(await lookup(w2, { path: [2], levels: [0] })).toEqual({ ok: true, indices: [null] });
  });

  it('a parent that never answers times out to null', async () => {
    const w = startWorker({ respond: () => new Promise(() => {}) });
    const started = Date.now();
    expect(await lookup(w, { path: [2, 0], levels: [0, 1] })).toEqual({ ok: true, indices: [null, null] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(350); // FRAME_LOOKUP_TIMEOUT_MS, both levels at once
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('a late answer after the timeout changes nothing', async () => {
    let late = null;
    const w = startWorker({
      respond: () =>
        new Promise((resolve) => {
          late = resolve;
        }),
    });
    const r = w.fromTab({ type: 'FRAME_INDEX_LOOKUP', path: [1], levels: [0] }, TAB, { frameId: 9 });
    await until(() => r.responded, { what: 'timeout answer' });
    late({ ok: true, index: 0 });
    await new Promise((res) => setTimeout(res, 5));
    expect(r.response).toEqual({ ok: true, indices: [null] });
  });
});

describe('C4 · FRAME_INDEX_LOOKUP sender and payload checks', () => {
  it('only a content script in a subframe may ask', () => {
    const w = startWorker({ respond: () => ({ ok: true, index: 0 }) });
    const fromPage = w.send({ type: 'FRAME_INDEX_LOOKUP', path: [0], levels: [0] });
    expect(fromPage).toMatchObject({ responded: false, keptOpen: false });
    const fromTop = w.fromTab({ type: 'FRAME_INDEX_LOOKUP', path: [0], levels: [0] });
    expect(fromTop).toMatchObject({ responded: false, keptOpen: false });
    // An extension page loaded in a tab is not a content script either.
    const ext = w.sendFrom(
      { type: 'FRAME_INDEX_LOOKUP', path: [0], levels: [0] },
      {
        tab: { id: TAB, windowId: 7 },
        frameId: 3,
        url: 'chrome-extension://test-extension-id/src/sidepanel.html',
      }
    );
    expect(ext).toMatchObject({ responded: false, keptOpen: false });
    expect(childAsks(w.sent)).toHaveLength(0);
  });

  it('a malformed request is refused without asking any frame', () => {
    const w = startWorker({ respond: () => ({ ok: true, index: 0 }) });
    const bad = [
      {},
      { path: 'x', levels: [0] },
      { path: [], levels: [0] },
      { path: [0, 0, 0, 0, 0, 0, 0, 0, 0], levels: [0] },
      { path: [10000], levels: [0] },
      { path: [-2], levels: [0] },
      { path: [-1, 0], levels: [1] }, // below a frame with no position: no path to its parent
      { path: [-1, 0], levels: [0] }, // a frame with no position that is not the asker
      { path: [0.5], levels: [0] },
      { path: [0], levels: [] },
      { path: [0], levels: 'x' },
      { path: [0], levels: [1] },
      { path: [0], levels: [-1] },
    ];
    for (const msg of bad) {
      const r = w.fromTab(Object.assign({ type: 'FRAME_INDEX_LOOKUP' }, msg), TAB, { frameId: 4 });
      expect(r.response).toEqual({ ok: false });
    }
    expect(childAsks(w.sent)).toHaveLength(0);
  });

  it('a lookup in flight neither holds nor reorders the steps relayed meanwhile', async () => {
    const w = startWorker({ respond: () => new Promise(() => {}) });
    const panel = w.connectPanel(7);
    w.fromTab({ type: 'FRAME_INDEX_LOOKUP', path: [1], levels: [0] }, TAB, { frameId: 2 });
    w.fromTab({ type: 'RECORDED_ACTION', data: { eventId: 'top-1', action: 'click' } });
    w.fromTab({ type: 'RECORDED_ACTION', data: { eventId: 'frame-1', action: 'click' } }, TAB, {
      frameId: 2,
    });
    w.fromTab({ type: 'RECORDED_ACTION', data: { eventId: 'top-2', action: 'click' } });
    await until(() => panel.of('RECORDED_ACTION').length === 3, { what: 'relays' });
    expect(panel.of('RECORDED_ACTION').map((m) => m.data.eventId)).toEqual(['top-1', 'frame-1', 'top-2']);
  });
});
