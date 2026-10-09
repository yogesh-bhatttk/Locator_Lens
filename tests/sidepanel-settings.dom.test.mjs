// @vitest-environment jsdom
//
// Side panel: following the options page and the worker. Live framework/language
// changes (storage.onChanged), the frameworks/languages the plug-in targets add
// (Java, C#, WebdriverIO), target-specific download names, the "⚙ All settings"
// link, RECORDING_STATE / ACTIVATION_FAILED relays, and settings writes that keep
// the options page's fields. The real sidepanel.js runs in jsdom with the real
// codegen.js and target modules behind a scripted `chrome` stub.

/* global LLCodegen, recorderFileName, declaredClassName, showPanelStatus */
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
  portListener: null,
  storageListeners: [],
  options: { mode: 'ok', calls: 0 },
  tabsCreated: [],
};

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function pickKeys(keys) {
  if (keys == null) return clone(h.store);
  const list = Array.isArray(keys) ? keys : [keys];
  const out = {};
  for (const k of list) if (k in h.store) out[k] = clone(h.store[k]);
  return out;
}

const MODULES = ['codegen-java.js', 'codegen-csharp.js', 'codegen-wdio.js'];

beforeAll(async () => {
  await import('../src/codegen.js');
  // The plug-in targets register themselves, exactly as the <script> tags load them.
  for (const m of MODULES) {
    vm.runInThisContext(readFileSync(join(ROOT, 'src', m), 'utf8'), { filename: m });
  }
  globalThis.chrome = {
    windows: {
      getCurrent: (cb) => cb({ id: WIN }),
      getAll: (_o, cb) => cb([{ id: WIN }]),
    },
    tabs: {
      create: (o) => h.tabsCreated.push(o),
    },
    runtime: {
      lastError: null,
      getURL: (p) => 'chrome-extension://locatra/' + p,
      openOptionsPage: (cb) => {
        h.options.calls++;
        if (h.options.mode === 'promise-reject') return Promise.reject(new Error('no'));
        if (h.options.mode === 'error') {
          chrome.runtime.lastError = { message: 'Could not create an options page.' };
          cb();
          chrome.runtime.lastError = null;
          return undefined;
        }
        if (h.options.mode === 'throw') throw new Error('nope');
        cb();
        return undefined;
      },
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
        postMessage: () => {},
        onMessage: {
          addListener: (fn) => {
            h.portListener = fn;
          },
        },
        onDisconnect: { addListener: () => {} },
      }),
      onMessage: { addListener: () => {} },
    },
    permissions: {
      contains: (q, cb) => queueMicrotask(() => cb(true)),
      request: (q, cb) => queueMicrotask(() => cb(true)),
      onAdded: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    storage: {
      onChanged: { addListener: (fn) => h.storageListeners.push(fn) },
      local: {
        get: (keys, cb) => cb(pickKeys(keys)),
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
    lastResultData = null; lastLocators = []; lastRenderedPickId = null; _stressState = null;
    outFramework = 'playwright'; outLanguage = 'typescript'; _bufferAckPending = false;
    _outputReady = false; _ownOutputWrites.length = 0;
    replayRun = null; replayStatuses = new Map(); replaySecretsOpen = false;
    pomModel = null; _pomLastResultJson = '';
    thumbCache.clear(); _thumbGen.clear(); _thumbInFlight.clear(); _thumbModalOpener = null;
    llSettings = { autoAssertions: true, stepScreenshots: true, variables: true, healthAutoCheck: false };
    llSettingsRaw = {}; _settingsLoaded = false;
    watched = { version: 1, sites: {} }; _watchedLoaded = false; healthPage = null; healthCheckRun = null;
    _activePageInFlight = false; _activePageAgain = []; _watchedOps.length = 0; _watchedBusy = false;
  `);
}

function boot() {
  const html = readFileSync(join(ROOT, 'src/sidepanel.html'), 'utf8');
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  document.body.innerHTML = (body ? body[1] : '').replace(/<script[\s\S]*?<\/script>/gi, '');
  document.dispatchEvent(new window.Event('DOMContentLoaded'));
}

const $ = (id) => document.getElementById(id);
const port = (msg) => h.portListener(msg);
const fireStorage = (changes) => {
  for (const fn of h.storageListeners) fn(changes, 'local');
};
const options = (id) =>
  [...$(id).options].map((o) => ({ id: o.value, text: o.textContent, disabled: o.disabled }));
const script = () => $('codePreview').textContent;
let seq = 0;
const click = () => ({
  action: 'click',
  eventId: 's' + ++seq,
  target: { kind: 'id', value: 'go' },
  code: "page.locator('#go')",
});
const record = (data) => port({ type: 'RECORDED_ACTION', windowId: WIN, data });
const choose = (id, value) => {
  $(id).value = value;
  $(id).dispatchEvent(new window.Event('change'));
};
const PICK = {
  pickId: 'k1',
  pageUrl: 'https://shop.test/',
  elementData: { tag: 'button' },
  locators: [
    {
      rank: 1,
      method: 'locator',
      stability: 'GOOD',
      code: "page.locator('#go')",
      fullCode: "await page.locator('#go').click();",
      target: { kind: 'id', value: 'go' },
    },
  ],
};

beforeEach(() => {
  vi.useFakeTimers();
  h.store = {};
  h.sent = [];
  h.deferred = [];
  h.options = { mode: 'ok', calls: 0 };
  h.tabsCreated = [];
  h.responders = {
    GET_RECORDING_STATE: () => ({ active: false }),
    GET_ACTIVE_PAGE: () => ({ ok: true, url: 'https://shop.test/', siteKey: 'https://shop.test/' }),
  };
  resetPanelGlobals();
  window.confirm = vi.fn(() => true);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── New targets ──────────────────────────────────────────────────────────────────
describe('frameworks and languages from the target modules', () => {
  it('lists every registered framework and language without panel changes', () => {
    boot();
    expect(options('fwSelect').map((o) => o.id)).toEqual(LLCodegen.FRAMEWORKS.map((f) => f.id));
    expect(options('fwSelect').map((o) => o.text)).toContain('WebdriverIO');
    expect(options('langSelect')).toEqual([
      { id: 'typescript', text: 'TypeScript', disabled: false },
      { id: 'javascript', text: 'JavaScript', disabled: false },
      { id: 'python', text: 'Python', disabled: false },
      { id: 'java', text: 'Java', disabled: false },
      { id: 'csharp', text: 'C#', disabled: false },
    ]);
  });

  it('greys out what a framework cannot produce, naming that framework', () => {
    boot();
    choose('fwSelect', 'webdriverio');
    const langs = options('langSelect');
    expect(langs.filter((o) => o.disabled).map((o) => o.text)).toEqual([
      'Python — n/a in WebdriverIO',
      'Java — n/a in WebdriverIO',
      'C# — n/a in WebdriverIO',
    ]);
    choose('fwSelect', 'cypress');
    expect(options('langSelect').find((o) => o.id === 'java').text).toBe('Java — n/a in Cypress');
  });

  it('generates Java / C# / WebdriverIO scripts and translates the cards', () => {
    boot();
    port({ type: 'ELEMENT_PICKED', windowId: WIN, data: PICK });
    record(click());
    choose('langSelect', 'java');
    expect(h.store.llLanguage).toBe('java');
    expect(script()).toContain('page.locator("#go").click();');
    // Not the engine's TypeScript string: Java needs codegen's translation.
    expect($('cardsContainer').querySelector('.code-txt').textContent).toBe(
      LLCodegen.locatorExpr({ kind: 'id', value: 'go' }, 'playwright', 'java')
    );
    choose('fwSelect', 'selenium');
    choose('langSelect', 'csharp');
    expect(script()).toContain('public class RecordedTest');
    choose('fwSelect', 'webdriverio');
    expect(h.store.llFramework).toBe('webdriverio');
    expect(script()).toContain("await $('#go').click();");
  });

  it('names downloads with the language extension, Java/C# after the declared class', () => {
    const java = 'import x;\n// The class name below matters\n@UsePlaywright\nclass CheckoutTest {\n}';
    expect(recorderFileName('playwright', 'java', java)).toBe('CheckoutTest.java');
    expect(recorderFileName('selenium', 'csharp', 'public sealed class Flow\n{\n}')).toBe('Flow.cs');
    expect(recorderFileName('selenium', 'java', '')).toBe('RecordedTest.java');
    expect(recorderFileName('webdriverio', 'typescript')).toBe('locatra-recorded.e2e.ts');
    expect(recorderFileName('webdriverio', 'javascript')).toBe('locatra-recorded.e2e.js');
    expect(recorderFileName('playwright', 'python')).toBe('test_recorded.py');
    expect(recorderFileName('selenium', 'klingon')).toBe('locatra-recorded.ts');
    expect(declaredClassName('// a class of its own\nexport class LoginPage {}')).toBe('LoginPage');
  });

  it('falls back to .txt for a language codegen gives a bad extension', () => {
    const orig = LLCodegen.fileExtension;
    try {
      LLCodegen.fileExtension = () => '../evil';
      expect(recorderFileName('selenium', 'klingon')).toBe('locatra-recorded.txt');
      LLCodegen.fileExtension = () => {
        throw new Error('x');
      };
      expect(recorderFileName('selenium', 'klingon')).toBe('locatra-recorded.txt');
    } finally {
      LLCodegen.fileExtension = orig;
    }
  });

  it('downloads the generated Java test under its class name', () => {
    URL.createObjectURL = vi.fn(() => 'blob:j');
    URL.revokeObjectURL = vi.fn();
    const names = [];
    vi.spyOn(window.HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      names.push(this.download);
    });
    h.store.llFramework = 'playwright';
    h.store.llLanguage = 'java';
    boot();
    record(click());
    $('downloadTestBtn').click();
    expect(names).toEqual(['RecordedTest.java']);
  });

  it('names Page Object downloads with the language extension', () => {
    URL.createObjectURL = vi.fn(() => 'blob:p');
    URL.revokeObjectURL = vi.fn();
    const names = [];
    vi.spyOn(window.HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      names.push(this.download);
    });
    h.store.llLanguage = 'csharp';
    boot();
    port({
      type: 'POM_RESULT',
      windowId: WIN,
      data: {
        pageUrl: 'https://shop.test/',
        elements: [{ name: 'go', kind: 'button', target: { kind: 'id', value: 'go' } }],
      },
    });
    $('pomClassName').value = 'Checkout';
    $('pomClassName').dispatchEvent(new window.Event('input'));
    $('pomDownloadBtn').click();
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^Checkout\w*\.cs$/);
  });

  it('starts on the default when the stored framework is not available in this build', () => {
    h.store.llFramework = 'robotframework';
    h.store.llLanguage = 'java';
    boot();
    expect($('fwSelect').value).toBe('playwright');
    expect($('langSelect').value).toBe('java');
  });

  it('highlights Java and C# keywords', () => {
    const out = hl('public class A { void run() { page.getByRole("x"); await Page.ClickAsync(); } }');
    expect(out).toContain('<span class="kw">public</span>');
    expect(out).toContain('<span class="kw">class</span>');
    expect(out).toContain('<span class="fn">ClickAsync</span>');
  });
});

// ── Live follow of the options page ──────────────────────────────────────────────
describe('framework / language changed in the options page', () => {
  it('follows at once: selects, cards, script and Page Object', () => {
    boot();
    port({ type: 'ELEMENT_PICKED', windowId: WIN, data: PICK });
    record(click());
    fireStorage({ llFramework: { newValue: 'selenium' }, llLanguage: { newValue: 'python' } });
    expect($('fwSelect').value).toBe('selenium');
    expect($('langSelect').value).toBe('python');
    expect(script()).toContain('driver.find_element');
    expect($('cardsContainer').querySelector('.code-txt').textContent).toContain('By.');
    // Following is not writing: the options page's value stays the source of truth.
    expect(h.store.llFramework).toBeUndefined();
  });

  it('picks the first valid language when the stored pair is impossible', () => {
    boot();
    fireStorage({ llFramework: { newValue: 'cypress' } });
    expect($('fwSelect').value).toBe('cypress');
    expect($('langSelect').value).toBe('typescript');
    choose('fwSelect', 'playwright');
    choose('langSelect', 'java');
    fireStorage({ llFramework: { newValue: 'webdriverio' } });
    expect($('langSelect').value).toBe('typescript');
  });

  it('a removed key means the default', () => {
    h.store.llFramework = 'selenium';
    boot();
    fireStorage({ llFramework: { newValue: undefined } });
    expect($('fwSelect').value).toBe('playwright');
  });

  it('ignores the echo of its own writes, even after a quick second switch', () => {
    boot();
    choose('fwSelect', 'selenium');
    choose('fwSelect', 'cypress');
    // The first write's onChanged arrives late.
    fireStorage({ llFramework: { newValue: 'selenium', oldValue: 'playwright' } });
    expect($('fwSelect').value).toBe('cypress');
    fireStorage({ llFramework: { newValue: 'cypress', oldValue: 'selenium' } });
    expect($('fwSelect').value).toBe('cypress');
    // Once consumed, the same value from the options page is honoured again.
    choose('fwSelect', 'playwright');
    fireStorage({ llFramework: { newValue: 'playwright' } });
    fireStorage({ llFramework: { newValue: 'selenium' } });
    expect($('fwSelect').value).toBe('selenium');
  });

  it('forgets echoes that never came', () => {
    boot();
    choose('fwSelect', 'selenium');
    choose('fwSelect', 'playwright');
    vi.advanceTimersByTime(3500);
    fireStorage({ llFramework: { newValue: 'selenium' } });
    expect($('fwSelect').value).toBe('selenium');
  });

  it('keeps a hand-edited script and its target, and says what changed', () => {
    boot();
    record(click());
    const editor = $('codePreview');
    editor.textContent = '// my own test';
    editor.dispatchEvent(new window.Event('input'));
    fireStorage({ llFramework: { newValue: 'selenium' } });
    expect($('fwSelect').value).toBe('playwright');
    expect(editor.textContent).toBe('// my own test');
    expect($('panelStatus').hidden).toBe(false);
    expect($('panelStatus').className).toContain('warn');
    expect($('panelStatus').textContent).toBe(
      'Settings changed the output to Selenium · TypeScript. Your edited script stays on Playwright · TypeScript — ' +
        'choose the new output above to regenerate it (that discards your edits).'
    );
    vi.advanceTimersByTime(10000);
    expect($('panelStatus').hidden).toBe(false); // a warning stays until the next action
  });

  it('ignores unknown frameworks, unrelated keys and other storage areas', () => {
    boot();
    fireStorage({ llFramework: { newValue: 'robotframework' } });
    expect($('fwSelect').value).toBe('playwright');
    fireStorage({ somethingElse: { newValue: 1 } });
    for (const fn of h.storageListeners) fn({ llFramework: { newValue: 'selenium' } }, 'sync');
    expect($('fwSelect').value).toBe('playwright');
    for (const fn of h.storageListeners) fn(null, 'local');
    fireStorage({ llLanguage: { newValue: 'javascript' } });
    expect($('langSelect').value).toBe('javascript');
  });

  it('waits for its first read of the stored output', () => {
    vm.runInThisContext('_outputReady = false;');
    fireStorage({ llFramework: { newValue: 'selenium' } });
    expect(vm.runInThisContext('outFramework')).toBe('playwright');
  });
});

// ── ⚙ All settings ──────────────────────────────────────────────────────────────
describe('All settings link', () => {
  it('both buttons open the options page', () => {
    boot();
    expect($('openOptionsBtn').textContent).toBe('⚙ All settings');
    expect($('openOptionsHeaderBtn').getAttribute('aria-label')).toBe('All settings');
    $('openOptionsBtn').click();
    $('openOptionsHeaderBtn').click();
    expect(h.options.calls).toBe(2);
    expect(h.tabsCreated).toEqual([]);
  });

  it('falls back to a tab when openOptionsPage fails, throws or is missing', async () => {
    boot();
    const expected = { url: 'chrome-extension://locatra/src/options.html' };
    h.options.mode = 'error';
    $('openOptionsBtn').click();
    expect(h.tabsCreated).toEqual([expected]);
    h.options.mode = 'throw';
    $('openOptionsBtn').click();
    expect(h.tabsCreated).toHaveLength(2);
    h.options.mode = 'promise-reject';
    $('openOptionsBtn').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.tabsCreated).toHaveLength(3);
    const orig = chrome.runtime.openOptionsPage;
    delete chrome.runtime.openOptionsPage;
    try {
      $('openOptionsBtn').click();
      expect(h.tabsCreated).toHaveLength(4);
      const tabs = chrome.tabs;
      delete chrome.tabs;
      try {
        $('openOptionsBtn').click();
        expect($('panelStatus').textContent).toBe("Couldn't open the settings page.");
      } finally {
        chrome.tabs = tabs;
      }
    } finally {
      chrome.runtime.openOptionsPage = orig;
    }
  });
});

// ── Settings writes ─────────────────────────────────────────────────────────────
describe('settings', () => {
  it("toggles write only the panel's fields and keep everything the options page stored", () => {
    h.store.llSettings = {
      testIdAttributes: ['data-qa'],
      secretNames: { password: 'PW', secret: 'S' },
      healthAutoCheck: false,
    };
    boot();
    $('settingAutoAssertions').click();
    expect(h.store.llSettings).toEqual({
      testIdAttributes: ['data-qa'],
      secretNames: { password: 'PW', secret: 'S' },
      healthAutoCheck: false,
      autoAssertions: false,
      stepScreenshots: true,
    });
  });

  it('every panel toggle changes only its own field (regression: toggles erased the options fields)', () => {
    const seeded = {
      autoAssertions: true,
      stepScreenshots: true,
      testIdAttributes: ['data-qa', 'data-e2e'],
      secretNames: { password: 'MY_PW', secret: 'MY_SECRET' },
      variables: true,
      healthAutoCheck: false,
      futureOption: { nested: [1, 2] },
    };
    h.store.llSettings = clone(seeded);
    boot();
    const flips = [
      ['settingAutoAssertions', 'autoAssertions'],
      ['settingStepScreenshots', 'stepScreenshots'],
      ['settingVariables', 'variables'],
      ['settingHealthAutoCheck', 'healthAutoCheck'],
    ];
    const expected = clone(seeded);
    for (const [id, field] of flips) {
      $(id).click();
      expected[field] = !expected[field];
      expect(h.store.llSettings, id).toEqual(expected);
    }
  });

  it('re-reads storage before writing so a concurrent options-page change survives', () => {
    boot();
    h.store.llSettings = { testIdAttributes: ['data-x'] }; // written meanwhile, no onChanged yet
    $('settingStepScreenshots').click();
    expect(h.store.llSettings.testIdAttributes).toEqual(['data-x']);
    expect(h.store.llSettings.stepScreenshots).toBe(false);
  });

  it('treats a non-object stored value as defaults', () => {
    h.store.llSettings = ['nope'];
    boot();
    expect($('settingAutoAssertions').checked).toBe(true);
    expect($('settingVariables').checked).toBe(true);
    expect($('settingHealthAutoCheck').checked).toBe(false);
    $('settingVariables').click();
    expect(h.store.llSettings).toEqual({ variables: false });
  });
});

// ── Worker relays ───────────────────────────────────────────────────────────────
describe('RECORDING_STATE relay', () => {
  it('updates the controls immediately (shortcut started, paused, asserting, stopped)', () => {
    boot();
    expect($('recBtnText').textContent).toBe('Start Recording');
    port({
      type: 'RECORDING_STATE',
      windowId: WIN,
      active: true,
      paused: false,
      assertMode: false,
      assertType: null,
    });
    expect($('recBtnText').textContent).toBe('Stop Recording');
    expect($('pauseRecordingBtn').style.display).toBe('');
    port({
      type: 'RECORDING_STATE',
      windowId: WIN,
      active: true,
      paused: true,
      assertMode: true,
      assertType: 'toHaveText',
    });
    expect($('resumeRecordingBtn').style.display).toBe('');
    expect($('pauseRecordingBtn').style.display).toBe('none');
    expect($('assertModeToggle').checked).toBe(true);
    expect($('assertTypeSelect').value).toBe('toHaveText');
    port({
      type: 'RECORDING_STATE',
      windowId: WIN,
      active: false,
      paused: false,
      assertMode: false,
      assertType: null,
    });
    expect($('recBtnText').textContent).toBe('Start Recording');
    expect($('recControls').style.display).toBe('none');
  });

  it("ignores another window's relay", () => {
    boot();
    port({ type: 'RECORDING_STATE', windowId: 99, active: true, paused: false });
    expect($('recBtnText').textContent).toBe('Start Recording');
  });

  it('a state query answered after the relay cannot undo it', () => {
    let calls = 0;
    h.responders.GET_RECORDING_STATE = () => (++calls === 1 ? { active: false } : DEFER);
    boot();
    vi.advanceTimersByTime(4000); // heartbeat asks again; that answer is held back
    expect(h.deferred).toHaveLength(1);
    port({ type: 'RECORDING_STATE', windowId: WIN, active: true, paused: false });
    h.deferred[0].cb({ active: false }); // stale
    expect($('recBtnText').textContent).toBe('Stop Recording');
  });
});

describe('ACTIVATION_FAILED relay', () => {
  it('turns inspect off and shows the error inline', () => {
    h.responders.GET_INSPECT_STATE = () => ({ active: true });
    boot();
    expect($('btnText').textContent).toBe('Stop Inspecting');
    port({
      type: 'ACTIVATION_FAILED',
      windowId: WIN,
      feature: 'inspect',
      error: "Locatra can't run on this page (chrome:// pages are protected).",
    });
    expect($('btnText').textContent).toBe('Start Inspecting');
    expect($('panelStatus').hidden).toBe(false);
    expect($('panelStatus').className).toContain('err');
    expect($('panelStatus').textContent).toBe(
      "Locatra can't run on this page (chrome:// pages are protected)."
    );
  });

  it('uses a default message, leaves inspect alone for other features, and ignores other windows', () => {
    h.responders.GET_INSPECT_STATE = () => ({ active: true });
    boot();
    port({ type: 'ACTIVATION_FAILED', windowId: 99, feature: 'inspect', error: 'x' });
    expect($('panelStatus').hidden).toBe(true);
    port({ type: 'ACTIVATION_FAILED', windowId: WIN, feature: 'recording', error: '' });
    expect($('panelStatus').textContent).toBe("Locatra can't run on this page.");
    expect($('btnText').textContent).toBe('Stop Inspecting');
    port({ type: 'ACTIVATION_FAILED', windowId: WIN, error: { html: '<b>' } });
    expect($('btnText').textContent).toBe('Start Inspecting');
    expect($('panelStatus').querySelector('b')).toBeNull();
  });

  it('renders the error as text', () => {
    boot();
    port({
      type: 'ACTIVATION_FAILED',
      windowId: WIN,
      feature: 'inspect',
      error: '<img src=x onerror=alert(1)>',
    });
    expect($('panelStatus').querySelector('img')).toBeNull();
    expect($('panelStatus').textContent).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('panel status kinds', () => {
  it('fades info, keeps errors and warnings', () => {
    boot();
    showPanelStatus('note', 'info');
    vi.advanceTimersByTime(6000);
    expect($('panelStatus').hidden).toBe(true);
    showPanelStatus('careful', 'warn');
    vi.advanceTimersByTime(6000);
    expect($('panelStatus').hidden).toBe(false);
  });
});
