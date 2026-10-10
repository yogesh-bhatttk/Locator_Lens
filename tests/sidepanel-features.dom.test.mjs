// @vitest-environment jsdom
//
// Side panel features: settings, replay (F1), Page Object export (F2), suggested
// assertions (F3) and step thumbnails (F4). Same approach as the other sidepanel
// suites: the real sidepanel.js runs in this jsdom realm behind a scripted `chrome`
// stub, against the real sidepanel.html markup, and every test asserts what the
// user sees or what the panel sends — not internal calls.

/* global LLCodegen, LLThumbs, thumbRectPercent, getExportedTestScript, setPomStatus */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WIN = 7;
const DEFER = Symbol('defer');

const h = {
  store: {},
  sent: [],
  responders: {},
  deferred: [],
  portPosts: [],
  portListener: null,
  portDisconnect: null,
  runtimeListener: null,
  storageListeners: [],
  // chrome.permissions stub: `granted` is what contains() reports, `answer` what
  // the prompt returns; requests records each request() call.
  perm: { granted: true, answer: true, requests: [], listeners: [], promiseStyle: false },
};

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function pick(keys) {
  if (keys == null) return clone(h.store);
  const list = Array.isArray(keys) ? keys : [keys];
  const out = {};
  for (const k of list) if (k in h.store) out[k] = clone(h.store[k]);
  return out;
}

// LLCodegen.pageObject is owned by codegen.js. Use the real one when it exists;
// otherwise a stand-in with the documented contract (model, fw, lang) → file text.
let realPageObject = null;
function stubPageObject(model, fw, lang) {
  // Mirrors the documented naming: the given name (or the title) + "Page".
  const base = model.className || 'Checkout';
  const cls = /Page$/.test(base) ? base : base + 'Page';
  const names = model.elements.map((e) => e.name).join(', ');
  if (lang === 'python') return `class ${cls}:\n    # ${fw}: ${names}\n`;
  return `export class ${cls} {\n  // ${fw}/${lang}: ${names}\n}\n`;
}

