// LocatorLens – content-locator-engine.js
// Playwright-oriented locator ranking (loaded before content.js).
(function (global) {
  'use strict';

  // Escape a string for use as a CSS identifier. Every browser we target has
  // CSS.escape; the fallback exists so the engine can also be exercised in a
  // headless DOM that doesn't implement it.
  function cssEscape(value) {
    const s = String(value == null ? '' : value);
    if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') return CSS.escape(s);
    return s.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1').replace(/^(\d)/, '\\3$1 ');
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
        const label = document.querySelector(`label[for="${cssEscape(el.id)}"]`);
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

  // ── A11y Audit Engine ──────────────────────────────────────────────────────
  function analyzeA11y(el) {
    const issues = [];
    const tag = el.tagName.toLowerCase();
    const role = getRole(el);
    const name = getAccessibleName(el);

    // 1. Missing Alt Text
    if (tag === 'img' && !el.getAttribute('alt')) {
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
      const implicit = IMPLICIT_ROLES[tag] ? IMPLICIT_ROLES[tag](el) : null;
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
        // CSS.escape: ids legally contain ':' '.' '[' etc. (Tailwind, Rails, Angular
        // all emit them). Unescaped, the returned string is an invalid selector that
        // throws in querySelectorAll and produces uncompilable generated code.
        return `#${cssEscape(current.id)}`;
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

  // ── Live uniqueness: how many elements does a locator actually match? ───────
  // Counts are capped at 10 (we only care about unique vs ambiguous) for speed.
  const UNIQ_CAP = 10;
  // Hard ceiling on nodes examined per count. generateLocators() runs on every pick
  // AND on every captured click while recording, and each candidate locator triggers
  // its own count — so an uncapped walk that reads innerText (which forces a layout
  // flush per node) turned a click on a large page into a visible freeze.
  const SCAN_CAP = 4000;

  function attrSelectorValue(v) {
    return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }
  function countBySelector(sel) {
    try { return Math.min(document.querySelectorAll(sel).length, UNIQ_CAP); } catch (e) { return null; }
  }
  // textContent, not innerText: innerText is layout-dependent and forces a reflow on
  // every node touched. For "does this text match exactly one element" the difference
  // is whitespace normalisation, which we do ourselves.
  function normText(node) {
    return (node.textContent || '').trim();
  }
  function countByText(text) {
    let count = 0;
    const all = document.querySelectorAll('*');
    const limit = Math.min(all.length, SCAN_CAP);
    for (let i = 0; i < limit; i++) {
      const node = all[i];
      if (normText(node) !== text) continue;
      // innermost only (mirrors Playwright getByText) — skip if a child holds the same text
      let childHas = false;
      for (let c = 0; c < node.children.length; c++) {
        if (normText(node.children[c]) === text) { childHas = true; break; }
      }
      if (!childHas && ++count >= UNIQ_CAP) break;
    }
    return count;
  }
  function countByRole(role, name) {
    let count = 0;
    const all = document.querySelectorAll('*');
    const limit = Math.min(all.length, SCAN_CAP);
    for (let i = 0; i < limit; i++) {
      if (getRole(all[i]) !== role) continue;
      if (name && getAccessibleName(all[i]) !== name) continue;
      if (++count >= UNIQ_CAP) break;
    }
    return count;
  }
  function countByLabel(labelText) {
    let count = 0;
    const controls = document.querySelectorAll('input, select, textarea');
    for (let i = 0; i < controls.length; i++) {
      if (getAccessibleName(controls[i]) === labelText && ++count >= UNIQ_CAP) break;
    }
    return count;
  }
  function countTargetMatches(t) {
    if (!t) return null;
    try {
      switch (t.kind) {
        case 'testid': return countBySelector('[' + t.attr + '="' + attrSelectorValue(t.value) + '"]');
        case 'id': return countBySelector('#' + cssEscape(String(t.value)));
        case 'name': return countBySelector('[name="' + attrSelectorValue(t.value) + '"]');
        case 'placeholder': return countBySelector('[placeholder="' + attrSelectorValue(t.value) + '"]');
        case 'altText': return countBySelector('img[alt="' + attrSelectorValue(t.value) + '"]');
        case 'title': return countBySelector('[title="' + attrSelectorValue(t.value) + '"]');
        case 'css': return countBySelector(t.value);
        case 'text': return countByText(t.value);
        case 'role': return countByRole(t.role, t.name);
        case 'label': return countByLabel(t.value);
        default: return null;
      }
    } catch (e) { return null; }
  }

  // ── Main locator generation engine ────────────────────────────────────────
  function generateLocators(el, customTestAttributes) {
    const locators = [];
    const tag = el.tagName.toLowerCase();
    const role = getRole(el);
    const name = getAccessibleName(el);

    // 1. data-testid / data-qa / data-cy / data-test / custom
    for (const attr of customTestAttributes) {
      const val = el.getAttribute(attr);
      if (val) {
        const escaped = val.replace(/'/g, "\\'");
        locators.push({
          rank: 1,
          method: 'getByTestId() / Custom',
          matchedAttr: `${attr}="${val}"`,
          stability: 'BEST',
          target: { kind: 'testid', attr: attr, value: val },
          code: `page.locator('[${attr}="${escaped}"]')`,
          fullCode: `await page.locator('[${attr}="${escaped}"]').${suggestAction(el)};`,
          explanation: `Uses the <${attr}> attribute which is purpose-built for testing or custom configuration. This is highly stable.`,
          why: 'Stable / Custom test attribute'
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
        stability: 'BEST',
        target: { kind: 'role', role: role, name: name, level: (role === 'heading' ? getHeadingLevel(el) : null) },
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
        target: { kind: 'role', role: role },
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
        const lbl = document.querySelector(`label[for="${cssEscape(el.id)}"]`);
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
          target: { kind: 'label', value: labelText },
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
        target: { kind: 'placeholder', value: placeholder.trim() },
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
          target: { kind: 'altText', value: alt.trim() },
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
        target: { kind: 'title', value: titleAttr.trim() },
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
      // Bounded, layout-free ambiguity probe. Reading innerText here walked the whole
      // document flushing layout per node whenever the text was in fact unique.
      const allMatchingText = document.querySelectorAll('*');
      const textScanLimit = Math.min(allMatchingText.length, SCAN_CAP);
      let textMatchCount = 0;
      for (let i = 0; i < textScanLimit; i++) {
        if (normText(allMatchingText[i]) === visibleText) textMatchCount++;
        if (textMatchCount > 3) break;
      }
      const stability = textMatchCount > 2 ? 'OK' : 'GOOD';
      const warning = textMatchCount > 2 ? ' Warning: this text may match multiple elements — consider using getByRole() instead.' : '';
      locators.push({
        rank: locators.length + 1,
        method: 'getByText()',
        matchedAttr: `visible text: "${visibleText.slice(0, 60)}"`,
        stability,
        target: { kind: 'text', value: visibleText.slice(0, 60) },
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
        target: { kind: 'id', value: el.id },
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
        target: { kind: 'name', value: name_attr },
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
      if (uParent.testId) {
        const tid = String(uParent.testId).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        pCode = `page.getByTestId('${tid}')`;
      } else if (uParent.id) {
        const escId = String(uParent.id).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        pCode = `page.locator('#${escId}')`;
      }
      else if (uParent.role && uParent.name) pCode = `page.getByRole('${uParent.role}', { name: '${uParent.name.replace(/'/g, "\\'")}' })`;

      if (pCode) {
        const bestChild = locators[0].code.replace('page.', '');
        const action = suggestAction(el);
        locators.push({
          rank: locators.length + 1,
          method: 'Chained/Filtered',
          matchedAttr: `Parent: ${uParent.testId || uParent.id || uParent.name}`,
          stability: 'BEST',
          target: { kind: 'css', value: buildCSSSelector(el) },
          code: `${pCode}.${bestChild}`,
          fullCode: `await (${pCode}).${bestChild}.${action};`,
          explanation: `Uses a unique parent (${uParent.id || uParent.role}) to narrow down the search. This is the pro approach for elements in lists, tables, or complex dashboards where name alone is ambiguous.`,
          why: 'Context-specific uniqueness'
        });
      }
    }

    // 11. Iframe Detection
    const inIframe = window.self !== window.top;
    if (inIframe) {
      const frameChildSnippet = locators.length && locators[0].code
        ? locators[0].code.replace('page.', '')
        : "locator('iframe')";
      locators.unshift({
        rank: 0,
        method: 'Frame Switch',
        matchedAttr: 'Inside Iframe',
        stability: 'GOOD',
        target: { kind: 'css', value: buildCSSSelector(el) },
        code: `page.frameLocator('iframe-selector')`,
        fullCode: `await page.frameLocator('iframe').${frameChildSnippet}.${suggestAction(el)};`,
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
      target: { kind: 'css', value: cssSelector },
      code: `page.locator('${cssSelector.replace(/'/g, "\\'")}')`,
      fullCode: `await page.locator('${cssSelector.replace(/'/g, "\\'")}').${suggestAction(el)};`,
      explanation: hasUnstable
        ? `This CSS selector contains auto-generated class names (like styled-components or MUI classes) that regenerate on every build. Using this WILL cause your tests to break regularly. Use a semantic locator instead.`
        : `CSS selector fallback. Use only when semantic locators are not available. Prefer IDs and data attributes over class-based selectors.`,
      why: 'CSS selector (fallback)'
    });

    // ── Live uniqueness: tag each locator with how many elements it matches ───
    locators.forEach(l => {
      const c = countTargetMatches(l.target);
      if (c != null) { l.matchCount = c; l.unique = (c === 1); }
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
      proTip = `Combine your locator with an assertion: await expect(page.getByRole('${role || tag}')).toBeVisible() — Playwright auto-retries this until the element appears or times out.`;
    }

    const a11y = analyzeA11y(el);

    return { elementData, locators, avoidList, proTip, a11y };
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

  global.__LocatorLensEngine = {
    generateLocators,
    getRole,
    getAccessibleName
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);