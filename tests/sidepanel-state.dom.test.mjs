// @vitest-environment jsdom
//
// Panel state machinery: window scoping, the per-window recorder session, restore
// ordering, sensitive values, edited-script safety. Like sidepanel-render.dom.test,
// the real sidepanel.js is evaluated in this jsdom realm — here behind a richer
// `chrome` stub (windows, an in-memory storage.local, a capturable port, and
// scripted worker responses) so whole flows can run end to end.

/* global outFramework, recorderFileName, copyToClipboard */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WIN = 7;
const DEFER = Symbol('defer');

/** Mutable harness shared with the stub; reset before every test. */
const h = {
  store: {},
  liveWindows: [WIN],
  sent: [],
  responders: {},
  deferred: [],
  deferGet: null, // when set, storage.get(null) callbacks are parked here
  portPosts: [],
  portListener: null,
  runtimeListener: null,
};

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function pick(keys) {
  if (keys == null) return clone(h.store);
  const list = Array.isArray(keys) ? keys : [keys];
  const out = {};
  for (const k of list) if (k in h.store) out[k] = clone(h.store[k]);
  return out;
}

beforeAll(async () => {
  await import('../src/codegen.js');
  globalThis.chrome = {
    windows: {
      getCurrent: (cb) => cb({ id: WIN }),
      getAll: (_opts, cb) => cb(h.liveWindows.map((id) => ({ id }))),
    },
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => {
        h.sent.push(msg);
        const responder = h.responders[msg.type];
        const answer = responder ? responder(msg) : undefined;
        if (answer === DEFER) {
          h.deferred.push({ msg, cb });
          return;
        }
        if (!cb) return;
        if (answer === undefined) {
          chrome.runtime.lastError = { message: 'The message port closed before a response was received.' };
          cb(undefined);
          chrome.runtime.lastError = null;
        } else {
          cb(answer);
        }
      },
      connect: () => ({
        postMessage: (m) => h.portPosts.push(m),
        onMessage: {
          addListener: (fn) => {
            h.portListener = fn;
          },
        },
        onDisconnect: { addListener: () => {} },
      }),
      onMessage: {
        addListener: (fn) => {
          h.runtimeListener = fn;
        },
      },
    },
    storage: {
      local: {
        get: (keys, cb) => {
          if (keys === null && h.deferGet) {
            h.deferGet.push(() => cb(pick(null)));
            return;
          }
          cb(pick(keys));
        },
        set: (obj, cb) => {
          Object.assign(h.store, clone(obj));
          if (cb) cb();
        },
        remove: (keys, cb) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete h.store[k];
          if (cb) cb();
        },
      },
    },
  };
  vm.runInThisContext(readFileSync(join(ROOT, 'src/sidepanel.js'), 'utf8'), { filename: 'sidepanel.js' });
  h.helloPosts = h.portPosts.slice();
});

function resetPanelGlobals() {
  vm.runInThisContext(`
    recordedActions = []; seenActionKeys = new Set(); recRedoStack = []; recFilter = '';
    _recorderRestored = false; _pendingRecorded.length = 0;
    lastSyncedPreviewScript = ''; lastSyncedStepKeys = []; recLastPageUrl = '';
    isRecording = false; isPaused = false; isInspecting = false;
    _recOpsInFlight = 0; _recToggleBusy = false; _recStateEpoch = 0;
    lastResultData = null; lastRenderedPickId = null; _stressState = null;
    outFramework = 'playwright'; outLanguage = 'typescript'; _bufferAckPending = false;
  `);
}

function mountRealPanel() {
  const html = readFileSync(join(ROOT, 'src/sidepanel.html'), 'utf8');
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  document.body.innerHTML = (body ? body[1] : '').replace(/<script[\s\S]*?<\/script>/gi, '');
}

function boot() {
  mountRealPanel();
  document.dispatchEvent(new window.Event('DOMContentLoaded'));
}

