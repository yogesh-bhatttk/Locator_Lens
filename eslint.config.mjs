// ESLint 9 flat config. A one-to-one port of the former .eslintrc.json +
// .eslintignore (ESLint 8): same rules, same per-directory environments, same
// ignores. Differences from the eslintrc defaults are spelled out where flat config
// would otherwise change behaviour silently.

import js from '@eslint/js';
import globals from 'globals';

export default [
  // Was .eslintignore. ESLint 8 also skipped dot-directories by default; flat config
  // does not, so they are listed. coverage/ and the throwaway browser profiles are
  // generated output (and gitignored).
  {
    ignores: [
      'node_modules/',
      'dist/',
      'icons/',
      // Anchored to the repo root on purpose: an unanchored `screenshots/` would also
      // match scripts/screenshots/, which holds the capture script and must be linted.
      'screenshots/',
      'coverage/',
      '.tmp-smoke-profile/',
      '.tmp-smoke-pom-profile/',
      '.tmp-smoke-settings-profile/',
      '.tmp-smoke-data-health-profile/',
      '.tmp-smoke-shots-*/',
      '.tmp-screenshot-profile/',
      '**/.*/',
    ],
  },

  js.configs.recommended,

  {
    // ESLint 8 did not report unused eslint-disable comments; 9 warns by default,
    // which --max-warnings 0 would turn into a failure. Kept off to match.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: {
      ecmaVersion: 2022,
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'off',
      'prefer-const': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // The eslintrc root env (browser + webextensions, classic scripts). Flat config
  // treats .js as ES modules unless told otherwise; the extension sources are not.
  {
    files: ['**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },

  {
    files: ['src/*.js'],
    languageOptions: {
      globals: { LLCodegen: 'readonly', module: 'readonly' },
    },
  },

  // Node tooling: node globals only — no browser/webextension globals.
  {
    files: ['scripts/**/*.mjs', '*.config.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: { 'no-console': 'off' },
  },

  // Bodies passed to page.evaluate / worker.evaluate run in the browser.
  {
    files: ['scripts/screenshots/*.mjs', 'scripts/smoke.mjs'],
    languageOptions: {
      globals: { chrome: 'readonly', document: 'readonly' },
    },
    rules: { 'no-eval': 'off' },
  },

  {
    files: ['tests/**/*.test.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.webextensions,
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        vi: 'readonly',
        esc: 'readonly',
        hl: 'readonly',
        safeRender: 'readonly',
        formatLocator: 'readonly',
        strategyLabel: 'readonly',
        buildActionCode: 'readonly',
        renderResults: 'readonly',
        recordedActions: 'writable',
        lastSyncedPreviewScript: 'writable',
        updateCodePreview: 'readonly',
        generateTestScript: 'readonly',
        getPreviewText: 'readonly',
        setPreviewCode: 'readonly',
        recRedoStack: 'writable',
        seenActionKeys: 'writable',
        recFilter: 'writable',
        renderTimeline: 'readonly',
      },
    },
    rules: { 'no-console': 'off' },
  },
];
