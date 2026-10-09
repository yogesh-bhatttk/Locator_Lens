#!/usr/bin/env node
/* global chrome, document, window, indexedDB, recordedActions */
// Real-browser smoke test for step screenshots (F4).
//
// The unit suites mock chrome.tabs.captureVisibleTab, IndexedDB and layout, so
// three things only a real browser can answer are covered here:
//   - whether a capture actually happens (it needs the optional <all_urls> host
//     permission or an activeTab grant — http/https host access is not enough),
//   - whether the stored JPEG decodes and the step's outline lands on the element,
//   - whether the records in IndexedDB follow the timeline (remove, clear, toggle).
//
//   npm run build && node scripts/e2e/smoke-screenshots.mjs
//
// Phase A runs without the grant, phase B/C with it. Chromium's permission prompt
// is native UI Playwright cannot click, so the grant is seeded the way Chromium
// stores it: the phase A profile is closed, "<all_urls>" is added to the
// extension's granted/active explicit hosts in its Preferences, and it is relaunched.
//
// Uses its own port and profile directory, so it can run next to the other smokes.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { computeExtensionId, resolveChromium, until, waitForServiceWorker } from './browsers.mjs';
import { startDemoServer } from './demo-server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXTENSION = join(ROOT, 'dist/chrome');
const PORT = 4182;
const PROFILE = join(ROOT, '.tmp-smoke-shots-profile');
// A real window, not Playwright's viewport emulation: captureVisibleTab shoots
// the window's actual surface, so an emulated 1280x800 layout in a window of
// another size yields a crop that no outline can line up with. Without emulation
// innerWidth/innerHeight are what gets captured, as for a user.
const WINDOW_SIZE = '1280,900';
/** Background spaces captures ≥ 500 ms apart (Chrome allows ~2/s). */
const CAPTURE_INTERVAL_MS = 500;
/**
 * How long a step that must NOT get a thumbnail is given to get one anyway. Only
 * negative checks wait this long: three capture slots, plus encode and store time.
 */
const NO_THUMB_SETTLE_MS = 3 * CAPTURE_INTERVAL_MS + 500;

const results = [];
let failures = 0;