beforeAll(async () => {
  await import('../src/codegen.js');
  realPageObject = typeof LLCodegen.pageObject === 'function' ? LLCodegen.pageObject : null;
  globalThis.chrome = {
    windows: {
      getCurrent: (cb) => cb({ id: WIN }),
      getAll: (_o, cb) => cb([{ id: WIN }]),
    },
    runtime: {
      lastError: null,
      getURL: (p) => 'chrome-extension://locatra/' + p,
      sendMessage: (msg, cb) => {
        h.sent.push(clone(msg));
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
        onDisconnect: {
          addListener: (fn) => {
            h.portDisconnect = fn;
          },
        },
      }),
      onMessage: {
        addListener: (fn) => {
          h.runtimeListener = fn;
        },
      },
    },
    permissions: {
      contains: (q, cb) => {
        const granted = h.perm.granted;
        queueMicrotask(() => cb(granted)); // like the browser: answers asynchronously
      },
      request: (q, cb) => {
        h.perm.requests.push(clone(q));
        const answer = h.perm.answer;
        if (answer) h.perm.granted = true;
        if (h.perm.promiseStyle) return Promise.resolve(answer);
        queueMicrotask(() => cb(answer)); // the prompt answers later
        return undefined;
      },
      onAdded: { addListener: (fn) => h.perm.listeners.push(fn) },
      onRemoved: { addListener: (fn) => h.perm.listeners.push(fn) },
    },
    storage: {
      onChanged: { addListener: (fn) => h.storageListeners.push(fn) },
      local: {
        get: (keys, cb) => cb(pick(keys)),
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
    replayRun = null; replayStatuses = new Map(); replaySecretsOpen = false;
    pomModel = null; _pomLastResultJson = '';
    thumbCache.clear(); _thumbGen.clear(); _thumbInFlight.clear(); _thumbModalOpener = null;
    llSettings = { autoAssertions: true, stepScreenshots: true };
    screenshotPermission = null; screenshotPermDeclined = false; _shotNoticeShownOnce = false; _wasRecording = false;
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
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
let seq = 0;
const step = (over = {}) => ({
  action: 'click',
  eventId: 'e' + ++seq,
  target: { kind: 'id', value: 'go' },
  code: "page.locator('#go')",
  ...over,
});
const record = (data) => port({ type: 'RECORDED_ACTION', windowId: WIN, data });
const rows = () => [...document.querySelectorAll('#recorderTimeline .ll-rec-step')];
const persisted = () => h.store[`llRecorderState:${WIN}`];

beforeEach(() => {
  vi.useFakeTimers();
  h.store = {};
  h.sent = [];
  h.responders = { GET_RECORDING_STATE: () => ({ active: false }) };
  h.deferred = [];
  h.portPosts = [];
  h.perm.granted = true;
  h.perm.answer = true;
  h.perm.requests = [];
  h.perm.promiseStyle = false;
  resetPanelGlobals();
  window.confirm = vi.fn(() => true);
  Element.prototype.scrollIntoView = vi.fn();
  LLCodegen.pageObject = realPageObject || vi.fn(stubPageObject);
  delete globalThis.LLThumbs;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

// ── Settings ──────────────────────────────────────────────────────────────────
describe('settings disclosure', () => {
  it('defaults both toggles on when nothing is stored', () => {
    boot();
    expect($('recSettings').tagName).toBe('DETAILS');
    expect($('settingAutoAssertions').checked).toBe(true);
    expect($('settingStepScreenshots').checked).toBe(true);
  });

  it('loads stored values and treats a missing field as its default', () => {
    h.store.llSettings = { autoAssertions: false };
    boot();
    expect($('settingAutoAssertions').checked).toBe(false);
    expect($('settingStepScreenshots').checked).toBe(true);
  });

  it('writes the whole object when a toggle changes', () => {
    boot();
    $('settingStepScreenshots').checked = false;
    $('settingStepScreenshots').dispatchEvent(new window.Event('change'));
    expect(h.store.llSettings).toEqual({ autoAssertions: true, stepScreenshots: false });
    $('settingAutoAssertions').click();
    expect(h.store.llSettings).toEqual({ autoAssertions: false, stepScreenshots: false });
  });

  it('follows changes made elsewhere (another window)', () => {
    boot();
    for (const fn of h.storageListeners) {
      fn({ llSettings: { newValue: { autoAssertions: false, stepScreenshots: false } } }, 'local');
    }
    expect($('settingAutoAssertions').checked).toBe(false);
    expect($('settingStepScreenshots').checked).toBe(false);
    // Unrelated areas/keys are ignored; a removed key falls back to defaults.
    for (const fn of h.storageListeners) fn({ llSettings: { newValue: { autoAssertions: true } } }, 'sync');
    expect($('settingAutoAssertions').checked).toBe(false);
    for (const fn of h.storageListeners) fn({ llSettings: { newValue: undefined } }, 'local');
    expect($('settingAutoAssertions').checked).toBe(true);
  });

  it('labels every toggle', () => {
    boot();
    for (const id of [
      'settingAutoAssertions',
      'settingStepScreenshots',
      'replayStopOnFailure',
      'replaySlowMo',
    ]) {
      expect($(id).closest('label'), id).not.toBeNull();
    }
  });
});

// ── Screenshot permission ──────────────────────────────────────────────────────
describe('screenshot permission', () => {
  const ALL = { origins: ['<all_urls>'] };
  const declined = (id) => $(id).querySelector('.ll-perm-declined');

  it('shows nothing when <all_urls> is granted', async () => {
    boot();
    await flush();
    expect($('shotPermNotice').hidden).toBe(true);
  });

  it('shows the notice when screenshots are on but access is missing; Grant asks inside the click', async () => {
    h.perm.granted = false;
    boot();
    await flush();
    expect($('shotPermNotice').hidden).toBe(false);
    expect($('shotPermNotice').textContent).toContain('Step screenshots need permission to capture pages');
    $('shotPermGrantBtn').click();
    // Synchronously, within the user gesture — nothing awaited first.
    expect(h.perm.requests).toEqual([ALL]);
    await flush();
    expect($('shotPermNotice').hidden).toBe(true);
  });

  it('keeps the setting on when declined and explains where thumbnails still work', async () => {
    h.perm.granted = false;
    h.perm.answer = false;
    boot();
    await flush();
    expect(declined('shotPermNotice').hidden).toBe(true);
    $('shotPermGrantBtn').click();
    await flush();
    expect($('shotPermNotice').hidden).toBe(false);
    expect(declined('shotPermNotice').hidden).toBe(false);
    expect(declined('shotPermNotice').textContent).toContain('opened from the toolbar');
    expect($('settingStepScreenshots').checked).toBe(true);
    expect(h.store.llSettings).toBeUndefined(); // nothing was switched off
  });

  it('turning the setting on asks for access in the same handler', async () => {
    h.store.llSettings = { stepScreenshots: false };
    h.perm.granted = false;
    boot();
    await flush();
    expect($('shotPermNotice').hidden).toBe(true); // off → no nagging
    $('settingStepScreenshots').click();
    expect(h.perm.requests).toEqual([ALL]);
    expect(h.store.llSettings.stepScreenshots).toBe(true);
    await flush();
    expect($('shotPermNotice').hidden).toBe(true);
    // Off and on again with access already granted: no second prompt.
    $('settingStepScreenshots').click();
    $('settingStepScreenshots').click();
    expect(h.perm.requests).toHaveLength(1);
  });

  it('shows a one-time notice near the timeline when a recording starts without access', async () => {
    h.perm.granted = false;
    let active = false;
    h.responders.GET_RECORDING_STATE = () => ({ active, paused: false });
    h.responders.START_RECORDING = () => {
      active = true;
      return { ok: true };
    };
    h.responders.STOP_RECORDING = () => {
      active = false;
      return { ok: true };
    };
    boot();
    await flush();
    expect($('shotPermTimelineNotice').hidden).toBe(true);
    $('recordBtn').click();
    await flush();
    expect($('shotPermTimelineNotice').hidden).toBe(false);
    $('shotPermTimelineDismiss').click();
    expect($('shotPermTimelineNotice').hidden).toBe(true);
    $('recordBtn').click(); // stop
    $('recordBtn').click(); // start again: not shown a second time
    await flush();
    expect($('shotPermTimelineNotice').hidden).toBe(true);
  });

  it('the timeline notice grants access too, and hides once granted', async () => {
    h.perm.granted = false;
    h.responders.GET_RECORDING_STATE = () => ({ active: true, paused: false });
    boot();
    await flush();
    expect($('shotPermTimelineNotice').hidden).toBe(false);
    $('shotPermTimelineGrantBtn').click();
    expect(h.perm.requests).toEqual([ALL]);
    await flush();
    expect($('shotPermTimelineNotice').hidden).toBe(true);
    expect($('shotPermNotice').hidden).toBe(true);
  });

  it('no timeline notice when screenshots are off', async () => {
    h.perm.granted = false;
    h.store.llSettings = { stepScreenshots: false };
    h.responders.GET_RECORDING_STATE = () => ({ active: true, paused: false });
    boot();
    await flush();
    expect($('shotPermTimelineNotice').hidden).toBe(true);
  });

  it('handles a promise-style permissions.request', async () => {
    h.perm.granted = false;
    h.perm.promiseStyle = true;
    boot();
    await flush();
    $('shotPermGrantBtn').click();
    await flush();
    expect($('shotPermNotice').hidden).toBe(true);
  });

  it('follows grants made elsewhere', async () => {
    h.perm.granted = false;
    boot();
    await flush();
    expect($('shotPermNotice').hidden).toBe(false);
    h.perm.granted = true;
    h.perm.listeners.forEach((fn) => fn({ origins: ['<all_urls>'] }));
    await flush();
    expect($('shotPermNotice').hidden).toBe(true);
  });

  it('falls back to GET_SCREENSHOT_PERMISSION without chrome.permissions', async () => {
    const saved = chrome.permissions;
    delete chrome.permissions;
    try {
      h.responders.GET_SCREENSHOT_PERMISSION = () => ({ granted: false });
      boot();
      await flush();
      expect(sentOf('GET_SCREENSHOT_PERMISSION')[0]).toEqual({
        type: 'GET_SCREENSHOT_PERMISSION',
        windowId: WIN,
      });
      expect($('shotPermNotice').hidden).toBe(false);
      $('shotPermGrantBtn').click(); // nothing to call; must not throw
      h.responders.GET_SCREENSHOT_PERMISSION = () => undefined; // unknown → leave as is
      boot();
      await flush();
      expect($('shotPermNotice').hidden).toBe(false);
    } finally {
      chrome.permissions = saved;
    }
  });
});

// ── F3: suggested assertions ───────────────────────────────────────────────────
describe('suggested assertions', () => {
  const urlSuggestion = (over = {}) =>
    step({
      action: 'assert',
      assertType: 'toHaveURL',
      value: 'https://shop.test/confirmation',
      target: null,
      code: undefined,
      suggested: true,
      reason: 'Page navigated to /confirmation',
      ...over,
    });

  it('renders a suggestion distinctly, with Accept/Dismiss and its reason, but no Copy', () => {
    boot();
    record(step({ eventId: 'c1' }));
    record(urlSuggestion({ eventId: 's1' }));
    const [, sug] = rows();
    expect(sug.classList.contains('is-suggested')).toBe(true);
    expect(sug.textContent).toContain('Suggested');
    expect(sug.textContent).toContain('Page navigated to /confirmation');
    expect(sug.querySelector('.accept-step-btn').getAttribute('aria-label')).toBe(
      'Accept suggested step 2: assert toHaveURL'
    );
    expect(sug.querySelector('.dismiss-step-btn')).not.toBeNull();
    expect(sug.querySelector('.copy-btn')).toBeNull();
    expect(sug.querySelector('.ll-thumb-slot')).toBeNull();
    // The preview shows the check it would add — not a TODO placeholder.
    const code = sug.querySelector('.ll-rec-step-code').textContent;
    expect(code).toContain('toHaveURL');
    expect(code).toContain('https://shop.test/confirmation');
    expect($('suggestionsBar').hidden).toBe(false);
    expect($('suggestionsText').textContent).toContain('1 suggested assertion');
  });

  it('keeps suggestions out of the script, copy and download until accepted', () => {
    boot();
    record(urlSuggestion({ eventId: 's1' }));
    expect(getExportedTestScript()).toBe('');
    expect($('codePreview').style.display).toBe('none');
    record(step({ eventId: 'c1', target: { kind: 'id', value: 'buy' } }));
    expect(getExportedTestScript()).toContain('buy');
    expect(getExportedTestScript()).not.toContain('toHaveURL');
  });

  it('Accept moves it into the script and persists suggested:false', () => {
    boot();
    record(step({ eventId: 'c1' }));
    record(urlSuggestion({ eventId: 's1' }));
    rows()[1].querySelector('.accept-step-btn').click();
    expect(rows()[1].classList.contains('is-suggested')).toBe(false);
    expect(rows()[1].querySelector('.copy-btn')).not.toBeNull();
    expect(document.activeElement).toBe(rows()[1].querySelector('.copy-btn'));
    expect(getPreviewText($('codePreview'))).toContain('toHaveURL');
    expect($('suggestionsBar').hidden).toBe(true);
    vi.advanceTimersByTime(250);
    expect(persisted().actions[1]).toMatchObject({ eventId: 's1', suggested: false });
  });

  it('Dismiss removes it for good — a re-delivery does not bring it back', () => {
    boot();
    record(step({ eventId: 'c1' }));
    record(urlSuggestion({ eventId: 's1' }));
    rows()[1].querySelector('.dismiss-step-btn').click();
    expect(recordedActions.map((a) => a.eventId)).toEqual(['c1']);
    expect(document.activeElement).toBe(rows()[0].querySelector('.copy-btn'));
    record(urlSuggestion({ eventId: 's1' }));
    expect(recordedActions.map((a) => a.eventId)).toEqual(['c1']);
    vi.advanceTimersByTime(250);
    expect(persisted().seenKeys).toContain('eid:s1');
    // Dismissing a suggestion is not undoable history.
    expect($('redoActionBtn').disabled).toBe(true);
  });

  it('Accept all accepts every suggestion at once', () => {
    boot();
    record(urlSuggestion({ eventId: 's1' }));
    record(
      step({
        eventId: 's2',
        action: 'assert',
        assertType: 'toContainText',
        value: 'Order placed',
        suggested: true,
        reason: 'Success message appeared after submit',
      })
    );
    expect($('suggestionsText').textContent).toContain('2 suggested assertions');
    $('acceptAllSuggestionsBtn').click();
    expect(recordedActions.every((a) => a.suggested === false)).toBe(true);
    expect($('suggestionsBar').hidden).toBe(true);
    expect(getExportedTestScript()).toContain('Order placed');
  });

  it('survives a reload still marked as suggested', () => {
    boot();
    record(step({ eventId: 'c1' }));
    record(urlSuggestion({ eventId: 's1' }));
    vi.advanceTimersByTime(250);
    const saved = clone(h.store);
    resetPanelGlobals();
    h.store = saved;
    boot();
    expect(recordedActions[1]).toMatchObject({ eventId: 's1', suggested: true });
    expect(rows()[1].classList.contains('is-suggested')).toBe(true);
    expect(getExportedTestScript()).not.toContain('toHaveURL');
  });

  it('Review expands the timeline, clears a hiding filter and focuses the first Accept', () => {
    boot();
    record(step({ eventId: 'c1' }));
    record(urlSuggestion({ eventId: 's1' }));
    vm.runInThisContext("recFilter = 'click'");
    $('recFilterInput').value = 'click';
    renderTimeline();
    expect($('recorderTimeline').style.display).toBe('none');
    $('reviewSuggestionsBtn').click();
    expect($('recorderTimeline').style.display).toBe('');
    expect($('recFilterInput').value).toBe('');
    expect(document.activeElement).toBe(rows()[1].querySelector('.accept-step-btn'));
  });

  it('escapes a hostile reason', () => {
    boot();
    record(urlSuggestion({ reason: '<img src=x onerror="globalThis.__pwned=1">' }));
    expect(document.querySelector('#recorderTimeline img')).toBeNull();
    expect(rows()[0].textContent).toContain('<img src=x');
    expect(globalThis.__pwned).toBeUndefined();
  });
});

// ── F1: replay ────────────────────────────────────────────────────────────────
describe('replay', () => {
  const progress = (over) => port({ type: 'REPLAY_PROGRESS', windowId: WIN, runId: 'r1', ...over });
  const done = (over) => port({ type: 'REPLAY_DONE', windowId: WIN, runId: 'r1', ...over });
  const badge = (i) => rows()[i].querySelector('.ll-replay-badge');

  beforeEach(() => {
    h.responders.REPLAY_START = () => ({ ok: true, runId: 'r1' });
    h.responders.REPLAY_STOP = () => ({ ok: true });
    h.responders.PAUSE_RECORDING = () => ({ ok: true });
    h.responders.RESUME_RECORDING = () => ({ ok: true });
  });

  it('is disabled with no steps, or with only suggestions', () => {
    boot();
    expect($('replayBtn').disabled).toBe(true);
    record(step({ suggested: true, action: 'assert', assertType: 'toBeVisible' }));
    expect($('replayBtn').disabled).toBe(true);
    record(step());
    expect($('replayBtn').disabled).toBe(false);
  });

  it('sends REPLAY_START with the committed steps, empty secrets and the options', () => {
    boot();
    record(step({ eventId: 'a' }));
    record(step({ eventId: 's', action: 'assert', assertType: 'toBeVisible', suggested: true }));
    record(step({ eventId: 'b', action: 'fill', value: 'hi' }));
    $('replayBtn').click();
    const [msg] = sentOf('REPLAY_START');
    expect(msg).toMatchObject({
      type: 'REPLAY_START',
      windowId: WIN,
      secrets: {},
      options: { stopOnFailure: true, slowMoMs: 0, stepTimeoutMs: 5000 },
    });
    expect(msg.steps.map((s) => s.eventId)).toEqual(['a', 'b']);
    expect(msg.steps[1]).toMatchObject({ action: 'fill', value: 'hi', target: { kind: 'id', value: 'go' } });
    // Every replayed step starts as pending; the suggestion gets no badge.
    expect(badge(0).textContent).toContain('pending');
    expect(badge(1)).toBeNull();
    expect(badge(2).textContent).toContain('pending');
    expect($('replayBtn').disabled).toBe(true);
    expect($('stopReplayBtn').hidden).toBe(false);
    expect($('recorderTimeline').style.display).toBe(''); // expanded to show progress
  });

  it('passes the chosen options', () => {
    boot();
    record(step());
    $('replayStopOnFailure').checked = false;
    $('replaySlowMo').checked = true;
    $('replayBtn').click();
    expect(sentOf('REPLAY_START')[0].options).toEqual({
      stopOnFailure: false,
      slowMoMs: 400,
      stepTimeoutMs: 5000,
    });
  });

  it('shows per-step progress and a passed summary', () => {
    boot();
    record(step());
    record(step());
    $('replayBtn').click();
    progress({ index: 0, status: 'running' });
    expect(badge(0).textContent).toContain('running');
    expect(rows()[0].classList.contains('replay-running')).toBe(true);
    progress({ index: 0, status: 'passed', matchCount: 1, durationMs: 12 });
    progress({ index: 1, status: 'passed' });
    expect(badge(0).textContent).toContain('passed');
    done({ result: 'passed' });
    expect($('replaySummary').textContent).toBe('Replay passed (2 steps)');
    expect($('replaySummary').className).toContain('ok');
    expect($('replayBtn').disabled).toBe(false);
    expect($('stopReplayBtn').hidden).toBe(true);
    expect(badge(1).textContent).toContain('passed'); // results stay visible
  });

  it('highlights the failed step, shows its error and scrolls it into view', () => {
    boot();
    record(step({ eventId: 'a' }));
    record(step({ eventId: 's', action: 'assert', assertType: 'toBeVisible', suggested: true }));
    record(step({ eventId: 'b' }));
    record(step({ eventId: 'c' }));
    $('replayBtn').click();
    progress({ index: 0, status: 'passed' });
    progress({ index: 1, status: 'failed', error: 'no element matches <#go>' });
    const failed = rows()[2];
    expect(failed.classList.contains('replay-failed')).toBe(true);
    expect(failed.querySelector('.ll-replay-error').textContent).toBe('no element matches <#go>');
    expect(failed.scrollIntoView).toHaveBeenCalled();
    done({ result: 'failed', failedIndex: 1, error: 'no element matches <#go>' });
    // "step 3" is the number the timeline shows (the suggestion is #2).
    expect($('replaySummary').textContent).toBe('Replay failed at step 3: no element matches <#go>');
    expect(rows()[2].classList.contains('replay-failed')).toBe(true);
    // The never-run step drops its pending badge.
    expect(badge(3)).toBeNull();
  });

  it('shows a skipped step with its reason', () => {
    boot();
    record(step({ action: 'upload' }));
    $('replayBtn').click();
    progress({ index: 0, status: 'skipped', error: "file uploads can't be replayed in the browser" });
    expect(badge(0).textContent).toContain('skipped');
    expect(rows()[0].querySelector('.ll-replay-error').textContent).toContain('file uploads');
  });

  it('reveals a failed step hidden by the timeline filter', () => {
    boot();
    record(step({ eventId: 'a', action: 'fill', value: 'x' }));
    record(step({ eventId: 'b' }));
    $('replayBtn').click();
    vm.runInThisContext("recFilter = 'fill'");
    renderTimeline();
    expect(rows()).toHaveLength(1);
    progress({ index: 1, status: 'failed', error: 'element is not visible' });
    expect(rows()).toHaveLength(2);
    expect(rows()[1].classList.contains('replay-failed')).toBe(true);
  });

  it('ignores progress for another window or another run, and adopts a run id that overtook the reply', () => {
    h.responders.REPLAY_START = () => DEFER;
    boot();
    record(step());
    $('replayBtn').click();
    port({ type: 'REPLAY_PROGRESS', windowId: 99, runId: 'r1', index: 0, status: 'failed', error: 'x' });
    expect(badge(0).textContent).toContain('pending');
    progress({ index: 0, status: 'running' }); // before the REPLAY_START answer
    expect(badge(0).textContent).toContain('running');
    h.deferred[0].cb({ ok: true, runId: 'r1' });
    port({ type: 'REPLAY_PROGRESS', windowId: WIN, runId: 'other', index: 0, status: 'failed' });
    expect(badge(0).textContent).toContain('running');
    progress({ index: 5, status: 'passed' }); // out of range
    progress({ index: 0, status: 'bogus' });
    expect(badge(0).textContent).toContain('running');
    done({ result: 'passed' });
    done({ result: 'failed', failedIndex: 0, error: 'late duplicate' });
    expect($('replaySummary').textContent).toBe('Replay passed (1 step)');
  });

  it('Stop sends REPLAY_STOP and reports "Replay stopped"', () => {
    boot();
    record(step());
    $('replayBtn').click();
    $('stopReplayBtn').click();
    expect(sentOf('REPLAY_STOP')).toEqual([{ type: 'REPLAY_STOP', windowId: WIN }]);
    expect($('stopReplayBtn').disabled).toBe(true);
    done({ result: 'stopped' });
    expect($('replaySummary').textContent).toBe('Replay stopped');
    expect($('replayBtn').disabled).toBe(false);
  });

  it('Stop finishes on its own if REPLAY_DONE never comes', () => {
    boot();
    record(step());
    $('replayBtn').click();
    $('stopReplayBtn').click();
    vi.advanceTimersByTime(3000);
    expect($('replaySummary').textContent).toBe('Replay stopped');
    expect($('stopReplayBtn').hidden).toBe(true);
  });

  it('shows a start failure from the worker', () => {
    h.responders.REPLAY_START = () => ({ ok: false, error: 'A replay is already running in this window.' });
    boot();
    record(step());
    $('replayBtn').click();
    expect($('replaySummary').textContent).toBe(
      "Replay couldn't run: A replay is already running in this window."
    );
    expect($('replayBtn').disabled).toBe(false);
    expect(rows()[0].querySelector('.ll-replay-badge')).toBeNull();
  });

  it('shows an error when the worker does not answer at all', () => {
    delete h.responders.REPLAY_START;
    boot();
    record(step());
    $('replayBtn').click();
    expect($('replaySummary').textContent).toContain("background worker didn't answer");
  });

  it('reports a REPLAY_DONE error result', () => {
    boot();
    record(step());
    $('replayBtn').click();
    done({ result: 'error', error: 'tab was closed' });
    expect($('replaySummary').textContent).toBe("Replay couldn't run: tab was closed");
  });

  it('says "Replay interrupted" after 30 s without progress, and stops the worker', () => {
    boot();
    record(step());
    record(step());
    $('replayBtn').click();
    vi.advanceTimersByTime(20000);
    progress({ index: 0, status: 'passed' }); // progress re-arms the watchdog
    vi.advanceTimersByTime(20000);
    expect($('replaySummary').textContent).not.toContain('interrupted');
    vi.advanceTimersByTime(10000);
    expect($('replaySummary').textContent).toContain('Replay interrupted');
    expect(sentOf('REPLAY_STOP')).toHaveLength(1);
    expect($('replayBtn').disabled).toBe(false);
  });

  it('a heartbeat keeps a long step alive without redrawing it', () => {
    boot();
    record(step());
    $('replayBtn').click();
    progress({ index: 0, status: 'running' });
    const before = $('recorderTimeline').innerHTML;
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(5000);
      progress({ index: 0, status: 'running', heartbeat: true });
    }
    expect($('replaySummary').textContent).not.toContain('interrupted');
    expect($('recorderTimeline').innerHTML).toBe(before);
    expect(sentOf('REPLAY_STOP')).toHaveLength(0);
    // A heartbeat for a step that does not exist is ignored like any bad progress.
    progress({ index: 99, status: 'running', heartbeat: true });
    vi.advanceTimersByTime(30000);
    expect($('replaySummary').textContent).toContain('Replay interrupted');
  });

  it('treats a lost port as an interrupted run', () => {
    boot();
    record(step());
    $('replayBtn').click();
    h.portDisconnect();
    expect($('replaySummary').textContent).toContain('Replay interrupted');
  });

  it('pauses a live recording first and resumes it afterwards', () => {
    let paused = false;
    h.responders.GET_RECORDING_STATE = () => ({ active: true, paused });
    h.responders.PAUSE_RECORDING = () => {
      paused = true;
      return { ok: true };
    };
    h.responders.RESUME_RECORDING = () => {
      paused = false;
      return { ok: true };
    };
    boot();
    record(step());
    expect($('replayBtn').disabled).toBe(false);
    expect($('replayBtn').title).toContain('Pauses recording');
    $('replayBtn').click();
    const types = h.sent.map((m) => m.type);
    expect(types.indexOf('PAUSE_RECORDING')).toBeGreaterThan(-1);
    expect(types.indexOf('PAUSE_RECORDING')).toBeLessThan(types.indexOf('REPLAY_START'));
    // Recording controls are locked while the replay drives the page.
    expect($('recordBtn').disabled).toBe(true);
    expect($('resumeRecordingBtn').disabled).toBe(true);
    done({ result: 'passed' });
    expect(sentOf('RESUME_RECORDING')).toHaveLength(1);
    expect($('pauseRecordingBtn').style.display).toBe('');
    expect($('recordBtn').disabled).toBe(false);
  });

  it('leaves an already-paused recording paused', () => {
    h.responders.GET_RECORDING_STATE = () => ({ active: true, paused: true });
    boot();
    record(step());
    $('replayBtn').click();
    done({ result: 'passed' });
    expect(sentOf('PAUSE_RECORDING')).toHaveLength(0);
    expect(sentOf('RESUME_RECORDING')).toHaveLength(0);
  });

  it('Clear Timeline stops a running replay', () => {
    boot();
    record(step());
    $('replayBtn').click();
    $('clearTimelineBtn').click();
    expect(sentOf('REPLAY_STOP')).toHaveLength(1);
    expect($('replaySummary').hidden).toBe(true);
    expect($('stopReplayBtn').hidden).toBe(true);
  });

  describe('sensitive steps', () => {
    const pw = (over) =>
      step({ action: 'fill', sensitive: true, secretName: 'LOCATRA_PASSWORD', value: 'hunter2', ...over });

    it('asks for each secret once, sends them only in REPLAY_START, then wipes the form', () => {
      boot();
      record(pw({ eventId: 'p1' }));
      record(pw({ eventId: 'p2' })); // same secret twice → one field
      record(pw({ eventId: 'p3', secretName: 'API_TOKEN' }));
      $('replayBtn').click();
      expect(sentOf('REPLAY_START')).toHaveLength(0);
      expect($('replaySecrets').hidden).toBe(false);
      const inputs = [...$('replaySecretsFields').querySelectorAll('input')];
      expect(inputs.map((i) => i.type)).toEqual(['password', 'password']);
      expect(inputs.map((i) => i.getAttribute('data-secret-name'))).toEqual([
        'LOCATRA_PASSWORD',
        'API_TOKEN',
      ]);
      expect(document.activeElement).toBe(inputs[0]);
      expect(inputs[0].labels[0].textContent).toContain('LOCATRA_PASSWORD');
      expect($('replayBtn').disabled).toBe(true);

      inputs[0].value = 's3cret!';
      // API_TOKEN left empty → those steps are skipped by the page ("no value provided").
      $('replaySecretsForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
      const [msg] = sentOf('REPLAY_START');
      expect(msg.secrets).toEqual({ LOCATRA_PASSWORD: 's3cret!' });
      expect(msg.steps.every((s) => s.value === '')).toBe(true); // stored steps carry no value
      expect($('replaySecrets').hidden).toBe(true);
      expect($('replaySecretsFields').querySelectorAll('input')).toHaveLength(0);
      vi.advanceTimersByTime(1000);
      expect(JSON.stringify(h.store)).not.toContain('s3cret!');
      expect(document.body.innerHTML).not.toContain('s3cret!');
    });

    it('Cancel and Esc close the form without replaying', () => {
      boot();
      record(pw());
      $('replayBtn').click();
      $('replaySecretsFields').querySelector('input').value = 'typed';
      $('replaySecretsCancel').click();
      expect($('replaySecrets').hidden).toBe(true);
      expect(document.body.innerHTML).not.toContain('typed');
      expect(document.activeElement).toBe($('replayBtn'));
      $('replayBtn').click();
      $('replaySecretsFields')
        .querySelector('input')
        .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect($('replaySecrets').hidden).toBe(true);
      expect(sentOf('REPLAY_START')).toHaveLength(0);
    });
  });
});

// ── F2: Page Object export ─────────────────────────────────────────────────────
describe('page object export', () => {
  const result = (over = {}) => ({
    pageUrl: 'https://shop.test/checkout',
    title: 'Checkout',
    region: { tag: 'form', locator: "page.locator('#checkout')" },
    truncated: false,
    elements: [
      {
        name: 'emailAddressInput',
        kind: 'input',
        role: 'textbox',
        tag: 'input',
        inputType: 'email',
        label: 'Email address',
        target: { kind: 'label', value: 'Email address' },
        code: "page.getByLabel('Email address')",
        matchCount: 1,
        unique: true,
      },
      {
        name: 'placeOrderButton',
        kind: 'button',
        role: 'button',
        tag: 'button',
        target: { kind: 'role', role: 'button', name: 'Place order' },
        code: "page.getByRole('button', { name: 'Place order' })",
        matchCount: 3,
        unique: false,
      },
    ],
    ...over,
  });
  const deliver = (data, windowId = WIN) => port({ type: 'POM_RESULT', windowId, data });
  const nameInputs = () => [...document.querySelectorAll('#pomList .ll-pom-name')];
  const typeName = (i, v) => {
    const input = nameInputs()[i];
    input.value = v;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  };

  beforeEach(() => {
    if (!realPageObject) LLCodegen.pageObject = vi.fn(stubPageObject);
    else LLCodegen.pageObject = vi.fn(realPageObject);
  });

  it('Pick region and Whole page ask the worker for this window', () => {
    h.responders.POM_PICK_START = () => ({ ok: true });
    h.responders.POM_SCAN = () => ({ ok: true });
    boot();
    $('pomPickBtn').click();
    expect(sentOf('POM_PICK_START')).toEqual([{ type: 'POM_PICK_START', windowId: WIN }]);
    expect($('pomStatus').textContent).toContain('Esc');
    $('pomScanBtn').click();
    expect(sentOf('POM_SCAN')).toEqual([{ type: 'POM_SCAN', windowId: WIN }]);
  });

  it('shows the restricted-page error from the response', () => {
    h.responders.POM_PICK_START = () => ({ ok: false, error: "Locatra can't run on this page." });
    boot();
    $('pomPickBtn').click();
    expect($('pomStatus').textContent).toBe("Locatra can't run on this page.");
    expect($('pomStatus').className).toContain('err');
  });

  it('says so when the page cannot be reached at all', () => {
    boot();
    $('pomScanBtn').click();
    expect($('pomStatus').textContent).toContain("Couldn't reach the page");
  });

  it('handles POM_PICK_CANCELLED from the relay and from this window only', () => {
    h.responders.POM_PICK_START = () => ({ ok: true });
    boot();
    $('pomPickBtn').click();
    port({ type: 'POM_PICK_CANCELLED', windowId: 99 });
    expect($('pomStatus').textContent).not.toContain('cancelled');
    h.runtimeListener({ type: 'POM_PICK_CANCELLED' }, { tab: { id: 3, windowId: 99 } });
    expect($('pomStatus').textContent).not.toContain('cancelled');
    h.runtimeListener({ type: 'POM_PICK_CANCELLED' }, { tab: { id: 3, windowId: WIN } });
    expect($('pomStatus').textContent).toBe('Region pick cancelled.');
    setPomStatus('', '');
    port({ type: 'POM_PICK_CANCELLED', windowId: WIN });
    expect($('pomStatus').textContent).toBe('Region pick cancelled.');
  });

  it('lists the elements with editable names, kinds and unique badges, and previews the class', () => {
    boot();
    deliver(result());
    expect($('pomResult').hidden).toBe(false);
    expect($('pomMeta').textContent).toContain("page.locator('#checkout')");
    expect(nameInputs().map((i) => i.value)).toEqual(['emailAddressInput', 'placeOrderButton']);
    expect(nameInputs()[0].getAttribute('aria-label')).toBe('Name for element 1 (input)');
    const rowEls = [...document.querySelectorAll('#pomList .ll-pom-row')];
    expect(rowEls[0].textContent).toContain('✓ unique');
    expect(rowEls[1].textContent).toContain('⚠ 3 matches');
    expect(rowEls[1].querySelector('.ll-pom-include').getAttribute('aria-label')).toContain(
      'Include element 2'
    );
    const [model, fw, lang] = LLCodegen.pageObject.mock.calls.at(-1);
    expect([fw, lang]).toEqual(['playwright', 'typescript']);
    expect(model.className).toBeUndefined();
    expect(model.pageUrl).toBe('https://shop.test/checkout');
    expect(model.elements.map((e) => e.name)).toEqual(['emailAddressInput', 'placeOrderButton']);
    expect(model.elements[0]).not.toHaveProperty('include');
    expect(model.elements[0].target).toEqual({ kind: 'label', value: 'Email address' });
    expect($('pomPreview').textContent).toContain('emailAddressInput');
    expect($('pomPreview').textContent).toMatch(/class CheckoutPage/);
    expect($('pomClassName').placeholder).toBe('CheckoutPage');
    expect($('pomCopyBtn').disabled).toBe(false);
  });

  it('renders page-derived text inertly', () => {
    boot();
    const hostile = '<img src=x onerror="globalThis.__pwned=1">';
    deliver(
      result({
        pageUrl: 'https://x.test/' + hostile,
        region: { tag: 'div', locator: hostile },
        elements: [{ ...result().elements[0], name: hostile, code: hostile, kind: hostile }],
      })
    );
    expect(document.querySelector('#pomSection img')).toBeNull();
    expect(nameInputs()[0].value).toBe(hostile);
    expect($('pomMeta').textContent).toContain(hostile);
    expect(globalThis.__pwned).toBeUndefined();
  });

  it('validates names: identifier, reserved words and duplicates block export', () => {
    boot();
    deliver(result());
    typeName(0, '2fast');
    expect(nameInputs()[0].getAttribute('aria-invalid')).toBe('true');
    expect($('pomErr-0').textContent).toContain('letters, digits');
    expect($('pomCopyBtn').disabled).toBe(true);
    expect($('pomDownloadBtn').disabled).toBe(true);
    expect($('pomValidation').textContent).toBe('Fix 1 name before exporting.');
    typeName(0, 'class');
    expect($('pomErr-0').textContent).toContain('reserved');
    typeName(0, 'page');
    expect($('pomErr-0').textContent).toContain('reserved');
    typeName(0, 'toString');
    expect($('pomErr-0').textContent).toContain('reserved');
    typeName(0, 'place_order_button'); // collides with placeOrderButton once snake_cased
    expect($('pomErr-1').textContent).toContain('Duplicate');
    // The row being edited is flagged too, not just the later one.
    expect($('pomErr-0').textContent).toBe('Duplicate of "placeOrderButton".');
    expect(nameInputs()[0].getAttribute('aria-invalid')).toBe('true');
    expect(nameInputs()[1].getAttribute('aria-invalid')).toBe('true');
    typeName(0, '');
    expect($('pomErr-0').textContent).toContain('required');
    typeName(0, '  contactEmail ');
    expect(nameInputs()[0].getAttribute('aria-invalid')).toBe('false');
    expect($('pomCopyBtn').disabled).toBe(false);
    expect(LLCodegen.pageObject.mock.calls.at(-1)[0].elements[0].name).toBe('contactEmail');
  });

  it('excluded elements are left out (and their names stop mattering)', () => {
    boot();
    deliver(result());
    typeName(0, 'not valid');
    const inc = document.querySelectorAll('#pomList .ll-pom-include')[0];
    inc.click();
    expect(inc.closest('.ll-pom-row').classList.contains('excluded')).toBe(true);
    expect($('pomCopyBtn').disabled).toBe(false);
    expect(LLCodegen.pageObject.mock.calls.at(-1)[0].elements.map((e) => e.name)).toEqual([
      'placeOrderButton',
    ]);
    document.querySelectorAll('#pomList .ll-pom-include')[1].click();
    expect($('pomValidation').textContent).toBe('Include at least one element.');
    expect($('pomDownloadBtn').disabled).toBe(true);
  });

  it('uses the class name field, and rejects an invalid one', () => {
    boot();
    deliver(result());
    $('pomClassName').value = 'Checkout Form';
    $('pomClassName').dispatchEvent(new window.Event('input'));
    expect($('pomClassError').hidden).toBe(false);
    expect($('pomCopyBtn').disabled).toBe(true);
    $('pomClassName').value = 'CheckoutForm';
    $('pomClassName').dispatchEvent(new window.Event('input'));
    expect($('pomClassError').hidden).toBe(true);
    expect(LLCodegen.pageObject.mock.calls.at(-1)[0].className).toBe('CheckoutForm');
    // Codegen normalises the name; the preview and the file name follow it.
    expect($('pomPreview').textContent).toMatch(/class CheckoutFormPage\b/);
    expect($('pomFileHint').textContent).toBe('Saves as CheckoutFormPage.ts');
  });

  it('Copy copies the generated file', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    boot();
    deliver(result());
    $('pomCopyBtn').click();
    await flush();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toMatch(/class CheckoutPage/);
    expect($('pomCopyBtn').textContent).toBe('✓ Copied');
  });

  it('Download names the file after the class and the current language', () => {
    URL.createObjectURL = vi.fn(() => 'blob:pom');
    URL.revokeObjectURL = vi.fn();
    const downloads = [];
    const click = vi.spyOn(window.HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      downloads.push(this.download);
    });
    boot();
    deliver(result());
    $('pomDownloadBtn').click();
    $('pomClassName').value = 'Checkout';
    $('pomClassName').dispatchEvent(new window.Event('input'));
    $('langSelect').value = 'python';
    $('langSelect').dispatchEvent(new window.Event('change'));
    $('pomDownloadBtn').click();
    $('langSelect').value = 'javascript';
    $('langSelect').dispatchEvent(new window.Event('change'));
    $('pomDownloadBtn').click();
    $('pomClassName').value = 'LoginForm';
    $('pomClassName').dispatchEvent(new window.Event('input'));
    $('pomDownloadBtn').click();
    // The file is named after the class the file declares (codegen adds "Page").
    expect(downloads).toEqual(['CheckoutPage.ts', 'CheckoutPage.py', 'CheckoutPage.js', 'LoginFormPage.js']);
    click.mockRestore();
  });

  it('re-renders for a framework change', () => {
    boot();
    deliver(result());
    $('fwSelect').value = 'selenium';
    $('fwSelect').dispatchEvent(new window.Event('change'));
    expect(LLCodegen.pageObject.mock.calls.at(-1).slice(1)).toEqual(['selenium', 'typescript']);
    $('fwSelect').value = 'cypress';
    $('fwSelect').dispatchEvent(new window.Event('change'));
    expect(LLCodegen.pageObject.mock.calls.at(-1)[1]).toBe('cypress');
  });

  it('keeps edited names when the same result is delivered again', () => {
    boot();
    deliver(result());
    typeName(0, 'emailField');
    deliver(result());
    expect(nameInputs()[0].value).toBe('emailField');
    // A genuinely new result replaces the list.
    deliver(result({ title: 'Other' }));
    expect(nameInputs()[0].value).toBe('emailAddressInput');
  });

  it('ignores a result addressed to another window', () => {
    boot();
    deliver(result(), 99);
    expect($('pomResult').hidden).toBe(true);
  });

  it('reports an empty region and a capped list', () => {
    boot();
    deliver(result({ elements: [] }));
    expect($('pomResult').hidden).toBe(true);
    expect($('pomStatus').textContent).toContain('No interactive elements');
    deliver(result({ truncated: true }));
    expect($('pomStatus').textContent).toContain('capped');
  });

  it('Close hides the result', () => {
    boot();
    deliver(result());
    $('pomCloseBtn').click();
    expect($('pomResult').hidden).toBe(true);
    expect(document.activeElement).toBe($('pomPickBtn'));
  });

  it('degrades clearly without LLCodegen.pageObject', () => {
    delete LLCodegen.pageObject;
    boot();
    deliver(result());
    expect($('pomValidation').textContent).toContain("can't generate Page Objects");
    expect($('pomCopyBtn').disabled).toBe(true);
    expect($('pomPreview').textContent).toBe('');
  });

  it('degrades clearly when codegen throws', () => {
    LLCodegen.pageObject = vi.fn(() => {
      throw new Error('boom');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    boot();
    deliver(result());
    expect($('pomValidation').textContent).toContain("Couldn't generate");
    expect($('pomDownloadBtn').disabled).toBe(true);
  });
});

// ── F4: step thumbnails ────────────────────────────────────────────────────────
describe('step thumbnails', () => {
  let stored;
  let urls;
  const blob = (tag) => new Blob([tag], { type: 'image/jpeg' });

  beforeEach(() => {
    stored = new Map();
    urls = { made: [], revoked: [] };
    let n = 0;
    URL.createObjectURL = vi.fn(() => {
      const u = 'blob:thumb/' + ++n;
      urls.made.push(u);
      return u;
    });
    URL.revokeObjectURL = vi.fn((u) => urls.revoked.push(u));
    globalThis.LLThumbs = {
      get: vi.fn((id) => Promise.resolve(stored.get(id) || null)),
      getMany: vi.fn((ids) => Promise.resolve(ids.map((id) => stored.get(id) || null))),
    };
  });

  const thumbRecord = (eventId) => ({ eventId, windowId: WIN, blob: blob(eventId), width: 360, height: 225 });
  const shot = (over = {}) =>
    step({
      rect: { x: 100, y: 50, width: 200, height: 40 },
      viewport: { width: 1000, height: 625 },
      ...over,
    });
  const thumbImg = (i) => rows()[i].querySelector('.ll-thumb-btn img');

  it('loads stored thumbnails for the timeline and outlines the step', async () => {
    stored.set('t1', thumbRecord('t1'));
    boot();
    record(shot({ eventId: 't1' }));
    await flush();
    expect(LLThumbs.getMany).toHaveBeenCalledWith(['t1']);
    const img = thumbImg(0);
    expect(img.getAttribute('src')).toMatch(/^blob:thumb\//);
    expect(img.getAttribute('width')).toBe('72');
    expect(img.getAttribute('height')).toBe('45');
    const box = rows()[0].querySelector('.ll-thumb-rect');
    expect(box.style.left).toBe('10%');
    expect(box.style.top).toBe('8%');
    expect(box.style.width).toBe('20%');
    expect(box.style.height).toBe('6.4%');
    expect(rows()[0].querySelector('.ll-thumb-btn').getAttribute('aria-label')).toBe(
      'Preview screenshot — Step 1: click'
    );
    // Re-rendering reuses the URL instead of fetching again.
    renderTimeline();
    await flush();
    expect(LLThumbs.getMany).toHaveBeenCalledTimes(1);
    expect(thumbImg(0).getAttribute('src')).toBe(urls.made[0]);
  });

  it('STEP_THUMBNAIL loads a screenshot that was not there before', async () => {
    boot();
    record(shot({ eventId: 't1' }));
    await flush();
    expect(thumbImg(0)).toBeNull();
    stored.set('t1', thumbRecord('t1'));
    port({ type: 'STEP_THUMBNAIL', windowId: WIN, eventId: 't1' });
    await flush();
    expect(thumbImg(0).getAttribute('src')).toBe(urls.made[0]);
    // A replacement revokes the previous URL.
    port({ type: 'STEP_THUMBNAIL', windowId: WIN, eventId: 't1' });
    await flush();
    expect(urls.revoked).toContain(urls.made[0]);
    expect(thumbImg(0).getAttribute('src')).toBe(urls.made[1]);
  });

  it('THUMBS_CLEARED (Settings → clear screenshots) releases every thumbnail', async () => {
    stored.set('t1', thumbRecord('t1'));
    boot();
    record(shot({ eventId: 't1' }));
    await flush();
    expect(thumbImg(0)).not.toBeNull();
    stored.clear();
    port({ type: 'THUMBS_CLEARED', windowId: WIN, all: true });
    await flush();
    expect(urls.revoked).toContain(urls.made[0]);
    expect(thumbImg(0)).toBeNull();
  });

  it('ignores STEP_THUMBNAIL for unknown steps and other windows', async () => {
    boot();
    record(shot({ eventId: 't1' }));
    await flush();
    const calls = LLThumbs.getMany.mock.calls.length;
    port({ type: 'STEP_THUMBNAIL', windowId: WIN, eventId: 'nope' });
    port({ type: 'STEP_THUMBNAIL', windowId: 99, eventId: 't1' });
    port({ type: 'STEP_THUMBNAIL', windowId: WIN });
    await flush();
    expect(LLThumbs.getMany.mock.calls.length).toBe(calls);
  });

  it('a stale load cannot overwrite a newer one', async () => {
    let release;
    LLThumbs.getMany = vi.fn(
      () =>
        new Promise((r) => {
          release = r;
        })
    );
    boot();
    record(shot({ eventId: 't1' }));
    const firstRelease = release;
    stored.set('t1', thumbRecord('t1'));
    port({ type: 'STEP_THUMBNAIL', windowId: WIN, eventId: 't1' });
    release([thumbRecord('t1')]);
    firstRelease([null]); // the older lookup answers last
    await flush();
    expect(thumbImg(0)).not.toBeNull();
    renderTimeline(); // still known after a re-render (the stale "none" was discarded)
    expect(thumbImg(0)).not.toBeNull();
    expect(LLThumbs.getMany).toHaveBeenCalledTimes(2);
  });

  it('does not fetch the same screenshot twice while a lookup is pending', async () => {
    let release;
    LLThumbs.getMany = vi.fn(
      () =>
        new Promise((r) => {
          release = r;
        })
    );
    boot();
    record(shot({ eventId: 't1' }));
    renderTimeline();
    renderTimeline();
    expect(LLThumbs.getMany).toHaveBeenCalledTimes(1);
    release([thumbRecord('t1')]);
    await flush();
    expect(thumbImg(0)).not.toBeNull();
  });

  it('falls back to get() and tolerates a failing store', async () => {
    stored.set('t1', thumbRecord('t1'));
    delete LLThumbs.getMany;
    boot();
    record(shot({ eventId: 't1' }));
    await flush();
    expect(LLThumbs.get).toHaveBeenCalledWith('t1');
    expect(thumbImg(0)).not.toBeNull();
    LLThumbs.get = vi.fn(() => Promise.reject(new Error('db closed')));
    record(shot({ eventId: 't2' }));
    await flush();
    expect(rows()[1].querySelector('img')).toBeNull();
  });

  it('opens a preview modal: focus moves in, Tab is trapped, Esc closes and restores focus', async () => {
    stored.set('t1', thumbRecord('t1'));
    boot();
    record(shot({ eventId: 't1' }));
    await flush();
    const opener = rows()[0].querySelector('.ll-thumb-btn');
    opener.focus();
    opener.click();
    const modal = $('thumbModal');
    expect(modal.hidden).toBe(false);
    expect(modal.querySelector('[role="dialog"]').getAttribute('aria-modal')).toBe('true');
    expect($('thumbModalTitle').textContent).toBe('Step 1: click');
    expect($('thumbModalBody').querySelector('img').getAttribute('src')).toBe(urls.made[0]);
    expect($('thumbModalBody').querySelector('.ll-thumb-rect')).not.toBeNull();
    expect(document.activeElement).toBe($('thumbModalClose'));
    const tab = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    $('thumbModalClose').dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe($('thumbModalClose'));
    // Focus that wanders out is pulled back.
    $('replayBtn').disabled = false;
    $('recordBtn').focus();
    expect(document.activeElement).toBe($('thumbModalClose'));
    $('thumbModalClose').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(modal.hidden).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it('the backdrop and close button close it; a re-rendered opener still gets focus back', async () => {
    stored.set('t1', thumbRecord('t1'));
    boot();
    record(shot({ eventId: 't1' }));
    await flush();
    rows()[0].querySelector('.ll-thumb-btn').click();
    $('thumbModalBackdrop').click();
    expect($('thumbModal').hidden).toBe(true);
    rows()[0].querySelector('.ll-thumb-btn').click();
    renderTimeline(); // the opener node is replaced
    $('thumbModalClose').click();
    expect(document.activeElement).toBe(rows()[0].querySelector('.ll-thumb-btn'));
  });

  it('removing a step deletes its screenshot', async () => {
    stored.set('t1', thumbRecord('t1'));
    boot();
    record(shot({ eventId: 't1' }));
    record(shot({ eventId: 't2' }));
    await flush();
    rows()[0].querySelector('.remove-step-btn').click();
    expect(sentOf('THUMBS_DELETE')).toEqual([{ type: 'THUMBS_DELETE', eventIds: ['t1'], windowId: WIN }]);
    expect(urls.revoked).toContain(urls.made[0]);
  });

  it('undo keeps the screenshot for redo; a new step then drops the redo history', async () => {
    stored.set('t1', thumbRecord('t1'));
    stored.set('t2', thumbRecord('t2'));
    boot();
    record(shot({ eventId: 't1' }));
    record(shot({ eventId: 't2' }));
    await flush();
    $('undoActionBtn').click();
    expect(sentOf('THUMBS_DELETE')).toHaveLength(0);
    expect(urls.revoked).toHaveLength(1); // the URL goes, the stored image stays
    $('redoActionBtn').click();
    await flush();
    expect(thumbImg(1)).not.toBeNull();
    $('undoActionBtn').click();
    record(shot({ eventId: 't3' }));
    expect(sentOf('THUMBS_DELETE')).toEqual([{ type: 'THUMBS_DELETE', eventIds: ['t2'], windowId: WIN }]);
  });

  it('Clear Timeline clears the window and every known screenshot', async () => {
    stored.set('t1', thumbRecord('t1'));
    boot();
    record(shot({ eventId: 't1' }));
    record(shot({ eventId: 't2' }));
    await flush();
    $('undoActionBtn').click(); // t2 sits in the redo history
    $('clearTimelineBtn').click();
    expect(sentOf('THUMBS_CLEAR')).toEqual([{ type: 'THUMBS_CLEAR', windowId: WIN }]);
    expect(sentOf('THUMBS_DELETE')).toEqual([
      { type: 'THUMBS_DELETE', eventIds: ['t1', 't2'], windowId: WIN },
    ]);
    expect(urls.revoked).toEqual(urls.made);
  });

  it('a superseded click loses its screenshot too', () => {
    boot();
    record(shot({ eventId: 'c1' }));
    record(shot({ eventId: 'd1', action: 'dblclick', supersedes: ['c1'] }));
    expect(sentOf('THUMBS_DELETE')).toEqual([{ type: 'THUMBS_DELETE', eventIds: ['c1'], windowId: WIN }]);
  });

  it('never stores image data or URLs in llRecorderState', async () => {
    stored.set('t1', thumbRecord('t1'));
    boot();
    record(shot({ eventId: 't1' }));
    await flush();
    vi.advanceTimersByTime(250);
    const json = JSON.stringify(persisted());
    expect(json).not.toContain('blob:');
    expect(persisted().actions[0]).not.toHaveProperty('thumb');
    expect(persisted().actions[0].eventId).toBe('t1');
  });

  it('renders nothing without the store', async () => {
    delete globalThis.LLThumbs;
    boot();
    record(shot({ eventId: 't1' }));
    await flush();
    expect(rows()[0].querySelector('.ll-thumb-slot').children).toHaveLength(0);
  });

  it('computes the outline from rect and viewport, clipped to the screenshot', () => {
    const vp = { width: 1000, height: 500 };
    expect(thumbRectPercent({ rect: { x: -50, y: 450, width: 100, height: 100 }, viewport: vp })).toEqual({
      left: 0,
      top: 90,
      width: 5,
      height: 10,
    });
    expect(thumbRectPercent({ rect: { x: 1200, y: 0, width: 10, height: 10 }, viewport: vp })).toBeNull();
    expect(thumbRectPercent({ rect: { x: 0, y: 0, width: 0, height: 10 }, viewport: vp })).toBeNull();
    expect(thumbRectPercent({ rect: { x: 0, y: 0, width: 10, height: 10 } })).toBeNull();
    expect(thumbRectPercent({ rect: { x: 'a', y: 0, width: 10, height: 10 }, viewport: vp })).toBeNull();
  });

  it('a step without rect gets a thumbnail without an outline', async () => {
    stored.set('t1', thumbRecord('t1'));
    boot();
    record(step({ eventId: 't1' }));
    await flush();
    expect(thumbImg(0)).not.toBeNull();
    expect(rows()[0].querySelector('.ll-thumb-rect')).toBeNull();
  });

  it('loads thumbs-store.js before sidepanel.js', () => {
    const html = readFileSync(join(ROOT, 'src/sidepanel.html'), 'utf8');
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    expect(scripts).toEqual([
      'codegen.js',
      'codegen-java.js',
      'codegen-csharp.js',
      'codegen-wdio.js',
      'thumbs-store.js',
      'sidepanel.js',
    ]);
  });
});
