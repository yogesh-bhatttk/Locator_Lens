// codegen.js is a UMD-style IIFE that publishes onto the global object. Importing
// it for side effects is enough to get the real shipping module — no shim, no copy.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';

let C;
beforeAll(async () => {
  await import('../src/codegen.js');
  C = globalThis.LLCodegen;
});

/** The value of a single-quoted JS string literal's body, escapes (\\xa0, \\u200b, …) decoded. */
const jsString = (body) => new Function(`return '${body}';`)();

const FRAMEWORKS = ['playwright', 'selenium', 'cypress'];
const LANGUAGES = ['typescript', 'javascript', 'python'];

/** Every framework/language pair the UI will actually let a user select. */
function validCombos() {
  const out = [];
  for (const fw of FRAMEWORKS)
    for (const lang of LANGUAGES) if (C.isValidCombo(fw, lang)) out.push([fw, lang]);
  return out;
}

describe('framework/language matrix', () => {
  it('exposes three frameworks and three languages', () => {
    expect(C.FRAMEWORKS.map((f) => f.id)).toEqual(FRAMEWORKS);
    expect(C.LANGUAGES.map((l) => l.id)).toEqual(LANGUAGES);
  });

  it('rejects only Cypress + Python, which has no bindings', () => {
    expect(C.isValidCombo('cypress', 'python')).toBe(false);
    expect(C.languagesFor('cypress').map((l) => l.id)).toEqual(['typescript', 'javascript']);
    expect(C.languagesFor('playwright')).toHaveLength(3);
    expect(C.languagesFor('selenium')).toHaveLength(3);
  });
});

describe('locator expressions', () => {
  const target = { kind: 'role', role: 'button', name: 'Submit' };

  it('produces a non-empty expression for every valid combination', () => {
    for (const [fw, lang] of validCombos()) {
      expect(C.locatorExpr(target, fw, lang), `${fw}/${lang}`).toBeTruthy();
    }
  });

  it('returns an empty string when there is no target', () => {
    expect(C.locatorExpr(null, 'playwright', 'typescript')).toBe('');
  });

  it('uses snake_case for Playwright Python and camelCase elsewhere', () => {
    expect(C.locatorExpr(target, 'playwright', 'python')).toBe('page.get_by_role("button", name="Submit")');
    expect(C.locatorExpr(target, 'playwright', 'typescript')).toBe(
      "page.getByRole('button', { name: 'Submit' })"
    );
  });

  it('passes a heading level through to getByRole', () => {
    const heading = { kind: 'role', role: 'heading', name: 'Title', level: 2 };
    expect(C.locatorExpr(heading, 'playwright', 'typescript')).toContain('level: 2');
    expect(C.locatorExpr(heading, 'playwright', 'python')).toContain('level=2');
  });

  it('maps getByTestId only for data-testid, and a CSS attribute otherwise', () => {
    expect(
      C.locatorExpr({ kind: 'testid', attr: 'data-testid', value: 'x' }, 'playwright', 'typescript')
    ).toBe("page.getByTestId('x')");
    expect(C.locatorExpr({ kind: 'testid', attr: 'data-qa', value: 'x' }, 'playwright', 'typescript')).toBe(
      'page.locator(\'[data-qa="x"]\')'
    );
  });

  // A custom test attribute such as data:qa is legal HTML but ':' is CSS-special —
  // unescaped, `[data:qa="v"]` is an invalid selector in every framework.
  // (Asserted as text: jsdom's selector engine can't parse an escaped attribute name.
  // The same selector was checked in Chromium, where it matches the element.)
  it('escapes a custom test attribute name in every framework', () => {
    const target = { kind: 'testid', attr: 'data:qa', value: 'v' };
    const selector = String.raw`'[data\\:qa="v"]'`;
    expect(C.locatorExpr(target, 'playwright', 'javascript')).toBe(`page.locator(${selector})`);
    expect(C.locatorExpr(target, 'selenium', 'javascript')).toBe(`driver.findElement(By.css(${selector}))`);
    expect(C.locatorExpr(target, 'cypress', 'javascript')).toBe(`cy.get(${selector})`);
  });
});

