// The main-process half of coverage-provider.mjs.
//
// Two overrides on the stock V8CoverageProvider, both limited to classic scripts
// (src/*.js):
//
//   convertCoverage — keeps only the V8 entries tagged with VM_MARKER (raw-file
//     runs) and drops the untagged ones (the import stub, whose few lines of code
//     are not the file). The tag is stripped so the report is keyed by the real
//     path, and startOffset is reset: it is a Vite module-wrapper length that
//     takeCoverage() looked up by path, and a vm run has no wrapper.
//   getSources — returns the file exactly as it is on disk, with no source map, so
//     ast-v8-to-istanbul reads raw V8 offsets against the raw text they index.
//
// Everything else (merging, thresholds, reporters, uncovered files, ignore hints)
// is the stock provider's.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { V8CoverageProvider } from '@vitest/coverage-v8/dist/provider.js';

import { CLASSIC_DIR_ENV, DEFAULT_CLASSIC_DIR, VM_MARKER, isClassicScript } from './classic-scripts.mjs';

function stripMarker(url) {
  return url.endsWith(VM_MARKER) ? url.slice(0, -VM_MARKER.length) : url;
}

function pathOf(url) {
  try {
    return fileURLToPath(stripMarker(url));
  } catch {
    return null;
  }
}

export class ClassicAwareV8Provider extends V8CoverageProvider {
  get classicDir() {
    return this.ctx?.config?.env?.[CLASSIC_DIR_ENV] || DEFAULT_CLASSIC_DIR;
  }

  isClassic(url) {
    const path = pathOf(url);
    return path != null && isClassicScript(path, this.classicDir);
  }

  /** Pure filter, exported for the accuracy test: tagged raw runs only, untagged. */
  selectClassicEntries(result) {
    const out = [];
    for (const entry of result) {
      if (!this.isClassic(entry.url)) {
        out.push(entry);
      } else if (entry.url.endsWith(VM_MARKER)) {
        out.push({ ...entry, url: stripMarker(entry.url), startOffset: 0 });
      }
      // else: the import stub's own code, under the same path — not the file.
    }
    return out;
  }

  async convertCoverage(coverage, project, environment) {
    const filtered = { ...coverage, result: this.selectClassicEntries(coverage.result ?? []) };
    return super.convertCoverage(filtered, project, environment);
  }

  async getSources(url, onTransform, functions = []) {
    if (this.isClassic(url)) {
      const code = await readFile(pathOf(url), 'utf8').catch(() => null);
      if (code != null) return { code };
    }
    return super.getSources(url, onTransform, functions);
  }
}

export function createClassicAwareProvider() {
  return new ClassicAwareV8Provider();
}
