import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    // Default to node; *.dom.test.mjs files opt into jsdom with a
    // `// @vitest-environment jsdom` docblock, which keeps the fast suite fast.
    environment: 'node',
    coverage: {
      provider: 'v8',
      // Only the two files a coverage provider can actually see.
      //
      // background.js, content.js, sidepanel.js and popup.js are classic scripts — an
      // IIFE or top-level `let`s — so they cannot be imported as modules. Their suites
      // run the real shipping file through node:vm instead, which v8 coverage does not
      // instrument: all four reported a flat 0% while being among the most heavily
      // tested files here, which made the headline number worse than useless. They are
      // covered by tests/background.test.mjs, tests/content-script.dom.test.mjs,
      // tests/sidepanel-render.dom.test.mjs and tests/popup.dom.test.mjs, plus the
      // browser smoke test.
      include: ['src/codegen.js', 'src/content-locator-engine.js'],
      reporter: ['text', 'lcov'],
      // Enforced so the part that IS measurable cannot quietly rot. Raise these when
      // the numbers rise; do not lower them to make a change pass.
      thresholds: {
        statements: 88,
        branches: 78,
        functions: 95,
        lines: 90,
      },
    },
  },
});