// The bugs these cover shipped as *silently wrong generated code*: the value closed
// the selector early, so the test the user pasted into their suite either threw or
// matched the wrong element.
describe('escaping of hostile values', () => {
  // Each framework reaches a CSS attribute selector through a different target kind
  // (Playwright prefers getByTitle/getByTestId and only falls back to locator()).
  it.each([
    ['playwright', { kind: 'testid', attr: 'data-qa', value: 'field"name' }],
    ['cypress', { kind: 'title', value: 'field"name' }],
    ['selenium', { kind: 'title', value: 'field"name' }],
  ])('escapes a double quote inside a %s CSS attribute selector', (fw, target) => {
    const expr = C.locatorExpr(target, fw, 'javascript');
    // Unescaped, `="field"name"` terminates the attribute early and the selector throws.
    expect(expr).not.toMatch(/="field"name"/);
    expect(expr).toContain('\\"');
  });

  it('does not CSS-escape values passed to a native Selenium By locator', () => {
    // By.name takes a bare name, not a selector — escaping here would corrupt it.
    expect(C.locatorExpr({ kind: 'name', value: 'field"name' }, 'selenium', 'javascript')).toBe(
      "driver.findElement(By.name('field\"name'))"
    );
  });

  it('escapes a backslash inside a CSS attribute selector', () => {
    const expr = C.locatorExpr({ kind: 'name', value: 'a\\b' }, 'playwright', 'typescript');
    expect(expr).toContain('\\\\');
  });

  it('keeps quotes in an accessible name instead of deleting them (Selenium xpath)', () => {
    const expr = C.locatorExpr(
      { kind: 'role', role: 'button', name: 'Delete "row"' },
      'selenium',
      'javascript'
    );
    // Previously every " was stripped, so the xpath searched for `Delete row` and
    // quietly matched a different button.
    expect(expr).toContain('Delete "row"');
    expect(expr).not.toContain('Delete row"');
  });

  it('switches xpath literal quoting to whichever quote the value lacks', () => {
    // Only a double quote present -> wrap in single quotes, no concat needed.
    const dbl = C.locatorExpr({ kind: 'text', value: 'say "hi"' }, 'selenium', 'javascript');
    expect(dbl).not.toContain('concat(');
    expect(dbl).toContain('say "hi"');

    // Only a single quote present -> wrap in double quotes.
    const sgl = C.locatorExpr({ kind: 'text', value: "it's here" }, 'selenium', 'javascript');
    expect(sgl).not.toContain('concat(');
    expect(sgl).toContain("it\\'s here");
  });

  it('builds a concat() xpath when both quote kinds are present', () => {
    // XPath 1.0 has no escape syntax, so this is the only correct encoding.
    const both = C.locatorExpr({ kind: 'text', value: `mix "d" and 'q'` }, 'selenium', 'javascript');
    expect(both).toContain('concat(');
  });

  it('escapes ids that contain CSS-special characters', () => {
    const expr = C.locatorExpr({ kind: 'id', value: 'md:w-1/2' }, 'playwright', 'typescript');
    expect(expr).toMatch(/\\:/);
    expect(expr).toMatch(/\\\//);
  });

  it('escapes the language quote character in string literals', () => {
    expect(C.locatorExpr({ kind: 'text', value: "it's" }, 'playwright', 'typescript')).toBe(
      "page.getByText('it\\'s')"
    );
    expect(C.locatorExpr({ kind: 'text', value: 'say "hi"' }, 'playwright', 'python')).toBe(
      'page.get_by_text("say \\"hi\\"")'
    );
  });

  it('escapes newlines and tabs rather than emitting a broken literal', () => {
    const expr = C.locatorExpr({ kind: 'text', value: 'a\nb\tc' }, 'playwright', 'typescript');
    expect(expr).toContain('\\n');
    expect(expr).toContain('\\t');
    expect(expr).not.toMatch(/\n/);
  });
});

describe('action statements', () => {
  const target = { kind: 'testid', attr: 'data-testid', value: 'email' };

  it('emits a statement for every action across every valid combination', () => {
    const actions = [
      'click',
      'dblclick',
      'check',
      'uncheck',
      'fill',
      'selectOption',
      'hover',
      'press',
      'goto',
      'viewport',
    ];
    for (const [fw, lang] of validCombos()) {
      for (const action of actions) {
        const stmt = C.actionStatement({ action, target, value: 'v' }, fw, lang);
        expect(stmt, `${fw}/${lang}/${action}`).toBeTruthy();
        expect(stmt, `${fw}/${lang}/${action}`).not.toContain('undefined');
      }
    }
  });

  it('omits await and semicolons in Python, and includes them in JS/TS', () => {
    const py = C.actionStatement({ action: 'click', target }, 'playwright', 'python');
    expect(py).not.toContain('await');
    expect(py.endsWith(';')).toBe(false);

    const ts = C.actionStatement({ action: 'click', target }, 'playwright', 'typescript');
    expect(ts.startsWith('await ')).toBe(true);
    expect(ts.endsWith(';')).toBe(true);
  });

  it('clears a Selenium field before typing so a prefilled value is replaced', () => {
    const js = C.actionStatement({ action: 'fill', target, value: 'x' }, 'selenium', 'javascript');
    expect(js).toContain('.clear()');
    expect(js.indexOf('.clear()')).toBeLessThan(js.indexOf('sendKeys'));
  });

  it('maps key names per framework', () => {
    expect(C.actionStatement({ action: 'press', value: 'Enter' }, 'cypress', 'javascript')).toContain(
      '{enter}'
    );
    expect(C.actionStatement({ action: 'press', value: 'Enter' }, 'selenium', 'python')).toContain(
      'Keys.ENTER'
    );
    expect(C.actionStatement({ action: 'press', value: 'Enter' }, 'playwright', 'typescript')).toContain(
      "press('Enter')"
    );
  });

  it('defaults an unparseable viewport to 1280x720', () => {
    const stmt = C.actionStatement({ action: 'viewport', value: 'nonsense' }, 'playwright', 'typescript');
    expect(stmt).toContain('1280');
    expect(stmt).toContain('720');
  });

  it('reads an explicit width/height pair in preference to the value string', () => {
    const stmt = C.actionStatement({ action: 'viewport', width: 800, height: 600 }, 'cypress', 'javascript');
    expect(stmt).toBe('cy.viewport(800, 600);');
  });

  it('parses a WxH viewport string', () => {
    const stmt = C.actionStatement({ action: 'viewport', value: '390x844' }, 'playwright', 'python');
    expect(stmt).toContain('390');
    expect(stmt).toContain('844');
  });
});

describe('assertions', () => {
  const target = { kind: 'id', value: 'total' };

  it('covers every assert type in every valid combination', () => {
    const types = ['toBeVisible', 'toHaveText', 'toHaveValue', 'toBeEnabled', 'toBeChecked'];
    for (const [fw, lang] of validCombos()) {
      for (const assertType of types) {
        const stmt = C.actionStatement({ action: 'assert', assertType, target, value: '42' }, fw, lang);
        expect(stmt, `${fw}/${lang}/${assertType}`).toBeTruthy();
        expect(stmt, `${fw}/${lang}/${assertType}`).not.toContain('undefined');
      }
    }
  });

  it('negates a checked assertion when the recorded value is false', () => {
    const step = { action: 'assert', assertType: 'toBeChecked', target, value: 'false' };
    expect(C.actionStatement(step, 'playwright', 'typescript')).toContain('not.toBeChecked()');
    expect(C.actionStatement(step, 'playwright', 'python')).toContain('not_to_be_checked()');
    expect(C.actionStatement(step, 'cypress', 'javascript')).toContain('not.be.checked');
    expect(C.actionStatement(step, 'selenium', 'python')).toContain('not ');
  });

  it('falls back to a visibility assertion for an unknown type', () => {
    const stmt = C.actionStatement(
      { action: 'assert', assertType: 'nope', target },
      'playwright',
      'typescript'
    );
    expect(stmt).toContain('toBeVisible()');
  });
});

describe('script scaffolding', () => {
  it('emits the right harness for each framework', () => {
    expect(C.wrapScript(["await page.goto('/');"], 'playwright', 'typescript')).toContain(
      "import { test, expect } from '@playwright/test'"
    );
    expect(C.wrapScript(['page.goto("/")'], 'playwright', 'python')).toContain(
      'from playwright.sync_api import'
    );
    expect(C.wrapScript(["cy.visit('/');"], 'cypress', 'javascript')).toContain('describe(');
    expect(C.wrapScript(["await driver.get('/');"], 'selenium', 'javascript')).toContain(
      'selenium-webdriver'
    );
    expect(C.wrapScript(['driver.get("/")'], 'selenium', 'python')).toContain(
      'from selenium import webdriver'
    );
  });

  it('adds Selenium imports only for the APIs the body actually uses', () => {
    const withSelect = C.wrapScript(
      ['await new Select(x).selectByVisibleText("a");'],
      'selenium',
      'javascript'
    );
    expect(withSelect).toContain('Select');

    const without = C.wrapScript(['await driver.get("/");'], 'selenium', 'javascript');
    expect(without).not.toMatch(/\bSelect\b/);
  });

  it('pulls in the assert module only when an assertion is present', () => {
    expect(C.wrapScript(['assert.ok(true);'], 'selenium', 'javascript')).toContain("require('assert')");
    expect(C.wrapScript(['await driver.get("/");'], 'selenium', 'javascript')).not.toContain(
      "require('assert')"
    );
  });

  it('indents every physical line of a multi-line statement', () => {
    const multi = 'await a.clear();\nawait a.sendKeys("x");';
    const wrapped = C.wrapScript([multi], 'selenium', 'javascript');
    for (const line of wrapped.split('\n').filter((l) => l.includes('await a.'))) {
      expect(line).toMatch(/^\s{4}await a\./);
    }
  });

  it('produces a syntactically complete file for an empty Python recording', () => {
    expect(C.wrapScript([], 'playwright', 'python')).toContain('    pass');
    expect(C.wrapScript([], 'selenium', 'python')).toContain('    pass');
  });

  it('round-trips a whole recording through testScript', () => {
    const actions = [
      { action: 'goto', value: 'https://example.com' },
      { action: 'fill', target: { kind: 'label', value: 'Email' }, value: 'a@b.c' },
      { action: 'click', target: { kind: 'role', role: 'button', name: 'Sign in' } },
      { action: 'assert', assertType: 'toBeVisible', target: { kind: 'text', value: 'Welcome' } },
    ];
    for (const [fw, lang] of validCombos()) {
      const script = C.testScript(actions, fw, lang);
      expect(script, `${fw}/${lang}`).toContain('example.com');
      expect(script, `${fw}/${lang}`).not.toContain('undefined');
      expect(script.endsWith('\n'), `${fw}/${lang}`).toBe(true);
    }
  });

  it('tolerates a null action list', () => {
    expect(() => C.testScript(null, 'playwright', 'typescript')).not.toThrow();
  });
});

// A chained locator is the answer to "the Delete button in *this* row". It used to
// exist only as a Playwright display string: the structured target carried the bare
// child selector, so every other framework — and every recorded step built from it —
// quietly addressed the first matching row on the page instead of the chosen one.
describe('chained locators', () => {
  const chain = {
    kind: 'chain',
    parent: { kind: 'testid', attr: 'data-testid', value: 'row-7' },
    child: { kind: 'role', role: 'button', name: 'Delete' },
  };

  it('keeps the parent scope in every framework and language', () => {
    for (const [fw, lang] of validCombos()) {
      expect(C.locatorExpr(chain, fw, lang), `${fw}/${lang}`).toContain('row-7');
      expect(C.locatorExpr(chain, fw, lang), `${fw}/${lang}`).toContain('Delete');
    }
  });

  it('continues the parent expression rather than starting a second root query', () => {
    expect(C.locatorExpr(chain, 'playwright', 'typescript')).toBe(
      "page.getByTestId('row-7').getByRole('button', { name: 'Delete' })"
    );
    expect(C.locatorExpr(chain, 'playwright', 'python')).toBe(
      'page.get_by_test_id("row-7").get_by_role("button", name="Delete")'
    );
    const cy = C.locatorExpr(chain, 'cypress', 'javascript');
    expect(cy.startsWith("cy.get('[data-testid=\"row-7\"]').find('button:not([role]), ")).toBe(true);
    expect(cy.endsWith(".filter((_, el) => locatraMatch(el, 'name', 'Delete'))")).toBe(true);
  });

  it('scopes the Selenium child XPath to the parent with a leading dot', () => {
    // Selenium's element.find_element(By.XPATH, "//…") still searches the whole
    // document — the dot is the entire difference between scoped and not.
    const js = C.locatorExpr(chain, 'selenium', 'javascript');
    expect(js).toContain('row-7');
    expect(js).toMatch(/By\.xpath\('\.\/\//);
    expect(js).not.toMatch(/By\.xpath\('\/\//);

    const py = C.locatorExpr(chain, 'selenium', 'python');
    expect(py).toMatch(/By\.XPATH, "\.\/\//);
  });

  it('leaves an unchained role locator absolute', () => {
    const plain = C.locatorExpr({ kind: 'role', role: 'button', name: 'Delete' }, 'selenium', 'javascript');
    expect(plain).toMatch(/By\.xpath\('\/\//);
  });

  it('scopes a chained text child too', () => {
    const textChain = {
      kind: 'chain',
      parent: { kind: 'id', value: 'cart' },
      child: { kind: 'text', value: 'Remove' },
    };
    expect(C.locatorExpr(textChain, 'selenium', 'python')).toMatch(/By\.XPATH, "\.\/\//);
    expect(C.locatorExpr(textChain, 'cypress', 'javascript')).toBe("cy.get('#cart').contains('Remove')");
  });

  it('drives a full action statement through the chain', () => {
    const step = { action: 'click', target: chain };
    for (const [fw, lang] of validCombos()) {
      const line = C.actionStatement(step, fw, lang);
      expect(line, `${fw}/${lang}`).toContain('row-7');
      expect(line, `${fw}/${lang}`).not.toContain('undefined');
    }
  });

  it('falls back to the parent alone when there is no child', () => {
    expect(
      C.locatorExpr({ kind: 'chain', parent: { kind: 'id', value: 'a' } }, 'playwright', 'typescript')
    ).toBe("page.locator('#a')");
  });

  it('never emits a broken expression for a malformed chain', () => {
    for (const [fw, lang] of validCombos()) {
      expect(() => C.locatorExpr({ kind: 'chain' }, fw, lang)).not.toThrow();
      expect(C.locatorExpr({ kind: 'chain' }, fw, lang), `${fw}/${lang}`).toBe('');
    }
  });
});

// An element inside an iframe is unreachable unless the generated code enters the
// frame first. Playwright and Cypress can express that inline; Selenium cannot —
// switching frames is a statement, so the whole action is wrapped in one.
describe('frames', () => {
  const inFrame = {
    kind: 'frame',
    selector: '#payment',
    index: 0,
    child: { kind: 'role', role: 'textbox', name: 'Card number' },
  };

  it('enters the frame in every framework and language', () => {
    for (const [fw, lang] of validCombos()) {
      const line = C.actionStatement({ action: 'fill', target: inFrame, value: '4242' }, fw, lang);
      expect(line, `${fw}/${lang}`).toContain('payment');
      expect(line, `${fw}/${lang}`).toContain('4242');
      expect(line, `${fw}/${lang}`).not.toContain('undefined');
    }
  });

  it('uses frameLocator for Playwright', () => {
    expect(C.locatorExpr(inFrame, 'playwright', 'typescript')).toBe(
      "page.frameLocator('#payment').getByRole('textbox', { name: 'Card number' })"
    );
    expect(C.locatorExpr(inFrame, 'playwright', 'python')).toBe(
      'page.frame_locator("#payment").get_by_role("textbox", name="Card number")'
    );
  });

  it('reaches through contentDocument for Cypress', () => {
    const expr = C.locatorExpr(inFrame, 'cypress', 'javascript');
    expect(expr).toContain("cy.get('#payment')");
    expect(expr).toContain("its('0.contentDocument.body')");
    expect(expr).toContain('.find(');
  });

  it('switches the Selenium driver in and back out again', () => {
    // Leaving the driver inside the frame would silently break every later step.
    const js = C.actionStatement({ action: 'click', target: inFrame }, 'selenium', 'javascript');
    const lines = js.split('\n');
    expect(lines[0]).toContain("switchTo().frame(driver.findElement(By.css('#payment')))");
    expect(lines[lines.length - 1]).toContain('switchTo().defaultContent()');

    const py = C.actionStatement({ action: 'click', target: inFrame }, 'selenium', 'python');
    expect(py.split('\n')[0]).toContain('driver.switch_to.frame(');
    expect(py.trim().split('\n').pop()).toBe('driver.switch_to.default_content()');
  });

  it('addresses a cross-origin frame positionally, since its element is unreadable', () => {
    const xo = { kind: 'frame', selector: null, index: 2, child: { kind: 'text', value: 'Pay' } };
    expect(C.locatorExpr(xo, 'playwright', 'typescript')).toBe(
      "page.frameLocator('iframe >> nth=2').getByText('Pay')"
    );
    expect(C.locatorExpr(xo, 'cypress', 'javascript')).toContain("cy.get('iframe').eq(2)");
    expect(C.actionStatement({ action: 'click', target: xo }, 'selenium', 'python')).toContain(
      'driver.switch_to.frame(2)'
    );
  });

  it('nests frames and composes with a chained child', () => {
    const nested = {
      kind: 'frame',
      selector: '#outer',
      child: {
        kind: 'frame',
        selector: '#inner',
        child: {
          kind: 'chain',
          parent: { kind: 'testid', attr: 'data-testid', value: 'row-2' },
          child: { kind: 'role', role: 'button', name: 'Delete' },
        },
      },
    };
    expect(C.locatorExpr(nested, 'playwright', 'typescript')).toBe(
      "page.frameLocator('#outer').frameLocator('#inner').getByTestId('row-2').getByRole('button', { name: 'Delete' })"
    );
    const py = C.actionStatement({ action: 'click', target: nested }, 'selenium', 'python').split('\n');
    expect(py[0]).toContain('#outer');
    expect(py[1]).toContain('#inner');
    expect(py[py.length - 1]).toBe('driver.switch_to.default_content()');
  });

  it('indents every line of a frame-switching statement inside the scaffold', () => {
    const script = C.testScript([{ action: 'click', target: inFrame }], 'selenium', 'python');
    for (const line of script
      .split('\n')
      .filter((l) => l.includes('switch_to') || l.includes('find_element'))) {
      expect(line).toMatch(/^ {4}\S/);
    }
  });

  it('leaves a frameless target untouched', () => {
    const plain = { kind: 'role', role: 'button', name: 'Go' };
    expect(C.locatorExpr(plain, 'playwright', 'typescript')).toBe("page.getByRole('button', { name: 'Go' })");
    expect(C.actionStatement({ action: 'click', target: plain }, 'selenium', 'python')).not.toContain(
      'switch_to'
    );
  });
});

// An <iframe> inside shadow DOM: Playwright's CSS pierces open shadow roots, so its
// frameLocator keeps the combined `selector`. Selenium's and Cypress's CSS do not, so
// they walk `shadowPath` — one selector per tree — host by host.
describe('frames inside shadow DOM', () => {
  const SHADOW = {
    kind: 'frame',
    selector: '#shell > x-pay > iframe:nth-of-type(2)',
    index: 1,
    shadowPath: ['#shell', 'x-pay', 'iframe:nth-of-type(2)'],
    child: { kind: 'id', value: 'card' },
  };
  const withoutPath = (t) => {
    const copy = { ...t };
    delete copy.shadowPath;
    return copy;
  };
  const NESTED = { kind: 'frame', selector: '#outer', index: 0, child: SHADOW };
  const fill = (target, fw, lang) => C.actionStatement({ action: 'fill', target, value: '4242' }, fw, lang);

  it('leaves Playwright output byte-identical', () => {
    for (const lang of LANGUAGES) {
      for (const t of [SHADOW, NESTED]) {
        const bare = t === SHADOW ? withoutPath(SHADOW) : { ...NESTED, child: withoutPath(SHADOW) };
        expect(C.locatorExpr(t, 'playwright', lang)).toBe(C.locatorExpr(bare, 'playwright', lang));
        expect(fill(t, 'playwright', lang)).toBe(fill(bare, 'playwright', lang));
      }
    }
    expect(C.locatorExpr(SHADOW, 'playwright', 'typescript')).toBe(
      "page.frameLocator('#shell > x-pay > iframe:nth-of-type(2)').locator('#card')"
    );
  });

  it('walks each shadow root with getShadowRoot() in Selenium JS/TS, then switches in and out', () => {
    const expected = [
      '{',
      "  const shadowHost1 = await driver.findElement(By.css('#shell'));",
      "  const shadowHost2 = await (await shadowHost1.getShadowRoot()).findElement(By.css('x-pay'));",
      "  const shadowFrame = await (await shadowHost2.getShadowRoot()).findElement(By.css('iframe:nth-of-type(2)'));",
      '  await driver.switchTo().frame(shadowFrame);',
      '}',
    ].join('\n');
    for (const lang of ['javascript', 'typescript']) {
      const out = fill(SHADOW, 'selenium', lang);
      expect(out.startsWith(expected + '\n'), out).toBe(true);
      expect(out).toContain("driver.findElement(By.id('card'))");
      expect(out.split('\n').pop()).toBe('await driver.switchTo().defaultContent();');
    }
  });

  it('walks each shadow root with .shadow_root in Selenium Python', () => {
    const lines = fill(SHADOW, 'selenium', 'python').split('\n');
    expect(lines[0]).toBe(
      'driver.switch_to.frame(driver.find_element(By.CSS_SELECTOR, "#shell")' +
        '.shadow_root.find_element(By.CSS_SELECTOR, "x-pay")' +
        '.shadow_root.find_element(By.CSS_SELECTOR, "iframe:nth-of-type(2)"))'
    );
    expect(lines[lines.length - 1]).toBe('driver.switch_to.default_content()');
  });

  it('steps through .shadow() in Cypress before entering the frame body', () => {
    expect(C.locatorExpr(SHADOW, 'cypress', 'javascript')).toBe(
      "cy.get('#shell').shadow().find('x-pay').shadow().find('iframe:nth-of-type(2)')" +
        ".its('0.contentDocument.body').should('not.be.empty').then(cy.wrap).find('#card')"
    );
  });

  it('nests under an outer frame in every framework', () => {
    const py = fill(NESTED, 'selenium', 'python').split('\n');
    expect(py[0]).toBe('driver.switch_to.frame(driver.find_element(By.CSS_SELECTOR, "#outer"))');
    expect(py[1]).toContain('.shadow_root.find_element(By.CSS_SELECTOR, "x-pay")');
    expect(py[py.length - 1]).toBe('driver.switch_to.default_content()');

    const js = fill(NESTED, 'selenium', 'javascript').split('\n');
    expect(js[0]).toBe("await driver.switchTo().frame(driver.findElement(By.css('#outer')));");
    expect(js[1]).toBe('{');
    expect(js.filter((l) => l.includes('switchTo().frame('))).toHaveLength(2);

    expect(C.locatorExpr(NESTED, 'cypress', 'typescript')).toBe(
      "cy.get('#outer').its('0.contentDocument.body').should('not.be.empty').then(cy.wrap)" +
        ".find('#shell').shadow().find('x-pay').shadow().find('iframe:nth-of-type(2)')" +
        ".its('0.contentDocument.body').should('not.be.empty').then(cy.wrap).find('#card')"
    );
  });

  it('quotes every hop for the host language', () => {
    const t = { ...SHADOW, shadowPath: ['pay-widget[title="it\'s"]', 'iframe'] };
    expect(fill(t, 'selenium', 'javascript')).toContain(
      "await driver.findElement(By.css('pay-widget[title=\"it\\'s\"]'))"
    );
    expect(fill(t, 'selenium', 'python')).toContain('By.CSS_SELECTOR, "pay-widget[title=\\"it\'s\\"]"');
  });

  it('renders exactly as before when shadowPath is missing or unusable', () => {
    const bare = withoutPath(SHADOW);
    for (const bad of [undefined, null, [], ['iframe'], ['#shell', ''], ['#shell', 3], 'x-pay iframe']) {
      const t = { ...bare, shadowPath: bad };
      for (const [fw, lang] of validCombos()) {
        expect(fill(t, fw, lang), `${fw}/${lang} ${JSON.stringify(bad)}`).toBe(fill(bare, fw, lang));
      }
    }
    // A cross-origin (positional) frame has no element to walk to.
    const xo = {
      kind: 'frame',
      selector: null,
      index: 2,
      shadowPath: ['a-b', 'iframe'],
      child: SHADOW.child,
    };
    expect(fill(xo, 'selenium', 'python')).toContain('driver.switch_to.frame(2)');
  });

  it('produces scripts that parse in every language', () => {
    const steps = [
      { action: 'goto', value: 'https://shop.example/' },
      { action: 'fill', target: SHADOW, value: '4242' },
      { action: 'click', target: NESTED },
      { action: 'check', target: SHADOW },
    ];
    const dir = mkdtempSync(join(tmpdir(), 'locatra-shadow-'));
    try {
      for (const [fw, lang] of validCombos()) {
        if (fw === 'playwright' || lang === 'python') continue;
        const code = C.testScript(steps, fw, lang);
        // Selenium scaffolds are CommonJS (require); Cypress specs are modules.
        const file = join(dir, `${fw}-${lang}.${fw === 'selenium' ? 'cjs' : 'mjs'}`);
        writeFileSync(file, code);
        if (lang === 'typescript') {
          const strip =
            "const fs = require('fs'); const f = process.argv[1];" +
            "fs.writeFileSync(f, require('node:module').stripTypeScriptTypes(fs.readFileSync(f, 'utf8')));";
          execFileSync(process.execPath, ['--no-warnings', '-e', strip, file], { stdio: 'pipe' });
        }
        expect(
          () => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }),
          `${fw}/${lang}`
        ).not.toThrow();
      }
      let python = true;
      try {
        execFileSync('python3', ['--version'], { stdio: 'pipe' });
      } catch {
        python = false; // no interpreter on this machine: nothing to parse with
      }
      if (python) {
        const file = join(dir, 'selenium.py');
        writeFileSync(file, C.testScript(steps, 'selenium', 'python'));
        expect(() =>
          execFileSync(
            'python3',
            ['-I', '-c', 'import ast, sys; ast.parse(open(sys.argv[1]).read())', file],
            {
              stdio: 'pipe',
            }
          )
        ).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Selenium/Cypress accessible-name matching ─────────────────────────────────
// Role-with-name and label locators used to match text content only
// (contains(normalize-space(.), name) / .contains(name)), so they never found a form
// control: its name comes from <label for>, a wrapping <label>, aria-labelledby,
// aria-label, title, placeholder or (buttons) value. These tests evaluate the
// generated XPath / Cypress helper against a real DOM.
describe('Selenium/Cypress accessible-name matching (DOM)', () => {
  const HTML = `
    <label for="e">Email</label><input id="e" type="email" data-k="email">
    <label><input type="checkbox" data-k="agree"> I Agree to terms</label>
    <select aria-label="Country" data-k="country"><option>India</option></select>
    <input type="search" aria-label="Search" data-k="search">
    <button aria-label="Close" data-k="close"><svg></svg></button>
    <span id="lbl">Billing   address</span><input aria-labelledby="lbl" data-k="billing">
    <input type="submit" value="Send" data-k="send">
    <input placeholder="Your name" data-k="yourname">
    <button data-k="save">Save</button><button data-k="savedraft">Save draft</button>
    <div role="button" data-k="custom">Custom</div>
    <ul role="menu"><li role="menuitem" data-k="menuitem">Menu thing</li></ul>
    <table><tr data-k="r1"><td>Row one</td><td><button data-k="d1">Delete</button></td></tr>
      <tr data-k="r2"><td>Row two</td><td><button data-k="d2">Delete</button></td></tr></table>
    <div data-k="wbdiv"><p><span data-k="wb">Welcome back</span></p></div>
    <button data-k="hostile">Delete "row" it's</button>`;

  let doc;
  beforeAll(() => {
    doc = new JSDOM(
      `<!doctype html><html><head><title>Welcome back</title></head><body>${HTML}</body></html>`
    ).window.document;
  });

  /** Extract the selector string from a Selenium JS expression and evaluate it. */
  function selenium(target) {
    const expr = C.locatorExpr(target, 'selenium', 'javascript');
    const re = /\.findElement\(By\.(css|xpath)\('((?:[^'\\]|\\.)*)'\)\)/g;
    let m;
    let ctx = doc;
    let all = [];
    while ((m = re.exec(expr))) {
      const sel = jsString(m[2]);
      if (m[1] === 'css') all = [...ctx.querySelectorAll(sel)];
      else {
        const it = doc.evaluate(sel, ctx, null, 7, null);
        all = Array.from({ length: it.snapshotLength }, (_, i) => it.snapshotItem(i));
      }
      if (!all.length) return null;
      ctx = all[0];
    }
    return all[0] ? all[0].getAttribute('data-k') : null;
  }

  /** Run a Cypress role/label expression with a minimal cy.get/find/filter stand-in. */
  function cypress(target) {
    const expr = C.locatorExpr(target, 'cypress', 'javascript');
    const helper = C.wrapScript([expr], 'cypress', 'javascript').split('describe(')[0];
    const wrap = (els) => ({
      els,
      find: (s) => wrap(els.flatMap((e) => [...e.querySelectorAll(s)])),
      filter: (fn) => wrap(els.filter((e, i) => fn(i, e))),
      first: () => wrap(els.slice(0, 1)),
      eq: (n) => wrap(els.slice(n, n + 1)),
    });
    const cy = { get: (s) => wrap([...doc.querySelectorAll(s)]) };
    const res = new Function('cy', `${helper}\nreturn ${expr};`)(cy);
    return res.els.map((e) => e.getAttribute('data-k'));
  }

  it.each([
    [{ kind: 'role', role: 'textbox', name: 'Email' }, 'email'],
    [{ kind: 'role', role: 'checkbox', name: 'Agree' }, 'agree'],
    [{ kind: 'role', role: 'combobox', name: 'Country' }, 'country'],
    [{ kind: 'role', role: 'searchbox', name: 'Search' }, 'search'],
    [{ kind: 'role', role: 'button', name: 'Close' }, 'close'],
    [{ kind: 'role', role: 'textbox', name: 'Billing address' }, 'billing'],
    [{ kind: 'role', role: 'button', name: 'Send' }, 'send'],
    [{ kind: 'role', role: 'textbox', name: 'Your name' }, 'yourname'],
    [{ kind: 'role', role: 'button', name: 'Custom' }, 'custom'],
    [{ kind: 'role', role: 'menuitem', name: 'Menu thing' }, 'menuitem'],
    [{ kind: 'role', role: 'button', name: 'Delete "row" it\'s' }, 'hostile'],
  ])('finds role %j by its accessible name', (target, want) => {
    expect(selenium(target)).toBe(want);
    expect(cypress(target)).toEqual([want]);
  });

  it.each([
    [{ kind: 'label', value: 'Email' }, 'email'],
    [{ kind: 'label', value: 'I Agree to terms', exact: true }, 'agree'],
    [{ kind: 'label', value: 'Country' }, 'country'],
    [{ kind: 'label', value: 'Billing address' }, 'billing'],
  ])('finds label %j via <label for>, wrapping label, aria-label and aria-labelledby', (target, want) => {
    expect(selenium(target)).toBe(want);
    expect(cypress(target)).toEqual([want]);
  });

  it('honours exact for a role name (Save vs Save draft)', () => {
    const t = { kind: 'role', role: 'button', name: 'Save', exact: true };
    expect(selenium(t)).toBe('save');
    expect(cypress(t)).toEqual(['save']);
    // Without exact, substring semantics match both — exactly why the engine sets it.
    expect(cypress({ kind: 'role', role: 'button', name: 'Save' })).toEqual(['save', 'savedraft']);
  });

  it('does not let a native element keep its implicit role under an explicit role', () => {
    // <li role="menuitem"> is not a listitem (Playwright semantics).
    expect(selenium({ kind: 'role', role: 'listitem', name: 'Menu thing' })).toBe(null);
  });

  it('chains from a named parent so .find() continues from the row, not a text node', () => {
    const chain = {
      kind: 'chain',
      parent: { kind: 'role', role: 'row', name: 'Row two' },
      child: { kind: 'role', role: 'button', name: 'Delete' },
    };
    expect(selenium(chain)).toBe('d2');
    expect(cypress(chain)).toEqual(['d2']);
  });

  it('matches the deepest element for a Selenium text locator, not <html> or <title>', () => {
    expect(selenium({ kind: 'text', value: 'Welcome back' })).toBe('wb');
    expect(selenium({ kind: 'text', value: 'Welcome back', exact: true })).toBe('wb');
    const chained = {
      kind: 'chain',
      parent: { kind: 'testid', attr: 'data-k', value: 'r2' },
      child: { kind: 'text', value: 'Delete' },
    };
    expect(selenium(chained)).toBe('d2');
  });

  it('honours target.nth positionally in every framework', () => {
    const t = { kind: 'role', role: 'button', name: 'Delete', nth: 1 };
    expect(selenium(t)).toBe('d2');
    expect(cypress(t)).toEqual(['d2']);
    expect(C.locatorExpr(t, 'playwright', 'typescript')).toBe(
      "page.getByRole('button', { name: 'Delete' }).nth(1)"
    );
  });
});

describe('role selector tables', () => {
  it('keeps the CSS and XPath forms consistent with Playwright implicit roles', () => {
    const css = (role) => C.locatorExpr({ kind: 'role', role }, 'cypress', 'javascript');
    const xp = (role) => C.locatorExpr({ kind: 'role', role, name: 'x' }, 'selenium', 'python');
    for (const [role, tag] of [
      ['textbox', 'textarea'],
      ['searchbox', 'input[type="search"]'],
      ['spinbutton', 'input[type="number"]'],
      ['slider', 'input[type="range"]'],
      ['list', 'ul'],
      ['listitem', 'li'],
      ['table', 'table'],
      ['row', 'tr'],
      ['cell', 'td'],
      ['navigation', 'nav'],
      ['main', 'main'],
      ['dialog', 'dialog'],
      ['banner', 'header'],
      ['contentinfo', 'footer'],
      ['complementary', 'aside'],
      ['option', 'option'],
    ]) {
      expect(css(role), role).toContain(tag);
      expect(xp(role), role).toContain('self::' + tag.split('[')[0]);
    }
    // number is a spinbutton and search a searchbox, never a textbox.
    expect(css('textbox')).toContain(':not([type="number"])');
    expect(css('textbox')).toContain(':not([type="search"])');
  });

  it('narrows a heading to its level', () => {
    const h = { kind: 'role', role: 'heading', name: 'T', level: 2 };
    expect(C.locatorExpr(h, 'cypress', 'javascript')).toContain(
      'h2:not([role]), [role~="heading"][aria-level="2"]'
    );
    expect(C.locatorExpr(h, 'cypress', 'javascript')).not.toContain('h1');
  });
});

describe('exact matching (C5)', () => {
  it('passes exact through to every Playwright getBy* kind', () => {
    for (const kind of ['label', 'placeholder', 'altText', 'title', 'text']) {
      const t = { kind, value: 'Save', exact: true };
      expect(C.locatorExpr(t, 'playwright', 'typescript'), kind).toContain(', { exact: true })');
      expect(C.locatorExpr(t, 'playwright', 'python'), kind).toContain(', exact=True)');
    }
    expect(
      C.locatorExpr({ kind: 'role', role: 'button', name: 'Save', exact: true }, 'playwright', 'python')
    ).toBe('page.get_by_role("button", name="Save", exact=True)');
  });

  it('uses equality when exact and substring otherwise for attribute kinds', () => {
    expect(
      C.locatorExpr({ kind: 'placeholder', value: 'Q', exact: true }, 'cypress', 'javascript')
    ).toContain('[placeholder="Q"]');
    expect(C.locatorExpr({ kind: 'placeholder', value: 'Q' }, 'selenium', 'javascript')).toContain(
      '[placeholder*="Q"]'
    );
  });

  it('anchors an exact Cypress text match with an escaped regex', () => {
    expect(
      C.locatorExpr({ kind: 'text', value: 'Price (USD) $5 / unit', exact: true }, 'cypress', 'javascript')
    ).toBe('cy.contains(/^\\s*Price\\s+\\(USD\\)\\s+\\$5\\s+\\/\\s+unit\\s*$/)');
    const re = new Function(
      `return ${C.locatorExpr({ kind: 'text', value: 'a.b', exact: true }, 'cypress', 'javascript').slice(12, -1)};`
    )();
    expect(re.test(' a.b ')).toBe(true);
    expect(re.test('axb')).toBe(false);
  });
});

describe('Cypress key presses (C6)', () => {
  const press = (value) => C.actionStatement({ action: 'press', value }, 'cypress', 'javascript');

  it('uses cy.press for Tab, which cy.type() cannot express', () => {
    expect(press('Tab')).toBe('cy.press(Cypress.Keyboard.Keys.TAB);');
  });

  it('types other plain keys into the focused element', () => {
    expect(press('Enter')).toBe("cy.focused().type('{enter}');");
    expect(press(' ')).toBe("cy.focused().type(' ');");
    expect(press('{')).toBe("cy.focused().type('{{}');");
  });

  it('emits a TODO rather than a different key for what Cypress cannot press', () => {
    expect(press('F13')).toMatch(/^\/\/ TODO: /);
  });
});

describe('Cypress modifier combos via cypress-real-events', () => {
  const press = (value, lang = 'javascript') =>
    C.actionStatement({ action: 'press', value }, 'cypress', lang);
  const IMPORT = /^import 'cypress-real-events';$/gm;
  const page = (value, url = 'https://a.example.com/') => ({ action: 'press', value, url });
  const GOTO = { action: 'goto', value: 'https://a.example.com/', url: 'https://a.example.com/' };

  // Parse a generated spec: TS is type-stripped first, then node --check (as an ES module).
  function checkSyntax(code, lang) {
    const dir = mkdtempSync(join(tmpdir(), 'locatra-cy-'));
    const file = join(dir, 'spec.mjs');
    try {
      writeFileSync(file, code);
      if (lang === 'typescript') {
        const strip =
          "const fs = require('fs'); const f = process.argv[1];" +
          "fs.writeFileSync(f, require('node:module').stripTypeScriptTypes(fs.readFileSync(f, 'utf8')));";
        execFileSync(process.execPath, ['--no-warnings', '-e', strip, file], { stdio: 'pipe' });
      }
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it.each([
    ['Shift+Tab', "['Shift', 'Tab']"],
    ['Control+Enter', "['Control', 'Enter']"],
    ['Shift+Space', "['Shift', 'Space']"],
    ['Shift+ ', "['Shift', 'Space']"],
    ['Meta+a', "['Meta', 'a']"],
    ['Meta+K', "['Meta', 'K']"],
    ['Control+Alt+Shift+Meta+Enter', "['Control', 'Alt', 'Shift', 'Meta', 'Enter']"],
    ['Control+Alt+Meta+Shift+Tab', "['Control', 'Alt', 'Meta', 'Shift', 'Tab']"],
    ['Alt+Escape', "['Alt', 'Escape']"],
    ['Shift+ArrowDown', "['Shift', 'ArrowDown']"],
    ['Control++', "['Control', '+']"],
    ["Control+'", "['Control', '\\'']"],
  ])('presses %s natively with cy.realPress (TS and JS)', (value, keys) => {
    expect(press(value, 'javascript')).toBe(`cy.realPress(${keys});`);
    expect(press(value, 'typescript')).toBe(`cy.realPress(${keys});`);
  });

  it('keeps cy.press for plain Tab and cy.type for other plain keys — no plugin needed', () => {
    expect(press('Tab')).toBe('cy.press(Cypress.Keyboard.Keys.TAB);');
    expect(press('Escape')).toBe("cy.focused().type('{esc}');");
    for (const lang of ['typescript', 'javascript']) {
      const spec = C.testScript([GOTO, page('Tab'), page('Enter'), page(' ')], 'cypress', lang);
      expect(spec).not.toContain('cypress-real-events');
      expect(spec).not.toContain('realPress');
    }
  });

  it('never turns an unsupported key or modifier into a different key', () => {
    for (const value of ['Hyper+Enter', 'Ctrl+Enter', 'Shift+F25', 'Shift+Unidentified', 'Shift+']) {
      const out = press(value);
      expect(out, value).toMatch(/^\/\/ TODO: press "/);
      expect(out, value).toContain('cy.realPress()');
      // A TODO that only mentions the command must not pull the plugin in.
      expect(C.testScript([GOTO, page(value)], 'cypress', 'javascript'), value).not.toContain('import ');
    }
  });

  it('imports the plugin exactly once, at the top, only when a combo is pressed', () => {
    for (const lang of ['typescript', 'javascript']) {
      const spec = C.testScript(
        [GOTO, page('Shift+Tab'), page('Tab'), page('Control+Enter'), page('Shift+Tab')],
        'cypress',
        lang
      );
      expect(spec.match(IMPORT), lang).toHaveLength(1);
      expect(spec.startsWith('// cy.realPress() needs the cypress-real-events plugin'), lang).toBe(true);
      expect(spec).toContain('npm i -D cypress-real-events');
      expect(spec).toContain('only in Chromium-based browsers');
      expect(spec).toContain(
        "    cy.realPress(['Shift', 'Tab']);\n    cy.press(Cypress.Keyboard.Keys.TAB);\n"
      );
      expect(spec).not.toContain('Cypress.require');
      checkSyntax(spec, lang);
    }
  });

  it('puts the import ahead of the name helper', () => {
    const steps = [
      GOTO,
      { action: 'click', target: { kind: 'role', role: 'button', name: 'Go' }, url: GOTO.url },
      page('Shift+Space'),
    ];
    const ts = C.testScript(steps, 'cypress', 'typescript');
    expect(ts.indexOf("import 'cypress-real-events';")).toBeLessThan(ts.indexOf('function locatraMatch('));
    checkSyntax(ts, 'typescript');
  });

  it('loads the plugin inside cy.origin() blocks that press combos', () => {
    const steps = [
      GOTO,
      page('Shift+Tab'),
      { action: 'click', target: { kind: 'id', value: 'sso' }, url: 'https://b.example.org/sso' },
      page('Shift+Tab', 'https://b.example.org/sso'),
      page('Meta+Enter', 'https://b.example.org/sso'),
      { action: 'click', target: { kind: 'id', value: 'back' }, url: 'https://a.example.com/home' },
      { action: 'click', target: { kind: 'id', value: 'x' }, url: 'https://c.example.net/' },
    ];
    for (const lang of ['typescript', 'javascript']) {
      const spec = C.testScript(steps, 'cypress', lang);
      expect(spec.match(IMPORT), lang).toHaveLength(1);
      expect(spec).toContain(
        "    cy.origin('https://b.example.org', () => {\n" +
          '      // cy.origin() has its own context: load the plugin there too (needs experimentalOriginDependencies: true).\n' +
          "      Cypress.require('cypress-real-events');\n" +
          "      cy.get('#sso').click();\n" +
          "      cy.realPress(['Shift', 'Tab']);\n" +
          "      cy.realPress(['Meta', 'Enter']);\n" +
          '    });\n'
      );
      // Only the block that presses a combo loads it.
      expect(spec.match(/Cypress\.require\(/g), lang).toHaveLength(1);
      expect(spec).toContain(
        "cy.origin('https://c.example.net', () => {\n      cy.get('#x').click();\n    });"
      );
      checkSyntax(spec, lang);
    }
  });

  it('loads the plugin in cy.origin() even when the primary origin needs no combo', () => {
    const steps = [
      GOTO,
      { action: 'click', target: { kind: 'id', value: 'sso' }, url: 'https://b.example.org/sso' },
      page('Alt+Escape', 'https://b.example.org/sso'),
    ];
    const js = C.testScript(steps, 'cypress', 'javascript');
    expect(js.match(IMPORT)).toHaveLength(1);
    expect(js).toContain("      Cypress.require('cypress-real-events');\n      cy.get('#sso').click();");
  });

  it('leaves Playwright and Selenium output untouched by the plugin', () => {
    const steps = [GOTO, page('Shift+Tab'), page('Control+Alt+Shift+Meta+Enter')];
    for (const [fw, lang] of validCombos().filter(([f]) => f !== 'cypress')) {
      expect(C.testScript(steps, fw, lang), `${fw}/${lang}`).not.toMatch(/realPress|real-events/);
    }
  });
});

describe('Selenium key presses (C6)', () => {
  it('maps combos with key_down/key_up', () => {
    expect(C.actionStatement({ action: 'press', value: 'Shift+Tab' }, 'selenium', 'python')).toBe(
      'webdriver.ActionChains(driver).key_down(Keys.SHIFT).send_keys(Keys.TAB).key_up(Keys.SHIFT).perform()'
    );
    expect(C.actionStatement({ action: 'press', value: ' ' }, 'selenium', 'javascript')).toBe(
      'await driver.actions().sendKeys(Key.SPACE).perform();'
    );
  });

  it('never turns an unknown key into ENTER', () => {
    const out = C.actionStatement({ action: 'press', value: 'Unidentified' }, 'selenium', 'python');
    expect(out).not.toContain('ENTER');
    expect(out).toMatch(/^# TODO: /);
  });
});

describe('fill', () => {
  it('stops Cypress parsing {…} in a recorded value', () => {
    expect(
      C.actionStatement(
        { action: 'fill', target: { kind: 'id', value: 'q' }, value: 'a{enter}' },
        'cypress',
        'javascript'
      )
    ).toBe("cy.get('#q').clear().type('a{enter}', { parseSpecialCharSequences: false });");
  });

  it('reads a sensitive value from the environment in every framework (C4)', () => {
    const step = {
      action: 'fill',
      target: { kind: 'id', value: 'pw' },
      value: 'leak',
      sensitive: true,
      secretName: 'LOCATRA_PASSWORD',
    };
    expect(C.actionStatement(step, 'playwright', 'typescript')).toBe(
      "await page.locator('#pw').fill(process.env.LOCATRA_PASSWORD ?? '');"
    );
    expect(C.actionStatement(step, 'selenium', 'python')).toContain(
      'send_keys(os.environ.get("LOCATRA_PASSWORD", ""))'
    );
    expect(C.actionStatement(step, 'cypress', 'javascript')).toBe(
      "locatraSecret('LOCATRA_PASSWORD').then((secret) => {\n" +
        "  cy.get('#pw').clear().type(secret, { log: false, parseSpecialCharSequences: false });\n" +
        '});'
    );
    for (const [fw, lang] of validCombos()) {
      expect(C.actionStatement(step, fw, lang), `${fw}/${lang}`).not.toContain('leak');
    }
  });

  it('defaults and sanitises the secret name', () => {
    const base = { action: 'fill', target: { kind: 'id', value: 'pw' }, sensitive: true };
    expect(C.actionStatement(base, 'playwright', 'javascript')).toContain('process.env.LOCATRA_PASSWORD');
    expect(C.actionStatement({ ...base, secretName: 'LOCATRA_SECRET' }, 'playwright', 'python')).toContain(
      'os.environ.get("LOCATRA_SECRET", "")'
    );
    expect(C.actionStatement({ ...base, secretName: "x'); evil(" }, 'playwright', 'javascript')).toContain(
      'process.env.LOCATRA_PASSWORD'
    );
  });

  it('imports os exactly once in Python scripts that need it', () => {
    const steps = [
      { action: 'fill', target: { kind: 'id', value: 'a' }, sensitive: true },
      { action: 'fill', target: { kind: 'id', value: 'b' }, sensitive: true, secretName: 'LOCATRA_SECRET' },
    ];
    for (const fw of ['playwright', 'selenium']) {
      const py = C.testScript(steps, fw, 'python');
      expect(py.match(/^import os$/gm), fw).toHaveLength(1);
    }
    expect(C.testScript([{ action: 'goto', value: '/' }], 'playwright', 'python')).not.toContain('import os');
  });

  it('sets range/colour values directly where typing cannot (C6)', () => {
    const step = { action: 'fill', target: { kind: 'id', value: 'vol' }, value: '42', inputType: 'range' };
    expect(C.actionStatement(step, 'cypress', 'javascript')).toBe(
      "cy.get('#vol').invoke('val', '42').trigger('input').trigger('change');"
    );
    const sel = C.actionStatement(step, 'selenium', 'python');
    expect(sel).toMatch(/^driver\.execute_script\(/);
    expect(sel).toContain("dispatchEvent(new Event('input'");
    expect(sel).toContain("dispatchEvent(new Event('change'");
    expect(C.actionStatement(step, 'playwright', 'typescript')).toBe(
      "await page.locator('#vol').fill('42');"
    );
  });
});

describe('upload (C6)', () => {
  const step = { action: 'upload', target: { kind: 'id', value: 'f' }, value: '["a.pdf","b c.png"]' };

  it('renders setInputFiles / send_keys / selectFile with a path note', () => {
    expect(C.actionStatement(step, 'playwright', 'typescript')).toBe(
      "// NOTE: these file paths must exist relative to where the test runs\nawait page.locator('#f').setInputFiles(['a.pdf', 'b c.png']);"
    );
    expect(C.actionStatement(step, 'playwright', 'python')).toContain(
      '.set_input_files(["a.pdf", "b c.png"])'
    );
    expect(C.actionStatement(step, 'selenium', 'python')).toContain(
      '.send_keys("\\n".join(os.path.abspath(p) for p in ["a.pdf", "b c.png"]))'
    );
    expect(C.actionStatement(step, 'cypress', 'javascript')).toContain(".selectFile(['a.pdf', 'b c.png']);");
  });

  it('tolerates a bare file name instead of JSON', () => {
    expect(C.actionStatement({ ...step, value: 'x.txt' }, 'playwright', 'javascript')).toContain(
      "setInputFiles(['x.txt'])"
    );
  });
});

describe('Selenium check/uncheck and viewport', () => {
  const t = { kind: 'id', value: 'agree' };

  it('only clicks when the checked state differs', () => {
    expect(C.actionStatement({ action: 'check', target: t }, 'selenium', 'python')).toBe(
      'el = driver.find_element(By.ID, "agree")\n' +
        'if not (el.is_selected() or el.get_attribute("aria-checked") == "true"):\n' +
        '    el.click()'
    );
    const js = C.actionStatement({ action: 'uncheck', target: t }, 'selenium', 'javascript');
    expect(js).toContain(
      "if (((await el.isSelected()) || (await el.getAttribute('aria-checked')) === 'true')) await el.click();"
    );
  });

  it('can repeat element-scoped statements without redeclaring in JS', () => {
    const steps = [
      { action: 'check', target: t },
      { action: 'fill', target: t, value: 'x' },
    ];
    const js = C.testScript(steps, 'selenium', 'javascript');
    expect(js.match(/const el = /g)).toHaveLength(2);
    expect(js.match(/^ {4}\{$/gm)).toHaveLength(2); // each in its own block
  });

  it('sizes the window to the recorded viewport plus browser chrome', () => {
    const py = C.actionStatement({ action: 'viewport', width: 390, height: 844 }, 'selenium', 'python');
    expect(py).toBe(
      'driver.set_window_size(*driver.execute_script("return [390 + window.outerWidth - window.innerWidth, 844 + window.outerHeight - window.innerHeight];"))'
    );
    expect(
      C.actionStatement({ action: 'viewport', width: 390, height: 844 }, 'selenium', 'typescript')
    ).toContain('executeScript<{ width: number; height: number }>(');
  });
});

describe('text assertions (C6)', () => {
  const t = { kind: 'id', value: 'total' };

  it('supports toContainText everywhere', () => {
    const step = { action: 'assert', assertType: 'toContainText', target: t, value: 'lorem' };
    expect(C.actionStatement(step, 'playwright', 'typescript')).toBe(
      "await expect(page.locator('#total')).toContainText('lorem', { useInnerText: true });"
    );
    expect(C.actionStatement(step, 'playwright', 'python')).toBe(
      'expect(page.locator("#total")).to_contain_text("lorem", use_inner_text=True)'
    );
    expect(C.actionStatement(step, 'selenium', 'python')).toBe(
      'assert "lorem" in " ".join(driver.find_element(By.ID, "total").text.replace("\\u00ad", "").replace("\\u200b", "").split())'
    );
    expect(C.actionStatement(step, 'cypress', 'javascript')).toContain('.to.contain(');
  });

  it('compares whitespace-normalised text for toHaveText in Cypress and Selenium', () => {
    const step = { action: 'assert', assertType: 'toHaveText', target: t, value: '  Total\n 42 ' };
    expect(C.actionStatement(step, 'cypress', 'javascript')).toBe(
      "cy.get('#total').should(($el) => { expect($el[0].innerText.replace(/[\\u00ad\\u200b]/g, '').replace(/\\s+/g, ' ').trim()).to.equal('Total 42'); });"
    );
    expect(C.actionStatement(step, 'selenium', 'javascript')).toBe(
      "assert.strictEqual((await driver.findElement(By.id('total')).getText()).replace(/[\\u00ad\\u200b]/g, '').replace(/\\s+/g, ' ').trim(), 'Total 42');"
    );
  });
});

describe('control characters in literals', () => {
  it('escapes NUL, other C0 controls, DEL and line separators', () => {
    const v = 'a\x00b\x0bc\x7fd e';
    expect(C.q(v, 'python')).toBe('"a\\x00b\\x0bc\\x7fd\\u2028e"');
    expect(C.q(v, 'javascript')).toBe("'a\\x00b\\x0bc\\x7fd\\u2028e'");
    // Round-trips through a real JS parser.
    expect(new Function(`return ${C.q(v, 'javascript')};`)()).toBe(v);
  });

  it('CSS-escapes a newline inside an attribute selector', () => {
    expect(C.locatorExpr({ kind: 'name', value: 'a\nb' }, 'playwright', 'typescript')).toBe(
      'page.locator(\'[name="a\\\\a b"]\')'
    );
  });
});

describe('ambiguous and unsupported steps', () => {
  it('picks .first() in Cypress and notes it for an unnamed role locator', () => {
    const out = C.actionStatement(
      { action: 'click', target: { kind: 'role', role: 'button' } },
      'cypress',
      'javascript'
    );
    expect(out.split('\n')[0]).toMatch(/^\/\/ NOTE: .*several elements/);
    expect(out).toMatch(/\.first\(\)\.click\(\);$/);
    expect(
      C.actionStatement({ action: 'click', target: { kind: 'role', role: 'button' } }, 'selenium', 'python')
    ).toMatch(/^# NOTE: /);
  });

  it('trusts a known-unique unnamed role', () => {
    const out = C.actionStatement(
      { action: 'click', target: { kind: 'role', role: 'main', matchCount: 1 } },
      'cypress',
      'javascript'
    );
    expect(out).not.toContain('NOTE');
    expect(out).not.toContain('.first()');
  });

  it('emits a TODO comment for an unknown action instead of clicking or throwing', () => {
    for (const [fw, lang] of validCombos()) {
      const out = C.actionStatement({ action: 'scroll', target: { kind: 'id', value: 'x' } }, fw, lang);
      expect(out, `${fw}/${lang}`).toMatch(/^(\/\/|#) TODO: unsupported step "scroll"/);
    }
  });

  it('keeps a Python script valid when every step is a comment', () => {
    const py = C.testScript([{ action: 'scroll' }], 'selenium', 'python');
    expect(py).toContain('    # TODO');
    expect(py).toContain('    pass\nfinally:');
  });
});

describe('Cypress cross-origin', () => {
  it('explains that a positional (cross-origin) iframe is unreachable', () => {
    const t = { kind: 'frame', selector: null, index: 1, child: { kind: 'text', value: 'Pay' } };
    const out = C.actionStatement({ action: 'click', target: t }, 'cypress', 'javascript');
    expect(out).toMatch(/^\/\/ NOTE: this iframe is cross-origin/);
    expect(
      C.actionStatement({ action: 'click', target: { ...t, selector: '#pay' } }, 'cypress', 'javascript')
    ).not.toContain('NOTE');
  });

  it('wraps steps on a different origin in cy.origin()', () => {
    const steps = [
      { action: 'goto', value: 'https://a.example.com/', url: 'https://a.example.com/' },
      { action: 'click', target: { kind: 'role', role: 'link', name: 'SSO' }, url: 'https://a.example.com/' },
      { action: 'fill', target: { kind: 'id', value: 'code' }, value: '1', url: 'https://b.example.org/sso' },
      { action: 'click', target: { kind: 'id', value: 'back' }, url: 'https://a.example.com/home' },
    ];
    const js = C.testScript(steps, 'cypress', 'javascript');
    expect(js).toContain(
      "    cy.origin('https://b.example.org', () => {\n" +
        "      cy.get('#code').clear().type('1', { parseSpecialCharSequences: false });\n" +
        '    });\n' +
        "    cy.get('#back').click();"
    );
  });

  it('falls back to cy.visit() lines when only statements are given', () => {
    const js = C.wrapScript(
      ["cy.visit('https://a.com/');", "cy.visit('https://b.com/x');", "cy.get('#x').click();"],
      'cypress',
      'javascript'
    );
    expect(js).toContain(
      "cy.origin('https://b.com', () => {\n      cy.visit('https://b.com/x');\n      cy.get('#x').click();\n    });"
    );
  });

  it('declares the name helper once at the top, and again inside cy.origin', () => {
    const steps = [
      { action: 'goto', value: 'https://a.example.com/' },
      {
        action: 'click',
        target: { kind: 'role', role: 'button', name: 'Go' },
        url: 'https://a.example.com/',
      },
      {
        action: 'click',
        target: { kind: 'role', role: 'button', name: 'Go' },
        url: 'https://b.example.org/',
      },
    ];
    const ts = C.testScript(steps, 'cypress', 'typescript');
    expect(ts.match(/function locatraMatch\(/g)).toHaveLength(2);
    expect(ts.startsWith('// Locatra: match an element')).toBe(true);
    expect(ts).toContain(
      'function locatraMatch(el: HTMLElement, kind: string, text: string, exact?: boolean): boolean {'
    );
    expect(C.testScript(steps, 'cypress', 'javascript')).toContain(
      'function locatraMatch(el, kind, text, exact) {'
    );
    expect(C.testScript([{ action: 'goto', value: '/' }], 'cypress', 'javascript')).not.toContain(
      'locatraMatch'
    );
  });
});

describe('press combos recorded by the content script', () => {
  it.each([
    [
      'Shift+Space',
      'Shift+Space',
      "cy.realPress(['Shift', 'Space']);",
      'key_down(Keys.SHIFT).send_keys(Keys.SPACE).key_up(Keys.SHIFT)',
    ],
    ['Escape', 'Escape', "cy.focused().type('{esc}');", 'send_keys(Keys.ESCAPE)'],
    [
      'Control+Alt+Shift+Meta+Enter',
      'Control+Alt+Shift+Meta+Enter',
      "cy.realPress(['Control', 'Alt', 'Shift', 'Meta', 'Enter']);",
      'key_down(Keys.CONTROL).key_down(Keys.ALT).key_down(Keys.SHIFT).key_down(Keys.META).send_keys(Keys.ENTER).key_up(Keys.META).key_up(Keys.SHIFT).key_up(Keys.ALT).key_up(Keys.CONTROL)',
    ],
  ])('maps %s in every framework', (value, pw, cy, sel) => {
    expect(C.actionStatement({ action: 'press', value }, 'playwright', 'typescript')).toBe(
      `await page.keyboard.press('${pw}');`
    );
    expect(C.actionStatement({ action: 'press', value }, 'cypress', 'javascript')).toBe(cy);
    expect(C.actionStatement({ action: 'press', value }, 'selenium', 'python')).toContain(sel);
  });
});

describe('Cypress check/uncheck on native and ARIA controls', () => {
  // Executes the generated statement against jsdom with a minimal cy/jQuery stand-in.
  function run(stmt, doc) {
    const $ = (el) => ({
      el,
      is: (sel) => el.matches(sel),
      attr: (n) => el.getAttribute(n) ?? undefined,
    });
    const chain = (els) => ({
      filter: (fn) => chain(els.filter((e, i) => fn(i, e))),
      then: (fn) => fn($(els[0])),
    });
    const cy = {
      get: (s) => chain([...doc.querySelectorAll(s)]),
      wrap: ($el) => ({
        check: () => {
          $el.el.checked = true;
        },
        uncheck: () => {
          $el.el.checked = false;
        },
        click: () => $el.el.click(),
      }),
    };
    const helper = C.wrapScript([stmt], 'cypress', 'javascript').split('describe(')[0];
    new Function('cy', `${helper}\n${stmt}`)(cy);
  }

  function page() {
    const doc = new JSDOM(`<label><input type="checkbox" id="n"> Native</label>
      <div role="checkbox" id="a" aria-checked="false">Aria</div>
      <div role="switch" id="s" aria-checked="true">Wifi</div>`).window.document;
    for (const id of ['a', 's']) {
      const el = doc.getElementById(id);
      el.addEventListener('click', () =>
        el.setAttribute('aria-checked', el.getAttribute('aria-checked') === 'true' ? 'false' : 'true')
      );
    }
    return doc;
  }

  const stmt = (action, role, name) =>
    C.actionStatement({ action, target: { kind: 'role', role, name } }, 'cypress', 'javascript');

  it('checks a native checkbox with .check() and is idempotent', () => {
    const doc = page();
    run(stmt('check', 'checkbox', 'Native'), doc);
    run(stmt('check', 'checkbox', 'Native'), doc);
    expect(doc.getElementById('n').checked).toBe(true);
    run(stmt('uncheck', 'checkbox', 'Native'), doc);
    expect(doc.getElementById('n').checked).toBe(false);
  });

  it('clicks an ARIA checkbox/switch only when its state differs', () => {
    const doc = page();
    run(stmt('check', 'checkbox', 'Aria'), doc);
    run(stmt('check', 'checkbox', 'Aria'), doc);
    expect(doc.getElementById('a').getAttribute('aria-checked')).toBe('true');
    run(stmt('uncheck', 'switch', 'Wifi'), doc);
    run(stmt('uncheck', 'switch', 'Wifi'), doc);
    expect(doc.getElementById('s').getAttribute('aria-checked')).toBe('false');
  });
});

describe('Selenium accessible-name precedence', () => {
  const doc = () =>
    new JSDOM(`<button aria-label="Dismiss" id="b">Cancel</button>
    <label for="z">Zip</label><input id="z" placeholder="Postal" title="Code">
    <button title="Settings" id="g">Gear</button>`).window.document;

  function count(target) {
    const m = /By\.xpath\('((?:[^'\\]|\\.)*)'\)/.exec(C.locatorExpr(target, 'selenium', 'javascript'));
    const d = doc();
    return d.evaluate(jsString(m[1]), d, null, 7, null).snapshotLength;
  }

  it('lets the first present name source decide, like Playwright', () => {
    expect(count({ kind: 'role', role: 'button', name: 'Dismiss' })).toBe(1);
    expect(count({ kind: 'role', role: 'button', name: 'Cancel' })).toBe(0); // aria-label wins
    expect(count({ kind: 'role', role: 'textbox', name: 'Zip' })).toBe(1);
    expect(count({ kind: 'role', role: 'textbox', name: 'Postal' })).toBe(0); // label wins
    expect(count({ kind: 'role', role: 'textbox', name: 'Code' })).toBe(0);
    expect(count({ kind: 'role', role: 'button', name: 'Gear' })).toBe(1);
    expect(count({ kind: 'role', role: 'button', name: 'Settings' })).toBe(0); // content wins over title
  });
});

// ── F3: page URL assertions, toHaveValue, suggested steps ─────────────────────
describe('toHaveURL assertions', () => {
  const step = {
    action: 'assert',
    assertType: 'toHaveURL',
    value: "https://shop.example/done?o='1'",
    target: null,
  };

  it('renders a page-level assertion in every framework', () => {
    const got = Object.fromEntries(
      validCombos().map(([fw, lang]) => [`${fw}/${lang}`, C.actionStatement(step, fw, lang)])
    );
    expect(got).toEqual({
      'playwright/typescript': "await expect(page).toHaveURL('https://shop.example/done?o=\\'1\\'');",
      'playwright/javascript': "await expect(page).toHaveURL('https://shop.example/done?o=\\'1\\'');",
      'playwright/python': 'expect(page).to_have_url("https://shop.example/done?o=\'1\'")',
      'selenium/typescript': "await driver.wait(until.urlIs('https://shop.example/done?o=\\'1\\''), 10000);",
      'selenium/javascript': "await driver.wait(until.urlIs('https://shop.example/done?o=\\'1\\''), 10000);",
      'selenium/python': 'WebDriverWait(driver, 10).until(EC.url_to_be("https://shop.example/done?o=\'1\'"))',
      'cypress/typescript': "cy.url().should('eq', 'https://shop.example/done?o=\\'1\\'');",
      'cypress/javascript': "cy.url().should('eq', 'https://shop.example/done?o=\\'1\\'');",
    });
  });

  it('ignores any target and falls back to the recorded page URL', () => {
    const framed = { kind: 'frame', selector: '#f', index: 0, child: { kind: 'id', value: 'x' } };
    expect(C.actionStatement({ ...step, target: framed }, 'selenium', 'javascript')).toBe(
      C.actionStatement(step, 'selenium', 'javascript')
    );
    expect(
      C.actionStatement(
        { action: 'assert', assertType: 'toHaveURL', url: 'https://a.example/' },
        'playwright',
        'python'
      )
    ).toBe('expect(page).to_have_url("https://a.example/")');
    expect(C.actionStatement({ action: 'assert', assertType: 'toHaveURL' }, 'cypress', 'javascript')).toBe(
      "cy.url().should('eq', '');"
    );
  });

  it('adds exactly the imports the wait needs', () => {
    const steps = [{ action: 'goto', value: 'https://shop.example/' }, step];
    const py = C.testScript(steps, 'selenium', 'python');
    expect(py).toContain(
      'from selenium import webdriver\nfrom selenium.webdriver.common.by import By\nfrom selenium.webdriver.support.ui import WebDriverWait\nfrom selenium.webdriver.support import expected_conditions as EC\n\n\n'
    );
    const withSelect = C.testScript(
      [...steps, { action: 'selectOption', target: { kind: 'id', value: 's' }, value: 'A' }],
      'selenium',
      'python'
    );
    expect(withSelect).toContain('from selenium.webdriver.support.ui import Select, WebDriverWait\n');
    expect(C.testScript(steps, 'selenium', 'javascript')).toMatch(
      /^const \{ Builder, By, Key, until \} = require\('selenium-webdriver'\);\n\n/
    );
    expect(
      C.testScript(
        [...steps, { action: 'selectOption', target: { kind: 'id', value: 's' }, value: 'A' }],
        'selenium',
        'typescript'
      )
    ).toMatch(/^const \{ Builder, By, Key, Select, until \} = require\('selenium-webdriver'\);\n/);
    // Unchanged scaffolds when no URL assertion is present.
    expect(C.testScript([steps[0]], 'selenium', 'javascript')).toMatch(
      /^const \{ Builder, By, Key \} = require\('selenium-webdriver'\);\n\n/
    );
    expect(C.testScript([steps[0]], 'selenium', 'python')).not.toMatch(/WebDriverWait|expected_conditions/);
    expect(C.testScript(steps, 'playwright', 'typescript')).toContain(
      "  await expect(page).toHaveURL('https://shop.example/done?o=\\'1\\'');\n"
    );
  });

  it('produces scripts that parse', () => {
    const steps = [{ action: 'goto', value: 'https://shop.example/' }, step];
    const dir = mkdtempSync(join(tmpdir(), 'locatra-url-'));
    try {
      for (const [fw, lang] of validCombos()) {
        if (lang === 'python') continue;
        const file = join(dir, `${fw}-${lang}.${fw === 'selenium' ? 'cjs' : 'mjs'}`);
        let code = C.testScript(steps, fw, lang);
        if (lang === 'typescript') code = stripTypeScriptTypes(code);
        writeFileSync(file, code);
        expect(
          () => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }),
          `${fw}/${lang}`
        ).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('toHaveValue assertions', () => {
  it('compares the current value in every framework', () => {
    const s = {
      action: 'assert',
      assertType: 'toHaveValue',
      target: { kind: 'id', value: 'qty' },
      value: '3',
    };
    expect(C.actionStatement(s, 'playwright', 'typescript')).toBe(
      "await expect(page.locator('#qty')).toHaveValue('3');"
    );
    expect(C.actionStatement(s, 'playwright', 'python')).toBe(
      'expect(page.locator("#qty")).to_have_value("3")'
    );
    expect(C.actionStatement(s, 'selenium', 'javascript')).toBe(
      "assert.strictEqual(await driver.findElement(By.id('qty')).getAttribute('value'), '3');"
    );
    expect(C.actionStatement(s, 'selenium', 'python')).toBe(
      'assert driver.find_element(By.ID, "qty").get_attribute("value") == "3"'
    );
    expect(C.actionStatement(s, 'cypress', 'typescript')).toBe("cy.get('#qty').should('have.value', '3');");
  });
});

describe('suggested steps', () => {
  const steps = [
    { action: 'goto', value: 'https://shop.example/' },
    { action: 'click', target: { kind: 'id', value: 'buy' } },
    { action: 'assert', assertType: 'toHaveURL', value: 'https://shop.example/done', suggested: true },
    {
      action: 'assert',
      assertType: 'toContainText',
      target: { kind: 'id', value: 'msg' },
      value: 'Thanks',
      suggested: true,
    },
    { action: 'assert', assertType: 'toBeVisible', target: { kind: 'id', value: 'ok' }, suggested: false },
  ];
  const accepted = steps.filter((s) => !s.suggested);

  it('are left out of a rendered script until accepted', () => {
    for (const [fw, lang] of validCombos()) {
      const code = C.testScript(steps, fw, lang);
      expect(code, `${fw}/${lang}`).toBe(C.testScript(accepted, fw, lang));
      expect(code).not.toMatch(/done|Thanks/);
    }
  });

  it('are dropped by wrapScript when the parallel steps mark them', () => {
    for (const [fw, lang] of validCombos()) {
      const stmts = steps.map((s) => C.actionStatement(s, fw, lang));
      expect(C.wrapScript(stmts, fw, lang, steps), `${fw}/${lang}`).toBe(C.testScript(accepted, fw, lang));
    }
    // Without a parallel steps array the statements are taken as given.
    const stmts = steps.map((s) => C.actionStatement(s, 'selenium', 'python'));
    expect(C.wrapScript(stmts, 'selenium', 'python')).toContain('WebDriverWait');
  });

  it('still render on their own, for the timeline preview', () => {
    expect(C.actionStatement(steps[3], 'playwright', 'typescript')).toBe(
      "await expect(page.locator('#msg')).toContainText('Thanks', { useInnerText: true });"
    );
  });
});

describe('remaining edge cases', () => {
  it('uses the platform CSS.escape when there is one', () => {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'CSS');
    const prev = globalThis.CSS;
    globalThis.CSS = { escape: (s) => 'esc(' + s + ')' };
    try {
      expect(C.locatorExpr({ kind: 'id', value: 'a:b' }, 'playwright', 'typescript')).toBe(
        "page.locator('#esc(a:b)')"
      );
    } finally {
      if (had) globalThis.CSS = prev;
      else delete globalThis.CSS;
    }
  });

  it('maps img roles to non-empty alt and SVG by local name', () => {
    expect(C.locatorExpr({ kind: 'role', role: 'img' }, 'cypress', 'javascript')).toBe(
      'cy.get(\'img:not([alt=""]):not([role]), img[title]:not([title=""]):not([role]), ' +
        'img:is([tabindex], [aria-atomic], [aria-busy], [aria-controls], [aria-current], [aria-describedby], ' +
        '[aria-details], [aria-dropeffect], [aria-flowto], [aria-grabbed], [aria-hidden], [aria-keyshortcuts], ' +
        '[aria-label], [aria-labelledby], [aria-live], [aria-owns], [aria-relevant], [aria-roledescription])' +
        ':not([role]), svg:not([role]), [role~="img"]\').first()'
    );
    const xp = C.locatorExpr({ kind: 'role', role: 'img', name: 'Logo' }, 'selenium', 'javascript');
    expect(xp).toContain('(self::img and not(@role) and (not(@alt) or @alt!=""))');
    expect(xp).toContain('(local-name(.)="svg" and not(@role))');
  });

  it('chains without a parent fall back to the child; frames without one render nothing', () => {
    const child = { kind: 'role', role: 'button', name: 'Go' };
    expect(C.locatorExpr({ kind: 'chain', parent: null, child }, 'playwright', 'typescript')).toBe(
      "page.getByRole('button', { name: 'Go' })"
    );
    expect(C.locatorExpr({ kind: 'frame', selector: '#f', index: 0 }, 'cypress', 'javascript')).toBe('');
    expect(
      C.actionStatement(
        { action: 'click', target: { kind: 'frame', selector: '#f' } },
        'playwright',
        'python'
      )
    ).toBe('# TODO: "click" step has no element locator');
    expect(C.actionStatement(null, 'playwright', 'python')).toBe('');
  });

  it('handles the remaining press, upload and fill shapes', () => {
    expect(C.actionStatement({ action: 'press', value: '+' }, 'selenium', 'javascript')).toBe(
      "await driver.actions().sendKeys('+').perform();"
    );
    expect(C.actionStatement({ action: 'press', value: 'Hyper+a' }, 'selenium', 'python')).toBe(
      '# TODO: press "Hyper+a" — modifier not supported'
    );
    const target = { kind: 'id', value: 'f' };
    expect(C.actionStatement({ action: 'upload', target, value: '' }, 'cypress', 'javascript')).toBe(
      '// TODO: upload step with no files (Cypress cannot clear a file input)'
    );
    expect(C.actionStatement({ action: 'upload', target, value: [] }, 'selenium', 'javascript')).toBe(
      "await driver.findElement(By.id('f')).clear();"
    );
    expect(
      C.actionStatement({ action: 'upload', target, value: ['a.txt', 'b.txt'] }, 'selenium', 'typescript')
    ).toContain(
      "await driver.findElement(By.id('f')).sendKeys(['a.txt', 'b.txt'].map((p) => require('path').resolve(p)).join('\\n'));"
    );
    expect(
      C.actionStatement({ action: 'upload', target, value: '"one.pdf"' }, 'playwright', 'typescript')
    ).toContain(".setInputFiles(['one.pdf']);");
    expect(
      C.actionStatement(
        { action: 'fill', target, value: '2024-01-31', inputType: 'date' },
        'selenium',
        'javascript'
      )
    ).toMatch(
      /^await driver\.executeScript\('const el = arguments\[0\];.*', driver\.findElement\(By\.id\('f'\)\), '2024-01-31'\);$/
    );
    expect(
      C.actionStatement(
        { action: 'assert', assertType: 'toContainText', target, value: ' a \n b ' },
        'selenium',
        'javascript'
      )
    ).toBe(
      "assert.ok((await driver.findElement(By.id('f')).getText()).replace(/[\\u00ad\\u200b]/g, '').replace(/\\s+/g, ' ').trim().includes('a b'));"
    );
  });

  it('tolerates missing steps when placing cy.origin blocks', () => {
    const code = C.wrapScript(["cy.visit('https://a.example/');", '// x'], 'cypress', 'javascript', [
      { action: 'goto', value: 'https://a.example/' },
      null,
    ]);
    expect(code).toContain("    cy.visit('https://a.example/');\n    // x\n");
  });
});

// Cypress 16 removed Cypress.env(); cy.env() (Cypress >= 15) replaces it. Exported
// specs read secrets through one emitted helper that works on both.
describe('Cypress secrets on Cypress 15 and 16', () => {
  const fill = { action: 'fill', target: { kind: 'id', value: 'pw' }, sensitive: true, secretName: 'MY_PW' };

  function helperFrom(code) {
    const start = code.indexOf('function locatraSecret(');
    const end = code.indexOf('\n}\n', start) + 2;
    return code.slice(start, end);
  }

  it('emits the helper once, only when a sensitive fill needs it', () => {
    const steps = [{ action: 'goto', value: 'https://a.example/' }, fill, { ...fill, secretName: 'OTHER' }];
    const js = C.testScript(steps, 'cypress', 'javascript');
    expect(js.match(/function locatraSecret\(/g)).toHaveLength(1);
    expect(js).toContain(
      "    locatraSecret('MY_PW').then((secret) => {\n      cy.get('#pw').clear().type(secret, { log: false, parseSpecialCharSequences: false });\n    });"
    );
    expect(js).not.toMatch(/Cypress\.env\(['"]/);
    expect(helperFrom(js)).toBe(
      [
        'function locatraSecret(name) {',
        '  const c = cy;',
        "  if (typeof c.env === 'function') {",
        "    return c.env([name], { log: false }).then((vars) => String(vars[name] ?? ''));",
        '  }',
        "  return cy.wrap(String((Cypress).env(name) ?? ''), { log: false });",
        '}',
      ].join('\n')
    );
    expect(helperFrom(C.testScript(steps, 'cypress', 'typescript'))).toContain(
      'function locatraSecret(name: string): Cypress.Chainable<string> {'
    );
    expect(
      C.testScript([{ action: 'fill', target: fill.target, value: 'x' }], 'cypress', 'javascript')
    ).not.toContain('locatraSecret');
    // A TODO that only mentions the helper does not pull it in.
    expect(C.wrapScript(['// locatraSecret(x)'], 'cypress', 'javascript')).not.toContain(
      'function locatraSecret'
    );
  });

  it('declares the helper again inside cy.origin(), whose callback is serialised', () => {
    const steps = [
      { action: 'goto', value: 'https://a.example/' },
      { action: 'goto', value: 'https://b.example/' },
      { ...fill, url: 'https://b.example/' },
    ];
    const code = C.testScript(steps, 'cypress', 'typescript');
    expect(code.match(/function locatraSecret\(/g)).toHaveLength(2);
    expect(code).toContain("    cy.origin('https://b.example', () => {\n      // Locatra: read a secret");
  });

  it('reads cy.env() when Cypress has it and Cypress.env() otherwise, never logging', () => {
    const js = helperFrom(C.testScript([fill], 'cypress', 'javascript'));
    const calls = [];
    const chain = (v) => ({ then: (fn) => chain(fn(v)), value: v });
    const cy16 = {
      env: (keys, opts) => {
        calls.push(['cy.env', keys, opts]);
        return chain({ MY_PW: 's3cret' });
      },
      wrap: () => {
        throw new Error('not used');
      },
    };
    const run = (cy, Cypress) =>
      new Function('cy', 'Cypress', js + '\nreturn locatraSecret("MY_PW");')(cy, Cypress);
    expect(run(cy16, {}).value).toBe('s3cret');
    expect(calls).toEqual([['cy.env', ['MY_PW'], { log: false }]]);
    const cy14 = { wrap: (v, opts) => (calls.push(['cy.wrap', v, opts]), chain(v)) };
    expect(run(cy14, { env: (k) => (k === 'MY_PW' ? 'old' : undefined) }).value).toBe('old');
    expect(calls[1]).toEqual(['cy.wrap', 'old', { log: false }]);
    expect(run(cy14, { env: () => undefined }).value).toBe('');
    expect(run({ ...cy16, env: () => chain({}) }, {}).value).toBe('');
  });

  it('parses in both languages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'locatra-cysecret-'));
    try {
      for (const lang of ['typescript', 'javascript']) {
        let code = C.testScript([{ action: 'goto', value: 'https://a.example/' }, fill], 'cypress', lang);
        if (lang === 'typescript') code = stripTypeScriptTypes(code);
        const file = join(dir, `${lang}.mjs`);
        writeFileSync(file, code);
        expect(() => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── pluggable targets (registerTarget) ────────────────────────────────────────
// Each test gets its own copy of the shipping file in a fresh context, so a target
// registered here never leaks into the framework lists the other suites assert.
describe('Selenium frame-wrapped chains', () => {
  const chain = {
    kind: 'chain',
    parent: { kind: 'css', value: 'form.card' },
    child: { kind: 'id', value: 'num' },
  };
  const framed = { kind: 'frame', selector: '#pay', index: 0, child: chain };
  const nested = {
    kind: 'frame',
    selector: '#outer',
    index: 0,
    child: { kind: 'frame', index: 1, child: chain },
  };

  it('render the chain inside the frame, not the <body> fallback', () => {
    expect(C.locatorExpr(framed, 'selenium', 'javascript')).toBe(
      "driver.findElement(By.css('form.card')).findElement(By.id('num'))"
    );
    expect(C.locatorExpr(nested, 'selenium', 'python')).toBe(
      'driver.find_element(By.CSS_SELECTOR, "form.card").find_element(By.ID, "num")'
    );
    expect(
      C.locatorExpr(
        { kind: 'frame', selector: '#f', index: 0, child: { kind: 'id', value: 'x' } },
        'selenium',
        'javascript'
      )
    ).toBe("driver.findElement(By.id('x'))");
  });

  it('switch into every frame before the chained lookup in a statement', () => {
    expect(C.actionStatement({ action: 'click', target: nested }, 'selenium', 'javascript')).toBe(
      [
        "await driver.switchTo().frame(driver.findElement(By.css('#outer')));",
        'await driver.switchTo().frame(1);',
        "await driver.findElement(By.css('form.card')).findElement(By.id('num')).click();",
        'await driver.switchTo().defaultContent();',
      ].join('\n')
    );
  });
});

describe('registerTarget', () => {
  const freshCodegen = () => {
    const sandbox = {};
    vm.runInNewContext(readFileSync(new URL('../src/codegen.js', import.meta.url), 'utf8'), sandbox);
    return sandbox.LLCodegen;
  };
  const calls = [];
  const def = (over = {}) => ({
    framework: { id: 'acme', label: 'Acme' },
    languages: [{ id: 'kotlin', label: 'Kotlin', ext: '.kt' }],
    locatorExpr: (target, lang, rel) => (
      calls.push(['loc', target.kind, lang, rel]),
      `find(${target.value})`
    ),
    actionStatement: (step, lang) => (calls.push(['act', step.action, lang]), `do(${step.action})`),
    wrapScript: (stmts, lang, steps, opts) => {
      calls.push(['wrap', lang, steps && steps.length, opts]);
      return `wrapped[${stmts.join('|')}]`;
    },
    pageObject: (model, lang) => `po(${model.className}, ${lang})`,
    ...over,
  });

  it('validates the definition', () => {
    const G = freshCodegen();
    expect(() => G.registerTarget()).toThrow('framework.id and languages[] are required');
    expect(() => G.registerTarget({ framework: {}, languages: [{ id: 'x' }] })).toThrow('framework.id');
    expect(() => G.registerTarget({ framework: { id: 'x' }, languages: [] })).toThrow('languages[]');
    expect(() => G.registerTarget(def({ pageObject: null }))).toThrow(
      'registerTarget: pageObject() is required'
    );
    expect(G.FRAMEWORKS.map((f) => f.id)).toEqual(['playwright', 'selenium', 'cypress']);
  });

  it('adds a new framework and language, valid only as registered', () => {
    const G = freshCodegen();
    const d = def();
    expect(G.registerTarget(d)).toBe(d);
    expect(G.FRAMEWORKS.map((f) => f.id)).toEqual(['playwright', 'selenium', 'cypress', 'acme']);
    expect(G.LANGUAGES.map((l) => l.id)).toEqual(['typescript', 'javascript', 'python', 'kotlin']);
    expect(G.isValidCombo('acme', 'kotlin')).toBe(true);
    expect(G.isValidCombo('acme', 'typescript')).toBe(false);
    expect(G.isValidCombo('playwright', 'kotlin')).toBe(false);
    expect(G.isValidCombo('nope', 'typescript')).toBe(false);
    expect(G.languagesFor('acme').map((l) => l.id)).toEqual(['kotlin']);
    expect(G.languagesFor('playwright').map((l) => l.id)).toEqual(['typescript', 'javascript', 'python']);
    expect(G.fileExtension('kotlin')).toBe('.kt');
    expect(G.fileExtension('python')).toBe('.py');
    expect(G.fileExtension('unknown')).toBe('.ts');
    // Re-registering a framework/language does not duplicate the menu entries.
    G.registerTarget(def({ framework: { id: 'acme' }, languages: [{ id: 'kotlin' }, { id: 'scala' }] }));
    expect(G.FRAMEWORKS.filter((f) => f.id === 'acme')).toHaveLength(1);
    expect(G.LANGUAGES.map((l) => l.id)).toEqual(['typescript', 'javascript', 'python', 'kotlin', 'scala']);
    expect(G.LANGUAGES.find((l) => l.id === 'scala').label).toBe('scala');
    expect(G.FRAMEWORKS.find((f) => f.id === 'acme').label).toBe('Acme');
  });

  // A plug-in framework asked for a language it didn't register used to fall through
  // to the built-in Playwright path: Playwright code labelled as the other framework.
  it("falls back to a plug-in framework's own language for an unregistered one", () => {
    const G = freshCodegen();
    calls.length = 0;
    G.registerTarget(def());
    expect(G.pageObject({ className: 'Cart' }, 'acme', 'python')).toBe('po(Cart, kotlin)');
    expect(G.pageObjectFileName({ className: 'Cart' }, 'acme', 'python')).toBe('CartPage.kt');
    expect(G.locatorExpr({ kind: 'id', value: 'q' }, 'acme', 'typescript')).toBe('find(q)');
    expect(G.testScript([{ action: 'click', target: { kind: 'id', value: 'q' } }], 'acme', 'python')).toBe(
      'wrapped[do(click)]'
    );
    expect(calls.every((c) => !c.includes('python') && !c.includes('typescript'))).toBe(true);
    // Built-in frameworks keep their existing behaviour for languages they lack.
    expect(G.pageObjectFileName({ className: 'Cart' }, 'cypress', 'python')).toBe('CartPage.ts');
  });

  it('adds a language to a built-in framework without touching its other languages', () => {
    const G = freshCodegen();
    G.registerTarget(def({ framework: { id: 'playwright', label: 'ignored' } }));
    expect(G.FRAMEWORKS.map((f) => f.label)).toEqual(['Playwright', 'Selenium', 'Cypress']);
    expect(G.languagesFor('playwright').map((l) => l.id)).toEqual([
      'typescript',
      'javascript',
      'python',
      'kotlin',
    ]);
    expect(G.locatorExpr({ kind: 'id', value: 'a' }, 'playwright', 'kotlin')).toBe('find(a)');
    expect(G.locatorExpr({ kind: 'id', value: 'a' }, 'playwright', 'typescript')).toBe("page.locator('#a')");
  });

  it('delegates locators, statements, scripts and page objects to the target', () => {
    const G = freshCodegen();
    G.registerTarget(def());
    calls.length = 0;
    expect(G.locatorExpr({ kind: 'id', value: 'x' }, 'acme', 'kotlin', true)).toBe('find(x)');
    expect(G.locatorExpr(null, 'acme', 'kotlin')).toBe('');
    expect(G.actionStatement({ action: 'click', target: { kind: 'id', value: 'x' } }, 'acme', 'kotlin')).toBe(
      'do(click)'
    );
    expect(G.actionStatement({ action: 'goto', value: 'https://a.example/' }, 'acme', 'kotlin')).toBe(
      'do(goto)'
    );
    expect(
      G.actionStatement({ action: 'assert', assertType: 'toHaveURL', value: 'u' }, 'acme', 'kotlin')
    ).toBe('do(assert)');
    expect(G.pageObject({ className: 'Shop' }, 'acme', 'kotlin')).toBe('po(Shop, kotlin)');
    expect(G.pageObject(undefined, 'acme', 'kotlin')).toBe('po(undefined, kotlin)');
    expect(G.pageObjectFileName({ className: 'Shop' }, 'acme', 'kotlin')).toBe('ShopPage.kt');
    expect(calls).toEqual([
      ['loc', 'id', 'kotlin', true],
      ['act', 'click', 'kotlin'],
      ['act', 'goto', 'kotlin'],
      ['act', 'assert', 'kotlin'],
    ]);
  });

  it('lets a target write the core TODOs in its own comment syntax', () => {
    const G = freshCodegen();
    const seen = [];
    G.registerTarget(
      def({
        framework: { id: 'acme' },
        languages: [{ id: 'kotlin' }],
        comment: (text, lang) => (seen.push([text, lang]), `/* ${text.replace(/\*\//g, '* /')} */`),
      })
    );
    G.registerTarget(
      def({
        framework: { id: 'acme' },
        languages: [{ id: 'cobol' }],
        todo: (text, lang) => `*> TODO(${lang}): ${text}`,
        comment: () => 'never used when todo() exists',
      })
    );
    G.registerTarget(def({ framework: { id: 'acme' }, languages: [{ id: 'python' }] }));
    expect(G.actionStatement({ action: 'x*/y' }, 'acme', 'kotlin')).toBe(
      '/* TODO: unsupported step "x* /y" */'
    );
    expect(G.actionStatement({ action: 'click' }, 'acme', 'kotlin')).toBe(
      '/* TODO: "click" step has no element locator */'
    );
    expect(seen).toEqual([
      ['TODO: unsupported step "x*/y"', 'kotlin'],
      ['TODO: "click" step has no element locator', 'kotlin'],
    ]);
    expect(G.actionStatement({ action: 'nope\nline' }, 'acme', 'cobol')).toBe(
      '*> TODO(cobol): unsupported step "nope line"'
    );
    expect(G.actionStatement({ action: 'fill', target: null }, 'acme', 'cobol')).toBe(
      '*> TODO(cobol): "fill" step has no element locator'
    );
    // Without either hook the TODO keeps the core's // or # form.
    expect(G.actionStatement({ action: 'nope' }, 'acme', 'python')).toBe('# TODO: unsupported step "nope"');
    // Built-in pairs are untouched.
    expect(G.actionStatement({ action: 'nope' }, 'playwright', 'javascript')).toBe(
      '// TODO: unsupported step "nope"'
    );
  });

  it('keeps the core guards: unknown actions and missing locators are TODOs, suggestions are dropped', () => {
    const G = freshCodegen();
    G.registerTarget(def());
    calls.length = 0;
    expect(G.actionStatement({ action: 'teleport' }, 'acme', 'kotlin')).toBe(
      '// TODO: unsupported step "teleport"'
    );
    expect(G.actionStatement({ action: 'fill', value: 'v' }, 'acme', 'kotlin')).toBe(
      '// TODO: "fill" step has no element locator'
    );
    expect(calls).toEqual([]);
    const steps = [
      { action: 'click', target: { kind: 'id', value: 'a' } },
      { action: 'assert', assertType: 'toBeVisible', target: { kind: 'id', value: 'b' }, suggested: true },
      { action: 'click', target: { kind: 'id', value: 'c' } },
    ];
    expect(G.testScript(steps, 'acme', 'kotlin')).toBe('wrapped[do(click)|do(click)]');
    expect(calls.at(-1)).toEqual(['wrap', 'kotlin', 2, undefined]);
    expect(G.wrapScript(['a', 'b', 'c'], 'acme', 'kotlin', steps, { x: 1 })).toBe('wrapped[a|c]');
    expect(calls.at(-1)).toEqual(['wrap', 'kotlin', 2, { x: 1 }]);
  });
});
