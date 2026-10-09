// Edge paths of the service worker's existing plumbing that tests/background.test.mjs
// does not reach: the panel-open/close messages, port edge cases, senders that may
// not issue a command, hydration of older state shapes, and tab/window lifecycle.

import { describe, expect, it } from 'vitest';

import { TAB, WINDOW, flush, startWorker, until } from './background-harness.mjs';

describe('OPEN_SIDE_PANEL / CLOSE_SIDE_PANEL (kept for older callers)', () => {
  it('opens the panel of the given window and reports the outcome', async () => {
    const w = startWorker();
    const opened = [];
    w.chrome.sidePanel.open = (arg) => {
      opened.push(arg);
      return Promise.resolve();
    };
    expect(await w.ask({ type: 'OPEN_SIDE_PANEL', windowId: WINDOW })).toEqual({ ok: true });
    expect(opened).toEqual([{ windowId: WINDOW }]);
  });

  it('without a windowId it uses the active tab’s window; with no tab it cannot', async () => {
    const w = startWorker();
    const opened = [];
    w.chrome.sidePanel.open = (arg) => {
      opened.push(arg);
      return Promise.resolve();
    };
    expect(await w.ask({ type: 'OPEN_SIDE_PANEL' })).toEqual({ ok: true });
    expect(opened).toEqual([{ windowId: WINDOW }]);
    const w2 = startWorker({ tabs: [] });
    expect(await w2.ask({ type: 'OPEN_SIDE_PANEL' })).toEqual({
      ok: false,
      error: 'Side panel API unavailable.',
    });
  });

  it('passes on the browser’s refusal (no user gesture) instead of claiming success', async () => {
    const w = startWorker();
    w.chrome.sidePanel.open = () =>
      Promise.reject(new Error('sidePanel.open() may only be called in response to a user gesture.'));
    expect(await w.ask({ type: 'OPEN_SIDE_PANEL', windowId: WINDOW })).toEqual({
      ok: false,
      error: 'sidePanel.open() may only be called in response to a user gesture.',
    });
    w.chrome.sidePanel.open = () => Promise.reject('plain');
    expect((await w.ask({ type: 'OPEN_SIDE_PANEL', windowId: WINDOW })).error).toBe('plain');
  });

  it('with no side-panel API, or window 0, it says the API is unavailable', async () => {
    const w = startWorker();
    delete w.chrome.sidePanel;
    expect(await w.ask({ type: 'OPEN_SIDE_PANEL', windowId: WINDOW })).toEqual({
      ok: false,
      error: 'Side panel API unavailable.',
    });
    const w2 = startWorker();
    expect((await w2.ask({ type: 'OPEN_SIDE_PANEL', windowId: 0 })).ok).toBe(false);
  });

  it('Firefox: opens and closes the sidebar through browser.sidebarAction', async () => {
    const calls = [];
    const browser = {
      sidebarAction: {
        open: () => {
          calls.push('open');
          return Promise.resolve();
        },
        close: () => {
          calls.push('close');
          return Promise.reject(new Error('no gesture'));
        },
      },
    };
    const w = startWorker({ context: { browser } });
    delete w.chrome.sidePanel;
    expect(await w.ask({ type: 'OPEN_SIDE_PANEL', windowId: WINDOW })).toEqual({ ok: true });
    expect(await w.ask({ type: 'CLOSE_SIDE_PANEL', windowId: WINDOW })).toEqual({
      ok: false,
      error: 'no gesture',
    });
    expect(calls).toEqual(['open', 'close']);
  });

  it('Chrome: closes through sidePanel.close when it exists, else says it cannot', async () => {
    const w = startWorker();
    expect(await w.ask({ type: 'CLOSE_SIDE_PANEL', windowId: WINDOW })).toEqual({
      ok: false,
      error: 'This browser cannot close the panel programmatically.',
    });
    const closed = [];
    w.chrome.sidePanel.close = (arg) => {
      closed.push(arg);
      return Promise.resolve();
    };
    expect(await w.ask({ type: 'CLOSE_SIDE_PANEL', windowId: WINDOW })).toEqual({ ok: true });
    expect(closed).toEqual([{ windowId: WINDOW }]);
    // close() needs a window to aim at.
    expect((await w.ask({ type: 'CLOSE_SIDE_PANEL' })).ok).toBe(false);
  });
});

