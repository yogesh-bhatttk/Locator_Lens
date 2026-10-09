#!/usr/bin/env node
/* global chrome, document, window, location, handleCommand, LLThumbs, LLCodegen */
// Real-browser smoke test for the settings page, the keyboard shortcuts, the
// locator health check and the Edge package (round 3: B, D, E, F).
//
// The unit suites drive options.js in jsdom and the worker against a mocked
// chrome.*. This loads the built extension into Chromium and holds the pieces to
// account where they meet:
//
//   • the settings page edits chrome.storage for real, and the content script on
//     an already-open page follows it: a test-id attribute added (and reordered) on
//     the settings page decides the top locator of the next real pick; a secret
//     variable name decides the env var a recorded password fill is exported with;
//   • export / import / reset / clear-data go through the page's own buttons, a
//     real download and a real file input;
//   • the commands are the manifest's, shown on the settings page and the popup,
//     and the worker's command handler switches inspect and recording on the demo
//     tab and flashes the failure badge on a page Locatra may not touch;
//   • HEALTH_CHECK re-resolves picked locators in every frame of the live page —
//     ok, broken (with a suggestion Playwright resolves to exactly one element),
//     ambiguous, owned by the payment iframe, frame-missing, restricted;
//   • dist/edge is dist/chrome byte for byte, and it loads and runs in Chromium.
//
//   npm run build && node scripts/e2e/smoke-settings.mjs
//
// Needs a display. Uses its own port and profile so it can run alongside the
// other smokes.
//
// Limitation: a real Alt+Shift+E / Alt+Shift+K press is a browser accelerator that
// Playwright's (CDP) keyboard cannot produce — it only reaches the page. The worker
// is a classic script, so its global handleCommand — the very function registered
// with chrome.commands.onCommand — is invoked with the tab the browser would pass.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { computeExtensionId, resolveChromium, until, waitForServiceWorker } from './browsers.mjs';
import { startDemoServer } from './demo-server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXTENSION = join(ROOT, 'dist/chrome');
const EDGE = join(ROOT, 'dist/edge');
const PORT = 4183;
const profile = join(ROOT, '.tmp-smoke-settings-profile');

const SHORTCUTS = { 'toggle-inspect': 'Alt+Shift+E', 'toggle-recording': 'Alt+Shift+K' };
const RESTRICTED_RE = /can't run on this page/i;
const DEFAULT_SETTINGS = {
  autoAssertions: true,
  stepScreenshots: true,
  testIdAttributes: [],
  secretNames: { password: 'LOCATRA_PASSWORD', secret: 'LOCATRA_SECRET' },
  variables: true,
  healthAutoCheck: false,
};
const SECTIONS = ['locators', 'output', 'recorder', 'health', 'shortcuts', 'data', 'about'];

const results = [];
let failures = 0;

function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures++;
  results.push({ ok, name, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail && !ok ? `\n      ${detail}` : ''}`);
  return ok;
}

/** Wait for a condition; true if it held in time, false if not (check() reports it). */
const waitFor = (fn, what, timeout = 8000) =>
  until(fn, { timeout, what }).then(
    () => true,
    () => false
  );

const json = (v) => JSON.stringify(v);
/** JSON with object keys sorted (chrome.storage does not keep insertion order). */
const canon = (v) =>
  JSON.stringify(v, (k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((key) => [key, x[key]])
        )
      : x
  );

function launch(executablePath, extensionPath) {
  rmSync(profile, { recursive: true, force: true });
  return chromium.launchPersistentContext(profile, {
    executablePath,
    headless: false,
    acceptDownloads: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
}

/** Every file under `dir`, relative to it, sorted. */
function tree(dir) {
  const out = [];
  const walk = (p) => {
    if (statSync(p).isDirectory()) for (const c of readdirSync(p).sort()) walk(join(p, c));
    else out.push(relative(dir, p));
  };
  walk(dir);
  return out;
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function main() {
  for (const dir of [EXTENSION, EDGE]) {
    if (!existsSync(join(dir, 'manifest.json'))) {
      throw new Error(`${relative(ROOT, dir)} missing — run \`npm run build\` first.`);
    }
  }
  const executablePath = resolveChromium();
  if (!executablePath)
    throw new Error('No Playwright Chromium found. Run `npx playwright install chromium`.');

  const server = await startDemoServer({ port: PORT });
  try {
    await chromePhase(executablePath, server);
    await edgePhase(executablePath, server);
  } finally {
    await server.close();
    rmSync(profile, { recursive: true, force: true });
  }

  const passed = results.length - failures;
  console.log(`\n${failures ? '✗' : '✓'} ${passed}/${results.length} checks passed`);
  if (failures) process.exit(1);
}

// ════════════════════════════════════════════════════════════════════════════
//  dist/chrome: settings page, shortcuts, health check
// ════════════════════════════════════════════════════════════════════════════

