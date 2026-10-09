// Keyboard shortcuts (manifest `commands`) and the RECORDING_STATE relay.
//
// A shortcut must do exactly what the panel's buttons do — same injection, same
// restricted-page rollback, same session bookkeeping — and, having no UI of its
// own, report a failure on the toolbar button (a "!" badge with the reason as its
// tooltip, for 4 s) and to the window's panel (ACTIVATION_FAILED). Any change to a
// window's recording, whatever caused it, reaches that window's panel as
// RECORDING_STATE, so the panel never has to poll.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ROOT, TAB, WINDOW, flush, setWaiter, startWorker, until } from './background-harness.mjs';

const RESTRICTED =
  "Locatra can't run on this page (browser pages, the Web Store, PDFs and some file:// pages are off-limits).";
const DEFAULT_TITLE = JSON.parse(readFileSync(join(ROOT, 'manifests/manifest.chrome.json'), 'utf8')).action
  .default_title;

const tab = (id = TAB, windowId = WINDOW) => ({ id, windowId, active: true });
const toTab = (w, type, tabId = TAB) => w.sent.filter((s) => s.tabId === tabId && s.msg.type === type);
const states = (w, ports = []) => w.relaysOf('RECORDING_STATE', ports);
const state = (active, extra = {}) => ({
  type: 'RECORDING_STATE',
  windowId: WINDOW,
  active,
  paused: false,
  assertMode: false,
  assertType: null,
  ...extra,
});

/** Watch chrome.sidePanel.open calls (synchronously — the gesture matters). */
function trackOpen(w, impl = () => Promise.resolve()) {
  const opened = [];
  w.chrome.sidePanel.open = (arg) => {
    opened.push(arg);
    return impl(arg);
  };
  return opened;
}

const inspecting = async (w, windowId = WINDOW) =>
  (await w.ask({ type: 'GET_INSPECT_STATE', windowId })).active;
const recording = async (w, windowId = WINDOW) =>
  (await w.ask({ type: 'GET_RECORDING_STATE', windowId })).active;

describe('manifest commands', () => {
  const chrome = JSON.parse(readFileSync(join(ROOT, 'manifests/manifest.chrome.json'), 'utf8'));
  const firefox = JSON.parse(readFileSync(join(ROOT, 'manifests/manifest.firefox.json'), 'utf8'));

  it('declares both commands, with the same keys, in Chrome/Edge and Firefox', () => {
    expect(Object.keys(chrome.commands).sort()).toEqual(['toggle-inspect', 'toggle-recording']);
    expect(firefox.commands).toEqual(chrome.commands);
    expect(chrome.commands['toggle-inspect'].description).toBe('Start or stop inspecting');
    expect(chrome.commands['toggle-recording'].description).toBe('Start or stop recording');
  });

  it('suggests keys that are valid and clear of the browsers’ own shortcuts', () => {
    // Chrome/Edge: Alt+Shift+I opens the feedback form, Alt+Shift+A focuses inactive
    // dialogs, Alt+Shift+T the toolbar, Alt+Shift+B the bookmarks/favorites bar,
    // Alt+Shift+N split view. ChromeOS: Alt+Shift+L/M/S/N. A suggested key that
    // collides with a browser shortcut is silently not assigned: Chromium (1243,
    // Linux) left Alt+Shift+C/P/R/W/X/Z unassigned when an extension suggested them.
    const taken = new Set(['I', 'A', 'T', 'B', 'N', 'L', 'M', 'S', 'C', 'P', 'R', 'W', 'X', 'Z']);
    const keys = Object.values(chrome.commands).map((c) => c.suggested_key.default);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      // Chrome: Ctrl or Alt is required, Ctrl+Alt is not allowed, one letter key.
      expect(key).toMatch(/^Alt\+Shift\+[A-Z]$/);
      expect(taken.has(key.slice(-1)), key).toBe(false);
    }
  });
});

