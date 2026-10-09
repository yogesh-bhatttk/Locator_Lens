// @vitest-environment jsdom
//
// The options page, part 2: Data (export, import with validation — hostile files
// included —, reset, the three clears and their counts) and Keyboard shortcuts
// (Chrome/Edge: the browser's shortcuts page; Firefox: inline editing through
// browser.commands.update/reset).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { $, flush, loadCodegen, openOptions, press, setValue, status } from './options-harness.mjs';

beforeAll(() => loadCodegen());

let blobs;
let clicks;
let confirmAnswer;

beforeEach(() => {
  blobs = [];
  clicks = [];
  confirmAnswer = true;
  URL.createObjectURL = (b) => {
    blobs.push(b);
    return `blob:locatra/${blobs.length}`;
  };
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(window.HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
    clicks.push({ href: this.href, download: this.download, attached: this.isConnected });
  });
  window.confirm = vi.fn(() => confirmAnswer);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete globalThis.browser;
});

const readBlob = (b) =>
  new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsText(b);
  });

async function importText(text, name = 'settings.json') {
  const input = $('importInput');
  const file = new File([text], name, { type: 'application/json' });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush(10);
}

const importErrors = () => [...$('importErrors').children].map((li) => li.textContent);

// ── Export ──────────────────────────────────────────────────────────────────

describe('Data — export', () => {
  it('downloads every setting as locatra-settings.json', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const opened = openOptions({
      storage: {
        llSettings: {
          autoAssertions: false,
          testIdAttributes: ['data-hook'],
          secretNames: { password: 'PW' },
          healthAutoCheck: true,
          futureThing: 1,
        },
        llFramework: 'selenium',
        llLanguage: 'python',
      },
    });
    await vi.advanceTimersByTimeAsync(50);
    await opened;
    $('exportBtn').click();
    expect(clicks).toEqual([{ href: 'blob:locatra/1', download: 'locatra-settings.json', attached: true }]);
    expect(blobs[0].type).toBe('application/json');
    const json = JSON.parse(await readBlob(blobs[0]));
    expect(json).toEqual({
      format: 'locatra-settings',
      version: 1,
      exportedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      extensionVersion: '9.8.7',
      llSettings: {
        autoAssertions: false,
        stepScreenshots: true,
        testIdAttributes: ['data-hook'],
        secretNames: { password: 'PW', secret: 'LOCATRA_SECRET' },
        variables: true,
        healthAutoCheck: true,
      },
      llFramework: 'selenium',
      llLanguage: 'python',
    });
    expect(status()).toBe('Settings exported');
    expect(document.querySelector('a[download]')).toBeNull(); // the temporary link is gone
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:locatra/1');
  });

  it('reports a failed export', async () => {
    await openOptions();
    URL.createObjectURL = () => {
      throw new Error('no blobs here');
    };
    $('exportBtn').click();
    expect(status()).toBe('Could not export: no blobs here');
  });

  it('an export imports back to the same settings', async () => {
    const storage = {
      llSettings: {
        variables: false,
        testIdAttributes: ['data-a', 'data-b'],
        secretNames: { secret: 'OTP' },
      },
      llFramework: 'cypress',
      llLanguage: 'javascript',
    };
    await openOptions({ storage });
    $('exportBtn').click();
    const text = await readBlob(blobs[0]);
    const { state } = await openOptions();
    await importText(text);
    expect(state.store.llSettings).toEqual(JSON.parse(text).llSettings);
    expect(state.store).toMatchObject({ llFramework: 'cypress', llLanguage: 'javascript' });
  });
});

// ── Import ──────────────────────────────────────────────────────────────────