const $ = (id) => document.getElementById(id);
const sentOf = (type) => h.sent.filter((m) => m.type === type);
const port = (msg) => h.portListener(msg);
const step = (over = {}) => ({
  action: 'click',
  eventId: 'e-' + Math.random().toString(36).slice(2),
  target: { kind: 'id', value: 'go' },
  code: "page.locator('#go')",
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  h.store = {};
  h.liveWindows = [WIN];
  h.sent = [];
  h.responders = { GET_RECORDING_STATE: () => ({ active: false }) };
  h.deferred = [];
  h.deferGet = null;
  h.portPosts = [];
  resetPanelGlobals();
  window.confirm = vi.fn(() => true);
  window.alert = vi.fn();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

// ── C1: window scoping ──────────────────────────────────────────────────────
describe('window scoping', () => {
  it('says hello on the port with its windowId', () => {
    expect(h.helloPosts).toContainEqual({ type: 'PANEL_HELLO', windowId: WIN });
  });

  it('tags every message it sends (state queries, heartbeat, recorder commands) with windowId', () => {
    boot();
    vi.advanceTimersByTime(4000);
    for (const type of ['GET_INSPECT_STATE', 'GET_RECORDING_STATE', 'PANEL_HEARTBEAT']) {
      expect(sentOf(type).length, type).toBeGreaterThan(0);
      for (const m of sentOf(type)) expect(m.windowId, type).toBe(WIN);
    }
  });

  it('ignores direct content-script broadcasts (sender.tab set)', () => {
    boot();
    h.runtimeListener(
      { type: 'RECORDED_ACTION', data: step({ eventId: 'direct' }) },
      { tab: { id: 1, windowId: WIN } }
    );
    expect(recordedActions).toHaveLength(0);
  });

  it('ignores relays addressed to another window, accepts its own and untagged ones', () => {
    boot();
    port({ type: 'RECORDED_ACTION', windowId: 99, data: step({ eventId: 'other' }) });
    expect(recordedActions).toHaveLength(0);
    port({ type: 'RECORDED_ACTION', windowId: WIN, data: step({ eventId: 'mine' }) });
    h.runtimeListener({ type: 'RECORDED_ACTION', data: step({ eventId: 'bg-fallback' }) }, {});
    expect(recordedActions.map((a) => a.eventId)).toEqual(['mine', 'bg-fallback']);
  });

  it("does not render another window's stored last pick", () => {
    h.store.lastElement = { windowId: 99, elementData: { tag: 'button' }, locators: [] };
    boot();
    expect($('resultsState').style.display).toBe('none');
  });

  it('renders its own stored last pick with the page it came from', () => {
    h.store.lastElement = {
      windowId: WIN,
      pageUrl: 'https://example.com/login',
      elementData: { tag: 'button' },
      locators: [],
    };
    boot();
    expect($('resultsState').style.display).toBe('');
    expect($('elBar').textContent).toContain('https://example.com/login');
  });
});

// ── C2 / findings 2, 3, 6, 10: recorder session lives in the background ───────
describe('recording state from the worker', () => {
  it('restores recording + assert mode + type on reopen', () => {
    h.responders.GET_RECORDING_STATE = () => ({
      active: true,
      paused: false,
      assertMode: true,
      assertType: 'toHaveText',
    });
    boot();
    expect($('recBtnText').textContent).toBe('Stop Recording');
    expect($('assertModeToggle').checked).toBe(true);
    expect($('assertTypeSelect').value).toBe('toHaveText');
    expect($('assertTypeSelect').style.display).toBe('');
  });

  it('re-syncs the assert checkbox on the heartbeat (e.g. after a navigation)', () => {
    let assertMode = true;
    h.responders.GET_RECORDING_STATE = () => ({
      active: true,
      paused: false,
      assertMode,
      assertType: 'toBeVisible',
    });
    boot();
    expect($('assertModeToggle').checked).toBe(true);
    assertMode = false;
    vi.advanceTimersByTime(4000);
    expect($('assertModeToggle').checked).toBe(false);
  });

  it('re-reads the state when a goto step arrives', () => {
    boot();
    const before = sentOf('GET_RECORDING_STATE').length;
    port({
      type: 'RECORDED_ACTION',
      windowId: WIN,
      data: step({ action: 'goto', value: 'https://x.test/', target: undefined }),
    });
    expect(sentOf('GET_RECORDING_STATE').length).toBe(before + 1);
  });

  it('waits for the worker before showing Recording, then follows its answer', () => {
    h.responders.START_RECORDING = () => DEFER;
    boot();
    $('recordBtn').click();
    expect($('recBtnText').textContent).toBe('Starting…');
    expect($('recordBtn').disabled).toBe(true);
    const [{ msg, cb }] = h.deferred;
    expect(msg).toMatchObject({ type: 'START_RECORDING', windowId: WIN });
    h.responders.GET_RECORDING_STATE = () => ({ active: true, paused: false, assertMode: false });
    cb({ ok: true });
    expect($('recBtnText').textContent).toBe('Stop Recording');
    expect($('recordBtn').disabled).toBe(false);
  });

  it('shows the restricted-page error inline and stays idle', () => {
    const error =
      "Locatra can't run on this page (browser pages, the Web Store, PDFs and some file:// pages are off-limits).";
    h.responders.START_RECORDING = () => ({ ok: false, error });
    boot();
    $('recordBtn').click();
    expect($('recBtnText').textContent).toBe('Start Recording');
    expect($('panelStatus').hidden).toBe(false);
    expect($('panelStatus').textContent).toBe(error);
    expect(window.alert).not.toHaveBeenCalled();
  });

  it('reverts Start Inspecting when the worker refuses', () => {
    h.responders.START_INSPECT = () => ({ ok: false, error: 'nope' });
    boot();
    $('inspectBtn').click();
    expect(sentOf('START_INSPECT')[0].windowId).toBe(WIN);
    expect($('btnText').textContent).toBe('Start Inspecting');
    expect($('panelStatus').textContent).toBe('nope');
  });

  it('Stop sends windowId and adopts the reported state', () => {
    let active = true;
    h.responders.GET_RECORDING_STATE = () => ({ active, paused: false });
    h.responders.STOP_RECORDING = () => {
      active = false;
      return { ok: true };
    };
    boot();
    $('recordBtn').click();
    expect(sentOf('STOP_RECORDING')[0].windowId).toBe(WIN);
    expect($('recBtnText').textContent).toBe('Start Recording');
  });

  it('Pause/Resume target the window session and reconcile with the reply', () => {
    let paused = false;
    h.responders.GET_RECORDING_STATE = () => ({ active: true, paused });
    h.responders.PAUSE_RECORDING = () => {
      paused = true;
      return { ok: true };
    };
    h.responders.RESUME_RECORDING = () => ({ ok: true }); // worker did NOT resume (e.g. raced)
    boot();
    $('pauseRecordingBtn').click();
    expect(sentOf('PAUSE_RECORDING')[0].windowId).toBe(WIN);
    expect($('resumeRecordingBtn').style.display).toBe('');
    $('resumeRecordingBtn').click();
    expect(sentOf('RESUME_RECORDING')[0].windowId).toBe(WIN);
    // The worker still reports paused, so the panel must not pretend otherwise.
    expect($('resumeRecordingBtn').style.display).toBe('');
  });

  it('SET_ASSERT_MODE carries windowId and a stale in-flight query cannot undo the toggle', () => {
    h.responders.GET_RECORDING_STATE = () => ({ active: true, paused: false, assertMode: false });
    boot();
    h.responders.GET_RECORDING_STATE = () => DEFER; // a heartbeat query is in flight…
    vi.advanceTimersByTime(4000);
    h.responders.SET_ASSERT_MODE = () => ({ ok: true });
    const toggle = $('assertModeToggle');
    toggle.checked = true;
    toggle.dispatchEvent(new window.Event('change'));
    expect(sentOf('SET_ASSERT_MODE').at(-1)).toMatchObject({ on: true, windowId: WIN });
    // …and answers with the pre-toggle state.
    h.deferred[0].cb({ active: true, paused: false, assertMode: false });
    expect(toggle.checked).toBe(true);
  });
});

// ── C4 / finding 1: sensitive values ───────────────────────────────────────────
describe('sensitive steps', () => {
  it('renders the env var, never a value, and persists no value', () => {
    boot();
    port({
      type: 'RECORDED_ACTION',
      windowId: WIN,
      data: step({ action: 'fill', sensitive: true, secretName: 'LOCATRA_PASSWORD', value: 'hunter2' }),
    });
    const tl = $('recorderTimeline').textContent;
    expect(tl).toContain('•••••• (env LOCATRA_PASSWORD)');
    expect(tl).not.toContain('hunter2');
    vi.advanceTimersByTime(250);
    expect(JSON.stringify(h.store)).not.toContain('hunter2');
    expect(h.store[`llRecorderState:${WIN}`].actions[0].value).toBe('');
  });

  it('scrubs values (and value-bearing dedupe keys) from a previously persisted state', () => {
    h.store.llRecorderState = {
      actions: [
        {
          action: 'fill',
          sensitive: true,
          value: 'hunter2',
          target: { kind: 'id', value: 'pw' },
          timestamp: 1,
        },
      ],
      seenKeys: ['0_1_fill_hunter2_'],
      codePreview: '',
      lastPageUrl: 'https://x.test/',
    };
    boot();
    expect(recordedActions[0].value).toBe('');
    vi.advanceTimersByTime(250);
    expect(JSON.stringify(h.store)).not.toContain('hunter2');
    expect(h.store.llRecorderState).toBeUndefined(); // legacy key migrated away
  });
});

// ── C7 / findings 4, 5: buffered steps and restore ordering ───────────────────
describe('buffer replay and restore ordering', () => {
  it('acknowledges replayed steps only after they are saved', () => {
    boot();
    port({ type: 'RECORDED_ACTION', windowId: WIN, data: step({ eventId: 'r1' }) });
    expect(h.portPosts.some((m) => m.type === 'PANEL_BUFFER_ACK')).toBe(false);
    vi.advanceTimersByTime(250);
    expect(h.store[`llRecorderState:${WIN}`].actions.map((a) => a.eventId)).toEqual(['r1']);
    expect(h.portPosts).toContainEqual({ type: 'PANEL_BUFFER_ACK', windowId: WIN });
  });

  it('queues steps that arrive before the restore and merges them after it (deduped)', () => {
    h.store[`llRecorderState:${WIN}`] = {
      actions: [step({ eventId: 's1' }), step({ eventId: 's2' })],
      seenKeys: ['eid:s1', 'eid:s2'],
      updatedAt: Date.now(),
    };
    h.deferGet = [];
    boot();
    port({ type: 'RECORDED_ACTION', windowId: WIN, data: step({ eventId: 's2' }) }); // replay duplicate
    port({ type: 'RECORDED_ACTION', windowId: WIN, data: step({ eventId: 'n1' }) });
    expect(recordedActions).toHaveLength(0);
    h.deferGet.forEach((fn) => fn());
    expect(recordedActions.map((a) => a.eventId)).toEqual(['s1', 's2', 'n1']);
  });

  it('does not save over the stored timeline before it has been restored', () => {
    h.store[`llRecorderState:${WIN}`] = { actions: [step({ eventId: 's1' })], updatedAt: 1 };
    h.deferGet = [];
    boot();
    port({ type: 'RECORDED_ACTION', windowId: WIN, data: step({ eventId: 'n1' }) });
    vi.advanceTimersByTime(250);
    expect(h.store[`llRecorderState:${WIN}`].actions.map((a) => a.eventId)).toEqual(['s1']);
  });
});

// ── finding 9: per-window persistence ──────────────────────────────────────────
describe('per-window recorder storage', () => {
  it("adopts a closed window's timeline after a restart, but never a live window's", () => {
    h.liveWindows = [WIN, 5];
    h.store['llRecorderState:3'] = { actions: [step({ eventId: 'closed' })], updatedAt: 100 };
    h.store['llRecorderState:5'] = { actions: [step({ eventId: 'live' })], updatedAt: 200 };
    boot();
    expect(recordedActions.map((a) => a.eventId)).toEqual(['closed']);
    vi.advanceTimersByTime(250);
    expect(h.store['llRecorderState:3']).toBeUndefined();
    expect(h.store['llRecorderState:5'].actions[0].eventId).toBe('live');
    expect(h.store[`llRecorderState:${WIN}`].actions[0].eventId).toBe('closed');
  });

  it('prefers its own entry', () => {
    h.store[`llRecorderState:${WIN}`] = { actions: [step({ eventId: 'own' })], updatedAt: 1 };
    h.store['llRecorderState:3'] = { actions: [step({ eventId: 'orphan' })], updatedAt: 999 };
    h.liveWindows = [WIN];
    boot();
    expect(recordedActions.map((a) => a.eventId)).toEqual(['own']);
  });

  it('Clear Timeline removes only this window', () => {
    h.liveWindows = [WIN, 5];
    h.store[`llRecorderState:${WIN}`] = { actions: [step()], updatedAt: 1 };
    h.store['llRecorderState:5'] = { actions: [step()], updatedAt: 1 };
    boot();
    $('clearTimelineBtn').click();
    expect(h.store[`llRecorderState:${WIN}`]).toBeUndefined();
    expect(h.store['llRecorderState:5']).toBeDefined();
  });
});

// ── C6 / finding 17: dblclick supersedes its clicks ────────────────────────────
describe('dblclick supersedes', () => {
  it('removes the superseded click steps, and keeps late ones out', () => {
    boot();
    port({ type: 'RECORDED_ACTION', windowId: WIN, data: step({ eventId: 'c1' }) });
    port({
      type: 'RECORDED_ACTION',
      windowId: WIN,
      data: step({ action: 'dblclick', eventId: 'd1', supersedes: ['c1', 'c2'] }),
    });
    port({ type: 'RECORDED_ACTION', windowId: WIN, data: step({ eventId: 'c2' }) }); // arrived late
    expect(recordedActions.map((a) => a.eventId)).toEqual(['d1']);
  });

  it('honours a separate RECORDED_ACTION_SUPERSEDE relay', () => {
    boot();
    port({ type: 'RECORDED_ACTION', windowId: WIN, data: step({ eventId: 'c1' }) });
    port({ type: 'RECORDED_ACTION', windowId: WIN, data: step({ eventId: 'keep' }) });
    port({ type: 'RECORDED_ACTION_SUPERSEDE', windowId: WIN, data: { supersedes: ['c1'] } });
    expect(recordedActions.map((a) => a.eventId)).toEqual(['keep']);
  });

  it('undo, redo and remove still work afterwards', () => {
    boot();
    for (const id of ['a', 'b', 'c'])
      port({ type: 'RECORDED_ACTION', windowId: WIN, data: step({ eventId: id }) });
    $('undoActionBtn').click();
    expect(recordedActions.map((a) => a.eventId)).toEqual(['a', 'b']);
    // A replay of the undone step must not resurrect it.
    port({ type: 'RECORDED_ACTION', windowId: WIN, data: step({ eventId: 'c' }) });
    expect(recordedActions.map((a) => a.eventId)).toEqual(['a', 'b']);
    $('redoActionBtn').click();
    expect(recordedActions.map((a) => a.eventId)).toEqual(['a', 'b', 'c']);
  });
});

// ── finding 7: edited scripts vs framework switches and new steps ──────────────
describe('edited script safety', () => {
  function bootWithEditedScript() {
    boot();
    port({ type: 'RECORDED_ACTION', windowId: WIN, data: step({ eventId: 'a' }) });
    setPreviewCode($('codePreview'), lastSyncedPreviewScript + '\n// my edit');
  }

  function selectFramework(fw) {
    $('fwSelect').value = fw;
    $('fwSelect').dispatchEvent(new window.Event('change'));
  }

  it('keeps edits and reverts the selectors when the user declines to regenerate', () => {
    bootWithEditedScript();
    window.confirm = vi.fn(() => false);
    selectFramework('selenium');
    expect(window.confirm).toHaveBeenCalled();
    expect(outFramework).toBe('playwright');
    expect($('fwSelect').value).toBe('playwright');
    expect($('langSelect').value).toBe('typescript');
    expect(getPreviewText($('codePreview'))).toContain('// my edit');
    expect(recorderFileName()).toBe('locatra-recorded.spec.ts');
  });

  it('regenerates for the new target when the user accepts', () => {
    bootWithEditedScript();
    window.confirm = vi.fn(() => true);
    selectFramework('cypress');
    expect(outFramework).toBe('cypress');
    const text = getPreviewText($('codePreview'));
    expect(text).not.toContain('// my edit');
    expect(text).toContain('cy.');
  });

  it('does not ask when there are no edits', () => {
    boot();
    port({ type: 'RECORDED_ACTION', windowId: WIN, data: step({ eventId: 'a' }) });
    selectFramework('selenium');
    expect(window.confirm).not.toHaveBeenCalled();
    expect(outFramework).toBe('selenium');
  });

  it('flags steps recorded after the edit, and Sync brings them in', () => {
    bootWithEditedScript();
    expect($('scriptStaleNotice').hidden).toBe(true);
    port({
      type: 'RECORDED_ACTION',
      windowId: WIN,
      data: step({ eventId: 'b', target: { kind: 'id', value: 'later' } }),
    });
    expect($('scriptStaleNotice').hidden).toBe(false);
    expect($('scriptStaleText').textContent).toContain('1 new step not in your edited script');
    $('scriptStaleSyncBtn').click();
    expect($('scriptStaleNotice').hidden).toBe(true);
    expect(getPreviewText($('codePreview'))).toContain('later');
  });

  it('restores an edited script as edited (new steps do not overwrite it)', () => {
    boot();
    port({ type: 'RECORDED_ACTION', windowId: WIN, data: step({ eventId: 'a' }) });
    setPreviewCode($('codePreview'), lastSyncedPreviewScript + '\n// kept');
    vi.advanceTimersByTime(250);
    const saved = clone(h.store);
    // Reopen.
    resetPanelGlobals();
    h.store = saved;
    boot();
    port({ type: 'RECORDED_ACTION', windowId: WIN, data: step({ eventId: 'b' }) });
    expect(getPreviewText($('codePreview'))).toContain('// kept');
    expect($('scriptStaleNotice').hidden).toBe(false);
  });
});

// ── finding 8: Reset must stick ────────────────────────────────────────────────
describe('Reset', () => {
  it('does not come back on a framework switch', () => {
    boot();
    port({
      type: 'ELEMENT_PICKED',
      windowId: WIN,
      data: { pickId: 'p1', elementData: { tag: 'button' }, locators: [] },
    });
    expect($('resultsState').style.display).toBe('');
    $('clearBtn').click();
    $('fwSelect').value = 'selenium';
    $('fwSelect').dispatchEvent(new window.Event('change'));
    expect($('resultsState').style.display).toBe('none');
    // …and the same pick id can be shown again if re-picked.
    port({
      type: 'ELEMENT_PICKED',
      windowId: WIN,
      data: { pickId: 'p1', elementData: { tag: 'a' }, locators: [] },
    });
    expect($('resultsState').style.display).toBe('');
  });
});

// ── finding 12: stress test outcome ───────────────────────────────────────────
describe('stress test', () => {
  it('a late result replaces the timeout note — one outcome, no alerts', () => {
    boot();
    $('stressTestBtn').click();
    expect(sentOf('RUN_STRESS_TEST')[0].windowId).toBe(WIN);
    vi.advanceTimersByTime(5000);
    expect($('stressResult').textContent).toContain('timed out');
    port({ type: 'STRESS_TEST_RESULT', windowId: WIN, data: { survived: true } });
    expect($('stressResult').textContent).toContain('complete');
    expect($('stressResult').textContent).not.toContain('timed out');
    expect(window.alert).not.toHaveBeenCalled();
  });

  it('ignores a result nobody asked for', () => {
    boot();
    port({ type: 'STRESS_TEST_RESULT', windowId: WIN, data: { survived: true } });
    expect($('stressResult').hidden).toBe(true);
  });
});

// ── finding 11: Copy label ─────────────────────────────────────────────────────
describe('copy button label', () => {
  it('returns to its own label after rapid repeat clicks', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.resolve() },
      configurable: true,
    });
    document.body.innerHTML = '<button id="b">Copy</button>';
    const btn = $('b');
    copyToClipboard('x', btn);
    await vi.advanceTimersByTimeAsync(0);
    expect(btn.textContent).toBe('✓ Copied');
    copyToClipboard('x', btn); // clicked again while it says "✓ Copied"
    await vi.advanceTimersByTimeAsync(1500);
    expect(btn.textContent).toBe('✓ Copied'); // first timer did not fire early
    await vi.advanceTimersByTimeAsync(600);
    expect(btn.textContent).toBe('Copy');
    expect(btn.classList.contains('done')).toBe(false);
  });
});

