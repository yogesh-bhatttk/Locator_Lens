// Locatra – codegen-wdio.js
// WebdriverIO v9 target for codegen.js: TypeScript and JavaScript specs for the
// WDIO testrunner (Mocha `describe`/`it`, the `browser` / `$` / `$$` / `expect`
// globals from @wdio/globals, matchers from expect-webdriverio).
//
// WebdriverIO has no getByRole/getByLabel/getByText: a role, label or text target
// calls the Locatra helper locatraFind() (declared once per file, see below), and a
// text assertion compares with the LOCATRA_TEXT options (declared likewise);
// every other locator uses the selector Selenium JS uses (codegen.js _internals),
// handed to `$()` instead of `driver.findElement(By…)`. Two differences:
//   * id and name become CSS (#id / [name="…"]): WDIO has no By.id / By.name.
//   * `$()` guesses a strategy from the selector text (XPath when it starts with
//     "/", "(" or "./", link text for "=…", an image path for "….png", …). A CSS
//     selector that one of those rules would claim is sent as "css selector:<css>",
//     WDIO's explicit-strategy form, so it is always matched as CSS.
// Frames are entered with browser.switchFrame() (v9) and left with
// switchFrame(null); an <iframe> inside shadow DOM is reached host by host with
// .shadow$(), as Selenium walks getShadowRoot().

