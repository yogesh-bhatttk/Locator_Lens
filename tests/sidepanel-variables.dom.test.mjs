// @vitest-environment jsdom
//
// Side panel: the Record tab's "Test data" section (section C). The real
// sidepanel.js runs in this jsdom realm behind a scripted `chrome` stub, against the
// real sidepanel.html markup and the real codegen.js. Every test asserts what the
// user sees (rows, errors, the generated script) or what the panel stores / sends.

/* global LLCodegen */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WIN = 7;

const h = {
  store: {},
  sent: [],
  responders: {},
  portListener: null,
  storageListeners: [],
};

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function pick(keys) {
  if (keys == null) return clone(h.store);
  const list = Array.isArray(keys) ? keys : [keys];
  const out = {};
  for (const k of list) if (k in h.store) out[k] = clone(h.store[k]);
  return out;
}

let realApi = {};

beforeAll(async () => {
  await import('../src/codegen.js');
  realApi = {
    extractVariables: LLCodegen.extractVariables,
    applyVariables: LLCodegen.applyVariables,
    variablesJson: LLCodegen.variablesJson,
    validateVariableName: LLCodegen.validateVariableName,
  };
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
    llSettings = { autoAssertions: true, stepScreenshots: true, variables: true, healthAutoCheck: false };
    llSettingsRaw = {}; _settingsLoaded = false;
    testDataVars = []; _testDataDirty = false; _scriptInputsVersion = 0; _syncedInputsVersion = 0;
    if (_testDataRenderTimer) clearTimeout(_testDataRenderTimer); _testDataRenderTimer = null;
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
const sentOf = (type) => h.sent.filter((m) => m.type === type);
const record = (data) => h.portListener({ type: 'RECORDED_ACTION', windowId: WIN, data });
const persisted = () => h.store[`llRecorderState:${WIN}`];
const script = () => $('codePreview').textContent;
const tdRows = () => [...document.querySelectorAll('#testDataList .ll-td-row')];
const nameInput = (i) => document.querySelector(`.ll-td-name[data-var="${i}"]`);
const valueInput = (i) => document.querySelector(`.ll-td-value[data-var="${i}"]`);
const fireStorage = (changes) => {
  for (const fn of h.storageListeners) fn(changes, 'local');
};
function type(input, text) {
  input.focus();
  input.value = text;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}
/** Let the debounced re-render of timeline + script run. */
const settle = () => vi.advanceTimersByTime(300);

let seq = 0;
const fill = (label, value, over = {}) => ({
  action: 'fill',
  eventId: 'v' + ++seq,
  target: { kind: 'label', value: label },
  code: `page.getByLabel('${label}')`,
  value,
  ...over,
});
const select = (name, value, over = {}) => ({
  action: 'selectOption',
  eventId: 'v' + ++seq,
  target: { kind: 'role', role: 'combobox', name },
  code: `page.getByRole('combobox', { name: '${name}' })`,
  value,
  ...over,
});
const click = (over = {}) => ({
  action: 'click',
  eventId: 'v' + ++seq,
  target: { kind: 'role', role: 'button', name: 'Buy' },
  code: "page.getByRole('button', { name: 'Buy' })",
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  h.store = {};
  h.sent = [];
  h.responders = {
    GET_RECORDING_STATE: () => ({ active: false }),
    GET_ACTIVE_PAGE: () => ({ ok: true, tabId: 1, url: 'https://shop.test/', siteKey: 'https://shop.test/' }),
  };
  Object.assign(LLCodegen, realApi);
  resetPanelGlobals();
  window.confirm = vi.fn(() => true);
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(() => Promise.resolve()) },
    configurable: true,
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.assign(LLCodegen, realApi);
});

describe('Test data section', () => {
  it('stays hidden (and the script keeps literals) when codegen has no variables API', () => {
    delete LLCodegen.extractVariables;
    boot();
    record(fill('Email', 'ada@x.io'));
    expect($('testDataSection').hidden).toBe(true);
    expect($('testDataLabel').hidden).toBe(true);
    expect(script()).toContain("fill('ada@x.io')");
    expect(script()).not.toContain('testData');
  });

  it('shows an empty hint with disabled buttons before anything is typed', () => {
    boot();
    record(click());
    expect($('testDataSection').hidden).toBe(false);
    expect($('testDataEmpty').hidden).toBe(false);
    expect(tdRows()).toHaveLength(0);
    expect($('testDataCopyBtn').disabled).toBe(true);
    expect($('testDataDownloadBtn').disabled).toBe(true);
    expect($('testDataCount').textContent).toBe('');
  });

  it('lists one row per distinct value: merged repeats, no secrets, no suggestions', () => {
    boot();
    record(fill('Email', 'ada@x.io'));
    record(select('Country', 'Norway'));
    record(fill('Password', 'hunter2', { sensitive: true, secretName: 'LOCATRA_PASSWORD' }));
    record(fill('Email', 'ada@x.io'));
    record(fill('Coupon', 'SAVE10', { suggested: true }));
    expect(tdRows()).toHaveLength(2);
    expect(nameInput(0).value).toBe('email');
    expect(valueInput(0).value).toBe('ada@x.io');
    expect(nameInput(1).value).toBe('country');
    expect(valueInput(1).value).toBe('Norway');
    expect($('tdMeta-0').textContent).toBe('Typed text · used in steps 1, 4');
    expect($('tdMeta-1').textContent).toBe('Selected option · used in step 2');
    expect($('testDataCount').textContent).toBe('(2)');
    expect($('testDataEmpty').hidden).toBe(true);
    expect(document.body.innerHTML).not.toContain('hunter2');
    // Every field is labelled and tied to its error line.
    expect(nameInput(0).getAttribute('aria-label')).toBe('Name of test-data variable 1');
    expect(valueInput(1).getAttribute('aria-label')).toBe('Value of test-data variable 2');
    expect(nameInput(0).getAttribute('aria-describedby')).toBe('tdErr-0');
    expect(nameInput(0).closest('label').textContent).toContain('Name');
  });

  it('renders page-derived values as text, never markup', () => {
    boot();
    record(fill('Bio', '<img src=x onerror=alert(1)>'));
    expect(valueInput(0).value).toBe('<img src=x onerror=alert(1)>');
    expect(document.querySelector('#testDataList img')).toBeNull();
  });
});

describe('generated script', () => {
  it('declares the test data once and references it (Playwright TS)', () => {
    boot();
    record(fill('Email', 'ada@x.io'));
    record(select('Country', 'Norway'));
    const text = script();
    expect(text).toContain("const testData = {\n  email: 'ada@x.io',\n  country: 'Norway',\n};");
    expect(text).toContain("await page.getByLabel('Email').fill(testData.email);");
    expect(text).toContain('.selectOption(testData.country);');
    expect(text).not.toContain("fill('ada@x.io')");
  });

  it('uses the Python form in Python', () => {
    h.store.llFramework = 'playwright';
    h.store.llLanguage = 'python';
    boot();
    record(fill('First name', 'Ada'));
    expect(script()).toContain('TEST_DATA = {\n    "first_name": "Ada",\n}');
    expect(script()).toContain('.fill(TEST_DATA["first_name"])');
  });

  it('passes the variables to wrapScript with steps carrying varRef', () => {
    boot();
    const spy = vi.spyOn(LLCodegen, 'wrapScript');
    record(fill('Email', 'ada@x.io'));
    const call = spy.mock.calls.at(-1);
    expect(call[3].map((s) => s.varRef)).toEqual(['email']);
    expect(call[4]).toEqual({ variables: [expect.objectContaining({ name: 'email', value: 'ada@x.io' })] });
  });

  it('keeps literals with the toggle off, and the toggle writes llSettings without losing other fields', () => {
    h.store.llSettings = { testIdAttributes: ['data-qa'], secretNames: { password: 'PW', secret: 'S' } };
    boot();
    record(fill('Email', 'ada@x.io'));
    expect($('settingVariables').checked).toBe(true);
    $('settingVariables').click();
    expect(h.store.llSettings).toEqual({
      testIdAttributes: ['data-qa'],
      secretNames: { password: 'PW', secret: 'S' },
      variables: false,
    });
    expect(script()).toContain("fill('ada@x.io')");
    expect(script()).not.toContain('testData');
    // Rows stay editable: values still drive replay.
    expect(tdRows()).toHaveLength(1);
    $('settingVariables').click();
    expect(h.store.llSettings.variables).toBe(true);
    expect(script()).toContain('fill(testData.email)');
  });

  it('starts with the stored setting and follows changes from the options page', () => {
    h.store.llSettings = { variables: false };
    boot();
    record(fill('Email', 'ada@x.io'));
    expect($('settingVariables').checked).toBe(false);
    expect(script()).not.toContain('testData');
    fireStorage({ llSettings: { newValue: { variables: true } } });
    expect($('settingVariables').checked).toBe(true);
    expect(script()).toContain('fill(testData.email)');
  });
});

describe('editing names', () => {
  it('renames the variable on every one of its steps, in the script and in storage', () => {
    boot();
    record(fill('Email', 'ada@x.io'));
    record(fill('Email', 'ada@x.io'));
    type(nameInput(0), 'userEmail');
    expect(nameInput(0).getAttribute('aria-invalid')).toBe('false');
    expect(recordedActions.map((s) => s.varName)).toEqual(['userEmail', 'userEmail']);
    settle();
    expect(script()).toContain('userEmail: ');
    expect(script().match(/fill\(testData\.userEmail\)/g)).toHaveLength(2);
    expect(persisted().actions.map((s) => s.varName)).toEqual(['userEmail', 'userEmail']);
    // The row is the same element, still focused, while typing goes on.
    expect(document.activeElement).toBe(nameInput(0));
  });

  it('rejects invalid, reserved and clashing names without touching the steps', () => {
    boot();
    record(fill('Email', 'ada@x.io'));
    record(fill('First name', 'Ada'));
    const cases = [
      ['', 'Enter a name.'],
      ['1st', 'Use letters, digits and _ only'],
      ['class', 'reserved word'],
      ['firstName', 'already named "firstName"'],
      ['first_name', 'both are "first_name" in Python'],
    ];
    for (const [value, msg] of cases) {
      type(nameInput(0), value);
      expect($('tdErr-0').hidden, value).toBe(false);
      expect($('tdErr-0').textContent, value).toContain(msg);
      expect(nameInput(0).getAttribute('aria-invalid')).toBe('true');
    }
    expect(recordedActions[0].varName).toBeUndefined();
    settle();
    expect(script()).toContain('fill(testData.email)');
    // Back to a good name clears the error.
    type(nameInput(0), 'contact');
    expect($('tdErr-0').hidden).toBe(true);
    expect(recordedActions[0].varName).toBe('contact');
  });

  it('drops an invalid draft when focus leaves the list, and says so', () => {
    boot();
    record(fill('Email', 'ada@x.io'));
    type(nameInput(0), 'not valid');
    nameInput(0).blur();
    vi.advanceTimersByTime(1);
    expect(nameInput(0).value).toBe('email');
    expect(nameInput(0).getAttribute('aria-invalid')).toBe('false');
    expect($('testDataStatus').textContent).toBe('Kept the name "email" — the one you typed wasn\'t valid.');
    vi.advanceTimersByTime(5000);
    expect($('testDataStatus').hidden).toBe(true);
  });

  it('falls back to its own checks when codegen has no validator', () => {
    delete LLCodegen.validateVariableName;
    boot();
    record(fill('Email', 'ada@x.io'));
    record(fill('Phone', '555'));
    type(nameInput(0), '');
    expect($('tdErr-0').textContent).toBe('Enter a name.');
    type(nameInput(0), 'a b');
    expect($('tdErr-0').textContent).toContain('letters, digits and _');
    type(nameInput(0), 'x'.repeat(65));
    expect($('tdErr-0').textContent).toContain('letters, digits and _');
    type(nameInput(0), 'phone');
    expect($('tdErr-0').textContent).toBe('Another variable is already named "phone".');
    type(nameInput(0), 'mail');
    expect($('tdErr-0').hidden).toBe(true);
    expect(recordedActions[0].varName).toBe('mail');
  });

  it('survives a validator that throws', () => {
    LLCodegen.validateVariableName = () => {
      throw new Error('boom');
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    boot();
    record(fill('Email', 'ada@x.io'));
    type(nameInput(0), 'mail');
    expect(recordedActions[0].varName).toBe('mail');
  });
});

describe('editing values', () => {
  it('rewrites the value of every step of the variable; timeline, script, storage and replay follow', () => {
    h.responders.REPLAY_START = () => ({ ok: true, runId: 1 });
    boot();
    record(fill('Email', 'ada@x.io'));
    record(click());
    record(fill('Email', 'ada@x.io'));
    type(valueInput(0), 'grace@x.io');
    expect(recordedActions.filter((s) => s.action === 'fill').map((s) => s.value)).toEqual([
      'grace@x.io',
      'grace@x.io',
    ]);
    settle();
    expect(script()).toContain("email: 'grace@x.io',");
    expect(script()).not.toContain('ada@x.io');
    expect(document.querySelector('#recorderTimeline .ll-rec-step-value').textContent).toBe(
      'value: "grace@x.io"'
    );
    expect(persisted().actions[0].value).toBe('grace@x.io');
    $('replayBtn').click();
    const [msg] = sentOf('REPLAY_START');
    expect(msg.steps.filter((s) => s.action === 'fill').map((s) => s.value)).toEqual([
      'grace@x.io',
      'grace@x.io',
    ]);
  });

  it('keeps the focused field while new steps arrive, then shows them once focus leaves', () => {
    boot();
    record(fill('Email', 'ada@x.io'));
    const field = valueInput(0);
    type(field, 'ada@y.io');
    settle();
    // A same-shaped refresh happens in place…
    expect(valueInput(0)).toBe(field);
    // …a new variable does not rebuild under the caret.
    record(fill('Phone', '555'));
    expect(valueInput(0)).toBe(field);
    expect(document.activeElement).toBe(field);
    expect(tdRows()).toHaveLength(1);
    expect($('testDataCount').textContent).toBe('(2)');
    field.blur();
    vi.advanceTimersByTime(1);
    expect(tdRows()).toHaveLength(2);
    expect(nameInput(1).value).toBe('phone');
  });

  it('moving between fields of the list does not rebuild it', () => {
    boot();
    record(fill('Email', 'ada@x.io'));
    record(fill('Phone', '555'));
    const first = valueInput(0);
    type(first, 'b@x.io');
    const next = nameInput(1);
    first.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true, relatedTarget: next }));
    next.focus();
    vi.advanceTimersByTime(1);
    expect(valueInput(0)).toBe(first);
  });

  it('updates other rows in place when they still line up', () => {
    boot();
    record(fill('Email', 'ada@x.io'));
    record(fill('Phone', '555'));
    valueInput(1).focus();
    // A change elsewhere (here: a direct step edit) refreshes the unfocused row.
    recordedActions[0].value = 'zed@x.io';
    record(click());
    expect(valueInput(0).value).toBe('zed@x.io');
  });

  it('flags an edited script as behind, and Sync brings the new values in', () => {
    boot();
    record(fill('Email', 'ada@x.io'));
    const editor = $('codePreview');
    editor.textContent = script() + '\n// my note';
    editor.dispatchEvent(new window.Event('input'));
    expect($('scriptStaleNotice').hidden).toBe(true);
    type(valueInput(0), 'grace@x.io');
    settle();
    expect($('scriptStaleNotice').hidden).toBe(false);
    expect($('scriptStaleText').textContent).toBe(
      'Test data or variable settings changed since you edited the script'
    );
    expect(editor.textContent).toContain('// my note'); // never overwritten
    $('scriptStaleSyncBtn').click();
    expect(script()).toContain("email: 'grace@x.io'");
    expect($('scriptStaleNotice').hidden).toBe(true);
  });

  it('flags an edited script when the variables setting changes elsewhere', () => {
    boot();
    record(fill('Email', 'ada@x.io'));
    const editor = $('codePreview');
    editor.textContent = script() + '\n// mine';
    editor.dispatchEvent(new window.Event('input'));
    fireStorage({ llSettings: { newValue: { variables: false } } });
    expect($('scriptStaleNotice').hidden).toBe(false);
    expect(editor.textContent).toContain('// mine');
  });
});