describe('toggle-inspect shortcut', () => {
  it('starts inspecting the tab it was pressed on, opening that window’s panel first', async () => {
    const w = startWorker();
    const opened = trackOpen(w);
    const panel = w.connectPanel(WINDOW);
    w.command('toggle-inspect', tab());
    // Synchronously, on the key press itself: open() needs the user gesture.
    expect(opened).toEqual([{ windowId: WINDOW }]);
    await until(() => toTab(w, 'START_INSPECT').length, { what: 'START_INSPECT' });
    expect(w.injected[0].target).toEqual({ tabId: TAB, allFrames: true });
    expect(panel.of('START_INSPECT')).toEqual([{ type: 'START_INSPECT', windowId: WINDOW, tabId: TAB }]);
    expect(await inspecting(w)).toBe(true);
    expect(w.badges).toEqual([]);
  });

  it('a second press stops, without opening the panel again', async () => {
    const w = startWorker();
    const opened = trackOpen(w);
    w.command('toggle-inspect', tab());
    await until(() => toTab(w, 'START_INSPECT').length);
    w.command('toggle-inspect', tab());
    await until(() => toTab(w, 'STOP_INSPECT').length, { what: 'STOP_INSPECT' });
    expect(opened).toHaveLength(1);
    expect(await inspecting(w)).toBe(false);
    expect(w.relaysOf('STOP_INSPECT').at(-1)).toEqual({ type: 'STOP_INSPECT', windowId: WINDOW, tabId: TAB });
  });

  it('with no tab given, acts on the focused window’s active tab', async () => {
    const w = startWorker({
      tabs: [
        { id: 1, windowId: 1, active: true },
        { id: 2, windowId: 2, active: true },
      ],
      focusedWindow: 2,
    });
    const opened = trackOpen(w);
    w.command('toggle-inspect');
    await until(() => toTab(w, 'START_INSPECT', 2).length);
    expect(toTab(w, 'START_INSPECT', 1)).toEqual([]);
    expect(await inspecting(w, 2)).toBe(true);
    // No window known at the moment of the press: Chrome's open() needs one.
    expect(opened).toEqual([]);
  });

  it('on a restricted page: rolls back, flashes the badge and tells the panel why', async () => {
    const w = startWorker({ restrictedTabs: [TAB] });
    const panel = w.connectPanel(WINDOW);
    w.command('toggle-inspect', tab());
    await until(() => panel.of('ACTIVATION_FAILED').length, { what: 'ACTIVATION_FAILED' });
    expect(panel.of('ACTIVATION_FAILED')).toEqual([
      { type: 'ACTIVATION_FAILED', windowId: WINDOW, feature: 'inspect', error: RESTRICTED },
    ]);
    expect(panel.of('STOP_INSPECT')).toEqual([{ type: 'STOP_INSPECT', windowId: WINDOW, tabId: TAB }]);
    expect(await inspecting(w)).toBe(false);
    expect(w.badges).toEqual([
      ['color', { color: '#B83A2E', tabId: TAB }],
      ['text', { text: '!', tabId: TAB }],
      ['title', { title: `Locatra: ${RESTRICTED}`, tabId: TAB }],
    ]);
    expect(toTab(w, 'START_INSPECT')).toEqual([]);
  });

  it('with no tab at all, reports that — on the global badge', async () => {
    const w = startWorker({ tabs: [] });
    w.command('toggle-inspect');
    await until(() => w.relaysOf('ACTIVATION_FAILED').length);
    expect(w.relaysOf('ACTIVATION_FAILED')).toEqual([
      {
        type: 'ACTIVATION_FAILED',
        windowId: undefined,
        feature: 'inspect',
        error: 'No active tab to inspect.',
      },
    ]);
    expect(w.badges[1]).toEqual(['text', { text: '!' }]);
  });

  it('inspect still starts when the panel refuses to open, or open() throws', async () => {
    for (const impl of [() => Promise.reject(new Error('no gesture')), () => undefined]) {
      const w = startWorker();
      trackOpen(w, impl);
      w.command('toggle-inspect', tab());
      await until(() => toTab(w, 'START_INSPECT').length);
    }
    const w = startWorker();
    w.chrome.sidePanel.open = () => {
      throw new Error('sync failure');
    };
    w.command('toggle-inspect', tab());
    await until(() => toTab(w, 'START_INSPECT').length);
  });

  it('Firefox: opens the sidebar through browser.sidebarAction', async () => {
    const calls = [];
    const browser = { sidebarAction: { open: () => (calls.push('open'), Promise.resolve()) } };
    const w = startWorker({ context: { browser } });
    w.chrome.sidePanel = undefined;
    w.command('toggle-inspect', tab());
    expect(calls).toEqual(['open']);
    await until(() => toTab(w, 'START_INSPECT').length);
    // A browser with neither API just inspects.
    const w2 = startWorker();
    w2.chrome.sidePanel = undefined;
    w2.command('toggle-inspect', tab());
    await until(() => toTab(w2, 'START_INSPECT').length);
  });

  it('right after a worker restart, state is unknown at the key press: it opens the panel, then still toggles', async () => {
    const first = startWorker();
    await first.ask({ type: 'START_INSPECT', windowId: WINDOW });
    const second = startWorker({ session: first.session });
    const opened = trackOpen(second);
    second.command('toggle-inspect', tab());
    expect(opened).toEqual([{ windowId: WINDOW }]);
    await until(() => toTab(second, 'STOP_INSPECT').length, { what: 'STOP_INSPECT' });
    expect(await inspecting(second)).toBe(false);
  });

  it('ignores commands it does not know', async () => {
    const w = startWorker();
    const opened = trackOpen(w);
    w.command('_execute_action', tab());
    w.command('something-else', tab());
    await flush(10);
    expect(opened).toEqual([]);
    expect(w.injected).toEqual([]);
    expect(w.relayed).toEqual([]);
  });

  it('a press counts as invoking Locatra on that tab: a blocked screenshot tab is retried', async () => {
    const w = startWorker({
      allUrls: false,
      capture: () => {
        throw new Error('no grant');
      },
    });
    const record = () =>
      w.fromTab({ type: 'RECORDED_ACTION', data: { eventId: 'e' + Math.random(), action: 'click' } });
    record();
    await until(() => w.captures.length === 1);
    await flush(600);
    record();
    await flush(600);
    expect(w.captures).toHaveLength(1); // blocked after the failure
    w.command('toggle-recording', tab());
    await until(() => toTab(w, 'START_RECORDING').length);
    record();
    await until(() => w.captures.length === 2, { what: 'a retried capture' });
  });
});

