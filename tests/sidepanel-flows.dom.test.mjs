// @vitest-environment jsdom
//
// Existing side panel flows that the render/state suites leave thin: the selector
// lab, tabs, inspect messages, stress-test outcomes, clipboard fallbacks, export
// and download, the timeline filter/collapse, the legacy (no-codegen) fallback,
// persistence limits and restore edge cases. Same harness as the other sidepanel
// suites: the real sidepanel.js in jsdom behind a scripted `chrome` stub.

/* global LLCodegen, recorderFileName, copyToClipboard, dedupeKeyForAction, appendToRecorder,
   isFromContentScript, targetLabel, showPanelStatus, clearPanelStatus, scheduleRecorderPersist,
   outFramework */
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
  liveWindows: [WIN],
  getAllFails: false,
  setFailures: 0,
  sent: [],
  responders: {},
  deferred: [],
  portPosts: [],
  portListener: null,
  portDisconnect: null,
  connects: 0,
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
      getAll: (_o, cb) => {
        if (h.getAllFails) {
          chrome.runtime.lastError = { message: 'nope' };
          cb(undefined);
          chrome.runtime.lastError = null;
          return;
        }
        cb(h.liveWindows.map((id) => ({ id })));
      },
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
      connect: () => {
        h.connects++;
        return {
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
        };
      },
      onMessage: {
        addListener: (fn) => {
          h.runtimeListener = fn;
        },
      },
    },
    storage: {
      local: {
        get: (keys, cb) => cb(pick(keys)),
        set: (obj, cb) => {
          if (h.setFailures > 0) {
            h.setFailures--;
            chrome.runtime.lastError = { message: 'QUOTA_BYTES quota exceeded' };
            if (cb) cb();
            chrome.runtime.lastError = null;
            return;
          }
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
    thumbCache.clear(); _thumbGen.clear(); _thumbInFlight.clear();
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
  eventId: 'f' + ++seq,
  target: { kind: 'id', value: 'go' },
  code: "page.locator('#go')",
  ...over,
});
const record = (data) => port({ type: 'RECORDED_ACTION', windowId: WIN, data });
const setOutput = (fw, lang) =>
  vm.runInThisContext(`outFramework = ${JSON.stringify(fw)}; outLanguage = ${JSON.stringify(lang)};`);
const persisted = () => h.store[`llRecorderState:${WIN}`];

beforeEach(() => {
  vi.useFakeTimers();
  h.store = {};
  h.liveWindows = [WIN];
  h.getAllFails = false;
  h.setFailures = 0;
  h.sent = [];
  h.responders = { GET_RECORDING_STATE: () => ({ active: false }) };
  h.deferred = [];
  h.portPosts = [];
  resetPanelGlobals();
  window.confirm = vi.fn(() => true);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(() => Promise.resolve()) },
    configurable: true,
  });
  document.execCommand = vi.fn(() => true);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('selector lab', () => {
  it('validates on click and on Enter, never an empty selector', () => {
    boot();
    $('lab-input').value = '  ';
    $('lab-validate-btn').click();
    expect(sentOf('LAB_VALIDATE')).toHaveLength(0);
    $('lab-input').value = ' #login ';
    $('lab-validate-btn').click();
    $('lab-input').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
    $('lab-input').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' }));
    expect(sentOf('LAB_VALIDATE')).toEqual([
      { type: 'LAB_VALIDATE', selector: '#login', windowId: WIN },
      { type: 'LAB_VALIDATE', selector: '#login', windowId: WIN },
    ]);
  });

  it('shows matches, no matches and errors', () => {
    boot();
    port({ type: 'LAB_STATUS_UPDATE', windowId: WIN, count: 3, via: 'getByRole' });
    expect($('lab-status').textContent).toBe(
      'Identification successful. Found 3 match(es). · via getByRole()'
    );
    expect($('lab-status').className).toContain('success');
    expect($('lab-count').textContent).toBe('(3)');
    expect($('lab-count').style.display).toBe('inline');
    port({ type: 'LAB_STATUS_UPDATE', windowId: WIN, count: 1 });
    expect($('lab-status').textContent).toBe('Identification successful. Found 1 match(es).');
    port({ type: 'LAB_STATUS_UPDATE', windowId: WIN, count: 0, via: 'getByText' });
    expect($('lab-status').textContent).toBe('Parsed getByText() but found no matches in the current DOM.');
    expect($('lab-count').style.display).toBe('none');
    port({ type: 'LAB_STATUS_UPDATE', windowId: WIN, count: 0 });
    expect($('lab-status').textContent).toBe('No matches found in the current DOM.');
    port({ type: 'LAB_ERROR', windowId: WIN, error: 'Unexpected token' });
    expect($('lab-status').textContent).toBe('Invalid Selector: Unexpected token');
    expect($('lab-status').className).toContain('err');
  });

  it('Clear resets the lab and tells the page', () => {
    boot();
    $('lab-input').value = '#x';
    port({ type: 'LAB_STATUS_UPDATE', windowId: WIN, count: 2 });
    $('lab-clear-btn').click();
    expect($('lab-input').value).toBe('');
    expect($('lab-status').textContent).toBe('Ready to validate...');
    expect($('lab-count').style.display).toBe('none');
    expect(sentOf('LAB_CLEAR')).toEqual([{ type: 'LAB_CLEAR', windowId: WIN }]);
  });
});

