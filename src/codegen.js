// LocatorLens – codegen.js
// Pure, framework/language-agnostic code generator.
// Turns a structured locator `target` (produced by content-locator-engine.js) plus
// an action into runnable test code for Playwright / Selenium / Cypress in
// JavaScript / TypeScript / Python.
//
// A `target` is one of:
//   { kind: 'testid', attr, value }
//   { kind: 'role', role, name?, level? }
//   { kind: 'label'|'placeholder'|'altText'|'title'|'text'|'id'|'name'|'css', value }
//   { kind: 'chain', parent, child }   — child scoped inside parent (both targets)
//
// An `action` step is: { action, target?, value?, key?, url?, width?, height? }
//   action ∈ click | dblclick | check | uncheck | fill | selectOption | press | goto | viewport

(function (global) {
  'use strict';

  // ── escaping ──────────────────────────────────────────────────────────────
  // Wrap a value as a string literal for the given language, escaping the wrapper
  // quote. JS/TS use single quotes; Python uses double quotes. CSS attribute
  // selectors below always use double quotes internally, which q() then escapes
  // correctly for whichever language is active.
  function q(value, lang) {
    var s = String(value == null ? '' : value)
      .replace(/\\/g, '\\\\')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t');
    if (lang === 'python') {
      return '"' + s.replace(/"/g, '\\"') + '"';
    }
    return "'" + s.replace(/'/g, "\\'") + "'";
  }

  // Escape a value for use inside a double-quoted CSS attribute selector, e.g.
  // [name="..."]. Without this, a value containing a double quote (placeholders and
  // aria-labels routinely do: 'Search "all" items') closed the selector early and
  // emitted code that throws at runtime. q() then escapes the result again for
  // whichever host language wraps it.
  function attrSel(value) {
    return String(value == null ? '' : value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
  }

  // Escape a value for use as a CSS identifier (the "foo" in #foo). Uses the platform
  // CSS.escape where available and falls back to escaping the ASCII specials, so the
  // module stays usable outside a browser (tests, Node).
  function cssIdent(value) {
    var s = String(value == null ? '' : value);
    if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') {
      return CSS.escape(s);
    }
    return s.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1')
      .replace(/^(\d)/, '\\3$1 ');
  }

  // Escape a value for an XPath string literal. XPath 1.0 has no escape syntax, so a
  // literal containing both quote kinds must be assembled with concat().
  function xpathLiteral(value) {
    var s = String(value == null ? '' : value);
    if (s.indexOf('"') === -1) return '"' + s + '"';
    if (s.indexOf("'") === -1) return "'" + s + "'";
    return 'concat(' + s.split('"').map(function (part) {
      return '"' + part + '"';
    }).join(", '\"', ") + ')';
  }

  // ── framework / language metadata ──────────────────────────────────────────
  var FRAMEWORKS = [
    { id: 'playwright', label: 'Playwright' },
    { id: 'selenium', label: 'Selenium' },
    { id: 'cypress', label: 'Cypress' }
  ];
  var LANGUAGES = [
    { id: 'typescript', label: 'TypeScript' },
    { id: 'javascript', label: 'JavaScript' },
    { id: 'python', label: 'Python' }
  ];

  // Cypress has no Python bindings.
  function isValidCombo(fw, lang) {
    if (fw === 'cypress' && lang === 'python') return false;
    return true;
  }
  function languagesFor(fw) {
    return LANGUAGES.filter(function (l) { return isValidCombo(fw, l.id); });
  }

  // ── implicit ARIA role → selector helpers (for Selenium/Cypress) ────────────
  var ROLE_CSS = {
    button: 'button, [role="button"]',
    link: 'a[href], [role="link"]',
    checkbox: 'input[type="checkbox"], [role="checkbox"]',
    radio: 'input[type="radio"], [role="radio"]',
    textbox: 'input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea, [role="textbox"]',
    heading: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
    img: 'img, [role="img"]',
    list: 'ul, ol, [role="list"]',
    listitem: 'li, [role="listitem"]',
    combobox: 'select, [role="combobox"]',
    table: 'table, [role="table"]'
  };
  var ROLE_XPATH = {
    button: 'self::button or @role="button"',
    link: 'self::a or @role="link"',
    checkbox: '(self::input and @type="checkbox") or @role="checkbox"',
    radio: '(self::input and @type="radio") or @role="radio"',
    textbox: 'self::textarea or (self::input and (not(@type) or @type="text")) or @role="textbox"',
    heading: 'self::h1 or self::h2 or self::h3 or self::h4 or self::h5 or self::h6 or @role="heading"',
    img: 'self::img or @role="img"',
    combobox: 'self::select or @role="combobox"'
  };

  function roleCss(role) { return ROLE_CSS[role] || ('[role="' + role + '"]'); }

  // ── key name mapping (recorder captures DOM e.key like "Enter") ─────────────
  var KEY_CYPRESS = { Enter: '{enter}', Tab: '{tab}', Escape: '{esc}', Backspace: '{backspace}', Delete: '{del}', ArrowUp: '{uparrow}', ArrowDown: '{downarrow}', ArrowLeft: '{leftarrow}', ArrowRight: '{rightarrow}' };
  var KEY_SELENIUM = { Enter: 'ENTER', Tab: 'TAB', Escape: 'ESCAPE', Backspace: 'BACK_SPACE', Delete: 'DELETE', ArrowUp: 'ARROW_UP', ArrowDown: 'ARROW_DOWN', ArrowLeft: 'ARROW_LEFT', ArrowRight: 'ARROW_RIGHT', ' ': 'SPACE' };

  // ════════════════════════════════════════════════════════════════════════════
  //  Locator expressions
  // ════════════════════════════════════════════════════════════════════════════

  function pwLocator(t, lang) {
    var py = lang === 'python';
    var m = function (camel, snake) { return py ? snake : camel; };
    switch (t.kind) {
      case 'testid':
        if (t.attr === 'data-testid') return 'page.' + m('getByTestId', 'get_by_test_id') + '(' + q(t.value, lang) + ')';
        return 'page.locator(' + q('[' + t.attr + '="' + attrSel(t.value) + '"]', lang) + ')';
      case 'role': {
        var opts = [];
        if (t.name) opts.push(py ? 'name=' + q(t.name, lang) : 'name: ' + q(t.name, lang));
        if (t.level) opts.push(py ? 'level=' + t.level : 'level: ' + t.level);
        var optStr = '';
        if (opts.length) optStr = py ? ', ' + opts.join(', ') : ', { ' + opts.join(', ') + ' }';
        return 'page.' + m('getByRole', 'get_by_role') + '(' + q(t.role, lang) + optStr + ')';
      }
      case 'label': return 'page.' + m('getByLabel', 'get_by_label') + '(' + q(t.value, lang) + ')';
      case 'placeholder': return 'page.' + m('getByPlaceholder', 'get_by_placeholder') + '(' + q(t.value, lang) + ')';
      case 'altText': return 'page.' + m('getByAltText', 'get_by_alt_text') + '(' + q(t.value, lang) + ')';
      case 'title': return 'page.' + m('getByTitle', 'get_by_title') + '(' + q(t.value, lang) + ')';
      case 'text': return 'page.' + m('getByText', 'get_by_text') + '(' + q(t.value, lang) + ')';
      case 'id': return 'page.locator(' + q('#' + cssIdent(t.value), lang) + ')';
      case 'name': return 'page.locator(' + q('[name="' + attrSel(t.value) + '"]', lang) + ')';
      case 'css': default: return 'page.locator(' + q(t.value || 'body', lang) + ')';
    }
  }

  function cyLocator(t, lang) {
    switch (t.kind) {
      case 'testid': return 'cy.get(' + q('[' + t.attr + '="' + attrSel(t.value) + '"]', lang) + ')';
      case 'role': {
        var sel = roleCss(t.role);
        if (t.name) return 'cy.get(' + q(sel, lang) + ').contains(' + q(t.name, lang) + ')';
        return 'cy.get(' + q(sel, lang) + ')';
      }
      case 'label': return 'cy.get(' + q('[aria-label="' + attrSel(t.value) + '"]', lang) + ')';
      case 'placeholder': return 'cy.get(' + q('[placeholder="' + attrSel(t.value) + '"]', lang) + ')';
      case 'altText': return 'cy.get(' + q('img[alt="' + attrSel(t.value) + '"]', lang) + ')';
      case 'title': return 'cy.get(' + q('[title="' + attrSel(t.value) + '"]', lang) + ')';
      case 'text': return 'cy.contains(' + q(t.value, lang) + ')';
      case 'id': return 'cy.get(' + q('#' + cssIdent(t.value), lang) + ')';
      case 'name': return 'cy.get(' + q('[name="' + attrSel(t.value) + '"]', lang) + ')';
      case 'css': default: return 'cy.get(' + q(t.value || 'body', lang) + ')';
    }
  }

  // Selenium: returns the `driver.find_element(...)` expression.
  function selFind(by, selector, lang) {
    // by ∈ css | id | name | xpath
    if (lang === 'python') {
      var BY = { css: 'By.CSS_SELECTOR', id: 'By.ID', name: 'By.NAME', xpath: 'By.XPATH' }[by];
      return 'driver.find_element(' + BY + ', ' + q(selector, lang) + ')';
    }
    var fn = { css: 'By.css', id: 'By.id', name: 'By.name', xpath: 'By.xpath' }[by];
    return 'driver.findElement(' + fn + '(' + q(selector, lang) + '))';
  }

  // `rel` renders the expression for use inside a parent element's search scope.
  // An absolute "//*[…]" handed to element.find_element still searches the whole
  // document — the leading dot is what actually scopes it to the parent.
  function roleXpath(role, name, rel) {
    var node = ROLE_XPATH[role] || ('@role="' + attrSel(role) + '"');
    var axis = rel ? './/*' : '//*';
    if (name) {
      // xpathLiteral() keeps quotes in the name intact — the previous version deleted
      // every double quote from the accessible name, so a button labelled Delete "row"
      // produced an xpath that silently matched the wrong element (or nothing).
      return axis + '[(' + node + ') and contains(normalize-space(.), ' + xpathLiteral(name) + ')]';
    }
    return axis + '[' + node + ']';
  }

  function selLocator(t, lang, rel) {
    switch (t.kind) {
      case 'testid': return selFind('css', '[' + t.attr + '="' + attrSel(t.value) + '"]', lang);
      case 'role':
        if (t.name) return selFind('xpath', roleXpath(t.role, t.name, rel), lang);
        return selFind('css', roleCss(t.role), lang);
      case 'label': return selFind('css', '[aria-label="' + attrSel(t.value) + '"]', lang);
      case 'placeholder': return selFind('css', '[placeholder="' + attrSel(t.value) + '"]', lang);
      case 'altText': return selFind('css', 'img[alt="' + attrSel(t.value) + '"]', lang);
      case 'title': return selFind('css', '[title="' + attrSel(t.value) + '"]', lang);
      case 'text': return selFind('xpath', (rel ? './/*' : '//*') + '[contains(normalize-space(.), ' + xpathLiteral(t.value) + ')]', lang);
      case 'id': return selFind('id', t.value, lang);
      case 'name': return selFind('name', t.value, lang);
      case 'css': default: return selFind('css', t.value || 'body', lang);
    }
  }

  // ── chained locators ────────────────────────────────────────────────────────
  // A chain narrows an ambiguous child to one unique parent — the only reliable way
  // to address "the Delete button in *this* table row". Every framework expresses it
  // by continuing the parent's expression, so the child is rendered normally and its
  // root receiver (`page.` / `cy.get(` / `driver.`) is re-pointed at the parent.
  var CHAIN_ROOT = {
    playwright: [[/^page\./, '.']],
    cypress: [[/^cy\.get\(/, '.find('], [/^cy\.contains\(/, '.contains(']],
    selenium: [[/^driver\./, '.']]
  };

  function chainExpr(t, fw, lang) {
    var parent = locatorExpr(t.parent, fw, lang);
    if (!t.child) return parent;
    var child = locatorExpr(t.child, fw, lang, true);
    if (!parent) return child;
    var rules = CHAIN_ROOT[fw] || CHAIN_ROOT.playwright;
    for (var i = 0; i < rules.length; i++) {
      if (rules[i][0].test(child)) return parent + child.replace(rules[i][0], rules[i][1]);
    }
    // Unrecognised child shape: the parent scope cannot be applied without silently
    // changing what the code selects, so return the child on its own rather than
    // emitting a syntactically broken chain.
    return child;
  }

  function locatorExpr(target, fw, lang, rel) {
    if (!target) return '';
    if (target.kind === 'chain') return chainExpr(target, fw, lang);
    if (fw === 'selenium') return selLocator(target, lang, rel);
    if (fw === 'cypress') return cyLocator(target, lang);
    return pwLocator(target, lang);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  Action statements (one line, no wrapper indentation)
  // ════════════════════════════════════════════════════════════════════════════

  function pwStatement(step, lang) {
    var py = lang === 'python';
    var aw = py ? '' : 'await ';
    var semi = py ? '' : ';';
    var a = step.action;
    if (a === 'goto') return aw + 'page.goto(' + q(step.value || step.url || '', lang) + ')' + semi;
    if (a === 'press') return aw + 'page.keyboard.press(' + q(step.value || step.key || 'Enter', lang) + ')' + semi;
    if (a === 'viewport') {
      var w = vpW(step), h = vpH(step);
      if (py) return 'page.set_viewport_size({"width": ' + w + ', "height": ' + h + '})';
      return 'await page.setViewportSize({ width: ' + w + ', height: ' + h + ' });';
    }
    if (a === 'assert') return pwAssert(step, lang);
    var loc = locatorExpr(step.target, 'playwright', lang);
    switch (a) {
      case 'click': return aw + loc + '.click()' + semi;
      case 'hover': return aw + loc + '.hover()' + semi;
      case 'dblclick': return aw + loc + '.dblclick()' + semi;
      case 'check': return aw + loc + '.check()' + semi;
      case 'uncheck': return aw + loc + '.uncheck()' + semi;
      case 'fill': return aw + loc + (py ? '.fill(' : '.fill(') + q(step.value, lang) + ')' + semi;
      case 'selectOption':
        if (py) return loc + '.select_option(' + q(step.value, lang) + ')';
        return 'await ' + loc + '.selectOption(' + q(step.value, lang) + ');';
      default: return aw + loc + '.click()' + semi;
    }
  }

  function cyKey(key) { return KEY_CYPRESS[key] || ('{' + String(key || '').toLowerCase() + '}'); }

  function cyStatement(step, lang) {
    var a = step.action;
    if (a === 'goto') return 'cy.visit(' + q(step.value || step.url || '', lang) + ');';
    if (a === 'press') return "cy.get('body').type(" + q(cyKey(step.value || step.key), lang) + ');';
    if (a === 'viewport') return 'cy.viewport(' + vpW(step) + ', ' + vpH(step) + ');';
    if (a === 'assert') return cyAssert(step, lang);
    var loc = locatorExpr(step.target, 'cypress', lang);
    switch (a) {
      case 'click': return loc + '.click();';
      case 'hover': return loc + ".trigger('mouseover');";
      case 'dblclick': return loc + '.dblclick();';
      case 'check': return loc + '.check();';
      case 'uncheck': return loc + '.uncheck();';
      case 'fill': return step.value ? loc + '.clear().type(' + q(step.value, lang) + ');' : loc + '.clear();';
      case 'selectOption': return loc + '.select(' + q(step.value, lang) + ');';
      default: return loc + '.click();';
    }
  }

  function selStatement(step, lang) {
    var py = lang === 'python';
    var aw = py ? '' : 'await ';
    var semi = py ? '' : ';';
    var a = step.action;
    if (a === 'goto') return aw + 'driver.get(' + q(step.value || step.url || '', lang) + ')' + semi;
    if (a === 'press') {
      var k = KEY_SELENIUM[step.value || step.key] || 'ENTER';
      if (py) return 'webdriver.ActionChains(driver).send_keys(Keys.' + k + ').perform()';
      return 'await driver.actions().sendKeys(Key.' + k + ').perform();';
    }
    if (a === 'viewport') {
      if (py) return 'driver.set_window_size(' + vpW(step) + ', ' + vpH(step) + ')';
      return 'await driver.manage().window().setRect({ width: ' + vpW(step) + ', height: ' + vpH(step) + ' });';
    }
    if (a === 'assert') return selAssert(step, lang);
    var loc = locatorExpr(step.target, 'selenium', lang);
    if (a === 'hover') {
      if (py) return 'webdriver.ActionChains(driver).move_to_element(' + loc + ').perform()';
      return 'await driver.actions().move({ origin: ' + loc + ' }).perform();';
    }
    switch (a) {
      case 'click': return aw + loc + '.click()' + semi;
      case 'check': return aw + loc + '.click()' + semi;
      case 'uncheck': return aw + loc + '.click()' + semi;
      case 'dblclick':
        if (py) return 'webdriver.ActionChains(driver).double_click(' + loc + ').perform()';
        return 'await driver.actions().doubleClick(' + loc + ').perform();';
      case 'fill':
        // clear first so a pre-filled field is replaced, not appended to
        if (py) return loc + '.clear()\n' + loc + '.send_keys(' + q(step.value, lang) + ')';
        return 'await ' + loc + '.clear();\nawait ' + loc + '.sendKeys(' + q(step.value, lang) + ');';
      case 'selectOption':
        if (py) return 'Select(' + loc + ').select_by_visible_text(' + q(step.value, lang) + ')';
        return 'await new Select(' + loc + ').selectByVisibleText(' + q(step.value, lang) + ');';
      default: return aw + loc + '.click()' + semi;
    }
  }

  function vpW(step) { return Number(step.width != null ? step.width : (parseViewport(step.value).w)) || 1280; }
  function vpH(step) { return Number(step.height != null ? step.height : (parseViewport(step.value).h)) || 720; }
  function parseViewport(v) {
    var parts = String(v || '').split('x');
    return { w: parts[0] || '', h: parts[1] || parts[0] || '' };
  }

  // ── assertions ──────────────────────────────────────────────────────────────
  // step.assertType ∈ toBeVisible | toHaveText | toHaveValue | toBeEnabled | toBeChecked
  // step.value carries the expected text/value, or 'false' for an unchecked assertion.
  function pwAssert(step, lang) {
    var py = lang === 'python';
    var loc = locatorExpr(step.target, 'playwright', lang);
    var t = step.assertType || 'toBeVisible';
    var v = step.value;
    var unchecked = t === 'toBeChecked' && String(v) === 'false';
    if (py) {
      var pmap = {
        toBeVisible: 'to_be_visible()',
        toHaveText: 'to_have_text(' + q(v, lang) + ')',
        toHaveValue: 'to_have_value(' + q(v, lang) + ')',
        toBeEnabled: 'to_be_enabled()',
        toBeChecked: unchecked ? 'not_to_be_checked()' : 'to_be_checked()'
      };
      return 'expect(' + loc + ').' + (pmap[t] || 'to_be_visible()');
    }
    var jmap = {
      toBeVisible: 'toBeVisible()',
      toHaveText: 'toHaveText(' + q(v, lang) + ')',
      toHaveValue: 'toHaveValue(' + q(v, lang) + ')',
      toBeEnabled: 'toBeEnabled()',
      toBeChecked: unchecked ? 'not.toBeChecked()' : 'toBeChecked()'
    };
    return 'await expect(' + loc + ').' + (jmap[t] || 'toBeVisible()') + ';';
  }

  function cyAssert(step, lang) {
    var loc = locatorExpr(step.target, 'cypress', lang);
    var t = step.assertType || 'toBeVisible';
    var v = step.value;
    var map = {
      toBeVisible: ".should('be.visible')",
      toHaveText: ".should('have.text', " + q(v, lang) + ')',
      toHaveValue: ".should('have.value', " + q(v, lang) + ')',
      toBeEnabled: ".should('be.enabled')",
      toBeChecked: String(v) === 'false' ? ".should('not.be.checked')" : ".should('be.checked')"
    };
    return loc + (map[t] || map.toBeVisible) + ';';
  }

  function selAssert(step, lang) {
    var py = lang === 'python';
    var loc = locatorExpr(step.target, 'selenium', lang);
    var t = step.assertType || 'toBeVisible';
    var v = step.value;
    if (py) {
      switch (t) {
        case 'toHaveText': return 'assert ' + loc + '.text == ' + q(v, lang);
        case 'toHaveValue': return 'assert ' + loc + '.get_attribute("value") == ' + q(v, lang);
        case 'toBeEnabled': return 'assert ' + loc + '.is_enabled()';
        case 'toBeChecked': return 'assert ' + (String(v) === 'false' ? 'not ' : '') + loc + '.is_selected()';
        case 'toBeVisible': default: return 'assert ' + loc + '.is_displayed()';
      }
    }
    switch (t) {
      case 'toHaveText': return 'assert.strictEqual(await ' + loc + '.getText(), ' + q(v, lang) + ');';
      case 'toHaveValue': return 'assert.strictEqual(await ' + loc + ".getAttribute('value'), " + q(v, lang) + ');';
      case 'toBeEnabled': return 'assert.ok(await ' + loc + '.isEnabled());';
      case 'toBeChecked': return 'assert.ok(' + (String(v) === 'false' ? '!' : '') + '(await ' + loc + '.isSelected()));';
      case 'toBeVisible': default: return 'assert.ok(await ' + loc + '.isDisplayed());';
    }
  }

  function actionStatement(step, fw, lang) {
    if (!step) return '';
    if (fw === 'selenium') return selStatement(step, lang);
    if (fw === 'cypress') return cyStatement(step, lang);
    return pwStatement(step, lang);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  Full test files
  // ════════════════════════════════════════════════════════════════════════════

  function indent(lines, pad) {
    // indent EVERY physical line of each statement (statements may be multi-line,
    // e.g. Selenium's clear()+send_keys fill)
    return lines.map(function (l) {
      if (!l) return l;
      return l.split('\n').map(function (sub) { return sub ? pad + sub : sub; }).join('\n');
    }).join('\n');
  }

  // Wrap already-rendered statement lines in the right test scaffold. Kept separate
  // from testScript() so callers that produce statements themselves (e.g. to preserve
  // Playwright JS/TS native fidelity) still get correct imports + indentation.
  function wrapScript(stmts, fw, lang) {
    stmts = stmts || [];
    var joined = stmts.join('\n');

    if (fw === 'playwright') {
      if (lang === 'python') {
        return 'from playwright.sync_api import Page, expect\n\n\n' +
          'def test_recorded(page: Page):\n' +
          (stmts.length ? indent(stmts, '    ') : '    pass') + '\n';
      }
      return "import { test, expect } from '@playwright/test';\n\n" +
        "test('recorded test', async ({ page }) => {\n" +
        indent(stmts, '  ') + '\n});\n';
    }

    if (fw === 'cypress') {
      return "describe('recorded test', () => {\n" +
        "  it('replays the recorded flow', () => {\n" +
        indent(stmts, '    ') + '\n  });\n});\n';
    }

    // selenium — derive imports from what the statements actually use.
    if (lang === 'python') {
      var pyImports = ['from selenium import webdriver', 'from selenium.webdriver.common.by import By'];
      if (/Keys\./.test(joined)) pyImports.push('from selenium.webdriver.common.keys import Keys');
      if (/\bSelect\(/.test(joined)) pyImports.push('from selenium.webdriver.support.ui import Select');
      return pyImports.join('\n') + '\n\n\n' +
        'driver = webdriver.Chrome()\n' +
        'driver.implicitly_wait(10)  # Selenium has no auto-wait; give elements time to appear\n' +
        'try:\n' +
        (stmts.length ? indent(stmts, '    ') : '    pass') + '\n' +
        'finally:\n' +
        '    driver.quit()\n';
    }
    var jsHead = (/new Select\(/.test(joined))
      ? "const { Builder, By, Key, Select } = require('selenium-webdriver');\n"
      : "const { Builder, By, Key } = require('selenium-webdriver');\n";
    if (/\bassert\./.test(joined)) jsHead += "const assert = require('assert');\n";
    return jsHead + '\n' +
      '(async () => {\n' +
      '  const driver = await new Builder().forBrowser(\'chrome\').build();\n' +
      '  await driver.manage().setTimeouts({ implicit: 10000 }); // Selenium has no auto-wait\n' +
      '  try {\n' +
      indent(stmts, '    ') + '\n' +
      '  } finally {\n' +
      '    await driver.quit();\n' +
      '  }\n' +
      '})();\n';
  }

  function testScript(actions, fw, lang) {
    return wrapScript((actions || []).map(function (a) { return actionStatement(a, fw, lang); }), fw, lang);
  }

  var LLCodegen = {
    FRAMEWORKS: FRAMEWORKS,
    LANGUAGES: LANGUAGES,
    isValidCombo: isValidCombo,
    languagesFor: languagesFor,
    locatorExpr: locatorExpr,
    actionStatement: actionStatement,
    wrapScript: wrapScript,
    testScript: testScript
  };

  global.LLCodegen = LLCodegen;
  if (typeof module !== 'undefined' && module.exports) module.exports = LLCodegen;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
