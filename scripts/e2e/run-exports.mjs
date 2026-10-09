#!/usr/bin/env node
// Run the exported tests for real — every framework × language the export menu
// offers — against the demo checkout, and prove each one did its job.
//
// The unit suites check that generated code parses and looks right; this checks
// that it WORKS: a Playwright, Selenium or Cypress run of the exported file, in its
// own real runner, against a live page, has to place the order the flow describes.
// The demo page reports each placed order to the local server (see
// scripts/e2e/demo-server.mjs), and a run passes only if it exited cleanly AND the
// server received exactly one order with the expected values — including the
// password, which the script reads from LOCATRA_PASSWORD and never contains.
//
// Two flows:
//   canonical  tests/e2e/fixtures/checkout-flow.json — steps in the exact shape the
//              side panel stores, covering fill (incl. a sensitive password),
//              select, check/uncheck, click, hover, viewport, Tab/Shift+Tab/Enter,
//              an iframe, and toBeVisible/toHaveText/toContainText/toBeChecked/
//              toHaveValue/toHaveURL assertions.
//   recorded   the same checkout recorded through the built extension (dist/chrome)
//              in a real browser, read back from the panel's storage — so the whole
//              chain recorder → storage → codegen → framework is exercised.
//
//   npm run test:exports                       # everything available here
//   npm run test:exports -- --only playwright-typescript,selenium-python
//   npm run test:exports -- --flow canonical
//   npm run test:exports -- --flow canonical --fixture my-state.json   # a stored state
//   npm run test:exports -- --require all      # CI: a skipped runner is a failure
//
// Runners that are not installed are SKIPPED with the reason and how to fix it
// (Python packages: `npm run test:exports:setup-python`; Cypress:
// `npm run test:exports:setup-cypress`). Generated files are kept in .tmp-exports/.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { resolveChromium } from './browsers.mjs';
import { startDemoServer } from './demo-server.mjs';
import { hasDisplay, recordCheckoutFlow } from './record-flow.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const E2E = join(ROOT, 'tests/e2e');
const WORK = join(ROOT, '.tmp-exports');
const PYLIB_CACHE = join(ROOT, 'node_modules/.cache/locatra-e2e/pylib');
const require = createRequire(import.meta.url);

export const COMBOS = [
  'playwright-typescript',
  'playwright-javascript',
  'playwright-python',
  'selenium-typescript',
  'selenium-javascript',
  'selenium-python',
  'cypress-typescript',
  'cypress-javascript',
];

const EXT = { typescript: 'ts', javascript: 'js', python: 'py' };

// ── arguments ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    only: COMBOS,
    flows: ['canonical', 'recorded'],
    require: [],
    port: 4175,
    fixture: join(E2E, 'fixtures/checkout-flow.json'),
  };
  const list = (v) =>
    v === 'all'
      ? COMBOS
      : v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=');
    const takesValue = ['--only', '--require', '--flow', '--port', '--fixture'].includes(flag);
    const value = takesValue ? (inline ?? argv[++i] ?? '') : '';
    if (flag === '--only') opts.only = list(value);
    else if (flag === '--require') opts.require = list(value);
    else if (flag === '--flow') opts.flows = value === 'all' ? ['canonical', 'recorded'] : value.split(',');
    else if (flag === '--port') opts.port = Number(value);
    else if (flag === '--fixture') opts.fixture = resolve(value);
    else if (flag === '--help' || flag === '-h') opts.help = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  for (const id of [...opts.only, ...opts.require]) {
    if (!COMBOS.includes(id))
      throw new Error(`unknown runner "${id}" — expected one of ${COMBOS.join(', ')}`);
  }
  if (process.env.LOCATRA_EXPORTS_REQUIRE) opts.require = list(process.env.LOCATRA_EXPORTS_REQUIRE);
  return opts;
}

// ── codegen and the flows ─────────────────────────────────────────────────────────