describe('tabs and inspect state', () => {
  it('switches tabs and keeps aria-selected in sync', () => {
    boot();
    const [inspectTab, recordTab] = document.querySelectorAll('.tab');
    recordTab.click();
    expect(recordTab.getAttribute('aria-selected')).toBe('true');
    expect(inspectTab.getAttribute('aria-selected')).toBe('false');
    expect($('tab-recorder').classList.contains('active')).toBe(true);
    expect($('tab-inspector').classList.contains('active')).toBe(false);
    inspectTab.click();
    expect($('tab-inspector').classList.contains('active')).toBe(true);
  });

  it('follows START_INSPECT / STOP_INSPECT and the reported state', () => {
    h.responders.GET_INSPECT_STATE = () => ({ active: true });
    boot();
    expect($('btnText').textContent).toBe('Stop Inspecting');
    expect($('hintRow').style.display).toBe('block');
    port({ type: 'STOP_INSPECT', windowId: WIN });
    expect($('btnText').textContent).toBe('Start Inspecting');
    expect($('statusDot').classList.contains('active')).toBe(false);
    port({ type: 'START_INSPECT', windowId: WIN });
    expect($('btnText').textContent).toBe('Stop Inspecting');
  });

  it('the inspect button toggles on and off', () => {
    h.responders.START_INSPECT = () => ({ ok: true });
    boot();
    $('inspectBtn').click();
    expect($('btnText').textContent).toBe('Stop Inspecting');
    $('inspectBtn').click();
    expect(sentOf('STOP_INSPECT')).toEqual([{ type: 'STOP_INSPECT', windowId: WIN }]);
    expect($('btnText').textContent).toBe('Start Inspecting');
  });

  it('a refused start without a message still explains itself', () => {
    h.responders.START_INSPECT = () => ({ ok: false });
    boot();
    $('inspectBtn').click();
    expect($('panelStatus').textContent).toBe("Locatra can't run on this page.");
  });

  it('renders a pick only once per pickId', () => {
    boot();
    const data = { pickId: 'p9', elementData: { tag: 'a' }, locators: [] };
    port({ type: 'ELEMENT_PICKED', windowId: WIN, data });
    $('elBar').textContent = 'marker';
    port({ type: 'ELEMENT_PICKED', windowId: WIN, data });
    expect($('elBar').textContent).toBe('marker');
  });
});

describe('panel status line', () => {
  it('fades informational notes but keeps errors', () => {
    boot();
    showPanelStatus('saved', 'info');
    expect($('panelStatus').hidden).toBe(false);
    vi.advanceTimersByTime(6000);
    expect($('panelStatus').hidden).toBe(true);
    showPanelStatus('broken', 'err');
    vi.advanceTimersByTime(10000);
    expect($('panelStatus').textContent).toBe('broken');
    clearPanelStatus();
    expect($('panelStatus').hidden).toBe(true);
  });
});

