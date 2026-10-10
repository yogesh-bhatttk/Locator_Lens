#!/usr/bin/env node
/* global chrome, document, CSS, LLCodegen */
// Real-browser smoke test for the Page Object export (F2).
//
// The unit suites prove the codegen in isolation and drive the panel in jsdom. This
// drives the built extension end to end instead: the real side panel's buttons,
// the real content script's scan and region picker (real mouse, real Esc), and the
// real worker relay between them. Then it holds the output to account:
//
//   • every locator the Playwright page object assigns is executed against the live
//     page and must hit exactly one element — the one its name says it is;
//   • the generated class itself is written to disk, imported, instantiated with
//     the live Playwright page, and its helpers fill and submit the demo checkout —
//     the demo server must receive exactly what the helpers entered;
//   • the Selenium XPath / CSS strings (JavaScript and Python) are evaluated in the
//     page and must land on the same elements as the Playwright locators.
//
//   npm run build && node scripts/e2e/smoke-pom.mjs
//
// Needs a display. Uses its own port and profile so it can run alongside
// scripts/smoke.mjs and the other e2e smokes.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

import { computeExtensionId, resolveChromium, until, waitForServiceWorker } from './browsers.mjs';
// The decoder the codegen unit tests use for the emitted helper calls, in every language.
import { helperCallOf } from '../../tests/codegen-helper-calls.mjs';
import { startDemoServer } from './demo-server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXTENSION = join(ROOT, 'dist/chrome');
const PORT = 4181;
const profile = join(ROOT, '.tmp-smoke-pom-profile');

// What each element of the demo checkout is, and what its member name has to say.
// The name only has to *mention* the element and end in the suffix for its kind
// (spec F2: Input / Field / Select / Checkbox / Button / Link) — the exact wording is
// suggestName's business; landing on the right element is this test's.
const DEMO_ELEMENTS = [
  { selector: 'nav a[href="#catalogue"]', name: /catalogue\w*Link$/i },
  { selector: 'nav a[href="#orders"]', name: /orders\w*Link$/i },
  { selector: 'nav a[href="#checkout"]', name: /checkout\w*Link$/i },
  { selector: '[data-testid="account-menu"]', name: /account\w*Button$/i },
  { selector: '#first-name', name: /first\w*Input$/i },
  { selector: '#last-name', name: /last\w*Input$/i },
  { selector: '#email', name: /email\w*Input$/i },
  { selector: '#phone', name: /phone\w*Input$/i },
  { selector: '#create-account', name: /account\w*Checkbox$/i },
  { selector: '#country', name: /country\w*Select$/i },
  { selector: '#notes', name: /notes\w*(Field|Input)$/i },
  { selector: '#gift-wrap', name: /gift\w*Checkbox$/i },
  { selector: '#save-details', name: /save\w*Checkbox$/i },
  { selector: '[data-testid="place-order"]', name: /place\w*Button$/i },
  { selector: 'aside .actions button.ghost', name: /back\w*Button$/i },
];
// The contact-details card: the region picked with the mouse. The password field is
// in it too, but hidden until "Create an account" is ticked, so it must be left out.
const CONTACT_IDS = ['first-name', 'last-name', 'email', 'phone', 'create-account'];

// Words a member may never be called (JS/TS keywords and the class's own members).
const RESERVED = new Set(
  (
    'break case catch class const continue debugger default delete do else enum export extends false finally ' +
    'for function if import in instanceof new null return super switch this throw true try typeof var void ' +
    'while with yield let static implements interface package private protected public await arguments eval ' +
    'undefined page driver goto constructor'
  ).split(' ')
);

const results = [];
let failures = 0;
const tempDirs = [];

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

