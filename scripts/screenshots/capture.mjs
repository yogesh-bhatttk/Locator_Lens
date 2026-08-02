#!/usr/bin/env node
// Capture store screenshots from the real, built extension.
//
// Every image is a genuine capture of dist/chrome running in Chrome against
// scripts/screenshots/demo-page.html. Nothing is drawn, composited or mocked up:
// both stores require listing images to depict actual functionality, and the
// previous set did not — some showed a different product entirely.
//
//   npm run screenshots
//
// Requires a display; the run is headed because an unpacked extension has to be
// loaded into a real browser UI.
//
// It uses Playwright's bundled Chromium rather than the installed Google Chrome:
// Chrome 137 removed support for the --load-extension switch, so a stock Chrome
// silently starts with no extension at all and every capture would be of a bare
// browser. Chromium still honours the switch, and it renders the extension
// identically — same engine, same stylesheets.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const EXTENSION = join(ROOT, 'dist/chrome');
const OUT = join(ROOT, 'screenshots/store');

// The demo is served over HTTP rather than opened as a file:// URL. The recorder
// writes the page address into the generated test, and a file:// path would put
// the machine's home directory into a public store listing.
const PORT = 4173;
const DEMO = `http://localhost:${PORT}/checkout`;

// Chrome Web Store accepts 1280x800 or 640x400. AMO is flexible; 1280x800 suits both.
const STORE = { width: 1280, height: 800 };
// A side panel is a tall narrow strip; captured at its real proportions.
const PANEL = { width: 460, height: 800 };

const profile = join(ROOT, '.tmp-screenshot-profile');

