// LocatorLens – content.js
// Injected into every page. Handles hover highlight + click capture + locator generation.

(function () {
  'use strict';
  if (window.__LocatorLensInjected) return;
  window.__LocatorLensInjected = true;

  // ── State ──────────────────────────────────────────────────────────────────
  let isInspecting = false;
  let hoveredEl = null;
  let overlay = null;
  let tooltip = null;
  let traversalBar = null;
  let lastRightClickedEl = null;

  // ── Deep-Tracing Engine (Shadow DOM X-Ray) ────────────────────────────────
  function getDeepElementAt(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const shadowEl = el.shadowRoot.elementFromPoint(x, y);
      if (!shadowEl || shadowEl === el) break;
      el = shadowEl;
    }
    return el;
  }

  // ── Track right-clicked element (always active for context menu) ───────────
  document.addEventListener('contextmenu', (e) => {
    lastRightClickedEl = getDeepElementAt(e.clientX, e.clientY);
  }, true);

  // ── Styles injected into the page ─────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('ll-styles')) return;
    const style = document.createElement('style');
    style.id = 'll-styles';
    style.textContent = `
      #ll-overlay {
        position: fixed !important;
        pointer-events: none !important;
        z-index: 2147483646 !important;
        border: 2px solid #3adffa !important;
        background: rgba(58, 223, 250, 0.08) !important;
        border-radius: 3px !important;
        border: 1px solid #3adffa !important;
        background: rgba(58, 223, 250, 0.05) !important;
        border-radius: 2px !important;
        transition: all 0.08s cubic-bezier(0.4, 0, 0.2, 1) !important;
        box-shadow: 0 0 0 1px rgba(58, 223, 250, 0.2), inset 0 0 15px rgba(58, 223, 250, 0.1) !important;
        animation: llBreathing 3s infinite linear !important;
      }
      @keyframes llBreathing {
        0% { opacity: 1; box-shadow: 0 0 4px rgba(58, 223, 250, 0.3), inset 0 0 10px rgba(58, 223, 250, 0.1); }
        50% { opacity: 0.8; box-shadow: 0 0 12px rgba(58, 223, 250, 0.5), inset 0 0 20px rgba(58, 223, 250, 0.2); }
        100% { opacity: 1; box-shadow: 0 0 4px rgba(58, 223, 250, 0.3), inset 0 0 10px rgba(58, 223, 250, 0.1); }
      }

      #ll-tooltip {
        position: fixed !important;
        z-index: 2147483647 !important;
        background: rgba(7, 13, 31, 0.85) !important;
        backdrop-filter: blur(10px) !important;
        -webkit-backdrop-filter: blur(10px) !important;
        border: 1px solid #3adffa !important;
        border-radius: 4px !important;
        padding: 8px 12px !important;
        font-family: 'Inter', system-ui, sans-serif !important;
        font-size: 11px !important;
        font-weight: 500 !important;
        color: #3adffa !important;
        pointer-events: none !important;
        max-width: 320px !important;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5) !important;
        line-height: 1.5 !important;
        white-space: nowrap !important;
      }
      #ll-tooltip .ll-tag { color: #82aaff; font-weight: 700; }
      #ll-tooltip .ll-hint { color: #a5aac2; font-size: 9px; margin-top: 3px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
      body.ll-inspecting * { cursor: crosshair !important; }

      /* ── Traversal Toolbar ── */
      #ll-traversal-bar {
        position: fixed !important;
        z-index: 2147483647 !important;
        display: flex !important;
        align-items: center !important;
        gap: 6px !important;
        background: rgba(7, 13, 31, 0.9) !important;
        backdrop-filter: blur(8px) !important;
        border: 1px solid #3adffa !important;
        border-radius: 4px !important;
        padding: 6px 10px !important;
        box-shadow: 0 4px 16px rgba(0,0,0,0.7) !important;
        font-family: 'Inter', system-ui, sans-serif !important;
        font-size: 11px !important;
        pointer-events: all !important;
        user-select: none !important;
      }
      #ll-traversal-bar .ll-trav-lbl {
        color: #a5aac2 !important;
        font-size: 9px !important;
        font-weight: 700 !important;
        letter-spacing: 0.1em !important;
        margin-right: 4px !important;
        text-transform: uppercase;
      }
      #ll-traversal-bar button {
        background: #1c253e !important;
        border: 1px solid rgba(65, 71, 91, 0.4) !important;
        color: #3adffa !important;
        font-size: 10px !important;
        font-weight: 700 !important;
        text-transform: uppercase !important;
        padding: 4px 10px !important;
        border-radius: 2px !important;
        cursor: pointer !important;
        transition: all 0.15s !important;
        pointer-events: all !important;
      }
      #ll-traversal-bar button:hover {
        background: #3adffa !important;
        color: #070d1f !important;
        border-color: #3adffa !important;
        box-shadow: 0 0 10px rgba(58, 223, 250, 0.5);
      }
      #ll-traversal-bar .ll-trav-hint {
        color: #a5aac2 !important;
        font-size: 8px !important;
        margin-left: 4px !important;
        opacity: 0.6;
      }

      /* ── Toast notification ── */
      #ll-toast {
        position: fixed !important;
        bottom: 24px !important;
        left: 50% !important;
        transform: translateX(-50%) translateY(0) !important;
        z-index: 2147483647 !important;
        background: rgba(7, 13, 31, 0.95) !important;
        backdrop-filter: blur(12px) !important;
        border: 1px solid #3adffa !important;
        border-radius: 4px !important;
        padding: 12px 20px !important;
        font-family: 'Inter', system-ui, sans-serif !important;
        font-size: 12px !important;
        font-weight: 600 !important;
        color: #3adffa !important;
        box-shadow: 0 12px 40px rgba(0,0,0,0.8), 0 0 0 1px rgba(58, 223, 250, 0.2) !important;
        display: flex !important;
        align-items: center !important;
        gap: 12px !important;
        pointer-events: none !important;
        white-space: nowrap !important;
        animation: llToastIn 0.3s cubic-bezier(0.34,1.56,0.64,1) both !important;
      }
      #ll-toast.ll-toast-out {
        animation: llToastOut 0.3s ease forwards !important;
      }
      #ll-toast .ll-toast-icon { font-size: 14px !important; text-shadow: 0 0 10px #3adffa; }
      #ll-toast .ll-toast-label { color: #a5aac2 !important; font-size: 10px !important; font-weight: 700 !important; margin-right: 2px !important; text-transform: uppercase; letter-spacing: 0.05em; }
      #ll-toast .ll-toast-code { color: #3adffa !important; max-width: 320px !important; overflow: hidden !important; text-overflow: ellipsis !important; font-family: 'Inter', system-ui, sans-serif !important; font-weight: 700; }
      @keyframes llToastIn {
        from { opacity: 0; transform: translateX(-50%) translateY(16px); }
        to   { opacity: 1; transform: translateX(-50%) translateY(0); }
      }
      @keyframes llToastOut {
        from { opacity: 1; transform: translateX(-50%) translateY(0); }
        to   { opacity: 0; transform: translateX(-50%) translateY(12px); }
      }
    `;
    document.head.appendChild(style);
  }

  // ── Overlay management ─────────────────────────────────────────────────────
  function createOverlay() {
    overlay = document.createElement('div');
    overlay.id = 'll-overlay';
    document.body.appendChild(overlay);

    tooltip = document.createElement('div');
    tooltip.id = 'll-tooltip';
    document.body.appendChild(tooltip);

    // ── Traversal Bar ──
    traversalBar = document.createElement('div');
    traversalBar.id = 'll-traversal-bar';
    traversalBar.innerHTML = `
      <span class="ll-trav-lbl">NAVIGATE</span>
      <button id="ll-trav-parent">▲ Parent</button>
      <button id="ll-trav-child">▼ Child</button>
      <span class="ll-trav-hint">↑↓ keys</span>
    `;
    document.body.appendChild(traversalBar);

    // Bind traversal button events
    document.getElementById('ll-trav-parent').addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      navigateParent();
    });
    document.getElementById('ll-trav-child').addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      navigateChild();
    });
  }

  function removeOverlay() {
    if (overlay) { overlay.remove(); overlay = null; }
    if (tooltip) { tooltip.remove(); tooltip = null; }
    if (traversalBar) { traversalBar.remove(); traversalBar = null; }
    
    // Final Flawless Audit: ensure toast is removed on exit
    const existing = document.getElementById('ll-toast');
    if (existing) existing.remove();
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  }

  function updateOverlay(el) {
    if (!overlay || !el) return;
    const r = el.getBoundingClientRect();
    overlay.style.cssText = `
      position: fixed !important;
      pointer-events: none !important;
      z-index: 2147483646 !important;
      border: 1px solid #3adffa !important;
      background: rgba(58, 223, 250, 0.05) !important;
      border-radius: 2px !important;
      box-shadow: 0 0 0 1px rgba(58, 223, 250, 0.2), inset 0 0 15px rgba(58, 223, 250, 0.1) !important;
      left: ${r.left}px !important;
      top: ${r.top}px !important;
      width: ${r.width}px !important;
      height: ${r.height}px !important;
    `;

    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/)[0] : '';

    tooltip.innerHTML = `
      <span class="ll-tag">&lt;${tag}${id || cls}&gt;</span>
      <div class="ll-hint">Click to analyze · ▲/▼ to navigate · Esc to stop</div>
    `;

    // Position tooltip: prefer below, fall back to above
    const TH = 52, TW = 300;
    let ty = r.bottom + 8;
    let tx = r.left;
    if (ty + TH > window.innerHeight) ty = r.top - TH - 8;
    if (tx + TW > window.innerWidth) tx = window.innerWidth - TW - 8;
    tx = Math.max(4, tx);
    ty = Math.max(4, ty);

    tooltip.style.cssText = `
      position: fixed !important;
      z-index: 2147483647 !important;
      background: rgba(7, 13, 31, 0.85) !important;
      backdrop-filter: blur(10px) !important;
      -webkit-backdrop-filter: blur(10px) !important;
      border: 1px solid #3adffa !important;
      border-radius: 8px !important;
      padding: 8px 12px !important;
      font-family: 'JetBrains Mono','Courier New',monospace !important;
      font-size: 12px !important;
      color: #3adffa !important;
      pointer-events: none !important;
      max-width: ${TW}px !important;
      box-shadow: 0 4px 20px rgba(0,0,0,0.6) !important;
      line-height: 1.5 !important;
      left: ${tx}px !important;
      top: ${ty}px !important;
    `;

    // Position traversal bar at bottom-right of overlay (or near viewport edge)
    if (traversalBar) {
      const BW = 200, BH = 32;
      let bx = r.right - BW;
      let by = r.bottom + 6;
      if (by + BH > window.innerHeight) by = r.top - BH - 6;
      if (bx < 4) bx = 4;
      if (bx + BW > window.innerWidth) bx = window.innerWidth - BW - 4;
      traversalBar.style.cssText = `
        position: fixed !important;
        z-index: 2147483647 !important;
        display: flex !important;
        align-items: center !important;
        gap: 4px !important;
        left: ${bx}px !important;
        top: ${by}px !important;
        pointer-events: all !important;
      `;
    }
  }

  // ── Traversal helpers ──────────────────────────────────────────────────────
  function navigateParent() {
    if (!hoveredEl) return;
    let parent = hoveredEl.parentElement;
    
    // 🧬 Shadow Boundary Jump: If no parent, check if we are in a shadow root
    if (!parent) {
      const root = hoveredEl.getRootNode();
      if (root instanceof ShadowRoot) parent = root.host;
    }

    if (parent && parent !== document.body && parent !== document.documentElement && parent.nodeType === Node.ELEMENT_NODE) {
      hoveredEl = parent;
      updateOverlay(hoveredEl);
    }
  }

  function navigateChild() {
    if (!hoveredEl) return;
    
    // 🧬 Shadow Infiltration: If host has shadow root, enter it
    let child = null;
    if (hoveredEl.shadowRoot) {
      child = Array.from(hoveredEl.shadowRoot.childNodes).find(n => n.nodeType === Node.ELEMENT_NODE);
    }
    
    if (!child) {
      child = Array.from(hoveredEl.childNodes).find(n => n.nodeType === Node.ELEMENT_NODE);
    }

    if (child) {
      hoveredEl = child;
      updateOverlay(hoveredEl);
    }
  }

  // ── Toast notification ─────────────────────────────────────────────────────
  let toastTimer = null;
  function showToast(locatorCode) {
    // Remove any existing toast immediately
    const existing = document.getElementById('ll-toast');
    if (existing) existing.remove();
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }

    const toast = document.createElement('div');
    toast.id = 'll-toast';
    toast.innerHTML = `
      <span class="ll-toast-icon">✅</span>
      <span><span class="ll-toast-label">Copied: </span><span class="ll-toast-code">${locatorCode}</span></span>
    `;
    document.body.appendChild(toast);

    // Auto-dismiss after 3s with fade-out
    toastTimer = setTimeout(() => {
      toast.classList.add('ll-toast-out');
      setTimeout(() => toast.remove(), 320);
    }, 3000);
  }

  // ── ARIA role lookup ───────────────────────────────────────────────────────
  const IMPLICIT_ROLES = {
    a: (el) => el.href ? 'link' : null,
    button: () => 'button',
    h1: () => 'heading', h2: () => 'heading', h3: () => 'heading',
    h4: () => 'heading', h5: () => 'heading', h6: () => 'heading',
    img: (el) => (el.alt !== undefined ? 'img' : null),
    input: (el) => {
      const t = (el.type || 'text').toLowerCase();
      const map = {
        text: 'textbox', email: 'textbox', password: 'textbox',
        search: 'searchbox', tel: 'textbox', url: 'textbox',
        number: 'spinbutton', checkbox: 'checkbox', radio: 'radio',
        submit: 'button', reset: 'button', button: 'button',
        range: 'slider',
      };
      return map[t] || null;
    },
    select: () => 'combobox',
    textarea: () => 'textbox',
    nav: () => 'navigation',
    main: () => 'main',
    table: () => 'table',
    tr: () => 'row',
    td: () => 'cell',
    th: () => 'columnheader',
    ul: () => 'list',
    ol: () => 'list',
    li: () => 'listitem',
    dialog: () => 'dialog',
    form: () => 'form',
    article: () => 'article',
    aside: () => 'complementary',
    header: () => 'banner',
    footer: () => 'contentinfo',
    section: () => 'region',
    menuitem: () => 'menuitem',
  };

  function getRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(' ')[0];
    const tag = el.tagName.toLowerCase();
    const fn = IMPLICIT_ROLES[tag];
    return fn ? fn(el) : null;
  }

  function getHeadingLevel(el) {
    const m = el.tagName.match(/^H([1-6])$/i);
    return m ? parseInt(m[1]) : null;
  }

  // ── Accessible name computation ────────────────────────────────────────────
  function getAccessibleName(el) {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const names = labelledBy.split(' ')
        .map(id => document.getElementById(id))
        .filter(Boolean)
        .map(e => e.textContent.trim())
        .filter(Boolean);
      if (names.length) return names.join(' ');
    }

    const tag = el.tagName.toLowerCase();
    if (['input', 'select', 'textarea'].includes(tag)) {
      if (el.id) {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label) return label.textContent.trim();
      }
      const parentLabel = el.closest('label');
      if (parentLabel) {
        const clone = parentLabel.cloneNode(true);
        clone.querySelectorAll('input,select,textarea').forEach(e => e.remove());
        const t = clone.textContent.trim();
        if (t) return t;
      }
    }

    const textRoles = ['button', 'link', 'heading', 'menuitem', 'tab', 'option'];
    const role = getRole(el);
    if (role && textRoles.includes(role)) {
      const t = (el.innerText || el.textContent || '').trim();
      if (t) return t.slice(0, 80);
    }

    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();

    if (tag === 'img') {
      const alt = el.getAttribute('alt');
      if (alt && alt.trim()) return alt.trim();
    }

    const ph = el.getAttribute('placeholder');
    if (ph && ph.trim()) return ph.trim();

    if (tag === 'input' && ['submit', 'button'].includes((el.type || '').toLowerCase())) {
      const v = el.value;
      if (v && v.trim()) return v.trim();
    }

    return null;
  }

  // ── Check if a string looks auto-generated / unstable ─────────────────────
  function isUnstableClass(cls) {
    return /^(sc-|css-|emotion-|makeStyles|jss\d|MuiButton-root-\d|[a-z]{2,4}-[a-zA-Z0-9]{6,}$)/.test(cls)
      || /[a-zA-Z0-9]{7,}/.test(cls) && /\d{3,}/.test(cls);
  }

  function hasUnstableClasses(el) {
    if (!el.className || typeof el.className !== 'string') return false;
    return el.className.trim().split(/\s+/).some(isUnstableClass);
  }

  function isUnstableId(id) {
    if (!id) return false;
    return /^\d+$/.test(id) || /[_-]\d{3,}$/.test(id) || /\d{5,}/.test(id);
  }

  // ── Build a reliable CSS selector fallback ─────────────────────────────────
  function buildCSSSelector(el) {
    const parts = [];
    let current = el;
    while (current && current !== document.body && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      if (current.id && !isUnstableId(current.id)) {
        return `#${current.id}`;
      }
      const stableClasses = current.className && typeof current.className === 'string'
        ? current.className.trim().split(/\s+/).filter(c => c && !isUnstableClass(c))
        : [];
      if (stableClasses.length) {
        part += '.' + stableClasses.slice(0, 2).join('.');
      }
      // Nth-child fallback
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter(c => c.tagName === current.tagName)
        : [];
      if (siblings.length > 1) {
        const idx = siblings.indexOf(current) + 1;
        part += `:nth-of-type(${idx})`;
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  // ── Find a unique parent for chaining ──────────────────────────────────────
  function findUniqueParent(el) {
    let parent = el.parentElement;
    while (parent && parent !== document.body) {
      const pTestId = parent.getAttribute('data-testid');
      const pId = (!isUnstableId(parent.id)) ? parent.id : null;
      const pRole = getRole(parent);
      const pName = getAccessibleName(parent);
      
      if (pTestId || pId || (pRole && pName)) {
        return { el: parent, testId: pTestId, id: pId, role: pRole, name: pName };
      }
      parent = parent.parentElement;
    }
    return null;
  }

  // ── Main locator generation engine ────────────────────────────────────────
  function generateLocators(el) {
    const locators = [];
    const tag = el.tagName.toLowerCase();
    const role = getRole(el);
    const name = getAccessibleName(el);

    // 1. data-testid / data-qa / data-cy / data-test
    const testAttrs = ['data-testid', 'data-qa', 'data-cy', 'data-test', 'data-automation-id', 'data-e2e'];
    for (const attr of testAttrs) {
      const val = el.getAttribute(attr);
      if (val) {
        const escaped = val.replace(/'/g, "\\'");
        locators.push({
          rank: 1,
          method: 'getByTestId()',
          matchedAttr: `${attr}="${val}"`,
          stability: 'BEST',
          code: `page.getByTestId('${escaped}')`,
          fullCode: `await page.getByTestId('${escaped}').${suggestAction(el)};`,
          explanation: `Uses the <${attr}> attribute which is purpose-built for testing. This is the most stable locator — it never changes with visual redesigns.`,
          why: 'Stable test attribute'
        });
        break;
      }
    }

    // 2. getByRole
    if (role && name) {
      const escaped = name.replace(/'/g, "\\'");
      let codeBase = `page.getByRole('${role}', { name: '${escaped}' })`;
      let extra = '';
      if (role === 'heading') {
        const level = getHeadingLevel(el);
        if (level) {
          codeBase = `page.getByRole('${role}', { name: '${escaped}', level: ${level} })`;
          extra = ` at level ${level}`;
        }
      }
      locators.push({
        rank: locators.length + 1,
        method: 'getByRole()',
        matchedAttr: `role="${role}", name="${name}"${extra}`,
        stability: locators.length === 0 ? 'BEST' : 'BEST',
        code: codeBase,
        fullCode: `await ${codeBase}.${suggestAction(el)};`,
        explanation: `Finds the element by its ARIA role "${role}" and accessible name "${name}". This is Playwright's most recommended locator — it tests your app the same way screen readers use it.`,
        why: 'Semantic ARIA role'
      });
    } else if (role && !name) {
      locators.push({
        rank: locators.length + 1,
        method: 'getByRole()',
        matchedAttr: `role="${role}" (no accessible name found)`,
        stability: 'OK',
        code: `page.getByRole('${role}')`,
        fullCode: `await page.getByRole('${role}').${suggestAction(el)};`,
        explanation: `Finds by role "${role}" but without a name filter — this may match multiple elements. Add an accessible name (aria-label, visible text) to make it unique.`,
        why: 'Role only — may be ambiguous'
      });
    }

    // 3. getByLabel
    if (['input', 'select', 'textarea'].includes(tag)) {
      let labelText = null;
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) labelText = lbl.textContent.trim();
      }
      if (!labelText) {
        const pLabel = el.closest('label');
        if (pLabel) {
          const clone = pLabel.cloneNode(true);
          clone.querySelectorAll('input,select,textarea').forEach(e => e.remove());
          labelText = clone.textContent.trim() || null;
        }
      }
      if (!labelText) labelText = el.getAttribute('aria-label') || null;
      if (labelText) {
        const escaped = labelText.replace(/'/g, "\\'");
        locators.push({
          rank: locators.length + 1,
          method: 'getByLabel()',
          matchedAttr: `label text: "${labelText}"`,
          stability: 'BEST',
          code: `page.getByLabel('${escaped}')`,
          fullCode: `await page.getByLabel('${escaped}').${suggestAction(el)};`,
          explanation: `Finds the ${tag} element by its associated label "${labelText}". Ideal for form inputs — directly reflects what the user sees on screen.`,
          why: 'Associated label text'
        });
      }
    }

    // 4. getByPlaceholder
    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) {
      const escaped = placeholder.trim().replace(/'/g, "\\'");
      locators.push({
        rank: locators.length + 1,
        method: 'getByPlaceholder()',
        matchedAttr: `placeholder="${placeholder.trim()}"`,
        stability: 'GOOD',
        code: `page.getByPlaceholder('${escaped}')`,
        fullCode: `await page.getByPlaceholder('${escaped}').${suggestAction(el)};`,
        explanation: `Finds the input by its placeholder text "${placeholder.trim()}". Good when no label is present — but note placeholder text can change with copy updates.`,
        why: 'Placeholder attribute'
      });
    }

    // 5. getByAltText
    if (tag === 'img') {
      const alt = el.getAttribute('alt');
      if (alt && alt.trim()) {
        const escaped = alt.trim().replace(/'/g, "\\'");
        locators.push({
          rank: locators.length + 1,
          method: 'getByAltText()',
          matchedAttr: `alt="${alt.trim()}"`,
          stability: 'GOOD',
          code: `page.getByAltText('${escaped}')`,
          fullCode: `await page.getByAltText('${escaped}').${suggestAction(el)};`,
          explanation: `Finds the image by its alt text "${alt.trim()}". The correct semantic approach for images — also important for accessibility.`,
          why: 'Alt text attribute'
        });
      }
    }

    // 6. getByTitle
    const titleAttr = el.getAttribute('title');
    if (titleAttr && titleAttr.trim()) {
      const escaped = titleAttr.trim().replace(/'/g, "\\'");
      locators.push({
        rank: locators.length + 1,
        method: 'getByTitle()',
        matchedAttr: `title="${titleAttr.trim()}"`,
        stability: 'GOOD',
        code: `page.getByTitle('${escaped}')`,
        fullCode: `await page.getByTitle('${escaped}').${suggestAction(el)};`,
        explanation: `Finds the element by its title attribute "${titleAttr.trim()}". Useful for icon buttons and tooltip elements without visible text.`,
        why: 'Title attribute'
      });
    }

    // 7. getByText
    const visibleText = (el.innerText || el.textContent || '').trim();
    if (visibleText && visibleText.length <= 100 && !['input', 'select', 'textarea', 'img'].includes(tag)) {
      const escaped = visibleText.replace(/'/g, "\\'");
      const allMatchingText = document.querySelectorAll('*');
      let textMatchCount = 0;
      for (const node of allMatchingText) {
        if ((node.innerText || node.textContent || '').trim() === visibleText) textMatchCount++;
        if (textMatchCount > 3) break;
      }
      const stability = textMatchCount > 2 ? 'OK' : 'GOOD';
      const warning = textMatchCount > 2 ? ' Warning: this text may match multiple elements — consider using getByRole() instead.' : '';
      locators.push({
        rank: locators.length + 1,
        method: 'getByText()',
        matchedAttr: `visible text: "${visibleText.slice(0, 60)}"`,
        stability,
        code: `page.getByText('${escaped.slice(0, 60)}')`,
        fullCode: `await page.getByText('${escaped.slice(0, 60)}').${suggestAction(el)};`,
        explanation: `Finds by visible text content "${visibleText.slice(0, 60)}".${warning} Best used for non-interactive elements like paragraphs and labels.`,
        why: 'Visible text content'
      });
    }

    // 8. locator() by stable ID
    if (el.id && !isUnstableId(el.id)) {
      const escaped = el.id.replace(/'/g, "\\'");
      locators.push({
        rank: locators.length + 1,
        method: "locator('#id')",
        matchedAttr: `id="${el.id}"`,
        stability: 'OK',
        code: `page.locator('#${escaped}')`,
        fullCode: `await page.locator('#${escaped}').${suggestAction(el)};`,
        explanation: `Uses the element's ID "${el.id}". Acceptable if the ID is hand-written and stable — avoid if IDs are auto-generated (e.g. "btn-47" or "input_1234").`,
        why: 'ID attribute'
      });
    }

    // 9. CSS attribute selectors (name, type combos)
    const name_attr = el.getAttribute('name');
    if (name_attr && ['input', 'select', 'textarea'].includes(tag)) {
      const escaped = name_attr.replace(/'/g, "\\'");
      locators.push({
        rank: locators.length + 1,
        method: "locator('[name]')",
        matchedAttr: `name="${name_attr}"`,
        stability: 'OK',
        code: `page.locator('[name="${escaped}"]')`,
        fullCode: `await page.locator('[name="${escaped}"]').${suggestAction(el)};`,
        explanation: `Uses the name attribute "${name_attr}". Moderately stable — name attributes are usually semantic but multiple elements can share the same name (e.g. radio groups).`,
        why: 'Name attribute'
      });
    }

    // 10. Chained / Filtered Locator (The Pro Approach)
    const uParent = findUniqueParent(el);
    if (uParent && locators.length > 0) {
      let pCode = '';
      if (uParent.testId) pCode = `page.getByTestId('${uParent.testId}')`;
      else if (uParent.id) pCode = `page.locator('#${uParent.id}')`;
      else if (uParent.role && uParent.name) pCode = `page.getByRole('${uParent.role}', { name: '${uParent.name.replace(/'/g, "\\'")}' })`;

      if (pCode) {
        const bestChild = locators[0].code.replace('page.', '');
        locators.push({
          rank: locators.length + 1,
          method: 'Chained/Filtered',
          matchedAttr: `Parent: ${uParent.testId || uParent.id || uParent.name}`,
          stability: 'BEST',
          code: `${pCode}.${bestChild}`,
          fullCode: `await ${pCode}.${bestChild}.${suggestAction(el)};`,
          explanation: `Uses a unique parent (${uParent.id || uParent.role}) to narrow down the search. This is the pro approach for elements in lists, tables, or complex dashboards where name alone is ambiguous.`,
          why: 'Context-specific uniqueness'
        });
      }
    }

    // 11. Iframe Detection
    const inIframe = window.self !== window.top;
    if (inIframe) {
      locators.unshift({
        rank: 0,
        method: 'Frame Switch',
        matchedAttr: 'Inside Iframe',
        stability: 'GOOD',
        code: `page.frameLocator('iframe-selector')`,
        fullCode: `await page.frameLocator('iframe').${locators[0] ? locators[0].code.replace('page.', '') : 'locator(...)'};`,
        explanation: `Element is inside an Iframe. You must use frameLocator() to switch context before interacting. Replace 'iframe-selector' with the actual iframe ID or src.`,
        why: 'Cross-document isolation'
      });
    }

    // 10. CSS selector fallback
    const cssSelector = buildCSSSelector(el);
    const hasUnstable = hasUnstableClasses(el);
    locators.push({
      rank: locators.length + 1,
      method: 'locator() CSS',
      matchedAttr: cssSelector,
      stability: hasUnstable ? 'AVOID' : 'OK',
      code: `page.locator('${cssSelector.replace(/'/g, "\\'")}')`,
      fullCode: `await page.locator('${cssSelector.replace(/'/g, "\\'")}').${suggestAction(el)};`,
      explanation: hasUnstable
        ? `This CSS selector contains auto-generated class names (like styled-components or MUI classes) that regenerate on every build. Using this WILL cause your tests to break regularly. Use a semantic locator instead.`
        : `CSS selector fallback. Use only when semantic locators are not available. Prefer IDs and data attributes over class-based selectors.`,
      why: 'CSS selector (fallback)'
    });

    // ── Stability-First Sorting ──────────────────────────────────────────────
    const stabilityWeight = { 'BEST': 4, 'GOOD': 3, 'OK': 2, 'AVOID': 1 };
    
    locators.sort((a, b) => {
      const wa = stabilityWeight[a.stability] || 0;
      const wb = stabilityWeight[b.stability] || 0;
      if (wa !== wb) return wb - wa;
      return a.rank - b.rank; // Keep relative discovery order within same stability
    });

    // Re-rank (The 1, 2, 3 sequence)
    locators.forEach((l, i) => { l.rank = i + 1; });

    // ── Build avoid list ───────────────────────────────────────────────────────
    const avoidList = [];
    if (hasUnstableClasses(el)) {
      const bad = el.className.trim().split(/\s+/).filter(isUnstableClass).slice(0, 3);
      avoidList.push({
        locator: `page.locator('.${bad[0]}')`,
        reason: `"${bad[0]}" is an auto-generated class (styled-components / CSS-in-JS). It changes on every build and will break your tests.`
      });
    }
    if (el.id && isUnstableId(el.id)) {
      avoidList.push({
        locator: `page.locator('#${el.id}')`,
        reason: `The ID "${el.id}" appears auto-generated (contains large numbers). It may change between page loads or deploys.`
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
    if (root instanceof ShadowRoot) {
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
      classes: typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 6) : [],
      hasUnstableClasses: hasUnstable,
      isInShadow,
      shadowHost
    };

    // ── Pro tip based on element ───────────────────────────────────────────
    let proTip = '';
    if (isInShadow) {
      proTip = `Found inside Shadow DOM (<${shadowHost}>). Playwright's getBy... locators pierce Shadow DOM automatically! For Selenium, you'll need driver.execute_script('return arguments[0].shadowRoot', host).`;
    } else if (!el.getAttribute('data-testid')) {
      proTip = `Ask your developers to add a <data-testid="${tag}-element"> attribute to this <${tag}>. It would make this the most stable locator possible and is a 5-second code change.`;
    } else if (role === 'button' || role === 'link') {
      proTip = `Great — this element has a data-testid. Use getByTestId() as primary and getByRole() as a backup assertion: expect(page.getByRole('${role}', { name: '...' })).toBeVisible()`;
    } else {
      proTip = `Combine your locator with an assertion: await expect(page.getByRole('${role || tag}')).toBeVisible() — Playwright auto-retries this until the element appears or times out.`;
    }

    return { elementData, locators, avoidList, proTip };
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

  // ── Event handlers ─────────────────────────────────────────────────────────
  function onMouseOver(e) {
    if (!isInspecting) return;
    const el = getDeepElementAt(e.clientX, e.clientY);
    if (!el) return;
    
    // Ignore our own UI elements
    if (el === overlay || el === tooltip || el === traversalBar ||
      (traversalBar && traversalBar.contains(el))) return;
      
    hoveredEl = el;
    updateOverlay(el);
  }

  function onClick(e) {
    if (!isInspecting) return;
    // Let traversal bar button clicks go through (they have their own handlers)
    if (traversalBar && traversalBar.contains(e.target)) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const el = getDeepElementAt(e.clientX, e.clientY);
    if (!el || el === overlay || el === tooltip) return;

    const result = generateLocators(el);

    // Get current framework preference for the toast
    chrome.storage.local.get('framework', (res) => {
      const fw = res.framework || 'playwright';
      let bestCode = result.locators[0] ? result.locators[0].code : '';

      // Simple toast translation
      if (fw === 'selenium' && result.locators[0]) {
        const loc = result.locators[0];
        if (loc.method.includes('TestId')) bestCode = `driver.find_element(By.CSS_SELECTOR, "[data-testid='${loc.matchedAttr.split('"')[1]}']")`;
        else if (loc.id) bestCode = `driver.find_element(By.ID, "${el.id}")`;
        else bestCode = `driver.find_element(By.CSS_SELECTOR, "${bestCode.replace("page.locator('", "").replace("')", "")}")`;
      } else if (fw === 'cypress' && result.locators[0]) {
        const loc = result.locators[0];
        if (loc.method.includes('TestId')) bestCode = `cy.get('[data-testid="${loc.matchedAttr.split('"')[1]}"]')`;
        else if (loc.id) bestCode = `cy.get('#${el.id}')`;
        else bestCode = `cy.get('${bestCode.replace("page.locator('", "").replace("')", "")}')`;
      }

      if (bestCode) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(bestCode).then(() => {
            showToast(bestCode);
          }).catch(() => {
            showToast(bestCode);
          });
        } else {
          showToast(bestCode);
        }
      }
    });

    // Flash the overlay green
    if (overlay) {
      overlay.style.background = 'rgba(58, 223, 250, 0.25)';
      setTimeout(() => {
        if (overlay) overlay.style.background = 'rgba(58, 223, 250, 0.05)';
      }, 300);
    }

    // Send to extension with context-invalidation safety
    try {
      if (chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage({ type: 'ELEMENT_PICKED', data: result });
      }
    } catch (err) {
      if (err.message.includes('context invalidated')) {
        console.warn('[LocatorLens] Extension context invalidated. Please refresh the page.');
        stopInspect(); // Cleanly remove UI
      }
    }
  }

  function onKeyDown(e) {
    if (!isInspecting) return;

    if (e.key === 'Escape') {
      stopInspect();
      chrome.runtime.sendMessage({ type: 'STOP_INSPECT' });
      return;
    }

    // Parent / Child traversal keyboard shortcuts
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      navigateParent();
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      navigateChild();
    }
  }

  // ── Start / Stop ───────────────────────────────────────────────────────────
  function startInspect() {
    if (isInspecting) return;
    isInspecting = true;
    injectStyles();
    createOverlay();
    document.body.classList.add('ll-inspecting');
    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
  }

  function stopInspect() {
    isInspecting = false;
    document.body.classList.remove('ll-inspecting');
    
    // Total Decommission: Remove all tracking listeners
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    
    removeOverlay();
    hoveredEl = null;
    lastRightClickedEl = null;
    
    console.log('[LocatorLens] Inspection Deactivated.');
  }

  // ── Message listener ───────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'START_INSPECT') startInspect();
    if (msg.type === 'STOP_INSPECT') stopInspect();

    // Handle context menu quick-copy
    if (msg.type === 'CONTEXT_MENU_COPY') {
      const target = lastRightClickedEl || document.body;
      const result = generateLocators(target);

      chrome.storage.local.get('framework', (res) => {
        const fw = res.framework || 'playwright';
        let bestCode = result.locators[0] ? result.locators[0].code : '';

        // Context Menu Framework Translation
        if (fw === 'selenium' && result.locators[0]) {
          const loc = result.locators[0];
          if (loc.method.includes('TestId')) bestCode = `driver.find_element(By.CSS_SELECTOR, "[data-testid='${loc.matchedAttr.split('"')[1]}']")`;
          else if (loc.id) bestCode = `driver.find_element(By.ID, "${target.id}")`;
          else bestCode = `driver.find_element(By.CSS_SELECTOR, "${bestCode.replace("page.locator('", "").replace("')", "")}")`;
        } else if (fw === 'cypress' && result.locators[0]) {
          const loc = result.locators[0];
          if (loc.method.includes('TestId')) bestCode = `cy.get('[data-testid="${loc.matchedAttr.split('"')[1]}"]')`;
          else if (loc.id) bestCode = `cy.get('#${target.id}')`;
          else bestCode = `cy.get('${bestCode.replace("page.locator('", "").replace("')", "")}')`;
        }

        if (bestCode) {
          navigator.clipboard.writeText(bestCode).then(() => {
            // Visual confirmation: briefly flash the element
            const origOutline = target.style.outline;
            const origTransition = target.style.transition;
            target.style.transition = 'outline 0.1s';
            target.style.outline = '3px solid #00ff9d';
            setTimeout(() => {
              target.style.outline = origOutline;
              target.style.transition = origTransition;
            }, 800);
          }).catch(() => { });
        }

        // ONLY update the extension UI if we are actually in Inspect Mode
        if (isInspecting) {
          try {
            if (chrome.runtime && chrome.runtime.id) {
              chrome.runtime.sendMessage({ type: 'ELEMENT_PICKED', data: result });
            }
          } catch (e) { }
        }
      });
      
      sendResponse({ ok: true });
      return true;
    }
  });

})();
