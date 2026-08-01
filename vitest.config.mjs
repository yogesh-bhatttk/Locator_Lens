import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    // Default to node; *.dom.test.mjs files opt into jsdom with a
    // `// @vitest-environment jsdom` docblock, which keeps the fast suite fast.
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      reporter: ['text', 'lcov'],
    },
  },
});