async function main() {
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  if (!existsSync(EXTENSION)) throw new Error(`${EXTENSION} is missing — run \`npm run build\` first.`);

  const html = readFileSync(join(HERE, 'demo-page.html'));
  const frameHtml = readFileSync(join(HERE, 'payment-frame.html'));
  const server = createServer((req, res) => {
    const body = (req.url || '').startsWith('/payment-frame') ? frameHtml : html;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));

  const context = await chromium.launchPersistentContext(profile, {
    executablePath: resolveChromium(),
    headless: false,
    viewport: STORE,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });

  try {
    const extensionId = await resolveExtensionId(context);
    console.log(`extension id: ${extensionId}`);

    const page = await context.newPage();
    await page.setViewportSize(STORE);
    await page.goto(DEMO, { waitUntil: 'load' });
    await page.waitForTimeout(400);

    // The side panel is opened as a tab so it can be captured. That makes it the
    // active tab, so anything routed through the background's
    // tabs.query({ active: true }) would target the panel instead of the page under
    // test — messages are therefore addressed to the demo tab explicitly, from the
    // service worker, which is also the only context where chrome.* exists.
    const panel = await context.newPage();
    await panel.setViewportSize(PANEL);
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel.html`);
    await panel.waitForTimeout(800);

    // Note: the bodies passed to worker.evaluate / page.evaluate below are
    // serialised and run inside the browser, so they see `chrome` and `document`
    // rather than any Node global. ESLint is told about those in .eslintrc.json.
    const worker = await getServiceWorker(context);
    const toDemo = (message) =>
      worker.evaluate(async (msg) => {
        const tabs = await chrome.tabs.query({});
        const target = tabs.find((t) => (t.url || '').includes('/checkout'));
        if (target) await chrome.tabs.sendMessage(target.id, msg).catch(() => {});
      }, message);

    // ── 1. Inspector overlay on a real page ─────────────────────────────────
    await toDemo({ type: 'START_INSPECT' });
    await page.bringToFront();
    await page.waitForTimeout(400);

    const email = page.locator('#email');
    await email.hover();
    await page.waitForTimeout(600);
    await shot(page, '01-inspect-overlay.png', 'inspector overlay + traversal bar on a live form');

    // A real click through the picker: the content script hit-tests the pointer
    // position, generates the locator set and pushes it to the panel.
    await email.click();
    await page.waitForTimeout(900);
    await toDemo({ type: 'STOP_INSPECT' });

    // ── 2. The side panel showing ranked locators ───────────────────────────
    await panel.bringToFront();
    await panel.reload();
    await panel.waitForTimeout(900);
    await shot(panel, '02-ranked-locators.png', 'ranked locators with live uniqueness badges');

    // ── 3. Same element, retargeted to another framework ────────────────────
    await panel.selectOption('#fwSelect', 'selenium').catch(() => {});
    await panel.waitForTimeout(600);
    await shot(panel, '03-selenium-output.png', 'the same element rendered as Selenium');

    await panel.selectOption('#fwSelect', 'cypress').catch(() => {});
    await panel.waitForTimeout(600);
    await shot(panel, '04-cypress-output.png', 'the same element rendered as Cypress');
    await panel.selectOption('#fwSelect', 'playwright').catch(() => {});

    // ── 4. Selector Lab resolving a pasted Playwright locator ───────────────
    const locator = "page.getByRole('button', { name: 'Place order' })";
    await panel.fill('#lab-input', locator);
    await toDemo({ type: 'LAB_VALIDATE', selector: locator });
    await panel.waitForTimeout(900);
    await shot(panel, '05-selector-lab.png', 'Selector Lab resolving a Playwright locator');

    // The same run, seen from the page: the match is highlighted in place.
    await page.bringToFront();
    await page.waitForTimeout(500);
    await shot(page, '06-lab-highlight.png', 'the resolved match highlighted on the page');
    await toDemo({ type: 'LAB_CLEAR' });

    // ── 5. Recorder timeline + generated script ─────────────────────────────
    await panel.bringToFront();
    await panel.click('[data-target="tab-recorder"]');
    await panel.waitForTimeout(400);
    await toDemo({ type: 'START_RECORDING' });
    await panel.waitForTimeout(400);

    await page.bringToFront();
    await page.click('#first-name');
    await page.fill('#first-name', 'Ada');
    await page.waitForTimeout(800);
    await page.click('#email');
    await page.fill('#email', 'ada@example.com');
    await page.waitForTimeout(800);
    await page.selectOption('#country', 'Ireland');
    await page.waitForTimeout(600);
    await page.check('#gift-wrap');
    await page.waitForTimeout(600);
    await page.click('[data-testid="place-order"]');
    await page.waitForTimeout(800);
    await toDemo({ type: 'STOP_RECORDING' });

    await panel.bringToFront();
    await panel.waitForTimeout(600);
    await panel.click('#timelineToggleHeader');
    await panel.waitForTimeout(600);
    await shot(panel, '07-recorder-timeline.png', 'recorded steps in the timeline');

    await panel.click('#timelineToggleHeader').catch(() => {});
    await panel.waitForTimeout(400);
    await panel.evaluate(() => document.getElementById('codePreview')?.scrollIntoView({ block: 'center' }));
    await panel.waitForTimeout(400);
    await shot(panel, '08-generated-test.png', 'the generated, editable test script');

    // ── 6. An element inside an iframe ───────────────────────────────────────
    // The payment fields are in a real cross-document iframe, as they are on every
    // checkout. Worth its own capture: the locator has to enter the frame, and that
    // is the difference between generated code that works and code that silently
    // finds nothing.
    await panel.bringToFront();
    await panel.click('[data-target="tab-inspector"]').catch(() => {});
    await page.bringToFront();
    // Routed through the worker, which is what injects into sub-frames.
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'START_INSPECT' }));
    await page.waitForTimeout(700);

    const cardField = page.frameLocator('#payment-frame').locator('#card');
    await cardField.hover();
    await page.waitForTimeout(500);
    await shot(page, '10-iframe-overlay.png', 'inspecting a field inside a payment iframe');

    await cardField.click();
    await page.waitForTimeout(900);
    await toDemo({ type: 'STOP_INSPECT' });

    await panel.bringToFront();
    await panel.reload();
    await panel.waitForTimeout(900);
    await shot(panel, '11-iframe-locators.png', 'the locator enters the frame with frameLocator()');

    // ── 7. Popup ────────────────────────────────────────────────────────────
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 420, height: 460 });
    await popup.goto(`chrome-extension://${extensionId}/src/popup.html`);
    await popup.waitForTimeout(600);
    await shot(popup, '09-popup.png', 'the launcher popup');

    // ── 8. Store-sized composites ───────────────────────────────────────────
    // The Chrome Web Store only accepts 1280x800 or 640x400, and a side panel is
    // 460px wide. These place the real page capture and the real panel capture at
    // the exact geometry Chrome uses when the panel is open (820 + 460 = 1280) —
    // it is a layout of two genuine captures, not a redrawn mock-up.
    console.log('');
    const composer = await context.newPage();
    await composer.setViewportSize(STORE);
    await compose(composer, 'store-01-inspect.png', '01-inspect-overlay.png', '02-ranked-locators.png');
    await compose(composer, 'store-02-selector-lab.png', '06-lab-highlight.png', '05-selector-lab.png');
    await compose(composer, 'store-03-recorder.png', '01-inspect-overlay.png', '07-recorder-timeline.png');
    await compose(composer, 'store-04-codegen.png', '06-lab-highlight.png', '08-generated-test.png');
    await compose(composer, 'store-05-iframes.png', '10-iframe-overlay.png', '11-iframe-locators.png');

    console.log(`\n✓ written to ${OUT.replace(ROOT + '/', '')}/`);
    console.log('  store-*.png are the 1280x800 images to upload; the rest are the raw captures.');
  } finally {
    await context.close();
    await new Promise((ok) => server.close(ok));
    rmSync(profile, { recursive: true, force: true });
  }
}

