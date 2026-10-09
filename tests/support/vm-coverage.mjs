// Vitest setup file: make the classic-script suites visible — and accurately
// measured — by V8 coverage.
//
// background.js, content.js, sidepanel.js and popup.js are classic scripts, so the
// suites run the real shipping file through node:vm rather than importing it. V8
// still records coverage for code compiled that way, but under whatever `filename`
// the suite passed — 'sidepanel.js', 'src/background.js' — which the coverage
// provider cannot map back to a file on disk, so those files used to report 0%.
//
// This rewrites the filename to the file's absolute file:// URL plus a marker
// (see classic-scripts.mjs) whenever the code being compiled is byte-identical to a
// file in src/. The marker tells tests/support/coverage-provider.mjs that the
// offsets index the raw file, not Vite's transformed copy. Nothing else changes:
// same code, same context, and any other vm call passes through untouched.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

import { classicDir, vmFilename } from './classic-scripts.mjs';

const SRC = classicDir();

const bySource = new Map();
for (const name of readdirSync(SRC)) {
  if (!name.endsWith('.js')) continue;
  const abs = join(SRC, name);
  bySource.set(readFileSync(abs, 'utf8'), vmFilename(abs));
}

function withRealFilename(code, options) {
  const url = typeof code === 'string' ? bySource.get(code) : undefined;
  if (!url) return options;
  if (typeof options === 'string') return { filename: url };
  return { ...(options ?? {}), filename: url };
}

const PATCHED = Symbol.for('locatra.vmCoveragePatched');
if (!vm[PATCHED]) {
  vm[PATCHED] = true;
  const { runInThisContext, runInContext, runInNewContext, Script } = vm;
  vm.runInThisContext = (code, options) => runInThisContext(code, withRealFilename(code, options));
  vm.runInContext = (code, ctx, options) => runInContext(code, ctx, withRealFilename(code, options));
  vm.runInNewContext = (code, ctx, options) => runInNewContext(code, ctx, withRealFilename(code, options));
  vm.Script = class extends Script {
    constructor(code, options) {
      super(code, withRealFilename(code, options));
    }
  };
}