describe('panel ports', () => {
  it('ignores untyped port messages, and a hello without a window', async () => {
    const w = startWorker();
    const p = w.connectPanel();
    p.post(null);
    p.post({ type: 7 });
    p.post({ type: 'PANEL_HELLO' });
    await flush(5);
    expect(p.posted).toEqual([]);
    // A port that never named its window gets every relay.
    w.fromTab({ type: 'LAB_STATUS_UPDATE', data: { count: 1 } }, TAB);
    expect(p.of('LAB_STATUS_UPDATE')).toHaveLength(1);
  });

  it('a port that dies during the buffered replay keeps the buffer for next time', async () => {
    const session = {
      llRecordBuffer: { [WINDOW]: [{ eventId: 'a' }, { eventId: 'b' }] },
    };
    const w = startWorker({ session });
    const p = w.connectPanel();
    p.port.postMessage = () => {
      throw new Error('disconnected');
    };
    p.post({ type: 'PANEL_HELLO', windowId: WINDOW });
    await flush(5);
    expect(session.llRecordBuffer[WINDOW]).toHaveLength(2);
  });

  it('a relay to a port that has gone away drops that port and falls back to the broadcast', async () => {
    const w = startWorker();
    const p = w.connectPanel(WINDOW);
    await flush(5);
    p.port.postMessage = () => {
      throw new Error('gone');
    };
    w.fromTab({ type: 'LAB_STATUS_UPDATE', data: {} }, TAB);
    expect(w.relayed.filter((m) => m.type === 'LAB_STATUS_UPDATE')).toHaveLength(1);
  });

  it('closing one of two panels of a window keeps the window’s panel state', async () => {
    const w = startWorker();
    const a = w.connectPanel(WINDOW);
    w.connectPanel(WINDOW);
    await flush(5);
    a.disconnect();
    await flush(5);
    expect(await w.ask({ type: 'GET_PANEL_STATE', windowId: WINDOW })).toEqual({ active: true });
  });

  it('a panel port counts as "some panel open" when the caller names no window', async () => {
    const w = startWorker();
    expect(await w.ask({ type: 'GET_PANEL_STATE' })).toEqual({ active: false });
    w.connectPanel();
    expect(await w.ask({ type: 'GET_PANEL_STATE' })).toEqual({ active: true });
  });

  it('PANEL_BUFFER_ACK over runtime messaging drops that window’s buffer', async () => {
    const session = { llRecordBuffer: { [WINDOW]: [{ eventId: 'a' }], 8: [{ eventId: 'b' }] } };
    const w = startWorker({ session });
    w.send({ type: 'PANEL_BUFFER_ACK', windowId: WINDOW });
    await flush(5);
    expect(Object.keys(session.llRecordBuffer)).toEqual(['8']);
    w.send({ type: 'PANEL_BUFFER_ACK' }); // no window: nothing to drop
    await flush(5);
    expect(Object.keys(session.llRecordBuffer)).toEqual(['8']);
  });
});

describe('who may send what', () => {
  it('PING is for content scripts to answer, not the worker', () => {
    const w = startWorker();
    expect(w.send({ type: 'PING' }).responded).toBe(false);
  });

  it('page-only messages are ignored from extension pages', async () => {
    const w = startWorker();
    expect(w.send({ type: 'CONTENT_READY' }).keptOpen).toBe(false);
    w.send({ type: 'REQUEST_FRAME_INJECTION' });
    w.send({ type: 'LAB_ERROR', error: 'x' });
    w.send({ type: 'RECORDED_ACTION', data: { eventId: 'x' } });
    await flush(450);
    expect(w.injected).toEqual([]);
    expect(w.relayed).toEqual([]);
  });

  it('UI-only commands are ignored from content scripts', async () => {
    const w = startWorker();
    for (const type of ['START_INSPECT', 'LAB_VALIDATE', 'LAB_CLEAR', 'START_RECORDING', 'STOP_RECORDING']) {
      expect(w.fromTab({ type }).keptOpen, type).toBe(false);
    }
    await flush(5);
    expect(w.sent).toEqual([]);
  });

  it('an extension page opened as a tab is a UI sender, not a content script', async () => {
    const w = startWorker();
    const r = w.sendFrom(
      { type: 'START_INSPECT', windowId: WINDOW },
      { tab: { id: 99, windowId: WINDOW }, url: 'chrome-extension://test-extension-id/src/sidepanel.html' }
    );
    expect(r.keptOpen).toBe(true);
    await until(() => r.responded);
    expect(r.response).toEqual({ ok: true });
  });

  it('a sender URL that cannot be checked (no runtime.getURL) is treated as a page', () => {
    const w = startWorker();
    delete w.chrome.runtime.getURL;
    const r = w.sendFrom(
      { type: 'START_INSPECT' },
      { tab: { id: TAB, windowId: WINDOW }, url: 'https://x/' }
    );
    expect(r.keptOpen).toBe(false);
  });
});