async function chromePhase(executablePath, server) {
  const DEMO = `${server.base}/checkout`;
  const context = await launch(executablePath, EXTENSION);
  try {
    const extensionId = computeExtensionId(EXTENSION);
    const origin = `chrome-extension://${extensionId}`;
    const OPTIONS_URL = `${origin}/src/options.html`;

    // Console errors and uncaught exceptions of the settings page under test (the
    // "#hub" copy below is plumbing and not judged).
    const optionsErrors = [];
    const isOptionsPage = (p) => Boolean(p) && p.url().startsWith(OPTIONS_URL) && !p.url().includes('#hub');
    context.on('console', (m) => {
      if (m.type() === 'error' && isOptionsPage(m.page())) optionsErrors.push(m.text());
    });
    context.on('weberror', (e) => {
      if (isOptionsPage(e.page())) optionsErrors.push(String(e.error()?.message ?? e.error()));
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
    await page.goto(DEMO, { waitUntil: 'load' });

    const worker = await waitForServiceWorker(context, extensionId);
    check('extension loads and the service worker is running', Boolean(worker));
    if (!worker) throw new Error('no service worker — nothing further can be driven');

    const store = (keys) => worker.evaluate((k) => chrome.storage.local.get(k), keys);
    const lastPick = async () => (await store('lastElement')).lastElement;

    /**
     * A tab as chrome.tabs sees it (what chrome.commands.onCommand passes): the active
     * tab of the window — without the "tabs" permission tab.url is hidden for pages
     * Locatra has no host access to (about:blank), so tabs are found by being active.
     */
    const activeTab = async (p) => {
      await p.bringToFront();
      return worker.evaluate(
        async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] ?? null
      );
    };

    const contentScriptReady = () =>
      waitFor(
        () =>
          worker.evaluate(async (port) => {
            const tabs = await chrome.tabs.query({});
            const t = tabs.find((x) => (x.url || '').includes(`:${port}/`));
            if (!t) return false;
            return chrome.tabs
              .sendMessage(t.id, { type: 'PING' }, { frameId: 0 })
              .then(() => true)
              .catch((e) => !/Receiving end does not exist/i.test(String(e?.message ?? e)));
          }, PORT),
        'content script in the demo page',
        10_000
      );
    check('the content script is running in the demo page', await contentScriptReady());

    // ── seed what an earlier version left behind (before the settings page opens) ─
    await worker.evaluate(() =>
      chrome.storage.local.set({
        customAttributes: ['data-legacy-id', 'DATA-EXISTING', 'not valid', 7],
        llSettings: { testIdAttributes: ['data-existing'], futureOption: 'kept' },
      })
    );

    // ── popup: shortcut hints, and the ⚙ Settings link opens the settings page ──
    console.log('\npopup');
    const popup = await context.newPage();
    await popup.goto(`${origin}/src/popup.html`, { waitUntil: 'load' });
    const hint = (id) =>
      popup.evaluate((i) => {
        const el = document.getElementById(i);
        return el ? { text: el.textContent.trim(), hidden: el.hidden } : null;
      }, id);
    await waitFor(async () => (await hint('inspectKey'))?.hidden === false, 'the popup shortcut hints');
    const inspectHint = await hint('inspectKey');
    const recordHint = await hint('recordKey');
    check(
      `the popup shows ${SHORTCUTS['toggle-inspect']} next to Inspect`,
      inspectHint?.text === SHORTCUTS['toggle-inspect'] && !inspectHint.hidden,
      json(inspectHint)
    );
    check(
      `the popup shows ${SHORTCUTS['toggle-recording']} next to Record`,
      recordHint?.text === SHORTCUTS['toggle-recording'] && !recordHint.hidden,
      json(recordHint)
    );

    await popup.click('#settingsBtn');
    // The tab starts as about:blank and becomes the options page: wait for the URL.
    const optionsTab = () => context.pages().find((p) => p.url().startsWith(OPTIONS_URL)) ?? null;
    await waitFor(async () => Boolean(optionsTab()), 'the settings tab');
    const opts = optionsTab();
    check('⚙ Settings in the popup opens the settings page in a tab', Boolean(opts));
    if (!opts) throw new Error('the settings page did not open');
    await popup.close().catch(() => {});
    await opts.waitForLoadState('load');
    await opts.evaluate(() => window.__LocatraOptions?.ready);
    await opts.bringToFront();

    let dialogMode = 'accept';
    const dialogs = [];
    opts.on('dialog', (d) => {
      dialogs.push(d.message());
      (dialogMode === 'accept' ? d.accept() : d.dismiss()).catch(() => {});
    });

    const text = (sel) => opts.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);
    const status = () => text('#saveStatus');
    const settingsNow = async () => (await store('llSettings')).llSettings;

    // ── settings page: structure ───────────────────────────────────────────────
    console.log('\nsettings page');
    const sections = await opts.evaluate(
      (ids) =>
        ids.map((id) => {
          const s = document.getElementById(id);
          const h = s && s.querySelector('h2');
          const r = h ? h.getBoundingClientRect() : null;
          return {
            id,
            present: Boolean(s),
            heading: h ? h.textContent.trim() : '',
            visible: !!r && r.height > 0,
          };
        }),
      SECTIONS
    );
    for (const s of sections) {
      check(
        `section “${s.id}” is present with a visible heading`,
        s.present && s.heading && s.visible,
        json(s)
      );
    }
    const manifestVersion = JSON.parse(readFileSync(join(EXTENSION, 'manifest.json'), 'utf8')).version;
    check(
      'About shows the manifest version',
      (await text('#aboutVersion')) === manifestVersion,
      await text('#aboutVersion')
    );
    const unlabelled = await opts.evaluate(() =>
      Array.from(document.querySelectorAll('main input:not([type=file]), main select'))
        .filter((el) => !(el.labels && el.labels.length) && !el.getAttribute('aria-label'))
        .filter((el) => !el.getAttribute('aria-labelledby'))
        .map((el) => el.id || el.outerHTML.slice(0, 60))
    );
    check('every input and select is labelled', unlabelled.length === 0, unlabelled.join(', '));

    // ── legacy customAttributes migration ──────────────────────────────────────
    console.log('\nlegacy migration');
    await waitFor(async () => !('customAttributes' in (await store(null))), 'the legacy key to be removed');
    const migrated = await store(null);
    check('the legacy customAttributes key is removed', !('customAttributes' in migrated));
    check(
      'valid legacy names are appended (lower-cased, de-duplicated, invalid ones dropped)',
      json(migrated.llSettings?.testIdAttributes) === json(['data-existing', 'data-legacy-id']),
      json(migrated.llSettings?.testIdAttributes)
    );
    check(
      'llSettings fields the page does not know are kept',
      migrated.llSettings?.futureOption === 'kept',
      json(migrated.llSettings)
    );
    check(
      'the page says what it migrated',
      await opts.evaluate(() => {
        const n = document.getElementById('migrationNotice');
        return !n.hidden && /Moved 1 attribute/.test(n.textContent);
      }),
      await text('#migrationNotice')
    );

    // ── test-id attribute editor ──────────────────────────────────────────────
    console.log('\ntest-id attributes');
    const attrsNow = async () => (await settingsNow())?.testIdAttributes ?? null;
    const listed = () => opts.$$eval('#testAttrList .attr-name', (els) => els.map((e) => e.textContent));
    async function addAttr(name) {
      await opts.fill('#testAttrInput', name);
      await opts.click('#testAttrAddBtn');
    }

    await addAttr('data-qa-id');
    check(
      'Add saves data-qa-id to llSettings.testIdAttributes',
      await waitFor(async () => (await attrsNow())?.includes('data-qa-id'), 'data-qa-id in storage'),
      json(await attrsNow())
    );
    check('“Saved” is announced', /Added data-qa-id/.test((await status()) ?? ''), await status());
    check(
      'the status region is a polite live region',
      await opts.evaluate(() => document.getElementById('saveStatus').getAttribute('aria-live') === 'polite')
    );

    const before = json(await attrsNow());
    const BAD = [
      { name: '9starts-with-digit', why: /not a valid attribute name/ },
      { name: 'has space', why: /not a valid attribute name/ },
      { name: '<img src=x onerror=window.__pwned=1>', why: /not a valid attribute name/ },
      { name: 'data-ll-own', why: /own data-ll-/ },
      { name: 'DATA-QA-ID', why: /already in your list/ },
    ];
    for (const bad of BAD) {
      await addAttr(bad.name);
      const err = await text('#testAttrError');
      const invalid = await opts.getAttribute('#testAttrInput', 'aria-invalid');
      check(
        `“${bad.name}” is refused with an error`,
        bad.why.test(err ?? '') && invalid === 'true',
        `error=${json(err)} aria-invalid=${invalid}`
      );
      if (bad.name.includes('<')) {
        check(
          'the error shows the markup as text (no element, no handler ran)',
          (err ?? '').includes(bad.name) &&
            (await opts.evaluate(
              () => document.querySelector('#testAttrError *') === null && window.__pwned === undefined
            )),
          json(err)
        );
      }
    }
    await opts.fill('#testAttrInput', '');
    check('typing clears the error', ((await text('#testAttrError')) ?? '') === '');

    await addAttr('data-hook');
    await waitFor(async () => (await attrsNow())?.includes('data-hook'), 'data-hook in storage');
    check(
      'refused names never reached storage',
      json((await attrsNow()).filter((a) => a !== 'data-hook')) === before,
      json(await attrsNow())
    );

    await opts.click('#testAttrList [aria-label="Move data-hook up"]');
    check(
      'Move up reorders the stored list',
      await waitFor(
        async () =>
          json(await attrsNow()) === json(['data-existing', 'data-legacy-id', 'data-hook', 'data-qa-id']),
        'the reorder'
      ),
      json(await attrsNow())
    );
    await opts.click('#testAttrList [aria-label="Remove data-existing"]');
    await opts.click('#testAttrList [aria-label="Remove data-legacy-id"]');
    check(
      'Remove deletes from the stored list',
      await waitFor(async () => json(await attrsNow()) === json(['data-hook', 'data-qa-id']), 'the removals'),
      json(await attrsNow())
    );
    check('the editor lists what is stored', json(await listed()) === json(['data-hook', 'data-qa-id']));
    const priority = await opts.$$eval('#attrPriority li', (els) => els.map((e) => e.textContent));
    check(
      'the priority preview puts custom attributes before the built-ins',
      priority[0] === 'data-hook' && priority[1] === 'data-qa-id' && priority.includes('data-testid'),
      json(priority)
    );
    check(
      'the up button of the first row is disabled',
      await opts.evaluate(() => document.querySelector('#testAttrList [data-action="up"]').disabled === true)
    );

    // ── the content script follows (it was loaded before any of this) ─────────
    // A plumbing page in the demo's window: it relays the panel's messages the way
    // the side panel does, and listens on the panel port for what the worker pushes.
    const hub = await context.newPage();
    await hub.goto(`${OPTIONS_URL}#hub`, { waitUntil: 'load' });
    const windowId = await hub.evaluate(async () => (await chrome.windows.getCurrent()).id);
    await hub.evaluate((wid) => {
      window.__smoke = { msgs: [] };
      const port = chrome.runtime.connect({ name: 'll-sidepanel' });
      port.onMessage.addListener((m) => window.__smoke.msgs.push(m));
      port.postMessage({ type: 'PANEL_HELLO', windowId: wid });
      window.__smoke.port = port;
      window.__smoke.storage = [];
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.llSettings) window.__smoke.storage.push(changes.llSettings.newValue);
      });
    }, windowId);
    const send = (msg) =>
      hub.evaluate(
        (m) =>
          new Promise((ok) =>
            chrome.runtime.sendMessage(m, (r) => {
              void chrome.runtime.lastError;
              ok(r ?? null);
            })
          ),
        { windowId, ...msg }
      );
    const hubMsgs = () => hub.evaluate(() => window.__smoke.msgs);
    const msgCount = async () => (await hubMsgs()).length;
    /** The first port message after index `from` that satisfies `pred`, or null. */
    async function awaitMsg(from, pred, what, timeout = 8000) {
      let found = null;
      await waitFor(
        async () => {
          found = (await hubMsgs()).slice(from).find(pred) ?? null;
          return Boolean(found);
        },
        what,
        timeout
      );
      return found;
    }

    /** Pick `selector` (in the iframe `frameSel`, if given) through the real inspect flow. */
    async function pick(selector, matches, { frameSel = null } = {}) {
      await worker.evaluate(() => chrome.storage.local.remove('lastElement'));
      await page.bringToFront();
      await send({ type: 'START_INSPECT' });
      const scope = frameSel ? page.frameLocator(frameSel) : page;
      await scope
        .locator(frameSel ? '#ll-styles, #ll-overlay' : '#ll-overlay')
        .first()
        .waitFor({ state: 'attached', timeout: 5000 })
        .catch(() => {});
      await scope.locator(selector).click();
      await waitFor(async () => matches(await lastPick()), `the pick of ${selector}`);
      const picked = await lastPick();
      await send({ type: 'STOP_INSPECT' });
      await waitFor(
        () =>
          page
            .locator('#ll-overlay')
            .count()
            .then((n) => n === 0),
        'inspect to stop'
      );
      return picked;
    }

    console.log('\nthe content script uses the configured attributes');
    await page.evaluate(() => {
      document.getElementById('email').setAttribute('data-qa-id', 'qa-email');
      const phone = document.getElementById('phone');
      phone.setAttribute('data-qa-id', 'qa-phone');
      phone.setAttribute('data-hook', 'hook-phone');
    });
    let picked = await pick('#email', (p) => p?.elementData?.id === 'email');
    let top = picked?.locators?.[0];
    check(
      'a custom attribute outranks the built-in data-testid',
      top?.target?.kind === 'testid' && top.target.attr === 'data-qa-id' && top.target.value === 'qa-email',
      json(top?.target)
    );
    check(
      "the top locator is page.locator('[data-qa-id=…]')",
      /locator\('\[data-qa-id="qa-email"\]'\)/.test(top?.code ?? ''),
      top?.code
    );
    check(
      'the top locator resolves to exactly the picked element',
      (await page.locator('[data-qa-id="qa-email"]').count()) === 1 && top?.unique === true
    );
    picked = await pick('#phone', (p) => p?.elementData?.id === 'phone');
    check(
      'with data-hook first, an element carrying both uses data-hook',
      picked?.locators?.[0]?.target?.attr === 'data-hook',
      json(picked?.locators?.[0]?.target)
    );
    await opts.bringToFront();
    await opts.click('#testAttrList [aria-label="Move data-qa-id up"]');
    await waitFor(async () => (await attrsNow())?.[0] === 'data-qa-id', 'data-qa-id first');
    picked = await pick('#phone', (p) => p?.elementData?.id === 'phone');
    check(
      'reordering on the settings page changes the next pick live',
      picked?.locators?.[0]?.target?.attr === 'data-qa-id',
      json(picked?.locators?.[0]?.target)
    );
    check(
      'the pick carries the element fingerprint (with the configured test attribute)',
      picked?.elementData?.fingerprint?.testAttr === 'data-qa-id' &&
        picked.elementData.fingerprint.testId === 'qa-phone',
      json(picked?.elementData?.fingerprint)
    );

    // ── default framework / language ──────────────────────────────────────────
    console.log('\noutput');
    await opts.bringToFront();
    const available = await opts.evaluate(() =>
      (LLCodegen.FRAMEWORKS || []).map((f) => ({
        id: f.id,
        langs: LLCodegen.languagesFor(f.id).map((l) => l.id),
      }))
    );
    const optionValues = (sel) => opts.$$eval(`${sel} option`, (os) => os.map((o) => o.value));
    check(
      'the framework select lists LLCodegen.FRAMEWORKS',
      json(await optionValues('#outFramework')) === json(available.map((f) => f.id)),
      `${json(await optionValues('#outFramework'))} vs ${json(available.map((f) => f.id))}`
    );
    const ids = available.map((f) => f.id);
    const pwLangs = available.find((f) => f.id === 'playwright')?.langs ?? [];
    const seleniumLangs = available.find((f) => f.id === 'selenium')?.langs ?? [];
    console.log(
      `    (modules present: webdriverio=${ids.includes('webdriverio')} java=${pwLangs.includes('java')} csharp=${pwLangs.includes('csharp')})`
    );
    const outputOk = [];
    for (const fw of available) {
      await opts.selectOption('#outFramework', fw.id);
      const langOptions = await optionValues('#outLanguage');
      const okList = json(langOptions) === json(fw.langs);
      for (const lang of fw.langs) {
        await opts.selectOption('#outLanguage', lang);
        const saved = await waitFor(async () => {
          const s = await store(['llFramework', 'llLanguage']);
          return s.llFramework === fw.id && s.llLanguage === lang;
        }, `${fw.id}/${lang} in storage`);
        const sample = await text('#outPreview');
        outputOk.push({ pair: `${fw.id}/${lang}`, ok: saved && okList && sample && sample !== '—' });
      }
    }
    const badPairs = outputOk.filter((o) => !o.ok).map((o) => o.pair);
    check(
      `every framework/language pair (${outputOk.length}) is offered and lands in llFramework/llLanguage`,
      badPairs.length === 0 && outputOk.length > 0,
      badPairs.join(', ')
    );
    if (ids.includes('webdriverio')) {
      check(
        'WebdriverIO is offered with TypeScript and JavaScript',
        json(
          available
            .find((f) => f.id === 'webdriverio')
            .langs.slice()
            .sort()
        ) === json(['javascript', 'typescript'])
      );
    }
    if (pwLangs.includes('java') || seleniumLangs.includes('java'))
      check(
        'Java is offered for Playwright and Selenium',
        pwLangs.includes('java') && seleniumLangs.includes('java')
      );
    if (pwLangs.includes('csharp') || seleniumLangs.includes('csharp'))
      check(
        'C# is offered for Playwright and Selenium',
        pwLangs.includes('csharp') && seleniumLangs.includes('csharp')
      );
    await opts.selectOption('#outFramework', 'selenium');
    await opts.selectOption('#outLanguage', 'python');
    await waitFor(
      async () => (await store('llLanguage')).llLanguage === 'python',
      'selenium/python in storage'
    );

    // ── secret variable names → recorded password fill ────────────────────────
    console.log('\nsecret variable names');
    const secretSaves = async () =>
      (await hub.evaluate(() => window.__smoke.storage)).map((s) => s?.secretNames ?? null);
    for (const [value, why] of [
      ['1BAD', /not starting with a digit/],
      ['MY-PASSWORD', /letters, digits/],
      ['LOCATRA_SECRET', /different name/],
    ]) {
      await opts.fill('#secretPassword', value);
      const err = await text('#secretPasswordError');
      check(
        `secret name “${value}” is refused`,
        why.test(err ?? '') && (await opts.getAttribute('#secretPassword', 'aria-invalid')) === 'true',
        json(err)
      );
    }
    await opts.fill('#secretPassword', 'MY_APP_PASSWORD');
    await opts.fill('#secretSecret', 'MY_OTP');
    await opts.locator('#secretSecret').blur();
    check(
      'valid secret names are saved',
      await waitFor(async () => {
        const s = await settingsNow();
        return s?.secretNames?.password === 'MY_APP_PASSWORD' && s.secretNames.secret === 'MY_OTP';
      }, 'the secret names in storage'),
      json((await settingsNow())?.secretNames)
    );
    const savedNames = await secretSaves();
    check(
      'no refused name was ever written to storage',
      savedNames.every((n) => !n || ['LOCATRA_PASSWORD', 'MY_APP_PASSWORD'].includes(n.password)),
      json(savedNames)
    );

    await page.evaluate(() => {
      const form = document.getElementById('checkout-form') || document.body;
      const wrap = document.createElement('div');
      wrap.innerHTML =
        '<label>Smoke password <input type="password" id="smoke-pw" name="smokePw"></label>' +
        '<label>Smoke code <input type="text" id="smoke-otp" name="smokeOtp" autocomplete="one-time-code"></label>';
      form.prepend(wrap);
    });
    await page.bringToFront();
    let from = await msgCount();
    await send({ type: 'START_RECORDING' });
    const started = await awaitMsg(
      from,
      (m) => m.type === 'RECORDING_STATE' && m.windowId === windowId && m.active === true,
      'RECORDING_STATE active'
    );
    check('recording started (RECORDING_STATE reached the panel port)', Boolean(started));
    from = await msgCount();
    await page.fill('#smoke-pw', 'hunter2-secret');
    await page.fill('#smoke-otp', '991122');
    await page.locator('#smoke-otp').blur();
    await waitFor(async () => {
      const ms = (await hubMsgs()).slice(from).filter((m) => m.type === 'RECORDED_ACTION');
      return (
        ms.some((m) => m.data?.secretName === 'MY_APP_PASSWORD') &&
        ms.some((m) => m.data?.secretName === 'MY_OTP')
      );
    }, 'both sensitive fills');
    const recorded = (await hubMsgs())
      .slice(from)
      .filter((m) => m.type === 'RECORDED_ACTION' && m.data?.action === 'fill')
      .map((m) => m.data);
    const pw = recorded.find((d) => d.secretName === 'MY_APP_PASSWORD');
    const otp = recorded.find((d) => d.secretName === 'MY_OTP');
    check(
      'the password fill carries secretName = the configured password name',
      pw && pw.sensitive === true && pw.value === '',
      json(recorded.map((d) => ({ secretName: d.secretName, sensitive: d.sensitive, target: d.target })))
    );
    check('the one-time-code fill carries secretName = the configured secret name', otp?.sensitive === true);
    check(
      'the typed secrets never leave the page',
      !json(recorded).includes('hunter2') && !json(recorded).includes('991122')
    );
    check(
      'the recorded step fills process.env.MY_APP_PASSWORD',
      /\.fill\(process\.env\.MY_APP_PASSWORD \?\? ''\)/.test(pw?.fullCode ?? ''),
      pw?.fullCode
    );
    from = await msgCount();
    await send({ type: 'STOP_RECORDING' });
    check(
      'recording stopped (RECORDING_STATE inactive)',
      Boolean(
        await awaitMsg(from, (m) => m.type === 'RECORDING_STATE' && m.active === false, 'RECORDING_STATE off')
      )
    );
    if (pw && otp) {
      const scripts = await hub.evaluate(
        (steps) => {
          const out = [];
          for (const f of LLCodegen.FRAMEWORKS) {
            for (const l of LLCodegen.languagesFor(f.id)) {
              let code = '';
              try {
                code = LLCodegen.testScript(steps, f.id, l.id, { variables: true });
              } catch (e) {
                code = `THREW ${e.message}`;
              }
              out.push({ pair: `${f.id}/${l.id}`, code });
            }
          }
          return out;
        },
        [pw, otp]
      );
      const missing = scripts.filter(
        (s) =>
          !s.code.includes('MY_APP_PASSWORD') || !s.code.includes('MY_OTP') || /hunter2|991122/.test(s.code)
      );
      check(
        `every generated script (${scripts.length} targets) reads MY_APP_PASSWORD / MY_OTP from the environment`,
        missing.length === 0,
        missing.map((s) => `${s.pair}: ${s.code.slice(0, 160)}`).join(' | ')
      );
      const ts = scripts.find((s) => s.pair === 'playwright/typescript')?.code ?? '';
      check(
        "Playwright TS fills process.env.MY_APP_PASSWORD ?? ''",
        /\.fill\(process\.env\.MY_APP_PASSWORD \?\? ''\)/.test(ts),
        ts.slice(0, 400)
      );
    }

    // ── export ─────────────────────────────────────────────────────────────────
    console.log('\nexport / import / reset');
    await opts.bringToFront();
    const downloadP = opts.waitForEvent('download', { timeout: 8000 });
    await opts.click('#exportBtn');
    const download = await downloadP.catch(() => null);
    let exported = null;
    try {
      exported = JSON.parse(readFileSync(await download.path(), 'utf8'));
    } catch {
      exported = null;
    }
    const stored = await store(['llSettings', 'llFramework', 'llLanguage']);
    check(
      'Export downloads locatra-settings.json',
      download?.suggestedFilename() === 'locatra-settings.json'
    );
    check(
      'the export is valid JSON with what is stored',
      exported?.format === 'locatra-settings' &&
        exported.version === 1 &&
        exported.extensionVersion === manifestVersion &&
        json(exported.llSettings.testIdAttributes) === json(stored.llSettings.testIdAttributes) &&
        json(exported.llSettings.secretNames) === json(stored.llSettings.secretNames) &&
        exported.llFramework === 'selenium' &&
        exported.llLanguage === 'python',
      json(exported)
    );

    // ── hostile imports are refused, escaped, and change nothing ───────────────
    async function importText(name, body) {
      await opts.evaluate(() => {
        document.getElementById('importErrorBox').hidden = true;
        document.getElementById('saveStatus').textContent = '';
      });
      await opts.setInputFiles('#importInput', {
        name,
        mimeType: 'application/json',
        buffer: Buffer.from(body),
      });
      await waitFor(async () => /import/i.test((await status()) ?? ''), `the import of ${name} to finish`);
      return {
        status: await status(),
        boxShown: await opts.evaluate(() => !document.getElementById('importErrorBox').hidden),
        errors: await opts.$$eval('#importErrors li', (els) => els.map((e) => e.textContent)),
      };
    }
    const snapshot = async () => json(await store(['llSettings', 'llFramework', 'llLanguage']));
    const beforeImport = await snapshot();
    const HOSTILE = [
      {
        name: 'hostile.json',
        body:
          '{"format":"locatra-settings","version":1,"__proto__":{"polluted":"yes"},' +
          '"llSettings":{"__proto__":{"polluted":"yes"},"autoAssertions":"yes",' +
          '"testIdAttributes":["<img src=x onerror=window.__pwned=1>",5],' +
          '"secretNames":{"password":"<b>bold</b>","secret":"x y"},"constructor":{"prototype":{"polluted":"yes"}}},' +
          '"llFramework":"<script>window.__pwned=2</script>"}',
        expect: [/autoAssertions/, /<img src=x/, /<b>bold<\/b>/, /<script>/],
      },
      { name: 'not-json.json', body: '{ this is not json', expect: [/not valid JSON/] },
      {
        name: 'proto-only.json',
        body: '{"__proto__":{"autoAssertions":false}}',
        expect: [/does not contain Locatra/],
      },
      { name: 'array.json', body: '[1,2,3]', expect: [/JSON object/] },
      {
        name: 'too-many.json',
        body: json({ llSettings: { testIdAttributes: Array.from({ length: 21 }, (_, i) => `data-a${i}`) } }),
        expect: [/at most 20/],
      },
    ];
    for (const h of HOSTILE) {
      const r = await importText(h.name, h.body);
      const all = r.errors.join('\n');
      check(
        `import of ${h.name} is refused with its errors listed`,
        r.boxShown && /Import failed/.test(r.status ?? '') && h.expect.every((re) => re.test(all)),
        `${json(r.status)} ${json(r.errors)}`
      );
    }
    check(
      'imported markup stays text: no element, no script ran, no prototype polluted',
      await opts.evaluate(
        () =>
          document.querySelector('#importErrors img, #importErrors b, #importErrors script') === null &&
          document.querySelector('img[src="x"]') === null &&
          window.__pwned === undefined &&
          {}.polluted === undefined &&
          Object.prototype.polluted === undefined
      )
    );
    check('refused imports changed nothing in storage', (await snapshot()) === beforeImport);

    const VALID = {
      format: 'locatra-settings',
      version: 1,
      llSettings: {
        autoAssertions: false,
        stepScreenshots: true,
        testIdAttributes: ['data-imported', 'Data-Second'],
        secretNames: { password: 'IMPORTED_PW', secret: 'IMPORTED_SECRET' },
        variables: false,
        healthAutoCheck: true,
      },
      llFramework: 'playwright',
      llLanguage: 'javascript',
    };
    const okImport = await importText('valid.json', json(VALID));
    check(
      'a valid file is imported',
      /Settings imported/.test(okImport.status ?? '') && !okImport.boxShown,
      json(okImport)
    );
    const afterImport = await store(['llSettings', 'llFramework', 'llLanguage']);
    check(
      'the imported settings are in storage',
      canon(afterImport.llSettings) ===
        canon({ ...VALID.llSettings, testIdAttributes: ['data-imported', 'data-second'] }) &&
        afterImport.llFramework === 'playwright' &&
        afterImport.llLanguage === 'javascript',
      json(afterImport)
    );
    const ui = await opts.evaluate(() => ({
      auto: document.getElementById('setAutoAssertions').checked,
      vars: document.getElementById('setVariables').checked,
      health: document.getElementById('setHealthAutoCheck').checked,
      fw: document.getElementById('outFramework').value,
      lang: document.getElementById('outLanguage').value,
      pw: document.getElementById('secretPassword').value,
      attrs: Array.from(document.querySelectorAll('#testAttrList .attr-name')).map((e) => e.textContent),
    }));
    check(
      'the page shows the imported settings',
      !ui.auto &&
        !ui.vars &&
        ui.health &&
        ui.fw === 'playwright' &&
        ui.lang === 'javascript' &&
        ui.pw === 'IMPORTED_PW' &&
        json(ui.attrs) === json(['data-imported', 'data-second']),
      json(ui)
    );

    // ── reset ──────────────────────────────────────────────────────────────────
    dialogMode = 'dismiss';
    const preReset = await snapshot();
    await opts.click('#resetBtn');
    await waitFor(async () => dialogs.length > 0, 'the confirm dialog');
    check(
      'Reset asks for confirmation',
      /Reset every Locatra setting/.test(dialogs.at(-1) ?? ''),
      dialogs.at(-1)
    );
    check('cancelling the confirm keeps the settings', (await snapshot()) === preReset);
    dialogMode = 'accept';
    await opts.click('#resetBtn');
    check(
      'Reset to defaults writes the defaults',
      await waitFor(async () => {
        const s = await store(['llSettings', 'llFramework', 'llLanguage']);
        return (
          canon(s.llSettings) === canon(DEFAULT_SETTINGS) &&
          s.llFramework === 'playwright' &&
          s.llLanguage === 'typescript'
        );
      }, 'the defaults in storage'),
      await snapshot()
    );
    check(
      'the page shows the defaults',
      await opts.evaluate(
        () =>
          document.getElementById('setAutoAssertions').checked &&
          document.getElementById('secretPassword').value === 'LOCATRA_PASSWORD' &&
          document.querySelectorAll('#testAttrList li').length === 0
      )
    );

    // ── data: timelines, screenshots, watched locators ─────────────────────────
    console.log('\ndata');
    await worker.evaluate(() =>
      chrome.storage.local.set({
        llRecorderState: { actions: [] },
        'llRecorderState:4242': { actions: [] },
        llRecorderStateOther: 'not a timeline',
        llWatched: {
          version: 1,
          sites: {
            'http://example.test/a': [{ id: 'w1' }, { id: 'w2' }],
            'http://example.test/b': [{ id: 'w3' }],
          },
        },
      })
    );
    check(
      'the counts follow storage live',
      await waitFor(
        async () =>
          /2 saved timelines/.test((await text('#timelineCount')) ?? '') &&
          /3 watched locators/.test((await text('#watchedCount')) ?? ''),
        'the data counts'
      ),
      `${await text('#timelineCount')} / ${await text('#watchedCount')}`
    );
    await opts.click('#clearTimelinesBtn');
    check(
      'Clear timelines removes every llRecorderState key and nothing else',
      await waitFor(async () => {
        const all = await store(null);
        return (
          !('llRecorderState' in all) &&
          !('llRecorderState:4242' in all) &&
          all.llRecorderStateOther === 'not a timeline' &&
          Boolean(all.llSettings)
        );
      }, 'the timelines to go'),
      json(Object.keys(await store(null)))
    );

    const thumbIds = ['smoke-thumb-1', 'smoke-thumb-2'];
    await worker.evaluate(
      (keys) =>
        Promise.all(
          keys.map((eventId) =>
            LLThumbs.put({ eventId, windowId: 4242, blob: new Blob(['x'], { type: 'image/jpeg' }) })
          )
        ),
      thumbIds
    );
    const thumbsLeft = () =>
      worker.evaluate((keys) => LLThumbs.getMany(keys).then((r) => r.filter(Boolean).length), thumbIds);
    check('two thumbnails are in IndexedDB before clearing', (await thumbsLeft()) === 2);
    from = await msgCount();
    await opts.click('#clearShotsBtn');
    check(
      'Clear screenshots: THUMBS_CLEAR_ALL answers ok',
      await waitFor(async () => /Step screenshots cleared/.test((await status()) ?? ''), 'the clear status'),
      await status()
    );
    check('every thumbnail is gone from IndexedDB', (await thumbsLeft()) === 0);
    check(
      'panels are told (THUMBS_CLEARED all)',
      Boolean(await awaitMsg(from, (m) => m.type === 'THUMBS_CLEARED' && m.all === true, 'THUMBS_CLEARED'))
    );

    await opts.click('#clearWatchedBtn');
    check(
      'Clear watched locators removes llWatched',
      await waitFor(async () => !('llWatched' in (await store(null))), 'llWatched to go')
    );
    check(
      'the buttons disable once there is nothing to clear',
      await waitFor(
        () =>
          opts.evaluate(
            () =>
              document.getElementById('clearTimelinesBtn').disabled &&
              document.getElementById('clearWatchedBtn').disabled
          ),
        'disabled clear buttons'
      )
    );
    await worker.evaluate(() => chrome.storage.local.remove('llRecorderStateOther'));

    // ── shortcuts ──────────────────────────────────────────────────────────────
    console.log('\nkeyboard shortcuts');
    const commands = await worker.evaluate(() => chrome.commands.getAll());
    for (const [name, key] of Object.entries(SHORTCUTS)) {
      const c = commands.find((x) => x.name === name);
      check(`chrome.commands has ${name} on ${key}`, c?.shortcut === key, json(c));
    }
    const shown = await opts.$$eval('#shortcutList li', (lis) =>
      lis.map((li) => ({ name: li.dataset.command, key: li.querySelector('kbd')?.textContent ?? null }))
    );
    for (const [name, key] of Object.entries(SHORTCUTS)) {
      check(
        `the settings page shows ${key} for ${name}`,
        shown.find((s) => s.name === name)?.key === key,
        json(shown)
      );
    }
    const managePage = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
    check('“Change shortcuts…” is offered on Chromium', await opts.isVisible('#shortcutsManageBtn'));
    await opts.click('#shortcutsManageBtn');
    const shortcutsTab = await managePage;
    check(
      'it opens chrome://extensions/shortcuts',
      Boolean(shortcutsTab) &&
        (await waitFor(
          async () => shortcutsTab.url().startsWith('chrome://extensions/shortcuts'),
          'the url',
          3000
        )),
      shortcutsTab?.url()
    );
    await shortcutsTab?.close().catch(() => {});

    check(
      'the worker command handler is reachable (classic service worker global)',
      await worker.evaluate(() => typeof handleCommand === 'function')
    );
    const demoTab = await activeTab(page);
    if (!(demoTab?.url ?? '').includes(`:${PORT}/`))
      throw new Error(`the demo tab is not active: ${json(demoTab)}`);
    const overlayCount = () => page.locator('#ll-overlay').count();
    const runCommand = (name, tab) =>
      worker.evaluate(([n, t]) => handleCommand(n, t ?? undefined), [name, tab ?? null]);

    await page.bringToFront();
    await runCommand('toggle-inspect', demoTab);
    check(
      'toggle-inspect starts inspecting the demo tab (overlay appears)',
      await waitFor(async () => (await overlayCount()) === 1, 'the overlay')
    );
    check('GET_INSPECT_STATE agrees', (await send({ type: 'GET_INSPECT_STATE' }))?.active === true);
    await runCommand('toggle-inspect', demoTab);
    check(
      'toggle-inspect again stops it (overlay removed)',
      await waitFor(async () => (await overlayCount()) === 0, 'the overlay to go')
    );
    await runCommand('toggle-inspect'); // no tab: the focused window's active tab
    check(
      'without a tab, the focused window’s active tab is used',
      await waitFor(async () => (await overlayCount()) === 1, 'the overlay (no tab)')
    );
    await runCommand('toggle-inspect');
    await waitFor(async () => (await overlayCount()) === 0, 'the overlay to go (no tab)');

    from = await msgCount();
    await runCommand('toggle-recording', demoTab);
    const recOn = await awaitMsg(
      from,
      (m) => m.type === 'RECORDING_STATE' && m.windowId === windowId && m.active === true,
      'RECORDING_STATE on'
    );
    check('toggle-recording starts a session and pushes RECORDING_STATE', Boolean(recOn), json(recOn));
    const recState = await send({ type: 'GET_RECORDING_STATE' });
    check(
      'GET_RECORDING_STATE reports the demo tab recording',
      recState?.active === true && recState.tabIds.includes(demoTab.id),
      json(recState)
    );
    from = await msgCount();
    await runCommand('toggle-recording', demoTab);
    check(
      'toggle-recording again stops it',
      Boolean(
        await awaitMsg(from, (m) => m.type === 'RECORDING_STATE' && m.active === false, 'RECORDING_STATE off')
      ) && (await send({ type: 'GET_RECORDING_STATE' }))?.active === false
    );

    const blank = await context.newPage();
    await blank.goto('about:blank');
    await blank.bringToFront();
    const blankTab = await activeTab(blank);
    const badge = () => worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), blankTab.id);
    const badgeTitle = () => worker.evaluate((id) => chrome.action.getTitle({ tabId: id }), blankTab.id);
    from = await msgCount();
    const t0 = Date.now();
    await runCommand('toggle-inspect', blankTab);
    check(
      'on about:blank, toggle-inspect flashes a "!" badge',
      await waitFor(async () => (await badge()) === '!', 'the badge', 3000),
      json(await badge())
    );
    check('the button tooltip says why', RESTRICTED_RE.test(await badgeTitle()), await badgeTitle());
    const failed = await awaitMsg(from, (m) => m.type === 'ACTIVATION_FAILED', 'ACTIVATION_FAILED');
    check(
      'the panel is told: ACTIVATION_FAILED { feature: inspect, error }',
      failed?.feature === 'inspect' && failed.windowId === windowId && RESTRICTED_RE.test(failed.error ?? ''),
      json(failed)
    );
    const cleared = await waitFor(async () => (await badge()) === '', 'the badge to clear', 8000);
    const elapsed = Date.now() - t0;
    check(
      'the badge clears after ~4 s',
      cleared && elapsed >= 3500 && elapsed < 8000,
      `cleared=${cleared} after ${elapsed} ms`
    );
    check('the tooltip is restored', !RESTRICTED_RE.test(await badgeTitle()), await badgeTitle());
    check(
      'about:blank is not left marked as inspecting',
      (await send({ type: 'GET_INSPECT_STATE' }))?.active === false
    );
    from = await msgCount();
    await runCommand('toggle-recording', blankTab);
    const recFailed = await awaitMsg(
      from,
      (m) => m.type === 'ACTIVATION_FAILED' && m.feature === 'recording',
      'ACTIVATION_FAILED recording'
    );
    check(
      'toggle-recording on about:blank reports ACTIVATION_FAILED { feature: recording }',
      Boolean(recFailed)
    );
    check('and leaves no session behind', (await send({ type: 'GET_RECORDING_STATE' }))?.active === false);
    await blank.close();

    // ── locator health check ───────────────────────────────────────────────────
    console.log('\nlocator health check');
    await page.goto(`${DEMO}?password=hunter2&q=1#top`, { waitUntil: 'load' });
    await contentScriptReady();
    await page.bringToFront();
    const active = await send({ type: 'GET_ACTIVE_PAGE' });
    check(
      'GET_ACTIVE_PAGE returns the demo tab and its siteKey (origin + path)',
      active?.ok === true && active.tabId === demoTab.id && active.siteKey === `${server.base}/checkout`,
      json(active)
    );
    check(
      'the url is redacted (no secret query values)',
      active?.url?.includes('password=REDACTED') && !active.url.includes('hunter2'),
      active?.url
    );

    const btn = await pick(
      '[data-testid="place-order"]',
      (p) => p?.elementData?.fingerprint?.testId === 'place-order'
    );
    const card = await pick('#card', (p) => p?.elementData?.id === 'card', { frameSel: '#payment-frame' });
    const fp = btn?.elementData?.fingerprint;
    check(
      'the pick has a fingerprint',
      fp?.tag === 'button' && fp.testAttr === 'data-testid' && fp.text === 'Place order',
      json(fp)
    );
    const byTestId = btn?.locators?.find((l) => l.target?.kind === 'testid');
    const byRole = btn?.locators?.find((l) => l.target?.kind === 'role' && l.target.name);
    const inFrame = card?.locators?.[0];
    check(
      'a test-id, a role and a frame locator to watch',
      byTestId && byRole && inFrame?.target?.kind === 'frame',
      json({ t: byTestId?.target, r: byRole?.target, f: inFrame?.target })
    );
    const items = [
      { id: 'btn-testid', target: byTestId?.target, fingerprint: fp },
      { id: 'btn-role', target: byRole?.target, fingerprint: fp },
      { id: 'card', target: inFrame?.target, fingerprint: card?.elementData?.fingerprint },
      // The card's own locator without its frame: the top document owns it, and has no #card.
      { id: 'card-unframed', target: inFrame?.target?.child, fingerprint: null },
    ];
    const health = async (list = items) => {
      await page.bringToFront();
      return send({ type: 'HEALTH_CHECK', items: list });
    };
    const statusOf = (res, id) => res?.results?.find((r) => r.id === id);
    /** Resolve a suggested Playwright locator against the live page: count, and what it hit. */
    async function resolveSuggestion(code) {
      try {
        // Running our own generated locator is the point of the check.
        // eslint-disable-next-line no-new-func
        const loc = new Function('page', `return (${code});`)(page);
        const count = await loc.count();
        const hit =
          count === 1
            ? await loc.evaluate((el) => ({
                tag: el.localName,
                type: el.getAttribute('type'),
                text: el.textContent.trim(),
              }))
            : null;
        return { count, hit };
      } catch (err) {
        return { count: -1, error: err.message.split('\n')[0] };
      }
    }

    let res = await health();
    check(
      'HEALTH_CHECK on the untouched page: ok ×3, siteKey echoed',
      res?.ok === true &&
        res.siteKey === `${server.base}/checkout` &&
        ['btn-testid', 'btn-role', 'card'].every(
          (id) => statusOf(res, id)?.status === 'ok' && statusOf(res, id).count === 1
        ),
      json(res)
    );
    check(
      'the frame-wrapped item is answered by the payment iframe',
      statusOf(res, 'card')?.status === 'ok' && statusOf(res, 'card-unframed')?.status === 'broken',
      json([statusOf(res, 'card'), statusOf(res, 'card-unframed')])
    );

    // Renamed button text: the role locator breaks, the fingerprint finds it again.
    await page.evaluate(() => {
      document.querySelector('[data-testid="place-order"]').textContent = 'Complete purchase';
    });
    res = await health();
    const renamed = statusOf(res, 'btn-role');
    check(
      'renamed text → the role locator is broken (count 0)',
      renamed?.status === 'broken' && renamed.count === 0,
      json(renamed)
    );
    check('… while the test-id locator is still ok', statusOf(res, 'btn-testid')?.status === 'ok');
    let resolved = renamed?.suggestion ? await resolveSuggestion(renamed.suggestion.code) : null;
    check(
      '… with a suggestion that Playwright resolves to exactly the button',
      resolved?.count === 1 && resolved.hit?.type === 'submit' && resolved.hit.text === 'Complete purchase',
      json({ suggestion: renamed?.suggestion, resolved })
    );

    // Changed attributes: the test-id locator breaks, the role locator holds.
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="place-order"]');
      b.textContent = 'Place order';
      b.setAttribute('data-testid', 'submit-order');
    });
    res = await health();
    const retagged = statusOf(res, 'btn-testid');
    check(
      'changed data-testid → the test-id locator is broken',
      retagged?.status === 'broken' && retagged.count === 0,
      json(retagged)
    );
    check('… while the role locator is ok again', statusOf(res, 'btn-role')?.status === 'ok');
    resolved = retagged?.suggestion ? await resolveSuggestion(retagged.suggestion.code) : null;
    check(
      '… with a suggestion that Playwright resolves to exactly the button',
      resolved?.count === 1 && resolved.hit?.type === 'submit' && resolved.hit.text === 'Place order',
      json({ suggestion: retagged?.suggestion, resolved })
    );
    check(
      '… whose structured target is not frame-wrapped (neither was the original)',
      retagged?.suggestion?.target && retagged.suggestion.target.kind !== 'frame',
      json(retagged?.suggestion?.target)
    );

    // A duplicate: ambiguous.
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="submit-order"]');
      b.setAttribute('data-testid', 'place-order');
      b.after(b.cloneNode(true));
    });
    res = await health();
    const dup = statusOf(res, 'btn-testid');
    check(
      'a duplicated element → ambiguous (count 2)',
      dup?.status === 'ambiguous' && dup.count === 2,
      json(dup)
    );
    if (dup?.suggestion) {
      resolved = await resolveSuggestion(dup.suggestion.code);
      check('an ambiguous item’s suggestion, if any, is unique', resolved.count === 1, json(resolved));
    }

    // The frame goes away: its item is frame-missing (no frame owns it any more).
    await page.evaluate(() => document.getElementById('payment-frame').remove());
    res = await health();
    check(
      'removing the payment iframe → frame-missing',
      statusOf(res, 'card')?.status === 'frame-missing',
      json(statusOf(res, 'card'))
    );

    // Restricted pages.
    for (const url of ['about:blank', 'chrome://version']) {
      const p = await context.newPage();
      await p.goto(url).catch(() => {});
      await p.bringToFront();
      const r = await send({ type: 'HEALTH_CHECK', items });
      check(
        `HEALTH_CHECK on ${url} → ok:false with the restricted-page error`,
        r?.ok === false && RESTRICTED_RE.test(r.error ?? ''),
        json(r)
      );
      const a = await send({ type: 'GET_ACTIVE_PAGE' });
      check(
        `GET_ACTIVE_PAGE on ${url} → ok:false`,
        a?.ok === false && RESTRICTED_RE.test(a.error ?? ''),
        json(a)
      );
      await p.close();
    }

    console.log('\nhygiene');
    check(
      'the settings page logged no errors',
      optionsErrors.length === 0,
      optionsErrors.slice(0, 3).join(' | ')
    );
    check(
      'the content script logged nothing to the page console',
      pageErrors.length === 0,
      pageErrors.slice(0, 3).join(' | ')
    );
    check('no order was placed by any of the clicks', server.orders().length === 0, json(server.orders()));
  } finally {
    await context.close();
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  dist/edge: the same package, and it runs
// ════════════════════════════════════════════════════════════════════════════

async function edgePhase(executablePath, server) {
  console.log('\nedge package');
  const chromeFiles = tree(EXTENSION);
  const edgeFiles = tree(EDGE);
  check(
    'dist/edge has the same files as dist/chrome',
    json(chromeFiles) === json(edgeFiles),
    json({ chromeFiles, edgeFiles })
  );
  const differing = chromeFiles.filter(
    (f) => edgeFiles.includes(f) && !readFileSync(join(EXTENSION, f)).equals(readFileSync(join(EDGE, f)))
  );
  check('every file is byte-identical', differing.length === 0, differing.join(', '));
  const version = JSON.parse(readFileSync(join(EDGE, 'manifest.json'), 'utf8')).version;
  const edgeZip = join(ROOT, `dist/locatra-edge-${version}.zip`);
  const chromeZip = join(ROOT, `dist/locatra-chrome-${version}.zip`);
  check(`dist/locatra-edge-${version}.zip exists`, existsSync(edgeZip));
  if (existsSync(edgeZip) && existsSync(chromeZip)) {
    check('the Edge archive is byte-identical to the Chrome archive', sha256(edgeZip) === sha256(chromeZip));
  }

  const context = await launch(executablePath, EDGE);
  try {
    const extensionId = computeExtensionId(EDGE);
    const errors = [];
    context.on(
      'console',
      (m) => m.type() === 'error' && errors.push(`${m.page()?.url() ?? '?'}: ${m.text()}`)
    );
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${server.base}/checkout`, { waitUntil: 'load' });
    const worker = await waitForServiceWorker(context, extensionId);
    check('dist/edge loads in Chromium and its service worker runs', Boolean(worker));
    if (!worker) return;
    const alive = await waitFor(
      () =>
        worker.evaluate(async (port) => {
          const tabs = await chrome.tabs.query({});
          const t = tabs.find((x) => (x.url || '').includes(`:${port}/`));
          if (!t) return false;
          const r = await chrome.tabs.sendMessage(t.id, { type: 'PING' }, { frameId: 0 }).catch(() => null);
          return r != null;
        }, PORT),
      'the edge content script',
      10_000
    );
    check('its content script answers PING on the demo page', alive);
    const probe = await worker.evaluate(async (port) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => (x.url || '').includes(`:${port}/`));
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: t.id },
        func: () => ({
          health: typeof globalThis.__LocatraHealthCheck,
          engine: typeof globalThis.__LocatorLensEngine,
          href: location.href,
        }),
      });
      return r?.result ?? null;
    }, PORT);
    check(
      'the content script world has the engine and __LocatraHealthCheck',
      probe?.health === 'function' && probe.engine === 'object',
      json(probe)
    );
    const commands = await worker.evaluate(() => chrome.commands.getAll());
    check(
      'its commands are registered',
      Object.entries(SHORTCUTS).every(([n, k]) => commands.find((c) => c.name === n)?.shortcut === k),
      json(commands)
    );
    const opts = await context.newPage();
    await opts.goto(`chrome-extension://${extensionId}/src/options.html`, { waitUntil: 'load' });
    await opts.evaluate(() => window.__LocatraOptions?.ready);
    check(
      'its settings page renders and lists the shortcuts',
      json(
        await opts.$$eval('#shortcutList li', (lis) =>
          lis
            .filter((li) => li.dataset.command.startsWith('toggle-'))
            .map((li) => `${li.dataset.command}=${li.querySelector('kbd')?.textContent}`)
            .sort()
        )
      ) ===
        json(
          Object.entries(SHORTCUTS)
            .map(([n, k]) => `${n}=${k}`)
            .sort()
        )
    );
    check('nothing logged an error', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err.stack || err.message}\n`);
  rmSync(profile, { recursive: true, force: true });
  process.exit(1);
});
