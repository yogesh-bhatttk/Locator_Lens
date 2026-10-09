// Shared plumbing that makes coverage of the extension's classic scripts accurate.
//
// Every file in src/ is a classic (non-module) script. The suites run them two ways:
// through node:vm (background.js, content.js, sidepanel.js, popup.js, and the engine
// in most DOM suites) and through `await import('../src/codegen.js')`. V8 coverage
// for both lands under the same file URL, but the two runs execute different code:
//
//   * vm runs the file byte-for-byte, so its V8 offsets index the raw source;
//   * an import runs Vite's transformed copy (oxc/SSR rewrites add characters).
//
// The stock v8 provider remaps every entry onto Vite's transformed code with its
// source map, so raw offsets from a vm run land on the wrong characters — executed
// statements and implicit `else` branches showed as uncovered — and an import plus a
// vm run of the same file were merged as if they were one script.
//
// The fix has three parts, all keyed off this module:
//   1. vm-coverage.mjs (setup file) tags every vm compile of a src/ file with
//      `<file URL>?locatra-vm`, so its V8 entry is recognisable;
//   2. classicScriptsPlugin() (vitest.config.mjs) replaces an `import` of a src/ file
//      with a stub that runs the same raw file through vm, so *every* execution is a
//      raw-offset vm run (same semantics as before: the scripts publish globals);
//   3. coverage-provider.mjs keeps only the tagged entries for src/ files and hands
//      the provider the file as it is on disk, with no transform and no source map.

import { readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

/** Query suffix on the filename of a vm-compiled classic script. */
export const VM_MARKER = '?locatra-vm';

/** Environment variable carrying the classic-script directory into test workers. */
export const CLASSIC_DIR_ENV = 'LOCATRA_CLASSIC_SRC';

/** The repository's own src/ directory (the default classic-script directory). */
export const DEFAULT_CLASSIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

export function classicDir() {
  return resolve(process.env[CLASSIC_DIR_ENV] || DEFAULT_CLASSIC_DIR);
}

/** True for a .js file directly inside `dir` (query strings ignored). */
export function isClassicScript(file, dir = classicDir()) {
  const path = String(file).split('?')[0];
  return extname(path) === '.js' && dirname(resolve(path)) === resolve(dir);
}

/** The filename a vm compile of `absPath` is given. */
export function vmFilename(absPath) {
  return pathToFileURL(absPath).href + VM_MARKER;
}

/** Run a classic script the way the vm-based suites do, under its tagged filename. */
export function runClassicScript(absPath) {
  return vm.runInThisContext(readFileSync(absPath, 'utf8'), { filename: vmFilename(absPath) });
}

/**
 * Vite plugin: an `import` of a classic script loads a stub that runs the real file
 * through vm instead. The scripts have no exports — they publish onto the global
 * object — so importers see exactly what they saw before.
 */
export function classicScriptsPlugin(dir = DEFAULT_CLASSIC_DIR) {
  const helper = fileURLToPath(import.meta.url);
  return {
    name: 'locatra-classic-scripts',
    enforce: 'pre',
    load(id) {
      if (!isClassicScript(id, dir)) return null;
      const file = id.split('?')[0];
      return (
        `import { runClassicScript } from ${JSON.stringify(helper)};\n` +
        `runClassicScript(${JSON.stringify(file)});\n`
      );
    },
  };
}