describe('commands with no tab to act on', () => {
  it('START_INSPECT and START_RECORDING say there is no active tab', async () => {
    const w = startWorker({ tabs: [] });
    expect(await w.ask({ type: 'START_INSPECT', windowId: WINDOW })).toEqual({
      ok: false,
      error: 'No active tab to inspect.',
    });
    expect(await w.ask({ type: 'START_RECORDING', windowId: WINDOW })).toEqual({
      ok: false,
      error: 'No active tab to record.',
    });
  });

  it('RUN_STRESS_TEST with no tab still answers, so the button never hangs', () => {
    const w = startWorker({ tabs: [] });
    const panel = w.connectPanel(WINDOW);
    w.send({ type: 'RUN_STRESS_TEST', windowId: WINDOW });
    expect(panel.of('STRESS_TEST_RESULT')).toEqual([
      { type: 'STRESS_TEST_RESULT', data: { survived: false, unavailable: true }, windowId: WINDOW },
    ]);
  });

  it('LAB_VALIDATE with no tab does nothing', () => {
    const w = startWorker({ tabs: [] });
    w.send({ type: 'LAB_VALIDATE', windowId: WINDOW, selector: '#a' });
    expect(w.sent).toEqual([]);
  });

  it('STOP_RECORDING with no session on record still reaches the visible page', async () => {
    const w = startWorker();
    expect(await w.ask({ type: 'STOP_RECORDING', windowId: WINDOW })).toEqual({ ok: true });
    expect(w.sent.filter((s) => s.msg.type === 'STOP_RECORDING').map((s) => s.tabId)).toEqual([TAB]);
  });
});

describe('content script missing: inject and retry', () => {
  it('LAB_VALIDATE injects, then retries to the top frame', async () => {
    const w = startWorker({ unreachableTabs: [TAB] });
    w.send({ type: 'LAB_VALIDATE', windowId: WINDOW, selector: '#a' });
    await until(() => w.sent.filter((s) => s.msg.type === 'LAB_VALIDATE').length === 2);
    expect(w.injected).toHaveLength(1);
    expect(w.sent.filter((s) => s.msg.type === 'LAB_VALIDATE').map((s) => s.frameId)).toEqual([0, 0]);
  });

  it('RUN_STRESS_TEST injects and retries the picked frame, and reports when it still cannot', async () => {
    const w = startWorker();
    const panel = w.connectPanel(WINDOW);
    w.fromTab({ type: 'ELEMENT_PICKED', data: { tag: 'button' } }, TAB, { frameId: 3 });
    await flush(5);
    w.restrict(TAB);
    w.send({ type: 'RUN_STRESS_TEST', windowId: WINDOW });
    await until(() => panel.of('STRESS_TEST_RESULT').length, { what: 'stress result' });
    expect(panel.of('STRESS_TEST_RESULT')[0].data).toEqual({ survived: false, unavailable: true });
    expect(w.sent.filter((s) => s.msg.type === 'RUN_STRESS_TEST').map((s) => s.frameId)).toEqual([3, 3]);
  });

  it('the context-menu copy injects and retries when the frame has no script', async () => {
    const w = startWorker({ unreachableTabs: [TAB] });
    w.listeners.menuClicked.forEach((fn) =>
      fn({ menuItemId: 'll-copy-locator', frameId: 2 }, { id: TAB, windowId: WINDOW })
    );
    await until(() => w.sent.filter((s) => s.msg.type === 'CONTEXT_MENU_COPY').length === 2);
    expect(w.injected).toHaveLength(1);
  });

  it('other context-menu items, and clicks without a tab, do nothing', () => {
    const w = startWorker();
    w.listeners.menuClicked.forEach((fn) =>
      fn({ menuItemId: 'something-else' }, { id: TAB, windowId: WINDOW })
    );
    w.listeners.menuClicked.forEach((fn) => fn({ menuItemId: 'll-copy-locator' }, undefined));
    expect(w.sent).toEqual([]);
  });
});