describe('stress test outcomes', () => {
  const run = (data) => {
    $('stressTestBtn').click();
    port({ type: 'STRESS_TEST_RESULT', windowId: WIN, data });
    return $('stressResult');
  };

  it('reports an unreachable page, a missing target, survival and failure', () => {
    boot();
    renderResults({ elementData: { tag: 'button' }, locators: [] });
    expect(run({ unavailable: true }).textContent).toContain("couldn't reach this page");
    expect(run({ noTarget: true }).textContent).toContain('no element selected');
    const ok = run({ survived: true, role: 'button', tag: 'button', name: 'Save' });
    expect(ok.textContent).toBe(
      'Stress Test complete. Target: <button> · role="button" · name="Save". Element locatable without classes/id? Yes ✅'
    );
    expect(ok.className).toContain('ok');
    const bad = run({ survived: false, role: 'link' });
    expect(bad.textContent).toContain('<?> · role="link".');
    expect(bad.textContent).toContain('No ❌');
    expect(bad.className).toContain('warn');
    expect(run(undefined).textContent).toContain('No ❌');
  });

  it('ignores a second click while one is pending', () => {
    boot();
    renderResults({ elementData: { tag: 'button' }, locators: [] });
    $('stressTestBtn').click();
    $('stressTestBtn').click();
    expect(sentOf('RUN_STRESS_TEST')).toHaveLength(1);
    expect($('stressTestBtn').textContent).toBe('Testing...');
  });

  it('falls back to the panel status line without its own result box', () => {
    boot();
    $('stressResult').remove();
    $('stressTestBtn').click();
    port({ type: 'STRESS_TEST_RESULT', windowId: WIN, data: { noTarget: true } });
    expect($('panelStatus').textContent).toContain('no element selected');
  });
});

describe('result rendering details', () => {
  beforeEach(boot);

  it('shows frame and shadow context, and truncates a long page URL', () => {
    const url = 'https://example.com/' + 'a'.repeat(100);
    renderResults({
      pageUrl: url,
      elementData: {
        tag: 'input',
        visibleText: 'x'.repeat(40),
        id: 'q',
        testId: 'search',
        ariaLabel: 'Search the site',
        placeholder: 'Search…',
        hasUnstableClasses: true,
        framePath: ['#outer', '#inner'],
        isInShadow: true,
        shadowHost: 'my-widget',
      },
      locators: [],
    });
    const bar = $('elBar').textContent;
    for (const s of [
      'IFRAME',
      '#outer › #inner',
      'SHADOW',
      'my-widget',
      'auto-generated',
      'testid: search',
    ]) {
      expect(bar).toContain(s);
    }
    expect(bar).toContain(url.slice(0, 77) + '…');
    expect(document.querySelector('.el-chip-url').getAttribute('title')).toBe(url);
  });

  it('takes the page URL from elementData when the payload has none', () => {
    renderResults({ elementData: { tag: 'a', pageUrl: 'https://x.test/p' }, locators: [] });
    expect($('elBar').textContent).toContain('https://x.test/p');
  });

  it('labels ambiguous locators and copies the full statement', async () => {
    renderResults({
      elementData: { tag: 'button', suggestedAction: 'click' },
      locators: [
        {
          rank: 2,
          method: 'getByText()',
          stability: 'OK',
          code: "page.getByText('Go')",
          fullCode: "await page.getByText('Go').click();",
          matchCount: 12,
          unique: false,
        },
        {
          rank: 3,
          method: 'locator()',
          stability: 'AVOID',
          code: 'x',
          fullCode: 'y',
          matchCount: 2,
          unique: false,
        },
        { rank: 4, method: 'xpath', stability: 'weird', code: 'x', fullCode: 'y' },
      ],
    });
    const cards = document.querySelectorAll('#cardsContainer .card');
    expect(cards[0].className).toContain('r2');
    expect(cards[0].textContent).toContain('⚠ 10+ matches');
    expect(cards[1].textContent).toContain('⚠ 2 matches');
    expect(cards[1].querySelector('.pill').className).toContain('p-avoid');
    expect(cards[2].className).toContain('rX');
    expect(cards[2].querySelector('.pill').textContent).toBe('weird');
    cards[0].querySelector('.copy-btn').click();
    await flush();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("await page.getByText('Go').click();");
  });

  it('defers a pick that arrives before the markup exists', () => {
    document.body.innerHTML = '';
    renderResults({ elementData: { tag: 'em' }, locators: [] });
    mountRealPanel();
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
    expect($('elBar').textContent).toContain('em');
  });

  it('translates locators for other frameworks', () => {
    setOutput('selenium', 'python');
    renderResults({
      elementData: { tag: 'input', suggestedAction: 'fill' },
      locators: [
        {
          rank: 1,
          method: 'getByLabel()',
          stability: 'BEST',
          code: "page.getByLabel('Email')",
          fullCode: "await page.getByLabel('Email').fill('x');",
          target: { kind: 'label', value: 'Email' },
        },
      ],
    });
    const card = document.querySelector('#cardsContainer .card');
    expect(card.querySelector('.method-name').textContent).toBe('Label');
    expect(card.querySelector('.copy-btn').getAttribute('data-code')).toContain('your value');
    expect(card.querySelector('.code-txt').textContent).not.toContain('getByLabel');
  });
});

