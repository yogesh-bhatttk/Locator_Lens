#!/usr/bin/env node
/* global chrome, document, window, recordedActions, committedActions, generateTestScript, getPreviewText, LLCodegen, lastLocators */
// Real-browser smoke test for test-data variables (round 3, C) and locator health (E).
//
// The unit suites drive the side panel in jsdom with a mocked worker and content
// script. This drives the built extension instead: the real side panel UI (as a tab in
// the demo page's window), the real worker relays (GET_ACTIVE_PAGE / HEALTH_CHECK /
// replay) and the real content script (recorder, picker, Page Object scan and
// globalThis.__LocatraHealthCheck) against the demo checkout.
//
//   1. Test data — a recorded checkout becomes named variables in the Record tab;
//      renames / value edits reach the script, the timeline and storage; invalid names
//      are rejected and revert; JSON copy / download equal LLCodegen.variablesJson;
//      the toggle switches literals back on; every framework × language the selectors
//      offer declares the data once and references it; replay types the edited values.
//   2. Health — ☆ Watch from an Inspect pick, Check now (ok / broken + suggestion /
//      use suggestion / ambiguous), Watch all from a whole-page Page Object scan,
//      remove, export / import (dedupe), a hostile import, other sites and auto-check.
//   3. Persistence — reloading the panel keeps watched locators and test data; the
//      panel's setting toggles never drop llSettings fields written elsewhere.
//
//   npm run build && node scripts/e2e/smoke-panel-data-health.mjs
//
// Needs a display. Own port and profile, so it can run next to the other smokes.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { computeExtensionId, resolveChromium, until, waitForServiceWorker } from './browsers.mjs';
import { startDemoServer } from './demo-server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXTENSION = join(ROOT, 'dist/chrome');
const PORT = 4184;
const profile = join(ROOT, '.tmp-smoke-data-health-profile');

// llSettings fields the options page owns. The panel must never drop them.
const SEEDED_SETTINGS = {
  autoAssertions: true,
  stepScreenshots: true,
  variables: true,
  healthAutoCheck: false,
  testIdAttributes: ['data-qa', 'data-e2e'],
  secretNames: { password: 'SMOKE_PASSWORD', secret: 'SMOKE_SECRET' },
  futureField: { keep: [1, 2, 3] },
};

// What the recorded checkout types / selects, and the variable each value must become.
const TYPED = [
  { field: '#first-name', value: 'Ada', name: /^firstName$/ },
  { field: '#last-name', value: 'Lovelace', name: /^lastName$/ },
  { field: '#email', value: 'ada@example.com', name: /email/i },
  { field: '#phone', value: '+44 20 7946 0001', name: /^phone/ },
  { field: '#country', value: 'Ireland', name: /^country$/ },
  { field: '#notes', value: 'Ring the bell twice', name: /notes$/i },
];

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

const short = (v, n = 300) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
};

