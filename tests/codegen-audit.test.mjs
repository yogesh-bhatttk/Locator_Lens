// Regression tests for the codegen audit findings and the cross-file contract fields
// the recorder now produces (scratchpad contracts C1–C4):
//   H1  text / name / label lookups must match text holding no-break spaces, soft
//       hyphens and zero-width spaces, as the engine (and Playwright) normalise them
//   H2  text assertions compare rendered text (innerText), like the recorder read it
//   M1  aria-labelledby with several ids names an element by all of them, in order
//   M6  numeric target fields (level, frame indices, viewport) can never become code
//   C1  multi-select steps (`values`)       C2  sensitive toHaveValue assertions
//   C3  open shadow DOM (`shadowHosts` / `shadowCss`)     C4  frame indices
// Every Selenium-family selector — or Locatra helper call (C9.4) — is decoded from the
// emitted string literals of each language and evaluated against a real DOM (jsdom),
// so the escapes are checked too.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';

import { declaredString, helperCallOf, runHelper } from './codegen-helper-calls.mjs';

let C;
beforeAll(async () => {
  await import('../src/codegen.js');
  await import('../src/codegen-java.js');
  await import('../src/codegen-csharp.js');
  await import('../src/codegen-wdio.js');
  C = globalThis.LLCodegen;
});

const ALL = [
  ['playwright', 'typescript'],
  ['playwright', 'javascript'],
  ['playwright', 'python'],
  ['playwright', 'java'],
  ['playwright', 'csharp'],
  ['selenium', 'typescript'],
  ['selenium', 'javascript'],
  ['selenium', 'python'],
  ['selenium', 'java'],
  ['selenium', 'csharp'],
  ['cypress', 'typescript'],
  ['cypress', 'javascript'],
  ['webdriverio', 'typescript'],
  ['webdriverio', 'javascript'],
];
const SELENIUM_FAMILY = [
  ['selenium', 'javascript'],
  ['selenium', 'python'],
  ['selenium', 'java'],
  ['selenium', 'csharp'],
  ['webdriverio', 'typescript'],
];
// Every target that runs the Locatra helper for a role / label / text locator.
const HELPER_FAMILY = [...SELENIUM_FAMILY, ['cypress', 'javascript'], ['cypress', 'typescript']];

const testid = (value) => ({ kind: 'testid', attr: 'data-testid', value });
const role = (r, name, o = {}) => ({ kind: 'role', role: r, ...(name != null ? { name } : {}), ...o });
const stmt = (step, fw, lang) => C.actionStatement(step, fw, lang);

// ── string literals, decoded the way each compiler reads them ──────────────────
/** Python \xNN is not JSON; everything else the generators emit is. */
const fromPython = (body) =>
  JSON.parse(`"${body.replace(/\\(x([0-9a-f]{2})|.)/g, (m, e, hex) => (hex ? `\\u00${hex}` : m))}"`);
const fromJs = (body) => new Function(`return '${body}';`)();
const LITERAL = {
  javascript: [/By\.(css|xpath)\('((?:[^'\\]|\\.)*)'\)/, (m) => [m[1], fromJs(m[2])]],
  python: [/By\.(CSS_SELECTOR|XPATH), "((?:[^"\\]|\\.)*)"/, (m) => [m[1], fromPython(m[2])]],
  java: [/By\.(cssSelector|xpath)\("((?:[^"\\]|\\.)*)"\)/, (m) => [m[1], JSON.parse(`"${m[2]}"`)]],
  csharp: [
    /By\.(CssSelector|XPath)\((?:@"((?:[^"]|"")*)"|"((?:[^"\\]|\\.)*)")\)/,
    (m) => [m[1], m[2] != null ? m[2].replace(/""/g, '"') : JSON.parse(`"${m[3]}"`)],
  ],
  typescript: [/\$\('((?:[^'\\]|\\.)*)'\)/, (m) => [null, fromJs(m[1]).replace(/^css selector:/, '')]],
};