describe('clipboard fallbacks', () => {
  it('uses execCommand when the async clipboard is missing', () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    document.body.innerHTML = '<button id="b">Copy</button>';
    copyToClipboard('text', $('b'));
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect($('b').textContent).toBe('✓ Copied');
    expect(document.querySelector('textarea')).toBeNull();
    vi.advanceTimersByTime(2000);
    expect($('b').textContent).toBe('Copy');
  });

  // execCommand reports failure by returning false, not by throwing; the button used
  // to say "✓ Copied" anyway.
  it('says the copy failed when execCommand returns false', () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    document.execCommand = vi.fn(() => false);
    document.body.innerHTML = '<button id="b">Copy</button>';
    copyToClipboard('text', $('b'));
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect($('b').textContent).toBe('Copy failed');
    expect($('b').classList.contains('done')).toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
    vi.advanceTimersByTime(2000);
    expect($('b').textContent).toBe('Copy');
  });

  it('falls back when writeText rejects, and says so when that fails too', async () => {
    navigator.clipboard.writeText = vi.fn(() => Promise.reject(new Error('denied')));
    document.execCommand = vi.fn(() => {
      throw new Error('no');
    });
    document.body.innerHTML = '<button id="b">Copy</button>';
    copyToClipboard('text', $('b'));
    await flush();
    expect($('b').textContent).toBe('Copy failed');
    expect(document.querySelector('textarea')).toBeNull();
    vi.advanceTimersByTime(2000);
    expect($('b').textContent).toBe('Copy');
  });
});

describe('export, download and the editor', () => {
  it('Copy/Download explain themselves with nothing recorded', () => {
    boot();
    $('exportTestBtn').click();
    expect($('panelStatus').textContent).toContain('Record at least one action first');
    clearPanelStatus();
    $('downloadTestBtn').click();
    expect($('panelStatus').textContent).toContain('Record at least one action first');
  });

  it('Copy copies the editor text', async () => {
    boot();
    record(step({ target: { kind: 'id', value: 'buy' } }));
    $('exportTestBtn').click();
    await flush();
    expect(navigator.clipboard.writeText.mock.calls[0][0]).toContain('#buy');
  });

  it('Download saves the script under the target-specific name', () => {
    URL.createObjectURL = vi.fn(() => 'blob:test');
    URL.revokeObjectURL = vi.fn();
    const names = [];
    vi.spyOn(window.HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      names.push(this.download);
    });
    boot();
    record(step());
    $('downloadTestBtn').click();
    vi.advanceTimersByTime(2000);
    expect(names).toEqual(['locatra-recorded.spec.ts']);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test');
  });

  it('names files per framework and language', () => {
    expect(recorderFileName('playwright', 'python')).toBe('test_recorded.py');
    expect(recorderFileName('cypress', 'javascript')).toBe('recorded.cy.js');
    expect(recorderFileName('cypress', 'typescript')).toBe('recorded.cy.ts');
    expect(recorderFileName('selenium', 'typescript')).toBe('locatra-recorded.ts');
    expect(recorderFileName('playwright', 'javascript')).toBe('locatra-recorded.spec.js');
  });

  it('pastes plain text only', () => {
    boot();
    record(step());
    const ev = new window.Event('paste', { cancelable: true });
    ev.clipboardData = { getData: (t) => (t === 'text/plain' ? 'plain' : '<b>rich</b>') };
    $('codePreview').dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith('insertText', false, 'plain');
  });

  it('typing marks the script edited and persists the edit', () => {
    boot();
    record(step({ eventId: 'a' }));
    record(step({ eventId: 'b', target: { kind: 'id', value: 'b' } }));
    setPreviewCode($('codePreview'), lastSyncedPreviewScript + '\n// mine');
    $('codePreview').dispatchEvent(new window.Event('input'));
    vi.advanceTimersByTime(250);
    expect(persisted().codeEdited).toBe(true);
    expect(persisted().codePreview).toContain('// mine');
    // Removing a step that is still in the edited script is flagged too.
    document.querySelectorAll('#recorderTimeline .remove-step-btn')[1].click();
    expect($('scriptStaleText').textContent).toBe('1 removed step still in your edited script');
    record(step({ eventId: 'c' }));
    expect($('scriptStaleText').textContent).toBe(
      '1 new step not in your edited script (and 1 removed step still in it)'
    );
    $('regenerateScriptBtn').click();
    expect($('scriptStaleNotice').hidden).toBe(true);
    expect(document.activeElement).toBe($('codePreview'));
  });

  it('copies a single step from the timeline', async () => {
    boot();
    record(step({ target: { kind: 'id', value: 'single' } }));
    document.querySelector('#recorderTimeline .copy-btn').click();
    await flush();
    expect(navigator.clipboard.writeText.mock.calls[0][0]).toContain('#single');
  });

  it('shows the page the recording is on', () => {
    boot();
    record(
      step({ action: 'goto', value: 'https://shop.test/', url: 'https://shop.test/', target: undefined })
    );
    expect($('recPageUrl').textContent).toBe('Page: https://shop.test/');
    expect($('recPageUrl').style.display).toBe('block');
  });
});

