// src/codegen-java.js: Playwright for Java and Selenium for Java (JUnit 5), registered
// on LLCodegen. Exact output for every target kind, action and assertion; escaping
// (Java's \uXXXX pre-processing included); page objects; test-data variables; parity
// with the Selenium JS locators; and — when a JDK and the Maven jars are available
// (node scripts/e2e/setup-java.mjs) — a javac compile of everything generated here.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { M2_REPO, javaToolchain } from '../scripts/e2e/setup-java.mjs';
import * as CORPUS from './codegen-corpus.mjs';
import { helperCallOf } from './codegen-helper-calls.mjs';

let C;
beforeAll(async () => {
  await import('../src/codegen.js');
  await import('../src/codegen-java.js');
  C = globalThis.LLCodegen;
});

const pw = (target) => C.locatorExpr(target, 'playwright', 'java');
const se = (target, rel) => C.locatorExpr(target, 'selenium', 'java', rel);
const pwStep = (step) => C.actionStatement(step, 'playwright', 'java');
const seStep = (step) => C.actionStatement(step, 'selenium', 'java');

const testid = (value, attr = 'data-testid') => ({ kind: 'testid', attr, value });
const role = (r, name, o = {}) => ({ kind: 'role', role: r, ...(name != null ? { name } : {}), ...o });
const label = (value, o = {}) => ({ kind: 'label', value, ...o });
const frame = (selector, child, o = {}) => ({ kind: 'frame', selector, index: 0, child, ...o });
const chain = (parent, child) => ({ kind: 'chain', parent, child });