// ── finding 14: a11y ───────────────────────────────────────────────────────────
describe('timeline accessibility', () => {
  it('labels per-step buttons and keeps focus in the list after a removal', () => {
    boot();
    for (const id of ['a', 'b', 'c'])
      port({ type: 'RECORDED_ACTION', windowId: WIN, data: step({ eventId: id }) });
    vi.runOnlyPendingTimers();
    const removeBtns = () => [...document.querySelectorAll('#recorderTimeline .remove-step-btn')];
    expect(removeBtns()[1].getAttribute('aria-label')).toBe('Remove step 2: click');
    expect(document.querySelector('#recorderTimeline .copy-btn').getAttribute('aria-label')).toBe(
      'Copy code for step 1: click'
    );
    removeBtns()[1].focus();
    removeBtns()[1].click();
    expect(recordedActions.map((a) => a.eventId)).toEqual(['a', 'c']);
    expect(document.activeElement).toBe(removeBtns()[1]); // now "step 2" = old c
  });

  it('Why? toggles expose aria-expanded / aria-controls', () => {
    boot();
    renderResults({
      elementData: { tag: 'button' },
      locators: [
        {
          rank: 1,
          method: 'getByRole()',
          stability: 'BEST',
          code: 'x',
          fullCode: 'y',
          explanation: 'because',
        },
      ],
    });
    const t = document.querySelector('.toggle-explain');
    const target = $(t.getAttribute('aria-controls'));
    expect(target.textContent).toBe('because');
    expect(t.getAttribute('aria-expanded')).toBe('false');
    t.click();
    expect(t.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.copy-btn[aria-label]').getAttribute('aria-label')).toBe(
      'Copy locator 1: getByRole()'
    );
  });
});

