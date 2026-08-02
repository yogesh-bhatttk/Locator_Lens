#!/usr/bin/env node
// End-to-end smoke test against the built extension in a real browser.
//
// The Vitest suites run in jsdom, which has no layout — so the picker's hit test
// (document.elementFromPoint), innerText semantics and the real message plumbing
// between content script, service worker and side panel are not covered there.
// This fills that gap, and goes one step further: the locators the extension
// generates are handed back to Playwright and executed against the same page, so
// a locator that looks right but does not resolve is a failure.
//
//   npm run build && npm run smoke
//
// Needs a display. Uses Playwright's Chromium because Chrome 137 dropped support
// for --load-extension.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = join(ROOT, 'dist/chrome');
const DEMO_HTML = join(ROOT, 'scripts/screenshots/demo-page.html');
const PORT = 4174;
const DEMO = `http://localhost:${PORT}/checkout`;
const profile = join(ROOT, '.tmp-smoke-profile');

const results = [];
let failures = 0;

function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures++;
  results.push({ ok, name, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail && !ok ? `\n      ${detail}` : ''}`);
  return ok;
}

async function main() {
  if (!existsSync(EXTENSION)) throw new Error('dist/chrome missing — run `npm run build` first.');

  const html = readFileSync(DEMO_HTML);
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));

  rmSync(profile, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: resolveChromium(),
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });

  try {
    const extensionId = computeExtensionId(EXTENSION);
    const page = await context.newPage();

    // Any uncaught page error means the content script broke someone's site.
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));

    await page.goto(DEMO, { waitUntil: 'load' });
    await page.waitForTimeout(500);

    const panel = await context.newPage();
    await panel.setViewportSize({ width: 460, height: 900 });
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel.html`);
    await panel.waitForTimeout(700);

    const [worker] = context.serviceWorkers();
    check('extension loads and the service worker is running', Boolean(worker));

    const toDemo = (message) =>
      worker.evaluate(async (msg) => {
        const tabs = await chrome.tabs.query({});
        // Match the host, not the path: the multi-page check navigates away from
        // /checkout and the demo server answers every path with the same page.
        const t = tabs.find((x) => (x.url || '').includes('localhost:4174'));
        if (!t) return false;
        await chrome.tabs.sendMessage(t.id, msg).catch(() => {});
        return true;
      }, message);

    console.log('\ninspect');
    await toDemo({ type: 'START_INSPECT' });
    await page.bringToFront();
    await page.waitForTimeout(300);

    await page.locator('#email').hover();
    // Wait for the overlay to actually be positioned rather than sleeping: it is
    // created with a 1px border, so isVisible() is true before updateOverlay() has
    // ever run and a fixed delay races the first mouseover.
    await page
      .waitForFunction(
        () => (document.getElementById('ll-overlay')?.getBoundingClientRect().width ?? 0) > 20,
        null,
        {
          timeout: 5000,
        }
      )
      .catch(() => {});

    const box = await page.locator('#ll-overlay').boundingBox();
    const target = await page.locator('#email').boundingBox();
    check(
      'overlay is positioned over the hovered element',
      box && target && Math.abs(box.width - target.width) < 4 && Math.abs(box.y - target.y) < 4,
      `overlay ${JSON.stringify(box)} vs element ${JSON.stringify(target)}`
    );
    check(
      'tooltip names the element',
      (await page.locator('#ll-tooltip').textContent())?.includes('input#email')
    );

    // A real click, hit-tested through document.elementFromPoint.
    await page.locator('#email').click();
    await page.waitForTimeout(700);

    const picked = await worker.evaluate(
      async () => (await chrome.storage.local.get('lastElement')).lastElement
    );
    check(
      'clicking picks the element and stores the result',
      picked?.elementData?.id === 'email',
      `stored id was ${JSON.stringify(picked?.elementData?.id)}`
    );
    check(
      'locators were generated',
      (picked?.locators?.length ?? 0) >= 3,
      `got ${picked?.locators?.length ?? 0}`
    );
    check(
      'top locator is the test id',
      picked?.locators?.[0]?.target?.kind === 'testid',
      `got ${picked?.locators?.[0]?.target?.kind}`
    );
    check('uniqueness was measured against the live page', picked?.locators?.[0]?.unique === true);

    // Keyboard traversal needs a focused document and a live overlay.
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(300);
    check('ArrowUp walks to the parent element', await page.locator('#ll-overlay').isVisible());

    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    check('Escape tears the overlay down', (await page.locator('#ll-overlay').count()) === 0);

    console.log('\nselector lab');
    await toDemo({ type: 'LAB_VALIDATE', selector: "page.getByRole('button', { name: 'Place order' })" });
    await page.waitForTimeout(500);
    check(
      'a pasted Playwright locator highlights its match',
      (await page.locator('.ll-lab-highlight').count()) === 1
    );
    check(
      'the highlight stylesheet is present without inspecting first',
      (await page.locator('#ll-styles').count()) === 1
    );

    await toDemo({ type: 'LAB_CLEAR' });
    await page.waitForTimeout(300);
    check('clear removes every highlight', (await page.locator('.ll-lab-highlight').count()) === 0);

    console.log('\nrecorder');
    await panel.bringToFront();
    await panel.click('[data-target="tab-recorder"]');
    await panel.waitForTimeout(300);
    await toDemo({ type: 'START_RECORDING' });
    await panel.waitForTimeout(300);

    await page.bringToFront();
    await page.click('#first-name');
    await page.fill('#first-name', 'Ada');
    await page.waitForTimeout(700);
    await page.selectOption('#country', 'Ireland');
    await page.waitForTimeout(500);
    await page.check('#gift-wrap');
    await page.waitForTimeout(500);
    await page.uncheck('#save-details');
    await page.waitForTimeout(500);
    await page.click('[data-testid="place-order"]');
    await page.waitForTimeout(700);
    await toDemo({ type: 'STOP_RECORDING' });

    await panel.bringToFront();
    await panel.waitForTimeout(600);
    const script = await panel.evaluate(() => document.getElementById('codePreview')?.innerText ?? '');

    check('a test script was generated', script.includes('@playwright/test'));
    check('the fill was captured', /\.fill\('Ada'\)/.test(script));
    check('the select was captured', /selectOption\('Ireland'\)/.test(script));
    check('checking a box records check()', /\.check\(\)/.test(script));
    check(
      'unchecking records uncheck(), not check()',
      /\.uncheck\(\)/.test(script),
      'the pointer handler used to emit check() before the control toggled'
    );

    const checkCalls = (script.match(/\.check\(\)/g) || []).length;
    check('a single tick produces exactly one step', checkCalls === 1, `found ${checkCalls} .check() calls`);

    console.log('\ngenerated locators actually resolve');
    // The real proof: run what the extension wrote back through Playwright.
    const locators = [
      ...script.matchAll(/page\.(getBy\w+)\(([^\n]*?)\)(?=\.(?:click|fill|check|uncheck|selectOption)\()/g),
    ];
    check('locator lines were found in the script', locators.length >= 4, `found ${locators.length}`);

    for (const [, method, args] of locators) {
      let count = -1;
      try {
        // eslint-disable-next-line no-eval -- evaluating our own generated locator is the point of the test
        count = await eval(`page.${method}(${args})`).count();
      } catch (err) {
        check(`page.${method}(${args.slice(0, 50)}) resolves`, false, err.message.split('\n')[0]);
        continue;
      }
      check(
        `page.${method}(${args.slice(0, 46)}) matches exactly 1 element`,
        count === 1,
        `matched ${count}`
      );
    }

    // Recording a real flow means navigating. Capture on the new page is re-armed by
    // the service worker from its own tab set, and nothing until now exercised that
    // hand-off end to end — a break here silently truncates every multi-page recording.
    console.log('\nrecording across a navigation');
    await panel.bringToFront();
    await panel.click('#clearTimelineBtn');
    await panel.waitForTimeout(300);
    // Drive this one through the service worker, exactly as the panel's Record
    // button does: the worker is what remembers which tab is recording, and that
    // memory is the whole mechanism being tested. Messaging the content script
    // directly (as toDemo does) would skip it entirely.
    await page.bringToFront();
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'START_RECORDING' }));
    await page.waitForTimeout(400);

    await page.click('[data-testid="account-menu"]');
    await page.waitForTimeout(400);
    await page.goto(`http://localhost:${PORT}/confirmation`, { waitUntil: 'load' });
    await page.waitForTimeout(1200); // document_idle re-injection + the worker's re-arm
    await page.click('#last-name');
    await page.fill('#last-name', 'Lovelace');
    await page.waitForTimeout(800);
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }));

    await panel.bringToFront();
    await panel.waitForTimeout(600);
    const multiPage = await panel.evaluate(() => document.getElementById('codePreview')?.innerText ?? '');
    check('the step before the navigation is kept', /account-menu/.test(multiPage), multiPage.slice(0, 400));
    check('capture resumes on the page navigated to', /Lovelace/.test(multiPage), multiPage.slice(0, 400));

    console.log('\nhygiene');
    check(
      'the content script logged nothing to the page console',
      pageErrors.length === 0,
      pageErrors.slice(0, 3).join(' | ')
    );

    await panel.reload();
    await panel.waitForTimeout(800);
    const restored = await panel.evaluate(() => document.getElementById('codePreview')?.innerText ?? '');
    check('the recording survives reopening the panel', restored.includes('@playwright/test'));
  } finally {
    await context.close();
    await new Promise((ok) => server.close(ok));
    rmSync(profile, { recursive: true, force: true });
  }

  const passed = results.length - failures;
  console.log(`\n${failures ? '✗' : '✓'} ${passed}/${results.length} checks passed`);
  if (failures) process.exit(1);
}

function computeExtensionId(absolutePath) {
  const digest = createHash('sha256').update(absolutePath, 'utf8').digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (digest[i] >> 4)) + String.fromCharCode(97 + (digest[i] & 0x0f));
  }
  return id;
}

function resolveChromium() {
  const configured = chromium.executablePath();
  if (configured && existsSync(configured)) return configured;
  const cache = join(process.env.HOME ?? '', '.cache/ms-playwright');
  for (const build of readdirSync(cache)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))) {
    for (const v of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = join(cache, build, v);
      if (existsSync(p)) return p;
    }
  }
  throw new Error('No Playwright Chromium found. Run `npx playwright install chromium`.');
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}\n`);
  rmSync(profile, { recursive: true, force: true });
  process.exit(1);
});
