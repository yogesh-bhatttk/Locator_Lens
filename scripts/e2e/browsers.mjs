// Browser plumbing shared by the export tests (same mechanics as scripts/smoke.mjs).

import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { chromium } from 'playwright';

/**
 * The Chromium every framework drives: LOCATRA_CHROMIUM if set, else the one
 * Playwright installed (`npx playwright install chromium`), else the newest build in
 * Playwright's cache. Null when there is none.
 */
export function resolveChromium() {
  const fromEnv = process.env.LOCATRA_CHROMIUM;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const configured = chromium.executablePath();
  if (configured && existsSync(configured)) return configured;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(process.env.HOME ?? '', '.cache/ms-playwright');
  if (!existsSync(cache)) return null;
  const builds = readdirSync(cache)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const build of builds) {
    for (const v of [
      'chrome-linux64/chrome',
      'chrome-linux/chrome',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    ]) {
      const p = join(cache, build, v);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** Chrome's id for an unpacked extension loaded from `absolutePath`. */
export function computeExtensionId(absolutePath) {
  const digest = createHash('sha256').update(absolutePath, 'utf8').digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (digest[i] >> 4)) + String.fromCharCode(97 + (digest[i] & 0x0f));
  }
  return id;
}

/** The extension's service worker: already running, or the next one to start. */
export async function waitForServiceWorker(context, extensionId, timeout = 15_000) {
  const ours = (w) => w.url().startsWith(`chrome-extension://${extensionId}/`);
  const existing = context.serviceWorkers().find(ours);
  if (existing) return existing;
  return context.waitForEvent('serviceworker', { predicate: ours, timeout }).catch(() => null);
}

/** Poll an async condition until it holds; rejects after `timeout` ms. */
export async function until(fn, { timeout = 5000, interval = 100, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeout}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}