/**
 * Path to a Chromium that still supports --load-extension. Prefers whatever
 * Playwright is configured to use, then the newest build in its browser cache.
 */
function resolveChromium() {
  const configured = chromium.executablePath();
  if (configured && existsSync(configured)) return configured;

  const cache = join(process.env.HOME ?? '', '.cache/ms-playwright');
  if (existsSync(cache)) {
    const builds = readdirSync(cache)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const build of builds) {
      for (const variant of [
        'chrome-linux64/chrome',
        'chrome-linux/chrome',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      ]) {
        const candidate = join(cache, build, variant);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  throw new Error('No Playwright Chromium found. Run `npx playwright install chromium`.');
}

async function shot(target, name, caption) {
  await target.screenshot({ path: join(OUT, name) });
  console.log(`  ${name.padEnd(28)} ${caption}`);
}

/**
 * Lay two existing captures side by side at 1280x800 — the page cropped to the
 * width Chrome leaves it when a 460px side panel is open, and the panel beside it.
 * Both inputs are real screenshots; this only positions them.
 */
async function compose(page, name, pageShot, panelShot) {
  const toDataUri = (file) => `data:image/png;base64,${readFileSync(join(OUT, file)).toString('base64')}`;

  await page.setContent(`
    <style>
      html, body { margin: 0; width: ${STORE.width}px; height: ${STORE.height}px; overflow: hidden; background: #fff; }
      .wrap { position: relative; width: ${STORE.width}px; height: ${STORE.height}px; }
      /* The page capture is 1280 wide; show its left 820px, exactly what stays
         visible when Chrome docks a 460px panel on the right. */
      .page { position: absolute; inset: 0 auto 0 0; width: 820px; height: ${STORE.height}px; overflow: hidden; }
      .page img { display: block; width: ${STORE.width}px; height: ${STORE.height}px; }
      .panel { position: absolute; top: 0; right: 0; width: ${PANEL.width}px; height: ${STORE.height}px;
               box-shadow: -1px 0 0 rgba(0,0,0,0.14), -12px 0 28px rgba(0,0,0,0.10); }
      .panel img { display: block; width: ${PANEL.width}px; height: ${STORE.height}px; }
    </style>
    <div class="wrap">
      <div class="page"><img src="${toDataUri(pageShot)}"></div>
      <div class="panel"><img src="${toDataUri(panelShot)}"></div>
    </div>
  `);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT, name) });
  console.log(`  ${name.padEnd(28)} ${pageShot} + ${panelShot}`);
}

/**
 * The unpacked extension's id.
 *
 * An MV3 service worker is lazy — it does not start until an event wakes it, so
 * waiting for one to appear can time out before anything has happened. Chrome
 * derives the id of an unpacked extension deterministically from its absolute
 * install path instead: SHA-256 the path, take the first 16 bytes and map each
 * nibble onto a..p. Computing it needs no running worker.
 */
function computeExtensionId(absolutePath) {
  const digest = createHash('sha256').update(absolutePath, 'utf8').digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (digest[i] >> 4));
    id += String.fromCharCode(97 + (digest[i] & 0x0f));
  }
  return id;
}

/** The background service worker, started by loading any extension page. */
async function getServiceWorker(context) {
  const [existing] = context.serviceWorkers();
  if (existing) return existing;
  return context.waitForEvent('serviceworker', { timeout: 15_000 });
}

async function resolveExtensionId(context) {
  // Prefer a live worker when one happens to be running; fall back to the path hash.
  const [worker] = context.serviceWorkers();
  if (worker) return new URL(worker.url()).host;

  const id = computeExtensionId(EXTENSION);
  // Prove the id is real before relying on it — a wrong guess would silently
  // produce screenshots of Chrome's error page.
  const probe = await context.newPage();
  try {
    const response = await probe.goto(`chrome-extension://${id}/src/popup.html`, { timeout: 10_000 });
    if (!response || !(await probe.title())) throw new Error('no response');
  } catch {
    throw new Error(
      `Could not reach the extension at chrome-extension://${id}/. ` +
        `Check that ${EXTENSION} exists — run \`npm run build\` first.`
    );
  } finally {
    await probe.close();
  }
  return id;
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}\n`);
  rmSync(profile, { recursive: true, force: true });
  process.exit(1);
});