describe('timeline filter and collapse', () => {
  it('filters after a short pause, shows a no-match note, and clears', () => {
    boot();
    record(step({ action: 'fill', value: 'alice' }));
    record(step());
    const input = $('recFilterInput');
    input.value = 'alice';
    input.dispatchEvent(new window.Event('input'));
    expect(document.querySelectorAll('#recorderTimeline .ll-rec-step')).toHaveLength(2);
    vi.advanceTimersByTime(200);
    expect(document.querySelectorAll('#recorderTimeline .ll-rec-step')).toHaveLength(1);
    expect($('recFilterClear').style.display).toBe('');
    input.value = 'zzz';
    input.dispatchEvent(new window.Event('input'));
    vi.advanceTimersByTime(200);
    expect($('recorderTimeline').textContent).toContain('No actions match "zzz".');
    $('recFilterClear').click();
    expect(document.querySelectorAll('#recorderTimeline .ll-rec-step')).toHaveLength(2);
    expect(document.activeElement).toBe(input);
  });

  it('expands and collapses from the header by mouse and keyboard', () => {
    boot();
    const hdr = $('timelineToggleHeader');
    hdr.click();
    expect(hdr.getAttribute('aria-expanded')).toBe('true');
    expect($('recorderTimeline').style.display).toBe('');
    expect(hdr.querySelector('.ll-timeline-chevron').textContent).toBe('▼');
    hdr.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
    expect(hdr.getAttribute('aria-expanded')).toBe('false');
    hdr.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ' }));
    expect(hdr.getAttribute('aria-expanded')).toBe('true');
    hdr.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'x' }));
    expect(hdr.getAttribute('aria-expanded')).toBe('true');
  });

  it('undo/redo do nothing on empty stacks', () => {
    boot();
    $('undoActionBtn').disabled = false;
    $('redoActionBtn').disabled = false;
    $('undoActionBtn').click();
    $('redoActionBtn').click();
    expect(recordedActions).toHaveLength(0);
  });

  it('undoing every step removes the saved state', () => {
    boot();
    record(step());
    vi.advanceTimersByTime(250);
    expect(persisted()).toBeDefined();
    $('undoActionBtn').click();
    vi.advanceTimersByTime(250);
    expect(persisted()).toBeUndefined();
  });

  it('ignores a remove click with a bogus index', () => {
    boot();
    record(step());
    const btn = document.querySelector('#recorderTimeline .remove-step-btn');
    btn.setAttribute('data-index', '9');
    btn.click();
    expect(recordedActions).toHaveLength(1);
  });
});

