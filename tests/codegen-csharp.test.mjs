// src/codegen-csharp.js: Playwright for .NET (Microsoft.Playwright.NUnit) and Selenium
// for C# (Selenium.WebDriver 4 + NUnit), registered on LLCodegen as plug-in targets.
// Exact-output assertions for every target kind, action, assertion, frame shape,
// escaping rule, page object and test-data variable; Selenium locators are checked
// against the Selenium Python output, so both read the same selectors. When a .NET
// SDK is available, everything is also compiled (`dotnet build`, warnings as errors)
// and the string literals are round-tripped through the C# compiler.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { csproj, runsettings, chromeWrapper, scaffold, PACKAGES } from '../scripts/e2e/runners/csharp.mjs';
import { dotnetEnv, findDotnet } from '../scripts/e2e/setup-csharp.mjs';
import * as CORPUS from './codegen-corpus.mjs';
import { helperCallSpan } from './codegen-helper-calls.mjs';

let C;
let X;
beforeAll(async () => {
  await import('../src/codegen.js');
  await import('../src/codegen-csharp.js');
  C = globalThis.LLCodegen;
  X = C._csharp;
});

const PW = (t) => C.locatorExpr(t, 'playwright', 'csharp');
const SEL = (t, rel) => C.locatorExpr(t, 'selenium', 'csharp', rel);
const pw = (step) => C.actionStatement(step, 'playwright', 'csharp');
const sel = (step) => C.actionStatement(step, 'selenium', 'csharp');

const role = (r, name, o = {}) => ({ kind: 'role', role: r, ...(name != null ? { name } : {}), ...o });
const label = (value, o = {}) => ({ kind: 'label', value, ...o });
const testid = (value, attr = 'data-testid') => ({ kind: 'testid', attr, value });
const id = (value) => ({ kind: 'id', value });

// ── Selenium parity: the Python expression, rewritten into C# syntax ─────────────
// Python and C# regular literals escape quotes and backslashes the same way, so the
// selector inside every By is decoded from the Python output and re-quoted for C#.
// Python's \xNN escapes (no-break spaces, soft hyphens) are not JSON: they become \u00NN.
const PY_BY = { XPATH: 'XPath', CSS_SELECTOR: 'CssSelector', ID: 'Id', NAME: 'Name' };
const pyString = (lit) =>
  JSON.parse(lit.replace(/\\(x([0-9a-f]{2})|.)/g, (m, e, hex) => (hex ? `\\u00${hex}` : m)));
// A Python helper call becomes Locatra.Find(root, "kind", "value", "name"?, exact:, level:, nth:).
function pyToCs(expr) {
  const span = helperCallSpan(expr, 'python');
  if (span) {
    const c = span.call;
    const args = [pyToCs(c.root), X.q(c.kind), X.q(c.value)];
    if (c.name != null) args.push(X.q(c.name));
    if (c.exact) args.push('exact: true');
    if (c.level) args.push(`level: ${c.level}`);
    if (c.nth >= 0) args.push(`nth: ${c.nth}`);
    return (
      pyToCs(expr.slice(0, span.start)) + `Locatra.Find(${args.join(', ')})` + pyToCs(expr.slice(span.end))
    );
  }
  return expr.replace(
    /(driver)?\.find_element\(By\.(XPATH|CSS_SELECTOR|ID|NAME), ("(?:[^"\\]|\\.)*")\)/g,
    (m, root, by, lit) => `${root ?? ''}.FindElement(By.${PY_BY[by]}(${X.q(pyString(lit))}))`
  );
}

describe('registration', () => {
  it('adds C# to Playwright and Selenium only', () => {
    expect(C.isValidCombo('playwright', 'csharp')).toBe(true);
    expect(C.isValidCombo('selenium', 'csharp')).toBe(true);
    expect(C.isValidCombo('cypress', 'csharp')).toBe(false);
    expect(C.languagesFor('playwright').map((l) => l.id)).toContain('csharp');
    expect(C.languagesFor('selenium').map((l) => l.id)).toContain('csharp');
    expect(C.languagesFor('cypress').map((l) => l.id)).not.toContain('csharp');
    expect(C.LANGUAGES.filter((l) => l.id === 'csharp')).toEqual([{ id: 'csharp', label: 'C#' }]);
    // No new framework: C# extends the existing two.
    expect(C.FRAMEWORKS.map((f) => f.id).slice(0, 3)).toEqual(['playwright', 'selenium', 'cypress']);
  });

  it('registers nothing (and does not throw) when codegen.js is not loaded', () => {
    const sandbox = {};
    vm.runInNewContext(readFileSync(new URL('../src/codegen-csharp.js', import.meta.url), 'utf8'), sandbox);
    expect(sandbox.LLCodegen).toBeUndefined();
    const partial = { LLCodegen: { registerTarget: () => {} } };
    vm.runInNewContext(readFileSync(new URL('../src/codegen-csharp.js', import.meta.url), 'utf8'), partial);
    expect(partial.LLCodegen._csharp).toBeUndefined();
  });

  it('downloads as .cs', () => {
    expect(C.fileExtension('csharp')).toBe('.cs');
    expect(C.pageObjectFileName({ title: 'Cart' }, 'playwright', 'csharp')).toBe('CartPage.cs');
    expect(C.pageObjectFileName({ title: 'Cart' }, 'selenium', 'csharp')).toBe('CartPage.cs');
  });

  it('leaves the built-in languages untouched', () => {
    const t = role('button', 'Go');
    expect(C.locatorExpr(t, 'playwright', 'typescript')).toBe("page.getByRole('button', { name: 'Go' })");
    expect(C.locatorExpr(t, 'selenium', 'python')).toBe('locatra_find(driver, "role", "button", "Go")');
  });
});

// ── string literals ─────────────────────────────────────────────────────────────
describe('C# string literals', () => {
  it('quotes plain text with double quotes and escapes the quote', () => {
    expect(X.q('Submit')).toBe('"Submit"');
    expect(X.q('it\'s "quoted"')).toBe('"it\'s \\"quoted\\""');
    expect(X.q('')).toBe('""');
    expect(X.q(null)).toBe('""');
    expect(X.q(undefined)).toBe('""');
    expect(X.q(42)).toBe('"42"');
  });

  it('writes a backslash-only value verbatim, doubling quotes', () => {
    expect(X.q('a\\b 😀')).toBe('@"a\\b 😀"');
    expect(X.q('a\\b')).toBe('@"a\\b"');
    expect(X.q('#a\\:b')).toBe('@"#a\\:b"');
    expect(X.q('say "\\hi"')).toBe('@"say ""\\hi"""');
  });

  it('escapes every control character, never with variable-length \\x', () => {
    expect(X.q('\0\x07\b\f\n\r\t\v')).toBe('"\\0\\a\\b\\f\\n\\r\\t\\v"');
    expect(X.q('a\x01b')).toBe('"a\\u0001b"');
    // "\x1Fa" in C# would read as one character U+1FA; \u001F cannot swallow the "a".
    expect(X.q('\x1fa')).toBe('"\\u001Fa"');
    expect(X.q('\x7f')).toBe('"\\u007F"');
    expect(X.q('\x9b')).toBe('"\\u009B"');
  });

  it('escapes the characters C# treats as line breaks', () => {
    expect(X.q('a\u0085b\u2028c\u2029d')).toBe('"a\\u0085b\\u2028c\\u2029d"');
  });

  it('escapes invisible format characters (zero-width, bidi controls, BOM)', () => {
    expect(X.q('a\u200bb')).toBe('"a\\u200Bb"');
    expect(X.q('\u202eevil')).toBe('"\\u202Eevil"');
    expect(X.q('\u2066x\u2069')).toBe('"\\u2066x\\u2069"');
    expect(X.q('\ufeff\u00ad\u061c\u180e\ufff9')).toBe('"\\uFEFF\\u00AD\\u061C\\u180E\\uFFF9"');
  });

  it('keeps printable Unicode and surrogate pairs, escapes lone surrogates', () => {
    expect(X.q('£3.50 日本語 café')).toBe('"£3.50 日本語 café"');
    expect(X.q('ok 😀')).toBe('"ok 😀"');
    expect(X.q('a\ud800b')).toBe('"a\\uD800b"');
    expect(X.q('\udc00')).toBe('"\\uDC00"');
    expect(X.q('end\ud83d')).toBe('"end\\uD83D"');
  });

  it('uses a regular literal when a backslash comes with something to escape', () => {
    expect(X.q('a\\b\nc')).toBe('"a\\\\b\\nc"');
    expect(X.q('a\\b"\u2028')).toBe('"a\\\\b\\"\\u2028"');
    expect(X.q('\\\ud800')).toBe('"\\\\\\uD800"');
  });

  it('keeps comments on one line', () => {
    expect(X.commentSafe('a\u0085b\u2028c\u2029d\ne')).toBe('a b c d e');
    expect(X.commentSafe(null)).toBe('');
  });
});

