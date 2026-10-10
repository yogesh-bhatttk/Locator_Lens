// @vitest-environment jsdom
//
// A frame without a selector (cross-origin) is exported by its `index`: its position
// among the page's <iframe> elements, shadow roots included, in the order the engine
// counts them (deepQueryAll). Selenium is never handed that number — ChromeDriver
// resolves switchTo().frame(n) as (/html/body//iframe | /html/frameset//frame)[n+1] and
// geckodriver as window.frames[n] — so every Selenium-family target runs a script that
// returns the frame element, and Cypress a helper doing the same walk. Both run here
// against a page where the three disagree: an <object> (a window.frames entry, no
// <iframe>), an <iframe> inside shadow DOM and one inserted after load.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let E;
let C;
beforeAll(async () => {
  vm.runInThisContext(readFileSync(join(ROOT, 'src/content-locator-engine.js'), 'utf8'), {
    filename: 'src/content-locator-engine.js',
  });
  E = globalThis.__LocatorLensEngine;
  await import('../src/codegen.js');
  await import('../src/codegen-java.js');
  await import('../src/codegen-csharp.js');
  await import('../src/codegen-wdio.js');
  C = globalThis.LLCodegen;
});

function renderPage() {
  document.body.innerHTML =
    '<object data="about:blank" id="obj"></object><iframe id="a"></iframe>' +
    '<x-host id="host"></x-host><div><iframe id="b"></iframe></div>';
  const root = document.getElementById('host').attachShadow({ mode: 'open' });
  root.innerHTML = '<iframe id="s1"></iframe><x-inner id="inner"></x-inner>';
  root.getElementById('inner').attachShadow({ mode: 'open' }).innerHTML = '<iframe id="s2"></iframe>';
  // Inserted after load, before everything else.
  const late = document.createElement('iframe');
  late.id = 'late';
  document.body.insertBefore(late, document.body.firstChild);
}

/** The script a generated Selenium JS statement passes to executeScript, decoded. */
function seleniumScript(index) {
  const target = { kind: 'frame', selector: null, index, child: { kind: 'id', value: 'x' } };
  const code = C.actionStatement({ action: 'click', target }, 'selenium', 'javascript');
  const m =
    /^await driver\.switchTo\(\)\.frame\(await driver\.executeScript\('((?:[^'\\]|\\.)*)', (\d+)\)\);/.exec(
      code
    );
  expect(m, code).toBeTruthy();
  expect(Number(m[2])).toBe(index);
  return new Function(`return '${m[1]}';`)();
}

/** Runs a WebDriver script the way executeScript does: a function body with arguments. */
function execute(script, ...args) {
  return new Function(script)(...args);
}