/** A fresh copy of the shipping codegen, loaded the way the extension loads it. */
function loadCodegen() {
  const sandbox = {};
  vm.runInNewContext(readFileSync(join(ROOT, 'src/codegen.js'), 'utf8'), sandbox, {
    filename: join(ROOT, 'src/codegen.js'),
  });
  if (!sandbox.LLCodegen) throw new Error('src/codegen.js did not define LLCodegen');
  return sandbox.LLCodegen;
}

const substitute = (value, vars) =>
  JSON.parse(JSON.stringify(value).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m)));

/**
 * Steps ready for codegen: what the panel would export. Suggested steps that were
 * never accepted are left out (the panel excludes them too); a step kind this
 * codegen cannot express yet (e.g. toHaveURL before it existed) is dropped with a
 * note rather than failing every runner on a TODO line.
 */
function exportableSteps(actions, C, notes) {
  const out = [];
  for (const step of actions) {
    if (step.suggested) {
      notes.push(`left out an unaccepted suggestion: ${step.assertType} (${step.reason ?? 'no reason'})`);
      continue;
    }
    const probe = C.actionStatement(step, 'playwright', 'typescript');
    if (/^\s*\/\/ TODO/.test(probe)) {
      notes.push(
        `codegen cannot express step ${step.sequence ?? '?'} (${step.action}/${step.assertType}): ${probe.trim()}`
      );
      continue;
    }
    out.push(step);
  }
  return out;
}

function summarizeSteps(steps) {
  const counts = {};
  for (const s of steps) {
    const kind = s.action === 'assert' ? `assert:${s.assertType}` : s.action;
    const framed = s.target && s.target.kind === 'frame' ? ' (iframe)' : '';
    const key = kind + framed + (s.sensitive ? ' (sensitive)' : '');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([k, n]) => (n > 1 ? `${k}×${n}` : k))
    .join(', ');
}

// ── process helpers ─────────────────────────────────────────────────────────────

function run(cmd, args, { cwd, env, timeout = 180_000, unset = [] }) {
  return new Promise((done) => {
    const started = Date.now();
    const fullEnv = { ...process.env, ...env };
    for (const key of unset) delete fullEnv[key];
    const child = spawn(cmd, args, {
      cwd,
      env: fullEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const timer = setTimeout(() => {
      output += `\n[killed after ${timeout / 1000}s]`;
      child.kill('SIGKILL');
    }, timeout);
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ code: -1, output: output + String(err), ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, output, ms: Date.now() - started });
    });
  });
}

const ok = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { stdio: 'ignore', timeout: 120_000, ...opts }).status === 0;

function python() {
  return process.env.LOCATRA_PYTHON || 'python3';
}

/** PYTHONPATH for the Python runners: an explicit one, then the local cache. */
function pythonPath(extra = []) {
  const parts = [...extra];
  if (process.env.LOCATRA_E2E_PYTHONPATH) parts.push(process.env.LOCATRA_E2E_PYTHONPATH);
  if (existsSync(PYLIB_CACHE)) parts.push(PYLIB_CACHE);
  if (process.env.PYTHONPATH) parts.push(process.env.PYTHONPATH);
  return parts.join(delimiter);
}

function pythonHas(modules) {
  return ok(python(), ['-c', modules.map((m) => `import ${m}`).join('; ')], {
    env: { ...process.env, PYTHONPATH: pythonPath() },
  });
}

// Set by editors built on Electron (VS Code and its terminals, Claude Code): it makes
// the Cypress binary — itself Electron — start as plain Node and reject every flag.
const ELECTRON_ENV = ['ELECTRON_RUN_AS_NODE'];
const withoutElectronEnv = () => {
  const env = { ...process.env };
  for (const key of ELECTRON_ENV) delete env[key];
  return env;
};

/** The Cypress CLI entry (its package exports do not expose bin/ to require). */
const cypressBin = () =>
  join(dirname(require.resolve('cypress/package.json', { paths: [ROOT] })), 'bin/cypress');