describe('Data — import', () => {
  it('the Import button opens the file picker', async () => {
    await openOptions();
    const pick = vi.spyOn($('importInput'), 'click').mockImplementation(() => {});
    $('importBtn').click();
    expect(pick).toHaveBeenCalled();
  });

  it('applies a valid file: writes settings and output, drops the legacy key, re-renders', async () => {
    const { state } = await openOptions({
      storage: { llSettings: { futureThing: 1 }, llFramework: 'playwright', llLanguage: 'typescript' },
    });
    state.store.customAttributes = ['data-old']; // e.g. written by an old version meanwhile
    await importText(
      JSON.stringify({
        format: 'locatra-settings',
        version: 1,
        llSettings: {
          autoAssertions: false,
          stepScreenshots: false,
          variables: false,
          healthAutoCheck: true,
          testIdAttributes: ['Data-QA-Id', 'data-qa-id', 'data-hook'],
          secretNames: { password: 'APP_PW', secret: 'APP_SECRET' },
        },
        llFramework: 'selenium',
        llLanguage: 'javascript',
      })
    );
    expect(state.store.llSettings).toEqual({
      autoAssertions: false,
      stepScreenshots: false,
      testIdAttributes: ['data-qa-id', 'data-hook'],
      secretNames: { password: 'APP_PW', secret: 'APP_SECRET' },
      variables: false,
      healthAutoCheck: true,
    });
    expect(state.store).toMatchObject({ llFramework: 'selenium', llLanguage: 'javascript' });
    expect(state.store.customAttributes).toBeUndefined();
    expect(status()).toBe('Settings imported');
    expect($('setHealthAutoCheck').checked).toBe(true);
    expect($('outFramework').value).toBe('selenium');
    expect($('secretPassword').value).toBe('APP_PW');
    expect([...$('testAttrList').querySelectorAll('code')].map((c) => c.textContent)).toEqual([
      'data-qa-id',
      'data-hook',
    ]);
    expect($('importErrorBox').hidden).toBe(true);
    expect($('importInput').value).toBe('');
  });

  it('accepts a bare llSettings object; missing fields become defaults, output stays as it was', async () => {
    const { state } = await openOptions({
      storage: { llSettings: { autoAssertions: false, healthAutoCheck: true }, llFramework: 'cypress' },
    });
    await importText('{"variables": false}');
    expect(state.store.llSettings).toMatchObject({
      autoAssertions: true,
      healthAutoCheck: false,
      variables: false,
    });
    expect(state.store.llFramework).toBe('cypress');
  });

  it('a language without a framework is checked against the default framework', async () => {
    const { state } = await openOptions({ storage: { llFramework: 'cypress', llLanguage: 'typescript' } });
    await importText('{"llLanguage": "python"}');
    expect(state.store).toMatchObject({ llFramework: 'playwright', llLanguage: 'python' });
  });

  it('a framework alone picks its default language', async () => {
    const { state } = await openOptions();
    await importText('{"llFramework": "cypress"}');
    expect(state.store).toMatchObject({ llFramework: 'cypress', llLanguage: 'typescript' });
  });

  const rejects = [
    ['not JSON', '{oops', ['The file is not valid JSON.']],
    ['an array', '[1,2]', ['The file must contain a JSON object.']],
    ['null', 'null', ['The file must contain a JSON object.']],
    ['a string', '"llSettings"', ['The file must contain a JSON object.']],
    [
      'another format',
      '{"format":"other-tool","llSettings":{}}',
      ['Unknown format “other-tool” — expected “locatra-settings”.'],
    ],
    [
      'a newer version',
      '{"version":2,"llSettings":{}}',
      ['Unsupported version “2” — this Locatra reads version 1.'],
    ],
    [
      'a string version',
      '{"version":"1","llSettings":{}}',
      ['Unsupported version “1” — this Locatra reads version 1.'],
    ],
    [
      'version 0',
      '{"version":0,"llSettings":{}}',
      ['Unsupported version “0” — this Locatra reads version 1.'],
    ],
    ['llSettings not an object', '{"llSettings":[]}', ['“llSettings” must be an object.']],
    ['nothing recognisable', '{"theme":"dark","foo":1}', ['This file does not contain Locatra settings.']],
    [
      'a string boolean',
      '{"autoAssertions":"false"}',
      ['“autoAssertions” must be true or false, not “false”.'],
    ],
    ['a numeric boolean', '{"healthAutoCheck":1}', ['“healthAutoCheck” must be true or false, not “1”.']],
    [
      'attributes not a list',
      '{"testIdAttributes":"data-qa"}',
      ['“testIdAttributes” must be a list of attribute names.'],
    ],
    [
      'too many attributes',
      JSON.stringify({ testIdAttributes: Array.from({ length: 21 }, (_, i) => `data-a${i}`) }),
      ['“testIdAttributes” has 21 entries — at most 20 are allowed.'],
    ],
    ['a non-string attribute', '{"testIdAttributes":[42]}', ['“42” is not an attribute name.']],
    [
      'an own attribute',
      '{"testIdAttributes":["data-ll-x"]}',
      ['Locatra’s own data-ll-* / data-locatra-* attributes cannot be used.'],
    ],
    ['secretNames not an object', '{"secretNames":"PW"}', ['“secretNames” must be an object.']],
    [
      'an invalid secret name',
      '{"secretNames":{"password":"has space"}}',
      ['secretNames.password “has space”: Use letters, digits and “_”, not starting with a digit.'],
    ],
    [
      'identical secret names',
      '{"secretNames":{"password":"SAME","secret":"SAME"}}',
      ['The two secret variable names must differ.'],
    ],
    ['an unknown framework', '{"llFramework":"puppeteer"}', ['Unknown framework “puppeteer”.']],
    ['a non-string framework', '{"llFramework":{"id":"x"}}', ['Unknown framework “{"id":"x"}”.']],
    [
      'an impossible pair',
      '{"llFramework":"cypress","llLanguage":"python"}',
      ['“python” is not a language for cypress.'],
    ],
  ];

  it.each(rejects)('rejects %s — nothing is written', async (_, text, errors) => {
    const { state } = await openOptions({ storage: { llSettings: { variables: false } } });
    await importText(text);
    expect(importErrors()).toEqual(errors);
    expect($('importErrorBox').hidden).toBe(false);
    expect($('importErrorTitle').textContent).toBe('Nothing was imported:');
    expect(status()).toBe('Import failed');
    expect($('saveStatus').dataset.tone).toBe('error');
    expect(state.ops).toEqual([]);
    expect(state.store.llSettings).toEqual({ variables: false });
    expect($('setVariables').checked).toBe(false);
  });

  it('collects every problem, listing at most eight', async () => {
    await openOptions();
    await importText(
      JSON.stringify({
        autoAssertions: 'x',
        stepScreenshots: 'x',
        variables: 'x',
        healthAutoCheck: 'x',
        testIdAttributes: ['bad name', 'also bad', '1x', 7, '<b>'],
      })
    );
    const errs = importErrors();
    expect(errs).toHaveLength(9);
    expect(errs[8]).toBe('…and 1 more.');
  });

  it('hostile values are shown as text, clipped, and never become markup', async () => {
    await openOptions();
    await importText(
      JSON.stringify({
        testIdAttributes: ['<img src=x onerror="window.__pwned=1">'],
        secretNames: { password: '<script>window.__pwned=1</script>' + 'A'.repeat(5000) },
      })
    );
    expect(document.querySelector('#importErrors img, #importErrors script')).toBeNull();
    expect(window.__pwned).toBeUndefined();
    const [attrErr, secretErr] = importErrors();
    expect(attrErr).toContain('<img src=x');
    expect(secretErr.length).toBeLessThan(200);
    expect(secretErr).toContain('…”');
  });

  it('__proto__ keys are inert: no prototype pollution, no smuggled settings', async () => {
    const { state } = await openOptions();
    await importText(
      '{"__proto__":{"polluted":true,"autoAssertions":false},' +
        '"llSettings":{"__proto__":{"healthAutoCheck":true},"constructor":{"prototype":{"polluted":true}},"variables":false}}'
    );
    expect({}.polluted).toBeUndefined();
    expect(Object.prototype.polluted).toBeUndefined();
    expect(state.store.llSettings).toEqual({
      autoAssertions: true,
      stepScreenshots: true,
      testIdAttributes: [],
      secretNames: { password: 'LOCATRA_PASSWORD', secret: 'LOCATRA_SECRET' },
      variables: false,
      healthAutoCheck: false,
    });
  });

  it('refuses a file over 256 KB without reading it', async () => {
    const { state } = await openOptions();
    const read = vi.spyOn(window.FileReader.prototype, 'readAsText');
    await importText(JSON.stringify({ variables: false, pad: 'x'.repeat(300 * 1024) }));
    expect(read).not.toHaveBeenCalled();
    expect(importErrors()[0]).toMatch(/^The file is too large \(\d+ KB\)/);
    expect(state.ops).toEqual([]);
  });

  it('reports a file that cannot be read', async () => {
    await openOptions();
    vi.spyOn(window.FileReader.prototype, 'readAsText').mockImplementation(function () {
      setTimeout(() => this.onerror && this.onerror(), 0);
    });
    await importText('{}');
    expect(importErrors()).toEqual(['Could not read the file.']);
    expect(status()).toBe('Import failed');
  });

  it('a change event without a file does nothing; a second attempt clears old errors', async () => {
    const { state } = await openOptions();
    const input = $('importInput');
    Object.defineProperty(input, 'files', { configurable: true, value: [] });
    input.dispatchEvent(new window.Event('change'));
    await flush();
    expect(state.ops).toEqual([]);
    await importText('nope');
    expect($('importErrorBox').hidden).toBe(false);
    await importText('{"variables":true}');
    expect($('importErrorBox').hidden).toBe(true);
  });

  it('a storage failure while importing is reported', async () => {
    const { state } = await openOptions();
    state.failNext.set = 'quota';
    await importText('{"variables":false}');
    expect(status()).toBe('Could not import: quota');
  });

  it('parseImport is exposed for direct checks', async () => {
    const { seam } = await openOptions();
    expect(seam.parseImport('{"variables":false}')).toMatchObject({ ok: true, framework: 'playwright' });
    expect(seam.parseImport('{}')).toEqual({
      ok: false,
      errors: ['This file does not contain Locatra settings.'],
    });
  });
});