/** Decode a Java string literal (as emitted: \\ \" \n \r \t \b \f, octal, \uXXXX). */
function javaString(lit) {
  expect(lit[0]).toBe('"');
  let out = '';
  for (let i = 1; i < lit.length - 1; i++) {
    const c = lit[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = lit[++i];
    if (n === 'u') {
      out += String.fromCharCode(parseInt(lit.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (/[0-7]/.test(n)) {
      out += String.fromCharCode(parseInt(lit.slice(i, i + 3), 8));
      i += 2;
    } else {
      out += { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '"': '"', '\\': '\\' }[n];
    }
  }
  return out;
}

/** Every `By.<how>(<literal>)` in a Selenium expression, decoded: [[how, selector], …]. */
function byCalls(code, lang) {
  if (lang === 'java') {
    return [...code.matchAll(/By\.(cssSelector|id|name|xpath)\(("(?:[^"\\]|\\.)*")\)/g)].map((m) => [
      m[1] === 'cssSelector' ? 'css' : m[1],
      javaString(m[2]),
    ]);
  }
  return [...code.matchAll(/By\.(css|id|name|xpath)\(('(?:[^'\\]|\\.)*')\)/g)].map((m) => [
    m[1],
    vm.runInNewContext(m[2]),
  ]);
}

// ── registration ────────────────────────────────────────────────────────────────

describe('registration', () => {
  it('adds Java to Playwright and Selenium only', () => {
    expect(C.LANGUAGES.find((l) => l.id === 'java')).toEqual({ id: 'java', label: 'Java' });
    expect(C.languagesFor('playwright').map((l) => l.id)).toEqual([
      'typescript',
      'javascript',
      'python',
      'java',
    ]);
    expect(C.languagesFor('selenium').map((l) => l.id)).toEqual([
      'typescript',
      'javascript',
      'python',
      'java',
    ]);
    expect(C.languagesFor('cypress').map((l) => l.id)).toEqual(['typescript', 'javascript']);
    expect(C.isValidCombo('playwright', 'java')).toBe(true);
    expect(C.isValidCombo('cypress', 'java')).toBe(false);
    expect(C.FRAMEWORKS.map((f) => f.id).slice(0, 3)).toEqual(['playwright', 'selenium', 'cypress']);
  });

  it('downloads as .java and leaves the built-in languages alone', () => {
    expect(C.fileExtension('java')).toBe('.java');
    expect(C.pageObjectFileName({ className: 'Login' }, 'selenium', 'java')).toBe('LoginPage.java');
    expect(C.pageObjectFileName({ className: 'Login' }, 'playwright', 'java')).toBe('LoginPage.java');
    expect(C.locatorExpr(role('button', 'Go'), 'playwright', 'typescript')).toBe(
      "page.getByRole('button', { name: 'Go' })"
    );
    expect(
      C.testScript([{ action: 'goto', value: 'https://a.example/' }], 'playwright', 'typescript')
    ).toContain("await page.goto('https://a.example/');");
  });

  it('does nothing (and does not throw) when codegen.js has not loaded', () => {
    const sandbox = {};
    expect(() =>
      vm.runInNewContext(readFileSync(new URL('../src/codegen-java.js', import.meta.url), 'utf8'), sandbox)
    ).not.toThrow();
    expect(sandbox.LLCodegen).toBeUndefined();
  });
});

// ── string literals ─────────────────────────────────────────────────────────────

describe('Java string literals', () => {
  const lit = (value) => pw(label(value)).slice('page.getByLabel('.length, -1);

  it('escapes quotes and backslashes', () => {
    expect(lit('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(lit("it's")).toBe('"it\'s"');
  });

  it('writes named escapes for \\n \\r \\t \\b \\f and octal for the other controls', () => {
    expect(lit('\n\r\t\b\f')).toBe('"\\n\\r\\t\\b\\f"');
    expect(lit('a\u0000b\u0001c\u001fd\u007fe')).toBe('"a\\000b\\001c\\037d\\177e"');
    // Octal is always three digits, so a following digit can never be swallowed.
    expect(lit('\u00007')).toBe('"\\0007"');
    expect(javaString(lit('\u00007'))).toBe('\u00007');
  });

  it('writes every non-ASCII character as \\uXXXX, so the source encoding never matters', () => {
    expect(lit('£ é')).toBe('"\\u00a3 \\u00e9"');
    expect(lit('😀')).toBe('"\\ud83d\\ude00"');
    expect(lit('a b ')).toBe('"a\\u2028b\\u2029"');
    expect(lit(' ')).toBe('"\\u00a0"');
  });

  it('keeps a literal "\\u000a" in a value inert (Java expands \\uXXXX before tokenising)', () => {
    // The backslash is doubled, so javac sees "\\u000a" — not a newline escape.
    expect(lit('\\u000a')).toBe('"\\\\u000a"');
    expect(lit('\\\\u0022')).toBe('"\\\\\\\\u0022"');
  });

  it('round-trips arbitrary strings', () => {
    const samples = [
      '',
      'plain',
      '"\'\\',
      '\u0000\u0008\u000b\u001b',
      'Grüße – 日本語 😀',
      '\\u0041\\\\uu0042',
      '\r\n',
    ];
    for (const s of samples) expect(javaString(lit(s)), JSON.stringify(s)).toBe(s);
  });

  it('defaults an empty CSS selector to body', () => {
    expect(lit('')).toBe('""');
    expect(pw({ kind: 'css', value: '' })).toBe('page.locator("body")');
    expect(pw({ kind: 'mystery' })).toBe('page.locator("body")');
  });
});

describe('comments stay comments', () => {
  const wrapped = (stmt, fw = 'playwright') => C.wrapScript([stmt], fw, 'java').split('\n');

  it("routes LLCodegen's own TODOs through the Java comment rules", () => {
    for (const fw of ['playwright', 'selenium']) {
      const step = (s) => C.actionStatement(s, fw, 'java');
      // Unknown action: \u000a neutralised, \u000d too, non-ASCII escaped.
      expect(step({ action: 'zap\\u000a}\\u000D é', target: testid('x') }), fw).toBe(
        '// TODO: unsupported step "zap\\\\u000a}\\\\u000D \\u00e9"'
      );
      // A step without a locator, and one whose chain is empty.
      expect(step({ action: 'fill', value: 'x' }), fw).toBe('// TODO: "fill" step has no element locator');
      expect(step({ action: 'click', target: frame('#f', null) }), fw).toBe(
        '// TODO: "click" step has no element locator'
      );
      const script = C.testScript(
        [
          { action: 'C:\\users\u2028', target: testid('x') },
          { action: 'hover' },
          { action: 'goto', value: 'https://e.example/' },
        ],
        fw,
        'java'
      );
      expect(script, fw).toContain('        // TODO: unsupported step "C:\\\\users "\n');
      expect(script, fw).toContain('        // TODO: "hover" step has no element locator\n');
    }
  });

  it('neutralises a \\u000a / \\u000d escape quoted in a comment (javac would end the line there)', () => {
    const todo = '// TODO: unsupported step "zap\\u000a}"';
    for (const fw of ['playwright', 'selenium']) {
      expect(wrapped(todo, fw)).toContain('        // TODO: unsupported step "zap\\\\u000a}"');
    }
    expect(wrapped('// a \\uuu000D b')).toContain('        // a \\\\uuu000D b');
  });

  it('neutralises a malformed escape (a Windows path) and keeps harmless ones', () => {
    expect(wrapped('// C:\\users\\me')).toContain('        // C:\\\\users\\me');
    expect(wrapped('// \\u12')).toContain('        // \\\\u12');
    expect(wrapped('// \\u00e9 and \\\\u000a')).toContain('        // \\u00e9 and \\\\u000a');
  });

  it('writes non-ASCII in comments as escapes, so any platform encoding reads the file', () => {
    expect(wrapped('// a\rb\u0000c\u007fd\te')).toContain('        // a b c d\te');
    expect(wrapped('// Café — 😀')).toContain('        // Caf\\u00e9 \\u2014 \\ud83d\\ude00');
  });

  it('is idempotent, and never touches string literals', () => {
    const once = C.wrapScript(['// x \\u000a — C:\\u'], 'selenium', 'java');
    const body = once.split('\n').filter((l) => l.startsWith('        // x'));
    expect(
      C.wrapScript(
        body.map((l) => l.trim()),
        'selenium',
        'java'
      )
    ).toBe(once);
    expect(C.wrapScript(['x("\\u00a3 \\u000a");'], 'playwright', 'java')).toContain(
      '        x("\\u00a3 \\u000a");'
    );
  });

  it('makes page-object titles and URLs safe', () => {
    const code = C.pageObject(
      { title: 'Café \\u000a x', pageUrl: 'https://e.example/\\u000d', elements: [] },
      'playwright',
      'java'
    );
    expect(code).toContain('// Page Object generated by Locatra for "Caf\\u00e9 \\\\u000a x".');
    expect(code).toContain('// Page: https://e.example/\\\\u000d');
  });
});

// ── Playwright locators ─────────────────────────────────────────────────────────

describe('Playwright for Java locators', () => {
  it('renders every target kind', () => {
    const cases = [
      [testid('save "it"'), 'page.getByTestId("save \\"it\\"")'],
      [testid('x\\y', 'data:qa'), 'page.locator("[data\\\\:qa=\\"x\\\\\\\\y\\"]")'],
      [
        role('button', 'Save'),
        'page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("Save"))',
      ],
      [
        role('heading', 'Title', { exact: true, level: 2 }),
        'page.getByRole(AriaRole.HEADING, new Page.GetByRoleOptions().setName("Title").setExact(true).setLevel(2))',
      ],
      [role('link', null, { nth: 1 }), 'page.getByRole(AriaRole.LINK).nth(1)'],
      [role('row'), 'page.getByRole(AriaRole.ROW)'],
      [
        role('heading', null, { level: 3 }),
        'page.getByRole(AriaRole.HEADING, new Page.GetByRoleOptions().setLevel(3))',
      ],
      [
        role('menuitemcheckbox', 'Bold'),
        'page.getByRole(AriaRole.MENUITEMCHECKBOX, new Page.GetByRoleOptions().setName("Bold"))',
      ],
      [label('Email'), 'page.getByLabel("Email")'],
      [
        label('Email', { exact: true }),
        'page.getByLabel("Email", new Page.GetByLabelOptions().setExact(true))',
      ],
      [{ kind: 'placeholder', value: 'Search' }, 'page.getByPlaceholder("Search")'],
      [
        { kind: 'placeholder', value: 'Search', exact: true },
        'page.getByPlaceholder("Search", new Page.GetByPlaceholderOptions().setExact(true))',
      ],
      [
        { kind: 'altText', value: 'Logo', exact: true },
        'page.getByAltText("Logo", new Page.GetByAltTextOptions().setExact(true))',
      ],
      [{ kind: 'title', value: 'Help' }, 'page.getByTitle("Help")'],
      [
        { kind: 'title', value: 'Help', exact: true },
        'page.getByTitle("Help", new Page.GetByTitleOptions().setExact(true))',
      ],
      [{ kind: 'text', value: 'Hi  there' }, 'page.getByText("Hi  there")'],
      [
        { kind: 'text', value: 'Hi', exact: true },
        'page.getByText("Hi", new Page.GetByTextOptions().setExact(true))',
      ],
      [{ kind: 'id', value: 'a:b' }, 'page.locator("#a\\\\:b")'],
      [{ kind: 'name', value: 'q"1' }, 'page.locator("[name=\\"q\\\\\\"1\\"]")'],
      [{ kind: 'css', value: 'form > .x' }, 'page.locator("form > .x")'],
    ];
    for (const [target, want] of cases) expect(pw(target), JSON.stringify(target)).toBe(want);
  });

  it('ignores exact on a role without a name, and a level that is not a positive integer', () => {
    expect(pw(role('button', null, { exact: true }))).toBe('page.getByRole(AriaRole.BUTTON)');
    expect(pw(role('heading', 'T', { level: 'x' }))).toBe(
      'page.getByRole(AriaRole.HEADING, new Page.GetByRoleOptions().setName("T"))'
    );
    expect(pw(role('heading', 'T', { level: 2.5 }))).toBe(pw(role('heading', 'T')));
    expect(pw(role('button', null, { nth: -1 }))).toBe('page.getByRole(AriaRole.BUTTON)');
  });

  it("falls back to Playwright's own role selector for a role AriaRole lacks", () => {
    expect(pw(role('fancy', 'Go "x"', { exact: true, level: 3, nth: 0 }))).toBe(
      'page.locator("internal:role=fancy[name=\\"Go \\\\\\"x\\\\\\"\\"s][level=3]").nth(0)'
    );
    expect(pw(role('fancy', 'a\\b'))).toBe('page.locator("internal:role=fancy[name=\\"a\\\\\\\\b\\"i]")');
    expect(pw(role('fancy'))).toBe('page.locator("internal:role=fancy")');
  });

  it('chains with the Locator options class', () => {
    expect(pw(chain(testid('row-2'), role('button', 'Delete')))).toBe(
      'page.getByTestId("row-2").getByRole(AriaRole.BUTTON, new Locator.GetByRoleOptions().setName("Delete"))'
    );
    expect(pw(chain(testid('row'), label('X', { exact: true })))).toBe(
      'page.getByTestId("row").getByLabel("X", new Locator.GetByLabelOptions().setExact(true))'
    );
    expect(pw(chain({ kind: 'id', value: 'a' }))).toBe('page.locator("#a")');
    expect(pw(chain(null, label('X', { exact: true })))).toBe(
      'page.getByLabel("X", new Page.GetByLabelOptions().setExact(true))'
    );
    expect(pw({ kind: 'chain' })).toBe('');
    expect(pw(null)).toBe('');
  });

  it('enters frames with frameLocator and the FrameLocator options class', () => {
    expect(pw(frame('#pay', label('Card number')))).toBe(
      'page.frameLocator("#pay").getByLabel("Card number")'
    );
    expect(pw(frame('#pay', role('button', 'Pay now')))).toBe(
      'page.frameLocator("#pay").getByRole(AriaRole.BUTTON, new FrameLocator.GetByRoleOptions().setName("Pay now"))'
    );
    // Cross-origin: no selector, so positional; nested frames continue the chain.
    expect(
      pw(
        frame('#outer', {
          kind: 'frame',
          selector: null,
          index: 2,
          child: { kind: 'text', value: 'Go', exact: true },
        })
      )
    ).toBe(
      'page.frameLocator("#outer").frameLocator("iframe >> nth=2").getByText("Go", new FrameLocator.GetByTextOptions().setExact(true))'
    );
    expect(pw({ kind: 'frame', selector: null, child: testid('t') })).toBe(
      'page.frameLocator("iframe >> nth=0").getByTestId("t")'
    );
    // Playwright's CSS pierces shadow roots, so the shadowPath is not needed.
    expect(
      pw(frame('x-pay iframe', { kind: 'id', value: 'cvc' }, { shadowPath: ['#shell', 'iframe'] }))
    ).toBe('page.frameLocator("x-pay iframe").locator("#cvc")');
    expect(pw(frame('#f', chain({ kind: 'css', value: 'form' }, role('button', 'OK'))))).toBe(
      'page.frameLocator("#f").locator("form").getByRole(AriaRole.BUTTON, new Locator.GetByRoleOptions().setName("OK"))'
    );
    expect(
      pw(
        chain(
          { kind: 'css', value: '.host' },
          frame('iframe', { kind: 'placeholder', value: 'P', exact: true })
        )
      )
    ).toBe(
      'page.locator(".host").frameLocator("iframe").getByPlaceholder("P", new FrameLocator.GetByPlaceholderOptions().setExact(true))'
    );
    expect(pw(frame('#f', null))).toBe('');
  });
});

// ── Selenium locators ───────────────────────────────────────────────────────────

const PARITY_TARGETS = [
  testid('save "it"'),
  testid('x\\y', 'data:qa'),
  role('button', 'Save'),
  role('heading', 'Title', { exact: true, level: 2 }),
  role('link', null, { nth: 1 }),
  role('row'),
  role('heading', null, { level: 1 }),
  role('button', 'Delete "row" it\'s'),
  role('img', 'Logo'),
  role('checkbox', 'Terms', { exact: true }),
  role('textbox', 'Search', { nth: 0 }),
  role('gridcell', 'A1'),
  label('Email'),
  label('Gift wrap (+ £3.50)', { exact: true }),
  { kind: 'placeholder', value: 'Search "all"' },
  { kind: 'placeholder', value: 'x', exact: true },
  { kind: 'altText', value: 'Logo' },
  { kind: 'title', value: 'Help', exact: true },
  { kind: 'text', value: 'Hi  there\n' },
  { kind: 'text', value: 'Hi', exact: true },
  { kind: 'id', value: 'a:b' },
  { kind: 'name', value: 'q"1' },
  { kind: 'css', value: 'form > .x' },
  { kind: 'css', value: '' },
  chain(testid('row-2'), role('button', 'Delete')),
  chain(testid('row'), { kind: 'text', value: 'Name' }),
  chain(testid('row'), label('L')),
  chain({ kind: 'css', value: 'table' }, { kind: 'text', value: 'Refactoring', exact: true }),
  chain({ kind: 'id', value: 'a' }),
  { kind: 'xpath', value: '//a[@title="it\'s"]' },
  chain(testid('row'), { kind: 'xpath', value: '//td[2]' }),
];

describe('Selenium for Java locators', () => {
  it('selects exactly what Selenium JavaScript selects (same By strategy and selector, same helper call)', () => {
    for (const t of PARITY_TARGETS) {
      const js = C.locatorExpr(t, 'selenium', 'javascript');
      const java = se(t);
      expect(byCalls(java, 'java'), JSON.stringify(t)).toEqual(byCalls(js, 'javascript'));
      const call = (code, lang) => {
        const c = helperCallOf(code, lang);
        return c && { ...c, root: null };
      };
      expect(call(java, 'java'), JSON.stringify(t)).toEqual(call(js, 'javascript'));
      expect(byCalls(java, 'java').length + (call(java, 'java') ? 1 : 0), JSON.stringify(t)).toBeGreaterThan(
        0
      );
      expect(byCalls(se(t, true), 'java'), JSON.stringify(t)).toEqual(
        byCalls(C.locatorExpr(t, 'selenium', 'javascript', true), 'javascript')
      );
    }
  });

  it('renders the Java By API', () => {
    expect(se(testid('go'))).toBe('driver.findElement(By.cssSelector("[data-testid=\\"go\\"]"))');
    expect(se({ kind: 'id', value: 'a:b' })).toBe('driver.findElement(By.id("a:b"))');
    expect(se({ kind: 'name', value: 'notes' })).toBe('driver.findElement(By.name("notes"))');
    expect(se({ kind: 'xpath', value: '//a[@id="x"]' })).toBe(
      'driver.findElement(By.xpath("//a[@id=\\"x\\"]"))'
    );
    // Role, label and text targets call the Locatra helper class (C9.4).
    expect(se(role('row'))).toBe('Locatra.find(driver, "role", "row", null, false, 0, 0)');
    expect(se(role('link', null, { nth: 1 }))).toBe(
      'Locatra.find(driver, "role", "link", null, false, 0, 1)'
    );
    expect(se(role('button', 'Save'))).toBe('Locatra.find(driver, "role", "button", "Save")');
    expect(se(role('button', 'Save', { exact: true }))).toBe(
      'Locatra.find(driver, "role", "button", "Save", true)'
    );
    expect(se(label('Email', { exact: true }))).toBe('Locatra.find(driver, "label", "Email", null, true)');
    expect(se({ kind: 'text', value: 'Hi' })).toBe('Locatra.find(driver, "text", "Hi")');
    expect(se({ kind: 'placeholder', value: 'P' })).toBe(
      'driver.findElement(By.cssSelector("[placeholder*=\\"P\\"]"))'
    );
  });

  it('roots a chained child at its parent (an XPath child with a leading dot)', () => {
    expect(se(chain(testid('row-2'), role('button', 'Delete')))).toBe(
      'Locatra.find(driver.findElement(By.cssSelector("[data-testid=\\"row-2\\"]")), "role", "button", "Delete")'
    );
    expect(se(chain(role('row', 'Ada'), testid('x')))).toBe(
      'Locatra.find(driver, "role", "row", "Ada").findElement(By.cssSelector("[data-testid=\\"x\\"]"))'
    );
    expect(se({ kind: 'xpath', value: '//td' }, true)).toBe('driver.findElement(By.xpath(".//td"))');
    expect(se({ kind: 'chain' })).toBe('');
    expect(se(chain(null, testid('c')))).toBe('driver.findElement(By.cssSelector("[data-testid=\\"c\\"]"))');
    expect(se(null)).toBe('');
  });

  it('renders a framed target as its inner element (switching is a statement)', () => {
    expect(se(frame('#pay', label('Card')))).toBe(se(label('Card')));
    expect(se(frame('#f', chain({ kind: 'css', value: 'form' }, testid('ok'))))).toBe(
      'driver.findElement(By.cssSelector("form")).findElement(By.cssSelector("[data-testid=\\"ok\\"]"))'
    );
    expect(se(frame('#f', null))).toBe('');
  });
});

// ── Playwright statements ───────────────────────────────────────────────────────

describe('Playwright for Java statements', () => {
  const t = testid('field');
  const loc = 'page.getByTestId("field")';

  it('renders every action', () => {
    expect(pwStep({ action: 'goto', value: 'https://a.example/?q="1"' })).toBe(
      'page.navigate("https://a.example/?q=\\"1\\"");'
    );
    expect(pwStep({ action: 'goto', url: 'https://b.example/' })).toBe(
      'page.navigate("https://b.example/");'
    );
    expect(pwStep({ action: 'goto' })).toBe('page.navigate("");');
    expect(pwStep({ action: 'click', target: t })).toBe(`${loc}.click();`);
    expect(pwStep({ action: 'dblclick', target: t })).toBe(`${loc}.dblclick();`);
    expect(pwStep({ action: 'hover', target: t })).toBe(`${loc}.hover();`);
    expect(pwStep({ action: 'check', target: t })).toBe(`${loc}.check();`);
    expect(pwStep({ action: 'uncheck', target: t })).toBe(`${loc}.uncheck();`);
    expect(pwStep({ action: 'fill', target: t, value: 'Ada "A"' })).toBe(`${loc}.fill("Ada \\"A\\"");`);
    expect(pwStep({ action: 'fill', target: t, value: '' })).toBe(`${loc}.fill("");`);
    expect(pwStep({ action: 'fill', target: t, value: '50', inputType: 'range' })).toBe(`${loc}.fill("50");`);
    expect(pwStep({ action: 'selectOption', target: t, value: 'Ireland' })).toBe(
      `${loc}.selectOption("Ireland");`
    );
  });

  it('presses keys and combos through the keyboard', () => {
    expect(pwStep({ action: 'press', value: 'Shift+Tab' })).toBe('page.keyboard().press("Shift+Tab");');
    expect(pwStep({ action: 'press', key: 'Escape' })).toBe('page.keyboard().press("Escape");');
    expect(pwStep({ action: 'press' })).toBe('page.keyboard().press("Enter");');
    expect(pwStep({ action: 'press', value: 'Control++' })).toBe('page.keyboard().press("Control++");');
  });

  it('sizes the viewport with integers', () => {
    expect(pwStep({ action: 'viewport', value: '1280x800' })).toBe('page.setViewportSize(1280, 800);');
    expect(pwStep({ action: 'viewport', width: 390.6, height: 844 })).toBe('page.setViewportSize(391, 844);');
    expect(pwStep({ action: 'viewport', value: 'nonsense' })).toBe('page.setViewportSize(1280, 720);');
  });

  it('reads a sensitive value from the environment, never the recorded value', () => {
    const out = pwStep({ action: 'fill', target: t, value: 'hunter2', sensitive: true });
    expect(out).toBe(`${loc}.fill(System.getenv().getOrDefault("LOCATRA_PASSWORD", ""));`);
    expect(pwStep({ action: 'fill', target: t, sensitive: true, secretName: 'MY_SECRET' })).toBe(
      `${loc}.fill(System.getenv().getOrDefault("MY_SECRET", ""));`
    );
    expect(pwStep({ action: 'fill', target: t, sensitive: true, secretName: 'bad name"' })).toContain(
      'getOrDefault("LOCATRA_PASSWORD", "")'
    );
  });

  it('uploads one file, several, or clears the input', () => {
    const note = '// NOTE: these file paths must exist relative to where the test runs\n';
    expect(pwStep({ action: 'upload', target: t, value: '["a.pdf"]' })).toBe(
      `${note}${loc}.setInputFiles(Paths.get("a.pdf"));`
    );
    expect(pwStep({ action: 'upload', target: t, value: '["a.pdf","b c.png"]' })).toBe(
      `${note}${loc}.setInputFiles(new Path[] {Paths.get("a.pdf"), Paths.get("b c.png")});`
    );
    expect(pwStep({ action: 'upload', target: t, value: '' })).toBe(
      `${note}${loc}.setInputFiles(new Path[0]);`
    );
    expect(pwStep({ action: 'upload', target: t, value: 'cv.pdf' })).toBe(
      `${note}${loc}.setInputFiles(Paths.get("cv.pdf"));`
    );
  });

  it('asserts with PlaywrightAssertions', () => {
    const a = (assertType, value) => pwStep({ action: 'assert', target: t, assertType, value });
    expect(a('toBeVisible')).toBe(`assertThat(${loc}).isVisible();`);
    expect(a(undefined)).toBe(`assertThat(${loc}).isVisible();`);
    expect(a('toBeSomethingNew')).toBe(`assertThat(${loc}).isVisible();`);
    expect(a('toHaveText', 'Ada  Lovelace')).toBe(
      `assertThat(${loc}).hasText("Ada  Lovelace", new LocatorAssertions.HasTextOptions().setUseInnerText(true));`
    );
    expect(a('toContainText', 'Ada')).toBe(
      `assertThat(${loc}).containsText("Ada", new LocatorAssertions.ContainsTextOptions().setUseInnerText(true));`
    );
    expect(a('toHaveValue', 'Ireland')).toBe(`assertThat(${loc}).hasValue("Ireland");`);
    expect(a('toHaveValue', null)).toBe(`assertThat(${loc}).hasValue("");`);
    expect(a('toBeEnabled')).toBe(`assertThat(${loc}).isEnabled();`);
    expect(a('toBeChecked', 'true')).toBe(`assertThat(${loc}).isChecked();`);
    expect(a('toBeChecked', false)).toBe(`assertThat(${loc}).not().isChecked();`);
  });

  it('asserts the URL on the page, ignoring any target', () => {
    expect(pwStep({ action: 'assert', assertType: 'toHaveURL', value: 'https://a.example/done' })).toBe(
      'assertThat(page).hasURL("https://a.example/done");'
    );
    expect(
      pwStep({ action: 'assert', assertType: 'toHaveURL', value: '', url: 'https://u.example/', target: t })
    ).toBe('assertThat(page).hasURL("https://u.example/");');
    expect(pwStep({ action: 'assert', assertType: 'toHaveURL' })).toBe('assertThat(page).hasURL("");');
  });

  it('turns unusable steps into TODO comments, never broken code', () => {
    expect(pwStep({ action: 'click' })).toBe('// TODO: "click" step has no element locator');
    expect(pwStep({ action: 'click', target: { kind: 'chain' } })).toBe(
      '// TODO: "click" step has no element locator'
    );
    expect(pwStep({ action: 'teleport', target: t })).toBe('// TODO: unsupported step "teleport"');
    expect(C.actionStatement(null, 'playwright', 'java')).toBe('');
  });

  it('notes nothing for an ambiguous role: Playwright reports a strict-mode violation itself', () => {
    expect(pwStep({ action: 'click', target: role('row') })).toBe('page.getByRole(AriaRole.ROW).click();');
  });
});

// ── Selenium statements ─────────────────────────────────────────────────────────

describe('Selenium for Java statements', () => {
  const t = testid('field');
  const loc = 'driver.findElement(By.cssSelector("[data-testid=\\"field\\"]"))';
  const block = (...lines) => `{\n    WebElement el = ${loc};\n${lines.map((l) => `    ${l}`).join('\n')}\n}`;
  const CHECKED = 'el.isSelected() || "true".equals(el.getDomAttribute("aria-checked"))';

  it('renders every action', () => {
    expect(seStep({ action: 'goto', value: 'https://a.example/' })).toBe('driver.get("https://a.example/");');
    expect(seStep({ action: 'goto', url: 'https://b.example/' })).toBe('driver.get("https://b.example/");');
    expect(seStep({ action: 'click', target: t })).toBe(`${loc}.click();`);
    expect(seStep({ action: 'dblclick', target: t })).toBe(
      `new Actions(driver).doubleClick(${loc}).perform();`
    );
    expect(seStep({ action: 'hover', target: t })).toBe(
      `new Actions(driver).moveToElement(${loc}).perform();`
    );
    expect(seStep({ action: 'selectOption', target: t, value: 'Ireland' })).toBe(
      `new Select(${loc}).selectByVisibleText("Ireland");`
    );
  });

  it('only toggles a checkbox (native or ARIA) whose state differs', () => {
    expect(seStep({ action: 'check', target: t })).toBe(block(`if (!(${CHECKED})) el.click();`));
    expect(seStep({ action: 'uncheck', target: t })).toBe(block(`if (${CHECKED}) el.click();`));
  });

  it('clears before typing, and sets range/colour/date values through the value setter', () => {
    expect(seStep({ action: 'fill', target: t, value: 'Ada' })).toBe(
      block('el.clear();', 'el.sendKeys("Ada");')
    );
    for (const inputType of ['range', 'color', 'date', 'time', 'datetime-local', 'month', 'week']) {
      const out = seStep({ action: 'fill', target: t, value: '5', inputType });
      // The script is a class constant (LOCATRA_SET_VALUE_JS), declared once.
      expect(out).toMatch(
        /^\(\(JavascriptExecutor\) driver\)\.executeScript\(LOCATRA_SET_VALUE_JS, driver\.findElement\(.*\), "5"\);$/
      );
      const file = C.testScript([{ action: 'fill', target: t, value: '5', inputType }], 'selenium', 'java');
      const decl = /private static final String LOCATRA_SET_VALUE_JS = ("(?:[^"\\]|\\.)*");/.exec(file);
      expect(javaString(decl[1])).toBe(C._internals.SET_VALUE_JS);
    }
    expect(seStep({ action: 'fill', target: t, value: 'x', inputType: 'text' })).toBe(
      block('el.clear();', 'el.sendKeys("x");')
    );
  });

  it('reads a sensitive value from the environment', () => {
    expect(seStep({ action: 'fill', target: t, value: 'hunter2', sensitive: true, secretName: 'PW' })).toBe(
      block('el.clear();', 'el.sendKeys(System.getenv().getOrDefault("PW", ""));')
    );
  });

  it('uploads absolute paths, newline-separated, or clears the input', () => {
    const note = '// NOTE: these file paths must exist relative to where the test runs\n';
    expect(seStep({ action: 'upload', target: t, value: '["a.pdf"]' })).toBe(
      `${note}${loc}.sendKeys(Paths.get("a.pdf").toAbsolutePath().toString());`
    );
    expect(seStep({ action: 'upload', target: t, value: ['a.pdf', 'b.pdf'] })).toBe(
      `${note}${loc}.sendKeys(Paths.get("a.pdf").toAbsolutePath().toString() + "\\n" + Paths.get("b.pdf").toAbsolutePath().toString());`
    );
    expect(seStep({ action: 'upload', target: t, value: '[]' })).toBe(`${loc}.clear();`);
  });

  it('maps keys and modifier combos onto Actions', () => {
    expect(seStep({ action: 'press', value: 'Tab' })).toBe(
      'new Actions(driver).sendKeys(Keys.TAB).perform();'
    );
    expect(seStep({ action: 'press' })).toBe('new Actions(driver).sendKeys(Keys.ENTER).perform();');
    expect(seStep({ action: 'press', value: 'Shift+Tab' })).toBe(
      'new Actions(driver).keyDown(Keys.SHIFT).sendKeys(Keys.TAB).keyUp(Keys.SHIFT).perform();'
    );
    expect(seStep({ action: 'press', value: 'Control+Shift+a' })).toBe(
      'new Actions(driver).keyDown(Keys.CONTROL).keyDown(Keys.SHIFT).sendKeys("a").keyUp(Keys.SHIFT).keyUp(Keys.CONTROL).perform();'
    );
    expect(seStep({ action: 'press', value: ' ' })).toBe(
      'new Actions(driver).sendKeys(Keys.SPACE).perform();'
    );
    expect(seStep({ action: 'press', value: 'Meta++' })).toBe(
      'new Actions(driver).keyDown(Keys.META).sendKeys("+").keyUp(Keys.META).perform();'
    );
    expect(seStep({ action: 'press', value: '"' })).toBe('new Actions(driver).sendKeys("\\"").perform();');
    expect(seStep({ action: 'press', key: 'F5' })).toBe('new Actions(driver).sendKeys(Keys.F5).perform();');
  });

  it('never turns an unknown key or modifier into a different key', () => {
    expect(seStep({ action: 'press', value: 'MediaPlay' })).toBe(
      '// TODO: press "MediaPlay" - no Selenium key mapping'
    );
    expect(seStep({ action: 'press', value: 'Hyper+a' })).toBe(
      '// TODO: press "Hyper+a" - modifier not supported'
    );
  });

  it('sizes the window to the recorded viewport plus the browser chrome', () => {
    expect(seStep({ action: 'viewport', value: '1280x800' })).toBe(
      [
        '{',
        '    JavascriptExecutor js = (JavascriptExecutor) driver;',
        '    int width = ((Number) js.executeScript("return 1280 + window.outerWidth - window.innerWidth;")).intValue();',
        '    int height = ((Number) js.executeScript("return 800 + window.outerHeight - window.innerHeight;")).intValue();',
        '    driver.manage().window().setSize(new Dimension(width, height));',
        '}',
      ].join('\n')
    );
    expect(seStep({ action: 'viewport', width: 400, height: 300.4 })).toContain(
      '"return 300 + window.outerHeight'
    );
  });

  it('asserts with JUnit, comparing whitespace-normalised text', () => {
    const a = (assertType, value) => seStep({ action: 'assert', target: t, assertType, value });
    const text = `${loc}.getText().replaceAll("[\\\\u00ad\\\\u200b]", "").replaceAll("(?U)\\\\s+", " ").trim()`;
    expect(a('toBeVisible')).toBe(`assertTrue(${loc}.isDisplayed());`);
    expect(a('somethingNew')).toBe(`assertTrue(${loc}.isDisplayed());`);
    expect(a('toHaveText', '  Ada\n Lovelace ')).toBe(`assertEquals("Ada Lovelace", ${text});`);
    expect(a('toContainText', 'Ada  L')).toBe(`assertTrue(${text}.contains("Ada L"));`);
    expect(a('toHaveValue', 'Ireland')).toBe(`assertEquals("Ireland", ${loc}.getDomProperty("value"));`);
    expect(a('toBeEnabled')).toBe(`assertTrue(${loc}.isEnabled());`);
    expect(a('toBeChecked', 'true')).toBe(block(`assertTrue(${CHECKED});`));
    expect(a('toBeChecked', 'false')).toBe(block(`assertFalse(${CHECKED});`));
  });

  it('waits for the URL', () => {
    expect(
      seStep({
        action: 'assert',
        assertType: 'toHaveURL',
        value: 'https://a.example/x',
        target: frame('#f', t),
      })
    ).toBe(
      'new WebDriverWait(driver, Duration.ofSeconds(10)).until(ExpectedConditions.urlToBe("https://a.example/x"));'
    );
    expect(seStep({ action: 'assert', assertType: 'toHaveURL', url: 'https://u.example/' })).toContain(
      'urlToBe("https://u.example/")'
    );
  });

  it('switches into frames, acts, and switches back out', () => {
    expect(seStep({ action: 'click', target: frame('#pay', t) })).toBe(
      [
        'driver.switchTo().frame(driver.findElement(By.cssSelector("#pay")));',
        `${loc}.click();`,
        'driver.switchTo().defaultContent();',
      ].join('\n')
    );
    expect(
      seStep({
        action: 'click',
        target: {
          kind: 'frame',
          selector: '#a',
          child: { kind: 'frame', selector: null, index: 2, child: t },
        },
      })
    ).toBe(
      [
        'driver.switchTo().frame(driver.findElement(By.cssSelector("#a")));',
        'driver.switchTo().frame((WebElement) ((JavascriptExecutor) driver).executeScript(LOCATRA_FRAME_JS, 2));',
        `${loc}.click();`,
        'driver.switchTo().defaultContent();',
      ].join('\n')
    );
    expect(
      seStep({
        action: 'fill',
        value: 'x',
        target: { kind: 'frame', selector: null, index: 'junk', child: t },
      }).split('\n')[0]
    ).toBe(
      'driver.switchTo().frame((WebElement) ((JavascriptExecutor) driver).executeScript(LOCATRA_FRAME_JS, 0));'
    );
  });

  it('walks shadow roots to an <iframe> inside shadow DOM', () => {
    const target = frame(
      'x-pay iframe',
      { kind: 'id', value: 'cvc' },
      { shadowPath: ['#shell', 'x-inner', 'iframe'] }
    );
    expect(seStep({ action: 'click', target })).toBe(
      [
        'driver.switchTo().frame(driver.findElement(By.cssSelector("#shell")).getShadowRoot().findElement(By.cssSelector("x-inner")).getShadowRoot().findElement(By.cssSelector("iframe")));',
        'driver.findElement(By.id("cvc")).click();',
        'driver.switchTo().defaultContent();',
      ].join('\n')
    );
    // An unusable path falls back to the frame selector.
    expect(seStep({ action: 'click', target: { ...target, shadowPath: ['only-one'] } }).split('\n')[0]).toBe(
      'driver.switchTo().frame(driver.findElement(By.cssSelector("x-pay iframe")));'
    );
  });

  it('notes an ambiguous role locator, inside the frame switch too', () => {
    const note =
      '// NOTE: this role locator has no accessible name and may match several elements; the first match is used.';
    expect(seStep({ action: 'click', target: role('row') })).toBe(
      `${note}\nLocatra.find(driver, "role", "row", null, false, 0, 0).click();`
    );
    expect(seStep({ action: 'click', target: frame('#f', role('row')) }).split('\n')[1]).toBe(note);
    expect(seStep({ action: 'click', target: role('row', null, { matchCount: 1 }) })).not.toContain('NOTE');
  });

  it('turns unusable steps into TODO comments', () => {
    expect(seStep({ action: 'fill', value: 'x' })).toBe('// TODO: "fill" step has no element locator');
    expect(seStep({ action: 'check', target: { kind: 'chain' } })).toBe(
      '// TODO: "check" step has no element locator'
    );
    expect(seStep({ action: 'click', target: frame('#f', null) })).toBe(
      '// TODO: "click" step has no element locator'
    );
  });
});

// ── test files ──────────────────────────────────────────────────────────────────

const SMALL_FLOW = [
  { action: 'goto', value: 'https://shop.example/' },
  { action: 'fill', target: label('First name'), value: 'Ada' },
  { action: 'click', target: role('button', 'Save') },
  { action: 'assert', target: testid('done'), assertType: 'toHaveText', value: 'Saved' },
];

describe('Playwright for Java test file', () => {
  it('renders a JUnit 5 test with the Playwright fixture', () => {
    expect(C.testScript(SMALL_FLOW, 'playwright', 'java')).toBe(
      [
        'import com.microsoft.playwright.Page;',
        'import com.microsoft.playwright.assertions.LocatorAssertions;',
        'import com.microsoft.playwright.junit.UsePlaywright;',
        'import com.microsoft.playwright.options.AriaRole;',
        'import org.junit.jupiter.api.Test;',
        '',
        'import static com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat;',
        '',
        '@UsePlaywright',
        'class RecordedTest {',
        '    @Test',
        '    void recordedTest(Page page) {',
        '        page.navigate("https://shop.example/");',
        '        page.getByLabel("First name").fill("Ada");',
        '        page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("Save")).click();',
        '        assertThat(page.getByTestId("done")).hasText("Saved", new LocatorAssertions.HasTextOptions().setUseInnerText(true));',
        '    }',
        '}',
        '',
      ].join('\n')
    );
  });

  it('imports only what the body uses', () => {
    const bare = C.testScript([{ action: 'click', target: testid('a') }], 'playwright', 'java');
    expect(bare).not.toMatch(/AriaRole|assertThat|Locator|java\.nio|java\.util/);
    const rich = C.testScript(
      [
        { action: 'click', target: chain(testid('r'), role('button', 'X')) },
        { action: 'click', target: frame('#f', role('button', 'Y')) },
        { action: 'upload', target: testid('u'), value: '["a","b"]' },
      ],
      'playwright',
      'java'
    );
    for (const imp of [
      'com.microsoft.playwright.FrameLocator',
      'com.microsoft.playwright.Locator',
      'com.microsoft.playwright.options.AriaRole',
      'java.nio.file.Path',
      'java.nio.file.Paths',
    ]) {
      expect(rich).toContain(`import ${imp};\n`);
    }
    // A type name inside a string literal does not pull in an import.
    expect(
      C.testScript(
        [{ action: 'fill', target: testid('a'), value: 'AriaRole.X Locator. assertThat(' }],
        'playwright',
        'java'
      )
    ).not.toMatch(/import .*(AriaRole|Locator|assertThat)/);
  });

  it('produces a complete class for an empty recording', () => {
    expect(C.wrapScript([], 'playwright', 'java')).toBe(
      [
        'import com.microsoft.playwright.Page;',
        'import com.microsoft.playwright.junit.UsePlaywright;',
        'import org.junit.jupiter.api.Test;',
        '',
        '@UsePlaywright',
        'class RecordedTest {',
        '    @Test',
        '    void recordedTest(Page page) {',
        '    }',
        '}',
        '',
      ].join('\n')
    );
    expect(C.wrapScript(null, 'playwright', 'java')).toBe(C.wrapScript([], 'playwright', 'java'));
    expect(C.testScript(null, 'playwright', 'java')).toBe(C.wrapScript([], 'playwright', 'java'));
  });

  it('indents every line of a multi-line statement and leaves suggested steps out', () => {
    const steps = [
      { action: 'upload', target: testid('u'), value: '["a"]' },
      { action: 'assert', target: testid('x'), assertType: 'toBeVisible', suggested: true },
    ];
    const out = C.testScript(steps, 'playwright', 'java');
    expect(out).toContain(
      '        // NOTE: these file paths must exist relative to where the test runs\n        page.getByTestId("u").setInputFiles(Paths.get("a"));\n'
    );
    expect(out).not.toContain('isVisible');
    const stmts = steps.map(pwStep);
    expect(C.wrapScript(stmts, 'playwright', 'java', steps)).toBe(out);
  });
});

describe('Selenium for Java test file', () => {
  it('renders a JUnit 5 test that owns its ChromeDriver', () => {
    const out = C.testScript(SMALL_FLOW, 'selenium', 'java');
    const head = [
      'import org.junit.jupiter.api.AfterEach;',
      'import org.junit.jupiter.api.BeforeEach;',
      'import org.junit.jupiter.api.Test;',
      'import org.openqa.selenium.By;',
      'import org.openqa.selenium.JavascriptExecutor;',
      'import org.openqa.selenium.NoSuchElementException;',
      'import org.openqa.selenium.SearchContext;',
      'import org.openqa.selenium.WebDriver;',
      'import org.openqa.selenium.WebDriverException;',
      'import org.openqa.selenium.WebElement;',
      'import org.openqa.selenium.WrapsDriver;',
      'import org.openqa.selenium.chrome.ChromeDriver;',
      '',
      'import java.time.Duration;',
      'import java.util.ArrayList;',
      'import java.util.List;',
      '',
      'import static org.junit.jupiter.api.Assertions.assertEquals;',
      '',
      'class RecordedTest {',
      '    private WebDriver driver;',
      '',
      '    @BeforeEach',
      '    void setUp() {',
      '        driver = new ChromeDriver();',
      '        // Selenium has no auto-wait: give elements time to appear.',
      '        driver.manage().timeouts().implicitlyWait(Duration.ofSeconds(10));',
      '    }',
      '',
      '    @AfterEach',
      '    void tearDown() {',
      '        if (driver != null) driver.quit();',
      '    }',
      '',
      '    @Test',
      '    void recordedTest() {',
      '        driver.get("https://shop.example/");',
      '        {',
      '            WebElement el = Locatra.find(driver, "label", "First name");',
    ].join('\n');
    expect(out.startsWith(head)).toBe(true);
    expect(out).toContain(
      [
        '        assertEquals("Saved", driver.findElement(By.cssSelector("[data-testid=\\"done\\"]")).getText()' +
          '.replaceAll("[\\\\u00ad\\\\u200b]", "").replaceAll("(?U)\\\\s+", " ").trim());',
        '    }',
        '',
        "    // Locatra: the one element a role / label / text locator matches, found the way Playwright's",
      ].join('\n')
    );
    // The helper class closes the test class, declared once.
    expect(out.match(/^ {4}static final class Locatra \{$/gm)).toHaveLength(1);
    expect(out.endsWith('        }\n    }\n}\n')).toBe(true);
    expect(out).toContain('            el.clear();\n            el.sendKeys("Ada");\n        }\n');
  });

  it('imports only what the body uses', () => {
    const empty = C.wrapScript([], 'selenium', 'java');
    expect(empty).not.toMatch(
      /import org\.openqa\.selenium\.(By|Keys|WebElement|interactions|support)|import static/
    );
    expect(empty).toContain('import java.time.Duration;');
    expect(empty).toContain('    void recordedTest() {\n    }\n}\n');
    const all = C.testScript(
      [
        { action: 'viewport', value: '800x600' },
        { action: 'press', value: 'Tab' },
        { action: 'hover', target: testid('h') },
        { action: 'selectOption', target: testid('s'), value: 'x' },
        { action: 'upload', target: testid('u'), value: '["f"]' },
        { action: 'assert', assertType: 'toHaveURL', value: 'https://x.example/' },
        { action: 'assert', target: testid('c'), assertType: 'toBeChecked', value: 'false' },
        { action: 'assert', target: testid('v'), assertType: 'toBeVisible' },
      ],
      'selenium',
      'java'
    );
    for (const imp of [
      'org.openqa.selenium.Dimension',
      'org.openqa.selenium.JavascriptExecutor',
      'org.openqa.selenium.Keys',
      'org.openqa.selenium.interactions.Actions',
      'org.openqa.selenium.support.ui.ExpectedConditions',
      'org.openqa.selenium.support.ui.Select',
      'org.openqa.selenium.support.ui.WebDriverWait',
      'java.nio.file.Paths',
    ]) {
      expect(all).toContain(`import ${imp};\n`);
    }
    expect(all).toContain(
      'import static org.junit.jupiter.api.Assertions.assertFalse;\nimport static org.junit.jupiter.api.Assertions.assertTrue;\n'
    );
    expect(all).not.toContain('assertEquals;');
  });
});

// ── test-data variables ─────────────────────────────────────────────────────────

describe('test-data variables', () => {
  const steps = [
    { eventId: 'e1', action: 'fill', target: label('First name'), value: 'Ada' },
    { eventId: 'e2', action: 'selectOption', target: role('combobox', 'Country'), value: 'Ireland' },
    { eventId: 'e3', action: 'fill', target: label('Password'), value: 'pw', sensitive: true },
    { eventId: 'e4', action: 'fill', target: label('First name'), value: 'Ada' },
  ];

  it('references TEST_DATA from fill and selectOption, and declares one Map field', () => {
    const vars = [
      { name: 'firstName', value: 'Ada' },
      { name: 'country', value: 'Ireland "IE"' },
    ];
    const refSteps = steps.map((s) =>
      s.sensitive ? s : { ...s, varRef: s.action === 'fill' ? 'firstName' : 'country' }
    );
    expect(pwStep(refSteps[0])).toBe('page.getByLabel("First name").fill(TEST_DATA.get("firstName"));');
    expect(pwStep(refSteps[1])).toBe(
      'page.getByRole(AriaRole.COMBOBOX, new Page.GetByRoleOptions().setName("Country")).selectOption(TEST_DATA.get("country"));'
    );
    expect(seStep(refSteps[1])).toMatch(/\)\.selectByVisibleText\(TEST_DATA\.get\("country"\)\);$/);
    expect(seStep(refSteps[0])).toContain('    el.sendKeys(TEST_DATA.get("firstName"));');
    // A sensitive value stays an environment variable even with a varRef.
    expect(pwStep({ ...steps[2], varRef: 'password' })).toContain(
      'System.getenv().getOrDefault("LOCATRA_PASSWORD", "")'
    );
    // An invalid or reserved reference renders the literal.
    expect(pwStep({ ...steps[0], varRef: 'not valid' })).toContain('.fill("Ada");');
    expect(pwStep({ ...steps[0], varRef: 'class' })).toContain('.fill("Ada");');
    expect(pwStep({ action: 'click', target: label('x'), varRef: 'firstName' })).toBe(
      'page.getByLabel("x").click();'
    );

    const field = [
      '    private static final Map<String, String> TEST_DATA = Map.ofEntries(',
      '        Map.entry("firstName", "Ada"),',
      '        Map.entry("country", "Ireland \\"IE\\"")',
      '    );',
      '',
    ].join('\n');
    for (const fw of ['playwright', 'selenium']) {
      const stmts = refSteps.map((s) => C.actionStatement(s, fw, 'java'));
      const out = C.wrapScript(stmts, fw, 'java', refSteps, { variables: vars });
      expect(out, fw).toContain(`class RecordedTest {\n${field}\n`);
      expect(out, fw).toContain('import java.util.Map;\n');
      expect(out.match(/TEST_DATA = /g), fw).toHaveLength(1);
      expect(out, fw).not.toContain('"pw"');
    }
  });

  it('declares a name a step references even when the list omits it, once per name', () => {
    const refSteps = [{ ...steps[0], varRef: 'firstName' }];
    const out = C.wrapScript([pwStep(refSteps[0])], 'playwright', 'java', refSteps, {
      variables: [
        { name: 'lastName', value: 'L' },
        { name: 'lastName', value: 'dupe' },
        { name: 'bad name', value: 'x' },
        null,
      ],
    });
    expect(out).toContain('Map.entry("lastName", "L"),\n        Map.entry("firstName", "Ada")\n    );');
    expect(out).not.toContain('dupe');
    expect(out).not.toContain('bad name');
  });

  it('renders no field and no import without variables', () => {
    for (const fw of ['playwright', 'selenium']) {
      for (const opts of [undefined, {}, { variables: [] }, { variables: false }, { other: 1 }]) {
        const out = C.wrapScript([C.actionStatement(steps[0], fw, 'java')], fw, 'java', [steps[0]], opts);
        expect(out, `${fw} ${JSON.stringify(opts)}`).not.toMatch(/TEST_DATA|java\.util\.Map/);
      }
    }
  });

  it('gets a normalised list from LLCodegen.wrapScript (no duplicate keys or null values)', () => {
    const variables = [
      { name: 'a', value: null },
      { name: 'a', value: 'x' },
      { name: '', value: 'y' },
      { value: 'z' },
    ];
    const out = C.wrapScript([], 'selenium', 'java', [], { variables });
    expect(out).toContain('Map.ofEntries(\n        Map.entry("a", "")\n    );');
  });

  it('wires through testScript({ variables: true }) with matching keys', () => {
    for (const fw of ['playwright', 'selenium']) {
      const out = C.testScript(steps, fw, 'java', { variables: true });
      const declared = [...out.matchAll(/Map\.entry\("(\w+)", /g)].map((m) => m[1]);
      const used = [...new Set([...out.matchAll(/TEST_DATA\.get\("(\w+)"\)/g)].map((m) => m[1]))];
      expect(declared.length, fw).toBeGreaterThan(0);
      expect(used.sort(), fw).toEqual([...declared].sort());
      expect(out, fw).toContain('System.getenv().getOrDefault("LOCATRA_PASSWORD", "")');
      expect(out, fw).not.toContain('"pw"');
      // Without the option, today's literal output.
      expect(C.testScript(steps, fw, 'java')).not.toContain('TEST_DATA');
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
  title: 'Checkout – "Shop"\nline two',
  elements: [
    { name: 'emailAddressInput', kind: 'input', inputType: 'email', target: label('Email address') },
    { name: 'notesField', kind: 'textarea', target: { kind: 'placeholder', value: 'it\'s "quoted"' } },
    { name: 'countrySelect', kind: 'select', target: role('combobox', 'Country') },
    { name: 'termsCheckbox', kind: 'checkbox', target: role('checkbox', 'Terms') },
    { name: 'expressRadio', kind: 'radio', target: role('radio', 'Express', { exact: true }) },
    { name: 'placeOrderButton', kind: 'button', target: testid('place-order') },
    { name: 'deleteButton', kind: 'button', target: chain(testid('row-2'), role('button', 'Delete')) },
    { name: 'editButton', kind: 'button', target: role('button', 'Edit', { nth: 1 }) },
    { name: 'helpLink', kind: 'link', target: role('link', 'Help') },
    { name: 'cardNumberInput', kind: 'input', target: frame('#pay', label('Card number')) },
    {
      name: 'cvcInput',
      kind: 'input',
      target: frame(
        'x-pay iframe',
        { kind: 'id', value: 'cvc' },
        { index: 1, shadowPath: ['#shell', 'iframe'] }
      ),
    },
    {
      name: 'thirdPartyButton',
      kind: 'button',
      target: { kind: 'frame', selector: null, index: 2, child: { kind: 'text', value: 'Go', exact: true } },
    },
    { name: 'qtyInput', kind: 'input', inputType: 'range', target: { kind: 'id', value: 'qty' } },
    { name: 'avatar', kind: 'other', target: { kind: 'altText', value: 'Avatar' } },
    { name: 'bio', kind: 'other', role: 'textbox', target: { kind: 'title', value: 'Bio' } },
    { name: 'resume', kind: 'input', inputType: 'file', target: { kind: 'name', value: 'cv' } },
    { name: 'anyRow', kind: 'other', target: role('row'), matchCount: 3, unique: false },
    { name: 'missing', kind: 'button', target: { kind: 'css', value: '.gone' }, matchCount: 0 },
    { name: 'shaky', kind: 'button', target: testid('shaky'), unique: false },
    { name: 'someCell', kind: 'weird', target: role('cell') },
    { name: 'nothing', kind: 'button', target: null },
    { name: 'emptyChain', kind: 'button', target: { kind: 'chain' } },
  ],
};

describe('page objects: exact output', () => {
  it('renders the Playwright for Java class', () => {
    expect(C.pageObject(SMALL, 'playwright', 'java')).toBe(
      [
        '// Page Object generated by Locatra for "Checkout | Shop".',
        '// Page: https://shop.example/checkout',
        'import com.microsoft.playwright.Locator;',
        'import com.microsoft.playwright.Page;',
        'import com.microsoft.playwright.options.AriaRole;',
        '',
        'public class CheckoutPage {',
        '    public final Page page;',
        '    public final Locator emailAddressInput;',
        '    public final Locator placeOrderButton;',
        '',
        '    public CheckoutPage(Page page) {',
        '        this.page = page;',
        '        this.emailAddressInput = page.getByLabel("Email address");',
        '        this.placeOrderButton = page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("Place order"));',
        '    }',
        '',
        '    public void navigate() {',
        '        this.page.navigate("https://shop.example/checkout");',
        '    }',
        '',
        '    public void fillEmailAddressInput(String value) {',
        '        this.emailAddressInput.fill(value);',
        '    }',
        '',
        '    public void clickPlaceOrderButton() {',
        '        this.placeOrderButton.click();',
        '    }',
        '}',
        '',
      ].join('\n')
    );
  });

  it('renders the Selenium for Java class with lazy lookups', () => {
    const code = C.pageObject(SMALL, 'selenium', 'java');
    const xpath = C.locatorExpr(SMALL.elements[0].target, 'selenium', 'java');
    const button = C.locatorExpr(SMALL.elements[1].target, 'selenium', 'java');
    expect(xpath).toBe('Locatra.find(driver, "label", "Email address")');
    expect(code.slice(0, code.indexOf('    // Locatra: the one element'))).toBe(
      [
        '// Page Object generated by Locatra for "Checkout | Shop".',
        '// Page: https://shop.example/checkout',
        'import org.openqa.selenium.JavascriptExecutor;',
        'import org.openqa.selenium.NoSuchElementException;',
        'import org.openqa.selenium.SearchContext;',
        'import org.openqa.selenium.WebDriver;',
        'import org.openqa.selenium.WebDriverException;',
        'import org.openqa.selenium.WebElement;',
        'import org.openqa.selenium.WrapsDriver;',
        '',
        'import java.util.ArrayList;',
        'import java.util.List;',
        '',
        'public class CheckoutPage {',
        '    public final WebDriver driver;',
        '',
        '    public CheckoutPage(WebDriver driver) {',
        '        this.driver = driver;',
        '    }',
        '',
        '    public void navigate() {',
        '        driver.get("https://shop.example/checkout");',
        '    }',
        '',
        '    public WebElement emailAddressInput() {',
        `        return ${xpath};`,
        '    }',
        '',
        '    public WebElement placeOrderButton() {',
        `        return ${button};`,
        '    }',
        '',
        '    public void fillEmailAddressInput(String value) {',
        '        WebElement el = emailAddressInput();',
        '        el.clear();',
        '        el.sendKeys(value);',
        '    }',
        '',
        '    public void clickPlaceOrderButton() {',
        '        placeOrderButton().click();',
        '    }',
        '',
        '',
      ].join('\n')
    );
    expect(code.endsWith('        }\n    }\n}\n')).toBe(true);
  });

  it('is deterministic and handles an empty or missing model', () => {
    for (const fw of ['playwright', 'selenium']) {
      expect(C.pageObject(RICH, fw, 'java')).toBe(C.pageObject(RICH, fw, 'java'));
      const empty = C.pageObject(null, fw, 'java');
      expect(empty, fw).toMatch(/^\/\/ Page Object generated by Locatra\.\n/);
      expect(empty, fw).toContain('public class HomePage {');
      expect(empty, fw).not.toContain('navigate()');
    }
  });
});

describe('page objects: members and helpers', () => {
  const pwCode = () => C.pageObject(RICH, 'playwright', 'java');
  const seCode = () => C.pageObject(RICH, 'selenium', 'java');

  it('gives each kind the same helpers as the JS targets', () => {
    const helpers = (code) => [...code.matchAll(/public void (\w+)\(/g)].map((m) => m[1]);
    const want = [
      'navigate',
      'fillEmailAddressInput',
      'fillNotesField',
      'selectCountrySelect',
      'checkTermsCheckbox',
      'uncheckTermsCheckbox',
      'checkExpressRadio',
      'clickPlaceOrderButton',
      'clickDeleteButton',
      'clickEditButton',
      'clickHelpLink',
      'fillCardNumberInput',
      'fillCvcInput',
      'clickThirdPartyButton',
      'fillQtyInput',
      'clickAvatar',
      'fillBio',
      'clickAnyRow',
      'clickMissing',
      'clickShaky',
      'clickSomeCell',
    ];
    expect(helpers(pwCode())).toEqual(want);
    expect(helpers(seCode())).toEqual(want);
    const ts = C.pageObject(RICH, 'playwright', 'typescript');
    expect(
      [...ts.matchAll(/async (\w+)\(/g)].map((m) => m[1]).map((n) => (n === 'goto' ? 'navigate' : n))
    ).toEqual(want);
  });

  it('leaves out elements without a usable locator, and says so', () => {
    for (const code of [pwCode(), seCode()]) {
      expect(code).toContain('// NOTE: 2 element(s) without a usable locator were left out.');
      expect(code).not.toMatch(/nothing|emptyChain/);
    }
  });

  it('flattens a hostile title into one comment line', () => {
    expect(pwCode().split('\n')[0]).toBe(
      '// Page Object generated by Locatra for "Checkout \\u2013 "Shop" line two".'
    );
    expect(pwCode().split('\n')[1]).toBe('// Page: https://shop.example/checkout?step=2');
  });

  it('annotates locators that were not unique', () => {
    const code = pwCode();
    expect(code).toContain(
      '        // NOTE: this locator matched 3 elements when the page object was generated.\n        this.anyRow = page.getByRole(AriaRole.ROW);'
    );
    expect(code).toContain(
      '        // NOTE: this locator matched no element when the page object was generated.\n        this.missing = page.locator(".gone");'
    );
    expect(code).toContain(
      '        // NOTE: this locator was not unique when the page object was generated.\n        this.shaky = page.getByTestId("shaky");'
    );
    expect(code).toContain(
      '        // NOTE: this role locator has no accessible name and may match several elements.\n        this.someCell = page.getByRole(AriaRole.CELL);'
    );
    expect(seCode()).toContain(
      '    // NOTE: this locator matched 3 elements when the page object was generated.\n    public WebElement anyRow() {'
    );
  });

  it('keeps exact, nth, chains and frames in Playwright', () => {
    const code = pwCode();
    expect(code).toContain(
      'this.expressRadio = page.getByRole(AriaRole.RADIO, new Page.GetByRoleOptions().setName("Express").setExact(true));'
    );
    expect(code).toContain(
      'this.editButton = page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("Edit")).nth(1);'
    );
    expect(code).toContain(
      'this.deleteButton = page.getByTestId("row-2").getByRole(AriaRole.BUTTON, new Locator.GetByRoleOptions().setName("Delete"));'
    );
    expect(code).toContain('this.cardNumberInput = page.frameLocator("#pay").getByLabel("Card number");');
    expect(code).toContain(
      'this.thirdPartyButton = page.frameLocator("iframe >> nth=2").getByText("Go", new FrameLocator.GetByTextOptions().setExact(true));'
    );
    expect(code).toContain('import com.microsoft.playwright.FrameLocator;\n');
    expect(code).toContain(
      '    public void selectCountrySelect(String value) {\n        this.countrySelect.selectOption(value);\n    }'
    );
    expect(code).toContain(
      '    public void uncheckTermsCheckbox() {\n        this.termsCheckbox.uncheck();\n    }'
    );
  });

  it('switches Selenium into each element’s frames from the top document', () => {
    const code = seCode();
    expect(code).toContain(
      [
        '    public void navigate() {',
        '        driver.switchTo().defaultContent();',
        '        driver.get("https://shop.example/checkout?step=2");',
        '    }',
      ].join('\n')
    );
    expect(code).toContain(
      [
        '    public WebElement cvcInput() {',
        '        driver.switchTo().defaultContent();',
        '        driver.switchTo().frame(driver.findElement(By.cssSelector("#shell")).getShadowRoot().findElement(By.cssSelector("iframe")));',
        '        return driver.findElement(By.id("cvc"));',
        '    }',
      ].join('\n')
    );
    expect(code).toContain(
      '    public WebElement placeOrderButton() {\n        driver.switchTo().defaultContent();\n        return driver.findElement(By.cssSelector("[data-testid=\\"place-order\\"]"));\n    }'
    );
    expect(code).toContain(
      '        driver.switchTo().frame((WebElement) ((JavascriptExecutor) driver).executeScript(LOCATRA_FRAME_JS, 2));\n        return Locatra.find(driver, "text", "Go", null, true);'
    );
    expect(code).toContain(
      `    private static final String LOCATRA_FRAME_JS = ${JSON.stringify(C._internals.DEEP_IFRAME_JS)};`
    );
  });

  it('sets range values through the value setter, selects by text, toggles only when needed', () => {
    const code = seCode();
    expect(code).toContain(
      '    public void fillQtyInput(String value) {\n        ((JavascriptExecutor) driver).executeScript(LOCATRA_SET_VALUE_JS, qtyInput(), value);\n    }'
    );
    expect(code).toContain(
      '    public void selectCountrySelect(String value) {\n        new Select(countrySelect()).selectByVisibleText(value);\n    }'
    );
    expect(code).toContain(
      '    public void checkTermsCheckbox() {\n        WebElement el = termsCheckbox();\n        if (!(el.isSelected() || "true".equals(el.getDomAttribute("aria-checked")))) el.click();\n    }'
    );
    expect(code).toContain(
      '    public void uncheckTermsCheckbox() {\n        WebElement el = termsCheckbox();\n        if (el.isSelected() || "true".equals(el.getDomAttribute("aria-checked"))) el.click();\n    }'
    );
    for (const imp of ['JavascriptExecutor', 'support.ui.Select'])
      expect(code).toContain(`import org.openqa.selenium.${imp};`);
    expect(
      C.pageObject({ elements: [{ name: 'x', kind: 'button', target: testid('x') }] }, 'selenium', 'java')
    ).not.toMatch(/JavascriptExecutor|Select;/);
  });

  it('never emits a Java keyword or a member every page object has', () => {
    const names = [
      'class',
      'goto',
      'page',
      'driver',
      'navigate',
      'wait',
      'toString',
      'var',
      'int',
      'record',
      'hashCode',
    ];
    const model = { elements: names.map((n) => ({ name: n, kind: 'link', target: testid(n) })) };
    const fields = [
      ...C.pageObject(model, 'playwright', 'java').matchAll(/public final Locator (\w+);/g),
    ].map((m) => m[1]);
    expect(fields).toEqual(names.map((n) => `${n}Element`));
    const methods = [...C.pageObject(model, 'selenium', 'java').matchAll(/public WebElement (\w+)\(\)/g)].map(
      (m) => m[1]
    );
    expect(methods).toEqual(names.map((n) => `${n}Element`));
  });

  it('dedupes collisions and helper names with numeric suffixes', () => {
    const model = {
      elements: [
        { name: 'email', kind: 'input', target: testid('a') },
        { name: 'email', kind: 'input', target: testid('b') },
        { name: 'fillEmail', kind: 'button', target: testid('c') },
        { name: '9 lives', kind: 'button', target: testid('d') },
        { name: '', kind: 'button', target: testid('e') },
      ],
    };
    const code = C.pageObject(model, 'playwright', 'java');
    expect([...code.matchAll(/public final Locator (\w+);/g)].map((m) => m[1])).toEqual([
      'email',
      'email2',
      'fillEmail',
      'el9Lives',
      'element',
    ]);
    expect([...code.matchAll(/public void (\w+)\(/g)].map((m) => m[1])).toEqual([
      'fillEmail2',
      'fillEmail22',
      'clickFillEmail',
      'clickEl9Lives',
      'clickElement',
    ]);
  });

  it("spells Playwright's Page out in full for a page object called Page", () => {
    const code = C.pageObject(
      { className: 'Page', elements: [{ name: 'go', kind: 'button', target: role('button', 'Go') }] },
      'playwright',
      'java'
    );
    expect(code).not.toContain('import com.microsoft.playwright.Page;');
    expect(code).toContain('public class Page {');
    expect(code).toContain('    public final com.microsoft.playwright.Page page;');
    expect(code).toContain('    public Page(com.microsoft.playwright.Page page) {');
    expect(code).toContain('new com.microsoft.playwright.Page.GetByRoleOptions().setName("Go")');
    expect(C.pageObjectFileName({ className: 'Page' }, 'playwright', 'java')).toBe('Page.java');
  });
});

// ── compile everything with javac (when a JDK and the Maven jars are present) ───

function compileEnvironment() {
  const tc = javaToolchain();
  if (tc.missing || !existsSync(M2_REPO)) return null;
  const roots = [
    'com/microsoft/playwright/playwright',
    'org/seleniumhq/selenium',
    'org/junit',
    'org/opentest4j',
    'org/apiguardian',
    'com/google/guava/guava',
  ].map((r) => join(M2_REPO, r));
  const jars = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jar') && !/-(sources|javadoc)\.jar$/.test(e.name)) jars.push(p);
    }
  };
  roots.forEach(walk);
  const need = [
    'playwright-',
    'selenium-api-',
    'selenium-support-',
    'selenium-chrome-driver-',
    'junit-jupiter-api-',
  ];
  if (!need.every((n) => jars.some((j) => j.split(/[\\/]/).pop().startsWith(n)))) return null;
  return {
    javac: join(tc.javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'),
    classpath: jars.join(delimiter),
  };
}

const JAVA = compileEnvironment();
let workDir;
afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe.skipIf(!JAVA)('javac compiles every generated file (-Xlint:all -Werror)', () => {
  it('compiles test files and page objects for both frameworks', () => {
    workDir = mkdtempSync(join(tmpdir(), 'locatra-java-'));
    const src = join(workDir, 'src');
    mkdirSync(src);
    let n = 0;
    const files = [];
    const addTest = (code) => {
      const cls = `RecordedTest${++n}`;
      const file = join(src, `${cls}.java`);
      // Unique class names so every file compiles in one javac run; nothing else changes.
      writeFileSync(file, code.replace(/^class RecordedTest \{$/m, `class ${cls} {`));
      files.push(file);
    };
    const addPo = (model, fw) => {
      const file = join(src, C.pageObjectFileName(model, fw, 'java'));
      writeFileSync(file, C.pageObject(model, fw, 'java'));
      files.push(file);
    };
    const everyAction = [];
    const targets = [...PARITY_TARGETS, ...RICH.elements.map((e) => e.target).filter(Boolean)];
    for (const target of targets) {
      for (const action of [
        'click',
        'dblclick',
        'hover',
        'check',
        'uncheck',
        'fill',
        'selectOption',
        'upload',
      ]) {
        everyAction.push({ action, target, value: action === 'upload' ? '["a.txt","b.txt"]' : 'v' });
      }
      for (const assertType of [
        'toBeVisible',
        'toHaveText',
        'toContainText',
        'toHaveValue',
        'toBeEnabled',
        'toBeChecked',
      ]) {
        everyAction.push({
          action: 'assert',
          target,
          assertType,
          value: assertType === 'toBeChecked' ? 'false' : 'x',
        });
      }
    }
    everyAction.push(
      { action: 'goto', value: 'https://e.example/' },
      { action: 'viewport', value: '800x600' },
      { action: 'press', value: 'Control+Shift+a' },
      { action: 'press', value: 'MediaPlay' },
      { action: 'assert', assertType: 'toHaveURL', value: 'https://e.example/' },
      { action: 'fill', target: testid('pw'), sensitive: true, value: 'x' },
      { action: 'fill', target: testid('r'), inputType: 'range', value: '3' },
      { action: 'upload', target: testid('u'), value: '' },
      { action: 'upload', target: testid('u'), value: '["one"]' },
      { action: 'fill', target: testid('h'), value: 'a\\u000a"\n\u0000£😀' },
      { action: 'teleport\\u000a', target: testid('x') },
      { action: 'zap\\u000D C:\\users é', target: testid('x') },
      { action: 'fill', value: 'x' },
      { action: 'check', target: { kind: 'chain' } },
      { action: 'click' },
      // Contract fields: multi-select, sensitive assertion, shadow DOM, frame indices.
      { action: 'selectOption', target: testid('m'), value: 'A', values: ['A', 'B "b"'] },
      {
        action: 'assert',
        assertType: 'toHaveValue',
        target: testid('pw'),
        sensitive: true,
        secretName: 'PW',
      },
      { action: 'click', target: { ...testid('s'), shadowHosts: ['x-a', 'x-b'], shadowCss: '.go' } },
      { action: 'fill', target: { ...testid('s'), shadowHosts: ['x-a'] }, value: 'v' },
      {
        action: 'click',
        target: { kind: 'frame', selector: null, index: 1, framesIndex: 2, child: testid('f') },
      }
    );
    const refSteps = [
      { action: 'fill', target: testid('a'), value: 'Ada', varRef: 'firstName' },
      { action: 'selectOption', target: testid('b'), value: 'IE', varRef: 'country' },
    ];
    for (const fw of ['playwright', 'selenium']) {
      addTest(C.testScript(everyAction, fw, 'java'));
      addTest(C.testScript(SMALL_FLOW, fw, 'java'));
      addTest(C.wrapScript([], fw, 'java'));
      addTest(
        C.wrapScript(
          refSteps.map((s) => C.actionStatement(s, fw, 'java')),
          fw,
          'java',
          refSteps,
          {
            variables: [
              { name: 'firstName', value: 'Ada' },
              { name: 'country', value: 'IE' },
            ],
          }
        )
      );
      for (const [i, model] of [SMALL, RICH, {}].entries())
        addPo({ ...model, className: `${fw} ${i} ${model.title ? 'x' : 'y'}` }, fw);
      addPo(
        {
          className: `${fw} shadow`,
          elements: [
            {
              name: 'go',
              kind: 'button',
              target: { ...testid('s'), shadowHosts: ['x-a'], shadowCss: '.go' },
            },
            { name: 'lost', kind: 'input', target: { ...testid('l'), shadowHosts: ['x-a'] } },
          ],
        },
        fw
      );
      addPo(
        {
          className: `${fw} keywords`,
          pageUrl: 'https://e.example/',
          elements: ['class', 'goto', 'wait', 'value'].map((name) => ({
            name,
            kind: 'input',
            target: testid(name),
          })),
        },
        fw
      );
    }
    addPo(
      { className: 'Page', elements: [{ name: 'go', kind: 'button', target: role('button', 'Go') }] },
      'playwright'
    );
    // The C9.4 corpus: every target kind × every action, the Locatra helper class and
    // its overloads, the frame / value-setter constants, deep shadow chains, XPath.
    for (const fw of ['playwright', 'selenium']) {
      addTest(C.testScript(CORPUS.STEPS, fw, 'java'));
      addTest(C.testScript(CORPUS.STEPS, fw, 'java', { variables: true }));
      addPo({ ...CORPUS.MODEL, className: `${fw} corpus` }, fw);
    }
    const out = join(workDir, 'out');
    let output = '';
    try {
      output = execFileSync(
        JAVA.javac,
        [
          '-Xlint:all',
          '-Werror',
          '-encoding',
          'US-ASCII',
          '-proc:none',
          '-d',
          out,
          '-cp',
          JAVA.classpath,
          ...files,
        ],
        { stdio: 'pipe', encoding: 'utf8' }
      );
    } catch (err) {
      throw new Error(`javac failed:\n${err.stdout}${err.stderr}`);
    }
    expect(output).toBe('');
    expect(files.length).toBe(n + 13);
  }, 180_000);
});
