// Locatra – codegen.js
// Pure, framework/language-agnostic code generator.
// Turns a structured locator `target` (produced by content-locator-engine.js) plus
// an action into runnable test code for Playwright / Selenium / Cypress in
// JavaScript / TypeScript / Python (Java, C# and WebdriverIO register themselves
// from codegen-java.js, codegen-csharp.js and codegen-wdio.js).
//
// A `target` is one of:
//   { kind: 'testid', attr, value }
//   { kind: 'role', role, name?, level? }
//   { kind: 'label'|'placeholder'|'altText'|'title'|'text'|'id'|'name'|'css', value }
//   { kind: 'xpath', value }   — a short element-specific XPath (C9.1: Playwright
//       `xpath=…`, Selenium By.xpath, WebdriverIO $('//…'); Cypress has no XPath, so
//       it is never chosen there — forced, locatraGet() evaluates it, with a NOTE)
//   { kind: 'chain', parent, child }   — child scoped inside parent (both targets)
//   { kind: 'frame', selector, index, child }  — child inside an iframe. `selector`
//       addresses the <iframe> in its parent document; when the frame is
//       cross-origin its element is unreachable, so only `index` is known and the
//       generators fall back to positional frame addressing. Nests for deep frames.
//       `index` is the frame's position among the parent document's <iframe>
//       elements in composed (shadow-piercing) order — exact even behind a
//       cross-origin parent, whose own content script reports it via the worker.
//       Optional `shadowPath` (an <iframe> inside shadow DOM): one CSS selector per
//       tree, outermost first — the first host in the parent document, each further
//       host in the previous host's shadow root, the <iframe> in the last root.
//       Selenium and Cypress walk it host by host, since neither one's CSS pierces
//       shadow roots; Playwright keeps using `selector`, which its CSS resolves
//       across the composed tree. Without a selector every framework finds the
//       frame by `index` (Playwright `iframe >> nth=i`; the others run the same
//       shadow-piercing walk, DEEP_IFRAME_JS / locatraFrame()). A bare number is never
//       handed to Selenium: ChromeDriver counts /html/body//iframe, geckodriver
//       window.frames. `framesIndex` (window.frames order) is for replay only.
// The innermost (non-frame) target may carry `shadowHosts` and `shadowCss` when its
// element is inside open shadow DOM (C3, see shadowOf()).
//
// Alternatives (C9): a step, a picked element or a page-object element may carry
// `altTargets` — up to three complete targets for the same element (test id, id,
// name, short CSS, short XPath), best first. preferredTarget(primary, altTargets,
// framework) picks what to render: Playwright always the primary; every other
// framework the first alternative it can use natively when the primary is a role /
// label / text target (or a chain holding one). actionStatement() and pageObject()
// apply it themselves; locatorExpr() renders exactly the target it is given.
//
// Helpers (C9.4): outside Playwright a role / label / text target is found by a
// small helper declared once per file, only when used, so no call site carries the
// accessible-name computation: locatraFind(driver, 'role', 'textbox', 'Email')
// (Selenium JS/TS), locatra_find(driver, …) (Python), Locatra.find(driver, …)
// (Java), Locatra.Find(driver, …) (C#), await locatraFind('role', …)
// (WebdriverIO), locatraGet('role', …) (Cypress). All run MATCH_SRC in the page, a
// port of the engine's matching, and insist on exactly one match (see MATCH_SRC). A
// file embeds the matcher compacted (compactPieces: no comments or white space, short
// local names; proven the same program by tests/codegen-helpers.dom.test.mjs), and
// every line a helper declaration emits stays within HELPER_WIDTH (120) columns. A
// text assertion outside Playwright reads the rendered text through a helper too —
// locatraText(el) (Selenium JS/TS, Cypress), locatra_text(el) (Python),
// Locatra.text(el) (Java), Locatra.Text(el) (C#), the LOCATRA_TEXT options
// (WebdriverIO) — declared once per file, only when used.
// The page scripts statements run are declared once too: LOCATRA_FRAME_JS (a
// cross-origin frame by position) and LOCATRA_SET_VALUE_JS (date / range / colour
// values). locatorSnippet(target, framework, language, altTargets?) returns
// { expr, helpers }: the expression and the declarations it needs ('' when none).
//
// An `action` step is: { action, target?, value?, key?, url?, width?, height? }
//   action ∈ click | dblclick | check | uncheck | fill | selectOption | press | goto | viewport
//   A selectOption on a <select multiple> may carry `values` (C1); an assert step
//   may be `sensitive` with a `secretName` (C2).