// ── Playwright locators ─────────────────────────────────────────────────────────
describe('Playwright for .NET locators', () => {
  it('renders every target kind', () => {
    expect(PW(testid('save'))).toBe('Page.GetByTestId("save")');
    expect(PW(testid('save', 'data-qa'))).toBe('Page.Locator("[data-qa=\\"save\\"]")');
    expect(PW(testid('v', 'data:qa'))).toBe('Page.Locator(@"[data\\:qa=""v""]")');
    expect(PW(role('button', 'Save'))).toBe('Page.GetByRole(AriaRole.Button, new() { Name = "Save" })');
    expect(PW(role('button', 'Save', { exact: true }))).toBe(
      'Page.GetByRole(AriaRole.Button, new() { Name = "Save", Exact = true })'
    );
    expect(PW(role('heading', 'Title', { level: 2 }))).toBe(
      'Page.GetByRole(AriaRole.Heading, new() { Name = "Title", Level = 2 })'
    );
    expect(PW(role('heading', null, { level: 3 }))).toBe(
      'Page.GetByRole(AriaRole.Heading, new() { Level = 3 })'
    );
    expect(PW(role('row'))).toBe('Page.GetByRole(AriaRole.Row)');
    expect(PW(role('row', null, { exact: true }))).toBe('Page.GetByRole(AriaRole.Row)');
    expect(PW(role('button', 'Edit', { nth: 1 }))).toBe(
      'Page.GetByRole(AriaRole.Button, new() { Name = "Edit" }).Nth(1)'
    );
    expect(PW(role('listitem', null, { nth: 0 }))).toBe('Page.GetByRole(AriaRole.Listitem).Nth(0)');
    expect(PW(role('button', 'X', { nth: -1 }))).toBe(
      'Page.GetByRole(AriaRole.Button, new() { Name = "X" })'
    );
    expect(PW(role('button', 'X', { nth: 1.5 }))).toBe(
      'Page.GetByRole(AriaRole.Button, new() { Name = "X" })'
    );
    expect(PW(label('Email'))).toBe('Page.GetByLabel("Email")');
    expect(PW(label('Email', { exact: true }))).toBe('Page.GetByLabel("Email", new() { Exact = true })');
    expect(PW({ kind: 'placeholder', value: 'Search' })).toBe('Page.GetByPlaceholder("Search")');
    expect(PW({ kind: 'placeholder', value: 'Search', exact: true })).toBe(
      'Page.GetByPlaceholder("Search", new() { Exact = true })'
    );
    expect(PW({ kind: 'altText', value: 'Logo' })).toBe('Page.GetByAltText("Logo")');
    expect(PW({ kind: 'altText', value: 'Logo', exact: true })).toBe(
      'Page.GetByAltText("Logo", new() { Exact = true })'
    );
    expect(PW({ kind: 'title', value: 'Close' })).toBe('Page.GetByTitle("Close")');
    expect(PW({ kind: 'title', value: 'Close', exact: true })).toBe(
      'Page.GetByTitle("Close", new() { Exact = true })'
    );
    expect(PW({ kind: 'text', value: 'Welcome' })).toBe('Page.GetByText("Welcome")');
    expect(PW({ kind: 'text', value: 'Welcome', exact: true })).toBe(
      'Page.GetByText("Welcome", new() { Exact = true })'
    );
    expect(PW(id('main'))).toBe('Page.Locator("#main")');
    expect(PW(id('a:b'))).toBe('Page.Locator(@"#a\\:b")');
    expect(PW(id('1st'))).toBe('Page.Locator(@"#\\31 st")');
    expect(PW({ kind: 'name', value: 'q' })).toBe('Page.Locator("[name=\\"q\\"]")');
    expect(PW({ kind: 'name', value: 'a"b' })).toBe('Page.Locator(@"[name=""a\\""b""]")');
    expect(PW({ kind: 'css', value: 'form > button' })).toBe('Page.Locator("form > button")');
    expect(PW({ kind: 'css' })).toBe('Page.Locator("body")');
    expect(PW({ kind: 'mystery', value: '.x' })).toBe('Page.Locator(".x")');
    expect(PW(null)).toBe('');
  });

  it('maps every ARIA role to its AriaRole member', () => {
    expect(PW(role('columnheader'))).toBe('Page.GetByRole(AriaRole.Columnheader)');
    expect(PW(role('menuitemcheckbox', 'Bold'))).toBe(
      'Page.GetByRole(AriaRole.Menuitemcheckbox, new() { Name = "Bold" })'
    );
    expect(PW(role('IMG', 'Logo'))).toBe('Page.GetByRole(AriaRole.Img, new() { Name = "Logo" })');
    for (const r of X.ARIA_ROLES) {
      expect(PW(role(r))).toBe(`Page.GetByRole(AriaRole.${r[0].toUpperCase()}${r.slice(1)})`);
    }
  });

  // The selector Playwright's own GetByRole() builds (as the Java target writes it).
  it('falls back to the internal:role selector for a role AriaRole lacks', () => {
    expect(PW(role('mark'))).toBe('Page.Locator("internal:role=mark")');
    expect(PW(role('x-widget', 'Go "x"', { nth: 2, exact: true, level: 3 }))).toBe(
      'Page.Locator(@"internal:role=x-widget[name=""Go \\""x\\""""s][level=3]").Nth(2)'
    );
    expect(PW(role('x-widget', 'Go'))).toBe('Page.Locator("internal:role=x-widget[name=\\"Go\\"i]")');
    expect(PW({ kind: 'role' })).toBe('Page.Locator("internal:role=")');
    expect(PW({ kind: 'xpath', value: '//a[@id="x"]' })).toBe('Page.Locator("xpath=//a[@id=\\"x\\"]")');
  });

  it('escapes hostile values in every literal', () => {
    expect(PW(role('button', 'Delete "row"\n2'))).toBe(
      'Page.GetByRole(AriaRole.Button, new() { Name = "Delete \\"row\\"\\n2" })'
    );
    expect(PW(label('C:\\path'))).toBe('Page.GetByLabel(@"C:\\path")');
    expect(PW({ kind: 'text', value: 'tab\there' })).toBe('Page.GetByText("tab\\there")');
  });

  it('continues a chain from its parent', () => {
    expect(PW({ kind: 'chain', parent: testid('row-2'), child: role('button', 'Delete') })).toBe(
      'Page.GetByTestId("row-2").GetByRole(AriaRole.Button, new() { Name = "Delete" })'
    );
    expect(
      PW({
        kind: 'chain',
        parent: { kind: 'css', value: 'table' },
        child: {
          kind: 'chain',
          parent: role('row', 'Ada'),
          child: { kind: 'text', value: 'Edit', exact: true },
        },
      })
    ).toBe(
      'Page.Locator("table").GetByRole(AriaRole.Row, new() { Name = "Ada" }).GetByText("Edit", new() { Exact = true })'
    );
    expect(PW({ kind: 'chain', parent: null, child: role('button', 'Go') })).toBe(
      'Page.GetByRole(AriaRole.Button, new() { Name = "Go" })'
    );
    expect(PW({ kind: 'chain', parent: testid('p') })).toBe('Page.GetByTestId("p")');
    // A chain into a frame continues through FrameLocator too.
    expect(
      PW({
        kind: 'chain',
        parent: testid('shell'),
        child: { kind: 'frame', selector: 'iframe', index: 0, child: id('x') },
      })
    ).toBe('Page.GetByTestId("shell").FrameLocator("iframe").Locator("#x")');
  });

  it('enters frames with FrameLocator, positionally when cross-origin, nested', () => {
    const inner = label('Card number');
    expect(PW({ kind: 'frame', selector: '#pay', index: 0, child: inner })).toBe(
      'Page.FrameLocator("#pay").GetByLabel("Card number")'
    );
    expect(PW({ kind: 'frame', selector: null, index: 2, child: inner })).toBe(
      'Page.FrameLocator("iframe >> nth=2").GetByLabel("Card number")'
    );
    expect(PW({ kind: 'frame', selector: null, child: inner })).toBe(
      'Page.FrameLocator("iframe >> nth=0").GetByLabel("Card number")'
    );
    expect(
      PW({
        kind: 'frame',
        selector: '#outer',
        index: 0,
        child: { kind: 'frame', selector: null, index: 1, child: inner },
      })
    ).toBe('Page.FrameLocator("#outer").FrameLocator("iframe >> nth=1").GetByLabel("Card number")');
    expect(PW({ kind: 'frame', selector: '#f', index: 0 })).toBe('');
  });

  it("keeps using the frame's selector when it sits in shadow DOM (Playwright's CSS pierces it)", () => {
    const t = {
      kind: 'frame',
      selector: '#shell > x-pay > iframe',
      index: 1,
      shadowPath: ['#shell', 'x-pay', 'iframe'],
      child: id('card'),
    };
    expect(PW(t)).toBe('Page.FrameLocator("#shell > x-pay > iframe").Locator("#card")');
  });
});

// ── Playwright statements ───────────────────────────────────────────────────────
describe('Playwright for .NET statements', () => {
  const t = label('Email');
  const L = 'Page.GetByLabel("Email")';

  it('renders every action with await and an *Async call', () => {
    expect(pw({ action: 'goto', value: 'https://x.example/' })).toBe(
      'await Page.GotoAsync("https://x.example/");'
    );
    expect(pw({ action: 'goto', url: 'https://y.example/' })).toBe(
      'await Page.GotoAsync("https://y.example/");'
    );
    expect(pw({ action: 'goto' })).toBe('await Page.GotoAsync("");');
    expect(pw({ action: 'click', target: t })).toBe(`await ${L}.ClickAsync();`);
    expect(pw({ action: 'dblclick', target: t })).toBe(`await ${L}.DblClickAsync();`);
    expect(pw({ action: 'hover', target: t })).toBe(`await ${L}.HoverAsync();`);
    expect(pw({ action: 'check', target: t })).toBe(`await ${L}.CheckAsync();`);
    expect(pw({ action: 'uncheck', target: t })).toBe(`await ${L}.UncheckAsync();`);
    expect(pw({ action: 'fill', target: t, value: 'ada@example.com' })).toBe(
      `await ${L}.FillAsync("ada@example.com");`
    );
    expect(pw({ action: 'fill', target: t, value: '' })).toBe(`await ${L}.FillAsync("");`);
    expect(pw({ action: 'selectOption', target: t, value: 'Ireland' })).toBe(
      `await ${L}.SelectOptionAsync("Ireland");`
    );
    expect(pw({ action: 'press', value: 'Shift+Tab' })).toBe('await Page.Keyboard.PressAsync("Shift+Tab");');
    expect(pw({ action: 'press', key: 'Escape' })).toBe('await Page.Keyboard.PressAsync("Escape");');
    expect(pw({ action: 'press' })).toBe('await Page.Keyboard.PressAsync("Enter");');
    expect(pw({ action: 'viewport', value: '1280x800' })).toBe('await Page.SetViewportSizeAsync(1280, 800);');
    expect(pw({ action: 'viewport', width: 390, height: 844, value: '1x1' })).toBe(
      'await Page.SetViewportSizeAsync(390, 844);'
    );
    expect(pw({ action: 'viewport', value: 'junk' })).toBe('await Page.SetViewportSizeAsync(1280, 720);');
  });

  it('sets range / colour / date inputs with FillAsync too', () => {
    for (const inputType of ['range', 'color', 'date', 'time']) {
      expect(pw({ action: 'fill', target: t, value: '5', inputType })).toBe(`await ${L}.FillAsync("5");`);
    }
  });

  it('reads a sensitive value from the environment, never the literal', () => {
    const out = pw({ action: 'fill', target: t, value: 'hunter2', sensitive: true, secretName: 'MY_SECRET' });
    expect(out).toBe(`await ${L}.FillAsync(Environment.GetEnvironmentVariable("MY_SECRET") ?? "");`);
    expect(pw({ action: 'fill', target: t, sensitive: true, secretName: 'bad name;' })).toBe(
      `await ${L}.FillAsync(Environment.GetEnvironmentVariable("LOCATRA_PASSWORD") ?? "");`
    );
  });

  it('uploads files with a path note', () => {
    expect(pw({ action: 'upload', target: t, value: '["a.txt","b c.pdf"]' })).toBe(
      '// NOTE: these file paths must exist relative to where the test runs\n' +
        `await ${L}.SetInputFilesAsync(new[] { "a.txt", "b c.pdf" });`
    );
    expect(pw({ action: 'upload', target: t, value: 'one.pdf' })).toBe(
      '// NOTE: these file paths must exist relative to where the test runs\n' +
        `await ${L}.SetInputFilesAsync(new[] { "one.pdf" });`
    );
    expect(pw({ action: 'upload', target: t, value: '' })).toBe(
      '// NOTE: these file paths must exist relative to where the test runs\n' +
        `await ${L}.SetInputFilesAsync(new string[0]);`
    );
    expect(pw({ action: 'upload', target: t, value: ['C:\\x.txt'] })).toContain('new[] { @"C:\\x.txt" }');
  });

  it('renders every assertion with Expect', () => {
    const a = (assertType, value) => pw({ action: 'assert', assertType, target: t, value });
    expect(a('toBeVisible')).toBe(`await Expect(${L}).ToBeVisibleAsync();`);
    expect(a(undefined)).toBe(`await Expect(${L}).ToBeVisibleAsync();`);
    expect(a('toBeSomethingNew')).toBe(`await Expect(${L}).ToBeVisibleAsync();`);
    expect(a('toHaveText', 'Ada  Lovelace')).toBe(
      `await Expect(${L}).ToHaveTextAsync("Ada  Lovelace", new() { UseInnerText = true });`
    );
    expect(a('toContainText', 'Ada')).toBe(
      `await Expect(${L}).ToContainTextAsync("Ada", new() { UseInnerText = true });`
    );
    expect(a('toHaveValue', 'x"y')).toBe(`await Expect(${L}).ToHaveValueAsync("x\\"y");`);
    expect(a('toBeEnabled')).toBe(`await Expect(${L}).ToBeEnabledAsync();`);
    expect(a('toBeChecked', 'true')).toBe(`await Expect(${L}).ToBeCheckedAsync();`);
    expect(a('toBeChecked', '')).toBe(`await Expect(${L}).ToBeCheckedAsync();`);
    expect(a('toBeChecked', 'false')).toBe(`await Expect(${L}).Not.ToBeCheckedAsync();`);
    expect(a('toBeChecked', false)).toBe(`await Expect(${L}).Not.ToBeCheckedAsync();`);
  });

  it('asserts the page URL without a target', () => {
    expect(pw({ action: 'assert', assertType: 'toHaveURL', value: 'https://x.example/done' })).toBe(
      'await Expect(Page).ToHaveURLAsync("https://x.example/done");'
    );
    expect(
      pw({ action: 'assert', assertType: 'toHaveURL', value: '', url: 'https://x.example/u', target: t })
    ).toBe('await Expect(Page).ToHaveURLAsync("https://x.example/u");');
    expect(pw({ action: 'assert', assertType: 'toHaveURL' })).toBe('await Expect(Page).ToHaveURLAsync("");');
  });

  it('leaves unknown and locator-less steps to the core TODOs', () => {
    expect(pw({ action: 'teleport', target: t })).toBe('// TODO: unsupported step "teleport"');
    expect(pw({ action: 'click' })).toBe('// TODO: "click" step has no element locator');
    expect(pw({ action: 'click', target: { kind: 'frame', selector: '#f' } })).toBe(
      '// TODO: "click" step has no element locator'
    );
    // Reached only by calling the target directly: still a comment, never a throw.
    expect(X.targets.playwright.actionStatement({ action: 'zap\nnow', target: t })).toBe(
      '// TODO: unsupported step "zap now"'
    );
  });
});