/** The selector one Selenium-family locator expression carries, decoded. */
function selectorOf(target, fw, lang) {
  const code = C.locatorExpr(target, fw, lang);
  const [re, decode] = LITERAL[lang];
  const m = re.exec(code);
  if (!m) throw new Error(`no selector in ${code}`);
  const [by, sel] = decode(m);
  const xpath = by ? /xpath/i.test(by) : /^[/(.]/.test(sel);
  return { code, xpath, sel };
}

/** data-k of every element a selector matches (XPath through jsdom's document.evaluate). */
function matches(doc, { xpath, sel }) {
  if (!xpath) return [...doc.querySelectorAll(sel)].map((e) => e.getAttribute('data-k'));
  const r = doc.evaluate(sel, doc, null, 7, null);
  return Array.from({ length: r.snapshotLength }, (_, i) => r.snapshotItem(i).getAttribute('data-k'));
}

const dom = (html) =>
  new JSDOM(`<!doctype html><html><head><title>t</title></head><body>${html}</body></html>`).window;

// ════════════════════════════════════════════════════════════════════════════
describe('H1: no-break spaces, soft hyphens and zero-width spaces (the Locatra helper)', () => {
  const HTML = `
    <button data-k="cart">Add&nbsp;to&nbsp;cart</button>
    <button data-k="wish">Add to wishlist</button>
    <p data-k="total">Total:&nbsp;$42.00</p>
    <p data-k="bundes">Bundes&shy;regierung</p>
    <p data-k="zw">zero&#8203;width</p>
    <p data-k="time">10:00&#8239;AM</p>
    <label for="fn">First&nbsp;name</label><input id="fn" data-k="first">
    <button data-k="gear" title="Settings">&nbsp;</button>
    <span id="st">Ship&nbsp;to</span><input data-k="ship" aria-labelledby="st">
    <button data-k="shy">Bundes&shy;tag</button>`;
  let doc;
  beforeAll(() => {
    doc = dom(HTML).document;
  });

  /** data-k of what each language's helper call finds, decoded from its literals. */
  const found = (target, fw, lang) => {
    const call = helperCallOf(C.locatorExpr(target, fw, lang), lang);
    return runHelper(C._internals, doc, call).map((e) => e.getAttribute('data-k'));
  };

  it.each([
    [role('button', 'Add to cart', { exact: true }), 'cart'],
    [role('button', 'to cart'), 'cart'],
    [{ kind: 'text', value: 'Total: $42.00', exact: true }, 'total'],
    [{ kind: 'text', value: 'Bundesregierung', exact: true }, 'bundes'],
    [{ kind: 'text', value: 'zerowidth' }, 'zw'],
    [{ kind: 'text', value: '10:00 AM', exact: true }, 'time'],
    [{ kind: 'label', value: 'First name', exact: true }, 'first'],
    [role('textbox', 'First name', { exact: true }), 'first'],
    // A name of only no-break spaces is empty: the title names the button.
    [role('button', 'Settings', { exact: true }), 'gear'],
    [{ kind: 'label', value: 'Ship to', exact: true }, 'ship'],
    [role('button', 'Bundestag', { exact: true }), 'shy'],
  ])('%j finds the element in every language', (target, want) => {
    for (const [fw, lang] of HELPER_FAMILY) {
      expect(found(target, fw, lang), `${fw}/${lang}`).toEqual([want]);
    }
  });

  it('writes the characters as escapes in every language, never raw', () => {
    const t = { kind: 'text', value: 'a\u00a0b\u00adc\u200bd\u202fe' };
    for (const [fw, lang] of HELPER_FAMILY) {
      const code = C.locatorExpr(t, fw, lang);
      expect(code, `${fw}/${lang}`).not.toMatch(/[\u00a0\u00ad\u200b\u202f]/);
      expect(helperCallOf(code, lang).value, `${fw}/${lang}`).toBe(t.value);
    }
    expect(C.locatorExpr(t, 'selenium', 'javascript')).toBe(
      "locatraFind(driver, 'text', 'a\\xa0b\\xadc\\u200bd\\u202fe')"
    );
    expect(C.locatorExpr(t, 'selenium', 'python')).toBe(
      'locatra_find(driver, "text", "a\\xa0b\\xadc\\u200bd\\u202fe")'
    );
    expect(C.locatorExpr(t, 'selenium', 'java')).toBe(
      'Locatra.find(driver, "text", "a\\u00a0b\\u00adc\\u200bd\\u202fe")'
    );
    expect(C.locatorExpr(t, 'selenium', 'csharp')).toBe(
      'Locatra.Find(driver, "text", "a\\u00A0b\\u00ADc\\u200Bd\\u202Fe")'
    );
    // A recorded value holding them is escaped too (a pasted test never hides text).
    expect(C.q('a\u00a0b\u00adc\u200bd\ufeff', 'python')).toBe('"a\\xa0b\\xadc\\u200bd\\ufeff"');
    expect(C._csharp.q('a\u00a0b\u202fc')).toBe('"a\\u00A0b\\u202Fc"');
  });

  it('drops soft hyphens and zero-width spaces from the needle too', () => {
    const t = { kind: 'text', value: 'Bundes\u00adregierung\u200b', exact: true };
    for (const [fw, lang] of HELPER_FAMILY) expect(found(t, fw, lang), `${fw}/${lang}`).toEqual(['bundes']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('C9: an XPath target is handed over verbatim (decoded from every literal)', () => {
  let doc;
  beforeAll(() => {
    doc = dom(`<button data-k="save">Save</button><a data-k="close" aria-label='Close "it"'>x</a>
      <table data-k="t"><tr><td>1</td><td data-k="two">2</td></tr></table>`).document;
  });

  it.each([
    [{ kind: 'xpath', value: '//button[normalize-space(.)="Save"]' }, ['save']],
    [{ kind: 'xpath', value: `//a[@aria-label=concat('Close "it', '"')]` }, ['close']],
    [{ kind: 'xpath', value: '(//td)[2]' }, ['two']],
  ])('%j', (target, want) => {
    for (const [fw, lang] of SELENIUM_FAMILY) {
      const s = selectorOf(target, fw, lang);
      expect(s.xpath, `${fw}/${lang}`).toBe(true);
      expect(s.sel, `${fw}/${lang}`).toBe(target.value);
      expect(matches(doc, s), `${fw}/${lang}`).toEqual(want);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('H2: text assertions compare the rendered text', () => {
  const t = testid('total');
  const has = { action: 'assert', assertType: 'toHaveText', target: t, value: 'Total 42' };
  const contains = { ...has, assertType: 'toContainText', value: 'Total' };

  it('asks Playwright for innerText in every language', () => {
    expect(stmt(has, 'playwright', 'typescript')).toBe(
      "await expect(page.getByTestId('total')).toHaveText('Total 42', { useInnerText: true });"
    );
    expect(stmt(contains, 'playwright', 'javascript')).toBe(
      "await expect(page.getByTestId('total')).toContainText('Total', { useInnerText: true });"
    );
    expect(stmt(has, 'playwright', 'python')).toBe(
      'expect(page.get_by_test_id("total")).to_have_text("Total 42", use_inner_text=True)'
    );
    expect(stmt(contains, 'playwright', 'python')).toBe(
      'expect(page.get_by_test_id("total")).to_contain_text("Total", use_inner_text=True)'
    );
    expect(stmt(has, 'playwright', 'java')).toBe(
      'assertThat(page.getByTestId("total"))\n' +
        '    .hasText("Total 42", new LocatorAssertions.HasTextOptions().setUseInnerText(true));'
    );
    expect(stmt(contains, 'playwright', 'java')).toBe(
      'assertThat(page.getByTestId("total"))\n' +
        '    .containsText("Total", new LocatorAssertions.ContainsTextOptions().setUseInnerText(true));'
    );
    expect(C.testScript([has], 'playwright', 'java')).toContain(
      'import com.microsoft.playwright.assertions.LocatorAssertions;'
    );
    expect(C.testScript([{ action: 'click', target: t }], 'playwright', 'java')).not.toContain(
      'LocatorAssertions'
    );
    expect(stmt(has, 'playwright', 'csharp')).toBe(
      'await Expect(Page.GetByTestId("total")).ToHaveTextAsync("Total 42", new() { UseInnerText = true });'
    );
    expect(stmt(contains, 'playwright', 'csharp')).toBe(
      'await Expect(Page.GetByTestId("total")).ToContainTextAsync("Total", new() { UseInnerText = true });'
    );
  });

  it('suggested assertions render the same way in the timeline preview', () => {
    expect(stmt({ ...has, suggested: true }, 'playwright', 'typescript')).toContain('{ useInnerText: true }');
  });

  // The rendered text of an element with a no-break space, a soft hyphen, a
  // zero-width space and markup indentation.
  const RENDERED = ' Total\u00a0\n 4\u00ad2\u200b ';

  // The declarations a statement needs (here: the locatraText / locatra_text helper).
  const helpers = (fw, lang) => C._internals.allHelpers(fw, lang).join('\n\n');

  it('Cypress compares innerText inside a retried should() callback', async () => {
    const code = stmt(has, 'cypress', 'typescript');
    expect(code).toBe(
      "cy.get('[data-testid=\"total\"]').should(($el) => { expect(locatraText($el)).to.equal('Total 42'); });"
    );
    expect(helpers('cypress', 'typescript')).toContain('$el[0].innerText');
    expect(code).not.toContain('.text()');
    const run = (innerText) => {
      const cy = { get: () => ({ should: (fn) => fn([{ innerText, textContent: 'hidden junk' }]) }) };
      new Function('cy', 'expect', `${helpers('cypress', 'javascript')}\n${code}`)(cy, expect);
    };
    expect(() => run(RENDERED)).not.toThrow();
    expect(() => run('Total 43')).toThrow();
    const part = stmt(contains, 'cypress', 'javascript');
    expect(() =>
      new Function('cy', 'expect', `${helpers('cypress', 'javascript')}\n${part}`)(
        { get: () => ({ should: (fn) => fn([{ innerText: RENDERED }]) }) },
        expect
      )
    ).not.toThrow();
  });

  it('Selenium JS normalises getText() like the recording', async () => {
    const driver = { findElement: () => ({ getText: async () => RENDERED }) };
    const By = { css: (s) => s };
    expect(stmt(has, 'selenium', 'javascript')).toBe(
      "assert.strictEqual(await locatraText(driver.findElement(By.css('[data-testid=\"total\"]'))), 'Total 42');"
    );
    const run = (step) =>
      new Function(
        'driver',
        'By',
        'assert',
        `${helpers('selenium', 'javascript')}\nreturn (async () => { ${stmt(step, 'selenium', 'javascript')} })();`
      )(driver, By, assert);
    await expect(run(has)).resolves.toBeUndefined();
    await expect(run(contains)).resolves.toBeUndefined();
    await expect(run({ ...has, value: 'Total 43' })).rejects.toThrow();
  });

  it('Selenium Python normalises .text like the recording', () => {
    const py = (step) =>
      [
        'class E:',
        `    text = ${JSON.stringify(RENDERED)}`,
        'class D:',
        '    def find_element(self, *a): return E()',
        'class By: CSS_SELECTOR = "css"',
        'driver = D()',
        helpers('selenium', 'python'),
        stmt(step, 'selenium', 'python'),
      ].join('\n');
    const runs = (step) => {
      try {
        execFileSync('python3', ['-I', '-c', py(step)], { stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    };
    expect(runs(has)).toBe(true);
    expect(runs(contains)).toBe(true);
    expect(runs({ ...has, value: 'Total 43' })).toBe(false);
  });

  it('Java, C# and WebdriverIO strip the same characters before comparing', () => {
    expect(stmt(has, 'selenium', 'java')).toBe(
      'assertEquals("Total 42", Locatra.text(driver.findElement(By.cssSelector("[data-testid=\\"total\\"]"))));'
    );
    expect(helpers('selenium', 'java')).toContain(
      'return el.getText().replaceAll("[\\\\u00ad\\\\u200b]", "").replaceAll("(?U)\\\\s+", " ").trim();'
    );
    expect(stmt(has, 'selenium', 'csharp')).toBe(
      'Assert.That(Locatra.Text(driver.FindElement(By.CssSelector("[data-testid=\\"total\\"]"))), Is.EqualTo("Total 42"));'
    );
    expect(helpers('selenium', 'csharp')).toContain(
      'Regex.Replace(Regex.Replace(el.Text, @"[\\u00AD\\u200B]", ""), @"\\s+", " ").Trim();'
    );
    expect(stmt({ ...has, value: ' Total\u00ad 42 ' }, 'webdriverio', 'typescript')).toBe(
      "await expect($('[data-testid=\"total\"]')).toHaveText('Total 42', LOCATRA_TEXT);"
    );
    expect(helpers('webdriverio', 'typescript')).toContain(
      "const LOCATRA_TEXT = { replace: [[/[\\u00ad\\u200b]/g, ''], [/\\s+/g, ' ']] as [RegExp, string][] };"
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('M1: aria-labelledby with several ids (the Locatra helper)', () => {
  const HTML = `
    <h2 id="t">Delete file</h2><p id="d">This cannot be undone</p>
    <div role="dialog" data-k="dlg" aria-labelledby="t d"><button>OK</button></div>
    <span id="a">Amount</span><span id="ab">USD</span>
    <input data-k="amt" aria-labelledby="a ab">
    <input data-k="pref" aria-labelledby="ab">
    <span id="one">Single</span><input data-k="single" aria-labelledby=" one ">
    <input data-k="missing" aria-labelledby="nope" aria-label="Fallback">
    <span id="w1">w1</span><span id="w2">w2</span><span id="w3">w3</span><span id="w4">w4</span>
    <input data-k="four" aria-labelledby="w4 w3 w2 w1">`;
  let doc;
  beforeAll(() => {
    doc = dom(HTML).document;
  });

  it.each([
    [role('dialog', 'Delete file This cannot be undone', { exact: true }), ['dlg']],
    [role('dialog', 'Delete file'), ['dlg']],
    [role('textbox', 'Amount USD', { exact: true }), ['amt']],
    // getByLabel matches each labelling element on its own (Playwright's
    // getElementLabels), unlike the accessible name, which joins them.
    [{ kind: 'label', value: 'Amount USD', exact: true }, []],
    [{ kind: 'label', value: 'USD', exact: true }, ['amt', 'pref']],
    [{ kind: 'label', value: 'Amount' }, ['amt']],
    // "a" is a prefix of "ab": only the whole id counts.
    [role('textbox', 'USD', { exact: true }), ['pref']],
    [role('textbox', 'Amount', { exact: true }), []],
    [role('textbox', 'Single', { exact: true }), ['single']],
    // An id that points nowhere leaves the name to the next source.
    [role('textbox', 'Fallback', { exact: true }), ['missing']],
    // Attribute order, not document order.
    [role('textbox', 'w4 w3 w2 w1', { exact: true }), ['four']],
    [role('textbox', 'w1 w2 w3 w4', { exact: true }), []],
  ])('%j matches %j', (target, want) => {
    for (const [fw, lang] of HELPER_FAMILY) {
      const call = helperCallOf(C.locatorExpr(target, fw, lang), lang);
      const got = runHelper(C._internals, doc, call).map((e) => e.getAttribute('data-k'));
      expect(got, `${fw}/${lang}`).toEqual(want);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('M6 / C4: numeric target fields never become code', () => {
  const HOSTILE = [
    '1 }); PWNED(); ({ a: 1',
    '1"]);PWNED();//',
    NaN,
    Infinity,
    -1,
    0,
    100,
    2.5,
    '',
    null,
    {},
    '3x',
  ];

  it('emits a heading level only when it is an integer 1-99', () => {
    for (const level of HOSTILE) {
      for (const [fw, lang] of ALL) {
        for (const t of [role('heading', 'x', { level }), role('heading', null, { level })]) {
          const code = C.locatorExpr(t, fw, lang);
          expect(code, `${fw}/${lang} ${String(level)}`).not.toMatch(
            /PWNED|NaN|Infinity|aria-level|level|Level/
          );
        }
      }
    }
    expect(C.locatorExpr(role('heading', 'x', { level: 3 }), 'playwright', 'typescript')).toBe(
      "page.getByRole('heading', { name: 'x', level: 3 })"
    );
    // The engine records any aria-level of 1 or more on role="heading".
    expect(C.locatorExpr(role('heading', 'x', { level: 7 }), 'playwright', 'typescript')).toBe(
      "page.getByRole('heading', { name: 'x', level: 7 })"
    );
    expect(C.locatorExpr(role('heading', 'x', { level: '42' }), 'playwright', 'python')).toBe(
      'page.get_by_role("heading", name="x", level=42)'
    );
    expect(C.locatorExpr(role('heading', 'x', { level: '2' }), 'playwright', 'python')).toBe(
      'page.get_by_role("heading", name="x", level=2)'
    );
    expect(C.locatorExpr(role('heading', 'x', { level: 6 }), 'playwright', 'csharp')).toBe(
      'Page.GetByRole(AriaRole.Heading, new() { Name = "x", Level = 6 })'
    );
    expect(C.locatorExpr(role('heading', null, { level: 4 }), 'playwright', 'java')).toBe(
      'page.getByRole(AriaRole.HEADING, new Page.GetByRoleOptions().setLevel(4))'
    );
    expect(C.locatorExpr(role('heading', null, { level: 2 }), 'cypress', 'javascript')).toBe(
      "locatraGet('role', 'heading', null, { level: 2, nth: 0 })"
    );
    expect(C.locatorExpr(role('heading', 'x', { level: 2 }), 'selenium', 'java')).toBe(
      'Locatra.find(driver, "role", "heading", "x", false, 2, -1)'
    );
  });

  it('coerces frame indices to non-negative integers', () => {
    const BAD = ['0); PWNED(); (0', NaN, Infinity, -1, 2.5, '', null, {}, '3x'];
    for (const index of BAD) {
      for (const framesIndex of [undefined, ...BAD]) {
        const target = { kind: 'frame', selector: null, index, framesIndex, child: testid('x') };
        for (const [fw, lang] of ALL) {
          const code = stmt({ action: 'click', target }, fw, lang);
          expect(code, `${fw}/${lang}`).not.toMatch(/PWNED|NaN|Infinity|-1|2\.5|\[object/);
          expect(code).toMatch(/nth=0|, 0\)|frame_locator|FrameLocator|frameLocator/);
        }
      }
    }
  });

  // ChromeDriver resolves switchTo().frame(n) as (/html/body//iframe | /html/frameset//frame)[n+1],
  // geckodriver as window.frames[n]: a bare number is a different frame per browser, and
  // never one inside shadow DOM. Every target finds the frame element itself instead.
  it('finds a selector-less frame by index, as an element, in every framework (never framesIndex)', () => {
    const I = C._internals;
    const target = { kind: 'frame', selector: null, index: 1, framesIndex: 3, child: testid('x') };
    const click = (fw, lang) => stmt({ action: 'click', target }, fw, lang).split('\n');
    // The script is declared once per file (LOCATRA_FRAME_JS) and run with the index.
    expect(I.FRAME_JS_NAME).toBe('LOCATRA_FRAME_JS');
    expect(click('selenium', 'javascript')[0]).toBe(
      'await driver.switchTo().frame(await driver.executeScript(LOCATRA_FRAME_JS, 1));'
    );
    expect(click('selenium', 'python')[0]).toBe(
      'driver.switch_to.frame(driver.execute_script(LOCATRA_FRAME_JS, 1))'
    );
    expect(click('selenium', 'java')[0]).toBe(
      'driver.switchTo().frame((WebElement) ((JavascriptExecutor) driver).executeScript(LOCATRA_FRAME_JS, 1));'
    );
    expect(click('selenium', 'csharp')[0]).toBe(
      'driver.SwitchTo().Frame((IWebElement)((IJavaScriptExecutor)driver).ExecuteScript(LocatraFrameJs, 1)!);'
    );
    expect(click('playwright', 'typescript')[0]).toContain("frameLocator('iframe >> nth=1')");
    expect(click('cypress', 'javascript').join('\n')).toContain(
      'cy.document().then((doc) => locatraFrame(doc, 1))'
    );
    expect(click('webdriverio', 'javascript')[0]).toBe(
      'await browser.switchFrame($(await browser.execute(LOCATRA_FRAME_JS, 1)));'
    );
    expect(click('webdriverio', 'typescript')[0]).toBe(
      'await browser.switchFrame($(await browser.execute<HTMLIFrameElement, [number]>(LOCATRA_FRAME_JS, 1)));'
    );
    // …and the declaration carries DEEP_IFRAME_JS, once, in every file that switches.
    const declared = (fw, lang, name = 'LOCATRA_FRAME_JS') =>
      declaredString(C.testScript([{ action: 'click', target }], fw, lang), name, lang);
    expect(declared('selenium', 'javascript')).toBe(I.DEEP_IFRAME_JS);
    expect(declared('selenium', 'python')).toBe(I.DEEP_IFRAME_JS);
    expect(C.testScript([{ action: 'click', target }], 'selenium', 'java')).toContain(
      'private static final String LOCATRA_FRAME_JS =\n'
    );
    expect(declared('selenium', 'java')).toBe(I.DEEP_IFRAME_JS);
    expect(C.testScript([{ action: 'click', target }], 'selenium', 'csharp')).toContain(
      'private const string LocatraFrameJs =\n'
    );
    expect(declared('selenium', 'csharp', 'LocatraFrameJs')).toBe(I.DEEP_IFRAME_JS);
    expect(declared('webdriverio', 'typescript')).toBe(I.DEEP_IFRAME_JS);
    for (const [fw, lang] of ALL) {
      const file = C.testScript(
        [
          { action: 'click', target },
          { action: 'click', target },
        ],
        fw,
        lang
      );
      expect(file.split(I.DEEP_IFRAME_JS.slice(0, 40)).length, `${fw}/${lang}`).toBeLessThanOrEqual(2);
    }
    for (const [fw, lang] of ALL)
      expect(stmt({ action: 'click', target }, fw, lang), `${fw}/${lang}`).not.toMatch(/\b3\b/);
    // A frame with a selector is still entered by its element.
    const t4 = { ...target, selector: '#pay' };
    expect(stmt({ action: 'click', target: t4 }, 'selenium', 'java').split('\n')[0]).toBe(
      'driver.switchTo().frame(driver.findElement(By.cssSelector("#pay")));'
    );
    // Page objects use the same switch.
    const po = C.pageObject({ elements: [{ name: 'x', kind: 'button', target }] }, 'selenium', 'python');
    expect(po).toContain('self.driver.switch_to.frame(self.driver.execute_script(LOCATRA_FRAME_JS, 1))');
    expect(declaredString(po, 'LOCATRA_FRAME_JS', 'python')).toBe(I.DEEP_IFRAME_JS);
  });

  it('falls back to the default viewport for anything but a positive finite size', () => {
    for (const bad of ['1); PWNED(); (1', NaN, Infinity, -5, 0, 'abc']) {
      for (const [fw, lang] of ALL) {
        const code = stmt({ action: 'viewport', width: bad, height: bad }, fw, lang);
        expect(code, `${fw}/${lang}`).not.toMatch(/PWNED|NaN|Infinity|-5/);
        expect(code).toContain('1280');
      }
    }
    expect(stmt({ action: 'viewport', width: 390.6, height: '844' }, 'playwright', 'csharp')).toBe(
      'await Page.SetViewportSizeAsync(391, 844);'
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('C1: multi-select steps', () => {
  const step = { action: 'selectOption', target: testid('s'), value: 'Red', values: ['Red', 'Blue "B"'] };

  it('selects every recorded label, in each framework', () => {
    expect(stmt(step, 'playwright', 'typescript')).toBe(
      "await page.getByTestId('s').selectOption(['Red', 'Blue \"B\"']);"
    );
    expect(stmt(step, 'playwright', 'python')).toBe(
      'page.get_by_test_id("s").select_option(["Red", "Blue \\"B\\""])'
    );
    expect(stmt(step, 'playwright', 'java')).toBe(
      'page.getByTestId("s").selectOption(new String[] {"Red", "Blue \\"B\\""});'
    );
    expect(stmt(step, 'playwright', 'csharp')).toBe(
      'await Page.GetByTestId("s").SelectOptionAsync(new[] { "Red", "Blue \\"B\\"" });'
    );
    expect(stmt(step, 'cypress', 'javascript')).toBe(
      "cy.get('[data-testid=\"s\"]').select(['Red', 'Blue \"B\"']);"
    );
    expect(stmt(step, 'selenium', 'javascript')).toBe(
      [
        '{',
        '  const select = new Select(driver.findElement(By.css(\'[data-testid="s"]\')));',
        '  await select.deselectAll();',
        "  await select.selectByVisibleText('Red');",
        '  await select.selectByVisibleText(\'Blue "B"\');',
        '}',
      ].join('\n')
    );
    expect(stmt(step, 'selenium', 'python')).toBe(
      [
        'select = Select(driver.find_element(By.CSS_SELECTOR, "[data-testid=\\"s\\"]"))',
        'select.deselect_all()',
        'select.select_by_visible_text("Red")',
        'select.select_by_visible_text("Blue \\"B\\"")',
      ].join('\n')
    );
    expect(stmt(step, 'selenium', 'java')).toBe(
      [
        '{',
        '    Select select = new Select(driver.findElement(By.cssSelector("[data-testid=\\"s\\"]")));',
        '    select.deselectAll();',
        '    select.selectByVisibleText("Red");',
        '    select.selectByVisibleText("Blue \\"B\\"");',
        '}',
      ].join('\n')
    );
    expect(stmt(step, 'selenium', 'csharp')).toBe(
      [
        '{',
        '    var select = new SelectElement(driver.FindElement(By.CssSelector("[data-testid=\\"s\\"]")));',
        '    select.DeselectAll();',
        '    select.SelectByText("Red");',
        '    select.SelectByText("Blue \\"B\\"");',
        '}',
      ].join('\n')
    );
    expect(stmt(step, 'webdriverio', 'typescript')).toBe(
      [
        '{',
        '  const el = await $(\'[data-testid="s"]\');',
        "  await browser.execute('for (const o of arguments[0].options) o.selected = false;', el);",
        "  await el.selectByVisibleText('Red');",
        '  await el.selectByVisibleText(\'Blue "B"\');',
        '}',
      ].join('\n')
    );
  });

  it('keeps the single-value form for one value, and imports Select', () => {
    const one = { ...step, values: ['Red'] };
    expect(stmt(one, 'playwright', 'typescript')).toBe("await page.getByTestId('s').selectOption('Red');");
    expect(C.testScript([step], 'selenium', 'python')).toContain(
      'from selenium.webdriver.support.ui import Select'
    );
    expect(C.testScript([step], 'selenium', 'javascript')).toContain('Select } = require');
  });

  it('never turns a multi-select into test data', () => {
    expect(C.extractVariables([step])).toEqual([]);
    const code = C.testScript([{ ...step, varRef: 'colour' }], 'playwright', 'typescript', {
      variables: true,
    });
    expect(code).not.toContain('testData');
    expect(code).toContain("selectOption(['Red', 'Blue \"B\"'])");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('C2: sensitive toHaveValue assertions', () => {
  const step = {
    action: 'assert',
    assertType: 'toHaveValue',
    target: testid('pw'),
    sensitive: true,
    secretName: 'MY_PW',
    value: 'hunter2',
  };

  it('reads the environment variable, never the value, in every target', () => {
    const want = {
      'playwright/typescript':
        "await expect.poll(async () => (await page.getByTestId('pw').inputValue()) === (process.env.MY_PW ?? ''), {\n" +
        "  message: 'the value does not match MY_PW',\n}).toBe(true);",
      'playwright/javascript':
        "await expect.poll(async () => (await page.getByTestId('pw').inputValue()) === (process.env.MY_PW ?? ''), {\n" +
        "  message: 'the value does not match MY_PW',\n}).toBe(true);",
      'playwright/python':
        'try:\n' +
        '    expect(page.get_by_test_id("pw")).to_have_value(os.environ.get("MY_PW", ""))\n' +
        'except AssertionError:\n' +
        '    raise AssertionError("the value does not match MY_PW") from None',
      'playwright/java':
        'try {\n' +
        '    assertThat(page.getByTestId("pw")).hasValue(System.getenv().getOrDefault("MY_PW", ""));\n' +
        '} catch (AssertionError e) {\n' +
        '    throw new AssertionError("the value does not match MY_PW");\n' +
        '}',
      'playwright/csharp':
        'try\n{\n' +
        '    await Expect(Page.GetByTestId("pw")).ToHaveValueAsync(Environment.GetEnvironmentVariable("MY_PW") ?? "");\n' +
        '}\ncatch (PlaywrightException)\n{\n' +
        '    throw new PlaywrightException("the value does not match MY_PW");\n' +
        '}',
      'selenium/javascript':
        "assert.ok((await driver.findElement(By.css('[data-testid=\"pw\"]')).getAttribute('value')) === " +
        "(process.env.MY_PW ?? ''), 'the value does not match MY_PW');",
      'selenium/python':
        'assert driver.find_element(By.CSS_SELECTOR, "[data-testid=\\"pw\\"]").get_attribute("value") == ' +
        'os.environ.get("MY_PW", ""), "the value does not match MY_PW"',
      'selenium/java':
        'assertTrue(System.getenv().getOrDefault("MY_PW", "").equals(driver.findElement(By.cssSelector(' +
        '"[data-testid=\\"pw\\"]")).getDomProperty("value")), "the value does not match MY_PW");',
      'selenium/csharp':
        'Assert.That(driver.FindElement(By.CssSelector("[data-testid=\\"pw\\"]")).GetDomProperty("value") == ' +
        '(Environment.GetEnvironmentVariable("MY_PW") ?? ""), Is.True,\n    "the value does not match MY_PW");',
      'cypress/javascript':
        "locatraSecret('MY_PW').then((secret) => {\n" +
        '  cy.get(\'[data-testid="pw"]\').should(($el) => { expect($el.val() === secret, ' +
        "'the value does not match MY_PW').to.equal(true); });\n});",
      'webdriverio/typescript':
        'await browser.waitUntil(async () => (await $(\'[data-testid="pw"]\').getValue()) === ' +
        "(process.env.MY_PW ?? ''), {\n  timeoutMsg: 'the value does not match MY_PW',\n});",
    };
    for (const [key, code] of Object.entries(want)) {
      const [fw, lang] = key.split('/');
      expect(stmt(step, fw, lang), key).toBe(code);
    }
    for (const [fw, lang] of ALL) {
      expect(C.testScript([step], fw, lang), `${fw}/${lang}`).not.toContain('hunter2');
    }
  });

  it('falls back to LOCATRA_PASSWORD for an unusable secret name, like a sensitive fill', () => {
    const bad = { ...step, secretName: 'x; PWNED()' };
    for (const [fw, lang] of ALL) {
      const code = stmt(bad, fw, lang);
      expect(code, `${fw}/${lang}`).toContain('LOCATRA_PASSWORD');
      expect(code).not.toContain('PWNED');
    }
  });

  it('brings in what the env read needs (os, the Cypress secret helper)', () => {
    expect(C.testScript([step], 'playwright', 'python')).toMatch(/^import os\n/);
    expect(C.testScript([step], 'selenium', 'python')).toMatch(/^import os\n/);
    expect(C.testScript([step], 'cypress', 'typescript')).toContain('function locatraSecret(name: string)');
    expect(C.testScript([step], 'selenium', 'csharp')).toContain('using System;');
  });

  it('a Selenium JS failure never prints the secret', async () => {
    const run = (actual) =>
      new Function(
        'driver',
        'By',
        'assert',
        'process',
        `return (async () => { ${stmt(step, 'selenium', 'javascript')} })();`
      )({ findElement: () => ({ getAttribute: async () => actual }) }, { css: (s) => s }, assert, {
        env: { MY_PW: 'hunter2' },
      });
    await expect(run('hunter2')).resolves.toBeUndefined();
    const err = await run('wrong').catch((e) => e);
    expect(String(err.message)).toBe('the value does not match MY_PW');
  });

  // Playwright's toHaveValue prints the expected value when it fails; every Playwright
  // language either compares yes/no (JS/TS expect.poll) or keeps the native retrying
  // assertion and replaces its failure with one that names only the variable.
  it('a Playwright JS failure is retried and never prints the secret', async () => {
    const run = async (values) => {
      const seen = { calls: 0 };
      let i = 0;
      const loc = { inputValue: async () => values[Math.min(i++, values.length - 1)] };
      const expectFn = () => {
        throw new Error('the native toHaveValue must not be used');
      };
      // The real expect.poll retries the generator until toBe passes or the timeout.
      expectFn.poll = (gen, opts) => ({
        toBe: async (want) => {
          seen.opts = opts;
          seen.want = want;
          for (let n = 0; n < 5; n++) {
            seen.calls++;
            const got = await gen();
            seen.got = got;
            if (got === want) return;
          }
          throw new Error(`${opts.message}\n\nExpected: ${want}\nReceived: ${seen.got}`);
        },
      });
      const err = await new Function(
        'expect',
        'page',
        'process',
        `return (async () => { ${stmt(step, 'playwright', 'typescript')} })();`
      )(expectFn, { getByTestId: () => loc }, { env: { MY_PW: 'hunter2' } }).catch((e) => e);
      return { err, seen };
    };
    const ok = await run(['', 'hunt', 'hunter2']);
    expect(ok.err).toBeUndefined();
    expect(ok.seen.calls).toBe(3);
    expect(ok.seen.want).toBe(true);
    const bad = await run(['wrong']);
    expect(bad.seen.calls).toBe(5);
    expect(bad.seen.got).toBe(false);
    expect(bad.seen.opts).toEqual({ message: 'the value does not match MY_PW' });
    expect(String(bad.err.message)).toContain('MY_PW');
    expect(String(bad.err.message)).not.toContain('hunter2');
  });

  it('a Playwright Python failure keeps the native assertion and never prints the secret', () => {
    let python = true;
    try {
      execFileSync('python3', ['--version'], { stdio: 'pipe' });
    } catch {
      python = false;
    }
    if (!python) return;
    // A stand-in for playwright.sync_api.expect: its failure names the expected value,
    // as the real one does.
    const py = (actual) =>
      [
        'import os',
        'class A:',
        '    def __init__(self, v): self.v = v',
        '    def to_have_value(self, want):',
        '        if self.v != want: raise AssertionError(f"Locator expected to have Value \'{want}\'")',
        'def expect(loc): return A(loc)',
        'class P:',
        `    def get_by_test_id(self, _): return ${JSON.stringify(actual)}`,
        'page = P()',
        stmt(step, 'playwright', 'python'),
      ].join('\n');
    const env = { ...process.env, MY_PW: 'hunter2' };
    expect(() => execFileSync('python3', ['-I', '-c', py('hunter2')], { stdio: 'pipe', env })).not.toThrow();
    let out = '';
    try {
      execFileSync('python3', ['-I', '-c', py('wrong')], { stdio: 'pipe', env });
    } catch (err) {
      out = String(err.stderr);
    }
    expect(out).toContain('AssertionError: the value does not match MY_PW');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('Locator expected');
  });

  it('Java and C# keep the native retrying assertion inside, and rethrow without the cause', () => {
    const java = stmt(step, 'playwright', 'java');
    expect(java).toContain(
      'assertThat(page.getByTestId("pw")).hasValue(System.getenv().getOrDefault("MY_PW", ""));'
    );
    expect(java).toMatch(/throw new AssertionError\("the value does not match MY_PW"\);/);
    expect(java).not.toMatch(/AssertionError\([^)]*, e\)|initCause/);
    const cs = stmt(step, 'playwright', 'csharp');
    expect(cs).toContain('await Expect(Page.GetByTestId("pw")).ToHaveValueAsync(');
    expect(cs).toContain('catch (PlaywrightException)\n');
    expect(cs).toContain('throw new PlaywrightException("the value does not match MY_PW");');
    // The whole scripts still bring in what the statements use.
    expect(C.testScript([step], 'playwright', 'csharp')).toContain('using Microsoft.Playwright;');
    for (const lang of ['typescript', 'javascript', 'python', 'java', 'csharp']) {
      const code = C.testScript([step], 'playwright', lang);
      expect(code, lang).not.toContain('hunter2');
      expect(code, lang).toContain('the value does not match MY_PW');
    }
  });

  it('leaves non-sensitive toHaveValue and a sensitive non-value assertion alone', () => {
    const plain = { ...step, sensitive: false };
    expect(stmt(plain, 'playwright', 'typescript')).toBe(
      "await expect(page.getByTestId('pw')).toHaveValue('hunter2');"
    );
    const vis = { ...step, assertType: 'toBeVisible' };
    expect(stmt(vis, 'selenium', 'python')).toBe(
      'assert driver.find_element(By.CSS_SELECTOR, "[data-testid=\\"pw\\"]").is_displayed()'
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('C3: open shadow DOM', () => {
  // A CSS target: role / label / text ones go to the helper instead (below).
  const plain = { kind: 'css', value: 'x-panel button' };
  const inShadow = (o = {}) => ({
    ...plain,
    shadowHosts: ['x-app', 'x-panel[data-k="p"]'],
    shadowCss: 'button.go',
    ...o,
  });
  const click = (target, fw, lang) => stmt({ action: 'click', target }, fw, lang);

  it('leaves Playwright alone: its locators pierce shadow roots', () => {
    for (const lang of ['typescript', 'python', 'java', 'csharp']) {
      expect(C.locatorExpr(inShadow(), 'playwright', lang)).toBe(C.locatorExpr(plain, 'playwright', lang));
    }
  });

  it('finds a role / label / text target with the helper, which pierces shadow roots, never a walk', () => {
    const LONG_HOST =
      'html > body > header > nav > div:nth-of-type(3) > div:nth-of-type(2) > mdn-search-button';
    for (const t of [
      role('button', 'Search the site'),
      { kind: 'label', value: 'Email' },
      { kind: 'text', value: 'Copy', exact: true },
    ]) {
      for (const sh of [
        { shadowHosts: [LONG_HOST], shadowCss: 'button[title="Search the site"]' },
        { shadowHosts: [LONG_HOST, 'mdn-copy-button'], shadowCss: 'mdn-button' },
        { shadowHosts: [LONG_HOST] }, // no shadowCss: the helper still finds it, so no NOTE
      ]) {
        for (const [fw, lang] of ALL) {
          if (fw === 'playwright') continue;
          const label = `${fw}/${lang} ${JSON.stringify(t)} ${JSON.stringify(sh)}`;
          expect(C.locatorExpr({ ...t, ...sh }, fw, lang), label).toBe(C.locatorExpr(t, fw, lang));
          const code = click({ ...t, ...sh }, fw, lang);
          expect(code, label).toBe(click(t, fw, lang));
          expect(code, label).not.toMatch(/shadow|NOTE|nth-of-type/i);
        }
      }
    }
    // Inside a chain the helper searches the parent, shadow roots included, as
    // Playwright's parent.getByRole() does.
    const chained = {
      kind: 'chain',
      parent: testid('popup'),
      child: { ...inShadow(), ...role('button', 'Go') },
    };
    for (const [fw, lang] of ALL) {
      expect(C.locatorExpr(chained, fw, lang), `${fw}/${lang}`).toBe(
        C.locatorExpr({ kind: 'chain', parent: testid('popup'), child: role('button', 'Go') }, fw, lang)
      );
    }
  });

  it('prefers a short native alternative in shadow DOM, the helper over a long walk', () => {
    const primary = {
      ...role('textbox', 'Filter sidebar'),
      shadowHosts: ['mdn-sidebar-filter'],
      shadowCss: '#input',
    };
    const short = { kind: 'id', value: 'input', shadowHosts: ['mdn-sidebar-filter'], shadowCss: '#input' };
    const long = {
      kind: 'id',
      value: 'reset',
      shadowHosts: ['interactive-example[name="HTML Demo: &lt;select&gt;"]'],
      shadowCss: '#reset',
    };
    const twoHops = { ...short, shadowHosts: ['x-a', 'x-b'] };
    const noCss = { kind: 'id', value: 'input', shadowHosts: ['mdn-sidebar-filter'] };
    for (const fw of ['selenium', 'cypress', 'webdriverio']) {
      expect(C.preferredTarget(primary, [short], fw), fw).toBe(short);
      for (const alt of [long, twoHops, noCss]) {
        expect(C.preferredTarget(primary, [alt], fw), `${fw} ${JSON.stringify(alt)}`).toBe(primary);
      }
      expect(C.preferredTarget(primary, [long, short], fw), fw).toBe(short);
    }
    expect(C.preferredTarget(primary, [short], 'playwright')).toBe(primary);
  });

  it('walks host by host and finishes with shadowCss everywhere else', () => {
    // Two hops or more go one per line (Python inside parentheses).
    expect(C.locatorExpr(inShadow(), 'selenium', 'javascript')).toBe(
      "(await (await (await (await driver.findElement(By.css('x-app'))\n" +
        '    .getShadowRoot()).findElement(By.css(\'x-panel[data-k="p"]\')))\n' +
        "    .getShadowRoot()).findElement(By.css('button.go')))"
    );
    expect(C.locatorExpr(inShadow(), 'selenium', 'python')).toBe(
      '(driver.find_element(By.CSS_SELECTOR, "x-app")\n' +
        '    .shadow_root.find_element(By.CSS_SELECTOR, "x-panel[data-k=\\"p\\"]")\n' +
        '    .shadow_root.find_element(By.CSS_SELECTOR, "button.go"))'
    );
    expect(C.locatorExpr(inShadow(), 'selenium', 'java')).toBe(
      'driver.findElement(By.cssSelector("x-app"))\n' +
        '    .getShadowRoot().findElement(By.cssSelector("x-panel[data-k=\\"p\\"]"))\n' +
        '    .getShadowRoot().findElement(By.cssSelector("button.go"))'
    );
    expect(C.locatorExpr(inShadow(), 'selenium', 'csharp')).toBe(
      'driver.FindElement(By.CssSelector("x-app"))\n' +
        '    .GetShadowRoot().FindElement(By.CssSelector("x-panel[data-k=\\"p\\"]"))\n' +
        '    .GetShadowRoot().FindElement(By.CssSelector("button.go"))'
    );
    expect(C.locatorExpr(inShadow(), 'cypress', 'javascript')).toBe(
      "cy.get('x-app')\n    .shadow().find('x-panel[data-k=\"p\"]')\n    .shadow().find('button.go')"
    );
    expect(C.locatorExpr(inShadow(), 'webdriverio', 'typescript')).toBe(
      "$('x-app')\n    .shadow$('x-panel[data-k=\"p\"]')\n    .shadow$('button.go')"
    );
    // A selector WebdriverIO would read as another strategy keeps its css prefix.
    expect(C.locatorExpr(inShadow({ shadowCss: 'id=x' }), 'webdriverio', 'typescript')).toBe(
      "$('x-app')\n    .shadow$('x-panel[data-k=\"p\"]')\n    .shadow$('css selector:id=x')"
    );
    // One short hop stays on one line; a long one (a recorded structural path) breaks.
    const oneHop = { ...plain, shadowHosts: ['x-app'], shadowCss: 'button.go' };
    expect(C.locatorExpr(oneHop, 'cypress', 'javascript')).toBe("cy.get('x-app').shadow().find('button.go')");
    expect(C.locatorExpr(oneHop, 'webdriverio', 'javascript')).toBe("$('x-app').shadow$('button.go')");
    expect(C.locatorExpr(oneHop, 'selenium', 'java')).toBe(
      'driver.findElement(By.cssSelector("x-app")).getShadowRoot().findElement(By.cssSelector("button.go"))'
    );
    const LONG_HOST =
      'html > body > main > article > div:nth-of-type(2) > div:nth-of-type(1) > div:nth-of-type(1) > sl-checkbox';
    const longHop = { ...plain, shadowHosts: [LONG_HOST], shadowCss: 'input' };
    for (const [fw, lang] of ALL) {
      if (fw === 'playwright') continue;
      const lines = C.locatorExpr(longHop, fw, lang).split('\n');
      expect(lines, `${fw}/${lang}`).toHaveLength(2);
      expect(lines[0], `${fw}/${lang}`).toContain(LONG_HOST);
      expect(lines[1], `${fw}/${lang}`).toMatch(
        /^\s+\.(getShadowRoot|GetShadowRoot|shadow_root|shadow)\b|^\s+\.shadow\$/
      );
    }
    // No note: the element is reachable.
    for (const [fw, lang] of ALL) expect(click(inShadow(), fw, lang), `${fw}/${lang}`).not.toContain('NOTE');
  });

  it('enters frames first, and starts a chained child from the document', () => {
    const framed = { kind: 'frame', selector: '#f', index: 0, child: inShadow() };
    expect(click(framed, 'selenium', 'python')).toBe(
      [
        'driver.switch_to.frame(driver.find_element(By.CSS_SELECTOR, "#f"))',
        `${C.locatorExpr(inShadow(), 'selenium', 'python')}.click()`,
        'driver.switch_to.default_content()',
      ].join('\n')
    );
    // One frame per line once the chain grows long.
    expect(C.locatorExpr(framed, 'cypress', 'javascript')).toBe(
      "cy.get('#f').its('0.contentDocument.body').should('not.be.empty').then(cy.wrap)\n" +
        "  .find('x-app')\n    .shadow().find('x-panel[data-k=\"p\"]')\n    .shadow().find('button.go')"
    );
    const chained = { kind: 'chain', parent: testid('row'), child: inShadow() };
    for (const [fw, lang] of ALL) {
      if (fw === 'playwright') continue;
      expect(C.locatorExpr(chained, fw, lang), `${fw}/${lang}`).toBe(C.locatorExpr(inShadow(), fw, lang));
    }
    // A shadow chain whose parent is the shadow target continues from the element.
    const outer = { kind: 'chain', parent: inShadow(), child: testid('in') };
    expect(C.locatorExpr(outer, 'selenium', 'python')).toBe(
      `${C.locatorExpr(inShadow(), 'selenium', 'python')}.find_element(By.CSS_SELECTOR, "[data-testid=\\"in\\"]")`
    );
  });

  it('keeps the target own locator with a NOTE when shadowCss is missing', () => {
    const noCss = inShadow({ shadowCss: undefined });
    const note = 'NOTE: inside shadow DOM, but no CSS selector was recorded for it there';
    for (const [fw, lang] of ALL) {
      const code = click(noCss, fw, lang);
      if (fw === 'playwright') expect(code, `${fw}/${lang}`).not.toContain('NOTE');
      else {
        expect(code, `${fw}/${lang}`).toContain(note);
        expect(code).toContain(click(plain, fw, lang).split('\n').pop());
      }
    }
    // Unusable shadowHosts are ignored entirely.
    for (const shadowHosts of [[], ['x-app', ''], ['x-app', 3], 'x-app', null]) {
      for (const [fw, lang] of ALL) {
        expect(click(inShadow({ shadowHosts }), fw, lang)).toBe(click(plain, fw, lang));
      }
    }
  });

  it('page objects reach shadow elements too (Selenium JS methods become async)', () => {
    const model = {
      elements: [
        { name: 'go', kind: 'button', target: inShadow() },
        { name: 'plain', kind: 'button', target: testid('p') },
        { name: 'lost', kind: 'button', target: inShadow({ shadowCss: '' }) },
        { name: 'named', kind: 'button', target: { ...inShadow(), ...role('button', 'Go') } },
      ],
    };
    const ts = C.pageObject(model, 'selenium', 'typescript');
    // 'lost' (no shadowCss) keeps its own locator; 'named' (a role) goes to the helper,
    // whose WebElementPromise is a value.
    expect(ts).toContain(
      "import { By, WebElementPromise, type WebDriver, type WebElement } from 'selenium-webdriver';"
    );
    expect(ts).toContain(
      "lost(): WebElementPromise {\n    return this.driver.findElement(By.css('x-panel button'));"
    );
    expect(ts).toContain(
      "named(): WebElementPromise {\n    return locatraFind(this.driver, 'role', 'button', 'Go');"
    );
    expect(ts).toContain(
      'async go(): Promise<WebElement> {\n    return (await (await (await (await this.driver.findElement('
    );
    expect(ts).toContain('plain(): WebElementPromise {');
    expect(ts).toContain('  // NOTE: inside shadow DOM');
    const allShadow = C.pageObject({ elements: [model.elements[0]] }, 'selenium', 'javascript');
    expect(allShadow).toContain('async go() {');
    expect(C.pageObject({ elements: [model.elements[0]] }, 'selenium', 'typescript')).toContain(
      'import { By, type WebDriver, type WebElement }'
    );
    expect(C.pageObject(model, 'selenium', 'python')).toContain(
      'return (self.driver.find_element(By.CSS_SELECTOR, "x-app")\n            .shadow_root'
    );
    expect(C.pageObject(model, 'selenium', 'java')).toContain(
      'return driver.findElement(By.cssSelector("x-app"))\n            .getShadowRoot()'
    );
    expect(C.pageObject(model, 'selenium', 'java')).toContain('// NOTE: inside shadow DOM');
    expect(C.pageObject(model, 'selenium', 'csharp')).toContain(
      'public IWebElement Go => Driver.FindElement(By.CssSelector("x-app"))\n        .GetShadowRoot()'
    );
    expect(C.pageObject(model, 'selenium', 'csharp')).toContain('// NOTE: inside shadow DOM');
    expect(C.pageObject(model, 'cypress', 'typescript')).toContain(
      "return cy.get('x-app')\n      .shadow().find('x-panel[data-k=\"p\"]')\n      .shadow().find('button.go');"
    );
    expect(C.pageObject(model, 'cypress', 'typescript')).toContain('// NOTE: inside shadow DOM');
    expect(C.pageObject(model, 'webdriverio', 'typescript')).toContain(
      "return $('x-app')\n      .shadow$('x-panel[data-k=\"p\"]')\n      .shadow$('button.go');"
    );
    expect(C.pageObject(model, 'webdriverio', 'typescript')).toContain('// NOTE: inside shadow DOM');
    // Playwright page objects need neither the walk nor the note.
    for (const lang of ['typescript', 'python', 'java', 'csharp']) {
      expect(C.pageObject(model, 'playwright', lang), lang).not.toMatch(/shadow|NOTE: this element/i);
    }
  });

  describe('runs against a real shadow tree', () => {
    let doc;
    beforeAll(() => {
      doc = dom('<x-app></x-app>').document;
      const app = doc.querySelector('x-app').attachShadow({ mode: 'open' });
      app.innerHTML = '<x-panel data-k="p"></x-panel>';
      const panel = app.querySelector('x-panel').attachShadow({ mode: 'open' });
      panel.innerHTML = '<button class="go" data-k="go">Go</button>';
    });

    it('Selenium JS: every hop awaited, as selenium-webdriver needs', async () => {
      const clicked = [];
      // selenium-webdriver's shapes: findElement() on the driver gives a thenable
      // WebElementPromise; getShadowRoot() and a ShadowRoot's findElement() give
      // plain promises.
      const element = (node) => ({
        getShadowRoot: async () => ({
          findElement: async (sel) => element(node.shadowRoot.querySelector(sel)),
        }),
        click: async () => clicked.push(node.getAttribute('data-k')),
      });
      const driver = { findElement: (sel) => element(doc.querySelector(sel)) };
      const code = click(inShadow(), 'selenium', 'typescript');
      await new Function('driver', 'By', `return (async () => { ${code} })();`)(driver, { css: (s) => s });
      expect(clicked).toEqual(['go']);
    });

    it('Cypress: .shadow().find() from host to element', () => {
      const wrap = (node) => ({
        node,
        shadow: () => ({ find: (sel) => wrap(node.shadowRoot.querySelector(sel)) }),
      });
      const cy = { get: (sel) => wrap(doc.querySelector(sel)) };
      const res = new Function('cy', `return ${C.locatorExpr(inShadow(), 'cypress', 'javascript')};`)(cy);
      expect(res.node.getAttribute('data-k')).toBe('go');
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// A recorded step whose locator the recorder found for several elements (the
// real-site run: Shoelace's `svg`, 103 matches) says so on the line before it, in
// every framework and language — never silently, and never by adding .first().
describe('non-unique recorded steps carry a NOTE', () => {
  const svg = (o = {}) => ({ kind: 'css', value: 'svg', ...o });
  const commentOf = (lang) => (lang === 'python' ? '# ' : '// ');
  const MANY = 'NOTE: this locator matched 103 elements when recorded; make it unique before relying on it.';
  const SOME = 'NOTE: this locator was not unique when recorded; make it unique before relying on it.';

  it.each(ALL)('%s / %s: the NOTE heads the statement, which is otherwise unchanged', (fw, lang) => {
    const step = { action: 'click', target: svg({ matchCount: 103, unique: false }) };
    const plain = stmt({ action: 'click', target: svg() }, fw, lang);
    expect(stmt(step, fw, lang)).toBe(`${commentOf(lang)}${MANY}\n${plain}`);
    expect(stmt({ action: 'click', target: svg({ unique: false }) }, fw, lang)).toBe(
      `${commentOf(lang)}${SOME}\n${plain}`
    );
    // Playwright keeps the strict locator: nothing picks one of the matches silently.
    expect(stmt(step, fw, lang)).not.toMatch(/\.first\(|\.First\b|\.nth\(|nth=/i);
    // Unique, a count of one or none at all: no NOTE.
    for (const target of [
      svg({ matchCount: 1, unique: true }),
      svg({ unique: true }),
      svg({ matchCount: 1 }),
      svg(),
    ]) {
      expect(stmt({ action: 'click', target }, fw, lang), JSON.stringify(target)).toBe(plain);
    }
    // A count the recorder could not take (0, or a corrupt one) says nothing either.
    for (const matchCount of [0, -3, 'many', 2.5]) {
      expect(stmt({ action: 'click', target: svg({ matchCount }) }, fw, lang)).not.toContain(
        'NOTE: this locator'
      );
    }
    // Page-level steps never carry it.
    expect(
      stmt({ action: 'goto', value: 'https://e.example/', target: svg({ matchCount: 3 }) }, fw, lang)
    ).not.toContain('NOTE');
  });

  it('reads the count through frame wrappers, and puts the NOTE before the frame switch', () => {
    const inner = { kind: 'frame', selector: '#f', index: 0, child: svg({ matchCount: 4, unique: false }) };
    const outer = { kind: 'frame', selector: '#f', index: 0, child: svg(), matchCount: 4, unique: false };
    for (const [fw, lang] of ALL) {
      for (const target of [inner, outer]) {
        const lines = stmt({ action: 'click', target }, fw, lang).split('\n');
        expect(lines[0], `${fw}/${lang}`).toBe(
          `${commentOf(lang)}NOTE: this locator matched 4 elements when recorded; make it unique before relying on it.`
        );
      }
    }
  });

  it('says nothing where a walk through shadow roots is rendered: it is unique by construction', () => {
    const SL =
      'html > body > main > article > div:nth-of-type(2) > div:nth-of-type(3) > div:nth-of-type(1) > sl-checkbox';
    const target = svg({
      shadowHosts: [SL, 'sl-icon[name="check"]'],
      shadowCss: 'svg',
      matchCount: 103,
      unique: false,
    });
    for (const [fw, lang] of ALL) {
      const code = stmt({ action: 'click', target }, fw, lang);
      if (fw === 'playwright') expect(code.split('\n')[0], `${fw}/${lang}`).toBe(`${commentOf(lang)}${MANY}`);
      else expect(code, `${fw}/${lang}`).not.toContain('NOTE');
    }
    // A role / label / text target in shadow DOM goes to the helper, which matches as
    // Playwright does: the count still applies.
    const named = role('button', 'Copy', {
      shadowHosts: [SL],
      shadowCss: 'button',
      matchCount: 6,
      unique: false,
    });
    for (const [fw, lang] of ALL) {
      expect(stmt({ action: 'click', target: named }, fw, lang), `${fw}/${lang}`).toContain(
        'matched 6 elements'
      );
    }
  });

  it('says nothing when an alternative (verified unique) is rendered instead', () => {
    const step = {
      action: 'click',
      target: role('button', 'Save', { matchCount: 3, unique: false }),
      altTargets: [{ kind: 'id', value: 'save' }],
    };
    for (const [fw, lang] of ALL) {
      const code = stmt(step, fw, lang);
      if (fw === 'playwright') expect(code, `${fw}/${lang}`).toContain('matched 3 elements');
      else expect(code, `${fw}/${lang}`).not.toContain('NOTE');
    }
  });

  it('replaces the "no accessible name" NOTE when the count is known', () => {
    const counted = { action: 'click', target: role('checkbox', null, { matchCount: 7, unique: false }) };
    const unknown = { action: 'click', target: role('checkbox') };
    for (const [fw, lang] of ALL) {
      const code = stmt(counted, fw, lang);
      expect(code.match(/NOTE:/g), `${fw}/${lang}`).toHaveLength(1);
      expect(code, `${fw}/${lang}`).toContain('matched 7 elements when recorded');
      if (fw !== 'playwright')
        expect(stmt(unknown, fw, lang), `${fw}/${lang}`).toContain('has no accessible name');
    }
  });

  it('appears in whole tests, literal and test-data, and they still parse', () => {
    const steps = [
      { action: 'goto', value: 'https://shoelace.example/' },
      { action: 'click', target: svg({ matchCount: 103, unique: false }) },
      { action: 'fill', target: { kind: 'css', value: 'input', matchCount: 2, unique: false }, value: 'Ada' },
    ];
    const dir = mkdtempSync(join(tmpdir(), 'locatra-nonunique-'));
    try {
      for (const [fw, lang] of ALL) {
        for (const opts of [undefined, { variables: true }]) {
          const code = C.testScript(steps, fw, lang, opts);
          expect(code, `${fw}/${lang}`).toContain('matched 103 elements when recorded');
          expect(code, `${fw}/${lang}`).toContain('matched 2 elements when recorded');
          if (lang === 'java' || lang === 'csharp') continue; // compiled in their own suites
          const ext = lang === 'python' ? 'py' : fw === 'selenium' ? 'cjs' : 'mjs';
          const file = join(dir, `${fw}-${lang}.${ext}`);
          writeFileSync(file, lang === 'typescript' ? stripTypeScriptTypes(code) : code);
          const args =
            lang === 'python'
              ? ['python3', ['-I', '-c', 'import ast, sys; ast.parse(open(sys.argv[1]).read())', file]]
              : [process.execPath, ['--check', file]];
          expect(() => execFileSync(args[0], args[1], { stdio: 'pipe' }), `${fw}/${lang}`).not.toThrow();
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('the new shapes parse in every language', () => {
  const steps = [
    { action: 'goto', value: 'https://e.example/' },
    { action: 'selectOption', target: testid('s'), value: 'A', values: ['A', "B 'b'"] },
    { action: 'assert', assertType: 'toHaveValue', target: testid('pw'), sensitive: true, secretName: 'PW' },
    { action: 'assert', assertType: 'toHaveText', target: testid('t'), value: 'a\u00a0b' },
    { action: 'assert', assertType: 'toContainText', target: testid('t'), value: 'a' },
    { action: 'click', target: { ...testid('x'), shadowHosts: ['x-a', 'x-b'], shadowCss: '.go' } },
    { action: 'fill', target: { ...testid('y'), shadowHosts: ['x-a'], shadowCss: 'input' }, value: 'v' },
    { action: 'check', target: { ...testid('z'), shadowHosts: ['x-a'] } },
    {
      action: 'assert',
      assertType: 'toHaveText',
      target: {
        kind: 'frame',
        selector: null,
        index: 0,
        framesIndex: 1,
        child: { ...testid('w'), shadowHosts: ['x-a'], shadowCss: 'p' },
      },
      value: 'w',
    },
    { action: 'click', target: role('heading', 'T', { level: '2' }) },
  ];
  const po = {
    pageUrl: 'https://e.example/',
    elements: [
      { name: 'go', kind: 'button', target: { ...testid('x'), shadowHosts: ['x-a'], shadowCss: '.go' } },
      { name: 'field', kind: 'input', target: testid('f') },
    ],
  };

  it('node --check (JS/TS) and ast.parse (Python)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'locatra-audit-'));
    try {
      for (const [fw, lang] of ALL) {
        if (lang === 'java' || lang === 'csharp') continue; // compiled in their own suites
        for (const [kind, code] of [
          ['spec', C.testScript(steps, fw, lang)],
          ['po', C.pageObject(po, fw, lang)],
        ]) {
          if (lang === 'python') {
            const file = join(dir, `${fw}-${kind}.py`);
            writeFileSync(file, code);
            expect(() =>
              execFileSync(
                'python3',
                ['-I', '-c', 'import ast, sys; ast.parse(open(sys.argv[1]).read())', file],
                {
                  stdio: 'pipe',
                }
              )
            ).not.toThrow();
            continue;
          }
          const module = fw === 'selenium' && kind === 'spec' ? 'cjs' : 'mjs';
          const file = join(dir, `${fw}-${lang}-${kind}.${module}`);
          writeFileSync(file, lang === 'typescript' ? stripTypeScriptTypes(code) : code);
          expect(
            () => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }),
            `${fw}/${lang}/${kind}`
          ).not.toThrow();
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