// ── finding 13: narrow sidebars ────────────────────────────────────────────────
describe('narrow layout', () => {
  it('has no 320px floor on html/body', () => {
    const html = readFileSync(join(ROOT, 'src/sidepanel.html'), 'utf8');
    expect(html).not.toMatch(/min-width:\s*320px/);
  });
});

// The timeline save is debounced by 200 ms; an edit made just before the panel closed
// was never written and came back on reopen (found by the real-browser smoke test).
describe('saving when the panel goes away', () => {
  for (const event of ['pagehide', 'beforeunload']) {
    it(`writes a pending save immediately on ${event}`, () => {
      boot();
      port({ type: 'RECORDED_ACTION', windowId: WIN, data: step({ action: 'click' }) });
      expect(h.store[`llRecorderState:${WIN}`]).toBeUndefined(); // still debounced
      window.dispatchEvent(new Event(event));
      expect(h.store[`llRecorderState:${WIN}`].actions).toHaveLength(1);
    });
  }

  it('writes a pending save when the panel is hidden', () => {
    boot();
    port({ type: 'RECORDED_ACTION', windowId: WIN, data: step({ action: 'click' }) });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      delete document.visibilityState;
    }
    expect(h.store[`llRecorderState:${WIN}`].actions).toHaveLength(1);
  });

  it('does nothing extra when no save is pending', () => {
    boot();
    const before = JSON.stringify(h.store);
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.stringify(h.store)).toBe(before);
  });
});