describe('the failure badge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setWaiter((ms) => vi.advanceTimersByTimeAsync(ms));
  });
  afterEach(() => {
    setWaiter(null);
    vi.useRealTimers();
  });

  it('clears after 4 s, restoring the button’s own title', async () => {
    const w = startWorker({ restrictedTabs: [TAB] });
    w.command('toggle-inspect', tab());
    await until(() => w.badges.length === 3);
    await flush(3900);
    expect(w.badges).toHaveLength(3);
    await flush(200);
    expect(w.badges.slice(3)).toEqual([
      ['text', { text: '', tabId: TAB }],
      ['title', { title: DEFAULT_TITLE, tabId: TAB }],
    ]);
  });

  it('a second failure restarts the 4 s', async () => {
    const w = startWorker({ restrictedTabs: [TAB] });
    w.command('toggle-inspect', tab());
    await until(() => w.badges.length === 3);
    await flush(3000);
    w.command('toggle-recording', tab());
    await until(() => w.badges.length === 6);
    await flush(3000); // 6 s after the first, 3 s after the second
    expect(w.badges.filter((b) => b[0] === 'text' && b[1].text === '')).toEqual([]);
    await flush(1100);
    expect(w.badges.filter((b) => b[0] === 'text' && b[1].text === '')).toHaveLength(1);
  });

  it('survives a browser without chrome.action, setters that throw or reject, and a manifest it cannot read', async () => {
    const w = startWorker({ restrictedTabs: [TAB], noAction: true });
    w.command('toggle-inspect', tab());
    await until(() => w.relaysOf('ACTIVATION_FAILED').length);

    const w2 = startWorker({ restrictedTabs: [TAB] });
    w2.chrome.action.setBadgeText = () => {
      throw new Error('boom');
    };
    w2.chrome.action.setTitle = () => Promise.reject(new Error('later boom'));
    w2.chrome.runtime.getManifest = () => {
      throw new Error('no manifest');
    };
    w2.command('toggle-inspect', tab());
    await until(() => w2.relaysOf('ACTIVATION_FAILED').length);
    await flush(4100);

    const w3 = startWorker({ restrictedTabs: [TAB] });
    const titles = [];
    w3.chrome.action.setTitle = (d) => titles.push(d.title);
    w3.chrome.runtime.getManifest = () => ({});
    w3.command('toggle-inspect', tab());
    await until(() => titles.length === 1);
    await flush(4100);
    expect(titles[1]).toBe('Locatra');
  });
});

