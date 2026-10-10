// LLCodegen.pageObject(): Page Object classes for a picked region / page, in every
// framework/language pair. The generated classes are not only parsed — the JS ones
// are executed against recording stand-ins for page / driver / cy, so a helper that
// targets the wrong member or forgets its argument fails here.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { declaredString } from './codegen-helper-calls.mjs';

let C;
let dir;
beforeAll(async () => {
  await import('../src/codegen.js');
  C = globalThis.LLCodegen;
  dir = mkdtempSync(join(tmpdir(), 'locatra-pom-'));
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const COMBOS = [
  ['playwright', 'typescript'],
  ['playwright', 'javascript'],
  ['playwright', 'python'],
  ['selenium', 'typescript'],
  ['selenium', 'javascript'],
  ['selenium', 'python'],
  ['cypress', 'typescript'],
  ['cypress', 'javascript'],
];

const label = (value, o = {}) => ({ kind: 'label', value, ...o });
const role = (r, name, o = {}) => ({ kind: 'role', role: r, ...(name != null ? { name } : {}), ...o });
const testid = (value) => ({ kind: 'testid', attr: 'data-testid', value });

const SMALL = {
  pageUrl: 'https://shop.example/checkout',
  title: 'Checkout | Shop',
  elements: [
    { name: 'emailAddressInput', kind: 'input', target: label('Email address') },
    { name: 'placeOrderButton', kind: 'button', target: role('button', 'Place order') },
  ],
};

/** Every kind of element and every kind of target the recorder can produce. */
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
        child: { kind: 'id', value: 'cvc' },
      },
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
  ],
};

function render(model, fw, lang) {
  return C.pageObject(model, fw, lang);
}

/** Throws unless `code` parses as the given language. */
function assertParses(code, fw, lang, tag) {
  const base = join(dir, `${tag}-${fw}-${lang}`);
  if (lang === 'python') {
    let python = true;
    try {
      execFileSync('python3', ['--version'], { stdio: 'pipe' });
    } catch {
      python = false;
    }
    if (!python) return;
    writeFileSync(base + '.py', code);
    execFileSync(
      'python3',
      ['-I', '-c', 'import ast, sys; ast.parse(open(sys.argv[1]).read())', base + '.py'],
      {
        stdio: 'pipe',
      }
    );
    return;
  }
  const js = lang === 'typescript' ? stripTypeScriptTypes(code) : code;
  const file = base + (fw === 'selenium' && lang === 'javascript' ? '.cjs' : '.mjs');
  writeFileSync(file, js);
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
}

