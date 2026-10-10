#!/usr/bin/env node
// Real-browser smoke test for the Firefox package.
//
// The unit suites run the worker against a mocked chrome.* and every other smoke
// drives Chromium. This installs dist/locatra-firefox-<version>.zip into a real
// Firefox as a temporary add-on (unsigned, as `web-ext run` does) and holds the
// Firefox-only pieces to account: the background *page* (module scripts, not a
// service worker), storage.session, scripting into every frame, the content script
// world, and the browser.* message plumbing between them.
//
//   • the add-on installs under its gecko id and its http/https access is granted;
//   • the side panel page (Firefox shows it as a sidebar; here it is opened as a tab)
//     talks to the background page;
//   • Inspect injects the content script into the demo page; Stop takes it out;
//   • Firefox opens the sidebar in a new window by itself (sidebar_action opens at
//     install), so a recording of real WebDriver input (trusted events) lands in
//     that window's sidebar timeline; the password step is kept without its value,
//     and nothing in extension storage holds the password;
//   • the recorded steps export to a Playwright test that reads the password from
//     the environment;
//   • a replay of those steps re-fills the reloaded page, the password reaching the
//     page through the owning frame's REPLAY_SECRET_REQUEST;
//   • the health check resolves locators in the page and inside the payment iframe;
//   • a privileged page (about:robots) is refused with the restricted-page message.
//
//   npm run build && node scripts/e2e/smoke-firefox.mjs
//
// Needs Firefox and geckodriver 0.36+ (LOCATRA_FIREFOX / LOCATRA_GECKODRIVER, else
// PATH). Found on neither, it says so and exits 0, so `npm run smoke:all` still runs
// elsewhere — unless LOCATRA_REQUIRE_FIREFOX=1 (CI); a path named in those
// variables that does not exist is always an error.
// Headless unless LOCATRA_E2E_HEADED=1.
//
// Opening a moz-extension:// page is something WebDriver refuses outright, so the
// panel tab is opened from Firefox's privileged (chrome) context — which geckodriver
// only allows when started with --allow-system-access. Nothing else uses it.

import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Builder, By, Key } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';

