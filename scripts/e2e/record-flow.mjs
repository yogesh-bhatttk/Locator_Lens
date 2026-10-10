// Record the checkout flow through the real, built extension and return what the
// side panel stored — the same object a user's recording leaves in
// chrome.storage.local under `llRecorderState:<windowId>`.
//
// Mechanics are scripts/smoke.mjs's: Playwright's Chromium with dist/chrome loaded,
// the side panel opened as a tab, recording started through the service worker the
// way the panel starts it, and every interaction a trusted input event (the recorder
// ignores synthetic ones). The values typed are the ones
// tests/e2e/fixtures/checkout-flow.expect.json expects the demo page to receive.

/* global chrome -- the bodies passed to panel.evaluate() run in the extension page */

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { chromium } from 'playwright';

import { computeExtensionId, until, waitForServiceWorker } from './browsers.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{ extensionDir: string, chromium: string, base: string, password: string,
 *           profileDir: string, headed?: boolean, log?: (s: string) => void }} opts
 * @returns {Promise<{ state: object, notes: string[] }>}
 */
export async function recordCheckoutFlow(opts) {
  const { extensionDir, base, password, profileDir } = opts;
  const log = opts.log ?? (() => {});
  const notes = [];
  if (!existsSync(join(extensionDir, 'manifest.json'))) {
    throw new Error(`${extensionDir} has no manifest.json — run \`npm run build\` first`);
  }

  rmSync(profileDir, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: opts.chromium,
    // Extensions need a headed browser or Chromium's new headless mode; headed is
    // what smoke and the screenshots use, so it is the default when a display exists.
    headless: !opts.headed,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });

  try {
    const extensionId = computeExtensionId(extensionDir);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${base}/checkout`, { waitUntil: 'load' });

    const panel = await context.newPage();
    await panel.setViewportSize({ width: 460, height: 900 });
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel.html`, { waitUntil: 'load' });
    const worker = await waitForServiceWorker(context, extensionId);
    if (!worker) throw new Error('the extension service worker never started');

    const windowId = await panel.evaluate(async () => (await chrome.windows.getCurrent()).id);
    const viaWorker = (message) =>
      panel.evaluate((msg) => chrome.runtime.sendMessage(msg).catch(() => undefined), {
        ...message,
        windowId,
      });
    const storedState = () =>
      panel.evaluate(
        (key) => new Promise((resolve) => chrome.storage.local.get(key, (all) => resolve(all[key] ?? null))),
        `llRecorderState:${windowId}`
      );

    await panel.click('[data-target="tab-recorder"]').catch(() => {});
    await page.bringToFront();
    const started = await viaWorker({ type: 'START_RECORDING' });
    log(`  START_RECORDING → ${JSON.stringify(started)}`);
    // The worker injects every frame; wait until the payment frame has the script.
    await page
      .frameLocator('#payment-frame')
      .locator('#ll-styles')
      .waitFor({ state: 'attached', timeout: 3000 })
      .catch(() => {});
    await pause(500);

    const typeInto = async (locator, value) => {
      await locator.click();
      await locator.fill(value);
      await pause(800); // the recorder debounces typing
    };

    await page.hover('[data-testid="account-menu"]');
    await typeInto(page.locator('#first-name'), 'Ada');
    await typeInto(page.locator('#last-name'), 'Lovelace');
    await typeInto(page.locator('#email'), 'ada@example.com');
    await typeInto(page.locator('#phone'), '+44 20 7946 0001');
    await page.check('#create-account');
    await pause(500);
    await typeInto(page.locator('#password'), password);
    // A value check on the password field: recorded as an env-var reference, never
    // the value. Assert mode turns the next click into the assertion.
    await viaWorker({ type: 'SET_ASSERT_MODE', on: true, assertType: 'toHaveValue' });
    await pause(300);
    await page.click('#password');
    await pause(500);
    await viaWorker({ type: 'SET_ASSERT_MODE', on: false });
    await pause(300);
    // page.selectOption() dispatches untrusted events, which the recorder ignores on
    // purpose. ArrowDown on the focused, closed <select> is a real keystroke:
    // Chromium moves to the next option (United Kingdom → Ireland), trusted change.
    await page.focus('#country');
    await page.keyboard.press('ArrowDown');
    await pause(600);
    // Interests (export server only): a listbox <select multiple>. A click picks
    // Books; Ctrl/Cmd+click adds Music — real clicks, so real change events. The
    // recorder keeps the changes (selectOption, the last with both values), not
    // the clicks on the options.
    await page.click('#interests option[value="books"]');
    await pause(500);
    await page.click('#interests option[value="music"]', { modifiers: ['ControlOrMeta'] });
    await pause(600);
    // Promo code lives in an open shadow root; Playwright's CSS pierces it.
    await typeInto(page.locator('promo-code #promo'), 'SPRING-10');
    await typeInto(page.locator('#notes'), 'Ring the bell twice');
    await page.check('#gift-wrap');
    await pause(500);
    await page.uncheck('#save-details');
    await pause(500);
    const pay = page.frameLocator('#payment-frame');
    await typeInto(pay.locator('#card'), '4242 4242 4242 4242');
    await pay.locator('[data-testid="pay-now"]').click();
    await pause(600);
    await page.click('#email');
    await pause(400);
    for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Enter']) {
      await page.keyboard.press(key);
      await pause(400);
    }
    // Automatic assertions watch for 3 s after a submit and wait for the URL to settle.
    await pause(4000);
    await viaWorker({ type: 'STOP_RECORDING' });

    // Accept every suggested assertion through the panel's own button, as a user
    // would; suggestions stay out of the script until accepted.
    await panel.bringToFront();
    const acceptAll = panel.locator('#acceptAllSuggestionsBtn');
    if (await acceptAll.isVisible().catch(() => false)) {
      await acceptAll.click();
      notes.push('accepted the suggested assertions with the panel’s “Accept all” button');
    }

    let state = null;
    let last = '';
    await until(
      async () => {
        state = await storedState();
        const snapshot = JSON.stringify(state?.actions ?? []);
        const settled = snapshot === last && /"press"/.test(snapshot) && !/"suggested":true/.test(snapshot);
        last = snapshot;
        return settled;
      },
      { timeout: 15_000, interval: 700, what: 'the recorded steps to be stored' }
    ).catch((err) => notes.push(err.message));
    if (!state?.actions?.length) throw new Error('the side panel stored no recorded steps');
    if (pageErrors.length) notes.push(`page errors during recording: ${pageErrors.slice(0, 3).join(' | ')}`);
    return { state, notes };
  } finally {
    await context.close().catch(() => {});
    rmSync(profileDir, { recursive: true, force: true });
  }
}

/** True when this machine can show a headed browser. */
export function hasDisplay() {
  return process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}