// ── Selenium locators ───────────────────────────────────────────────────────────
describe('Selenium for C# locators', () => {
  const TARGETS = [
    testid('save'),
    testid('v', 'data:qa'),
    testid('a"b', 'data-qa'),
    role('button'),
    role('heading', null, { level: 2 }),
    role('button', 'Save'),
    role('button', 'Save', { exact: true }),
    role('heading', 'Title', { level: 1 }),
    role('button', 'Edit', { nth: 1 }),
    role('listitem', null, { nth: 0 }),
    role('img', 'Logo'),
    role('textbox', 'Delete "row" it\'s'),
    label('Email'),
    label('Email', { exact: true }),
    { kind: 'placeholder', value: 'Search "all"' },
    { kind: 'placeholder', value: 'Search', exact: true },
    { kind: 'altText', value: 'Logo' },
    { kind: 'altText', value: 'Logo', exact: true },
    { kind: 'title', value: 'Close' },
    { kind: 'title', value: 'Close', exact: true },
    { kind: 'text', value: 'Welcome  back' },
    { kind: 'text', value: 'Welcome', exact: true },
    id('main'),
    id('a:b'),
    { kind: 'name', value: 'field"name' },
    { kind: 'css', value: 'form > button' },
    { kind: 'css' },
    { kind: 'chain', parent: testid('row-2'), child: role('button', 'Delete') },
    { kind: 'chain', parent: { kind: 'css', value: 'table' }, child: { kind: 'text', value: 'Go' } },
    { kind: 'chain', parent: role('row', 'Ada'), child: label('Qty') },
    { kind: 'chain', parent: null, child: role('button', 'Go') },
    { kind: 'chain', parent: testid('p') },
    { kind: 'xpath', value: '//a[@title="it\'s"]' },
    { kind: 'chain', parent: testid('row'), child: { kind: 'xpath', value: '//td[2]' } },
  ];

  it('emits exactly the selectors Selenium JS/Python emit', () => {
    for (const t of TARGETS) {
      expect(SEL(t), JSON.stringify(t)).toBe(pyToCs(C.locatorExpr(t, 'selenium', 'python')));
      // As a chained child (rel). A chain's own parent is the one exception, below.
      if (t.kind !== 'chain') {
        expect(SEL(t, true), JSON.stringify(t)).toBe(pyToCs(C.locatorExpr(t, 'selenium', 'python', true)));
      }
    }
  });

  // Each part of a nested chain is rooted at the one before it.
  it('keeps a nested chain scoped to its outer parent', () => {
    const t = {
      kind: 'chain',
      parent: testid('table'),
      child: { kind: 'chain', parent: role('row', 'Ada'), child: { kind: 'text', value: 'Edit' } },
    };
    expect(SEL(t)).toBe(
      'Locatra.Find(Locatra.Find(driver.FindElement(By.CssSelector("[data-testid=\\"table\\"]")), "role", "row", "Ada"), "text", "Edit")'
    );
  });

  it('spells By the .NET way', () => {
    expect(SEL(testid('save'))).toBe('driver.FindElement(By.CssSelector("[data-testid=\\"save\\"]"))');
    expect(SEL(id('main'))).toBe('driver.FindElement(By.Id("main"))');
    expect(SEL({ kind: 'name', value: 'q' })).toBe('driver.FindElement(By.Name("q"))');
    expect(SEL({ kind: 'xpath', value: '//td' })).toBe('driver.FindElement(By.XPath("//td"))');
    // Role, label and text targets call the Locatra helper class (C9.4).
    expect(SEL(role('row'))).toBe('Locatra.Find(driver, "role", "row", nth: 0)');
    expect(SEL({ kind: 'text', value: 'Go', exact: true })).toBe(
      'Locatra.Find(driver, "text", "Go", exact: true)'
    );
    expect(SEL(role('heading', 'T', { level: 2 }))).toBe(
      'Locatra.Find(driver, "role", "heading", "T", level: 2)'
    );
    expect(SEL(id('a:b'))).toBe('driver.FindElement(By.Id("a:b"))');
    expect(SEL(null)).toBe('');
  });

  it('roots a chained child at its parent (an XPath child with a leading dot)', () => {
    expect(SEL({ kind: 'chain', parent: testid('row'), child: { kind: 'text', value: 'Go' } })).toBe(
      'Locatra.Find(driver.FindElement(By.CssSelector("[data-testid=\\"row\\"]")), "text", "Go")'
    );
    expect(SEL({ kind: 'chain', parent: testid('row'), child: { kind: 'xpath', value: '//td' } })).toBe(
      'driver.FindElement(By.CssSelector("[data-testid=\\"row\\"]")).FindElement(By.XPath(".//td"))'
    );
  });

  it("renders a frame target's inner element (switching is a statement)", () => {
    expect(SEL({ kind: 'frame', selector: '#f', index: 0, child: id('x') })).toBe(
      'driver.FindElement(By.Id("x"))'
    );
    expect(
      SEL({
        kind: 'frame',
        selector: '#f',
        index: 0,
        child: {
          kind: 'chain',
          parent: { kind: 'css', value: 'table' },
          child: { kind: 'text', value: 'Go' },
        },
      })
    ).toBe(
      pyToCs(
        C.locatorExpr(
          { kind: 'chain', parent: { kind: 'css', value: 'table' }, child: { kind: 'text', value: 'Go' } },
          'selenium',
          'python'
        )
      )
    );
    expect(SEL({ kind: 'frame', selector: '#f', index: 0 })).toBe('');
  });
});