describe('persistence', () => {
  it('stores varName but never varRef (references are derived per script)', () => {
    h.store[`llRecorderState:${WIN}`] = {
      actions: [fill('Email', 'ada@x.io', { varRef: 'stale' })],
      seenKeys: [],
      updatedAt: Date.now(),
    };
    boot();
    record(fill('Phone', '555', { varRef: 'alsoStale' }));
    type(nameInput(0), 'mail');
    vi.advanceTimersByTime(500);
    expect(persisted().actions.map((s) => s.varName)).toEqual(['mail', undefined]);
    expect(persisted().actions.some((s) => 'varRef' in s)).toBe(false);
    expect(script()).toContain('fill(testData.mail)');
  });

  it('restores renamed variables with the timeline', () => {
    h.store[`llRecorderState:${WIN}`] = {
      actions: [fill('Email', 'ada@x.io', { varName: 'loginEmail' })],
      seenKeys: [],
      updatedAt: Date.now(),
    };
    boot();
    expect(nameInput(0).value).toBe('loginEmail');
    expect(script()).toContain('fill(testData.loginEmail)');
  });

  it('restores an edited script as edited without a drift notice', () => {
    const steps = [fill('Email', 'ada@x.io')];
    h.store[`llRecorderState:${WIN}`] = {
      actions: steps,
      seenKeys: [],
      codePreview: '// hand edited',
      codeEdited: true,
      codeFramework: 'playwright',
      codeLanguage: 'typescript',
      updatedAt: Date.now(),
    };
    h.store.llSettings = { variables: false };
    boot();
    expect(script()).toBe('// hand edited');
    expect($('scriptStaleNotice').hidden).toBe(true);
  });
});