let cypressStatus;
function cypressAvailable() {
  if (cypressStatus) return cypressStatus;
  try {
    require.resolve('cypress/package.json', { paths: [ROOT] });
  } catch {
    return (cypressStatus = {
      ok: false,
      reason:
        'cypress is not installed (it is not a devDependency: the binary is large) — run `npm run test:exports:setup-cypress`',
    });
  }
  try {
    require.resolve('cypress-real-events', { paths: [ROOT] });
  } catch {
    return (cypressStatus = {
      ok: false,
      reason: 'cypress-real-events is not installed — run `npm run test:exports:setup-cypress`',
    });
  }
  const verify = spawnSync(process.execPath, [cypressBin(), 'verify'], {
    encoding: 'utf8',
    timeout: 180_000,
    env: withoutElectronEnv(),
  });
  if (verify.status !== 0) {
    const why = (verify.stdout + verify.stderr).trim().split('\n').slice(-3).join(' ');
    return (cypressStatus = { ok: false, reason: `\`cypress verify\` failed: ${why}` });
  }
  return (cypressStatus = { ok: true });
}

// ── runners ─────────────────────────────────────────────────────────────────────
//
// Each takes the generated script text and returns { skip } or { result }. The
// script is written and run exactly as exported; only the browser launch is
// pointed at the shared Chromium (playwright.config, a pytest conftest, a Node
// preload, a Python sitecustomize) — see tests/e2e/support/.

function playwrightNode(lang) {
  return async ({ dir, script, env }) => {
    const file = `recorded.spec.${EXT[lang]}`;
    writeFileSync(join(dir, file), script);
    writeFileSync(
      join(dir, 'playwright.config.mjs'),
      `// Generated by scripts/e2e/run-exports.mjs.
export default {
  testDir: '.',
  testMatch: ${JSON.stringify(file)},
  testIgnore: [],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    headless: process.env.LOCATRA_E2E_HEADED !== '1',
    launchOptions: { executablePath: process.env.LOCATRA_CHROMIUM || undefined },
  },
};
`
    );
    const cli = require.resolve('@playwright/test/cli', { paths: [ROOT] });
    return {
      result: await run(process.execPath, [cli, 'test', '--config', 'playwright.config.mjs'], {
        cwd: dir,
        env,
      }),
    };
  };
}

async function playwrightPython({ dir, script, env }) {
  if (!pythonHas(['pytest', 'pytest_playwright', 'playwright.sync_api'])) {
    return {
      skip: 'pytest / pytest-playwright / playwright (Python) are not importable — run `npm run test:exports:setup-python` or `pip install -r tests/e2e/requirements.txt`',
    };
  }
  writeFileSync(join(dir, 'test_recorded.py'), script);
  copyFileSync(join(E2E, 'support/playwright-python/conftest.py'), join(dir, 'conftest.py'));
  const args = ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', 'test_recorded.py', '--browser', 'chromium'];
  return { result: await run(python(), args, { cwd: dir, env: { ...env, PYTHONPATH: pythonPath() } }) };
}

function seleniumNode(lang) {
  return async ({ dir, script, env }) => {
    const file = `recorded.${EXT[lang]}`;
    writeFileSync(join(dir, file), script);
    // The export is a CommonJS script (require()); this tree is an ES-module package.
    writeFileSync(join(dir, 'package.json'), '{ "type": "commonjs" }\n');
    const preload = join(E2E, 'support/selenium-preload.cjs');
    const args = ['--require', preload, file];
    return {
      result: await run(process.execPath, args, { cwd: dir, env: { ...env, NODE_NO_WARNINGS: '1' } }),
    };
  };
}

async function seleniumPython({ dir, script, env }) {
  if (!pythonHas(['selenium'])) {
    return {
      skip: 'selenium (Python) is not importable — run `npm run test:exports:setup-python` or `pip install -r tests/e2e/requirements.txt`',
    };
  }
  writeFileSync(join(dir, 'recorded.py'), script);
  const pp = pythonPath([join(E2E, 'support/selenium-python')]);
  return { result: await run(python(), ['recorded.py'], { cwd: dir, env: { ...env, PYTHONPATH: pp } }) };
}

