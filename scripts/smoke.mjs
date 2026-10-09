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

// The panel generates test-data variables by default, so a recorded value appears
// either inline — .fill('Ada') — or as testData.<name> with `<name>: 'Ada'` declared.
// Either way the step must use exactly the recorded value.
function usesRecordedValue(script, method, value) {
  const literal = `.${method}('${value}')`;
  if (script.includes(literal)) return true;
  const decl = script.match(/const testData = \{([\s\S]*?)\n\};/);
  if (!decl) return false;
  return [...script.matchAll(new RegExp(`\\.${method}\\(testData\\.(\\w+)\\)`, 'g'))].some(([, name]) =>
    decl[1].includes(`${name}: '${value}',`)
  );
}

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
  // "The app changed under the test": the same page without its Last name field,
  // served while `demoChanged` is set, so a replay that reloads the page meets it.
  const changedHtml = Buffer.from(
    html.toString('utf8').replace(/<div class="field">\s*<label for="last-name">[\s\S]*?<\/div>/, '')
  );
  if (changedHtml.includes('id="last-name"')) throw new Error('could not derive the changed demo page');
  let demoChanged = false;
  const server = createServer((req, res) => {
    const body = (req.url || '').startsWith('/payment-frame') ? frameHtml : demoChanged ? changedHtml : html;
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
    check('the fill was captured', usesRecordedValue(script, 'fill', 'Ada'));
    check('the select was captured', usesRecordedValue(script, 'selectOption', 'Ireland'));
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

    await suggestionsAndReplay({
      page,
      panel,
      worker,
      windowId,
      contentScriptReady,
      preview,
      setDemoChanged: (on) => (demoChanged = on),
    });

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

// ── Suggested assertions and Replay, driven through the side panel's own UI ──────
//
// One recorded checkout feeds both: the order submit is what makes the content script
// suggest assertions, and once they are accepted the same steps are replayed — so the
// replay also proves the suggested checks hold on a fresh run of the page.

/* global recordedActions, getComputedStyle, location, innerHeight -- page-context bodies below:
   recordedActions is the side panel's timeline (a top-level binding of sidepanel.js) */

const REPLAY_SECRET = 'replay-S3cret!';
const RECORDED_SECRET = 'recorded-S3cret!';

async function suggestionsAndReplay({
  page,
  panel,
  worker,
  windowId,
  contentScriptReady,
  preview,
  setDemoChanged,
}) {
  /** The panel's in-memory timeline, reduced to what the checks look at. */
  const steps = () =>
    panel.evaluate(() =>
      recordedActions.map((a) => ({
        action: a.action,
        assertType: a.assertType || '',
        value: a.sensitive ? '' : String(a.value ?? ''),
        sensitive: !!a.sensitive,
        suggested: !!a.suggested,
        code: String(a.code || ''),
      }))
    );
  /** What the timeline shows: one entry per rendered step row. */
  const rows = () =>
    panel.evaluate(() =>
      [...document.querySelectorAll('#recorderTimeline .ll-rec-step')].map((r) => ({
        index: Number(r.getAttribute('data-step-index')),
        cls: r.className,
        label: r.querySelector('.ll-rec-step-label')?.textContent ?? '',
        badge: r.querySelector('.ll-replay-badge')?.className.replace(/.*\brs-(\w+).*/, '$1') ?? '',
        error: r.querySelector('.ll-replay-error')?.textContent ?? '',
        reason: r.querySelector('.ll-rec-step-reason')?.textContent ?? '',
        hasAccept: Boolean(r.querySelector('.accept-step-btn')),
        hasDismiss: Boolean(r.querySelector('.dismiss-step-btn')),
        border: getComputedStyle(r).borderTopStyle,
      }))
    );
  const recordingState = () =>
    panel.evaluate((w) => chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATE', windowId: w }), windowId);
  const summary = () => panel.evaluate(() => document.getElementById('replaySummary')?.textContent ?? '');
  const stored = () =>
    panel.evaluate(() => new Promise((r) => chrome.storage.local.get(null, (all) => r(JSON.stringify(all)))));
  const expandTimeline = async () => {
    const header = panel.locator('#timelineToggleHeader');
    if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  };
  const waitForStep = (what, pred, timeout = 6000) =>
    until(async () => (await steps()).some(pred), { timeout, what }).catch(() => {});

  // The worker starts, pauses and replays in the window's ACTIVE tab, as it does for
  // a real side panel. The panel here is a tab of that window, so the demo tab is
  // brought to the front and the panel's buttons are clicked while it stays behind.
  const clickInPanel = async (selector) => {
    await page.bringToFront();
    await panel.click(selector);
  };
  const setRecording = async (on) => {
    await clickInPanel('#recordBtn');
    await until(async () => (await recordingState())?.active === on, {
      timeout: 5000,
      what: `recording ${on ? 'on' : 'off'}`,
    }).catch(() => {});
  };
  /** Click ▶ Replay; fill the secrets form when it opens; wait for the run to end. */
  const replay = async (secret) => {
    await clickInPanel('#replayBtn');
    const field = panel.locator('#replaySecretsFields input[data-secret-name="LOCATRA_PASSWORD"]');
    await field.waitFor({ state: 'visible', timeout: 3000 });
    const isPassword = (await field.getAttribute('type')) === 'password';
    if (secret) await field.fill(secret);
    await clickInPanel('#replaySecretsStart');
    await until(async () => /^Replay (passed|failed|stopped|couldn|interrupted)/.test(await summary()), {
      timeout: 45_000,
      what: 'the replay to finish',
    }).catch(() => {});
    return { isPassword, summary: await summary(), rows: await rows() };
  };
  const pageState = () =>
    page.evaluate(() => ({
      href: location.href,
      first: document.getElementById('first-name')?.value ?? null,
      last: document.getElementById('last-name')?.value ?? null,
      password: document.getElementById('password')?.value ?? null,
      createAccount: document.getElementById('create-account')?.checked ?? null,
      giftWrap: document.getElementById('gift-wrap')?.checked ?? null,
      country: document.getElementById('country')?.value ?? null,
      confirmed: document.getElementById('order-confirmation')?.hidden === false,
      confirmation: document.getElementById('order-confirmation')?.innerText ?? '',
    }));

  console.log('\nsuggested assertions');
  await page.goto(DEMO, { waitUntil: 'load' });
  await contentScriptReady();
  await panel.click('[data-target="tab-recorder"]');
  await panel.click('#clearTimelineBtn');
  await until(async () => (await steps()).length === 0, { what: 'an empty timeline' }).catch(() => {});

  await setRecording(true);
  // The top frame opens every recording with goto + viewport: capture is armed.
  await waitForStep('the opening goto', (s) => s.action === 'viewport');

  await page.click('#first-name');
  await page.fill('#first-name', 'Grace');
  await waitForStep('the first-name fill', (s) => s.action === 'fill' && s.value === 'Grace');
  await page.click('#last-name');
  await page.fill('#last-name', 'Hopper');
  await waitForStep('the last-name fill', (s) => s.action === 'fill' && s.value === 'Hopper');
  await page.check('#create-account');
  await waitForStep('the create-account check', (s) => s.action === 'check');
  await page.click('#password');
  await page.fill('#password', RECORDED_SECRET);
  await waitForStep('the password fill', (s) => s.action === 'fill' && s.sensitive);
  await page.focus('#country');
  await page.keyboard.press('ArrowDown'); // a trusted change (see the recorder section)
  await waitForStep('the country select', (s) => s.action === 'selectOption');
  await page.check('#gift-wrap');
  await waitForStep('the gift-wrap check', (s) => s.action === 'check' && /gift/i.test(s.code));

  // Submitting pushes /checkout/confirmed and reveals a role=status confirmation.
  await page.click('[data-testid="place-order"]');
  const isUrlSuggestion = (s, re) => s.suggested && s.assertType === 'toHaveURL' && re.test(s.value);
  const isConfirmSuggestion = (s) =>
    s.suggested && s.assertType === 'toContainText' && /Order confirmed/.test(s.value);
  await waitForStep('the suggested assertions', (s) => isUrlSuggestion(s, /\/checkout\/confirmed$/), 8000);
  await waitForStep('the suggested confirmation check', isConfirmSuggestion, 8000);
  // One more URL change (a hash link) gives a third suggestion, to dismiss.
  await page.click('nav a[href="#orders"]');
  await waitForStep('the #orders URL suggestion', (s) => isUrlSuggestion(s, /#orders$/), 8000);
  await setRecording(false);

  let all = await steps();
  check(
    'submitting the order suggests toHaveURL for the SPA navigation',
    all.some((s) => isUrlSuggestion(s, /^http:\/\/localhost:4174\/checkout\/confirmed$/)),
    JSON.stringify(all.filter((s) => s.suggested))
  );
  check(
    'and toContainText for the "Order confirmed" status',
    all.some(isConfirmSuggestion),
    JSON.stringify(all.filter((s) => s.suggested))
  );
  check(
    'suggestions never carry the typed password',
    !JSON.stringify(all).includes(RECORDED_SECRET) && !(await stored()).includes(RECORDED_SECRET)
  );

  await panel.click('#reviewSuggestionsBtn'); // expands the timeline at the first suggestion
  let shown = await rows();
  const suggestedRows = shown.filter((r) => /\bis-suggested\b/.test(r.cls));
  check(
    'suggested steps render with the Suggested style, badge and Accept/Dismiss',
    suggestedRows.length === all.filter((s) => s.suggested).length &&
      suggestedRows.length >= 3 &&
      suggestedRows.every(
        (r) => /Suggested/.test(r.label) && r.hasAccept && r.hasDismiss && r.border === 'dashed' && r.reason
      ) &&
      shown.filter((r) => !/\bis-suggested\b/.test(r.cls)).every((r) => r.border !== 'dashed'),
    JSON.stringify(suggestedRows)
  );
  check(
    'the suggestions bar counts them',
    await panel.evaluate(
      (n) =>
        !document.getElementById('suggestionsBar').hidden &&
        document.getElementById('suggestionsText').textContent.startsWith(`${n} suggested`),
      suggestedRows.length
    )
  );
  let script = await preview();
  check(
    'suggestions stay out of the script until accepted',
    /Grace/.test(script) && !/toHaveURL|toContainText/.test(script),
    script.slice(-500)
  );

  // Dismiss the #orders one; it must not come back — not on a re-render, and not
  // when the panel is reopened and the worker re-delivers what it buffered.
  const ordersIndex = all.findIndex((s) => isUrlSuggestion(s, /#orders$/));
  await panel.click(`#recorderTimeline .dismiss-step-btn[data-index="${ordersIndex}"]`);
  await until(async () => !(await steps()).some((s) => isUrlSuggestion(s, /#orders$/)), {
    what: 'the dismissed suggestion to go',
  }).catch(() => {});
  const afterDismiss = await steps();
  check(
    'Dismiss removes that suggestion and nothing else',
    afterDismiss.length === all.length - 1 &&
      !afterDismiss.some((s) => isUrlSuggestion(s, /#orders$/)) &&
      afterDismiss.some((s) => isUrlSuggestion(s, /\/checkout\/confirmed$/)) &&
      afterDismiss.some(isConfirmSuggestion),
    JSON.stringify(afterDismiss.filter((s) => s.suggested))
  );

  // The panel saves its timeline 200 ms after an edit; reopen it once that is done.
  const storedState = () =>
    panel.evaluate(
      (key) => new Promise((r) => chrome.storage.local.get(key, (all) => r(all[key] ?? null))),
      `llRecorderState:${windowId}`
    );
  await until(async () => (await storedState())?.actions?.length === afterDismiss.length, {
    what: 'the dismissal to be saved',
  }).catch(() => {});
  await panel.reload({ waitUntil: 'load' });
  await until(async () => (await steps()).length >= afterDismiss.length, {
    what: 'the timeline to be restored',
  }).catch(() => {});
  // Give a re-delivery of the worker's buffered steps (on the panel's hello) time to land.
  await new Promise((r) => setTimeout(r, 1000));
  const restored = await steps();
  check(
    'a dismissed suggestion does not come back when the panel is reopened',
    restored.length === afterDismiss.length && !restored.some((s) => isUrlSuggestion(s, /#orders$/)),
    `${restored.length} steps (expected ${afterDismiss.length})`
  );

  await panel.click('[data-target="tab-recorder"]');
  await expandTimeline();
  await panel.click('#acceptAllSuggestionsBtn');
  await until(async () => !(await steps()).some((s) => s.suggested), { what: 'Accept all' }).catch(() => {});
  await until(async () => /toHaveURL/.test(await preview()), {
    what: 'the accepted checks in the script',
  }).catch(() => {});
  all = await steps();
  script = await preview();
  check(
    'Accept all turns every suggestion into a step',
    !all.some((s) => s.suggested) &&
      (await panel.evaluate(() => document.getElementById('suggestionsBar').hidden)) &&
      !(await rows()).some((r) => /\bis-suggested\b/.test(r.cls))
  );
  check(
    'accepted checks reach the script',
    /expect\(page\)\.toHaveURL\('http:\/\/localhost:4174\/checkout\/confirmed'\)/.test(script) &&
      /\.toContainText\('Order confirmed/.test(script) &&
      !/#orders'\)/.test(script.match(/toHaveURL\([^)]*\)/g)?.join('') ?? ''),
    script.slice(-700)
  );

  console.log('\nreplay');
  // Recording stays on through the replay: the replayed actions must not be captured.
  await page.goto(DEMO, { waitUntil: 'load' });
  await contentScriptReady();
  const before = (await steps()).length;
  await setRecording(true);
  // Starting appends goto + viewport for this page; drop them so the replay ends on
  // the order flow rather than on a fresh /checkout.
  await until(async () => (await steps()).length === before + 2, { what: 'the new goto + viewport' }).catch(
    () => {}
  );
  for (let i = 0; i < 2; i++) {
    const last = (await steps()).length - 1;
    await panel.click(`#recorderTimeline .remove-step-btn[data-index="${last}"]`);
  }
  await until(async () => (await steps()).length === before, { what: 'the extra steps removed' }).catch(
    () => {}
  );
  const flow = await steps();
  const passwordIndex = flow.findIndex((s) => s.action === 'fill' && s.sensitive);
  // The first step that touches the Last name field (the click into it, before the fill).
  const lastNameIndex = flow.findIndex((s) => /Last name|last-name/.test(s.code));

  check(
    'Replay is enabled with steps recorded and recording live',
    await panel.evaluate(() => !document.getElementById('replayBtn').disabled)
  );
  const ok = await replay(REPLAY_SECRET);
  check('a sensitive step asks for its value in a password field first', ok.isPassword);
  check(
    'the summary says the replay passed',
    ok.summary === `Replay passed (${flow.length} steps)`,
    `got ${JSON.stringify(ok.summary)}`
  );
  const unexpected = ok.rows.filter((r) =>
    flow[r.index]?.action === 'viewport' ? r.badge !== 'skipped' : r.badge !== 'passed'
  );
  check(
    'every step is badged passed (the viewport step skipped)',
    ok.rows.length === flow.length && unexpected.length === 0,
    JSON.stringify(unexpected.slice(0, 3))
  );
  const after = await pageState();
  check(
    'the replay filled and submitted the form on the page',
    after.first === 'Grace' &&
      after.last === 'Hopper' &&
      after.createAccount &&
      after.giftWrap &&
      after.country === 'Ireland' &&
      after.confirmed &&
      /Grace Hopper/.test(after.confirmation) &&
      /\/checkout\/confirmed#orders$/.test(after.href),
    JSON.stringify(after)
  );
  check('the secret typed into the replay form reached the page', after.password === REPLAY_SECRET);
  check(
    'the replay secret is not kept anywhere',
    !(await stored()).includes(REPLAY_SECRET) &&
      (await panel.evaluate(() => document.getElementById('replaySecretsFields').childElementCount === 0))
  );

  // The worker pauses the session for the run and resumes it after.
  await until(async () => (await recordingState())?.paused === false, { what: 'recording to resume' }).catch(
    () => {}
  );
  const resumed = await recordingState();
  check('recording is live again after the replay', resumed?.active === true && resumed?.paused === false);
  // Anything the replay leaked would land within the recorder's debounce windows once
  // capture resumes (fill 700 ms; a toHaveURL for the URL the replay left, 500 ms).
  await new Promise((r) => setTimeout(r, 1500));
  const afterReplay = await steps();
  check(
    'replayed actions are not recorded as new steps',
    afterReplay.length === flow.length,
    JSON.stringify(afterReplay.slice(flow.length))
  );
  await setRecording(false);

  console.log('\nreplay without a secret');
  const skipped = await replay('');
  const pwRow = skipped.rows.find((r) => r.index === passwordIndex);
  check(
    'leaving the secret empty skips that step',
    pwRow?.badge === 'skipped' && /no value provided/.test(pwRow?.error ?? ''),
    JSON.stringify(pwRow)
  );
  const noSecret = await pageState();
  check(
    'the rest of the flow still ran, and the field was left empty',
    /^Replay passed/.test(skipped.summary) && noSecret.password === '' && noSecret.confirmed,
    `${skipped.summary} — ${JSON.stringify(noSecret)}`
  );

  console.log('\nreplay against a changed page');
  // The page's goto step reloads it from the server, which now serves it without
  // the Last name field: the locator recorded for it can no longer match.
  setDemoChanged(true);
  let failed;
  try {
    failed = await replay(REPLAY_SECRET);
  } finally {
    setDemoChanged(false);
  }
  const failedRow = failed.rows.find((r) => r.index === lastNameIndex);
  check(
    `the summary names the failing step (#${lastNameIndex + 1}) and the error`,
    new RegExp(`^Replay failed at step ${lastNameIndex + 1}: no element matches`).test(failed.summary),
    `got ${JSON.stringify(failed.summary)}`
  );
  check(
    'the failed step is badged, highlighted and shows the error',
    failedRow?.badge === 'failed' &&
      /\breplay-failed\b/.test(failedRow.cls) &&
      /no element matches/.test(failedRow.error),
    JSON.stringify(failedRow)
  );
  check(
    'steps before it passed and none after it ran (stop at first failure)',
    failed.rows.every((r) =>
      r.index < lastNameIndex
        ? r.badge === (flow[r.index].action === 'viewport' ? 'skipped' : 'passed')
        : r.index > lastNameIndex
          ? r.badge === ''
          : true
    ),
    JSON.stringify(failed.rows.map((r) => r.badge))
  );
  check(
    'the failed step is scrolled into view',
    await panel.evaluate((i) => {
      const row = document.querySelector(`#recorderTimeline .ll-rec-step[data-step-index="${i}"]`);
      const tl = document.getElementById('recorderTimeline').getBoundingClientRect();
      const r = row?.getBoundingClientRect();
      return Boolean(r && r.bottom > Math.max(0, tl.top) && r.top < Math.min(innerHeight, tl.bottom));
    }, lastNameIndex)
  );
  const broken = await pageState();
  check(
    'the order was not placed',
    !broken.confirmed && /\/checkout$/.test(broken.href),
    JSON.stringify(broken)
  );
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
