// COPY_VIA_TOP: a quick copy in a subframe whose permissions policy blocks the
// clipboard is relayed to the tab's top frame (frameId 0) as COPY_TEXT, and the
// top frame's answer goes back to the asking frame. INSPECT_HOVERED: a frame that
// starts showing its hover UI has every other frame of the tab hide theirs.

import { describe, expect, it } from 'vitest';

import { NO_ANSWER, TAB, startWorker, until } from './background-harness.mjs';

const copies = (sent) => sent.filter((s) => s.msg.type === 'COPY_TEXT');

describe('COPY_VIA_TOP relay', () => {
  it('asks only the top frame, and passes its answer back', async () => {
    const w = startWorker({
      respond: (tabId, msg, frameId) =>
        msg.type === 'COPY_TEXT' && frameId === 0 ? { ok: true } : NO_ANSWER,
    });
    const r = w.fromTab({ type: 'COPY_VIA_TOP', text: "page.getByRole('button')" }, TAB, { frameId: 5 });
    expect(r.keptOpen).toBe(true);
    await until(() => r.responded, { what: 'relay answer' });
    expect(r.response).toEqual({ ok: true });
    expect(copies(w.sent)).toEqual([
      { tabId: TAB, frameId: 0, msg: { type: 'COPY_TEXT', text: "page.getByRole('button')" } },
    ]);
  });

  it('a top frame that could not copy (or never answered) is a failed copy', async () => {
    const w = startWorker({
      respond: (tabId, msg) => (msg.type === 'COPY_TEXT' ? { ok: false } : NO_ANSWER),
    });
    const r = w.fromTab({ type: 'COPY_VIA_TOP', text: 'x' }, TAB, { frameId: 3 });
    await until(() => r.responded, { what: 'relay answer' });
    expect(r.response).toEqual({ ok: false });

    const silent = startWorker(); // no content script in the top frame
    const r2 = silent.fromTab({ type: 'COPY_VIA_TOP', text: 'x' }, TAB, { frameId: 3 });
    await until(() => r2.responded, { what: 'relay answer' });
    expect(r2.response).toEqual({ ok: false });
  });

  it('is ignored from the top frame itself, from extension pages, and without text', () => {
    const w = startWorker();
    expect(w.fromTab({ type: 'COPY_VIA_TOP', text: 'x' }, TAB, { frameId: 0 }).keptOpen).toBeFalsy();
    expect(w.fromTab({ type: 'COPY_VIA_TOP', text: 42 }, TAB, { frameId: 2 }).keptOpen).toBeFalsy();
    expect(w.send({ type: 'COPY_VIA_TOP', text: 'x' }).keptOpen).toBeFalsy();
    expect(copies(w.sent)).toEqual([]);
  });
});

describe('INSPECT_HOVERED relay', () => {
  it('tells every frame of the tab, with the announcer’s token', () => {
    const w = startWorker();
    w.fromTab({ type: 'INSPECT_HOVERED', token: 't1' }, TAB, { frameId: 4 });
    expect(w.sent.filter((s) => s.msg.type === 'HIDE_HOVER_UI')).toEqual([
      { tabId: TAB, frameId: undefined, msg: { type: 'HIDE_HOVER_UI', token: 't1' } },
    ]);
  });

  it('is ignored from extension pages and without a token', () => {
    const w = startWorker();
    w.send({ type: 'INSPECT_HOVERED', token: 't1' });
    w.fromTab({ type: 'INSPECT_HOVERED' }, TAB, { frameId: 1 });
    expect(w.sent.filter((s) => s.msg.type === 'HIDE_HOVER_UI')).toEqual([]);
  });
});