describe('hydrating older or damaged state', () => {
  it('accepts bare tab ids from the pre-window inspect shape and skips junk sessions', async () => {
    const session = {
      llWorkerState: {
        inspect: [TAB, 'junk'],
        sessions: [null, { windowId: 'x' }, { windowId: WINDOW, tabIds: 'nope', paused: 1 }],
      },
    };
    const w = startWorker({ session });
    expect(await w.ask({ type: 'GET_INSPECT_STATE', windowId: WINDOW })).toEqual({ active: true });
    expect(await w.ask({ type: 'GET_RECORDING_STATE', windowId: WINDOW })).toMatchObject({
      active: true,
      paused: true,
      tabIds: [],
    });
  });

  it('messages that arrive while state is still loading all wait for the same load', async () => {
    let reads = 0;
    const w3 = startWorker({ session: { llWorkerState: { inspect: [[TAB, WINDOW]] } } });
    const realGet = w3.chrome.storage.session.get;
    let release;
    w3.chrome.storage.session.get = (keys, cb) => {
      reads++;
      release = () => realGet(keys, cb);
    };
    const a = w3.send({ type: 'GET_INSPECT_STATE', windowId: WINDOW });
    const b = w3.send({ type: 'GET_PANEL_STATE', windowId: WINDOW });
    expect(reads).toBe(1);
    release();
    await until(() => a.responded && b.responded);
    expect(a.response).toEqual({ active: true });
  });

  it('without storage.session everything still works in memory', async () => {
    const w = startWorker({ noSession: true });
    await w.ask({ type: 'START_RECORDING', windowId: WINDOW });
    w.fromTab({ type: 'RECORDED_ACTION', data: { eventId: 'e1', action: 'click' } });
    expect((await w.ask({ type: 'GET_RECORDING_STATE', windowId: WINDOW })).active).toBe(true);
  });
});