describe('recording toggle edge cases', () => {
  it('re-enables the button if the worker never answers', () => {
    h.responders.START_RECORDING = () => DEFER;
    boot();
    $('recordBtn').click();
    expect($('recordBtn').disabled).toBe(true);
    $('recordBtn').click(); // ignored while busy
    expect(sentOf('START_RECORDING')).toHaveLength(1);
    vi.advanceTimersByTime(5000);
    expect($('recordBtn').disabled).toBe(false);
    // A late answer after the timeout changes nothing.
    h.deferred[0].cb({ ok: false });
    expect($('panelStatus').hidden).toBe(true);
  });

  it('explains a refused stop that came without a message', () => {
    h.responders.GET_RECORDING_STATE = () => ({ active: true, paused: false });
    h.responders.STOP_RECORDING = () => ({ ok: false });
    boot();
    $('recordBtn').click();
    expect($('panelStatus').textContent).toBe("Couldn't stop recording.");
  });

  it('explains a refused start that came without a message', () => {
    h.responders.START_RECORDING = () => ({ ok: false });
    boot();
    $('recordBtn').click();
    expect($('panelStatus').textContent).toBe("Couldn't start recording on this page.");
  });

  it('re-reads the state when the panel becomes visible again', () => {
    boot();
    const before = sentOf('GET_RECORDING_STATE').length;
    // (Earlier boots in this file left their own document listeners behind, so
    // only "at least one more query" is meaningful here.)
    document.dispatchEvent(new window.Event('visibilitychange'));
    expect(sentOf('GET_RECORDING_STATE').length).toBeGreaterThan(before);
  });
});

describe('port lifecycle', () => {
  it('reconnects after a disconnect and says hello again', () => {
    boot();
    const before = h.connects;
    h.portDisconnect();
    vi.advanceTimersByTime(400);
    expect(h.connects).toBe(before + 1);
    expect(h.portPosts).toContainEqual({ type: 'PANEL_HELLO', windowId: WIN });
  });

  it('acknowledges the buffer on both channels once saved', () => {
    boot();
    record(step());
    vi.advanceTimersByTime(250);
    expect(sentOf('PANEL_BUFFER_ACK')).toEqual([{ type: 'PANEL_BUFFER_ACK', windowId: WIN }]);
  });

  it('treats the extension opened as a tab as the extension, not a content script', () => {
    expect(
      isFromContentScript({ tab: { id: 1 }, url: 'chrome-extension://locatra/src/sidepanel.html' })
    ).toBe(false);
    expect(isFromContentScript({ tab: { id: 1 }, url: 'https://x.test/' })).toBe(true);
    expect(isFromContentScript({})).toBe(false);
    boot();
    h.runtimeListener(
      { type: 'RECORDED_ACTION', data: step({ eventId: 'tabpage' }) },
      { tab: { id: 1 }, url: 'chrome-extension://locatra/src/sidepanel.html' }
    );
    h.runtimeListener(null, {});
    expect(recordedActions.map((a) => a.eventId)).toEqual(['tabpage']);
  });
});

describe('legacy fallback without codegen', () => {
  let saved;
  beforeEach(() => {
    saved = globalThis.LLCodegen;
    delete globalThis.LLCodegen;
  });
  afterEach(() => {
    globalThis.LLCodegen = saved;
  });

  it('builds Playwright lines from the step itself', () => {
    const loc = "page.locator('#f')";
    expect(buildActionCode({ action: 'goto', value: 'https://x.test/' })).toBe(
      'await page.goto("https://x.test/");'
    );
    expect(buildActionCode({ action: 'fill', code: loc, value: "it's \\ok" })).toBe(
      `await ${loc}.fill('it\\'s \\\\ok');`
    );
    expect(buildActionCode({ action: 'fill', code: loc, sensitive: true, secretName: 'PW' })).toBe(
      `await ${loc}.fill(process.env.PW ?? '');`
    );
    expect(buildActionCode({ action: 'fill', code: loc, sensitive: true, secretName: 'bad name' })).toContain(
      'process.env.LOCATRA_PASSWORD'
    );
    expect(buildActionCode({ action: 'selectOption', code: loc, value: "a'b" })).toBe(
      `await ${loc}.selectOption('a\\'b');`
    );
    expect(buildActionCode({ action: 'uncheck', code: loc })).toBe(`await ${loc}.uncheck();`);
    expect(buildActionCode({ action: 'press', value: 'Enter' })).toBe('await page.keyboard.press("Enter");');
    expect(buildActionCode({ action: 'assert', assertType: 'toHaveURL', value: 'https://x.test/done' })).toBe(
      'await expect(page).toHaveURL("https://x.test/done");'
    );
    expect(buildActionCode({ action: 'assert', assertType: 'toBeVisible', code: loc })).toBe(
      `await expect(${loc}).toBeVisible();`
    );
    expect(buildActionCode({ action: 'click', code: loc })).toBe(`await ${loc}.click();`);
    expect(buildActionCode({ action: 'hover', fullCode: 'await x.hover();' })).toBe('await x.hover();');
  });

  it('wraps them in a Playwright test, skipping suggestions', () => {
    recordedActions = [
      { action: 'goto', value: 'https://x.test/' },
      { action: 'assert', assertType: 'toHaveURL', value: 'https://x.test/', suggested: true },
    ];
    const script = generateTestScript();
    expect(script).toContain("test('recorded test'");
    expect(script).toContain('  await page.goto("https://x.test/");');
    expect(script).not.toContain('toHaveURL');
  });

  it('labels targets without codegen metadata', () => {
    expect(targetLabel('selenium', 'python')).toBe('selenium / python');
  });
});

