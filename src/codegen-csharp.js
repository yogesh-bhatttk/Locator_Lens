// Locatra – codegen-csharp.js
// C# targets for the code generator (registered through LLCodegen.registerTarget):
//   * Playwright for .NET  — Microsoft.Playwright + NUnit (Microsoft.Playwright.NUnit
//     PageTest: `Page`, `Expect(...)`, async/await, *Async methods)
//   * Selenium for C#      — Selenium.WebDriver 4 + Selenium.Support + NUnit
//     (By.XPath / By.CssSelector, Actions, SelectElement, WebDriverWait,
//     GetShadowRoot(), SwitchTo().Frame())
// Locators carry exactly the selectors the JavaScript targets emit (the XPath / CSS
// builders are shared through LLCodegen._internals); only the host syntax differs.
// Loaded after codegen.js as a classic script, sharing its global.

(function (global) {
  'use strict';
  var C = global.LLCodegen;
  if (!C || typeof C.registerTarget !== 'function' || !C._internals) return;
  var I = C._internals;

  // ── string literals ───────────────────────────────────────────────────────
  // A regular literal escapes the quote, the backslash, every C0/C1 control and DEL,
  // the characters C# itself treats as line breaks (U+0085, U+2028, U+2029 — a raw
  // one ends the literal), invisible format characters and spaces (zero-width, bidi
  // controls, no-break spaces: a pasted test should never hide text) and lone
  // surrogates (not encodable as UTF-8). \x is never used: C#'s \x takes 1–4 hex digits, so "\x1Fa" would
  // swallow the "a". A value with backslashes and nothing to escape is written
  // verbatim (@"…", where only the quote doubles), which keeps CSS escapes readable.
  var NAMED = { '\0': '\\0', '\x07': '\\a', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v' };
  // Built from code points so the source itself holds no invisible characters.
  function charClass(ranges) {
    var hex = function (n) { return '\\u' + ('000' + n.toString(16)).slice(-4); };
    return new RegExp('[' + ranges.map(function (r) { return hex(r[0]) + '-' + hex(r[1]); }).join('') + ']', 'g');
  }
  var SPECIAL_G = charClass([[0x00, 0x1f], [0x7f, 0xa0], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e],
    [0x200b, 0x200f], [0x2028, 0x202f], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb]]);
  var SPECIAL = new RegExp(SPECIAL_G.source);
  var CS_NEWLINES = charClass([[0x85, 0x85], [0x2028, 0x2029]]);
  var LINE_BREAKERS = charClass([[0x00, 0x1f], [0x7f, 0x7f], [0x85, 0x85], [0x2028, 0x2029]]);

  function u4(code) { return '\\u' + ('000' + code.toString(16).toUpperCase()).slice(-4); }

  function isHigh(c) { return c >= 0xd800 && c <= 0xdbff; }
  function isLow(c) { return c >= 0xdc00 && c <= 0xdfff; }

  /** Whether `s` has anything a verbatim literal could not hold readably. */
  function needsEscape(s) {
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (SPECIAL.test(s.charAt(i))) return true;
      if (isHigh(c) && i + 1 < s.length && isLow(s.charCodeAt(i + 1))) { i++; continue; }
      if (isHigh(c) || isLow(c)) return true;
    }
    return false;
  }

  function escapeRegular(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      var c = s.charCodeAt(i);
      if (ch === '\\') out += '\\\\';
      else if (ch === '"') out += '\\"';
      else if (NAMED[ch]) out += NAMED[ch];
      else if (SPECIAL.test(ch)) out += u4(c);
      else if (isHigh(c) && i + 1 < s.length && isLow(s.charCodeAt(i + 1))) { out += s.substr(i, 2); i++; }
      else if (isHigh(c) || isLow(c)) out += u4(c);
      else out += ch;
    }
    return out;
  }

  function q(value) {
    var s = String(value == null ? '' : value);
    if (s.indexOf('\\') !== -1 && !needsEscape(s)) return '@"' + s.replace(/"/g, '""') + '"';
    return '"' + escapeRegular(s) + '"';
  }

  /** Text for a // comment: C# also ends a comment at U+0085, U+2028 and U+2029. */
  function commentSafe(value) {
    return I.commentSafe(String(value == null ? '' : value).replace(CS_NEWLINES, ' '));
  }
  function comment(text) { return '// ' + text; }
  // The whole TODO stays on its line, whatever text it carries (the core passes
  // its own TODOs through here too: an action name may hold U+0085, which ends a
  // C# comment but not a JavaScript one).
  function todo(text) {
    return comment('TODO: ' + String(text == null ? '' : text).replace(LINE_BREAKERS, ' '));
  }

  // ── Playwright: ARIA roles ────────────────────────────────────────────────
  // Microsoft.Playwright.AriaRole members, by lower-case ARIA role name.
  var ARIA_ROLES = ('alert alertdialog application article banner blockquote button caption cell checkbox code ' +
    'columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed ' +
    'figure form generic grid gridcell group heading img insertion link list listbox listitem log main marquee math ' +
    'meter menu menubar menuitem menuitemcheckbox menuitemradio navigation none note option paragraph presentation ' +
    'progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider ' +
    'spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer ' +
    'toolbar tooltip tree treegrid treeitem').split(' ');

  function ariaRole(role) {
    var r = String(role == null ? '' : role).toLowerCase();
    return ARIA_ROLES.indexOf(r) !== -1 ? 'AriaRole.' + r.charAt(0).toUpperCase() + r.slice(1) : null;
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  Locator expressions
  // ════════════════════════════════════════════════════════════════════════════

  /** `new() { Exact = true }` for the text-matching getBy* kinds. */
  function exactOpt(t) { return t.exact ? ', new() { Exact = true }' : ''; }

  function pwLeaf(t, root) {
    switch (t.kind) {
      case 'testid':
        if (t.attr === 'data-testid') return root + '.GetByTestId(' + q(t.value) + ')';
        return root + '.Locator(' + q('[' + I.cssIdent(t.attr) + '="' + I.attrSel(t.value) + '"]') + ')';
      case 'role': {
        var nth = I.hasNth(t) ? '.Nth(' + t.nth + ')' : '';
        var enumRole = ariaRole(t.role);
        if (!enumRole) {
          // Not an AriaRole member (Playwright for .NET has no string overload): the
          // same role XPath the Selenium targets use, narrowed by text when the
          // recording had a name.
          var css = root + '.Locator(' + q('xpath=//*[' + I.roleNodeXpath(String(t.role == null ? '' : t.role), t.level) + ']') + ')';
          if (t.name) css += '.Filter(new() { HasText = ' + q(t.name) + ' })';
          return css + nth;
        }
        var opts = [];
        if (t.name) opts.push('Name = ' + q(t.name));
        if (t.name && t.exact) opts.push('Exact = true');
        var level = I.headingLevel(t.level);
        if (level) opts.push('Level = ' + level);
        return root + '.GetByRole(' + enumRole + (opts.length ? ', new() { ' + opts.join(', ') + ' }' : '') + ')' + nth;
      }
      case 'label': return root + '.GetByLabel(' + q(t.value) + exactOpt(t) + ')';
      case 'placeholder': return root + '.GetByPlaceholder(' + q(t.value) + exactOpt(t) + ')';
      case 'altText': return root + '.GetByAltText(' + q(t.value) + exactOpt(t) + ')';
      case 'title': return root + '.GetByTitle(' + q(t.value) + exactOpt(t) + ')';
      case 'text': return root + '.GetByText(' + q(t.value) + exactOpt(t) + ')';
      case 'id': return root + '.Locator(' + q('#' + I.cssIdent(t.value)) + ')';
      case 'name': return root + '.Locator(' + q('[name="' + I.attrSel(t.value) + '"]') + ')';
      case 'css': default: return root + '.Locator(' + q(t.value || 'body') + ')';
    }
  }

  // Frames and chains continue the expression they are scoped to, exactly like the
  // JavaScript target: page.frameLocator(…).getBy…() / parent.getBy…().
  function pwExpr(t, root) {
    if (!t) return '';
    if (t.kind === 'frame') {
      var peeled = I.unwrapFrames(t);
      if (!peeled.inner) return '';
      var expr = root;
      peeled.frames.forEach(function (f) {
        // Without a selector the frame is cross-origin; address it positionally.
        expr += '.FrameLocator(' + q(f.selector ? f.selector : 'iframe >> nth=' + f.index) + ')';
      });
      return pwExpr(peeled.inner, expr);
    }
    if (t.kind === 'chain') {
      var parent = pwExpr(t.parent, root);
      if (!t.child) return parent;
      return pwExpr(t.child, parent || root);
    }
    return pwLeaf(t, root);
  }

  var BY = { css: 'CssSelector', id: 'Id', name: 'Name', xpath: 'XPath' };
  function selFind(by, selector, root) {
    return root + '.FindElement(By.' + BY[by] + '(' + q(selector) + '))';
  }

  // `rel` scopes an XPath to the parent element (the leading dot), as in Selenium JS.
  function roleXpath(t, rel) {
    var node = I.roleNodeXpath(t.role, t.level);
    var axis = rel ? './/*' : '//*';
    var xp = t.name
      ? axis + '[(' + node + ') and (' + I.nameXpath(t.name, t.exact, t.role) + ')]'
      : axis + '[' + node + ']';
    if (I.hasNth(t)) xp = '(' + xp + ')[' + (t.nth + 1) + ']';
    return xp;
  }

  function selLeaf(t, root, rel) {
    var axis = rel ? './/*' : '//*';
    switch (t.kind) {
      case 'testid': return selFind('css', '[' + I.cssIdent(t.attr) + '="' + I.attrSel(t.value) + '"]', root);
      case 'role':
        // XPath, named or not: CSS cannot say which role an element ends up with.
        return selFind('xpath', roleXpath(t, rel), root);
      case 'label': return selFind('xpath', axis + '[' + I.labelXpath(t.value, t.exact) + ']', root);
      case 'placeholder': return selFind('css', I.attrMatchSel('placeholder', t.value, t.exact), root);
      case 'altText': return selFind('css', I.attrMatchSel('alt', t.value, t.exact), root);
      case 'title': return selFind('css', I.attrMatchSel('title', t.value, t.exact), root);
      case 'text': return selFind('xpath', I.textXpath(t.value, t.exact, rel), root);
      case 'id': return selFind('id', t.value, root);
      case 'name': return selFind('name', t.value, root);
      case 'css': default: return selFind('css', t.value || 'body', root);
    }
  }

  // Switching into a frame is a statement in Selenium, so a frame target's
  // expression is its inner element's lookup (selStatement() does the switching).
  // An element in open shadow DOM is reached host by host from the driver — a
  // shadow root is searched with CSS only — ending with its shadowCss (C3).
  function selExpr(t, root, rel) {
    if (!t) return '';
    if (t.kind === 'frame') return selExpr(I.unwrapFrames(t).inner, root, rel);
    var sh = I.shadowOf(t);
    if (sh) {
      var driver = /^Driver\b/.test(root) ? 'Driver' : 'driver';
      return sh.hosts.slice(1).concat(sh.css).reduce(function (el, sel) {
        return el + '.GetShadowRoot().FindElement(By.CssSelector(' + q(sel) + '))';
      }, selFind('css', sh.hosts[0], driver));
    }
    if (t.kind === 'chain') {
      var parent = selExpr(t.parent, root, rel);
      if (!t.child) return parent;
      // The child is always rendered as a scoped (.//) search, as in Selenium JS.
      return selExpr(t.child, parent || root, true);
    }
    return selLeaf(t, root, rel);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  Values
  // ════════════════════════════════════════════════════════════════════════════

  var TEST_DATA = 'TestData';

  function secretExpr(step) {
    return 'Environment.GetEnvironmentVariable(' + q(I.secretName(step)) + ') ?? ""';
  }

  function stringArray(items) { return 'new[] { ' + items.map(q).join(', ') + ' }'; }

  var VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

  // Which steps reference test data, and which variables a script declares, are
  // decided by codegen.js (LLCodegen._internals) so every target agrees; the local
  // fallbacks apply the same rules should a core without variables load this file.
  function varRefName(step) {
    if (typeof I.variableRefName === 'function') return I.variableRefName(step);
    if ((step.action !== 'fill' && step.action !== 'selectOption') || step.sensitive) return null;
    return typeof step.varRef === 'string' && VAR_NAME.test(step.varRef) ? step.varRef : null;
  }

  function scriptVariables(vars, steps) {
    if (typeof I.scriptVariables === 'function') return I.scriptVariables(vars, steps);
    var out = [];
    var seen = {};
    var add = function (name, value) {
      if (typeof name !== 'string' || !VAR_NAME.test(name) || Object.prototype.hasOwnProperty.call(seen, name)) return;
      seen[name] = true;
      out.push({ name: name, value: String(value == null ? '' : value) });
    };
    (Array.isArray(vars) ? vars : []).forEach(function (v) { if (v) add(v.name, v.value); });
    (Array.isArray(steps) ? steps : []).forEach(function (st) { if (st) { var r = varRefName(st); if (r) add(r, st.value); } });
    return out;
  }

  /** A fill/select value: env secret, test-data reference or literal. */
  function valueExpr(step) {
    if (step.action === 'fill' && step.sensitive) return secretExpr(step);
    var ref = varRefName(step);
    return ref ? TEST_DATA + '[' + q(ref) + ']' : q(step.value);
  }

  function fileArray(files) {
    if (!files.length) return 'new string[0]';
    return stringArray(files);
  }

  function uploadNote() { return comment('NOTE: these file paths must exist relative to where the test runs'); }

  function urlValue(step) {
    return q(step.value != null && step.value !== '' ? step.value : (step.url || ''));
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  Playwright statements
  // ════════════════════════════════════════════════════════════════════════════

  // Text is compared as rendered (innerText), the way the recorder read it; a
  // sensitive field's value is compared against its environment variable (C2).
  function pwAssert(step, loc) {
    var t = step.assertType || 'toBeVisible';
    var v = step.value;
    // ToHaveValueAsync's failure message prints the expected value: a secret's
    // assertion keeps the retrying ToHaveValueAsync but rethrows the exception
    // Playwright's assertions throw with a message that names only the variable (no
    // inner exception, so the original is not printed either).
    if (I.sensitiveAssert(step)) {
      return 'try\n{\n    await Expect(' + loc + ').ToHaveValueAsync(' + secretExpr(step) + ');\n}\n' +
        'catch (PlaywrightException)\n{\n    throw new PlaywrightException(' + q(I.secretMismatch(step)) + ');\n}';
    }
    var map = {
      toBeVisible: 'ToBeVisibleAsync()',
      toHaveText: 'ToHaveTextAsync(' + q(v) + ', new() { UseInnerText = true })',
      toContainText: 'ToContainTextAsync(' + q(v) + ', new() { UseInnerText = true })',
      toHaveValue: 'ToHaveValueAsync(' + q(v) + ')',
      toBeEnabled: 'ToBeEnabledAsync()',
      toBeChecked: String(v) === 'false' ? 'Not.ToBeCheckedAsync()' : 'ToBeCheckedAsync()'
    };
    return 'await Expect(' + loc + ').' + (map[t] || map.toBeVisible) + ';';
  }

  function pwStatement(step) {
    var a = step.action;
    if (a === 'goto') return 'await Page.GotoAsync(' + q(step.value || step.url || '') + ');';
    if (a === 'press') return 'await Page.Keyboard.PressAsync(' + q(step.value || step.key || 'Enter') + ');';
    if (a === 'viewport') return 'await Page.SetViewportSizeAsync(' + I.vpW(step) + ', ' + I.vpH(step) + ');';
    if (a === 'assert' && step.assertType === 'toHaveURL') return 'await Expect(Page).ToHaveURLAsync(' + urlValue(step) + ');';
    var loc = pwExpr(step.target, 'Page');
    switch (a) {
      case 'assert': return pwAssert(step, loc);
      case 'click': return 'await ' + loc + '.ClickAsync();';
      case 'hover': return 'await ' + loc + '.HoverAsync();';
      case 'dblclick': return 'await ' + loc + '.DblClickAsync();';
      case 'check': return 'await ' + loc + '.CheckAsync();';
      case 'uncheck': return 'await ' + loc + '.UncheckAsync();';
      // FillAsync also sets range/color/date inputs, so inputType needs no special case.
      case 'fill': return 'await ' + loc + '.FillAsync(' + valueExpr(step) + ');';
      case 'selectOption': {
        var many = I.multiValues(step);
        return 'await ' + loc + '.SelectOptionAsync(' + (many ? stringArray(many) : valueExpr(step)) + ');';
      }
      case 'upload':
        return uploadNote() + '\nawait ' + loc + '.SetInputFilesAsync(' + fileArray(I.uploadFiles(step.value)) + ');';
      default: return todo('unsupported step "' + commentSafe(a) + '"');
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  Selenium statements
  // ════════════════════════════════════════════════════════════════════════════

  // OpenQA.Selenium.Keys members for the recorder's DOM key names.
  var KEYS = { Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete',
    ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ' ': 'Space',
    Space: 'Space', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert' };
  for (var fk = 1; fk <= 12; fk++) KEYS['F' + fk] = 'F' + fk;
  var MODS = { Shift: 'Shift', Control: 'Control', Alt: 'Alt', Meta: 'Meta' };

  function selPress(value) {
    var raw = value == null || value === '' ? 'Enter' : value;
    var p = I.parseKeyCombo(raw);
    var keyArg = KEYS[p.key] ? 'Keys.' + KEYS[p.key] : (Array.from(String(p.key)).length === 1 ? q(p.key) : null);
    // An unknown key never silently becomes a different one.
    if (!keyArg) return todo('press "' + commentSafe(raw) + '" — no Selenium key mapping');
    var mods = [];
    for (var i = 0; i < p.mods.length; i++) {
      if (!MODS[p.mods[i]]) return todo('press "' + commentSafe(raw) + '" — modifier not supported');
      mods.push('Keys.' + MODS[p.mods[i]]);
    }
    var down = mods.map(function (m) { return '.KeyDown(' + m + ')'; }).join('');
    var up = mods.slice().reverse().map(function (m) { return '.KeyUp(' + m + ')'; }).join('');
    return 'new Actions(driver)' + down + '.SendKeys(' + keyArg + ')' + up + '.Perform();';
  }

  // Selected is always false for an ARIA checkbox (div[role=checkbox]), so its
  // aria-checked state counts too.
  function checkedExpr(el) {
    return '(' + el + '.Selected || ' + el + '.GetDomAttribute("aria-checked") == "true")';
  }

  // Statements that touch the element more than once look it up once, in a block
  // so repeated steps never redeclare `el`.
  function withEl(loc, lines) {
    return '{\n    var el = ' + loc + ';\n' + lines.map(function (l) { return '    ' + l; }).join('\n') + '\n}';
  }

  function frameSwitch(frame, root) {
    if (frame.shadowPath) {
      // WebDriver searches a shadow root with CSS only, one tree at a time.
      var host = selFind('css', frame.shadowPath[0], root);
      for (var i = 1; i < frame.shadowPath.length; i++) {
        host += '.GetShadowRoot().FindElement(By.CssSelector(' + q(frame.shadowPath[i]) + '))';
      }
      return root + '.SwitchTo().Frame(' + host + ');';
    }
    if (frame.selector) return root + '.SwitchTo().Frame(' + selFind('css', frame.selector, root) + ');';
    // No selector (a cross-origin frame): the frame element, by its position among
    // the page's <iframe>s, shadow roots included (codegen.js DEEP_IFRAME_JS).
    return root + '.SwitchTo().Frame((IWebElement)((IJavaScriptExecutor)' + root + ').ExecuteScript(' +
      q(I.DEEP_IFRAME_JS) + ', ' + I.seleniumFrameIndex(frame) + ')!);';
  }

  var SET_VALUE = '((IJavaScriptExecutor)driver).ExecuteScript(' + q(I.SET_VALUE_JS);
  // The rendered text, normalised as the recorder normalised it: soft hyphens and
  // zero-width spaces dropped, white space (\s is Unicode-aware in .NET) collapsed.
  var NORM_TEXT = function (loc) {
    return 'Regex.Replace(Regex.Replace(' + loc + '.Text, @"[\\u00AD\\u200B]", ""), @"\\s+", " ").Trim()';
  };

  function selAssert(step, loc) {
    var t = step.assertType || 'toBeVisible';
    var v = step.value;
    switch (t) {
      case 'toHaveText': return 'Assert.That(' + NORM_TEXT(loc) + ', Is.EqualTo(' + q(I.normText(v)) + '));';
      case 'toContainText': return 'Assert.That(' + NORM_TEXT(loc) + ', Does.Contain(' + q(I.normText(v)) + '));';
      case 'toHaveValue':
        // A secret is compared without ever being printed in a failure message.
        if (I.sensitiveAssert(step)) {
          return 'Assert.That(' + loc + '.GetDomProperty("value") == (' + secretExpr(step) + '), Is.True, ' +
            q(I.secretMismatch(step)) + ');';
        }
        return 'Assert.That(' + loc + '.GetDomProperty("value"), Is.EqualTo(' + q(v) + '));';
      case 'toBeEnabled': return 'Assert.That(' + loc + '.Enabled, Is.True);';
      case 'toBeChecked':
        return withEl(loc, ['Assert.That(' + checkedExpr('el') + ', ' + (String(v) === 'false' ? 'Is.False' : 'Is.True') + ');']);
      case 'toBeVisible': default: return 'Assert.That(' + loc + '.Displayed, Is.True);';
    }
  }

  function selTargetStatement(step) {
    var a = step.action;
    var loc = selExpr(step.target, 'driver');
    switch (a) {
      case 'assert': return selAssert(step, loc);
      case 'click': return loc + '.Click();';
      case 'hover': return 'new Actions(driver).MoveToElement(' + loc + ').Perform();';
      case 'dblclick': return 'new Actions(driver).DoubleClick(' + loc + ').Perform();';
      // Only click when the state differs — a plain click toggles.
      case 'check': return withEl(loc, ['if (!' + checkedExpr('el') + ') el.Click();']);
      case 'uncheck': return withEl(loc, ['if ' + checkedExpr('el') + ' el.Click();']);
      case 'fill':
        if (I.SET_VALUE_TYPES_SELENIUM.indexOf(step.inputType) !== -1) {
          return SET_VALUE + ', ' + loc + ', ' + valueExpr(step) + ');';
        }
        // Clear first so a pre-filled field is replaced, not appended to.
        return withEl(loc, ['el.Clear();', 'el.SendKeys(' + valueExpr(step) + ');']);
      case 'selectOption': {
        var many = I.multiValues(step);
        if (!many) return 'new SelectElement(' + loc + ').SelectByText(' + valueExpr(step) + ');';
        // A multi-select keeps earlier choices: clear them, then pick each label.
        return '{\n    var select = new SelectElement(' + loc + ');\n    select.DeselectAll();\n' + many.map(function (v) {
          return '    select.SelectByText(' + q(v) + ');';
        }).join('\n') + '\n}';
      }
      case 'upload': {
        var files = I.uploadFiles(step.value);
        if (!files.length) return loc + '.Clear();';
        // A file input takes absolute paths; several files are newline-separated.
        return uploadNote() + '\n' + loc + '.SendKeys(string.Join("\\n", ' + fileArray(files) + '.Select(Path.GetFullPath)));';
      }
      default: return todo('unsupported step "' + commentSafe(a) + '"');
    }
  }

  function selStatement(step) {
    var a = step.action;
    var peeled = I.unwrapFrames(step.target);
    if (peeled.frames.length && !(a === 'assert' && step.assertType === 'toHaveURL')) {
      var lines = peeled.frames.map(function (f) { return frameSwitch(f, 'driver'); });
      var body = {};
      for (var prop in step) if (Object.prototype.hasOwnProperty.call(step, prop)) body[prop] = step[prop];
      body.target = peeled.inner;
      lines.push(selStatement(body));
      // Back to the top document, or every later step would run inside this frame.
      lines.push('driver.SwitchTo().DefaultContent();');
      return lines.join('\n');
    }
    if (a === 'goto') return 'driver.Navigate().GoToUrl(' + q(step.value || step.url || '') + ');';
    if (a === 'press') return selPress(step.value || step.key);
    if (a === 'viewport') {
      // The recorded size is the viewport; Selenium sizes the whole window, so add
      // the browser chrome measured at run time.
      return '{\n' +
        '    var js = (IJavaScriptExecutor)driver;\n' +
        '    var width = Convert.ToInt32(js.ExecuteScript(' + q('return ' + I.vpW(step) + ' + window.outerWidth - window.innerWidth;') + '));\n' +
        '    var height = Convert.ToInt32(js.ExecuteScript(' + q('return ' + I.vpH(step) + ' + window.outerHeight - window.innerHeight;') + '));\n' +
        '    driver.Manage().Window.Size = new Size(width, height);\n' +
        '}';
    }
    if (a === 'assert' && step.assertType === 'toHaveURL') {
      return 'new WebDriverWait(driver, TimeSpan.FromSeconds(10)).Until(d => d.Url == ' + urlValue(step) + ');';
    }
    var notes = [];
    if (I.hasAmbiguousRole(step.target)) {
      notes.push(comment('NOTE: this role locator has no accessible name and may match several elements; the first match is used.'));
    }
    if (I.lacksShadowCss(step.target)) notes.push(comment(I.SHADOW_NOTE));
    var stmt = selTargetStatement(step);
    return notes.length ? notes.join('\n') + '\n' + stmt : stmt;
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  Test files
  // ════════════════════════════════════════════════════════════════════════════

  function pad(text, spaces) {
    var p = new Array(spaces + 1).join(' ');
    return I.indent([text], p);
  }

  /** Real statements only: comment lines alone do not use any API. */
  function codeOf(stmts) {
    return stmts.join('\n').split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
  }

  // System namespaces first, then the rest, each alphabetically (the .NET default).
  function usingBlock(names) {
    var uniq = names.filter(function (n, i) { return names.indexOf(n) === i; });
    uniq.sort(function (a, b) {
      var sa = /^System(\.|$)/.test(a) ? 0 : 1;
      var sb = /^System(\.|$)/.test(b) ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return a < b ? -1 : 1;
    });
    return uniq.map(function (n) { return 'using ' + n + ';'; }).join('\n') + '\n';
  }

  function systemUsings(code) {
    var out = [];
    if (/\b(Environment|TimeSpan|Convert)\./.test(code)) out.push('System');
    if (/\bTestData\[/.test(code)) out.push('System.Collections.Generic');
    if (/\bSize\(/.test(code)) out.push('System.Drawing');
    if (/\bPath\./.test(code)) out.push('System.IO');
    if (/\.Select\(/.test(code)) out.push('System.Linq');
    if (/\bRegex\./.test(code)) out.push('System.Text.RegularExpressions');
    return out;
  }

  /** The test-data field (variables contract): one entry per variable, in order. */
  // Keys are the variable names exactly as the references spell them.
  function testDataField(steps, opts) {
    var vars = scriptVariables(opts && opts.variables, steps);
    if (!vars.length) return '';
    var rows = vars.map(function (v) { return '    [' + q(v.name) + '] = ' + q(v.value) + ','; });
    return 'private static readonly IReadOnlyDictionary<string, string> ' + TEST_DATA + ' = new Dictionary<string, string>\n' +
      '{\n' + rows.join('\n') + '\n};';
  }

  function pwWrap(stmts, lang, steps, opts) {
    stmts = stmts || [];
    var field = testDataField(steps, opts);
    var code = codeOf(stmts) + (field ? '\nTestData[' : '');
    var usings = ['Microsoft.Playwright', 'Microsoft.Playwright.NUnit', 'NUnit.Framework', 'System.Threading.Tasks']
      .concat(systemUsings(code));
    return usingBlock(usings) + '\n' +
      '[Parallelizable(ParallelScope.Self)]\n' +
      '[TestFixture]\n' +
      'public class RecordedTest : PageTest\n' +
      '{\n' +
      (field ? pad(field, 4) + '\n\n' : '') +
      '    [Test]\n' +
      '    public async Task RecordedFlow()\n' +
      '    {\n' +
      (stmts.length ? pad(stmts.join('\n'), 8) + '\n' : '') +
      '    }\n' +
      '}\n';
  }

  function selWrap(stmts, lang, steps, opts) {
    stmts = stmts || [];
    var field = testDataField(steps, opts);
    var code = codeOf(stmts) + (field ? '\nTestData[' : '');
    var usings = ['NUnit.Framework', 'OpenQA.Selenium', 'OpenQA.Selenium.Chrome', 'System'].concat(systemUsings(code));
    if (/\bnew Actions\(/.test(code)) usings.push('OpenQA.Selenium.Interactions');
    if (/\bnew (SelectElement|WebDriverWait)\(/.test(code)) usings.push('OpenQA.Selenium.Support.UI');
    return usingBlock(usings) + '\n' +
      '[TestFixture]\n' +
      'public class RecordedTest\n' +
      '{\n' +
      (field ? pad(field, 4) + '\n\n' : '') +
      '    [Test]\n' +
      '    public void RecordedFlow()\n' +
      '    {\n' +
      '        IWebDriver driver = new ChromeDriver();\n' +
      '        // Selenium has no auto-wait; give elements time to appear\n' +
      '        driver.Manage().Timeouts().ImplicitWait = TimeSpan.FromSeconds(10);\n' +
      '        try\n' +
      '        {\n' +
      (stmts.length ? pad(stmts.join('\n'), 12) + '\n' : '') +
      '        }\n' +
      '        finally\n' +
      '        {\n' +
      '            driver.Quit();\n' +
      '        }\n' +
      '    }\n' +
      '}\n';
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  Page Objects
  // ════════════════════════════════════════════════════════════════════════════
  // Same members and helpers as the JavaScript page objects (one locator member per
  // element; fill / select / check / uncheck / click helpers by kind), in .NET
  // style: PascalCase properties and methods, *Async for Playwright's awaitables.

  // Names a member may not take: every object's own members, the class's fixed
  // members, and the type names its code uses in expressions (a property named
  // `By` would shadow OpenQA.Selenium.By inside the class). C# keywords need no
  // entry: they are all lower-case, and every generated member is PascalCase.
  var PO_RESERVED = ['Page', 'Driver', 'Goto', 'GotoAsync', 'Equals', 'GetHashCode', 'GetType', 'ToString',
    'MemberwiseClone', 'Finalize', 'ReferenceEquals', 'By', 'AriaRole', 'Keys', 'SelectElement',
    'IJavaScriptExecutor', 'Actions', 'Task', 'Environment', 'Convert', 'IPage', 'ILocator', 'IWebDriver',
    'IWebElement', 'String', 'Object'];

  function poPascal(name) {
    var words = I.poWords(name).slice(0, 8);
    if (!words.length) words = ['element'];
    var id = words.map(I.cap).join('');
    if (/^[0-9]/.test(id)) id = 'El' + id;
    return id.slice(0, 64);
  }

  function poClaim(base, used, reserved) {
    var id = base;
    if (reserved.indexOf(id) !== -1) id += 'Element';
    var root = id;
    var n = 2;
    while (Object.prototype.hasOwnProperty.call(used, id)) id = root + n++;
    used[id] = true;
    return id;
  }

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

  function poMembers(model, cls, async, render) {
    var used = {};
    var reserved = PO_RESERVED.concat([cls]);
    var skipped = 0;
    var members = [];
    (Array.isArray(model.elements) ? model.elements : []).forEach(function (el) {
      if (!el || !el.target || !I.unwrapFrames(el.target).inner || !render(el.target)) { skipped++; return; }
      members.push({ el: el, id: poClaim(poPascal(el.name), used, reserved) });
    });
    members.forEach(function (m) {
      m.helpers = poActions(m.el).map(function (act) {
        return { act: act, id: poClaim(I.cap(act) + m.id + (async ? 'Async' : ''), used, reserved) };
      });
    });
    return { members: members, skipped: skipped };
  }

  function poNotes(el, selenium) {
    var notes = [];
    var n = el.matchCount;
    if (typeof n === 'number' && n !== 1) {
      notes.push(comment(n === 0
        ? 'NOTE: this locator matched no element when the page object was generated.'
        : 'NOTE: this locator matched ' + n + ' elements when the page object was generated.'));
    } else if (el.unique === false) {
      notes.push(comment('NOTE: this locator was not unique when the page object was generated.'));
    }
    if (I.hasAmbiguousRole(el.target) && !(typeof n === 'number' && n !== 1)) {
      notes.push(comment('NOTE: this role locator has no accessible name and may match several elements.'));
    }
    if (selenium && I.lacksShadowCss(el.target)) notes.push(comment(I.SHADOW_NOTE));
    return notes;
  }

  function poHeader(model, skipped) {
    var lines = [comment('Page Object generated by Locatra' + (model.title ? ' for "' + commentSafe(model.title) + '"' : '') + '.')];
    if (model.pageUrl) lines.push(comment('Page: ' + commentSafe(model.pageUrl).slice(0, 80)));
    if (skipped) lines.push(comment('NOTE: ' + skipped + ' element(s) without a usable locator were left out.'));
    return lines.join('\n') + '\n';
  }

  function block(lines, spaces) { return pad(lines.join('\n'), spaces); }

  function poClass(model, cls, usings, info, body) {
    var code = codeOf(body);
    return poHeader(model, info.skipped) + usingBlock(usings.concat(systemUsings(code))) + '\n' +
      'public class ' + cls + '\n{\n' + block(body, 4) + '\n}\n';
  }

  function poPlaywright(model) {
    var cls = I.poClassName(model);
    // A member may not share its class's name, and every page object has `Page`.
    if (cls === 'Page') cls = 'PagePage';
    var info = poMembers(model, cls, true, function (t) { return pwExpr(t, 'page'); });
    var url = model.pageUrl ? String(model.pageUrl) : '';
    var body = [];
    var ctor = ['Page = page;'];
    info.members.forEach(function (m) {
      ctor = ctor.concat(poNotes(m.el), [m.id + ' = ' + pwExpr(m.el.target, 'page') + ';']);
    });
    body.push('public ' + cls + '(IPage page)', '{', block(ctor, 4), '}', '', 'public IPage Page { get; }');
    info.members.forEach(function (m) { body.push('', 'public ILocator ' + m.id + ' { get; }'); });
    if (url) body.push('', 'public async Task GotoAsync()', '{', '    await Page.GotoAsync(' + q(url) + ');', '}');
    info.members.forEach(function (m) {
      m.helpers.forEach(function (h) {
        var call;
        if (h.act === 'fill') call = m.id + '.FillAsync(value)';
        else if (h.act === 'select') call = m.id + '.SelectOptionAsync(value)';
        else call = m.id + '.' + I.cap(h.act) + 'Async()';
        var sig = h.act === 'fill' || h.act === 'select' ? '(string value)' : '()';
        body.push('', 'public async Task ' + h.id + sig, '{', '    await ' + call + ';', '}');
      });
    });
    return poClass(model, cls, ['Microsoft.Playwright', 'System.Threading.Tasks'], info, body);
  }

  // Elements are looked up on every access (never cached), so a re-rendered page
  // cannot hand back a stale element. When any element lives in a frame, every
  // lookup first returns to the top document and then enters that element's frames.
  function poSelenium(model) {
    var cls = I.poClassName(model);
    var info = poMembers(model, cls, false, function (t) { return selExpr(t, 'Driver'); });
    var url = model.pageUrl ? String(model.pageUrl) : '';
    var anyFrames = info.members.some(function (m) { return I.unwrapFrames(m.el.target).frames.length > 0; });
    var body = ['public ' + cls + '(IWebDriver driver)', '{', '    Driver = driver;', '}', '', 'public IWebDriver Driver { get; }'];
    if (url) {
      body.push('', 'public void Goto()', '{');
      if (anyFrames) body.push('    Driver.SwitchTo().DefaultContent();');
      body.push('    Driver.Navigate().GoToUrl(' + q(url) + ');', '}');
    }
    info.members.forEach(function (m) {
      body.push('');
      body = body.concat(poNotes(m.el, true));
      var find = selExpr(m.el.target, 'Driver');
      if (!anyFrames) {
        body.push('public IWebElement ' + m.id + ' => ' + find + ';');
        return;
      }
      var lines = ['Driver.SwitchTo().DefaultContent();'];
      I.unwrapFrames(m.el.target).frames.forEach(function (f) { lines.push(frameSwitch(f, 'Driver')); });
      lines.push('return ' + find + ';');
      body.push('public IWebElement ' + m.id, '{', '    get', '    {', block(lines, 8), '    }', '}');
    });
    info.members.forEach(function (m) {
      m.helpers.forEach(function (h) {
        var lines;
        var sig = h.act === 'fill' || h.act === 'select' ? '(string value)' : '()';
        if (h.act === 'fill') {
          lines = I.SET_VALUE_TYPES_SELENIUM.indexOf(m.el.inputType) !== -1
            ? ['((IJavaScriptExecutor)Driver).ExecuteScript(' + q(I.SET_VALUE_JS) + ', ' + m.id + ', value);']
            : ['var el = ' + m.id + ';', 'el.Clear();', 'el.SendKeys(value);'];
        } else if (h.act === 'select') {
          lines = ['new SelectElement(' + m.id + ').SelectByText(value);'];
        } else if (h.act === 'check' || h.act === 'uncheck') {
          lines = ['var el = ' + m.id + ';', 'if ' + (h.act === 'check' ? '(!' + checkedExpr('el') + ')' : checkedExpr('el')) + ' el.Click();'];
        } else {
          lines = [m.id + '.Click();'];
        }
        body.push('', 'public void ' + h.id + sig, '{', block(lines, 4), '}');
      });
    });
    var usings = ['OpenQA.Selenium'];
    if (/\bnew SelectElement\(/.test(codeOf(body))) usings.push('OpenQA.Selenium.Support.UI');
    return poClass(model, cls, usings, info, body);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  Registration
  // ════════════════════════════════════════════════════════════════════════════

  var CSHARP = { id: 'csharp', label: 'C#', ext: '.cs' };

  var targets = {};
  targets.playwright = C.registerTarget({
    framework: { id: 'playwright', label: 'Playwright' },
    languages: [CSHARP],
    locatorExpr: function (target) { return pwExpr(target, 'Page'); },
    actionStatement: function (step) { return pwStatement(step); },
    wrapScript: pwWrap,
    todo: function (text) { return todo(text); },
    pageObject: function (model) { return poPlaywright(model || {}); }
  });

  targets.selenium = C.registerTarget({
    framework: { id: 'selenium', label: 'Selenium' },
    languages: [CSHARP],
    locatorExpr: function (target, lang, rel) { return selExpr(target, 'driver', rel); },
    actionStatement: function (step) { return selStatement(step); },
    wrapScript: selWrap,
    todo: function (text) { return todo(text); },
    pageObject: function (model) { return poSelenium(model || {}); }
  });

  // For tests: the literal and identifier helpers on their own, and the target
  // definitions (to reach what LLCodegen's own guards never pass through).
  C._csharp = { q: q, commentSafe: commentSafe, ARIA_ROLES: ARIA_ROLES, targets: targets };
})(typeof window !== 'undefined' ? window : globalThis);