describe('tab and window lifecycle', () => {
  it('ignores created tabs without an opener', async () => {
    const w = startWorker();
    await w.ask({ type: 'START_RECORDING', windowId: WINDOW });
    w.listeners.tabCreated.forEach((fn) => fn(null));
    w.listeners.tabCreated.forEach((fn) => fn({ id: 80 }));
    await flush(5);
    expect((await w.ask({ type: 'GET_RECORDING_STATE', windowId: WINDOW })).tabIds).toEqual([TAB]);
  });

  it('an inspecting tab dragged to another window follows it there', async () => {
    const w = startWorker();
    await w.ask({ type: 'START_INSPECT', windowId: WINDOW });
    w.listeners.tabAttached.forEach((fn) => fn(TAB, { newWindowId: 12 }));
    w.listeners.tabAttached.forEach((fn) => fn(999, { newWindowId: 12 }));
    await flush(5);
    expect(w.session.llWorkerState.inspect).toEqual([[TAB, 12]]);
  });

  it('closing a tab cancels its pending frame injection and leaves other sessions alone', async () => {
    const w = startWorker({
      tabs: [
        { id: TAB, windowId: WINDOW, active: true },
        { id: 2, windowId: 20, active: true },
      ],
    });
    await w.ask({ type: 'START_RECORDING', windowId: WINDOW });
    await w.ask({ type: 'START_RECORDING', windowId: 20 });
    const injectedBefore = w.injected.length;
    w.fromTab({ type: 'REQUEST_FRAME_INJECTION' }, TAB);
    w.closeTab(TAB);
    await flush(450);
    expect(w.injected.length).toBe(injectedBefore);
    expect((await w.ask({ type: 'GET_RECORDING_STATE', windowId: 20 })).tabIds).toEqual([2]);
    expect((await w.ask({ type: 'GET_RECORDING_STATE', windowId: WINDOW })).active).toBe(false);
  });

  it('closing a window forgets its panel heartbeat and its inspecting tabs', async () => {
    const w = startWorker({
      tabs: [
        { id: TAB, windowId: WINDOW, active: true },
        { id: 2, windowId: 20, active: true },
      ],
    });
    w.send({ type: 'PANEL_HEARTBEAT', windowId: WINDOW });
    await w.ask({ type: 'START_INSPECT', windowId: WINDOW });
    await w.ask({ type: 'START_INSPECT', windowId: 20 });
    w.closeWindow(WINDOW);
    await flush(5);
    expect(w.session.llWorkerState.panelSeen).toEqual({});
    expect(w.session.llWorkerState.inspect).toEqual([[2, 20]]);
  });

  it('tab updates other than loading/complete are ignored', async () => {
    const w = startWorker();
    await w.ask({ type: 'START_INSPECT', windowId: WINDOW });
    w.listeners.tabUpdated.forEach((fn) => fn(TAB, { title: 'x' }, { id: TAB }));
    await flush(5);
    expect(await w.ask({ type: 'GET_INSPECT_STATE', windowId: WINDOW })).toEqual({ active: true });
  });

  it('a recorded step from a tab with no window is relayed but not buffered', async () => {
    const w = startWorker();
    w.sendFrom(
      { type: 'RECORDED_ACTION', data: { eventId: 'z', action: 'click' } },
      { tab: { id: 77 }, url: 'https://x/' }
    );
    await flush(5);
    expect(w.relayed.filter((m) => m.type === 'RECORDED_ACTION')).toHaveLength(1);
    expect(w.session.llRecordBuffer).toBeUndefined();
  });
});

describe('replay: browser APIs that throw', () => {
  it('tabs.get / tabs.update / tabs.sendMessage throwing become step failures, not a stuck run', async () => {
    const w = startWorker();
    w.chrome.tabs.update = () => {
      throw new Error('update exploded');
    };
    const panel = w.connectPanel(WINDOW);
    await w.ask({
      type: 'REPLAY_START',
      windowId: WINDOW,
      steps: [{ action: 'goto', value: 'https://a.example/' }],
    });
    await until(() => panel.of('REPLAY_DONE').length);
    expect(panel.of('REPLAY_DONE')[0]).toMatchObject({
      result: 'failed',
      error: 'navigation failed: update exploded',
    });

    const w2 = startWorker();
    w2.chrome.tabs.sendMessage = (tabId, msg, o, cb) => {
      const callback = typeof o === 'function' ? o : cb;
      if (msg.type === 'PING') return callback({ ok: true });
      throw new Error('send exploded');
    };
    await w2.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [{ action: 'click', target: {} }] });
    await until(() => w2.relayed.some((m) => m.type === 'REPLAY_DONE'));
    expect(w2.relayed.find((m) => m.type === 'REPLAY_DONE')).toMatchObject({
      result: 'failed',
      error: 'frame not found or page navigated',
    });

    const w3 = startWorker();
    w3.chrome.tabs.get = () => {
      throw new Error('get exploded');
    };
    await w3.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [{ action: 'click', target: {} }] });
    await until(() => w3.relayed.some((m) => m.type === 'REPLAY_DONE'));
    expect(w3.relayed.find((m) => m.type === 'REPLAY_DONE')).toMatchObject({
      result: 'error',
      error: 'The tab being replayed was closed.',
    });
  });

  it('a goto whose tab vanished is an error for the whole run', async () => {
    const w = startWorker();
    w.chrome.tabs.update = (tabId, props, cb) => {
      w.tabs.delete(tabId);
      cb && cb();
    };
    const res = await w.ask({
      type: 'REPLAY_START',
      windowId: WINDOW,
      steps: [{ action: 'goto', value: 'https://a/' }],
    });
    expect(res.ok).toBe(true);
    await until(() => w.relayed.some((m) => m.type === 'REPLAY_DONE'));
    expect(w.relayed.find((m) => m.type === 'REPLAY_DONE').result).toBe('error');
  });
});