// ── Reset ───────────────────────────────────────────────────────────────────

describe('Data — reset to defaults', () => {
  const storage = {
    llSettings: {
      autoAssertions: false,
      testIdAttributes: ['data-x'],
      secretNames: { password: 'PW' },
      extra: 1,
    },
    llFramework: 'cypress',
    llLanguage: 'javascript',
    customAttributes: ['data-legacy'],
    llWatched: { version: 1, sites: { a: [{ id: 1 }] } },
  };

  it('asks first; cancelling changes nothing', async () => {
    const { state } = await openOptions({ storage });
    state.ops.length = 0;
    confirmAnswer = false;
    $('resetBtn').click();
    await flush();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Reset every Locatra setting'));
    expect(state.ops).toEqual([]);
  });

  it('writes the defaults, removes the legacy key, keeps recordings and watched locators', async () => {
    const { state } = await openOptions({ storage });
    state.store.customAttributes = ['data-legacy']; // re-written after migration
    await importText('nope'); // leaves an import error on screen
    $('resetBtn').click();
    await flush();
    expect(state.store.llSettings).toEqual({
      autoAssertions: true,
      stepScreenshots: true,
      testIdAttributes: [],
      secretNames: { password: 'LOCATRA_PASSWORD', secret: 'LOCATRA_SECRET' },
      variables: true,
      healthAutoCheck: false,
    });
    expect(state.store).toMatchObject({ llFramework: 'playwright', llLanguage: 'typescript' });
    expect(state.store.customAttributes).toBeUndefined();
    expect(state.store.llWatched).toEqual(storage.llWatched);
    expect(status()).toBe('Settings reset to defaults');
    expect($('setAutoAssertions').checked).toBe(true);
    expect($('secretPassword').value).toBe('LOCATRA_PASSWORD');
    expect($('outFramework').value).toBe('playwright');
    expect($('testAttrEmpty').hidden).toBe(false);
    expect($('importErrorBox').hidden).toBe(true);
  });

  it('a failed reset is reported', async () => {
    const { state } = await openOptions();
    state.failNext.set = 'nope';
    $('resetBtn').click();
    await flush();
    expect(status()).toBe('Could not reset: nope');
  });

  it('a confirm() that throws counts as “no”', async () => {
    const { state } = await openOptions();
    window.confirm = () => {
      throw new Error('dialogs blocked');
    };
    $('resetBtn').click();
    await flush();
    expect(state.ops).toEqual([]);
  });
});