async function main() {
  if (!existsSync(join(EXTENSION, 'manifest.json'))) {
    throw new Error('dist/chrome missing — run `npm run build` first.');
  }
  const executablePath = resolveChromium();
  if (!executablePath)
    throw new Error('No Playwright Chromium found. Run `npx playwright install chromium`.');

  const server = await startDemoServer({ port: PORT });
  const DEMO = `${server.base}/checkout`;

  rmSync(profile, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: false,
    acceptDownloads: true,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      // The Copy check pastes through the system clipboard. Under native Wayland the
      // compositor ignores a copy from a window without keyboard focus, which an
      // automated window often lacks, so the copy was dropped on some runs. X11
      // (XWayland here, xvfb in CI) has no such rule, so prefer it when available.
      ...(process.env.WAYLAND_DISPLAY && process.env.DISPLAY ? ['--ozone-platform=x11'] : []),
    ],
  });

  try {
    const extensionId = computeExtensionId(EXTENSION);
    const panelOrigin = `chrome-extension://${extensionId}`;

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
    await page.goto(DEMO, { waitUntil: 'load' });

    // The panel runs as a tab in the same window as the demo page: the worker answers
    // the panel's window, and in that window the demo tab is brought to the front
    // before each page-directed action so it is the "active tab" being scanned.
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 460, height: 900 });
    await panel.goto(`${panelOrigin}/src/sidepanel.html`, { waitUntil: 'load' });
    panel.on('dialog', (d) => d.accept().catch(() => {}));

    const worker = await waitForServiceWorker(context, extensionId);
    check('extension loads and the service worker is running', Boolean(worker));
    if (!worker) throw new Error('no service worker — nothing further can be driven');

    /** Resolve once the demo tab's top frame has a content script listening. */
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

    // ── panel readers ──────────────────────────────────────────────────────────
    const rows = () =>
      panel.$$eval('#pomList .ll-pom-row', (rs) =>
        rs.map((r) => {
          const input = r.querySelector('.ll-pom-name');
          return {
            name: input ? input.value : '',
            invalid: input ? input.getAttribute('aria-invalid') : null,
            kind: r.querySelector('.ll-pom-kind')?.textContent ?? '',
            unique: Boolean(r.querySelector('.uniq-ok')),
          };
        })
      );
    const text = (sel) => panel.evaluate((s) => document.querySelector(s)?.textContent ?? '', sel);
    const preview = () => text('#pomPreview');
    const status = () => text('#pomStatus');
    const meta = () => text('#pomMeta');
    const disabled = (sel) => panel.evaluate((s) => Boolean(document.querySelector(s)?.disabled), sel);

    async function setOutput(framework, language, ready) {
      await panel.selectOption('#fwSelect', framework);
      await panel.selectOption('#langSelect', language);
      return waitFor(async () => ready.test(await preview()), `${framework}/${language} page object`);
    }

    /** `this.<member> = <expr>;` assignments in the constructor of a Playwright TS/JS page object. */
    function constructorLocators(code) {
      const ctor = /constructor\(page[^)]*\)\s*\{([\s\S]*?)\n {2}\}/.exec(code)?.[1] ?? '';
      return [...ctor.matchAll(/^\s*this\.(\w+)\s*=\s*(page\..+);\s*$/gm)].map(([, member, expr]) => ({
        member,
        expr,
      }));
    }

    /**
     * Execute each locator expression against the live page. Returns one entry per
     * member with the match count and, when it matched exactly one, a summary of
     * that element; the element is tagged data-pom-smoke=<member> so other
     * frameworks' locators can be checked against the very same node.
     */
    async function resolveLocators(locators) {
      await page.evaluate(() =>
        document.querySelectorAll('[data-pom-smoke]').forEach((n) => n.removeAttribute('data-pom-smoke'))
      );
      const out = [];
      for (const { member, expr } of locators) {
        let count = -1;
        let el = null;
        let error = '';
        try {
          // Executing our own generated locator is the point of the test.
          // eslint-disable-next-line no-new-func
          const loc = new Function('page', `return (${expr});`)(page);
          count = await loc.count();
          if (count === 1) {
            el = await loc.evaluate((node, name) => {
              node.setAttribute('data-pom-smoke', name);
              return {
                id: node.id,
                tag: node.localName,
                type: (node.getAttribute('type') || '').toLowerCase(),
                inContactCard: node.closest('.card')?.querySelector('h2')?.textContent === 'Contact details',
              };
            }, member);
          }
        } catch (err) {
          error = err.message.split('\n')[0];
        }
        out.push({ member, expr, count, el, error });
      }
      return out;
    }

    /** Does a member's kind suffix agree with the element it resolved to? */
    function suffixFits(member, el) {
      if (!el) return false;
      if (/Checkbox$/.test(member)) return el.type === 'checkbox';
      if (/Radio$/.test(member)) return el.type === 'radio';
      if (/Select$/.test(member)) return el.tag === 'select';
      if (/Field$/.test(member)) return el.tag === 'textarea';
      if (/Input$/.test(member)) return el.tag === 'input' && !['checkbox', 'radio'].includes(el.type);
      if (/Button$/.test(member)) return el.tag === 'button' || ['button', 'submit'].includes(el.type);
      if (/Link$/.test(member)) return el.tag === 'a';
      return true;
    }

    async function importPageObject(code, language) {
      const cls = /export class (\w+)/.exec(code)?.[1];
      const dir = mkdtempSync(join(tmpdir(), 'locatra-pom-'));
      tempDirs.push(dir);
      writeFileSync(join(dir, `${cls}.${language === 'typescript' ? 'ts' : 'js'}`), code);
      let js = language === 'typescript' ? quietly(() => stripTypeScriptTypes(code)) : code;
      // `import { type Page, type Locator } from '@playwright/test'` is still an
      // import once the types are gone; point it at this repo's copy so the file
      // loads from a temp dir exactly as written.
      js = js.replace(/(['"])@playwright\/test\1/, JSON.stringify(PLAYWRIGHT_TEST_URL));
      const file = join(dir, `${cls}.${language}.mjs`);
      writeFileSync(file, js);
      const mod = await import(pathToFileURL(file).href);
      return { cls, Class: mod[cls] };
    }

    async function scanWholePage() {
      await page.bringToFront();
      await panel.click('#pomScanBtn');
      return waitFor(
        async () => /Found \d+ element/.test(await status()) && (await rows()).length > 0,
        'the whole-page scan to reach the panel'
      );
    }

    await contentScriptReady();

    // ═══ 1. Whole page ═══════════════════════════════════════════════════════
    console.log('\nwhole page');
    await panel.selectOption('#fwSelect', 'playwright');
    await panel.selectOption('#langSelect', 'typescript');
    check('"Whole page" lists elements in the panel', await scanWholePage(), await status());

    const wholeRows = await rows();
    check('more than 5 elements were found', wholeRows.length > 5, `found ${wholeRows.length}`);
    const names = wholeRows.map((r) => r.name);
    check(
      'every name is a valid identifier',
      names.every((n) => /^[A-Za-z_$][\w$]*$/.test(n)),
      names.filter((n) => !/^[A-Za-z_$][\w$]*$/.test(n)).join(', ')
    );
    check(
      'no name is a reserved word or a class member',
      names.every((n) => !RESERVED.has(n)),
      names.filter((n) => RESERVED.has(n)).join(', ')
    );
    check('names are unique', new Set(names).size === names.length, names.join(', '));
    check(
      'no name is flagged invalid',
      wholeRows.every((r) => r.invalid !== 'true'),
      wholeRows
        .filter((r) => r.invalid === 'true')
        .map((r) => r.name)
        .join(', ')
    );
    check(
      'every element shows the "unique" badge',
      wholeRows.every((r) => r.unique),
      wholeRows
        .filter((r) => !r.unique)
        .map((r) => r.name)
        .join(', ')
    );
    check(
      'the region reads as the whole page',
      /locator\('body'\)|whole page/i.test(await meta()),
      await meta()
    );
    check('export is enabled', !(await disabled('#pomCopyBtn')) && !(await disabled('#pomDownloadBtn')));

    // ═══ 3. The Playwright locators resolve to the elements their names describe ═══
    console.log('\nPlaywright page object locators resolve on the live page');
    const tsCode = await preview();
    check(
      'a Playwright TypeScript page object is shown',
      tsCode.includes("from '@playwright/test'") && /export class \w+/.test(tsCode),
      tsCode.slice(0, 200)
    );
    const tsLocators = constructorLocators(tsCode);
    check(
      'the constructor assigns one locator per listed element',
      tsLocators.length === wholeRows.length,
      `${tsLocators.length} assignments for ${wholeRows.length} rows`
    );
    check(
      'the members are the names shown in the panel',
      tsLocators.map((l) => l.member).join() === names.join(),
      `${tsLocators.map((l) => l.member).join()} vs ${names.join()}`
    );
    const resolved = await resolveLocators(tsLocators);
    for (const r of resolved) {
      check(
        `${r.member} = ${r.expr.slice(0, 70)} matches exactly 1 element`,
        r.count === 1,
        r.error || `matched ${r.count}`
      );
    }
    check(
      'no two members point at the same element',
      (await page.locator('[data-pom-smoke]').count()) === resolved.filter((r) => r.count === 1).length
    );
    check(
      'every member’s kind suffix fits its element',
      resolved.every((r) => suffixFits(r.member, r.el)),
      resolved
        .filter((r) => !suffixFits(r.member, r.el))
        .map((r) => `${r.member} → <${r.el?.tag} type=${r.el?.type}>`)
        .join(', ')
    );
    check(
      'hidden fields (the password) are left out',
      (await page.locator('#password[data-pom-smoke]').count()) === 0
    );

    // Member names for the demo's elements, found by what they say, then held to the
    // element they actually resolved to.
    const memberFor = {};
    for (const { selector, name } of DEMO_ELEMENTS) {
      const candidates = resolved.filter((r) => name.test(r.member));
      const tagged = await page
        .locator(selector)
        .getAttribute('data-pom-smoke')
        .catch(() => null);
      memberFor[selector] = tagged;
      check(
        `${selector} is the member named for it (${tagged ?? 'none'})`,
        tagged && candidates.length === 1 && candidates[0].member === tagged,
        `name pattern ${name} matched [${candidates.map((c) => c.member).join(', ')}], element tagged ${tagged}`
      );
    }

    // ═══ 5. Selenium locators resolve to the same elements ═══════════════════
    console.log('\nSelenium page objects resolve on the live page');
    // Each member is a lookup by id / name / css / xpath, or (role, label or text
    // with no simpler equivalent) a call to the emitted locatra helper, which runs
    // the codegen's own in-page matcher (MATCH_JS) — evaluated here the same way.
    const matchJs = await panel.evaluate(() => LLCodegen._internals.MATCH_JS);
    const countIn = (lookup) =>
      page.evaluate(
        ({ lookup, matchJs }) => {
          let hits = [];
          if (lookup.by === 'helper') {
            const c = lookup.call;
            hits = new Function(matchJs)(c.kind, c.value, c.name, !!c.exact, c.level || 0, document);
            if (c.nth >= 0) hits = hits.slice(c.nth, c.nth + 1);
          } else if (lookup.by === 'xpath') {
            const r = document.evaluate(
              lookup.selector,
              document,
              null,
              7 /* ORDERED_NODE_SNAPSHOT_TYPE */,
              null
            );
            hits = Array.from({ length: r.snapshotLength }, (_, i) => r.snapshotItem(i));
          } else {
            const css =
              lookup.by === 'id'
                ? '#' + CSS.escape(lookup.selector)
                : lookup.by === 'name'
                  ? `[name="${CSS.escape(lookup.selector)}"]`
                  : lookup.selector;
            hits = [...document.querySelectorAll(css)];
          }
          return {
            count: hits.length,
            tag: hits.length === 1 ? hits[0].getAttribute('data-pom-smoke') : null,
          };
        },
        { lookup, matchJs }
      );

    /** Each page-object member and the lookup its body makes. */
    // Only the members that hand back an element: their body is one `return` of a
    // lookup. The fill… / check… / click… action methods around them are not lookups.
    const membersOf = (code, language, memberRe) =>
      [...code.matchAll(memberRe)]
        .filter(([, , body]) => /^\s*return\b/.test(body))
        .map(([, member, body]) => {
          const call = helperCallOf(body, language);
          if (call)
            return { member, by: 'helper', call, selector: `${call.kind} ${call.value} ${call.name ?? ''}` };
          const m =
            language === 'python'
              ? /By\.(ID|NAME|CSS_SELECTOR|XPATH), ("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/.exec(body)
              : /By\.(id|name|css|xpath)\(('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")\)/.exec(body);
          if (!m) return { member, by: 'unknown', selector: body.trim().slice(0, 60) };
          const by = { ID: 'id', NAME: 'name', CSS_SELECTOR: 'css', XPATH: 'xpath' }[m[1]] || m[1];
          return {
            member,
            by,
            selector: language === 'python' ? pyString(m[2]) : new Function(`return ${m[2]}`)(),
          };
        });

    const seleniumCases = [
      {
        language: 'javascript',
        ready: /require\('selenium-webdriver'\)/,
        parse: (code) => membersOf(code, 'javascript', /^\s*(?:async )?(\w+)\(\)\s*\{([\s\S]*?)\n\s*\}/gm),
      },
      {
        language: 'python',
        ready: /from selenium\.webdriver/,
        parse: (code) =>
          membersOf(
            code,
            'python',
            /^\s*def (\w+)\(self\)[^:\n]*:\s*\n([\s\S]*?)(?=\n\s*(?:def |@|class )|\n\S|$)/gm
          ).map((x) => ({ ...x, member: snakeToCamel(x.member) })),
      },
    ];
    for (const { language, ready, parse } of seleniumCases) {
      check(`Selenium ${language} page object is shown`, await setOutput('selenium', language, ready));
      const code = await preview();
      const found = parse(code);
      check(
        `Selenium ${language}: one lookup per element`,
        found.length === wholeRows.length,
        `parsed ${found.length} lookups for ${wholeRows.length} elements`
      );
      for (const lookup of found) {
        const { member, by, selector } = lookup;
        const { count, tag } = by === 'unknown' ? { count: -1, tag: null } : await countIn(lookup);
        check(
          `Selenium ${language} ${member}: ${by} ${selector.slice(0, 40)}… matches exactly 1 element`,
          count === 1,
          `matched ${count}`
        );
        if (count === 1) {
          check(
            `Selenium ${language} ${member} is the same element as the Playwright member`,
            tag === member,
            `landed on the element tagged ${tag}`
          );
        }
      }
    }
    check(
      'back to Playwright TypeScript',
      await setOutput('playwright', 'typescript', /from '@playwright\/test'/)
    );

    // ═══ 4. Use the generated class against the live page ════════════════════
    console.log('\nthe generated Playwright page object drives the page');
    const method = (verb, selector) => {
      const m = memberFor[selector];
      return m ? verb + m[0].toUpperCase() + m.slice(1) : '(no member)';
    };
    {
      const code = await preview();
      let po = null;
      let cls = '';
      try {
        const loaded = await importPageObject(code, 'typescript');
        cls = loaded.cls;
        po = new loaded.Class(page);
      } catch (err) {
        check('the TypeScript page object imports once its types are stripped', false, err.message);
      }
      if (po) {
        check(`the TypeScript page object imports and ${cls} instantiates with the live page`, true);
        check('it keeps the page it was given', po.page === page);

        await page.goto('about:blank');
        await po.goto();
        check('goto() opens the scanned page', page.url() === DEMO, `at ${page.url()}`);
        await page.waitForLoadState('load');

        const steps = [
          [method('fill', '#first-name'), 'Ada'],
          [method('fill', '#last-name'), 'Lovelace'],
          [method('fill', '#email'), 'ada@example.test'],
          [method('fill', '#phone'), '+44 20 7946 0001'],
          [method('select', '#country'), 'Ireland'],
          [method('fill', '#notes'), 'Ring the bell twice'],
          [method('check', '#gift-wrap')],
          [method('uncheck', '#save-details')],
          [method('check', '#create-account')],
          [method('uncheck', '#create-account')],
        ];
        for (const [fn, ...args] of steps) {
          let ok = typeof po[fn] === 'function';
          let detail = ok ? '' : `no method ${fn} on ${cls}`;
          if (ok) {
            try {
              await po[fn](...args);
            } catch (err) {
              ok = false;
              detail = err.message.split('\n')[0];
            }
          }
          check(`${fn}(${args.map((a) => JSON.stringify(a)).join(', ')}) runs`, ok, detail);
        }
        const state = await page.evaluate(() => ({
          first: document.getElementById('first-name').value,
          last: document.getElementById('last-name').value,
          email: document.getElementById('email').value,
          phone: document.getElementById('phone').value,
          country: document.getElementById('country').value,
          notes: document.getElementById('notes').value,
          gift: document.getElementById('gift-wrap').checked,
          save: document.getElementById('save-details').checked,
          account: document.getElementById('create-account').checked,
        }));
        check(
          'the fill helpers filled the fields',
          state.first === 'Ada' &&
            state.last === 'Lovelace' &&
            state.email === 'ada@example.test' &&
            state.phone === '+44 20 7946 0001' &&
            state.notes === 'Ring the bell twice',
          JSON.stringify(state)
        );
        check('the select helper chose Ireland', state.country === 'Ireland', state.country);
        check(
          'check/uncheck helpers set the boxes',
          state.gift && !state.save && !state.account,
          JSON.stringify(state)
        );

        const before = server.orders().length;
        const submit = method('click', '[data-testid="place-order"]');
        let clicked = typeof po[submit] === 'function';
        if (clicked) await po[submit]().catch(() => (clicked = false));
        check(`${submit}() runs`, clicked);
        const confirmed = await waitFor(
          async () =>
            (await page.locator('#order-confirmation').isVisible()) && server.orders().length > before,
          'the order to be placed'
        );
        const order = server.orders().at(-1) ?? {};
        check(
          'the order the server received is what the helpers entered',
          confirmed &&
            order.firstName === 'Ada' &&
            order.lastName === 'Lovelace' &&
            order.email === 'ada@example.test' &&
            order.country === 'Ireland' &&
            order.notes === 'Ring the bell twice' &&
            order.giftWrap === true &&
            order.saveDetails === false &&
            order.createAccount === false,
          JSON.stringify(order)
        );
        check(
          'the page confirms the order',
          /Ada Lovelace/.test((await page.locator('[data-testid="confirmation-name"]').textContent()) ?? '')
        );
      }
    }

    // The JavaScript flavour: same class without types, imported as written.
    check(
      'Playwright JavaScript page object is shown',
      await setOutput('playwright', 'javascript', /^export class /m)
    );
    {
      const code = await preview();
      check(
        'the JavaScript output has no type annotations',
        !/: (Page|Locator|string)\b|Promise<void>/.test(code)
      );
      try {
        const { cls, Class } = await importPageObject(code, 'javascript');
        const po = new Class(page);
        await po.goto();
        await page.waitForLoadState('load');
        await po[method('fill', '#first-name')]('Grace');
        await po[method('select', '#country')]('Germany');
        await po[method('check', '#gift-wrap')]();
        const state = await page.evaluate(() => ({
          first: document.getElementById('first-name').value,
          country: document.getElementById('country').value,
          gift: document.getElementById('gift-wrap').checked,
        }));
        check(
          `the JavaScript ${cls} fills, selects and checks on the live page`,
          state.first === 'Grace' && state.country === 'Germany' && state.gift,
          JSON.stringify(state)
        );
      } catch (err) {
        check('the JavaScript page object imports and runs', false, err.message.split('\n')[0]);
      }
    }
    await setOutput('playwright', 'typescript', /from '@playwright\/test'/);

    // ═══ 6. Renaming ═════════════════════════════════════════════════════════
    console.log('\nrenaming an element');
    const firstMember = memberFor['#first-name'];
    const lastMember = memberFor['#last-name'];
    const idx = (await rows()).findIndex((r) => r.name === firstMember);
    check('the first-name row is in the list', idx !== -1, `looking for ${firstMember}`);
    if (idx !== -1) {
      const input = panel.locator(`.ll-pom-name[data-index="${idx}"]`);
      const invalid = () => input.getAttribute('aria-invalid');
      const exportDisabled = async () =>
        (await disabled('#pomCopyBtn')) && (await disabled('#pomDownloadBtn'));

      await input.fill('buyerGivenName');
      check(
        'the new name is used for the member and its helper',
        await waitFor(async () => {
          const code = await preview();
          return (
            code.includes('readonly buyerGivenName: Locator;') &&
            code.includes('this.buyerGivenName = ') &&
            code.includes('async fillBuyerGivenName(') &&
            !code.includes(firstMember)
          );
        }, 'the renamed member in the preview'),
        (await preview()).slice(0, 600)
      );
      const renamed = constructorLocators(await preview()).find((l) => l.member === 'buyerGivenName');
      const renamedHits = renamed ? await resolveLocators([renamed]) : [];
      check(
        'the renamed member still resolves to the first-name field',
        renamedHits[0]?.count === 1 && renamedHits[0]?.el?.id === 'first-name',
        JSON.stringify(renamedHits[0] ?? null)
      );
      check('a valid name is not flagged', (await invalid()) === 'false');

      // The edited name belongs to the model, not to one rendering of it.
      check(
        'the rename carries over to Python (snake_case)',
        await setOutput('playwright', 'python', /self\.buyer_given_name = page\./),
        (await preview()).slice(0, 400)
      );
      check('…with its helper', /def fill_buyer_given_name\(self, value: str\)/.test(await preview()));
      check(
        'and back to TypeScript unchanged',
        await setOutput('playwright', 'typescript', /this\.buyerGivenName = page\./)
      );

      // Excluding a row drops it (and its helper) from the class; including it restores it.
      const backMember = memberFor['aside .actions button.ghost'];
      const backIdx = (await rows()).findIndex((r) => r.name === backMember);
      const include = panel.locator(`.ll-pom-include[data-index="${backIdx}"]`);
      await include.uncheck();
      check(
        `unticking ${backMember} leaves it out of the class`,
        await waitFor(async () => !(await preview()).includes(backMember), 'the excluded member to go', 3000)
      );
      check(
        'the class still has every other member',
        constructorLocators(await preview()).length === wholeRows.length - 1,
        `${constructorLocators(await preview()).length} members`
      );
      await include.check();
      check(
        `ticking ${backMember} again puts it back`,
        await waitFor(
          async () => (await preview()).includes(`this.${backMember} = `),
          'the member to return',
          3000
        )
      );

      for (const bad of ['class', '1abc', 'first name']) {
        await input.fill(bad);
        const flagged = await waitFor(
          async () => (await invalid()) === 'true',
          `"${bad}" to be flagged`,
          3000
        );
        const errText = await text(`#pomErr-${idx}`);
        check(`"${bad}" is flagged invalid (aria-invalid)`, flagged, `aria-invalid=${await invalid()}`);
        check(`"${bad}": the row explains why`, errText.trim().length > 0);
        check(`"${bad}": Copy and Download are disabled`, await exportDisabled());
        check(`"${bad}": the panel says to fix it`, /fix/i.test(await text('#pomValidation')));
      }

      // A name another row already has: the panel marks the clash on both rows, so the
      // one being edited shows it too, and blocks export until it is resolved.
      await input.fill(lastMember);
      const dupFlagged = await waitFor(
        async () => (await rows()).filter((r) => r.name === lastMember && r.invalid === 'true').length === 2,
        'the duplicate to be flagged',
        3000
      );
      check(
        `a duplicate name ("${lastMember}" twice) is flagged`,
        dupFlagged,
        JSON.stringify((await rows()).filter((r) => r.name === lastMember))
      );
      check('a duplicate name disables Copy and Download', await exportDisabled());
      check('a duplicate name is explained', /duplicate/i.test(await text('#pomList')));

      await input.fill(firstMember);
      check(
        'restoring a valid name re-enables export',
        await waitFor(
          async () => (await invalid()) === 'false' && !(await exportDisabled()),
          'export to re-enable'
        )
      );

      await panel.fill('#pomClassName', 'class');
      check(
        'a reserved class name is flagged and blocks export',
        await waitFor(
          async () =>
            (await panel.getAttribute('#pomClassName', 'aria-invalid')) === 'true' &&
            (await exportDisabled()),
          'the class name to be flagged',
          3000
        )
      );
    }

    // ═══ 7. Copy and Download ════════════════════════════════════════════════
    console.log('\ncopy and download');
    await panel.fill('#pomClassName', 'Checkout');
    check(
      'the class name field names the class',
      await waitFor(
        async () => /export class CheckoutPage \{/.test(await preview()),
        'export class CheckoutPage'
      ),
      (await preview()).slice(0, 300)
    );
    check('the panel says where it will save', (await text('#pomFileHint')).includes('CheckoutPage.ts'));

    async function download(expected) {
      try {
        const [dl] = await Promise.all([
          panel.waitForEvent('download', { timeout: 10_000 }),
          panel.click('#pomDownloadBtn'),
        ]);
        const path = await dl.path();
        return { name: dl.suggestedFilename(), body: path ? readFileSync(path, 'utf8') : '' };
      } catch (err) {
        return { name: '', body: '', error: err.message.split('\n')[0], expected };
      }
    }

    const tsShown = await preview();
    const tsFile = await download('CheckoutPage.ts');
    check(
      'Download saves <ClassName>.ts',
      tsFile.name === 'CheckoutPage.ts',
      tsFile.error || `got ${tsFile.name}`
    );
    check(
      'the downloaded file is the code shown',
      tsFile.body === tsShown,
      `${tsFile.body.length} vs ${tsShown.length} chars`
    );

    await panel.bringToFront();
    await panel.click('#pomCopyBtn');
    check(
      'Copy reports success',
      await waitFor(async () => /Copied/.test(await text('#pomCopyBtn')), 'the Copied confirmation', 3000),
      await text('#pomCopyBtn')
    );
    // Read the clipboard back the way a user would: paste it (a real Ctrl+V) into a
    // blank page. navigator.clipboard.readText() needs focus and a permission grant
    // an extension origin does not reliably get, and stalls instead of failing.
    const clip = await pasteClipboard(context, tsShown);
    check('the clipboard holds the code shown', clip === tsShown, clip.slice(0, 200));

    check(
      'Playwright Python page object is shown',
      await setOutput('playwright', 'python', /^class CheckoutPage:/m)
    );
    const pyShown = await preview();
    const pyFile = await download('CheckoutPage.py');
    check(
      'Download in Python saves <ClassName>.py',
      pyFile.name === 'CheckoutPage.py',
      pyFile.error || `got ${pyFile.name}`
    );
    check('the downloaded Python file is the code shown', pyFile.body === pyShown);
    await setOutput('playwright', 'typescript', /from '@playwright\/test'/);

    // ═══ 2. Region pick with the real mouse ══════════════════════════════════
    console.log('\nregion pick');
    await page.goto(DEMO, { waitUntil: 'load' });
    await contentScriptReady();
    const metaBefore = await meta();

    await page.bringToFront();
    await panel.click('#pomPickBtn');
    check(
      'Pick region puts the page in pick mode',
      await waitFor(
        () =>
          page
            .locator('#ll-overlay')
            .count()
            .then((n) => n === 1),
        'the pick overlay'
      ),
      await status()
    );

    const heading = page.locator('.card h2', { hasText: 'Contact details' });
    const hb = await heading.boundingBox();
    // A real pointer: move onto the card's heading, wait for the overlay to frame the
    // whole card (region mode climbs to the container), then click there.
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2, { steps: 5 });
    const framesCard = () =>
      page.evaluate(() => {
        const o = document.getElementById('ll-overlay')?.getBoundingClientRect();
        const h = [...document.querySelectorAll('.card h2')].find((x) => x.textContent === 'Contact details');
        const c = h?.parentElement.getBoundingClientRect();
        return Boolean(
          o && c && Math.abs(o.x - c.x) < 4 && Math.abs(o.y - c.y) < 4 && Math.abs(o.width - c.width) < 4
        );
      });
    check(
      'hovering frames the whole contact-details card',
      await waitFor(framesCard, 'the overlay over the card')
    );
    await page.mouse.click(hb.x + hb.width / 2, hb.y + hb.height / 2);

    check(
      'clicking the card sends its Page Object to the panel',
      await waitFor(
        async () => (await meta()) !== metaBefore && /Found \d+ element/.test(await status()),
        'the region result'
      ),
      `${await status()} | ${await meta()}`
    );
    check('the panel names the picked region', !/locator\('body'\)/.test(await meta()), await meta());
    const regionRows = await rows();
    check(
      `the list has only the card's ${CONTACT_IDS.length} fields`,
      regionRows.length === CONTACT_IDS.length,
      regionRows.map((r) => r.name).join(', ')
    );
    check(
      'every region element is unique',
      regionRows.every((r) => r.unique)
    );
    const regionResolved = await resolveLocators(constructorLocators(await preview()));
    check(
      'each region locator matches exactly 1 element',
      regionResolved.length > 0 && regionResolved.every((r) => r.count === 1),
      regionResolved.map((r) => `${r.member}:${r.count}`).join(', ')
    );
    check(
      'they are exactly the contact-details fields',
      regionResolved.every((r) => r.el?.inContactCard) &&
        regionResolved
          .map((r) => r.el?.id)
          .sort()
          .join() === [...CONTACT_IDS].sort().join(),
      regionResolved.map((r) => `${r.member}→#${r.el?.id}`).join(', ')
    );
    check(
      'the pick overlay is gone afterwards',
      await waitFor(
        () =>
          page
            .locator('#ll-overlay')
            .count()
            .then((n) => n === 0),
        'the overlay to go',
        3000
      )
    );
    check(
      'the payment frame left pick mode too',
      await waitFor(
        () =>
          page
            .frameLocator('#payment-frame')
            .locator('#ll-overlay')
            .count()
            .then((n) => n === 0),
        'the frame overlay to go',
        3000
      )
    );

    console.log('\nEsc cancels a region pick');
    await page.bringToFront();
    await panel.click('#pomPickBtn');
    const armed = await waitFor(
      async () =>
        (await page.locator('#ll-overlay').count()) === 1 && /Hover a container/.test(await status()),
      'pick mode'
    );
    check('a second pick starts', armed, await status());
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 40, { steps: 3 });
    await page.keyboard.press('Escape');
    check(
      'the panel shows the pick was cancelled',
      await waitFor(async () => /cancelled/i.test(await status()), 'the cancelled state'),
      await status()
    );
    check(
      'the page overlay is gone',
      await waitFor(
        () =>
          page
            .locator('#ll-overlay')
            .count()
            .then((n) => n === 0),
        'the overlay to go',
        3000
      )
    );
    check(
      'the payment frame left pick mode too',
      await waitFor(
        () =>
          page
            .frameLocator('#payment-frame')
            .locator('#ll-overlay')
            .count()
            .then((n) => n === 0),
        'the frame overlay to go',
        3000
      )
    );
    check('cancelling keeps the previous result', (await rows()).length === CONTACT_IDS.length);
    // Esc must not have picked anything or left the page swallowing clicks.
    await page.locator('#first-name').click();
    await page.keyboard.type('x');
    check('the page takes input normally again', (await page.inputValue('#first-name')) === 'x');

    console.log('\nhygiene');
    check(
      'the content script logged nothing to the page console',
      pageErrors.length === 0,
      pageErrors.slice(0, 3).join(' | ')
    );
  } finally {
    await context.close();
    await server.close();
    rmSync(profile, { recursive: true, force: true });
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  }

  const passed = results.length - failures;
  console.log(`\n${failures ? '✗' : '✓'} ${passed}/${results.length} checks passed`);
  if (failures) process.exit(1);
}

const PLAYWRIGHT_TEST_URL = pathToFileURL(
  createRequire(join(ROOT, 'package.json')).resolve('@playwright/test')
).href;

/** Run fn without Node's one-off "stripTypeScriptTypes is experimental" warning. */
function quietly(fn) {
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) =>
    /stripTypeScriptTypes/.test(String(warning?.message ?? warning))
      ? undefined
      : emit.call(process, warning, ...rest);
  try {
    return fn();
  } finally {
    process.emitWarning = emit;
  }
}

/** What a real paste (Ctrl+V into a fresh textarea) yields. */
// On a desktop session (Wayland with XWayland, a clipboard manager) the clipboard a
// paste reads can lag the copy by a moment and briefly still hold an older value —
// the same build passed and failed on alternate runs that way. Paste again until the
// expected text arrives or 4 s pass; anything else after that is a real failure.
async function pasteClipboard(context, expected) {
  const scratch = await context.newPage();
  let last = '';
  try {
    await scratch.setContent('<textarea id="paste" style="width:600px;height:400px"></textarea>');
    await scratch.bringToFront();
    await until(
      async () => {
        await scratch.fill('#paste', '');
        await scratch.focus('#paste');
        await scratch.keyboard.press('ControlOrMeta+V');
        last = await scratch.inputValue('#paste');
        return expected === undefined ? last.length > 0 : last === expected;
      },
      { timeout: 4000, what: 'the paste' }
    ).catch(() => {});
    return last;
  } catch (err) {
    return `<<${err.message.split('\n')[0]}>>`;
  } finally {
    await scratch.close();
  }
}

function snakeToCamel(s) {
  return s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/** Decode a Python string literal ('…' or "…"). */
function pyString(lit) {
  return lit.slice(1, -1).replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e) => {
    if (/^[xuU]/.test(e)) return String.fromCodePoint(parseInt(e.slice(1), 16));
    return { n: '\n', t: '\t', r: '\r', 0: '\0' }[e] ?? e;
  });
}

main().catch((err) => {
  console.error(`\n✗ ${err.stack || err.message}\n`);
  rmSync(profile, { recursive: true, force: true });
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  process.exit(1);
});
