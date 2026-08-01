// codegen.js is a UMD-style IIFE that publishes onto the global object. Importing
// it for side effects is enough to get the real shipping module — no shim, no copy.
import { beforeAll, describe, expect, it } from 'vitest';

let C;
beforeAll(async () => {
  await import('../src/codegen.js');
  C = globalThis.LLCodegen;
});

const FRAMEWORKS = ['playwright', 'selenium', 'cypress'];
const LANGUAGES = ['typescript', 'javascript', 'python'];

/** Every framework/language pair the UI will actually let a user select. */
function validCombos() {
  const out = [];
  for (const fw of FRAMEWORKS) for (const lang of LANGUAGES) if (C.isValidCombo(fw, lang)) out.push([fw, lang]);
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
    expect(C.locatorExpr(target, 'playwright', 'python')).toBe("page.get_by_role(\"button\", name=\"Submit\")");
    expect(C.locatorExpr(target, 'playwright', 'typescript')).toBe("page.getByRole('button', { name: 'Submit' })");
  });

  it('passes a heading level through to getByRole', () => {
    const heading = { kind: 'role', role: 'heading', name: 'Title', level: 2 };
    expect(C.locatorExpr(heading, 'playwright', 'typescript')).toContain('level: 2');
    expect(C.locatorExpr(heading, 'playwright', 'python')).toContain('level=2');
  });

  it('maps getByTestId only for data-testid, and a CSS attribute otherwise', () => {
    expect(C.locatorExpr({ kind: 'testid', attr: 'data-testid', value: 'x' }, 'playwright', 'typescript')).toBe(
      "page.getByTestId('x')"
    );
    expect(C.locatorExpr({ kind: 'testid', attr: 'data-qa', value: 'x' }, 'playwright', 'typescript')).toBe(
      'page.locator(\'[data-qa="x"]\')'
    );
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
      'driver.findElement(By.name(\'field"name\'))'
    );
  });

  it('escapes a backslash inside a CSS attribute selector', () => {
    const expr = C.locatorExpr({ kind: 'name', value: 'a\\b' }, 'playwright', 'typescript');
    expect(expr).toContain('\\\\');
  });

  it('keeps quotes in an accessible name instead of deleting them (Selenium xpath)', () => {
    const expr = C.locatorExpr({ kind: 'role', role: 'button', name: 'Delete "row"' }, 'selenium', 'javascript');
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
    const actions = ['click', 'dblclick', 'check', 'uncheck', 'fill', 'selectOption', 'hover', 'press', 'goto', 'viewport'];
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
    expect(C.actionStatement({ action: 'press', value: 'Enter' }, 'cypress', 'javascript')).toContain('{enter}');
    expect(C.actionStatement({ action: 'press', value: 'Enter' }, 'selenium', 'python')).toContain('Keys.ENTER');
    expect(C.actionStatement({ action: 'press', value: 'Enter' }, 'playwright', 'typescript')).toContain("press('Enter')");
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
    const stmt = C.actionStatement({ action: 'assert', assertType: 'nope', target }, 'playwright', 'typescript');
    expect(stmt).toContain('toBeVisible()');
  });
});

describe('script scaffolding', () => {
  it('emits the right harness for each framework', () => {
    expect(C.wrapScript(["await page.goto('/');"], 'playwright', 'typescript')).toContain(
      "import { test, expect } from '@playwright/test'"
    );
    expect(C.wrapScript(['page.goto("/")'], 'playwright', 'python')).toContain('from playwright.sync_api import');
    expect(C.wrapScript(["cy.visit('/');"], 'cypress', 'javascript')).toContain('describe(');
    expect(C.wrapScript(["await driver.get('/');"], 'selenium', 'javascript')).toContain('selenium-webdriver');
    expect(C.wrapScript(['driver.get("/")'], 'selenium', 'python')).toContain('from selenium import webdriver');
  });

  it('adds Selenium imports only for the APIs the body actually uses', () => {
    const withSelect = C.wrapScript(['await new Select(x).selectByVisibleText("a");'], 'selenium', 'javascript');
    expect(withSelect).toContain('Select');

    const without = C.wrapScript(['await driver.get("/");'], 'selenium', 'javascript');
    expect(without).not.toMatch(/\bSelect\b/);
  });

  it('pulls in the assert module only when an assertion is present', () => {
    expect(C.wrapScript(['assert.ok(true);'], 'selenium', 'javascript')).toContain("require('assert')");
    expect(C.wrapScript(['await driver.get("/");'], 'selenium', 'javascript')).not.toContain("require('assert')");
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