// ── Selenium statements ─────────────────────────────────────────────────────────
describe('Selenium for C# statements', () => {
  const t = id('f');
  const L = 'driver.FindElement(By.Id("f"))';
  const CHECKED = '(el.Selected || el.GetDomAttribute("aria-checked") == "true")';

  it('renders navigation, clicks and hovers', () => {
    expect(sel({ action: 'goto', value: 'https://x.example/' })).toBe(
      'driver.Navigate().GoToUrl("https://x.example/");'
    );
    expect(sel({ action: 'goto', url: 'https://y.example/' })).toBe(
      'driver.Navigate().GoToUrl("https://y.example/");'
    );
    expect(sel({ action: 'goto' })).toBe('driver.Navigate().GoToUrl("");');
    expect(sel({ action: 'click', target: t })).toBe(`${L}.Click();`);
    expect(sel({ action: 'hover', target: t })).toBe(`new Actions(driver).MoveToElement(${L}).Perform();`);
    expect(sel({ action: 'dblclick', target: t })).toBe(`new Actions(driver).DoubleClick(${L}).Perform();`);
  });

  it('checks and unchecks only when the state differs (native and ARIA)', () => {
    expect(sel({ action: 'check', target: t })).toBe(
      `{\n    var el = ${L};\n    if (!${CHECKED}) el.Click();\n}`
    );
    expect(sel({ action: 'uncheck', target: t })).toBe(
      `{\n    var el = ${L};\n    if ${CHECKED} el.Click();\n}`
    );
  });

  it('clears before typing, and sets value-only input types through the native setter', () => {
    expect(sel({ action: 'fill', target: t, value: 'Ada' })).toBe(
      `{\n    var el = ${L};\n    el.Clear();\n    el.SendKeys("Ada");\n}`
    );
    for (const inputType of ['range', 'color', 'date', 'time', 'datetime-local', 'month', 'week']) {
      expect(sel({ action: 'fill', target: t, value: '2024-01-31', inputType })).toBe(
        `((IJavaScriptExecutor)driver).ExecuteScript(LocatraSetValueJs, ${L}, "2024-01-31");`
      );
    }
    expect(sel({ action: 'fill', target: t, value: 'x', inputType: 'text' })).toContain('el.SendKeys("x");');
  });

  it('reads a sensitive value from the environment', () => {
    expect(sel({ action: 'fill', target: t, value: 'pw', sensitive: true })).toBe(
      `{\n    var el = ${L};\n    el.Clear();\n    el.SendKeys(Environment.GetEnvironmentVariable("LOCATRA_PASSWORD") ?? "");\n}`
    );
    expect(sel({ action: 'fill', target: t, sensitive: true, secretName: 'PIN', inputType: 'range' })).toBe(
      `((IJavaScriptExecutor)driver).ExecuteScript(LocatraSetValueJs, ${L}, Environment.GetEnvironmentVariable("PIN") ?? "");`
    );
  });

  it('selects by visible text and uploads absolute paths', () => {
    expect(sel({ action: 'selectOption', target: t, value: 'Ireland' })).toBe(
      `new SelectElement(${L}).SelectByText("Ireland");`
    );
    expect(sel({ action: 'upload', target: t, value: ['a.txt', 'b.txt'] })).toBe(
      '// NOTE: these file paths must exist relative to where the test runs\n' +
        `${L}.SendKeys(string.Join("\\n", new[] { "a.txt", "b.txt" }.Select(Path.GetFullPath)));`
    );
    expect(sel({ action: 'upload', target: t, value: [] })).toBe(`${L}.Clear();`);
    expect(sel({ action: 'upload', target: t, value: '' })).toBe(`${L}.Clear();`);
  });

  it('sizes the window to the recorded viewport plus the browser chrome', () => {
    expect(sel({ action: 'viewport', value: '1280x800' })).toBe(
      [
        '{',
        '    var js = (IJavaScriptExecutor)driver;',
        '    var width = Convert.ToInt32(js.ExecuteScript("return 1280 + window.outerWidth - window.innerWidth;"));',
        '    var height = Convert.ToInt32(js.ExecuteScript("return 800 + window.outerHeight - window.innerHeight;"));',
        '    driver.Manage().Window.Size = new Size(width, height);',
        '}',
      ].join('\n')
    );
    expect(sel({ action: 'viewport' })).toContain('return 1280 + window.outerWidth');
    expect(sel({ action: 'viewport' })).toContain('return 720 + window.outerHeight');
  });

  it('presses keys and modifier combos through Actions', () => {
    const p = (value) => sel({ action: 'press', value });
    expect(p('Enter')).toBe('new Actions(driver).SendKeys(Keys.Enter).Perform();');
    expect(p('')).toBe('new Actions(driver).SendKeys(Keys.Enter).Perform();');
    expect(sel({ action: 'press', key: 'Tab' })).toBe('new Actions(driver).SendKeys(Keys.Tab).Perform();');
    expect(p('Shift+Tab')).toBe(
      'new Actions(driver).KeyDown(Keys.Shift).SendKeys(Keys.Tab).KeyUp(Keys.Shift).Perform();'
    );
    expect(p('Control+Alt+Shift+Meta+Enter')).toBe(
      'new Actions(driver).KeyDown(Keys.Control).KeyDown(Keys.Alt).KeyDown(Keys.Shift).KeyDown(Keys.Meta)\n' +
        '    .SendKeys(Keys.Enter).KeyUp(Keys.Meta).KeyUp(Keys.Shift).KeyUp(Keys.Alt).KeyUp(Keys.Control).Perform();'
    );
    expect(p('Control++')).toBe(
      'new Actions(driver).KeyDown(Keys.Control).SendKeys("+").KeyUp(Keys.Control).Perform();'
    );
    expect(p('+')).toBe('new Actions(driver).SendKeys("+").Perform();');
    expect(p(' ')).toBe('new Actions(driver).SendKeys(Keys.Space).Perform();');
    expect(p('Shift+Space')).toBe(
      'new Actions(driver).KeyDown(Keys.Shift).SendKeys(Keys.Space).KeyUp(Keys.Shift).Perform();'
    );
    expect(p('a')).toBe('new Actions(driver).SendKeys("a").Perform();');
    expect(p('"')).toBe('new Actions(driver).SendKeys("\\"").Perform();');
    expect(p('\\')).toBe('new Actions(driver).SendKeys(@"\\").Perform();');
    expect(p('😀')).toBe('new Actions(driver).SendKeys("😀").Perform();');
    const named = {
      Escape: 'Escape',
      Backspace: 'Backspace',
      Delete: 'Delete',
      ArrowUp: 'ArrowUp',
      ArrowDown: 'ArrowDown',
      ArrowLeft: 'ArrowLeft',
      ArrowRight: 'ArrowRight',
      Space: 'Space',
      Home: 'Home',
      End: 'End',
      PageUp: 'PageUp',
      PageDown: 'PageDown',
      Insert: 'Insert',
      F1: 'F1',
      F12: 'F12',
    };
    for (const [key, member] of Object.entries(named)) {
      expect(p(key)).toBe(`new Actions(driver).SendKeys(Keys.${member}).Perform();`);
    }
  });

  it('never turns an unknown key or modifier into a different key', () => {
    expect(sel({ action: 'press', value: 'MediaPlay' })).toBe(
      '// TODO: press "MediaPlay" — no Selenium key mapping'
    );
    expect(sel({ action: 'press', value: 'Hyper+a' })).toBe(
      '// TODO: press "Hyper+a" — modifier not supported'
    );
    expect(sel({ action: 'press', value: 'F13' })).toBe('// TODO: press "F13" — no Selenium key mapping');
  });

  it('renders every assertion with NUnit constraints, normalising text like Playwright', () => {
    const a = (assertType, value) => sel({ action: 'assert', assertType, target: t, value });
    const TEXT = `Regex.Replace(Regex.Replace(${L}.Text, @"[\\u00AD\\u200B]", ""), @"\\s+", " ").Trim()`;
    expect(a('toBeVisible')).toBe(`Assert.That(${L}.Displayed, Is.True);`);
    expect(a(undefined)).toBe(`Assert.That(${L}.Displayed, Is.True);`);
    expect(a('toBeSomethingNew')).toBe(`Assert.That(${L}.Displayed, Is.True);`);
    expect(a('toHaveText', '  Ada \n Lovelace ')).toBe(`Assert.That(${TEXT}, Is.EqualTo("Ada Lovelace"));`);
    expect(a('toContainText', ' a \n b ')).toBe(`Assert.That(${TEXT}, Does.Contain("a b"));`);
    expect(a('toHaveValue', 'Ireland')).toBe(
      `Assert.That(${L}.GetDomProperty("value"), Is.EqualTo("Ireland"));`
    );
    expect(a('toBeEnabled')).toBe(`Assert.That(${L}.Enabled, Is.True);`);
    expect(a('toBeChecked', 'true')).toBe(`{\n    var el = ${L};\n    Assert.That(${CHECKED}, Is.True);\n}`);
    expect(a('toBeChecked', 'false')).toBe(
      `{\n    var el = ${L};\n    Assert.That(${CHECKED}, Is.False);\n}`
    );
  });

  it('waits for the page URL', () => {
    expect(sel({ action: 'assert', assertType: 'toHaveURL', value: 'https://x.example/done' })).toBe(
      'new WebDriverWait(driver, TimeSpan.FromSeconds(10)).Until(d => d.Url == "https://x.example/done");'
    );
    // A target (even a framed one) is ignored: the URL is the page's.
    expect(
      sel({
        action: 'assert',
        assertType: 'toHaveURL',
        url: 'https://x.example/u',
        target: { kind: 'frame', selector: '#f', index: 0, child: t },
      })
    ).toBe('new WebDriverWait(driver, TimeSpan.FromSeconds(10)).Until(d => d.Url == "https://x.example/u");');
  });

  it('notes an unnamed role locator that may match several elements', () => {
    expect(sel({ action: 'click', target: role('button') })).toBe(
      '// NOTE: this role locator has no accessible name and may match several elements; the first match is used.\n' +
        'Locatra.Find(driver, "role", "button", nth: 0).Click();'
    );
    expect(sel({ action: 'click', target: role('button', null, { matchCount: 1 }) })).not.toContain('NOTE');
    expect(sel({ action: 'click', target: role('button', null, { unique: true }) })).not.toContain('NOTE');
    expect(sel({ action: 'click', target: role('button', null, { nth: 0 }) })).not.toContain('NOTE');
    expect(
      sel({ action: 'click', target: { kind: 'chain', parent: testid('row'), child: role('button') } })
    ).toContain('// NOTE: this role locator has no accessible name');
  });

  it('leaves unknown and locator-less steps to the core TODOs', () => {
    expect(sel({ action: 'teleport', target: t })).toBe('// TODO: unsupported step "teleport"');
    expect(sel({ action: 'fill', value: 'x' })).toBe('// TODO: "fill" step has no element locator');
    expect(X.targets.selenium.actionStatement({ action: 'zap', target: t })).toBe(
      '// TODO: unsupported step "zap"'
    );
  });
});

// ── Selenium frames ─────────────────────────────────────────────────────────────
describe('Selenium for C# frames', () => {
  const inner = id('card');
  const fill = (target) => sel({ action: 'fill', target, value: '4242' });
  const FILL =
    '{\n    var el = driver.FindElement(By.Id("card"));\n    el.Clear();\n    el.SendKeys("4242");\n}';

  it('switches in by selector, acts, and switches back', () => {
    expect(fill({ kind: 'frame', selector: '#pay', index: 0, child: inner })).toBe(
      'driver.SwitchTo().Frame(driver.FindElement(By.CssSelector("#pay")));\n' +
        FILL +
        '\ndriver.SwitchTo().DefaultContent();'
    );
  });

  it('addresses a cross-origin frame by index', () => {
    expect(fill({ kind: 'frame', selector: null, index: 2, child: inner })).toBe(
      'driver.SwitchTo().Frame((IWebElement)((IJavaScriptExecutor)driver).ExecuteScript(LocatraFrameJs, 2)!);\n' +
        FILL +
        '\ndriver.SwitchTo().DefaultContent();'
    );
    expect(fill({ kind: 'frame', child: inner }).split('\n')[0]).toBe(
      'driver.SwitchTo().Frame((IWebElement)((IJavaScriptExecutor)driver).ExecuteScript(LocatraFrameJs, 0)!);'
    );
  });

  it('walks each shadow root with GetShadowRoot() before switching', () => {
    const SHADOW = {
      kind: 'frame',
      selector: '#shell > x-pay > iframe:nth-of-type(2)',
      index: 1,
      shadowPath: ['#shell', 'x-pay', 'iframe:nth-of-type(2)'],
      child: inner,
    };
    expect(fill(SHADOW)).toBe(
      'driver.SwitchTo().Frame(driver.FindElement(By.CssSelector("#shell")).GetShadowRoot()' +
        '.FindElement(By.CssSelector("x-pay")).GetShadowRoot().FindElement(By.CssSelector("iframe:nth-of-type(2)")));\n' +
        FILL +
        '\ndriver.SwitchTo().DefaultContent();'
    );
    const nested = { kind: 'frame', selector: '#outer', index: 0, child: SHADOW };
    const lines = fill(nested).split('\n');
    expect(lines[0]).toBe('driver.SwitchTo().Frame(driver.FindElement(By.CssSelector("#outer")));');
    expect(lines[1]).toContain('.GetShadowRoot().FindElement(By.CssSelector("x-pay"))');
    expect(lines[lines.length - 1]).toBe('driver.SwitchTo().DefaultContent();');
    expect(lines.filter((l) => l.includes('SwitchTo().Frame('))).toHaveLength(2);
    // Every hop is quoted for C#.
    expect(fill({ ...SHADOW, shadowPath: ['pay-widget[title="it\'s"]', 'iframe'] })).toContain(
      'driver.FindElement(By.CssSelector("pay-widget[title=\\"it\'s\\"]")).GetShadowRoot()'
    );
  });

  it('ignores an unusable shadowPath, exactly like the other targets', () => {
    const bare = { kind: 'frame', selector: 'x-pay iframe', index: 1, child: inner };
    for (const bad of [undefined, null, [], ['iframe'], ['#shell', ''], ['#shell', 3], 'x-pay iframe']) {
      expect(fill({ ...bare, shadowPath: bad })).toBe(fill(bare));
      expect(pw({ action: 'fill', target: { ...bare, shadowPath: bad }, value: '1' })).toBe(
        pw({ action: 'fill', target: bare, value: '1' })
      );
    }
    expect(
      fill({ kind: 'frame', selector: null, index: 3, shadowPath: ['a-b', 'iframe'], child: inner })
    ).toContain(
      'driver.SwitchTo().Frame((IWebElement)((IJavaScriptExecutor)driver).ExecuteScript(LocatraFrameJs, 3)!);'
    );
  });

  it('keeps notes and multi-line statements inside the frame', () => {
    const out = sel({
      action: 'click',
      target: { kind: 'frame', selector: '#f', index: 0, child: role('row') },
    });
    expect(out.split('\n')).toEqual([
      'driver.SwitchTo().Frame(driver.FindElement(By.CssSelector("#f")));',
      '// NOTE: this role locator has no accessible name and may match several elements; the first match is used.',
      'Locatra.Find(driver, "role", "row", nth: 0).Click();',
      'driver.SwitchTo().DefaultContent();',
    ]);
  });
});