function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures++;
  results.push({ ok, name, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail && !ok ? `\n      ${detail}` : ''}`);
  return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch(executablePath) {
  return chromium.launchPersistentContext(PROFILE, {
    executablePath,
    headless: false,
    viewport: null,
    args: [
      `--window-size=${WINDOW_SIZE}`,
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
    ],
  });
}

/**
 * Open the demo page and the panel (as a tab in the same window, as smoke.mjs
 * does) and wire up everything a phase needs to drive and observe them.
 */
async function openSession(context, extensionId, base) {
  const errors = [];
  const watchConsole = (label, target) => {
    target.on('console', (m) => m.type() === 'error' && errors.push(`${label}: ${m.text()}`));
    if (label !== 'worker') target.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  };

  const page = context.pages()[0] ?? (await context.newPage());
  watchConsole('page', page);
  await page.goto(`${base}/checkout`, { waitUntil: 'load' });

  const panel = await context.newPage();
  watchConsole('panel', panel);
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel.html`, { waitUntil: 'load' });

  const worker = await waitForServiceWorker(context, extensionId);
  if (!worker) throw new Error('the extension service worker never started');
  watchConsole('worker', worker);

  const windowId = await panel.evaluate(async () => (await chrome.windows.getCurrent()).id);
  const host = new URL(base).host;

  const viaWorker = (message) =>
    panel.evaluate((msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ error: String(e) })), {
      ...message,
      windowId,
    });

  const demoTab = () =>
    worker.evaluate(async (h) => {
      const t = (await chrome.tabs.query({})).find((x) => (x.url || '').includes(h));
      return t ? { id: t.id, windowId: t.windowId, active: t.active } : null;
    }, host);

  const contentScriptReady = () =>
    until(
      () =>
        worker.evaluate(async (h) => {
          const t = (await chrome.tabs.query({})).find((x) => (x.url || '').includes(h));
          if (!t) return false;
          return chrome.tabs
            .sendMessage(t.id, { type: 'PING' }, { frameId: 0 })
            .then(() => true)
            .catch((e) => !/Receiving end does not exist/i.test(String(e?.message ?? e)));
        }, host),
      { timeout: 10_000, what: 'the content script in the demo page' }
    );

  /** The panel's timeline, as the panel itself holds it. */
  const steps = () =>
    panel.evaluate(() =>
      recordedActions.map((a) => ({
        eventId: a.eventId,
        action: a.action,
        suggested: !!a.suggested,
        assertType: a.assertType || null,
        rect: a.rect || null,
        viewport: a.viewport || null,
      }))
    );

  /** Every record in IndexedDB 'locatra' / 'thumbs', read from the panel's origin. */
  const thumbRecords = () =>
    panel.evaluate(
      () =>
        new Promise((resolveRecords) => {
          const req = indexedDB.open('locatra');
          // Never create the database from here: a version-1 database without its
          // store would stop thumbs-store.js from ever creating it.
          req.onupgradeneeded = () => req.transaction.abort();
          req.onerror = () => resolveRecords([]);
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('thumbs')) {
              db.close();
              resolveRecords([]);
              return;
            }
            const all = db.transaction('thumbs').objectStore('thumbs').getAll();
            all.onsuccess = () => {
              db.close();
              resolveRecords(
                all.result.map((r) => ({
                  eventId: r.eventId,
                  windowId: r.windowId,
                  width: r.width,
                  height: r.height,
                  type: r.blob && r.blob.type,
                  size: r.blob && r.blob.size,
                }))
              );
            };
            all.onerror = () => {
              db.close();
              resolveRecords([]);
            };
          };
        })
    );
  const recordIds = async () => new Set((await thumbRecords()).map((r) => r.eventId));

  /**
   * Do something on the demo page and wait for the step it records to reach the
   * panel. Returns that step (null if none came), plus where the element really
   * was at that moment when `selector` is given.
   */
  const recordStep = async (what, act, { action, selector, timeout = 6000 } = {}) => {
    const before = new Set((await steps()).map((s) => s.eventId));
    await act();
    let step = null;
    await until(
      async () => {
        step =
          (await steps()).find(
            (s) => !before.has(s.eventId) && !s.suggested && (!action || s.action === action)
          ) ?? null;
        return Boolean(step);
      },
      { timeout, what }
    ).catch(() => {});
    let live = null;
    if (step && selector) {
      live = await page.evaluate((sel) => {
        const r = document.querySelector(sel).getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          vw: window.innerWidth,
          vh: window.innerHeight,
        };
      }, selector);
    }
    return step && { ...step, live, what };
  };

  const waitForRecord = (eventId, timeout = 6000) =>
    until(async () => (await recordIds()).has(eventId), {
      timeout,
      what: `the thumbnail record of ${eventId}`,
    })
      .then(() => true)
      .catch(() => false);

  const openRecorder = async () => {
    await panel.bringToFront();
    await panel.click('[data-target="tab-recorder"]');
    if ((await panel.getAttribute('#timelineToggleHeader', 'aria-expanded')) !== 'true') {
      await panel.click('#timelineToggleHeader');
    }
  };

  const openSettings = async () => {
    const open = await panel.evaluate(() => document.getElementById('recSettings').open);
    if (!open) await panel.click('#recSettings > summary');
  };

  /** What the timeline shows for one step's thumbnail slot. */
  const slotState = (eventId) =>
    panel.evaluate((id) => {
      const step = [...document.querySelectorAll('#recorderTimeline .ll-rec-step')].find((el) =>
        [...el.querySelectorAll('.ll-thumb-slot')].some((s) => s.getAttribute('data-eid') === id)
      );
      const slot = step && step.querySelector('.ll-thumb-slot');
      if (!slot) return { slot: false };
      const btn = slot.querySelector('.ll-thumb-btn');
      const img = slot.querySelector('.ll-thumb-btn img');
      if (!img) return { slot: true, img: false };
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const outline = slot.querySelector('.ll-thumb-rect');
      return {
        slot: true,
        img: true,
        button: Boolean(btn),
        complete: img.complete,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        imgBox: box(img),
        outline: outline && !outline.hidden ? box(outline) : null,
      };
    }, eventId);

  return {
    page,
    panel,
    worker,
    windowId,
    errors,
    viaWorker,
    demoTab,
    contentScriptReady,
    steps,
    thumbRecords,
    recordIds,
    recordStep,
    waitForRecord,
    openRecorder,
    openSettings,
    slotState,
  };
}