(function (global) {
  'use strict';

  // ── escaping ──────────────────────────────────────────────────────────────
  // Wrap a value as a string literal for the given language, escaping the wrapper
  // quote. JS/TS use single quotes; Python uses double quotes. CSS attribute
  // selectors below always use double quotes internally, which q() then escapes
  // correctly for whichever language is active.
  // Every C0 control, DEL and the two Unicode line separators are written as escapes:
  // Python rejects a raw NUL in source outright, and a raw control character in a
  // pasted test is invisible at best. So are the invisible spaces and format
  // characters a page's text routinely holds (no-break spaces, soft hyphens,
  // zero-width characters, the BOM): a pasted literal should never hide them. \xNN
  // and \uNNNN mean the same thing in JS/TS and Python string literals.
  var NAMED_ESCAPES = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
  function escapeControls(s) {
    // eslint-disable-next-line no-control-regex
    return s.replace(/[\x00-\x1f\x7f\u00a0\u00ad\u200b-\u200f\u2028\u2029\u202f\u2060\ufeff]/g, function (c) {
      if (NAMED_ESCAPES[c]) return NAMED_ESCAPES[c];
      var code = c.charCodeAt(0);
      if (code > 0xff) return '\\u' + ('000' + code.toString(16)).slice(-4);
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

  // Playwright's normalizeWhiteSpace (and the engine's) also drops soft hyphens and
  // zero-width spaces, which render as nothing: "Bundes\u00adregierung" reads, and
  // is recorded, as "Bundesregierung".
  function normText(value) {
    return normWs(String(value == null ? '' : value).replace(/[\u00ad\u200b]/g, ''));
  }

  // ── numeric target fields ───────────────────────────────────────────────────
  // Every number a target or step carries is emitted as code, never inside a string
  // literal, so it is validated first: a recording is data, and a hand-edited or
  // corrupted one must not be able to write code into the test.
  /** A heading level: an integer 1–99 (a number or its digit string), else 0 (= none). */
  function headingLevel(value) {
    var n = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
    return typeof n === 'number' && n >= 1 && n <= 99 && Math.floor(n) === n ? n : 0;
  }

  /** A non-negative integer (a number or its digit string), else `fallback`. */
  function nonNegInt(value, fallback) {
    var n = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
    return typeof n === 'number' && n >= 0 && Math.floor(n) === n && isFinite(n) ? n : fallback;
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

  // ── Locatra helpers: role / label / text lookups outside Playwright (C9.4) ──
  // Only Playwright has getByRole / getByLabel / getByText. Selenium (every
  // language), WebdriverIO and Cypress call a small helper instead — locatraFind
  // (Selenium JS/TS, WebdriverIO), locatra_find (Python), Locatra.find (Java),
  // Locatra.Find (C#), locatraGet (Cypress) — declared once per script or page
  // object, and only when a step uses it, so a call site stays one short line:
  //   await locatraFind(driver, 'role', 'textbox', 'Username or Email')
  // (spelling the accessible-name computation out as XPath put kilobytes of it into
  // every call). Each helper runs MATCH_SRC in the page: a port of the engine's own
  // matching (content-locator-engine.js — getRole, the accessible name, getByLabel's
  // label texts, getByText's innermost element; exact, or a case-insensitive
  // substring; no-break spaces and soft hyphens normalised; open shadow roots
  // pierced; in the current frame), so the exported test finds what the panel
  // counted. It waits like the framework's own lookup and insists on exactly one
  // match — several is an error naming the count — except a positional role locator
  // (`nth`), which takes that match. Arguments: kind ('role' | 'label' | 'text';
  // Cypress also 'xpath'), value (the role, or the text), name (a role's accessible
  // name), exact, level, scope (a chain's parent element or a frame's body; null =
  // the document). `$T{…}` holds TypeScript-only annotations: Cypress declares the
  // matcher as a function, every WebDriver target embeds it as a script (MATCH_JS).
  var MATCH_SRC = String.raw`function locatraMatch(kind$T{: string}, value$T{: string}, name$T{: string | null}, exact$T{: boolean}, level$T{: number}, scope$T{: any})$T{: any[]} {
  const doc$T{: any} = !scope ? document : scope.nodeType === 9 ? scope : scope.ownerDocument;
  const has = (list$T{: string}, word$T{: string})$T{: boolean} => word !== '' && (' ' + list + ' ').indexOf(' ' + word + ' ') !== -1;
  const norm = (s$T{: any})$T{: string} => String(s == null ? '' : s).replace(/[\u200b\u00ad]/g, '').trim().replace(/\s+/g, ' ');
  const tag = (e$T{: any})$T{: string} => (typeof e.tagName === 'string' ? e.tagName.toUpperCase() : '');
  const memo = (fn$T{: (e: any) => any})$T{: (e: any) => any} => {
    const seen = new Map$T{<any, any>}();
    return (e$T{: any}) => {
      if (!seen.has(e)) seen.set(e, fn(e));
      return seen.get(e);
    };
  };
  // Every element, the document's first and then each open shadow root's.
  const roots$T{: any[]} = [];
  const collect = (r$T{: any}, depth$T{: number})$T{: void} => {
    roots.push(r);
    if (depth >= 256) return;
    if (r.shadowRoot) collect(r.shadowRoot, depth + 1);
    r.querySelectorAll('*').forEach((e$T{: any}) => {
      if (e.shadowRoot) collect(e.shadowRoot, depth + 1);
    });
  };
  collect(doc, 0);
  const all$T{: any[]} = [];
  roots.forEach((r) => r.querySelectorAll('*').forEach((e$T{: any}) => all.push(e)));
  const up = (e$T{: any})$T{: any} => e.parentElement || (e.parentNode && e.parentNode.nodeType === 11 ? e.parentNode.host : null);
  const closest = (e$T{: any}, sel$T{: string})$T{: any} => {
    for (let n = e; n; ) {
      const c = n.closest(sel);
      if (c) return c;
      const r = n.getRootNode();
      n = r.nodeType === 11 ? r.host : null;
    }
    return null;
  };
  const inside = (a$T{: any}, n$T{: any})$T{: boolean} => {
    for (; n; n = n.nodeType === 11 ? n.host : n.parentNode) if (n === a) return true;
    return false;
  };
  const byIds = (e$T{: any}, ref$T{: any})$T{: any[]} => {
    const r = e.getRootNode();
    const out$T{: any[]} = [];
    if (!ref || !r || !r.getElementById) return out;
    ref.split(' ').forEach((id$T{: string}) => {
      const f = id ? r.getElementById(id) : null;
      if (f && out.indexOf(f) === -1) out.push(f);
    });
    return out;
  };
  const styleOf = (e$T{: any}, pseudo$T{?: string})$T{: any} => {
    try {
      const v = e.ownerDocument.defaultView;
      return v ? v.getComputedStyle(e, pseudo || null) : null;
    } catch (x) {
      return null;
    }
  };
  const style = memo((e) => styleOf(e));

  // Hidden from the accessibility tree (getByRole skips those elements).
  const ignored = (e$T{: any})$T{: boolean} => has('STYLE SCRIPT NOSCRIPT TEMPLATE', tag(e));
  const hiddenTree$T{: (e: any) => boolean} = memo((e) => {
    const p = e.parentElement;
    if (p && p.shadowRoot && 'assignedSlot' in e && !e.assignedSlot) return true;
    const s = style(e);
    if (s && s.display === 'none') return true;
    if ((e.getAttribute('aria-hidden') || '').toLowerCase() === 'true') return true;
    const u = up(e);
    return u ? hiddenTree(u) : false;
  });
  const shown = (e$T{: any}, s$T{: any})$T{: boolean} => {
    if (!s) return true;
    if (typeof e.checkVisibility === 'function') {
      try {
        if (!e.checkVisibility()) return false;
      } catch (x) {}
    } else {
      const d = e.closest('details,summary');
      if (d !== e && d && tag(d) === 'DETAILS' && !d.open) return false;
    }
    return s.visibility === 'visible' || !s.visibility;
  };
  const hidden$T{: (e: any) => boolean} = memo((e) => {
    if (ignored(e)) return true;
    const s = style(e);
    const slot = e.nodeName === 'SLOT';
    if (s && s.display === 'contents' && !slot) {
      for (let c = e.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 1 && !hidden(c)) return false;
        if (c.nodeType === 3 && /\S/.test(c.nodeValue || '')) return false;
      }
      return true;
    }
    const option = e.nodeName === 'OPTION' && !!e.closest('select');
    if (!option && !slot && !shown(e, s)) return true;
    return hiddenTree(e);
  });

  // The ARIA role (Playwright's getAriaRole): the first valid token of the role
  // attribute, else the implicit role, which role="none"/"presentation" leaves in
  // place on an element that can take focus or has a global ARIA attribute.
  const VALID = 'alert alertdialog application article banner blockquote button caption cell checkbox code ' +
    'columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed ' +
    'figure form generic grid gridcell group heading img insertion link list listbox listitem log main mark marquee ' +
    'math meter menu menubar menuitem menuitemcheckbox menuitemradio navigation none note option paragraph ' +
    'presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator ' +
    'slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time ' +
    'timer toolbar tooltip tree treegrid treeitem';
  const GLOBAL = ['aria-atomic', 'aria-busy', 'aria-controls', 'aria-current', 'aria-describedby', 'aria-details',
    'aria-dropeffect', 'aria-flowto', 'aria-grabbed', 'aria-hidden', 'aria-keyshortcuts', 'aria-label',
    'aria-labelledby', 'aria-live', 'aria-owns', 'aria-relevant', 'aria-roledescription'];
  const NAMELESS = 'caption code deletion emphasis generic insertion paragraph presentation strong subscript superscript';
  const TAGS$T{: Record<string, string>} = { ARTICLE: 'article', ASIDE: 'complementary', BLOCKQUOTE: 'blockquote',
    BUTTON: 'button', CAPTION: 'caption', CODE: 'code', DATALIST: 'listbox', DD: 'definition', DEL: 'deletion',
    DETAILS: 'group', DFN: 'term', DIALOG: 'dialog', DT: 'term', EM: 'emphasis', FIELDSET: 'group', FIGURE: 'figure',
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading', HR: 'separator',
    HTML: 'document', INS: 'insertion', LI: 'listitem', MAIN: 'main', MARK: 'mark', MATH: 'math', MENU: 'list',
    METER: 'meter', NAV: 'navigation', OL: 'list', OPTGROUP: 'group', OPTION: 'option', OUTPUT: 'status',
    P: 'paragraph', PROGRESS: 'progressbar', SEARCH: 'search', STRONG: 'strong', SUB: 'subscript',
    SUP: 'superscript', SVG: 'img', TABLE: 'table', TBODY: 'rowgroup', TEXTAREA: 'textbox', TFOOT: 'rowgroup',
    THEAD: 'rowgroup', TIME: 'time', TR: 'row', UL: 'list' };
  const INPUTS$T{: Record<string, string>} = { button: 'button', checkbox: 'checkbox', file: 'button', image: 'button',
    number: 'spinbutton', radio: 'radio', range: 'slider', reset: 'button', submit: 'button' };
  // A presentational list, table or <dl> makes its items presentational too.
  const OWNERS$T{: Record<string, string>} = { DD: 'DL DIV', DIV: 'DL', DT: 'DL DIV', LI: 'OL UL', TBODY: 'TABLE',
    TD: 'TR', TFOOT: 'TABLE', TH: 'TR', THEAD: 'TABLE', TR: 'THEAD TBODY TFOOT TABLE' };
  const LANDMARK_STOP = 'article:not([role]), aside:not([role]), main:not([role]), nav:not([role]), ' +
    'section:not([role]), [role=article], [role=complementary], [role=main], [role=navigation], [role=region]';
  const explicit = (e$T{: any})$T{: string | null} => (e.getAttribute('role') || '').split(' ')
    .map((r$T{: string}) => r.trim()).find((r$T{: string}) => has(VALID, r)) || null;
  const aria = (e$T{: any}, role$T{: string | null})$T{: boolean} => GLOBAL.some((a) => e.hasAttribute(a) &&
    !(a === 'aria-roledescription' ? role === 'generic' : a.indexOf('aria-label') === 0 && has(NAMELESS, role || '')));
  const tabbable = (e$T{: any})$T{: boolean} => !isNaN(Number(String(e.getAttribute('tabindex'))));
  const focusable = (e$T{: any})$T{: boolean} => {
    const t = tag(e);
    if (has('BUTTON INPUT SELECT TEXTAREA OPTION OPTGROUP', t)) {
      try {
        if (e.matches(':disabled')) return false;
      } catch (x) {
        if (e.hasAttribute('disabled')) return false;
      }
    }
    if (has('BUTTON DETAILS SELECT TEXTAREA', t) || ((t === 'A' || t === 'AREA') && e.hasAttribute('href'))) return true;
    return (t === 'INPUT' && !e.hidden) || tabbable(e);
  };
  const filled = (e$T{: any})$T{: boolean} => !!e && tag(e) === 'TD' && (!!(e.textContent || '').trim() || e.children.length > 0);
  const own = (e$T{: any})$T{: string | null} => {
    const t = tag(e);
    if (Object.prototype.hasOwnProperty.call(TAGS, t)) return TAGS[t];
    if (t === 'A' || t === 'AREA') return e.hasAttribute('href') ? 'link' : null;
    if (t === 'FORM' || t === 'SECTION') {
      if (!e.hasAttribute('aria-label') && !e.hasAttribute('aria-labelledby')) return null;
      return t === 'FORM' ? 'form' : 'region';
    }
    if (t === 'HEADER' || t === 'FOOTER') return closest(e, LANDMARK_STOP) ? null : t === 'HEADER' ? 'banner' : 'contentinfo';
    if (t === 'IMG') {
      const decorative = e.getAttribute('alt') === '' && !e.getAttribute('title') && !aria(e, null) && !tabbable(e);
      return decorative ? 'presentation' : 'img';
    }
    if (t === 'SELECT') return e.hasAttribute('multiple') || e.size > 1 ? 'listbox' : 'combobox';
    if (t === 'TD') {
      const table = closest(e, 'table');
      const r = table ? explicit(table) : null;
      return r === 'grid' || r === 'treegrid' ? 'gridcell' : 'cell';
    }
    if (t === 'TH') {
      const scope = e.getAttribute('scope');
      if (scope === 'col' || scope === 'colgroup') return 'columnheader';
      if (scope === 'row' || scope === 'rowgroup') return 'rowheader';
      const next = e.nextElementSibling;
      const prev = e.previousElementSibling;
      if (!next && !prev) {
        const row = e.parentElement && tag(e.parentElement) === 'TR' ? e.parentElement : null;
        const table = row ? closest(row, 'table') : null;
        return table && table.rows && table.rows.length <= 1 ? null : 'columnheader';
      }
      return filled(next) || filled(prev) ? 'rowheader' : 'columnheader';
    }
    if (t === 'INPUT') {
      const type = String(e.type || '').toLowerCase();
      if (type === 'search') return e.hasAttribute('list') ? 'combobox' : 'searchbox';
      if (type === '' || has('email tel text url', type)) {
        const list = byIds(e, e.getAttribute('list'))[0];
        return list && tag(list) === 'DATALIST' ? 'combobox' : 'textbox';
      }
      if (type === 'hidden') return null;
      return Object.prototype.hasOwnProperty.call(INPUTS, type) ? INPUTS[type] : 'textbox';
    }
    return null;
  };
  const implicit = (e$T{: any})$T{: string | null} => {
    const r = own(e);
    if (!r) return null;
    for (let a = e, p = up(e); p && has(OWNERS[tag(a)] || '', tag(p)); a = p, p = up(p)) {
      const pr = explicit(p);
      if ((pr === 'none' || pr === 'presentation') && !(aria(p, pr) || focusable(p))) return pr;
    }
    return r;
  };
  const roleOf$T{: (e: any) => string | null} = memo((e) => {
    const r = explicit(e);
    if (!r) return implicit(e);
    if (r === 'none' || r === 'presentation') {
      const i = implicit(e);
      if (aria(e, i) || focusable(e)) return i;
    }
    return r;
  });
  const levelOf = (e$T{: any})$T{: number} => {
    const m = /^H([1-6])$/.exec(tag(e));
    if (m) return Number(m[1]);
    if (!has('heading listitem row treeitem', roleOf(e) || '')) return 0;
    const v = e.getAttribute('aria-level') === null ? NaN : Number(e.getAttribute('aria-level'));
    return Math.floor(v) === v && v >= 1 ? v : 0;
  };

  // Text as getByText reads it (textContent-like, shadow roots appended).
  const skipText = (n$T{: any})$T{: boolean} => has('SCRIPT NOSCRIPT STYLE', n.nodeName) ||
    !!(n.ownerDocument && n.ownerDocument.head && n.ownerDocument.head.contains(n));
  const textOf$T{: (e: any) => string} = memo((r) => {
    let full = '';
    if (skipText(r)) return full;
    if (r.nodeName === 'INPUT' && (r.type === 'submit' || r.type === 'button')) return r.value || '';
    for (let c = r.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) full += c.nodeValue || '';
      else if (c.nodeType === 1) full += textOf(c);
    }
    return r.shadowRoot ? full + textOf(r.shadowRoot) : full;
  });
  const matches = (text$T{: string}, want$T{: string})$T{: boolean} => {
    const t = norm(text);
    const w = norm(want);
    return exact ? t === w : t.toLowerCase().indexOf(w.toLowerCase()) !== -1;
  };

  // Labels: <label for> / a wrapping <label>, resolved once for every control.
  const CONTROLS = 'BUTTON INPUT METER OUTPUT PROGRESS SELECT TEXTAREA';
  const labelMap = new Map$T{<any, any[]>}();
  all.forEach((l) => {
    if (tag(l) !== 'LABEL') return;
    let c$T{: any} = null;
    try {
      if ('control' in l) c = l.control;
      else if (l.getAttribute('for')) {
        c = l.getRootNode().getElementById(l.getAttribute('for'));
        if (c && (!has(CONTROLS, tag(c)) || (tag(c) === 'INPUT' && c.type === 'hidden'))) c = null;
      } else c = l.querySelector('button, input:not([type=hidden]), meter, output, progress, select, textarea');
    } catch (x) {}
    if (c) labelMap.set(c, (labelMap.get(c) || []).concat(l));
  });
  const labelsOf = (e$T{: any})$T{: any[]} => {
    const t = tag(e);
    if (!has(CONTROLS, t) || (t === 'INPUT' && e.type === 'hidden')) return [];
    return labelMap.get(e) || [];
  };
  const labelledBy = (e$T{: any})$T{: any[] | null} => {
    const refs = byIds(e, e.getAttribute('aria-labelledby'));
    return refs.length ? refs : null;
  };
  // getByLabel's texts: aria-labelledby, else aria-label, else the <label>s.
  const labelTexts = (e$T{: any})$T{: string[]} => {
    const lb = labelledBy(e);
    if (lb) return lb.map(textOf);
    const al = e.getAttribute('aria-label');
    if (al !== null && al.trim()) return [al];
    return labelsOf(e).map(textOf);
  };

  // The accessible name (Playwright's getElementAccessibleName).
  const FROM_CONTENT = 'button cell checkbox columnheader gridcell heading link menuitem menuitemcheckbox ' +
    'menuitemradio option radio row rowheader switch tab tooltip treeitem';
  const FROM_DESCENDANT = 'caption code contentinfo definition deletion emphasis insertion list listitem mark none ' +
    'paragraph presentation region row rowgroup section strong subscript superscript table term time';
  const PROHIBITED = 'caption code definition deletion emphasis generic insertion mark paragraph presentation strong ' +
    'subscript suggestion superscript term time';
  const cssText = (e$T{: any}, value$T{: string}, pseudo$T{: boolean})$T{: string | null} => {
    const toks$T{: any[]} = [];
    for (let i = 0; i < value.length; ) {
      const c = value[i];
      if (/\s/.test(c)) {
        i++;
      } else if (c === '"' || c === "'") {
        let j = i + 1;
        let out = '';
        while (j < value.length && value[j] !== c) {
          if (value[j] === '\\') {
            const m = /^\\([0-9a-fA-F]{1,6})\s?/.exec(value.slice(j));
            if (m) {
              out += String.fromCodePoint(parseInt(m[1], 16));
              j += m[0].length;
            } else {
              out += value[j + 1] || '';
              j += 2;
            }
          } else {
            out += value[j++];
          }
        }
        toks.push({ t: 'str', v: out });
        i = j + 1;
      } else if (c === '/') {
        toks.push({ t: 'delim' });
        i++;
      } else {
        const attr = /^attr\(\s*([-\w]+)\s*\)/i.exec(value.slice(i));
        const other = attr || /^[-\w]+\([^)]*\)/.exec(value.slice(i)) || /^[^\s/"']+/.exec(value.slice(i));
        toks.push(attr ? { t: 'attr', v: attr[1] } : { t: 'other' });
        i += other ? other[0].length : 1;
      }
    }
    const d = toks.findIndex((t) => t.t === 'delim');
    if (d === -1 && !pseudo) return null;
    let acc = '';
    for (const t of d === -1 ? toks : toks.slice(d + 1)) {
      if (t.t === 'str') acc += t.v;
      else if (t.t === 'attr') acc += e.getAttribute(t.v) || '';
      else return null;
    }
    return acc;
  };
  const cssContent = (e$T{: any}, pseudo$T{?: string})$T{: string | null} => {
    const s = pseudo ? styleOf(e, pseudo) : style(e);
    let content$T{: string | null} = null;
    const v = s ? s.content : '';
    if (v && v !== 'none' && v !== 'normal' && s.display !== 'none' && s.visibility !== 'hidden') {
      try {
        content = cssText(e, v, !!pseudo);
      } catch (x) {}
    }
    if (pseudo && content !== null && (s.display || 'inline') !== 'inline') content = ' ' + content + ' ';
    return content;
  };
  const textAlt = (e$T{: any}, o$T{: any})$T{: string} => {
    if (o.visited.has(e)) return '';
    const childO = Object.assign({}, o, { inTarget: o.inTarget === 'self' ? 'descendant' : o.inTarget });
    const inHidden = !!((o.inLabelledBy && o.inLabelledBy.hidden) || (o.inNative && o.inNative.hidden) ||
      (o.inLabel && o.inLabel.hidden));
    if (ignored(e) || (!inHidden && hidden(e))) {
      o.visited.add(e);
      return '';
    }
    const lb = labelledBy(e);
    if (!o.inLabelledBy) {
      const n = (lb || []).map((r) => textAlt(r, { visited: o.visited, inLabelledBy: { hidden: hidden(r) } })).join(' ');
      if (n) return n;
    }
    const role = roleOf(e) || '';
    const t = tag(e);
    const fromLabels = (labels$T{: any[]})$T{: string} => labels.map((l) => textAlt(l, {
      visited: o.visited, inLabel: { hidden: hidden(l) } })).filter(Boolean).join(' ');
    if ((o.inLabel || o.inLabelledBy || o.inTarget === 'descendant') && !(lb || []).includes(e)) {
      if (role === 'textbox') {
        o.visited.add(e);
        return t === 'INPUT' || t === 'TEXTAREA' ? e.value || '' : e.textContent || '';
      }
      if (role === 'combobox' || role === 'listbox') {
        o.visited.add(e);
        let selected$T{: any[]};
        if (t === 'SELECT') {
          selected = Array.from(e.selectedOptions || []);
          if (!selected.length && e.options && e.options.length) selected.push(e.options[0]);
        } else {
          const box = role === 'combobox' ? Array.from(e.querySelectorAll('*')).find((x) => roleOf(x) === 'listbox') : e;
          selected = box ? Array.from(box.querySelectorAll('[aria-selected="true"]')).filter((x) => roleOf(x) === 'option') : [];
        }
        if (!selected.length && t === 'INPUT') return e.value || '';
        return selected.map((x) => textAlt(x, childO)).join(' ');
      }
      if (has('progressbar scrollbar slider spinbutton meter', role)) {
        o.visited.add(e);
        if (e.hasAttribute('aria-valuetext')) return e.getAttribute('aria-valuetext') || '';
        if (e.hasAttribute('aria-valuenow')) return e.getAttribute('aria-valuenow') || '';
        return e.getAttribute('value') || '';
      }
      if (role === 'menu') {
        o.visited.add(e);
        return '';
      }
    }
    const label = e.getAttribute('aria-label') || '';
    if (label.trim()) {
      o.visited.add(e);
      return label;
    }
    if (role !== 'presentation' && role !== 'none') {
      const type = t === 'INPUT' ? String(e.type || '').toLowerCase() : '';
      if (t === 'INPUT' && has('button submit reset', type)) {
        o.visited.add(e);
        if ((e.value || '').trim()) return e.value;
        if (type === 'submit') return 'Submit';
        if (type === 'reset') return 'Reset';
        return e.getAttribute('title') || '';
      }
      if (t === 'INPUT' && (type === 'file' || type === 'image')) {
        o.visited.add(e);
        const labels = labelsOf(e);
        if (labels.length && !o.inLabelledBy) return fromLabels(labels);
        if (type === 'file') return 'Choose File';
        if ((e.getAttribute('alt') || '').trim()) return e.getAttribute('alt');
        if ((e.getAttribute('title') || '').trim()) return e.getAttribute('title');
        return 'Submit';
      }
      if (!lb && (t === 'BUTTON' || t === 'OUTPUT' || t === 'TEXTAREA' || t === 'SELECT' || t === 'INPUT')) {
        o.visited.add(e);
        const labels = labelsOf(e);
        if (labels.length) return fromLabels(labels);
        if (t === 'OUTPUT') return e.getAttribute('title') || '';
        if (t !== 'BUTTON') {
          const title = e.getAttribute('title') || '';
          const usePlaceholder = t === 'TEXTAREA' || (t === 'INPUT' && has('text password search tel email url', type));
          return !usePlaceholder || title ? title : e.getAttribute('placeholder') || '';
        }
      }
      if (!lb && has('FIELDSET FIGURE TABLE', t)) {
        o.visited.add(e);
        const want = t === 'FIELDSET' ? 'LEGEND' : t === 'FIGURE' ? 'FIGCAPTION' : 'CAPTION';
        for (let c = e.firstElementChild; c; c = c.nextElementSibling) {
          if (tag(c) === want) return textAlt(c, Object.assign({}, childO, { inNative: { hidden: hidden(c) } }));
        }
        if (t !== 'TABLE') return e.getAttribute('title') || '';
        if (e.getAttribute('summary')) return e.getAttribute('summary');
      }
      if (t === 'IMG' || t === 'AREA') {
        o.visited.add(e);
        return (e.getAttribute('alt') || '').trim() ? e.getAttribute('alt') : e.getAttribute('title') || '';
      }
      if (t === 'SVG' || e.ownerSVGElement) {
        o.visited.add(e);
        for (let c = e.firstElementChild; c; c = c.nextElementSibling) {
          if (tag(c) === 'TITLE' && c.ownerSVGElement) {
            return textAlt(c, Object.assign({}, childO, { inLabelledBy: { hidden: hidden(c) } }));
          }
        }
      }
    }
    const fromContent = has(FROM_CONTENT, role) || (o.inTarget === 'descendant' && (role === '' || has(FROM_DESCENDANT, role)));
    if (fromContent || (t === 'SUMMARY' && role !== 'presentation' && role !== 'none') ||
        o.inLabelledBy || o.inLabel || o.inNative) {
      o.visited.add(e);
      const acc = accumulated(e, childO);
      if (o.inTarget === 'self' ? acc.trim() : acc) return acc;
    }
    if ((role !== 'presentation' && role !== 'none') || t === 'IFRAME') {
      o.visited.add(e);
      if ((e.getAttribute('title') || '').trim()) return e.getAttribute('title');
    }
    o.visited.add(e);
    return '';
  };
  const accumulated = (e$T{: any}, o$T{: any})$T{: string} => {
    const out$T{: string[]} = [cssContent(e, '::before') || ''];
    const visit = (n$T{: any}, skipSlotted$T{: boolean})$T{: void} => {
      if (skipSlotted && n.assignedSlot) return;
      if (n.nodeType === 1) {
        const s = style(n);
        const display = (s && s.display) || 'inline';
        const token = textAlt(n, o);
        out.push(display !== 'inline' || n.nodeName === 'BR' ? ' ' + token + ' ' : token);
      } else if (n.nodeType === 3) {
        out.push(n.textContent || '');
      }
    };
    const content = cssContent(e);
    if (content !== null) {
      out.push(content);
    } else {
      const slotted = e.nodeName === 'SLOT' && e.assignedNodes ? e.assignedNodes() : [];
      if (slotted.length) {
        slotted.forEach((n$T{: any}) => visit(n, false));
      } else {
        for (let c = e.firstChild; c; c = c.nextSibling) visit(c, true);
        if (e.shadowRoot) for (let c = e.shadowRoot.firstChild; c; c = c.nextSibling) visit(c, true);
      }
    }
    out.push(cssContent(e, '::after') || '');
    return out.join('');
  };
  const nameOf = (e$T{: any})$T{: string} => (has(PROHIBITED, roleOf(e) || '') ? '' :
    norm(textAlt(e, { visited: new Set(), inTarget: 'self' })));

  let found$T{: any[]};
  if (kind === 'xpath') {
    const base = scope && scope.nodeType === 1 ? scope : doc;
    const path = base !== doc && value.charAt(0) === '/' ? '.' + value : value;
    const r = doc.evaluate(path, base, null, 7, null);
    found = [];
    for (let i = 0; i < r.snapshotLength; i++) if (r.snapshotItem(i).nodeType === 1) found.push(r.snapshotItem(i));
    return found;
  }
  if (kind === 'role') {
    found = all.filter((e) => roleOf(e) === value && (!level || levelOf(e) === level) && !hidden(e) &&
      (!name || (exact ? nameOf(e) === norm(name) : nameOf(e).toUpperCase().indexOf(norm(name).toUpperCase()) !== -1)));
  } else if (kind === 'label') {
    found = all.filter((e) => (e.hasAttribute('aria-labelledby') || e.hasAttribute('aria-label') || labelMap.has(e)) &&
      labelTexts(e).some((t) => matches(t, value)));
  } else if (kind === 'text') {
    // The innermost element with the text: none of its children has it too.
    found = all.filter((e) => {
      if (skipText(e) || !matches(textOf(e), value)) return false;
      for (let c = e.firstElementChild; c; c = c.nextElementSibling) if (matches(textOf(c), value)) return false;
      return !(e.shadowRoot && matches(textOf(e.shadowRoot), value));
    });
  } else {
    throw new Error('Locatra: unknown locator kind ' + kind);
  }
  // Inside a scope element: its descendants (getByText may also match the scope itself).
  return scope && scope.nodeType === 1 ? found.filter((e) => inside(scope, e) && (e !== scope || kind === 'text')) : found;
}`;

  /** Keep (TypeScript) or drop (JavaScript) the `$T{…}` annotations of a helper source. */
  function tsOnly(src, lang) {
    return src.replace(/\$T\{([^}]*)\}/g, function (m, t) { return lang === 'typescript' ? t : ''; });
  }

  // ── The matcher as a file embeds it: compacted ───────────────────────────────
  // MATCH_SRC stays readable here; a test file embeds the same program compacted, in
  // dense lines of at most HELPER_WIDTH, a third of its 500 lines: comments and white
  // space dropped (a space stays only between two words, or between two "+" / "-"
  // that would otherwise merge), and every local name — each const, let, function and
  // parameter but locatraMatch — shortened to one or two letters no word of the
  // source uses. The tokenizer knows exactly what
  // MATCH_SRC is written with: '…' and "…" strings, regular expression literals (a
  // "/" where an operand starts; MATCH_SRC never divides), words, one-character
  // punctuation and the `$T{…}` annotations, kept whole; a template literal or a
  // block comment is refused, and a shortened name may not appear as a shorthand
  // property. tests/codegen-helpers.dom.test.mjs proves the result is the same
  // program: its syntax tree equals the readable source's with each variable renamed
  // (by scope analysis), and both find the same elements across the parity corpus.
  var TOKEN_RES = {
    s: /\s+|\/\/[^\n]*/y,
    q: /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/y,
    a: /\$T\{[^}]*\}/y,
    w: /(?:(?!\$T\{)[\w$])+/y,
    r: /\/(?:[^/\\[\n]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[a-z]*/y
  };

  /** The tokens of a helper source: { s: text, t: type (TOKEN_RES key, 'p' = punctuation), gap: white space before }. */
  function jsTokens(src) {
    var out = [];
    var gap = false;
    for (var i = 0; i < src.length;) {
      var prev = out[out.length - 1];
      // A "/" starts a regular expression where an operand is expected.
      var operand = !prev || (prev.t === 'p' && ')]}'.indexOf(prev.s) === -1) ||
        (prev.t === 'w' && /^(return|typeof)$/.test(prev.s));
      var type = null;
      var m = null;
      for (var t in TOKEN_RES) {
        if (t === 'r' && !operand) continue;
        TOKEN_RES[t].lastIndex = i;
        if ((m = TOKEN_RES[t].exec(src))) { type = t; break; }
      }
      var text = m ? m[0] : src.charAt(i);
      if (src.substr(i, 2) === '/*' || (!m && (text === '`' || (text === '/' && operand)))) {
        throw new Error('compactPieces: unsupported syntax at ' + i + ': ' + src.substr(i, 20));
      }
      i += text.length;
      if (type === 's') { gap = true; continue; }
      if (type === 'a') text = compactAnnotation(text);
      out.push({ s: text, t: type || 'p', gap: gap });
      gap = false;
    }
    return out;
  }

  /** A `$T{…}` annotation with its white space dropped (kept before a word: `$T{ as any}`). */
  function compactAnnotation(a) {
    var body = a.slice(3, -1).replace(/\s*([:,|<>()=[\]?])\s*/g, '$1').replace(/\s+/g, ' ').trim();
    return '$T{' + (/^[\w$]/.test(body) ? ' ' : '') + body + '}';
  }

  /** The local names a token list declares: after const / let / function, and every parameter. */
  function declaredNames(all) {
    var toks = all.filter(function (tk) { return tk.t !== 'a'; });
    var names = {};
    var params = function (open) {
      for (var k = open + 1, depth = 1; k < toks.length && depth; k++) {
        if (toks[k].s === '(') depth++;
        else if (toks[k].s === ')') depth--;
        else if (depth === 1 && toks[k].t === 'w' && /^(\(|,)$/.test(toks[k - 1].s)) names[toks[k].s] = true;
      }
    };
    toks.forEach(function (tk, k) {
      var prev = toks[k - 1] || {};
      if (tk.t === 'w' && prev.t === 'w' && /^(const|let|var|function)$/.test(prev.s)) names[tk.s] = true;
      if (tk.s === '(' && prev.t === 'w' && /^(function|catch)$/.test(prev.s)) params(k);
      if (tk.s === '(' && prev.t === 'w' && (toks[k - 2] || {}).s === 'function') params(k);
      if (tk.s === '=' && (toks[k + 1] || {}).s === '>' && !toks[k + 1].gap) {
        if (prev.t === 'w') names[prev.s] = true;
        if (prev.s === ')') {
          for (var j = k - 1, depth = 0; j >= 0; j--) {
            if (toks[j].s === ')') depth++;
            else if (toks[j].s === '(' && !--depth) { params(j); break; }
          }
        }
      }
    });
    return Object.keys(names).filter(function (n) { return !/^\d/.test(n); });
  }

  /**
   * Short names for a source's longer local names, the most used first: { name: short }.
   * A short name is one or two letters (and digits) no word of the source spells.
   */
  function shortNames(toks, keep) {
    var words = {};
    toks.forEach(function (tk) { if (tk.t === 'w') words[tk.s] = (words[tk.s] || 0) + 1; });
    var taken = ' as do if in is of ';
    var letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    var fresh = letters.split('');
    letters.split('').forEach(function (a) {
      (letters + '0123456789').split('').forEach(function (b) { fresh.push(a + b); });
    });
    fresh = fresh.filter(function (n) {
      return !Object.prototype.hasOwnProperty.call(words, n) && taken.indexOf(' ' + n + ' ') === -1;
    });
    var map = {};
    declaredNames(toks)
      .filter(function (n) { return n.length > 1 && keep.indexOf(n) === -1; })
      .sort(function (a, b) { return words[b] - words[a] || (a < b ? -1 : 1); })
      .forEach(function (n, k) { map[n] = fresh[k]; });
    return map;
  }

  /**
   * A helper source compacted (see above), as pieces: each token's text, renamed, with
   * the one space it needs in front. `keep` lists names that stay (the function others call).
   */
  function compactPieces(src, keep) {
    var toks = jsTokens(src);
    var map = shortNames(toks, keep || []);
    var last = '';
    return toks.map(function (tk, k) {
      var prev = toks[k - 1] || {};
      var next = toks[k + 1] || {};
      var s = tk.s;
      if (tk.t === 'w' && Object.prototype.hasOwnProperty.call(map, s) && prev.s !== '.') {
        var key = /^[{,]$/.test(prev.s) && next.s === ':';
        if (/^[{,]$/.test(prev.s) && /^[,}]$/.test(next.s) && (prev.s === '{' || next.s === '}')) {
          throw new Error('compactPieces: shorthand property ' + s);
        }
        if (!key) s = map[s];
      }
      var a = last.slice(-1);
      var b = s.charAt(0);
      var space = tk.gap && ((/[\w$]/.test(a) && /[\w$]/.test(b)) || (a === b && /[+\-/]/.test(a)));
      if (tk.t !== 'a') last = s;
      return (space ? ' ' : '') + s;
    });
  }

  /**
   * Whether a line may break between pieces `p` and `next`: never after return /
   * throw / break / continue (a line break would end the statement), never before a
   * piece that starts with an operator character or a space (so no operator is split
   * — "=" ">" is "=>", "+" "+" is "++" — no "=>" or postfix "++" / "--" moves to the
   * next line, and no TypeScript annotation is cut from its name). Anywhere else a
   * line break changes nothing JavaScript or TypeScript reads, and neither does
   * joining the lines again with nothing between them.
   */
  function breakable(p, next) {
    return !!next && !/^(return|throw|break|continue)$/.test(p) && !/^[ =+\-.:?<>&|*/%]/.test(next);
  }

  /**
   * Pieces joined into lines costing at most `width` (`cost(c)`: the characters c
   * takes once quoted; one each by default), broken only where breakable() allows. A
   * host language may keep those line breaks (and its own indentation) in the
   * script, or concatenate the lines.
   */
  function wrapPieces(pieces, width, cost) {
    var size = function (p) {
      var n = 0;
      for (var i = 0; i < p.length; i++) n += cost ? cost(p.charAt(i)) : 1;
      return n;
    };
    var lines = [];
    var line = [];
    var used = 0;
    var cut = -1;
    pieces.forEach(function (p, k) {
      var n = size(p);
      if (used + n > width && cut > 0) {
        lines.push(line.slice(0, cut).join(''));
        line = line.slice(cut);
        used = size(line.join(''));
        cut = -1;
      }
      line.push(p);
      used += n;
      if (breakable(p, pieces[k + 1])) cut = line.length;
    });
    if (line.length) lines.push(line.join(''));
    return lines;
  }

  // Every line a helper declaration emits stays within this width.
  var HELPER_WIDTH = 120;

  var MATCH_PIECES = compactPieces(MATCH_SRC, ['locatraMatch']);
  /** The names compactPieces gives MATCH_SRC's locals: { name: short } (for the tests that prove it). */
  function matchNames() { return shortNames(jsTokens(MATCH_SRC), ['locatraMatch']); }
  // What a WebDriver script adds: run the matcher on executeScript()'s arguments.
  var MATCH_RUN = 'return locatraMatch.apply(null,arguments)';

  /** The compact matcher in `lang` (TypeScript keeps its annotations), as one line. */
  function matchSource(lang) { return tsOnly(MATCH_PIECES.join(''), lang); }

  /** The compact matcher as a function declaration in `lang`, in lines of at most `width`. */
  function matchLines(lang, width) {
    return wrapPieces(MATCH_PIECES.map(function (p) { return tsOnly(p, lang); }), width);
  }

  /**
   * `text` cut into consecutive chunks costing at most `width` each (`cost(c)`: the
   * characters c takes once quoted; one by default), for a host language to
   * concatenate again. No chunk ends in a backslash (unless it holds nothing else),
   * so a reader never sees an escape split in two.
   */
  function chunkText(text, width, cost) {
    var size = function (c) { return cost ? cost(c) : 1; };
    var out = [];
    var cur = '';
    var used = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (used + size(c) > width && cur) {
        var tail = /\\+$/.exec(cur);
        var at = tail && tail[0].length < cur.length ? cur.length - tail[0].length : cur.length;
        out.push(cur.slice(0, at));
        cur = cur.slice(at);
        used = 0;
        for (var j = 0; j < cur.length; j++) used += size(cur.charAt(j));
      }
      cur += c;
      used += size(c);
    }
    if (cur) out.push(cur);
    return out;
  }

  /**
   * A long string as literals to concatenate, each at most `width` long once quoted
   * (`quote(text)`: the literal), cut after a space where one is near enough.
   */
  function literalLines(text, width, quote) {
    var cost = function (c) { return quote(c).length - 2; };
    var out = [];
    var words = String(text).match(/[^ ]+ *| +/g) || [''];
    var cur = '';
    words.forEach(function (w) {
      if (cur && quote(cur + w).length > width) {
        out.push(cur);
        cur = '';
      }
      if (quote(w).length > width) {
        var pieces = chunkText(cur + w, width - 2, cost);
        cur = pieces.pop();
        out = out.concat(pieces);
      } else {
        cur += w;
      }
    });
    out.push(cur);
    return out.map(quote);
  }

  /**
   * The matcher as a script for executeScript() — (kind, value, name, exact, level,
   * scope) → elements — as JavaScript embeds it: ASCII, no backtick or "${" (a
   * String.raw template holds it), in lines of at most HELPER_WIDTH (see wrapPieces).
   */
  var MATCH_JS = wrapPieces(MATCH_PIECES.map(function (p) { return tsOnly(p, 'javascript'); }).concat(MATCH_RUN),
    HELPER_WIDTH).join('\n');

  /**
   * The same script on one line, cut into chunks costing at most `width` once quoted,
   * for a host language that concatenates string literals (Python, Java, C#).
   */
  function matchScriptChunks(width, cost) { return chunkText(MATCH_JS.replace(/\n/g, ''), width, cost); }

  /** MATCH_JS as a JavaScript constant: a String.raw template. */
  function jsMatchConst(name) { return 'const ' + name + ' = String.raw`\n' + MATCH_JS + '`;'; }

  /** The script as a Python constant: double-quoted literals, concatenated inside parentheses. */
  function pyMatchConst(name) {
    var cost = function (c) { return c === '\\' || c === '"' ? 2 : 1; };
    return name + ' = (\n' + matchScriptChunks(HELPER_WIDTH - 6, cost).map(function (l) {
      return '    ' + q(l, 'python');
    }).join('\n') + '\n)';
  }

  // The kinds a helper looks up; every other kind has a native locator.
  var HELPER_KINDS = ['role', 'label', 'text'];

  /**
   * The helper call a target needs, or null when it has a native locator: { kind,
   * value, name (null = none), exact, level (0 = none), nth (-1 = exactly one) }. A
   * role with no name that may match several elements takes the first (nth 0), as
   * the NOTE beside it says.
   */
  function helperSpec(t) {
    if (!t || HELPER_KINDS.indexOf(t.kind) === -1) return null;
    if (t.kind !== 'role') {
      return { kind: t.kind, value: String(t.value == null ? '' : t.value), name: null, exact: !!t.exact, level: 0, nth: -1 };
    }
    return {
      kind: 'role', value: String(t.role == null ? '' : t.role), name: t.name ? String(t.name) : null,
      exact: !!(t.name && t.exact), level: headingLevel(t.level), nth: hasNth(t) ? t.nth : (isAmbiguousRole(t) ? 0 : -1)
    };
  }

  /**
   * JavaScript arguments after the root: 'kind', 'value'[, name | null][, { exact,
   * level, nth, …extra }]. `extra` are further option entries ('within: $el').
   */
  function jsHelperArgs(spec, lang, extra) {
    var opts = [];
    if (spec.exact) opts.push('exact: true');
    if (spec.level) opts.push('level: ' + spec.level);
    if (spec.nth >= 0) opts.push('nth: ' + spec.nth);
    opts = opts.concat(extra || []);
    var args = [q(spec.kind, lang), q(spec.value, lang)];
    if (spec.name != null || opts.length) args.push(spec.name != null ? q(spec.name, lang) : 'null');
    if (opts.length) args.push('{ ' + opts.join(', ') + ' }');
    return args.join(', ');
  }

  /** Python arguments after the root: "kind", "value"[, "name"][, exact=True][, level=n][, nth=n]. */
  function pyHelperArgs(spec) {
    var args = [q(spec.kind, 'python'), q(spec.value, 'python')];
    if (spec.name != null) args.push(q(spec.name, 'python'));
    if (spec.exact) args.push('exact=True');
    if (spec.level) args.push('level=' + spec.level);
    if (spec.nth >= 0) args.push('nth=' + spec.nth);
    return args.join(', ');
  }

  /** The source of a statement with string literals blanked and comment lines dropped. */
  function codeOnly(text) {
    return String(text).split('\n').filter(function (l) { return !/^\s*(\/\/|#)/.test(l); }).join('\n')
      .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, '""');
  }
  /** Whether code (string literals and comments aside) calls / names `id`. */
  // A use, not a property of the same name (`x.NAME`) — but a spread (`...NAME`) is one.
  function uses(code, id) {
    return new RegExp('(^|[^\\w$.]|\\.\\.\\.)' + id.replace(/\$/g, '\\$') + '\\b').test(codeOnly(code));
  }

  // ── Selenium JS/TS and Python: the helper, the frame script ─────────────────
  // One banner line heads every helper declaration, whatever the framework.
  var HELPER_BANNER = 'Locatra helper (generated): finds role / label / text like Playwright\'s getBy* does.';
  // A Java / C# Locatra class holding text() alone says so instead.
  var TEXT_BANNER = 'Locatra helper (generated): an element\'s text as rendered, normalised like the recording.';

  var SEL_JS_HELPER = [
    'function locatraFind(root$T{: any}, kind$T{: string}, value$T{: string}, name$T{: string | null} = null, opts$T{: any} = {})$T{: any} {',
    '  const driver = typeof root.getDriver === \'function\' ? root.getDriver() : root;',
    '  const nth$T{: number} = typeof opts.nth === \'number\' ? opts.nth : -1;',
    '  const level$T{: number} = opts.level || 0;',
    '  const what = kind + \' \' + JSON.stringify(value) + (name ? \' named \' + JSON.stringify(name) : \'\') +',
    '    (opts.exact ? \' (exact)\' : \'\');',
    '  // Waits up to the implicit wait, as findElement does; several matches are an error.',
    '  return new WebElementPromise(driver, (async () => {',
    '    const scope = root === driver ? null : await root;',
    '    const end = Date.now() + ((await driver.manage().getTimeouts()).implicit || 0);',
    '    for (;;) {',
    '      const found$T{: any[]} = await driver.executeScript(LOCATRA_JS, kind, value, name, !!opts.exact, level, scope);',
    '      if (found.length > Math.max(nth, 0)) {',
    '        if (nth < 0 && found.length > 1) {',
    '          throw new Error(\'Locatra: \' + found.length + \' elements match \' + what + \'; expected exactly one\');',
    '        }',
    '        return found[Math.max(nth, 0)];',
    '      }',
    '      if (Date.now() >= end) throw new Error(\'Locatra: no element matches \' + what);',
    '      await driver.sleep(100);',
    '    }',
    '  })());',
    '}'
  ].join('\n');

  var PY_HELPER = [
    'def locatra_find(root, kind, value, name=None, exact=False, level=0, nth=-1):',
    '    """Wait up to the driver\'s implicit wait, as find_element does; fail when several elements match."""',
    '    driver = root if hasattr(root, "execute_script") else root.parent',
    '    scope = None if root is driver else root',
    '    what = f"{kind} {value!r}" + (f" named {name!r}" if name else "") + (" (exact)" if exact else "")',
    '    end = time.monotonic() + (driver.timeouts.implicit_wait or 0)',
    '    while True:',
    '        found = driver.execute_script(LOCATRA_JS, kind, value, name, exact, level, scope)',
    '        if len(found) > max(nth, 0):',
    '            if nth < 0 and len(found) > 1:',
    '                raise WebDriverException(f"Locatra: {len(found)} elements match {what}; expected exactly one")',
    '            return found[max(nth, 0)]',
    '        if time.monotonic() >= end:',
    '            raise NoSuchElementException(f"Locatra: no element matches {what}")',
    '        time.sleep(0.1)'
  ].join('\n');

  /**
   * Selenium JS/TS/Python: the helper declaration (LOCATRA_JS, the compact matcher,
   * and locatraFind / locatra_find).
   */
  function selHelperSource(lang) {
    if (lang === 'python') return '# ' + HELPER_BANNER + '\n' + pyMatchConst('LOCATRA_JS') + '\n\n\n' + PY_HELPER;
    return '// ' + HELPER_BANNER + '\n' + jsMatchConst('LOCATRA_JS') + '\n\n' + tsOnly(SEL_JS_HELPER, lang);
  }

  // Text is compared as rendered (getText(), innerText), normalised as the recorder
  // read it: soft hyphens and zero-width spaces dropped, white space collapsed. One
  // small helper per file, so an assertion reads assert.ok((await locatraText(el)).includes(…)).
  var TEXT_NOTE = 'Locatra: the text as rendered, soft hyphens and zero-width spaces dropped, white space collapsed.';
  var SEL_TEXT_NAME = 'locatraText';
  var PY_TEXT_NAME = 'locatra_text';
  function selTextSource(lang) {
    if (lang === 'python') {
      return '# ' + TEXT_NOTE + '\ndef locatra_text(el):\n' +
        '    return " ".join(el.text.replace("\\u00ad", "").replace("\\u200b", "").split())';
    }
    return tsOnly('// ' + TEXT_NOTE + '\nasync function locatraText(el$T{: any})$T{: Promise<string>} {\n' +
      "  return (await el.getText()).replace(/[\\u00ad\\u200b]/g, '').replace(/\\s+/g, ' ').trim();\n}", lang);
  }

  // Page scripts a statement runs are declared once per file, as constants, rather
  // than spelled out in every statement: LOCATRA_FRAME_JS (DEEP_IFRAME_JS below)
  // finds a cross-origin frame (no selector) by its position, LOCATRA_SET_VALUE_JS
  // (SET_VALUE_JS below) sets a date / range / colour input's value.
  var FRAME_JS_NAME = 'LOCATRA_FRAME_JS';
  var SET_VALUE_NAME = 'LOCATRA_SET_VALUE_JS';
  var FRAME_JS_NOTE = 'Locatra: the index-th <iframe>, counting those in open shadow roots (arguments[0] = index).';
  var SET_VALUE_NOTE = 'Locatra: set arguments[0]\'s value to arguments[1] the way typing would (input and change events).';
  function selConstSource(name, note, js, lang) {
    var parts = literalLines(js, HELPER_WIDTH - 6, function (c) { return q(c, lang); });
    if (lang === 'python') return '# ' + note + '\n' + name + ' = (\n    ' + parts.join('\n    ') + '\n)';
    return '// ' + note + '\nconst ' + name + ' =\n  ' + parts.join(' +\n  ') + ';';
  }

  /** The declarations Selenium JS/TS/Python code needs, in order ('' when none). */
  function selHelpers(code, lang) {
    var out = [];
    if (uses(code, FRAME_JS_NAME)) out.push(selConstSource(FRAME_JS_NAME, FRAME_JS_NOTE, DEEP_IFRAME_JS, lang));
    if (uses(code, SET_VALUE_NAME)) out.push(selConstSource(SET_VALUE_NAME, SET_VALUE_NOTE, SET_VALUE_JS, lang));
    if (uses(code, lang === 'python' ? PY_TEXT_NAME : SEL_TEXT_NAME)) out.push(selTextSource(lang));
    if (uses(code, lang === 'python' ? 'locatra_find' : 'locatraFind')) out.push(selHelperSource(lang));
    return out;
  }

  /** A Selenium helper call rooted at `root` (the driver or a parent element). */
  function selHelperCall(spec, lang, root) {
    if (lang === 'python') return 'locatra_find(' + root + ', ' + pyHelperArgs(spec) + ')';
    return 'locatraFind(' + root + ', ' + jsHelperArgs(spec, lang) + ')';
  }

  // ── Cypress: the helper ─────────────────────────────────────────────────────
  // locatraGet() yields the one element as a jQuery subject, retrying (a .should()
  // on cy.document()) until exactly one matches or the command timeout passes. A
  // chain or a frame hands it the element to search inside: .then(($el) =>
  // locatraGet(…, { within: $el })).
  var CY_GET_NAME = 'locatraGet';
  var CY_GET_SRC = [
    'function locatraGet(',
    '  kind$T{: string}, value$T{: string}, name$T{: string | null} = null, opts$T{: any} = {}',
    ')$T{: Cypress.Chainable<JQuery<HTMLElement>>} {',
    '  const nth$T{: number} = typeof opts.nth === \'number\' ? opts.nth : -1;',
    '  const what = kind + \' \' + JSON.stringify(value) + (name ? \' named \' + JSON.stringify(name) : \'\') +',
    '    (opts.exact ? \' (exact)\' : \'\');',
    '  let found$T{: HTMLElement[]} = [];',
    '  // Retries until exactly one element matches (the nth, for a positional locator), like cy.get().',
    '  return cy.document({ log: false }).should((doc) => {',
    '    const scope = opts.within ? opts.within[0] || opts.within : doc;',
    '    found = locatraMatch(kind, value, name, !!opts.exact, opts.level || 0, scope);',
    '    if (nth < 0) expect(found.length, \'elements matching \' + what).to.equal(1);',
    '    else expect(found.length, \'elements matching \' + what).to.be.greaterThan(nth);',
    '  }).then(() => Cypress.$(found[Math.max(nth, 0)]));',
    '}'
  ].join('\n');

  /** Cypress: the compact matcher (a function declaration) and locatraGet(). */
  function cyGetSource(lang) {
    return '// ' + HELPER_BANNER + '\n' + matchLines(lang, HELPER_WIDTH).join('\n') + '\n\n' + tsOnly(CY_GET_SRC, lang);
  }

  // A text assertion compares the rendered text (innerText) normalised like the
  // recording, in a retried should(): expect(locatraText($el)).to.equal(…).
  var CY_TEXT_NAME = 'locatraText';
  function cyTextSource(lang) {
    return tsOnly('// ' + TEXT_NOTE + '\nfunction locatraText($el$T{: JQuery<HTMLElement>})$T{: string} {\n' +
      "  return $el[0].innerText.replace(/[\\u00ad\\u200b]/g, '').replace(/\\s+/g, ' ').trim();\n}", lang);
  }

  /** A Cypress helper call; `within` names the element to search inside (a chain, a frame). */
  function cyHelperCall(spec, lang, within) {
    return CY_GET_NAME + '(' + jsHelperArgs(spec, lang, within ? ['within: ' + within] : null) + ')';
  }

  // The index-th <iframe>, shadow roots included, as a jQuery subject for .its().
  var CY_FRAME_NAME = 'locatraFrame';
  var CY_FRAME_SRC = [
    '// Locatra: the index-th <iframe> of a document in the order the recorder counts them',
    '// (the document\'s own, then each open shadow root\'s), which cy.get(\'iframe\') cannot see.',
    'function locatraFrame(doc$T{: Document}, index$T{: number})$T{: JQuery<HTMLIFrameElement>} {',
    '  const frames$T{: HTMLIFrameElement[]} = [];',
    '  const walk = (root$T{: Document | ShadowRoot})$T{: void} => {',
    '    frames.push(...Array.from(root.querySelectorAll(\'iframe\')));',
    '    root.querySelectorAll(\'*\').forEach((el) => {',
    '      if (el.shadowRoot) walk(el.shadowRoot);',
    '    });',
    '  };',
    '  walk(doc);',
    '  if (!frames[index]) throw new Error(\'Locatra: no iframe at index \' + index);',
    '  return Cypress.$(frames[index]);',
    '}'
  ];
  function cyFrameSource(lang) { return tsOnly(CY_FRAME_SRC.join('\n'), lang); }

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
  function cySecretSource(lang) { return tsOnly(CY_SECRET_SRC.join('\n'), lang); }
  /** The helpers a set of Cypress statements calls, as source blocks to prepend. */
  function cyHelpers(stmts, lang) {
    var code = stmts.join('\n');
    var out = [];
    if (uses(code, CY_TEXT_NAME)) out.push(cyTextSource(lang));
    if (uses(code, CY_GET_NAME)) out.push(cyGetSource(lang));
    if (uses(code, CY_FRAME_NAME)) out.push(cyFrameSource(lang));
    if (uses(code, CY_SECRET_NAME)) out.push(cySecretSource(lang));
    return out;
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

  /**
   * How many elements the recorder found for a step's locator: its matchCount (or 1
   * when it is marked unique, -2 when marked not unique without a count), read off
   * the target or, through frame wrappers, the target inside; -1 when unknown. A
   * chain's parts are not consulted: a chain exists to narrow an ambiguous child.
   */
  function recordedCount(t) {
    for (var d = 0; t && typeof t === 'object' && d < 64; d++) {
      var n = nonNegInt(t.matchCount, -1);
      if (n >= 0) return n;
      if (t.unique === true) return 1;
      if (t.unique === false) return -2;
      if (t.kind !== 'frame') break;
      t = t.child;
    }
    return -1;
  }

  /**
   * The NOTE a recorded step gets when its locator was known to match more than one
   * element (Playwright's strict mode would throw on it; Selenium would take the
   * first), else null. Nothing is added to the locator to hide it (no .first()).
   */
  function nonUniqueNote(target) {
    var n = recordedCount(target);
    if (n > 1) return 'NOTE: this locator matched ' + n + ' elements when recorded; make it unique before relying on it.';
    if (n === -2) return 'NOTE: this locator was not unique when recorded; make it unique before relying on it.';
    return null;
  }

  /** Whether a framework other than Playwright renders the target as a shadow walk (C3). */
  function walked(t) {
    var inner = unwrapFrames(t).inner;
    if (inner && inner.kind === 'chain') inner = inner.child;
    return !!shadowWalk(inner);
  }

  /** Whether a statement needs the "no accessible name" NOTE (not when the count NOTE says more). */
  function roleNote(t) { return hasAmbiguousRole(t) && !nonUniqueNote(t); }

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
        var level = headingLevel(t.level);
        if (level) opts.push(py ? 'level=' + level : 'level: ' + level);
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
      case 'xpath': return 'page.locator(' + q('xpath=' + t.value, lang) + ')';
      case 'css': default: return 'page.locator(' + q(t.value || 'body', lang) + ')';
    }
  }

  // Attribute selector for the attribute-matching kinds: equality when the engine
  // asked for an exact match, otherwise substring (Playwright's default semantics).
  function attrMatchSel(attr, value, exact) {
    return '[' + attr + (exact ? '="' : '*="') + attrSel(value) + '"]';
  }

  // ── which target to render (C9.2) ──────────────────────────────────────────
  // A recorded step, a picked element or a page-object element may carry
  // `altTargets`: up to three complete targets for the same element (test id, id,
  // name, short CSS, short XPath), best first, each verified to match it alone.
  // Playwright always renders the primary target — it has getByRole and friends.
  // Elsewhere a role / label / text target needs the Locatra helper, so the first
  // alternative the framework can use wins: By.id('username') over a helper call.
  // Cypress has no XPath, so it never takes an alternative of kind 'xpath'.
  var ALT_KINDS = ['testid', 'id', 'name', 'css', 'xpath'];

  /** Whether a target needs a helper lookup (through frames, on either side of a chain). */
  function needsHelper(t, depth) {
    depth = depth || 0;
    if (!t || typeof t !== 'object' || depth > 64) return false;
    if (t.kind === 'frame') return needsHelper(t.child, depth + 1);
    if (t.kind === 'chain') return needsHelper(t.parent, depth + 1) || needsHelper(t.child, depth + 1);
    return HELPER_KINDS.indexOf(t.kind) !== -1;
  }

  /**
   * Whether `alt` is a whole target `fw` renders natively (no helper, no chain) and
   * simply. In shadow DOM the native form is a host-by-host walk: an alternative
   * there is simpler than the helper (which pierces shadow roots itself) only when
   * the walk is one short hop; one with no shadowCss could not be walked at all.
   */
  function usableAlt(alt, fw) {
    var inner = alt && typeof alt === 'object' ? unwrapFrames(alt).inner : null;
    if (!inner || ALT_KINDS.indexOf(inner.kind) === -1 || typeof inner.value !== 'string' || !inner.value) return false;
    if (inner.kind === 'testid' && (typeof inner.attr !== 'string' || !inner.attr)) return false;
    if (shadowHostsOf(inner)) {
      var sh = shadowOf(inner);
      if (!sh || shadowBreak(sh)) return false;
    }
    return !(fw === 'cypress' && inner.kind === 'xpath');
  }

  /** The target to render for `framework`: an alternative when the primary would need a helper. */
  function preferredTarget(primary, altTargets, framework) {
    if (framework === 'playwright' || !Array.isArray(altTargets) || !needsHelper(primary)) return primary;
    for (var i = 0; i < altTargets.length && i < 3; i++) {
      if (usableAlt(altTargets[i], framework)) return altTargets[i];
    }
    return primary;
  }

  /** A step or page-object element whose target is the one `fw` prefers (a copy when it changes). */
  function withPreferred(item, fw) {
    if (!item || typeof item !== 'object' || !Array.isArray(item.altTargets)) return item;
    var t = preferredTarget(item.target, item.altTargets, fw);
    if (t === item.target) return item;
    var copy = {};
    for (var k in item) if (own(item, k)) copy[k] = item[k];
    copy.target = t;
    return copy;
  }

  // Cypress: role / label / text go through locatraGet(), and so does an XPath when
  // one is forced on it (an XPath primary target: Cypress has no XPath of its own —
  // statementNotes() says so); everything else is a CSS cy.get().
  function cyHelperSpec(t) {
    if (t && t.kind === 'xpath') return { kind: 'xpath', value: String(t.value == null ? '' : t.value), name: null, exact: false, level: 0, nth: -1 };
    return helperSpec(t);
  }

  function cyLocator(t, lang) {
    var spec = cyHelperSpec(t);
    if (spec) return cyHelperCall(spec, lang);
    switch (t.kind) {
      case 'testid': return 'cy.get(' + q('[' + cssIdent(t.attr) + '="' + attrSel(t.value) + '"]', lang) + ')';
      case 'placeholder': return 'cy.get(' + q(attrMatchSel('placeholder', t.value, t.exact), lang) + ')';
      case 'altText': return 'cy.get(' + q(attrMatchSel('alt', t.value, t.exact), lang) + ')';
      case 'title': return 'cy.get(' + q(attrMatchSel('title', t.value, t.exact), lang) + ')';
      case 'id': return 'cy.get(' + q('#' + cssIdent(t.value), lang) + ')';
      case 'name': return 'cy.get(' + q('[name="' + attrSel(t.value) + '"]', lang) + ')';
      case 'css': default: return 'cy.get(' + q(t.value || 'body', lang) + ')';
    }
  }

  /**
   * Cypress: `t` continued from the subject before it (a chain's parent, a frame's
   * body) — '.find(…)' for a CSS locator, '.then(($el) => locatraGet(…, { within:
   * $el }))' for a helper one; null for a frame, which cannot be entered from there.
   */
  function cyContinue(t, lang) {
    if (!t || t.kind === 'frame') return null;
    if (t.kind === 'chain') {
      var p = cyContinue(t.parent, lang);
      var c = t.child ? cyContinue(t.child, lang) : '';
      return p == null || c == null ? null : p + c;
    }
    var sh = shadowWalk(t);
    if (sh) return cyShadowExpr(sh, lang).replace(/^cy\.get\(/, '.find(');
    var spec = cyHelperSpec(t);
    if (spec) return '.then(($el) => ' + cyHelperCall(spec, lang, '$el') + ')';
    return cyLocator(t, lang).replace(/^cy\.get\(/, '.find(');
  }

  // Selenium: `<root>.findElement(By…)` / `<root>.find_element(By…)`, where root is
  // the driver or, in a chain, the parent element's expression.
  function selFind(by, selector, lang, root) {
    root = root || 'driver';
    // by ∈ css | id | name | xpath
    if (lang === 'python') {
      var BY = { css: 'By.CSS_SELECTOR', id: 'By.ID', name: 'By.NAME', xpath: 'By.XPATH' }[by];
      return root + '.find_element(' + BY + ', ' + q(selector, lang) + ')';
    }
    var fn = { css: 'By.css', id: 'By.id', name: 'By.name', xpath: 'By.xpath' }[by];
    return root + '.findElement(' + fn + '(' + q(selector, lang) + '))';
  }

  // An XPath searched from a parent element: an absolute "//…" handed to
  // element.findElement still searches the whole document, so it is made "./…".
  function scopedXpath(value, rel) {
    var v = String(value == null ? '' : value);
    return rel && v.charAt(0) === '/' ? '.' + v : v;
  }

  function selLocator(t, lang, rel, root) {
    var spec = helperSpec(t);
    if (spec) return selHelperCall(spec, lang, root || 'driver');
    switch (t.kind) {
      case 'testid': return selFind('css', '[' + cssIdent(t.attr) + '="' + attrSel(t.value) + '"]', lang, root);
      case 'placeholder': return selFind('css', attrMatchSel('placeholder', t.value, t.exact), lang, root);
      case 'altText': return selFind('css', attrMatchSel('alt', t.value, t.exact), lang, root);
      case 'title': return selFind('css', attrMatchSel('title', t.value, t.exact), lang, root);
      case 'xpath': return selFind('xpath', scopedXpath(t.value, rel), lang, root);
      case 'id': return selFind('id', t.value, lang, root);
      case 'name': return selFind('name', t.value, lang, root);
      case 'css': default: return selFind('css', t.value || 'body', lang, root);
    }
  }

  /** Selenium: `t` searched inside the element `root` evaluates to. */
  function selScoped(t, lang, root) {
    if (t.kind === 'frame' || shadowWalk(t)) return locatorExpr(t, 'selenium', lang);
    if (t.kind !== 'chain') return selLocator(t, lang, true, root);
    var parent = selScoped(t.parent, lang, root);
    return t.child ? selScoped(t.child, lang, parent) : parent;
  }

  // ── chained locators ────────────────────────────────────────────────────────
  // A chain narrows an ambiguous child to one unique parent — the only reliable way
  // to address "the Delete button in *this* table row". Every framework expresses it
  // by continuing the parent's expression: Playwright re-points the child's `page.`
  // at the parent, Selenium roots the child's lookup (findElement or the helper) at
  // the parent element, Cypress continues with .find() / .then(locatraGet within).
  function chainExpr(t, fw, lang) {
    var parent = locatorExpr(t.parent, fw, lang);
    if (!t.child) return parent;
    var child = locatorExpr(t.child, fw, lang, true);
    // A child reached through its shadow roots starts from the document: its first
    // host is unique there, and need not be inside the parent.
    if (!parent || (fw !== 'playwright' && shadowWalk(t.child))) return child;
    if (fw === 'selenium') return selScoped(t.child, lang, parent);
    if (fw === 'cypress') {
      // A chain longer than 120 characters continues on its own line.
      var rest = cyContinue(t.child, lang);
      return rest == null ? child : parent + (parent.length + rest.length > 120 ? '\n  ' : '') + rest;
    }
    // Unrecognised child shape: the parent scope cannot be applied without silently
    // changing what the code selects, so return the child on its own rather than
    // emitting a syntactically broken chain.
    return /^page\./.test(child) ? parent + child.replace(/^page\./, '.') : child;
  }

  // ── frames ──────────────────────────────────────────────────────────────────
  // Playwright and Cypress can address into a frame from an expression, so a frame
  // continues like a chain: the child is rendered from the frame (Playwright
  // re-points its `page.`, Cypress continues from the frame's body). Selenium cannot — switching frames is a statement, not part
  // of a locator — so selenium is handled in selStatement() instead and its
  // expression here is the child alone.

  /** Peel any frame wrappers off a target. Returns the frames outermost-first. */
  function unwrapFrames(target) {
    var frames = [];
    var t = target;
    while (t && t.kind === 'frame') {
      // index: position among the parent document's <iframe> elements, shadow roots
      // included (DEEP_IFRAME_JS). framesIndex is not used: window.frames order is
      // what geckodriver counts, but ChromeDriver counts /html/body//iframe instead.
      var f = { selector: t.selector, index: nonNegInt(t.index, 0) };
      if (t.selector && validShadowPath(t.shadowPath)) f.shadowPath = t.shadowPath;
      frames.push(f);
      t = t.child;
    }
    return { frames: frames, inner: t || null };
  }

  /**
   * The position DEEP_IFRAME_JS looks a frame up by. Selenium is never handed a bare
   * number: ChromeDriver resolves switchTo().frame(i) as (/html/body//iframe |
   * /html/frameset//frame)[i+1] and geckodriver as window.frames[i], so the same
   * number means different frames, and neither reaches an <iframe> in shadow DOM.
   */
  function seleniumFrameIndex(frame) {
    return frame.index;
  }

  // The index-th <iframe> of the current document in the order the recorder counts
  // them (the engine's deepQueryAll): the document's own, then each open shadow
  // root's, depth first in document order. Run with executeScript(DEEP_IFRAME_JS, i)
  // (WebDriver passes i as arguments[0]); it throws when there is no such frame.
  var DEEP_IFRAME_JS = "const frames = []; const walk = (root) => { frames.push(...root.querySelectorAll('iframe')); " +
    "root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); }); }; walk(document); " +
    "if (!frames[arguments[0]]) throw new Error('Locatra: no iframe at index ' + arguments[0]); return frames[arguments[0]];";

  function validShadowPath(p) {
    if (!Array.isArray(p) || p.length < 2) return false;
    for (var i = 0; i < p.length; i++) if (typeof p[i] !== 'string' || !p[i]) return false;
    return true;
  }

  function frameEnterExpr(frame, fw, lang) {
    var sel = frame.selector;
    if (fw === 'cypress') {
      // Without a selector, the index-th <iframe> counting shadow roots (locatraFrame()).
      var base = sel
        ? 'cy.get(' + q(sel, lang) + ')'
        : 'cy.document().then((doc) => ' + CY_FRAME_NAME + '(doc, ' + frame.index + '))';
      var hop = '';
      if (frame.shadowPath) {
        // cy.get/find stay inside one tree (and includeShadowDom matches a selector
        // within a single root, not a path across several), so step host by host —
        // one hop per line once the path is long (see shadowBreak).
        hop = pathBreak(frame.shadowPath) ? '\n    ' : '';
        base = 'cy.get(' + q(frame.shadowPath[0], lang) + ')';
        for (var h = 1; h < frame.shadowPath.length; h++) {
          base += hop + '.shadow().find(' + q(frame.shadowPath[h], lang) + ')';
        }
      }
      // The no-plugin recipe: reach the frame's body, then continue inside it (on the
      // next line after a long shadow path).
      var br = hop || (frame.shadowPath && frame.shadowPath.length > 3) ? '\n  ' : '';
      return base + br + ".its('0.contentDocument.body').should('not.be.empty').then(cy.wrap)";
    }
    var py = lang === 'python';
    var fl = py ? 'frame_locator' : 'frameLocator';
    // Without a selector the frame is cross-origin; address it positionally.
    var arg = sel ? q(sel, lang) : q('iframe >> nth=' + frame.index, lang);
    return 'page.' + fl + '(' + arg + ')';
  }

  function frameExpr(t, fw, lang) {
    var peeled = unwrapFrames(t);
    if (!peeled.inner) return '';
    // The inner target may itself be a chain (a parent/child pair inside the frame),
    // so it goes through locatorExpr, never straight to selLocator.
    if (fw === 'selenium') return locatorExpr(peeled.inner, fw, lang);

    var parts = [];
    for (var i = 0; i < peeled.frames.length; i++) {
      var enter = frameEnterExpr(peeled.frames[i], fw, lang);
      if (parts.length && /^cy\.document\(\)/.test(enter)) {
        // Inside a frame: look in the document of the body the chain yields.
        // (cy.wrap yields an untyped subject, so TypeScript is told what it is.)
        var body = lang === 'typescript' ? '(body as JQuery<HTMLElement>)' : 'body';
        enter = enter.replace(/^cy\.document\(\)\.then\(\(doc\) => (\w+)\(doc, /, '.then((body) => $1(' + body + '[0].ownerDocument, ')
          .replace(".its('0.contentDocument.body')", "\n  .its('0.contentDocument.body')");
      }
      parts.push(parts.length ? enter.replace(/^cy\.get\(/, '.find(').replace(/^page\./, '.') : enter);
    }
    var expr = parts.join('');
    if (fw === 'cypress') {
      var rest = cyContinue(peeled.inner, lang);
      if (rest == null) return locatorExpr(peeled.inner, fw, lang);
      // A long chain reads (and fits) better one frame per line.
      parts.push(rest);
      return parts.join('').length <= 100 ? parts.join('') : parts.join('\n  ');
    }
    var child = locatorExpr(peeled.inner, fw, lang);
    return /^page\./.test(child) ? expr + child.replace(/^page\./, '.') : child;
  }

  // ── open shadow DOM (C3) ────────────────────────────────────────────────────
  // A target inside open shadow roots carries `shadowHosts` (one CSS selector per
  // host, outermost first, each unique in the tree that holds it) and `shadowCss`
  // (unique inside the innermost root). Playwright's locators pierce shadow roots and
  // need neither. Selenium and Cypress search one tree at a time, and a shadow root
  // takes CSS only, so they walk host by host and finish with shadowCss. Not a role /
  // label / text target: the Locatra helper finds it, and its matcher pierces open
  // shadow roots as the engine does — one short call instead of a walk whose host
  // selectors are often long structural paths (see shadowWalk). Without shadowCss
  // any other kind keeps its own locator, with a NOTE that it may not find the element.
  function shadowHostsOf(t) {
    if (!t || !Array.isArray(t.shadowHosts) || !t.shadowHosts.length) return null;
    for (var i = 0; i < t.shadowHosts.length; i++) {
      if (typeof t.shadowHosts[i] !== 'string' || !t.shadowHosts[i]) return null;
    }
    return t.shadowHosts;
  }

  /** { hosts, css } when a target can be reached through its shadow roots, else null. */
  function shadowOf(t) {
    var hosts = shadowHostsOf(t);
    return hosts && typeof t.shadowCss === 'string' && t.shadowCss ? { hosts: hosts, css: t.shadowCss } : null;
  }

  /**
   * The host-by-host walk a framework other than Playwright renders for `t`, or null:
   * a role / label / text target goes to the helper (which pierces shadow roots)
   * instead, whatever its shadowHosts say.
   */
  function shadowWalk(t) {
    return t && HELPER_KINDS.indexOf(t.kind) === -1 ? shadowOf(t) : null;
  }

  // A walk goes one hop per line once it has two hops or more, or once its selectors
  // are long enough (recorded host selectors can be whole structural paths) that one
  // line would hold them all: every line then carries a single selector.
  var SHADOW_INLINE = 48;
  function shadowBreak(sh) {
    return sh.hosts.length > 1 || sh.hosts[0].length + sh.css.length > SHADOW_INLINE;
  }

  /** Whether an <iframe>'s shadowPath (its hosts, then the <iframe>) is too long for one line. */
  function pathBreak(path) {
    return path.join('').length > SHADOW_INLINE;
  }

  /** Whether a step's element is in shadow DOM with no shadowCss to reach it by (and no helper). */
  function lacksShadowCss(target) {
    var inner = unwrapFrames(target).inner;
    return !!shadowHostsOf(inner) && !shadowOf(inner) && HELPER_KINDS.indexOf(inner.kind) === -1;
  }

  var SHADOW_NOTE = 'NOTE: inside shadow DOM, but no CSS selector was recorded for it there; this locator may not find it.';

  // Selenium JS/TS: a shadow root's findElement returns a plain promise, so every hop
  // is awaited (see selShadowFrameSwitch); the result is a WebElement expression.
  // Two hops or more go one per line (inside parentheses, so Python reads it too).
  function selShadowExpr(sh, lang) {
    var expr = selFind('css', sh.hosts[0], lang);
    var rest = sh.hosts.slice(1).concat(sh.css);
    var br = shadowBreak(sh) ? '\n    ' : '';
    rest.forEach(function (sel) {
      expr = lang === 'python'
        ? expr + br + '.shadow_root.find_element(By.CSS_SELECTOR, ' + q(sel, lang) + ')'
        : '(await (await ' + expr + br + '.getShadowRoot()).findElement(By.css(' + q(sel, lang) + ')))';
    });
    return br && lang === 'python' ? '(' + expr + ')' : expr;
  }

  function cyShadowExpr(sh, lang) {
    var br = shadowBreak(sh) ? '\n    ' : '';
    return 'cy.get(' + q(sh.hosts[0], lang) + ')' + sh.hosts.slice(1).concat(sh.css).map(function (sel) {
      return br + '.shadow().find(' + q(sel, lang) + ')';
    }).join('');
  }

  function locatorExpr(target, fw, lang, rel) {
    if (!target) return '';
    lang = pluginLang(fw, lang);
    var plug = targetFor(fw, lang);
    if (plug) return plug.locatorExpr(target, lang, rel);
    if (target.kind === 'frame') return frameExpr(target, fw, lang);
    var sh = fw === 'selenium' || fw === 'cypress' ? shadowWalk(target) : null;
    if (sh) return fw === 'selenium' ? selShadowExpr(sh, lang) : cyShadowExpr(sh, lang);
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

  /**
   * The labels a selectOption step on a <select multiple> chose, when it chose more
   * than one (C1: `value` keeps the first label for older consumers); else null.
   */
  function multiValues(step) {
    if (!step || step.action !== 'selectOption' || !Array.isArray(step.values) || step.values.length < 2) return null;
    return step.values.map(function (v) { return String(v == null ? '' : v); });
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

  /**
   * A step whose value can be test data: a non-sensitive, accepted fill/select with a
   * value and a locator. A multi-select's several labels are not one value.
   */
  function varEligible(step) {
    return !!step && typeof step === 'object' && !isSuggested(step) && !multiValues(step) &&
      (step.action === 'fill' || step.action === 'selectOption') && !step.sensitive &&
      typeof step.value === 'string' && step.value !== '' && !!unwrapFrames(step.target).inner;
  }

  /** The variable a step's statement references, or null when it renders a literal. */
  function variableRefName(step) {
    if (!step || (step.action !== 'fill' && step.action !== 'selectOption') || step.sensitive || multiValues(step)) return null;
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

  /** Whether a target looks an element up by XPath (through frames and chains). */
  function hasXpath(t) {
    if (!t || typeof t !== 'object') return false;
    if (t.kind === 'frame') return hasXpath(t.child);
    if (t.kind === 'chain') return hasXpath(t.parent) || hasXpath(t.child);
    return t.kind === 'xpath';
  }

  var CY_XPATH_NOTE = 'NOTE: Cypress has no XPath; locatraGet() runs it with document.evaluate (no shadow roots).';

  function statementNotes(step, fw, lang) {
    var notes = [];
    if (roleNote(step.target)) {
      notes.push(comment(lang, 'NOTE: this role locator has no accessible name and may match several elements; the first match is used.'));
    }
    if (fw === 'cypress' && hasXpath(step.target)) notes.push(comment(lang, CY_XPATH_NOTE));
    if (fw === 'cypress' && hasPositionalFrame(step.target)) {
      notes.push(comment(lang, 'NOTE: this iframe is cross-origin, so contentDocument is null and Cypress cannot reach into it.'));
      notes.push(comment(lang, 'Test that page in its own spec (cy.visit/cy.origin) or set chromeWebSecurity: false (Chromium only).'));
    }
    if (lacksShadowCss(step.target)) notes.push(comment(lang, SHADOW_NOTE));
    return notes;
  }

  // A statement continues on a line of its own before the action (`.fill(…)`, an
  // assertion's matcher) when one line would pass STMT_WIDTH, where the language reads
  // that naturally (Java, C#): `head` is everything before it, possibly several lines.
  var STMT_WIDTH = 100;
  function callOn(head, call) {
    var lines = String(head).split('\n');
    return lines[lines.length - 1].length + call.length > STMT_WIDTH ? head + '\n    ' + call : head + call;
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
      case 'selectOption': {
        var many = multiValues(step);
        var opt = many ? listLiteral(many, lang) : valueExpr(step, lang);
        if (py) return loc + '.select_option(' + opt + ')';
        return 'await ' + loc + '.selectOption(' + opt + ');';
      }
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
      case 'selectOption': {
        var many = multiValues(step);
        return loc + '.select(' + (many ? listLiteral(many, lang) : valueExpr(step, lang)) + ');';
      }
      default: return todo(lang, 'unsupported step "' + commentSafe(a) + '"');
    }
  }

  // An <iframe> inside shadow DOM is reached host by host: WebDriver searches a
  // shadow root with CSS only (no XPath), one tree at a time. JS/TS spell every hop
  // out with awaits — at run time a shadow root's findElement returns a plain
  // promise, so chaining off it the way off driver.findElement() fails.
  function selShadowFrameSwitch(path, lang) {
    if (lang === 'python' && path.length === 2 && !pathBreak(path)) {
      return 'driver.switch_to.frame(' + selFind('css', path[0], lang) + '.shadow_root.find_element(By.CSS_SELECTOR, ' +
        q(path[1], lang) + '))';
    }
    if (lang === 'python') {
      // Deeper: one hop per line, so the path never makes one long line.
      var py = ['shadow_host = ' + selFind('css', path[0], lang)];
      for (var i = 1; i < path.length - 1; i++) {
        py.push('shadow_host = shadow_host.shadow_root.find_element(By.CSS_SELECTOR, ' + q(path[i], lang) + ')');
      }
      py.push('driver.switch_to.frame(shadow_host.shadow_root.find_element(By.CSS_SELECTOR, ' + q(path[path.length - 1], lang) + '))');
      return py.join('\n');
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
    // No selector (a cross-origin frame): the frame element, by its position
    // (LOCATRA_FRAME_JS, declared once per file).
    var js = FRAME_JS_NAME + ', ' + seleniumFrameIndex(frame);
    return py ? 'driver.switch_to.frame(driver.execute_script(' + js + '))'
      : 'await driver.switchTo().frame(await driver.executeScript(' + js + '));';
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
    // Three or four modifiers make a long chain: it continues on a second line.
    var br = mods.length > 2 ? '\n    ' : '';
    if (py) {
      var chain = 'webdriver.ActionChains(driver)' + down + br + '.send_keys(' + keyArg + ')' + up + '.perform()';
      return br ? '(' + chain + ')' : chain;
    }
    return 'await driver.actions()' + down + br + '.sendKeys(' + keyArg + ')' + up + '.perform();';
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
        return 'driver.set_window_size(*driver.execute_script(\n    ' + q('return [' + vpW(step) +
          ' + window.outerWidth - window.innerWidth, ' + vpH(step) + ' + window.outerHeight - window.innerHeight];', lang) + '))';
      }
      // (The script's driver comes from require(): untyped, so no type argument.)
      return '{\n  const chrome' + (lang === 'typescript' ? ': number[]' : '') + ' = await driver.executeScript(\n' +
        "    'return [window.outerWidth - window.innerWidth, window.outerHeight - window.innerHeight];');\n" +
        '  await driver.manage().window().setRect({ width: ' + vpW(step) + ' + chrome[0], height: ' + vpH(step) + ' + chrome[1] });\n}';
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
          if (py) return 'driver.execute_script(' + SET_VALUE_NAME + ', ' + loc + ', ' + val + ')';
          return 'await driver.executeScript(' + SET_VALUE_NAME + ', ' + loc + ', ' + val + ');';
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
      case 'selectOption': {
        var many = multiValues(step);
        if (many) {
          // A multi-select keeps earlier choices: clear them, then pick each label, so
          // the selection ends up exactly as recorded (as Playwright's selectOption).
          if (py) {
            return ['select = Select(' + loc + ')', 'select.deselect_all()'].concat(many.map(function (v) {
              return 'select.select_by_visible_text(' + q(v, lang) + ')';
            })).join('\n');
          }
          return '{\n  const select = new Select(' + loc + ');\n  await select.deselectAll();\n' + many.map(function (v) {
            return '  await select.selectByVisibleText(' + q(v, lang) + ');';
          }).join('\n') + '\n}';
        }
        if (py) return 'Select(' + loc + ').select_by_visible_text(' + valueExpr(step, lang) + ')';
        return 'await new Select(' + loc + ').selectByVisibleText(' + valueExpr(step, lang) + ');';
      }
      default: return todo(lang, 'unsupported step "' + commentSafe(a) + '"');
    }
  }

  // A viewport size is emitted as a number in code: anything but a positive, finite
  // number (NaN, Infinity, a string of code) falls back to the default.
  function vpSize(raw, fallback) {
    var n = Math.round(Number(raw));
    return n > 0 && isFinite(n) ? n : fallback;
  }
  function vpW(step) { return vpSize(step.width != null ? step.width : parseViewport(step.value).w, 1280); }
  function vpH(step) { return vpSize(step.height != null ? step.height : parseViewport(step.value).h, 720); }
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

  // C2: a toHaveValue recorded on a sensitive field carries no value; it compares
  // against the same environment variable the field's fill reads.
  function sensitiveAssert(step) { return !!step.sensitive && step.assertType === 'toHaveValue'; }

  // A sensitive comparison never prints the secret: not in an assertion's failure
  // message, and not in Cypress's command log (which also lands in videos).
  function secretMismatch(step) { return 'the value does not match ' + secretName(step); }

  // Playwright's toHaveValue prints the expected value (the secret) when it fails, in
  // the CI log and the HTML report. JS/TS polls a yes/no comparison instead, so the
  // report shows only the message and true/false, with the same retrying and timeout;
  // Python keeps the native retrying assertion and replaces its message (from None
  // drops the original from the traceback).
  function pwSecretAssert(step, loc, lang) {
    var secret = secretExpr(step, 'playwright', lang);
    var msg = q(secretMismatch(step), lang);
    if (lang === 'python') {
      return 'try:\n    expect(' + loc + ').to_have_value(' + secret + ')\n' +
        'except AssertionError:\n    raise AssertionError(' + msg + ') from None';
    }
    return 'await expect.poll(async () => (await ' + loc + '.inputValue()) === (' + secret + '), {\n' +
      '  message: ' + msg + ',\n}).toBe(true);';
  }

  // Text assertions: the recorder takes an element's text from innerText (what is
  // rendered, white space normalised), while Playwright's toHaveText/toContainText
  // compare textContent unless told otherwise — hidden text, <script> content and the
  // spacing between block elements made a recorded assertion fail.
  function pwAssert(step, lang) {
    var py = lang === 'python';
    var loc = locatorExpr(step.target, 'playwright', lang);
    var t = step.assertType || 'toBeVisible';
    var v = step.value;
    var unchecked = t === 'toBeChecked' && String(v) === 'false';
    if (sensitiveAssert(step)) return pwSecretAssert(step, loc, lang);
    if (py) {
      var pmap = {
        toBeVisible: 'to_be_visible()',
        toHaveText: 'to_have_text(' + q(v, lang) + ', use_inner_text=True)',
        toContainText: 'to_contain_text(' + q(v, lang) + ', use_inner_text=True)',
        toHaveValue: 'to_have_value(' + q(v, lang) + ')',
        toBeEnabled: 'to_be_enabled()',
        toBeChecked: unchecked ? 'not_to_be_checked()' : 'to_be_checked()'
      };
      return 'expect(' + loc + ').' + (pmap[t] || 'to_be_visible()');
    }
    var jmap = {
      toBeVisible: 'toBeVisible()',
      toHaveText: 'toHaveText(' + q(v, lang) + ', { useInnerText: true })',
      toContainText: 'toContainText(' + q(v, lang) + ', { useInnerText: true })',
      toHaveValue: 'toHaveValue(' + q(v, lang) + ')',
      toBeEnabled: 'toBeEnabled()',
      toBeChecked: unchecked ? 'not.toBeChecked()' : 'toBeChecked()'
    };
    return 'await expect(' + loc + ').' + (jmap[t] || 'toBeVisible()') + ';';
  }

  // Cypress's have.text compares raw textContent, so indentation and newlines in the
  // markup failed a text the user can see is identical. Compare the rendered text
  // (innerText), normalised as Playwright's toHaveText does, inside a retried
  // should() callback.
  function cyAssert(step, lang) {
    var loc = locatorExpr(step.target, 'cypress', lang);
    var t = step.assertType || 'toBeVisible';
    var v = step.value;
    if (sensitiveAssert(step)) {
      return secretExpr(step, 'cypress', lang) + '.then((secret) => {\n' +
        '  ' + loc + '.should(($el) => { expect($el.val() === secret, ' + q(secretMismatch(step), lang) + ').to.equal(true); });\n});';
    }
    var rendered = CY_TEXT_NAME + '($el)';
    var map = {
      toBeVisible: ".should('be.visible')",
      toHaveText: '.should(($el) => { expect(' + rendered + ').to.equal(' + q(normText(v), lang) + '); })',
      toContainText: '.should(($el) => { expect(' + rendered + ').to.contain(' + q(normText(v), lang) + '); })',
      toHaveValue: ".should('have.value', " + q(v, lang) + ')',
      toBeEnabled: ".should('be.enabled')",
      toBeChecked: String(v) === 'false' ? ".should('not.be.checked')" : ".should('be.checked')"
    };
    return loc + (map[t] || map.toBeVisible) + ';';
  }

  // getText() is already the rendered text; it is normalised like the recording
  // (white space collapsed, soft hyphens and zero-width spaces dropped).
  function selAssert(step, lang) {
    var py = lang === 'python';
    var loc = locatorExpr(step.target, 'selenium', lang);
    var t = step.assertType || 'toBeVisible';
    var v = step.value;
    var unchecked = String(v) === 'false';
    var sensitive = sensitiveAssert(step);
    if (py) {
      var pyText = PY_TEXT_NAME + '(' + loc + ')';
      switch (t) {
        case 'toHaveText': return 'assert ' + pyText + ' == ' + q(normText(v), lang);
        case 'toContainText': return 'assert ' + q(normText(v), lang) + ' in ' + pyText;
        case 'toHaveValue':
          if (sensitive) {
            return 'assert ' + loc + '.get_attribute("value") == ' + secretExpr(step, 'selenium', lang) + ', ' +
              q(secretMismatch(step), lang);
          }
          return 'assert ' + loc + '.get_attribute("value") == ' + q(v, lang);
        case 'toBeEnabled': return 'assert ' + loc + '.is_enabled()';
        case 'toBeChecked': return selWithEl(loc, lang, ['assert ' + (unchecked ? 'not ' : '') + selCheckedExpr('el', lang)]);
        case 'toBeVisible': default: return 'assert ' + loc + '.is_displayed()';
      }
    }
    var jsText = '(await ' + SEL_TEXT_NAME + '(' + loc + '))';
    switch (t) {
      case 'toHaveText': return 'assert.strictEqual(await ' + SEL_TEXT_NAME + '(' + loc + '), ' + q(normText(v), lang) + ');';
      case 'toContainText': return 'assert.ok(' + jsText + '.includes(' + q(normText(v), lang) + '));';
      case 'toHaveValue':
        if (sensitive) {
          return 'assert.ok((await ' + loc + ".getAttribute('value')) === (" + secretExpr(step, 'selenium', lang) + '), ' +
            q(secretMismatch(step), lang) + ');';
        }
        return 'assert.strictEqual(await ' + loc + ".getAttribute('value'), " + q(v, lang) + ');';
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
    // A step with alternative targets renders the one this framework prefers (C9.2).
    if (fw !== 'playwright') step = withPreferred(step, fw);
    var a = step.action;
    // A step from a newer recorder, or a corrupted one, becomes a visible TODO rather
    // than a throw or a silently different action.
    var plug = targetFor(fw, lang);
    if (KNOWN_ACTIONS.indexOf(a) === -1) return targetTodo(plug, lang, 'unsupported step "' + commentSafe(a) + '"');
    var urlStep = a === 'assert' && step.assertType === 'toHaveURL';
    if (!urlStep && TARGETLESS_ACTIONS.indexOf(a) === -1 && !unwrapFrames(step.target).inner) {
      return targetTodo(plug, lang, '"' + a + '" step has no element locator');
    }
    var stmt;
    if (plug) stmt = plug.actionStatement(step, lang);
    else if (urlStep) stmt = urlAssert(step, fw, lang);
    else if (fw === 'selenium') stmt = selStatement(step, lang);
    else if (fw === 'cypress') stmt = cyStatement(step, lang);
    else stmt = pwStatement(step, lang);
    // A locator the recorder found more than one element for says so, in every
    // framework, on the line before the step — unless what is rendered is not that
    // locator: an alternative chosen above, or a walk through shadow roots (each host
    // unique in its tree, shadowCss unique in the last root) are unique.
    var note = urlStep || TARGETLESS_ACTIONS.indexOf(a) !== -1 || (fw !== 'playwright' && walked(step.target))
      ? null : nonUniqueNote(step.target);
    if (!note) return stmt;
    return (plug && typeof plug.comment === 'function' ? plug.comment(note, lang) : comment(lang, note)) + '\n' + stmt;
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

    // selenium — derive imports from what the statements actually use; the Locatra
    // helpers go after them, each declared once and only when a statement uses it.
    var selDecls = selHelpers(joined, lang);
    var selBlock = selDecls.length ? selDecls.join(lang === 'python' ? '\n\n\n' : '\n\n') + (lang === 'python' ? '\n\n\n' : '\n\n') : '';
    var finds = uses(joined, lang === 'python' ? 'locatra_find' : 'locatraFind');
    if (lang === 'python') {
      var pyImports = ['from selenium import webdriver', 'from selenium.webdriver.common.by import By'];
      if (finds) pyImports.push('from selenium.common.exceptions import NoSuchElementException, WebDriverException');
      if (/Keys\./.test(joined)) pyImports.push('from selenium.webdriver.common.keys import Keys');
      var uiNames = [];
      if (/\bSelect\(/.test(joined)) uiNames.push('Select');
      if (/\bWebDriverWait\(/.test(joined)) uiNames.push('WebDriverWait');
      if (uiNames.length) pyImports.push('from selenium.webdriver.support.ui import ' + uiNames.join(', '));
      if (/\bEC\./.test(joined)) pyImports.push('from selenium.webdriver.support import expected_conditions as EC');
      return pyOs + (finds ? 'import time\n' : '') + pyImports.join('\n') + '\n\n\n' + selBlock + (decl ? decl + '\n\n' : '') +
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
    if (finds) jsNames.push('WebElementPromise');
    var jsHead = 'const { ' + jsNames.join(', ') + " } = require('selenium-webdriver');\n";
    if (/\bassert\./.test(joined)) jsHead += "const assert = require('assert');\n";
    return jsHead + '\n' + selBlock + declBlock +
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

  // Re-point a rendered expression's root receiver (`page.`, `driver.`, and the
  // driver a helper call is rooted at: `locatraFind(driver, …`) at another one
  // (`this.page.`, `self.driver.`), leaving string literals untouched — a selector
  // may well contain the text "driver.".
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
      var next = code.charAt(i + from.length);
      if (code.substr(i, from.length) === from && (next === '.' || (next === ',' && prev === '(')) && !/[\w$.]/.test(prev)) {
        out += to;
        i += from.length;
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
    if (fw === 'cypress' && hasXpath(el.target)) notes.push(comment(lang, CY_XPATH_NOTE));
    if (fw === 'cypress' && hasPositionalFrame(el.target)) {
      notes.push(comment(lang, 'NOTE: this iframe is cross-origin, so contentDocument is null and Cypress cannot reach into it.'));
    }
    if (fw !== 'playwright' && lacksShadowCss(el.target)) notes.push(comment(lang, SHADOW_NOTE));
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
              ? ['self.driver.execute_script(' + SET_VALUE_NAME + ', ' + get + ', value)']
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
      var pyFinds = uses(joinedPy, 'locatra_find');
      var imports = ['from selenium.webdriver.common.by import By', 'from selenium.webdriver.remote.webdriver import WebDriver',
        'from selenium.webdriver.remote.webelement import WebElement'];
      if (/\bSelect\(/.test(joinedPy)) imports.push('from selenium.webdriver.support.ui import Select');
      if (pyFinds) imports.push('from selenium.common.exceptions import NoSuchElementException, WebDriverException');
      var pyDecls = selHelpers(joinedPy, lang);
      return poHeader(model, lang, info.skipped) + (pyFinds ? 'import time\n\n' : '') + imports.join('\n') + '\n\n\n' +
        (pyDecls.length ? pyDecls.join('\n\n\n') + '\n\n\n' : '') + 'class ' + cls + ':\n' + block(body, '    ') + '\n';
    }
    if (ts) body.push('readonly driver: WebDriver;', '');
    body.push('constructor(driver' + (ts ? ': WebDriver' : '') + ') {', '  this.driver = driver;', '}');
    var ret = ts ? ': Promise<void>' : '';
    if (url) {
      body.push('', 'async goto()' + ret + ' {');
      if (anyFrames) body.push('  await this.driver.switchTo().defaultContent();');
      body.push('  await this.driver.get(' + q(url, lang) + ');', '}');
    }
    // A lookup through shadow roots awaits each hop, so it is an async method too.
    var isAsync = function (m) { return anyFrames || !!shadowWalk(unwrapFrames(m.el.target).inner); };
    members.forEach(function (m) {
      body.push('');
      body = body.concat(poNote(m.el, 'selenium', lang));
      if (isAsync(m)) {
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
            ? ['await this.driver.executeScript(' + SET_VALUE_NAME + ', ' + get + ', value);']
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
    var jsFinds = uses(joined, 'locatraFind');
    if (jsFinds) names.push('WebElementPromise');
    var jsDecls = selHelpers(joined, lang);
    var cls0 = (jsDecls.length ? jsDecls.join('\n\n') + '\n\n' : '') + (ts ? 'export ' : '') +
      'class ' + cls + ' {\n' + block(body, '  ') + '\n}\n';
    if (ts) {
      // @types/selenium-webdriver declares Select only in its own module.
      var types = [];
      if (members.some(isAsync)) types.push('type WebElement');
      // The helper constructs a WebElementPromise, so it is then a value import.
      if (!jsFinds && (!members.length || !members.every(isAsync))) types.push('type WebElementPromise');
      var tsImports = 'import { ' + ['By'].concat(jsFinds ? ['WebElementPromise'] : [], ['type WebDriver'], types).join(', ') +
        " } from 'selenium-webdriver';\n";
      if (names.indexOf('Select') !== -1) tsImports += "import { Select } from 'selenium-webdriver/lib/select.js';\n";
      return poHeader(model, lang, info.skipped) + tsImports + '\n' + cls0;
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
    var helpers = cyHelpers([all], lang);
    var helper = helpers.length ? helpers.join('\n\n') + '\n\n' : '';
    return poHeader(model, lang, info.skipped) + helper + 'export class ' + cls + ' {\n' + block(body, '  ') + '\n}\n';
  }

  function pageObject(model, fw, lang) {
    model = model || {};
    lang = pluginLang(fw, lang);
    // Elements with alternative targets render the one this framework prefers (C9.2).
    if (fw !== 'playwright' && Array.isArray(model.elements)) {
      var copy = {};
      for (var k in model) if (own(model, k)) copy[k] = model[k];
      copy.elements = model.elements.map(function (el) { return withPreferred(el, fw); });
      model = copy;
    }
    var plug = targetFor(fw, lang);
    if (plug) return plug.pageObject(model, lang);
    if (!isValidCombo(fw, lang)) lang = 'typescript';
    var cls = poClassName(model);
    var info = poMembers(model, fw, lang);
    if (fw === 'selenium') return poSelenium(model, lang, cls, info);
    if (fw === 'cypress') return poCypress(model, lang, cls, info);
    return poPlaywright(model, lang, cls, info);
  }

  /**
   * One locator for display and copying (C9.4): `expr` is the expression the
   * framework uses — short, and for a role / label / text target a helper call —
   * and `helpers` the declarations that expression needs ('' when none), so a copy
   * of expr + helpers runs on its own. altTargets (optional) are offered to
   * preferredTarget() first.
   */
  function locatorSnippet(target, fw, lang, altTargets) {
    lang = pluginLang(fw, lang);
    var t = preferredTarget(target, altTargets, fw);
    var expr = locatorExpr(t, fw, lang) || '';
    if (!expr) return { expr: '', helpers: '' };
    var plug = targetFor(fw, lang);
    var list = [];
    if (plug) list = typeof plug.helpers === 'function' ? plug.helpers(expr, lang) || [] : [];
    else if (fw === 'selenium') list = selHelpers(expr, lang);
    else if (fw === 'cypress') list = cyHelpers([expr], lang);
    return { expr: expr, helpers: list.join(lang === 'python' ? '\n\n\n' : '\n\n') };
  }

  /** Every helper declaration a framework/language can emit (what the budget test leaves out). */
  function allHelpers(fw, lang) {
    lang = pluginLang(fw, lang);
    var plug = targetFor(fw, lang);
    var every = 'locatraFind( locatra_find( Locatra( Locatra.find( Locatra.Find( LOCATRA_FRAME_JS LocatraFrameJs ' +
      'LOCATRA_SET_VALUE_JS LocatraSetValueJs locatraGet( locatraFrame( locatraSecret( locatraText( locatra_text( ' +
      'Locatra.text( Locatra.Text( LOCATRA_TEXT';
    if (plug) return typeof plug.helpers === 'function' ? plug.helpers(every, lang) : [];
    if (fw === 'selenium') return selHelpers(every, lang);
    return fw === 'cypress' ? cyHelpers([every], lang) : [];
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
    locatorSnippet: locatorSnippet,
    preferredTarget: preferredTarget,
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
      escapeControls: escapeControls, attrSel: attrSel, normWs: normWs, normText: normText, cssIdent: cssIdent,
      // numeric target fields, validated before they are emitted as code (C4)
      headingLevel: headingLevel, nonNegInt: nonNegInt, seleniumFrameIndex: seleniumFrameIndex,
      DEEP_IFRAME_JS: DEEP_IFRAME_JS, cyFrameSource: cyFrameSource,
      // multi-select (C1), sensitive assertions (C2), open shadow DOM (C3)
      multiValues: multiValues, sensitiveAssert: sensitiveAssert, secretMismatch: secretMismatch,
      shadowOf: shadowOf, shadowWalk: shadowWalk, shadowBreak: shadowBreak, pathBreak: pathBreak, lacksShadowCss: lacksShadowCss, SHADOW_NOTE: SHADOW_NOTE, attrMatchSel: attrMatchSel,
      unwrapFrames: unwrapFrames, validShadowPath: validShadowPath,
      // the Locatra helpers (C9.4) and the target a framework prefers (C9.2)
      MATCH_SRC: MATCH_SRC, MATCH_JS: MATCH_JS, MATCH_RUN: MATCH_RUN, tsOnly: tsOnly, helperSpec: helperSpec,
      // the compact matcher and the line widths of what a file declares
      jsTokens: jsTokens, compactPieces: compactPieces, matchNames: matchNames, matchSource: matchSource,
      matchLines: matchLines, matchScriptChunks: matchScriptChunks, wrapPieces: wrapPieces, chunkText: chunkText,
      literalLines: literalLines, jsMatchConst: jsMatchConst, pyMatchConst: pyMatchConst, HELPER_WIDTH: HELPER_WIDTH,
      HELPER_BANNER: HELPER_BANNER, TEXT_BANNER: TEXT_BANNER, TEXT_NOTE: TEXT_NOTE, jsHelperArgs: jsHelperArgs,
      pyHelperArgs: pyHelperArgs, selHelperSource: selHelperSource, cyGetSource: cyGetSource, uses: uses,
      HELPER_KINDS: HELPER_KINDS, ALT_KINDS: ALT_KINDS, needsHelper: needsHelper, scopedXpath: scopedXpath,
      FRAME_JS_NAME: FRAME_JS_NAME, SET_VALUE_NAME: SET_VALUE_NAME, FRAME_JS_NOTE: FRAME_JS_NOTE,
      SET_VALUE_NOTE: SET_VALUE_NOTE, hasXpath: hasXpath, CY_XPATH_NOTE: CY_XPATH_NOTE, allHelpers: allHelpers,
      hasNth: hasNth, isAmbiguousRole: isAmbiguousRole, hasAmbiguousRole: hasAmbiguousRole, roleNote: roleNote,
      recordedCount: recordedCount, nonUniqueNote: nonUniqueNote, callOn: callOn, STMT_WIDTH: STMT_WIDTH,
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