// ── test files ──────────────────────────────────────────────────────────────────
// The core routes its own TODOs (unknown action, no locator) through the target's
// todo(), so they are sanitised for C#: U+0085 / U+2028 / U+2029 end a C# comment.
describe('TODO comments', () => {
  it('keeps core TODOs on one C# line in both frameworks', () => {
    for (const fw of ['playwright', 'selenium']) {
      expect(C.actionStatement({ action: 'zap\u0085now\u2028or\u2029never' }, fw, 'csharp')).toBe(
        '// TODO: unsupported step "zap now or never"'
      );
      expect(C.actionStatement({ action: 'fill', value: 'x' }, fw, 'csharp')).toBe(
        '// TODO: "fill" step has no element locator'
      );
      expect(
        C.actionStatement(
          { action: 'check', target: { kind: 'frame', selector: '#f', index: 0 } },
          fw,
          'csharp'
        )
      ).toBe('// TODO: "check" step has no element locator');
      const def = X.targets[fw];
      expect(def.todo('a\nb\u0085c\x00d\x7fe', 'csharp')).toBe('// TODO: a b c d e');
      expect(def.todo(null)).toBe('// TODO: ');
    }
  });
});

describe('test file scaffolds', () => {
  it('wraps Playwright statements in a PageTest fixture', () => {
    expect(C.wrapScript(['await Page.GotoAsync("https://x.example/");'], 'playwright', 'csharp')).toBe(
      [
        'using System.Threading.Tasks;',
        'using Microsoft.Playwright;',
        'using Microsoft.Playwright.NUnit;',
        'using NUnit.Framework;',
        '',
        '[Parallelizable(ParallelScope.Self)]',
        '[TestFixture]',
        'public class RecordedTest : PageTest',
        '{',
        '    [Test]',
        '    public async Task RecordedFlow()',
        '    {',
        '        await Page.GotoAsync("https://x.example/");',
        '    }',
        '}',
        '',
      ].join('\n')
    );
  });

  it('wraps Selenium statements in a ChromeDriver session that always quits', () => {
    expect(C.wrapScript(['driver.Navigate().GoToUrl("https://x.example/");'], 'selenium', 'csharp')).toBe(
      [
        'using System;',
        'using NUnit.Framework;',
        'using OpenQA.Selenium;',
        'using OpenQA.Selenium.Chrome;',
        '',
        '[TestFixture]',
        'public class RecordedTest',
        '{',
        '    [Test]',
        '    public void RecordedFlow()',
        '    {',
        '        IWebDriver driver = new ChromeDriver();',
        '        // Selenium has no auto-wait; give elements time to appear',
        '        driver.Manage().Timeouts().ImplicitWait = TimeSpan.FromSeconds(10);',
        '        try',
        '        {',
        '            driver.Navigate().GoToUrl("https://x.example/");',
        '        }',
        '        finally',
        '        {',
        '            driver.Quit();',
        '        }',
        '    }',
        '}',
        '',
      ].join('\n')
    );
  });

  it('produces complete files for an empty recording', () => {
    expect(C.testScript([], 'playwright', 'csharp')).toContain(
      '    public async Task RecordedFlow()\n    {\n    }\n'
    );
    expect(C.testScript(null, 'selenium', 'csharp')).toContain(
      '        try\n        {\n        }\n        finally'
    );
    expect(C.wrapScript(undefined, 'playwright', 'csharp')).toContain('RecordedFlow()');
    expect(X.targets.playwright.wrapScript(undefined, 'csharp')).toContain('    {\n    }\n}\n');
    expect(X.targets.selenium.wrapScript(null, 'csharp')).toContain('        {\n        }\n        finally');
  });

  it('indents every physical line of multi-line statements', () => {
    const code = C.testScript(
      [{ action: 'fill', target: { kind: 'frame', selector: '#f', index: 0, child: id('x') }, value: 'v' }],
      'selenium',
      'csharp'
    );
    expect(code).toContain(
      [
        '            driver.SwitchTo().Frame(driver.FindElement(By.CssSelector("#f")));',
        '            {',
        '                var el = driver.FindElement(By.Id("x"));',
        '                el.Clear();',
        '                el.SendKeys("v");',
        '            }',
        '            driver.SwitchTo().DefaultContent();',
      ].join('\n')
    );
  });

  it('adds each using only when a statement needs it', () => {
    const usings = (fw, steps) =>
      C.testScript(steps, fw, 'csharp')
        .split('\n')
        .filter((l) => l.startsWith('using '));
    const t = id('x');
    expect(usings('selenium', [{ action: 'click', target: t }])).toEqual([
      'using System;',
      'using NUnit.Framework;',
      'using OpenQA.Selenium;',
      'using OpenQA.Selenium.Chrome;',
    ]);
    expect(
      usings('selenium', [
        { action: 'viewport', value: '800x600' },
        { action: 'hover', target: t },
        { action: 'selectOption', target: t, value: 'a' },
        { action: 'upload', target: t, value: ['a.txt'] },
        { action: 'assert', assertType: 'toHaveText', target: t, value: 'x' },
      ])
    ).toEqual([
      'using System;',
      'using System.Drawing;',
      'using System.IO;',
      'using System.Linq;',
      'using System.Text.RegularExpressions;',
      'using NUnit.Framework;',
      'using OpenQA.Selenium;',
      'using OpenQA.Selenium.Chrome;',
      'using OpenQA.Selenium.Interactions;',
      'using OpenQA.Selenium.Support.UI;',
    ]);
    expect(usings('selenium', [{ action: 'assert', assertType: 'toHaveURL', value: 'u' }])).toContain(
      'using OpenQA.Selenium.Support.UI;'
    );
    expect(usings('playwright', [{ action: 'click', target: t }])).toEqual([
      'using System.Threading.Tasks;',
      'using Microsoft.Playwright;',
      'using Microsoft.Playwright.NUnit;',
      'using NUnit.Framework;',
    ]);
    expect(usings('playwright', [{ action: 'fill', target: t, sensitive: true }])).toContain('using System;');
    // A comment that merely mentions an API does not pull its namespace in.
    expect(
      C.wrapScript(
        ['// new Actions(driver) Regex.Replace Path.GetFullPath .Select( new Size('],
        'selenium',
        'csharp'
      )
    ).not.toMatch(/Interactions|RegularExpressions|System\.IO|System\.Linq|System\.Drawing/);
  });

  it('drops suggested steps that were never accepted', () => {
    const steps = [
      { action: 'click', target: id('a') },
      { action: 'assert', assertType: 'toBeVisible', target: id('b'), suggested: true },
    ];
    for (const fw of ['playwright', 'selenium']) {
      const code = C.testScript(steps, fw, 'csharp');
      expect(code).toContain('"a"'.replace('"a"', fw === 'playwright' ? '"#a"' : '"a"'));
      expect(code).not.toMatch(/"#?b"/);
      const wrapped = C.wrapScript(
        steps.map((s) => C.actionStatement(s, fw, 'csharp')),
        fw,
        'csharp',
        steps
      );
      expect(wrapped).not.toMatch(/"#?b"/);
    }
  });

  it('renders the canonical checkout flow in both frameworks', () => {
    const flow = JSON.parse(
      readFileSync(new URL('./e2e/fixtures/checkout-flow.json', import.meta.url), 'utf8')
    );
    const pwCode = C.testScript(flow.actions, 'playwright', 'csharp');
    expect(pwCode).toContain(
      '        await Page.FrameLocator("#payment-frame").GetByRole(AriaRole.Button, new() { Name = "Pay now" }).ClickAsync();\n'
    );
    expect(pwCode).toContain(
      '        await Page.GetByLabel("Password", new() { Exact = true }).FillAsync(Environment.GetEnvironmentVariable("LOCATRA_PASSWORD") ?? "");\n'
    );
    expect(pwCode).toContain(
      '        await Expect(Page.Locator("table").GetByText("Refactoring", new() { Exact = true })).ToBeVisibleAsync();\n'
    );
    expect(pwCode).toContain('        await Expect(Page.Locator("#save-details")).Not.ToBeCheckedAsync();\n');
    expect(pwCode).toContain(
      '        await Page.GetByLabel("Gift wrap this order (+ £3.50)").CheckAsync();\n'
    );
    const selCode = C.testScript(flow.actions, 'selenium', 'csharp');
    expect(selCode).toContain(
      '            new Actions(driver).KeyDown(Keys.Shift).SendKeys(Keys.Tab).KeyUp(Keys.Shift).Perform();\n'
    );
    expect(selCode).toContain(
      '            driver.SwitchTo().Frame(driver.FindElement(By.CssSelector("#payment-frame")));\n'
    );
    expect(selCode).toContain('{{BASE}}');
    expect(selCode).not.toMatch(/TODO/);
    expect(pwCode).not.toMatch(/TODO/);
  });
});

