// Proof that coverage of the extension's classic scripts is measured correctly.
//
// A throwaway Vitest project (in the OS temp dir, node_modules symlinked) runs the
// same workload against two classic scripts — a fixture with known HIT/MISS lines,
// and the real src/codegen.js — in five configurations:
//
//   truth        stock @vitest/coverage-v8, the script `import`ed through Vite.
//                Vite's source map is exact for code Vite itself transformed, so
//                this is the reference measurement.
//   stock-vm     stock provider, the script run through node:vm (the old setup).
//   fixed-vm     tests/support/coverage-provider.mjs + the classic-scripts plugin,
//                run through vm — what the vm-based suites do.
//   fixed-import the fixed setup, `import`ed (the plugin turns it into a vm run).
//   fixed-both   the fixed setup, imported AND vm-run in the same project.
//
// The fixed configurations must agree with the truth on every statement, branch
// and function, and with each other; the HIT/MISS markers must hold.

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const SUPPORT = pathToFileURL(HERE).href;
const SUBJECTS = ['branchy.js', 'codegen.js'];

let dir;
const results = {};

const WORKLOAD = `
export function workload(g) {
  const B = g.LLBranchy;
  B.classify(-5);
  B.classify(5);
  B.pick('a');
  B.pick('z');
  B.guard(null);
  B.guard({ name: 'bob' });
  const C = g.LLCodegen;
  const steps = [
    { action: 'goto', value: 'https://example.com/' },
    { action: 'fill', target: { kind: 'label', value: 'Email' }, value: 'a@b.c' },
    { action: 'fill', target: { kind: 'label', value: 'Password' }, sensitive: true, value: '' },
    { action: 'click', target: { kind: 'role', role: 'button', name: 'Sign in' } },
    { action: 'press', value: 'Enter' },
    { action: 'check', target: { kind: 'testid', attr: 'data-testid', value: 'terms' } },
    { action: 'assert', assertType: 'toHaveText', target: { kind: 'text', value: 'Welcome' }, value: 'Welcome' },
  ];
  for (const fw of ['playwright', 'selenium', 'cypress'])
    for (const lang of ['typescript', 'javascript', 'python'])
      if (C.isValidCombo(fw, lang)) C.testScript(steps, fw, lang);
}
`;

// Vite's module runner hands an imported file a CommonJS \`module\`; a vm run sees the
// global one. Defining it keeps codegen.js's \`module.exports = …\` line executing in
// every mode, so the comparison is of measurement, not of two different runs.
const VM_SPEC = `
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';
import { workload } from './workload.mjs';
it('runs the classic scripts through vm', () => {
  globalThis.module = { exports: {} };
  for (const f of ${JSON.stringify(SUBJECTS)})
    vm.runInThisContext(readFileSync(new URL('./src/' + f, import.meta.url), 'utf8'), { filename: 'src/' + f });
  workload(globalThis);
  expect(globalThis.LLBranchy.count()).toBe(2);
});
`;

const IMPORT_SPEC = `
import { expect, it } from 'vitest';
import { workload } from './workload.mjs';
it('imports the classic scripts', async () => {
  globalThis.module = { exports: {} };
  for (const f of ${JSON.stringify(SUBJECTS)}) await import('./src/' + f);
  workload(globalThis);
  expect(globalThis.LLBranchy.count()).toBe(2);
});
`;

function config({ fixed, specs }) {
  const support = (f) => JSON.stringify(`${SUPPORT}/${f}`);
  return `
import { defineConfig } from 'vitest/config';
${fixed ? `import { classicScriptsPlugin } from ${support('classic-scripts.mjs')};` : ''}
const SRC = new URL('./src', import.meta.url).pathname;
export default defineConfig({
  ${fixed ? 'plugins: [classicScriptsPlugin(SRC)],' : ''}
  test: {
    include: ${JSON.stringify(specs)},
    env: { LOCATRA_CLASSIC_SRC: SRC },
    ${fixed ? `setupFiles: [${support('vm-coverage.mjs')}],` : `setupFiles: ['./old-vm-coverage.mjs'],`}
    coverage: {
      enabled: true,
      ${fixed ? `provider: 'custom', customProviderModule: ${support('coverage-provider.mjs')},` : "provider: 'v8',"}
      include: ['src/*.js'],
      reporter: ['json'],
    },
  },
});
`;
}

// The pre-fix setup file: real file URL, no marker — reproduces the old behaviour.
const OLD_SETUP = `
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
const SRC = process.env.LOCATRA_CLASSIC_SRC;
const bySource = new Map();
for (const n of readdirSync(SRC)) bySource.set(readFileSync(join(SRC, n), 'utf8'), pathToFileURL(join(SRC, n)).href);
const run = vm.runInThisContext;
vm.runInThisContext = (code, o) => run(code, bySource.has(code) ? { ...(o || {}), filename: bySource.get(code) } : o);
`;

const MODES = {
  truth: { fixed: false, specs: ['import.spec.mjs'] },
  'stock-vm': { fixed: false, specs: ['vm.spec.mjs'] },
  'fixed-vm': { fixed: true, specs: ['vm.spec.mjs'] },
  'fixed-import': { fixed: true, specs: ['import.spec.mjs'] },
  'fixed-both': { fixed: true, specs: ['vm.spec.mjs', 'import.spec.mjs'] },
};

