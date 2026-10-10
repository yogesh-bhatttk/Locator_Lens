// C9.2 — the target a framework renders. Recorded steps, picked elements and page-object
// elements may carry `altTargets` (up to three complete targets for the same element,
// best first). Playwright always renders the primary target; every other framework
// prefers the first alternative it can use natively when the primary would need the
// Locatra helper (a role / label / text target, or a chain holding one): the user saw
// 4.5 KB of XPath for getByRole('textbox', { name }) while By.id('username') existed.
// Also: the new target kind 'xpath', and LLCodegen.locatorSnippet().
import { beforeAll, describe, expect, it } from 'vitest';

let C;
beforeAll(async () => {
  await import('../src/codegen.js');
  await import('../src/codegen-java.js');
  await import('../src/codegen-csharp.js');
  await import('../src/codegen-wdio.js');
  C = globalThis.LLCodegen;
});

const role = (r, name, o = {}) => ({ kind: 'role', role: r, ...(name != null ? { name } : {}), ...o });
const id = (value) => ({ kind: 'id', value });
const css = (value) => ({ kind: 'css', value });
const xpath = (value) => ({ kind: 'xpath', value });
const frame = (selector, child) => ({ kind: 'frame', selector, index: 0, child });

const USERNAME = role('textbox', 'Username or Email');
const ALTS = [id('username'), css('#login input[name="u"]'), xpath('//input[@id="username"]')];