describe('pageObject: exact output', () => {
  it('renders the Playwright TypeScript class from the spec', () => {
    expect(render(SMALL, 'playwright', 'typescript')).toBe(
      [
        '// Page Object generated by Locatra for "Checkout | Shop".',
        '// Page: https://shop.example/checkout',
        "import { type Page, type Locator } from '@playwright/test';",
        '',
        'export class CheckoutPage {',
        '  readonly page: Page;',
        '  readonly emailAddressInput: Locator;',
        '  readonly placeOrderButton: Locator;',
        '',
        '  constructor(page: Page) {',
        '    this.page = page;',
        "    this.emailAddressInput = page.getByLabel('Email address');",
        "    this.placeOrderButton = page.getByRole('button', { name: 'Place order' });",
        '  }',
        '',
        '  async goto(): Promise<void> {',
        "    await this.page.goto('https://shop.example/checkout');",
        '  }',
        '',
        '  async fillEmailAddressInput(value: string): Promise<void> {',
        '    await this.emailAddressInput.fill(value);',
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

  it('renders the Playwright Python class with snake_case members', () => {
    expect(render(SMALL, 'playwright', 'python')).toBe(
      [
        '# Page Object generated by Locatra for "Checkout | Shop".',
        '# Page: https://shop.example/checkout',
        'from playwright.sync_api import Page',
        '',
        '',
        'class CheckoutPage:',
        '    def __init__(self, page: Page) -> None:',
        '        self.page = page',
        '        self.email_address_input = page.get_by_label("Email address")',
        '        self.place_order_button = page.get_by_role("button", name="Place order")',
        '',
        '    def goto(self) -> None:',
        '        self.page.goto("https://shop.example/checkout")',
        '',
        '    def fill_email_address_input(self, value: str) -> None:',
        '        self.email_address_input.fill(value)',
        '',
        '    def click_place_order_button(self) -> None:',
        '        self.place_order_button.click()',
        '',
      ].join('\n')
    );
  });

  it('renders Playwright JavaScript as an ES module without types', () => {
    const code = render(SMALL, 'playwright', 'javascript');
    expect(code).toContain('// Usage: const checkoutPage = new CheckoutPage(page);');
    expect(code).toContain('export class CheckoutPage {\n  constructor(page) {');
    expect(code).toContain(
      '  async fillEmailAddressInput(value) {\n    await this.emailAddressInput.fill(value);\n  }'
    );
    expect(code).not.toMatch(/readonly|: Locator|Promise<void>|import /);
  });

  it('renders Selenium with lazy lookups and CommonJS in JavaScript', () => {
    const js = render(SMALL, 'selenium', 'javascript');
    // The label and the role go through the Locatra helper, declared once above the class.
    expect(js).toContain("const { By, WebElementPromise } = require('selenium-webdriver');");
    expect(js).toContain(
      "  emailAddressInput() {\n    return locatraFind(this.driver, 'label', 'Email address');"
    );
    expect(js.match(/^function locatraFind\(/gm)).toHaveLength(1);
    expect(js.indexOf('function locatraFind(')).toBeLessThan(js.indexOf('class CheckoutPage'));
    expect(js).toContain(
      '  async fillEmailAddressInput(value) {\n    const el = await this.emailAddressInput();\n    await el.clear();\n    await el.sendKeys(value);\n  }'
    );
    expect(js).toContain(
      '  async clickPlaceOrderButton() {\n    await (await this.placeOrderButton()).click();\n  }'
    );
    expect(js.endsWith('\nmodule.exports = { CheckoutPage };\n')).toBe(true);

    const py = render(SMALL, 'selenium', 'python');
    expect(py).toContain(
      'import time\n\nfrom selenium.webdriver.common.by import By\nfrom selenium.webdriver.remote.webdriver import WebDriver\n' +
        'from selenium.webdriver.remote.webelement import WebElement\n' +
        'from selenium.common.exceptions import NoSuchElementException, WebDriverException\n\n\n# Locatra helper (generated): '
    );
    expect(py).toContain('\n\n\nclass CheckoutPage:');
    expect(py).toContain(
      '    @property\n    def email_address_input(self) -> WebElement:\n        return locatra_find(self.driver, "label", "Email address")'
    );
    expect(py).toContain(
      '    def goto(self) -> None:\n        self.driver.get("https://shop.example/checkout")'
    );
    expect(py).not.toMatch(/import Select|\bSelect\(/);

    const ts = render(SMALL, 'selenium', 'typescript');
    expect(ts).toContain("import { By, WebElementPromise, type WebDriver } from 'selenium-webdriver';");
    expect(ts).toContain('  readonly driver: WebDriver;\n\n  constructor(driver: WebDriver) {');
    expect(ts).toContain('  emailAddressInput(): WebElementPromise {');
    expect(ts).not.toContain('lib/select');
  });

  it('renders Cypress with chain-returning members and the name helper', () => {
    const code = render(SMALL, 'cypress', 'javascript');
    expect(code).toMatch(
      /^\/\/ Page Object generated by Locatra[^\n]*\n\/\/ Page: [^\n]*\n\/\/ Locatra helper \(generated\)[\s\S]*\nfunction locatraGet\(/
    );
    expect(code).toContain("  visit() {\n    cy.visit('https://shop.example/checkout');\n  }");
    expect(code).toContain(
      "  placeOrderButton() {\n    return locatraGet('role', 'button', 'Place order');\n  }"
    );
    expect(code).toContain(
      "  fillEmailAddressInput(value) {\n    if (value === '') this.emailAddressInput().clear();\n    else this.emailAddressInput().clear().type(value, { parseSpecialCharSequences: false });\n  }"
    );
    expect(render(SMALL, 'cypress', 'typescript')).toContain(
      '  fillEmailAddressInput(value: string): void {'
    );
  });

  it('leaves the name helper out when no locator needs it', () => {
    const model = { elements: [{ name: 'go', kind: 'button', target: testid('go') }] };
    const code = render(model, 'cypress', 'typescript');
    expect(code).not.toContain('locatra');
    expect(code).toContain(
      '  goButton() {\n    return cy.get(\'[data-testid="go"]\');\n  }'.replace('goButton', 'go')
    );
  });

  it('is deterministic', () => {
    for (const [fw, lang] of COMBOS) expect(render(RICH, fw, lang)).toBe(render(RICH, fw, lang));
  });
});

describe('pageObject: every combination parses', () => {
  it.each(COMBOS)('%s / %s', (fw, lang) => {
    expect(() => assertParses(render(RICH, fw, lang), fw, lang, 'rich')).not.toThrow();
    expect(() => assertParses(render(SMALL, fw, lang), fw, lang, 'small')).not.toThrow();
    expect(() => assertParses(render({}, fw, lang), fw, lang, 'empty')).not.toThrow();
  });

  it('keeps hostile titles, URLs and names inside comments and literals', () => {
    const model = {
      title: "x\n*/ alert('t')  ",
      pageUrl: 'https://e.example/a\'b"c\\d\ne',
      elements: [{ name: 'a\'b"c\n', kind: 'input', target: label('it\'s "x"\n') }],
    };
    for (const [fw, lang] of COMBOS) {
      const code = render(model, fw, lang);
      expect(() => assertParses(code, fw, lang, 'hostile'), `${fw}/${lang}`).not.toThrow();
      // The title is flattened to one comment line.
      expect(code.split('\n')[0]).toMatch(
        /^(\/\/|#) Page Object generated by Locatra for "x \*\/ alert\('t'\) {2}"\.$/
      );
    }
  });
});

describe('pageObject: identifiers', () => {
  const names = (model, fw, lang) => {
    const code = render(model, fw, lang);
    if (lang === 'python') return [...code.matchAll(/self\.(\w+) = page\./g)].map((m) => m[1]);
    return [...code.matchAll(/this\.(\w+) = page\./g)].map((m) => m[1]);
  };
  const el = (name, kind = 'button') => ({ name, kind, target: testid(name || 'x') });

  it('dedupes collisions with numeric suffixes', () => {
    const model = { elements: [el('emailInput'), el('emailInput'), el('email input'), el('EMAIL_INPUT')] };
    expect(names(model, 'playwright', 'typescript')).toEqual([
      'emailInput',
      'emailInput2',
      'emailInput3',
      'emailInput4',
    ]);
    expect(names(model, 'playwright', 'python')).toEqual([
      'email_input',
      'email_input_2',
      'email_input_3',
      'email_input_4',
    ]);
  });

  it('never emits a reserved word or a member every page object has', () => {
    const model = {
      elements: ['delete', 'class', 'page', 'constructor', 'goto', 'toString', 'import'].map((n) => el(n)),
    };
    expect(names(model, 'playwright', 'typescript')).toEqual([
      'deleteElement',
      'classElement',
      'pageElement',
      'constructorElement',
      'gotoElement',
      'toStringElement',
      'importElement',
    ]);
    const py = { elements: ['del', 'class', 'self', 'page', 'None', 'lambda', 'delete'].map((n) => el(n)) };
    expect(names(py, 'playwright', 'python')).toEqual([
      'del_element',
      'class_element',
      'self_element',
      'page_element',
      'none',
      'lambda_element',
      'delete',
    ]);
  });

  it('turns any text into a valid identifier', () => {
    const model = { elements: [el('2fa code'), el('Café crème'), el('日本語'), el(''), el('  -- ')] };
    expect(names(model, 'playwright', 'javascript')).toEqual([
      'el2faCode',
      'cafeCreme',
      'element',
      'element2',
      'element3',
    ]);
    expect(names(model, 'playwright', 'python')).toEqual([
      'el_2fa_code',
      'cafe_creme',
      'element',
      'element_2',
      'element_3',
    ]);
  });

  it('dedupes helper methods against members', () => {
    const model = {
      elements: [
        { name: 'clickGo', kind: 'other', target: testid('a') },
        { name: 'go', kind: 'button', target: testid('b') },
      ],
    };
    const code = render(model, 'playwright', 'typescript');
    expect(code).toContain('async clickClickGo(): Promise<void>');
    expect(code).toContain('async clickGo2(): Promise<void> {\n    await this.go.click();');
  });

  it('names the class from className, URL path, title, or Home', () => {
    const cls = (m) => C.pageObjectClassName(m);
    expect(cls({ className: 'checkout' })).toBe('CheckoutPage');
    expect(cls({ className: 'LoginPage' })).toBe('LoginPage');
    expect(cls({ className: 'URL shortener' })).toBe('URLShortenerPage');
    expect(cls({ className: '9lives' })).toBe('Page9livesPage');
    expect(cls({ title: 'Sign in – My Bank' })).toBe('SignInPage');
    expect(cls({ title: 'Orders | Admin' })).toBe('OrdersPage');
    expect(cls({ title: 'one two three four five' })).toBe('OneTwoThreeFourPage');
    expect(cls({ title: '', pageUrl: 'https://x.example/account/settings.html?tab=1#a' })).toBe(
      'SettingsPage'
    );
    expect(cls({ pageUrl: 'https://x.example/orders/12345' })).toBe('OrdersPage');
    // The path names the page; a "Site — Page" title's first part names the site.
    expect(cls({ title: 'Northwind Books — Checkout', pageUrl: 'http://localhost:4174/checkout' })).toBe(
      'CheckoutPage'
    );
    // A generic segment says nothing, so the title is used.
    expect(cls({ title: 'Orders | Admin', pageUrl: 'https://x.example/app/index.html' })).toBe('OrdersPage');
    expect(cls({ title: 'Cart', pageUrl: 'https://x.example/home' })).toBe('CartPage');
    expect(cls({ pageUrl: 'https://x.example/' })).toBe('HomePage');
    expect(cls({})).toBe('HomePage');
    expect(C.pageObjectClassName()).toBe('HomePage');
    expect(C.pageObjectFileName({ title: 'Cart' }, 'selenium', 'python')).toBe('CartPage.py');
    expect(C.pageObjectFileName({ title: 'Cart' }, 'cypress', 'javascript')).toBe('CartPage.js');
    expect(C.pageObjectFileName({ title: 'Cart' }, 'cypress', 'python')).toBe('CartPage.ts');
    expect(C.pageObjectFileName(null, 'playwright', 'typescript')).toBe('HomePage.ts');
  });
});

describe('pageObject: helpers per kind', () => {
  const helpers = (model, fw = 'playwright', lang = 'typescript') =>
    [...render(model, fw, lang).matchAll(/^ {2}(?:async )?(\w+)\((value[^)]*)?\)(?:: Promise<void>)? \{$/gm)]
      .map((m) => m[1])
      .filter((n) => n !== 'goto' && n !== 'constructor');

  it('fills inputs and textareas, selects, checks, clicks', () => {
    expect(helpers(RICH)).toEqual([
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
    ]);
  });

  it('treats an unknown kind as other', () => {
    const model = { elements: [{ name: 'x', kind: 'weird', target: testid('x') }] };
    expect(helpers(model)).toEqual(['clickX']);
  });

  it('sets range/colour/date values through the value setter in Selenium and Cypress', () => {
    const sel = render(RICH, 'selenium', 'javascript');
    // The script is declared once, above the class (LOCATRA_SET_VALUE_JS).
    expect(sel).toContain(
      '  async fillQtyInput(value) {\n    await this.driver.executeScript(LOCATRA_SET_VALUE_JS, await this.qtyInput(), value);'
    );
    expect(declaredString(sel, 'LOCATRA_SET_VALUE_JS', 'javascript')).toBe(C._internals.SET_VALUE_JS);
    const py = render(RICH, 'selenium', 'python');
    expect(py).toContain(
      '    def fill_qty_input(self, value: str) -> None:\n        self.driver.execute_script(LOCATRA_SET_VALUE_JS, self.qty_input, value)'
    );
    expect(py).toContain('\nLOCATRA_SET_VALUE_JS = (\n');
    expect(declaredString(py, 'LOCATRA_SET_VALUE_JS', 'python')).toBe(C._internals.SET_VALUE_JS);
    expect(render(RICH, 'cypress', 'javascript')).toContain(
      "  fillQtyInput(value) {\n    this.qtyInput().invoke('val', value).trigger('input').trigger('change');\n  }"
    );
  });

  it('only toggles a checkbox whose state differs', () => {
    expect(render(RICH, 'selenium', 'python')).toContain(
      '    def uncheck_terms_checkbox(self) -> None:\n        el = self.terms_checkbox\n        if (el.is_selected() or el.get_attribute("aria-checked") == "true"):\n            el.click()'
    );
    expect(render(RICH, 'selenium', 'typescript')).toContain(
      "  async checkTermsCheckbox(): Promise<void> {\n    const el = await this.termsCheckbox();\n    if (!((await el.isSelected()) || (await el.getAttribute('aria-checked')) === 'true')) await el.click();\n  }"
    );
    expect(render(RICH, 'cypress', 'typescript')).toContain(
      '  checkTermsCheckbox(): void {\n    this.termsCheckbox().then(($el) => {\n      if ($el.is(\'input[type="checkbox"], input[type="radio"]\')) cy.wrap($el).check();'
    );
  });

  it('imports Select only when a select helper exists', () => {
    expect(render(RICH, 'selenium', 'typescript')).toContain(
      "import { Select } from 'selenium-webdriver/lib/select.js';"
    );
    expect(render(RICH, 'selenium', 'javascript')).toContain(
      "const { By, Select, WebElementPromise } = require('selenium-webdriver');"
    );
    expect(render(RICH, 'selenium', 'python')).toContain('from selenium.webdriver.support.ui import Select');
  });
});

describe('pageObject: locators reuse locatorExpr', () => {
  // A chain inside a frame used to reach selLocator() directly, which has no chain
  // case, so the member looked up <body> instead of the element.
  const FRAMED_CHAIN = {
    pageUrl: 'https://shop.example/checkout',
    elements: [
      {
        name: 'Card',
        kind: 'input',
        target: {
          kind: 'frame',
          selector: '#pay',
          index: 0,
          child: {
            kind: 'chain',
            parent: { kind: 'css', value: 'form.card' },
            child: { kind: 'id', value: 'num' },
          },
        },
      },
    ],
  };

  it('looks a frame-wrapped chain up inside the frame, parent first (Selenium)', () => {
    const js = render(FRAMED_CHAIN, 'selenium', 'javascript');
    expect(js).toContain(
      "  async card() {\n    await this.driver.switchTo().defaultContent();\n    await this.driver.switchTo().frame(this.driver.findElement(By.css('#pay')));\n    return this.driver.findElement(By.css('form.card')).findElement(By.id('num'));\n  }"
    );
    const ts = render(FRAMED_CHAIN, 'selenium', 'typescript');
    expect(ts).toContain(
      "  async card(): Promise<WebElement> {\n    await this.driver.switchTo().defaultContent();\n    await this.driver.switchTo().frame(this.driver.findElement(By.css('#pay')));\n    return this.driver.findElement(By.css('form.card')).findElement(By.id('num'));\n  }"
    );
    const py = render(FRAMED_CHAIN, 'selenium', 'python');
    expect(py).toContain(
      '    @property\n    def card(self) -> WebElement:\n        self.driver.switch_to.default_content()\n        self.driver.switch_to.frame(self.driver.find_element(By.CSS_SELECTOR, "#pay"))\n        return self.driver.find_element(By.CSS_SELECTOR, "form.card").find_element(By.ID, "num")'
    );
    for (const code of [js, ts, py]) expect(code).not.toMatch(/body/);
  });

  it('runs the frame-wrapped chain lookup against a stand-in driver (Selenium JS)', async () => {
    const code = render(FRAMED_CHAIN, 'selenium', 'javascript');
    const log = [];
    const element = (desc) => ({
      findElement: (sel) => (log.push(`${desc}.findElement(${sel})`), element(`${desc}>${sel}`)),
      clear: async () => log.push(`${desc}.clear()`),
      sendKeys: async (v) => log.push(`${desc}.sendKeys(${v})`),
    });
    const driver = {
      get: async () => {},
      findElement: (sel) => (log.push(`findElement(${sel})`), element(sel)),
      switchTo: () => ({
        defaultContent: async () => log.push('defaultContent()'),
        frame: async (f) => log.push(`frame(${typeof f === 'object' ? 'element' : f})`),
      }),
    };
    const By = { id: (v) => `#${v}`, css: (v) => v };
    const module = { exports: {} };
    new Function('require', 'module', code)(() => ({ By }), module);
    await new module.exports.CheckoutPage(driver).fillCard('4242');
    expect(log).toEqual([
      'defaultContent()',
      'findElement(#pay)',
      'frame(element)',
      'findElement(form.card)',
      'form.card.findElement(#num)',
      'form.card>#num.clear()',
      'form.card>#num.sendKeys(4242)',
    ]);
  });

  it('keeps exact, nth, chains, frames and shadow paths', () => {
    for (const [fw, lang] of COMBOS) {
      const code = render(RICH, fw, lang);
      for (const e of RICH.elements) {
        let expr = C.locatorExpr(e.target, fw, lang);
        if (fw === 'selenium')
          expr = expr.replace(
            /(^|\()driver(?=[.,])/g,
            (m, p) => `${p}${lang === 'python' ? 'self' : 'this'}.driver`
          );
        // A long Cypress chain spans lines, indented with the member.
        const flat = (x) => x.replace(/\n\s+/g, '\n');
        expect(flat(code), `${fw}/${lang} ${e.name}`).toContain(flat(expr));
      }
    }
  });

  it('switches Selenium into each element’s frames from the top document', () => {
    const js = render(RICH, 'selenium', 'javascript');
    expect(js).toContain(
      "  async cardNumberInput() {\n    await this.driver.switchTo().defaultContent();\n    await this.driver.switchTo().frame(this.driver.findElement(By.css('#pay')));\n    return locatraFind(this.driver, 'label', 'Card number');"
    );
    expect(js).toContain("    const shadowHost1 = await this.driver.findElement(By.css('#shell'));");
    expect(js).toContain('    await this.driver.switchTo().frame(shadowFrame);');
    expect(js).toContain(
      '    await this.driver.switchTo().frame(await this.driver.executeScript(LOCATRA_FRAME_JS, 2));'
    );
    // Top-document members leave any frame first, too.
    expect(js).toContain(
      '  async placeOrderButton() {\n    await this.driver.switchTo().defaultContent();\n    return this.driver.findElement(By.css(\'[data-testid="place-order"]\'));\n  }'
    );
    expect(js).toContain(
      "  async goto() {\n    await this.driver.switchTo().defaultContent();\n    await this.driver.get('https://shop.example/checkout?step=2');"
    );
    const py = render(RICH, 'selenium', 'python');
    expect(py).toContain(
      '    @property\n    def cvc_input(self) -> WebElement:\n        self.driver.switch_to.default_content()\n' +
        '        self.driver.switch_to.frame(self.driver.find_element(By.CSS_SELECTOR, "#shell").shadow_root.find_element(By.CSS_SELECTOR, "iframe"))\n' +
        '        return self.driver.find_element(By.ID, "cvc")'
    );
    const ts = render(RICH, 'selenium', 'typescript');
    expect(ts).toContain(
      "import { By, WebElementPromise, type WebDriver, type WebElement } from 'selenium-webdriver';"
    );
    expect(declaredString(ts, 'LOCATRA_FRAME_JS', 'typescript')).toBe(C._internals.DEEP_IFRAME_JS);
    expect(ts).toContain('  async cardNumberInput(): Promise<WebElement> {');
  });

  it('never rewrites "driver." inside a selector', () => {
    const model = {
      elements: [
        { name: 'x', kind: 'button', target: { kind: 'css', value: '[data-x="driver.y"] .driver.z' } },
      ],
    };
    expect(render(model, 'selenium', 'javascript')).toContain(
      'return this.driver.findElement(By.css(\'[data-x="driver.y"] .driver.z\'));'
    );
    expect(render(model, 'selenium', 'python')).toContain(
      'return self.driver.find_element(By.CSS_SELECTOR, "[data-x=\\"driver.y\\"] .driver.z")'
    );
  });

  it('annotates locators that were not unique and skips elements without one', () => {
    const model = {
      elements: [
        ...RICH.elements.slice(-2),
        { name: 'nameless', kind: 'button', target: role('button') },
        { name: 'flagged', kind: 'button', target: testid('f'), unique: false },
        { name: 'noTarget', kind: 'button' },
        { name: 'emptyFrame', kind: 'button', target: { kind: 'frame', selector: '#f', index: 0 } },
        null,
      ],
    };
    const code = render(model, 'playwright', 'typescript');
    expect(code).toContain(
      '    // NOTE: this locator matched 3 elements when the page object was generated.\n    this.anyRow = '
    );
    expect(code).toContain(
      '    // NOTE: this locator matched no element when the page object was generated.\n    this.missing = '
    );
    expect(code).toContain(
      '    // NOTE: this role locator has no accessible name and may match several elements.\n    this.nameless = '
    );
    expect(code).toContain(
      '    // NOTE: this locator was not unique when the page object was generated.\n    this.flagged = '
    );
    expect(code).toContain('// NOTE: 3 element(s) without a usable locator were left out.\n');
    expect(code).not.toMatch(/noTarget|emptyFrame/);
    expect(render(RICH, 'cypress', 'javascript')).toContain(
      '  // NOTE: this iframe is cross-origin, so contentDocument is null and Cypress cannot reach into it.\n  thirdPartyButton() {'
    );
  });

  it('falls back to TypeScript for an invalid combination and omits goto without a URL', () => {
    const code = C.pageObject({ elements: SMALL.elements }, 'cypress', 'python');
    expect(code).toContain('fillEmailAddressInput(value: string): void');
    expect(code).not.toMatch(/visit\(\)|goto\(\)/);
    expect(C.pageObject(null, 'playwright', 'python')).toContain('class HomePage:\n    def __init__');
  });
});

// ── Executing the generated JavaScript ───────────────────────────────────────
// Recording stand-ins: every call on a locator / element / chain is logged with the
// member it came from, so the assertions read like what a real run would do.

async function importModule(code, name) {
  const file = join(dir, name + '.mjs');
  writeFileSync(file, code);
  return import(pathToFileURL(file).href + '?v=' + Math.random());
}

function fakePage(log) {
  const locator = (desc) =>
    new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === 'then') return undefined;
          return (...args) => {
            if (['fill', 'click', 'check', 'uncheck', 'selectOption'].includes(prop)) {
              log.push(`${desc}.${prop}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
              return Promise.resolve();
            }
            return locator(`${desc}.${String(prop)}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
          };
        },
      }
    );
  return new Proxy(
    { goto: async (u) => log.push(`goto(${JSON.stringify(u)})`) },
    {
      get: (t, prop) =>
        t[prop] ??
        ((...args) => locator(`${String(prop)}(${args.map((a) => JSON.stringify(a)).join(', ')})`)),
    }
  );
}

describe('pageObject: generated classes run', () => {
  it('Playwright TS and JS classes drive the right locators', async () => {
    for (const lang of ['typescript', 'javascript']) {
      let code = render(SMALL, 'playwright', lang);
      if (lang === 'typescript')
        code = stripTypeScriptTypes(code).replace(/^import \{\s*\} from '@playwright\/test';$/m, '');
      const { CheckoutPage } = await importModule(code, 'pw-' + lang);
      const log = [];
      const po = new CheckoutPage(fakePage(log));
      await po.goto();
      await po.fillEmailAddressInput('a@b.co');
      await po.clickPlaceOrderButton();
      expect(log, lang).toEqual([
        'goto("https://shop.example/checkout")',
        'getByLabel("Email address").fill("a@b.co")',
        'getByRole("button", {"name":"Place order"}).click()',
      ]);
    }
  });

  it('Selenium JS looks elements up on every access and toggles only when needed', async () => {
    const model = {
      pageUrl: 'https://e.example/',
      elements: [
        { name: 'email', kind: 'input', target: { kind: 'id', value: 'email' } },
        { name: 'terms', kind: 'checkbox', target: { kind: 'id', value: 'terms' } },
        { name: 'country', kind: 'select', target: { kind: 'name', value: 'country' } },
        { name: 'go', kind: 'link', target: { kind: 'id', value: 'go' } },
      ],
    };
    const code = render(model, 'selenium', 'javascript');
    const log = [];
    const state = { terms: false };
    const element = (sel) => ({
      clear: async () => log.push(`${sel}.clear()`),
      sendKeys: async (v) => log.push(`${sel}.sendKeys(${v})`),
      click: async () => {
        log.push(`${sel}.click()`);
        if (sel === 'terms') state.terms = !state.terms;
      },
      isSelected: async () => (sel === 'terms' ? state.terms : false),
      getAttribute: async () => null,
    });
    const By = { id: (v) => v, name: (v) => v, css: (v) => v, xpath: (v) => v };
    class Select {
      constructor(el) {
        this.el = el;
      }
      async selectByVisibleText(v) {
        log.push(`select(${v})`);
      }
    }
    const lookups = [];
    const driver = {
      get: async (u) => log.push(`get(${u})`),
      findElement: (sel) => {
        lookups.push(sel);
        return Promise.resolve(element(sel));
      },
    };
    const module = { exports: {} };
    new Function('require', 'module', code)(() => ({ By, Select }), module);
    const po = new module.exports.HomePage(driver);
    await po.goto();
    await po.fillEmail('x');
    await po.checkTerms();
    await po.checkTerms();
    await po.uncheckTerms();
    await po.selectCountry('Canada');
    await po.clickGo();
    expect(log).toEqual([
      'get(https://e.example/)',
      'email.clear()',
      'email.sendKeys(x)',
      'terms.click()',
      'terms.click()',
      'select(Canada)',
      'go.click()',
    ]);
    expect(lookups).toEqual(['email', 'terms', 'terms', 'terms', 'country', 'go']);
  });

  it('Cypress JS helpers chain off the member commands', async () => {
    const log = [];
    const chain = (desc) =>
      new Proxy(
        {},
        {
          get:
            (_, prop) =>
            (...args) => {
              const call = `${desc}.${String(prop)}(${args.map((a) => (typeof a === 'function' ? 'fn' : JSON.stringify(a))).join(', ')})`;
              if (['click', 'type', 'select', 'trigger'].includes(prop)) log.push(call);
              if (prop === 'clear' && !log.length) log.push(call);
              return chain(call);
            },
        }
      );
    const cy = {
      get: (sel) => chain(`get(${JSON.stringify(sel)})`),
      visit: (u) => log.push(`visit(${u})`),
    };
    const model = {
      pageUrl: 'https://e.example/',
      elements: [
        { name: 'email', kind: 'input', target: { kind: 'id', value: 'email' } },
        { name: 'go', kind: 'button', target: { kind: 'id', value: 'go' } },
        { name: 'country', kind: 'select', target: { kind: 'id', value: 'c' } },
      ],
    };
    const code = render(model, 'cypress', 'javascript').replace('export class', 'class');
    const Page = new Function('cy', code + '\nreturn HomePage;')(cy);
    const po = new Page();
    po.visit();
    po.fillEmail('a{b}');
    po.clickGo();
    po.selectCountry('Canada');
    expect(log).toEqual([
      'visit(https://e.example/)',
      'get("#email").clear().type("a{b}", {"parseSpecialCharSequences":false})',
      'get("#go").click()',
      'get("#c").select("Canada")',
    ]);
  });
});