function run(mode) {
  const cfg = join(dir, `vitest.${mode}.config.mjs`);
  writeFileSync(cfg, config(MODES[mode]));
  const out = join(dir, `cov-${mode}`);
  execFileSync(
    process.execPath,
    [
      join(ROOT, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--root',
      dir,
      '--config',
      cfg,
      '--coverage.reportsDirectory',
      out,
    ],
    { cwd: dir, stdio: 'pipe', env: { ...process.env, CI: '1' } }
  );
  const json = JSON.parse(readFileSync(join(out, 'coverage-final.json'), 'utf8'));
  const byName = {};
  for (const [file, data] of Object.entries(json)) byName[file.split('/').pop()] = data;
  return byName;
}

const key = (loc) => `${loc.start.line}:${loc.start.column}-${loc.end.line}:${loc.end.column}`;

/** Location → covered?, for statements, functions and every branch arm. */
function hitMaps(fc) {
  const s = {};
  for (const [id, loc] of Object.entries(fc.statementMap)) s[key(loc)] = fc.s[id] > 0;
  const f = {};
  for (const [id, fn] of Object.entries(fc.fnMap)) f[`${fn.name}@${key(fn.loc)}`] = fc.f[id] > 0;
  const b = {};
  for (const [id, br] of Object.entries(fc.branchMap)) {
    br.locations.forEach((loc, i) => {
      b[`${br.type}@${key(br.loc)}#${i}`] = fc.b[id][i] > 0;
    });
  }
  return { s, f, b };
}

/** Covered/total per metric, the way the text reporter computes them. */
function totals(fc) {
  const count = (vals) => ({ covered: vals.filter((v) => v > 0).length, total: vals.length });
  return {
    statements: count(Object.values(fc.s)),
    functions: count(Object.values(fc.f)),
    branches: count(Object.values(fc.b).flat()),
  };
}

/** Lines of the fixture carrying a HIT / MISS marker. */
function markedLines(tag) {
  const src = readFileSync(join(HERE, 'fixtures/coverage-accuracy/branchy.js'), 'utf8').split('\n');
  return src.flatMap((l, i) => (l.includes(`// ${tag}`) ? [i + 1] : []));
}

function lineHit(fc, line) {
  const ids = Object.entries(fc.statementMap)
    .filter(([, loc]) => loc.start.line === line)
    .map(([id]) => id);
  expect(ids.length, `a statement on line ${line}`).toBeGreaterThan(0);
  return ids.every((id) => fc.s[id] > 0);
}

describe('coverage of classic scripts is accurate', () => {
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'locatra-cov-')));
    mkdirSync(join(dir, 'src'));
    copyFileSync(join(HERE, 'fixtures/coverage-accuracy/branchy.js'), join(dir, 'src/branchy.js'));
    copyFileSync(join(ROOT, 'src/codegen.js'), join(dir, 'src/codegen.js'));
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
    writeFileSync(join(dir, 'workload.mjs'), WORKLOAD);
    writeFileSync(join(dir, 'vm.spec.mjs'), VM_SPEC);
    writeFileSync(join(dir, 'import.spec.mjs'), IMPORT_SPEC);
    writeFileSync(join(dir, 'old-vm-coverage.mjs'), OLD_SETUP);
    for (const mode of Object.keys(MODES)) results[mode] = run(mode);
  }, 120_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  for (const subject of SUBJECTS) {
    describe(subject, () => {
      for (const mode of ['fixed-vm', 'fixed-import', 'fixed-both']) {
        it(`${mode} matches the source-mapped import measurement exactly`, () => {
          const truth = hitMaps(results.truth[subject]);
          const got = hitMaps(results[mode][subject]);
          expect(got.s).toEqual(truth.s);
          expect(got.f).toEqual(truth.f);
          expect(got.b).toEqual(truth.b);
          expect(totals(results[mode][subject])).toEqual(totals(results.truth[subject]));
        });
      }

      it('a vm run and an import of the same file are not double counted', () => {
        // Both specs ran the workload once each, so every counter is exactly twice
        // the single-run counter — not a merge of two different scripts' ranges.
        const one = results['fixed-vm'][subject];
        const both = results['fixed-both'][subject];
        for (const id of Object.keys(one.s)) expect(both.s[id]).toBe(one.s[id] * 2);
      });
    });
  }

  it('the old setup mis-measured the vm-run fixture (the bug this fixes)', () => {
    const truth = totals(results.truth['codegen.js']);
    const old = totals(results['stock-vm']['codegen.js']);
    expect(old).not.toEqual(truth);
  });

  it('deliberately executed lines and branches count as covered; the rest do not', () => {
    for (const mode of ['truth', 'fixed-vm', 'fixed-import', 'fixed-both']) {
      const fc = results[mode]['branchy.js'];
      for (const line of markedLines('HIT'))
        expect(lineHit(fc, line), `${mode}: line ${line} HIT`).toBe(true);
      for (const line of markedLines('MISS'))
        expect(lineHit(fc, line), `${mode}: line ${line} MISS`).toBe(false);
      // classify(): `if (n < 0)` took both arms; `if (label === 'big')` only its
      // implicit else — the arm reported missing must be the consequent, not the else.
      const ifs = Object.entries(fc.branchMap).filter(([, br]) => br.type === 'if');
      const bigIf = ifs.find(([, br]) => br.loc.start.line === markedLines('MISS')[1] - 1);
      expect(bigIf, 'the `label === big` if').toBeTruthy();
      expect(fc.b[bigIf[0]]).toEqual([0, expect.any(Number)]);
      expect(fc.b[bigIf[0]][1]).toBeGreaterThan(0);
      const neverCalled = Object.entries(fc.fnMap).find(([, fn]) => fn.name === 'neverCalled');
      expect(fc.f[neverCalled[0]]).toBe(0);
    }
  });
});