describe('codegen failures', () => {
  it('falls back to a TODO comment when codegen throws for a non-Playwright target', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(LLCodegen, 'actionStatement').mockImplementation(() => {
      throw new Error('boom');
    });
    setOutput('cypress', 'javascript');
    expect(buildActionCode(step())).toMatch(/^\/\/ TODO: could not convert step: click/);
    setOutput('playwright', 'typescript');
  });

  it('renders a minimal timeline when a step cannot be rendered at all', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    boot();
    record(step({ fullCode: 'await legacy();' }));
    // A broken value object makes the rich template throw.
    recordedActions[0].value = {
      toString() {
        throw new Error('bad');
      },
    };
    renderTimeline();
    expect(document.querySelector('#recorderTimeline .ll-rec-step-code').textContent).toBe('await legacy();');
  });
});

describe('accessibility', () => {
  it('announces each new step on its own instead of re-reading the whole timeline', () => {
    boot();
    expect($('recorderTimeline').hasAttribute('aria-live')).toBe(false);
    record(step({ action: 'click' }));
    record(step({ action: 'fill', value: 'x' }));
    expect($('recAnnounce').getAttribute('aria-live')).toBe('polite');
    expect($('recAnnounce').textContent).toBe('Step 2 recorded: fill');
  });

  it('labels the Selector Lab controls and makes its status a live region', () => {
    boot();
    expect($('lab-input').getAttribute('aria-label')).toMatch(/selector/i);
    expect($('lab-validate-btn').getAttribute('aria-label')).toBe('Validate selector');
    expect($('lab-clear-btn').getAttribute('aria-label')).toBe('Clear highlights');
    expect($('lab-status').getAttribute('role')).toBe('status');
  });
});

describe('persistence limits', () => {
  it('keeps the newest 500 steps and the newest 2000 keys', () => {
    boot();
    // Without the timeline/editor in the DOM each append skips the (quadratic) re-render.
    $('recorderTimeline').remove();
    $('codePreview').remove();
    for (let i = 0; i < 2005; i++) appendToRecorder(step({ eventId: 'k' + i }));
    expect(seenActionKeys.size).toBe(2000);
    expect(seenActionKeys.has('eid:k0')).toBe(false);
    vi.advanceTimersByTime(250);
    expect(persisted().actions).toHaveLength(500);
    expect(persisted().actions[0].eventId).toBe('k1505');
  });

  it('keeps the opening goto through the cut, and says once that steps were dropped', () => {
    boot();
    vm.runInThisContext('_persistTrimNoted = false;'); // the test above already tripped it
    $('recorderTimeline').remove();
    $('codePreview').remove();
    appendToRecorder(step({ eventId: 'start', action: 'goto', value: 'https://shop.example/' }));
    for (let i = 0; i < 600; i++) appendToRecorder(step({ eventId: 'g' + i }));
    vi.advanceTimersByTime(250);
    const kept = persisted().actions;
    expect(kept).toHaveLength(500);
    expect(kept[0].eventId).toBe('start');
    expect(kept[1].eventId).toBe('g101');
    expect(kept[499].eventId).toBe('g599');
    expect($('panelStatus').textContent).toMatch(/601 steps; only the last 500 are kept/);
    $('panelStatus').textContent = '';
    appendToRecorder(step({ eventId: 'g600' }));
    vi.advanceTimersByTime(250);
    expect($('panelStatus').textContent).toBe('');
  });

  it('drops the editor text and trims when the quota is exceeded', () => {
    boot();
    recordedActions = Array.from({ length: 150 }, (_, i) => step({ eventId: 'q' + i }));
    updateCodePreview();
    setPreviewCode($('codePreview'), lastSyncedPreviewScript + '\n// edit');
    h.setFailures = 1;
    scheduleRecorderPersist();
    vi.advanceTimersByTime(250);
    expect(persisted().actions).toHaveLength(100);
    expect(persisted().codePreview).toBe('');
    expect(persisted().codeEdited).toBe(false);
  });
});