/** Wait for the panel's <img> to decode, then report its slot. */
async function decodedSlot(s, eventId) {
  let state = null;
  await until(
    async () => {
      state = await s.slotState(eventId);
      return state.img && state.complete && state.naturalWidth > 0 && state.imgBox.width > 0;
    },
    { timeout: 5000, what: `the thumbnail of ${eventId} to decode` }
  ).catch(() => {});
  return state;
}

// ── Phase A ──────────────────────────────────────────────────────────────────
async function phaseA(context, extensionId, base) {
  console.log('\nphase A: no <all_urls>, no activeTab grant');
  const s = await openSession(context, extensionId, base);

  const permission = await s.viaWorker({ type: 'GET_SCREENSHOT_PERMISSION' });
  check(
    'GET_SCREENSHOT_PERMISSION answers granted:false, available:true',
    permission?.granted === false && permission?.available === true,
    JSON.stringify(permission)
  );

  await s.contentScriptReady();
  await s.page.bringToFront();
  const started = await s.viaWorker({ type: 'START_RECORDING' });
  check('recording starts', started?.ok !== false, JSON.stringify(started));

  let opening = [];
  await until(
    async () => {
      opening = await s.steps();
      return opening.some((x) => x.action === 'goto') && opening.some((x) => x.action === 'viewport');
    },
    { timeout: 6000, what: 'the goto and viewport steps' }
  ).catch(() => {});
  check('the recording opens with goto + viewport steps', opening.length >= 2, JSON.stringify(opening));

  const recorded = [
    await s.recordStep('click on first name', () => s.page.click('#first-name'), { action: 'click' }),
    await s.recordStep('fill first name', () => s.page.fill('#first-name', 'Ada'), { action: 'fill' }),
    await s.recordStep('tick gift wrap', () => s.page.check('#gift-wrap'), { action: 'check' }),
  ];
  check(
    'click, fill and check are recorded without the grant',
    recorded.every(Boolean),
    JSON.stringify(recorded.map((r) => r && r.action))
  );
  check(
    'each recorded step has an eventId',
    recorded.every((r) => r && typeof r.eventId === 'string' && r.eventId.length > 0)
  );

  // Nothing positive can mark "the capture was refused", so this is the one place
  // a bounded settle is the condition: well past the capture slot of the last step.
  await sleep(NO_THUMB_SETTLE_MS);
  const records = await s.thumbRecords();
  check('no thumbnail is stored without permission', records.length === 0, JSON.stringify(records));

  await s.openRecorder();
  const preview = await s.panel.evaluate(() => document.getElementById('codePreview')?.innerText ?? '');
  check('the script is still generated', /\.fill\('Ada'\)/.test(preview) && /\.check\(\)/.test(preview));
  check(
    'the timeline shows no thumbnail',
    (await s.panel.locator('#recorderTimeline .ll-thumb-btn').count()) === 0
  );

  // The panel learns about the recording through its state refresh (on becoming
  // visible), then points out the missing access once.
  const timelineNotice = s.panel.locator('#shotPermTimelineNotice');
  await timelineNotice.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  check('the timeline shows the screenshot permission notice', await timelineNotice.isVisible());
  check(
    'that notice offers "Grant access"',
    await s.panel.locator('#shotPermTimelineGrantBtn').isVisible(),
    await timelineNotice.innerText().catch(() => '')
  );

  await s.openSettings();
  const settingsNotice = s.panel.locator('#shotPermNotice');
  await settingsNotice.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  check('Settings shows the screenshot permission notice', await settingsNotice.isVisible());
  check(
    'Settings offers "Grant access"',
    (
      await s.panel
        .locator('#shotPermGrantBtn')
        .innerText()
        .catch(() => '')
    ).includes('Grant access')
  );

  await s.viaWorker({ type: 'STOP_RECORDING' });
  // Leave the profile clean for phase B: no adopted timeline from this window.
  await s.panel.click('#clearTimelineBtn');
  await until(async () => (await s.steps()).length === 0, {
    timeout: 3000,
    what: 'the timeline to clear',
  }).catch(() => {});

  check(
    'no errors in the page, panel or worker console',
    s.errors.length === 0,
    s.errors.slice(0, 4).join(' | ')
  );
}

