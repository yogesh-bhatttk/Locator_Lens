import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    // Default to node; *.dom.test.mjs files opt into jsdom with a
    // `// @vitest-environment jsdom` docblock, which keeps the fast suite fast.
    environment: 'node',
    setupFiles: ['tests/support/vm-coverage.mjs'],
    coverage: {
      provider: 'v8',
      // Every shipping script. background.js, content.js, sidepanel.js and popup.js
      // are classic scripts that the suites run through node:vm rather than import;
      // tests/support/vm-coverage.mjs gives that code its real file URL so V8
      // coverage attributes it to src/ instead of reporting a flat 0%.
      include: ['src/*.js'],
      reporter: ['text', 'lcov'],
      // Enforced so coverage cannot quietly rot. Set just below the numbers measured
      // when every file became measurable (statements 72 / branches 58 / functions 78
      // / lines 76 across src/, with several suites mid-rewrite) — ratchet them up as
      // the numbers rise; never lower them to make a change pass.
      thresholds: {
        statements: 83,
        branches: 71,
        functions: 87,
        lines: 86,
      },
    },
  },
});
