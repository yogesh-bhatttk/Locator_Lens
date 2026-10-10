// @vitest-environment jsdom
//
// Side panel: locator health (section E) — ☆ Watch on locator cards, "Watch all"
// in the Page Object view, the Health tab (statuses, Check now, suggestions,
// Remove, Copy, Export / Import with hostile-JSON validation, caps, auto-check)
// and llWatched storage. The real sidepanel.js runs in jsdom behind a scripted
// `chrome` stub; assertions are on what the user sees and what gets stored / sent.

/* global LLCodegen */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WIN = 7;
const DEFER = Symbol('defer');
const SITE = 'https://shop.test/cart';

const h = {
  store: {},
  sent: [],
  responders: {},
  deferred: [],
  portListener: null,
  storageListeners: [],
  tabsActivated: [],
  tabsUpdated: [],
  setError: null,
};

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function pickKeys(keys) {
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
      getAll: (_o, cb) => cb([{ id: WIN }]),
    },
    tabs: {
      onActivated: { addListener: (fn) => h.tabsActivated.push(fn) },
      onUpdated: { addListener: (fn) => h.tabsUpdated.push(fn) },
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
          cb(clone(answer));
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
          if (h.setError) {
            chrome.runtime.lastError = { message: h.setError };
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
    lastResultData = null; lastLocators = []; lastRenderedPickId = null; _stressState = null;
    outFramework = 'playwright'; outLanguage = 'typescript'; _bufferAckPending = false;
    replayRun = null; replayStatuses = new Map(); replaySecretsOpen = false;
    pomModel = null; _pomLastResultJson = '';
    thumbCache.clear(); _thumbGen.clear(); _thumbInFlight.clear(); _thumbModalOpener = null;
    llSettings = { autoAssertions: true, stepScreenshots: true, variables: true, healthAutoCheck: false };
    llSettingsRaw = {}; _settingsLoaded = false;
    watched = { version: 1, sites: {} }; _watchedLoaded = false; healthPage = null;
    if (healthCheckRun && healthCheckRun.timer) clearTimeout(healthCheckRun.timer);
    healthCheckRun = null; _healthAutoCheckedKey = null;
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
const port = (msg) => h.portListener(msg);
const fireStorage = (changes) => {
  for (const fn of h.storageListeners) fn(changes, 'local');
};
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const healthRows = () => [...document.querySelectorAll('#healthList .ll-health-row')];
const rowOf = (id) => document.querySelector(`#healthList .ll-health-row[data-id="${id}"]`);
const badgeOf = (id) => rowOf(id).querySelector('.ll-health-badge').textContent;
const site = (key = SITE) => (h.store.llWatched && h.store.llWatched.sites[key]) || [];
const openHealth = () => $('tabBtnHealth').click();
const watchBtns = () => [...document.querySelectorAll('#cardsContainer .watch-btn')];

const W = (id, over = {}) => ({
  id,
  label: `button "Buy ${id}"`,
  target: { kind: 'role', role: 'button', name: 'Buy ' + id },
  code: `page.getByRole('button', { name: 'Buy ${id}' })`,
  fingerprint: { tag: 'button', role: 'button', label: 'Buy ' + id },
  savedAt: 1000,
  ...over,
});
const storeWatched = (sites) => {
  h.store.llWatched = { version: 1, sites };
};
const many = (n, prefix = 'w') => Array.from({ length: n }, (_, i) => W(prefix + i));

const PICK = () => ({
  pickId: 'p' + Math.random(),
  pageUrl: 'https://shop.test/cart?token=REDACTED#top',
  elementData: {
    tag: 'button',
    role: 'button',
    visibleText: 'Buy now',
    fingerprint: {
      tag: 'button',
      id: null,
      role: 'button',
      label: 'Buy now',
      text: 'Buy now '.repeat(20),
      classes: ['a', 'b', 'c', 'd', 'e', 'f'],
      junk: 'dropped',
    },
  },
  locators: [
    {
      rank: 1,
      method: 'getByRole',
      stability: 'BEST',
      code: "page.getByRole('button', { name: 'Buy now' })",
      fullCode: "await page.getByRole('button', { name: 'Buy now' }).click();",
      target: { kind: 'role', role: 'button', name: 'Buy now' },
      matchCount: 1,
      unique: true,
    },
    {
      rank: 2,
      method: 'locator',
      stability: 'OK',
      code: "page.locator('#buy')",
      fullCode: "await page.locator('#buy').click();",
      target: { kind: 'id', value: 'buy' },
    },
    { rank: 3, method: 'locator', stability: 'AVOID', code: "page.locator('div > button')", fullCode: '' },
  ],
});
const showPick = (data = PICK()) => port({ type: 'ELEMENT_PICKED', windowId: WIN, data });

beforeEach(() => {
  vi.useFakeTimers();
  h.store = {};
  h.sent = [];
  h.deferred = [];
  h.setError = null;
  h.responders = {
    GET_RECORDING_STATE: () => ({ active: false }),
    GET_ACTIVE_PAGE: () => ({ ok: true, tabId: 3, url: SITE + '?q=1#x', siteKey: SITE }),
  };
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
});

// ── ☆ Watch on locator cards ───────────────────────────────────────────────────
describe('watch buttons on locator cards', () => {
  it('appear on every card with a structured locator, labelled per card', () => {
    boot();
    showPick();
    expect(watchBtns()).toHaveLength(2);
    expect(watchBtns()[0].textContent).toBe('☆ Watch');
    expect(watchBtns()[0].getAttribute('aria-pressed')).toBe('false');
    expect(watchBtns()[0].getAttribute('aria-label')).toBe('Watch locator 1: getByRole');
  });

  it('watching stores the locator + a sanitised fingerprint under the page key (no query/hash)', () => {
    boot();
    showPick();
    watchBtns()[0].click();
    const [item] = site();
    expect(Object.keys(h.store.llWatched.sites)).toEqual([SITE]);
    expect(h.store.llWatched.version).toBe(1);
    expect(item).toMatchObject({
      label: 'button "Buy now"',
      target: { kind: 'role', role: 'button', name: 'Buy now' },
      code: "page.getByRole('button', { name: 'Buy now' })",
    });
    expect(item.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(typeof item.savedAt).toBe('number');
    expect(item.fingerprint.classes).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(item.fingerprint.text).toHaveLength(80);
    expect(item.fingerprint).not.toHaveProperty('junk');
    expect(item.fingerprint).not.toHaveProperty('id'); // null dropped
    expect(watchBtns()[0].textContent).toBe('★ Watching');
    expect(watchBtns()[0].getAttribute('aria-pressed')).toBe('true');
    expect($('panelStatus').textContent).toBe('Watching button "Buy now" — see the Health tab.');
  });

  it('a second click stops watching (and drops the empty site)', () => {
    boot();
    showPick();
    watchBtns()[1].click();
    expect(site()).toHaveLength(1);
    watchBtns()[1].click();
    expect(h.store.llWatched.sites).toEqual({});
    expect(watchBtns()[1].textContent).toBe('☆ Watch');
    expect($('panelStatus').textContent).toBe('Stopped watching that locator.');
  });

  it('shows ★ Watching for a locator watched earlier, whatever its key order', () => {
    storeWatched({ [SITE]: [W('a', { target: { name: 'Buy now', role: 'button', kind: 'role' } })] });
    boot();
    showPick();
    expect(watchBtns()[0].textContent).toBe('★ Watching');
    expect(watchBtns()[1].textContent).toBe('☆ Watch');
  });

  it('builds a fingerprint from the element bar when the pick has none, and labels by tag#id', () => {
    boot();
    const data = PICK();
    data.elementData = { tag: 'input', id: 'email', placeholder: 'you@x' };
    showPick(data);
    watchBtns()[1].click();
    expect(site()[0].label).toBe('input#email');
    expect(site()[0].fingerprint).toEqual({ tag: 'input', id: 'email', placeholder: 'you@x' });
  });

  it('asks the worker for the page when the pick carries none', () => {
    boot();
    const data = PICK();
    delete data.pageUrl;
    showPick(data);
    h.sent = [];
    watchBtns()[0].click();
    expect(sentOf('GET_ACTIVE_PAGE')).toEqual([{ type: 'GET_ACTIVE_PAGE', windowId: WIN }]);
    expect(site()).toHaveLength(1);
  });

  it('refuses non-http pages', () => {
    h.responders.GET_ACTIVE_PAGE = () => ({ ok: false, error: "Locatra can't run on this page." });
    boot();
    const data = PICK();
    data.pageUrl = 'chrome://settings/';
    showPick(data);
    watchBtns()[0].click();
    expect(h.store.llWatched).toBeUndefined();
    expect($('panelStatus').textContent).toBe('Locators can only be watched on http(s) pages.');
  });

  it('refuses beyond 200 per page and 2000 in total', () => {
    storeWatched({ [SITE]: many(200) });
    boot();
    showPick();
    watchBtns()[0].click();
    expect(site()).toHaveLength(200);
    expect($('panelStatus').textContent).toContain('already has 200 watched locators');
    const sites = {};
    for (let s = 0; s < 10; s++) sites[`https://o${s}.test/`] = many(200, 's' + s + '-');
    storeWatched(sites);
    showPick();
    watchBtns()[0].click();
    expect(site()).toHaveLength(0);
    expect($('panelStatus').textContent).toContain('You already watch 2000 locators');
  });

  it('reports a storage failure', () => {
    boot();
    showPick();
    h.setError = 'QUOTA_BYTES quota exceeded';
    watchBtns()[0].click();
    expect($('panelStatus').textContent).toBe(
      "Couldn't save the watched locator: QUOTA_BYTES quota exceeded"
    );
    expect(watchBtns()[0].textContent).toBe('☆ Watch');
  });

  it('ignores clicks that point at no locator', () => {
    boot();
    showPick();
    watchBtns()[0].setAttribute('data-index', '9');
    watchBtns()[0].click();
    expect(h.store.llWatched).toBeUndefined();
  });
});

// ── Watch all (Page Object) ──────────────────────────────────────────────────────
describe('Watch all in the Page Object view', () => {
  const POM = () => ({
    pageUrl: 'https://shop.test/cart?step=2',
    title: 'Cart',
    elements: [
      {
        name: 'emailInput',
        kind: 'input',
        target: { kind: 'label', value: 'Email' },
        code: "page.getByLabel('Email')",
        fingerprint: { tag: 'input', label: 'Email', type: 'email' },
        unique: true,
      },
      {
        name: 'buyButton',
        kind: 'button',
        target: { kind: 'role', role: 'button', name: 'Buy' },
        role: 'button',
      },
      { name: 'noTarget', kind: 'link' },
    ],
  });

  it('watches every included element with a locator and reports what it did', () => {
    boot();
    port({ type: 'POM_RESULT', windowId: WIN, data: POM() });
    $('pomWatchAllBtn').click();
    expect(site().map((i) => i.label)).toEqual(['emailInput (input)', 'buyButton (button)']);
    expect(site()[0].fingerprint).toEqual({ tag: 'input', label: 'Email', type: 'email' });
    expect(site()[1].fingerprint).toEqual({ role: 'button' });
    expect(site()[1].code).toBe("getByRole('button', { name: 'Buy' })".replace(/^/, 'page.'));
    expect($('pomStatus').textContent).toBe('Watching 2 locators — see the Health tab.');
    $('pomWatchAllBtn').click();
    expect(site()).toHaveLength(2);
    expect($('pomStatus').textContent).toBe('Watching 0 locators — see the Health tab. 2 already watched.');
  });

  it('recognises an already-watched element whose raw target carries fields storage drops', () => {
    boot();
    const raw = {
      kind: 'frame',
      selector: '#pay',
      index: 0,
      framesIndex: undefined,
      child: { kind: 'role', role: 'heading', name: 'Pay', level: 2, shadowHosts: undefined },
    };
    const data = { ...POM(), elements: [{ name: 'payHeading', kind: 'heading', target: raw }] };
    port({ type: 'POM_RESULT', windowId: WIN, data });
    $('pomWatchAllBtn').click();
    expect(site()).toHaveLength(1);
    port({ type: 'POM_RESULT', windowId: WIN, data });
    $('pomWatchAllBtn').click();
    expect(site()).toHaveLength(1);
    expect($('pomStatus').textContent).toBe('Watching 0 locators — see the Health tab. 1 already watched.');
  });

  it('skips excluded rows, and says so when nothing is included', () => {
    boot();
    port({ type: 'POM_RESULT', windowId: WIN, data: POM() });
    const boxes = document.querySelectorAll('.ll-pom-include');
    boxes[0].click();
    $('pomWatchAllBtn').click();
    expect(site().map((i) => i.label)).toEqual(['buyButton (button)']);
    boxes[1].click();
    $('pomWatchAllBtn').click();
    expect($('pomStatus').textContent).toBe('Include at least one element to watch.');
  });

  it('stops at the per-page cap and counts the rest', () => {
    storeWatched({ [SITE]: many(199) });
    boot();
    port({ type: 'POM_RESULT', windowId: WIN, data: POM() });
    $('pomWatchAllBtn').click();
    expect(site()).toHaveLength(200);
    expect($('pomStatus').textContent).toBe(
      'Watching 1 locator — see the Health tab. 1 skipped (limit: 200 per page, 2000 in total).'
    );
    $('pomWatchAllBtn').click();
    expect($('pomStatus').className).toContain('err');
  });

  it('uses the active page when the result has no URL, and refuses a non-http one', () => {
    h.responders.GET_ACTIVE_PAGE = () => ({ ok: true, url: 'about:blank' });
    boot();
    const data = POM();
    data.pageUrl = '';
    port({ type: 'POM_RESULT', windowId: WIN, data });
    $('pomWatchAllBtn').click();
    expect($('pomStatus').textContent).toBe('Locators can only be watched on http(s) pages.');
    expect(h.store.llWatched).toBeUndefined();
  });

  it('reports a storage failure', () => {
    boot();
    port({ type: 'POM_RESULT', windowId: WIN, data: POM() });
    h.setError = 'disk full';
    $('pomWatchAllBtn').click();
    expect($('pomStatus').textContent).toBe("Couldn't save the watched locators: disk full");
  });

  it('does nothing without a Page Object', () => {
    boot();
    $('pomWatchAllBtn').click();
    expect(h.store.llWatched).toBeUndefined();
  });
});

// ── The Health tab ───────────────────────────────────────────────────────────────
describe('Health tab', () => {
  it('lists the watched locators of the active page, with the page and other sites', () => {
    storeWatched({
      [SITE]: [W('a'), W('b')],
      'https://shop.test/login': [W('c')],
      'https://docs.test/': [W('d'), W('e'), W('f')],
    });
    boot();
    openHealth();
    expect($('tab-health').classList.contains('active')).toBe(true);
    expect($('healthPage').textContent).toBe('Page: ' + SITE);
    expect(healthRows().map((r) => r.getAttribute('data-id'))).toEqual(['a', 'b']);
    expect(badgeOf('a')).toBe('• not checked');
    expect(rowOf('a').querySelector('.ll-health-meta').textContent).toBe('Not checked yet');
    expect(rowOf('a').querySelector('.ll-health-label').textContent).toBe('button "Buy a"');
    expect(rowOf('a').querySelector('.ll-health-code').textContent).toBe(
      "page.getByRole('button', { name: 'Buy a' })"
    );
    expect($('healthSummary').textContent).toBe('2 watched on this page');
    expect($('healthEmpty').hidden).toBe(true);
    expect($('healthOther').hidden).toBe(false);
    expect($('healthOtherSummary').textContent).toBe('Other sites (2)');
    expect([...$('healthOtherList').children].map((li) => li.textContent)).toEqual([
      'https://docs.test/ — 3 locators',
      'https://shop.test/login — 1 locator',
    ]);
    expect($('healthCheckBtn').disabled).toBe(false);
  });

  it('shows the empty state on an unwatched page', () => {
    storeWatched({ 'https://docs.test/': [W('d')] });
    boot();
    openHealth();
    expect(healthRows()).toHaveLength(0);
    expect($('healthEmpty').hidden).toBe(false);
    expect($('healthCheckBtn').disabled).toBe(true);
    expect($('healthSummary').textContent).toBe('');
  });

  it('explains a page it cannot read', () => {
    h.responders.GET_ACTIVE_PAGE = () => ({
      ok: false,
      error: "Locatra can't run on this page (chrome://).",
    });
    boot();
    openHealth();
    expect($('healthPage').textContent).toBe("Locatra can't run on this page (chrome://).");
    expect($('healthEmpty').hidden).toBe(true);
    h.responders.GET_ACTIVE_PAGE = () => ({ ok: true, url: 'ftp://x/' });
    openHealth();
    expect($('healthPage').textContent).toBe('Locator health works on http(s) pages.');
    h.responders.GET_ACTIVE_PAGE = () => undefined;
    openHealth();
    expect($('healthPage').textContent).toBe("Couldn't reach the extension's background worker.");
    h.responders.GET_ACTIVE_PAGE = () => ({ ok: false });
    openHealth();
    expect($('healthPage').textContent).toBe("Couldn't read the active page.");
  });

  it('follows tab switches and navigations in its window only', () => {
    storeWatched({ [SITE]: [W('a')], 'https://shop.test/login': [W('c')] });
    boot();
    openHealth();
    h.responders.GET_ACTIVE_PAGE = () => ({ ok: true, url: 'https://shop.test/login' });
    for (const fn of h.tabsActivated) fn({ tabId: 9, windowId: 99 }); // another window
    expect($('healthPage').textContent).toBe('Page: ' + SITE);
    for (const fn of h.tabsActivated) fn({ tabId: 9, windowId: WIN });
    expect(healthRows().map((r) => r.getAttribute('data-id'))).toEqual(['c']);
    h.responders.GET_ACTIVE_PAGE = () => ({ ok: true, url: SITE });
    for (const fn of h.tabsUpdated) fn(9, { title: 'x' }, { windowId: WIN, active: true }); // not a load
    for (const fn of h.tabsUpdated) fn(9, { status: 'complete' }, { windowId: WIN, active: false }); // background tab
    expect(healthRows().map((r) => r.getAttribute('data-id'))).toEqual(['c']);
    for (const fn of h.tabsUpdated) fn(9, { status: 'complete' }, { windowId: WIN, active: true });
    expect(healthRows().map((r) => r.getAttribute('data-id'))).toEqual(['a']);
  });

  it('polls the active page on the heartbeat only while the tab is shown', () => {
    boot();
    const before = sentOf('GET_ACTIVE_PAGE').length;
    vi.advanceTimersByTime(4000);
    expect(sentOf('GET_ACTIVE_PAGE')).toHaveLength(before);
    openHealth();
    const shown = sentOf('GET_ACTIVE_PAGE').length;
    vi.advanceTimersByTime(4000);
    expect(sentOf('GET_ACTIVE_PAGE')).toHaveLength(shown + 1);
    // (Every boot in this file adds a visibility listener, so only "it asked again" is checked.)
    document.dispatchEvent(new window.Event('visibilitychange'));
    expect(sentOf('GET_ACTIVE_PAGE').length).toBeGreaterThan(shown + 1);
  });

  it('shares one in-flight page request between callers', () => {
    h.responders.GET_ACTIVE_PAGE = () => DEFER;
    boot();
    openHealth();
    openHealth();
    expect(sentOf('GET_ACTIVE_PAGE')).toHaveLength(1);
    h.deferred[0].cb({ ok: true, url: SITE });
    expect($('healthPage').textContent).toBe('Page: ' + SITE);
  });

  it('follows llWatched changes made elsewhere (e.g. "Clear watched locators")', () => {
    storeWatched({ [SITE]: [W('a')] });
    boot();
    openHealth();
    expect(healthRows()).toHaveLength(1);
    fireStorage({ llWatched: { newValue: undefined } });
    expect(healthRows()).toHaveLength(0);
    fireStorage({ llWatched: { newValue: { version: 1, sites: { [SITE]: [W('z')] } } } });
    expect(healthRows().map((r) => r.getAttribute('data-id'))).toEqual(['z']);
  });

  it('shows locators in the selected framework and copies that form', async () => {
    storeWatched({
      [SITE]: [W('a', { target: { kind: 'id', value: 'buy' }, code: "page.locator('#buy')" })],
    });
    h.store.llFramework = 'selenium';
    h.store.llLanguage = 'python';
    boot();
    openHealth();
    const expected = LLCodegen.locatorExpr({ kind: 'id', value: 'buy' }, 'selenium', 'python');
    expect(rowOf('a').querySelector('.ll-health-code').textContent).toBe(expected);
    rowOf('a').querySelector('.ll-health-copy').click();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expected);
  });

  it('renders hostile stored text as text', () => {
    storeWatched({ [SITE]: [W('a', { label: '<img src=x onerror=alert(1)>', code: '<b>x</b>' })] });
    boot();
    openHealth();
    expect(document.querySelector('#healthList img')).toBeNull();
    expect(document.querySelector('#healthList b')).toBeNull();
    expect(rowOf('a').querySelector('.ll-health-label').textContent).toBe('<img src=x onerror=alert(1)>');
  });
});

// ── Check now ───────────────────────────────────────────────────────────────────
describe('checking', () => {
  const results = (list) => () => ({ ok: true, siteKey: SITE, results: list });

  it('sends the items, then shows every status with its count and a summary', () => {
    storeWatched({ [SITE]: [W('a'), W('b'), W('c'), W('d'), W('e'), W('f')] });
    h.responders.HEALTH_CHECK = results([
      { id: 'a', status: 'ok', count: 1 },
      { id: 'b', status: 'broken', count: 0 },
      { id: 'c', status: 'ambiguous', count: 3 },
      { id: 'd', status: 'frame-missing', count: 0 },
      { id: 'e', status: 'error', count: 0, error: 'Selector is invalid' },
      { id: 'f', status: 'bogus', count: 1 },
    ]);
    boot();
    openHealth();
    $('healthCheckBtn').click();
    const [msg] = sentOf('HEALTH_CHECK');
    expect(msg.windowId).toBe(WIN);
    expect(msg.items[0]).toEqual({ id: 'a', target: W('a').target, fingerprint: W('a').fingerprint });
    expect(msg.items).toHaveLength(6);
    expect(['a', 'b', 'c', 'd', 'e', 'f'].map(badgeOf)).toEqual([
      '✓ ok',
      '✗ broken',
      '⚠ ambiguous',
      '⧉ frame missing',
      '! error',
      '! error',
    ]);
    const meta = (id) => rowOf(id).querySelector('.ll-health-meta').textContent;
    expect(meta('a')).toBe('Checked just now · matches 1 element');
    expect(meta('b')).toBe('Checked just now · matches nothing');
    expect(meta('c')).toBe('Checked just now · matches 3 elements');
    expect(meta('d')).toBe('Checked just now · its frame is not on the page');
    expect(meta('e')).toBe('Checked just now · error: Selector is invalid');
    expect(meta('f')).toBe('Checked just now · error: The page sent an unreadable result.');
    expect($('healthStatus').textContent).toBe(
      'Checked 6 locators: 1 ok · 1 broken · 1 ambiguous · 1 frame missing · 2 errors.'
    );
    expect($('healthStatus').className).toContain('warn');
    expect($('healthTabBadge').hidden).toBe(false);
    expect($('healthTabBadge').textContent).toBe('5');
    expect($('healthSummary').textContent).toBe('6 watched on this page · 5 need attention');
    expect(site()[1].lastCheck).toMatchObject({ status: 'broken', count: 0 });
    expect(typeof site()[1].lastCheck.at).toBe('number');
  });

  it('reports an all-clear and fades it', () => {
    storeWatched({ [SITE]: [W('a')] });
    h.responders.HEALTH_CHECK = results([{ id: 'a', status: 'ok', count: 1 }]);
    boot();
    openHealth();
    $('healthCheckBtn').click();
    expect($('healthStatus').textContent).toBe('Checked 1 locator: 1 ok.');
    expect($('healthStatus').className).toContain('ok');
    expect($('healthTabBadge').hidden).toBe(true);
    vi.advanceTimersByTime(8000);
    expect($('healthStatus').hidden).toBe(true);
  });

  it('marks a locator the page did not answer for as an error', () => {
    storeWatched({ [SITE]: [W('a'), W('b')] });
    h.responders.HEALTH_CHECK = results([{ id: 'a', status: 'ok', count: 1 }, 'junk', { id: 7 }]);
    boot();
    openHealth();
    $('healthCheckBtn').click();
    expect(badgeOf('b')).toBe('! error');
    expect(rowOf('b').querySelector('.ll-health-meta').textContent).toContain(
      'The page sent no result for this locator.'
    );
  });

  it('offers a suggestion, and using it swaps the locator but keeps the id', () => {
    storeWatched({ [SITE]: [W('a')] });
    const suggestion = {
      target: { kind: 'testid', attr: 'data-testid', value: 'buy-btn' },
      code: "page.getByTestId('buy-btn')",
    };
    h.responders.HEALTH_CHECK = results([{ id: 'a', status: 'broken', count: 0, suggestion }]);
    boot();
    openHealth();
    $('healthCheckBtn').click();
    expect($('healthStatus').textContent).toBe('Checked 1 locator: 1 broken. 1 suggested fix below.');
    const box = rowOf('a').querySelector('.ll-health-suggest');
    expect(box.querySelector('.ll-health-code').textContent).toBe("page.getByTestId('buy-btn')");
    const use = box.querySelector('.ll-health-use');
    expect(use.getAttribute('aria-label')).toBe('Use the suggested locator for button "Buy a"');
    use.click();
    expect(site()[0]).toMatchObject({ id: 'a', target: suggestion.target, code: suggestion.code });
    expect(site()[0].lastCheck).toBeUndefined();
    expect(badgeOf('a')).toBe('• not checked');
    expect(rowOf('a').querySelector('.ll-health-suggest')).toBeNull();
    expect($('healthStatus').textContent).toBe(
      'Locator replaced with the suggestion. Check now to confirm it.'
    );
  });

  it('drops malformed suggestions and never offers one for a healthy locator', () => {
    storeWatched({ [SITE]: [W('a'), W('b'), W('c')] });
    h.responders.HEALTH_CHECK = results([
      { id: 'a', status: 'broken', count: 0, suggestion: { target: 'nope', code: 'x' } },
      { id: 'b', status: 'ok', count: 1, suggestion: { target: { kind: 'id', value: 'x' }, code: 'x' } },
      { id: 'c', status: 'ambiguous', count: 2, suggestion: { target: { kind: 'id', value: 'one' } } },
    ]);
    boot();
    openHealth();
    $('healthCheckBtn').click();
    expect(rowOf('a').querySelector('.ll-health-suggest')).toBeNull();
    expect(rowOf('b').querySelector('.ll-health-suggest')).toBeNull();
    // A suggestion without code gets Playwright code generated from its target.
    expect(site()[2].lastCheck.suggestion.code).toBe(
      LLCodegen.locatorExpr({ kind: 'id', value: 'one' }, 'playwright', 'typescript')
    );
  });

  it('shows the worker error, a silent worker, and a timeout', () => {
    storeWatched({ [SITE]: [W('a')] });
    h.responders.HEALTH_CHECK = () => ({ ok: false, error: 'The health check timed out after 10 s.' });
    boot();
    openHealth();
    $('healthCheckBtn').click();
    expect($('healthStatus').textContent).toBe('The health check timed out after 10 s.');
    expect($('healthStatus').className).toContain('err');
    h.responders.HEALTH_CHECK = () => undefined;
    $('healthCheckBtn').click();
    expect($('healthStatus').textContent).toBe(
      "The extension's background worker didn't answer — try again."
    );
    h.responders.HEALTH_CHECK = () => ({ ok: false });
    $('healthCheckBtn').click();
    expect($('healthStatus').textContent).toBe('The check failed.');
    h.responders.HEALTH_CHECK = () => DEFER;
    $('healthCheckBtn').click();
    expect($('healthCheckBtn').disabled).toBe(true);
    expect($('healthCheckBtn').textContent).toBe('⟳ Checking…');
    $('healthCheckBtn').disabled = false;
    $('healthCheckBtn').click(); // one run at a time
    expect(sentOf('HEALTH_CHECK')).toHaveLength(4);
    vi.advanceTimersByTime(15000);
    expect($('healthStatus').textContent).toBe('No answer from the page — reload it and check again.');
    expect($('healthCheckBtn').textContent).toBe('↻ Check now');
    // A late answer after the timeout changes nothing.
    h.deferred[0].cb({ ok: true, siteKey: SITE, results: [{ id: 'a', status: 'ok', count: 1 }] });
    expect(badgeOf('a')).toBe('• not checked');
  });

  it('discards results from a page that changed mid-check', () => {
    storeWatched({ [SITE]: [W('a')] });
    h.responders.HEALTH_CHECK = () => ({ ok: true, siteKey: 'https://shop.test/other', results: [] });
    boot();
    openHealth();
    $('healthCheckBtn').click();
    expect($('healthStatus').textContent).toBe('The page changed during the check — check again.');
    expect(site()[0].lastCheck).toBeUndefined();
  });

  it('does not apply a result to a locator that changed or appeared during the check', () => {
    storeWatched({ [SITE]: [W('a')] });
    h.responders.HEALTH_CHECK = () => DEFER;
    boot();
    openHealth();
    $('healthCheckBtn').click();
    h.store.llWatched.sites[SITE][0].target = { kind: 'id', value: 'changed' };
    h.store.llWatched.sites[SITE].push(W('new'));
    h.deferred[0].cb({
      ok: true,
      siteKey: SITE,
      results: [
        { id: 'a', status: 'ok', count: 1 },
        { id: 'new', status: 'ok', count: 1 },
      ],
    });
    expect(site()[0].lastCheck).toBeUndefined();
    expect(site()[1].lastCheck).toBeUndefined();
    expect($('healthStatus').textContent).toBe('Nothing left to check on this page.');
  });

  it('says when there is nothing to check, or the page cannot be read', () => {
    storeWatched({ [SITE]: [W('a')] });
    boot();
    openHealth();
    h.responders.GET_ACTIVE_PAGE = () => ({ ok: true, url: 'https://elsewhere.test/' });
    $('healthCheckBtn').click();
    expect($('healthStatus').textContent).toBe('Nothing is watched on this page yet.');
    expect(sentOf('HEALTH_CHECK')).toHaveLength(0);
    h.responders.GET_ACTIVE_PAGE = () => ({ ok: false, error: 'No active tab.' });
    $('healthCheckBtn').disabled = false;
    $('healthCheckBtn').click();
    expect($('healthStatus').textContent).toBe('No active tab.');
    expect($('healthStatus').className).toContain('err');
  });

  it('reports a failure to save the results', () => {
    storeWatched({ [SITE]: [W('a')] });
    h.responders.HEALTH_CHECK = () => {
      h.setError = 'quota';
      return { ok: true, siteKey: SITE, results: [{ id: 'a', status: 'ok', count: 1 }] };
    };
    boot();
    openHealth();
    $('healthCheckBtn').click();
    expect($('healthStatus').textContent).toBe("Checked, but couldn't save the results: quota");
  });

  it('shows how long ago a locator was checked', () => {
    const now = Date.now();
    const lc = (ago) => ({ at: now - ago, status: 'ok', count: 1 });
    storeWatched({
      [SITE]: [
        W('a', { lastCheck: lc(5 * 60000) }),
        W('b', { lastCheck: lc(3 * 3600000) }),
        W('c', { lastCheck: lc(3 * 86400000) }),
        W('d', { lastCheck: { at: now + 60000, status: 'ok', count: 1 } }),
      ],
    });
    boot();
    openHealth();
    const meta = (id) => rowOf(id).querySelector('.ll-health-meta').textContent;
    expect(meta('a')).toBe('Checked 5 min ago · matches 1 element');
    expect(meta('b')).toBe('Checked 3 h ago · matches 1 element');
    expect(meta('c')).toBe(
      `Checked ${new Date(now - 3 * 86400000).toLocaleDateString()} · matches 1 element`
    );
    expect(meta('d')).toContain(new Date(now + 60000).toLocaleString());
    expect(rowOf('a').querySelector('.ll-health-meta').title).toBe(
      new Date(now - 5 * 60000).toLocaleString()
    );
  });
});

// ── Remove / Copy ────────────────────────────────────────────────────────────────
describe('row actions', () => {
  it('Remove drops the row, keeps focus in the list, and lands on Import when empty', () => {
    storeWatched({ [SITE]: [W('a'), W('b')] });
    boot();
    openHealth();
    const remove = rowOf('a').querySelector('.ll-health-remove');
    expect(remove.getAttribute('aria-label')).toBe('Stop watching: button "Buy a"');
    remove.focus();
    remove.click();
    expect(site().map((i) => i.id)).toEqual(['b']);
    expect(document.activeElement).toBe(rowOf('b').querySelector('.ll-health-remove'));
    expect($('healthStatus').textContent).toBe('Removed.');
    rowOf('b').querySelector('.ll-health-remove').click();
    expect(h.store.llWatched.sites).toEqual({});
    expect(document.activeElement).toBe($('healthImportBtn'));
    expect($('healthEmpty').hidden).toBe(false);
  });

  it('Remove of an id that is already gone changes nothing', () => {
    storeWatched({ [SITE]: [W('a')] });
    boot();
    openHealth();
    const btn = rowOf('a').querySelector('.ll-health-remove');
    delete h.store.llWatched; // removed elsewhere meanwhile
    btn.click();
    expect(h.store.llWatched).toBeUndefined();
  });

  it('reports a failed remove / suggestion update', () => {
    const sg = { target: { kind: 'id', value: 'x' }, code: "page.locator('#x')" };
    storeWatched({ [SITE]: [W('a', { lastCheck: { at: 1, status: 'broken', count: 0, suggestion: sg } })] });
    boot();
    openHealth();
    h.setError = 'nope';
    rowOf('a').querySelector('.ll-health-remove').click();
    expect($('healthStatus').textContent).toBe("Couldn't remove it: nope");
    rowOf('a').querySelector('.ll-health-use').click();
    expect($('healthStatus').textContent).toBe("Couldn't update it: nope");
  });

  it('keeps focus on the same control when a re-render replaces it', () => {
    storeWatched({ [SITE]: [W('a'), W('b')] });
    boot();
    openHealth();
    rowOf('b').querySelector('.ll-health-copy').focus();
    fireStorage({ llWatched: { newValue: { version: 1, sites: { [SITE]: [W('a'), W('b')] } } } });
    expect(document.activeElement).toBe(rowOf('b').querySelector('.ll-health-copy'));
  });

  it('a suggestion that vanished meanwhile is not applied', () => {
    const sg = { target: { kind: 'id', value: 'x' }, code: "page.locator('#x')" };
    storeWatched({ [SITE]: [W('a', { lastCheck: { at: 1, status: 'broken', count: 0, suggestion: sg } })] });
    boot();
    openHealth();
    const use = rowOf('a').querySelector('.ll-health-use');
    h.store.llWatched.sites[SITE][0].lastCheck = { at: 2, status: 'ok', count: 1 };
    use.click();
    expect(site()[0].target).toEqual(W('a').target);
  });
});

// ── Export / Import ──────────────────────────────────────────────────────────────
describe('export and import', () => {
  function captureDownloads() {
    const out = [];
    URL.createObjectURL = vi.fn((b) => {
      out.push({ blob: b });
      return 'blob:x';
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(window.HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      out[out.length - 1].name = this.download;
    });
    return out;
  }
  async function importText(text, name = 'w.json') {
    const input = $('healthImportFile');
    const file = new window.File([text], name, { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new window.Event('change'));
    await flush();
    await vi.advanceTimersByTimeAsync(5);
    await flush();
  }

  it('exports every site as JSON', async () => {
    storeWatched({ [SITE]: [W('a')], 'https://docs.test/': [W('d')] });
    const downloads = captureDownloads();
    boot();
    openHealth();
    $('healthExportBtn').click();
    expect(downloads[0].name).toBe('locatra-watched-locators.json');
    const json = JSON.parse(await downloads[0].blob.text());
    expect(json).toEqual({ version: 1, sites: { [SITE]: [W('a')], 'https://docs.test/': [W('d')] } });
    expect($('healthStatus').textContent).toBe('Exported 2 watched locators.');
  });

  it('says when there is nothing to export', () => {
    const downloads = captureDownloads();
    boot();
    $('healthExportBtn').click();
    expect(downloads).toHaveLength(0);
    expect($('healthStatus').textContent).toBe('Nothing to export yet.');
  });

  it('Import opens the file picker', () => {
    boot();
    const click = vi.spyOn($('healthImportFile'), 'click').mockImplementation(() => {});
    $('healthImportBtn').click();
    expect(click).toHaveBeenCalled();
  });

  it('round-trips an export, merging without duplicates', async () => {
    storeWatched({ [SITE]: [W('a')] });
    boot();
    openHealth();
    await importText(
      JSON.stringify({ version: 1, sites: { [SITE]: [W('a'), W('b')], 'https://x.test/p': [W('x')] } })
    );
    expect(site().map((i) => i.id)).toEqual(['a', 'b']);
    expect(site('https://x.test/p').map((i) => i.id)).toEqual(['x']);
    expect($('healthStatus').textContent).toBe('Imported 2 locators. 1 already watched.');
    expect(healthRows()).toHaveLength(2);
    expect($('healthOtherSummary').textContent).toBe('Other sites (1)');
  });

  it('gives an imported locator a new id when its id is taken by a different locator', async () => {
    storeWatched({ [SITE]: [W('a')] });
    boot();
    await importText(
      JSON.stringify({
        version: 1,
        sites: { 'https://x.test/': [W('a', { target: { kind: 'id', value: 'other' } })] },
      })
    );
    const imported = site('https://x.test/')[0];
    expect(imported.id).not.toBe('a');
    expect(imported.target).toEqual({ kind: 'id', value: 'other' });
  });

  it('rejects files that are not JSON or not an export', async () => {
    boot();
    await importText('{nope');
    expect($('healthStatus').textContent).toBe("That file isn't valid JSON.");
    for (const bad of [
      '[]',
      '{"version":2,"sites":{}}',
      '{"version":1}',
      '{"version":1,"sites":[]}',
      'null',
    ]) {
      await importText(bad);
      expect($('healthStatus').textContent, bad).toContain("That isn't a Locatra watched-locators export");
    }
    expect(h.store.llWatched).toBeUndefined();
  });

  it('rejects an oversized file without reading it', async () => {
    boot();
    const input = $('healthImportFile');
    const file = { size: 6 * 1024 * 1024, text: vi.fn() };
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new window.Event('change'));
    expect(file.text).not.toHaveBeenCalled();
    expect($('healthStatus').textContent).toContain('too large');
  });

  it('reports a file that cannot be read', async () => {
    boot();
    const input = $('healthImportFile');
    const file = { size: 10, text: () => Promise.reject(new Error('io')) };
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new window.Event('change'));
    await flush();
    expect($('healthStatus').textContent).toBe("Couldn't read that file.");
  });

  it('falls back to FileReader when File.text is missing', async () => {
    boot();
    const input = $('healthImportFile');
    const real = new window.Blob([JSON.stringify({ version: 1, sites: { [SITE]: [W('a')] } })]);
    const file = { size: real.size }; // no text(): an older File implementation
    const RealReader = window.FileReader;
    window.FileReader = class {
      readAsText() {
        real.text().then((t) => {
          this.result = t;
          this.onload();
        });
      }
    };
    globalThis.FileReader = window.FileReader;
    try {
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new window.Event('change'));
      await flush();
      expect(site().map((i) => i.id)).toEqual(['a']);
      window.FileReader = class {
        readAsText() {
          queueMicrotask(() => this.onerror());
        }
      };
      globalThis.FileReader = window.FileReader;
      input.dispatchEvent(new window.Event('change'));
      await flush();
      expect($('healthStatus').textContent).toBe("Couldn't read that file.");
      window.FileReader = class {
        readAsText() {
          throw new Error('no');
        }
      };
      globalThis.FileReader = window.FileReader;
      input.dispatchEvent(new window.Event('change'));
      expect($('healthStatus').textContent).toBe("Couldn't read that file.");
    } finally {
      window.FileReader = RealReader;
      globalThis.FileReader = RealReader;
    }
  });

  it('ignores a change event without a file', () => {
    boot();
    const input = $('healthImportFile');
    Object.defineProperty(input, 'files', { value: [], configurable: true });
    input.dispatchEvent(new window.Event('change'));
    expect($('healthStatus').hidden).toBe(true);
  });

  it('keeps up to three sanitised altTargets on watched locators (C9)', async () => {
    const file = {
      version: 1,
      sites: {
        'https://shop.example/': [
          {
            id: 'u',
            target: { kind: 'role', role: 'textbox', name: 'Username' },
            altTargets: [
              { kind: 'id', value: 'username' },
              'junk',
              { value: 'no kind' },
              { kind: 'name', value: 'user' },
              { kind: 'css', value: '#username' },
              { kind: 'xpath', value: '//input[@id="username"]' },
            ],
          },
        ],
      },
    };
    boot();
    await importText(JSON.stringify(file));
    const [u] = site('https://shop.example/');
    expect(u.altTargets).toEqual([
      { kind: 'id', value: 'username' },
      { kind: 'name', value: 'user' },
      { kind: 'css', value: '#username' },
    ]);
  });

  it('rebuilds imported code from the target and drops non-integer numeric target fields', async () => {
    const file = {
      version: 1,
      sites: {
        'https://shop.example/': [
          {
            id: 'lv',
            code: "page.locator('x'); require('child_process').exec('rm -rf ~')",
            target: { kind: 'role', role: 'heading', name: 'Cart', level: '1 }); evil(); ({ a: 1' },
          },
          {
            id: 'fr',
            target: {
              kind: 'frame',
              selector: null,
              index: '0); evil(); (0',
              framesIndex: 2,
              child: { kind: 'role', role: 'heading', name: 'Pay', level: 2 },
            },
          },
        ],
      },
    };
    boot();
    await importText(JSON.stringify(file));
    const [lv, fr] = site('https://shop.example/');
    expect(lv.code).not.toMatch(/child_process|evil/);
    expect('level' in lv.target).toBe(false);
    expect('index' in fr.target).toBe(false);
    expect(fr.target.framesIndex).toBe(2);
    expect(fr.target.child.level).toBe(2);
    // aria-level goes past 6 (role="heading" aria-level="7"); only nonsense is dropped.
    const deep = {
      version: 1,
      sites: {
        'https://shop.example/': [
          { id: 'l7', target: { kind: 'role', role: 'heading', name: 'Summary', level: 7 } },
          { id: 'l0', target: { kind: 'role', role: 'heading', name: 'Zero', level: 0 } },
        ],
      },
    };
    await importText(JSON.stringify(deep));
    const byId = Object.fromEntries(site('https://shop.example/').map((i) => [i.id, i]));
    expect(byId.l7.target.level).toBe(7);
    expect('level' in byId.l0.target).toBe(false);
    expect(fr.code).not.toMatch(/evil/);
  });

  it('survives hostile JSON: prototype keys, bad sites, bad items, oversized fields', async () => {
    const huge = 'x'.repeat(5000);
    const nested = {};
    let cur = nested;
    for (let i = 0; i < 40; i++) cur = cur.a = {};
    const hostile = `{
      "version": 1,
      "sites": {
        "__proto__": [{"id": "p", "target": {"kind": "id", "value": "p"}}],
        "javascript:alert(1)": [{"id": "j", "target": {"kind": "id", "value": "j"}}],
        "https://evil.test/?q=1#h": [
          {"id": "../../etc", "label": "${huge}", "code": "${huge}",
           "target": {"kind": "css", "value": "a", "__proto__": {"polluted": true}, "constructor": {"x": 1}},
           "fingerprint": {"tag": "${huge}", "text": "${huge}", "classes": ["a", 1, null, "b", "c", "d", "e", "f"], "evil": "x"},
           "savedAt": "yesterday",
           "lastCheck": {"status": "ok", "at": -5, "count": "many", "error": 42}},
          {"id": "nokind", "target": {"value": "x"}},
          {"id": "notarget"},
          "string item",
          {"id": "deep", "target": {"kind": "css", "value": "x", "deep": ${JSON.stringify(nested)}}},
          {"id": "arr", "target": {"kind": "css", "value": "x", "list": [${Array.from({ length: 100 }, (_, i) => i).join(',')}]}},
          {"id": "inf", "target": {"kind": "css", "value": "y", "n": 1e999}},
          {"id": "bigtarget", "target": {"kind": "css", "value": "z", "a": "${'y'.repeat(1999)}", "b": "${'y'.repeat(1999)}", "c": "${'y'.repeat(1999)}", "d": "${'y'.repeat(1999)}", "e": "${'y'.repeat(1999)}", "f": "${'y'.repeat(1999)}", "g": "${'y'.repeat(1999)}", "h": "${'y'.repeat(1999)}", "i": "${'y'.repeat(1999)}", "j": "${'y'.repeat(1999)}", "k": "${'y'.repeat(1999)}"}}
        ],
        "https://ok.test/": "not an array"
      }
    }`;
    boot();
    await importText(hostile);
    expect(Object.prototype.polluted).toBeUndefined();
    expect({}.polluted).toBeUndefined();
    const keys = Object.keys(h.store.llWatched.sites);
    expect(keys).toEqual(['https://evil.test/']);
    const [first, deep, arr, inf] = site('https://evil.test/');
    expect(first.id).not.toBe('../../etc');
    expect(first.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(first.label).toHaveLength(200);
    // The file's own code text never survives: it is rebuilt from the target.
    expect(first.code).toBe("page.locator('a')");
    expect(first.target).toEqual({ kind: 'css', value: 'a' });
    expect(Object.getPrototypeOf(first.target)).toBe(Object.prototype);
    expect(first.fingerprint.tag).toHaveLength(300);
    expect(first.fingerprint.text).toHaveLength(80);
    expect(first.fingerprint.classes).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(first.fingerprint).not.toHaveProperty('evil');
    expect(typeof first.savedAt).toBe('number');
    expect(first.lastCheck.count).toBe(0);
    expect(first.lastCheck.at).toBeGreaterThan(0);
    expect(first.lastCheck).not.toHaveProperty('error');
    expect(first.lastCheck.error).toBeUndefined();
    expect(deep.id).toBe('deep');
    expect(JSON.stringify(deep.target).length).toBeLessThan(200); // depth-capped
    expect(arr.target.list).toHaveLength(64);
    expect(inf.target).toEqual({ kind: 'css', value: 'y' });
    expect(site('https://evil.test/').map((i) => i.id)).not.toContain('bigtarget');
    expect($('healthStatus').textContent).toBe('Imported 4 locators. 7 invalid entries skipped.');
  });

  it('applies the caps to imports and reports what did not fit', async () => {
    storeWatched({ [SITE]: many(199) });
    boot();
    await importText(JSON.stringify({ version: 1, sites: { [SITE]: many(3, 'n') } }));
    expect(site()).toHaveLength(200);
    expect($('healthStatus').textContent).toBe(
      'Imported 1 locator. 2 over the limit (200 per page, 2000 in total).'
    );
    // A file that is itself over the caps is trimmed on read.
    const sites = {};
    for (let s = 0; s < 11; s++) sites[`https://o${s}.test/`] = many(201, 's' + s + '-');
    h.store = {};
    await importText(JSON.stringify({ version: 1, sites }));
    const total = Object.values(h.store.llWatched.sites).reduce((n, l) => n + l.length, 0);
    expect(total).toBe(2000);
    expect(h.store.llWatched.sites['https://o0.test/']).toHaveLength(200);
    expect($('healthStatus').textContent).toBe('Imported 2000 locators. 211 invalid entries skipped.');
  });

  it('reports a duplicate-only import as a warning and an entry with one invalid item', async () => {
    storeWatched({ [SITE]: [W('a')] });
    boot();
    await importText(JSON.stringify({ version: 1, sites: { [SITE]: [W('a'), { id: 'x' }] } }));
    expect($('healthStatus').textContent).toBe(
      'Imported 0 locators. 1 already watched. 1 invalid entry skipped.'
    );
    expect($('healthStatus').className).toContain('warn');
  });

  it('reports a failure to save an import', async () => {
    boot();
    h.setError = 'quota';
    await importText(JSON.stringify({ version: 1, sites: { [SITE]: [W('a')] } }));
    expect($('healthStatus').textContent).toBe("Couldn't save the imported locators: quota");
  });
});

// ── Auto-check ────────────────────────────────────────────────────────────────────
describe('healthAutoCheck', () => {
  const okAll = (msg) => ({
    ok: true,
    siteKey: SITE,
    results: msg.items.map((i) => ({ id: i.id, status: 'ok', count: 1 })),
  });

  it('checks once when the panel opens on a watched page', () => {
    h.store.llSettings = { healthAutoCheck: true };
    storeWatched({ [SITE]: [W('a')] });
    h.responders.HEALTH_CHECK = okAll;
    boot();
    expect(sentOf('HEALTH_CHECK')).toHaveLength(1);
    expect($('settingHealthAutoCheck').checked).toBe(true);
    expect(site()[0].lastCheck.status).toBe('ok');
    // The same page again (heartbeat while the tab is shown, a reload) is not re-checked.
    openHealth();
    vi.advanceTimersByTime(8000);
    expect(sentOf('HEALTH_CHECK')).toHaveLength(1);
  });

  it('checks again after the active page changes to a watched page', () => {
    h.store.llSettings = { healthAutoCheck: true };
    storeWatched({ [SITE]: [W('a')] });
    h.responders.HEALTH_CHECK = okAll;
    boot();
    h.responders.GET_ACTIVE_PAGE = () => ({ ok: true, url: 'https://unwatched.test/' });
    for (const fn of h.tabsActivated) fn({ windowId: WIN });
    expect(sentOf('HEALTH_CHECK')).toHaveLength(1);
    h.responders.GET_ACTIVE_PAGE = () => ({ ok: true, url: SITE });
    for (const fn of h.tabsActivated) fn({ windowId: WIN });
    expect(sentOf('HEALTH_CHECK')).toHaveLength(2);
  });

  it('never checks on its own when off', () => {
    storeWatched({ [SITE]: [W('a')] });
    boot();
    for (const fn of h.tabsActivated) fn({ windowId: WIN });
    expect(sentOf('HEALTH_CHECK')).toHaveLength(0);
  });

  it('does not check an unwatched page', () => {
    h.store.llSettings = { healthAutoCheck: true };
    storeWatched({ 'https://other.test/': [W('a')] });
    boot();
    expect(sentOf('HEALTH_CHECK')).toHaveLength(0);
  });

  it('the toggle writes the setting (keeping other fields) and checks right away', () => {
    h.store.llSettings = { testIdAttributes: ['data-qa'] };
    storeWatched({ [SITE]: [W('a')] });
    h.responders.HEALTH_CHECK = okAll;
    boot();
    openHealth();
    expect($('settingHealthAutoCheck').checked).toBe(false);
    $('settingHealthAutoCheck').click();
    expect(h.store.llSettings).toEqual({ testIdAttributes: ['data-qa'], healthAutoCheck: true });
    expect(sentOf('HEALTH_CHECK')).toHaveLength(1);
    $('settingHealthAutoCheck').click();
    expect(h.store.llSettings.healthAutoCheck).toBe(false);
    expect(sentOf('HEALTH_CHECK')).toHaveLength(1);
  });

  it('turning it on from the options page checks the current page', () => {
    storeWatched({ [SITE]: [W('a')] });
    h.responders.HEALTH_CHECK = okAll;
    boot();
    expect(sentOf('HEALTH_CHECK')).toHaveLength(0);
    fireStorage({ llSettings: { newValue: { healthAutoCheck: true } } });
    expect(sentOf('HEALTH_CHECK')).toHaveLength(1);
    expect($('settingHealthAutoCheck').checked).toBe(true);
  });
});

// ── Keyboard ──────────────────────────────────────────────────────────────────────
describe('keyboard', () => {
  const key = (el, k) =>
    el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  it('the tab list follows the ARIA tabs pattern (arrows, Home, End; one tab stop)', () => {
    boot();
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => t.getAttribute('aria-controls'))).toEqual([
      'tab-inspector',
      'tab-recorder',
      'tab-health',
    ]);
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual([null, '-1', '-1']);
    expect($('tab-health').getAttribute('role')).toBe('tabpanel');
    expect($('tab-health').getAttribute('aria-labelledby')).toBe('tabBtnHealth');
    tabs[0].focus();
    key(tabs[0], 'ArrowLeft');
    expect(document.activeElement).toBe(tabs[2]);
    expect(tabs[2].getAttribute('aria-selected')).toBe('true');
    expect(tabs[2].getAttribute('tabindex')).toBe('0');
    expect($('tab-health').classList.contains('active')).toBe(true);
    key(tabs[2], 'ArrowRight');
    expect(document.activeElement).toBe(tabs[0]);
    key(tabs[0], 'End');
    expect(document.activeElement).toBe(tabs[2]);
    key(tabs[2], 'Home');
    expect(document.activeElement).toBe(tabs[0]);
    key(tabs[0], 'ArrowRight');
    expect(document.activeElement).toBe(tabs[1]);
    expect($('tab-recorder').classList.contains('active')).toBe(true);
    const ev = new window.KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    tabs[1].dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('every Health control is a labelled native control', () => {
    storeWatched({
      [SITE]: [
        W('a', {
          lastCheck: {
            at: 1,
            status: 'broken',
            count: 0,
            suggestion: { target: { kind: 'id', value: 'x' }, code: 'c' },
          },
        }),
      ],
    });
    boot();
    openHealth();
    const controls = [...$('tab-health').querySelectorAll('button, input')];
    for (const c of controls) {
      const name =
        c.getAttribute('aria-label') ||
        c.textContent.trim() ||
        (c.closest('label') && c.closest('label').textContent.trim());
      expect(name, c.outerHTML).toBeTruthy();
      expect(['BUTTON', 'INPUT']).toContain(c.tagName);
    }
    expect($('healthStatus').getAttribute('role')).toBe('status');
    expect($('healthList').getAttribute('role')).toBe('list');
    expect(healthRows()[0].getAttribute('role')).toBe('listitem');
  });
});

// ── Storage queue ────────────────────────────────────────────────────────────────
describe('llWatched writes', () => {
  it('re-read storage before each change so another panel’s additions survive', () => {
    boot();
    showPick();
    // Another window's panel added one in the meantime (no onChanged yet here).
    storeWatched({ [SITE]: [W('other')] });
    watchBtns()[1].click();
    expect(site().map((i) => i.id)).toEqual(['other', site()[1].id]);
    expect(site()[1].target).toEqual({ kind: 'id', value: 'buy' });
  });

  it('a throwing change is reported and the queue keeps going', () => {
    boot();
    vm.runInThisContext(
      `mutateWatched(() => { throw new Error('bad'); }, (err) => { window.__err = err && err.message; });`
    );
    expect(window.__err).toBe('bad');
    showPick();
    watchBtns()[0].click();
    expect(site()).toHaveLength(1);
  });

  it('a throwing callback does not stall the queue', () => {
    boot();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vm.runInThisContext(`mutateWatched(() => ({ changed: false }), () => { throw new Error('cb'); });`);
    showPick();
    watchBtns()[0].click();
    expect(site()).toHaveLength(1);
  });
});