// ── Grant seeding ────────────────────────────────────────────────────────────
function seedAllUrlsGrant(extensionId) {
  let seeded = 0;
  for (const name of ['Preferences', 'Secure Preferences']) {
    const file = join(PROFILE, 'Default', name);
    if (!existsSync(file)) continue;
    const prefs = JSON.parse(readFileSync(file, 'utf8'));
    const ext = prefs.extensions?.settings?.[extensionId];
    if (!ext) continue;
    for (const key of ['granted_permissions', 'active_permissions']) {
      ext[key] = ext[key] || {};
      ext[key].explicit_host = [...new Set([...(ext[key].explicit_host || []), '<all_urls>'])];
    }
    writeFileSync(file, JSON.stringify(prefs));
    seeded++;
  }
  return seeded;
}

// ── Phase B + C ──────────────────────────────────────────────────────────────
async function phaseB(context, extensionId, base) {
  console.log('\nphase B: <all_urls> granted');
  const s = await openSession(context, extensionId, base);

  const contains = await s.panel.evaluate(() => chrome.permissions.contains({ origins: ['<all_urls>'] }));
  check('the seeded <all_urls> grant is in effect', contains === true);
  const permission = await s.viaWorker({ type: 'GET_SCREENSHOT_PERMISSION' });
  check(
    'GET_SCREENSHOT_PERMISSION answers granted:true',
    permission?.granted === true && permission?.available === true,
    JSON.stringify(permission)
  );
  const demo = await s.demoTab();
  check(
    'the panel tab and the demo tab share a window',
    demo?.windowId === s.windowId,
    `demo ${JSON.stringify(demo)} vs panel window ${s.windowId}`
  );

  await s.contentScriptReady();
  await s.page.bringToFront();
  const started = await s.viaWorker({ type: 'START_RECORDING' });
  check('recording starts', started?.ok !== false, JSON.stringify(started));

  let opening = [];
  await until(
    async () => {
      opening = await s.steps();
      return opening.some((x) => x.action === 'goto') && opening.some((x) => x.action === 'viewport');
    },
    { timeout: 6000, what: 'the goto and viewport steps' }
  ).catch(() => {});
  const gotoStep = opening.find((x) => x.action === 'goto');
  const viewportSteps = () => s.steps().then((all) => all.filter((x) => x.action === 'viewport'));
  check('the recording opens with goto + viewport steps', Boolean(gotoStep) && opening.length >= 2);
  check('the goto step gets a stored thumbnail', gotoStep && (await s.waitForRecord(gotoStep.eventId)));
  // The viewport step arrives with the goto. Were it queued, the next step would
  // replace it in the one-per-tab queue before its slot came up, so give it that
  // slot before doing anything else.
  await sleep(NO_THUMB_SETTLE_MS);
  const firstViewport = opening.find((x) => x.action === 'viewport');
  check(
    'the viewport step gets no stored thumbnail',
    firstViewport && !(await s.recordIds()).has(firstViewport.eventId)
  );

  // Each step waits for its own record before the next action: captures are
  // throttled and only the newest pending step per tab keeps its slot.
  const userSteps = [];
  for (const [what, act, action, selector] of [
    ['click on first name', () => s.page.click('#first-name'), 'click', '#first-name'],
    ['fill first name', () => s.page.fill('#first-name', 'Ada'), 'fill', '#first-name'],
    ['tick gift wrap', () => s.page.check('#gift-wrap'), 'check', '#gift-wrap'],
    ['click on email', () => s.page.click('#email'), 'click', '#email'],
  ]) {
    const step = await s.recordStep(what, act, { action, selector });
    const stored = step ? await s.waitForRecord(step.eventId) : false;
    check(`${what}: recorded and its thumbnail stored`, step && stored, step ? 'no record' : 'no step');
    if (step) userSteps.push(step);
  }

  console.log('\ntimeline thumbnails');
  await s.openRecorder();
  check(
    'the panel shows no permission notice in Settings',
    await s.panel.locator('#shotPermNotice').isHidden()
  );
  check(
    'the panel shows no permission notice in the timeline',
    await s.panel.locator('#shotPermTimelineNotice').isHidden()
  );

  const records = await s.thumbRecords();
  const pageViewport = await s.page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const byId = new Map(records.map((r) => [r.eventId, r]));
  const thumbnailed = [gotoStep, ...userSteps].filter(Boolean);
  for (const step of thumbnailed) {
    const rec = byId.get(step.eventId);
    check(
      `${step.what ?? 'goto'}: record is a ≤360px JPEG for this window`,
      rec && rec.type === 'image/jpeg' && rec.size > 0 && rec.width <= 360 && rec.windowId === s.windowId,
      JSON.stringify(rec)
    );
    // The thumbnail is drawn over at the viewport's proportions; a capture of a
    // different shape would put every outline in the wrong place.
    check(
      `${step.what ?? 'goto'}: image has the viewport's aspect ratio`,
      rec && Math.abs(rec.width / rec.height - pageViewport.width / pageViewport.height) < 0.03,
      rec && `${rec.width}x${rec.height} vs viewport ${pageViewport.width}x${pageViewport.height}`
    );

    const slot = await decodedSlot(s, step.eventId);
    check(
      `${step.what ?? 'goto'}: timeline shows a decoded thumbnail (naturalWidth ≤ 360, 72px wide)`,
      slot?.img &&
        slot.complete &&
        slot.naturalWidth > 0 &&
        slot.naturalWidth <= 360 &&
        Math.round(slot.imgBox.width) === 72,
      JSON.stringify(slot)
    );
    if (!step.live) continue; // goto: no element, no outline

    const r = step.rect;
    check(
      `${step.what}: the step carries the element's on-screen rect`,
      r &&
        step.viewport &&
        Math.abs(r.x - step.live.x) <= 2 &&
        Math.abs(r.y - step.live.y) <= 2 &&
        Math.abs(r.width - step.live.width) <= 2 &&
        Math.abs(r.height - step.live.height) <= 2 &&
        step.viewport.width === step.live.vw &&
        step.viewport.height === step.live.vh,
      `recorded ${JSON.stringify({ rect: r, viewport: step.viewport })} vs live ${JSON.stringify(step.live)}`
    );
    const o = slot?.outline;
    const i = slot?.imgBox;
    const inside =
      o &&
      i &&
      o.width > 0 &&
      o.height > 0 &&
      o.x >= i.x - 1 &&
      o.y >= i.y - 1 &&
      o.x + o.width <= i.x + i.width + 1 &&
      o.y + o.height <= i.y + i.height + 1;
    check(
      `${step.what}: the outline sits inside the thumbnail`,
      inside,
      JSON.stringify({ outline: o, img: i })
    );
    if (inside) {
      // Where the element really was, as a fraction of the viewport, against where
      // the outline is drawn, as a fraction of the image (±3% of the image).
      const want = {
        x: step.live.x / step.live.vw,
        y: step.live.y / step.live.vh,
        w: step.live.width / step.live.vw,
        h: step.live.height / step.live.vh,
      };
      const got = {
        x: (o.x - i.x) / i.width,
        y: (o.y - i.y) / i.height,
        w: o.width / i.width,
        h: o.height / i.height,
      };
      check(
        `${step.what}: the outline is over the element`,
        ['x', 'y', 'w', 'h'].every((k) => Math.abs(want[k] - got[k]) <= 0.03),
        `outline ${JSON.stringify(got)} vs element ${JSON.stringify(want)}`
      );
    }
  }

  const vps = await viewportSteps();
  for (const vp of vps) {
    const slot = await s.slotState(vp.eventId);
    check(
      'the viewport step has no thumbnail (timeline or IndexedDB)',
      !slot.img && !byId.has(vp.eventId),
      JSON.stringify({ slot, stored: byId.has(vp.eventId) })
    );
  }
  const expected = new Set(thumbnailed.map((x) => x.eventId));
  check(
    'IndexedDB holds exactly one record per thumbnailed step',
    records.length === expected.size && records.every((r) => expected.has(r.eventId)),
    `records ${JSON.stringify(records.map((r) => r.eventId))} vs steps ${JSON.stringify([...expected])}`
  );

  console.log('\npreview');
  const target = userSteps.find((x) => x.action === 'check') ?? userSteps[0];
  if (target) {
    const thumbBtn = s.panel.locator(`#recorderTimeline .ll-thumb-btn[data-eid="${target.eventId}"]`);
    await thumbBtn.click();
    const dialog = s.panel.getByRole('dialog');
    await dialog.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    check('clicking a thumbnail opens the preview dialog', await dialog.isVisible());
    check(
      'focus moves into the dialog',
      await s.panel.evaluate(() => document.getElementById('thumbModal').contains(document.activeElement))
    );
    const large = await s.panel
      .waitForFunction(
        () => {
          const img = document.querySelector('#thumbModalBody img');
          return img && img.complete && img.naturalWidth > 0 ? img.getBoundingClientRect().width : 0;
        },
        null,
        { timeout: 3000 }
      )
      .then((h) => h.jsonValue())
      .catch(() => 0);
    check('the preview shows the screenshot larger than the thumbnail', large > 72, `width ${large}`);
    check(
      'the preview outlines the step',
      (await s.panel.locator('#thumbModalBody .ll-thumb-rect').count()) === 1
    );

    await s.panel.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
    check('Esc closes the preview', await dialog.isHidden());
    check(
      'focus returns to the thumbnail',
      await s.panel.evaluate(
        (id) => document.activeElement?.matches?.(`.ll-thumb-btn[data-eid="${id}"]`) === true,
        target.eventId
      )
    );
  }

  console.log('\nrecords follow the timeline');
  // Undo keeps the screenshot (Redo can bring the step back); ✕ deletes it.
  const last = userSteps[userSteps.length - 1];
  if (last) {
    await s.panel.click('#undoActionBtn');
    await until(async () => !(await s.steps()).some((x) => x.eventId === last.eventId), {
      timeout: 3000,
      what: 'undo',
    }).catch(() => {});
    await sleep(CAPTURE_INTERVAL_MS); // a delete message would have landed by now
    check("Undo keeps the undone step's record", (await s.recordIds()).has(last.eventId));
    await s.panel.click('#redoActionBtn');
    const back = await decodedSlot(s, last.eventId);
    check(
      'Redo brings the step back with its thumbnail',
      back?.img && back.naturalWidth > 0,
      JSON.stringify(back)
    );
  }

  const victim = userSteps.find((x) => x.action === 'fill');
  if (victim) {
    const index = (await s.steps()).findIndex((x) => x.eventId === victim.eventId);
    await s.panel.click(`#recorderTimeline .remove-step-btn[data-index="${index}"]`);
    let gone = false;
    await until(async () => !(await s.recordIds()).has(victim.eventId), { timeout: 4000, what: 'the delete' })
      .then(() => (gone = true))
      .catch(() => {});
    check('removing a step (✕) deletes its record', gone);
    const ids = await s.recordIds();
    check(
      'the other steps keep theirs',
      thumbnailed.filter((x) => x !== victim).every((x) => ids.has(x.eventId)),
      JSON.stringify([...ids])
    );
  }

  console.log('\nsetting: step screenshots');
  await s.openSettings();
  await s.panel.uncheck('#settingStepScreenshots');
  const settingIs = (value) =>
    until(
      async () =>
        (await s.worker.evaluate(async () => (await chrome.storage.local.get('llSettings')).llSettings))
          ?.stepScreenshots === value,
      { timeout: 3000, what: `stepScreenshots=${value} in storage` }
    )
      .then(() => true)
      .catch(() => false);
  check('turning the setting off is saved', await settingIs(false));
  check('no permission notice while the setting is off', await s.panel.locator('#shotPermNotice').isHidden());

  await s.page.bringToFront();
  const off = await s.recordStep('click on phone (setting off)', () => s.page.click('#phone'), {
    action: 'click',
  });
  check('steps are still recorded with the setting off', Boolean(off));
  await sleep(NO_THUMB_SETTLE_MS);
  check(
    'a step recorded with the setting off gets no thumbnail',
    off && !(await s.recordIds()).has(off.eventId) && !(await s.slotState(off.eventId)).img
  );

  await s.openRecorder();
  await s.openSettings();
  await s.panel.check('#settingStepScreenshots');
  check('turning it back on is saved', await settingIs(true));
  await s.page.bringToFront();
  const on = await s.recordStep('click on last name (setting on)', () => s.page.click('#last-name'), {
    action: 'click',
  });
  check('thumbnails resume once it is back on', on && (await s.waitForRecord(on.eventId)));

  // ── Phase C ──
  console.log('\nphase C: suggested and viewport steps');
  await s.page.bringToFront();
  const before = new Set((await s.steps()).map((x) => x.eventId));
  const submit = await s.recordStep('place order', () => s.page.click('[data-testid="place-order"]'));
  check(
    'the submit click is recorded and its thumbnail stored',
    submit && (await s.waitForRecord(submit.eventId))
  );
  // The order puts up a confirmation (role=status) and pushes /checkout/confirmed:
  // both are proposed as assertions.
  let suggested = [];
  await until(
    async () => {
      suggested = (await s.steps()).filter((x) => x.suggested && !before.has(x.eventId));
      return suggested.some((x) => x.assertType === 'toHaveURL') && suggested.length >= 2;
    },
    { timeout: 8000, what: 'the suggested assertions' }
  ).catch(() => {});
  check(
    'suggested assertions were proposed',
    suggested.length > 0,
    JSON.stringify((await s.steps()).slice(-4))
  );
  await sleep(NO_THUMB_SETTLE_MS);
  const idsAfter = await s.recordIds();
  await s.openRecorder();
  for (const sug of suggested) {
    const slot = await s.slotState(sug.eventId);
    check(
      `suggested ${sug.assertType}: no thumbnail (timeline or IndexedDB)`,
      !slot.slot && !idsAfter.has(sug.eventId),
      JSON.stringify({ slot, stored: idsAfter.has(sug.eventId) })
    );
  }

  // A second recording opens with a second goto + viewport pair.
  await s.page.bringToFront();
  await s.viaWorker({ type: 'STOP_RECORDING' });
  const vpBefore = new Set((await viewportSteps()).map((x) => x.eventId));
  await s.viaWorker({ type: 'START_RECORDING' });
  let vp2 = null;
  await until(
    async () => {
      vp2 = (await viewportSteps()).find((x) => !vpBefore.has(x.eventId)) ?? null;
      return Boolean(vp2);
    },
    { timeout: 6000, what: 'the second viewport step' }
  ).catch(() => {});
  const goto2 = (await s.steps()).find((x) => x.action === 'goto' && !before.has(x.eventId));
  check("the restarted recording's goto gets a thumbnail", goto2 && (await s.waitForRecord(goto2.eventId)));
  await sleep(NO_THUMB_SETTLE_MS);
  check('its viewport step does not', vp2 && !(await s.recordIds()).has(vp2.eventId), JSON.stringify(vp2));
  await s.viaWorker({ type: 'STOP_RECORDING' });

  console.log('\nclear timeline');
  await s.openRecorder();
  check(
    'this window has records before clearing',
    (await s.thumbRecords()).some((r) => r.windowId === s.windowId)
  );
  await s.panel.click('#clearTimelineBtn');
  let cleared = false;
  await until(async () => !(await s.thumbRecords()).some((r) => r.windowId === s.windowId), {
    timeout: 4000,
    what: "the window's records to go",
  })
    .then(() => (cleared = true))
    .catch(() => {});
  check('Clear Timeline deletes every record of the window', cleared, JSON.stringify(await s.thumbRecords()));
  check(
    'the timeline shows no thumbnails',
    (await s.panel.locator('#recorderTimeline .ll-thumb-btn').count()) === 0
  );

  check(
    'no errors in the page, panel or worker console',
    s.errors.length === 0,
    s.errors.slice(0, 4).join(' | ')
  );
}