// ── test-data variables ─────────────────────────────────────────────────────────
describe('test-data variables', () => {
  const steps = [
    { eventId: 'e1', action: 'goto', value: 'https://x.example/' },
    { eventId: 'e2', action: 'fill', target: label('First name'), value: 'Ada' },
    { eventId: 'e3', action: 'fill', target: label('Password'), value: 'pw', sensitive: true },
    { eventId: 'e4', action: 'selectOption', target: role('combobox', 'Country'), value: 'Ireland' },
    { eventId: 'e5', action: 'fill', target: label('Notes'), value: 'Line "1"\nC:\\x' },
  ];
  const FIELD = [
    '    private static readonly IReadOnlyDictionary<string, string> TestData = new Dictionary<string, string>',
    '    {',
    '        ["firstName"] = "Ada",',
    '        ["country"] = "Ireland",',
    '        ["notes"] = "Line \\"1\\"\\nC:\\\\x",',
    '    };',
    '',
    '    [Test]',
  ].join('\n');

  it('references TestData from fill and select statements', () => {
    expect(pw({ action: 'fill', target: label('A'), value: 'x', varRef: 'firstName' })).toBe(
      'await Page.GetByLabel("A").FillAsync(TestData["firstName"]);'
    );
    expect(pw({ action: 'selectOption', target: label('A'), value: 'x', varRef: 'country' })).toBe(
      'await Page.GetByLabel("A").SelectOptionAsync(TestData["country"]);'
    );
    expect(sel({ action: 'fill', target: id('a'), value: 'x', varRef: 'firstName' })).toContain(
      'el.SendKeys(TestData["firstName"]);'
    );
    expect(sel({ action: 'fill', target: id('a'), value: 'x', varRef: 'v', inputType: 'date' })).toBe(
      '((IJavaScriptExecutor)driver).ExecuteScript(LocatraSetValueJs, driver.FindElement(By.Id("a")), TestData["v"]);'
    );
    expect(sel({ action: 'selectOption', target: id('a'), value: 'x', varRef: 'country' })).toBe(
      'new SelectElement(driver.FindElement(By.Id("a"))).SelectByText(TestData["country"]);'
    );
  });

  it('keeps environment secrets and literals where no valid reference applies', () => {
    expect(pw({ action: 'fill', target: label('A'), value: 'x', varRef: 'pw', sensitive: true })).toContain(
      'Environment.GetEnvironmentVariable("LOCATRA_PASSWORD")'
    );
    expect(pw({ action: 'fill', target: label('A'), value: 'x', varRef: 'not valid' })).toContain(
      'FillAsync("x")'
    );
    expect(pw({ action: 'fill', target: label('A'), value: 'x', varRef: '' })).toContain('FillAsync("x")');
    expect(pw({ action: 'click', target: label('A'), varRef: 'firstName' })).not.toContain('TestData');
  });

  it('declares one TestData dictionary whose keys match the references', () => {
    for (const fw of ['playwright', 'selenium']) {
      const code = C.testScript(steps, fw, 'csharp', { variables: true });
      expect(code).toContain(FIELD);
      expect(code).toContain('using System.Collections.Generic;');
      const declared = [...code.matchAll(/^ {8}\["(\w+)"\] = /gm)].map((m) => m[1]);
      const used = [...new Set([...code.matchAll(/TestData\["(\w+)"\]/g)].map((m) => m[1]))];
      expect(used.sort()).toEqual([...declared].sort());
      expect(code).not.toMatch(/"pw"/);
      expect(code).toContain('GetEnvironmentVariable("LOCATRA_PASSWORD")');
    }
  });

  it('uses a given variable list as-is, and literals when variables are off', () => {
    const vars = [{ name: 'givenName', value: 'Ada', eventIds: ['e2'], kind: 'fill' }];
    const code = C.testScript(steps, 'playwright', 'csharp', { variables: vars });
    expect(code).toContain('        ["givenName"] = "Ada",\n    };');
    expect(code).toContain('FillAsync(TestData["givenName"])');
    expect(code).toContain('SelectOptionAsync("Ireland")');
    for (const opts of [undefined, {}, { variables: false }, { variables: [] }]) {
      const lit = C.testScript(steps, 'selenium', 'csharp', opts);
      expect(lit).not.toContain('TestData');
      expect(lit).not.toContain('IReadOnlyDictionary');
      expect(lit).toContain('el.SendKeys("Ada");');
    }
  });

  it('wrapScript declares the variables it is handed (the panel path)', () => {
    const vars = C.extractVariables(steps);
    const applied = C.applyVariables(steps, vars);
    const stmts = applied.map((s) => C.actionStatement(s, 'selenium', 'csharp'));
    const code = C.wrapScript(stmts, 'selenium', 'csharp', applied, { variables: vars });
    expect(code).toContain(FIELD);
    expect(code.indexOf('TestData =')).toBeLessThan(code.indexOf('[Test]'));
  });

  it('falls back to its own rules when the core lacks the variable helpers', () => {
    const I = C._internals;
    const saved = { variableRefName: I.variableRefName, scriptVariables: I.scriptVariables };
    delete I.variableRefName;
    delete I.scriptVariables;
    try {
      expect(pw({ action: 'fill', target: label('A'), value: 'x', varRef: 'firstName' })).toContain(
        'TestData["firstName"]'
      );
      expect(pw({ action: 'fill', target: label('A'), value: 'x', varRef: '1bad' })).toContain(
        'FillAsync("x")'
      );
      expect(pw({ action: 'fill', target: label('A'), value: 'x', varRef: 5 })).toContain('FillAsync("x")');
      expect(pw({ action: 'fill', target: label('A'), value: 'x', varRef: 'a', sensitive: true })).toContain(
        'Environment'
      );
      expect(pw({ action: 'click', target: label('A'), varRef: 'a' })).toBe(
        'await Page.GetByLabel("A").ClickAsync();'
      );
      const refSteps = [
        { action: 'fill', target: label('A'), value: 'one', varRef: 'a' },
        { action: 'fill', target: label('B'), value: null, varRef: 'b' },
        null,
        { action: 'click', target: label('C') },
      ];
      const code = C.wrapScript(
        refSteps.map((s) => (s ? C.actionStatement(s, 'playwright', 'csharp') : '')),
        'playwright',
        'csharp',
        refSteps,
        {
          variables: [
            null,
            { name: 'a', value: 'given' },
            { name: 'a', value: 'dupe' },
            { name: 'bad name', value: 'x' },
            { name: 'z' },
          ],
        }
      );
      expect(code).toContain('        ["a"] = "given",\n        ["z"] = "",\n        ["b"] = "",\n    };');
      expect(C.wrapScript([], 'selenium', 'csharp', null, { variables: 'yes' })).not.toContain('TestData');
    } finally {
      Object.assign(I, saved);
    }
  });
});

// ── page objects ────────────────────────────────────────────────────────────────
const SMALL = {
  pageUrl: 'https://shop.example/checkout',
  title: 'Checkout | Shop',
  elements: [
    { name: 'emailAddressInput', kind: 'input', target: label('Email address') },
    { name: 'placeOrderButton', kind: 'button', target: role('button', 'Place order') },
  ],
};

const RICH = {
  pageUrl: 'https://shop.example/checkout?step=2',
  title: 'Checkout – "Shop"\nline two\u2028three\u0085four',
  elements: [
    { name: 'emailAddressInput', kind: 'input', inputType: 'email', target: label('Email address') },
    { name: 'notesField', kind: 'textarea', target: { kind: 'placeholder', value: 'it\'s "quoted"' } },
    { name: 'countrySelect', kind: 'select', target: role('combobox', 'Country') },
    { name: 'termsCheckbox', kind: 'checkbox', target: role('checkbox', 'Terms') },
    { name: 'expressRadio', kind: 'radio', target: role('radio', 'Express', { exact: true }) },
    { name: 'placeOrderButton', kind: 'button', target: testid('place-order') },
    {
      name: 'deleteButton',
      kind: 'button',
      target: { kind: 'chain', parent: testid('row-2'), child: role('button', 'Delete') },
    },
    { name: 'editButton', kind: 'button', target: role('button', 'Edit', { nth: 1 }) },
    { name: 'helpLink', kind: 'link', target: role('link', 'Help') },
    {
      name: 'cardNumberInput',
      kind: 'input',
      target: { kind: 'frame', selector: '#pay', index: 0, child: label('Card number') },
    },
    {
      name: 'cvcInput',
      kind: 'input',
      target: {
        kind: 'frame',
        selector: 'x-pay iframe',
        index: 1,
        shadowPath: ['#shell', 'iframe'],
        child: id('cvc'),
      },
    },
    {
      name: 'thirdPartyButton',
      kind: 'button',
      target: { kind: 'frame', selector: null, index: 2, child: { kind: 'text', value: 'Go', exact: true } },
    },
    { name: 'qtyInput', kind: 'input', inputType: 'range', target: id('qty') },
    { name: 'avatar', kind: 'other', target: { kind: 'altText', value: 'Avatar' } },
    { name: 'bio', kind: 'other', role: 'textbox', target: { kind: 'title', value: 'Bio' } },
    { name: 'resume', kind: 'input', inputType: 'file', target: { kind: 'name', value: 'cv' } },
    { name: 'anyRow', kind: 'other', target: role('row'), matchCount: 3, unique: false },
    { name: 'missing', kind: 'button', target: { kind: 'css', value: '.gone' }, matchCount: 0 },
    { name: 'mystery', kind: 'gadget', target: testid('m') },
  ],
};

describe('page objects: exact output', () => {
  it('renders the Playwright class with PascalCase members and *Async helpers', () => {
    expect(C.pageObject(SMALL, 'playwright', 'csharp')).toBe(
      [
        '// Page Object generated by Locatra for "Checkout | Shop".',
        '// Page: https://shop.example/checkout',
        'using System.Threading.Tasks;',
        'using Microsoft.Playwright;',
        '',
        'public class CheckoutPage',
        '{',
        '    public CheckoutPage(IPage page)',
        '    {',
        '        Page = page;',
        '        EmailAddressInput = page.GetByLabel("Email address");',
        '        PlaceOrderButton = page.GetByRole(AriaRole.Button, new() { Name = "Place order" });',
        '    }',
        '',
        '    public IPage Page { get; }',
        '',
        '    public ILocator EmailAddressInput { get; }',
        '',
        '    public ILocator PlaceOrderButton { get; }',
        '',
        '    public async Task GotoAsync()',
        '    {',
        '        await Page.GotoAsync("https://shop.example/checkout");',
        '    }',
        '',
        '    public async Task FillEmailAddressInputAsync(string value)',
        '    {',
        '        await EmailAddressInput.FillAsync(value);',
        '    }',
        '',
        '    public async Task ClickPlaceOrderButtonAsync()',
        '    {',
        '        await PlaceOrderButton.ClickAsync();',
        '    }',
        '}',
        '',
      ].join('\n')
    );
  });

  it('renders the Selenium class with lazy lookups', () => {
    // The members are rooted at the Driver property.
    const name = C.locatorExpr(label('Email address'), 'selenium', 'csharp').replace('(driver,', '(Driver,');
    const button = C.locatorExpr(role('button', 'Place order'), 'selenium', 'csharp').replace(
      '(driver,',
      '(Driver,'
    );
    expect(name).toBe('Locatra.Find(Driver, "label", "Email address")');
    const code = C.pageObject(SMALL, 'selenium', 'csharp');
    expect(code.slice(0, code.indexOf('    #nullable enable'))).toBe(
      [
        '// Page Object generated by Locatra for "Checkout | Shop".',
        '// Page: https://shop.example/checkout',
        'using System;',
        'using System.Collections.Generic;',
        'using System.Linq;',
        'using System.Threading;',
        'using OpenQA.Selenium;',
        '',
        'public class CheckoutPage',
        '{',
        '    public CheckoutPage(IWebDriver driver)',
        '    {',
        '        Driver = driver;',
        '    }',
        '',
        '    public IWebDriver Driver { get; }',
        '',
        '    public void Goto()',
        '    {',
        '        Driver.Navigate().GoToUrl("https://shop.example/checkout");',
        '    }',
        '',
        `    public IWebElement EmailAddressInput => ${name};`,
        '',
        `    public IWebElement PlaceOrderButton => ${button};`,
        '',
        '    public void FillEmailAddressInput(string value)',
        '    {',
        '        var el = EmailAddressInput;',
        '        el.Clear();',
        '        el.SendKeys(value);',
        '    }',
        '',
        '    public void ClickPlaceOrderButton()',
        '    {',
        '        PlaceOrderButton.Click();',
        '    }',
        '',
        '',
      ].join('\n')
    );
    expect(code.endsWith('    }\n    #nullable restore\n}\n')).toBe(true);
  });

  it('is deterministic', () => {
    for (const fw of ['playwright', 'selenium']) {
      expect(C.pageObject(RICH, fw, 'csharp')).toBe(C.pageObject(RICH, fw, 'csharp'));
    }
  });
});

