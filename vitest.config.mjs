import { defineConfig } from 'vitest/config';

import {
  CLASSIC_DIR_ENV,
  DEFAULT_CLASSIC_DIR,
  classicScriptsPlugin,
} from './tests/support/classic-scripts.mjs';

export default defineConfig({
  // src/*.js are classic scripts. An `import` of one runs the raw file through vm
  // (as the vm-based suites do), so every execution is measured against the file
  // on disk — see tests/support/classic-scripts.mjs.
  plugins: [classicScriptsPlugin(DEFAULT_CLASSIC_DIR)],
  test: {
    include: ['tests/**/*.test.mjs'],
    // Default to node; *.dom.test.mjs files opt into jsdom with a
    // `// @vitest-environment jsdom` docblock, which keeps the fast suite fast.
    environment: 'node',
    // Shared CI runners under coverage instrumentation run jsdom-heavy tests about
    // four times slower than a dev machine; 5 s (vitest's default) failed a 1.3 s
    // test there. Tests that genuinely need longer (compilers) still set their own.
    testTimeout: 20_000,
    env: { [CLASSIC_DIR_ENV]: DEFAULT_CLASSIC_DIR },
    setupFiles: ['tests/support/vm-coverage.mjs'],
    coverage: {
      // @vitest/coverage-v8 with two fixes for classic scripts (raw-file offsets,
      // no Vite transform, no double counting of import + vm runs). Without them
      // ~20 executed statements and ~90 implicit-else branches per file read as
      // uncovered. tests/support/coverage-accuracy.test.mjs proves the numbers.
      provider: 'custom',
      customProviderModule: 'tests/support/coverage-provider.mjs',
      // Every shipping script.
      include: ['src/*.js'],
      reporter: ['text', 'lcov', 'json-summary'],
      // Enforced so coverage cannot quietly rot: global, and per file so one
      // well-tested file cannot hide another's decline. Set just below the numbers
      // measured once coverage was accurate — ratchet them up as the numbers
      // rise; never lower them to make a change pass.
      thresholds: {
        // Measured with the accurate provider on the feature branch (replay, page
        // objects, suggestions, screenshots): 95.43 / 88.36 / 98.64 / 98.32.
        statements: 94,
        branches: 87,
        functions: 97,
        lines: 97,
        // Per file, as statements / branches / functions / lines. (Release 1.4.0,
        // measured the same way, read 83.33 / 72.19 / 87.27 / 87.93 for background.js.)
        // 96.98–97.06 / 91.20–91.30 / 99.51 / 98.35
        'src/background.js': { statements: 96, branches: 90, functions: 98, lines: 97 },
        // 99.20 / 94.48 / 100 / 99.38
        'src/codegen.js': { statements: 98, branches: 93, functions: 99, lines: 98 },
        // 98.98 / 96.50 / 99.51 / 99.69
        'src/content-locator-engine.js': { statements: 98, branches: 95, functions: 98, lines: 99 },
        // 92.67 / 86.11 / 98.45 / 97.85
        'src/content.js': { statements: 91, branches: 85, functions: 97, lines: 96 },
        // 99.34 / 92.79 / 96.29 / 99.27
        'src/popup.js': { statements: 98, branches: 91, functions: 95, lines: 98 },
        // 93.97 / 80.46 / 97.46 / 97.62
        'src/sidepanel.js': { statements: 92, branches: 79, functions: 96, lines: 96 },
        // 98.40 / 91.54 / 97.61 / 97.91
        'src/thumbs-store.js': { statements: 97, branches: 90, functions: 96, lines: 96 },
        // 99.25 / 95.58 / 100 / 99.87
        'src/options.js': { statements: 98, branches: 94, functions: 99, lines: 99 },
        // 99.31 / 96.58 / 100 / 99.42
        'src/codegen-java.js': { statements: 98, branches: 95, functions: 99, lines: 98 },
        // 100 / 99.06 / 100 / 100
        'src/codegen-csharp.js': { statements: 99, branches: 98, functions: 99, lines: 99 },
        // 98.43 / 95.63 / 100 / 100
        'src/codegen-wdio.js': { statements: 97, branches: 94, functions: 99, lines: 99 },
      },
    },
  },
});
