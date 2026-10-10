// Locatra – codegen-java.js
// Java targets for the code generator: Playwright for Java and Selenium 4 for Java,
// both as JUnit 5 tests. Registers with LLCodegen (codegen.js must load first) and
// reuses its shared helpers, so every locator selects exactly what the JS/TS/Python
// output of the same framework selects — only the host-language syntax differs.
// A Selenium role / label / text target calls Locatra.find(), and a text assertion
// reads Locatra.text(el): members of a static nested class declared once per file,
// holding only the members the file calls (C9.4).
//
// Java specifics handled here:
//   * String literals are double-quoted. Control characters become octal escapes and
//     every non-ASCII character a \uXXXX escape, so the file compiles whatever source
//     encoding javac assumes. Java translates \uXXXX escapes before it tokenises —
//     even inside comments — so a literal "\u000a" in a recorded value (or in a
//     comment quoting one) would otherwise end the line early; backslashes in values
//     are always doubled, and comments are neutralised (javaSafe()).
//   * Playwright's getBy* options are nested classes of the receiver type
//     (Page.GetByRoleOptions vs Locator.GetByRoleOptions vs FrameLocator…), so the
//     locator renderer tracks what each call is made on.
//   * `goto` is a reserved word in Java: page objects navigate with navigate().

(function (global) {
  'use strict';

  var C = global.LLCodegen;
  if (!C || typeof C.registerTarget !== 'function') return;
  var I = C._internals;

  // ── escaping ──────────────────────────────────────────────────────────────
  var NAMED = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f', '"': '\\"', '\\': '\\\\' };

  /** A Java string literal for any value. */
  function jq(value) {
    var s = String(value == null ? '' : value);
    var out = '"';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      var code = s.charCodeAt(i);
      if (NAMED[ch]) out += NAMED[ch];
      else if (code < 0x20 || code === 0x7f) out += '\\' + ('00' + code.toString(8)).slice(-3);
      else if (code > 0x7e) out += '\\u' + ('000' + code.toString(16)).slice(-4);
      else out += ch;
    }
    return out + '"';
  }

  // javac decodes \uXXXX escapes before it tokenises, comments included: one that
  // decodes to a line break ends a // comment early, and a malformed one ("C:\users")
  // is a compile error. A backslash starts an escape when an even number of
  // backslashes precede it, so such a run gets one more backslash. Escapes that
  // decode to anything else are harmless and kept, which makes this idempotent.
  function neutraliseUnicodeEscapes(text) {
    return text.replace(/(\\+)(u+)([0-9a-fA-F]{4})?/g, function (m, run, us, hex) {
      if (run.length % 2 === 0) return m;
      var code = hex ? parseInt(hex, 16) : -1;
      return code === -1 || code === 0x0a || code === 0x0d ? run + '\\' + us + (hex || '') : m;
    });
  }

  // Comments are made pure ASCII too (a \uXXXX escape in a comment is harmless
  // unless it decodes to a line break, which a non-ASCII character never does), so
  // javac reads the file the same in every platform encoding.
  function asciiComment(line) {
    return neutraliseUnicodeEscapes(line).replace(/[^\x20-\x7e\t]/g, function (c) {
      var code = c.charCodeAt(0);
      // A control character (a stray CR above all) becomes a space, never \u000d.
      return code < 0x20 || code === 0x7f ? ' ' : '\\u' + ('000' + code.toString(16)).slice(-4);
    });
  }

  /** Make every whole-line // comment safe (string literals are left alone). */
  function javaSafe(code) {
    return String(code).split('\n').map(function (line) {
      return /^\s*\/\//.test(line) ? asciiComment(line) : line;
    }).join('\n');
  }

  function comment(text) { return javaSafe('// ' + text); }
  function todo(text) { return comment('TODO: ' + text); }

  /** Remove string literals, so import detection only looks at code. */
  function codeOnly(text) { return String(text).replace(/"(?:[^"\\\n]|\\.)*"/g, '""'); }

  // ── shared step helpers ─────────────────────────────────────────────────────
  /**
   * The value a fill / selectOption types: an environment secret (never test data),
   * a TEST_DATA reference (step.varRef, by the same rules as the built-in targets),
   * or the literal.
   */
  function secretExpr(step) { return 'System.getenv().getOrDefault(' + jq(I.secretName(step)) + ', "")'; }

  function valueExpr(step) {
    if (step.sensitive) return secretExpr(step);
    var ref = I.variableRefName(step);
    return ref ? 'TEST_DATA.get(' + jq(ref) + ')' : jq(step.value);
  }

  function uploadNote() { return comment('NOTE: these file paths must exist relative to where the test runs'); }

  function withNotes(notes, stmt) { return notes.length ? notes.join('\n') + '\n' + stmt : stmt; }

  function ambiguousNote(target) {
    var notes = I.roleNote(target)
      ? [comment('NOTE: this role locator has no accessible name and may match several elements; the first match is used.')]
      : [];
    if (I.lacksShadowCss(target)) notes.push(comment(I.SHADOW_NOTE));
    return notes;
  }

  function urlOf(step) {
    return step.value != null && step.value !== '' ? step.value : (step.url || '');
  }

  // ── test data (variables) ───────────────────────────────────────────────────
  // LLCodegen.wrapScript() hands a target opts.variables already resolved: valid
  // names, the first of each name, string values, plus any name a step references
  // (Map.ofEntries() would throw on a duplicate key or a null value).
  /** The TEST_DATA field for opts.variables, or '' when there are none. */
  function testDataField(opts, pad) {
    var vars = opts && Array.isArray(opts.variables) ? opts.variables : [];
    if (!vars.length) return '';
    return pad + 'private static final Map<String, String> TEST_DATA = Map.ofEntries(\n' +
      vars.map(function (v) { return pad + '    Map.entry(' + jq(v.name) + ', ' + jq(v.value) + ')'; }).join(',\n') +
      '\n' + pad + ');\n';
  }

  function sortedImports(list) {
    var seen = {};
    return list.filter(function (i) {
      if (seen[i]) return false;
      seen[i] = true;
      return true;
    }).sort();
  }

  function importBlock(regular, statics) {
    var java = [];
    var other = [];
    sortedImports(regular).forEach(function (i) { (/^java\./.test(i) ? java : other).push('import ' + i + ';'); });
    var groups = [other, java, sortedImports(statics).map(function (i) { return 'import static ' + i + ';'; })];
    return groups.filter(function (g) { return g.length; }).map(function (g) { return g.join('\n'); }).join('\n\n') + '\n';
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  Playwright for Java
  // ════════════════════════════════════════════════════════════════════════════

  var ARIA_ROLES = ('alert alertdialog application article banner blockquote button caption cell checkbox code ' +
    'columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed ' +
    'figure form generic grid gridcell group heading img insertion link list listbox listitem log main marquee ' +
    'math meter menu menubar menuitem menuitemcheckbox menuitemradio navigation none note option paragraph ' +
    'presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator ' +
    'slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time ' +
    'timer toolbar tooltip tree treegrid treeitem').split(' ');

  // The selector Playwright's own getByRole() builds, for a role AriaRole has no
  // constant for (only reachable with hand-edited or future targets).
  function internalRoleSelector(t, level) {
    var sel = 'internal:role=' + t.role;
    if (t.name) sel += '[name="' + String(t.name).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' + (t.exact ? 's' : 'i') + ']';
    if (level) sel += '[level=' + level + ']';
    return sel;
  }

  /**
   * One target as a Playwright for Java expression rooted at `page.`. `recv` is the
   * type the root call is made on (Page, Locator, FrameLocator) — it decides which
   * nested options class the getBy* call takes. `pageType` spells Page (fully
   * qualified when a page object is itself called Page).
   */
  function pwExpr(t, recv, pageType) {
    if (!t) return '';
    if (t.kind === 'frame') return pwFrameExpr(t, recv, pageType);
    if (t.kind === 'chain') return pwChainExpr(t, recv, pageType);
    var optCls = recv === 'Page' ? pageType + '.' : recv + '.';
    var ex = function (opt) { return t.exact ? ', new ' + optCls + 'GetBy' + opt + 'Options().setExact(true)' : ''; };
    switch (t.kind) {
      case 'testid':
        if (t.attr === 'data-testid') return 'page.getByTestId(' + jq(t.value) + ')';
        return 'page.locator(' + jq('[' + I.cssIdent(t.attr) + '="' + I.attrSel(t.value) + '"]') + ')';
      case 'role': {
        var level = I.headingLevel(t.level);
        var nth = I.hasNth(t) ? '.nth(' + t.nth + ')' : '';
        if (ARIA_ROLES.indexOf(t.role) === -1) return 'page.locator(' + jq(internalRoleSelector(t, level)) + ')' + nth;
        var setters = '';
        if (t.name) setters += '.setName(' + jq(t.name) + ')';
        if (t.name && t.exact) setters += '.setExact(true)';
        if (level) setters += '.setLevel(' + level + ')';
        var opts = setters ? ', new ' + optCls + 'GetByRoleOptions()' + setters : '';
        return 'page.getByRole(AriaRole.' + t.role.toUpperCase() + opts + ')' + nth;
      }
      case 'label': return 'page.getByLabel(' + jq(t.value) + ex('Label') + ')';
      case 'placeholder': return 'page.getByPlaceholder(' + jq(t.value) + ex('Placeholder') + ')';
      case 'altText': return 'page.getByAltText(' + jq(t.value) + ex('AltText') + ')';
      case 'title': return 'page.getByTitle(' + jq(t.value) + ex('Title') + ')';
      case 'text': return 'page.getByText(' + jq(t.value) + ex('Text') + ')';
      case 'id': return 'page.locator(' + jq('#' + I.cssIdent(t.value)) + ')';
      case 'name': return 'page.locator(' + jq('[name="' + I.attrSel(t.value) + '"]') + ')';
      case 'xpath': return 'page.locator(' + jq('xpath=' + t.value) + ')';
      case 'css': default: return 'page.locator(' + jq(t.value || 'body') + ')';
    }
  }

  /** Re-point an expression rooted at `page.` at the receiver before it. */
  // A chain longer than 120 characters continues on its own line.
  function continueFrom(parent, child) {
    if (!parent) return child;
    if (!/^page\./.test(child)) return child;
    return parent + (parent.length + child.length > 120 ? '\n    ' : '') + child.replace(/^page\./, '.');
  }

  function pwChainExpr(t, recv, pageType) {
    var parent = pwExpr(t.parent, recv, pageType);
    if (!t.child) return parent;
    // Without a parent the child is rooted where the parent would have been.
    var child = pwExpr(t.child, parent ? 'Locator' : recv, pageType);
    return continueFrom(parent, child);
  }

  function pwFrameExpr(t, recv, pageType) {
    var peeled = I.unwrapFrames(t);
    if (!peeled.inner) return '';
    var expr = '';
    peeled.frames.forEach(function (f) {
      // Without a selector the frame is cross-origin; address it positionally.
      var arg = f.selector ? jq(f.selector) : jq('iframe >> nth=' + f.index);
      expr = continueFrom(expr, 'page.frameLocator(' + arg + ')');
    });
    return continueFrom(expr, pwExpr(peeled.inner, 'FrameLocator', pageType));
  }

  function pwLocator(target) { return pwExpr(target, 'Page', 'Page'); }

  // Text is compared as rendered (innerText), the way the recorder read it; a
  // sensitive field's value is compared against its environment variable (C2).
  function pwAssert(step, loc) {
    var t = step.assertType || 'toBeVisible';
    var v = step.value;
    // hasValue's failure message prints the expected value: a secret's assertion keeps
    // the retrying hasValue but rethrows with a message that names only the variable
    // (no cause, so the original is not printed either).
    if (I.sensitiveAssert(step)) {
      return 'try {\n    assertThat(' + loc + ').hasValue(' + secretExpr(step) + ');\n' +
        '} catch (AssertionError e) {\n    throw new AssertionError(' + jq(I.secretMismatch(step)) + ');\n}';
    }
    var map = {
      toBeVisible: 'isVisible()',
      toHaveText: 'hasText(' + jq(v) + ', new LocatorAssertions.HasTextOptions().setUseInnerText(true))',
      toContainText: 'containsText(' + jq(v) + ', new LocatorAssertions.ContainsTextOptions().setUseInnerText(true))',
      toHaveValue: 'hasValue(' + jq(v) + ')',
      toBeEnabled: 'isEnabled()',
      toBeChecked: String(v) === 'false' ? 'not().isChecked()' : 'isChecked()'
    };
    return I.callOn('assertThat(' + loc + ')', '.' + (map[t] || map.toBeVisible) + ';');
  }

  function pathsArg(files) {
    var paths = files.map(function (f) { return 'Paths.get(' + jq(f) + ')'; });
    if (paths.length === 1) return paths[0];
    return paths.length ? 'new Path[] {' + paths.join(', ') + '}' : 'new Path[0]';
  }

  function pwStatement(step) {
    var a = step.action;
    if (a === 'assert' && step.assertType === 'toHaveURL') return 'assertThat(page).hasURL(' + jq(urlOf(step)) + ');';
    if (a === 'goto') return 'page.navigate(' + jq(step.value || step.url || '') + ');';
    if (a === 'press') return 'page.keyboard().press(' + jq(step.value || step.key || 'Enter') + ');';
    if (a === 'viewport') return 'page.setViewportSize(' + I.vpW(step) + ', ' + I.vpH(step) + ');';
    var loc = pwLocator(step.target);
    if (!loc) return todo('"' + I.commentSafe(a) + '" step has no element locator');
    switch (a) {
      case 'assert': return pwAssert(step, loc);
      case 'click': case 'hover': case 'dblclick': case 'check': case 'uncheck':
        return I.callOn(loc, '.' + a + '();');
      // fill() also sets range/color/date inputs, so inputType needs no special case.
      case 'fill': return I.callOn(loc, '.fill(' + valueExpr(step) + ');');
      case 'upload': return uploadNote() + '\n' + I.callOn(loc, '.setInputFiles(' + pathsArg(I.uploadFiles(step.value)) + ');');
      case 'selectOption': {
        var many = I.multiValues(step);
        return I.callOn(loc, '.selectOption(' + (many ? 'new String[] {' + many.map(jq).join(', ') + '}' : valueExpr(step)) + ');');
      }
      default: return todo('unsupported step "' + I.commentSafe(a) + '"');
    }
  }

  function pwWrap(stmts, lang, steps, opts) {
    var body = (stmts || []).map(javaSafe);
    var field = testDataField(opts, '    ');
    var code = codeOnly(body.join('\n'));
    var imports = ['com.microsoft.playwright.Page', 'com.microsoft.playwright.junit.UsePlaywright', 'org.junit.jupiter.api.Test'];
    if (/\bAriaRole\./.test(code)) imports.push('com.microsoft.playwright.options.AriaRole');
    if (/\bLocator\./.test(code)) imports.push('com.microsoft.playwright.Locator');
    if (/\bFrameLocator\./.test(code)) imports.push('com.microsoft.playwright.FrameLocator');
    if (/\bLocatorAssertions\./.test(code)) imports.push('com.microsoft.playwright.assertions.LocatorAssertions');
    if (/\bnew Path\[/.test(code)) imports.push('java.nio.file.Path');
    if (/\bPaths\.get\(/.test(code)) imports.push('java.nio.file.Paths');
    if (field) imports.push('java.util.Map');
    var statics = /\bassertThat\(/.test(code) ? ['com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat'] : [];
    return importBlock(imports, statics) + '\n' +
      '@UsePlaywright\n' +
      'class RecordedTest {\n' +
      (field ? field + '\n' : '') +
      '    @Test\n' +
      '    void recordedTest(Page page) {\n' +
      (body.length ? I.indent(body, '        ') + '\n' : '') +
      '    }\n' +
      '}\n';
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  Selenium for Java
  // ════════════════════════════════════════════════════════════════════════════

  var BY = { css: 'By.cssSelector', id: 'By.id', name: 'By.name', xpath: 'By.xpath' };

  /** `<root>.findElement(By…)`: root is the driver or, in a chain, the parent element. */
  function selFind(by, selector, root) { return (root || 'driver') + '.findElement(' + BY[by] + '(' + jq(selector) + '))'; }

  // ── the Locatra helper (C9.4) ──────────────────────────────────────────────
  // Selenium has no getByRole / getByLabel / getByText: a role, label or text
  // target calls Locatra.find(root, kind, value[, name[, exact[, level, nth]]]), a
  // static nested class declared once per file (the in-page matcher every target
  // runs, codegen.js MATCH_JS, compacted and concatenated from literals). It waits up
  // to the driver's implicit wait, as findElement does, and throws when several
  // elements match.
  function helperCall(spec, root) {
    var args = [root, jq(spec.kind), jq(spec.value)];
    var full = spec.level || spec.nth >= 0;
    if (spec.name != null || spec.exact || full) args.push(spec.name != null ? jq(spec.name) : 'null');
    if (spec.exact || full) args.push(String(spec.exact));
    if (full) args.push(String(spec.level), String(spec.nth));
    return 'Locatra.find(' + args.join(', ') + ')';
  }

  // The class is a member of the test class / page object (indented once there), so
  // the script's literals start 8 columns in: `+ "…"` and the closing `;` leave
  // HELPER_WIDTH - 13 for the script, counted as escaped.
  var JS_WIDTH = I.HELPER_WIDTH - 13;

  var FIND_MEMBERS = [
    '',
    'static WebElement find(SearchContext root, String kind, String value) {',
    '    return find(root, kind, value, null, false, 0, -1);',
    '}',
    '',
    'static WebElement find(SearchContext root, String kind, String value, String name) {',
    '    return find(root, kind, value, name, false, 0, -1);',
    '}',
    '',
    'static WebElement find(SearchContext root, String kind, String value, String name, boolean exact) {',
    '    return find(root, kind, value, name, exact, 0, -1);',
    '}',
    '',
    '// Waits up to the implicit wait, as findElement does; several matches are an error.',
    'static WebElement find(',
    '        SearchContext root, String kind, String value, String name, boolean exact, int level, int nth) {',
    '    WebDriver driver = root instanceof WrapsDriver',
    '        ? ((WrapsDriver) root).getWrappedDriver() : (WebDriver) root;',
    '    Object scope = root instanceof WebDriver ? null : root;',
    '    String what = kind + " \\"" + value + "\\"" + (name != null ? " named \\"" + name + "\\"" : "")',
    '        + (exact ? " (exact)" : "");',
    '    long end = System.nanoTime() + driver.manage().timeouts().getImplicitWaitTimeout().toNanos();',
    '    while (true) {',
    '        List<WebElement> found = new ArrayList<>();',
    '        Object result = ((JavascriptExecutor) driver).executeScript(JS, kind, value, name, exact, level, scope);',
    '        if (result instanceof List<?>) {',
    '            for (Object item : (List<?>) result) found.add((WebElement) item);',
    '        }',
    '        if (found.size() > Math.max(nth, 0)) {',
    '            if (nth < 0 && found.size() > 1) {',
    '                String count = "Locatra: " + found.size() + " elements match ";',
    '                throw new WebDriverException(count + what + "; expected exactly one");',
    '            }',
    '            return found.get(Math.max(nth, 0));',
    '        }',
    '        if (System.nanoTime() - end >= 0) {',
    '            throw new NoSuchElementException("Locatra: no element matches " + what);',
    '        }',
    '        try {',
    '            Thread.sleep(100);',
    '        } catch (InterruptedException e) {',
    '            Thread.currentThread().interrupt();',
    '            throw new WebDriverException(e);',
    '        }',
    '    }',
    '}'
  ];

  // Text is compared as rendered (getText()), normalised like the recording. (?U)
  // makes \s match Unicode white space (e.g. no-break spaces), as JavaScript's \s
  // does; soft hyphens and zero-width spaces are dropped, as the recorder drops them.
  var TEXT_MEMBER = [
    '',
    '// The text as rendered: soft hyphens and zero-width spaces dropped, white space collapsed.',
    'static String text(WebElement el) {',
    '    return el.getText().replaceAll("[\\\\u00ad\\\\u200b]", "").replaceAll("(?U)\\\\s+", " ").trim();',
    '}'
  ];

  /** The Locatra class with the members `code` calls: find() (and the script it runs), text(). */
  function helperClass(code) {
    var find = I.uses(code, 'Locatra.find');
    var out = ['// ' + (find ? I.HELPER_BANNER : I.TEXT_BANNER), 'static final class Locatra {'];
    if (find) {
      var cost = function (c) { return c === '\\' || c === '"' ? 2 : 1; };
      var lines = I.matchScriptChunks(JS_WIDTH, cost).map(function (l, k) { return '    ' + (k ? '+ ' : '  ') + jq(l); });
      out.push('    private static final String JS =', lines.join('\n') + ';', '');
    }
    out.push('    private Locatra() {', '    }');
    if (find) out.push(I.indent(FIND_MEMBERS, '    '));
    if (I.uses(code, 'Locatra.text')) out.push(I.indent(TEXT_MEMBER, '    '));
    out.push('}');
    return out.join('\n');
  }

  var FRAME_JS = 'LOCATRA_FRAME_JS';

  /** A page script as a constant: literals concatenated, each line within HELPER_WIDTH once indented. */
  function constSource(name, note, js) {
    var parts = I.literalLines(js, I.HELPER_WIDTH - 13, jq);
    return '// ' + note + '\nprivate static final String ' + name + ' =\n    ' + parts.join('\n    + ') + ';';
  }

  /** The class members code needs (the frame script, the Locatra class), in order. */
  function selHelpers(code) {
    var out = [];
    if (I.uses(code, FRAME_JS)) out.push(constSource(FRAME_JS, I.FRAME_JS_NOTE, I.DEEP_IFRAME_JS));
    if (I.uses(code, I.SET_VALUE_NAME)) out.push(constSource(I.SET_VALUE_NAME, I.SET_VALUE_NOTE, I.SET_VALUE_JS));
    if (I.uses(code, 'Locatra')) out.push(helperClass(code));
    return out;
  }

  /**
   * One target as a `driver.findElement(...)` expression (frames are statements, not
   * part of it), or a Locatra.find(...) call. `root` is what the search starts from:
   * the driver, or a chain's parent element. An element in open shadow DOM is reached
   * host by host from the driver — a shadow root is searched with CSS only — ending
   * with its shadowCss (C3).
   */
  function selExpr(t, rel, root) {
    if (!t) return '';
    if (t.kind === 'frame') return selExpr(I.unwrapFrames(t).inner, false);
    var sh = I.shadowWalk(t);
    if (sh) {
      var el = selFind('css', sh.hosts[0]);
      var br = I.shadowBreak(sh) ? '\n    ' : '';
      sh.hosts.slice(1).concat(sh.css).forEach(function (sel) {
        el += br + '.getShadowRoot().findElement(By.cssSelector(' + jq(sel) + '))';
      });
      return el;
    }
    if (t.kind === 'chain') {
      var parent = selExpr(t.parent, rel, root);
      if (!t.child) return parent;
      // A child reached through shadow roots starts from the document.
      if (!parent || I.shadowWalk(t.child)) return selExpr(t.child, true);
      return selExpr(t.child, true, parent);
    }
    var spec = I.helperSpec(t);
    if (spec) return helperCall(spec, root || 'driver');
    switch (t.kind) {
      case 'testid': return selFind('css', '[' + I.cssIdent(t.attr) + '="' + I.attrSel(t.value) + '"]', root);
      case 'placeholder': return selFind('css', I.attrMatchSel('placeholder', t.value, t.exact), root);
      case 'altText': return selFind('css', I.attrMatchSel('alt', t.value, t.exact), root);
      case 'title': return selFind('css', I.attrMatchSel('title', t.value, t.exact), root);
      case 'xpath': return selFind('xpath', I.scopedXpath(t.value, rel), root);
      case 'id': return selFind('id', t.value, root);
      case 'name': return selFind('name', t.value, root);
      case 'css': default: return selFind('css', t.value || 'body', root);
    }
  }

  // An <iframe> inside shadow DOM is reached host by host: WebDriver searches a
  // shadow root with CSS only, one tree at a time.
  // Two hops or more go one per line.
  /** A line break before each hop of an <iframe>'s shadowPath once it is long. */
  function hopBreak(path) { return path.length > 2 || I.pathBreak(path) ? '\n    ' : ''; }

  function selFrameSwitch(frame) {
    if (frame.shadowPath) {
      var el = selFind('css', frame.shadowPath[0]);
      for (var i = 1; i < frame.shadowPath.length; i++) {
        el += hopBreak(frame.shadowPath) + '.getShadowRoot().findElement(By.cssSelector(' + jq(frame.shadowPath[i]) + '))';
      }
      return 'driver.switchTo().frame(' + el + ');';
    }
    if (frame.selector) return 'driver.switchTo().frame(' + selFind('css', frame.selector) + ');';
    // No selector (a cross-origin frame): the frame element, by its position among
    // the page's <iframe>s, shadow roots included (codegen.js DEEP_IFRAME_JS, declared
    // once per file as LOCATRA_FRAME_JS).
    return 'driver.switchTo().frame((WebElement) ((JavascriptExecutor) driver).executeScript(' +
      FRAME_JS + ', ' + I.seleniumFrameIndex(frame) + '));';
  }

  /** A block that looks the element up once: `WebElement el = …;` (scoped, so steps can repeat). */
  function selWithEl(loc, lines) {
    return '{\n    WebElement el = ' + loc + ';\n' + lines.map(function (l) { return '    ' + l; }).join('\n') + '\n}';
  }

  // isSelected() is always false for an ARIA checkbox (div[role=checkbox]), so its
  // aria-checked state counts too.
  function selChecked(el) {
    return el + '.isSelected() || "true".equals(' + el + '.getDomAttribute("aria-checked"))';
  }

  function selPress(value) {
    var raw = value == null || value === '' ? 'Enter' : value;
    var p = I.parseKeyCombo(raw);
    var keyArg = I.KEY_SELENIUM[p.key] ? 'Keys.' + I.KEY_SELENIUM[p.key] : (Array.from(String(p.key)).length === 1 ? jq(p.key) : null);
    // An unknown key never becomes ENTER — that would be a silently different test.
    if (!keyArg) return todo('press "' + I.commentSafe(raw) + '" - no Selenium key mapping');
    var mods = [];
    for (var i = 0; i < p.mods.length; i++) {
      if (!I.MOD_SELENIUM[p.mods[i]]) return todo('press "' + I.commentSafe(raw) + '" - modifier not supported');
      mods.push('Keys.' + I.MOD_SELENIUM[p.mods[i]]);
    }
    var down = mods.map(function (m) { return '.keyDown(' + m + ')'; }).join('');
    var up = mods.slice().reverse().map(function (m) { return '.keyUp(' + m + ')'; }).join('');
    // Three or four modifiers make a long chain: it continues on a second line.
    return 'new Actions(driver)' + down + (mods.length > 2 ? '\n    ' : '') + '.sendKeys(' + keyArg + ')' + up + '.perform();';
  }

  // The recorded size is the viewport (innerWidth x innerHeight); Selenium sizes the
  // whole window, so the browser chrome measured at run time is added.
  function selViewport(step) {
    // vpW/vpH are always positive integers (codegen.js validates them).
    var w = I.vpW(step);
    var h = I.vpH(step);
    return '{\n' +
      '    JavascriptExecutor js = (JavascriptExecutor) driver;\n' +
      '    int width = ((Number) js.executeScript(\n' +
      '        ' + jq('return ' + w + ' + window.outerWidth - window.innerWidth;') + ')).intValue();\n' +
      '    int height = ((Number) js.executeScript(\n' +
      '        ' + jq('return ' + h + ' + window.outerHeight - window.innerHeight;') + ')).intValue();\n' +
      '    driver.manage().window().setSize(new Dimension(width, height));\n' +
      '}';
  }

  // Normalised visible text, compared like Playwright's toHaveText (Locatra.text()).
  function selText(loc) { return 'Locatra.text(' + loc + ')'; }

  function selAssert(step, loc) {
    var t = step.assertType || 'toBeVisible';
    var v = step.value;
    switch (t) {
      case 'toHaveText': return 'assertEquals(' + jq(I.normText(v)) + ', ' + selText(loc) + ');';
      case 'toContainText': return 'assertTrue(' + selText(loc) + '.contains(' + jq(I.normText(v)) + '));';
      case 'toHaveValue':
        // A secret is compared without ever being printed in a failure message.
        if (I.sensitiveAssert(step)) {
          return 'assertTrue(' + secretExpr(step) + '.equals(' + loc + '.getDomProperty("value")), ' +
            jq(I.secretMismatch(step)) + ');';
        }
        return 'assertEquals(' + jq(v) + ', ' + loc + '.getDomProperty("value"));';
      case 'toBeEnabled': return 'assertTrue(' + loc + '.isEnabled());';
      case 'toBeChecked':
        return selWithEl(loc, [(String(v) === 'false' ? 'assertFalse(' : 'assertTrue(') + selChecked('el') + ');']);
      case 'toBeVisible': default: return 'assertTrue(' + loc + '.isDisplayed());';
    }
  }

  var SET_VALUE = function (loc, val) {
    return '((JavascriptExecutor) driver).executeScript(' + I.SET_VALUE_NAME + ', ' + loc + ', ' + val + ');';
  };

  function selTargetStatement(step) {
    var a = step.action;
    var loc = selExpr(step.target);
    if (!loc) return todo('"' + I.commentSafe(a) + '" step has no element locator');
    switch (a) {
      case 'assert': return selAssert(step, loc);
      case 'click': return loc + '.click();';
      case 'hover': return 'new Actions(driver).moveToElement(' + loc + ').perform();';
      case 'dblclick': return 'new Actions(driver).doubleClick(' + loc + ').perform();';
      // Only click when the state differs: a click toggles, so a re-run check
      // on an already-checked box would uncheck it.
      case 'check': return selWithEl(loc, ['if (!(' + selChecked('el') + ')) el.click();']);
      case 'uncheck': return selWithEl(loc, ['if (' + selChecked('el') + ') el.click();']);
      case 'fill': {
        var val = valueExpr(step);
        if (I.SET_VALUE_TYPES_SELENIUM.indexOf(step.inputType) !== -1) return SET_VALUE(loc, val);
        // clear first so a pre-filled field is replaced, not appended to
        return selWithEl(loc, ['el.clear();', 'el.sendKeys(' + val + ');']);
      }
      case 'upload': {
        var files = I.uploadFiles(step.value);
        if (!files.length) return loc + '.clear();';
        // A file input takes absolute paths; several files are newline-separated.
        var paths = files.map(function (f) { return 'Paths.get(' + jq(f) + ').toAbsolutePath().toString()'; });
        return uploadNote() + '\n' + loc + '.sendKeys(' + paths.join(' + "\\n" + ') + ');';
      }
      case 'selectOption': {
        var many = I.multiValues(step);
        if (!many) return 'new Select(' + loc + ').selectByVisibleText(' + valueExpr(step) + ');';
        // A multi-select keeps earlier choices: clear them, then pick each label.
        return '{\n    Select select = new Select(' + loc + ');\n    select.deselectAll();\n' + many.map(function (v) {
          return '    select.selectByVisibleText(' + jq(v) + ');';
        }).join('\n') + '\n}';
      }
      default: return todo('unsupported step "' + I.commentSafe(a) + '"');
    }
  }

  function selStatement(step) {
    var a = step.action;
    if (a === 'assert' && step.assertType === 'toHaveURL') {
      return 'new WebDriverWait(driver, Duration.ofSeconds(10)).until(ExpectedConditions.urlToBe(' + jq(urlOf(step)) + '));';
    }
    if (a === 'goto') return 'driver.get(' + jq(step.value || step.url || '') + ');';
    if (a === 'press') return selPress(step.value || step.key);
    if (a === 'viewport') return selViewport(step);
    var peeled = I.unwrapFrames(step.target);
    if (peeled.frames.length) {
      // Selenium has no frame-scoped locator: switch in, act, switch back out — or
      // every later step would run inside this frame.
      var lines = peeled.frames.map(selFrameSwitch);
      var body = {};
      for (var k in step) if (Object.prototype.hasOwnProperty.call(step, k)) body[k] = step[k];
      body.target = peeled.inner;
      lines.push(selStatement(body));
      lines.push('driver.switchTo().defaultContent();');
      return lines.join('\n');
    }
    return withNotes(ambiguousNote(step.target), selTargetStatement(step));
  }

  function selImports(code, extra) {
    var imports = ['org.openqa.selenium.WebDriver'].concat(extra || []);
    var uses = [
      [/\bBy\./, 'org.openqa.selenium.By'],
      [/\bDimension\(/, 'org.openqa.selenium.Dimension'],
      [/\bJavascriptExecutor\b/, 'org.openqa.selenium.JavascriptExecutor'],
      [/\bKeys\./, 'org.openqa.selenium.Keys'],
      [/\bWebElement\b/, 'org.openqa.selenium.WebElement'],
      [/\bnew Actions\(/, 'org.openqa.selenium.interactions.Actions'],
      [/\bExpectedConditions\./, 'org.openqa.selenium.support.ui.ExpectedConditions'],
      [/\bnew Select\(/, 'org.openqa.selenium.support.ui.Select'],
      [/\bnew WebDriverWait\(/, 'org.openqa.selenium.support.ui.WebDriverWait'],
      [/\bPaths\.get\(/, 'java.nio.file.Paths'],
      [/\bDuration\./, 'java.time.Duration'],
      // the Locatra helper class
      [/\bSearchContext\b/, 'org.openqa.selenium.SearchContext'],
      [/\bWrapsDriver\b/, 'org.openqa.selenium.WrapsDriver'],
      [/\bNoSuchElementException\(/, 'org.openqa.selenium.NoSuchElementException'],
      [/\bWebDriverException\(/, 'org.openqa.selenium.WebDriverException'],
      [/\bList</, 'java.util.List'],
      [/\bArrayList</, 'java.util.ArrayList']
    ];
    uses.forEach(function (u) { if (u[0].test(code)) imports.push(u[1]); });
    return imports;
  }

  function selWrap(stmts, lang, steps, opts) {
    var body = (stmts || []).map(javaSafe);
    var field = testDataField(opts, '    ');
    var decls = selHelpers(body.join('\n'));
    var code = codeOnly(body.concat(decls).join('\n'));
    var imports = selImports(code, [
      'org.junit.jupiter.api.AfterEach', 'org.junit.jupiter.api.BeforeEach', 'org.junit.jupiter.api.Test',
      'org.openqa.selenium.chrome.ChromeDriver', 'java.time.Duration'
    ]);
    if (field) imports.push('java.util.Map');
    var statics = [];
    ['assertEquals', 'assertFalse', 'assertTrue'].forEach(function (fn) {
      if (new RegExp('\\b' + fn + '\\(').test(code)) statics.push('org.junit.jupiter.api.Assertions.' + fn);
    });
    return importBlock(imports, statics) + '\n' +
      'class RecordedTest {\n' +
      (field ? field + '\n' : '') +
      '    private WebDriver driver;\n' +
      '\n' +
      '    @BeforeEach\n' +
      '    void setUp() {\n' +
      '        driver = new ChromeDriver();\n' +
      '        // Selenium has no auto-wait: give elements time to appear.\n' +
      '        driver.manage().timeouts().implicitlyWait(Duration.ofSeconds(10));\n' +
      '    }\n' +
      '\n' +
      '    @AfterEach\n' +
      '    void tearDown() {\n' +
      '        if (driver != null) driver.quit();\n' +
      '    }\n' +
      '\n' +
      '    @Test\n' +
      '    void recordedTest() {\n' +
      (body.length ? I.indent(body, '        ') + '\n' : '') +
      '    }\n' +
      (decls.length ? '\n' + I.indent([decls.join('\n\n')], '    ') + '\n' : '') +
      '}\n';
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  Page Objects
  // ════════════════════════════════════════════════════════════════════════════
  // Same model and member/helper semantics as the JS targets (codegen.js
  // pageObject): lowerCamelCase members, helpers fill<X>/select<X>/check<X>/
  // uncheck<X>/click<X>, a navigate() (goto is reserved in Java) when the page URL
  // is known. One public class per file, named like the download (<ClassName>.java).

  var JAVA_RESERVED = ('abstract assert boolean break byte case catch char class const continue default do double ' +
    'else enum extends final finally float for goto if implements import instanceof int interface long native new ' +
    'package private protected public return short static strictfp super switch synchronized this throw throws ' +
    'transient try void volatile while true false null var yield record sealed permits when module open ' +
    'getClass hashCode equals clone toString notify notifyAll wait finalize page driver navigate').split(' ');

  var PO_KINDS = ['input', 'textarea', 'select', 'checkbox', 'radio', 'button', 'link', 'other'];
  var PO_TEXT_ROLES = ['textbox', 'searchbox', 'combobox', 'spinbutton'];

  /** The helper actions an element gets: fill | select | check | uncheck | click. */
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

  function poClaim(base, used) {
    var id = base;
    if (JAVA_RESERVED.indexOf(id) !== -1) id += 'Element';
    var n = 2;
    var root = id;
    while (Object.prototype.hasOwnProperty.call(used, id)) id = root + n++;
    used[id] = true;
    return id;
  }

  function poMembers(model, render) {
    var used = {};
    var skipped = 0;
    var members = [];
    (Array.isArray(model.elements) ? model.elements : []).forEach(function (el) {
      if (!el || !el.target || !I.unwrapFrames(el.target).inner || !render(el.target)) { skipped++; return; }
      members.push({ el: el, id: poClaim(I.poIdent(el.name, false), used) });
    });
    members.forEach(function (m) {
      m.helpers = poActions(m.el).map(function (act) {
        return { act: act, id: poClaim(act + m.id.charAt(0).toUpperCase() + m.id.slice(1), used) };
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
    var lines = [comment('Page Object generated by Locatra' + (model.title ? ' for "' + I.commentSafe(model.title) + '"' : '') + '.')];
    if (model.pageUrl) lines.push(comment('Page: ' + I.commentSafe(model.pageUrl).slice(0, 80)));
    if (skipped) lines.push(comment('NOTE: ' + skipped + ' element(s) without a usable locator were left out.'));
    return lines.join('\n') + '\n';
  }

  function poPlaywright(model) {
    var cls = I.poClassName(model);
    // A page object called "Page" would shadow Playwright's Page: spell that one out.
    var pageType = cls === 'Page' ? 'com.microsoft.playwright.Page' : 'Page';
    var render = function (t) { return pwExpr(t, 'Page', pageType); };
    var info = poMembers(model, render);
    var url = model.pageUrl ? String(model.pageUrl) : '';
    var out = ['public final ' + pageType + ' page;'];
    info.members.forEach(function (m) { out.push('public final Locator ' + m.id + ';'); });
    out.push('');
    var ctor = ['this.page = page;'];
    info.members.forEach(function (m) {
      ctor = ctor.concat(poNotes(m.el), ['this.' + m.id + ' = ' + render(m.el.target) + ';']);
    });
    out.push('public ' + cls + '(' + pageType + ' page) {', I.indent(ctor, '    '), '}');
    if (url) out.push('', 'public void navigate() {', '    this.page.navigate(' + jq(url) + ');', '}');
    info.members.forEach(function (m) {
      m.helpers.forEach(function (h) {
        var recv = 'this.' + m.id;
        out.push('');
        if (h.act === 'fill') out.push('public void ' + h.id + '(String value) {', '    ' + recv + '.fill(value);', '}');
        else if (h.act === 'select') out.push('public void ' + h.id + '(String value) {', '    ' + recv + '.selectOption(value);', '}');
        else out.push('public void ' + h.id + '() {', '    ' + recv + '.' + h.act + '();', '}');
      });
    });
    var code = codeOnly(out.join('\n'));
    var imports = [];
    if (pageType === 'Page') imports.push('com.microsoft.playwright.Page');
    if (/\bLocator\b/.test(code)) imports.push('com.microsoft.playwright.Locator');
    if (/\bFrameLocator\./.test(code)) imports.push('com.microsoft.playwright.FrameLocator');
    if (/\bAriaRole\./.test(code)) imports.push('com.microsoft.playwright.options.AriaRole');
    return poHeader(model, info.skipped) + importBlock(imports, []) + '\n' +
      'public class ' + cls + ' {\n' + I.indent(out, '    ') + '\n}\n';
  }

  // Elements are looked up on every access (never cached), so a re-rendered page
  // cannot hand back a stale element. When any element lives in a frame, every
  // lookup first returns to the top document and then enters that element's frames.
  function poSelenium(model) {
    var cls = I.poClassName(model);
    var render = function (t) { return selExpr(t); };
    var info = poMembers(model, render);
    var url = model.pageUrl ? String(model.pageUrl) : '';
    var anyFrames = info.members.some(function (m) { return I.unwrapFrames(m.el.target).frames.length > 0; });
    var reset = anyFrames ? ['driver.switchTo().defaultContent();'] : [];
    var out = ['public final WebDriver driver;', '', 'public ' + cls + '(WebDriver driver) {', '    this.driver = driver;', '}'];
    if (url) out.push('', 'public void navigate() {', I.indent(reset.concat(['driver.get(' + jq(url) + ');']), '    '), '}');
    info.members.forEach(function (m) {
      var lines = reset.concat(I.unwrapFrames(m.el.target).frames.map(selFrameSwitch), ['return ' + render(m.el.target) + ';']);
      out.push('');
      out = out.concat(poNotes(m.el, true));
      out.push('public WebElement ' + m.id + '() {', I.indent(lines, '    '), '}');
    });
    info.members.forEach(function (m) {
      m.helpers.forEach(function (h) {
        var get = m.id + '()';
        var lines;
        var sig = h.act === 'fill' || h.act === 'select' ? '(String value)' : '()';
        if (h.act === 'fill') {
          lines = I.SET_VALUE_TYPES_SELENIUM.indexOf(m.el.inputType) !== -1
            ? [SET_VALUE(get, 'value')]
            : ['WebElement el = ' + get + ';', 'el.clear();', 'el.sendKeys(value);'];
        } else if (h.act === 'select') {
          lines = ['new Select(' + get + ').selectByVisibleText(value);'];
        } else if (h.act === 'check' || h.act === 'uncheck') {
          lines = ['WebElement el = ' + get + ';',
            'if (' + (h.act === 'check' ? '!(' + selChecked('el') + ')' : selChecked('el')) + ') el.click();'];
        } else {
          lines = [get + '.click();'];
        }
        out.push('', 'public void ' + h.id + sig + ' {', I.indent(lines, '    '), '}');
      });
    });
    var decls = selHelpers(out.join('\n'));
    if (decls.length) out.push('', decls.join('\n\n'));
    var code = codeOnly(out.join('\n'));
    var imports = selImports(code, []);
    return poHeader(model, info.skipped) + importBlock(imports, []) + '\n' +
      'public class ' + cls + ' {\n' + I.indent(out, '    ') + '\n}\n';
  }

  // ── registration ────────────────────────────────────────────────────────────
  var JAVA = { id: 'java', label: 'Java', ext: '.java' };

  C.registerTarget({
    framework: { id: 'playwright', label: 'Playwright' },
    languages: [JAVA],
    locatorExpr: function (target) { return pwLocator(target); },
    actionStatement: function (step) { return javaSafe(pwStatement(step)); },
    wrapScript: pwWrap,
    // LLCodegen's own TODOs (unknown action, no locator) come through here too.
    todo: function (text) { return todo(text); },
    comment: function (text) { return comment(text); },
    pageObject: function (model) { return poPlaywright(model || {}); }
  });

  C.registerTarget({
    framework: { id: 'selenium', label: 'Selenium' },
    languages: [JAVA],
    locatorExpr: function (target, lang, rel) { return selExpr(target, !!rel); },
    actionStatement: function (step) { return javaSafe(selStatement(step)); },
    wrapScript: selWrap,
    // The class members a locator expression needs (LLCodegen.locatorSnippet).
    helpers: function (code) { return selHelpers(code); },
    // LLCodegen's own TODOs (unknown action, no locator) come through here too.
    todo: function (text) { return todo(text); },
    comment: function (text) { return comment(text); },
    pageObject: function (model) { return poSelenium(model || {}); }
  });
})(typeof window !== 'undefined' ? window : globalThis);
