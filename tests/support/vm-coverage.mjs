// Vitest setup file: make the classic-script suites visible to V8 coverage.
//
// background.js, content.js, sidepanel.js and popup.js are classic scripts, so the
// suites run the real shipping file through node:vm rather than importing it. V8
// still records coverage for code compiled that way, but under whatever `filename`
// the suite passed — 'sidepanel.js', 'src/background.js' — which the coverage
// provider cannot map back to a file on disk, so those files used to report 0%.
//
// This rewrites the filename to the file's absolute file:// URL whenever the code
// being compiled is byte-identical to a file in src/. Nothing else changes: same
// code, same context, and any other vm call passes through untouched.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

const bySource = new Map();
for (const name of readdirSync(SRC)) {
  if (!name.endsWith('.js')) continue;
  const abs = join(SRC, name);
  bySource.set(readFileSync(abs, 'utf8'), pathToFileURL(abs).href);
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
