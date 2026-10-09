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
const FRAME_HTML = join(ROOT, 'scripts/screenshots/payment-frame.html');
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
  const frameHtml = readFileSync(FRAME_HTML);
  const server = createServer((req, res) => {
    const body = (req.url || '').startsWith('/payment-frame') ? frameHtml : html;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
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

    const panel = await context.newPage();
    await panel.setViewportSize({ width: 460, height: 900 });
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel.html`, { waitUntil: 'load' });

    // An MV3 worker starts lazily and may not exist yet when the first extension
    // page finishes loading; reading context.serviceWorkers() once raced that.
    const worker = await waitForServiceWorker(context, extensionId);
    check('extension loads and the service worker is running', Boolean(worker));
    if (!worker) throw new Error('no service worker — nothing further can be driven');

    // The window the panel tab and the demo tab share. Messages sent the way the
    // real panel sends them carry it, so the worker resolves the right active tab.
    const windowId = await panel.evaluate(async () => (await chrome.windows.getCurrent()).id);
    const viaWorker = (message) =>
      panel.evaluate((msg) => chrome.runtime.sendMessage(msg).catch(() => undefined), {
        ...message,
        windowId,
      });

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

    /** Resolve once the demo tab's top frame has a content script listening. */
    const contentScriptReady = () =>
      until(
        () =>
          worker.evaluate(async () => {
            const tabs = await chrome.tabs.query({});
            const t = tabs.find((x) => (x.url || '').includes('localhost:4174'));
            if (!t) return false;
            // "Receiving end does not exist" means no content script yet. Any
            // other outcome — an answer, or a listener that did not reply — means
            // one is there.
            return chrome.tabs
              .sendMessage(t.id, { type: 'PING' }, { frameId: 0 })
              .then(() => true)
              .catch((e) => !/Receiving end does not exist/i.test(String(e?.message ?? e)));
          }),
        { timeout: 10_000, what: 'content script in the demo page' }
      );

    const lastPick = () =>
      worker.evaluate(async () => (await chrome.storage.local.get('lastElement')).lastElement);
    const preview = () => panel.evaluate(() => document.getElementById('codePreview')?.innerText ?? '');

    await contentScriptReady();

    console.log('\ninspect');
    await toDemo({ type: 'START_INSPECT' });
    await page.bringToFront();
    // Inspect mode is live once its overlay exists; hovering earlier is a no-op.
    await page.waitForSelector('#ll-overlay', { state: 'attached', timeout: 3000 }).catch(() => {});

    await page.locator('#email').hover();
    // Wait for the overlay to actually be positioned rather than sleeping: it is
    // created with a 1px border, so isVisible() is true before updateOverlay() has
    // ever run and a fixed delay races the first mouseover.
    // Wait for it to sit over the target itself — an earlier pointer position can
    // leave it over some other element first.
    await page
      .waitForFunction(
        () => {
          const o = document.getElementById('ll-overlay')?.getBoundingClientRect();
          const t = document.getElementById('email')?.getBoundingClientRect();
          return Boolean(o && t && Math.abs(o.width - t.width) < 4 && Math.abs(o.y - t.y) < 4);
        },
        null,
        { timeout: 5000 }
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
    await until(async () => (await lastPick())?.elementData?.id === 'email', {
      timeout: 5000,
      what: 'the pick to be stored',
    }).catch(() => {});

    const picked = await lastPick();
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
    await page
      .waitForFunction(() => !document.getElementById('ll-overlay'), null, { timeout: 3000 })
      .catch(() => {});
    check('Escape tears the overlay down', (await page.locator('#ll-overlay').count()) === 0);

    console.log('\nselector lab');
    await toDemo({ type: 'LAB_VALIDATE', selector: "page.getByRole('button', { name: 'Place order' })" });
    await page
      .waitForFunction(() => document.querySelectorAll('[data-locatra-lab]').length > 0, null, {
        timeout: 3000,
      })
      .catch(() => {});
    check(
      'a pasted Playwright locator highlights its match',
      (await page.locator('[data-locatra-lab]').count()) === 1
    );
    check(
      'the highlight stylesheet is present without inspecting first',
      (await page.locator('#ll-styles').count()) === 1
    );

    await toDemo({ type: 'LAB_CLEAR' });
    await page
      .waitForFunction(() => document.querySelectorAll('[data-locatra-lab]').length === 0, null, {
        timeout: 3000,
      })
      .catch(() => {});
    check('clear removes every highlight', (await page.locator('[data-locatra-lab]').count()) === 0);

    console.log('\nrecorder');
    await panel.bringToFront();
    await panel.click('[data-target="tab-recorder"]');
    // Addressed to the content script directly; the navigation check below covers
    // the service-worker path.
    await toDemo({ type: 'START_RECORDING' });
    await page.bringToFront();

    await page.click('#first-name');
    await page.fill('#first-name', 'Ada');
    await page.waitForTimeout(700);
    // page.selectOption() sets the value from script and dispatches untrusted
    // events, which the recorder deliberately ignores (page scripts and input masks
    // fire them too). ArrowDown on the focused, closed <select> is a real keystroke:
    // Chromium moves to the next option and fires a trusted change.
    await page.focus('#country');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(500);
    await page.check('#gift-wrap');
    await page.waitForTimeout(500);
    await page.uncheck('#save-details');
    await page.waitForTimeout(500);
    // A password field is added at runtime: the demo page is also the screenshot
    // page, and a login form would not belong in the store images.
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'password';
      input.id = 'smoke-password';
      input.setAttribute('aria-label', 'Account password');
      document.querySelector('[data-testid="place-order"]').before(input);
    });
    await page.fill('#smoke-password', 'hunter2-SMOKE');
    await page.waitForTimeout(700);
    await page.click('[data-testid="place-order"]');
    await page.waitForTimeout(300);
    await toDemo({ type: 'STOP_RECORDING' });

    await panel.bringToFront();
    await until(async () => /place-order|Place order/.test(await preview()), {
      timeout: 5000,
      what: 'the last step to reach the script',
    }).catch(() => {});
    const script = await preview();

    check('a test script was generated', script.includes('@playwright/test'));
    check('the fill was captured', /\.fill\('Ada'\)/.test(script));
    check('the select was captured', /selectOption\('Ireland'\)/.test(script));
    check('checking a box records check()', /\.check\(\)/.test(script));
    check(
      'unchecking records uncheck(), not check()',
      /\.uncheck\(\)/.test(script),
      'the pointer handler used to emit check() before the control toggled'
    );

    check(
      'a typed password never reaches the script',
      !script.includes('hunter2-SMOKE') && /process\.env\.LOCATRA_PASSWORD/.test(script),
      script.slice(0, 600)
    );
    const stored = await panel.evaluate(
      () => new Promise((resolve) => chrome.storage.local.get(null, (all) => resolve(JSON.stringify(all))))
    );
    check('a typed password is never written to storage', !stored.includes('hunter2-SMOKE'));

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

    // Selenium can't reuse Playwright's getBy* engine, so its locators are XPath/CSS
    // translations — and those once matched nothing for any labelled form field.
    // Evaluate exactly what the Selenium export says, against the same live page.
    console.log('\nselenium locators actually resolve');
    panel.on('dialog', (d) => d.accept().catch(() => {}));
    await panel.selectOption('#fwSelect', 'selenium');
    await panel.selectOption('#langSelect', 'javascript');
    await until(async () => /By\.(xpath|css)/.test(await preview()), {
      timeout: 5000,
      what: 'the Selenium script',
    }).catch(() => {});
    const seleniumScript = await preview();
    const seleniumLocators = [
      ...seleniumScript.matchAll(/By\.(xpath|css)\(((['"])(?:\\.|(?!\3)[^\\])*\3)\)/g),
    ].map(([, by, literal]) => ({
      by,
      // eslint-disable-next-line no-new-func -- decoding our own generated string literal
      selector: new Function(`return ${literal}`)(),
    }));
    check('Selenium locators were found', seleniumLocators.length >= 5, `found ${seleniumLocators.length}`);
    for (const { by, selector } of seleniumLocators) {
      const count = await page.evaluate(
        ({ by, selector }) => {
          if (by === 'css') return document.querySelectorAll(selector).length;
          const r = document.evaluate(
            selector,
            document,
            null,
            7 /* XPathResult.ORDERED_NODE_SNAPSHOT_TYPE */,
            null
          );
          return r.snapshotLength;
        },
        { by, selector }
      );
      check(`By.${by}(${selector.slice(0, 50)}) matches exactly 1 element`, count === 1, `matched ${count}`);
    }
    await panel.selectOption('#fwSelect', 'playwright');
    await panel.selectOption('#langSelect', 'typescript');

    // Recording a real flow means navigating. Capture on the new page is re-armed by
    // the service worker from its own tab set, and nothing until now exercised that
    // hand-off end to end — a break here silently truncates every multi-page recording.
    console.log('\nrecording across a navigation');
    await panel.bringToFront();
    await panel.click('#clearTimelineBtn');
    // The worker is what remembers which tab is recording, and that memory is the
    // whole mechanism being tested. Messaging the content script directly (as
    // toDemo does) would skip it entirely.
    await page.bringToFront();
    await viaWorker({ type: 'START_RECORDING' });

    await page.click('[data-testid="account-menu"]');
    await page.waitForTimeout(400);
    await page.goto(`http://localhost:${PORT}/confirmation`, { waitUntil: 'load' });
    await contentScriptReady(); // document_idle injection on the new page
    await page.waitForTimeout(400); // the worker's re-arm message follows the injection
    await page.click('#last-name');
    await page.fill('#last-name', 'Lovelace');
    await page.waitForTimeout(800); // the fill debounce
    await viaWorker({ type: 'STOP_RECORDING' });

    await panel.bringToFront();
    await until(async () => /Lovelace/.test(await preview()), {
      timeout: 5000,
      what: 'the post-navigation fill',
    }).catch(() => {});
    const multiPage = await preview();
    check('the step before the navigation is kept', /account-menu/.test(multiPage), multiPage.slice(0, 400));
    check('capture resumes on the page navigated to', /Lovelace/.test(multiPage), multiPage.slice(0, 400));

    // Payment fields live in an iframe on essentially every real checkout. The
    // content script is not there until a feature is switched on, and a locator
    // generated inside a frame is wrong unless it says which frame to enter — so
    // this drives the whole path: worker injects all frames, the pick comes back
    // frame-qualified, and Playwright is handed the result to resolve for real.
    console.log('\niframes');
    await page.bringToFront();
    await viaWorker({ type: 'START_INSPECT' });
    // The worker injects into every frame; wait until the payment frame has it.
    await page
      .frameLocator('#payment-frame')
      .locator('#ll-styles, #ll-overlay')
      .first()
      .waitFor({ state: 'attached', timeout: 5000 })
      .catch(() => page.waitForTimeout(600));

    const cardField = page.frameLocator('#payment-frame').locator('#card');
    await cardField.click();
    await until(async () => (await lastPick())?.elementData?.id === 'card', {
      timeout: 5000,
      what: 'the iframe pick to be stored',
    }).catch(() => {});

    const framePick = await lastPick();
    check(
      'an element inside an iframe can be picked at all',
      framePick?.elementData?.id === 'card',
      `picked ${JSON.stringify(framePick?.elementData?.id)}`
    );
    check(
      'the pick records the frame it came from',
      (framePick?.elementData?.framePath ?? []).some((f) => String(f).includes('payment-frame')),
      JSON.stringify(framePick?.elementData?.framePath)
    );

    const frameTop = framePick?.locators?.[0];
    check(
      'the top locator enters the frame',
      /frameLocator\(/.test(frameTop?.code ?? ''),
      `got ${frameTop?.code}`
    );
    check(
      'the structured target is frame-wrapped',
      frameTop?.target?.kind === 'frame',
      `got ${frameTop?.target?.kind}`
    );

    // The real proof: hand the generated Playwright locator back to Playwright.
    const frameExpr = frameTop?.code ?? '';
    let frameCount = -1;
    try {
      // eslint-disable-next-line no-eval -- resolving our own generated locator is the point
      frameCount = await eval(frameExpr).count();
    } catch (err) {
      check(`${frameExpr.slice(0, 70)} resolves`, false, err.message.split('\n')[0]);
    }
    if (frameCount !== -1) {
      check(`${frameExpr.slice(0, 60)} matches exactly 1 element`, frameCount === 1, `matched ${frameCount}`);
    }

    // Web components (Lit, Stencil — payment and chat widgets) render their iframe
    // into a shadow root, where the document's MutationObserver and its capture
    // `load` listener see nothing. The frame is added after Inspect is already on,
    // so only the content script's own watcher can get it injected. Its title and
    // src duplicate #payment-frame's, so the selector has to be structural — and
    // it has to resolve through the shadow root the way Playwright resolves CSS.
    console.log('\niframes inside shadow DOM');
    await page.evaluate(() => {
      const win = document.defaultView; // the eslint env for page bodies only knows `document`
      win.customElements.define(
        'smoke-pay-widget',
        class extends win.HTMLElement {
          connectedCallback() {
            const root = this.shadowRoot || this.attachShadow({ mode: 'open' });
            // Rendered a little later, the way component libraries batch their first render.
            setTimeout(() => {
              root.innerHTML =
                '<div class="frame-wrap"><iframe title="Payment details" src="/payment-frame" ' +
                'style="width: 100%; height: 150px; border: 0"></iframe></div>';
            }, 50);
          }
        }
      );
      document.getElementById('payment-frame').after(document.createElement('smoke-pay-widget'));
    });
    await worker.evaluate(() => chrome.storage.local.remove('lastElement'));

    const shadowFrame = page.frameLocator('smoke-pay-widget iframe');
    let shadowInjected = true;
    await shadowFrame
      .locator('#ll-styles')
      .waitFor({ state: 'attached', timeout: 8000 })
      .catch(() => (shadowInjected = false));
    check(
      'an iframe added inside a shadow root after Inspect started gets the content script',
      shadowInjected
    );

    await shadowFrame.locator('#card').click();
    await until(async () => (await lastPick())?.elementData?.id === 'card', {
      timeout: 5000,
      what: 'the shadow-hosted iframe pick to be stored',
    }).catch(() => {});
    const shadowPick = await lastPick();
    check(
      'an element inside a shadow-hosted iframe can be picked',
      shadowPick?.elementData?.id === 'card',
      `picked ${JSON.stringify(shadowPick?.elementData?.id)}`
    );

    const shadowFrameSelector = shadowPick?.locators?.[0]?.target?.selector ?? '';
    let addressesShadowFrame = false;
    try {
      const hits = page.locator(shadowFrameSelector);
      addressesShadowFrame =
        (await hits.count()) === 1 &&
        (await hits.evaluate((el) => el.getRootNode().host?.localName)) === 'smoke-pay-widget';
    } catch {
      addressesShadowFrame = false;
    }
    check(
      'the frame selector addresses exactly the shadow-hosted <iframe>',
      addressesShadowFrame,
      `selector ${JSON.stringify(shadowFrameSelector)}`
    );

    // Selenium and Cypress do not pierce shadow roots: they walk shadowPath one tree
    // at a time (findElement → getShadowRoot(), cy.get → .shadow().find). Each hop
    // must match exactly one element in its own tree, ending at this iframe.
    const shadowPath = shadowPick?.locators?.[0]?.target?.shadowPath;
    const walked = await page.evaluate((path) => {
      if (!Array.isArray(path) || path.length < 2) return 'no shadowPath';
      let scope = document;
      let el = null;
      for (let i = 0; i < path.length; i++) {
        if (i > 0) scope = el.shadowRoot;
        if (!scope) return `hop ${i}: no open shadow root`;
        const hits = scope.querySelectorAll(path[i]);
        if (hits.length !== 1) return `hop ${i} (${path[i]}) matched ${hits.length}`;
        el = hits[0];
      }
      return el.localName === 'iframe' && el.getRootNode().host?.localName === 'smoke-pay-widget'
        ? 'ok'
        : 'ended elsewhere';
    }, shadowPath);
    check(
      'the per-tree shadowPath for Selenium/Cypress walks to that <iframe>',
      walked === 'ok',
      `${walked} — ${JSON.stringify(shadowPath)}`
    );

    const shadowExpr = shadowPick?.locators?.[0]?.code ?? '';
    let shadowCount = -1;
    try {
      // eslint-disable-next-line no-eval -- resolving our own generated locator is the point
      shadowCount = await eval(shadowExpr).count();
    } catch (err) {
      check(`${shadowExpr.slice(0, 70)} resolves`, false, err.message.split('\n')[0]);
    }
    if (shadowCount !== -1) {
      check(
        `${shadowExpr.slice(0, 60)} matches exactly 1 element`,
        shadowCount === 1,
        `matched ${shadowCount}`
      );
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    console.log('\nhygiene');
    check(
      'the content script logged nothing to the page console',
      pageErrors.length === 0,
      pageErrors.slice(0, 3).join(' | ')
    );

    await panel.reload({ waitUntil: 'load' });
    await until(async () => (await preview()).includes('@playwright/test'), {
      timeout: 5000,
      what: 'the restored script',
    }).catch(() => {});
    const restored = await preview();
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

/**
 * Poll an async condition until it holds. Rejects after `timeout` ms; callers that
 * go on to assert the same condition catch that and let check() report it.
 */
async function until(fn, { timeout = 5000, interval = 100, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeout}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** The extension's service worker: already running, or the next one to start. */
async function waitForServiceWorker(context, extensionId, timeout = 15_000) {
  const ours = (w) => w.url().startsWith(`chrome-extension://${extensionId}/`);
  const existing = context.serviceWorkers().find(ours);
  if (existing) return existing;
  return context.waitForEvent('serviceworker', { predicate: ours, timeout }).catch(() => null);
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