function cypress(lang) {
  return async ({ dir, script, env }) => {
    const status = cypressAvailable();
    if (!status.ok) return { skip: status.reason };
    mkdirSync(join(dir, 'specs'), { recursive: true });
    const spec = `specs/recorded.cy.${EXT[lang]}`;
    writeFileSync(join(dir, spec), script);
    writeFileSync(join(dir, 'package.json'), '{ "type": "commonjs" }\n');
    writeFileSync(
      join(dir, 'cypress.config.js'),
      `// Generated by scripts/e2e/run-exports.mjs.
module.exports = {
  video: false,
  screenshotOnRunFailure: false,
  defaultCommandTimeout: 10000,
  e2e: { specPattern: ${JSON.stringify(spec)}, supportFile: false },
};
`
    );
    if (lang === 'typescript') {
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify(
          {
            compilerOptions: { target: 'es2020', lib: ['es2020', 'dom'], types: ['cypress'], allowJs: true },
          },
          null,
          2
        )
      );
    }
    const bin = cypressBin();
    const args = [
      bin,
      'run',
      '--project',
      dir,
      '--spec',
      spec,
      '--browser',
      process.env.LOCATRA_CYPRESS_BROWSER || 'electron',
    ];
    // The spec's locatraSecret('LOCATRA_PASSWORD') helper reads it through cy.env() (or
    // Cypress.env() on older Cypress); both see only CYPRESS_-prefixed variables.
    const cyEnv = { ...env, CYPRESS_LOCATRA_PASSWORD: env.LOCATRA_PASSWORD, NO_COLOR: '1' };
    return {
      result: await run(process.execPath, args, {
        cwd: dir,
        env: cyEnv,
        timeout: 300_000,
        unset: ELECTRON_ENV,
      }),
    };
  };
}

const RUNNERS = {
  'playwright-typescript': playwrightNode('typescript'),
  'playwright-javascript': playwrightNode('javascript'),
  'playwright-python': playwrightPython,
  'selenium-typescript': seleniumNode('typescript'),
  'selenium-javascript': seleniumNode('javascript'),
  'selenium-python': seleniumPython,
  'cypress-typescript': cypress('typescript'),
  'cypress-javascript': cypress('javascript'),
};

// ── verification ────────────────────────────────────────────────────────────────