describe('toggle-recording shortcut', () => {
  it('starts a session for the window, then stops it', async () => {
    const w = startWorker();
    const opened = trackOpen(w);
    const panel = w.connectPanel(WINDOW);
    w.command('toggle-recording', tab());
    await until(() => toTab(w, 'START_RECORDING').length, { what: 'START_RECORDING' });
    expect(opened).toEqual([]); // only inspect opens the panel
    expect(await recording(w)).toBe(true);
    expect(panel.of('RECORDING_STATE')).toEqual([state(true)]);

    w.command('toggle-recording', tab());
    await until(() => toTab(w, 'STOP_RECORDING').length, { what: 'STOP_RECORDING' });
    expect(toTab(w, 'STOP_RECORDING')[0].msg).toEqual({ type: 'STOP_RECORDING' });
    expect(await recording(w)).toBe(false);
    expect(panel.of('RECORDING_STATE')).toEqual([state(true), state(false)]);
  });

  it('stops a session the panel started, even a paused one, from any of its tabs', async () => {
    const w = startWorker({
      tabs: [
        { id: TAB, windowId: WINDOW, active: false },
        { id: 43, windowId: WINDOW, active: true },
      ],
    });
    w.setActive(TAB);
    await w.ask({ type: 'START_RECORDING', windowId: WINDOW });
    await w.ask({ type: 'PAUSE_RECORDING', windowId: WINDOW });
    w.setActive(43);
    w.command('toggle-recording', tab(43));
    await until(() => toTab(w, 'STOP_RECORDING').length, { what: 'STOP_RECORDING to the session tab' });
    expect(await recording(w)).toBe(false);
  });

  it('on a restricted page: no session is left behind, and the failure is reported', async () => {
    const w = startWorker({ restrictedTabs: [TAB] });
    const panel = w.connectPanel(WINDOW);
    w.command('toggle-recording', tab());
    await until(() => panel.of('ACTIVATION_FAILED').length);
    expect(panel.of('ACTIVATION_FAILED')).toEqual([
      { type: 'ACTIVATION_FAILED', windowId: WINDOW, feature: 'recording', error: RESTRICTED },
    ]);
    await until(() => panel.of('RECORDING_STATE').length);
    expect(panel.of('RECORDING_STATE')).toEqual([state(false)]);
    expect(await recording(w)).toBe(false);
  });

  it('with no tab at all, says so', async () => {
    const w = startWorker({ tabs: [] });
    w.command('toggle-recording');
    await until(() => w.relaysOf('ACTIVATION_FAILED').length);
    expect(w.relaysOf('ACTIVATION_FAILED')[0]).toMatchObject({
      feature: 'recording',
      error: 'No active tab to record.',
    });
  });
});

describe('a browser without chrome.commands', () => {
  it('still runs the worker', async () => {
    const w = startWorker({ noCommands: true });
    expect(w.listeners.command).toEqual([]);
    expect((await w.ask({ type: 'START_INSPECT', windowId: WINDOW })).ok).toBe(true);
  });
});