const COMBOS = [
  ['playwright', 'typescript'],
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

describe('preferredTarget', () => {
  it('keeps the primary for Playwright, always', () => {
    expect(C.preferredTarget(USERNAME, ALTS, 'playwright')).toBe(USERNAME);
  });

  it('takes the first usable alternative elsewhere when the primary needs the helper', () => {
    for (const fw of ['selenium', 'cypress', 'webdriverio']) {
      expect(C.preferredTarget(USERNAME, ALTS, fw), fw).toBe(ALTS[0]);
      expect(C.preferredTarget({ kind: 'label', value: 'Email' }, ALTS, fw), fw).toBe(ALTS[0]);
      expect(C.preferredTarget({ kind: 'text', value: 'Hi', exact: true }, ALTS, fw), fw).toBe(ALTS[0]);
    }
  });

  it('never gives Cypress an XPath alternative', () => {
    const alts = [xpath('//input[@id="u"]'), id('u')];
    expect(C.preferredTarget(USERNAME, alts, 'cypress')).toBe(alts[1]);
    expect(C.preferredTarget(USERNAME, alts, 'selenium')).toBe(alts[0]);
    expect(C.preferredTarget(USERNAME, [xpath('//a')], 'cypress')).toBe(USERNAME);
  });

  it('applies to a chain holding a helper kind, and to framed targets', () => {
    const chained = { kind: 'chain', parent: css('#row'), child: role('button', 'Delete') };
    expect(C.preferredTarget(chained, [id('del-7')], 'selenium')).toEqual(id('del-7'));
    const framed = frame('#pay', role('textbox', 'Card'));
    const framedAlt = frame('#pay', id('card'));
    expect(C.preferredTarget(framed, [framedAlt], 'webdriverio')).toBe(framedAlt);
    // A frame wrapper with a helper target inside is not itself usable.
    expect(C.preferredTarget(framed, [framed], 'webdriverio')).toBe(framed);
  });

  it('keeps a primary that is native already, and ignores unusable alternatives', () => {
    const primary = { kind: 'testid', attr: 'data-testid', value: 'login' };
    expect(C.preferredTarget(primary, ALTS, 'selenium')).toBe(primary);
    expect(C.preferredTarget(css('#x'), ALTS, 'cypress').value).toBe('#x');
    const junk = [
      null,
      'id=username',
      {},
      { kind: 'id', value: '' },
      { kind: 'id', value: 3 },
      { kind: 'testid', value: 'x' },
      { kind: 'testid', attr: '', value: 'x' },
      role('textbox', 'Other'),
      { kind: 'chain', parent: id('a'), child: id('b') },
      { kind: 'placeholder', value: 'Email' },
    ];
    expect(C.preferredTarget(USERNAME, junk, 'selenium')).toBe(USERNAME);
    expect(C.preferredTarget(USERNAME, [...junk, id('u')], 'selenium')).toBe(USERNAME); // beyond the first three
    expect(C.preferredTarget(USERNAME, [junk[0], junk[1], id('u')], 'selenium')).toEqual(id('u'));
    expect(C.preferredTarget(USERNAME, undefined, 'selenium')).toBe(USERNAME);
    expect(C.preferredTarget(USERNAME, 'nope', 'selenium')).toBe(USERNAME);
    expect(C.preferredTarget(null, ALTS, 'selenium')).toBe(null);
  });
});

describe('every rendering path uses it', () => {
  const step = { action: 'fill', target: USERNAME, altTargets: ALTS, value: 'ada' };

  it('actionStatement: the alternative outside Playwright, the primary in Playwright', () => {
    expect(C.actionStatement(step, 'selenium', 'typescript')).toBe(
      "{\n  const el = driver.findElement(By.id('username'));\n  await el.clear();\n  await el.sendKeys('ada');\n}"
    );
    expect(C.actionStatement(step, 'selenium', 'java')).toContain(
      'WebElement el = driver.findElement(By.id("username"));'
    );
    expect(C.actionStatement(step, 'selenium', 'csharp')).toContain(
      'var el = driver.FindElement(By.Id("username"));'
    );
    expect(C.actionStatement(step, 'selenium', 'python')).toContain(
      'el = driver.find_element(By.ID, "username")'
    );
    expect(C.actionStatement(step, 'cypress', 'javascript')).toBe(
      "cy.get('#username').clear().type('ada', { parseSpecialCharSequences: false });"
    );
    expect(C.actionStatement(step, 'webdriverio', 'typescript')).toBe(
      "await $('#username').setValue('ada');"
    );
    expect(C.actionStatement(step, 'playwright', 'typescript')).toBe(
      "await page.getByRole('textbox', { name: 'Username or Email' }).fill('ada');"
    );
    expect(C.actionStatement(step, 'playwright', 'java')).toContain('page.getByRole(AriaRole.TEXTBOX');
  });

  it('testScript: no helper declared when every step has a usable alternative', () => {
    for (const [fw, lang] of COMBOS) {
      const code = C.testScript([{ action: 'goto', value: 'https://e.example/' }, step], fw, lang);
      if (fw === 'playwright') expect(code, `${fw}/${lang}`).toMatch(/getByRole|get_by_role|GetByRole/);
      else expect(code, `${fw}/${lang}`).not.toMatch(/locatra|Locatra\./);
    }
  });

  it('test data: variables are named from the primary target, values flow to the alternative', () => {
    const steps = [step];
    const vars = C.extractVariables(steps);
    expect(vars.map((v) => v.name)).toEqual(['usernameOrEmail']);
    const js = C.testScript(steps, 'selenium', 'javascript', { variables: true });
    expect(js).toContain("const testData = {\n  usernameOrEmail: 'ada',\n};");
    expect(js).toContain("const el = driver.findElement(By.id('username'));");
    expect(js).toContain('await el.sendKeys(testData.usernameOrEmail);');
    expect(C.testScript(steps, 'webdriverio', 'typescript', { variables: true })).toContain(
      "await $('#username').setValue(testData.usernameOrEmail);"
    );
  });

  it('pageObject: elements render their alternative outside Playwright', () => {
    const model = {
      className: 'Login',
      elements: [
        { name: 'username', kind: 'input', target: USERNAME, altTargets: ALTS },
        { name: 'submit', kind: 'button', target: role('button', 'Sign in') },
      ],
    };
    const sel = C.pageObject(model, 'selenium', 'javascript');
    expect(sel).toContain("  username() {\n    return this.driver.findElement(By.id('username'));");
    expect(sel).toContain("  submit() {\n    return locatraFind(this.driver, 'role', 'button', 'Sign in');");
    expect(C.pageObject(model, 'selenium', 'java')).toContain(
      'return driver.findElement(By.id("username"));'
    );
    expect(C.pageObject(model, 'selenium', 'csharp')).toContain(
      'public IWebElement Username => Driver.FindElement(By.Id("username"));'
    );
    expect(C.pageObject(model, 'selenium', 'python')).toContain(
      'return self.driver.find_element(By.ID, "username")'
    );
    expect(C.pageObject(model, 'cypress', 'typescript')).toContain(
      "  username() {\n    return cy.get('#username');"
    );
    expect(C.pageObject(model, 'webdriverio', 'typescript')).toContain(
      "  get username() {\n    return $('#username');"
    );
    expect(C.pageObject(model, 'playwright', 'typescript')).toContain(
      "this.username = page.getByRole('textbox', { name: 'Username or Email' });"
    );
    // The model passed in is never modified.
    expect(model.elements[0].target).toBe(USERNAME);
  });

  it('a page-object model without elements, or with odd ones, still renders', () => {
    expect(C.pageObject({ elements: 'x' }, 'selenium', 'javascript')).toContain('class HomePage');
    expect(
      C.pageObject(
        { elements: [null, { name: 'a', kind: 'button', altTargets: ALTS }] },
        'cypress',
        'javascript'
      )
    ).toContain('2 element(s) without a usable locator');
  });
});

describe("the target kind 'xpath'", () => {
  const x = xpath('//button[normalize-space(.)="Save"]');

  it('renders in every framework and language', () => {
    const got = Object.fromEntries(COMBOS.map(([fw, lang]) => [`${fw}/${lang}`, C.locatorExpr(x, fw, lang)]));
    expect(got).toEqual({
      'playwright/typescript': `page.locator('xpath=//button[normalize-space(.)="Save"]')`,
      'playwright/python': 'page.locator("xpath=//button[normalize-space(.)=\\"Save\\"]")',
      'playwright/java': 'page.locator("xpath=//button[normalize-space(.)=\\"Save\\"]")',
      'playwright/csharp': 'Page.Locator("xpath=//button[normalize-space(.)=\\"Save\\"]")',
      'selenium/typescript': `driver.findElement(By.xpath('//button[normalize-space(.)="Save"]'))`,
      'selenium/javascript': `driver.findElement(By.xpath('//button[normalize-space(.)="Save"]'))`,
      'selenium/python': 'driver.find_element(By.XPATH, "//button[normalize-space(.)=\\"Save\\"]")',
      'selenium/java': 'driver.findElement(By.xpath("//button[normalize-space(.)=\\"Save\\"]"))',
      'selenium/csharp': 'driver.FindElement(By.XPath("//button[normalize-space(.)=\\"Save\\"]"))',
      'cypress/typescript': `locatraGet('xpath', '//button[normalize-space(.)="Save"]')`,
      'cypress/javascript': `locatraGet('xpath', '//button[normalize-space(.)="Save"]')`,
      'webdriverio/typescript': `$('//button[normalize-space(.)="Save"]')`,
      'webdriverio/javascript': `$('//button[normalize-space(.)="Save"]')`,
    });
  });

  it('is relative inside a chain', () => {
    const chained = { kind: 'chain', parent: id('row'), child: xpath('//td[2]') };
    expect(C.locatorExpr(chained, 'playwright', 'typescript')).toBe(
      "page.locator('#row').locator('xpath=//td[2]')"
    );
    expect(C.locatorExpr(chained, 'selenium', 'javascript')).toBe(
      "driver.findElement(By.id('row')).findElement(By.xpath('.//td[2]'))"
    );
    expect(C.locatorExpr(chained, 'cypress', 'javascript')).toBe(
      "cy.get('#row').then(($el) => locatraGet('xpath', '//td[2]', null, { within: $el }))"
    );
    // Only an absolute path gets the dot.
    expect(C.locatorExpr({ ...chained, child: xpath('(//td)[2]') }, 'selenium', 'python')).toBe(
      'driver.find_element(By.ID, "row").find_element(By.XPATH, "(//td)[2]")'
    );
  });

  it('Cypress: forced on it, a NOTE says it is document.evaluate, outside shadow DOM', () => {
    const out = C.actionStatement({ action: 'click', target: x }, 'cypress', 'typescript');
    expect(out.split('\n')).toEqual([
      '// NOTE: Cypress has no XPath; locatraGet() runs it with document.evaluate (no shadow roots).',
      `locatraGet('xpath', '//button[normalize-space(.)="Save"]').click();`,
    ]);
    const po = C.pageObject(
      { elements: [{ name: 'save', kind: 'button', target: x }] },
      'cypress',
      'javascript'
    );
    expect(po).toContain('  // NOTE: Cypress has no XPath;');
    expect(C.actionStatement({ action: 'click', target: x }, 'selenium', 'javascript')).not.toContain('NOTE');
  });
});

describe('locatorSnippet', () => {
  it('returns the expression and exactly the declarations it needs', () => {
    for (const [fw, lang] of COMBOS) {
      const snip = C.locatorSnippet(USERNAME, fw, lang);
      expect(snip.expr, `${fw}/${lang}`).toBe(C.locatorExpr(USERNAME, fw, lang));
      if (fw === 'playwright') expect(snip.helpers, `${fw}/${lang}`).toBe('');
      else expect(snip.helpers, `${fw}/${lang}`).toMatch(/locatraFind|locatra_find|class Locatra|locatraGet/);
    }
    expect(C.locatorSnippet(USERNAME, 'selenium', 'javascript').helpers).toBe(
      C._internals.selHelperSource('javascript')
    );
    expect(C.locatorSnippet(USERNAME, 'cypress', 'typescript').helpers).toBe(
      C._internals.cyGetSource('typescript')
    );
  });

  it('prefers an alternative, and then needs no helper', () => {
    expect(C.locatorSnippet(USERNAME, 'selenium', 'python', ALTS)).toEqual({
      expr: 'driver.find_element(By.ID, "username")',
      helpers: '',
    });
    expect(C.locatorSnippet(USERNAME, 'playwright', 'typescript', ALTS)).toEqual({
      expr: "page.getByRole('textbox', { name: 'Username or Email' })",
      helpers: '',
    });
  });

  it('declares the frame script for a framed lookup only where the expression uses it', () => {
    // A frame is entered by a statement in Selenium: the expression is the inner lookup.
    const xo = { kind: 'frame', selector: null, index: 2, child: id('x') };
    expect(C.locatorSnippet(xo, 'selenium', 'java')).toEqual({
      expr: 'driver.findElement(By.id("x"))',
      helpers: '',
    });
    expect(C.locatorSnippet(xo, 'cypress', 'javascript').helpers).toContain(
      'function locatraFrame(doc, index) {'
    );
  });

  it('is empty for nothing to locate', () => {
    expect(C.locatorSnippet(null, 'selenium', 'javascript')).toEqual({ expr: '', helpers: '' });
    expect(C.locatorSnippet({ kind: 'frame', selector: '#f' }, 'webdriverio', 'typescript')).toEqual({
      expr: '',
      helpers: '',
    });
  });

  it('separates Python declarations by two blank lines, others by one', () => {
    const both = { kind: 'chain', parent: role('row', 'A'), child: { kind: 'text', value: 'B' } };
    expect(C.locatorSnippet(both, 'selenium', 'python').helpers.split('\n\n\ndef locatra_find').length).toBe(
      2
    );
  });
});
