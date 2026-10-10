#!/usr/bin/env node
// Real-browser smoke test for frames addressed only by position (C4).
//
// A frame whose parent is cross-origin cannot read its own <iframe> element, so its
// recorded wrapper carries no selector, only positions: `index` among the parent's
// <iframe> elements (what Playwright, Cypress and WebdriverIO count) and
// `framesIndex` in window.frames (what Selenium counts). The two differ whenever the
// parent holds an <object>, an iframe inserted later by script (ads, chat widgets:
// Chrome lists window.frames in creation order) or one in a shadow root (not in
// window.frames at all). The frame's content script asks the parent's, through the
// worker, for the exact `index`.
//
// The page here has all three, at two cross-origin levels (localhost ↔ 127.0.0.1):
// a top page with an <object>, a late-inserted iframe and a shadow-hosted iframe; a
// payment frame with the same mix around a nested frame. A real click is recorded in
// each target frame, and every recorded wrapper must equal what Playwright itself
// counts — and the exported Playwright locator must find exactly one element.
//
//   npm run build && node scripts/e2e/smoke-frames.mjs [--headed]

/* global chrome, document, window, LLCodegen -- the bodies passed to evaluate() run in the browser */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { computeExtensionId, resolveChromium, waitForServiceWorker } from './browsers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REPO = join(ROOT, 'dist/chrome');
if (!existsSync(join(REPO, 'manifest.json'))) {
  console.error('dist/chrome is missing — run `npm run build` first');
  process.exit(1);
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let PORT = 0;
const LATE = `<script>
  addEventListener('load', () => {
    const f = document.createElement('iframe');
    f.id = 'late'; f.src = '/blank'; f.width = 40; f.height = 20;
    document.body.insertBefore(f, document.body.firstChild);
  });
</script>`;
const pages = {
  '/top': () => `<!doctype html><title>top</title>
    <object data="/blank" type="text/html" width="40" height="20"></object>
    <iframe id="a" src="/blank" width="40" height="20"></iframe>
    <iframe id="pay" title="pay" src="http://127.0.0.1:${PORT}/pay" width="420" height="160"></iframe>
    <x-pay></x-pay>
    <script>
      customElements.define('x-pay', class extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: 'open' }).innerHTML =
            '<iframe id="shadowpay" src="http://127.0.0.1:${PORT}/pay2" width="300" height="60"></iframe>';
        }
      });
    </script>${LATE}`,
  '/pay': () => `<!doctype html><title>pay</title><button id="buy">Pay now</button>
    <object data="/blank" type="text/html" width="40" height="20"></object>
    <iframe id="inner" src="http://localhost:${PORT}/inner" width="300" height="60"></iframe>${LATE}`,
  '/pay2': () => `<!doctype html><title>pay2</title><button id="go">Go</button>`,
  '/inner': () => `<!doctype html><title>inner</title><button id="ok">Confirm</button>`,
  '/blank': () => `<!doctype html><title>blank</title><p>x</p>`,
};
const handler = (req, res) => {
  const page = pages[new URL(req.url, 'http://x').pathname];
  res.writeHead(page ? 200 : 404, { 'content-type': 'text/html' });
  res.end(page ? page() : 'nope');
};
const server = createServer(handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
PORT = server.address().port;
const server6 = createServer(handler); // localhost may resolve to ::1
await new Promise((r) => {
  server6.once('error', r);
  server6.listen(PORT, '::1', r);
});

/** In `frame`: the element #id's position among Playwright's `iframe` matches, and in window.frames. */
async function facts(frame, id) {
  const order = await frame.locator('iframe').evaluateAll((els) => els.map((e) => e.id));
  const framesIndex = await frame.evaluate((wanted) => {
    const all = [...document.querySelectorAll('iframe')];
    document
      .querySelectorAll('*')
      .forEach((h) => h.shadowRoot && all.push(...h.shadowRoot.querySelectorAll('iframe')));
    const el = all.find((e) => e.id === wanted);
    for (let k = 0; k < window.frames.length; k++) if (window.frames[k] === el.contentWindow) return k;
    return undefined;
  }, id);
  return { selector: null, index: order.indexOf(id), framesIndex, order };
}

const profile = mkdtempSync(join(tmpdir(), 'locatra-c4-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: resolveChromium() ?? undefined,
  headless: !process.argv.includes('--headed'),
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`],
});
let failed = false;
try {
  const extensionId = computeExtensionId(REPO);
  const page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/top`, { waitUntil: 'load' });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel.html`, { waitUntil: 'load' });
  if (!(await waitForServiceWorker(context, extensionId))) throw new Error('no service worker');
  const windowId = await panel.evaluate(async () => (await chrome.windows.getCurrent()).id);
  const viaWorker = (m) =>
    panel.evaluate((msg) => chrome.runtime.sendMessage(msg).catch(() => undefined), { ...m, windowId });
  await page.bringToFront();
  console.log('START_RECORDING →', JSON.stringify(await viaWorker({ type: 'START_RECORDING' })));
  await pause(2000); // every frame injected and armed (and its lookup answered)

  const payFrame = page.frames().find((f) => f.url().endsWith('/pay'));
  const want = [
    [await facts(page.mainFrame(), 'pay')],
    [await facts(page.mainFrame(), 'pay'), await facts(payFrame, 'inner')],
    [await facts(page.mainFrame(), 'shadowpay')],
  ];
  console.log('top <iframe> order (Playwright):', JSON.stringify(want[0][0].order));
  console.log('pay <iframe> order (Playwright):', JSON.stringify(want[1][1].order));

  const pay = page.frameLocator('#pay');
  await pay.locator('#buy').click();
  await pause(400);
  await pay.frameLocator('#inner').locator('#ok').click();
  await pause(400);
  await page.locator('x-pay').locator('#shadowpay').contentFrame().locator('#go').click();
  await pause(800);
  await viaWorker({ type: 'STOP_RECORDING' });
  await pause(800);
  const state = await panel.evaluate(
    (key) => new Promise((r) => chrome.storage.local.get(key, (all) => r(all[key] ?? null))),
    `llRecorderState:${windowId}`
  );
  const clicks = (state?.actions ?? []).filter((a) => a.action === 'click');
  const levels = (t) => {
    const out = [];
    for (let x = t; x && x.kind === 'frame'; x = x.child)
      out.push({ selector: x.selector, index: x.index, framesIndex: x.framesIndex });
    return out;
  };
  if (clicks.length !== 3) {
    failed = true;
    console.log(`FAIL: expected 3 recorded clicks, got ${clicks.length}`);
  }
  clicks.forEach((c, i) => {
    const got = levels(c.target);
    const exp = (want[i] || []).map(({ order, ...rest }) => rest);
    const ok = JSON.stringify(got) === JSON.stringify(exp);
    if (!ok) failed = true;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${c.code}\n     recorded ${JSON.stringify(got)}\n     expected ${JSON.stringify(exp)}`
    );
  });
  // The export, run: the Playwright locator codegen writes for each recorded click
  // must address exactly one element of the live page.
  for (const c of clicks) {
    const expr = await panel.evaluate((t) => LLCodegen.locatorExpr(t, 'playwright', 'javascript'), c.target);
    let count = -1;
    try {
      count = await new Function('page', `return ${expr}.count();`)(page);
    } catch (e) {
      count = -1;
    }
    if (count !== 1) failed = true;
    console.log(`${count === 1 ? 'ok  ' : 'FAIL'} ${expr} resolves to ${count} element(s)`);
  }
  console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
} finally {
  await context.close().catch(() => {});
  server.close();
  server6.close();
  rmSync(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