describe('RECORDING_STATE, from every source', () => {
  it('panel Start / Pause / Resume / Assert / Stop each reach that window’s panel only', async () => {
    const w = startWorker({
      tabs: [
        { id: TAB, windowId: WINDOW, active: true },
        { id: 50, windowId: 8, active: true },
      ],
    });
    const mine = w.connectPanel(WINDOW);
    const other = w.connectPanel(8);
    await w.ask({ type: 'START_RECORDING', windowId: WINDOW });
    await w.ask({ type: 'PAUSE_RECORDING', windowId: WINDOW });
    await w.ask({ type: 'RESUME_RECORDING', windowId: WINDOW });
    await w.ask({ type: 'SET_ASSERT_MODE', windowId: WINDOW, on: true, assertType: 'toHaveText' });
    await w.ask({ type: 'SET_ASSERT_MODE', windowId: WINDOW, on: false });
    await w.ask({ type: 'STOP_RECORDING', windowId: WINDOW });
    expect(mine.of('RECORDING_STATE')).toEqual([
      state(true),
      state(true, { paused: true }),
      state(true),
      state(true, { assertMode: true, assertType: 'toHaveText' }),
      state(true, { assertType: 'toHaveText' }),
      state(false),
    ]);
    expect(other.of('RECORDING_STATE')).toEqual([]);
  });

  it('says nothing when a Stop had no session to stop', async () => {
    const w = startWorker();
    await w.ask({ type: 'STOP_RECORDING', windowId: WINDOW });
    expect(states(w)).toEqual([]);
  });

  it('a start on an already-recording window that turns out restricted reports the session as it stands', async () => {
    const w = startWorker({
      tabs: [
        { id: TAB, windowId: WINDOW, active: true },
        { id: 43, windowId: WINDOW, active: false },
      ],
      restrictedTabs: [43],
    });
    const panel = w.connectPanel(WINDOW);
    await w.ask({ type: 'START_RECORDING', windowId: WINDOW });
    await w.ask({ type: 'PAUSE_RECORDING', windowId: WINDOW });
    w.setActive(43);
    expect((await w.ask({ type: 'START_RECORDING', windowId: WINDOW })).ok).toBe(false);
    await until(() => panel.of('RECORDING_STATE').length === 3);
    // Start un-pauses; the session (on TAB) carries on.
    expect(panel.of('RECORDING_STATE')[2]).toEqual(state(true));
    expect((await w.ask({ type: 'GET_RECORDING_STATE', windowId: WINDOW })).tabIds).toEqual([TAB]);
  });

  it('closing the session’s last tab ends it; closing another tab does not', async () => {
    const w = startWorker({
      tabs: [
        { id: TAB, windowId: WINDOW, active: true },
        { id: 43, windowId: WINDOW, active: false },
      ],
    });
    const panel = w.connectPanel(WINDOW);
    await w.ask({ type: 'START_RECORDING', windowId: WINDOW });
    w.closeTab(43); // never joined
    await flush(5);
    expect(panel.of('RECORDING_STATE')).toEqual([state(true)]);
    w.listeners.tabCreated.forEach((fn) => fn({ id: 60, openerTabId: TAB }));
    await flush(5);
    w.closeTab(60); // joined, not the last
    await flush(5);
    expect(panel.of('RECORDING_STATE')).toEqual([state(true)]);
    w.closeTab(TAB);
    await until(() => panel.of('RECORDING_STATE').length === 2);
    expect(panel.of('RECORDING_STATE')[1]).toEqual(state(false));
  });

  it('closing the window ends its session', async () => {
    const w = startWorker();
    await w.ask({ type: 'START_RECORDING', windowId: WINDOW });
    w.closeWindow(WINDOW);
    await until(() => states(w).length === 2);
    expect(states(w)[1]).toEqual(state(false));
    // A window that was not recording says nothing.
    w.closeWindow(123);
    await flush(5);
    expect(states(w)).toHaveLength(2);
  });

  it('a replay pauses the recording for its run and resumes it after, telling the panel both times', async () => {
    const w = startWorker({
      respond: (tabId, msg) => (msg.type === 'REPLAY_STEP' ? { ok: true } : undefined),
    });
    const panel = w.connectPanel(WINDOW);
    await w.ask({ type: 'START_RECORDING', windowId: WINDOW });
    const res = await w.ask({
      type: 'REPLAY_START',
      windowId: WINDOW,
      steps: [{ action: 'fill', target: { kind: 'css', value: '#a' }, value: 'x' }],
    });
    expect(res.ok).toBe(true);
    await until(() => panel.of('REPLAY_DONE').length, { what: 'REPLAY_DONE' });
    expect(panel.of('RECORDING_STATE')).toEqual([state(true), state(true, { paused: true }), state(true)]);
  });
});
