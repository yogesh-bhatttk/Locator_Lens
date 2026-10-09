// Locatra – codegen.js
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
//   { kind: 'frame', selector, index, child }  — child inside an iframe. `selector`
//       addresses the <iframe> in its parent document; when the frame is
//       cross-origin its element is unreachable, so only `index` is known and the
//       generators fall back to positional frame addressing. Nests for deep frames.
//       Optional `shadowPath` (an <iframe> inside shadow DOM): one CSS selector per
//       tree, outermost first — the first host in the parent document, each further
//       host in the previous host's shadow root, the <iframe> in the last root.
//       Selenium and Cypress walk it host by host, since neither one's CSS pierces
//       shadow roots; Playwright keeps using `selector`, which its CSS resolves
//       across the composed tree.
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
  // Every C0 control, DEL and the two Unicode line separators are written as escapes:
  // Python rejects a raw NUL in source outright, and a raw control character in a
  // pasted test is invisible at best. \xNN and \uNNNN mean the same thing in JS/TS
  // and Python string literals.
  var NAMED_ESCAPES = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
  function escapeControls(s) {
    // eslint-disable-next-line no-control-regex
    return s.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, function (c) {
      if (NAMED_ESCAPES[c]) return NAMED_ESCAPES[c];
      var code = c.charCodeAt(0);
      if (code > 0xff) return '\\u' + code.toString(16);
      return '\\x' + (code < 16 ? '0' : '') + code.toString(16);
    });
  }

  function q(value, lang) {
    var s = escapeControls(String(value == null ? '' : value).replace(/\\/g, '\\\\'));
    if (lang === 'python') {
      return '"' + s.replace(/"/g, '\\"') + '"';
    }
    return "'" + s.replace(/'/g, "\\'") + "'";
  }

  // Escape a value for use inside a double-quoted CSS attribute selector, e.g.
  // [name="..."]. Without this, a value containing a double quote (placeholders and
  // aria-labels routinely do: 'Search "all" items') closed the selector early and
  // emitted code that throws at runtime. q() then escapes the result again for
  // whichever host language wraps it. A raw newline is not allowed inside a CSS
  // string either, so control characters become CSS hex escapes.
  function attrSel(value) {
    return String(value == null ? '' : value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, function (c) { return '\\' + c.charCodeAt(0).toString(16) + ' '; });
  }

  // Collapse whitespace the way Playwright's text/name matching (and the recorder)
  // do, so Selenium/Cypress compare like with like.
  function normWs(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
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

  // ── Pluggable targets ───────────────────────────────────────────────────────
  // Additional frameworks/languages (Java, C#, WebdriverIO, …) live in their own files
  // and register here, so each can be built and tested without touching this one:
  //   LLCodegen.registerTarget({
  //     framework: { id, label },        // new (webdriverio) or existing (playwright)
  //     languages: [{ id, label, ext }], // e.g. { id: 'java', label: 'Java', ext: '.java' }
  //     locatorExpr(target, lang, rel), actionStatement(step, lang),
  //     wrapScript(stmts, lang, steps, opts), pageObject(model, lang),
  //     todo(text, lang)?, comment(text, lang)?   // optional, see below
  //   });
  // The core still turns an unknown action, or a step without an element locator,
  // into a TODO before delegating; when the target defines todo(text, lang) it
  // renders it (text is e.g. 'unsupported step "x"'), else when it defines
  // comment(text, lang) it renders the comment 'TODO: ' + text, else the TODO is a
  // `// TODO: …` line (`# TODO: …` for a language id of 'python').
  // wrapScript's opts.variables is normalised (see wrapScript); a step's test-data
  // reference is _internals.variableRefName(step).
  // A registered framework×language pair takes precedence for that pair only; the
  // shared helpers it needs are on LLCodegen._internals.
  var TARGETS = {};
  var BUILTIN_LANGS = ['typescript', 'javascript', 'python'];
  var BUILTIN_FWS = ['playwright', 'selenium', 'cypress'];

  function targetFor(fw, lang) {
    return Object.prototype.hasOwnProperty.call(TARGETS, fw + ':' + lang) ? TARGETS[fw + ':' + lang] : null;
  }

  // A plug-in framework asked for a language it didn't register (webdriverio +
  // python) used to fall through to the built-in Playwright path — Playwright code
  // labelled as the other framework. Use that framework's first registered language.
  function pluginLang(fw, lang) {
    if (targetFor(fw, lang) || BUILTIN_FWS.indexOf(fw) !== -1) return lang;
    var prefix = fw + ':';
    for (var key in TARGETS) {
      if (Object.prototype.hasOwnProperty.call(TARGETS, key) && key.indexOf(prefix) === 0) return key.slice(prefix.length);
    }
    return lang;
  }

  function registerTarget(def) {
    if (!def || !def.framework || !def.framework.id || !Array.isArray(def.languages) || !def.languages.length) {
      throw new Error('registerTarget: framework.id and languages[] are required');
    }
    ['locatorExpr', 'actionStatement', 'wrapScript', 'pageObject'].forEach(function (fn) {
      if (typeof def[fn] !== 'function') throw new Error('registerTarget: ' + fn + '() is required');
    });
    var fwId = def.framework.id;
    if (!FRAMEWORKS.some(function (f) { return f.id === fwId; })) {
      FRAMEWORKS.push({ id: fwId, label: def.framework.label || fwId });
    }
    def.languages.forEach(function (l) {
      if (!LANGUAGES.some(function (x) { return x.id === l.id; })) LANGUAGES.push({ id: l.id, label: l.label || l.id });
      if (l.ext) LANG_EXT[l.id] = l.ext;
      TARGETS[fwId + ':' + l.id] = def;
    });
    return def;
  }

  // File extension per language, for page-object and test downloads.
  var LANG_EXT = { typescript: '.ts', javascript: '.js', python: '.py' };

  // Cypress has no Python bindings. Built-in frameworks pair with the built-in
  // languages; anything else is valid only where a target registered it.
  function isValidCombo(fw, lang) {
    if (targetFor(fw, lang)) return true;
    if (BUILTIN_FWS.indexOf(fw) === -1 || BUILTIN_LANGS.indexOf(lang) === -1) return false;
    if (fw === 'cypress' && lang === 'python') return false;
    return true;
  }
  function languagesFor(fw) {
    return LANGUAGES.filter(function (l) { return isValidCombo(fw, l.id); });
  }

  // ── implicit ARIA role → selector helpers (for Selenium/Cypress) ────────────
  // One table drives both the CSS (Cypress, unnamed Selenium) and the XPath (named
  // Selenium) form, so the two can never disagree. It mirrors Playwright's implicit
  // role mapping (injected roleUtils): a native element only carries its implicit
  // role when it has no explicit role attribute, hence the :not([role]) on each.
  //   tag        element name
  //   typeIn     input types (any listed; 'text' also covers a missing type)
  //   typeNotIn  input types excluded
  //   has/lacks  attributes that must be present / absent
  //   notEmpty   attribute that, when present, must not be ""
  //   inGrid     only inside a [role=grid]/[role=treegrid] table
  var TEXTBOX_EXCLUDED = ['hidden', 'file', 'button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'number', 'range', 'search'];
  var ROLE_NATIVE = {
    button: [{ tag: 'button' }, { tag: 'input', typeIn: ['button', 'submit', 'reset', 'image', 'file'] }],
    link: [{ tag: 'a', has: ['href'] }, { tag: 'area', has: ['href'] }],
    checkbox: [{ tag: 'input', typeIn: ['checkbox'] }],
    radio: [{ tag: 'input', typeIn: ['radio'] }],
    textbox: [{ tag: 'textarea' }, { tag: 'input', typeNotIn: TEXTBOX_EXCLUDED, lacks: ['list'] }],
    searchbox: [{ tag: 'input', typeIn: ['search'], lacks: ['list'] }],
    combobox: [{ tag: 'select', lacks: ['multiple'] }, { tag: 'input', typeIn: ['text', 'email', 'tel', 'url', 'search'], has: ['list'] }],
    listbox: [{ tag: 'select', has: ['multiple'] }, { tag: 'datalist' }],
    option: [{ tag: 'option' }],
    spinbutton: [{ tag: 'input', typeIn: ['number'] }],
    slider: [{ tag: 'input', typeIn: ['range'] }],
    heading: [{ tag: 'h1' }, { tag: 'h2' }, { tag: 'h3' }, { tag: 'h4' }, { tag: 'h5' }, { tag: 'h6' }],
    img: [{ tag: 'img', notEmpty: 'alt' }, { tag: 'svg' }],
    list: [{ tag: 'ul' }, { tag: 'ol' }, { tag: 'menu' }],
    listitem: [{ tag: 'li' }],
    table: [{ tag: 'table' }],
    row: [{ tag: 'tr' }],
    rowgroup: [{ tag: 'thead' }, { tag: 'tbody' }, { tag: 'tfoot' }],
    cell: [{ tag: 'td' }],
    gridcell: [{ tag: 'td', inGrid: true }],
    columnheader: [{ tag: 'th', typeAttr: 'scope', typeNotIn: ['row', 'rowgroup'] }],
    rowheader: [{ tag: 'th', typeAttr: 'scope', typeIn: ['row', 'rowgroup'] }],
    navigation: [{ tag: 'nav' }],
    main: [{ tag: 'main' }],
    dialog: [{ tag: 'dialog' }],
    form: [{ tag: 'form', has: ['aria-label'] }, { tag: 'form', has: ['aria-labelledby'] }],
    region: [{ tag: 'section', has: ['aria-label'] }, { tag: 'section', has: ['aria-labelledby'] }],
    banner: [{ tag: 'header' }],
    contentinfo: [{ tag: 'footer' }],
    complementary: [{ tag: 'aside' }],
    article: [{ tag: 'article' }],
    group: [{ tag: 'fieldset' }, { tag: 'details' }, { tag: 'optgroup' }],
    separator: [{ tag: 'hr' }],
    progressbar: [{ tag: 'progress' }],
    meter: [{ tag: 'meter' }],
    status: [{ tag: 'output' }],
    paragraph: [{ tag: 'p' }],
    figure: [{ tag: 'figure' }],
    term: [{ tag: 'dt' }, { tag: 'dfn' }],
    definition: [{ tag: 'dd' }],
    blockquote: [{ tag: 'blockquote' }],
    caption: [{ tag: 'caption' }],
    code: [{ tag: 'code' }],
    emphasis: [{ tag: 'em' }],
    strong: [{ tag: 'strong' }],
    deletion: [{ tag: 'del' }],
    insertion: [{ tag: 'ins' }],
    mark: [{ tag: 'mark' }],
    search: [{ tag: 'search' }]
  };

  /** The native alternatives for a role, narrowed to one heading level if given. */
  function roleNatives(role, level) {
    var natives = ROLE_NATIVE[role] || [];
    if (role === 'heading' && level) {
      natives = natives.filter(function (n) { return n.tag === 'h' + level; });
    }
    return natives;
  }

  function nativeCss(n) {
    var attrPart = '';
    (n.has || []).forEach(function (a) { attrPart += '[' + a + ']'; });
    (n.lacks || []).forEach(function (a) { attrPart += ':not([' + a + '])'; });
    if (n.notEmpty) attrPart += ':not([' + n.notEmpty + '=""])';
    var typeAttr = n.typeAttr || 'type';
    (n.typeNotIn || []).forEach(function (t) { attrPart += ':not([' + typeAttr + '="' + t + '"])'; });
    attrPart += ':not([role])';
    var heads = [n.tag];
    if (n.typeIn) {
      heads = n.typeIn.map(function (t) { return n.tag + '[' + typeAttr + '="' + t + '"]'; });
      if (n.typeIn.indexOf('text') !== -1) heads.unshift(n.tag + ':not([' + typeAttr + '])');
    }
    var prefixes = n.inGrid ? ['[role="grid"] ', '[role="treegrid"] '] : [''];
    var out = [];
    prefixes.forEach(function (p) { heads.forEach(function (h) { out.push(p + h + attrPart); }); });
    return out;
  }

  function nativeXpath(n) {
    var parts = ['self::' + n.tag, 'not(@role)'];
    if (n.tag === 'svg') parts[0] = 'local-name()="svg"'; // SVG namespace: self::svg misses it
    var typeAttr = '@' + (n.typeAttr || 'type');
    if (n.typeIn) {
      var any = n.typeIn.map(function (t) { return typeAttr + '="' + t + '"'; });
      if (n.typeIn.indexOf('text') !== -1) any.unshift('not(' + typeAttr + ')');
      parts.push('(' + any.join(' or ') + ')');
    }
    (n.typeNotIn || []).forEach(function (t) { parts.push('not(' + typeAttr + '="' + t + '")'); });
    (n.has || []).forEach(function (a) { parts.push('@' + a); });
    (n.lacks || []).forEach(function (a) { parts.push('not(@' + a + ')'); });
    if (n.notEmpty) parts.push('not(@' + n.notEmpty + '="")');
    if (n.inGrid) parts.push('ancestor::table[@role="grid" or @role="treegrid"]');
    return '(' + parts.join(' and ') + ')';
  }

  function explicitRole(role, level) {
    return { css: '[role="' + attrSel(role) + '"]' + (level ? '[aria-level="' + level + '"]' : ''),
      xpath: '(@role=' + xpathLiteral(role) + (level ? ' and @aria-level="' + level + '"' : '') + ')' };
  }

  function roleCss(role, level) {
    var sels = [];
    roleNatives(role, level).forEach(function (n) { sels = sels.concat(nativeCss(n)); });
    sels.push(explicitRole(role, level).css);
    return sels.join(', ');
  }

  function roleNodeXpath(role, level) {
    var alts = roleNatives(role, level).map(nativeXpath);
    alts.push(explicitRole(role, level).xpath);
    return alts.join(' or ');
  }

  // ── accessible-name / label matching in XPath 1.0 (Selenium) ───────────────
  // Playwright's getByRole name and getByLabel do not look at text content alone: a
  // form control is named by <label for>, a wrapping <label>, aria-labelledby,
  // aria-label, title, placeholder, or (buttons) its value. `contains` is
  // case-sensitive here — the recorded name comes from the element itself, so it is
  // never missed, and it can only match fewer elements than Playwright's
  // case-insensitive default.
  function xpMatch(expr, lit, exact) {
    return exact ? 'normalize-space(' + expr + ')=' + lit : 'contains(normalize-space(' + expr + '), ' + lit + ')';
  }

  // Only the name sources a role can actually use are emitted, which keeps the
  // generated XPath readable: labels, values and placeholders are form-control
  // sources; text content names everything else (and ARIA widgets like
  // div[role=checkbox]).
  var LABELLED_ROLES = ['button', 'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'spinbutton', 'slider', 'meter', 'progressbar', 'status'];
  var PLACEHOLDER_ROLES = ['textbox', 'searchbox', 'combobox'];
  var ALT_ROLES = ['img', 'button', 'link'];

  // Strict precedence, as in Playwright's accessible-name computation: the first
  // source that is present decides the name, so a later source can never add a
  // match (a button with aria-label="Close" is not also named by its text).
  // Each source is a [present, matches] pair; a match implies presence.
  function nameXpath(name, exact, role) {
    var lit = xpathLiteral(normWs(name));
    var m = function (e) { return xpMatch(e, lit, exact); };
    var has = function (e) { return 'normalize-space(' + e + ')!=""'; };
    var formish = LABELLED_ROLES.indexOf(role) !== -1;
    var sources = [
      ['@aria-labelledby', '@aria-labelledby = //*[@id][' + m('.') + ']/@id'],
      [has('@aria-label'), m('@aria-label')]
    ];
    if (formish) {
      sources.push([
        '(@id and @id = //label[' + has('.') + ']/@for) or ancestor::label[' + has('.') + ']',
        '(@id and @id = //label[' + m('.') + ']/@for) or ancestor::label[' + m('.') + ']'
      ]);
    }
    if (role === 'button') {
      var btn = 'self::input and (@type="button" or @type="submit" or @type="reset")';
      sources.push(['(' + btn + ' and ' + has('@value') + ')', '(' + btn + ' and ' + m('@value') + ')']);
    }
    if (ALT_ROLES.indexOf(role) !== -1) {
      var altEl = 'self::img or self::area or (self::input and @type="image")';
      sources.push(['((' + altEl + ') and ' + has('@alt') + ')', '((' + altEl + ') and ' + m('@alt') + ')']);
    }
    var guard = function (e) { return formish ? '(not(self::input or self::select or self::textarea) and (' + e + '))' : '(' + e + ')'; };
    sources.push([guard(has('.') + ' or .//img[' + has('@alt') + ']'), guard(m('.') + ' or .//img[' + m('@alt') + ']')]);
    sources.push([has('@title'), m('@title')]);
    if (PLACEHOLDER_ROLES.indexOf(role) !== -1) sources.push([has('@placeholder'), m('@placeholder')]);
    var expr = sources[sources.length - 1][1];
    for (var i = sources.length - 2; i >= 0; i--) {
      expr = '(' + sources[i][1] + ') or (not(' + sources[i][0] + ') and (' + expr + '))';
    }
    return expr;
  }


  var LABELABLE_XPATH = '(self::input and not(@type="hidden")) or self::textarea or self::select or self::button or self::meter or self::output or self::progress';
  var LABELABLE_CSS = 'input:not([type="hidden"]), textarea, select, button, meter, output, progress, [aria-label], [aria-labelledby]';

  function labelXpath(text, exact) {
    var lit = xpathLiteral(normWs(text));
    var m = function (e) { return xpMatch(e, lit, exact); };
    return '(@aria-labelledby and @aria-labelledby = //*[@id][' + m('.') + ']/@id)' +
      ' or ' + m('@aria-label') +
      ' or ((' + LABELABLE_XPATH + ') and ((@id and @id = //label[' + m('.') + ']/@for) or ancestor::label[' + m('.') + ']))';
  }

  // Deepest element whose text matches — `//*[contains(., X)]` alone returns <html>
  // first, because every ancestor's string-value contains the text too.
  var TEXT_SKIP = 'self::script or self::style or self::noscript or self::template';
  function textXpath(text, exact, rel) {
    var lit = xpathLiteral(normWs(text));
    var m = xpMatch('.', lit, exact);
    return (rel ? './/*' : '//*') + '[not(ancestor-or-self::head or ' + TEXT_SKIP + ') and ' + m +
      ' and not(.//*[not(' + TEXT_SKIP + ') and ' + m + '])]';
  }

  // ── Cypress: the accessible-name helper emitted once per spec ───────────────
  // Cypress has no getByRole/getByLabel and no XPath, so role-with-name and label
  // locators select the candidate elements by CSS and narrow them with .filter()
  // through this helper. `$T{...}` holds TypeScript-only annotations.
  var CY_HELPER_NAME = 'locatraMatch';
  var CY_HELPER_SRC = [
    '// Locatra: match an element by its accessible name (kind \'name\') or by its label',
    '// (kind \'label\') the way Playwright\'s getByRole / getByLabel do.',
    'function locatraMatch(el$T{: HTMLElement}, kind$T{: string}, text$T{: string}, exact$T{?: boolean})$T{: boolean} {',
    '  const norm = (s$T{?: string | null})$T{: string} => String(s == null ? \'\' : s).replace(/\\s+/g, \' \').trim();',
    '  const hit = (s$T{?: string | null})$T{: boolean} => {',
    '    const v = norm(s);',
    '    return exact ? v === text : v !== \'\' && v.indexOf(text) !== -1;',
    '  };',
    '  const doc = el.ownerDocument;',
    '  const byIds = (ids$T{: string | null})$T{: string} => norm((ids || \'\').split(/\\s+/).map((id) => {',
    '    const n = id ? doc.getElementById(id) : null;',
    '    return n ? n.textContent : \'\';',
    '  }).join(\' \'));',
    '  const labels = Array.from((el$T{ as HTMLInputElement}).labels || []).map((l) => l.textContent).join(\' \');',
    '  if (kind === \'label\') {',
    '    return hit(byIds(el.getAttribute(\'aria-labelledby\'))) || hit(el.getAttribute(\'aria-label\')) || hit(labels);',
    '  }',
    '  const tag = el.tagName.toLowerCase();',
    '  const type = (el.getAttribute(\'type\') || \'\').toLowerCase();',
    '  const content = (n$T{: Node})$T{: string} => {',
    '    if (n.nodeType === 3) return n.nodeValue || \'\';',
    '    if (n.nodeType !== 1) return \'\';',
    '    const e = n$T{ as Element};',
    '    const t = e.tagName.toLowerCase();',
    '    if (t === \'script\' || t === \'style\' || t === \'template\' || e.getAttribute(\'aria-hidden\') === \'true\') return \'\';',
    '    if (e !== el && e.getAttribute(\'aria-label\')) return \' \' + e.getAttribute(\'aria-label\') + \' \';',
    '    if (t === \'img\') return \' \' + (e.getAttribute(\'alt\') || \'\') + \' \';',
    '    return Array.from(e.childNodes).map(content).join(\'\');',
    '  };',
    '  let name = byIds(el.getAttribute(\'aria-labelledby\')) || norm(el.getAttribute(\'aria-label\')) || norm(labels);',
    '  if (!name && tag === \'input\' && [\'button\', \'submit\', \'reset\'].indexOf(type) !== -1) name = norm((el$T{ as HTMLInputElement}).value);',
    '  if (!name && (tag === \'img\' || tag === \'area\' || (tag === \'input\' && type === \'image\'))) name = norm(el.getAttribute(\'alt\'));',
    '  if (!name && [\'input\', \'select\', \'textarea\'].indexOf(tag) === -1) name = norm(content(el));',
    '  if (!name) name = norm(el.getAttribute(\'title\')) || norm(el.getAttribute(\'placeholder\'));',
    '  return hit(name);',
    '}'
  ];
  function cyHelperSource(lang) {
    var ts = lang === 'typescript';
    return CY_HELPER_SRC.map(function (l) {
      return l.replace(/\$T\{([^}]*)\}/g, function (m, t) { return ts ? t : ''; });
    }).join('\n');
  }

  // ── Cypress: reading a secret, emitted once per spec when a step needs it ────
  // Cypress 16 removed Cypress.env(); cy.env() (added in Cypress 15) replaces it but
  // does not exist in older versions. The helper uses whichever this Cypress has and
  // yields the value as a chain, so one spec runs on both. The value is never logged.
  // Casts to any keep it type-correct against either version's typings.
  var CY_SECRET_NAME = 'locatraSecret';
  var CY_SECRET_SRC = [
    '// Locatra: read a secret from the Cypress environment (CYPRESS_<NAME> or the env config)',
    '// without logging it. Cypress 16 removed Cypress.env(); cy.env() replaces it (Cypress >= 15).',
    'function locatraSecret(name$T{: string})$T{: Cypress.Chainable<string>} {',
    '  const c$T{: any} = cy;',
    '  if (typeof c.env === \'function\') {',
    '    return c.env([name], { log: false }).then((vars$T{: Record<string, unknown>}) => String(vars[name] ?? \'\'));',
    '  }',
    '  return cy.wrap(String((Cypress$T{ as any}).env(name) ?? \'\'), { log: false });',
    '}'
  ];
  function cySecretSource(lang) {
    var ts = lang === 'typescript';
    return CY_SECRET_SRC.map(function (l) {
      return l.replace(/\$T\{([^}]*)\}/g, function (m, t) { return ts ? t : ''; });
    }).join('\n');
  }
  function usesCySecret(stmts) {
    return new RegExp('^\\s*' + CY_SECRET_NAME + '\\(', 'm').test(stmts.join('\n'));
  }
  /** The helpers a set of Cypress statements calls, as source lines to prepend. */
  function cyHelpers(stmts, lang) {
    var out = [];
    if (usesCyHelper(stmts)) out.push(cyHelperSource(lang));
    if (usesCySecret(stmts)) out.push(cySecretSource(lang));
    return out;
  }

  function cyFilter(kind, text, exact, lang) {
    return '.filter((_, el) => ' + CY_HELPER_NAME + '(el, ' + q(kind, lang) + ', ' + q(normWs(text), lang) +
      (exact ? ', true' : '') + '))';
  }

  // Regex literal for an exact cy.contains(): whole (whitespace-trimmed) text only.
  function cyExactTextRegex(text) {
    var body = normWs(text)
      .replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
      .replace(/ /g, '\\s+');
    body = escapeControls(body);
    return '/^\\s*' + body + '\\s*$/';
  }

  // ── key name mapping (recorder captures DOM e.key like "Enter") ─────────────
  var KEY_CYPRESS = { Enter: '{enter}', Escape: '{esc}', Backspace: '{backspace}', Delete: '{del}', ArrowUp: '{uparrow}', ArrowDown: '{downarrow}', ArrowLeft: '{leftarrow}', ArrowRight: '{rightarrow}', Home: '{home}', End: '{end}', PageUp: '{pageup}', PageDown: '{pagedown}', Insert: '{insert}' };
  // Key names cy.realPress() (cypress-real-events) accepts — a subset of its
  // keyCodeDefinitions that matches DOM e.key values one-to-one. Space is 'Space'.
  var REAL_PRESS_MODS = ['Control', 'Alt', 'Shift', 'Meta'];
  var REAL_PRESS_NAMED = ['Enter', 'Tab', 'Escape', 'Space', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  for (var fk = 1; fk <= 24; fk++) REAL_PRESS_NAMED.push('F' + fk);
  var REAL_PRESS_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ*+-;=,.`[\\]\'/)!@#$%^&(:<_>?~{|}"';
  var KEY_SELENIUM = { Enter: 'ENTER', Tab: 'TAB', Escape: 'ESCAPE', Backspace: 'BACK_SPACE', Delete: 'DELETE', ArrowUp: 'ARROW_UP', ArrowDown: 'ARROW_DOWN', ArrowLeft: 'ARROW_LEFT', ArrowRight: 'ARROW_RIGHT', ' ': 'SPACE', Space: 'SPACE', Home: 'HOME', End: 'END', PageUp: 'PAGE_UP', PageDown: 'PAGE_DOWN', Insert: 'INSERT', F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6', F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12' };
  var MOD_SELENIUM = { Shift: 'SHIFT', Control: 'CONTROL', Alt: 'ALT', Meta: 'META' };

  /** Split a Playwright-style key combo ('Shift+Tab', 'Control++', ' ') into parts. */
  function parseKeyCombo(value) {
    var v = String(value == null ? '' : value);
    if (v === '' || v === '+') return { mods: [], key: v };
    var mods, key;
    if (/\+\+$/.test(v)) {
      key = '+';
      mods = v.slice(0, -2).split('+');
    } else {
      var parts = v.split('+');
      key = parts.pop();
      mods = parts;
    }
    return { mods: mods.filter(function (m) { return m !== ''; }), key: key };
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  Locator expressions
  // ════════════════════════════════════════════════════════════════════════════

  function hasNth(t) { return typeof t.nth === 'number' && t.nth >= 0 && Math.floor(t.nth) === t.nth; }

  /**
   * A role locator with no name and no position can match several elements:
   * Playwright's strict mode would throw on it, Cypress refuses to click a
   * multi-element subject, and Selenium silently takes the first. Known-unique
   * targets (matchCount/unique from the engine) are not ambiguous.
   */
  function isAmbiguousRole(t) {
    return !!t && t.kind === 'role' && !t.name && !hasNth(t) && t.matchCount !== 1 && t.unique !== true;
  }

  function hasAmbiguousRole(t) {
    if (!t) return false;
    if (t.kind === 'frame') return hasAmbiguousRole(t.child);
    if (t.kind === 'chain') return hasAmbiguousRole(t.parent) || hasAmbiguousRole(t.child);
    return isAmbiguousRole(t);
  }

  function pwLocator(t, lang) {
    var py = lang === 'python';
    var m = function (camel, snake) { return py ? snake : camel; };
    // `{ exact: true }` / `exact=True` for the text-matching kinds (C5).
    var ex = function () {
      if (!t.exact) return '';
      return py ? ', exact=True' : ', { exact: true }';
    };
    switch (t.kind) {
      case 'testid':
        if (t.attr === 'data-testid') return 'page.' + m('getByTestId', 'get_by_test_id') + '(' + q(t.value, lang) + ')';
        return 'page.locator(' + q('[' + cssIdent(t.attr) + '="' + attrSel(t.value) + '"]', lang) + ')';
      case 'role': {
        var opts = [];
        if (t.name) opts.push(py ? 'name=' + q(t.name, lang) : 'name: ' + q(t.name, lang));
        if (t.name && t.exact) opts.push(py ? 'exact=True' : 'exact: true');
        if (t.level) opts.push(py ? 'level=' + t.level : 'level: ' + t.level);
        var optStr = '';
        if (opts.length) optStr = py ? ', ' + opts.join(', ') : ', { ' + opts.join(', ') + ' }';
        return 'page.' + m('getByRole', 'get_by_role') + '(' + q(t.role, lang) + optStr + ')' +
          (hasNth(t) ? '.nth(' + t.nth + ')' : '');
      }
      case 'label': return 'page.' + m('getByLabel', 'get_by_label') + '(' + q(t.value, lang) + ex() + ')';
      case 'placeholder': return 'page.' + m('getByPlaceholder', 'get_by_placeholder') + '(' + q(t.value, lang) + ex() + ')';
      case 'altText': return 'page.' + m('getByAltText', 'get_by_alt_text') + '(' + q(t.value, lang) + ex() + ')';
      case 'title': return 'page.' + m('getByTitle', 'get_by_title') + '(' + q(t.value, lang) + ex() + ')';
      case 'text': return 'page.' + m('getByText', 'get_by_text') + '(' + q(t.value, lang) + ex() + ')';
      case 'id': return 'page.locator(' + q('#' + cssIdent(t.value), lang) + ')';
      case 'name': return 'page.locator(' + q('[name="' + attrSel(t.value) + '"]', lang) + ')';
      case 'css': default: return 'page.locator(' + q(t.value || 'body', lang) + ')';
    }
  }

  // Attribute selector for the attribute-matching kinds: equality when the engine
  // asked for an exact match, otherwise substring (Playwright's default semantics).
  function attrMatchSel(attr, value, exact) {
    return '[' + attr + (exact ? '="' : '*="') + attrSel(value) + '"]';
  }

  function cyLocator(t, lang) {
    switch (t.kind) {
      case 'testid': return 'cy.get(' + q('[' + cssIdent(t.attr) + '="' + attrSel(t.value) + '"]', lang) + ')';
      case 'role': {
        var expr = 'cy.get(' + q(roleCss(t.role, t.level), lang) + ')';
        // .contains(name) used to yield the deepest element containing the text — a
        // <span> inside the button, never an <input> named by its <label>, and never
        // something a chained .find() could continue from. Filter by accessible name.
        if (t.name) expr += cyFilter('name', t.name, t.exact, lang);
        if (hasNth(t)) expr += '.eq(' + t.nth + ')';
        else if (isAmbiguousRole(t)) expr += '.first()';
        return expr;
      }
      case 'label': return 'cy.get(' + q(LABELABLE_CSS, lang) + ')' + cyFilter('label', t.value, t.exact, lang);
      case 'placeholder': return 'cy.get(' + q(attrMatchSel('placeholder', t.value, t.exact), lang) + ')';
      case 'altText': return 'cy.get(' + q(attrMatchSel('alt', t.value, t.exact), lang) + ')';
      case 'title': return 'cy.get(' + q(attrMatchSel('title', t.value, t.exact), lang) + ')';
      case 'text':
        if (t.exact) return 'cy.contains(' + cyExactTextRegex(t.value) + ')';
        return 'cy.contains(' + q(t.value, lang) + ')';
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
  function roleXpath(t, rel) {
    var node = roleNodeXpath(t.role, t.level);
    var axis = rel ? './/*' : '//*';
    // xpathLiteral() (inside nameXpath) keeps quotes in the name intact — an older
    // version deleted every double quote, so Delete "row" matched the wrong element.
    var xp = t.name
      ? axis + '[(' + node + ') and (' + nameXpath(t.name, t.exact, t.role) + ')]'
      : axis + '[' + node + ']';
    if (hasNth(t)) xp = '(' + xp + ')[' + (t.nth + 1) + ']';
    return xp;
  }

  function selLocator(t, lang, rel) {
    var axis = rel ? './/*' : '//*';
    switch (t.kind) {
      case 'testid': return selFind('css', '[' + cssIdent(t.attr) + '="' + attrSel(t.value) + '"]', lang);
      case 'role':
        if (t.name || hasNth(t)) return selFind('xpath', roleXpath(t, rel), lang);
        return selFind('css', roleCss(t.role, t.level), lang);
      case 'label': return selFind('xpath', axis + '[' + labelXpath(t.value, t.exact) + ']', lang);
      case 'placeholder': return selFind('css', attrMatchSel('placeholder', t.value, t.exact), lang);
      case 'altText': return selFind('css', attrMatchSel('alt', t.value, t.exact), lang);
      case 'title': return selFind('css', attrMatchSel('title', t.value, t.exact), lang);
      case 'text': return selFind('xpath', textXpath(t.value, t.exact, rel), lang);
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

  // ── frames ──────────────────────────────────────────────────────────────────
  // Playwright and Cypress can address into a frame from an expression, so a frame
  // reuses the chain machinery above: render the child normally and re-point its
  // root at the frame. Selenium cannot — switching frames is a statement, not part
  // of a locator — so selenium is handled in selStatement() instead and its
  // expression here is the child alone.

  /** Peel any frame wrappers off a target. Returns the frames outermost-first. */
  function unwrapFrames(target) {
    var frames = [];
    var t = target;
    while (t && t.kind === 'frame') {
      var f = { selector: t.selector, index: t.index };
      if (t.selector && validShadowPath(t.shadowPath)) f.shadowPath = t.shadowPath;
      frames.push(f);
      t = t.child;
    }
    return { frames: frames, inner: t || null };
  }

  function validShadowPath(p) {
    if (!Array.isArray(p) || p.length < 2) return false;
    for (var i = 0; i < p.length; i++) if (typeof p[i] !== 'string' || !p[i]) return false;
    return true;
  }

  function frameEnterExpr(frame, fw, lang) {
    var sel = frame.selector;
    if (fw === 'cypress') {
      var base = sel
        ? 'cy.get(' + q(sel, lang) + ')'
        : "cy.get('iframe').eq(" + (frame.index || 0) + ')';
      if (frame.shadowPath) {
        // cy.get/find stay inside one tree (and includeShadowDom matches a selector
        // within a single root, not a path across several), so step host by host.
        base = 'cy.get(' + q(frame.shadowPath[0], lang) + ')';
        for (var h = 1; h < frame.shadowPath.length; h++) {
          base += '.shadow().find(' + q(frame.shadowPath[h], lang) + ')';
        }
      }
      // The no-plugin recipe: reach the frame's body, then continue inside it.
      return base + ".its('0.contentDocument.body').should('not.be.empty').then(cy.wrap)";
    }
    var py = lang === 'python';
    var fl = py ? 'frame_locator' : 'frameLocator';
    // Without a selector the frame is cross-origin; address it positionally.
    var arg = sel ? q(sel, lang) : q('iframe >> nth=' + (frame.index || 0), lang);
    return 'page.' + fl + '(' + arg + ')';
  }

  function frameExpr(t, fw, lang) {
    var peeled = unwrapFrames(t);
    if (!peeled.inner) return '';
    // The inner target may itself be a chain (a parent/child pair inside the frame),
    // so it goes through locatorExpr, never straight to selLocator.
    if (fw === 'selenium') return locatorExpr(peeled.inner, fw, lang);

    var expr = '';
    for (var i = 0; i < peeled.frames.length; i++) {
      var enter = frameEnterExpr(peeled.frames[i], fw, lang);
      expr = expr ? expr + enter.replace(/^cy\.get\(/, '.find(').replace(/^page\./, '.') : enter;
    }
    var child = locatorExpr(peeled.inner, fw, lang);
    var rules = CHAIN_ROOT[fw] || CHAIN_ROOT.playwright;
    for (var r = 0; r < rules.length; r++) {
      if (rules[r][0].test(child)) return expr + child.replace(rules[r][0], rules[r][1]);
    }
    return child;
  }

  function locatorExpr(target, fw, lang, rel) {
    if (!target) return '';
    lang = pluginLang(fw, lang);
    var plug = targetFor(fw, lang);
    if (plug) return plug.locatorExpr(target, lang, rel);
    if (target.kind === 'frame') return frameExpr(target, fw, lang);
    if (target.kind === 'chain') return chainExpr(target, fw, lang);
    if (fw === 'selenium') return selLocator(target, lang, rel);
    if (fw === 'cypress') return cyLocator(target, lang);
    return pwLocator(target, lang);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  Action statements (no wrapper indentation; may span several lines)
  // ════════════════════════════════════════════════════════════════════════════

  var KNOWN_ACTIONS = ['click', 'dblclick', 'check', 'uncheck', 'fill', 'selectOption', 'hover', 'press', 'goto', 'viewport', 'assert', 'upload'];
  var TARGETLESS_ACTIONS = ['press', 'goto', 'viewport'];

  function comment(lang, text) {
    return (lang === 'python' ? '# ' : '// ') + text;
  }

  /** A recorded value, safe to quote inside a one-line comment. */
  function commentSafe(value) {
    // eslint-disable-next-line no-control-regex
    return String(value == null ? '' : value).replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').slice(0, 80);
  }

  function todo(lang, text) { return comment(lang, 'TODO: ' + text); }

  // ── sensitive values (C4) ──────────────────────────────────────────────────
  function secretName(step) {
    var n = step && step.secretName;
    return (typeof n === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) ? n : 'LOCATRA_PASSWORD';
  }

  function secretExpr(step, fw, lang) {
    var name = secretName(step);
    if (lang === 'python') return 'os.environ.get("' + name + '", "")';
    if (fw === 'cypress') return CY_SECRET_NAME + "('" + name + "')";
    return 'process.env.' + name + " ?? ''";
  }

  function fillValueExpr(step, fw, lang) {
    return step.sensitive ? secretExpr(step, fw, lang) : valueExpr(step, lang);
  }

  /** A typed or selected value: its test-data reference when it has one, else the literal. */
  function valueExpr(step, lang) {
    var ref = variableRefName(step);
    return ref ? variableRef(ref, lang) : q(step.value, lang);
  }

  // ── test-data variables ─────────────────────────────────────────────────────
  // Typed and selected values can become named test data: the script declares them
  // once (testData / TEST_DATA) and the fill / selectOption statements reference
  // them, so a test runs with other data by editing one block (or test-data.json).
  //   extractVariables(steps)     → [{ name, value, kind, eventIds, indexes }]
  //   applyVariables(steps, vars) → shallow copies; matching steps get varRef: name
  //   testScript(steps, fw, lang, { variables: true | vars })
  // A name is a lowerCamelCase identifier that is legal and not reserved in every
  // language a target renders (JS/TS, Python, Java, C#). Python keys are the
  // snake_case form of the same name (firstName → "first_name"); two names whose
  // snake_case forms are equal are treated as the same name. Sensitive values are
  // never test data: they stay environment variables.
  var VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  var VAR_NAME_MAX = 64;
  var VAR_BASE_MAX = 40;
  var VAR_RESERVED = (
    // JavaScript / TypeScript (incl. strict mode, contextual and type keywords)
    'arguments await break case catch class const continue debugger default delete do else enum eval export ' +
    'extends false finally for function if implements import in instanceof interface let new null package ' +
    'private protected public return static super switch this throw true try typeof undefined var void while ' +
    'with yield abstract any as async bigint boolean constructor declare get infer is keyof module namespace ' +
    'never number object readonly require set string symbol type unique unknown NaN Infinity ' +
    // Object.prototype members (a key in an object literal; __proto__ would set the prototype)
    '__proto__ prototype hasOwnProperty isPrototypeOf propertyIsEnumerable toLocaleString toString valueOf ' +
    // Python (incl. soft keywords)
    'False None True and assert def del elif except from global lambda nonlocal not or pass raise match _ ' +
    // Java
    'byte char double final float goto int long native short strictfp synchronized throws transient volatile ' +
    'record sealed permits ' +
    // C#
    'base bool checked decimal delegate event explicit extern fixed foreach implicit internal lock operator ' +
    'out override params ref sbyte sizeof stackalloc struct uint ulong unchecked unsafe ushort using virtual ' +
    'dynamic nameof'
  ).split(' ');
  // Filler words dropped from a label when other words remain ("Enter your email" → email).
  var VAR_STOP_WORDS = ['a', 'an', 'the', 'your', 'my', 'our', 'please', 'enter', 'type', 'select', 'choose', 'pick', 'here'];
  // When the target says nothing usable (a CSS selector, a numeric placeholder).
  var VAR_INPUT_HINTS = {
    email: 'email', tel: 'phone', url: 'url', number: 'numberValue', search: 'searchTerm', date: 'date',
    time: 'time', 'datetime-local': 'dateTime', month: 'month', week: 'week', color: 'color', range: 'rangeValue'
  };

  function own(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

  function isValidVariableName(name) {
    return typeof name === 'string' && name.length <= VAR_NAME_MAX && VAR_NAME_RE.test(name) &&
      VAR_RESERVED.indexOf(name) === -1;
  }

  /** The Python TEST_DATA key of a name: its snake_case form. */
  function pyVarKey(name) {
    var words = poWords(name);
    return words.length ? words.map(function (w) { return w.toLowerCase(); }).join('_') : String(name).toLowerCase();
  }

  /** The key a name has in the given language's declaration (Python: snake_case). */
  function variableKey(name, lang) {
    return lang === 'python' ? pyVarKey(name) : String(name);
  }

  /** Why a name cannot be used (null when it can); `others` are the other variables' names. */
  function validateVariableName(name, others) {
    if (typeof name !== 'string' || name === '') return 'Enter a name.';
    if (name.length > VAR_NAME_MAX) return 'Use at most ' + VAR_NAME_MAX + ' characters.';
    if (!VAR_NAME_RE.test(name)) return 'Use letters, digits and _ only, starting with a letter or _.';
    if (VAR_RESERVED.indexOf(name) !== -1) return '"' + name + '" is a reserved word in generated code.';
    var list = Array.isArray(others) ? others : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] === name) return 'Another variable is already named "' + name + '".';
    }
    for (var j = 0; j < list.length; j++) {
      if (typeof list[j] === 'string' && pyVarKey(list[j]) === pyVarKey(name)) {
        return 'Clashes with "' + list[j] + '": both are "' + pyVarKey(name) + '" in Python.';
      }
    }
    return null;
  }

  /** The element a step's target finally addresses (through frames and chains). */
  function varInnerTarget(t) {
    var guard = 0;
    while (t && (t.kind === 'frame' || t.kind === 'chain') && guard++ < 64) {
      t = t.kind === 'frame' ? t.child : (t.child || t.parent);
    }
    return t || null;
  }

  function varWords(text) {
    var words = poWords(text);
    var kept = words.filter(function (w) { return VAR_STOP_WORDS.indexOf(w.toLowerCase()) === -1; });
    if (kept.length) words = kept;
    while (words.length && /^[0-9]/.test(words[0])) words.shift();
    return words.slice(0, 4);
  }

  /** The base name for a step's value, from its target (label, name, placeholder, test id, …). */
  function deriveVariableName(step) {
    step = step || {};
    var t = varInnerTarget(step.target);
    var text = '';
    if (t && t.kind === 'role') text = t.name;
    else if (t && t.kind !== 'css') text = t.value;
    var words = varWords(text);
    var name;
    if (words.length) {
      name = words.map(function (w, i) { return i ? cap(w) : w.toLowerCase(); }).join('').slice(0, VAR_BASE_MAX);
    } else if (own(VAR_INPUT_HINTS, String(step.inputType))) {
      name = VAR_INPUT_HINTS[step.inputType];
    } else {
      name = step.action === 'selectOption' ? 'selectedOption' : 'inputValue';
    }
    return VAR_RESERVED.indexOf(name) === -1 ? name : name + 'Value';
  }

  /** A step whose value can be test data: a non-sensitive, accepted fill/select with a value and a locator. */
  function varEligible(step) {
    return !!step && typeof step === 'object' && !isSuggested(step) &&
      (step.action === 'fill' || step.action === 'selectOption') && !step.sensitive &&
      typeof step.value === 'string' && step.value !== '' && !!unwrapFrames(step.target).inner;
  }

  /** The variable a step's statement references, or null when it renders a literal. */
  function variableRefName(step) {
    if (!step || (step.action !== 'fill' && step.action !== 'selectOption') || step.sensitive) return null;
    return isValidVariableName(step.varRef) ? step.varRef : null;
  }

  function variableRef(name, lang) {
    return lang === 'python' ? 'TEST_DATA[' + q(pyVarKey(name), lang) + ']' : 'testData.' + name;
  }

  function hasEventId(step) { return step.eventId != null && step.eventId !== ''; }

  // One variable per distinct (name, value), in order of first use. A step's own
  // varName (set when the user renames a variable) wins over the derived name and is
  // claimed before any derived one, so it is never pushed to a suffix by them; a
  // name already taken by a different value gets the next free numeric suffix
  // (email, email2, email3). `indexes` are the steps' positions in `steps`.
  function extractVariables(steps) {
    var list = Array.isArray(steps) ? steps : [];
    var claims = {}; // name → the (name, value) key that owns it
    var pyClaims = {}; // Python key → name
    var free = function (name) { return !own(claims, name) && !own(pyClaims, pyVarKey(name)); };
    var claim = function (name, key) { claims[name] = key; pyClaims[pyVarKey(name)] = name; };
    var bases = list.map(function (s) {
      if (!varEligible(s)) return null;
      return isValidVariableName(s.varName) ? { name: s.varName, explicit: true } : { name: deriveVariableName(s) };
    });
    bases.forEach(function (b, i) {
      if (b && b.explicit && free(b.name)) claim(b.name, b.name + '\u0000' + list[i].value);
    });
    var byKey = {};
    var out = [];
    bases.forEach(function (b, i) {
      if (!b) return;
      var s = list[i];
      var key = b.name + '\u0000' + s.value;
      var v = own(byKey, key) ? byKey[key] : null;
      if (!v) {
        var name = b.name;
        if (claims[name] !== key) {
          if (free(name)) {
            claim(name, key);
          } else {
            var root = name.slice(0, VAR_NAME_MAX - 4);
            var n = 2;
            name = root + n;
            while (!free(name)) name = root + ++n;
            claim(name, key);
          }
        }
        v = byKey[key] = { name: name, value: s.value, kind: s.action === 'fill' ? 'fill' : 'select', eventIds: [], indexes: [] };
        out.push(v);
      }
      if (hasEventId(s)) v.eventIds.push(s.eventId);
      v.indexes.push(i);
    });
    return out;
  }

  // A step is matched by its eventId; a step without one (an older recording) is
  // matched by its position in `steps` against the variable's `indexes`, so the
  // same array (or one in the same order) must be passed to both functions. A match
  // only counts when the step's value still equals the variable's value — a step
  // edited since extraction keeps its literal rather than referencing other data.
  // Steps that match nothing lose any stale varRef.
  function applyVariables(steps, vars) {
    var byId = {};
    var byIndex = {};
    (Array.isArray(vars) ? vars : []).forEach(function (v) {
      if (!v || !isValidVariableName(v.name) || typeof v.value !== 'string') return;
      (Array.isArray(v.eventIds) ? v.eventIds : []).forEach(function (id) {
        if (!own(byId, String(id))) byId[String(id)] = v;
      });
      (Array.isArray(v.indexes) ? v.indexes : []).forEach(function (i) {
        if (!own(byIndex, String(i))) byIndex[String(i)] = v;
      });
    });
    return (Array.isArray(steps) ? steps : []).map(function (s, i) {
      if (!s || typeof s !== 'object') return s;
      var copy = {};
      for (var k in s) if (own(s, k)) copy[k] = s[k];
      delete copy.varRef;
      var key = hasEventId(s) ? String(s.eventId) : String(i);
      var table = hasEventId(s) ? byId : byIndex;
      var v = own(table, key) ? table[key] : null;
      if (v && varEligible(s) && s.value === v.value) copy.varRef = v.name;
      return copy;
    });
  }

  /** The variables as pretty JSON: { "<name>": "<value>", … } (with a final newline). */
  function variablesJson(vars) {
    var list = scriptVariables(vars, null);
    if (!list.length) return '{}\n';
    return '{\n' + list.map(function (v) {
      return '  ' + JSON.stringify(v.name) + ': ' + JSON.stringify(v.value);
    }).join(',\n') + '\n}\n';
  }

  // The variables a script declares: the valid entries of `vars` (first of each
  // name) plus any variable a step references that `vars` does not list, so a
  // reference can never point at an undeclared name.
  function scriptVariables(vars, steps) {
    var out = [];
    var seen = {};
    var add = function (name, value) {
      if (!isValidVariableName(name) || own(seen, name)) return;
      seen[name] = true;
      out.push({ name: name, value: String(value == null ? '' : value) });
    };
    (Array.isArray(vars) ? vars : []).forEach(function (v) { if (v) add(v.name, v.value); });
    (Array.isArray(steps) ? steps : []).forEach(function (s) {
      var ref = variableRefName(s);
      if (ref) add(ref, s.value);
    });
    return out;
  }

  /** The one test-data declaration for the built-in languages ('' when there is none). */
  function variablesDeclaration(vars, lang) {
    if (!vars || !vars.length) return '';
    if (lang === 'python') {
      return 'TEST_DATA = {\n' + vars.map(function (v) {
        return '    ' + q(pyVarKey(v.name), lang) + ': ' + q(v.value, lang) + ',';
      }).join('\n') + '\n}';
    }
    return 'const testData = {\n' + vars.map(function (v) {
      return '  ' + v.name + ': ' + q(v.value, lang) + ',';
    }).join('\n') + '\n};';
  }

  // ── uploads (C6) ───────────────────────────────────────────────────────────
  function uploadFiles(value) {
    if (Array.isArray(value)) return value.map(String);
    var v = value == null ? '' : String(value);
    try {
      var parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map(String);
      if (typeof parsed === 'string') return parsed ? [parsed] : [];
    } catch (e) {}
    return v ? [v] : [];
  }

  function listLiteral(items, lang) {
    return '[' + items.map(function (i) { return q(i, lang); }).join(', ') + ']';
  }

  function uploadNote(lang) {
    return comment(lang, 'NOTE: these file paths must exist relative to where the test runs');
  }

  // ── notes prepended to Selenium/Cypress statements ─────────────────────────
  function hasPositionalFrame(t) {
    while (t && t.kind === 'frame') {
      if (!t.selector) return true;
      t = t.child;
    }
    return false;
  }

  function statementNotes(step, fw, lang) {
    var notes = [];
    if (hasAmbiguousRole(step.target)) {
      notes.push(comment(lang, 'NOTE: this role locator has no accessible name and may match several elements; ' +
        (fw === 'cypress' ? '.first() picks the first one.' : 'the first match is used.')));
    }
    if (fw === 'cypress' && hasPositionalFrame(step.target)) {
      notes.push(comment(lang, 'NOTE: this iframe is cross-origin, so contentDocument is null and Cypress cannot reach into it.'));
      notes.push(comment(lang, 'Test that page in its own spec (cy.visit/cy.origin) or set chromeWebSecurity: false (Chromium only).'));
    }
    return notes;
  }

  function withNotes(notes, stmt) {
    return notes.length ? notes.join('\n') + '\n' + stmt : stmt;
  }

  // Input types whose value cannot be typed reliably (Selenium types dates in the
  // browser's locale order; a slider or colour picker has no keyboard text entry).
  var SET_VALUE_TYPES_SELENIUM = ['range', 'color', 'date', 'time', 'datetime-local', 'month', 'week'];
  var SET_VALUE_TYPES_CYPRESS = ['range', 'color'];
  // Uses the prototype's value setter so frameworks that track the DOM value
  // (React) notice the change, then fires the events a user's input would.
  var SET_VALUE_JS = "const el = arguments[0]; const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); " +
    "if (d && d.set) d.set.call(el, arguments[1]); else el.value = arguments[1]; " +
    "el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));";

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
      // fill() also sets range/color/date inputs, so inputType needs no special case.
      case 'fill': return aw + loc + '.fill(' + fillValueExpr(step, 'playwright', lang) + ')' + semi;
      case 'upload':
        return uploadNote(lang) + '\n' + aw + loc + (py ? '.set_input_files(' : '.setInputFiles(') +
          listLiteral(uploadFiles(step.value), lang) + ')' + semi;
      case 'selectOption':
        if (py) return loc + '.select_option(' + valueExpr(step, lang) + ')';
        return 'await ' + loc + '.selectOption(' + valueExpr(step, lang) + ');';
      default: return todo(lang, 'unsupported step "' + commentSafe(a) + '"');
    }
  }

  function isSingleChar(key) { return Array.from(String(key)).length === 1; }

  function realPressKey(key) {
    if (key === ' ' || key === 'Space') return 'Space';
    if (REAL_PRESS_NAMED.indexOf(key) !== -1) return key;
    return key.length === 1 && REAL_PRESS_CHARS.indexOf(key) !== -1 ? key : null;
  }

  // Cypress, plain keys: Tab has no cy.type() sequence at all ({tab} throws), so it
  // goes through cy.press() (Cypress ≥ 14.3); everything else is typed into whatever
  // has focus. Modifier combos: cy.type()'s {shift}/{ctrl}/… only set flags on
  // synthetic, untrusted events, so the browser never performs the native action
  // (Shift+Tab focus movement, Shift+Space on a button, Ctrl/Meta+Enter on a link,
  // shortcuts) — and cy.press() takes no modifiers. Combos therefore use the
  // cypress-real-events plugin's cy.realPress(), which dispatches real key events
  // over CDP; wrapScript() adds its import. A key either path cannot express
  // becomes a TODO — never a different key.
  function cyPress(value, lang) {
    var raw = value == null || value === '' ? 'Enter' : value;
    var p = parseKeyCombo(raw);
    var key = p.key;
    if (p.mods.length) {
      for (var i = 0; i < p.mods.length; i++) {
        if (REAL_PRESS_MODS.indexOf(p.mods[i]) === -1) {
          return todo(lang, 'press "' + commentSafe(raw) + '" — modifier not supported by cy.realPress()');
        }
      }
      var real = realPressKey(key);
      if (!real) return todo(lang, 'press "' + commentSafe(raw) + '" — key not supported by cy.realPress()');
      return 'cy.realPress(' + listLiteral(p.mods.concat(real), lang) + ');';
    }
    if (key === 'Tab') return 'cy.press(Cypress.Keyboard.Keys.TAB);';
    var seq = KEY_CYPRESS[key];
    if (!seq && (key === ' ' || key === 'Space')) seq = ' ';
    if (!seq && isSingleChar(key)) seq = key === '{' ? '{{}' : key;
    if (!seq) return todo(lang, 'press "' + commentSafe(raw) + '" — key not supported by cy.type()');
    return 'cy.focused().type(' + q(seq, lang) + ');';
  }

  // .check()/.uncheck() only work on native checkbox/radio inputs; an ARIA control
  // (div[role=checkbox], role=switch, aria-checked) has to be clicked, and only when
  // its state differs. The target alone cannot tell the two apart, so branch at
  // run time.
  function cyToggle(desired) {
    var native = "$el.is('input[type=\"checkbox\"], input[type=\"radio\"]')";
    return '.then(($el) => {\n' +
      '  if (' + native + ') cy.wrap($el).' + (desired ? 'check' : 'uncheck') + '();\n' +
      "  else if ($el.attr('aria-checked') " + (desired ? '!==' : '===') + " 'true') cy.wrap($el).click();\n" +
      '});';
  }

  function cyStatement(step, lang) {
    var a = step.action;
    if (a === 'goto') return 'cy.visit(' + q(step.value || step.url || '', lang) + ');';
    if (a === 'press') return cyPress(step.value || step.key, lang);
    if (a === 'viewport') return 'cy.viewport(' + vpW(step) + ', ' + vpH(step) + ');';
    return withNotes(statementNotes(step, 'cypress', lang), cyTargetStatement(step, lang));
  }

  function cyTargetStatement(step, lang) {
    var a = step.action;
    if (a === 'assert') return cyAssert(step, lang);
    var loc = locatorExpr(step.target, 'cypress', lang);
    switch (a) {
      case 'click': return loc + '.click();';
      case 'hover': return loc + ".trigger('mouseover');";
      case 'dblclick': return loc + '.dblclick();';
      case 'check': return loc + cyToggle(true);
      case 'uncheck': return loc + cyToggle(false);
      case 'fill':
        if (step.sensitive) {
          return secretExpr(step, 'cypress', lang) + '.then((secret) => {\n' +
            '  ' + loc + '.clear().type(secret, { log: false, parseSpecialCharSequences: false });\n});';
        }
        if (SET_VALUE_TYPES_CYPRESS.indexOf(step.inputType) !== -1) {
          return loc + ".invoke('val', " + valueExpr(step, lang) + ").trigger('input').trigger('change');";
        }
        // A literal "{" in a recorded value is text, not a cy.type() key sequence.
        return step.value ? loc + '.clear().type(' + valueExpr(step, lang) + ', { parseSpecialCharSequences: false });' : loc + '.clear();';
      case 'upload': {
        var files = uploadFiles(step.value);
        if (!files.length) return todo(lang, 'upload step with no files (Cypress cannot clear a file input)');
        return uploadNote(lang) + '\n' + loc + '.selectFile(' + listLiteral(files, lang) + ');';
      }
      case 'selectOption': return loc + '.select(' + valueExpr(step, lang) + ');';
      default: return todo(lang, 'unsupported step "' + commentSafe(a) + '"');
    }
  }

  // An <iframe> inside shadow DOM is reached host by host: WebDriver searches a
  // shadow root with CSS only (no XPath), one tree at a time. JS/TS spell every hop
  // out with awaits — at run time a shadow root's findElement returns a plain
  // promise, so chaining off it the way off driver.findElement() fails.
  function selShadowFrameSwitch(path, lang) {
    if (lang === 'python') {
      var expr = selFind('css', path[0], lang);
      for (var i = 1; i < path.length; i++) {
        expr += '.shadow_root.find_element(By.CSS_SELECTOR, ' + q(path[i], lang) + ')';
      }
      return 'driver.switch_to.frame(' + expr + ')';
    }
    var lines = ['  const shadowHost1 = await ' + selFind('css', path[0], lang) + ';'];
    for (var k = 1; k < path.length; k++) {
      var name = k === path.length - 1 ? 'shadowFrame' : 'shadowHost' + (k + 1);
      lines.push('  const ' + name + ' = await (await shadowHost' + k + '.getShadowRoot()).findElement(By.css(' +
        q(path[k], lang) + '));');
    }
    lines.push('  await driver.switchTo().frame(shadowFrame);');
    return '{\n' + lines.join('\n') + '\n}';
  }

  // Selenium has no frame-scoped locator: the driver is switched into the frame,
  // acts, and is switched back. Emitted as one multi-line statement — indent() already
  // pads every physical line, so it lands correctly inside the test scaffold.
  function selFrameSwitch(frame, lang) {
    var py = lang === 'python';
    if (frame.shadowPath) return selShadowFrameSwitch(frame.shadowPath, lang);
    if (frame.selector) {
      var el = selFind('css', frame.selector, lang);
      return py ? 'driver.switch_to.frame(' + el + ')' : 'await driver.switchTo().frame(' + el + ');';
    }
    var idx = frame.index || 0;
    return py ? 'driver.switch_to.frame(' + idx + ')' : 'await driver.switchTo().frame(' + idx + ');';
  }

  function selPress(value, lang) {
    var py = lang === 'python';
    var raw = value == null || value === '' ? 'Enter' : value;
    var p = parseKeyCombo(raw);
    var K = py ? 'Keys.' : 'Key.';
    var keyArg = KEY_SELENIUM[p.key] ? K + KEY_SELENIUM[p.key] : (isSingleChar(p.key) ? q(p.key, lang) : null);
    // An unknown key used to become ENTER — a silently different test.
    if (!keyArg) return todo(lang, 'press "' + commentSafe(raw) + '" — no Selenium key mapping');
    var mods = [];
    for (var i = 0; i < p.mods.length; i++) {
      if (!MOD_SELENIUM[p.mods[i]]) return todo(lang, 'press "' + commentSafe(raw) + '" — modifier not supported');
      mods.push(K + MOD_SELENIUM[p.mods[i]]);
    }
    var down = mods.map(function (m) { return py ? '.key_down(' + m + ')' : '.keyDown(' + m + ')'; }).join('');
    var up = mods.slice().reverse().map(function (m) { return py ? '.key_up(' + m + ')' : '.keyUp(' + m + ')'; }).join('');
    if (py) return 'webdriver.ActionChains(driver)' + down + '.send_keys(' + keyArg + ')' + up + '.perform()';
    return 'await driver.actions()' + down + '.sendKeys(' + keyArg + ')' + up + '.perform();';
  }

  // is_selected() is always false for an ARIA checkbox (div[role=checkbox]), so its
  // aria-checked state counts too.
  function selCheckedExpr(el, lang) {
    if (lang === 'python') return '(' + el + '.is_selected() or ' + el + '.get_attribute("aria-checked") == "true")';
    return '((await ' + el + '.isSelected()) || (await ' + el + ".getAttribute('aria-checked')) === 'true')";
  }

  // Statements that touch the element more than once look it up once: `el = …` in
  // Python, a block-scoped `const el` in JS/TS (a block, so repeated steps never
  // redeclare it).
  function selWithEl(loc, lang, lines) {
    if (lang === 'python') return ['el = ' + loc].concat(lines).join('\n');
    return '{\n  const el = ' + loc + ';\n' + lines.map(function (l) { return '  ' + l; }).join('\n') + '\n}';
  }


  function selStatement(step, lang) {
    var py = lang === 'python';
    var aw = py ? '' : 'await ';
    var semi = py ? '' : ';';
    var a = step.action;

    var peeled = unwrapFrames(step.target);
    if (peeled.frames.length) {
      var lines = peeled.frames.map(function (f) { return selFrameSwitch(f, lang); });
      var body = {};
      for (var prop in step) if (Object.prototype.hasOwnProperty.call(step, prop)) body[prop] = step[prop];
      body.target = peeled.inner;
      lines.push(selStatement(body, lang));
      // Back to the top document, or every later step would run inside this frame.
      lines.push(py ? 'driver.switch_to.default_content()' : 'await driver.switchTo().defaultContent();');
      return lines.join('\n');
    }
    if (a === 'goto') return aw + 'driver.get(' + q(step.value || step.url || '', lang) + ')' + semi;
    if (a === 'press') return selPress(step.value || step.key, lang);
    if (a === 'viewport') {
      // The recorded size is the viewport (innerWidth x innerHeight); Selenium sizes
      // the whole window, so add the browser chrome measured at run time.
      if (py) {
        return 'driver.set_window_size(*driver.execute_script(' + q('return [' + vpW(step) + ' + window.outerWidth - window.innerWidth, ' +
          vpH(step) + ' + window.outerHeight - window.innerHeight];', lang) + '))';
      }
      var rectJs = 'return { width: ' + vpW(step) + ' + window.outerWidth - window.innerWidth, height: ' +
        vpH(step) + ' + window.outerHeight - window.innerHeight };';
      var generic = lang === 'typescript' ? '<{ width: number; height: number }>' : '';
      return 'await driver.manage().window().setRect(await driver.executeScript' + generic + '(' + q(rectJs, lang) + '));';
    }
    return withNotes(statementNotes(step, 'selenium', lang), selTargetStatement(step, lang));
  }

  function selTargetStatement(step, lang) {
    var py = lang === 'python';
    var aw = py ? '' : 'await ';
    var semi = py ? '' : ';';
    var a = step.action;
    if (a === 'assert') return selAssert(step, lang);
    var loc = locatorExpr(step.target, 'selenium', lang);
    if (a === 'hover') {
      if (py) return 'webdriver.ActionChains(driver).move_to_element(' + loc + ').perform()';
      return 'await driver.actions().move({ origin: ' + loc + ' }).perform();';
    }
    switch (a) {
      case 'click': return aw + loc + '.click()' + semi;
      // Only click when the state differs — a plain click toggles, so re-running a
      // check on an already-checked box used to uncheck it.
      case 'check':
        if (py) return selWithEl(loc, lang, ['if not ' + selCheckedExpr('el', lang) + ':', '    el.click()']);
        return selWithEl(loc, lang, ['if (!' + selCheckedExpr('el', lang) + ') await el.click();']);
      case 'uncheck':
        if (py) return selWithEl(loc, lang, ['if ' + selCheckedExpr('el', lang) + ':', '    el.click()']);
        return selWithEl(loc, lang, ['if (' + selCheckedExpr('el', lang) + ') await el.click();']);
      case 'dblclick':
        if (py) return 'webdriver.ActionChains(driver).double_click(' + loc + ').perform()';
        return 'await driver.actions().doubleClick(' + loc + ').perform();';
      case 'fill': {
        var val = fillValueExpr(step, 'selenium', lang);
        if (SET_VALUE_TYPES_SELENIUM.indexOf(step.inputType) !== -1) {
          if (py) return 'driver.execute_script(' + q(SET_VALUE_JS, lang) + ', ' + loc + ', ' + val + ')';
          return 'await driver.executeScript(' + q(SET_VALUE_JS, lang) + ', ' + loc + ', ' + val + ');';
        }
        // clear first so a pre-filled field is replaced, not appended to
        if (py) return selWithEl(loc, lang, ['el.clear()', 'el.send_keys(' + val + ')']);
        return selWithEl(loc, lang, ['await el.clear();', 'await el.sendKeys(' + val + ');']);
      }
      case 'upload': {
        var files = uploadFiles(step.value);
        if (!files.length) return aw + loc + '.clear()' + semi;
        // A file input takes absolute paths; several files are newline-separated.
        if (py) {
          return uploadNote(lang) + '\n' + loc + '.send_keys("\\n".join(os.path.abspath(p) for p in ' + listLiteral(files, lang) + '))';
        }
        return uploadNote(lang) + '\nawait ' + loc + '.sendKeys(' + listLiteral(files, lang) +
          ".map((p) => require('path').resolve(p)).join('\\n'));";
      }
      case 'selectOption':
        if (py) return 'Select(' + loc + ').select_by_visible_text(' + valueExpr(step, lang) + ')';
        return 'await new Select(' + loc + ').selectByVisibleText(' + valueExpr(step, lang) + ');';
      default: return todo(lang, 'unsupported step "' + commentSafe(a) + '"');
    }
  }

  function vpW(step) { return Number(step.width != null ? step.width : (parseViewport(step.value).w)) || 1280; }
  function vpH(step) { return Number(step.height != null ? step.height : (parseViewport(step.value).h)) || 720; }
  function parseViewport(v) {
    var parts = String(v || '').split('x');
    return { w: parts[0] || '', h: parts[1] || parts[0] || '' };
  }

  // ── assertions ──────────────────────────────────────────────────────────────
  // step.assertType ∈ toBeVisible | toHaveText | toContainText | toHaveValue |
  //                   toBeEnabled | toBeChecked | toHaveURL
  // step.value carries the expected text/value, or 'false' for an unchecked assertion.
  // toHaveURL is a page assertion: it takes no target (one, if present, is ignored)
  // and step.value holds the expected URL (step.url as a fallback).
  function urlAssert(step, fw, lang) {
    var py = lang === 'python';
    var url = q(step.value != null && step.value !== '' ? step.value : (step.url || ''), lang);
    if (fw === 'cypress') return 'cy.url().should(' + q('eq', lang) + ', ' + url + ');';
    if (fw === 'selenium') {
      if (py) return 'WebDriverWait(driver, 10).until(EC.url_to_be(' + url + '))';
      return 'await driver.wait(until.urlIs(' + url + '), 10000);';
    }
    return py ? 'expect(page).to_have_url(' + url + ')' : 'await expect(page).toHaveURL(' + url + ');';
  }

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
        toContainText: 'to_contain_text(' + q(v, lang) + ')',
        toHaveValue: 'to_have_value(' + q(v, lang) + ')',
        toBeEnabled: 'to_be_enabled()',
        toBeChecked: unchecked ? 'not_to_be_checked()' : 'to_be_checked()'
      };
      return 'expect(' + loc + ').' + (pmap[t] || 'to_be_visible()');
    }
    var jmap = {
      toBeVisible: 'toBeVisible()',
      toHaveText: 'toHaveText(' + q(v, lang) + ')',
      toContainText: 'toContainText(' + q(v, lang) + ')',
      toHaveValue: 'toHaveValue(' + q(v, lang) + ')',
      toBeEnabled: 'toBeEnabled()',
      toBeChecked: unchecked ? 'not.toBeChecked()' : 'toBeChecked()'
    };
    return 'await expect(' + loc + ').' + (jmap[t] || 'toBeVisible()') + ';';
  }

  // Cypress's have.text compares raw textContent, so indentation and newlines in the
  // markup failed a text the user can see is identical. Compare normalised text, as
  // Playwright's toHaveText does.
  function cyAssert(step, lang) {
    var loc = locatorExpr(step.target, 'cypress', lang);
    var t = step.assertType || 'toBeVisible';
    var v = step.value;
    var normText = "$el.text().replace(/\\s+/g, ' ').trim()";
    var map = {
      toBeVisible: ".should('be.visible')",
      toHaveText: '.should(($el) => { expect(' + normText + ').to.equal(' + q(normWs(v), lang) + '); })',
      toContainText: '.should(($el) => { expect(' + normText + ').to.contain(' + q(normWs(v), lang) + '); })',
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
    var unchecked = String(v) === 'false';
    if (py) {
      var pyText = '" ".join(' + loc + '.text.split())';
      switch (t) {
        case 'toHaveText': return 'assert ' + pyText + ' == ' + q(normWs(v), lang);
        case 'toContainText': return 'assert ' + q(normWs(v), lang) + ' in ' + pyText;
        case 'toHaveValue': return 'assert ' + loc + '.get_attribute("value") == ' + q(v, lang);
        case 'toBeEnabled': return 'assert ' + loc + '.is_enabled()';
        case 'toBeChecked': return selWithEl(loc, lang, ['assert ' + (unchecked ? 'not ' : '') + selCheckedExpr('el', lang)]);
        case 'toBeVisible': default: return 'assert ' + loc + '.is_displayed()';
      }
    }
    var jsText = '(await ' + loc + ".getText()).replace(/\\s+/g, ' ').trim()";
    switch (t) {
      case 'toHaveText': return 'assert.strictEqual(' + jsText + ', ' + q(normWs(v), lang) + ');';
      case 'toContainText': return 'assert.ok(' + jsText + '.includes(' + q(normWs(v), lang) + '));';
      case 'toHaveValue': return 'assert.strictEqual(await ' + loc + ".getAttribute('value'), " + q(v, lang) + ');';
      case 'toBeEnabled': return 'assert.ok(await ' + loc + '.isEnabled());';
      case 'toBeChecked': return selWithEl(loc, lang, ['assert.ok(' + (unchecked ? '!' : '') + selCheckedExpr('el', lang) + ');']);
      case 'toBeVisible': default: return 'assert.ok(await ' + loc + '.isDisplayed());';
    }
  }

  // A TODO the core writes for a step it cannot express. A registered target that
  // defines todo(text, lang) or comment(text, lang) writes it in its own comment
  // syntax (and sanitising); otherwise it is a // or # line comment.
  function targetTodo(plug, lang, text) {
    if (plug && typeof plug.todo === 'function') return plug.todo(text, lang);
    if (plug && typeof plug.comment === 'function') return plug.comment('TODO: ' + text, lang);
    return todo(lang, text);
  }

  function actionStatement(step, fw, lang) {
    if (!step) return '';
    lang = pluginLang(fw, lang);
    var a = step.action;
    // A step from a newer recorder, or a corrupted one, becomes a visible TODO rather
    // than a throw or a silently different action.
    var plug = targetFor(fw, lang);
    if (KNOWN_ACTIONS.indexOf(a) === -1) return targetTodo(plug, lang, 'unsupported step "' + commentSafe(a) + '"');
    var urlStep = a === 'assert' && step.assertType === 'toHaveURL';
    if (!urlStep && TARGETLESS_ACTIONS.indexOf(a) === -1 && !unwrapFrames(step.target).inner) {
      return targetTodo(plug, lang, '"' + a + '" step has no element locator');
    }
    if (plug) return plug.actionStatement(step, lang);
    if (urlStep) return urlAssert(step, fw, lang);
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

  /** Python needs at least one real statement in a block; comments do not count. */
  function pyBody(stmts, pad) {
    var hasCode = stmts.some(function (s) {
      return String(s || '').split('\n').some(function (l) { return l.trim() && l.trim().charAt(0) !== '#'; });
    });
    return (stmts.length ? indent(stmts, pad) + '\n' : '') + (hasCode ? '' : pad + 'pass\n');
  }

  // ── Cypress cross-origin navigation ────────────────────────────────────────
  function urlOrigin(url) {
    var m = /^(https?:\/\/[^/?#]+)/i.exec(String(url || ''));
    return m ? m[1].toLowerCase() : null;
  }

  function stepOrigin(step) {
    if (!step) return null;
    if (step.action === 'goto') return urlOrigin(step.value || step.url);
    // A step inside an iframe records the frame's own URL, not the page's.
    if (unwrapFrames(step.target).frames.length) return null;
    return urlOrigin(step.url);
  }

  function visitOrigin(stmt) {
    var m = /^cy\.visit\('((?:[^'\\]|\\.)*)'\);$/.exec(String(stmt || ''));
    return m ? urlOrigin(m[1].replace(/\\(.)/g, '$1')) : null;
  }

  // After the first page, commands for a different origin must run inside
  // cy.origin(); the origin is taken from the steps' recorded URLs when the steps are
  // given, else from the cy.visit() lines.
  function cyOriginGroups(stmts, steps) {
    var useSteps = Array.isArray(steps) && steps.length === stmts.length;
    var groups = [];
    var base = null;
    var cur = null;
    stmts.forEach(function (s, i) {
      var o = useSteps ? stepOrigin(steps[i]) : visitOrigin(s);
      if (o && !base) base = o;
      if (o) cur = o;
      var origin = cur && cur !== base ? cur : null;
      if (!groups.length || groups[groups.length - 1].origin !== origin) groups.push({ origin: origin, stmts: [] });
      groups[groups.length - 1].stmts.push(s);
    });
    return groups;
  }

  function usesCyHelper(stmts) {
    return new RegExp('\\b' + CY_HELPER_NAME + '\\(').test(stmts.join('\n'));
  }

  // cy.realPress() (modifier combos) comes from the cypress-real-events plugin. Only
  // a real call counts — a TODO comment that merely mentions it does not.
  var REAL_EVENTS = 'cypress-real-events';
  function usesRealEvents(stmts) {
    return /^\s*cy\.realPress\(/m.test(stmts.join('\n'));
  }

  function realEventsHeader(lang) {
    return comment(lang, 'cy.realPress() needs the ' + REAL_EVENTS + ' plugin: npm i -D ' + REAL_EVENTS) + '\n' +
      comment(lang, 'It sends real key events over CDP, so this spec runs only in Chromium-based browsers (Chrome, Edge, Electron).') + '\n' +
      'import ' + q(REAL_EVENTS, lang) + ';\n\n';
  }

  // A cy.origin() callback runs in a separate spec bridge where the top-level import
  // never ran, so the plugin's commands are loaded again inside it.
  function realEventsOriginRequire(lang) {
    return comment(lang, 'cy.origin() has its own context: load the plugin there too (needs experimentalOriginDependencies: true).') + '\n' +
      'Cypress.require(' + q(REAL_EVENTS, lang) + ');';
  }

  // Wrap already-rendered statement lines in the right test scaffold. Kept separate
  // from testScript() so callers that produce statements themselves (e.g. to preserve
  // Playwright JS/TS native fidelity) still get correct imports + indentation.
  // `steps` (optional, parallel to stmts) lets Cypress place cy.origin() blocks.
  // `opts.variables` (optional, an array from extractVariables) adds the one
  // test-data declaration the statements' references need; any variable a step
  // references but the list lacks is declared too. Registered targets receive opts
  // with `variables` normalised the same way (a non-empty array, or absent).
  function wrapScript(stmts, fw, lang, steps, opts) {
    stmts = stmts || [];
    lang = pluginLang(fw, lang);
    // A suggested (not yet accepted) assertion is never part of the script.
    if (Array.isArray(steps) && steps.length === stmts.length && steps.some(isSuggested)) {
      var keptSteps = [];
      stmts = stmts.filter(function (s, i) {
        if (isSuggested(steps[i])) return false;
        keptSteps.push(steps[i]);
        return true;
      });
      steps = keptSteps;
    }
    var vars = scriptVariables(opts && opts.variables, steps);
    var plug = targetFor(fw, lang);
    if (plug) {
      if (opts == null && !vars.length) return plug.wrapScript(stmts, lang, steps, opts);
      var plugOpts = {};
      for (var k in opts) if (own(opts, k)) plugOpts[k] = opts[k];
      if (vars.length) plugOpts.variables = vars;
      else delete plugOpts.variables;
      return plug.wrapScript(stmts, lang, steps, plugOpts);
    }
    var joined = stmts.join('\n');
    var pyOs = lang === 'python' && /\bos\.(environ|path)\b/.test(joined) ? 'import os\n' : '';
    // The test-data declaration, followed by the blank lines that separate it from
    // the next top-level statement ('' when the script has no variables).
    var decl = variablesDeclaration(vars, lang);
    var declBlock = decl ? decl + (lang === 'python' ? '\n\n\n' : '\n\n') : '';

    if (fw === 'playwright') {
      if (lang === 'python') {
        return pyOs + 'from playwright.sync_api import Page, expect\n\n\n' + declBlock +
          'def test_recorded(page: Page):\n' +
          pyBody(stmts, '    ');
      }
      return "import { test, expect } from '@playwright/test';\n\n" + declBlock +
        "test('recorded test', async ({ page }) => {\n" +
        indent(stmts, '  ') + '\n});\n';
    }

    if (fw === 'cypress') {
      var body = cyOriginGroups(stmts, steps).map(function (g) {
        if (!g.origin) return indent(g.stmts, '    ');
        // cy.origin() serialises its callback, so the helper must be declared inside.
        var inner = cyHelpers(g.stmts, lang).concat(g.stmts);
        if (usesRealEvents(g.stmts)) inner = [realEventsOriginRequire(lang)].concat(inner);
        // …and so must the test data, which reaches it as a serialised argument.
        var cb = decl ? ', { args: { testData } }, ({ testData }) => {\n' : ', () => {\n';
        return '    cy.origin(' + q(g.origin, lang) + cb + indent(inner, '      ') + '\n    });';
      }).join('\n');
      var helpers = cyHelpers(stmts, lang);
      var helper = helpers.length ? helpers.join('\n\n') + '\n\n' : '';
      var realEvents = usesRealEvents(stmts) ? realEventsHeader(lang) : '';
      return realEvents + declBlock + helper + "describe('recorded test', () => {\n" +
        "  it('replays the recorded flow', () => {\n" +
        body + '\n  });\n});\n';
    }

    // selenium — derive imports from what the statements actually use.
    if (lang === 'python') {
      var pyImports = ['from selenium import webdriver', 'from selenium.webdriver.common.by import By'];
      if (/Keys\./.test(joined)) pyImports.push('from selenium.webdriver.common.keys import Keys');
      var uiNames = [];
      if (/\bSelect\(/.test(joined)) uiNames.push('Select');
      if (/\bWebDriverWait\(/.test(joined)) uiNames.push('WebDriverWait');
      if (uiNames.length) pyImports.push('from selenium.webdriver.support.ui import ' + uiNames.join(', '));
      if (/\bEC\./.test(joined)) pyImports.push('from selenium.webdriver.support import expected_conditions as EC');
      return pyOs + pyImports.join('\n') + '\n\n\n' + (decl ? decl + '\n\n' : '') +
        'driver = webdriver.Chrome()\n' +
        'driver.implicitly_wait(10)  # Selenium has no auto-wait; give elements time to appear\n' +
        'try:\n' +
        pyBody(stmts, '    ') +
        'finally:\n' +
        '    driver.quit()\n';
    }
    var jsNames = ['Builder', 'By', 'Key'];
    if (/new Select\(/.test(joined)) jsNames.push('Select');
    if (/\buntil\./.test(joined)) jsNames.push('until');
    var jsHead = 'const { ' + jsNames.join(', ') + " } = require('selenium-webdriver');\n";
    if (/\bassert\./.test(joined)) jsHead += "const assert = require('assert');\n";
    return jsHead + '\n' + declBlock +
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

  function isSuggested(step) { return !!step && step.suggested === true; }

  // `opts.variables`: true extracts the test data from the steps; an array (from
  // extractVariables, possibly edited) is used as-is; absent or false keeps every
  // value a literal. Variables are applied before suggested steps are dropped, so
  // index-matched steps (no eventId) line up with the array they were extracted from.
  function testScript(actions, fw, lang, opts) {
    var all = actions || [];
    var vars = opts && opts.variables;
    if (vars === true) vars = extractVariables(all);
    if (Array.isArray(vars)) {
      all = applyVariables(all, vars);
      var o = {};
      for (var k in opts) if (own(opts, k)) o[k] = opts[k];
      o.variables = vars;
      opts = o;
    } else if (all.some(function (a) { return !!a && a.varRef != null; })) {
      all = applyVariables(all, []); // literals only: drop references a caller left on the steps
    }
    var steps = all.filter(function (a) { return !isSuggested(a); });
    return wrapScript(steps.map(function (a) { return actionStatement(a, fw, lang); }), fw, lang, steps, opts);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  Page Objects
  // ════════════════════════════════════════════════════════════════════════════
  // pageObject(model, fw, lang) renders one class for a picked region / page:
  //   model = { className?, pageUrl?, title?, elements: [{ name, kind, target,
  //             inputType?, role?, matchCount?, unique? }] }
  //   kind ∈ input | textarea | select | checkbox | radio | button | link | other
  // Every locator goes through locatorExpr(), so exact / nth / chains / frames /
  // shadowPath behave exactly as in recorded scripts. Member names are made valid,
  // non-reserved and unique per language (lowerCamelCase in JS/TS, snake_case in
  // Python); the same model always renders the same text.

  var PO_RESERVED = {
    js: ('arguments await break case catch class const constructor continue debugger default delete do else enum ' +
      'eval export extends false finally for function if implements import in instanceof interface let new null ' +
      'package private protected public return static super switch this throw true try typeof undefined var void ' +
      'while with yield hasOwnProperty isPrototypeOf propertyIsEnumerable toLocaleString toString valueOf ' +
      'page driver goto visit').split(' '),
    python: ('False None True and as assert async await break class continue def del elif else except finally for ' +
      'from global if import in is lambda nonlocal not or pass raise return try while with yield self page driver ' +
      'goto match case type').split(' ')
  };

  function poWords(text) {
    var plain = String(text == null ? '' : text);
    if (typeof plain.normalize === 'function') plain = plain.normalize('NFD').replace(/[̀-ͯ]/g, '');
    plain = plain.replace(/([a-z])([A-Z])|([0-9])([A-Z][a-z])/g, '$1$3 $2$4').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    return plain.match(/[A-Za-z0-9]+/g) || [];
  }

  function cap(w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); }

  function poIdent(name, py) {
    var words = poWords(name).slice(0, 8);
    if (!words.length) words = ['element'];
    var id = py
      ? words.map(function (w) { return w.toLowerCase(); }).join('_')
      : words.map(function (w, i) { return i === 0 ? w.toLowerCase() : cap(w); }).join('');
    if (/^[0-9]/.test(id)) id = (py ? 'el_' : 'el') + id;
    return id.slice(0, 64);
  }

  /** A unique, non-reserved identifier; numeric suffixes resolve collisions. */
  function poClaim(base, used, py) {
    var id = base;
    if (PO_RESERVED[py ? 'python' : 'js'].indexOf(id) !== -1) id += py ? '_element' : 'Element';
    var n = 2;
    var root = id;
    while (Object.prototype.hasOwnProperty.call(used, id)) id = root + (py ? '_' : '') + n++;
    used[id] = true;
    return id;
  }

  // Path segments that name no particular page, so the title says more.
  var PO_GENERIC_SEGMENTS = ['index', 'home', 'default', 'main', 'app', 'page'];

  /** PascalCase class name: the model's, else the URL path, else the title. */
  function poClassName(model) {
    var words = poWords(model.className);
    if (!words.length) {
      // The path is checked before the title: titles put the site name first as often
      // as last ("Northwind Books — Checkout"), so their first part named the site,
      // while /checkout names the page.
      var path = String(model.pageUrl || '').replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').split(/[?#]/)[0];
      var segs = path.split('/').filter(function (sg) { return sg && !/^\d+$/.test(sg); });
      var last = segs.length ? segs[segs.length - 1].replace(/\.[a-z0-9]+$/i, '') : '';
      if (last && PO_GENERIC_SEGMENTS.indexOf(last.toLowerCase()) === -1) words = poWords(last).slice(0, 4);
    }
    if (!words.length) {
      // "Checkout | Shop" → Checkout: the part before a title separator.
      var title = String(model.title || '').split(/\s[|–—\-:·]\s|[|–—·]/)[0];
      words = poWords(title).slice(0, 4);
    }
    if (!words.length) words = ['Home'];
    var name = words.map(function (w) { return /^[A-Z0-9]+$/.test(w) && w.length > 1 && model.className ? w : cap(w); }).join('');
    if (/^[0-9]/.test(name)) name = 'Page' + name;
    if (!/Page$/.test(name)) name += 'Page';
    return name.slice(0, 80);
  }

  // Re-point a rendered expression's root receiver (`page.`, `driver.`) at another
  // one (`this.page.`, `self.driver.`), leaving string literals untouched — a
  // selector may well contain the text "driver.".
  function rebaseReceiver(code, from, to) {
    var out = '';
    var i = 0;
    while (i < code.length) {
      var c = code.charAt(i);
      if (c === "'" || c === '"') {
        var j = i + 1;
        while (j < code.length && code.charAt(j) !== c) j += code.charAt(j) === '\\' ? 2 : 1;
        out += code.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      var prev = i ? code.charAt(i - 1) : '';
      if (code.substr(i, from.length + 1) === from + '.' && !/[\w$.]/.test(prev)) {
        out += to + '.';
        i += from.length + 1;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

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

  function poNote(el, fw, lang) {
    var notes = [];
    var n = el.matchCount;
    if (typeof n === 'number' && n !== 1) {
      notes.push(comment(lang, n === 0
        ? 'NOTE: this locator matched no element when the page object was generated.'
        : 'NOTE: this locator matched ' + n + ' elements when the page object was generated.'));
    } else if (el.unique === false) {
      notes.push(comment(lang, 'NOTE: this locator was not unique when the page object was generated.'));
    }
    if (hasAmbiguousRole(el.target) && !(typeof n === 'number' && n !== 1)) {
      notes.push(comment(lang, 'NOTE: this role locator has no accessible name and may match several elements.'));
    }
    if (fw === 'cypress' && hasPositionalFrame(el.target)) {
      notes.push(comment(lang, 'NOTE: this iframe is cross-origin, so contentDocument is null and Cypress cannot reach into it.'));
    }
    return notes;
  }

  /** Normalised element list: valid targets only, with claimed member names. */
  function poMembers(model, fw, lang) {
    var py = lang === 'python';
    var used = {};
    var skipped = 0;
    var members = [];
    (Array.isArray(model.elements) ? model.elements : []).forEach(function (el) {
      if (!el || !el.target || !unwrapFrames(el.target).inner || !locatorExpr(el.target, fw, lang)) { skipped++; return; }
      members.push({ el: el, id: poClaim(poIdent(el.name, py), used, py) });
    });
    members.forEach(function (m) {
      m.helpers = poActions(m.el).map(function (act) {
        var base = py ? act + '_' + m.id : act + m.id.charAt(0).toUpperCase() + m.id.slice(1);
        return { act: act, id: poClaim(base, used, py) };
      });
    });
    return { members: members, skipped: skipped };
  }

  function poHeader(model, lang, skipped) {
    var lines = [comment(lang, 'Page Object generated by Locatra' + (model.title ? ' for "' + commentSafe(model.title) + '"' : '') + '.')];
    if (model.pageUrl) lines.push(comment(lang, 'Page: ' + commentSafe(model.pageUrl).slice(0, 80)));
    if (skipped) lines.push(comment(lang, 'NOTE: ' + skipped + ' element(s) without a usable locator were left out.'));
    return lines.join('\n') + '\n';
  }

  function block(lines, pad) { return indent(lines, pad); }

  // ── Playwright ──────────────────────────────────────────────────────────────
  function poPlaywright(model, lang, cls, info) {
    var py = lang === 'python';
    var ts = lang === 'typescript';
    var url = model.pageUrl ? String(model.pageUrl) : '';
    var members = info.members;
    if (py) {
      var body = ['def __init__(self, page: Page) -> None:'];
      var init = ['self.page = page'];
      members.forEach(function (m) {
        init = init.concat(poNote(m.el, 'playwright', lang), ['self.' + m.id + ' = ' + locatorExpr(m.el.target, 'playwright', lang)]);
      });
      body.push(block(init, '    '));
      if (url) body.push('', 'def goto(self) -> None:', '    self.page.goto(' + q(url, lang) + ')');
      members.forEach(function (m) {
        m.helpers.forEach(function (h) {
          var recv = 'self.' + m.id;
          body.push('');
          if (h.act === 'fill') body.push('def ' + h.id + '(self, value: str) -> None:', '    ' + recv + '.fill(value)');
          else if (h.act === 'select') body.push('def ' + h.id + '(self, value: str) -> None:', '    ' + recv + '.select_option(value)');
          else body.push('def ' + h.id + '(self) -> None:', '    ' + recv + '.' + h.act + '()');
        });
      });
      return poHeader(model, lang, info.skipped) + 'from playwright.sync_api import Page\n\n\n' +
        'class ' + cls + ':\n' + block(body, '    ') + '\n';
    }
    var out = [];
    if (ts) {
      out.push('readonly page: Page;');
      members.forEach(function (m) { out.push('readonly ' + m.id + ': Locator;'); });
      out.push('');
    }
    var ctor = ['this.page = page;'];
    members.forEach(function (m) {
      ctor = ctor.concat(poNote(m.el, 'playwright', lang), ['this.' + m.id + ' = ' + locatorExpr(m.el.target, 'playwright', lang) + ';']);
    });
    out.push('constructor(page' + (ts ? ': Page' : '') + ') {', block(ctor, '  '), '}');
    var ret = ts ? ': Promise<void>' : '';
    if (url) out.push('', 'async goto()' + ret + ' {', '  await this.page.goto(' + q(url, lang) + ');', '}');
    members.forEach(function (m) {
      m.helpers.forEach(function (h) {
        var recv = 'this.' + m.id;
        out.push('');
        if (h.act === 'fill' || h.act === 'select') {
          out.push('async ' + h.id + '(value' + (ts ? ': string' : '') + ')' + ret + ' {',
            '  await ' + recv + (h.act === 'fill' ? '.fill(value);' : '.selectOption(value);'), '}');
        } else {
          out.push('async ' + h.id + '()' + ret + ' {', '  await ' + recv + '.' + h.act + '();', '}');
        }
      });
    });
    var head = ts ? "import { type Page, type Locator } from '@playwright/test';\n\n" : '';
    if (!ts) head = comment(lang, 'Usage: const ' + cls.charAt(0).toLowerCase() + cls.slice(1) + ' = new ' + cls + '(page);') + '\n\n';
    return poHeader(model, lang, info.skipped) + head + 'export class ' + cls + ' {\n' + block(out, '  ') + '\n}\n';
  }

  // ── Selenium ────────────────────────────────────────────────────────────────
  // Elements are looked up on every access (never cached), so a re-rendered page
  // cannot hand back a stale element. Selenium can only search the document the
  // driver is switched to, so when any element lives in a frame every lookup first
  // returns to the top document and then enters that element's frames.
  function poSelenium(model, lang, cls, info) {
    var py = lang === 'python';
    var ts = lang === 'typescript';
    var url = model.pageUrl ? String(model.pageUrl) : '';
    var members = info.members;
    var anyFrames = members.some(function (m) { return unwrapFrames(m.el.target).frames.length > 0; });
    var self = py ? 'self' : 'this';
    var findOf = function (m) {
      return rebaseReceiver(locatorExpr(m.el.target, 'selenium', lang), 'driver', self + '.driver');
    };
    var switchesOf = function (m) {
      if (!anyFrames) return [];
      var lines = [py ? 'self.driver.switch_to.default_content()' : 'await this.driver.switchTo().defaultContent();'];
      unwrapFrames(m.el.target).frames.forEach(function (f) {
        lines.push(rebaseReceiver(selFrameSwitch(f, lang), 'driver', self + '.driver'));
      });
      return lines;
    };
    var body = [];
    if (py) {
      body.push('def __init__(self, driver: WebDriver) -> None:', '    self.driver = driver');
      if (url) body.push('', 'def goto(self) -> None:', '    ' + (anyFrames ? 'self.driver.switch_to.default_content()\n    ' : '') + 'self.driver.get(' + q(url, lang) + ')');
      members.forEach(function (m) {
        body.push('');
        body = body.concat(poNote(m.el, 'selenium', lang));
        body.push('@property', 'def ' + m.id + '(self) -> WebElement:', block(switchesOf(m).concat(['return ' + findOf(m)]), '    '));
      });
      members.forEach(function (m) {
        m.helpers.forEach(function (h) {
          var get = 'self.' + m.id;
          body.push('');
          var lines;
          if (h.act === 'fill') {
            body.push('def ' + h.id + '(self, value: str) -> None:');
            lines = SET_VALUE_TYPES_SELENIUM.indexOf(m.el.inputType) !== -1
              ? ['self.driver.execute_script(' + q(SET_VALUE_JS, lang) + ', ' + get + ', value)']
              : ['el = ' + get, 'el.clear()', 'el.send_keys(value)'];
          } else if (h.act === 'select') {
            body.push('def ' + h.id + '(self, value: str) -> None:');
            lines = ['Select(' + get + ').select_by_visible_text(value)'];
          } else if (h.act === 'check' || h.act === 'uncheck') {
            body.push('def ' + h.id + '(self) -> None:');
            lines = ['el = ' + get, 'if ' + (h.act === 'check' ? 'not ' : '') + selCheckedExpr('el', lang) + ':', '    el.click()'];
          } else {
            body.push('def ' + h.id + '(self) -> None:');
            lines = [get + '.click()'];
          }
          body.push(block(lines, '    '));
        });
      });
      var joinedPy = body.join('\n');
      var imports = ['from selenium.webdriver.common.by import By', 'from selenium.webdriver.remote.webdriver import WebDriver',
        'from selenium.webdriver.remote.webelement import WebElement'];
      if (/\bSelect\(/.test(joinedPy)) imports.push('from selenium.webdriver.support.ui import Select');
      return poHeader(model, lang, info.skipped) + imports.join('\n') + '\n\n\n' + 'class ' + cls + ':\n' + block(body, '    ') + '\n';
    }
    if (ts) body.push('readonly driver: WebDriver;', '');
    body.push('constructor(driver' + (ts ? ': WebDriver' : '') + ') {', '  this.driver = driver;', '}');
    var ret = ts ? ': Promise<void>' : '';
    if (url) {
      body.push('', 'async goto()' + ret + ' {');
      if (anyFrames) body.push('  await this.driver.switchTo().defaultContent();');
      body.push('  await this.driver.get(' + q(url, lang) + ');', '}');
    }
    members.forEach(function (m) {
      body.push('');
      body = body.concat(poNote(m.el, 'selenium', lang));
      if (anyFrames) {
        body.push('async ' + m.id + '()' + (ts ? ': Promise<WebElement>' : '') + ' {',
          block(switchesOf(m).concat(['return ' + findOf(m) + ';']), '  '), '}');
      } else {
        body.push(m.id + '()' + (ts ? ': WebElementPromise' : '') + ' {', '  return ' + findOf(m) + ';', '}');
      }
    });
    members.forEach(function (m) {
      m.helpers.forEach(function (h) {
        var get = 'await this.' + m.id + '()';
        var lines;
        var sig = h.act === 'fill' || h.act === 'select' ? '(value' + (ts ? ': string' : '') + ')' : '()';
        if (h.act === 'fill') {
          lines = SET_VALUE_TYPES_SELENIUM.indexOf(m.el.inputType) !== -1
            ? ['await this.driver.executeScript(' + q(SET_VALUE_JS, lang) + ', ' + get + ', value);']
            : ['const el = ' + get + ';', 'await el.clear();', 'await el.sendKeys(value);'];
        } else if (h.act === 'select') {
          lines = ['await new Select(' + get + ').selectByVisibleText(value);'];
        } else if (h.act === 'check' || h.act === 'uncheck') {
          lines = ['const el = ' + get + ';', 'if (' + (h.act === 'check' ? '!' : '') + selCheckedExpr('el', lang) + ') await el.click();'];
        } else {
          lines = ['await (' + get + ').click();'];
        }
        body.push('', 'async ' + h.id + sig + ret + ' {', block(lines, '  '), '}');
      });
    });
    var joined = body.join('\n');
    var names = ['By'];
    if (/new Select\(/.test(joined)) names.push('Select');
    var cls0 = 'class ' + cls + ' {\n' + block(body, '  ') + '\n}\n';
    if (ts) {
      // @types/selenium-webdriver declares Select only in its own module.
      var tsImports = "import { By, type WebDriver, " + (anyFrames ? 'type WebElement' : 'type WebElementPromise') +
        " } from 'selenium-webdriver';\n";
      if (names.indexOf('Select') !== -1) tsImports += "import { Select } from 'selenium-webdriver/lib/select.js';\n";
      return poHeader(model, lang, info.skipped) + tsImports + '\nexport ' + cls0;
    }
    return poHeader(model, lang, info.skipped) + 'const { ' + names.join(', ') + " } = require('selenium-webdriver');\n\n" +
      cls0 + '\nmodule.exports = { ' + cls + ' };\n';
  }

  // ── Cypress ─────────────────────────────────────────────────────────────────
  function poCypress(model, lang, cls, info) {
    var ts = lang === 'typescript';
    var url = model.pageUrl ? String(model.pageUrl) : '';
    var members = info.members;
    var body = [];
    if (url) body.push('visit()' + (ts ? ': void' : '') + ' {', '  cy.visit(' + q(url, lang) + ');', '}');
    members.forEach(function (m) {
      if (body.length) body.push('');
      body = body.concat(poNote(m.el, 'cypress', lang));
      body.push(m.id + '() {', '  return ' + locatorExpr(m.el.target, 'cypress', lang) + ';', '}');
    });
    members.forEach(function (m) {
      m.helpers.forEach(function (h) {
        var get = 'this.' + m.id + '()';
        var sig = h.act === 'fill' || h.act === 'select' ? '(value' + (ts ? ': string' : '') + ')' : '()';
        var lines;
        if (h.act === 'fill') {
          lines = SET_VALUE_TYPES_CYPRESS.indexOf(m.el.inputType) !== -1
            ? [get + ".invoke('val', value).trigger('input').trigger('change');"]
            // cy.type('') throws, and a literal "{" in a value is text, not a key.
            : ["if (value === '') " + get + '.clear();', 'else ' + get + '.clear().type(value, { parseSpecialCharSequences: false });'];
        } else if (h.act === 'select') {
          lines = [get + '.select(value);'];
        } else if (h.act === 'check' || h.act === 'uncheck') {
          lines = [get + cyToggle(h.act === 'check')];
        } else {
          lines = [get + '.click();'];
        }
        if (body.length) body.push('');
        body.push(h.id + sig + (ts ? ': void' : '') + ' {', block(lines, '  '), '}');
      });
    });
    var all = body.join('\n');
    var helper = usesCyHelper([all]) ? cyHelperSource(lang) + '\n\n' : '';
    return poHeader(model, lang, info.skipped) + helper + 'export class ' + cls + ' {\n' + block(body, '  ') + '\n}\n';
  }

  function pageObject(model, fw, lang) {
    model = model || {};
    lang = pluginLang(fw, lang);
    var plug = targetFor(fw, lang);
    if (plug) return plug.pageObject(model, lang);
    if (!isValidCombo(fw, lang)) lang = 'typescript';
    var cls = poClassName(model);
    var info = poMembers(model, fw, lang);
    if (fw === 'selenium') return poSelenium(model, lang, cls, info);
    if (fw === 'cypress') return poCypress(model, lang, cls, info);
    return poPlaywright(model, lang, cls, info);
  }

  /** The file name a page object downloads as: <ClassName>.ts|.js|.py */
  function pageObjectFileName(model, fw, lang) {
    lang = pluginLang(fw, lang);
    if (!isValidCombo(fw, lang)) lang = 'typescript';
    var ext = LANG_EXT[lang] || '.ts';
    return poClassName(model || {}) + ext;
  }

  var LLCodegen = {
    FRAMEWORKS: FRAMEWORKS,
    LANGUAGES: LANGUAGES,
    isValidCombo: isValidCombo,
    languagesFor: languagesFor,
    locatorExpr: locatorExpr,
    actionStatement: actionStatement,
    wrapScript: wrapScript,
    testScript: testScript,
    pageObject: pageObject,
    pageObjectClassName: function (model) { return poClassName(model || {}); },
    pageObjectFileName: pageObjectFileName,
    q: q,
    extractVariables: extractVariables,
    applyVariables: applyVariables,
    variablesJson: variablesJson,
    isValidVariableName: isValidVariableName,
    validateVariableName: validateVariableName,
    variableKey: variableKey,
    registerTarget: registerTarget,
    fileExtension: function (lang) { return LANG_EXT[lang] || '.ts'; },
    // Shared building blocks for registered targets (codegen-*.js). Not a stable
    // public API: only the target modules in this repository use it.
    _internals: {
      escapeControls: escapeControls, attrSel: attrSel, normWs: normWs, cssIdent: cssIdent,
      xpathLiteral: xpathLiteral, roleCss: roleCss, roleNodeXpath: roleNodeXpath, nameXpath: nameXpath,
      labelXpath: labelXpath, textXpath: textXpath, xpMatch: xpMatch, attrMatchSel: attrMatchSel,
      explicitRole: explicitRole, roleNatives: roleNatives, LABELLED_ROLES: LABELLED_ROLES,
      PLACEHOLDER_ROLES: PLACEHOLDER_ROLES, ALT_ROLES: ALT_ROLES, LABELABLE_XPATH: LABELABLE_XPATH,
      LABELABLE_CSS: LABELABLE_CSS, unwrapFrames: unwrapFrames, validShadowPath: validShadowPath,
      hasNth: hasNth, isAmbiguousRole: isAmbiguousRole, hasAmbiguousRole: hasAmbiguousRole,
      hasPositionalFrame: hasPositionalFrame, parseKeyCombo: parseKeyCombo, KEY_SELENIUM: KEY_SELENIUM,
      MOD_SELENIUM: MOD_SELENIUM, REAL_PRESS_MODS: REAL_PRESS_MODS, secretName: secretName,
      uploadFiles: uploadFiles, parseViewport: parseViewport, vpW: vpW, vpH: vpH,
      isSuggested: isSuggested, commentSafe: commentSafe, indent: indent,
      SET_VALUE_TYPES_SELENIUM: SET_VALUE_TYPES_SELENIUM, SET_VALUE_JS: SET_VALUE_JS,
      KNOWN_ACTIONS: KNOWN_ACTIONS, TARGETLESS_ACTIONS: TARGETLESS_ACTIONS, urlOrigin: urlOrigin,
      poClassName: poClassName, poWords: poWords, poIdent: poIdent, poClaim: poClaim,
      PO_RESERVED: PO_RESERVED, cap: cap,
      // test-data variables: the name rules, and what a step / script references
      VAR_RESERVED: VAR_RESERVED, VAR_NAME_RE: VAR_NAME_RE, isValidVariableName: isValidVariableName,
      deriveVariableName: deriveVariableName, variableKey: variableKey, pyVarKey: pyVarKey,
      variableRefName: variableRefName, variableRef: variableRef, scriptVariables: scriptVariables,
      variablesDeclaration: variablesDeclaration, varEligible: varEligible
    }
  };

  global.LLCodegen = LLCodegen;
  if (typeof module !== 'undefined' && module.exports) module.exports = LLCodegen;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