describe('dedupe keys', () => {
  it('prefers eventId, then tab+sequence, then a value-free legacy key for secrets', () => {
    expect(dedupeKeyForAction({ eventId: 'x' })).toBe('eid:x');
    expect(dedupeKeyForAction({ tabId: 4, sequence: 9 })).toBe('seq:4:9');
    expect(dedupeKeyForAction({ sequence: 9 })).toBe('seq:0:9');
    expect(dedupeKeyForAction({ timestamp: 1, action: 'fill', value: 'v', code: 'c' })).toBe('0_1_fill_v_c');
    expect(dedupeKeyForAction({ timestamp: 1, action: 'fill', value: 'pw', sensitive: true })).toBe(
      '0_1_fill__'
    );
  });

  it('undo releases a legacy key so the same step can be recorded again', () => {
    boot();
    const legacy = {
      action: 'click',
      timestamp: 5,
      code: "page.locator('#l')",
      target: { kind: 'id', value: 'l' },
    };
    appendToRecorder(legacy);
    $('undoActionBtn').click();
    appendToRecorder(legacy);
    expect(recordedActions).toHaveLength(1);
  });
});

describe('restore edge cases', () => {
  it('switches to the target an edited script was written for', () => {
    h.store[`llRecorderState:${WIN}`] = {
      actions: [step({ eventId: 'r1' })],
      codePreview: 'driver.find_element("x")  # hand edited',
      codeEdited: true,
      codeFramework: 'selenium',
      codeLanguage: 'python',
      syncedStepKeys: ['eid:r1'],
      updatedAt: Date.now(),
    };
    boot();
    expect(outFramework).toBe('selenium');
    expect($('fwSelect').value).toBe('selenium');
    expect($('langSelect').value).toBe('python');
    expect(getPreviewText($('codePreview'))).toContain('hand edited');
  });

  it('removes stale orphans and, when windows cannot be listed, adopts only the shared default', () => {
    h.getAllFails = true;
    h.store['llRecorderState:3'] = { actions: [step({ eventId: 'w3' })], updatedAt: 1 };
    h.store['llRecorderState:default'] = { actions: [step({ eventId: 'dflt' })], updatedAt: 2 };
    h.store['llRecorderState:junk'] = 'not an object';
    boot();
    expect(recordedActions.map((a) => a.eventId)).toEqual(['dflt']);
    expect(h.store['llRecorderState:3']).toBeDefined(); // might belong to a live window
  });

  it('drops orphans older than 14 days', () => {
    h.liveWindows = [WIN];
    h.store[`llRecorderState:${WIN}`] = { actions: [step({ eventId: 'own' })], updatedAt: Date.now() };
    h.store['llRecorderState:3'] = { actions: [step()], updatedAt: Date.now() - 15 * 24 * 3600 * 1000 };
    h.store['llRecorderState:4'] = { actions: [step()], updatedAt: Date.now() };
    boot();
    expect(h.store['llRecorderState:3']).toBeUndefined();
    expect(h.store['llRecorderState:4']).toBeDefined();
  });

  it('a dblclick that arrives before the restore supersedes its clicks after it', () => {
    h.store[`llRecorderState:${WIN}`] = {
      actions: [step({ eventId: 'c1' }), step({ eventId: 'keep' })],
      updatedAt: Date.now(),
    };
    const realGet = chrome.storage.local.get;
    const parked = [];
    chrome.storage.local.get = (keys, cb) =>
      keys === null ? parked.push(() => cb(pick(null))) : realGet(keys, cb);
    try {
      boot();
      port({
        type: 'RECORDED_ACTION',
        windowId: WIN,
        data: step({ eventId: 'dbl', action: 'dblclick', supersedes: ['c1'] }),
      });
      parked.forEach((fn) => fn());
    } finally {
      chrome.storage.local.get = realGet;
    }
    expect(recordedActions.map((a) => a.eventId)).toEqual(['keep', 'dbl']);
  });
});