describe('page objects: every element kind and target', () => {
  it('Playwright: locators reuse the statement locators; helpers per kind', () => {
    const code = C.pageObject(RICH, 'playwright', 'csharp');
    expect(code.split('\n').slice(0, 2)).toEqual([
      '// Page Object generated by Locatra for "Checkout – "Shop" line two three four".',
      '// Page: https://shop.example/checkout?step=2',
    ]);
    for (const el of RICH.elements) {
      expect(code).toContain(
        ` = ${C.locatorExpr(el.target, 'playwright', 'csharp').replace(/^Page\./, 'page.')};`
      );
    }
    expect(code).toContain('        CvcInput = page.FrameLocator("x-pay iframe").Locator("#cvc");\n');
    expect(code).toContain(
      '        // NOTE: this locator matched 3 elements when the page object was generated.\n        AnyRow = page.GetByRole(AriaRole.Row);\n'
    );
    expect(code).toContain(
      '        // NOTE: this locator matched no element when the page object was generated.\n        Missing = page.Locator(".gone");\n'
    );
    const helpers = [...code.matchAll(/public async Task (\w+)\((string value)?\)/g)].map((m) => m[1]);
    expect(helpers).toEqual([
      'GotoAsync',
      'FillEmailAddressInputAsync',
      'FillNotesFieldAsync',
      'SelectCountrySelectAsync',
      'CheckTermsCheckboxAsync',
      'UncheckTermsCheckboxAsync',
      'CheckExpressRadioAsync',
      'ClickPlaceOrderButtonAsync',
      'ClickDeleteButtonAsync',
      'ClickEditButtonAsync',
      'ClickHelpLinkAsync',
      'FillCardNumberInputAsync',
      'FillCvcInputAsync',
      'ClickThirdPartyButtonAsync',
      'FillQtyInputAsync',
      'ClickAvatarAsync',
      'FillBioAsync',
      'ClickAnyRowAsync',
      'ClickMissingAsync',
      'ClickMysteryAsync',
    ]);
    expect(code).toContain(
      '    public async Task SelectCountrySelectAsync(string value)\n    {\n        await CountrySelect.SelectOptionAsync(value);\n    }'
    );
    expect(code).toContain(
      '    public async Task UncheckTermsCheckboxAsync()\n    {\n        await TermsCheckbox.UncheckAsync();\n    }'
    );
    expect(code).toContain('    public ILocator Resume { get; }');
    expect(code).not.toMatch(/Task \w*Resume/);
  });

  it('Selenium: every lookup re-enters its frames from the top document', () => {
    const code = C.pageObject(RICH, 'selenium', 'csharp');
    expect(code).toContain('using OpenQA.Selenium.Support.UI;');
    expect(code).toContain(
      '    public void Goto()\n    {\n        Driver.SwitchTo().DefaultContent();\n        Driver.Navigate().GoToUrl("https://shop.example/checkout?step=2");\n    }'
    );
    expect(code).toContain(
      [
        '    public IWebElement CvcInput',
        '    {',
        '        get',
        '        {',
        '            Driver.SwitchTo().DefaultContent();',
        '            Driver.SwitchTo().Frame(Driver.FindElement(By.CssSelector("#shell")).GetShadowRoot().FindElement(By.CssSelector("iframe")));',
        '            return Driver.FindElement(By.Id("cvc"));',
        '        }',
        '    }',
      ].join('\n')
    );
    expect(code).toContain(
      '            Driver.SwitchTo().DefaultContent();\n' +
        '            Driver.SwitchTo().Frame((IWebElement)((IJavaScriptExecutor)Driver).ExecuteScript(LocatraFrameJs, 2)!);\n' +
        '            return Locatra.Find(Driver, "text", "Go", exact: true);'
    );
    expect(code).toContain(
      `    private const string LocatraFrameJs = ${JSON.stringify(C._internals.DEEP_IFRAME_JS)};`
    );
    expect(code).toContain(
      '            Driver.SwitchTo().DefaultContent();\n            Driver.SwitchTo().Frame(Driver.FindElement(By.CssSelector("#pay")));\n'
    );
    expect(code).toContain(
      '            Driver.SwitchTo().DefaultContent();\n            return Locatra.Find(Driver.FindElement(By.CssSelector("[data-testid=\\"row-2\\"]")), "role", "button", "Delete");'
    );
    expect(code).toContain(
      '    // NOTE: this locator matched 3 elements when the page object was generated.\n    public IWebElement AnyRow\n'
    );
    expect(code).toContain(
      '    public void FillQtyInput(string value)\n    {\n        ((IJavaScriptExecutor)Driver).ExecuteScript(LocatraSetValueJs, QtyInput, value);\n    }'
    );
    expect(code).toContain(`    private const string LocatraSetValueJs = ${X.q(C._internals.SET_VALUE_JS)};`);
    expect(code).toContain(
      '    public void SelectCountrySelect(string value)\n    {\n        new SelectElement(CountrySelect).SelectByText(value);\n    }'
    );
    expect(code).toContain(
      '    public void CheckTermsCheckbox()\n    {\n        var el = TermsCheckbox;\n        if (!(el.Selected || el.GetDomAttribute("aria-checked") == "true")) el.Click();\n    }'
    );
    expect(code).toContain(
      '    public void UncheckTermsCheckbox()\n    {\n        var el = TermsCheckbox;\n        if (el.Selected || el.GetDomAttribute("aria-checked") == "true") el.Click();\n    }'
    );
    expect(code).toContain('    public void ClickMystery()\n    {\n        Mystery.Click();\n    }');
    expect(code).not.toContain('"Driver.');
  });

  it('notes ambiguity, skips elements without a locator, omits Goto without a URL', () => {
    const model = {
      elements: [
        { name: 'nameless', kind: 'button', target: role('button') },
        { name: 'flagged', kind: 'button', target: testid('f'), unique: false },
        { name: 'noTarget', kind: 'button' },
        { name: 'emptyFrame', kind: 'button', target: { kind: 'frame', selector: '#f', index: 0 } },
        null,
      ],
    };
    for (const fw of ['playwright', 'selenium']) {
      const code = C.pageObject(model, fw, 'csharp');
      expect(code).toContain(
        '// NOTE: this role locator has no accessible name and may match several elements.\n'
      );
      expect(code).toContain('// NOTE: this locator was not unique when the page object was generated.\n');
      expect(code).toContain('// NOTE: 3 element(s) without a usable locator were left out.\n');
      expect(code).not.toMatch(/NoTarget|EmptyFrame|Goto/);
      expect(code.startsWith('// Page Object generated by Locatra.\n// NOTE: 3 element(s)')).toBe(true);
    }
    expect(C.pageObject(null, 'playwright', 'csharp')).toContain(
      'public class HomePage\n{\n    public HomePage(IPage page)'
    );
    expect(C.pageObject(undefined, 'selenium', 'csharp')).toContain(
      'public class HomePage\n{\n    public HomePage(IWebDriver driver)'
    );
    expect(X.targets.playwright.pageObject(null, 'csharp')).toContain('public class HomePage');
    expect(X.targets.selenium.pageObject(null, 'csharp')).toContain('public class HomePage');
    expect(C.pageObject({ elements: 'nope' }, 'selenium', 'csharp')).not.toContain('IWebElement');
  });

  it('imports Select only when a select helper exists; never re-enters frames when none are used', () => {
    const plain = C.pageObject(SMALL, 'selenium', 'csharp');
    expect(plain).not.toContain('Support.UI');
    expect(plain).not.toContain('DefaultContent');
  });
});

describe('page objects: identifiers', () => {
  const members = (model, fw = 'playwright') => {
    const code = C.pageObject(model, fw, 'csharp');
    return fw === 'playwright'
      ? [...code.matchAll(/public ILocator (\w+) \{ get; \}/g)].map((m) => m[1])
      : [...code.matchAll(/public IWebElement (\w+)/g)].map((m) => m[1]);
  };
  const el = (name, kind = 'other') => ({ name, kind, target: testid(String(name || 'x')) });

  it('PascalCases and dedupes with numeric suffixes', () => {
    const model = { elements: [el('emailInput'), el('emailInput'), el('email input'), el('EMAIL_INPUT')] };
    expect(members(model)).toEqual(['EmailInput', 'EmailInput2', 'EmailInput3', 'EmailInput4']);
    expect(members(model, 'selenium')).toEqual(['EmailInput', 'EmailInput2', 'EmailInput3', 'EmailInput4']);
  });

  it('turns any text into a valid identifier', () => {
    const model = {
      elements: [el('2fa code'), el('Café crème'), el('日本語'), el(''), el('  -- '), el('URL field')],
    };
    expect(members(model)).toEqual(['El2faCode', 'CafeCreme', 'Element', 'Element2', 'Element3', 'UrlField']);
  });

  it('never shadows the class, its fixed members or the types its code uses', () => {
    const names = [
      'page',
      'driver',
      'goto',
      'GotoAsync',
      'toString',
      'equals',
      'get type',
      'by',
      'aria role',
      'keys',
      'select element',
      'task',
      'IPage',
      'checkout page',
      'class',
      'delete',
    ];
    const model = { title: 'Checkout', elements: names.map((n) => el(n)) };
    expect(members(model)).toEqual([
      'PageElement',
      'DriverElement',
      'GotoElement',
      'GotoAsyncElement',
      'ToStringElement',
      'EqualsElement',
      'GetTypeElement',
      'ByElement',
      'AriaRoleElement',
      'KeysElement',
      'SelectElementElement',
      'TaskElement',
      'IPageElement',
      'CheckoutPageElement',
      'Class',
      'Delete',
    ]);
  });

  it('dedupes helpers against members', () => {
    const model = {
      elements: [
        { name: 'clickGo', kind: 'other', target: testid('a') },
        { name: 'go', kind: 'button', target: testid('b') },
        { name: 'clickGoAsync', kind: 'other', target: testid('c') },
      ],
    };
    const pwCode = C.pageObject(model, 'playwright', 'csharp');
    expect(pwCode).toContain('public async Task ClickClickGoAsync()');
    expect(pwCode).toContain('public async Task ClickGoAsync2()\n    {\n        await Go.ClickAsync();');
    const selCode = C.pageObject(model, 'selenium', 'csharp');
    expect(selCode).toContain('public void ClickGo2()\n    {\n        Go.Click();');
  });

  it('renames a Playwright class that would collide with its Page property', () => {
    const code = C.pageObject({ className: 'Page', elements: [el('go')] }, 'playwright', 'csharp');
    expect(code).toContain('public class PagePage\n{\n    public PagePage(IPage page)');
    expect(C.pageObject({ className: 'Page', elements: [el('go')] }, 'selenium', 'csharp')).toContain(
      'public class Page\n'
    );
  });
});