async function main() {
  if (!existsSync(EXTENSION)) throw new Error('dist/chrome missing — run `npm run build` first.');
  const executablePath = resolveChromium();
  if (!executablePath)
    throw new Error('No Playwright Chromium found. Run `npx playwright install chromium`.');
  const extensionId = computeExtensionId(EXTENSION);
  const server = await startDemoServer({ port: PORT });

  rmSync(PROFILE, { recursive: true, force: true });
  try {
    let context = await launch(executablePath);
    try {
      await phaseA(context, extensionId, server.base);
    } catch (err) {
      check('phase A ran to the end', false, err.stack || String(err));
    } finally {
      await context.close();
    }

    const seeded = seedAllUrlsGrant(extensionId);
    if (!check('the <all_urls> grant was seeded into the profile', seeded > 0)) return;

    context = await launch(executablePath);
    try {
      await phaseB(context, extensionId, server.base);
    } catch (err) {
      check('phase B/C ran to the end', false, err.stack || String(err));
    } finally {
      await context.close();
    }
  } finally {
    await server.close();
    rmSync(PROFILE, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    const passed = results.length - failures;
    console.log(`\n${failures ? '✗' : '✓'} ${passed}/${results.length} checks passed`);
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.error(`\n✗ ${err.stack || err.message}\n`);
    rmSync(PROFILE, { recursive: true, force: true });
    process.exit(1);
  });