// ── Clears ──────────────────────────────────────────────────────────────────

describe('Data — clearing stored data', () => {
  const storage = {
    llRecorderState: { actions: [] },
    'llRecorderState:1': { actions: [] },
    'llRecorderState:22': { actions: [] },
    llRecorderStateArchive: 'not a timeline key',
    llWatched: {
      version: 1,
      sites: { 'https://a.test/': [{ id: 1 }, { id: 2 }], 'https://b.test/x': [{ id: 3 }], bad: 'x' },
    },
    llSettings: { variables: false },
  };

  it('shows how much is stored', async () => {
    await openOptions({ storage });
    expect($('timelineCount').textContent).toBe('3 saved timelines, one per browser window.');
    expect($('watchedCount').textContent).toBe('3 watched locators.');
    expect($('clearTimelinesBtn').disabled).toBe(false);
    expect($('clearWatchedBtn').disabled).toBe(false);
  });

  it('singular counts, and nothing stored disables the buttons', async () => {
    await openOptions({ storage: { llRecorderState: {}, llWatched: { version: 1, sites: { a: [{}] } } } });
    expect($('timelineCount').textContent).toBe('1 saved timeline, one per browser window.');
    expect($('watchedCount').textContent).toBe('1 watched locator.');
    await openOptions({ storage: { llWatched: 'corrupt' } });
    expect($('timelineCount').textContent).toBe('No saved timelines.');
    expect($('watchedCount').textContent).toBe('No watched locators.');
    expect($('clearTimelinesBtn').disabled).toBe(true);
    expect($('clearWatchedBtn').disabled).toBe(true);
  });

  it('Clear timelines removes exactly the llRecorderState keys', async () => {
    const { state } = await openOptions({ storage });
    $('clearTimelinesBtn').click();
    await flush();
    expect(window.confirm).toHaveBeenCalled();
    expect(state.ops).toEqual(['remove:llRecorderState,llRecorderState:1,llRecorderState:22']);
    expect(state.store.llRecorderStateArchive).toBe('not a timeline key');
    expect(state.store.llWatched).toBeDefined();
    expect(status()).toBe('Cleared 3 timelines');
    expect($('timelineCount').textContent).toBe('No saved timelines.');
    expect($('clearTimelinesBtn').disabled).toBe(true);
  });

  it('Clear timelines with none left says so', async () => {
    const { state } = await openOptions({ storage: { llRecorderState: {} } });
    delete state.store.llRecorderState; // cleared by another page meanwhile
    $('clearTimelinesBtn').click();
    await flush();
    expect(state.ops).toEqual([]);
    expect(status()).toBe('No timelines to clear');
    expect($('saveStatus').dataset.tone).toBe('info');
  });

  it('Clear timelines reports a storage failure', async () => {
    const { state } = await openOptions({ storage });
    state.failNext.get = 'gone';
    $('clearTimelinesBtn').click();
    await flush();
    expect(status()).toBe('Could not clear timelines: gone');
  });

  it('Clear watched locators removes llWatched only', async () => {
    const { state } = await openOptions({ storage });
    $('clearWatchedBtn').click();
    await flush();
    expect(state.ops).toEqual(['remove:llWatched']);
    expect(status()).toBe('Watched locators cleared');
    expect($('watchedCount').textContent).toBe('No watched locators.');
    expect(state.store['llRecorderState:1']).toBeDefined();
  });

  it('Clear watched locators reports a storage failure', async () => {
    const { state } = await openOptions({ storage });
    state.failNext.remove = 'locked';
    $('clearWatchedBtn').click();
    await flush();
    expect(status()).toBe('Could not clear watched locators: locked');
  });

  it('Clear screenshots asks the worker (THUMBS_CLEAR_ALL)', async () => {
    const { state } = await openOptions();
    $('clearShotsBtn').click();
    await flush();
    expect(state.sent).toEqual([{ type: 'THUMBS_CLEAR_ALL' }]);
    expect(status()).toBe('Step screenshots cleared');
  });

  it.each([
    [{ ok: false, error: 'db blocked' }, 'Could not clear screenshots: db blocked'],
    [{ ok: false }, 'Could not clear screenshots'],
    [undefined, 'Could not clear screenshots'],
  ])('Clear screenshots reports a worker answer of %j', async (answer, message) => {
    await openOptions({ thumbsResponse: answer });
    $('clearShotsBtn').click();
    await flush();
    expect(status()).toBe(message);
    expect($('saveStatus').dataset.tone).toBe('error');
  });

  it('Clear screenshots reports a missing worker (lastError) and a throwing sendMessage', async () => {
    const { state } = await openOptions();
    state.failNext.send = 'Could not establish connection. Receiving end does not exist.';
    $('clearShotsBtn').click();
    await flush();
    expect(status()).toBe(
      'Could not clear screenshots: Could not establish connection. Receiving end does not exist.'
    );
    await openOptions({ sendThrows: true });
    $('clearShotsBtn').click();
    await flush();
    expect(status()).toBe('Could not clear screenshots: worker gone');
  });

  it('every clear can be cancelled', async () => {
    const { state } = await openOptions({ storage });
    confirmAnswer = false;
    $('clearTimelinesBtn').click();
    $('clearShotsBtn').click();
    $('clearWatchedBtn').click();
    await flush();
    expect(state.ops).toEqual([]);
    expect(state.sent).toEqual([]);
  });

  it('counts follow changes made elsewhere', async () => {
    const { state } = await openOptions();
    state.store.llWatched = { version: 1, sites: { a: [{}, {}] } };
    state.changeListeners.forEach((fn) => fn({ llWatched: { newValue: state.store.llWatched } }, 'local'));
    await flush();
    expect($('watchedCount').textContent).toBe('2 watched locators.');
    state.store['llRecorderState:5'] = {};
    state.changeListeners.forEach((fn) => fn({ 'llRecorderState:5': { newValue: {} } }, 'local'));
    await flush();
    expect($('timelineCount').textContent).toBe('1 saved timeline, one per browser window.');
  });

  it('a failed count read leaves the texts alone', async () => {
    const { state } = await openOptions({ storage: { llRecorderState: {} } });
    expect($('timelineCount').textContent).toBe('1 saved timeline, one per browser window.');
    state.failNext.get = 'x';
    state.changeListeners.forEach((fn) => fn({ llRecorderState: { oldValue: {} } }, 'local'));
    await flush();
    expect($('timelineCount').textContent).toBe('1 saved timeline, one per browser window.');
  });
});