describe('copy and download', () => {
  it('copies the test data as JSON', async () => {
    boot();
    record(fill('Email', 'ada@x.io'));
    record(select('Country', 'Norway'));
    $('testDataCopyBtn').click();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      '{\n  "email": "ada@x.io",\n  "country": "Norway"\n}\n'
    );
    await Promise.resolve();
    expect($('testDataCopyBtn').textContent).toBe('✓ Copied');
  });

  it('downloads test-data.json with the same content', async () => {
    const blobs = [];
    URL.createObjectURL = vi.fn((b) => {
      blobs.push(b);
      return 'blob:td';
    });
    URL.revokeObjectURL = vi.fn();
    const names = [];
    vi.spyOn(window.HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      names.push(this.download);
    });
    boot();
    record(fill('Email', 'ada@x.io'));
    $('testDataDownloadBtn').click();
    expect(names).toEqual(['test-data.json']);
    expect(blobs[0].type).toBe('application/json;charset=utf-8');
    expect(await blobs[0].text()).toBe('{\n  "email": "ada@x.io"\n}\n');
    vi.advanceTimersByTime(2000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:td');
  });

  it('explains itself when there is nothing to copy or download', () => {
    boot();
    record(click());
    // Buttons are disabled; a programmatic click still answers sensibly.
    $('testDataCopyBtn').disabled = false;
    $('testDataCopyBtn').click();
    expect($('testDataStatus').textContent).toContain('No test data yet');
    $('testDataDownloadBtn').disabled = false;
    $('testDataDownloadBtn').click();
    expect($('testDataStatus').textContent).toContain('No test data yet');
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
});

describe('codegen failures', () => {
  it('keeps literals and an empty list when extraction throws', () => {
    LLCodegen.extractVariables = () => {
      throw new Error('boom');
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    boot();
    record(fill('Email', 'ada@x.io'));
    expect(tdRows()).toHaveLength(0);
    expect(script()).toContain("fill('ada@x.io')");
  });

  it('keeps literals when applyVariables throws or returns something unusable', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    LLCodegen.applyVariables = () => {
      throw new Error('boom');
    };
    boot();
    record(fill('Email', 'ada@x.io'));
    expect(script()).toContain("fill('ada@x.io')");
    // The rows still find their steps by eventId.
    type(valueInput(0), 'x@y.z');
    expect(recordedActions[0].value).toBe('x@y.z');
    LLCodegen.applyVariables = () => 'nope';
    record(fill('Phone', '1'));
    settle();
    expect(script()).toContain("fill('x@y.z')");
  });

  it('copies nothing when variablesJson throws', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    LLCodegen.variablesJson = () => {
      throw new Error('boom');
    };
    boot();
    record(fill('Email', 'ada@x.io'));
    $('testDataCopyBtn').click();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect($('testDataStatus').textContent).toContain('No test data yet');
  });

  it('ignores malformed variables from codegen', () => {
    LLCodegen.extractVariables = () => [null, { name: '' }, { name: 'ok', value: null, kind: 'select' }];
    LLCodegen.applyVariables = (steps) => steps.map((s) => ({ ...s }));
    boot();
    record(fill('Email', 'ada@x.io'));
    expect(tdRows()).toHaveLength(1);
    expect(valueInput(0).value).toBe('');
    expect($('tdMeta-0').textContent).toBe('Selected option');
  });
});
