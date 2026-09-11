#!/usr/bin/env node
// Render the Chrome Web Store promo tiles.
//
// These used to exist only as uploads on the developer dashboard — no source, no
// history, nothing to regenerate from if the dashboard copy were lost or the
// branding changed. They are now built from this file.
//
// The palette is sampled from icons/icon128.png so the tiles match the mark that
// actually ships in the package: navy #15212F/#253347, crosshair green #4BD060.
// The store icon is the canonical identity; the tiles follow it, not the reverse.
//
//   node scripts/screenshots/promo.mjs
//
// Store requirements honoured here: exact canvas sizes, 24-bit PNG with no alpha
// channel, artwork bleeding to every edge (no letterboxing), and restrained text —
// a tile that is mostly words reads as an advert and reviews poorly.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

/**
 * The pinned build and the downloaded one drift apart whenever Playwright is
 * upgraded without re-running `playwright install`; fall back to the newest
 * Chromium actually on disk. Same helper as scripts/smoke.mjs.
 */
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(ROOT, 'screenshots', 'store');

const NAVY_DEEP = '#15212F';
const NAVY_LIFT = '#253347';
const GREEN = '#4BD060';
const GREEN_DIM = '#2DA653';

/** The crosshair from icon128.png, rebuilt as vector so it stays sharp at any size. */
function crosshair(px) {
  return `
  <svg width="${px}" height="${px}" viewBox="0 0 100 100" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id="g" x1="18" y1="12" x2="82" y2="88" gradientUnits="userSpaceOnUse">
        <stop stop-color="#6BE87C"/><stop offset="1" stop-color="${GREEN_DIM}"/>
      </linearGradient>
    </defs>
    <circle cx="50" cy="50" r="31" stroke="url(#g)" stroke-width="7"/>
    <circle cx="50" cy="50" r="15" stroke="url(#g)" stroke-width="7"/>
    <circle cx="50" cy="50" r="5.5" fill="${GREEN}"/>
    <g stroke="url(#g)" stroke-width="7" stroke-linecap="round">
      <path d="M50 4v14"/><path d="M50 82v14"/>
      <path d="M4 50h14"/><path d="M82 50h14"/>
    </g>
  </svg>`;
}

const FONT = `'Inter','Segoe UI','Helvetica Neue', 'DejaVu Sans', system-ui, sans-serif`;

/** Shared chrome: full-bleed navy field, soft green glow behind the mark, fine grid. */
function shell(w, h, body) {
  return `<!doctype html><meta charset="utf-8">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${w}px;height:${h}px;overflow:hidden}
    body{
      font-family:${FONT};
      background:
        radial-gradient(${Math.round(w * 0.6)}px ${Math.round(h * 0.9)}px at 22% 42%, rgba(75,208,96,.16), transparent 68%),
        linear-gradient(145deg, ${NAVY_LIFT} 0%, ${NAVY_DEEP} 58%, #0E1826 100%);
      color:#fff;
    }
    .grid{
      position:absolute;inset:0;
      background-image:
        linear-gradient(rgba(255,255,255,.032) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,.032) 1px, transparent 1px);
      background-size:${Math.round(h / 12)}px ${Math.round(h / 12)}px;
    }
    .wrap{position:relative;width:100%;height:100%;display:flex;align-items:center}
    .word{font-weight:700;letter-spacing:-.022em;line-height:1;white-space:nowrap}
    .word .lens{color:${GREEN}}
    .tag{color:#93A7BD;font-weight:500;line-height:1.35}
    .rule{background:linear-gradient(90deg,${GREEN},rgba(75,208,96,0));border-radius:2px}
    code{font-family:'DejaVu Sans Mono',ui-monospace,Menlo,Consolas,monospace}
  </style>
  <div class="grid"></div>
  <div class="wrap">${body}</div>`;
}

/** 440×280 — shown small in a grid, so: mark, name, one line. Nothing else. */
function smallTile() {
  return shell(
    440,
    280,
    `<div style="width:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:0 28px">
       ${crosshair(92)}
       <div style="display:flex;flex-direction:column;align-items:center;gap:9px">
         <div class="word" style="font-size:41px">Locator<span class="lens">Lens</span></div>
         <div class="rule" style="width:104px;height:3px"></div>
         <div class="tag" style="font-size:15.5px;letter-spacing:.055em;text-transform:uppercase">Smart Locator Automation</div>
       </div>
     </div>`
  );
}

/** 1400×560 — a wide banner has room for the one line that says what it does. */
function marqueeTile() {
  return shell(
    1400,
    560,
    `<div style="display:flex;align-items:center;gap:74px;padding:0 96px;width:100%">
       <div style="flex:0 0 auto;display:grid;place-items:center;width:290px;height:290px;
                   background:radial-gradient(circle at 50% 50%, rgba(75,208,96,.13), transparent 70%)">
         ${crosshair(232)}
       </div>
       <div style="flex:1 1 auto;min-width:0">
         <div class="word" style="font-size:104px">Locator<span class="lens">Lens</span></div>
         <div class="rule" style="width:232px;height:5px;margin:26px 0 24px"></div>
         <div class="tag" style="font-size:31px;max-width:830px">
           Inspect any element. Get ranked, uniqueness-checked locators for
           Playwright, Selenium&nbsp;&amp; Cypress.
         </div>
         <div style="margin-top:34px;display:inline-flex;align-items:center;gap:13px;
                     padding:15px 24px;border-radius:11px;
                     background:rgba(255,255,255,.045);border:1px solid rgba(75,208,96,.28)">
           <span style="width:9px;height:9px;border-radius:50%;background:${GREEN};flex:0 0 auto"></span>
           <code style="font-size:24px;color:#C8D6E5">page.getByRole(<span style="color:#6BE87C">'textbox'</span>, { name: <span style="color:#6BE87C">'Email address'</span> })</code>
         </div>
       </div>
     </div>`
  );
}

const TILES = [
  { name: 'promo-small-440x280.png', w: 440, h: 280, html: smallTile() },
  { name: 'promo-marquee-1400x560.png', w: 1400, h: 560, html: marqueeTile() },
];

const browser = await chromium.launch({ executablePath: resolveChromium() });
mkdirSync(OUT, { recursive: true });

for (const tile of TILES) {
  const page = await browser.newPage({ viewport: { width: tile.w, height: tile.h }, deviceScaleFactor: 2 });
  await page.setContent(tile.html, { waitUntil: 'load' });
  await page.waitForTimeout(120); // let the gradients settle before the grab

  const tmp = join(OUT, `.${tile.name}.tmp.png`);
  await page.screenshot({ path: tmp, clip: { x: 0, y: 0, width: tile.w, height: tile.h } });
  await page.close();

  // Rendered at 2x for crisp text, then resampled down to the exact canvas the
  // store expects. `-alpha remove -alpha off` is what makes it a true 24-bit PNG:
  // the store rejects an alpha channel even when every pixel is opaque.
  const dest = join(OUT, tile.name);
  execFileSync('magick', [
    tmp,
    '-resize',
    `${tile.w}x${tile.h}!`,
    '-background',
    NAVY_DEEP,
    '-alpha',
    'remove',
    '-alpha',
    'off',
    '-strip',
    '-depth',
    '8',
    `PNG24:${dest}`,
  ]);
  rmSync(tmp, { force: true });

  const kind = execFileSync('file', ['-b', dest]).toString().trim();
  console.log(`✓ ${tile.name}`);
  console.log(`  ${kind}`);
}

await browser.close();