async function main() {
  if (!existsSync(join(EXTENSION, 'manifest.json'))) {
    throw new Error('dist/chrome missing — run `npm run build` first.');
  }
  const executablePath = resolveChromium();
  if (!executablePath)
    throw new Error('No Playwright Chromium found. Run `npx playwright install chromium`.');

  const server = await startDemoServer({ port: PORT });
  const DEMO = `${server.base}/checkout`;
  const OTHER = `${server.base}/account/settings`;
  const SITE = DEMO; // siteKey = origin + pathname
  const OTHER_SITE = OTHER;

  rmSync(profile, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: false,
    acceptDownloads: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });

  try {
    const extensionId = computeExtensionId(EXTENSION);
    const worker = await waitForServiceWorker(context, extensionId);
    check('extension loads and the service worker is running', Boolean(worker));
    if (!worker) throw new Error('no service worker — nothing further can be driven');
    // Written "elsewhere" (the options page) before the panel ever opens.
    await worker.evaluate((s) => chrome.storage.local.set({ llSettings: s }), SEEDED_SETTINGS);

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
    page.on('dialog', (d) => {
      pageErrors.push(`page dialog: ${d.message()}`);
      d.dismiss().catch(() => {});
    });
    await page.goto(DEMO, { waitUntil: 'load' });

    // The panel runs as a tab in the demo page's window. The worker acts on the
    // window's ACTIVE tab, so the demo tab stays in front and the panel's buttons are
    // clicked while it is behind (Playwright drives background tabs).
    const panel = await context.newPage();
    const panelErrors = [];
    panel.on('pageerror', (e) => panelErrors.push(e.message));
    panel.on('console', (m) => m.type() === 'error' && panelErrors.push(m.text()));
    panel.on('dialog', (d) => d.accept().catch(() => {}));
    await panel.setViewportSize({ width: 460, height: 900 });
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel.html`, { waitUntil: 'load' });
    // Copy buttons need a focused document; emulate focus so the panel can stay behind.
    const panelCdp = await context.newCDPSession(panel);
    await panelCdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const windowId = await panel.evaluate(async () => (await chrome.windows.getCurrent()).id);

    // ── shared helpers ──────────────────────────────────────────────────────────
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
    const text = (sel) => panel.evaluate((s) => document.querySelector(s)?.textContent ?? '', sel);
    const isHidden = (sel) =>
      panel.evaluate((s) => {
        const el = document.querySelector(s);
        return !el || el.hidden || el.closest('[hidden]') !== null;
      }, sel);
    const storage = (key) =>
      panel.evaluate((k) => new Promise((r) => chrome.storage.local.get(k, (all) => r(all[k] ?? null))), key);
    const clickInPanel = async (selector) => {
      await page.bringToFront();
      await panel.click(selector);
    };
    const showTab = async (id) => {
      await page.bringToFront();
      await panel.click(`[data-target="${id}"]`);
    };

    async function download(selector) {
      try {
        const [dl] = await Promise.all([
          panel.waitForEvent('download', { timeout: 10_000 }),
          panel.click(selector),
        ]);
        const path = await dl.path();
        return { name: dl.suggestedFilename(), body: path ? readFileSync(path, 'utf8') : '' };
      } catch (err) {
        return { name: '', body: '', error: err.message.split('\n')[0] };
      }
    }

    /** Click a copy button, then read the clipboard back with a real paste. */
    // What a Copy button hands to the clipboard, recorded on the way through (the real
    // calls still happen). The X clipboard is shared with every other browser on the
    // machine, so a paste can see someone else's copy; the recorded call cannot.
    await panel.evaluate(() => {
      const log = (window.__smokeCopies = []);
      const clip = navigator.clipboard;
      if (clip && clip.writeText) {
        const orig = clip.writeText.bind(clip);
        clip.writeText = (t) => {
          const entry = { via: 'writeText', text: String(t), ok: null };
          log.push(entry);
          return orig(t).then(
            (v) => ((entry.ok = true), v),
            (e) => {
              entry.ok = false;
              entry.error = String((e && e.message) || e);
              throw e;
            }
          );
        };
      }
      const exec = document.execCommand.bind(document);
      document.execCommand = (cmd, ...rest) => {
        const result = exec(cmd, ...rest);
        if (cmd === 'copy')
          log.push({ via: 'execCommand', text: document.activeElement?.value ?? '', ok: result });
        return result;
      };
    });

    /** Click a copy button: what the panel copied, and what a real paste then yields. */
    async function copyAndPaste(selector, confirm) {
      const before = await panel.evaluate(() => window.__smokeCopies.length);
      await panel.click(selector);
      const copied = await waitFor(confirm, `the copy confirmation of ${selector}`, 3000);
      await waitFor(
        () => panel.evaluate((n) => window.__smokeCopies.slice(n).some((c) => c.ok !== null), before),
        'the clipboard write to settle',
        3000
      );
      const calls = await panel.evaluate((n) => window.__smokeCopies.slice(n), before);
      const written = calls.filter((c) => c.ok === true).at(-1) ?? null;
      const clip = await pasteClipboard(context);
      await page.bringToFront();
      return { copied, calls, text: written ? written.text : null, clip };
    }

    /** The paste is a best-effort cross-check: another process may own the clipboard. */
    function notePaste(what, result, expected) {
      if (result.clip.replace(/\n$/, '') !== expected.replace(/\n$/, '')) {
        console.log(
          `    (note: a real paste after ${what} gave ${short(result.clip, 80)} — clipboard contended?)`
        );
      }
    }

    await contentScriptReady();

    // ════════════════════════════════════════════════════════════════════════
    // 1. Test data
    // ════════════════════════════════════════════════════════════════════════
    const script = () => panel.evaluate(() => document.getElementById('codePreview')?.innerText ?? '');
    const steps = () =>
      panel.evaluate(() =>
        recordedActions.map((a) => ({
          action: a.action,
          value: a.sensitive ? '' : String(a.value ?? ''),
          varName: a.varName ?? null,
          eventId: a.eventId ?? null,
          code: String(a.code || ''),
          suggested: !!a.suggested,
        }))
      );
    const tdRows = () =>
      panel.$$eval('#testDataList .ll-td-row', (rows) =>
        rows.map((r) => {
          const name = r.querySelector('.ll-td-name');
          const err = r.querySelector('.ll-td-err');
          return {
            index: Number(name?.getAttribute('data-var')),
            name: name?.value ?? '',
            value: r.querySelector('.ll-td-value')?.value ?? '',
            invalid: name?.getAttribute('aria-invalid') ?? null,
            error: err && !err.hidden ? err.textContent : '',
            meta: r.querySelector('.ll-td-meta')?.textContent ?? '',
          };
        })
      );
    const timelineValues = () =>
      panel.$$eval('#recorderTimeline .ll-rec-step', (rows) =>
        rows.map((r) => ({
          index: Number(r.getAttribute('data-step-index')),
          value: r.querySelector('.ll-rec-step-value')?.textContent ?? '',
        }))
      );
    const recorderKey = `llRecorderState:${windowId}`;
    const storedSteps = async () => (await storage(recorderKey))?.actions ?? [];
    const recordingState = () =>
      panel.evaluate(
        (w) => chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATE', windowId: w }),
        windowId
      );
    const waitForStep = (what, pred, timeout = 8000) =>
      waitFor(async () => (await steps()).some(pred), what, timeout);

    console.log('\nrecording a checkout');
    await showTab('tab-recorder');
    await clickInPanel('#recordBtn');
    check(
      'Record starts a session in the demo tab',
      await waitFor(async () => (await recordingState())?.active === true, 'recording on'),
      JSON.stringify(await recordingState())
    );
    check(
      'the recording opens with goto + viewport',
      await waitForStep('the opening viewport step', (s) => s.action === 'viewport')
    );
    for (const t of TYPED) {
      if (t.field === '#country') {
        // A trusted change: ArrowDown on the focused, closed <select> (UK → Ireland).
        await page.focus('#country');
        await page.keyboard.press('ArrowDown');
        check(
          'select country is recorded',
          await waitForStep('the country select', (s) => s.action === 'selectOption' && s.value === t.value)
        );
        continue;
      }
      await page.click(t.field);
      await page.fill(t.field, t.value);
      check(
        `fill ${t.field} = ${JSON.stringify(t.value)} is recorded`,
        await waitForStep(`the ${t.field} fill`, (s) => s.action === 'fill' && s.value === t.value)
      );
    }
    await clickInPanel('#recordBtn');
    check(
      'Record again stops the session',
      await waitFor(async () => (await recordingState())?.active === false, 'recording off')
    );

    console.log('\nthe Test data section');
    check(
      'the Test data section is shown',
      !(await isHidden('#testDataSection')) && !(await isHidden('#testDataLabel'))
    );
    await waitFor(async () => (await tdRows()).length >= TYPED.length, 'the variables to be listed');
    let vars = await tdRows();
    check(
      `one variable per typed / selected value (${TYPED.length})`,
      vars.length === TYPED.length,
      short(vars)
    );
    check('the count says so', (await text('#testDataCount')).includes(`(${TYPED.length})`));
    const varOf = {};
    for (const t of TYPED) {
      const v = vars.find((r) => r.value === t.value);
      varOf[t.field] = v?.name;
      check(
        `${t.field}: variable ${v?.name ?? '(none)'} holds ${JSON.stringify(t.value)}`,
        v && t.name.test(v.name),
        short(vars)
      );
    }
    check(
      'every name is a unique identifier',
      vars.every((v) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name)) &&
        new Set(vars.map((v) => v.name)).size === vars.length,
      vars.map((v) => v.name).join(', ')
    );
    check(
      'each row says which step uses it',
      vars.every((v) => /used in step \d+/.test(v.meta)),
      vars.map((v) => v.meta).join(' | ')
    );
    check('the empty-state hint is hidden', await isHidden('#testDataEmpty'));

    /** The variables the panel's own codegen extracts right now (independent of the rows). */
    const codegenJson = () =>
      panel.evaluate(() => LLCodegen.variablesJson(LLCodegen.extractVariables(committedActions())));

    let ts = await script();
    const declTs = declarationOf(ts, 'typescript');
    check(
      'the Playwright TS script declares const testData = {…}',
      ts.includes("from '@playwright/test'") && declTs.found,
      ts.slice(0, 600)
    );
    check(
      'the declaration lists every variable with its recorded value',
      TYPED.every((t) => declTs.text.includes(`${varOf[t.field]}: ${jsQuote(t.value)}`)),
      declTs.text
    );
    check(
      'fills and the select use testData.<name>',
      /\.fill\(testData\.firstName\)/.test(ts) &&
        /\.fill\(testData\.lastName\)/.test(ts) &&
        new RegExp(`\\.selectOption\\(testData\\.${varOf['#country']}\\)`).test(ts),
      ts
    );
    check(
      'no recorded value is left as a literal outside the declaration',
      TYPED.every((t) => !declTs.rest.includes(t.value)) && !/\.fill\('Ada'\)/.test(ts),
      declTs.rest
    );

    // ── rename ──
    console.log('\nrenaming a variable');
    const idxOf = async (name) => (await tdRows()).find((r) => r.name === name)?.index ?? -1;
    const firstIdx = await idxOf('firstName');
    const nameInput = (i) => panel.locator(`.ll-td-name[data-var="${i}"]`);
    const valueInput = (i) => panel.locator(`.ll-td-value[data-var="${i}"]`);
    await nameInput(firstIdx).fill('buyerFirstName');
    check(
      'the script follows the rename (declaration and reference)',
      await waitFor(async () => {
        const s = await script();
        return (
          /\.fill\(testData\.buyerFirstName\)/.test(s) &&
          /\bbuyerFirstName: 'Ada'/.test(s) &&
          !/\bfirstName\b/.test(s.replace(/buyerFirstName/g, ''))
        );
      }, 'the renamed variable in the script'),
      (await script()).slice(0, 700)
    );
    const firstFillIndex = (await steps()).findIndex((s) => s.action === 'fill' && s.value === 'Ada');
    check(
      'the timeline step keeps its value and carries the name',
      (await steps())[firstFillIndex]?.varName === 'buyerFirstName',
      short((await steps())[firstFillIndex])
    );
    check(
      'the rename is saved with the timeline',
      await waitFor(
        async () => (await storedSteps()).some((s) => s.varName === 'buyerFirstName' && s.value === 'Ada'),
        'the saved varName'
      )
    );
    check(
      'Copy test data JSON / variablesJson use the new name',
      JSON.parse(await codegenJson()).buyerFirstName === 'Ada'
    );

    // ── invalid names ──
    console.log('\ninvalid names are rejected and revert');
    const lastIdx = await idxOf('lastName');
    const blur = () => panel.click('#testDataLabel');
    const invalidCases = [
      ['class', 'a reserved word'],
      ['1abc', 'a leading digit'],
      ['last name', 'a space'],
      ['buyerFirstName', 'a duplicate'],
      ['buyer_first_name', 'a Python clash (buyer_first_name vs buyerFirstName)'],
      ['email', 'a duplicate of another variable'],
    ];
    for (const [bad, why] of invalidCases) {
      if (bad === 'email' && varOf['#email'] !== 'email') continue;
      const before = await script();
      await nameInput(lastIdx).fill(bad);
      const flagged = await waitFor(async () => {
        const r = (await tdRows()).find((x) => x.index === lastIdx);
        return r?.invalid === 'true' && r.error.trim().length > 0;
      }, `"${bad}" to be flagged`);
      const row = (await tdRows()).find((x) => x.index === lastIdx);
      check(`"${bad}" (${why}) is flagged with an error`, flagged, short(row));
      check(
        `"${bad}": the script keeps lastName`,
        (await script()) === before && /\.fill\(testData\.lastName\)/.test(before)
      );
      await blur();
      check(
        `"${bad}": leaving the field reverts it to lastName`,
        await waitFor(async () => {
          const r = (await tdRows()).find((x) => x.index === lastIdx);
          return r?.name === 'lastName' && r.invalid === 'false';
        }, 'the revert'),
        short(await tdRows())
      );
    }
    check('the panel explains the revert', /Kept the name "lastName"/.test(await text('#testDataStatus')));
    check(
      'no step was renamed to an invalid name',
      (await storedSteps()).every((s) => s.varName == null || s.varName === 'buyerFirstName'),
      short((await storedSteps()).map((s) => s.varName))
    );

    // ── value edit ──
    console.log('\nediting a value');
    await valueInput(lastIdx).fill('Byron');
    check(
      'the declaration takes the new value',
      await waitFor(async () => /\blastName: 'Byron'/.test(await script()), 'lastName: Byron'),
      (await script()).slice(0, 700)
    );
    check('the old value is gone from the script', !(await script()).includes('Lovelace'));
    const lastFillIndex = (await steps()).findIndex(
      (s) => s.action === 'fill' && s.code.includes('Last name')
    );
    await expandTimeline(panel);
    check(
      'the timeline step shows the new value',
      await waitFor(
        async () =>
          (await timelineValues()).some((r) => r.index === lastFillIndex && r.value.includes('"Byron"')),
        'the timeline value'
      ),
      short(await timelineValues())
    );
    check(
      'the new value is saved with the timeline',
      await waitFor(
        async () => (await storedSteps()).some((s) => s.action === 'fill' && s.value === 'Byron'),
        'the saved value'
      )
    );
    await blur();

    // ── JSON copy / download ──
    console.log('\ntest data JSON');
    const expectedJson = await codegenJson();
    const expectedObj = {
      buyerFirstName: 'Ada',
      lastName: 'Byron',
      [varOf['#email']]: 'ada@example.com',
      [varOf['#phone']]: '+44 20 7946 0001',
      [varOf['#country']]: 'Ireland',
      [varOf['#notes']]: 'Ring the bell twice',
    };
    check(
      'variablesJson is the edited test data',
      JSON.stringify(JSON.parse(expectedJson)) === JSON.stringify(expectedObj),
      expectedJson
    );
    const dl = await download('#testDataDownloadBtn');
    check('Download saves test-data.json', dl.name === 'test-data.json', dl.error || dl.name);
    check('the download is exactly variablesJson', dl.body === expectedJson, short(dl.body));
    const copiedJson = await copyAndPaste('#testDataCopyBtn', async () =>
      /Copied/.test(await text('#testDataCopyBtn'))
    );
    check('Copy test data (JSON) reports success', copiedJson.copied, await text('#testDataCopyBtn'));
    check(
      'the clipboard was written with exactly variablesJson',
      copiedJson.text === expectedJson,
      short(copiedJson.calls)
    );
    notePaste('Copy test data', copiedJson, expectedJson);

    // ── the toggle ──
    console.log('\nthe variables toggle');
    await panel.uncheck('#settingVariables');
    check(
      'off: the script types literals again',
      await waitFor(async () => {
        const s = await script();
        return /\.fill\('Ada'\)/.test(s) && /\.fill\('Byron'\)/.test(s) && !/testData/.test(s);
      }, 'literals'),
      (await script()).slice(0, 600)
    );
    check(
      'off is saved in llSettings.variables',
      await waitFor(
        async () => (await storage('llSettings'))?.variables === false,
        'llSettings.variables=false'
      )
    );
    await panel.check('#settingVariables');
    check(
      'on: back to testData references',
      await waitFor(async () => {
        const s = await script();
        return /\.fill\(testData\.buyerFirstName\)/.test(s) && !/\.fill\('Ada'\)/.test(s);
      }, 'testData again')
    );
    check(
      'on is saved',
      await waitFor(
        async () => (await storage('llSettings'))?.variables === true,
        'llSettings.variables=true'
      )
    );

    // ── every framework × language ──
    console.log('\nevery framework and language');
    const fwOptions = await panel.$$eval('#fwSelect option', (os) => os.map((o) => o.value));
    check(
      'the framework selector offers Playwright, Selenium, Cypress (and the plug-ins)',
      ['playwright', 'selenium', 'cypress'].every((f) => fwOptions.includes(f)),
      fwOptions.join(', ')
    );
    const combos = [];
    for (const fw of fwOptions) {
      await panel.selectOption('#fwSelect', fw);
      const langs = await panel.$$eval('#langSelect option:not([disabled])', (os) => os.map((o) => o.value));
      for (const lang of langs) {
        await panel.selectOption('#langSelect', lang);
        const ready = await waitFor(async () => {
          const s = await script();
          return (
            (await panel.inputValue('#fwSelect')) === fw &&
            (await panel.inputValue('#langSelect')) === lang &&
            s !== '' &&
            (await panel.evaluate(
              () =>
                getPreviewText(document.getElementById('codePreview')).trim() === generateTestScript().trim()
            )) &&
            declarationOf(s, lang).found &&
            looksLike(fw, lang, s)
          );
        }, `${fw}/${lang} script`);
        const s = await script();
        combos.push(`${fw}/${lang}`);
        const decl = declarationOf(s, lang);
        check(
          `${fw}/${lang}: one test-data declaration`,
          ready && decl.found && decl.count === 1,
          s.slice(0, 500)
        );
        const missingRefs = Object.keys(expectedObj).filter(
          (name) => !decl.rest.includes(refFor(name, lang))
        );
        check(
          `${fw}/${lang}: every variable is declared with its value and referenced`,
          missingRefs.length === 0 &&
            Object.entries(expectedObj).every(
              ([name, value]) => decl.text.includes(keyFor(name, lang)) && decl.text.includes(value)
            ),
          `missing refs: ${missingRefs.join(', ')} | ${decl.text}`
        );
        const leaked = Object.values(expectedObj).filter((v) => decl.rest.includes(v));
        check(
          `${fw}/${lang}: no recorded value as a literal outside the declaration`,
          leaked.length === 0,
          `${leaked.join(', ')}\n${decl.rest.slice(0, 800)}`
        );
        check(`${fw}/${lang}: the script is a ${fw} ${lang} file`, looksLike(fw, lang, s), s.slice(0, 300));
      }
    }
    for (const want of ['playwright/java', 'selenium/java', 'playwright/csharp', 'selenium/csharp']) {
      if (!combos.includes(want)) console.log(`    (note: ${want} is not offered by the selectors)`);
    }
    check(
      'WebdriverIO is offered when its module is loaded',
      !(await panel.evaluate(() => LLCodegen.FRAMEWORKS.some((f) => f.id === 'webdriverio'))) ||
        combos.some((c) => c.startsWith('webdriverio/'))
    );
    await panel.selectOption('#fwSelect', 'playwright');
    await panel.selectOption('#langSelect', 'typescript');
    await waitFor(async () => (await script()).includes("from '@playwright/test'"), 'back to Playwright TS');

    // ── replay with the edited value ──
    console.log('\nreplay uses the edited values');
    await page.goto(DEMO, { waitUntil: 'load' });
    await contentScriptReady();
    await page.evaluate(() => {
      for (const id of ['first-name', 'last-name', 'email', 'phone', 'notes'])
        document.getElementById(id).value = '';
    });
    await valueInput(firstIdx).fill('Augusta');
    await blur();
    await waitFor(async () => /\bbuyerFirstName: 'Augusta'/.test(await script()), 'buyerFirstName: Augusta');
    check('Replay is enabled', await panel.evaluate(() => !document.getElementById('replayBtn').disabled));
    await clickInPanel('#replayBtn');
    if (!(await isHidden('#replaySecrets'))) await clickInPanel('#replaySecretsStart');
    const summary = () => text('#replaySummary');
    await waitFor(
      async () => /^Replay (passed|failed|stopped|couldn|interrupted)/.test(await summary()),
      'the replay to finish',
      45_000
    );
    check('the replay passes', /^Replay passed/.test(await summary()), await summary());
    const filled = await page.evaluate(() => ({
      first: document.getElementById('first-name').value,
      last: document.getElementById('last-name').value,
      email: document.getElementById('email').value,
      phone: document.getElementById('phone').value,
      country: document.getElementById('country').value,
      notes: document.getElementById('notes').value,
    }));
    check(
      'the page received the edited values (Augusta Byron), and the rest as recorded',
      filled.first === 'Augusta' &&
        filled.last === 'Byron' &&
        filled.email === 'ada@example.com' &&
        filled.phone === '+44 20 7946 0001' &&
        filled.country === 'Ireland' &&
        filled.notes === 'Ring the bell twice',
      JSON.stringify(filled)
    );
    const testDataAfterReplay = await tdRows();

    // ════════════════════════════════════════════════════════════════════════
    // 2. Health
    // ════════════════════════════════════════════════════════════════════════
    const hRows = () =>
      panel.$$eval('#healthList .ll-health-row', (rows) =>
        rows.map((r) => ({
          id: r.getAttribute('data-id'),
          status: (r.className.match(/\bhs-([\w-]+)/) || [])[1] ?? '',
          badge: r.querySelector('.ll-health-badge')?.textContent ?? '',
          label: r.querySelector('.ll-health-label')?.textContent ?? '',
          code: r.querySelector('.ll-health-code')?.textContent ?? '',
          meta: r.querySelector('.ll-health-meta')?.textContent ?? '',
          suggestion: r.querySelector('.ll-health-suggest .ll-health-code')?.textContent ?? '',
          hasUse: Boolean(r.querySelector('.ll-health-use')),
        }))
      );
    const healthStatus = () => text('#healthStatus');
    const tabBadge = () =>
      panel.evaluate(() => {
        const b = document.getElementById('healthTabBadge');
        return b.hidden ? '' : b.textContent;
      });
    const watchedSite = async (key = SITE) => (await storage('llWatched'))?.sites?.[key] ?? [];
    const onPage = (key) =>
      waitFor(async () => (await text('#healthPage')).includes(key), `Health on ${key}`);
    const checkNow = async (what) => {
      const before = await healthStatus();
      await clickInPanel('#healthCheckBtn');
      return waitFor(
        async () => {
          const s = await healthStatus();
          return /^Checked \d+ locator/.test(s) && (s !== before || what === 'again');
        },
        `Check now (${what})`,
        15_000
      );
    };
    const resolveIn = async (code) => {
      try {
        // Executing the locator the extension suggested is the point of the check.
        // eslint-disable-next-line no-new-func
        const loc = new Function('page', `return (${code});`)(page);
        const n = await loc.count();
        return { n, text: n === 1 ? await loc.textContent() : null };
      } catch (err) {
        return { n: -1, error: err.message.split('\n')[0] };
      }
    };

    console.log('\nHealth: watching a picked locator');
    await page.goto(DEMO, { waitUntil: 'load' });
    await contentScriptReady();
    await showTab('tab-health');
    check('the Health tab names the active page', await onPage(SITE), await text('#healthPage'));
    check(
      'nothing watched yet: the empty state shows, Check now is disabled',
      !(await isHidden('#healthEmpty')) &&
        (await panel.evaluate(() => document.getElementById('healthCheckBtn').disabled))
    );

    await showTab('tab-inspector');
    await clickInPanel('#inspectBtn');
    await page.waitForSelector('#ll-overlay', { state: 'attached', timeout: 5000 }).catch(() => {});
    const account = page.locator('[data-testid="account-menu"]');
    await account.hover();
    await page
      .waitForFunction(
        () => {
          const o = document.getElementById('ll-overlay')?.getBoundingClientRect();
          const t = document.querySelector('[data-testid="account-menu"]')?.getBoundingClientRect();
          return Boolean(o && t && Math.abs(o.width - t.width) < 4 && Math.abs(o.y - t.y) < 4);
        },
        null,
        { timeout: 5000 }
      )
      .catch(() => {});
    await account.click();
    const picked = await waitFor(
      async () =>
        (await panel.evaluate(() => (lastLocators[0]?.target?.value ?? '') === 'account-menu')) &&
        (await panel.locator('#cardsContainer .watch-btn').count()) > 0,
      'the pick in the panel'
    );
    check('Inspect picks the Account button into the panel', picked);
    await page.keyboard.press('Escape');
    const topTarget = await panel.evaluate(() => lastLocators[0]?.target);
    await clickInPanel('#cardsContainer .watch-btn[data-index="0"]');
    check(
      '☆ Watch on the top card turns into ★ Watching',
      await waitFor(
        async () =>
          (await panel.getAttribute('#cardsContainer .watch-btn[data-index="0"]', 'aria-pressed')) ===
            'true' && /Watching/.test(await text('#cardsContainer .watch-btn[data-index="0"]')),
        'the watching state'
      )
    );
    let site = await watchedSite();
    check(
      'llWatched holds the locator, its code and a fingerprint, under origin + path',
      site.length === 1 &&
        canonical(site[0].target) === canonical(topTarget) &&
        /getByTestId\('account-menu'\)/.test(site[0].code) &&
        site[0].fingerprint?.tag === 'button' &&
        site[0].fingerprint?.testId === 'account-menu',
      short(site)
    );
    await showTab('tab-health');
    await waitFor(async () => (await hRows()).length === 1, 'one Health row');
    let rows = await hRows();
    check(
      'the Health tab lists it as not checked',
      rows.length === 1 && rows[0].status === 'none' && /not checked/.test(rows[0].badge),
      short(rows)
    );
    check(
      'the summary counts it',
      /^1 watched on this page$/.test(await text('#healthSummary')),
      await text('#healthSummary')
    );
    // The tab badge counts locators that need attention; an unchecked one does not.
    check('no attention badge yet (nothing broken)', (await tabBadge()) === '', await tabBadge());
    const watchedId = rows[0].id;

    check('Check now → ok', await checkNow('ok'), await healthStatus());
    rows = await hRows();
    check(
      'the row is ok and matches 1 element',
      rows[0]?.status === 'ok' &&
        /matches 1 element/.test(rows[0].meta) &&
        /Checked just now/.test(rows[0].meta),
      short(rows)
    );
    check(
      'the status line says 1 ok',
      /Checked 1 locator: 1 ok\./.test(await healthStatus()),
      await healthStatus()
    );

    console.log('\nHealth: broken → suggestion → fixed');
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="account-menu"]');
      b.setAttribute('data-testid', 'acct-menu');
      b.removeAttribute('title');
    });
    check('Check now after the page changed', await checkNow('broken'), await healthStatus());
    rows = await hRows();
    check(
      'the row is broken and offers a suggested locator',
      rows[0]?.status === 'broken' && /broken/.test(rows[0].badge) && rows[0].hasUse && rows[0].suggestion,
      short(rows)
    );
    check('the tab badge shows 1 needing attention', (await tabBadge()) === '1', await tabBadge());
    check(
      'the status mentions the suggested fix',
      /1 suggested fix/.test(await healthStatus()),
      await healthStatus()
    );
    const suggested = await resolveIn(rows[0].suggestion);
    check(
      `the suggestion ${rows[0].suggestion} matches exactly the Account button`,
      suggested.n === 1 && suggested.text?.trim() === 'Account',
      JSON.stringify(suggested)
    );

    const copyRow = await copyAndPaste(`#healthList .ll-health-copy[data-id="${watchedId}"]`, async () =>
      /Copied/.test(await text(`#healthList .ll-health-copy[data-id="${watchedId}"]`))
    );
    check(
      'Copy on a row copies its locator',
      copyRow.copied && copyRow.text === rows[0].code,
      short(copyRow.calls)
    );
    notePaste('Copy on a Health row', copyRow, rows[0].code);
    await onPage(SITE);

    await clickInPanel(`#healthList .ll-health-use[data-id="${watchedId}"]`);
    check(
      '"Use suggested locator" replaces the locator and keeps the id',
      await waitFor(async () => {
        const r = (await hRows())[0];
        return r?.id === watchedId && r.status === 'none' && r.code === rows[0].suggestion;
      }, 'the replaced locator'),
      short(await hRows())
    );
    site = await watchedSite();
    check(
      'storage has the suggested target and no stale lastCheck',
      site.length === 1 &&
        site[0].id === watchedId &&
        !site[0].lastCheck &&
        site[0].code === rows[0].suggestion,
      short(site)
    );
    check('Check now → ok again', await checkNow('fixed'), await healthStatus());
    check('the suggested locator is ok', (await hRows())[0]?.status === 'ok', short(await hRows()));
    check('the attention badge clears', (await tabBadge()) === '');

    console.log('\nHealth: ambiguous');
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="acct-menu"]');
      const twin = b.cloneNode(true);
      twin.id = 'smoke-twin';
      b.after(twin);
    });
    check('Check now with a duplicated element', await checkNow('ambiguous'), await healthStatus());
    rows = await hRows();
    check(
      'the row is ambiguous and says how many match',
      rows[0]?.status === 'ambiguous' && /matches 2 elements/.test(rows[0].meta),
      short(rows)
    );
    check('the tab badge shows 1 again', (await tabBadge()) === '1');

    await clickInPanel(`#healthList .ll-health-remove[data-id="${watchedId}"]`);
    check(
      'Remove deletes the row; the empty state returns',
      await waitFor(
        async () => (await hRows()).length === 0 && !(await isHidden('#healthEmpty')),
        'the removal'
      )
    );
    check('Remove deletes it from storage too', (await watchedSite()).length === 0);

    console.log('\nHealth: Watch all from a whole-page Page Object');
    await page.goto(DEMO, { waitUntil: 'load' });
    await contentScriptReady();
    await showTab('tab-inspector');
    await clickInPanel('#pomScanBtn');
    const scanned = await waitFor(
      async () =>
        /Found \d+ element/.test(await text('#pomStatus')) &&
        (await panel.locator('#pomList .ll-pom-row').count()) > 0,
      'the whole-page scan'
    );
    check('Whole page lists the elements', scanned, await text('#pomStatus'));
    const pomCount = await panel.locator('#pomList .ll-pom-row').count();
    await clickInPanel('#pomWatchAllBtn');
    check(
      `Watch all watches all ${pomCount}`,
      await waitFor(
        async () => new RegExp(`Watching ${pomCount} locators`).test(await text('#pomStatus')),
        'the Watch all status'
      ),
      await text('#pomStatus')
    );
    await showTab('tab-health');
    check(
      `the Health tab lists ${pomCount} rows, all not checked`,
      await waitFor(async () => {
        const r = await hRows();
        return r.length === pomCount && r.every((x) => x.status === 'none');
      }, 'the watched rows'),
      `${(await hRows()).length} rows`
    );
    site = await watchedSite();
    check(
      'each watched element has a fingerprint',
      site.length === pomCount && site.every((it) => it.fingerprint && it.fingerprint.tag),
      short(site.filter((it) => !it.fingerprint?.tag))
    );
    check('Check now on the whole page', await checkNow('watch all'), await healthStatus());
    rows = await hRows();
    check(
      `all ${pomCount} are ok`,
      rows.length === pomCount && rows.every((r) => r.status === 'ok'),
      short(rows.filter((r) => r.status !== 'ok'))
    );
    check(
      'the status line says so',
      new RegExp(`Checked ${pomCount} locators: ${pomCount} ok\\.`).test(await healthStatus()),
      await healthStatus()
    );

    const removeId = rows[rows.length - 1].id;
    await clickInPanel(`#healthList .ll-health-remove[data-id="${removeId}"]`);
    check(
      'removing one row leaves the others',
      await waitFor(async () => {
        const r = await hRows();
        return r.length === pomCount - 1 && !r.some((x) => x.id === removeId);
      }, 'the removed row')
    );
    check(
      'and storage agrees',
      await waitFor(async () => {
        const s = await watchedSite();
        return s.length === pomCount - 1 && !s.some((x) => x.id === removeId);
      }, 'the stored removal')
    );
    await showTab('tab-inspector');
    await clickInPanel('#pomWatchAllBtn');
    check(
      'Watch all again adds only the removed one back',
      await waitFor(
        async () =>
          new RegExp(`Watching 1 locator\\b.*${pomCount - 1} already watched`).test(await text('#pomStatus')),
        'the dedupe status'
      ),
      await text('#pomStatus')
    );
    check('no duplicates in storage', (await watchedSite()).length === pomCount);
    await showTab('tab-health');
    await waitFor(async () => (await hRows()).length === pomCount, 'the re-added row');

    console.log('\nHealth: export and import');
    const exported = await download('#healthExportBtn');
    let exportedJson = null;
    try {
      exportedJson = JSON.parse(exported.body);
    } catch {
      exportedJson = null;
    }
    check(
      'Export JSON downloads locatra-watched-locators.json',
      exported.name === 'locatra-watched-locators.json',
      exported.error || exported.name
    );
    check(
      'the export is valid llWatched JSON with every watched locator',
      exportedJson?.version === 1 &&
        Object.keys(exportedJson.sites).join() === SITE &&
        exportedJson.sites[SITE].length === pomCount &&
        canonical(exportedJson) === canonical(await storage('llWatched')),
      short(exported.body)
    );
    await panel.setInputFiles('#healthImportFile', {
      name: 'locatra-watched-locators.json',
      mimeType: 'application/json',
      buffer: Buffer.from(exported.body),
    });
    check(
      'importing the export back dedupes everything',
      await waitFor(
        async () =>
          new RegExp(`Imported 0 locators\\. ${pomCount} already watched\\.`).test(await healthStatus()),
        'the import status'
      ),
      await healthStatus()
    );
    check('nothing grew', (await watchedSite()).length === pomCount && (await hRows()).length === pomCount);
    await panel.setInputFiles('#healthImportFile', {
      name: 'not-json.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{ nope'),
    });
    check(
      'a file that is not JSON is rejected',
      await waitFor(async () => /isn't valid JSON/.test(await healthStatus()), 'the JSON error'),
      await healthStatus()
    );
    await panel.setInputFiles('#healthImportFile', {
      name: 'other.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ version: 2, sites: {} })),
    });
    check(
      'a JSON file of another shape is rejected',
      await waitFor(
        async () => /isn't a Locatra watched-locators export/.test(await healthStatus()),
        'the shape error'
      ),
      await healthStatus()
    );

    console.log('\nHealth: other sites');
    await page.goto(OTHER, { waitUntil: 'load' });
    check('the Health tab follows the navigation', await onPage(OTHER_SITE), await text('#healthPage'));
    check(
      'the new page shows the empty state, Check now disabled',
      await waitFor(
        async () =>
          (await hRows()).length === 0 &&
          !(await isHidden('#healthEmpty')) &&
          (await panel.evaluate(() => document.getElementById('healthCheckBtn').disabled)),
        'the empty state'
      )
    );
    check(
      '"Other sites (1)" is shown',
      (await text('#healthOtherSummary')) === 'Other sites (1)',
      await text('#healthOtherSummary')
    );
    check(
      'and lists the checkout with its count',
      (await text('#healthOtherList')).includes(`${SITE} — ${pomCount} locators`),
      await text('#healthOtherList')
    );

    console.log('\nHealth: auto-check');
    // Count the panel's messages to the worker (installed in the panel's own realm).
    await panel.evaluate(() => {
      const log = (window.__smokeMsgs = []);
      const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (msg, ...rest) => {
        const entry = { type: msg && msg.type, done: false };
        log.push(entry);
        const i = rest.findIndex((x) => typeof x === 'function');
        if (i !== -1) {
          const cb = rest[i];
          rest[i] = (...a) => {
            entry.done = true;
            return cb(...a);
          };
        }
        return orig(msg, ...rest);
      };
    });
    const msgs = () => panel.evaluate(() => window.__smokeMsgs.map((m) => ({ ...m })));
    const countOf = async (type, done) =>
      (await msgs()).filter((m) => m.type === type && (done === undefined || m.done === done)).length;
    await panel.check('#settingHealthAutoCheck');
    check(
      'the auto-check setting is saved',
      await waitFor(
        async () => (await storage('llSettings'))?.healthAutoCheck === true,
        'healthAutoCheck=true'
      )
    );
    check('nothing to check on an unwatched page', (await countOf('HEALTH_CHECK')) === 0);
    const beforeNav = Date.now();
    await page.goto(DEMO, { waitUntil: 'load' });
    const autoChecked = await waitFor(
      async () => {
        const s = await watchedSite();
        return (
          (await countOf('HEALTH_CHECK', true)) >= 1 &&
          s.length === pomCount &&
          s.every((it) => it.lastCheck && it.lastCheck.at >= beforeNav)
        );
      },
      'the auto-check',
      15_000
    );
    check('arriving back on the watched page checks it automatically', autoChecked, short(await msgs()));
    check(
      'all rows are ok after the auto-check',
      await waitFor(
        async () => (await hRows()).every((r) => r.status === 'ok') && (await hRows()).length === pomCount,
        'ok rows'
      ),
      short((await hRows()).filter((r) => r.status !== 'ok'))
    );
    const pagesBefore = await countOf('GET_ACTIVE_PAGE', true);
    await page.reload({ waitUntil: 'load' });
    // The reload makes the panel ask which page is open again; once every request it
    // sent has been answered, a second auto-check would already have been sent.
    await waitFor(
      async () =>
        (await countOf('GET_ACTIVE_PAGE', true)) > pagesBefore &&
        (await countOf('GET_ACTIVE_PAGE', false)) === 0,
      'the panel to re-read the active page'
    );
    check(
      'it checks once: a reload of the same page does not check again',
      (await countOf('HEALTH_CHECK')) === 1,
      short(await msgs())
    );

    console.log('\nHealth: a hostile import');
    await contentScriptReady();
    const beforeHostile = await storage('llWatched');
    const huge = 'H'.repeat(1_000_000);
    const hostile =
      '{"version":1,"__proto__":{"polluted":"yes"},"sites":{' +
      '"__proto__":[{"id":"p1","target":{"kind":"css","selector":"#first-name"}}],' +
      '"constructor":[{"id":"c1","target":{"kind":"css","selector":"#first-name"}}],' +
      '"javascript:alert(1)//":[{"id":"j1","target":{"kind":"css","selector":"#first-name"}}],' +
      `"data:text/html,<script>window.top.__pwned=1</script>":[{"id":"d1","target":{"kind":"css","selector":"#email"}}],` +
      `${JSON.stringify(SITE)}:[` +
      JSON.stringify({
        id: '"><img src=x onerror="window.__pwned=1">',
        label: '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>',
        code: '<b onmouseover="window.__pwned=3">bold</b>',
        target: { kind: 'css', selector: '<img src=x onerror="window.__pwned=4">' },
        fingerprint: {
          tag: 'img',
          text: huge,
          href: 'javascript:alert(1)',
          classes: [huge, 'a', 'b', 'c', 'd', 'e', 'f'],
        },
        lastCheck: { at: 'never', status: '<script>', count: -5 },
      }) +
      ',' +
      JSON.stringify({
        id: 'huge',
        label: huge,
        code: huge,
        target: { kind: 'css', selector: '#notes', pad: huge },
      }) +
      ',' +
      JSON.stringify({
        id: 'proto',
        label: 'proto target',
        target: { kind: 'css', selector: '#phone', constructor: { prototype: { polluted: 'yes' } } },
      }) +
      ',{"id":"noTarget","label":"no target"},' +
      '{"id":"badKind","target":{"kind":""}},' +
      '"just a string",null,42' +
      '],"http://evil.test/x?y=1#z":[' +
      JSON.stringify({
        id: 'e1',
        label: '<iframe src="javascript:alert(1)"></iframe>',
        target: { kind: 'css', selector: 'a' },
      }) +
      ']}}';
    await panel.setInputFiles('#healthImportFile', {
      name: 'hostile.json',
      mimeType: 'application/json',
      buffer: Buffer.from(hostile),
    });
    check(
      'the hostile file is imported only as far as it validates',
      await waitFor(async () => /^Imported \d+ locators?\./.test(await healthStatus()), 'the import result'),
      await healthStatus()
    );
    const afterHostile = await storage('llWatched');
    const siteKeys = Object.keys(afterHostile.sites);
    check(
      'no __proto__ / constructor / javascript: / data: site was kept',
      siteKeys.every((k) => /^https?:\/\//.test(k)) &&
        !siteKeys.some((k) => /proto|constructor|javascript|data:/.test(k)),
      siteKeys.join(', ')
    );
    check(
      'no prototype was polluted',
      await panel.evaluate(() => ({}).polluted === undefined && Object.prototype.polluted === undefined)
    );
    const added = (afterHostile.sites[SITE] || []).filter(
      (it) => !(beforeHostile.sites[SITE] || []).some((b) => b.id === it.id)
    );
    check(
      'targets without a kind, non-objects and duplicates were skipped',
      added.length === 3 && !added.some((it) => /noTarget|badKind/.test(it.id)),
      short(added.map((it) => it.id))
    );
    check(
      'ids are re-minted when unsafe; strings are capped',
      added.every((it) => /^[A-Za-z0-9_-]{1,64}$/.test(it.id)) &&
        added.every((it) => it.label.length <= 200 && it.code.length <= 2000) &&
        added.every((it) => !it.fingerprint?.text || it.fingerprint.text.length <= 80) &&
        added.every((it) => !it.fingerprint?.classes || it.fingerprint.classes.length <= 5),
      short(added.map((it) => ({ id: it.id, label: it.label.length, code: it.code.length })))
    );
    check(
      'the huge target was rejected or capped (no megabyte in storage)',
      JSON.stringify(afterHostile).length < 200_000,
      `${JSON.stringify(afterHostile).length} chars stored`
    );
    check(
      'an invalid lastCheck is dropped',
      added.every((it) => !it.lastCheck),
      short(added.map((it) => it.lastCheck))
    );
    check(
      'the other http(s) site is kept under its origin + path only',
      siteKeys.includes('http://evil.test/x'),
      siteKeys.join(', ')
    );
    // Rendered as text, never as markup; then checked on the page, where nothing runs.
    await waitFor(async () => (await hRows()).length === pomCount + added.length, 'the imported rows');
    const panelDom = await panel.evaluate(() => ({
      injected: document.querySelectorAll(
        '#healthList img, #healthList script, #healthList b, #healthList iframe, #healthOtherList img, #healthOtherList iframe'
      ).length,
      pwned: window.__pwned ?? null,
      labels: [...document.querySelectorAll('#healthList .ll-health-label')].map((l) => l.textContent),
    }));
    check(
      'the panel shows the HTML as text and runs nothing',
      panelDom.injected === 0 && panelDom.pwned === null,
      JSON.stringify({ ...panelDom, labels: panelDom.labels.slice(-4) })
    );
    check(
      'the HTML label is shown verbatim as text',
      panelDom.labels.some((l) => l.startsWith('<img src=x onerror=')),
      short(panelDom.labels.slice(-4))
    );
    check(
      'Other sites lists evil.test as text',
      /http:\/\/evil\.test\/x — 1 locator/.test(await text('#healthOtherList')),
      await text('#healthOtherList')
    );
    check('Check now with the hostile rows', await checkNow('again'), await healthStatus());
    const hostileStatus = await hRows();
    check(
      'the hostile selector is reported, not executed',
      hostileStatus.filter((r) => added.some((a) => a.id === r.id)).every((r) => r.status !== 'none') &&
        (await page.evaluate(
          () => (window.__pwned ?? null) === null && document.querySelectorAll('img[src="x"]').length === 0
        )),
      short(hostileStatus.filter((r) => added.some((a) => a.id === r.id)))
    );
    check(
      'the original rows are still ok',
      hostileStatus.filter((r) => !added.some((a) => a.id === r.id)).every((r) => r.status === 'ok'),
      short(hostileStatus.filter((r) => r.status !== 'ok'))
    );
    for (const it of added) await clickInPanel(`#healthList .ll-health-remove[data-id="${it.id}"]`);
    check(
      'the imported rows can be removed again',
      await waitFor(
        async () => (await watchedSite()).length === pomCount && (await hRows()).length === pomCount,
        'the cleanup'
      )
    );
    const tooBig = Buffer.alloc(6 * 1024 * 1024, 0x20);
    await panel.setInputFiles('#healthImportFile', {
      name: 'big.json',
      mimeType: 'application/json',
      buffer: tooBig,
    });
    check(
      'a file over 5 MB is refused before it is read',
      await waitFor(async () => /too large/.test(await healthStatus()), 'the size error'),
      await healthStatus()
    );

    // ════════════════════════════════════════════════════════════════════════
    // 3. Persistence
    // ════════════════════════════════════════════════════════════════════════
    console.log('\npersistence');
    const watchedBefore = await storage('llWatched');
    const idsBefore = (await hRows()).map((r) => `${r.id}:${r.status}`);
    await page.bringToFront();
    await panel.reload({ waitUntil: 'load' });
    await panelCdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await showTab('tab-health');
    check(
      'after reopening the panel the watched locators are back',
      await waitFor(
        async () => (await hRows()).map((r) => `${r.id}:${r.status}`).join() === idsBefore.join(),
        'the restored rows',
        10_000
      ),
      `${(await hRows()).length} rows vs ${idsBefore.length}`
    );
    check(
      'and the other site is still listed',
      (await text('#healthOtherSummary')) === 'Other sites (1)',
      await text('#healthOtherSummary')
    );
    check('the auto-check setting is still on', await panel.isChecked('#settingHealthAutoCheck'));
    await showTab('tab-recorder');
    check(
      'the test-data names and edited values are back',
      await waitFor(
        async () =>
          JSON.stringify((await tdRows()).map((r) => [r.name, r.value])) ===
          JSON.stringify(testDataAfterReplay.map((r) => [r.name, r.value])),
        'the restored test data'
      ),
      short(await tdRows())
    );
    check(
      'and the script still uses them',
      await waitFor(
        async () =>
          /\bbuyerFirstName: 'Augusta'/.test(await script()) && /\blastName: 'Byron'/.test(await script()),
        'the restored script'
      )
    );
    check(
      'reopening changed nothing in llWatched but check times',
      JSON.stringify(stripChecks(await storage('llWatched'))) === JSON.stringify(stripChecks(watchedBefore))
    );

    console.log('\nsettings written elsewhere survive the panel toggles');
    // A change made elsewhere (the options page) reaches the open panel live.
    await worker.evaluate(async () => {
      const { llSettings } = await chrome.storage.local.get('llSettings');
      await chrome.storage.local.set({ llSettings: { ...llSettings, variables: false } });
    });
    check(
      'turning variables off in storage unchecks the toggle and restores literals live',
      await waitFor(
        async () =>
          !(await panel.isChecked('#settingVariables')) && /\.fill\('Augusta'\)/.test(await script()),
        'the live settings change'
      )
    );
    await panel.check('#settingVariables');
    await waitFor(async () => (await storage('llSettings'))?.variables === true, 'variables back on');

    await panel.evaluate(() => {
      document.getElementById('recSettings').open = true;
    });
    const toggles = [
      '#settingAutoAssertions',
      '#settingVariables',
      '#settingHealthAutoCheck',
      '#settingStepScreenshots',
    ];
    const field = {
      '#settingAutoAssertions': 'autoAssertions',
      '#settingVariables': 'variables',
      '#settingHealthAutoCheck': 'healthAutoCheck',
      '#settingStepScreenshots': 'stepScreenshots',
    };
    for (const sel of toggles) {
      if (!(await panel.isVisible(sel)))
        await showTab(sel === '#settingHealthAutoCheck' ? 'tab-health' : 'tab-recorder');
      const start = await panel.isChecked(sel);
      for (const want of [!start, start]) {
        // Turning screenshots on asks for <all_urls> (native UI); it saves either way.
        await panel.setChecked(sel, want);
        const saved = await waitFor(
          async () => (await storage('llSettings'))?.[field[sel]] === want,
          `${field[sel]}=${want}`
        );
        check(`${field[sel]} → ${want} is saved`, saved, short(await storage('llSettings')));
      }
    }
    const finalSettings = await storage('llSettings');
    check(
      'testIdAttributes, secretNames and unknown fields written elsewhere survive every toggle',
      JSON.stringify(finalSettings.testIdAttributes) === JSON.stringify(SEEDED_SETTINGS.testIdAttributes) &&
        JSON.stringify(finalSettings.secretNames) === JSON.stringify(SEEDED_SETTINGS.secretNames) &&
        JSON.stringify(finalSettings.futureField) === JSON.stringify(SEEDED_SETTINGS.futureField),
      short(finalSettings)
    );
    check(
      'the toggled fields are back where they were',
      finalSettings.autoAssertions === true &&
        finalSettings.variables === true &&
        finalSettings.healthAutoCheck === true &&
        finalSettings.stepScreenshots === true,
      short(finalSettings)
    );

    console.log('\nhygiene');
    check('the demo page logged no errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    check(
      'the panel logged no errors',
      panelErrors.filter((e) => !/permission/i.test(e)).length === 0,
      panelErrors.slice(0, 3).join(' | ')
    );
  } finally {
    await context.close();
    await server.close();
    rmSync(profile, { recursive: true, force: true });
  }

  const passed = results.length - failures;
  console.log(`\n${failures ? '✗' : '✓'} ${passed}/${results.length} checks passed`);
  if (failures) process.exit(1);
}