// ── the e2e runner scaffold (scripts/e2e/runners/csharp.mjs) ────────────────────
describe('C# runner scaffold', () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'locatra-cs-scaffold-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('references the packages a user would and keeps the generated file byte-for-byte', () => {
    const proj = csproj({ major: 10, kinds: ['playwright'] });
    expect(proj).toContain('<TargetFramework>net10.0</TargetFramework>');
    expect(proj).toContain('<ImplicitUsings>disable</ImplicitUsings>');
    expect(proj).toContain('<TreatWarningsAsErrors>true</TreatWarningsAsErrors>');
    for (const [pkg, v] of [...PACKAGES.common, ...PACKAGES.playwright]) {
      expect(proj).toContain(`<PackageReference Include="${pkg}" Version="${v}" />`);
    }
    expect(proj).not.toContain('Selenium');
    const script = C.testScript([{ action: 'goto', value: 'https://x.example/' }], 'selenium', 'csharp');
    const out = scaffold({
      dir: join(dir, 's'),
      kind: 'selenium',
      major: 8,
      script,
      chromium: "/opt/chrome it's",
    });
    expect(readFileSync(join(dir, 's/RecordedTest.cs'), 'utf8')).toBe(script);
    expect(readFileSync(join(dir, 's/Locatra.Recorded.csproj'), 'utf8')).toContain('Selenium.WebDriver');
    if (process.platform !== 'win32') {
      expect(out.browserPath).toBe(join(dir, 's/locatra-chromium.sh'));
      const sh = readFileSync(out.browserPath, 'utf8');
      expect(sh).toContain(
        "exec '/opt/chrome it'\\''s' --no-sandbox --disable-dev-shm-usage --window-size=1280,900 --headless=new \"$@\""
      );
    }
    const p = scaffold({ dir: join(dir, 'p'), kind: 'playwright', major: 9, script: 'x', chromium: '/a&b' });
    expect(p.browserPath).toBe('/a&b');
    expect(readFileSync(join(dir, 'p/locatra.runsettings'), 'utf8')).toContain(
      '<ExecutablePath>/a&amp;b</ExecutablePath>'
    );
  });

  it('renders headed variants and no executable path when none is given', () => {
    expect(runsettings({ chromium: null, headed: true })).toContain('<Headless>false</Headless>');
    expect(runsettings({ chromium: null, headed: false })).not.toContain('ExecutablePath');
    expect(chromeWrapper({ chromium: '/c', headed: true, marker: '/m' })).not.toContain('--headless');
    expect(chromeWrapper({ chromium: '/c', headed: false, marker: '/m' })).toContain(
      'case "$1" in --version|-version) ;; *) : > \'/m\' ;; esac'
    );
    mkdirSync(join(dir, 'n'), { recursive: true });
    expect(scaffold({ dir: join(dir, 'n'), kind: 'selenium', major: 8, script: '' }).browserPath).toBe(null);
  });
});

// ── compile everything with the real C# compiler ────────────────────────────────
// Skipped when no .NET SDK (8+) is installed: `node scripts/e2e/setup-csharp.mjs`
// installs one into node_modules/.cache/locatra-e2e/dotnet without sudo.
const DOTNET = findDotnet();

describe.skipIf(!DOTNET)('dotnet build of the generated code', () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'locatra-cs-build-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // Each generated file is put in its own namespace, right after its usings, so the
  // many RecordedTest / CheckoutPage classes can share one project.
  const files = [];
  const add = (code, tag) => {
    const lines = code.split('\n');
    let at = 0;
    lines.forEach((l, i) => {
      if (l.startsWith('using ')) at = i + 1;
    });
    lines.splice(at, 0, '', `namespace Case${files.length}_${tag};`);
    files.push(lines.join('\n'));
  };

  const LITERALS = [
    '',
    'plain',
    'it\'s "quoted"',
    'a\\b',
    'say "\\hi"',
    '\0\x07\b\f\n\r\t\v\x01\x1fa\x7f\x9b',
    'a\u0085b\u2028c\u2029d',
    '\u200b\u202e\u2066\u2069\ufeff\u00ad\u061c\u180e\ufff9',
    '£3.50 日本語 café 😀',
    'a\ud800b\udc00',
    'a\\b\nc',
    '\\\ud800',
  ];

  function dotnet(args, extraEnv = {}) {
    return execFileSync(DOTNET.dotnet, args, {
      cwd: dir,
      env: { ...process.env, ...dotnetEnv(DOTNET), ...extraEnv },
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 600_000,
    });
  }

  it('compiles every statement, scaffold, page object and literal (warnings as errors)', () => {
    const t = id('x');
    const frame = { kind: 'frame', selector: '#f', index: 0, child: label('Card') };
    const shadow = { kind: 'frame', selector: 'a iframe', index: 1, shadowPath: ['#a', 'iframe'], child: t };
    const xo = { kind: 'frame', selector: null, index: 2, child: role('button', 'Go', { nth: 1 }) };
    const chain = {
      kind: 'chain',
      parent: testid('row'),
      child: { kind: 'text', value: 'Edit', exact: true },
    };
    const steps = [
      { action: 'goto', value: 'https://x.example/' },
      { action: 'viewport', value: '1280x800' },
      { action: 'click', target: t },
      { action: 'dblclick', target: chain },
      { action: 'hover', target: role('row') },
      { action: 'check', target: frame },
      { action: 'uncheck', target: shadow },
      { action: 'fill', target: xo, value: 'Ada' },
      { action: 'fill', target: t, value: 'secret', sensitive: true, secretName: 'MY_PW' },
      { action: 'fill', target: t, value: '5', inputType: 'range' },
      { action: 'fill', target: t, value: 'v', varRef: 'firstName' },
      { action: 'selectOption', target: role('combobox', 'Country'), value: 'Ireland', varRef: 'country' },
      { action: 'selectOption', target: t, value: 'Literal' },
      { action: 'upload', target: t, value: ['a.txt', 'b.txt'] },
      { action: 'upload', target: t, value: [] },
      { action: 'press', value: 'Control+Alt+Shift+Meta+Enter' },
      { action: 'press', value: 'Control++' },
      { action: 'press', value: 'Hyper+x' },
      { action: 'teleport' },
      { action: 'tele\u0085port\u2028x' },
      { action: 'click' },
      { action: 'assert', assertType: 'toBeVisible', target: t },
      { action: 'assert', assertType: 'toHaveText', target: t, value: 'a  b' },
      { action: 'assert', assertType: 'toContainText', target: frame, value: 'a' },
      { action: 'assert', assertType: 'toHaveValue', target: t, value: 'v' },
      { action: 'assert', assertType: 'toBeEnabled', target: t },
      { action: 'assert', assertType: 'toBeChecked', target: t, value: 'true' },
      { action: 'assert', assertType: 'toBeChecked', target: t, value: 'false' },
      { action: 'assert', assertType: 'toHaveURL', value: 'https://x.example/done' },
      ...LITERALS.map((value) => ({ action: 'fill', target: { kind: 'text', value }, value })),
      ...[
        'Tab',
        'Escape',
        'Backspace',
        'Delete',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        ' ',
        'Home',
        'End',
        'PageUp',
        'PageDown',
        'Insert',
        'F1',
        'F12',
        'a',
        '"',
        '\\',
      ].map((value) => ({ action: 'press', value })),
      ...X.ARIA_ROLES.map((r) => ({
        action: 'click',
        target: role(r, 'n', { level: 1, exact: true, nth: 0 }),
      })),
      { action: 'click', target: role('mark', 'Hi') },
      // Contract fields: multi-select, sensitive assertion, shadow DOM, frame indices.
      { action: 'selectOption', target: t, value: 'A', values: ['A', 'B "b"'] },
      { action: 'assert', assertType: 'toHaveValue', target: t, sensitive: true, secretName: 'PW' },
      { action: 'click', target: { ...testid('s'), shadowHosts: ['x-a', 'x-b'], shadowCss: '.go' } },
      { action: 'fill', target: { ...testid('s'), shadowHosts: ['x-a'] }, value: 'v' },
      { action: 'click', target: { kind: 'frame', selector: null, index: 1, framesIndex: 2, child: t } },
    ];
    const vars = [
      { name: 'firstName', value: 'Ada' },
      { name: 'country', value: 'Ireland "IE"\n' },
    ];
    for (const fw of ['playwright', 'selenium']) {
      add(C.testScript(steps, fw, 'csharp', { variables: vars }), fw);
      add(C.testScript(steps, fw, 'csharp'), fw + 'Literal');
      add(C.testScript([], fw, 'csharp'), fw + 'Empty');
      add(C.pageObject(RICH, fw, 'csharp'), fw + 'Rich');
      add(C.pageObject(SMALL, fw, 'csharp'), fw + 'Small');
      add(
        C.pageObject(
          { className: 'Page', elements: [{ name: 'by', kind: 'select', target: t }] },
          fw,
          'csharp'
        ),
        fw + 'Odd'
      );
      add(
        C.pageObject(
          {
            className: 'Shadow',
            elements: [
              {
                name: 'go',
                kind: 'button',
                target: { ...testid('s'), shadowHosts: ['x-a'], shadowCss: '.go' },
              },
              { name: 'lost', kind: 'input', target: { ...testid('l'), shadowHosts: ['x-a'] } },
            ],
          },
          fw,
          'csharp'
        ),
        fw + 'Shadow'
      );
      // The C9.4 corpus: every target kind × every action, the Locatra helper class,
      // the frame / value-setter constants, deep shadow chains, XPath.
      add(C.testScript(CORPUS.STEPS, fw, 'csharp'), fw + 'Corpus');
      add(C.testScript(CORPUS.STEPS, fw, 'csharp', { variables: true }), fw + 'CorpusData');
      add(C.pageObject({ ...CORPUS.MODEL, className: 'Corpus' }, fw, 'csharp'), fw + 'CorpusPage');
    }
    // The literals, read back by the compiler: one line of UTF-16 code units each.
    files.push(
      [
        'using System.IO;',
        'using System.Linq;',
        'using NUnit.Framework;',
        '',
        'namespace Probe;',
        '',
        'public class LiteralsProbe',
        '{',
        '    [Test]',
        '    public void Dump()',
        '    {',
        '        var values = new string[]',
        '        {',
        ...LITERALS.map((v) => `            ${X.q(v)},`),
        '        };',
        '        File.WriteAllText(System.Environment.GetEnvironmentVariable("LOCATRA_PROBE_OUT")!, string.Join("\\n",',
        '            values.Select(s => string.Join(",", s.Select(c => ((int)c).ToString("x4"))))));',
        '    }',
        '}',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(dir, 'Locatra.Compile.csproj'),
      csproj({ major: DOTNET.major, kinds: ['playwright', 'selenium'] })
    );
    files.forEach((code, i) => writeFileSync(join(dir, `File${i}.cs`), code));

    for (const implicit of ['disable', 'enable']) {
      try {
        dotnet(['build', '--nologo', '-v', 'q', `-p:ImplicitUsings=${implicit}`]);
      } catch (err) {
        throw new Error(`dotnet build (ImplicitUsings=${implicit}) failed:\n${err.stdout}\n${err.stderr}`);
      }
    }

    const out = join(dir, 'literals.txt');
    try {
      dotnet(['test', '--nologo', '--no-build', '--filter', 'FullyQualifiedName~LiteralsProbe'], {
        LOCATRA_PROBE_OUT: out,
      });
    } catch (err) {
      throw new Error(`dotnet test (literals) failed:\n${err.stdout}\n${err.stderr}`);
    }
    const units = (s) =>
      [...Array(s.length)].map((_, i) => s.charCodeAt(i).toString(16).padStart(4, '0')).join(',');
    expect(readFileSync(out, 'utf8').split('\n')).toEqual(LITERALS.map(units));
  }, 900_000);
});