describe('a selector-less frame is found by the engine’s index', () => {
  it('the engine counts the document’s own <iframe>s, then each shadow root’s, depth first', () => {
    renderPage();
    expect(E.deepQueryAll('iframe').map((f) => f.id)).toEqual(['late', 'a', 'b', 's1', 's2']);
  });

  it('the generated Selenium script returns the same element for every index', () => {
    renderPage();
    const frames = E.deepQueryAll('iframe');
    for (let i = 0; i < frames.length; i++) {
      expect(execute(seleniumScript(i), i), `index ${i}`).toBe(frames[i]);
    }
    expect(() => execute(seleniumScript(5), 5)).toThrow('Locatra: no iframe at index 5');
  });

  it('every Selenium language and WebdriverIO run that one script', () => {
    const I = C._internals;
    const target = { kind: 'frame', selector: null, index: 3, child: { kind: 'id', value: 'x' } };
    const click = (fw, lang) => C.actionStatement({ action: 'click', target }, fw, lang).split('\n')[0];
    expect(click('selenium', 'python')).toBe(
      `driver.switch_to.frame(driver.execute_script(${C.q(I.DEEP_IFRAME_JS, 'python')}, 3))`
    );
    expect(click('selenium', 'java')).toContain(`executeScript(${JSON.stringify(I.DEEP_IFRAME_JS)}, 3)`);
    expect(click('selenium', 'csharp')).toContain(`ExecuteScript(${JSON.stringify(I.DEEP_IFRAME_JS)}, 3)`);
    expect(click('webdriverio', 'javascript')).toBe(
      `await browser.switchFrame($(await browser.execute(${C.q(I.DEEP_IFRAME_JS, 'javascript')}, 3)));`
    );
  });

  it('the Cypress helper finds the same element, from the document or a frame’s body', () => {
    renderPage();
    const Cypress = { $: (el) => [el] };
    const locatraFrame = new Function(
      'Cypress',
      `${C._internals.cyFrameSource('javascript')}\nreturn locatraFrame;`
    )(Cypress);
    const frames = E.deepQueryAll('iframe');
    for (let i = 0; i < frames.length; i++) expect(locatraFrame(document, i)[0]).toBe(frames[i]);
    expect(() => locatraFrame(document, 9)).toThrow('Locatra: no iframe at index 9');
    const nested = {
      kind: 'frame',
      selector: null,
      index: 1,
      child: { kind: 'frame', selector: null, index: 0, child: { kind: 'id', value: 'x' } },
    };
    expect(C.locatorExpr(nested, 'cypress', 'typescript')).toBe(
      "cy.document().then((doc) => locatraFrame(doc, 1)).its('0.contentDocument.body').should('not.be.empty')" +
        '.then(cy.wrap).then((body) => locatraFrame((body as JQuery<HTMLElement>)[0].ownerDocument, 0))' +
        ".its('0.contentDocument.body').should('not.be.empty').then(cy.wrap).find('#x')"
    );
    const spec = C.testScript([{ action: 'click', target: nested }], 'cypress', 'typescript');
    expect(
      spec.match(/function locatraFrame\(doc: Document, index: number\): JQuery<HTMLIFrameElement> \{/g)
    ).toHaveLength(1);
  });

  it('never uses framesIndex, and leaves frames with a selector alone', () => {
    const I = C._internals;
    expect(I.seleniumFrameIndex({ index: 2, framesIndex: 5 })).toBe(2);
    const withSelector = {
      kind: 'frame',
      selector: '#pay',
      index: 1,
      framesIndex: 4,
      child: { kind: 'id', value: 'x' },
    };
    expect(
      C.actionStatement({ action: 'click', target: withSelector }, 'selenium', 'javascript').split('\n')[0]
    ).toBe("await driver.switchTo().frame(driver.findElement(By.css('#pay')));");
  });
});

// The Cypress helpers (locatraFrame, locatraRole, locatraMatch) and the chains that call
// them, type-checked against the real Cypress typings when they are installed.
const TSC = join(ROOT, 'node_modules/typescript/bin/tsc');
const CYPRESS_TYPES = join(ROOT, 'node_modules/cypress/types/index.d.ts');
describe.skipIf(!existsSync(TSC) || !existsSync(CYPRESS_TYPES))('Cypress TypeScript output', () => {
  it('type-checks with tsc --strict against the Cypress typings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'locatra-cy-tsc-'));
    try {
      const nested = {
        kind: 'frame',
        selector: null,
        index: 1,
        child: {
          kind: 'frame',
          selector: null,
          index: 0,
          child: { kind: 'role', role: 'button', name: 'Pay' },
        },
      };
      const steps = [
        { action: 'goto', value: 'https://x.example/' },
        { action: 'click', target: { kind: 'role', role: 'button', name: 'Go' } },
        { action: 'click', target: { kind: 'role', role: 'heading', level: 7 } },
        { action: 'click', target: nested },
        { action: 'fill', target: { kind: 'label', value: 'Email' }, value: 'a' },
      ];
      writeFileSync(join(dir, 'spec.cy.ts'), C.testScript(steps, 'cypress', 'typescript'));
      writeFileSync(
        join(dir, 'page.ts'),
        C.pageObject({ elements: [{ name: 'go', kind: 'button', target: nested }] }, 'cypress', 'typescript')
      );
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'es2020',
            lib: ['es2020', 'dom'],
            types: ['cypress'],
            typeRoots: [join(ROOT, 'node_modules')],
            skipLibCheck: true,
            module: 'commonjs',
            moduleResolution: 'node',
          },
          files: ['spec.cy.ts', 'page.ts'],
        })
      );
      try {
        execFileSync(process.execPath, [TSC, '-p', dir], { stdio: 'pipe', encoding: 'utf8' });
      } catch (err) {
        throw new Error(`tsc failed:\n${err.stdout}${err.stderr}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