// ── helpers ────────────────────────────────────────────────────────────────

async function expandTimeline(panel) {
  const header = panel.locator('#timelineToggleHeader');
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
}

function jsQuote(s) {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** snake_case as codegen's Python keys (firstName → first_name). */
function snake(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

const DECL_START = {
  python: /^\s*TEST_DATA\s*=\s*\{/m,
  java: /^\s*(private\s+)?static\s+final\s+Map<String,\s*String>\s+TEST_DATA\s*=/m,
  csharp: /^\s*(private\s+)?static\s+readonly\s+IReadOnlyDictionary<string,\s*string>\s+TestData\s*=/m,
};
const JS_DECL = /^\s*const testData = \{/m;

/** The test-data declaration of a script and everything else: { found, count, text, rest }. */
function declarationOf(script, lang) {
  const re = DECL_START[lang] ?? JS_DECL;
  const global = new RegExp(re.source, 'gm');
  const count = (script.match(global) || []).length;
  const m = re.exec(script);
  if (!m) return { found: false, count, text: '', rest: script };
  const lines = script.split('\n');
  const startLine = script.slice(0, m.index + m[0].length).split('\n').length - 1;
  let depth = 0;
  let opened = false;
  let end = startLine;
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{' || ch === '(') {
        depth++;
        opened = true;
      } else if (ch === '}' || ch === ')') depth--;
    }
    end = i;
    if (opened && depth <= 0) break;
  }
  const text = lines.slice(startLine, end + 1).join('\n');
  const rest = [...lines.slice(0, startLine), ...lines.slice(end + 1)].join('\n');
  // Cypress passes the object into cy.origin blocks too: those are references.
  return { found: true, count, text, rest };
}

function keyFor(name, lang) {
  if (lang === 'python') return `"${snake(name)}"`;
  if (lang === 'java') return `"${name}"`;
  if (lang === 'csharp') return `["${name}"]`;
  return `${name}:`;
}

function refFor(name, lang) {
  if (lang === 'python') return `TEST_DATA["${snake(name)}"]`;
  if (lang === 'java') return `TEST_DATA.get("${name}")`;
  if (lang === 'csharp') return `TestData["${name}"]`;
  return `testData.${name}`;
}

/** Does a script read as the given framework × language (its imports / API)? */
function looksLike(fw, lang, s) {
  const marks = {
    python: { playwright: /^from playwright\b/m, selenium: /^from selenium\b/m },
    java: {
      playwright: /^import com\.microsoft\.playwright\b/m,
      selenium: /^import org\.openqa\.selenium\b/m,
    },
    csharp: { playwright: /^using Microsoft\.Playwright\b/m, selenium: /^using OpenQA\.Selenium\b/m },
    js: {
      playwright: /from '@playwright\/test'|require\('@playwright\/test'\)/,
      selenium: /selenium-webdriver/,
      cypress: /\bcy\.visit\(/,
      webdriverio: /@wdio\/globals|\bbrowser\.url\(/,
    },
  };
  const family = marks[lang] ?? marks.js;
  const re = family[fw];
  return re ? re.test(s) : true;
}

/** Key-order-independent JSON. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

/** llWatched without the per-check fields (an auto-check on reopen may refresh them). */
function stripChecks(state) {
  const out = { version: state?.version, sites: {} };
  for (const [k, list] of Object.entries(state?.sites ?? {})) {
    out.sites[k] = list.map(({ lastCheck, ...rest }) => ({ ...rest, status: lastCheck?.status ?? null }));
  }
  return out;
}

/** What a real paste (Ctrl+V into a fresh textarea) yields. */
async function pasteClipboard(context) {
  const scratch = await context.newPage();
  try {
    await scratch.setContent('<textarea id="paste" style="width:600px;height:400px"></textarea>');
    await scratch.bringToFront();
    await scratch.focus('#paste');
    await scratch.keyboard.press('ControlOrMeta+V');
    await until(async () => (await scratch.inputValue('#paste')).length > 0, {
      timeout: 3000,
      what: 'the paste',
    }).catch(() => {});
    return await scratch.inputValue('#paste');
  } catch (err) {
    return `<<${err.message.split('\n')[0]}>>`;
  } finally {
    await scratch.close();
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err.stack || err.message}\n`);
  rmSync(profile, { recursive: true, force: true });
  process.exit(1);
});