// ── Keyboard shortcuts: Chrome / Edge ──────────────────────────────────────

const COMMANDS = [
  { name: '_execute_action', shortcut: 'Alt+Shift+L', description: '' },
  { name: 'toggle-inspect', shortcut: 'Alt+Shift+E', description: 'Start or stop inspecting' },
  { name: 'toggle-recording', shortcut: '', description: 'Start or stop recording' },
];

const rows = () =>
  [...$('shortcutList').children].map((li) => ({
    name: li.dataset.command,
    label: li.querySelector('strong').textContent,
    key: (li.querySelector('kbd') || li.querySelector('.not-set') || li.querySelector('input'))[
      li.querySelector('input') ? 'value' : 'textContent'
    ],
  }));

function setNavigator(props) {
  for (const [k, v] of Object.entries(props))
    Object.defineProperty(navigator, k, { configurable: true, value: v });
  return () => Object.keys(props).forEach((k) => delete navigator[k]);
}

describe('Keyboard shortcuts — Chrome / Edge', () => {
  it('lists every command with its keys or “Not set”', async () => {
    await openOptions({ commands: COMMANDS });
    expect(rows()).toEqual([
      { name: '_execute_action', label: 'Open the Locatra popup', key: 'Alt+Shift+L' },
      { name: 'toggle-inspect', label: 'Start or stop inspecting', key: 'Alt+Shift+E' },
      { name: 'toggle-recording', label: 'Start or stop recording', key: 'Not set' },
    ]);
    expect($('shortcutsHint').textContent).toContain('chrome://extensions/shortcuts');
    expect($('shortcutsEmpty').hidden).toBe(true);
    expect($('shortcutList').querySelector('input')).toBeNull();
  });

  it('“Change shortcuts…” opens chrome://extensions/shortcuts in a tab', async () => {
    const { state } = await openOptions({ commands: COMMANDS });
    expect($('shortcutsManageBtn').hidden).toBe(false);
    $('shortcutsManageBtn').click();
    await flush();
    expect(state.tabs).toEqual([{ url: 'chrome://extensions/shortcuts' }]);
    expect($('shortcutsManageError').textContent).toBe('');
  });

  it('on Edge it opens edge://extensions/shortcuts (user agent or client hints)', async () => {
    let restore = setNavigator({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0',
    });
    try {
      const { state } = await openOptions({ commands: COMMANDS });
      expect($('shortcutsHint').textContent).toContain('edge://extensions/shortcuts');
      $('shortcutsManageBtn').click();
      expect(state.tabs).toEqual([{ url: 'edge://extensions/shortcuts' }]);
    } finally {
      restore();
    }
    restore = setNavigator({
      userAgentData: { brands: [{ brand: 'Microsoft Edge', version: '130' }, null] },
    });
    try {
      const { state } = await openOptions({ commands: COMMANDS });
      $('shortcutsManageBtn').click();
      expect(state.tabs).toEqual([{ url: 'edge://extensions/shortcuts' }]);
    } finally {
      restore();
    }
  });

  it('tells the user where to go when the tab cannot be opened', async () => {
    await openOptions({ commands: COMMANDS, tabsError: 'Not allowed' });
    $('shortcutsManageBtn').click();
    await flush();
    expect($('shortcutsManageError').textContent).toBe(
      'Open chrome://extensions/shortcuts in a new tab to change shortcuts.'
    );

    await openOptions({
      commands: COMMANDS,
      beforeInit: (c) => {
        c.tabs.create = () => {
          throw new Error('no tabs');
        };
      },
    });
    $('shortcutsManageBtn').click();
    expect($('shortcutsManageError').textContent).toContain('chrome://extensions/shortcuts');

    await openOptions({
      commands: COMMANDS,
      beforeInit: (c) => (c.tabs.create = () => Promise.reject(new Error('x'))),
    });
    $('shortcutsManageBtn').click();
    await flush();
    expect($('shortcutsManageError').textContent).toContain('chrome://extensions/shortcuts');
  });

  it('no commands API, no commands, or a throwing getAll: an explanation and no button', async () => {
    await openOptions({ commands: null });
    expect($('shortcutsEmpty').hidden).toBe(false);
    expect($('shortcutsManageBtn').hidden).toBe(true);
    await openOptions({ commands: [] });
    expect($('shortcutsEmpty').hidden).toBe(false);
    expect($('shortcutsManageBtn').hidden).toBe(true);
    await openOptions({
      commands: COMMANDS,
      beforeInit: (c) => {
        c.commands.getAll = () => {
          throw new Error('nope');
        };
      },
    });
    expect($('shortcutsEmpty').hidden).toBe(false);
    await openOptions({ commands: COMMANDS, beforeInit: (c) => delete c.tabs });
    expect($('shortcutsManageBtn').hidden).toBe(true);
  });

  it('re-reads the shortcuts when the page regains focus (back from the browser’s page)', async () => {
    const { state } = await openOptions({ commands: COMMANDS });
    state.commands = [
      { name: 'toggle-recording', shortcut: 'Ctrl+Shift+9', description: 'Start or stop recording' },
    ];
    window.dispatchEvent(new window.Event('focus'));
    await flush();
    expect(rows()).toEqual([
      { name: 'toggle-recording', label: 'Start or stop recording', key: 'Ctrl+Shift+9' },
    ]);
  });

  it('renders command names and descriptions as text; drops malformed entries', async () => {
    await openOptions({
      commands: [
        { name: 'evil', description: '<img src=x onerror="window.__pwned=1">', shortcut: '<b>K</b>' },
        null,
        { description: 'no name' },
        { name: 'plain' },
      ],
    });
    expect(document.querySelector('#shortcutList img, #shortcutList b')).toBeNull();
    expect(rows()).toEqual([
      { name: 'evil', label: '<img src=x onerror="window.__pwned=1">', key: '<b>K</b>' },
      { name: 'plain', label: 'plain', key: 'Not set' },
    ]);
  });
});