(function (global) {
  'use strict';

  var C = global.LLCodegen;
  if (!C || typeof C.registerTarget !== 'function' || !C._internals) return;
  var I = C._internals;

  function q(value, lang) { return C.q(value, lang); }
  // Line comments only: a line break (or U+2028/2029, which JS also ends a line on)
  // inside one would turn the rest of the text into code.
  function comment(text) {
    // eslint-disable-next-line no-control-regex
    return '// ' + String(text == null ? '' : text).replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ');
  }
  function todo(text) { return comment('TODO: ' + text); }

  // ── selector strings ───────────────────────────────────────────────────────
  // A copy of webdriverio's findStrategy() rules (src/utils/findStrategy.ts, v9):
  // when any of them would claim a CSS selector, it is not plain CSS to `$()`.
  var WDIO_DIRECT = /^(id|css selector|xpath|link text|partial link text|name|tag name|class name|-android uiautomator|-android datamatcher|-android viewmatcher|-android viewtag|-ios uiautomation|-ios predicate string|-ios class chain|accessibility id):(.+)/;
  var WDIO_IMAGE_EXT = ['.jpg', '.jpeg', '.gif', '.png', '.bmp', '.svg'];
  var WDIO_PREFIXES = ['/', '(', '../', './', '*/', '=', '*=', 'id=', '>>>', 'aria/', 'android=', 'ios=', '~'];
  var WDIO_MOBILE = ['uia', 'xcuielementtype', 'android.widget', 'cyi', 'android.view'];
  var WDIO_XPATH_EXTENDED = new RegExp([
    /^([a-z0-9|-]*)/.source,
    /(?:(\.|#)(-?[_a-zA-Z]+[_a-zA-Z0-9-]*))?/.source,
    /(?:\[(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)(?:=(?:"|')([a-zA-Z0-9\-_. ]+)(?:"|'))?\])?/.source,
    /(\.)?/.source,
    /(\*)?=(.+)$/.source
  ].join(''));

  function cssIsAmbiguous(css) {
    var lower = css.toLowerCase();
    if (WDIO_DIRECT.test(css)) return true;
    if (WDIO_IMAGE_EXT.some(function (ext) { return lower.slice(-ext.length) === ext && lower !== ext; })) return true;
    if (WDIO_PREFIXES.some(function (p) { return css.indexOf(p) === 0; })) return true;
    if (WDIO_MOBILE.some(function (p) { return lower.indexOf(p) === 0; })) return true;
    if (/<[0-9a-zA-Z-]+( \/)*>/.test(css)) return true;
    if (css === '.' || css === '..') return true;
    if (WDIO_XPATH_EXTENDED.test(css)) return true;
    return /^\[role=[A-Za-z]+]$/.test(css);
  }

  /** The `$()` argument for a CSS selector: plain, or with WDIO's explicit prefix. */
  function cssArg(css) {
    return cssIsAmbiguous(css) ? 'css selector:' + css : css;
  }

  function find(by, selector, lang) {
    return '$(' + q(by === 'xpath' ? selector : cssArg(selector), lang) + ')';
  }

  // ── the Locatra helper (C9.4) ──────────────────────────────────────────────
  // WebdriverIO has no getByRole / getByLabel / getByText: a role, label or text
  // target calls locatraFind(), declared once per spec or page object (the same
  // in-page matcher every target runs, codegen.js MATCH_SRC). It waits with
  // browser.waitUntil (waitforTimeout, as an element command waits for its element)
  // and fails when several elements match; a chain passes its parent as `within`.
  var HELPER_SRC = [
    'async function locatraFind(',
    '  kind$T{: string}, value$T{: string}, name$T{: string | null} = null, opts$T{: any} = {}',
    ')$T{: Promise<WebdriverIO.Element>} {',
    '  const nth$T{: number} = typeof opts.nth === \'number\' ? opts.nth : -1;',
    '  const what = kind + \' \' + JSON.stringify(value) + (name ? \' named \' + JSON.stringify(name) : \'\') +',
    '    (opts.exact ? \' (exact)\' : \'\');',
    '  const scope = opts.within ? await opts.within : null;',
    '  let found$T{: WebdriverIO.Element[]} = [];',
    '  // Waits up to waitforTimeout, as an element command does; several matches are an error.',
    '  await browser.waitUntil(async () => {',
    '    found = await browser.execute$T{<HTMLElement[], [string, string, string | null, boolean, number, any]>}(',
    '      LOCATRA_JS, kind, value, name, !!opts.exact, opts.level || 0, scope);',
    '    return found.length > Math.max(nth, 0);',
    '  }, { timeoutMsg: \'Locatra: no element matches \' + what });',
    '  if (nth < 0 && found.length > 1) {',
    '    throw new Error(\'Locatra: \' + found.length + \' elements match \' + what + \'; expected exactly one\');',
    '  }',
    '  return $(found[Math.max(nth, 0)]).getElement();',
    '}'
  ].join('\n');

  function helperSource(lang) {
    return '// ' + I.HELPER_BANNER + '\n' + I.jsMatchConst('LOCATRA_JS') + '\n\n' + I.tsOnly(HELPER_SRC, lang);
  }

  // A cross-origin frame (no selector) is entered by its position: LOCATRA_FRAME_JS
  // (codegen.js DEEP_IFRAME_JS) is declared once and run with the frame's index.
  // So is LOCATRA_SET_VALUE_JS (codegen.js SET_VALUE_JS), which sets a date / range /
  // colour input's value.
  function constSource(name, note, js, lang) {
    var parts = I.literalLines(js, I.HELPER_WIDTH - 6, function (c) { return q(c, lang); });
    return '// ' + note + '\nconst ' + name + ' =\n  ' + parts.join(' +\n  ') + ';';
  }

  /** The declarations code needs, in order (an empty list when none). */
  function helpers(code, lang) {
    var out = [];
    if (I.uses(code, I.FRAME_JS_NAME)) out.push(constSource(I.FRAME_JS_NAME, I.FRAME_JS_NOTE, I.DEEP_IFRAME_JS, lang));
    if (I.uses(code, I.SET_VALUE_NAME)) out.push(constSource(I.SET_VALUE_NAME, I.SET_VALUE_NOTE, I.SET_VALUE_JS, lang));
    if (I.uses(code, TEXT_NAME)) out.push(textSource(lang));
    if (I.uses(code, 'locatraFind')) out.push(helperSource(lang));
    return out;
  }

  /** `(await locatraFind(…))`: an element, so a statement continues it like `$()`. */
  function helperCall(spec, lang, within) {
    return '(await locatraFind(' + I.jsHelperArgs(spec, lang, within ? ['within: ' + within] : null) + '))';
  }

  // `$()` reads a selector starting with "/", "(" or "./" as XPath; any other XPath
  // gets WDIO's explicit "xpath:" prefix. Inside a parent, "//…" is made ".//…".
  function xpathArg(value, rel) {
    var v = I.scopedXpath(value, rel);
    return /^(\/|\(|\.\.?\/)/.test(v) ? v : 'xpath:' + v;
  }

  function baseLocator(t, lang, rel, within) {
    var spec = I.helperSpec(t);
    if (spec) return helperCall(spec, lang, within);
    switch (t.kind) {
      case 'testid': return find('css', '[' + I.cssIdent(t.attr) + '="' + I.attrSel(t.value) + '"]', lang);
      case 'placeholder': return find('css', I.attrMatchSel('placeholder', t.value, t.exact), lang);
      case 'altText': return find('css', I.attrMatchSel('alt', t.value, t.exact), lang);
      case 'title': return find('css', I.attrMatchSel('title', t.value, t.exact), lang);
      case 'xpath': return find('xpath', xpathArg(t.value, rel), lang);
      case 'id': return find('css', '#' + I.cssIdent(t.value), lang);
      case 'name': return find('css', '[name="' + I.attrSel(t.value) + '"]', lang);
      case 'css': default: return find('css', t.value || 'body', lang);
    }
  }

  // A chain continues the parent element's search: `$(parent).$(child)`, the child
  // rendered relative (a leading "./" XPath) so it stays inside the parent; a helper
  // child searches `within` the parent. A frame renders its innermost target:
  // entering the frame is a statement (browser.switchFrame), as in Selenium. An
  // element in open shadow DOM is reached host by host with .shadow$(), ending with
  // its shadowCss (C3): `$()` does not search shadow roots with XPath or plain CSS.
  function locatorExpr(target, lang, rel) { return expr(target, lang, rel, null); }

  function expr(target, lang, rel, within) {
    if (!target) return '';
    if (target.kind === 'frame') {
      var inner = I.unwrapFrames(target).inner;
      return inner ? expr(inner, lang, rel, null) : '';
    }
    var sh = I.shadowWalk(target);
    if (sh) {
      var br = I.shadowBreak(sh) ? '\n    ' : '';
      return find('css', sh.hosts[0], lang) + sh.hosts.slice(1).concat(sh.css).map(function (sel) {
        return br + '.shadow$(' + q(cssArg(sel), lang) + ')';
      }).join('');
    }
    if (target.kind === 'chain') {
      var parent = expr(target.parent, lang, rel, within);
      if (!target.child) return parent;
      // A child reached through shadow roots starts from the document.
      if (!parent || I.shadowWalk(target.child)) return expr(target.child, lang, true, null);
      if (I.helperSpec(target.child) || (target.child.kind === 'chain' && I.needsHelper(target.child))) {
        return expr(target.child, lang, true, parent);
      }
      var child = expr(target.child, lang, true, null);
      // A child that is no element search (an empty frame) cannot narrow the parent.
      return /^\$\(/.test(child) ? parent + '.' + child : parent;
    }
    var base = baseLocator(target, lang, rel, within);
    // A native locator inside a helper-found parent continues from that element.
    return within && /^\$\(/.test(base) ? within + '.' + base : base;
  }

  // ── frames ─────────────────────────────────────────────────────────────────
  /** The element switchFrame() enters, as an expression. */
  function frameElementExpr(frame, lang) {
    if (frame.shadowPath) {
      var expr = find('css', frame.shadowPath[0], lang);
      var br = I.pathBreak(frame.shadowPath) ? '\n    ' : '';
      for (var i = 1; i < frame.shadowPath.length; i++) {
        expr += br + '.shadow$(' + q(cssArg(frame.shadowPath[i]), lang) + ')';
      }
      return expr;
    }
    if (frame.selector) return find('css', frame.selector, lang);
    // A cross-origin frame has no readable selector: address it by its position
    // among the page's <iframe>s, shadow roots included ($$('iframe') sees only the
    // document's own), as codegen.js DEEP_IFRAME_JS (LOCATRA_FRAME_JS) counts them.
    // execute() hands back a bare element reference, which switchFrame() refuses;
    // $() makes it an element.
    return '$(await browser.execute' + (lang === 'typescript' ? '<HTMLIFrameElement, [number]>' : '') + '(' +
      I.FRAME_JS_NAME + ', ' + frame.index + '))';
  }

  function frameSwitch(frame, lang) {
    return 'await browser.switchFrame(' + frameElementExpr(frame, lang) + ');';
  }

  // ── values ─────────────────────────────────────────────────────────────────
  // Test-data variables (codegen.js testScript/applyVariables): a fill/select step
  // with a usable varRef reads `testData.<name>`; wrapScript() declares the object.
  // The name rules are codegen.js's own, so every target agrees on which steps
  // reference a variable; the fallback covers an older codegen.js without them.
  var TEST_DATA = 'testData';
  var VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

  function validVarName(name) {
    if (typeof I.isValidVariableName === 'function') return I.isValidVariableName(name);
    return typeof name === 'string' && VAR_NAME.test(name);
  }

  function varRefName(step) {
    if (typeof I.variableRefName === 'function') return I.variableRefName(step);
    if (step.sensitive || (step.action !== 'fill' && step.action !== 'selectOption')) return null;
    return validVarName(step.varRef) ? step.varRef : null;
  }

  // A sensitive value is read from the environment; a test-data value from the
  // `testData` declaration; anything else is a literal.
  function valueExpr(step, lang) {
    if (step.sensitive) return 'process.env.' + I.secretName(step) + " ?? ''";
    var ref = varRefName(step);
    if (!ref) return q(step.value, lang);
    return typeof I.variableRef === 'function' ? I.variableRef(ref, lang) : TEST_DATA + '.' + ref;
  }

  function listLiteral(items, lang) {
    return '[' + items.map(function (i) { return q(i, lang); }).join(', ') + ']';
  }

  // ── keys ───────────────────────────────────────────────────────────────────
  // DOM e.key → webdriverio's Key constant. browser.keys() presses every key of the
  // array in order and then releases them all, so a combo is [modifiers…, key].
  var KEY_WDIO = { Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete',
    ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ' ': 'Space',
    Space: 'Space', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert' };
  for (var fk = 1; fk <= 12; fk++) KEY_WDIO['F' + fk] = 'F' + fk;
  // webdriverio names the Meta key Command (U+E03D, WebDriver's Meta).
  var MOD_WDIO = { Shift: 'Shift', Control: 'Control', Alt: 'Alt', Meta: 'Command' };

  function isSingleChar(key) { return Array.from(String(key)).length === 1; }

  function pressStatement(value, lang) {
    var raw = value == null || value === '' ? 'Enter' : String(value);
    var p = I.parseKeyCombo(raw);
    var keyArg = Object.prototype.hasOwnProperty.call(KEY_WDIO, p.key) ? 'Key.' + KEY_WDIO[p.key]
      : (isSingleChar(p.key) ? q(p.key, lang) : null);
    if (!keyArg) return todo('press "' + I.commentSafe(raw) + '" — no WebdriverIO key mapping');
    var mods = [];
    for (var i = 0; i < p.mods.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(MOD_WDIO, p.mods[i])) {
        return todo('press "' + I.commentSafe(raw) + '" — modifier not supported');
      }
      mods.push('Key.' + MOD_WDIO[p.mods[i]]);
    }
    if (!mods.length) return 'await browser.keys(' + keyArg + ');';
    return 'await browser.keys([' + mods.concat(keyArg).join(', ') + ']);';
  }

  // ── statements ─────────────────────────────────────────────────────────────
  function notes(step) {
    var out = [];
    if (I.roleNote(step.target)) {
      out.push(comment('NOTE: this role locator has no accessible name and may match several elements; the first match is used.'));
    }
    if (I.lacksShadowCss(step.target)) out.push(comment(I.SHADOW_NOTE));
    return out;
  }

  function withNotes(list, stmt) { return list.length ? list.join('\n') + '\n' + stmt : stmt; }

  // isSelected() is always false for an ARIA checkbox (div[role=checkbox]), so its
  // aria-checked state counts too — as in the Selenium export.
  function checkedExpr(el) {
    return '((await ' + el + '.isSelected()) || (await ' + el + ".getAttribute('aria-checked')) === 'true')";
  }

  var DESELECT_ALL_JS = 'for (const o of arguments[0].options) o.selected = false;';

  function withEl(loc, lines) {
    return '{\n  const el = await ' + loc + ';\n' + lines.map(function (l) { return '  ' + l; }).join('\n') + '\n}';
  }

  function toggle(loc, desired) {
    return withEl(loc, ['if (' + (desired ? '!' : '') + checkedExpr('el') + ') await el.click();']);
  }

  // Normalise the text like the recorder and Playwright's toHaveText: expect-webdriverio
  // trims the element text (getText(), already the rendered text), then LOCATRA_TEXT's
  // `replace` drops soft hyphens and zero-width spaces and collapses every run of
  // whitespace. Declared once per file (textSource), so the retrying assertion reads
  // toHaveText('…', LOCATRA_TEXT).
  var TEXT_NAME = 'LOCATRA_TEXT';
  function textSource(lang) {
    return '// ' + I.TEXT_NOTE + '\nconst ' + TEXT_NAME + " = { replace: [[/[\\u00ad\\u200b]/g, ''], [/\\s+/g, ' ']]" +
      (lang === 'typescript' ? ' as [RegExp, string][]' : '') + ' };';
  }

  function assertStatement(step, lang) {
    var loc = locatorExpr(step.target, lang);
    var v = step.value;
    switch (step.assertType || 'toBeVisible') {
      case 'toHaveText': return 'await expect(' + loc + ').toHaveText(' + q(I.normText(v), lang) + ', ' + TEXT_NAME + ');';
      case 'toContainText':
        return 'await expect(' + loc + ').toHaveText(' + q(I.normText(v), lang) + ', { ...' + TEXT_NAME + ', containing: true });';
      case 'toHaveValue':
        // A secret (C2) is compared without ever being printed: toHaveValue's failure
        // message would show the expected value.
        if (I.sensitiveAssert(step)) {
          return 'await browser.waitUntil(async () => (await ' + loc + '.getValue()) === (' + valueExpr(step, lang) + '), {\n' +
            '  timeoutMsg: ' + q(I.secretMismatch(step), lang) + ',\n});';
        }
        return 'await expect(' + loc + ').toHaveValue(' + q(v, lang) + ');';
      case 'toBeEnabled': return 'await expect(' + loc + ').toBeEnabled();';
      case 'toBeChecked': {
        // expect-webdriverio's toBeChecked() reads isSelected() only; wait for the
        // native or ARIA state instead.
        var not = String(v) === 'false';
        return 'await browser.waitUntil(async () => {\n' +
          '  const el = await ' + loc + ';\n' +
          '  return ' + (not ? '!' : '') + checkedExpr('el') + ';\n' +
          '}, { timeoutMsg: ' + q('expected the element ' + (not ? 'not ' : '') + 'to be checked', lang) + ' });';
      }
      case 'toBeVisible': default: return 'await expect(' + loc + ').toBeDisplayed();';
    }
  }

  function targetStatement(step, lang) {
    if (step.action === 'assert') return assertStatement(step, lang);
    var loc = locatorExpr(step.target, lang);
    switch (step.action) {
      case 'click': return 'await ' + loc + '.click();';
      case 'hover': return 'await ' + loc + '.moveTo();';
      case 'dblclick': return 'await ' + loc + '.doubleClick();';
      // A plain click toggles: only click when the state differs.
      case 'check': return toggle(loc, true);
      case 'uncheck': return toggle(loc, false);
      case 'fill': {
        var val = valueExpr(step, lang);
        // Dates, times, sliders and colours cannot be typed reliably: set the value
        // through the prototype setter and fire input/change, as Selenium does.
        if (I.SET_VALUE_TYPES_SELENIUM.indexOf(step.inputType) !== -1) {
          return 'await browser.execute(' + I.SET_VALUE_NAME + ', await ' + loc + ', ' + val + ');';
        }
        if (!step.sensitive && !varRefName(step) && (step.value == null || step.value === '')) {
          return 'await ' + loc + '.clearValue();';
        }
        // setValue() clears first, so a pre-filled field is replaced.
        return 'await ' + loc + '.setValue(' + val + ');';
      }
      case 'upload': {
        var files = I.uploadFiles(step.value);
        if (!files.length) return 'await ' + loc + '.clearValue();';
        // A file input takes absolute paths; several files are newline-separated.
        // addValue, not setValue: clearing a file input first is not needed.
        return comment('NOTE: these file paths must exist relative to where the test runs') + '\n' +
          'await ' + loc + '.addValue(' + listLiteral(files, lang) + ".map((p) => path.resolve(p)).join('\\n'));";
      }
      case 'selectOption': {
        var many = I.multiValues(step);
        if (!many) return 'await ' + loc + '.selectByVisibleText(' + valueExpr(step, lang) + ');';
        // WebdriverIO has no deselectAll(), and clicking an option of a multi-select
        // toggles it: clear the selection first, then pick each label (C1).
        return withEl(loc, ['await browser.execute(' + q(DESELECT_ALL_JS, lang) + ', el);'].concat(many.map(function (label) {
          return 'await el.selectByVisibleText(' + q(label, lang) + ');';
        })));
      }
      default: return todo('unsupported step "' + I.commentSafe(step.action) + '"');
    }
  }

  function actionStatement(step, lang) {
    if (!step) return '';
    var a = step.action;
    if (I.KNOWN_ACTIONS.indexOf(a) === -1) return todo('unsupported step "' + I.commentSafe(a) + '"');
    if (a === 'goto') return 'await browser.url(' + q(step.value || step.url || '', lang) + ');';
    if (a === 'press') return pressStatement(step.value || step.key, lang);
    if (a === 'viewport') {
      // The recorded size is the viewport (innerWidth x innerHeight);
      // setWindowSize() sizes the whole window, so add the browser chrome measured
      // at run time (works with and without WebDriver BiDi).
      var js = 'return [' + I.vpW(step) + ' + outerWidth - innerWidth, ' + I.vpH(step) + ' + outerHeight - innerHeight];';
      var generic = lang === 'typescript' ? '<[number, number], []>' : '';
      return '{\n  const [width, height] = await browser.execute' + generic + '(\n    ' + q(js, lang) + ');\n' +
        '  await browser.setWindowSize(width, height);\n}';
    }
    if (a === 'assert' && step.assertType === 'toHaveURL') {
      // A page assertion: any target is ignored.
      var url = step.value != null && step.value !== '' ? step.value : (step.url || '');
      return 'await expect(browser).toHaveUrl(' + q(url, lang) + ');';
    }
    var peeled = I.unwrapFrames(step.target);
    if (!peeled.inner) return todo('"' + a + '" step has no element locator');
    if (peeled.frames.length) {
      var lines = peeled.frames.map(function (f) { return frameSwitch(f, lang); });
      var body = {};
      for (var prop in step) if (Object.prototype.hasOwnProperty.call(step, prop)) body[prop] = step[prop];
      body.target = peeled.inner;
      lines.push(actionStatement(body, lang));
      // Back to the top document, or every later step would run inside this frame.
      lines.push('await browser.switchFrame(null);');
      return lines.join('\n');
    }
    return withNotes(notes(step), targetStatement(step, lang));
  }

  // ── test file ──────────────────────────────────────────────────────────────
  function codeOnly(text) {
    return String(text).split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
  }

  /** The import lines a body needs, derived from what it actually calls. */
  function importsFor(code) {
    var names = [];
    if (/(^|[^\w$.])browser\b/.test(code)) names.push('browser');
    if (/(^|[^\w$.])\$\(/.test(code)) names.push('$');
    if (/(^|[^\w$.])\$\$\(/.test(code)) names.push('$$');
    if (/(^|[^\w$.])expect\(/.test(code)) names.push('expect');
    var out = [];
    if (names.length) out.push('import { ' + names.join(', ') + " } from '@wdio/globals';");
    if (/(^|[^\w$.])Key\./.test(code)) out.push("import { Key } from 'webdriverio';");
    if (/(^|[^\w$.])path\.resolve\(/.test(code)) out.push("import * as path from 'node:path';");
    return out;
  }

  /** `const testData = { … };` for the variables wrapScript() was given, else ''. */
  function testDataDecl(vars, lang) {
    var seen = {};
    var list = [];
    (Array.isArray(vars) ? vars : []).forEach(function (v) {
      if (!v || !validVarName(v.name) || Object.prototype.hasOwnProperty.call(seen, v.name)) return;
      seen[v.name] = true;
      list.push({ name: v.name, value: v.value == null ? '' : String(v.value) });
    });
    if (!list.length) return '';
    // codegen.js renders the declaration the built-in JS/TS targets use, when it can.
    if (typeof I.variablesDeclaration === 'function') return I.variablesDeclaration(list, lang) + '\n';
    return 'const ' + TEST_DATA + ' = {\n' + list.map(function (v) {
      return '  ' + v.name + ': ' + q(v.value, lang) + ',';
    }).join('\n') + '\n};\n';
  }

  function wrapScript(stmts, lang, steps, opts) {
    stmts = stmts || [];
    var decls = helpers(stmts.join('\n'), lang);
    var imports = importsFor(codeOnly(stmts.concat(decls).join('\n')));
    var data = testDataDecl(opts && opts.variables, lang);
    var head = (imports.length ? imports.join('\n') + '\n\n' : '') + (decls.length ? decls.join('\n\n') + '\n\n' : '') +
      (data ? data + '\n' : '');
    return head +
      "describe('recorded test', () => {\n" +
      "  it('replays the recorded flow', async () => {\n" +
      I.indent(stmts, '    ') + '\n' +
      '  });\n' +
      '});\n';
  }

  // ── page objects ───────────────────────────────────────────────────────────
  // Same model and member/helper semantics as the JS targets in codegen.js. Members
  // are getters returning `$()` — looked up on every access, so a re-rendered page
  // never hands back a stale element. When any element lives in a frame, members
  // become async methods that return to the top document and enter that element's
  // frames first (WebDriver can only search the document it is switched to).
  var PO_KINDS = ['input', 'textarea', 'select', 'checkbox', 'radio', 'button', 'link', 'other'];
  var PO_TEXT_ROLES = ['textbox', 'searchbox', 'combobox', 'spinbutton'];

  function poActions(el) {
    var kind = PO_KINDS.indexOf(el.kind) !== -1 ? el.kind : 'other';
    if (kind === 'input') return el.inputType === 'file' ? [] : ['fill'];
    if (kind === 'textarea') return ['fill'];
    if (kind === 'select') return ['select'];
    if (kind === 'checkbox') return ['check', 'uncheck'];
    if (kind === 'radio') return ['check'];
    if (kind === 'other' && PO_TEXT_ROLES.indexOf(el.role) !== -1) return ['fill'];
    return ['click'];
  }

  function poNote(el) {
    var out = [];
    var n = el.matchCount;
    if (typeof n === 'number' && n !== 1) {
      out.push(comment(n === 0
        ? 'NOTE: this locator matched no element when the page object was generated.'
        : 'NOTE: this locator matched ' + n + ' elements when the page object was generated.'));
    } else if (el.unique === false) {
      out.push(comment('NOTE: this locator was not unique when the page object was generated.'));
    }
    if (I.hasAmbiguousRole(el.target) && !(typeof n === 'number' && n !== 1)) {
      out.push(comment('NOTE: this role locator has no accessible name and may match several elements.'));
    }
    if (I.lacksShadowCss(el.target)) out.push(comment(I.SHADOW_NOTE));
    return out;
  }

  function poHeader(model, skipped) {
    var lines = [comment('Page Object generated by Locatra' + (model.title ? ' for "' + I.commentSafe(model.title) + '"' : '') + '.')];
    if (model.pageUrl) lines.push(comment('Page: ' + I.commentSafe(model.pageUrl).slice(0, 80)));
    if (skipped) lines.push(comment('NOTE: ' + skipped + ' element(s) without a usable locator were left out.'));
    return lines.join('\n') + '\n';
  }

  function poMembers(model, lang) {
    var used = {};
    var skipped = 0;
    var members = [];
    (Array.isArray(model.elements) ? model.elements : []).forEach(function (el) {
      if (!el || !el.target || !I.unwrapFrames(el.target).inner || !locatorExpr(el.target, lang)) { skipped++; return; }
      members.push({ el: el, id: I.poClaim(I.poIdent(el.name, false), used, false) });
    });
    members.forEach(function (m) {
      m.helpers = poActions(m.el).map(function (act) {
        return { act: act, id: I.poClaim(act + m.id.charAt(0).toUpperCase() + m.id.slice(1), used, false) };
      });
    });
    return { members: members, skipped: skipped };
  }

  function pageObject(model, lang) {
    model = model || {};
    if (lang !== 'javascript') lang = 'typescript';
    var ts = lang === 'typescript';
    var cls = I.poClassName(model);
    var info = poMembers(model, lang);
    var members = info.members;
    var url = model.pageUrl ? String(model.pageUrl) : '';
    var anyFrames = members.some(function (m) { return I.unwrapFrames(m.el.target).frames.length > 0; });
    var ret = ts ? ': Promise<void>' : '';
    var body = [];

    // A member found by the helper (an await) is an async method, as is every member
    // once any element lives in a frame; the rest are getters.
    members.forEach(function (m, i) {
      if (i) body.push('');
      body = body.concat(poNote(m.el));
      var loc = locatorExpr(m.el.target, lang);
      var found = /^\(await (locatraFind\([^\n]*\))\)$/.exec(loc);
      m.async = anyFrames || I.uses(loc, 'locatraFind');
      if (m.async) {
        var lines = [];
        if (anyFrames) {
          lines.push('await browser.switchFrame(null);');
          I.unwrapFrames(m.el.target).frames.forEach(function (f) { lines.push(frameSwitch(f, lang)); });
        }
        if (found) lines.push('return ' + found[1] + ';');
        else lines.push('return ' + loc + (I.uses(loc, 'locatraFind') ? ';' : '.getElement();'));
        body.push('async ' + m.id + '()' + (ts ? ': Promise<WebdriverIO.Element>' : '') + ' {', I.indent(lines, '  '), '}');
      } else {
        body.push('get ' + m.id + '() {', '  return ' + loc + ';', '}');
      }
    });
    if (url) {
      if (body.length) body.push('');
      body.push('async goto()' + ret + ' {');
      if (anyFrames) body.push('  await browser.switchFrame(null);');
      body.push('  await browser.url(' + q(url, lang) + ');', '}');
    }
    members.forEach(function (m) {
      var awaited = m.async;
      var get = awaited ? 'await this.' + m.id + '()' : 'this.' + m.id;
      m.helpers.forEach(function (h) {
        var sig = h.act === 'fill' || h.act === 'select' ? '(value' + (ts ? ': string' : '') + ')' : '()';
        var lines;
        if (h.act === 'fill') {
          lines = I.SET_VALUE_TYPES_SELENIUM.indexOf(m.el.inputType) !== -1
            ? ['await browser.execute(' + I.SET_VALUE_NAME + ', ' + (awaited ? get : 'await ' + get) + ', value);']
            : [awaited ? 'await (' + get + ').setValue(value);' : 'await ' + get + '.setValue(value);'];
        } else if (h.act === 'select') {
          lines = [awaited ? 'await (' + get + ').selectByVisibleText(value);' : 'await ' + get + '.selectByVisibleText(value);'];
        } else if (h.act === 'check' || h.act === 'uncheck') {
          lines = ['const el = ' + (awaited ? get : 'await ' + get) + ';',
            'if (' + (h.act === 'check' ? '!' : '') + checkedExpr('el') + ') await el.click();'];
        } else {
          lines = [awaited ? 'await (' + get + ').click();' : 'await ' + get + '.click();'];
        }
        if (body.length) body.push('');
        body.push('async ' + h.id + sig + ret + ' {', I.indent(lines, '  '), '}');
      });
    });

    var decls = helpers(body.join('\n'), lang);
    var imports = importsFor(codeOnly(body.concat(decls).join('\n')));
    var head = imports.length ? imports.join('\n') + '\n\n' : '';
    if (!ts) {
      var inst = cls.charAt(0).toLowerCase() + cls.slice(1);
      head += comment('Usage: const ' + inst + ' = new ' + cls + '();') + '\n\n';
    }
    if (decls.length) head += decls.join('\n\n') + '\n\n';
    return poHeader(model, info.skipped) + head + 'export class ' + cls + ' {\n' + I.indent(body, '  ') + '\n}\n';
  }

  C.registerTarget({
    framework: { id: 'webdriverio', label: 'WebdriverIO' },
    languages: [
      { id: 'typescript', label: 'TypeScript', ext: '.ts' },
      { id: 'javascript', label: 'JavaScript', ext: '.js' }
    ],
    locatorExpr: locatorExpr,
    actionStatement: actionStatement,
    wrapScript: wrapScript,
    pageObject: pageObject,
    // The declarations a locator expression needs (LLCodegen.locatorSnippet).
    helpers: helpers,
    // codegen.js writes its own TODOs (unknown action, no locator) through this.
    todo: function (text) { return todo(text); },
    comment: function (text) { return comment(text); }
  });
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
