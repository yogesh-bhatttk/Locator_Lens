// src/codegen-wdio.js: the WebdriverIO v9 target (TypeScript + JavaScript) that plugs
// into codegen.js through LLCodegen.registerTarget. Exact-output assertions for every
// target kind, action, assertion, frame shape, escaping rule, the test-data variables
// and page objects; the generated code is also parsed (node --check, TS stripped),
// type-checked with `tsc --strict` against the real @wdio types when the toolchain is
// installed (node scripts/e2e/setup-webdriverio.mjs), and executed against recording
// stand-ins for browser / $ / expect. The real-browser runs live in
// scripts/e2e/runners/webdriverio.mjs (npm run test:exports).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as CORPUS from './codegen-corpus.mjs';
import { declaredString } from './codegen-helper-calls.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WDIO_MODULES = join(ROOT, 'node_modules/.cache/locatra-e2e/wdio/node_modules');
const HAS_WDIO_TYPES =
  existsSync(join(WDIO_MODULES, 'typescript/bin/tsc')) &&
  existsSync(join(WDIO_MODULES, '@wdio/globals/types.d.ts'));

let C;
let dir;
beforeAll(async () => {
  await import('../src/codegen.js');
  await import('../src/codegen-wdio.js');
  C = globalThis.LLCodegen;
  dir = mkdtempSync(join(tmpdir(), 'locatra-wdio-'));
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const FW = 'webdriverio';
const LANGS = ['typescript', 'javascript'];
const loc = (t, lang = 'typescript', rel) => C.locatorExpr(t, FW, lang, rel);
const stmt = (step, lang = 'typescript') => C.actionStatement(step, FW, lang);
// A selector-less frame: the index-th <iframe>, shadow roots included (codegen.js
// DEEP_IFRAME_JS, declared once per file as LOCATRA_FRAME_JS). execute() returns a
// bare element reference; $() turns it into the element switchFrame() takes.
const deepFrame = (i, lang = 'typescript') =>
  `$(await browser.execute${lang === 'typescript' ? '<HTMLIFrameElement, [number]>' : ''}(LOCATRA_FRAME_JS, ${i}))`;

/**
 * The Selenium JS locator for a target, rewritten to the WDIO form: $ / .$ for a
 * selector, `(await locatraFind(…))` — the same helper arguments, no driver — for a
 * role / label / text target.
 */
function fromSelenium(t, rel) {
  const sel = C.locatorExpr(t, 'selenium', 'javascript', rel);
  if (/^locatraFind\(driver, /.test(sel))
    return `(await ${sel.replace('locatraFind(driver, ', 'locatraFind(')})`;
  return sel
    .replace(/^driver\.findElement\(By\.(?:css|xpath)\(('(?:[^'\\]|\\.)*')\)\)/, '$$($1)')
    .replace(/\.findElement\(By\.(?:css|xpath)\(('(?:[^'\\]|\\.)*')\)\)/g, '.$$($1)');
}

/** A fresh codegen.js (+ optionally the WDIO module) in its own context. */
function freshContext({ withWdio = true, internals, capture } = {}) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(ROOT, 'src/codegen.js'), 'utf8'), sandbox);
  if (internals) internals(sandbox.LLCodegen._internals);
  if (capture) {
    const register = sandbox.LLCodegen.registerTarget;
    sandbox.LLCodegen.registerTarget = (def) => capture(register(def));
  }
  if (withWdio) vm.runInContext(readFileSync(join(ROOT, 'src/codegen-wdio.js'), 'utf8'), sandbox);
  return sandbox.LLCodegen;
}

const label = (value, o = {}) => ({ kind: 'label', value, ...o });
const role = (r, name, o = {}) => ({ kind: 'role', role: r, ...(name != null ? { name } : {}), ...o });
const testid = (value, attr = 'data-testid') => ({ kind: 'testid', attr, value });
const css = (value) => ({ kind: 'css', value });
const id = (value) => ({ kind: 'id', value });
const frame = (selector, child, o = {}) => ({ kind: 'frame', selector, index: 0, child, ...o });

// ════════════════════════════════════════════════════════════════════════════
describe('registration', () => {
  it('adds the WebdriverIO framework with TypeScript and JavaScript', () => {
    expect(C.FRAMEWORKS.map((f) => f.id)).toEqual(['playwright', 'selenium', 'cypress', 'webdriverio']);
    expect(C.FRAMEWORKS.find((f) => f.id === FW).label).toBe('WebdriverIO');
    expect(C.languagesFor(FW).map((l) => l.id)).toEqual(['typescript', 'javascript']);
    expect(C.isValidCombo(FW, 'typescript')).toBe(true);
    expect(C.isValidCombo(FW, 'javascript')).toBe(true);
    expect(C.isValidCombo(FW, 'python')).toBe(false);
    expect(C.LANGUAGES.map((l) => l.id).slice(0, 3)).toEqual(['typescript', 'javascript', 'python']);
    expect(C.fileExtension('typescript')).toBe('.ts');
    expect(C.fileExtension('javascript')).toBe('.js');
    expect(C.pageObjectFileName({ className: 'Login' }, FW, 'javascript')).toBe('LoginPage.js');
    expect(C.pageObjectFileName({ className: 'Login' }, FW, 'typescript')).toBe('LoginPage.ts');
  });

  it('leaves every built-in framework/language byte-identical', () => {
    const bare = freshContext({ withWdio: false });
    const flow = JSON.parse(
      readFileSync(join(ROOT, 'tests/e2e/fixtures/checkout-flow.json'), 'utf8')
    ).actions;
    for (const fw of ['playwright', 'selenium', 'cypress']) {
      for (const lang of ['typescript', 'javascript', 'python']) {
        if (!C.isValidCombo(fw, lang)) continue;
        expect(C.testScript(flow, fw, lang), `${fw}/${lang}`).toBe(bare.testScript(flow, fw, lang));
        expect(C.testScript(flow, fw, lang, { variables: true }), `${fw}/${lang} vars`).toBe(
          bare.testScript(flow, fw, lang, { variables: true })
        );
      }
    }
    expect(bare.FRAMEWORKS.map((f) => f.id)).not.toContain(FW);
  });

  it("writes the core's TODOs as single-line comments through its todo() hook", () => {
    let def;
    const C2 = freshContext({ capture: (d) => (def = d) });
    expect(typeof def.todo).toBe('function');
    expect(def.todo('unsupported step "x"', 'javascript')).toBe('// TODO: unsupported step "x"');
    expect(def.todo('a\nb\r\u2028c\u2029d\x00e */ f', 'typescript')).toBe('// TODO: a b  c d e */ f');
    // the core routes its own TODOs here
    expect(C2.actionStatement({ action: 'fly', target: id('a') }, FW, 'javascript')).toBe(
      '// TODO: unsupported step "fly"'
    );
    expect(C2.actionStatement({ action: 'fill', value: 'x' }, FW, 'javascript')).toBe(
      '// TODO: "fill" step has no element locator'
    );
    def.todo = (text) => `// TODO(wdio): ${text}`;
    expect(C2.actionStatement({ action: 'fly', target: id('a') }, FW, 'javascript')).toBe(
      '// TODO(wdio): unsupported step "fly"'
    );
    expect(C2.actionStatement({ action: 'click' }, FW, 'typescript')).toBe(
      '// TODO(wdio): "click" step has no element locator'
    );
  });

  it('does nothing when codegen.js is not loaded first', () => {
    const sandbox = {};
    vm.createContext(sandbox);
    expect(() =>
      vm.runInContext(readFileSync(join(ROOT, 'src/codegen-wdio.js'), 'utf8'), sandbox)
    ).not.toThrow();
    expect(sandbox.LLCodegen).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('locators', () => {
  it('renders every target kind exactly', () => {
    expect(loc(testid('place-order'))).toBe(`$('[data-testid="place-order"]')`);
    expect(loc(testid('v', 'data:qa'))).toBe(String.raw`$('[data\\:qa="v"]')`);
    // Role, label and text locators call the Locatra helper (C9.4), named or not.
    expect(loc(role('button'))).toBe("(await locatraFind('role', 'button', null, { nth: 0 }))");
    expect(loc(role('heading', null, { level: 2, matchCount: 1 }))).toBe(
      "(await locatraFind('role', 'heading', null, { level: 2 }))"
    );
    expect(loc(label('Email'))).toBe("(await locatraFind('label', 'Email'))");
    expect(loc({ kind: 'text', value: 'Hi', exact: true })).toBe(
      "(await locatraFind('text', 'Hi', null, { exact: true }))"
    );
    // An XPath alternative is $()'s own strategy; one $() would not read as XPath gets "xpath:".
    expect(loc({ kind: 'xpath', value: '//button[@id="go"]' })).toBe(`$('//button[@id="go"]')`);
    expect(loc({ kind: 'xpath', value: 'id("go")' })).toBe(`$('xpath:id("go")')`);
    expect(loc({ kind: 'placeholder', value: 'Search' })).toBe(`$('[placeholder*="Search"]')`);
    expect(loc({ kind: 'placeholder', value: 'Search', exact: true })).toBe(`$('[placeholder="Search"]')`);
    expect(loc({ kind: 'altText', value: 'Logo' })).toBe(`$('[alt*="Logo"]')`);
    expect(loc({ kind: 'title', value: 'Help', exact: true })).toBe(`$('[title="Help"]')`);
    expect(loc(id('email'))).toBe(`$('#email')`);
    expect(loc(id('2fa.code:x'))).toBe(String.raw`$('#\\32 fa\\.code\\:x')`);
    expect(loc({ kind: 'name', value: 'notes' })).toBe(`$('[name="notes"]')`);
    expect(loc({ kind: 'name', value: 'a"b' })).toBe(String.raw`$('[name="a\\"b"]')`);
    expect(loc(css('form > button.primary'))).toBe(`$('form > button.primary')`);
    expect(loc(css(''))).toBe(`$('body')`);
    expect(loc({ kind: 'mystery' })).toBe(`$('body')`);
    expect(loc(null)).toBe('');
  });

  it('uses exactly the Selenium JS CSS / XPath / helper arguments for every kind but id and name', () => {
    const targets = [
      testid('x'),
      testid('v', 'data-qa'),
      role('button'),
      role('button', 'Save'),
      role('button', 'Save', { exact: true }),
      role('heading', 'Title', { level: 3 }),
      role('row', null, { nth: 2 }),
      role('button', 'Delete "row"', { nth: 0 }),
      role('checkbox', 'It\'s "quoted"'),
      role('img', 'Logo'),
      role('textbox', 'Email'),
      label('Email'),
      label('Email', { exact: true }),
      { kind: 'placeholder', value: 'it\'s "x"' },
      { kind: 'altText', value: 'Logo', exact: true },
      { kind: 'title', value: 'Help' },
      { kind: 'text', value: 'Hello   world' },
      { kind: 'text', value: 'Hello', exact: true },
      css('table tr:nth-child(2)'),
      { kind: 'xpath', value: '//a[normalize-space(.)="Help"]' },
      { kind: 'chain', parent: css('form'), child: css('input') },
    ];
    for (const t of targets) {
      expect(loc(t), JSON.stringify(t)).toBe(fromSelenium(t));
      expect(loc(t, 'javascript'), JSON.stringify(t)).toBe(fromSelenium(t));
    }
  });

  it('renders role names, exact, nth and level as helper options', () => {
    expect(loc(role('button', 'Save', { exact: true }))).toBe(
      "(await locatraFind('role', 'button', 'Save', { exact: true }))"
    );
    expect(loc(role('button', null, { nth: 1 }))).toBe(
      "(await locatraFind('role', 'button', null, { nth: 1 }))"
    );
    expect(loc(role('heading', 'T', { level: 3, nth: 0 }))).toBe(
      "(await locatraFind('role', 'heading', 'T', { level: 3, nth: 0 }))"
    );
  });

  it('searches a chained child within its parent', () => {
    const t = { kind: 'chain', parent: css('tr.b'), child: { kind: 'text', value: 'Row B', exact: true } };
    expect(loc(t)).toBe("(await locatraFind('text', 'Row B', null, { exact: true, within: $('tr.b') }))");
    // A helper-found parent: a native child continues from it, a helper child searches within it.
    expect(loc({ kind: 'chain', parent: role('row', 'Ada'), child: css('a.edit') })).toBe(
      "(await locatraFind('role', 'row', 'Ada')).$('a.edit')"
    );
    expect(loc({ kind: 'chain', parent: role('row', 'Ada'), child: { kind: 'text', value: 'Edit' } })).toBe(
      "(await locatraFind('text', 'Edit', null, { within: (await locatraFind('role', 'row', 'Ada')) }))"
    );
    // …through a nested chain too.
    expect(
      loc({
        kind: 'chain',
        parent: css('table'),
        child: { kind: 'chain', parent: css('tr.b'), child: label('Qty') },
      })
    ).toBe("(await locatraFind('label', 'Qty', null, { within: $('table').$('tr.b') }))");
    // An XPath child is made relative with a leading dot.
    expect(loc({ kind: 'chain', parent: css('tr.b'), child: { kind: 'xpath', value: '//td[2]' } })).toBe(
      "$('tr.b').$('.//td[2]')"
    );
  });

  it('falls back sensibly for malformed chains and frames', () => {
    expect(loc({ kind: 'chain', parent: css('form') })).toBe(`$('form')`);
    expect(loc({ kind: 'chain', parent: null, child: css('input') })).toBe(`$('input')`);
    // A child that is not an element search (an empty frame) cannot be scoped.
    expect(
      loc({ kind: 'chain', parent: css('form'), child: { kind: 'frame', selector: '#f', index: 0 } })
    ).toBe(`$('form')`);
    expect(loc({ kind: 'chain', parent: css('form'), child: frame('#f', id('x')) })).toBe(
      `$('form').$('#x')`
    );
    expect(loc({ kind: 'frame', selector: '#f', index: 0, child: null })).toBe('');
    expect(loc(frame('#f', frame('#g', label('Card'))))).toBe(loc(label('Card')));
  });

  // webdriverio's $() picks a strategy from the selector text; CSS it would misread
  // is sent with the explicit "css selector:" strategy.
  it('marks CSS that WebdriverIO would read as another strategy', () => {
    const plain = [
      'button',
      '#id',
      '.class',
      'table',
      '[data-testid="x"]',
      '[placeholder*="+44 20"]',
      'input[type="button"]:not([role])',
      '[name="email"]',
      'a.png-icon',
      'img[src$="logo.png"]',
      '[role="checkbox"]',
      'svg',
      'div > span',
    ];
    for (const sel of plain) expect(loc(css(sel)), sel).toBe(`$('${sel.replace(/'/g, "\\'")}')`);
    const ambiguous = [
      'id:main', // explicit-strategy prefix
      'name:hover',
      'span.x.png', // image path
      'i.icon.SVG',
      'tag.jpeg',
      '*/x',
      '=Link text',
      '*=partial',
      'id=x',
      '>>>button',
      'aria/Name',
      'android=x',
      'ios=x',
      '~acc',
      'uiapp-header', // mobile class-name prefixes
      'CYI-x',
      'android.widget',
      '[title="<b>"]', // <tag>
      'p[title="<br />"]',
      'a=Click', // element-with-text
      'button*=Save',
      'div.cls=text',
      '[role=checkbox]',
    ];
    for (const sel of ambiguous) expect(loc(css(sel)), sel).toBe(`$('css selector:${sel}')`);
    expect(loc(css('.'))).toBe(`$('css selector:.')`);
    expect(loc(css('..'))).toBe(`$('css selector:..')`);
    expect(loc(css('.png'))).toBe(`$('.png')`);
    expect(loc({ kind: 'title', value: "it's <b>bold</b>", exact: true })).toBe(
      `$('css selector:[title="it\\'s <b>bold</b>"]')`
    );
    // XPath strings are never prefixed: they already start with "/", "(" or "./".
    expect(loc({ kind: 'xpath', value: '(//a)[2]' })).toBe(`$('(//a)[2]')`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('escaping', () => {
  it('escapes quotes, backslashes and every control character for JS', () => {
    const v = 'it\'s \\ "q"\n\t\r\0\x1b\x7f   ✓ Zoë';
    const expected = String.raw`'it\'s \\ "q"\n\t\r\x00\x1b\x7f` + '\\u2028\\u2029' + " ✓ Zoë'";
    for (const lang of LANGS) {
      expect(stmt({ action: 'fill', target: id('a'), value: v }, lang)).toBe(
        `await $('#a').setValue(${expected});`
      );
      expect(stmt({ action: 'goto', value: v }, lang)).toBe(`await browser.url(${expected});`);
    }
  });

  it('CSS-escapes control characters inside attribute selectors', () => {
    expect(loc({ kind: 'name', value: 'a\nb' })).toBe(String.raw`$('[name="a\\a b"]')`);
  });

  it('keeps hostile values inside comments on one line', () => {
    expect(stmt({ action: 'press', value: 'Hyper+x\n// injected' })).toBe(
      '// TODO: press "Hyper+x // injected" — no WebdriverIO key mapping'
    );
    expect(stmt({ action: 'warp\nzone', target: id('a') })).toBe('// TODO: unsupported step "warp zone"');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('actions', () => {
  const T = testid('t');
  const L = `$('[data-testid="t"]')`;
  const checked = `((await el.isSelected()) || (await el.getAttribute('aria-checked')) === 'true')`;

  it('renders click, dblclick, hover, check, uncheck, select', () => {
    for (const lang of LANGS) {
      expect(stmt({ action: 'click', target: T }, lang)).toBe(`await ${L}.click();`);
      expect(stmt({ action: 'dblclick', target: T }, lang)).toBe(`await ${L}.doubleClick();`);
      expect(stmt({ action: 'hover', target: T }, lang)).toBe(`await ${L}.moveTo();`);
      expect(stmt({ action: 'check', target: T }, lang)).toBe(
        `{\n  const el = await ${L};\n  if (!${checked}) await el.click();\n}`
      );
      expect(stmt({ action: 'uncheck', target: T }, lang)).toBe(
        `{\n  const el = await ${L};\n  if (${checked}) await el.click();\n}`
      );
      expect(stmt({ action: 'selectOption', target: T, value: "Côte d'Ivoire" }, lang)).toBe(
        `await ${L}.selectByVisibleText('Côte d\\'Ivoire');`
      );
    }
  });

  it('fills with setValue, clears for an empty value, and reads secrets from the environment', () => {
    expect(stmt({ action: 'fill', target: T, value: 'Ada' })).toBe(`await ${L}.setValue('Ada');`);
    expect(stmt({ action: 'fill', target: T, value: '' })).toBe(`await ${L}.clearValue();`);
    expect(stmt({ action: 'fill', target: T })).toBe(`await ${L}.clearValue();`);
    expect(stmt({ action: 'fill', target: T, value: '', sensitive: true })).toBe(
      `await ${L}.setValue(process.env.LOCATRA_PASSWORD ?? '');`
    );
    expect(stmt({ action: 'fill', target: T, value: 'leak', sensitive: true, secretName: 'MY_SECRET' })).toBe(
      `await ${L}.setValue(process.env.MY_SECRET ?? '');`
    );
    expect(
      stmt({ action: 'fill', target: T, value: 'leak', sensitive: true, secretName: 'bad-name; rm' })
    ).toBe(`await ${L}.setValue(process.env.LOCATRA_PASSWORD ?? '');`);
    expect(stmt({ action: 'fill', target: T, value: 'leak', sensitive: true })).not.toContain('leak');
  });

  it('sets dates, times, sliders and colours through the value setter', () => {
    // Declared once per file (LOCATRA_SET_VALUE_JS).
    const js = 'LOCATRA_SET_VALUE_JS';
    expect(
      C.testScript([{ action: 'fill', target: T, value: '42', inputType: 'date' }], FW, 'typescript')
    ).toContain('const LOCATRA_SET_VALUE_JS =\n');
    expect(
      declaredString(
        C.testScript([{ action: 'fill', target: T, value: '42', inputType: 'date' }], FW, 'typescript'),
        'LOCATRA_SET_VALUE_JS',
        'typescript'
      )
    ).toBe(C._internals.SET_VALUE_JS);
    for (const inputType of ['range', 'color', 'date', 'time', 'datetime-local', 'month', 'week']) {
      expect(stmt({ action: 'fill', target: T, value: '42', inputType })).toBe(
        `await browser.execute(${js}, await ${L}, '42');`
      );
    }
    expect(stmt({ action: 'fill', target: T, value: '', inputType: 'date', sensitive: true })).toBe(
      `await browser.execute(${js}, await ${L}, process.env.LOCATRA_PASSWORD ?? '');`
    );
    expect(stmt({ action: 'fill', target: T, value: 'x', inputType: 'email' })).toBe(
      `await ${L}.setValue('x');`
    );
  });

  it('uploads absolute paths with addValue and clears an empty upload', () => {
    const note = '// NOTE: these file paths must exist relative to where the test runs';
    expect(stmt({ action: 'upload', target: T, value: JSON.stringify(['a.txt', "b's.pdf"]) })).toBe(
      `${note}\nawait ${L}.addValue(['a.txt', 'b\\'s.pdf'].map((p) => path.resolve(p)).join('\\n'));`
    );
    expect(stmt({ action: 'upload', target: T, value: 'report.pdf' })).toBe(
      `${note}\nawait ${L}.addValue(['report.pdf'].map((p) => path.resolve(p)).join('\\n'));`
    );
    expect(stmt({ action: 'upload', target: T, value: '[]' })).toBe(`await ${L}.clearValue();`);
    expect(stmt({ action: 'upload', target: T, value: ['x.png'] })).toContain(`['x.png']`);
  });

  it('navigates, and sizes the window to the recorded viewport plus browser chrome', () => {
    expect(stmt({ action: 'goto', value: 'https://e.example/' })).toBe(
      `await browser.url('https://e.example/');`
    );
    expect(stmt({ action: 'goto', url: 'https://u.example/' })).toBe(
      `await browser.url('https://u.example/');`
    );
    expect(stmt({ action: 'goto' })).toBe(`await browser.url('');`);
    const js = "'return [1280 + outerWidth - innerWidth, 800 + outerHeight - innerHeight];'";
    expect(stmt({ action: 'viewport', value: '1280x800' }, 'typescript')).toBe(
      `{\n  const [width, height] = await browser.execute<[number, number], []>(\n    ${js});\n` +
        '  await browser.setWindowSize(width, height);\n}'
    );
    expect(stmt({ action: 'viewport', value: '1280x800' }, 'javascript')).toBe(
      `{\n  const [width, height] = await browser.execute(\n    ${js});\n  await browser.setWindowSize(width, height);\n}`
    );
    expect(stmt({ action: 'viewport', width: 390, height: 844 }, 'javascript')).toContain('[390 + ');
    expect(stmt({ action: 'viewport', width: 390, height: 844 }, 'javascript')).toContain(', 844 + ');
    expect(stmt({ action: 'viewport', value: 'junk' }, 'javascript')).toContain('[1280 + ');
    expect(stmt({ action: 'viewport', value: 'junk' }, 'javascript')).toContain(', 720 + ');
  });

  it('presses keys and modifier combos with browser.keys and the Key constants', () => {
    const cases = [
      [undefined, 'await browser.keys(Key.Enter);'],
      ['Enter', 'await browser.keys(Key.Enter);'],
      ['Tab', 'await browser.keys(Key.Tab);'],
      ['Escape', 'await browser.keys(Key.Escape);'],
      ['Backspace', 'await browser.keys(Key.Backspace);'],
      ['Delete', 'await browser.keys(Key.Delete);'],
      ['ArrowUp', 'await browser.keys(Key.ArrowUp);'],
      ['ArrowDown', 'await browser.keys(Key.ArrowDown);'],
      ['ArrowLeft', 'await browser.keys(Key.ArrowLeft);'],
      ['ArrowRight', 'await browser.keys(Key.ArrowRight);'],
      ['Home', 'await browser.keys(Key.Home);'],
      ['End', 'await browser.keys(Key.End);'],
      ['PageUp', 'await browser.keys(Key.PageUp);'],
      ['PageDown', 'await browser.keys(Key.PageDown);'],
      ['Insert', 'await browser.keys(Key.Insert);'],
      ['F1', 'await browser.keys(Key.F1);'],
      ['F12', 'await browser.keys(Key.F12);'],
      [' ', 'await browser.keys(Key.Space);'],
      ['Space', 'await browser.keys(Key.Space);'],
      ['a', "await browser.keys('a');"],
      ["'", "await browser.keys('\\'');"],
      ['\\', "await browser.keys('\\\\');"],
      ['é', "await browser.keys('é');"],
      ['😀', "await browser.keys('😀');"],
      ['+', "await browser.keys('+');"],
      ['Shift+Tab', 'await browser.keys([Key.Shift, Key.Tab]);'],
      ['Control+a', "await browser.keys([Key.Control, 'a']);"],
      ['Control++', "await browser.keys([Key.Control, '+']);"],
      ['Alt+F4', 'await browser.keys([Key.Alt, Key.F4]);'],
      ['Meta+k', "await browser.keys([Key.Command, 'k']);"],
      ['Control+Shift+Z', "await browser.keys([Key.Control, Key.Shift, 'Z']);"],
      ['Shift+ ', 'await browser.keys([Key.Shift, Key.Space]);'],
      ['F13', '// TODO: press "F13" — no WebdriverIO key mapping'],
      ['MediaPlay', '// TODO: press "MediaPlay" — no WebdriverIO key mapping'],
      ['Hyper+a', '// TODO: press "Hyper+a" — modifier not supported'],
      ['Shift+Hyper+Tab', '// TODO: press "Shift+Hyper+Tab" — modifier not supported'],
    ];
    for (const [value, expected] of cases) {
      for (const lang of LANGS) expect(stmt({ action: 'press', value }, lang), String(value)).toBe(expected);
    }
    expect(stmt({ action: 'press', key: 'Tab' })).toBe('await browser.keys(Key.Tab);');
  });

  it('notes an unnamed role locator that may match several elements', () => {
    const note =
      '// NOTE: this role locator has no accessible name and may match several elements; the first match is used.';
    expect(stmt({ action: 'click', target: role('link') })).toBe(
      `${note}\nawait ${loc(role('link'))}.click();`
    );
    expect(stmt({ action: 'click', target: role('link', null, { nth: 0 }) })).not.toContain('NOTE');
    expect(stmt({ action: 'click', target: role('link', null, { matchCount: 1 }) })).not.toContain('NOTE');
    expect(stmt({ action: 'click', target: frame('#f', role('link')) }).split('\n')).toEqual([
      `await browser.switchFrame($('#f'));`,
      note,
      `await ${loc(role('link'))}.click();`,
      'await browser.switchFrame(null);',
    ]);
  });

  it('turns unknown actions and missing locators into TODO comments', () => {
    expect(stmt({ action: 'teleport', target: T })).toBe('// TODO: unsupported step "teleport"');
    expect(stmt({ action: 'click' })).toBe('// TODO: "click" step has no element locator');
    expect(stmt({ action: 'click', target: { kind: 'frame', selector: '#f', index: 0, child: null } })).toBe(
      '// TODO: "click" step has no element locator'
    );
    expect(stmt(null)).toBe('');
    // An action a newer codegen.js knows but this target does not yet render.
    const newer = freshContext({ internals: (I) => I.KNOWN_ACTIONS.push('swipe') });
    expect(newer.actionStatement({ action: 'swipe', target: T }, FW, 'javascript')).toBe(
      '// TODO: unsupported step "swipe"'
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('assertions', () => {
  const T = testid('t');
  const L = `$('[data-testid="t"]')`;
  const a = (assertType, value, target = T) => stmt({ action: 'assert', target, assertType, value });

  it('declares LOCATRA_TEXT when the only text check is a "contains" one (a spread use)', () => {
    const steps = [{ action: 'assert', target: T, assertType: 'toContainText', value: 'Card ending' }];
    for (const lang of ['typescript', 'javascript']) {
      const out = C.testScript(steps, 'webdriverio', lang);
      expect(out, lang).toContain('{ ...LOCATRA_TEXT, containing: true }');
      expect(out.match(/^const LOCATRA_TEXT\b/gm), lang).toHaveLength(1);
    }
  });

  it('maps every assertion to expect-webdriverio with normalised text', () => {
    expect(a('toBeVisible')).toBe(`await expect(${L}).toBeDisplayed();`);
    expect(a(undefined)).toBe(`await expect(${L}).toBeDisplayed();`);
    expect(a('toBeSomethingNew')).toBe(`await expect(${L}).toBeDisplayed();`);
    expect(a('toHaveText', '  Ada \n  Lovelace ')).toBe(
      `await expect(${L}).toHaveText('Ada Lovelace', LOCATRA_TEXT);`
    );
    expect(a('toContainText', 'Card   ending')).toBe(
      `await expect(${L}).toHaveText('Card ending', { ...LOCATRA_TEXT, containing: true });`
    );
    // The normalisation, declared once per file that compares text.
    const steps = [{ action: 'assert', target: T, assertType: 'toHaveText', value: 'x' }];
    for (const lang of ['typescript', 'javascript']) {
      const out = C.testScript([...steps, ...steps], 'webdriverio', lang);
      expect(out.match(/^const LOCATRA_TEXT = /gm), lang).toHaveLength(1);
      expect(out).toContain(
        "const LOCATRA_TEXT = { replace: [[/[\\u00ad\\u200b]/g, ''], [/\\s+/g, ' ']]" +
          (lang === 'typescript' ? ' as [RegExp, string][] };' : ' };')
      );
    }
    expect(a('toHaveValue', ' raw  value ')).toBe(`await expect(${L}).toHaveValue(' raw  value ');`);
    expect(a('toBeEnabled')).toBe(`await expect(${L}).toBeEnabled();`);
  });

  it('waits for the native or ARIA checked state', () => {
    const body = `((await el.isSelected()) || (await el.getAttribute('aria-checked')) === 'true')`;
    expect(a('toBeChecked', 'true')).toBe(
      `await browser.waitUntil(async () => {\n  const el = await ${L};\n  return ${body};\n}, ` +
        `{ timeoutMsg: 'expected the element to be checked' });`
    );
    expect(a('toBeChecked', undefined)).toContain(`return ${body};`);
    expect(a('toBeChecked', 'false')).toBe(
      `await browser.waitUntil(async () => {\n  const el = await ${L};\n  return !${body};\n}, ` +
        `{ timeoutMsg: 'expected the element not to be checked' });`
    );
    expect(a('toBeChecked', false)).toContain('return !(');
  });

  it('asserts the page URL, ignoring any target', () => {
    for (const lang of LANGS) {
      expect(stmt({ action: 'assert', assertType: 'toHaveURL', value: 'https://e.example/done' }, lang)).toBe(
        `await expect(browser).toHaveUrl('https://e.example/done');`
      );
    }
    expect(stmt({ action: 'assert', assertType: 'toHaveURL', value: '', url: 'https://u.example/' })).toBe(
      `await expect(browser).toHaveUrl('https://u.example/');`
    );
    expect(stmt({ action: 'assert', assertType: 'toHaveURL' })).toBe(`await expect(browser).toHaveUrl('');`);
    expect(
      stmt({ action: 'assert', assertType: 'toHaveURL', value: 'https://x/', target: frame('#f', id('a')) })
    ).toBe(`await expect(browser).toHaveUrl('https://x/');`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('frames', () => {
  it('switches into a frame, acts, and switches back to the top document', () => {
    expect(stmt({ action: 'fill', target: frame('#payment-frame', id('card')), value: '4242' })).toBe(
      [
        `await browser.switchFrame($('#payment-frame'));`,
        `await $('#card').setValue('4242');`,
        'await browser.switchFrame(null);',
      ].join('\n')
    );
  });

  it('enters nested frames outermost first', () => {
    expect(
      stmt({
        action: 'assert',
        assertType: 'toHaveValue',
        value: '1',
        target: frame('#outer', frame('#inner', id('c'))),
      })
    ).toBe(
      [
        `await browser.switchFrame($('#outer'));`,
        `await browser.switchFrame($('#inner'));`,
        `await expect($('#c')).toHaveValue('1');`,
        'await browser.switchFrame(null);',
      ].join('\n')
    );
  });

  it('addresses a cross-origin frame by position', () => {
    const xo = { kind: 'frame', selector: null, index: 2, child: id('x') };
    expect(stmt({ action: 'click', target: xo }).split('\n')[0]).toBe(
      `await browser.switchFrame(${deepFrame(2)});`
    );
    expect(stmt({ action: 'click', target: xo }, 'javascript').split('\n')[0]).toBe(
      `await browser.switchFrame(${deepFrame(2, 'javascript')});`
    );
    const noIndex = { kind: 'frame', selector: '', child: id('x') };
    expect(stmt({ action: 'click', target: noIndex }).split('\n')[0]).toBe(
      `await browser.switchFrame(${deepFrame(0)});`
    );
  });

  it('walks a shadow-DOM path host by host with shadow$()', () => {
    const t = frame('#shell > x-pay > iframe', id('card'), { shadowPath: ['#shell', 'x-pay', 'iframe.pay'] });
    expect(stmt({ action: 'click', target: t }).split('\n')).toEqual([
      `await browser.switchFrame($('#shell').shadow$('x-pay').shadow$('iframe.pay'));`,
      `await $('#card').click();`,
      'await browser.switchFrame(null);',
    ]);
    // Each hop is quoted, and CSS that WDIO would misread keeps its explicit strategy.
    const hostile = frame('x', id('c'), { shadowPath: ['pay-widget[title="it\'s"]', 'frame.png'] });
    expect(stmt({ action: 'click', target: hostile }).split('\n')[0]).toBe(
      `await browser.switchFrame($('pay-widget[title="it\\'s"]').shadow$('css selector:frame.png'));`
    );
    // An unusable path falls back to the selector.
    for (const bad of [undefined, [], ['only'], ['a', ''], ['a', 3], 'a b']) {
      expect(
        stmt({ action: 'click', target: frame('#f', id('c'), { shadowPath: bad }) }).split('\n')[0]
      ).toBe(`await browser.switchFrame($('#f'));`);
    }
    // A cross-origin frame has no element to walk to.
    const xo = { kind: 'frame', selector: null, index: 1, shadowPath: ['a-b', 'iframe'], child: id('c') };
    expect(stmt({ action: 'click', target: xo }).split('\n')[0]).toBe(
      `await browser.switchFrame(${deepFrame(1)});`
    );
  });

  it('nests a shadow frame under an outer frame and keeps chains inside', () => {
    const t = frame(
      '#outer',
      frame(
        's',
        { kind: 'chain', parent: css('form'), child: role('button', 'Pay') },
        {
          shadowPath: ['x-a', 'iframe'],
        }
      )
    );
    const lines = stmt({ action: 'click', target: t }).split('\n');
    expect(lines.slice(0, 2)).toEqual([
      `await browser.switchFrame($('#outer'));`,
      `await browser.switchFrame($('x-a').shadow$('iframe'));`,
    ]);
    expect(lines[2]).toBe(
      "await (await locatraFind('role', 'button', 'Pay', { within: $('form') })).click();"
    );
    expect(lines[3]).toBe('await browser.switchFrame(null);');
  });

  it('indents every line of a frame statement inside the spec', () => {
    const out = C.testScript([{ action: 'click', target: frame('#f', id('b')) }], FW, 'typescript');
    expect(out).toContain(
      `    await browser.switchFrame($('#f'));\n    await $('#b').click();\n    await browser.switchFrame(null);\n`
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('test file', () => {
  it('wraps statements in a Mocha spec with only the imports they use', () => {
    const out = C.testScript(
      [
        { action: 'goto', value: 'https://e.example/' },
        { action: 'click', target: id('go') },
        { action: 'press', value: 'Enter' },
        { action: 'assert', target: id('ok'), assertType: 'toBeVisible' },
      ],
      FW,
      'typescript'
    );
    expect(out).toBe(
      [
        "import { browser, $, expect } from '@wdio/globals';",
        "import { Key } from 'webdriverio';",
        '',
        "describe('recorded test', () => {",
        "  it('replays the recorded flow', async () => {",
        "    await browser.url('https://e.example/');",
        "    await $('#go').click();",
        '    await browser.keys(Key.Enter);',
        "    await expect($('#ok')).toBeDisplayed();",
        '  });',
        '});',
        '',
      ].join('\n')
    );
  });

  it('derives each import from real calls, never from comments', () => {
    const w = (stmts) => C.wrapScript(stmts, FW, 'javascript');
    expect(w([])).toBe(
      "describe('recorded test', () => {\n  it('replays the recorded flow', async () => {\n\n  });\n});\n"
    );
    expect(w(['// TODO: unsupported step "x"'])).toMatch(/^describe\(/);
    expect(w(["// browser.url('x') Key.Enter $('a') expect(1) path.resolve('x')"])).toMatch(/^describe\(/);
    expect(w(["await browser.url('x');"])).toMatch(/^import \{ browser \} from '@wdio\/globals';\n\n/);
    expect(w(["await $('a').click();"])).toMatch(/^import \{ \$ \} from '@wdio\/globals';\n\n/);
    expect(w(["await browser.switchFrame($$('iframe')[0]);"])).toMatch(
      /^import \{ browser, \$\$ \} from '@wdio\/globals';\n\n/
    );
    expect(w(["await expect(browser).toHaveUrl('x');"])).toMatch(/^import \{ browser, expect \} from/);
    const upload = C.testScript([{ action: 'upload', target: id('f'), value: 'a.txt' }], FW, 'javascript');
    expect(upload.split('\n').slice(0, 3)).toEqual([
      "import { $ } from '@wdio/globals';",
      "import * as path from 'node:path';",
      '',
    ]);
    // A method named like a global is not a call of it.
    expect(w(['await x.browser.foo(); await y.$(1); await z.expect(2);'])).toMatch(/^describe\(/);
  });

  it('indents every physical line and drops unaccepted suggestions', () => {
    const steps = [
      { action: 'check', target: id('terms') },
      { action: 'assert', target: id('x'), assertType: 'toBeVisible', suggested: true },
      { action: 'click', target: id('go') },
    ];
    const out = C.testScript(steps, FW, 'javascript');
    expect(out).toContain("    {\n      const el = await $('#terms');\n      if (!(");
    expect(out).not.toContain("$('#x')");
    const wrapped = C.wrapScript(
      steps.map((s) => stmt(s, 'javascript')),
      FW,
      'javascript',
      steps
    );
    expect(wrapped).toBe(out);
  });

  it('differs between TypeScript and JavaScript only in type annotations', () => {
    const flow = JSON.parse(
      readFileSync(join(ROOT, 'tests/e2e/fixtures/checkout-flow.json'), 'utf8')
    ).actions;
    const ts = C.testScript(flow, FW, 'typescript');
    const js = C.testScript(flow, FW, 'javascript');
    const body = (code) => code.slice(code.indexOf("describe('recorded test'"));
    expect(
      body(ts)
        .replace('browser.execute<[number, number], []>(', 'browser.execute(')
        .replaceAll('browser.execute<HTMLIFrameElement, [number]>(', 'browser.execute(')
    ).toBe(body(js));
    // The helper declarations differ only in their annotations (one source, $T{…} kept or dropped).
    const head = (code) => code.slice(0, code.indexOf("describe('recorded test'"));
    expect(head(ts)).toContain(
      'async function locatraFind(\n  kind: string, value: string, name: string | null = null, opts: any = {}\n'
    );
    expect(head(js)).toContain('async function locatraFind(\n  kind, value, name = null, opts = {}\n) {');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('test-data variables', () => {
  const steps = [
    { eventId: 'e1', action: 'goto', value: 'https://e.example/' },
    { eventId: 'e2', action: 'fill', target: label('First name'), value: "Ada 'A'" },
    { eventId: 'e3', action: 'fill', target: label('Password'), value: 'secret', sensitive: true },
    { eventId: 'e4', action: 'selectOption', target: role('combobox', 'Country'), value: 'Ireland' },
    { eventId: 'e5', action: 'fill', target: label('Notes'), value: '' },
    { eventId: 'e6', action: 'fill', target: label('Volume'), value: '42', inputType: 'range' },
    { eventId: 'e7', action: 'fill', target: frame('#pay', label('Card number')), value: '4242' },
    { eventId: 'e8', action: 'assert', target: id('name'), assertType: 'toHaveText', value: "Ada 'A'" },
  ];

  it('declares testData after the imports and references it from fills and selects', () => {
    const out = C.testScript(steps, FW, 'typescript', { variables: true });
    const head = out.split("describe('recorded")[0];
    // imports, then the Locatra helper the label / role steps call, then the data.
    expect(head.startsWith("import { browser, $, expect } from '@wdio/globals';\n\n// Locatra: ")).toBe(true);
    expect(head.indexOf('async function locatraFind(')).toBeLessThan(head.indexOf('const testData = {'));
    expect(head.slice(head.indexOf('const testData = {'))).toBe(
      [
        'const testData = {',
        "  firstName: 'Ada \\'A\\'',",
        "  country: 'Ireland',",
        "  volume: '42',",
        "  cardNumber: '4242',",
        '};',
        '',
        '',
      ].join('\n')
    );
    expect(out).toContain(`await ${loc(label('First name'))}.setValue(testData.firstName);`);
    expect(out).toContain(`.selectByVisibleText(testData.country);`);
    expect(out).toContain(`, await ${loc(label('Volume'))}, testData.volume);`);
    expect(out).toContain(`.setValue(testData.cardNumber);`);
    // secrets stay environment variables; empty values and assertions stay literal
    expect(out).toContain(".setValue(process.env.LOCATRA_PASSWORD ?? '');");
    expect(out).not.toContain('secret');
    expect(out).toContain(`await ${loc(label('Notes'))}.clearValue();`);
    expect(out).toContain(`.toHaveText('Ada \\'A\\'', LOCATRA_TEXT);`);
  });

  it('declares exactly the keys the statements reference', () => {
    for (const lang of LANGS) {
      const out = C.testScript(steps, FW, lang, { variables: true });
      const decl = out.match(/const testData = \{\n([\s\S]*?)\n\};/)[1];
      const keys = decl.split('\n').map((l) => l.trim().split(':')[0]);
      const refs = [...new Set([...out.matchAll(/testData\.(\w+)/g)].map((m) => m[1]))];
      expect(refs.sort()).toEqual([...keys].sort());
      expect(Object.keys(JSON.parse(C.variablesJson(C.extractVariables(steps)))).sort()).toEqual(keys.sort());
    }
  });

  it('uses an edited variable list as-is and renders literals without one', () => {
    const vars = C.extractVariables(steps).map((v) =>
      v.name === 'firstName' ? { ...v, name: 'givenName' } : v
    );
    const out = C.testScript(steps, FW, 'javascript', { variables: vars });
    expect(out).toContain('  givenName: ');
    expect(out).toContain('.setValue(testData.givenName);');
    const literal = C.testScript(steps, FW, 'javascript');
    expect(literal).not.toContain('testData');
    expect(literal).toBe(C.testScript(steps, FW, 'javascript', { variables: false }));
    // references left on steps are dropped when no variables are passed
    const stale = C.testScript(
      steps.map((s) => ({ ...s, varRef: 'firstName' })),
      FW,
      'javascript'
    );
    expect(stale).toBe(literal);
  });

  it('renders a panel-built script (applyVariables + actionStatement + wrapScript) identically', () => {
    const vars = C.extractVariables(steps);
    const applied = C.applyVariables(steps, vars);
    const stmts = applied.map((s) => stmt(s, 'typescript'));
    expect(C.wrapScript(stmts, FW, 'typescript', applied, { variables: vars })).toBe(
      C.testScript(steps, FW, 'typescript', { variables: true })
    );
  });

  it('only references valid, non-reserved names, and never on sensitive steps', () => {
    const T = id('a');
    expect(stmt({ action: 'fill', target: T, value: 'x', varRef: 'email' })).toBe(
      `await $('#a').setValue(testData.email);`
    );
    expect(stmt({ action: 'fill', target: T, value: '', varRef: 'email' })).toBe(
      `await $('#a').setValue(testData.email);`
    );
    expect(stmt({ action: 'fill', target: T, value: 'x', varRef: 'class' })).toBe(
      `await $('#a').setValue('x');`
    );
    expect(stmt({ action: 'fill', target: T, value: 'x', varRef: '1bad' })).toBe(
      `await $('#a').setValue('x');`
    );
    expect(stmt({ action: 'fill', target: T, value: 'x', varRef: 'pw', sensitive: true })).toBe(
      `await $('#a').setValue(process.env.LOCATRA_PASSWORD ?? '');`
    );
    expect(stmt({ action: 'selectOption', target: T, value: 'x', varRef: 'country' })).toBe(
      `await $('#a').selectByVisibleText(testData.country);`
    );
    expect(stmt({ action: 'click', target: T, varRef: 'x' })).toBe(`await $('#a').click();`);
  });

  it('declares each valid name once, skipping malformed entries', () => {
    const out = C.wrapScript(["await $('#a').setValue(testData.a);"], FW, 'javascript', undefined, {
      variables: [
        { name: 'a', value: 'one' },
        { name: 'a', value: 'dupe' },
        { name: 'b', value: null },
        { name: 'class', value: 'reserved' },
        null,
        { name: 'bad name', value: 'x' },
      ],
    });
    expect(out.split('describe(')[0]).toBe(
      "import { $ } from '@wdio/globals';\n\nconst testData = {\n  a: 'one',\n  b: '',\n};\n\n"
    );
    expect(C.wrapScript([], FW, 'javascript', [], { variables: [] })).toMatch(/^describe\(/);
  });

  it('falls back to its own name rules on a codegen.js without the variable helpers', () => {
    const old = freshContext({
      internals: (I) => {
        delete I.variableRefName;
        delete I.isValidVariableName;
        delete I.variableRef;
        delete I.variablesDeclaration;
      },
    });
    const T = id('a');
    const s = (step) => old.actionStatement(step, FW, 'javascript');
    expect(s({ action: 'fill', target: T, value: 'x', varRef: 'email' })).toBe(
      `await $('#a').setValue(testData.email);`
    );
    expect(s({ action: 'selectOption', target: T, value: 'x', varRef: 'c' })).toBe(
      `await $('#a').selectByVisibleText(testData.c);`
    );
    expect(s({ action: 'fill', target: T, value: 'x', varRef: 'bad name' })).toBe(
      `await $('#a').setValue('x');`
    );
    expect(s({ action: 'fill', target: T, value: 'x', varRef: 'pw', sensitive: true })).toContain(
      'process.env'
    );
    expect(
      old.wrapScript([], FW, 'javascript', [], {
        variables: [{ name: 'ok', value: 'v' }, { name: 'no way' }],
      })
    ).toContain("const testData = {\n  ok: 'v',\n};");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('page objects', () => {
  const SMALL = {
    pageUrl: 'https://shop.example/checkout',
    title: 'Checkout | Shop',
    elements: [
      { name: 'emailAddressInput', kind: 'input', target: id('email') },
      { name: 'placeOrderButton', kind: 'button', target: testid('place-order') },
    ],
  };
  const po = (model, lang = 'typescript') => C.pageObject(model, FW, lang);

  it('renders the TypeScript class: getters, goto, typed helpers', () => {
    expect(po(SMALL)).toBe(
      [
        '// Page Object generated by Locatra for "Checkout | Shop".',
        '// Page: https://shop.example/checkout',
        "import { browser, $ } from '@wdio/globals';",
        '',
        'export class CheckoutPage {',
        '  get emailAddressInput() {',
        "    return $('#email');",
        '  }',
        '',
        '  get placeOrderButton() {',
        `    return $('[data-testid="place-order"]');`,
        '  }',
        '',
        '  async goto(): Promise<void> {',
        "    await browser.url('https://shop.example/checkout');",
        '  }',
        '',
        '  async fillEmailAddressInput(value: string): Promise<void> {',
        '    await this.emailAddressInput.setValue(value);',
        '  }',
        '',
        '  async clickPlaceOrderButton(): Promise<void> {',
        '    await this.placeOrderButton.click();',
        '  }',
        '}',
        '',
      ].join('\n')
    );
  });

  it('renders the JavaScript class without types and with a usage line', () => {
    const js = po(SMALL, 'javascript');
    expect(js.split('\n').slice(0, 7)).toEqual([
      '// Page Object generated by Locatra for "Checkout | Shop".',
      '// Page: https://shop.example/checkout',
      "import { browser, $ } from '@wdio/globals';",
      '',
      '// Usage: const checkoutPage = new CheckoutPage();',
      '',
      'export class CheckoutPage {',
    ]);
    expect(js).toContain('  async goto() {\n');
    expect(js).toContain('  async fillEmailAddressInput(value) {\n');
    expect(js).not.toMatch(/: (string|Promise)/);
  });

  it('gives every kind its helpers, with the native/ARIA toggle and the value setter', () => {
    const model = {
      className: 'Form',
      elements: [
        { name: 'notes', kind: 'textarea', target: id('n') },
        { name: 'country', kind: 'select', target: id('c') },
        { name: 'terms', kind: 'checkbox', target: id('t') },
        { name: 'express', kind: 'radio', target: id('r') },
        { name: 'volume', kind: 'input', inputType: 'range', target: id('v') },
        { name: 'cv', kind: 'input', inputType: 'file', target: id('f') },
        { name: 'search', kind: 'other', role: 'searchbox', target: id('s') },
        { name: 'widget', kind: 'mystery', target: id('w') },
        { name: 'home', kind: 'link', target: id('h') },
      ],
    };
    const out = po(model);
    const checked = `((await el.isSelected()) || (await el.getAttribute('aria-checked')) === 'true')`;
    const setter = 'LOCATRA_SET_VALUE_JS';
    for (const part of [
      '  async fillNotes(value: string): Promise<void> {\n    await this.notes.setValue(value);\n  }',
      '  async selectCountry(value: string): Promise<void> {\n    await this.country.selectByVisibleText(value);\n  }',
      `  async checkTerms(): Promise<void> {\n    const el = await this.terms;\n    if (!${checked}) await el.click();\n  }`,
      `  async uncheckTerms(): Promise<void> {\n    const el = await this.terms;\n    if (${checked}) await el.click();\n  }`,
      `  async checkExpress(): Promise<void> {\n    const el = await this.express;\n    if (!${checked}) await el.click();\n  }`,
      `  async fillVolume(value: string): Promise<void> {\n    await browser.execute(${setter}, await this.volume, value);\n  }`,
      '  async fillSearch(value: string): Promise<void> {',
      '  async clickWidget(): Promise<void> {',
      '  async clickHome(): Promise<void> {',
      '  get cv() {',
    ]) {
      expect(out).toContain(part);
    }
    expect(out).not.toMatch(/uncheckExpress|fillCv|clickCv/);
    expect(out).not.toContain('goto(');
  });

  it('switches to each element’s frames from the top document when any element is framed', () => {
    const model = {
      className: 'Pay',
      pageUrl: 'https://e.example/',
      elements: [
        { name: 'email', kind: 'input', target: id('email') },
        { name: 'card', kind: 'input', target: frame('#pay', id('card')) },
        { name: 'agree', kind: 'checkbox', target: frame('#pay', id('agree')) },
        { name: 'when', kind: 'input', inputType: 'date', target: frame('#pay', id('d')) },
        { name: 'plan', kind: 'select', target: frame('#pay', id('p')) },
        { name: 'go', kind: 'button', target: { kind: 'frame', selector: null, index: 1, child: id('go') } },
      ],
    };
    const ts = po(model);
    expect(ts).toContain(
      [
        '  async email(): Promise<WebdriverIO.Element> {',
        '    await browser.switchFrame(null);',
        "    return $('#email').getElement();",
        '  }',
        '',
        '  async card(): Promise<WebdriverIO.Element> {',
        '    await browser.switchFrame(null);',
        "    await browser.switchFrame($('#pay'));",
        "    return $('#card').getElement();",
        '  }',
      ].join('\n')
    );
    expect(ts).toContain(
      `    await browser.switchFrame(${deepFrame(1)});\n    return $('#go').getElement();`
    );
    expect(declaredString(ts, 'LOCATRA_FRAME_JS', 'typescript')).toBe(C._internals.DEEP_IFRAME_JS);
    expect(ts).toContain(
      "  async goto(): Promise<void> {\n    await browser.switchFrame(null);\n    await browser.url('https://e.example/');\n  }"
    );
    expect(ts).toContain('    await (await this.card()).setValue(value);');
    expect(ts).toContain('    const el = await this.agree();\n');
    expect(ts).toContain(', await this.when(), value);');
    expect(ts).toContain('    await (await this.plan()).selectByVisibleText(value);');
    expect(ts).toContain('    await (await this.go()).click();');
    // The selector-less frame is found with browser.execute, so $$ is not imported.
    expect(ts.split('\n')[2]).toBe("import { browser, $ } from '@wdio/globals';");
    expect(po(model, 'javascript')).toContain('  async card() {\n');
  });

  it('claims valid, unique, non-reserved member names', () => {
    const model = {
      className: 'X',
      elements: [
        { name: 'goto', kind: 'button', target: id('a') },
        { name: 'constructor', kind: 'button', target: id('b') },
        { name: 'Save', kind: 'button', target: id('c') },
        { name: 'save', kind: 'button', target: id('d') },
        { name: '1st item!', kind: 'button', target: id('e') },
        { name: '', kind: 'button', target: id('f') },
        { name: 'clickSave', kind: 'button', target: id('g') },
      ],
    };
    const names = [...po(model).matchAll(/^ {2}(?:get |async )?(\w+)\(/gm)].map((m) => m[1]);
    expect(names).toEqual([
      'gotoElement',
      'constructorElement',
      'save',
      'save2',
      'el1stItem',
      'element',
      'clickSave',
      'clickGotoElement',
      'clickConstructorElement',
      'clickSave2',
      'clickSave22',
      'clickEl1stItem',
      'clickElement',
      'clickClickSave',
    ]);
  });

  it('annotates doubtful locators, skips unusable elements and keeps hostile text in comments', () => {
    const model = {
      title: 'Evil "title"\n// injected',
      pageUrl: "https://e.example/a'b\nc",
      elements: [
        { name: 'none', kind: 'button', target: id('a'), matchCount: 0 },
        { name: 'many', kind: 'button', target: id('b'), matchCount: 3 },
        { name: 'loose', kind: 'button', target: id('c'), unique: false },
        { name: 'anon', kind: 'link', target: role('link') },
        { name: 'anonCounted', kind: 'link', target: role('link'), matchCount: 2 },
        { name: 'gone', kind: 'button' },
        { name: 'emptyFrame', kind: 'button', target: { kind: 'frame', selector: '#f', child: null } },
        null,
      ],
    };
    const out = po(model);
    expect(out.split('\n').slice(0, 3)).toEqual([
      '// Page Object generated by Locatra for "Evil "title" // injected".',
      "// Page: https://e.example/a'b c",
      '// NOTE: 3 element(s) without a usable locator were left out.',
    ]);
    expect(out).toContain(
      '  // NOTE: this locator matched no element when the page object was generated.\n  get none() {'
    );
    expect(out).toContain(
      '  // NOTE: this locator matched 3 elements when the page object was generated.\n  get many() {'
    );
    expect(out).toContain(
      '  // NOTE: this locator was not unique when the page object was generated.\n  get loose() {'
    );
    expect(out).toContain(
      '  // NOTE: this role locator has no accessible name and may match several elements.\n  async anon(): Promise<WebdriverIO.Element> {'
    );
    expect(out).toContain(
      '  // NOTE: this locator matched 2 elements when the page object was generated.\n  async anonCounted(): Promise<WebdriverIO.Element> {'
    );
    expect(out).toContain(`await browser.url('https://e.example/a\\'b\\nc');`);
    expect(po({})).toBe(
      '// Page Object generated by Locatra.\n\nexport class HomePage {\n\n}\n'.replace(
        '\n\nexport',
        '\nexport'
      )
    );
    expect(C.pageObject(undefined, FW, 'javascript')).toBe(
      '// Page Object generated by Locatra.\n// Usage: const homePage = new HomePage();\n\nexport class HomePage {\n\n}\n'
    );
  });

  it('is deterministic', () => {
    expect(po(SMALL)).toBe(po(JSON.parse(JSON.stringify(SMALL))));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Everything below renders real files: a broad recording and a broad page object.
const ALL_STEPS = [
  { action: 'goto', value: 'https://e.example/' },
  { action: 'viewport', value: '1024x768' },
  { action: 'fill', target: label('First name'), value: 'Zoë \'A\' "B" \\ ✓\n' },
  { action: 'fill', target: label('Password'), value: '', sensitive: true, secretName: 'PW' },
  { action: 'fill', target: label('Volume'), value: '4', inputType: 'range' },
  { action: 'fill', target: label('Empty'), value: '' },
  { action: 'selectOption', target: role('combobox', 'Country'), value: 'Ireland' },
  { action: 'check', target: role('checkbox', 'Terms') },
  { action: 'uncheck', target: id('news') },
  { action: 'hover', target: testid('menu') },
  { action: 'dblclick', target: { kind: 'text', value: 'Cell', exact: true } },
  { action: 'upload', target: label('CV'), value: '["a.pdf","b.pdf"]' },
  { action: 'upload', target: label('CV'), value: '[]' },
  { action: 'press', value: 'Shift+Tab' },
  { action: 'press', value: 'Meta+a' },
  { action: 'press', value: 'F13' },
  { action: 'click', target: role('link') },
  { action: 'click', target: { kind: 'chain', parent: css('tr.b'), child: role('button', 'Delete') } },
  { action: 'fill', target: frame('#outer', frame('#inner', label('Card'))), value: '4242' },
  { action: 'click', target: frame('s', id('pay'), { shadowPath: ['x-a', 'x-b', 'iframe'] }) },
  { action: 'click', target: { kind: 'frame', selector: null, index: 1, child: id('xo') } },
  { action: 'assert', target: id('a'), assertType: 'toBeVisible' },
  { action: 'assert', target: id('a'), assertType: 'toHaveText', value: 'A  b' },
  { action: 'assert', target: id('a'), assertType: 'toContainText', value: 'A' },
  { action: 'assert', target: id('a'), assertType: 'toHaveValue', value: 'v' },
  { action: 'assert', target: id('a'), assertType: 'toBeEnabled' },
  { action: 'assert', target: id('a'), assertType: 'toBeChecked', value: 'true' },
  { action: 'assert', target: id('a'), assertType: 'toBeChecked', value: 'false' },
  { action: 'assert', assertType: 'toHaveURL', value: 'https://e.example/done' },
  { action: 'mystery' },
];

const RICH_PO = {
  pageUrl: 'https://shop.example/checkout?step=2',
  title: 'Checkout – "Shop"',
  elements: [
    { name: 'emailAddressInput', kind: 'input', inputType: 'email', target: label('Email address') },
    { name: 'notesField', kind: 'textarea', target: { kind: 'placeholder', value: 'it\'s "quoted"' } },
    { name: 'countrySelect', kind: 'select', target: role('combobox', 'Country') },
    { name: 'termsCheckbox', kind: 'checkbox', target: role('checkbox', 'Terms') },
    { name: 'expressRadio', kind: 'radio', target: role('radio', 'Express', { exact: true }) },
    { name: 'volume', kind: 'input', inputType: 'range', target: id('vol') },
    {
      name: 'deleteButton',
      kind: 'button',
      target: { kind: 'chain', parent: css('tr.b'), child: role('button', 'Delete') },
    },
    { name: 'cardNumber', kind: 'input', target: frame('#pay', label('Card number')) },
    { name: 'shadowPay', kind: 'button', target: frame('s', id('pay'), { shadowPath: ['x-a', 'iframe'] }) },
    { name: 'goto', kind: 'link', target: role('link') },
  ],
};
const FLAT_PO = { ...RICH_PO, elements: RICH_PO.elements.filter((e) => e.target.kind !== 'frame') };

// The fields the recorder added (scratchpad contracts C1–C4).
const CONTRACT_STEPS = [
  { action: 'selectOption', target: id('m'), value: 'A', values: ['A', 'B'] },
  { action: 'assert', target: id('pw'), assertType: 'toHaveValue', sensitive: true, secretName: 'PW' },
  { action: 'click', target: { ...id('go'), shadowHosts: ['x-a', 'x-b'], shadowCss: '.go' } },
  { action: 'fill', target: { ...id('in'), shadowHosts: ['x-a'] }, value: 'v' },
  { action: 'click', target: { kind: 'frame', selector: null, index: 1, framesIndex: 2, child: id('f') } },
];
const SHADOW_PO = {
  className: 'Shadow',
  elements: [
    { name: 'go', kind: 'button', target: { ...id('go'), shadowHosts: ['x-a'], shadowCss: '.go' } },
    { name: 'pick', kind: 'select', target: id('pick') },
  ],
};

function writeFiles(files) {
  const out = {};
  for (const [name, text] of Object.entries(files)) {
    const file = join(dir, name);
    writeFileSync(file, text);
    out[name] = file;
  }
  return out;
}

describe('generated code parses', () => {
  it('passes node --check for every file in both languages (TypeScript stripped)', () => {
    const variants = {
      'spec-js.mjs': C.testScript(ALL_STEPS, FW, 'javascript'),
      'spec-vars-js.mjs': C.testScript(ALL_STEPS, FW, 'javascript', { variables: true }),
      'po-js.mjs': C.pageObject(RICH_PO, FW, 'javascript'),
      'po-flat-js.mjs': C.pageObject(FLAT_PO, FW, 'javascript'),
      'spec-ts.mjs': stripTypeScriptTypes(C.testScript(ALL_STEPS, FW, 'typescript')),
      'spec-vars-ts.mjs': stripTypeScriptTypes(
        C.testScript(ALL_STEPS, FW, 'typescript', { variables: true })
      ),
      'po-ts.mjs': stripTypeScriptTypes(C.pageObject(RICH_PO, FW, 'typescript')),
      'po-flat-ts.mjs': stripTypeScriptTypes(C.pageObject(FLAT_PO, FW, 'typescript')),
      'corpus-js.mjs': C.testScript(CORPUS.STEPS, FW, 'javascript'),
      'corpus-po-js.mjs': C.pageObject(CORPUS.MODEL, FW, 'javascript'),
      'corpus-ts.mjs': stripTypeScriptTypes(
        C.testScript(CORPUS.STEPS, FW, 'typescript', { variables: true })
      ),
    };
    const files = writeFiles(variants);
    for (const [name, file] of Object.entries(files)) {
      expect(() => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }), name).not.toThrow();
    }
  });

  // The real WebdriverIO v9 + expect-webdriverio + Mocha typings, installed by
  // `node scripts/e2e/setup-webdriverio.mjs` into node_modules/.cache (never into
  // package.json). Skipped, with this reason, where that toolchain is absent.
  it.skipIf(!HAS_WDIO_TYPES)(
    'type-checks with tsc --strict against the real @wdio types',
    () => {
      const project = mkdtempSync(join(dir, 'tsc-'));
      symlinkSync(WDIO_MODULES, join(project, 'node_modules'), 'junction');
      writeFileSync(join(project, 'package.json'), '{ "type": "module" }\n');
      const files = {
        'spec.ts': C.testScript(ALL_STEPS, FW, 'typescript'),
        'spec-vars.ts': C.testScript(ALL_STEPS, FW, 'typescript', { variables: true }),
        'RichPage.ts': C.pageObject({ ...RICH_PO, className: 'Rich' }, FW, 'typescript'),
        'FlatPage.ts': C.pageObject({ ...FLAT_PO, className: 'Flat' }, FW, 'typescript'),
        'contract.ts': C.testScript(CONTRACT_STEPS, FW, 'typescript'),
        'ShadowPage.ts': C.pageObject(SHADOW_PO, FW, 'typescript'),
        // The C9.4 corpus: the Locatra helper (within, nth, level, exact), XPath, deep shadow.
        'corpus.ts': C.testScript(CORPUS.STEPS, FW, 'typescript'),
        'corpus-vars.ts': C.testScript(CORPUS.STEPS, FW, 'typescript', { variables: true }),
        'CorpusPage.ts': C.pageObject({ ...CORPUS.MODEL, className: 'Corpus' }, FW, 'typescript'),
        'uses-po.ts': [
          "import { RichPage } from './RichPage.js';",
          "import { FlatPage } from './FlatPage.js';",
          "describe('po', () => {",
          "  it('runs', async () => {",
          '    const rich = new RichPage();',
          '    await rich.goto();',
          "    await rich.fillCardNumber('4242');",
          '    const card: WebdriverIO.Element = await rich.cardNumber();',
          "    await card.setValue('1');",
          '    const flat = new FlatPage();',
          "    await flat.fillEmailAddressInput('a@b.c');",
          '    await (await flat.emailAddressInput()).click();',
          '    await flat.checkTermsCheckbox();',
          '  });',
          '});',
          '',
        ].join('\n'),
      };
      for (const [name, text] of Object.entries(files)) writeFileSync(join(project, name), text);
      writeFileSync(
        join(project, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'es2022',
            module: 'esnext',
            moduleResolution: 'bundler',
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            types: ['node', '@wdio/globals/types', 'expect-webdriverio', '@wdio/mocha-framework'],
          },
          include: Object.keys(files),
        })
      );
      let output = '';
      try {
        execFileSync(process.execPath, [join(WDIO_MODULES, 'typescript/bin/tsc'), '-p', project], {
          stdio: 'pipe',
          encoding: 'utf8',
        });
      } catch (err) {
        output = String(err.stdout) + String(err.stderr);
      }
      expect(output).toBe('');
    },
    120_000
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Recording stand-ins for the WDIO globals: every command is logged, checkbox
// state is kept per selector, and `expect` records the matcher it was given.
function fakeWdio() {
  const log = [];
  const checked = {};
  const element = (desc) => {
    const el = {
      desc,
      $: (s) => element(`${desc}.$(${s})`),
      shadow$: (s) => element(`${desc}.shadow$(${s})`),
      getElement: async () => el,
      click: async () => {
        log.push(`${desc}.click()`);
        checked[desc] = !checked[desc];
      },
      isSelected: async () => !!checked[desc] && !desc.includes('aria'),
      getAttribute: async (name) =>
        name === 'aria-checked' && desc.includes('aria') ? String(!!checked[desc]) : null,
    };
    for (const m of ['setValue', 'clearValue', 'addValue', 'moveTo', 'doubleClick', 'selectByVisibleText']) {
      el[m] = async (...args) => log.push(`${desc}.${m}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
    }
    return el;
  };
  // execute() hands back a W3C element reference; $() accepts one, as WDIO's does.
  const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
  const $ = (s) => (s && typeof s === 'object' && ELEMENT_KEY in s ? element(s[ELEMENT_KEY]) : element(s));
  const $$ = (s) => new Proxy([], { get: (_, i) => element(`${s}[${String(i)}]`) });
  const browser = {
    url: async (u) => log.push(`url(${u})`),
    keys: async (k) => log.push(`keys(${JSON.stringify(k)})`),
    switchFrame: async (f) => {
      // Like WDIO: an element, a number, a URL string or null — never a bare reference.
      if (f !== null && !(f && f.desc)) throw new Error('Invalid type for context parameter: object');
      log.push(`switchFrame(${f === null ? 'null' : f.desc})`);
    },
    execute: async (script, ...args) => {
      log.push(
        `execute(${script.slice(0, 16)}…, ${args.map((a) => (a && a.desc) || JSON.stringify(a)).join(', ')})`
      );
      // The deep <iframe> lookup returns the frame element — as a bare reference.
      return script.startsWith('const frames') ? { [ELEMENT_KEY]: `iframe[${args[0]}]` } : [1000, 700];
    },
    setWindowSize: async (w, h) => log.push(`setWindowSize(${w}, ${h})`),
    waitUntil: async (fn, opts) => {
      const ok = await fn();
      log.push(`waitUntil(${ok}, ${opts.timeoutMsg})`);
      if (!ok) throw new Error(opts.timeoutMsg);
    },
  };
  const expectFn = (subject) =>
    new Proxy(
      {},
      {
        get:
          (_, matcher) =>
          async (...args) =>
            log.push(
              `expect(${subject === browser ? 'browser' : subject.desc}).${String(matcher)}(${args
                .map((a) =>
                  a && typeof a === 'object' && a.replace
                    ? `{replace:${a.replace.map((r) => r[0]).join('|')}${a.containing ? ',containing' : ''}}`
                    : JSON.stringify(a)
                )
                .join(', ')})`
            ),
      }
    );
  const Key = new Proxy({}, { get: (_, k) => `<${String(k)}>` });
  const path = { resolve: (p) => `/abs/${p}` };
  return { log, checked, globals: { browser, $, $$, expect: expectFn, Key, path } };
}

const stripImports = (code) => code.replace(/^import .*;$/gm, '');

async function runSpec(code) {
  const fake = fakeWdio();
  const tests = [];
  const g = {
    ...fake.globals,
    describe: (n, fn) => fn(),
    it: (n, fn) => tests.push(fn),
    process: { env: { PW: 'from-env' } },
  };
  new Function(...Object.keys(g), stripImports(code))(...Object.values(g));
  for (const t of tests) await t();
  return fake;
}

describe('generated code runs against WDIO stand-ins', () => {
  it('drives each recorded step through the right WDIO command', async () => {
    const steps = [
      { action: 'goto', value: 'https://e.example/' },
      { action: 'viewport', value: '1000x700' },
      { action: 'fill', target: id('first'), value: 'Ada' },
      { action: 'fill', target: id('pw'), value: '', sensitive: true, secretName: 'PW' },
      { action: 'fill', target: id('vol'), value: '4', inputType: 'range' },
      { action: 'fill', target: id('empty'), value: '' },
      { action: 'selectOption', target: id('country'), value: 'Ireland' },
      { action: 'check', target: id('terms') },
      { action: 'check', target: id('terms') },
      { action: 'uncheck', target: id('terms') },
      { action: 'check', target: id('aria-box') },
      { action: 'assert', target: id('aria-box'), assertType: 'toBeChecked', value: 'true' },
      { action: 'assert', target: id('terms'), assertType: 'toBeChecked', value: 'false' },
      { action: 'hover', target: id('menu') },
      { action: 'dblclick', target: id('cell') },
      { action: 'upload', target: id('cv'), value: '["a.pdf","b.pdf"]' },
      { action: 'upload', target: id('cv'), value: '[]' },
      { action: 'press', value: 'Shift+Tab' },
      { action: 'click', target: frame('#outer', frame('#inner', id('card'))) },
      { action: 'click', target: frame('s', id('pay'), { shadowPath: ['x-a', 'iframe'] }) },
      { action: 'click', target: { kind: 'frame', selector: null, index: 1, child: id('xo') } },
      { action: 'click', target: { kind: 'chain', parent: css('tr.b'), child: css('button') } },
      { action: 'assert', target: id('name'), assertType: 'toHaveText', value: 'Ada  L' },
      { action: 'assert', target: id('name'), assertType: 'toContainText', value: 'Ada' },
      { action: 'assert', target: id('country'), assertType: 'toHaveValue', value: 'Ireland' },
      { action: 'assert', target: id('go'), assertType: 'toBeEnabled' },
      { action: 'assert', target: id('go'), assertType: 'toBeVisible' },
      { action: 'assert', assertType: 'toHaveURL', value: 'https://e.example/done' },
    ];
    for (const lang of LANGS) {
      let code = C.testScript(steps, FW, lang, { variables: true });
      if (lang === 'typescript') code = stripTypeScriptTypes(code);
      const { log } = await runSpec(code);
      expect(log, lang).toEqual([
        'url(https://e.example/)',
        'execute(return [1000 + o…, )',
        'setWindowSize(1000, 700)',
        '#first.setValue("Ada")',
        '#pw.setValue("from-env")',
        'execute(const el = argum…, #vol, "4")',
        '#empty.clearValue()',
        '#country.selectByVisibleText("Ireland")',
        '#terms.click()',
        '#terms.click()',
        '#aria-box.click()',
        'waitUntil(true, expected the element to be checked)',
        'waitUntil(true, expected the element not to be checked)',
        '#menu.moveTo()',
        '#cell.doubleClick()',
        '#cv.addValue("/abs/a.pdf\\n/abs/b.pdf")',
        '#cv.clearValue()',
        'keys(["<Shift>","<Tab>"])',
        'switchFrame(#outer)',
        'switchFrame(#inner)',
        '#card.click()',
        'switchFrame(null)',
        'switchFrame(x-a.shadow$(iframe))',
        '#pay.click()',
        'switchFrame(null)',
        'execute(const frames = […, 1)',
        'switchFrame(iframe[1])',
        '#xo.click()',
        'switchFrame(null)',
        'tr.b.$(button).click()',
        'expect(#name).toHaveText("Ada L", {replace:/[\\u00ad\\u200b]/g|/\\s+/g})',
        'expect(#name).toHaveText("Ada", {replace:/[\\u00ad\\u200b]/g|/\\s+/g,containing})',
        'expect(#country).toHaveValue("Ireland")',
        'expect(#go).toBeEnabled()',
        'expect(#go).toBeDisplayed()',
        'expect(browser).toHaveUrl("https://e.example/done")',
      ]);
    }
  });

  it('runs page-object helpers against fresh lookups, toggling only when needed', async () => {
    const model = {
      pageUrl: 'https://e.example/',
      elements: [
        { name: 'email', kind: 'input', target: id('email') },
        { name: 'terms', kind: 'checkbox', target: id('terms') },
        { name: 'ariaBox', kind: 'checkbox', target: id('aria-box') },
        { name: 'country', kind: 'select', target: id('country') },
        { name: 'volume', kind: 'input', inputType: 'range', target: id('vol') },
        { name: 'go', kind: 'link', target: id('go') },
      ],
    };
    const framed = {
      ...model,
      elements: [...model.elements, { name: 'card', kind: 'input', target: frame('#pay', id('card')) }],
    };
    for (const lang of LANGS) {
      for (const m of [model, framed]) {
        let code = C.pageObject(m, FW, lang);
        if (lang === 'typescript') code = stripTypeScriptTypes(code);
        const fake = fakeWdio();
        const g = fake.globals;
        const Page = new Function(
          'browser',
          '$',
          '$$',
          stripImports(code).replace('export class', 'class') + '\nreturn HomePage;'
        )(g.browser, g.$, g.$$);
        const po = new Page();
        await po.goto();
        await po.fillEmail('a@b.c');
        await po.checkTerms();
        await po.checkTerms();
        await po.uncheckTerms();
        await po.checkAriaBox();
        await po.checkAriaBox();
        await po.uncheckAriaBox();
        await po.selectCountry('Canada');
        await po.fillVolume('9');
        await po.clickGo();
        if (m === framed) await po.fillCard('4242');
        const top = m === framed ? ['switchFrame(null)'] : [];
        const actions = fake.log.filter((l) => !l.startsWith('switchFrame'));
        expect(actions, `${lang} ${m === framed ? 'framed' : 'flat'}`).toEqual([
          'url(https://e.example/)',
          '#email.setValue("a@b.c")',
          '#terms.click()',
          '#terms.click()',
          '#aria-box.click()',
          '#aria-box.click()',
          '#country.selectByVisibleText("Canada")',
          'execute(const el = argum…, #vol, "9")',
          '#go.click()',
          ...(m === framed ? ['#card.setValue("4242")'] : []),
        ]);
        if (m === framed) {
          expect(fake.log.slice(0, 2)).toEqual([...top, 'url(https://e.example/)']);
          expect(fake.log.slice(-4)).toEqual([
            '#go.click()',
            'switchFrame(null)',
            'switchFrame(#pay)',
            '#card.setValue("4242")',
          ]);
        } else {
          expect(fake.log.some((l) => l.startsWith('switchFrame'))).toBe(false);
        }
      }
    }
  });
});