// ── Keyboard shortcuts: Firefox ─────────────────────────────────────────────

function firefox(commands) {
  const state = { commands: JSON.parse(JSON.stringify(commands)) };
  const b = {
    commands: {
      getAll: vi.fn(async () => JSON.parse(JSON.stringify(state.commands))),
      update: vi.fn(async ({ name, shortcut }) => {
        const c = state.commands.find((x) => x.name === name);
        c.shortcut = shortcut;
      }),
      reset: vi.fn(async (name) => {
        const c = state.commands.find((x) => x.name === name);
        c.shortcut = 'Alt+Shift+E';
      }),
    },
  };
  return { b, state };
}

const inputFor = (name) => $('shortcutList').querySelector(`[data-command="${name}"] input`);
const errorFor = (name) => $('shortcutList').querySelector(`[data-command="${name}"] .field-error`);
const buttonFor = (name, text) =>
  [...$('shortcutList').querySelectorAll(`[data-command="${name}"] button`)].find(
    (b) => b.textContent === text
  );

describe('Keyboard shortcuts — Firefox inline editing', () => {
  it('shows an editable, labelled field per command and no shortcuts-page button', async () => {
    const { b } = firefox(COMMANDS);
    await openOptions({ browser: b, commands: [] });
    expect($('shortcutsManageBtn').hidden).toBe(true);
    expect($('shortcutsHint').textContent).toContain('press the keys');
    const input = inputFor('toggle-inspect');
    expect(input.value).toBe('Alt+Shift+E');
    expect(document.getElementById(input.getAttribute('aria-labelledby')).textContent).toBe(
      'Start or stop inspecting'
    );
    expect(inputFor('toggle-recording').value).toBe('');
    expect(inputFor('toggle-recording').placeholder).toBe('Not set');
    expect(buttonFor('toggle-inspect', 'Save').getAttribute('aria-label')).toBe(
      'Save shortcut for Start or stop inspecting'
    );
    expect(rows()[0].label).toBe('Open the Locatra popup');
  });

  it('captures a pressed combination and saves it with Enter', async () => {
    const { b } = firefox(COMMANDS);
    await openOptions({ browser: b });
    const input = inputFor('toggle-recording');
    input.focus();
    const ev = press(input, 'J', { code: 'KeyJ', altKey: true, shiftKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(input.value).toBe('Alt+Shift+J');
    press(input, 'Enter');
    await flush();
    expect(b.commands.update).toHaveBeenCalledWith({ name: 'toggle-recording', shortcut: 'Alt+Shift+J' });
    expect(status()).toBe('Shortcut set to Alt+Shift+J');
    expect(inputFor('toggle-recording').value).toBe('Alt+Shift+J');
    expect(document.activeElement).toBe(inputFor('toggle-recording'));
  });

  it('accepts typed text, normalised, via the Save button', async () => {
    const { b } = firefox(COMMANDS);
    await openOptions({ browser: b });
    setValue(inputFor('toggle-inspect'), ' ctrl + shift + y ', { change: false });
    buttonFor('toggle-inspect', 'Save').click();
    await flush();
    expect(b.commands.update).toHaveBeenCalledWith({ name: 'toggle-inspect', shortcut: 'Ctrl+Shift+Y' });
  });

  it('rejects an invalid shortcut before asking the browser', async () => {
    const { b } = firefox(COMMANDS);
    await openOptions({ browser: b });
    const input = inputFor('toggle-inspect');
    setValue(input, 'Shift+K', { change: false });
    buttonFor('toggle-inspect', 'Save').click();
    await flush();
    expect(b.commands.update).not.toHaveBeenCalled();
    expect(errorFor('toggle-inspect').textContent).toBe('Add Ctrl, Alt, Command or MacCtrl.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(input);
  });

  it('shows the browser’s own rejection', async () => {
    const { b } = firefox(COMMANDS);
    b.commands.update.mockRejectedValueOnce(new Error('Type error for parameter detail'));
    await openOptions({ browser: b });
    setValue(inputFor('toggle-inspect'), 'Alt+P', { change: false });
    buttonFor('toggle-inspect', 'Save').click();
    await flush();
    expect(errorFor('toggle-inspect').textContent).toBe('Type error for parameter detail');
    b.commands.update.mockRejectedValueOnce('weird');
    buttonFor('toggle-inspect', 'Save').click();
    await flush();
    expect(errorFor('toggle-inspect').textContent).toBe('The browser rejected this shortcut.');
  });

  it('Backspace empties the field; saving empty turns the shortcut off', async () => {
    const { b } = firefox(COMMANDS);
    await openOptions({ browser: b });
    const input = inputFor('toggle-inspect');
    expect(press(input, 'Backspace').defaultPrevented).toBe(true);
    expect(input.value).toBe('');
    buttonFor('toggle-inspect', 'Save').click();
    await flush();
    expect(b.commands.update).toHaveBeenCalledWith({ name: 'toggle-inspect', shortcut: '' });
    expect(status()).toBe('Shortcut turned off');
  });

  it('Escape reverts the field and clears its error', async () => {
    const { b } = firefox(COMMANDS);
    await openOptions({ browser: b });
    const input = inputFor('toggle-inspect');
    press(input, 'K', { code: 'KeyK', ctrlKey: true, altKey: true, shiftKey: true });
    expect(input.value).toBe('Ctrl+Alt+Shift+K');
    expect(errorFor('toggle-inspect').textContent).toBe('Use at most two modifiers.');
    press(input, 'Escape');
    expect(input.value).toBe('Alt+Shift+E');
    expect(errorFor('toggle-inspect').textContent).toBe('');
  });

  it('leaves Tab and plain typing alone, captures F-keys and media keys, ignores a bare modifier', async () => {
    const { b } = firefox(COMMANDS);
    await openOptions({ browser: b });
    const input = inputFor('toggle-inspect');
    expect(press(input, 'Tab', { code: 'Tab' }).defaultPrevented).toBe(false);
    expect(press(input, 'Tab', { code: 'Tab', shiftKey: true }).defaultPrevented).toBe(false);
    expect(press(input, 'a', { code: 'KeyA' }).defaultPrevented).toBe(false);
    expect(press(input, 'Shift', { code: 'ShiftLeft', shiftKey: true }).defaultPrevented).toBe(false);
    expect(press(input, 'Enter', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(press(input, 'Backspace', { ctrlKey: true, code: 'Backspace' }).defaultPrevented).toBe(false);
    expect(press(input, 'F7', { code: 'F7' }).defaultPrevented).toBe(true);
    expect(input.value).toBe('F7');
    press(input, 'MediaPlayPause', { code: 'MediaPlayPause' });
    expect(input.value).toBe('MediaPlayPause');
    press(input, '5', { code: 'Digit5', ctrlKey: true });
    expect(input.value).toBe('Ctrl+5');
    press(input, 'ArrowUp', { code: 'ArrowUp', altKey: true });
    expect(input.value).toBe('Alt+Up');
    // Windows key on a non-Mac is not a Firefox modifier.
    press(input, 'k', { code: 'KeyK', metaKey: true });
    expect(input.value).toBe('K');
    expect(errorFor('toggle-inspect').textContent).toBe('Add Ctrl, Alt, Command or MacCtrl.');
  });

  it('on a Mac, Control is MacCtrl and ⌘ is Command', async () => {
    const restore = setNavigator({ platform: 'MacIntel' });
    try {
      const { b } = firefox(COMMANDS);
      await openOptions({ browser: b });
      const input = inputFor('toggle-inspect');
      press(input, 'k', { code: 'KeyK', ctrlKey: true, shiftKey: true });
      expect(input.value).toBe('MacCtrl+Shift+K');
      press(input, 'k', { code: 'KeyK', metaKey: true, altKey: true });
      expect(input.value).toBe('Alt+Command+K');
    } finally {
      restore();
    }
  });

  it('Reset restores the default through browser.commands.reset', async () => {
    const { b } = firefox([
      { name: 'toggle-inspect', shortcut: 'Ctrl+9', description: 'Start or stop inspecting' },
    ]);
    await openOptions({ browser: b });
    buttonFor('toggle-inspect', 'Reset').click();
    await flush();
    expect(b.commands.reset).toHaveBeenCalledWith('toggle-inspect');
    expect(inputFor('toggle-inspect').value).toBe('Alt+Shift+E');
    expect(status()).toBe('Shortcut reset to the default');
    b.commands.reset.mockRejectedValueOnce(new Error('cannot'));
    buttonFor('toggle-inspect', 'Reset').click();
    await flush();
    expect(errorFor('toggle-inspect').textContent).toBe('cannot');
    b.commands.reset.mockRejectedValueOnce(null);
    buttonFor('toggle-inspect', 'Reset').click();
    await flush();
    expect(errorFor('toggle-inspect').textContent).toBe('Could not reset this shortcut.');
  });

  it('a getAll that resolves to nothing, or rejects, shows the explanation', async () => {
    const { b } = firefox(COMMANDS);
    b.commands.getAll.mockResolvedValueOnce(undefined);
    await openOptions({ browser: b });
    expect($('shortcutsEmpty').hidden).toBe(false);
    b.commands.getAll.mockRejectedValueOnce(new Error('x'));
    window.dispatchEvent(new window.Event('focus'));
    await flush();
    expect($('shortcutsEmpty').hidden).toBe(false);
  });

  it('a browser object without update/reset is not treated as Firefox', async () => {
    await openOptions({ browser: { commands: { getAll: async () => [] } }, commands: COMMANDS });
    expect($('shortcutsManageBtn').hidden).toBe(false);
    expect($('shortcutList').querySelector('input')).toBeNull();
  });
});

describe('normalizeShortcut (Firefox syntax)', () => {
  it.each([
    ['', { value: '' }],
    ['   ', { value: '' }],
    ['alt+shift+i', { value: 'Alt+Shift+I' }],
    ['Shift+Ctrl+P', { value: 'Ctrl+Shift+P' }],
    ['Command+Shift+1', { value: 'Command+Shift+1' }],
    ['cmd+k', { value: 'Command+K' }],
    ['MacCtrl+Alt+comma', { value: 'Alt+MacCtrl+Comma' }],
    ['option+pageup', { value: 'Alt+PageUp' }],
    ['control+space', { value: 'Ctrl+Space' }],
    ['f12', { value: 'F12' }],
    ['Shift+F3', { value: 'Shift+F3' }],
    ['mediastop', { value: 'MediaStop' }],
    ['Ctrl+MediaStop', { error: 'Media keys cannot have modifiers.' }],
    ['Shift+K', { error: 'Add Ctrl, Alt, Command or MacCtrl.' }],
    ['K', { error: 'Add Ctrl, Alt, Command or MacCtrl.' }],
    ['Ctrl+Alt+Shift+K', { error: 'Use at most two modifiers.' }],
    ['Ctrl+Ctrl+K', { error: 'Ctrl appears twice.' }],
    ['Hyper+K', { error: '“Hyper” is not a modifier (use Ctrl, Alt, Shift, Command or MacCtrl).' }],
    ['Ctrl+Escape', { error: '“Escape” is not a key Firefox accepts.' }],
    ['Ctrl+F13', { error: '“F13” is not a key Firefox accepts.' }],
    ['Ctrl++', { error: 'Write it like Alt+Shift+E.' }],
    [null, { value: '' }],
  ])('%j → %j', async (input, expected) => {
    const { seam } = await openOptions();
    expect(seam.normalizeShortcut(input)).toEqual(expected);
  });
});
