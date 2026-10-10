// Selenium for TypeScript, type-checked with `tsc --strict` against the real
// @types/selenium-webdriver: the scripts (CommonJS require, as generated), the page
// objects (ES imports, WebElementPromise as a value once the Locatra helper is in),
// and the C9.4 corpus — the locatraFind helper, LOCATRA_FRAME_JS and
// LOCATRA_SET_VALUE_JS, chains rooted at a parent element, deep shadow DOM, XPath.
// Skipped, with the reason, where the typings are not installed: they are looked for
// in node_modules, in LOCATRA_SELENIUM_TYPES (a node_modules directory holding
// @types/selenium-webdriver and @types/node) and in TypeScript's own type cache.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import * as CORPUS from './codegen-corpus.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSC = join(ROOT, 'node_modules/typescript/bin/tsc');

/** A node_modules directory with both @types/selenium-webdriver and @types/node, or null. */
function seleniumTypes() {
  const candidates = [join(ROOT, 'node_modules')];
  if (process.env.LOCATRA_SELENIUM_TYPES) candidates.unshift(process.env.LOCATRA_SELENIUM_TYPES);
  const cache = join(homedir(), '.cache/typescript');
  if (existsSync(cache)) {
    for (const v of readdirSync(cache).sort().reverse()) candidates.push(join(cache, v, 'node_modules'));
  }
  return (
    candidates.find(
      (d) => existsSync(join(d, '@types/selenium-webdriver/index.d.ts')) && existsSync(join(d, '@types/node'))
    ) || null
  );
}
const TYPES = existsSync(TSC) ? seleniumTypes() : null;

let C;
beforeAll(async () => {
  await import('../src/codegen.js');
  C = globalThis.LLCodegen;
});

describe.skipIf(!TYPES)('Selenium TypeScript output', () => {
  it('type-checks with tsc --strict against @types/selenium-webdriver', () => {
    const dir = mkdtempSync(join(tmpdir(), 'locatra-sel-tsc-'));
    try {
      const model = { ...CORPUS.MODEL, className: 'Corpus' };
      const files = {
        // Each script is a module of its own (the generated file is one script).
        'script.ts': `export {};\n${C.testScript(CORPUS.STEPS, 'selenium', 'typescript')}`,
        'script-vars.ts': `export {};\n${C.testScript(CORPUS.STEPS, 'selenium', 'typescript', { variables: true })}`,
        'CorpusPage.ts': C.pageObject(model, 'selenium', 'typescript'),
        'uses-po.ts': [
          "import { Builder } from 'selenium-webdriver';",
          "import { CorpusPage } from './CorpusPage';",
          'export async function run(): Promise<void> {',
          "  const driver = await new Builder().forBrowser('chrome').build();",
          '  const page = new CorpusPage(driver);',
          '  await (await page.element0()).click();',
          '}',
          '',
        ].join('\n'),
      };
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'es2022',
            lib: ['es2022', 'dom'],
            module: 'commonjs',
            moduleResolution: 'node',
            types: ['node', 'selenium-webdriver'],
            typeRoots: [join(TYPES, '@types')],
            baseUrl: '.',
            paths: { 'selenium-webdriver': [join(TYPES, '@types/selenium-webdriver')] },
            skipLibCheck: true,
          },
          files: Object.keys(files),
        })
      );
      let output = '';
      try {
        execFileSync(process.execPath, [TSC, '-p', dir], { stdio: 'pipe', encoding: 'utf8' });
      } catch (err) {
        output = String(err.stdout) + String(err.stderr);
      }
      expect(output).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