function compareOrder(received, expected) {
  if (received.length !== 1) {
    return [`expected exactly one order to reach the demo server, got ${received.length}`];
  }
  const problems = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = received[0][key];
    if (got !== want)
      problems.push(`order.${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
  return problems;
}

function tail(output, lines = 25) {
  return output.trim().split('\n').slice(-lines).join('\n');
}

// ── main ────────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      readFileSync(fileURLToPath(import.meta.url), 'utf8')
        .split('\n')
        .slice(1, 33)
        .join('\n')
    );
    return 0;
  }

  const chromium = resolveChromium();
  if (!chromium)
    throw new Error('No Chromium found — run `npx playwright install chromium` (or set LOCATRA_CHROMIUM).');
  const password = process.env.LOCATRA_PASSWORD || 'Locatra-e2e-S3cret!';
  const env = { LOCATRA_CHROMIUM: chromium, LOCATRA_PASSWORD: password };

  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const server = await startDemoServer({ port: opts.port });
  const vars = { BASE: server.base, LOCATRA_PASSWORD: password };
  const expectation = substitute(
    JSON.parse(readFileSync(join(E2E, 'fixtures/checkout-flow.expect.json'), 'utf8')),
    vars
  );
  const C = loadCodegen();

  console.log(`Chromium   ${chromium}`);
  console.log(`demo page  ${server.base}/checkout`);
  console.log(`runners    ${opts.only.join(', ')}`);

  const rows = [];
  try {
    for (const flow of opts.flows) {
      const notes = [];
      let actions;
      console.log(`\n━━ flow: ${flow} ━━`);
      if (flow === 'canonical') {
        actions = substitute(JSON.parse(readFileSync(opts.fixture, 'utf8')), vars).actions;
      } else if (flow === 'recorded') {
        const extensionDir = join(ROOT, 'dist/chrome');
        if (!existsSync(join(extensionDir, 'manifest.json'))) {
          const why = 'dist/chrome is missing — run `npm run build` first';
          for (const id of opts.only) rows.push({ flow, id, status: 'SKIP', detail: why });
          console.log(`  skipped: ${why}`);
          continue;
        }
        const before = server.orders().length;
        try {
          const rec = await recordCheckoutFlow({
            extensionDir,
            chromium,
            base: server.base,
            password,
            profileDir: join(WORK, 'recording-profile'),
            headed: process.env.LOCATRA_E2E_HEADLESS === '1' ? false : hasDisplay(),
            log: (s) => console.log(s),
          });
          notes.push(...rec.notes);
          actions = rec.state.actions;
          writeFileSync(join(WORK, 'recorded-flow.json'), JSON.stringify(rec.state, null, 2) + '\n');
          // The recording itself placed an order: it must be the expected one too,
          // or the recorder was driven wrong and every runner below would mislead.
          const own = compareOrder(server.orders().slice(before), expectation.order);
          if (own.length) notes.push(`the recording session's own order differed: ${own.join('; ')}`);
        } catch (err) {
          for (const id of opts.only)
            rows.push({ flow, id, status: 'FAIL', detail: `recording failed: ${err.message}` });
          console.log(`  ✗ recording through the extension failed: ${err.message}`);
          continue;
        }
      } else {
        throw new Error(`unknown flow "${flow}"`);
      }

      const steps = exportableSteps(actions, C, notes);
      console.log(`  ${steps.length} steps: ${summarizeSteps(steps)}`);
      for (const n of notes) console.log(`  note: ${n}`);

      for (const id of opts.only) {
        const [fw, lang] = id.split('-');
        const dir = join(WORK, flow, id);
        mkdirSync(dir, { recursive: true });
        const script = C.testScript(steps, fw, lang);
        if (script.includes(password)) {
          rows.push({ flow, id, status: 'FAIL', detail: 'the exported script contains the password' });
          continue;
        }
        const before = server.orders().length;
        const outcome = await RUNNERS[id]({ dir, script, env });
        if (outcome.skip) {
          rows.push({ flow, id, status: 'SKIP', detail: outcome.skip });
          console.log(`  - ${id}: skipped — ${outcome.skip}`);
          continue;
        }
        const { result } = outcome;
        writeFileSync(join(dir, 'output.log'), result.output);
        const problems = [];
        if (result.code !== 0) problems.push(`exited with ${result.code}`);
        problems.push(...compareOrder(server.orders().slice(before), expectation.order));
        const status = problems.length ? 'FAIL' : 'PASS';
        const secs = (result.ms / 1000).toFixed(1);
        rows.push({ flow, id, status, detail: problems.join('; '), secs });
        console.log(
          `  ${status === 'PASS' ? '✓' : '✗'} ${id} (${secs}s)${problems.length ? ` — ${problems.join('; ')}` : ''}`
        );
        if (problems.length) {
          console.log(`    ${relative(ROOT, dir)}/output.log:`);
          console.log(
            tail(result.output)
              .split('\n')
              .map((l) => `      ${l}`)
              .join('\n')
          );
        }
      }
    }
  } finally {
    await server.close();
  }

  console.log('\n━━ summary ━━');
  for (const r of rows) {
    console.log(
      `  ${r.status.padEnd(4)}  ${r.flow.padEnd(9)}  ${r.id.padEnd(22)}  ${r.status === 'PASS' ? `${r.secs}s` : r.detail}`
    );
  }
  const failed = rows.filter((r) => r.status === 'FAIL');
  const missing = rows.filter((r) => r.status === 'SKIP' && opts.require.includes(r.id));
  const passed = rows.filter((r) => r.status === 'PASS').length;
  console.log(
    `\n${failed.length || missing.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed, ` +
      `${rows.length - passed - failed.length} skipped` +
      (missing.length
        ? ` (${missing.length} skipped runner(s) were required: ${[...new Set(missing.map((r) => r.id))].join(', ')})`
        : '')
  );
  console.log(`generated scripts and logs: ${relative(ROOT, WORK)}/`);
  return failed.length || missing.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`\n✗ ${err.stack || err.message}\n`);
    process.exit(1);
  }
);