import { startDemoServer } from './demo-server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = join(ROOT, 'dist/firefox');
const PORT = 4186;
// A fixed internal UUID, so the panel's moz-extension:// URL is known in advance.
const UUID = '7c0d5e1a-6b2f-4c3d-9e8f-0a1b2c3d4e5f';
const PASSWORD_RECORDED = 'ff-Recorded-S3cret!';
const PASSWORD_REPLAYED = 'ff-Replayed-S3cret!';
const RESTRICTED_RE = /can't run on this page/i;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok && detail !== undefined) {
    console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 600)}`);
  }
}
const section = (title) => console.log(`\n${title}`);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, { timeout = 8000, interval = 200 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await pause(interval);
  }
  return last;
}

/** An executable from an env var, else the first match on PATH (snap included). */
function findExecutable(envName, name) {
  const fromEnv = process.env[envName];
  if (fromEnv) {
    // Named explicitly (as CI does): missing is an error, not a reason to skip.
    if (!existsSync(fromEnv)) throw new Error(`${envName}=${fromEnv} does not exist`);
    return fromEnv;
  }
  const dirs = (process.env.PATH || '').split(delimiter).concat(['/snap/bin', '/usr/local/bin', '/usr/bin']);
  for (const d of dirs) {
    const p = join(d, name);
    if (d && existsSync(p)) return p;
  }
  return null;
}

async function main() {
  const firefoxBin = findExecutable('LOCATRA_FIREFOX', 'firefox');
  const geckodriver = findExecutable('LOCATRA_GECKODRIVER', 'geckodriver');
  if (!firefoxBin || !geckodriver) {
    const why = `${!firefoxBin ? 'no firefox' : 'no geckodriver'} found`;
    if (process.env.LOCATRA_REQUIRE_FIREFOX === '1') throw new Error(`Firefox smoke cannot run: ${why}`);
    console.log(`Firefox smoke skipped: ${why}.`);
    return 0;
  }
  if (!existsSync(join(DIST, 'manifest.json')))
    throw new Error('dist/firefox is missing — run `npm run build` first');
  const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
  const geckoId = manifest.browser_specific_settings.gecko.id;
  const xpi = join(ROOT, `dist/locatra-firefox-${manifest.version}.zip`);
  if (!existsSync(xpi)) throw new Error(`${xpi} is missing — run \`npm run build\` first`);

  const server = await startDemoServer({ port: PORT });
  const options = new firefox.Options()
    .setPreference('extensions.webextensions.uuids', JSON.stringify({ [geckoId]: UUID }))
    .setPreference('browser.shell.checkDefaultBrowser', false);
  // geckodriver finds the installed Firefox itself (a snap's /usr/bin/firefox is a
  // wrapper script it must not be handed); LOCATRA_FIREFOX names another build.
  if (process.env.LOCATRA_FIREFOX) options.setBinary(firefoxBin);
  if (process.env.LOCATRA_E2E_HEADED !== '1') options.addArguments('-headless');
  const service = new firefox.ServiceBuilder(geckodriver).addArguments('--allow-system-access');
  const driver = await new Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(options)
    .setFirefoxService(service)
    .build();

  try {
    const version = (await driver.getCapabilities()).get('browserVersion');
    console.log(
      `Firefox ${version}  ·  ${manifest.name} ${manifest.version}  ·  demo ${server.base}/checkout`
    );

    section('install');
    const installed = await driver.installAddon(xpi, true);
    check(
      `the package installs as a temporary add-on under its gecko id (${geckoId})`,
      installed === geckoId,
      installed
    );

    // The panel page, opened as a tab from the privileged context.
    const before = await driver.getAllWindowHandles();
    await driver.setContext(firefox.Context.CHROME);
    await driver.executeScript(
      `const tab = gBrowser.addTab(arguments[0], {
         triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
       gBrowser.selectedTab = tab;`,
      `moz-extension://${UUID}/src/sidepanel.html`
    );
    await driver.setContext(firefox.Context.CONTENT);
    const panelHandle = await until(async () =>
      (await driver.getAllWindowHandles()).find((h) => !before.includes(h))
    );
    await driver.switchTo().window(panelHandle);
    await until(async () => (await driver.getTitle()).includes('Locatra'));

    const inPanel = async (body, ...args) => {
      await driver.switchTo().window(panelHandle);
      return driver.executeAsyncScript(
        `const done = arguments[arguments.length - 1];
         Promise.resolve().then(async () => { ${body} }).then(done, (e) => done({ thrown: String(e && e.message || e) }));`,
        ...args
      );
    };
    const send = (msg) => inPanel(`return await browser.runtime.sendMessage(arguments[0]);`, msg);

    check(
      'the side panel page loads',
      (await driver.getTitle()).includes('Locatra'),
      await driver.getTitle()
    );
    const perms = await inPanel(`return await browser.permissions.getAll();`);
    check(
      'http and https host access is granted',
      perms?.origins?.includes('http://*/*') && perms.origins.includes('https://*/*'),
      perms
    );
    const state = await send({ type: 'GET_RECORDING_STATE' });
    check('the background page answers the panel', state && state.active === false, state);

    // The demo page in a window of its own: switching to the panel tab must not
    // change which tab is active in the window the commands are aimed at. Firefox
    // opens Locatra's sidebar in that new window, so the window has a real panel.
    await driver.switchTo().newWindow('window');
    const demoHandle = await driver.getWindowHandle();
    await driver.get(`${server.base}/checkout`);
    const windowId = await inPanel(
      `const wins = await browser.windows.getAll({ populate: true });
       const w = wins.find((x) => x.tabs.some((t) => t.active && (t.url || '').startsWith(arguments[0])));
       return w ? w.id : null;`,
      server.base
    );
    check('the demo window is found', typeof windowId === 'number', windowId);
    const inDemo = async (fn) => {
      await driver.switchTo().window(demoHandle);
      return fn();
    };

    section('inspect');
    const inspect = await send({ type: 'START_INSPECT', windowId });
    check('START_INSPECT on the demo page → ok', inspect && inspect.ok === true, inspect);
    const uiCount = await inDemo(() =>
      until(() => driver.executeScript(`return document.querySelectorAll('[data-locatra-ui]').length;`))
    );
    check('the content script is in the page (its own UI is attached)', uiCount > 0, uiCount);
    const stop = await send({ type: 'STOP_INSPECT', windowId });
    check('STOP_INSPECT → ok', stop && stop.ok !== false, stop);

    section('record');
    const rec = await send({ type: 'START_RECORDING', windowId });
    check('START_RECORDING → ok', rec && rec.ok === true, rec);
    await pause(500);
    await inDemo(async () => {
      const type = async (css, text) => {
        const el = await driver.findElement(By.css(css));
        await el.click();
        await el.sendKeys(text);
        await pause(900); // the recorder debounces typing
      };
      await type('#first-name', 'Ada');
      await type('#last-name', 'Lovelace');
      await driver.findElement(By.css('#create-account')).click();
      await pause(500);
      await type('#password', PASSWORD_RECORDED);
      // Keyboard on the closed <select>: a trusted change, as a user makes it.
      const country = await driver.findElement(By.css('#country'));
      await country.sendKeys(Key.ARROW_DOWN);
      await pause(700);
      await driver.findElement(By.css('#gift-wrap')).click();
      await pause(700);
    });
    await send({ type: 'STOP_RECORDING', windowId });

    // The demo window's sidebar takes the steps and saves its timeline; without a
    // sidebar they would wait in storage.session instead. Either is accepted.
    const key = `llRecorderState:${windowId}`;
    const recorded = await until(async () => {
      const all = await inPanel(
        `const [l, s] = await Promise.all([browser.storage.local.get(arguments[0]), browser.storage.session.get('llRecordBuffer')]);
         return { timeline: l[arguments[0]] && l[arguments[0]].actions, buffer: s.llRecordBuffer && s.llRecordBuffer[arguments[1]] };`,
        key,
        windowId
      );
      const list = (all?.timeline?.length ? all.timeline : all?.buffer) || [];
      const done = list.some((x) => x.action === 'check' && /gift/i.test(JSON.stringify(x.target)));
      return done ? { list, where: all.timeline?.length ? 'sidebar' : 'buffer' } : null;
    });
    const steps = recorded ? recorded.list : [];
    check(
      `the steps reach the demo window's sidebar timeline, or wait for it in storage.session`,
      recorded && (recorded.where === 'sidebar' || recorded.where === 'buffer'),
      recorded ? recorded.where : 'nothing recorded'
    );
    if (recorded)
      console.log(
        `      (recorded into the ${recorded.where === 'sidebar' ? `sidebar, ${key}` : 'worker buffer'})`
      );
    const byAction = (a) => steps.filter((s) => s.action === a);
    check(
      'fills were recorded with their values',
      byAction('fill').some((s) => s.value === 'Ada') && byAction('fill').some((s) => s.value === 'Lovelace'),
      byAction('fill').map((s) => s.value)
    );
    const pw = byAction('fill').find((s) => s.sensitive);
    check(
      'the password fill is sensitive, empty and named',
      pw && pw.value === '' && pw.secretName === 'LOCATRA_PASSWORD',
      pw
    );
    check(
      'the select change was recorded',
      byAction('selectOption').some((s) => s.value === 'Ireland'),
      byAction('selectOption')
    );
    check('both checkboxes were recorded', byAction('check').length >= 2, byAction('check').length);
    const stored = await inPanel(
      `const [s, l] = await Promise.all([browser.storage.session.get(null), browser.storage.local.get(null)]);
       return JSON.stringify(s) + JSON.stringify(l);`
    );
    check('the password is nowhere in extension storage', !String(stored).includes(PASSWORD_RECORDED));

    section('export');
    const script = await inPanel(
      `return typeof LLCodegen === 'undefined' ? null : LLCodegen.testScript(arguments[0], 'playwright', 'typescript');`,
      steps
    );
    check(
      'the steps export to a Playwright test',
      typeof script === 'string' && script.includes("fill('Ada')") && script.includes('selectOption'),
      script && script.slice(0, 400)
    );
    check(
      'the export reads the password from LOCATRA_PASSWORD and does not contain it',
      typeof script === 'string' &&
        script.includes('process.env.LOCATRA_PASSWORD') &&
        !script.includes(PASSWORD_RECORDED)
    );

    section('replay');
    await inDemo(() => driver.navigate().refresh());
    await pause(800);
    const replaySteps = steps.filter((s) => ['fill', 'check', 'selectOption'].includes(s.action));
    // Progress and the result go to the demo window's sidebar over its port, so the
    // run is judged by the page it filled and by the worker letting go of it.
    const started = await send({
      type: 'REPLAY_START',
      windowId,
      steps: replaySteps,
      secrets: { LOCATRA_PASSWORD: PASSWORD_REPLAYED },
      options: { stopOnFailure: true },
    });
    check('REPLAY_START → ok', started && started.ok === true, started);
    const readPage = () =>
      inDemo(() =>
        driver.executeScript(`return {
          first: document.getElementById('first-name').value,
          last: document.getElementById('last-name').value,
          password: document.getElementById('password').value,
          country: document.getElementById('country').value,
          gift: document.getElementById('gift-wrap').checked };`)
      );
    const page =
      (await until(
        async () => {
          const p = await readPage();
          return p.gift ? p : null;
        },
        { timeout: 30000, interval: 500 }
      )) || (await readPage());
    const finished = await until(async () => {
      const st = await inPanel(`return (await browser.storage.session.get('llWorkerState')).llWorkerState;`);
      return st && Array.isArray(st.replays) && st.replays.length === 0;
    });
    check('the worker finished the run', finished === true);
    check('the replay re-filled the page', page.first === 'Ada' && page.last === 'Lovelace', page);
    check('the replay secret reached the password field', page.password === PASSWORD_REPLAYED);
    check(
      'the replay chose the country and ticked gift wrap',
      page.country === 'Ireland' && page.gift === true,
      page
    );
    const afterReplay = await inPanel(
      `const [s, l] = await Promise.all([browser.storage.session.get(null), browser.storage.local.get(null)]);
       return JSON.stringify(s) + JSON.stringify(l);`
    );
    check(
      'the replay secret is not kept in extension storage',
      !String(afterReplay).includes(PASSWORD_REPLAYED)
    );

    section('health check');
    const health = await send({
      type: 'HEALTH_CHECK',
      windowId,
      items: [
        { id: 'first', target: { kind: 'label', value: 'First name' } },
        { id: 'gone', target: { kind: 'testid', attr: 'data-testid', value: 'no-such-thing' } },
        {
          id: 'card',
          target: {
            kind: 'frame',
            selector: '#payment-frame',
            index: 0,
            child: { kind: 'label', value: 'Card number' },
          },
        },
      ],
    });
    const status = (id) => health?.results?.find((r) => r.id === id)?.status;
    check('HEALTH_CHECK → ok', health && health.ok === true, health);
    check('a live locator is ok', status('first') === 'ok', health?.results);
    check('a missing one is broken', status('gone') === 'broken', health?.results);
    check('a locator inside the payment iframe is ok', status('card') === 'ok', health?.results);

    section('restricted page');
    await inDemo(() => driver.get('about:robots'));
    await pause(500);
    const refused = await send({ type: 'START_INSPECT', windowId });
    check(
      'START_INSPECT on about:robots → refused with the restricted-page message',
      refused && refused.ok === false && RESTRICTED_RE.test(refused.error || ''),
      refused
    );
  } finally {
    await driver.quit().catch(() => {});
    await server.close();
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed ? '✗' : '✓'} ${results.length - failed}/${results.length} checks passed`);
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
