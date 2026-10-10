// Locatra – content-locator-engine.js
// Playwright-oriented locator ranking (loaded before content.js).
//
// Every "how many elements does this locator match" answer below is meant to agree
// with what Playwright itself would resolve — same role table, same accessible-name
// algorithm, same text/label/attribute matching rules, same shadow-DOM traversal.
// The reference is Playwright's injected script (roleUtils.ts, selectorEvaluator.ts,
// injectedScript.ts); functions ported from it say so. A badge that says "unique"
// while Playwright finds two elements (or none) is worse than no badge at all.
(function (global) {
  'use strict';

  // Escape a string for use as a CSS identifier. Every browser we target has
  // CSS.escape; the fallback (a port of the CSSOM spec algorithm) exists so the
  // engine can also be exercised in a headless DOM that doesn't implement it.
  function cssEscape(value) {
    const s = String(value == null ? '' : value);
    if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') return CSS.escape(s);
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      const c = s.charAt(i);
      if (ch === 0) { out += '\uFFFD'; continue; }
      if ((ch >= 1 && ch <= 31) || ch === 127 ||
          (i === 0 && ch >= 48 && ch <= 57) ||
          (i === 1 && ch >= 48 && ch <= 57 && s.charCodeAt(0) === 45)) {
        out += '\\' + ch.toString(16) + ' ';
        continue;
      }
      if (i === 0 && s.length === 1 && ch === 45) { out += '\\' + c; continue; }
      if (ch >= 128 || ch === 45 || ch === 95 || (ch >= 48 && ch <= 57) ||
          (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122)) {
        out += c;
        continue;
      }
      out += '\\' + c;
    }
    return out;
  }

  // Wrap a value as the source text of a single-quoted JS string literal — i.e. what
  // the *displayed/copyable* `code` fields need, as opposed to the live `target`
  // matching below (which works with the real runtime string directly). Backslashes
  // are doubled first: cssEscape()/attrSelectorValue() below embed real backslash
  // characters (e.g. CSS.escape('md:w-1/2') === 'md\\:w-1\\/2'), and a lone backslash
  // in JS source is either a recognised escape or silently dropped — so without this,
  // copying the shown code into a real test file re-parses to the unescaped selector
  // it was built to avoid. Mirrors codegen.js's q().
  // Delegates to codegen.js's q() so "escape a JS string literal" has one
  // implementation, not two that can quietly drift apart (as happened before: this
  // used to have its own copy that was missing \r/\n/\t handling — a literal one of
  // those bytes inside a single-quoted JS string literal, as opposed to the
  // two-character escape, is a syntax error when the generated code is pasted into a
  // test file, and values like getByText's visible text come from innerText/
  // textContent and routinely contain one). Falls back to a local copy of the same
  // logic for contexts that load this file without codegen.js (e.g. its unit tests).
  function jsStr(value) {
    if (global.LLCodegen && typeof global.LLCodegen.q === 'function') {
      return global.LLCodegen.q(value);
    }
    return "'" + String(value == null ? '' : value)
      .replace(/\\/g, '\\\\')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t')
      .replace(/'/g, "\\'") + "'";
  }

  // A value for a double-quoted CSS attribute selector ([attr="..."]). Backslash and
  // quote need a backslash; control characters (a newline in a data-qa value, say)
  // are not allowed raw inside a CSS string at all and must become a hex escape
  // ("\a "), otherwise the selector is invalid and throws in querySelectorAll.
  function attrSelectorValue(v) {
    return String(v == null ? '' : v)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/[\x00-\x1f\x7f]/g, (c) => '\\' + c.charCodeAt(0).toString(16) + ' '); // eslint-disable-line no-control-regex
  }

  // ── Our own DOM artifacts ────────────────────────────────────────────────────
  // content.js decorates the page (hover outline, Lab highlights, …) with ll-* /
  // locatra-* classes and data-ll-* attributes. They exist only while the extension
  // is looking at the page, so a locator built on one is guaranteed to fail in a test.
  function isOwnArtifactClass(cls) {
    return /^(ll-|locatra-)/.test(String(cls || ''));
  }
  function isOwnArtifactAttr(attr) {
    return /^data-(ll|locatra)-/.test(String(attr || ''));
  }
  // The overlay, tooltip, toolbar, toast… are known by identity: content.js hands
  // each one to markOwnUi() when it creates it. An id prefix ("ll-*") used to
  // decide this, and a page with its own <div id="ll-root"> had its whole subtree
  // vanish from every count. A page script cannot reach this registry (content
  // scripts run in an isolated world), so it cannot hide its elements here either.
  // Our UI is plain light DOM appended to <body>, so Node.contains() is enough.
  // The registry outlives a re-evaluation of this file: background re-runs every
  // content script whenever it injects into all frames (an iframe added while
  // inspecting, recording, a health check, a POM pick), and the live content.js
  // instance then stands down without re-marking anything. A fresh Set here forgot
  // the overlay, its "▲ Parent" button and the toast, which then counted as page
  // elements. The previous engine object lives in this same isolated world, so its
  // registry is ours to carry over.
  const prevEngine = global.__LocatorLensEngine;
  const ownUiRoots = prevEngine && prevEngine.ownUiRoots instanceof Set ? prevEngine.ownUiRoots : new Set();
  function markOwnUi(el) {
    if (el && el.nodeType === 1) ownUiRoots.add(el);
  }
  function unmarkOwnUi(el) {
    ownUiRoots.delete(el);
  }
  function isOwnUi(n) {
    for (const r of ownUiRoots) {
      if (r.contains(n)) return true; // contains() includes r itself
    }
    return false;
  }

  // ── Per-analysis caches ──────────────────────────────────────────────────────
  // generateLocators() runs on every pick *and* on every captured click while
  // recording, and one call resolves many targets that share work (the full element
  // list, every element's text, accessible names, computed styles). The DOM cannot
  // change inside one synchronous call, so everything is memoised for exactly the
  // duration of the call and dropped afterwards. Calls nest safely (a depth counter).
  let ctx = null;
  // The document every page-wide query runs against. null means the global
  // `document`; resolveTarget() points it at a same-origin frame's document while it
  // resolves the inside of a frame target (always with a fresh cache context, since
  // every cache below is per document).
  let scopeDoc = null;
  function curDoc() { return scopeDoc || document; }
  function inDocument(doc, fn) {
    if (doc === curDoc()) return withCaches(fn);
    const savedCtx = ctx;
    const savedDoc = scopeDoc;
    ctx = null;
    scopeDoc = doc;
    try { return withCaches(fn); } finally { ctx = savedCtx; scopeDoc = savedDoc; }
  }
  function beginCaches() {
    if (ctx) { ctx.depth++; return; }
    ctx = {
      depth: 1,
      roots: new Map(), query: new Map(), style: new Map(), hidden: new Map(),
      hiddenTree: new Map(), role: new Map(), name: new Map(), text: new Map(),
      before: new Map(), after: new Map(), content: new Map(), nodes: new Map(),
      xpath: new Map(), labelMap: null
    };
  }
  function endCaches() {
    if (ctx && --ctx.depth === 0) ctx = null;
  }
  function withCaches(fn) {
    beginCaches();
    try { return fn(); } finally { endCaches(); }
  }
  function cached(bucket, key, compute) {
    if (!ctx) return compute();
    const m = ctx[bucket];
    if (m.has(key)) return m.get(key);
    const v = compute();
    m.set(key, v);
    return v;
  }

  // ── Shadow-DOM-piercing query ────────────────────────────────────────────────
  // document.querySelectorAll (and root.querySelectorAll) never descends into shadow
  // roots. Every place that needs "every matching element on the page" — uniqueness
  // counts, the Stress Test, the Selector Lab — funnels through this so an element
  // inside an open shadow root is actually found instead of silently producing zero
  // matches (or a false "unique") for pages built with web components.
  //
  // Order matches Playwright's own pierce-shadow query (selectorEvaluator _queryCSS),
  // so .first()/.nth(i) agree with it: a root's own matches first, then the scope's
  // own shadow root (when the scope is a host), then each shadow root found in that
  // root, in document order of its host — recursively. (Verified in Chromium: for
  // <button/> <host>#shadow<button/></host> <button/>, Playwright returns the two
  // light buttons before the shadow one.)
  //
  // Each root is searched with one native querySelectorAll(selector). Discovering the
  // shadow roots needs one querySelectorAll('*') per root, which is memoised per
  // analysis. Only nesting *depth* is guarded (against a pathological chain blowing
  // the stack); there is no cap on how many roots or elements are visited, because a
  // cap silently turns "3 matches" into "unique" or "not found".
  const DEEP_QUERY_MAX_DEPTH = 256;
  function rootsUnder(scope) {
    return cached('roots', scope, () => {
      const out = [];
      (function collect(root, depth) {
        out.push(root);
        if (depth >= DEEP_QUERY_MAX_DEPTH) return;
        if (root.shadowRoot) collect(root.shadowRoot, depth + 1);
        let all;
        try { all = root.querySelectorAll('*'); } catch (e) { return; }
        for (let i = 0; i < all.length; i++) {
          const sr = all[i].shadowRoot;
          if (sr) collect(sr, depth + 1);
        }
      })(scope, 0);
      return out;
    });
  }

  function deepQueryAllUncapped(selector, scope) {
    let perScope = ctx ? ctx.query.get(scope) : null;
    if (perScope && perScope.has(selector)) return perScope.get(selector);
    try { scope.querySelectorAll(selector); } catch (e) { return null; } // invalid selector
    const out = [];
    const roots = rootsUnder(scope);
    for (let r = 0; r < roots.length; r++) {
      let found;
      try { found = roots[r].querySelectorAll(selector); } catch (e) { continue; }
      for (let i = 0; i < found.length; i++) out.push(found[i]);
    }
    if (ctx) {
      if (!perScope) { perScope = new Map(); ctx.query.set(scope, perScope); }
      perScope.set(selector, out);
    }
    return out;
  }

  // Public signature kept: (selector, root?, cap?) → Element[] | null (invalid selector).
  function deepQueryAll(selector, root, cap) {
    const all = deepQueryAllUncapped(selector, root || document);
    if (!all) return null;
    const max = typeof cap === 'number' ? cap : Infinity;
    return all.length > max ? all.slice(0, max) : all.slice();
  }

  // Composed-tree helpers (cross shadow boundaries the way Playwright does).
  function parentElementOrShadowHost(el) {
    if (el.parentElement) return el.parentElement;
    const p = el.parentNode;
    if (p && p.nodeType === 11 && p.host) return p.host;
    return null;
  }
  function composedContains(ancestor, node) {
    let n = node;
    while (n) {
      if (n === ancestor) return true;
      n = n.nodeType === 11 ? (n.host || null) : n.parentNode;
    }
    return false;
  }
  function closestCrossShadow(el, selector) {
    let e = el;
    while (e) {
      const c = e.closest(selector);
      if (c) return c;
      const root = e.getRootNode ? e.getRootNode() : null;
      e = root && root.nodeType === 11 ? root.host : null;
    }
    return null;
  }
  function tagOf(el) {
    return typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  }

  // ── Visibility for the accessibility tree (port of isElementHiddenForAria) ──
  // getByRole() skips hidden elements by default, so a count that includes them
  // reports "2 matches" where Playwright finds one. Uses computed style only (no
  // layout), which also works in jsdom.
  const IS_JSDOM = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '');
  function computedStyle(el, pseudo) {
    const bucket = pseudo === '::before' ? 'before' : pseudo === '::after' ? 'after' : 'style';
    return cached(bucket, el, () => {
      if (pseudo && IS_JSDOM) return null; // not implemented there (and noisy)
      try {
        const view = el.ownerDocument && el.ownerDocument.defaultView;
        return view ? view.getComputedStyle(el, pseudo || null) : null;
      } catch (e) { return null; }
    });
  }
  function isIgnoredForAria(el) {
    const t = tagOf(el);
    return t === 'STYLE' || t === 'SCRIPT' || t === 'NOSCRIPT' || t === 'TEMPLATE';
  }
  function isStyleVisibilityVisible(el, style) {
    if (!style) return true;
    if (typeof el.checkVisibility === 'function') {
      try { if (!el.checkVisibility()) return false; } catch (e) {}
    } else {
      const ds = el.closest('details,summary');
      if (ds !== el && ds && tagOf(ds) === 'DETAILS' && !ds.open) return false;
    }
    return style.visibility === 'visible' || !style.visibility;
  }
  function belongsToHiddenTree(el) {
    return cached('hiddenTree', el, () => {
      const parent = el.parentElement;
      if (parent && parent.shadowRoot && 'assignedSlot' in el && !el.assignedSlot) return true;
      const style = computedStyle(el);
      if (style && style.display === 'none') return true;
      if ((el.getAttribute('aria-hidden') || '').toLowerCase() === 'true') return true;
      const up = parentElementOrShadowHost(el);
      return up ? belongsToHiddenTree(up) : false;
    });
  }
  function isHiddenForAria(el) {
    return cached('hidden', el, () => {
      if (isIgnoredForAria(el)) return true;
      const style = computedStyle(el);
      const isSlot = el.nodeName === 'SLOT';
      if (style && style.display === 'contents' && !isSlot) {
        for (let c = el.firstChild; c; c = c.nextSibling) {
          if (c.nodeType === 1 && !isHiddenForAria(c)) return false;
          if (c.nodeType === 3 && /\S/.test(c.nodeValue || '')) return false;
        }
        return true;
      }
      const optionInSelect = el.nodeName === 'OPTION' && !!el.closest('select');
      if (!optionInSelect && !isSlot && !isStyleVisibilityVisible(el, style)) return true;
      return belongsToHiddenTree(el);
    });
  }

  // ── ARIA role lookup (port of Playwright's getAriaRole) ─────────────────────
  const VALID_ROLES = new Set(('alert alertdialog application article banner blockquote button caption cell ' +
    'checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory ' +
    'document emphasis feed figure form generic grid gridcell group heading img insertion link list ' +
    'listbox listitem log main mark marquee math meter menu menubar menuitem menuitemcheckbox ' +
    'menuitemradio navigation none note option paragraph presentation progressbar radio radiogroup ' +
    'region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong ' +
    'subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip ' +
    'tree treegrid treeitem').split(' '));

  const ANCESTOR_PREVENTING_LANDMARK = 'article:not([role]), aside:not([role]), main:not([role]), ' +
    'nav:not([role]), section:not([role]), [role=article], [role=complementary], [role=main], ' +
    '[role=navigation], [role=region]';

  const GLOBAL_ARIA_ATTRS = [
    ['aria-atomic'], ['aria-busy'], ['aria-controls'], ['aria-current'], ['aria-describedby'],
    ['aria-details'], ['aria-dropeffect'], ['aria-flowto'], ['aria-grabbed'], ['aria-hidden'],
    ['aria-keyshortcuts'],
    ['aria-label', ['caption', 'code', 'deletion', 'emphasis', 'generic', 'insertion', 'paragraph', 'presentation', 'strong', 'subscript', 'superscript']],
    ['aria-labelledby', ['caption', 'code', 'deletion', 'emphasis', 'generic', 'insertion', 'paragraph', 'presentation', 'strong', 'subscript', 'superscript']],
    ['aria-live'], ['aria-owns'], ['aria-relevant'], ['aria-roledescription', ['generic']]
  ];
  function hasGlobalAriaAttribute(el, forRole) {
    return GLOBAL_ARIA_ATTRS.some(([attr, prohibited]) =>
      !(prohibited && prohibited.includes(forRole || '')) && el.hasAttribute(attr));
  }
  function hasTabIndex(el) {
    return !Number.isNaN(Number(String(el.getAttribute('tabindex'))));
  }
  function isNativelyDisabled(el) {
    if (!['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'OPTGROUP'].includes(tagOf(el))) return false;
    try { return el.matches(':disabled'); } catch (e) { return el.hasAttribute('disabled'); }
  }
  function isFocusable(el) {
    if (isNativelyDisabled(el)) return false;
    const t = tagOf(el);
    let native = false;
    if (['BUTTON', 'DETAILS', 'SELECT', 'TEXTAREA'].includes(t)) native = true;
    else if (t === 'A' || t === 'AREA') native = el.hasAttribute('href');
    else if (t === 'INPUT') native = !el.hidden;
    return native || hasTabIndex(el);
  }
  function idRefs(el, ref) {
    if (!ref) return [];
    const root = el.getRootNode ? el.getRootNode() : null;
    if (!root || (root.nodeType !== 9 && root.nodeType !== 11)) return [];
    const out = [];
    for (const id of ref.split(' ').filter(Boolean)) {
      let found = null;
      try {
        found = typeof root.getElementById === 'function'
          ? root.getElementById(id)
          : root.querySelector('#' + cssEscape(id));
      } catch (e) {}
      if (found && !out.includes(found)) out.push(found);
    }
    return out;
  }

  const INPUT_TYPE_TO_ROLE = {
    button: 'button', checkbox: 'checkbox', image: 'button', number: 'spinbutton',
    radio: 'radio', range: 'slider', reset: 'button', submit: 'button'
  };
  function headingFn() { return 'heading'; }
  const IMPLICIT_ROLES = {
    A: (e) => e.hasAttribute('href') ? 'link' : null,
    AREA: (e) => e.hasAttribute('href') ? 'link' : null,
    ARTICLE: () => 'article',
    ASIDE: () => 'complementary',
    BLOCKQUOTE: () => 'blockquote',
    BUTTON: () => 'button',
    CAPTION: () => 'caption',
    CODE: () => 'code',
    DATALIST: () => 'listbox',
    DD: () => 'definition',
    DEL: () => 'deletion',
    DETAILS: () => 'group',
    DFN: () => 'term',
    DIALOG: () => 'dialog',
    DT: () => 'term',
    EM: () => 'emphasis',
    FIELDSET: () => 'group',
    FIGURE: () => 'figure',
    // <header>/<footer> are only landmarks at page level; nested in sectioning
    // content they are generic (no role).
    FOOTER: (e) => closestCrossShadow(e, ANCESTOR_PREVENTING_LANDMARK) ? null : 'contentinfo',
    // <form>/<section> are landmarks only when they have an explicit name.
    FORM: (e) => (e.hasAttribute('aria-label') || e.hasAttribute('aria-labelledby')) ? 'form' : null,
    H1: headingFn, H2: headingFn, H3: headingFn, H4: headingFn, H5: headingFn, H6: headingFn,
    HEADER: (e) => closestCrossShadow(e, ANCESTOR_PREVENTING_LANDMARK) ? null : 'banner',
    HR: () => 'separator',
    HTML: () => 'document',
    // alt="" marks a decorative image (role presentation) unless something else makes
    // it interesting. Testing `el.alt !== undefined` was always true.
    IMG: (e) => (e.getAttribute('alt') === '' && !e.getAttribute('title') && !hasGlobalAriaAttribute(e) && !hasTabIndex(e)) ? 'presentation' : 'img',
    INPUT: (e) => {
      const type = String(e.type || '').toLowerCase();
      if (type === 'search') return e.hasAttribute('list') ? 'combobox' : 'searchbox';
      if (['email', 'tel', 'text', 'url', ''].includes(type)) {
        const list = idRefs(e, e.getAttribute('list'))[0];
        return list && tagOf(list) === 'DATALIST' ? 'combobox' : 'textbox';
      }
      if (type === 'hidden') return null;
      if (type === 'file') return 'button';
      return INPUT_TYPE_TO_ROLE[type] || 'textbox';
    },
    INS: () => 'insertion',
    LI: () => 'listitem',
    MAIN: () => 'main',
    MARK: () => 'mark',
    MATH: () => 'math',
    MENU: () => 'list',
    METER: () => 'meter',
    NAV: () => 'navigation',
    OL: () => 'list',
    OPTGROUP: () => 'group',
    OPTION: () => 'option',
    OUTPUT: () => 'status',
    P: () => 'paragraph',
    PROGRESS: () => 'progressbar',
    SEARCH: () => 'search',
    SECTION: (e) => (e.hasAttribute('aria-label') || e.hasAttribute('aria-labelledby')) ? 'region' : null,
    SELECT: (e) => (e.hasAttribute('multiple') || e.size > 1) ? 'listbox' : 'combobox',
    STRONG: () => 'strong',
    SUB: () => 'subscript',
    SUP: () => 'superscript',
    SVG: () => 'img',
    TABLE: () => 'table',
    TBODY: () => 'rowgroup',
    TD: (e) => {
      const table = closestCrossShadow(e, 'table');
      const r = table ? getExplicitRole(table) : '';
      return (r === 'grid' || r === 'treegrid') ? 'gridcell' : 'cell';
    },
    TEXTAREA: () => 'textbox',
    TFOOT: () => 'rowgroup',
    TH: (e) => {
      const scope = e.getAttribute('scope');
      if (scope === 'col' || scope === 'colgroup') return 'columnheader';
      if (scope === 'row' || scope === 'rowgroup') return 'rowheader';
      const next = e.nextElementSibling;
      const prev = e.previousElementSibling;
      const row = e.parentElement && tagOf(e.parentElement) === 'TR' ? e.parentElement : null;
      if (!next && !prev) {
        if (row) {
          const table = closestCrossShadow(row, 'table');
          if (table && table.rows && table.rows.length <= 1) return null;
        }
        return 'columnheader';
      }
      const isTh = (x) => !!x && tagOf(x) === 'TH';
      const isFilledTd = (x) => !!x && tagOf(x) === 'TD' && !!((x.textContent || '').trim() || x.children.length > 0);
      if (isTh(next) && isTh(prev)) return 'columnheader';
      if (isFilledTd(next) || isFilledTd(prev)) return 'rowheader';
      return 'columnheader';
    },
    THEAD: () => 'rowgroup',
    TIME: () => 'time',
    TR: () => 'row',
    UL: () => 'list'
  };

  // Which tags can carry each implicit role, so counting a role only has to look at
  // [role] elements plus those tags instead of computing the role of every node.
  // Roles not listed (none/presentation can be inherited by many tags) scan '*'.
  const ROLE_CANDIDATE_TAGS = {
    link: 'a,area', button: 'button,input', heading: 'h1,h2,h3,h4,h5,h6',
    textbox: 'input,textarea', searchbox: 'input', combobox: 'input,select',
    listbox: 'select,datalist', checkbox: 'input', radio: 'input', spinbutton: 'input',
    slider: 'input', img: 'img,svg', article: 'article', complementary: 'aside',
    blockquote: 'blockquote', caption: 'caption', code: 'code', definition: 'dd',
    deletion: 'del', group: 'details,fieldset,optgroup', term: 'dfn,dt', dialog: 'dialog',
    emphasis: 'em', figure: 'figure', contentinfo: 'footer', form: 'form', banner: 'header',
    separator: 'hr', document: 'html', insertion: 'ins', listitem: 'li', main: 'main',
    mark: 'mark', math: 'math', list: 'menu,ol,ul', meter: 'meter', navigation: 'nav',
    option: 'option', status: 'output', paragraph: 'p', progressbar: 'progress',
    search: 'search', region: 'section', strong: 'strong', subscript: 'sub',
    superscript: 'sup', table: 'table', rowgroup: 'tbody,tfoot,thead', cell: 'td',
    gridcell: 'td', columnheader: 'th', rowheader: 'th', time: 'time', row: 'tr'
  };
  const PRESENTATION_INHERITANCE_PARENTS = {
    DD: ['DL', 'DIV'], DIV: ['DL'], DT: ['DL', 'DIV'], LI: ['OL', 'UL'], TBODY: ['TABLE'],
    TD: ['TR'], TFOOT: ['TABLE'], TH: ['TR'], THEAD: ['TABLE'], TR: ['THEAD', 'TBODY', 'TFOOT', 'TABLE']
  };

  // The first *valid* token wins (role="foo button" is a button, as in Playwright and
  // browsers); an unknown first token used to become the role.
  function getExplicitRole(el) {
    const raw = el.getAttribute && el.getAttribute('role');
    if (!raw) return null;
    return raw.split(' ').map(r => r.trim()).find(r => VALID_ROLES.has(r)) || null;
  }
  function getImplicitRoleOwn(el) {
    const fn = IMPLICIT_ROLES[tagOf(el)];
    return (fn && fn(el)) || null;
  }
  function getImplicitRole(el) {
    const implicit = getImplicitRoleOwn(el);
    if (!implicit) return null;
    let ancestor = el;
    while (ancestor) {
      const parent = parentElementOrShadowHost(ancestor);
      const parents = PRESENTATION_INHERITANCE_PARENTS[tagOf(ancestor)];
      if (!parents || !parent || !parents.includes(tagOf(parent))) break;
      const pr = getExplicitRole(parent);
      if ((pr === 'none' || pr === 'presentation') && !(hasGlobalAriaAttribute(parent, pr) || isFocusable(parent))) return pr;
      ancestor = parent;
    }
    return implicit;
  }
  function getRole(el) {
    if (!el || el.nodeType !== 1) return null;
    return cached('role', el, () => {
      const explicit = getExplicitRole(el);
      if (!explicit) return getImplicitRole(el);
      if (explicit === 'none' || explicit === 'presentation') {
        const implicit = getImplicitRole(el);
        if (hasGlobalAriaAttribute(el, implicit) || isFocusable(el)) return implicit;
      }
      return explicit;
    });
  }

  // Port of Playwright's getAriaLevel: native <hN> first, then aria-level.
  function getHeadingLevel(el) {
    const m = /^H([1-6])$/.exec(tagOf(el));
    if (m) return parseInt(m[1], 10);
    if (['heading', 'listitem', 'row', 'treeitem'].includes(getRole(el) || '')) {
      const attr = el.getAttribute('aria-level');
      const v = attr === null ? NaN : Number(attr);
      if (Number.isInteger(v) && v >= 1) return v;
    }
    return null;
  }

  // ── Text normalisation ───────────────────────────────────────────────────────
  // Playwright's normalizeWhiteSpace — applied to page text *and* to the needle.
  function normalizeWS(s) {
    return String(s == null ? '' : s).replace(/[\u200b\u00ad]/g, '').trim().replace(/\s+/g, ' ');
  }

  // Shorten a long string to a word-bounded prefix. Only usable with substring
  // (non-exact) matching — a truncated value can never match exactly.
  function snippet(text, max) {
    if (text.length <= max) return { value: text, truncated: false };
    let cut = text.slice(0, max);
    const sp = cut.lastIndexOf(' ');
    if (sp > max / 2) cut = cut.slice(0, sp);
    return { value: cut.trim(), truncated: true };
  }

  // ── Element text (port of Playwright's elementText) ─────────────────────────
  // textContent-like (no layout, hidden text included — exactly what getByText
  // sees), with shadow-root content appended and <input type=submit|button> read
  // from its value. Cached per analysis.
  function shouldSkipForText(node) {
    const n = node.nodeName;
    if (n === 'SCRIPT' || n === 'NOSCRIPT' || n === 'STYLE') return true;
    const d = node.ownerDocument;
    return !!(d && d.head && d.head.contains(node));
  }
  function elementText(root) {
    return cached('text', root, () => {
      const value = { full: '', normalized: '', lower: null };
      if (shouldSkipForText(root)) return value;
      if (root.nodeName === 'INPUT' && (root.type === 'submit' || root.type === 'button')) {
        value.full = root.value || '';
      } else {
        for (let child = root.firstChild; child; child = child.nextSibling) {
          if (child.nodeType === 3) value.full += child.nodeValue || '';
          else if (child.nodeType === 1) value.full += elementText(child).full;
        }
        if (root.shadowRoot) value.full += elementText(root.shadowRoot).full;
      }
      value.normalized = normalizeWS(value.full);
      return value;
    });
  }
  function lowerOf(t) {
    if (t.lower == null) t.lower = t.normalized.toLowerCase();
    return t.lower;
  }
  // Playwright's createTextMatcher for internal:text / internal:label: exact → full
  // normalized equality (case-sensitive); default → case-insensitive substring.
  function textMatcher(value, exact) {
    const needle = normalizeWS(value);
    if (exact) return (t) => t.normalized === needle;
    const lower = needle.toLowerCase();
    return (t) => lowerOf(t).includes(lower);
  }
  // 'none' | 'self' | 'selfAndChildren' — getByText only returns 'self' elements:
  // the smallest element containing the text, never an ancestor of a match.
  function elementMatchesText(el, matcher) {
    if (shouldSkipForText(el)) return 'none';
    if (!matcher(elementText(el))) return 'none';
    for (let child = el.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1 && matcher(elementText(child))) return 'selfAndChildren';
    }
    if (el.shadowRoot && matcher(elementText(el.shadowRoot))) return 'selfAndChildren';
    return 'self';
  }

  // ── Labels ──────────────────────────────────────────────────────────────────
  const LABELABLE = new Set(['BUTTON', 'INPUT', 'METER', 'OUTPUT', 'PROGRESS', 'SELECT', 'TEXTAREA']);
  function labelControl(label) {
    if ('control' in label) return label.control;
    const f = label.getAttribute('for');
    if (f) {
      const root = label.getRootNode();
      const c = root && typeof root.getElementById === 'function' ? root.getElementById(f) : null;
      return c && LABELABLE.has(tagOf(c)) && !(tagOf(c) === 'INPUT' && c.type === 'hidden') ? c : null;
    }
    return label.querySelector('button, input:not([type=hidden]), meter, output, progress, select, textarea');
  }
  function buildLabelMap() {
    if (!ctx.labelMap) {
      ctx.labelMap = new Map();
      const labels = deepQueryAllUncapped('label', curDoc()) || [];
      for (const label of labels) {
        let c = null;
        try { c = labelControl(label); } catch (e) {}
        if (!c) continue;
        if (!ctx.labelMap.has(c)) ctx.labelMap.set(c, []);
        ctx.labelMap.get(c).push(label);
      }
    }
    return ctx.labelMap;
  }
  // element.labels walks the tree per control; resolving every label once and
  // inverting is O(DOM) for the whole analysis instead of O(controls × DOM).
  function labelsFor(el) {
    const t = tagOf(el);
    if (!LABELABLE.has(t) || (t === 'INPUT' && el.type === 'hidden')) return [];
    if (!ctx) {
      if (el.labels) return Array.from(el.labels);
      return [];
    }
    let list = buildLabelMap().get(el);
    // A control outside `document` (detached, another frame) was not indexed.
    if (!list && el.labels && !el.isConnected) list = Array.from(el.labels);
    return list || [];
  }
  function labelledByElements(el) {
    const ref = el.getAttribute('aria-labelledby');
    if (ref === null) return null;
    const refs = idRefs(el, ref);
    return refs.length ? refs : null;
  }
  // Port of Playwright's getElementLabels — exactly what getByLabel() matches
  // against: aria-labelledby targets, else aria-label, else associated <label>s.
  // Any element qualifies (a <button aria-label="Close"> is found by getByLabel).
  function labelTexts(el) {
    const lb = labelledByElements(el);
    if (lb) return lb.map(l => elementText(l));
    const al = el.getAttribute('aria-label');
    if (al !== null && al.trim()) return [{ full: al, normalized: normalizeWS(al), lower: null }];
    return labelsFor(el).map(l => elementText(l));
  }

  // ── Accessible name computation (port of Playwright's getElementAccessibleName) ──
  // aria-labelledby beats aria-label, which beats native labelling (label, alt,
  // value…), then name-from-content for roles that allow it, then title — the
  // accname order Playwright implements. Descendant alt/aria-label/control values
  // contribute to name-from-content.
  function allowsNameFromContent(role, targetDescendant) {
    const always = ['button', 'cell', 'checkbox', 'columnheader', 'gridcell', 'heading', 'link', 'menuitem',
      'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'row', 'rowheader', 'switch', 'tab',
      'tooltip', 'treeitem'].includes(role);
    const descendant = targetDescendant && ['', 'caption', 'code', 'contentinfo', 'definition', 'deletion',
      'emphasis', 'insertion', 'list', 'listitem', 'mark', 'none', 'paragraph', 'presentation', 'region',
      'row', 'rowgroup', 'section', 'strong', 'subscript', 'superscript', 'table', 'term', 'time'].includes(role);
    return always || descendant;
  }
  const NAME_PROHIBITED = new Set(['caption', 'code', 'definition', 'deletion', 'emphasis', 'generic',
    'insertion', 'mark', 'paragraph', 'presentation', 'strong', 'subscript', 'suggestion', 'superscript',
    'term', 'time']);

  // CSS generated content (icon fonts, "*" required markers) is part of the name.
  function parseCSSContent(el, value, isPseudo) {
    const toks = [];
    const s = String(value);
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '"' || c === "'") {
        let j = i + 1;
        let out = '';
        while (j < s.length && s[j] !== c) {
          if (s[j] === '\\') {
            const m = /^\\([0-9a-fA-F]{1,6})\s?/.exec(s.slice(j));
            if (m) { out += String.fromCodePoint(parseInt(m[1], 16)); j += m[0].length; continue; }
            out += s[j + 1] || '';
            j += 2;
            continue;
          }
          out += s[j++];
        }
        toks.push({ t: 'str', v: out });
        i = j + 1;
        continue;
      }
      if (c === '/') { toks.push({ t: 'delim' }); i++; continue; }
      const attr = /^attr\(\s*([-\w]+)\s*\)/i.exec(s.slice(i));
      if (attr) { toks.push({ t: 'attr', v: attr[1] }); i += attr[0].length; continue; }
      const fn = /^[-\w]+\([^)]*\)/.exec(s.slice(i));
      const other = fn || /^[^\s/"']+/.exec(s.slice(i));
      toks.push({ t: 'other' });
      i += other ? other[0].length : 1;
    }
    let use = toks;
    const d = toks.findIndex(t => t.t === 'delim');
    if (d !== -1) use = toks.slice(d + 1);
    else if (!isPseudo) return undefined;
    let acc = '';
    for (const t of use) {
      if (t.t === 'str') acc += t.v;
      else if (t.t === 'attr') acc += el.getAttribute(t.v) || '';
      else return undefined;
    }
    return acc;
  }
  function cssContent(el, pseudo) {
    const bucket = 'content';
    const key = pseudo ? null : el;
    const compute = () => {
      const style = computedStyle(el, pseudo);
      let content;
      if (style) {
        const v = style.content;
        if (v && v !== 'none' && v !== 'normal' && style.display !== 'none' && style.visibility !== 'hidden') {
          try { content = parseCSSContent(el, v, !!pseudo); } catch (e) {}
        }
      }
      if (pseudo && content !== undefined && (style.display || 'inline') !== 'inline') content = ' ' + content + ' ';
      return content;
    };
    return key ? cached(bucket, key, compute) : compute();
  }

  function nameFromLabels(labels, o) {
    return labels.map(label => textAlternative(label, {
      visited: o.visited, inLabel: { hidden: isHiddenForAria(label) }
    })).filter(Boolean).join(' ');
  }

  function textAlternative(element, o) {
    if (o.visited.has(element)) return '';
    const childO = Object.assign({}, o, { inTarget: o.inTarget === 'self' ? 'descendant' : o.inTarget });
    const hiddenTraversal = !!((o.inLabelledBy && o.inLabelledBy.hidden) || (o.inNative && o.inNative.hidden) ||
      (o.inLabel && o.inLabel.hidden));
    if (isIgnoredForAria(element) || (!hiddenTraversal && isHiddenForAria(element))) {
      o.visited.add(element);
      return '';
    }
    const labelledBy = labelledByElements(element);
    if (!o.inLabelledBy) {
      const n = (labelledBy || []).map(ref => textAlternative(ref, {
        visited: o.visited, inLabelledBy: { hidden: isHiddenForAria(ref) }
      })).join(' ');
      if (n) return n;
    }
    const role = getRole(element) || '';
    const tag = tagOf(element);

    // Embedded controls contribute their value, not their label.
    if (o.inLabel || o.inLabelledBy || o.inTarget === 'descendant') {
      if (!(labelledBy || []).includes(element)) {
        if (role === 'textbox') {
          o.visited.add(element);
          if (tag === 'INPUT' || tag === 'TEXTAREA') return element.value || '';
          return element.textContent || '';
        }
        if (role === 'combobox' || role === 'listbox') {
          o.visited.add(element);
          let selected;
          if (tag === 'SELECT') {
            selected = Array.from(element.selectedOptions || []);
            if (!selected.length && element.options && element.options.length) selected.push(element.options[0]);
          } else {
            const listbox = role === 'combobox'
              ? Array.from(element.querySelectorAll('*')).find(e => getRole(e) === 'listbox')
              : element;
            selected = listbox
              ? Array.from(listbox.querySelectorAll('[aria-selected="true"]')).filter(e => getRole(e) === 'option')
              : [];
          }
          if (!selected.length && tag === 'INPUT') return element.value || '';
          return selected.map(opt => textAlternative(opt, childO)).join(' ');
        }
        if (['progressbar', 'scrollbar', 'slider', 'spinbutton', 'meter'].includes(role)) {
          o.visited.add(element);
          if (element.hasAttribute('aria-valuetext')) return element.getAttribute('aria-valuetext') || '';
          if (element.hasAttribute('aria-valuenow')) return element.getAttribute('aria-valuenow') || '';
          return element.getAttribute('value') || '';
        }
        if (role === 'menu') { o.visited.add(element); return ''; }
      }
    }

    const ariaLabel = element.getAttribute('aria-label') || '';
    if (ariaLabel.trim()) { o.visited.add(element); return ariaLabel; }

    if (role !== 'presentation' && role !== 'none') {
      const type = tag === 'INPUT' ? String(element.type || '').toLowerCase() : '';
      // <input type=submit|button|reset>: value before title.
      if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(type)) {
        o.visited.add(element);
        const value = element.value || '';
        if (value.trim()) return value;
        if (type === 'submit') return 'Submit';
        if (type === 'reset') return 'Reset';
        return element.getAttribute('title') || '';
      }
      if (tag === 'INPUT' && type === 'file') {
        o.visited.add(element);
        const labels = labelsFor(element);
        if (labels.length && !o.inLabelledBy) return nameFromLabels(labels, o);
        return 'Choose File';
      }
      if (tag === 'INPUT' && type === 'image') {
        o.visited.add(element);
        const labels = labelsFor(element);
        if (labels.length && !o.inLabelledBy) return nameFromLabels(labels, o);
        const alt = element.getAttribute('alt') || '';
        if (alt.trim()) return alt;
        const title = element.getAttribute('title') || '';
        if (title.trim()) return title;
        return 'Submit';
      }
      if (!labelledBy && tag === 'BUTTON') {
        o.visited.add(element);
        const labels = labelsFor(element);
        if (labels.length) return nameFromLabels(labels, o);
      }
      if (!labelledBy && tag === 'OUTPUT') {
        o.visited.add(element);
        const labels = labelsFor(element);
        if (labels.length) return nameFromLabels(labels, o);
        return element.getAttribute('title') || '';
      }
      if (!labelledBy && (tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'INPUT')) {
        o.visited.add(element);
        const labels = labelsFor(element);
        if (labels.length) return nameFromLabels(labels, o);
        const usePlaceholder = (tag === 'INPUT' && ['text', 'password', 'search', 'tel', 'email', 'url'].includes(type)) || tag === 'TEXTAREA';
        const placeholder = element.getAttribute('placeholder') || '';
        const title = element.getAttribute('title') || '';
        if (!usePlaceholder || title) return title;
        return placeholder;
      }
      if (!labelledBy && (tag === 'FIELDSET' || tag === 'FIGURE' || tag === 'TABLE')) {
        o.visited.add(element);
        const want = tag === 'FIELDSET' ? 'LEGEND' : tag === 'FIGURE' ? 'FIGCAPTION' : 'CAPTION';
        for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
          if (tagOf(child) === want) {
            return textAlternative(child, Object.assign({}, childO, { inNative: { hidden: isHiddenForAria(child) } }));
          }
        }
        if (tag === 'TABLE') {
          const summary = element.getAttribute('summary') || '';
          if (summary) return summary;
        } else {
          return element.getAttribute('title') || '';
        }
      }
      if (tag === 'IMG' || tag === 'AREA') {
        o.visited.add(element);
        const alt = element.getAttribute('alt') || '';
        if (alt.trim()) return alt;
        return element.getAttribute('title') || '';
      }
      if (tag === 'SVG' || element.ownerSVGElement) {
        o.visited.add(element);
        for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
          if (tagOf(child) === 'TITLE' && child.ownerSVGElement) {
            return textAlternative(child, Object.assign({}, childO, { inLabelledBy: { hidden: isHiddenForAria(child) } }));
          }
        }
      }
    }

    const summaryContent = tag === 'SUMMARY' && role !== 'presentation' && role !== 'none';
    if (allowsNameFromContent(role, o.inTarget === 'descendant') || summaryContent ||
        o.inLabelledBy || o.inLabel || o.inNative) {
      o.visited.add(element);
      const acc = accumulatedText(element, childO);
      const check = o.inTarget === 'self' ? acc.trim() : acc;
      if (check) return acc;
    }
    if ((role !== 'presentation' && role !== 'none') || tag === 'IFRAME') {
      o.visited.add(element);
      const title = element.getAttribute('title') || '';
      if (title.trim()) return title;
    }
    o.visited.add(element);
    return '';
  }
  function accumulatedText(element, o) {
    const tokens = [];
    const visit = (node, skipSlotted) => {
      if (skipSlotted && node.assignedSlot) return;
      if (node.nodeType === 1) {
        const style = computedStyle(node);
        const display = (style && style.display) || 'inline';
        let token = textAlternative(node, o);
        if (display !== 'inline' || node.nodeName === 'BR') token = ' ' + token + ' ';
        tokens.push(token);
      } else if (node.nodeType === 3) {
        tokens.push(node.textContent || '');
      }
    };
    tokens.push(cssContent(element, '::before') || '');
    const content = cssContent(element);
    if (content !== undefined) {
      tokens.push(content);
    } else {
      const assigned = element.nodeName === 'SLOT' && element.assignedNodes ? element.assignedNodes() : [];
      if (assigned.length) {
        for (const child of assigned) visit(child, false);
      } else {
        for (let child = element.firstChild; child; child = child.nextSibling) visit(child, true);
        if (element.shadowRoot) {
          for (let child = element.shadowRoot.firstChild; child; child = child.nextSibling) visit(child, true);
        }
      }
    }
    tokens.push(cssContent(element, '::after') || '');
    return tokens.join('');
  }

  // Normalised accessible name ('' when none) — what getByRole's name option is
  // matched against.
  function accessibleName(el) {
    return cached('name', el, () => {
      if (NAME_PROHIBITED.has(getRole(el) || '')) return '';
      return normalizeWS(textAlternative(el, { visited: new Set(), inTarget: 'self' }));
    });
  }
  // Public: the accessible name, or null when the element has none.
  function getAccessibleName(el) {
    if (!el || el.nodeType !== 1) return null;
    try { return accessibleName(el) || null; } catch (e) { return null; }
  }

  // ── A11y Audit Engine ──────────────────────────────────────────────────────
  function analyzeA11y(el) {
    const issues = [];
    const tag = el.tagName.toLowerCase();
    const role = getRole(el);
    const name = getAccessibleName(el);

    // 1. Missing Alt Text
    if (tag === 'img' && !el.hasAttribute('alt')) {
      issues.push({ severity: 'high', message: 'Missing [alt] text on image. Screen readers will skip this or read the filename.' });
    }

    // 2. Form Control Labeling
    if (['input', 'select', 'textarea'].includes(tag)) {
      const type = el.getAttribute('type');
      if (type !== 'hidden' && type !== 'submit' && type !== 'button') {
        if (!name) {
          issues.push({ severity: 'high', message: 'Form control lacks a label. Assign an id and use <label for="..."> or aria-label.' });
        }
      }
    }

    // 3. Redundant Role
    const explicitRole = el.getAttribute('role');
    if (explicitRole) {
      const implicit = getImplicitRoleOwn(el);
      if (explicitRole === implicit) {
        issues.push({ severity: 'low', message: `Redundant role="${explicitRole}". Browsers already treat <${tag}> as this role.` });
      }
    }

    // 4. Low-Semantic DIV/SPAN buttons
    if ((tag === 'div' || tag === 'span') && (role === 'button' || el.onclick)) {
      issues.push({ severity: 'low', message: 'Consider using a <button> instead of a <div> for better native keyboard support.' });
    }

    // 5. Accessible Name Check for Interactive Elements
    const interactiveRoles = ['button', 'link', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'menuitem', 'tab'];
    if (role && interactiveRoles.includes(role) && !name) {
      issues.push({ severity: 'low', message: `Interactive <${tag}> has no accessible name. Important for screen reader users.` });
    }

    return issues;
  }

  // ── Check if a string looks auto-generated / unstable ─────────────────────
  // A class is "unstable" when it is emitted by a build tool or runtime and changes
  // between builds or renders. Hand-written names — btn-primary, text-center,
  // form-control, nav-wrapper, col-md-6, card__title, MuiButton-root — are stable
  // even though they contain hyphens and short tokens; the old "2–4 letters, dash,
  // 6+ chars" rule flagged every one of those as generated.
  const UNSTABLE_CLASS_PATTERNS = [
    /^sc-[A-Za-z0-9]{4,}$/,                          // styled-components (sc-bdVaJa)
    /^css-(?=[a-z0-9]*\d)[a-z0-9]{4,}(-[\w-]+)?$/i,  // emotion / css-in-js (css-1x2y3z, css-1dbjc4n-Button)
    /^emotion-\d+$/,
    /^jss\d+$/,                                      // JSS
    /^(makeStyles|Mui[A-Za-z]*|Private[A-Za-z]*|jss)[A-Za-z0-9]*-[A-Za-z0-9]+-\d+$/, // makeStyles-root-12, MuiButton-root-123
    /^[A-Za-z][A-Za-z0-9-]*_[A-Za-z0-9-]+__(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{5,}$/, // CSS modules [name]_[local]__[hash]
    /^[A-Za-z][A-Za-z0-9-]*-module__[A-Za-z0-9-]+___?[A-Za-z0-9_-]{5,}$/,            // CSS modules [file]-module__[local]___[hash]
    /^_(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{5,}$/,      // css-loader [hash:base64] (_3xK9a)
    /^svelte-[a-z0-9]{5,}$/,                         // Svelte scoped styles
    /^ng-tns-/,                                      // Angular animation scope
    /^ng-(touched|untouched|pristine|dirty|valid|invalid|pending|star-inserted|animating|trigger)\b/ // Angular state
  ];
  // A segment that looks like a hash: letters and digits interleaved several times
  // (a1B2c, 1dbjc4n, e1q3ycj70), or a long digit run. "300px", "h264", "col12",
  // "2xl" have at most one letter/digit switch and stay stable.
  function looksLikeHash(seg) {
    if (/\d{5,}/.test(seg)) return true;
    if (!/^[A-Za-z0-9]{5,}$/.test(seg) || !/\d/.test(seg) || !/[A-Za-z]/.test(seg)) return false;
    let switches = 0;
    for (let i = 1; i < seg.length; i++) {
      if (/\d/.test(seg[i]) !== /\d/.test(seg[i - 1])) switches++;
    }
    return switches >= 3;
  }
  function isUnstableClass(cls) {
    const c = String(cls || '');
    if (!c) return false;
    if (UNSTABLE_CLASS_PATTERNS.some(re => re.test(c))) return true;
    return c.split(/[-_:/]+/).some(looksLikeHash);
  }

  // A class that says what state the element is in rather than what it is: the
  // page adds and removes it as the user interacts. A locator built from it
  // describes the DOM *after* the click that set it (TodoMVC's li.completed) and
  // misses on replay. Stable in the sense above, but never part of a CSS selector.
  const STATE_CLASS_WORDS = 'completed|active|selected|checked|open|opened|expanded|collapsed|disabled|' +
    'focus|focused|focus-visible|hover|hovered|current|pressed|visited|loading|dragging|highlighted|invalid';
  const STATE_CLASS_PATTERNS = [
    new RegExp('^(' + STATE_CLASS_WORDS + ')$', 'i'),
    /^(is|has)-[\w-]+$/,                                        // is-active, has-error
    /^ng-[\w-]+$/,                                              // every Angular runtime class
    new RegExp('(--|__)(' + STATE_CLASS_WORDS + ')$', 'i'),     // BEM modifiers: tab--active, item__selected
    new RegExp('^[\\w-]+-(' + STATE_CLASS_WORDS + ')$', 'i')    // nav-item-active, btn-selected
  ];
  function isStateClass(cls) {
    const c = String(cls || '');
    return !!c && STATE_CLASS_PATTERNS.some(re => re.test(c));
  }

  function hasUnstableClasses(el) {
    if (!el.className || typeof el.className !== 'string') return false;
    return el.className.trim().split(/\s+/).some(c => !isOwnArtifactClass(c) && isUnstableClass(c));
  }

  // Ids generated per render/build. Hand-written ids (user-name, main, step-2,
  // login-form) are kept.
  const UNSTABLE_ID_PATTERNS = [
    /^\d+$/,                                    // pure number
    /:[rR][0-9a-zA-Z]*:/,                       // React useId (:r0:, :R1a:, radix-:r3:)
    /«[^»]*»/,                                  // React 19 useId («r1»)
    /^(radix|headlessui|downshift|react-aria|reach)-/i,
    /^react-select-\d+/,
    /^(mat|cdk)-[a-z-]+-\d+$/,                  // Angular Material (mat-input-0)
    /^mui-\d+$/i,
    /^ember\d+$/,
    /^ext-(gen|comp|element)-?\d+/,             // ExtJS
    /^j_id/,                                    // JSF
    /^yui_/,
    /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i, // UUID
    /[_-]\d{3,}$/,                              // input_1234, field-123
    /\d{5,}/                                    // long digit runs
  ];
  function isUnstableId(id) {
    if (!id) return false;
    const s = String(id);
    if (UNSTABLE_ID_PATTERNS.some(re => re.test(s))) return true;
    // A hex-ish hash segment (section-a3f9b2c1), not a word.
    return s.split(/[-_:.]+/).some(seg => /^[0-9a-f]{8,}$/i.test(seg) && /\d/.test(seg) && /[a-f]/i.test(seg));
  }
  // An "ll-…" id on a page element is the page's own: our UI is never the subject
  // of a locator or an ancestor of one, so no prefix needs excluding here.
  function usableId(id) {
    return !!id && !isUnstableId(id);
  }

  // ── Build a reliable CSS selector fallback ─────────────────────────────────
  // Walks up from the element adding one level at a time and stops as soon as the
  // selector matches exactly this element (counted across shadow roots, as
  // Playwright would). An ancestor with a stable, unique id anchors the path
  // (`#id > … > el`); the old code returned the bare `#ancestorId` at that point,
  // discarding the path and targeting the ancestor instead of the element.
  function buildCSSSelector(el, doc) {
    // Defaults to the element's own document, which is what makes this usable for an
    // <iframe> element that lives in the parent document rather than in ours.
    // The guard comes first: reading el.ownerDocument threw on a null element.
    if (!el || !el.tagName) return 'body';
    const d = doc || el.ownerDocument || document;
    if (el === d.body || el === d.documentElement) return el.tagName.toLowerCase();
    return withCaches(() => {
      const resolvesToEl = (sel) => {
        const found = deepQueryAllUncapped(sel, d);
        return !!found && found.length === 1 && found[0] === el;
      };
      const parts = [];
      let current = el;
      let sel = '';
      while (current && current !== d.body && current !== d.documentElement) {
        // CSS.escape: ids legally contain ':' '.' '[' etc. (Tailwind, Rails, Angular
        // all emit them). Unescaped, the returned string is an invalid selector that
        // throws in querySelectorAll and produces uncompilable generated code.
        if (usableId(current.id)) {
          const anchored = ['#' + cssEscape(current.id)].concat(parts).join(' > ');
          if (resolvesToEl(anchored)) return anchored;
        }
        let part = cssEscape(current.tagName.toLowerCase());
        const stableClasses = current.className && typeof current.className === 'string'
          ? current.className.trim().split(/\s+/).filter(c => c && !isOwnArtifactClass(c) && !isUnstableClass(c) && !isStateClass(c))
          : [];
        if (stableClasses.length) {
          // Utility-class frameworks (Tailwind's sm:flex, w-1/2, …) are common and
          // pass isUnstableClass — but ':' and '/' are CSS-special and left the
          // selector invalid without this, exactly like the unescaped id case above.
          part += '.' + stableClasses.slice(0, 2).map(cssEscape).join('.');
        }
        // Nth-of-type disambiguation among same-tag siblings — a shadow root's
        // top-level elements included: they have a parentNode (the root) but no
        // parentElement, and went without one (`div.item` matching all three items).
        const tree = current.parentElement || current.parentNode;
        const siblings = tree && tree.children
          ? Array.from(tree.children).filter(c => c.tagName === current.tagName)
          : [];
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
        parts.unshift(part);
        sel = parts.join(' > ');
        if (resolvesToEl(sel)) return sel;
        current = current.parentElement;
      }
      // Reached <body> (or a shadow root's top) without a unique match: anchor at
      // <body> when the walk got there — the full child-combinator path is unique in
      // the light DOM.
      if (current === d.body && parts.length) {
        const anchored = 'body > ' + parts.join(' > ');
        if (resolvesToEl(anchored)) return anchored;
      }
      // The walk stops *at* <body>, so <body> itself produced an empty string — and
      // `page.locator('')` is a runtime error in every framework and throws inside
      // querySelectorAll here. The context-menu path falls back to document.body when
      // it has no tracked element, so this was reachable by right-clicking.
      return sel || el.tagName.toLowerCase();
    });
  }

  // ── Live uniqueness: which elements does a locator actually match? ───────────
  // Every matcher mirrors Playwright's default semantics. Nothing is capped: a scan
  // cap made elements past the first N invisible, producing a false "unique" or a
  // false "not found" on large pages (and never reached shadow content, which is
  // visited last).
  function nodesBySelector(sel) {
    try { return deepQueryAllUncapped(sel, curDoc()); } catch (e) { return null; }
  }
  function nodesByText(value, exact) {
    const matcher = textMatcher(value, exact);
    const all = deepQueryAllUncapped('*', curDoc()) || [];
    const out = [];
    let lastNone = null;
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      // A descendant of a non-matching element cannot contain the substring either.
      if (!exact && lastNone && lastNone.contains(el)) continue;
      const m = elementMatchesText(el, matcher);
      if (m === 'none') lastNone = el;
      if (m === 'self') out.push(el);
    }
    return out;
  }
  function nodesByRole(t) {
    const cand = ROLE_CANDIDATE_TAGS[t.role];
    const all = deepQueryAllUncapped(cand ? '[role],' + cand : '*', curDoc()) || [];
    const hasName = t.name != null && t.name !== '';
    const needle = hasName ? normalizeWS(t.name) : '';
    // Playwright compares role names with toUpperCase() (attribute-selector rules),
    // text with toLowerCase(); mirrored exactly.
    const upper = needle.toUpperCase();
    const out = [];
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (getRole(el) !== t.role) continue;
      if (t.level && getHeadingLevel(el) !== t.level) continue;
      if (isHiddenForAria(el)) continue;
      if (hasName) {
        const n = accessibleName(el);
        if (t.exact ? n !== needle : !n.toUpperCase().includes(upper)) continue;
      }
      out.push(el);
    }
    return out;
  }
  function nodesByLabel(value, exact) {
    const matcher = textMatcher(value, exact);
    const labelMap = buildLabelMap();
    const seen = new Set();
    const cands = [];
    const add = (e) => { if (!seen.has(e)) { seen.add(e); cands.push(e); } };
    (deepQueryAllUncapped('[aria-labelledby],[aria-label]', curDoc()) || []).forEach(add);
    labelMap.forEach((_, control) => add(control));
    const hits = cands.filter(e => labelTexts(e).some(matcher));
    if (hits.length < 2) return hits;
    // Playwright returns label matches in its pierce-shadow document order.
    const hitSet = new Set(hits);
    return (deepQueryAllUncapped('*', curDoc()) || []).filter(e => hitSet.has(e));
  }
  // getByPlaceholder / getByAltText / getByTitle: Playwright's internal:attr engine
  // — any element carrying the attribute; default is a case-insensitive substring of
  // the raw value, exact is raw equality (no whitespace normalisation).
  function nodesByAttr(attr, value, exact) {
    const all = deepQueryAllUncapped('[' + attr + ']', curDoc()) || [];
    const v = String(value == null ? '' : value);
    const lower = v.toLowerCase();
    return all.filter(e => {
      const a = e.getAttribute(attr) || '';
      return exact ? a === v : a.toLowerCase().includes(lower);
    });
  }

  // A `kind: 'xpath'` target (C9.1): what Playwright's xpath= engine returns —
  // element results only, in document order. XPath never pierces shadow roots, in
  // Playwright or anywhere else, so nothing here does either. null for an invalid
  // expression (or a document without XPath), like an invalid CSS selector.
  const ORDERED_NODE_SNAPSHOT_TYPE = 7;
  function nodesByXPath(expr) {
    const d = curDoc();
    if (typeof d.evaluate !== 'function') return null;
    let r;
    try { r = d.evaluate(String(expr), d, null, ORDERED_NODE_SNAPSHOT_TYPE, null); } catch (e) { return null; }
    const out = [];
    for (let i = 0; i < r.snapshotLength; i++) {
      const n = r.snapshotItem(i);
      if (n && n.nodeType === 1) out.push(n);
    }
    return out;
  }

  function targetNodes(t) {
    if (!t) return null;
    if (!ctx) return withCaches(() => targetNodes(t));
    const key = JSON.stringify(t);
    if (ctx.nodes.has(key)) return ctx.nodes.get(key);
    const out = withoutOwnUi(resolveTargetNodes(t));
    ctx.nodes.set(key, out);
    return out;
  }
  // The extension's own overlay/tooltip (which displays locator text!) is not
  // part of the page a test will run against.
  function withoutOwnUi(nodes) {
    return nodes && nodes.length && ownUiRoots.size ? nodes.filter(n => !isOwnUi(n)) : nodes;
  }

  function resolveTargetNodes(t) {
    switch (t.kind) {
      // The attribute *name* is user-configured (custom test attributes) and may hold
      // CSS-special characters (data:qa) — escaped, or the selector is invalid.
      case 'testid': return nodesBySelector('[' + cssEscape(t.attr) + '="' + attrSelectorValue(t.value) + '"]');
      case 'id': return nodesBySelector('#' + cssEscape(String(t.value)));
      case 'name': return nodesBySelector('[name="' + attrSelectorValue(t.value) + '"]');
      case 'placeholder': return nodesByAttr('placeholder', t.value, t.exact);
      case 'altText': return nodesByAttr('alt', t.value, t.exact);
      case 'title': return nodesByAttr('title', t.value, t.exact);
      case 'css': return nodesBySelector(t.value);
      case 'xpath': return nodesByXPath(t.value);
      case 'text': return nodesByText(t.value, t.exact);
      case 'role': return applyNth(withoutOwnUi(nodesByRole(t)), t);
      case 'label': return nodesByLabel(t.value, t.exact);
      case 'chain': {
        const parents = targetNodes(t.parent);
        if (!parents || !t.child) return null;
        return nodesWithin(parents, t.child);
      }
      case 'frame': return nodesInFrame(t);
      default: return null;
    }
  }

  // `nth` (a role target's position, rendered by codegen as .nth(i)) picks one
  // element out of the full, ordered result — Playwright's `nth=` part. Nothing in
  // this engine produces it any more; it is still honoured because imported or
  // older saved targets can carry it.
  function hasNth(t) {
    return !!t && typeof t.nth === 'number' && t.nth >= 0 && Math.floor(t.nth) === t.nth;
  }
  function applyNth(nodes, t) {
    if (!nodes || !hasNth(t)) return nodes;
    return nodes.slice(t.nth, t.nth + 1);
  }
  function withoutNth(t) {
    if (!hasNth(t)) return t;
    const copy = Object.assign({}, t);
    delete copy.nth;
    return copy;
  }

  // The `child` part of a chain, evaluated inside each scope element the way
  // Playwright evaluates `parent >> child`: scope by scope, in the scopes' order,
  // each element once. Only descendants qualify (through shadow roots), except that
  // getByText's engine also tests the scope element itself. A trailing .nth(i) on
  // the child applies to the combined result, as it does in the generated code.
  function nodesWithin(scopes, child) {
    if (!child) return null;
    if (child.kind === 'chain') {
      const mids = nodesWithin(scopes, child.parent);
      return mids ? nodesWithin(mids, child.child) : null;
    }
    // A frame cannot be entered from inside a chain in any generated locator.
    if (child.kind === 'frame') return null;
    const candidates = targetNodes(withoutNth(child));
    if (!candidates) return null;
    const selfOk = child.kind === 'text';
    const out = [];
    const seen = new Set();
    for (const p of scopes) {
      for (const c of candidates) {
        if (seen.has(c) || (p === c && !selfOk) || !composedContains(p, c)) continue;
        seen.add(c);
        out.push(c);
      }
    }
    return applyNth(out, child);
  }

  // A frame target: find the <iframe> in this document (by `selector`, which —
  // like Playwright's frameLocator — pierces open shadow roots, or positionally as
  // `iframe >> nth=index` for a cross-origin frame), then resolve `child` inside
  // its document. `index` is the position among the document's <iframe> elements
  // in this pierce order — exactly what content.js's frameIndexOf() records, or,
  // behind a cross-origin parent, what that parent's childFrameIndex() answers — not
  // the position in window.frames (that one is `framesIndex`, for Selenium only,
  // and counts <frame>/<object> browsing contexts too). null when the frame
  // cannot be evaluated: several elements match
  // the selector (Playwright's strict mode throws), or its document is not
  // reachable from here (cross-origin) — the content script running inside that
  // frame has to resolve the inner target itself (see unwrapFrameTarget).
  function nodesInFrame(t) {
    let frames;
    if (t.selector) {
      frames = nodesBySelector(t.selector);
    } else {
      const all = nodesBySelector('iframe');
      const i = typeof t.index === 'number' && t.index >= 0 ? t.index : 0;
      frames = all ? all.slice(i, i + 1) : null;
    }
    if (!frames) return null;
    frames = withoutOwnUi(frames);
    if (!frames.length) return [];
    if (frames.length > 1 || !t.child) return null;
    let doc = null;
    try { doc = frames[0].contentDocument; } catch (e) { doc = null; }
    if (!doc) return null;
    return inDocument(doc, () => targetNodes(t.child));
  }

  // Public (C5): how many elements Playwright would resolve `target` to, or null when
  // it cannot be evaluated (unknown kind, invalid selector).
  function countTargetMatches(t) {
    if (!t) return null;
    try {
      const nodes = targetNodes(t);
      return nodes ? nodes.length : null;
    } catch (e) { return null; }
  }

  // ── Displayed code from a target ────────────────────────────────────────────
  // One source for every card's `code`, so it can never disagree with `target`.
  function codeFor(t) {
    const exactOpt = t.exact ? ', { exact: true }' : '';
    switch (t.kind) {
      case 'testid':
        // getByTestId() takes a plain string — no CSS-selector escaping needed, and
        // it's the locator Playwright actually recommends. Attributes without a
        // dedicated API fall back to a CSS attribute selector, which does need the
        // value escaped for the double-quoted selector (a value containing a `"`,
        // e.g. a testid embedding JSON, otherwise breaks the selector outright).
        return t.attr === 'data-testid'
          ? `page.getByTestId(${jsStr(t.value)})`
          : `page.locator(${jsStr('[' + cssEscape(t.attr) + '="' + attrSelectorValue(t.value) + '"]')})`;
      case 'role': {
        const o = [];
        if (t.name) {
          o.push('name: ' + jsStr(t.name));
          if (t.exact) o.push('exact: true');
        }
        if (t.level) o.push('level: ' + t.level);
        return `page.getByRole(${jsStr(t.role)}${o.length ? ', { ' + o.join(', ') + ' }' : ''})`;
      }
      case 'label': return `page.getByLabel(${jsStr(t.value)}${exactOpt})`;
      case 'placeholder': return `page.getByPlaceholder(${jsStr(t.value)}${exactOpt})`;
      case 'altText': return `page.getByAltText(${jsStr(t.value)}${exactOpt})`;
      case 'title': return `page.getByTitle(${jsStr(t.value)}${exactOpt})`;
      case 'text': return `page.getByText(${jsStr(t.value)}${exactOpt})`;
      case 'id': return `page.locator(${jsStr('#' + cssEscape(t.value))})`;
      case 'name': return `page.locator(${jsStr('[name="' + attrSelectorValue(t.value) + '"]')})`;
      case 'xpath': return `page.locator(${jsStr('xpath=' + t.value)})`;
      case 'chain': return `${codeFor(t.parent)}.${codeFor(t.child).replace(/^page\./, '')}`;
      case 'css': default: return `page.locator(${jsStr(t.value)})`;
    }
  }

  // Builds the two fields every locator card carries — the bare Playwright expression
  // and the actionable statement wrapping it.
  function withAction(code, el) {
    return { code, fullCode: `await ${code}.${suggestAction(el)};` };
  }

  // ── Find a unique parent for chaining ──────────────────────────────────────
  // Only an ancestor that is itself unique on the page is useful as a scope; one
  // that matches several elements just moves the ambiguity up a level.
  const ROLES_NOT_FOR_LOCATORS = new Set(['presentation', 'none', 'generic']);
  function findUniqueParent(el, attrs) {
    let parent = parentElementOrShadowHost(el);
    const d = el.ownerDocument || document;
    let tried = 0;
    while (parent && parent !== d.body && parent !== d.documentElement && tried < 8) {
      let target = null;
      for (const attr of attrs) {
        if (isOwnArtifactAttr(attr)) continue;
        const v = parent.getAttribute(attr);
        if (v) { target = { kind: 'testid', attr, value: v }; break; }
      }
      if (!target && usableId(parent.id)) target = { kind: 'id', value: parent.id };
      if (!target) {
        const r = getRole(parent);
        if (r && !ROLES_NOT_FOR_LOCATORS.has(r)) {
          const n = accessibleName(parent);
          if (n && n.length <= 80) target = { kind: 'role', role: r, name: n };
        }
      }
      if (target) {
        tried++;
        const nodes = targetNodes(target);
        if (nodes && nodes.length === 1 && nodes[0] === parent) return { el: parent, target };
      }
      parent = parentElementOrShadowHost(parent);
    }
    return null;
  }

  // Kinds whose default matching is a case-insensitive substring and which accept
  // { exact: true } (C5).
  const EXACTABLE = new Set(['role', 'text', 'label', 'placeholder', 'altText', 'title']);

  // ── Simple alternatives (C9.1) ─────────────────────────────────────────────
  // getByRole / getByLabel / getByText have no native equivalent outside
  // Playwright: Selenium, WebdriverIO, Java and C# would have to spell the whole
  // accessible-name computation out. When the best locator is one of those, the
  // result also carries `altTargets` — at most three plain targets (test id, id,
  // name, short CSS, short XPath; best first), each already measured to match this
  // element alone, for codegen to use where it cannot use the primary. They come
  // from the candidates generated above; only the XPath costs extra evaluations,
  // and none at all when the primary is itself one of the simple kinds.
  const SIMPLE_KINDS = new Set(['testid', 'id', 'name', 'css']);
  const ALT_MAX = 3;
  const ALT_CSS_MAX = 80;
  const ALT_XPATH_MAX = 120;
  const XHTML_NS = 'http://www.w3.org/1999/xhtml';

  // An XPath 1.0 string literal. XPath has no escapes: a value holding both quote
  // kinds is spelled as concat() of pieces split at the double quotes.
  function xpathLiteral(value) {
    const s = String(value);
    if (s.indexOf('"') === -1) return '"' + s + '"';
    if (s.indexOf("'") === -1) return "'" + s + "'";
    return 'concat(' + s.split('"').map(p => '"' + p + '"').join(', \'"\', ') + ')';
  }

  // XPath's normalize-space() collapses only space, tab, CR and LF, so a no-break
  // space (&nbsp; — everywhere in button text) is first turned into a space.
  const XPATH_NBSP_TEXT = 'normalize-space(translate(., "\u00a0", " "))';
  function xpathText(raw) {
    const nbsp = raw.indexOf('\u00a0') !== -1;
    const text = (nbsp ? raw.replace(/\u00a0/g, ' ') : raw).replace(/[ \t\r\n]+/g, ' ').trim();
    return { expr: nbsp ? XPATH_NBSP_TEXT : 'normalize-space(.)', text };
  }

  // A value an alternative may be built on: present, single-line, not generated.
  function stableValue(v) {
    return !!v && !!v.trim() && !/[\x00-\x1f\x7f]/.test(v) && !isUnstableId(v.trim()); // eslint-disable-line no-control-regex
  }

  // The element's own tag plus ONE stable attribute — or its own text — e.g.
  // //button[normalize-space(.)="Save"], //input[@placeholder="Email"]: the first
  // candidate (≤ 120 chars) that document.evaluate finds for this element alone.
  // Never a field's value (only a button's, which is its caption), never in shadow
  // DOM (XPath cannot reach it), never on an SVG/MathML element (namespaced names).
  // `skip` names attributes another alternative already uses.
  function altXPath(el, skip) {
    return cached('xpath', el, () => {
      const d = el.ownerDocument;
      if (typeof d.evaluate !== 'function' || el.getRootNode() !== d || el.namespaceURI !== XHTML_NS) return null;
      const tag = el.localName;
      if (!/^[a-z][a-z0-9-]*$/.test(tag)) return null;
      const T = tag.toUpperCase();
      const cands = [];
      const attr = (name, ok) => {
        const v = el.getAttribute(name);
        if (ok !== false && !skip.has(name) && stableValue(v)) cands.push(`//${tag}[@${name}=${xpathLiteral(v)}]`);
      };
      attr('aria-label');
      attr('placeholder');
      attr('alt', T === 'IMG' || T === 'AREA' || T === 'INPUT');
      attr('title');
      attr('name');
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (T === 'INPUT' && ['submit', 'button', 'reset'].includes(type)) {
        const v = el.getAttribute('value');
        if (stableValue(v)) cands.push(`//input[@type=${xpathLiteral(el.getAttribute('type'))}][@value=${xpathLiteral(v)}]`);
      }
      // <label for=x>Email</label> addresses the control without spelling out its
      // id — which is the point when the id is generated (a stable one is already
      // an alternative of its own). Evaluating it compares every <label> for every
      // control of that tag, so it is not tried when it would add nothing.
      if (el.id && isUnstableId(el.id) && LABELABLE.has(T)) {
        const lab = labelsFor(el).find(l => l.getAttribute('for') === el.id);
        const lt = lab ? xpathText(lab.textContent) : null;
        if (lt && stableValue(lt.text)) cands.push(`//${tag}[@id=//label[${lt.expr}=${xpathLiteral(lt.text)}]/@for]`);
      }
      // Own text. A field's text is its value (a <textarea>'s) or its options.
      if (!['INPUT', 'TEXTAREA', 'SELECT', 'OPTION'].includes(T)) {
        const own = xpathText(el.textContent || '');
        if (stableValue(own.text)) cands.push(`//${tag}[${own.expr}=${xpathLiteral(own.text)}]`);
      }
      for (const xp of cands) {
        if (xp.length > ALT_XPATH_MAX) continue;
        const nodes = withoutOwnUi(inDocument(d, () => nodesByXPath(xp)));
        if (nodes && nodes.length === 1 && nodes[0] === el) return xp;
      }
      return null;
    });
  }

  // `locators` measured and ranked; [] when the best one is already simple.
  function altTargetsFor(el, locators) {
    const primary = locators[0];
    if (!primary || !primary.target || SIMPLE_KINDS.has(primary.target.kind)) return [];
    const unique = (kind, ok) => {
      const l = locators.find(x => x.target && x.target.kind === kind && x.unique === true && (!ok || ok(x)));
      return l ? Object.assign({}, l.target) : null;
    };
    const shortCss = (x) => x.stability !== 'AVOID' && String(x.target.value).length <= ALT_CSS_MAX;
    const out = [
      unique('testid'),
      unique('id'),
      unique('name', x => !isUnstableId(x.target.value)),
      unique('css', x => shortCss(x) && !/:nth-/.test(x.target.value))
    ].filter(Boolean);
    // (Four simple ones never all exist: a unique test id is always the primary,
    // and the CSS card is dropped when it would just repeat the #id one.)
    const xp = altXPath(el, new Set(out.some(t => t.kind === 'name') ? ['name'] : []));
    if (xp) out.push({ kind: 'xpath', value: xp });
    // A positional CSS path only when nothing else exists.
    if (!out.length) {
      const nth = unique('css', shortCss);
      if (nth) out.push(nth);
    }
    return out.slice(0, ALT_MAX);
  }

  // ── Main locator generation engine ────────────────────────────────────────
  function generateLocators(el, customTestAttributes) {
    beginCaches();
    try {
      return generateLocatorsImpl(el, Array.isArray(customTestAttributes) ? customTestAttributes : []);
    } finally {
      endCaches();
    }
  }

  function generateLocatorsImpl(el, customTestAttributes) {
    const locators = [];
    const tag = el.tagName.toLowerCase();
    const role = getRole(el);
    const name = getAccessibleName(el);
    // `exactValue`: the value to use if the locator has to be made exact (null when
    // the shown value is a truncated prefix and so cannot be).
    const add = (spec) => {
      spec.rank = locators.length + 1;
      Object.assign(spec, withAction(codeFor(spec.target), el));
      locators.push(spec);
      return spec;
    };

    // 1. data-testid / data-qa / data-cy / data-test / custom
    for (const attr of customTestAttributes) {
      if (isOwnArtifactAttr(attr)) continue;
      const val = el.getAttribute(attr);
      if (val) {
        const isTestId = attr === 'data-testid';
        add({
          method: isTestId ? 'getByTestId()' : 'locator() / Custom attribute',
          matchedAttr: `${attr}="${val}"`,
          stability: 'BEST',
          target: { kind: 'testid', attr: attr, value: val },
          explanation: `Uses the <${attr}> attribute which is purpose-built for testing or custom configuration. This is highly stable.`,
          why: 'Stable / Custom test attribute'
        });
        break;
      }
    }

    // 2. getByRole
    if (role && name && !ROLES_NOT_FOR_LOCATORS.has(role)) {
      const level = role === 'heading' ? getHeadingLevel(el) : null;
      const short = snippet(name, 80);
      const extra = level ? ` at level ${level}` : '';
      add({
        method: 'getByRole()',
        matchedAttr: `role="${role}", name="${short.value}"${extra}`,
        stability: 'BEST',
        target: { kind: 'role', role: role, name: short.value, level: level || null },
        exactValue: short.truncated ? null : short.value,
        explanation: `Finds the element by its ARIA role "${role}" and accessible name "${short.value}". This is Playwright's most recommended locator — it tests your app the same way screen readers use it.`,
        why: 'Semantic ARIA role'
      });
    } else if (role && !name && !ROLES_NOT_FOR_LOCATORS.has(role)) {
      add({
        method: 'getByRole()',
        matchedAttr: `role="${role}" (no accessible name found)`,
        stability: 'OK',
        target: { kind: 'role', role: role },
        explanation: `Finds by role "${role}" but without a name filter — this may match multiple elements. Add an accessible name (aria-label, visible text) to make it unique.`,
        why: 'Role only — may be ambiguous'
      });
    }

    // 3. getByLabel — the same label sources getByLabel() itself matches
    // (aria-labelledby, aria-label, <label for>, wrapping <label>).
    const isFormControl = ['input', 'select', 'textarea'].includes(tag) && !(tag === 'input' && el.type === 'hidden');
    const labelRoles = ['textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton'];
    if (isFormControl || (role && labelRoles.includes(role) && (el.hasAttribute('aria-labelledby') || el.hasAttribute('aria-label')))) {
      const candidates = [];
      const lb = labelledByElements(el);
      if (!lb && !(el.getAttribute('aria-label') || '').trim()) {
        // A wrapping label also contains the control's own text (a <select>'s
        // options); try the label text without it first — it reads better and,
        // being a substring, still matches.
        for (const lab of labelsFor(el)) {
          const clone = lab.cloneNode(true);
          clone.querySelectorAll('input,select,textarea,button').forEach(e => e.remove());
          candidates.push(normalizeWS(clone.textContent));
        }
      }
      labelTexts(el).forEach(t => candidates.push(t.normalized));
      for (const text of candidates) {
        if (!text) continue;
        const short = snippet(text, 80);
        const target = { kind: 'label', value: short.value };
        const nodes = targetNodes(target);
        if (!nodes || !nodes.includes(el)) continue;
        add({
          method: 'getByLabel()',
          matchedAttr: `label text: "${short.value}"`,
          stability: 'BEST',
          target,
          exactValue: short.truncated ? null : short.value,
          explanation: `Finds the ${tag} element by its associated label "${short.value}". Ideal for form inputs — directly reflects what the user sees on screen.`,
          why: 'Associated label text'
        });
        break;
      }
    }

    // 4. getByPlaceholder
    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) {
      const ph = placeholder.trim();
      add({
        method: 'getByPlaceholder()',
        matchedAttr: `placeholder="${ph}"`,
        stability: 'GOOD',
        target: { kind: 'placeholder', value: ph },
        exactValue: placeholder,
        explanation: `Finds the input by its placeholder text "${ph}". Good when no label is present — but note placeholder text can change with copy updates.`,
        why: 'Placeholder attribute'
      });
    }

    // 5. getByAltText
    if (tag === 'img' || tag === 'area' || (tag === 'input' && el.type === 'image')) {
      const alt = el.getAttribute('alt');
      if (alt && alt.trim()) {
        const altText = alt.trim();
        add({
          method: 'getByAltText()',
          matchedAttr: `alt="${altText}"`,
          stability: 'GOOD',
          target: { kind: 'altText', value: altText },
          exactValue: alt,
          explanation: `Finds the image by its alt text "${altText}". The correct semantic approach for images — also important for accessibility.`,
          why: 'Alt text attribute'
        });
      }
    }

    // 6. getByTitle
    const titleAttr = el.getAttribute('title');
    if (titleAttr && titleAttr.trim()) {
      const titleText = titleAttr.trim();
      add({
        method: 'getByTitle()',
        matchedAttr: `title="${titleText}"`,
        stability: 'GOOD',
        target: { kind: 'title', value: titleText },
        exactValue: titleAttr,
        explanation: `Finds the element by its title attribute "${titleText}". Useful for icon buttons and tooltip elements without visible text.`,
        why: 'Title attribute'
      });
    }

    // 7. getByText — the text Playwright's text engine sees (textContent-based,
    // whitespace-normalised), not layout-dependent innerText, so the target
    // actually resolves to the element it was built from. Longer text uses a
    // word-bounded prefix, which only works as a substring (never exact).
    const visibleText = elementText(el).normalized;
    if (visibleText && visibleText.length <= 200 && !['input', 'select', 'textarea', 'img'].includes(tag)) {
      const short = snippet(visibleText, visibleText.length <= 80 ? 80 : 60);
      add({
        method: 'getByText()',
        matchedAttr: `visible text: "${short.value}"`,
        stability: 'GOOD',
        target: { kind: 'text', value: short.value },
        exactValue: short.truncated ? null : short.value,
        explanation: `Finds by visible text content "${short.value}". Best used for non-interactive elements like paragraphs and labels.`,
        why: 'Visible text content'
      });
    }

    // 8. locator() by stable ID
    if (usableId(el.id)) {
      add({
        method: "locator('#id')",
        matchedAttr: `id="${el.id}"`,
        stability: 'OK',
        target: { kind: 'id', value: el.id },
        explanation: `Uses the element's ID "${el.id}". Acceptable if the ID is hand-written and stable — avoid if IDs are auto-generated (e.g. "btn-47" or "input_1234").`,
        why: 'ID attribute'
      });
    }

    // 9. CSS attribute selectors (name, type combos)
    const name_attr = el.getAttribute('name');
    if (name_attr && ['input', 'select', 'textarea'].includes(tag)) {
      add({
        method: "locator('[name]')",
        matchedAttr: `name="${name_attr}"`,
        stability: 'OK',
        target: { kind: 'name', value: name_attr },
        explanation: `Uses the name attribute "${name_attr}". Moderately stable — name attributes are usually semantic but multiple elements can share the same name (e.g. radio groups).`,
        why: 'Name attribute'
      });
    }

    // ── Live uniqueness, with Playwright's matching semantics ────────────────
    // When the default (substring, case-insensitive) match is ambiguous but the
    // exact match is unique, switch the locator to { exact: true } (C5).
    const measure = (l) => {
      let nodes = null;
      try { nodes = targetNodes(l.target); } catch (e) { nodes = null; }
      if (nodes && nodes.length > 1 && EXACTABLE.has(l.target.kind) && l.exactValue != null && l.exactValue !== '') {
        const exactTarget = Object.assign({}, l.target, { exact: true });
        if (exactTarget.kind === 'role') exactTarget.name = l.exactValue;
        else exactTarget.value = l.exactValue;
        let exactNodes = null;
        try { exactNodes = targetNodes(exactTarget); } catch (e) {}
        if (exactNodes && exactNodes.length === 1 && exactNodes[0] === el) {
          l.target = exactTarget;
          Object.assign(l, withAction(codeFor(l.target), el));
          nodes = exactNodes;
        }
      }
      if (nodes) {
        l.matchCount = nodes.length;
        l.matchesElement = nodes.includes(el);
        l.unique = nodes.length === 1 && l.matchesElement;
      }
      delete l.exactValue;
    };
    locators.forEach(measure);

    // 10. Chained / Filtered Locator (The Pro Approach)
    //
    // The parent and child are recorded as a structured `chain` target, not as the
    // element's flat CSS path. They used to disagree: the card displayed the chained
    // Playwright expression while `target` held the bare child selector, so every
    // non-Playwright translation — and every recorded step whose best locator was
    // this one — silently dropped the parent scope and addressed the *first* matching
    // row instead of the one the user clicked.
    const childLoc = locators.find(l => l.matchesElement && l.target && l.target.kind !== 'id' && l.target.kind !== 'name');
    const uParent = childLoc ? findUniqueParent(el, customTestAttributes) : null;
    if (uParent && childLoc) {
      const pt = uParent.target;
      const pLabel = pt.kind === 'role' ? pt.name : pt.value;
      const l = add({
        method: 'Chained/Filtered',
        matchedAttr: `Parent: ${pLabel}`,
        stability: 'BEST',
        target: { kind: 'chain', parent: pt, child: childLoc.target },
        explanation: `Uses a unique parent (${pt.kind === 'role' ? pt.role : pLabel}) to narrow down the search. This is the pro approach for elements in lists, tables, or complex dashboards where name alone is ambiguous.`,
        why: 'Context-specific uniqueness'
      });
      measure(l);
    }

    // 11. CSS selector fallback (built to be unique; skipped when it would just
    // repeat another card's code, e.g. the #id card).
    const cssSelector = buildCSSSelector(el);
    const hasUnstable = hasUnstableClasses(el);
    const cssCode = codeFor({ kind: 'css', value: cssSelector });
    if (!locators.some(l => l.code === cssCode)) {
      const l = add({
        method: 'locator() CSS',
        matchedAttr: cssSelector,
        stability: hasUnstable ? 'AVOID' : 'OK',
        target: { kind: 'css', value: cssSelector },
        explanation: hasUnstable
          ? `This CSS selector contains auto-generated class names (like styled-components or MUI classes) that regenerate on every build. Using this WILL cause your tests to break regularly. Use a semantic locator instead.`
          : `CSS selector fallback. Use only when semantic locators are not available. Prefer IDs and data attributes over class-based selectors.`,
        why: 'CSS selector (fallback)'
      });
      measure(l);
    }

    // Mark what isn't unique, in words, on the card itself.
    locators.forEach(l => {
      if (typeof l.matchCount !== 'number') return;
      if (!l.matchesElement) {
        l.explanation += ' Note: on this page it does not resolve to the selected element (hidden from the accessibility tree, or the text belongs to a child) — do not use it as-is.';
      } else if (l.matchCount > 1) {
        l.ambiguous = true;
        l.explanation += ` Matches ${l.matchCount} elements on this page — not unique; Playwright's strict mode will reject it unless narrowed.`;
        if (l.target.kind === 'text' && l.matchCount > 2) l.stability = 'OK';
      }
    });

    // ── Ranking: unique first, then stability ────────────────────────────────
    // A BEST locator that matches two elements is worse than an OK one that
    // matches only this element: locators[0] is what the recorder writes into the
    // test, so it must never be ambiguous while a unique alternative exists.
    const stabilityWeight = { 'BEST': 4, 'GOOD': 3, 'OK': 2, 'AVOID': 1 };
    const group = (l) => {
      if (typeof l.matchCount !== 'number') return 1; // could not be evaluated
      if (l.unique) return 0;
      if (l.matchesElement) return 2;                   // ambiguous
      return 3;                                         // misses the element
    };
    locators.sort((a, b) => {
      const ga = group(a), gb = group(b);
      if (ga !== gb) return ga - gb;
      const wa = stabilityWeight[a.stability] || 0;
      const wb = stabilityWeight[b.stability] || 0;
      if (wa !== wb) return wb - wa;
      return a.rank - b.rank; // Keep relative discovery order within same stability
    });

    // Re-rank (The 1, 2, 3 sequence)
    locators.forEach((l, i) => { l.rank = i + 1; });

    // ── Build avoid list ───────────────────────────────────────────────────────
    const avoidList = [];
    if (hasUnstable) {
      const bad = el.className.trim().split(/\s+/).filter(c => !isOwnArtifactClass(c) && isUnstableClass(c)).slice(0, 3);
      avoidList.push({
        locator: `page.locator(${jsStr('.' + cssEscape(bad[0]))})`,
        reason: `"${bad[0]}" is an auto-generated class (styled-components / CSS-in-JS / CSS modules). It changes on every build and will break your tests.`
      });
    }
    if (el.id && isUnstableId(el.id)) {
      avoidList.push({
        locator: `page.locator(${jsStr('#' + cssEscape(el.id))})`,
        reason: `The ID "${el.id}" appears auto-generated (framework-generated or contains large numbers). It may change between page loads or deploys.`
      });
    }
    avoidList.push({
      locator: `page.locator('${tag}:nth-child(n)')`,
      reason: 'Position-based selectors break immediately when the UI is reordered or new elements are added.'
    });
    if (!el.getAttribute('data-testid') && !el.getAttribute('aria-label')) {
      avoidList.push({
        locator: 'XPath (//button[...])',
        reason: 'XPath is verbose and very fragile. It breaks when HTML structure changes. Use getByRole() or getByLabel() instead.'
      });
    }

    // ── Shadow DOM Detection ─────────────────────────────────────────────
    let isInShadow = false;
    let shadowHost = null;
    const root = el.getRootNode();
    if (root && root.nodeType === 11 && root.host) {
      isInShadow = true;
      shadowHost = root.host.tagName.toLowerCase();
      if (root.host.id) shadowHost += `#${root.host.id}`;
    }

    // ── Collect element metadata ───────────────────────────────────────────
    const elementData = {
      tag,
      type: el.getAttribute('type') || null,
      id: el.id || null,
      visibleText: visibleText.slice(0, 80) || null,
      ariaLabel: el.getAttribute('aria-label') || null,
      placeholder: placeholder || null,
      alt: el.getAttribute('alt') || null,
      testId: el.getAttribute('data-testid') || el.getAttribute('data-qa') || el.getAttribute('data-cy') || null,
      role: role || tag,
      title: titleAttr || null,
      name: name_attr || null,
      href: tag === 'a' ? el.getAttribute('href') : null,
      classes: typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(c => c && !isOwnArtifactClass(c)).slice(0, 6) : [],
      hasUnstableClasses: hasUnstable,
      isInShadow,
      shadowHost,
      suggestedAction: (function () {
        var ty = (el.getAttribute('type') || '').toLowerCase();
        if (tag === 'input') {
          if (ty === 'checkbox' || ty === 'radio') return 'check';
          if (ty === 'submit' || ty === 'button' || ty === 'reset') return 'click';
          return 'fill';
        }
        if (tag === 'select') return 'selectOption';
        if (tag === 'textarea') return 'fill';
        return 'click';
      })()
    };

    // ── Pro tip based on element ───────────────────────────────────────────
    let proTip = '';
    if (isInShadow) {
      proTip = `Found inside Shadow DOM (<${shadowHost}>). Playwright's getBy... locators pierce shadow roots automatically — no extra shadowRoot plumbing needed.`;
    } else if (!el.getAttribute('data-testid')) {
      proTip = `Ask your developers to add a <data-testid="${tag}-element"> attribute to this <${tag}>. It would make this the most stable locator possible and is a 5-second code change.`;
    } else if (role === 'button' || role === 'link') {
      proTip = `Great — this element has a data-testid. Use getByTestId() as primary and getByRole() as a backup assertion: expect(page.getByRole('${role}', { name: '...' })).toBeVisible()`;
    } else {
      // A tag name is not a role: getByRole('div') silently matches nothing, so an
      // element without one is asserted through its test id instead.
      const assertOn = role ? `page.getByRole(${jsStr(role)})` : `page.getByTestId(${jsStr(el.getAttribute('data-testid'))})`;
      proTip = `Combine your locator with an assertion: await expect(${assertOn}).toBeVisible() — Playwright auto-retries this until the element appears or times out.`;
    }

    const a11y = analyzeA11y(el);

    const result = { elementData, locators, avoidList, proTip, a11y };
    const altTargets = altTargetsFor(el, locators);
    if (altTargets.length) result.altTargets = altTargets;
    return result;
  }

  // ── Suggest a realistic Playwright action ─────────────────────────────────
  function suggestAction(el) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input') {
      if (type === 'checkbox' || type === 'radio') return 'check()';
      if (type === 'submit' || type === 'button') return 'click()';
      return "fill('your value')";
    }
    if (tag === 'select') return "selectOption('option text')";
    if (tag === 'textarea') return "fill('your text')";
    return 'click()';
  }

  // ── Resolving a target to elements (in-browser replay) ─────────────────────
  // The elements Playwright would resolve `target` to, in Playwright's order —
  // always an array (empty when nothing matches or the target cannot be evaluated:
  // unknown kind, invalid selector, cross-origin or ambiguous frame). Uses exactly
  // the matching behind countTargetMatches, so `resolveTarget(t).length` equals
  // `countTargetMatches(t)` whenever the count is not null.
  //   root  optional scope: a Document (e.g. a same-origin frame's) to resolve in,
  //         or an Element / ShadowRoot whose descendants the target is evaluated
  //         within, like `scope.locator(...)` (getByText also tests the scope itself),
  //         or an array of such scopes from one document — what a chained locator
  //         does with every match of its previous step, each result once, in
  //         scope order (the Selector Lab resolves pasted chains with this).
  // Frame targets ({kind:'frame', selector, index, child}) are entered when the
  // frame's document is reachable (same-origin); otherwise the content script that
  // runs *inside* that frame must resolve the inner target itself — see
  // unwrapFrameTarget().
  function isScope(n) {
    return !!n && (n.nodeType === 1 || n.nodeType === 9 || n.nodeType === 11);
  }
  function resolveTarget(target, root) {
    if (!target) return [];
    if (Array.isArray(root)) {
      const scopes = root.filter(n => isScope(n) && n.nodeType !== 9);
      if (!scopes.length) return [];
      try {
        const nodes = inDocument(scopes[0].ownerDocument, () => nodesWithin(scopes, target));
        return nodes ? nodes.slice() : [];
      } catch (e) {
        return [];
      }
    }
    const r = isScope(root) ? root : document;
    const doc = r.nodeType === 9 ? r : (r.ownerDocument || document);
    try {
      const nodes = inDocument(doc, () => (r.nodeType === 9 ? targetNodes(target) : nodesWithin([r], target)));
      return nodes ? nodes.slice() : [];
    } catch (e) {
      return [];
    }
  }

  // Splits a recorded target into the frames it lives in (outermost first, exactly
  // the {selector, index, framesIndex?, shadowPath?} segments content.js's frameChain() builds —
  // selector is null for a cross-origin frame) and the target inside the innermost
  // frame. A frame's content script owns a step when `framePath` equals its own
  // frame chain; the top document owns targets with an empty framePath. The inner
  // target is then resolved there with resolveTarget(inner).
  function unwrapFrameTarget(target) {
    const framePath = [];
    let t = target || null;
    while (t && t.kind === 'frame') {
      const seg = { selector: t.selector || null, index: typeof t.index === 'number' ? t.index : 0 };
      if (typeof t.framesIndex === 'number') seg.framesIndex = t.framesIndex;
      if (Array.isArray(t.shadowPath)) seg.shadowPath = t.shadowPath.slice();
      framePath.push(seg);
      t = t.child || null;
    }
    return { framePath, inner: t };
  }

  // ── Page Object member names ─────────────────────────────────────────────────
  // What an element is, for a Page Object: decides the helper methods codegen
  // emits (fill / select / check / click) and the suffix of its suggested name.
  function elementKind(el) {
    if (!el || el.nodeType !== 1) return 'other';
    const tag = tagOf(el);
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      return 'input';
    }
    if (tag === 'TEXTAREA') return 'textarea';
    if (tag === 'SELECT') return 'select';
    if (tag === 'BUTTON') return 'button';
    const role = getRole(el);
    if (role === 'checkbox' || role === 'switch' || role === 'menuitemcheckbox') return 'checkbox';
    if (role === 'radio' || role === 'menuitemradio') return 'radio';
    if (role === 'button') return 'button';
    if (role === 'link') return 'link';
    return 'other';
  }

  // Words an identifier may be built from: ASCII letters/digits after stripping
  // diacritics (Café → Cafe), split at camelCase humps as well.
  function nameWords(text) {
    const plain = String(text == null ? '' : text).normalize('NFD').replace(/[̀-ͯ]/g, '');
    const humps = plain.replace(/([a-z])([A-Z])|([0-9])([A-Z][a-z])/g, '$1$3 $2$4').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    return humps.match(/[A-Za-z0-9]+/g) || [];
  }
  // Reserved in JavaScript/TypeScript (incl. strict-mode and contextual words) or
  // Python, plus names that would shadow a member every Page Object has.
  const RESERVED_NAMES = new Set(('abstract any arguments as assert async await boolean break case catch class ' +
    'const constructor continue debugger declare def default del delete do elif else enum eval except export ' +
    'extends false finally for from function get global if implements import in instanceof interface is ' +
    'lambda let new nonlocal not null number object of or package pass private protected prototype public ' +
    'raise readonly return self set static string super switch symbol this throw true try type typeof ' +
    'undefined var void while with yield none driver page goto visit').split(' '));
  const KIND_SUFFIX = {
    input: ['Input', ['input', 'field', 'textbox']],
    textarea: ['Field', ['field', 'textarea', 'input']],
    select: ['Select', ['select', 'dropdown']],
    checkbox: ['Checkbox', ['checkbox']],
    radio: ['Radio', ['radio']],
    button: ['Button', ['button', 'btn']],
    link: ['Link', ['link']]
  };
  const ROLE_SUFFIX = {
    switch: ['Switch', ['switch', 'toggle']],
    tab: ['Tab', ['tab']],
    menuitem: ['MenuItem', ['menuitem', 'item']],
    option: ['Option', ['option']],
    slider: ['Slider', ['slider']],
    textbox: ['Input', ['input', 'field', 'textbox']],
    searchbox: ['Input', ['input', 'field', 'search']],
    combobox: ['Input', ['input', 'combobox']],
    heading: ['Heading', ['heading', 'title']]
  };
  const NAME_TEST_ATTRS = ['data-testid', 'data-test-id', 'data-qa', 'data-cy', 'data-test', 'data-automation-id', 'data-e2e'];

  // A lowerCamelCase identifier for `el` as a Page Object member: built from its
  // test id, accessible name, label, placeholder, id, name attribute or tag (the
  // first that yields letters), at most four words, plus a suffix for its kind —
  // "Email address" textbox → emailAddressInput, "Place order" button →
  // placeOrderButton. Never a reserved word; never starts with a digit.
  // `testAttributes` optionally replaces the test-id attributes consulted.
  function suggestName(el, testAttributes) {
    if (!el || el.nodeType !== 1) return 'element';
    return withCaches(() => {
      const kind = elementKind(el);
      const role = getRole(el);
      const suffix = KIND_SUFFIX[kind] || (role === 'switch' ? ROLE_SUFFIX.switch : ROLE_SUFFIX[role]) || null;
      const sources = [];
      const attrs = Array.isArray(testAttributes) && testAttributes.length ? testAttributes : NAME_TEST_ATTRS;
      for (const attr of attrs) {
        if (isOwnArtifactAttr(attr)) continue;
        const v = el.getAttribute(attr);
        if (v && !isUnstableId(v)) { sources.push(v); break; }
      }
      sources.push(getAccessibleName(el));
      try { labelTexts(el).forEach(t => sources.push(t.normalized)); } catch (e) {}
      sources.push(el.getAttribute('placeholder'));
      if (usableId(el.id)) sources.push(el.id);
      sources.push(el.getAttribute('name'));
      let words = [];
      for (const src of sources) {
        words = nameWords(src);
        if (words.length && suffix && suffix[1].includes(words[words.length - 1].toLowerCase())) words.pop();
        if (words.length) break;
      }
      words = words.slice(0, 4);
      if (!words.length) words = suffix ? [] : nameWords(el.tagName.toLowerCase()).slice(0, 4);
      if (suffix) words.push(suffix[0]);
      let id = words.map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join('');
      id = id.slice(0, 48);
      if (/^[0-9]/.test(id)) id = 'el' + id;
      if (!id) id = 'element';
      if (RESERVED_NAMES.has(id.toLowerCase())) id += 'Element';
      return id;
    });
  }

  global.__LocatorLensEngine = {
    generateLocators,
    getRole,
    // No per-call cache here: callers such as the Stress Test name thousands of
    // elements one by one, and building the page-wide label index for each would be
    // O(n²). Without a cache the native element.labels is used instead.
    getAccessibleName,
    buildCSSSelector,
    deepQueryAll,
    countTargetMatches: (t) => withCaches(() => countTargetMatches(t)),
    resolveTarget,
    // The Playwright expression for a target, as the cards show it (C9.1: the
    // xpath kind included).
    codeForTarget: (t) => (t && typeof t === 'object' ? codeFor(t) : ''),
    markOwnUi,
    unmarkOwnUi,
    ownUiRoots, // read by the next evaluation of this file (see above)
    unwrapFrameTarget,
    suggestName,
    elementKind,
    isOwnArtifactClass,
    isUnstableClass,
    isStateClass,
    isUnstableId
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
