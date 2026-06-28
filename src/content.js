// LocatorLens – content.js
// Injected into every page. Handles hover highlight + click capture + locator generation.

(function () {
  'use strict';
  if (window.__LocatorLensInjected) return;
  window.__LocatorLensInjected = true;

  // ── State ──────────────────────────────────────────────────────────────────
  let isInspecting = false;
  let isRecording = false;
  let hoveredEl = null;
  let overlay = null;
  let tooltip = null;
  let traversalBar = null;
  let lastRightClickedEl = null;
  let lastPickedEl = null; // last element the user actually picked (survives stop-inspect for Stress Test)
  let customTestAttributes = ['data-testid', 'data-qa', 'data-cy', 'data-test', 'data-automation-id', 'data-e2e'];

  // Recorder modes (driven by the side panel via messages)
  let isPaused = false;       // pause/resume while recording
  let assertMode = false;     // when on, a click records an assertion instead of an interaction
  let assertType = 'toBeVisible';

  // Output target for quick-copy (context menu + click-to-copy), synced from the side panel.
  let llFramework = 'playwright';
  let llLanguage = 'typescript';

  // ── Recording Engine ──────────────────────────────────────────────────────
  // Monotonic id per recording session so the side panel can dedupe true transport
  // duplicates without merging distinct actions that share the same timestamp.
  let recordActionSeq = 0;

  function nextRecordEventId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  function sendRecordedAction(data) {
    const payload = {
      eventId: nextRecordEventId(),
      sequence: ++recordActionSeq,
      timestamp: data.timestamp != null ? data.timestamp : Date.now(),
      url: data.url != null ? data.url : window.location.href,
      action: data.action,
      value: data.value != null ? data.value : '',
      code: data.code != null ? data.code : '',
      fullCode: data.fullCode != null ? data.fullCode : '',
      target: data.target != null ? data.target : null,
      assertType: data.assertType != null ? data.assertType : null
    };
    try {
      if (chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage({ type: 'RECORDED_ACTION', data: payload }, () => {
          void chrome.runtime.lastError;
        });
      }
    } catch (err) { /* context invalidated */ }
  }

  function recordFallbackLocator(el, methodChain) {
    const chain = (methodChain || 'click()').replace(/;\s*$/, '');
    if (el.id && typeof el.id === 'string' && el.id.trim()) {
      const id = String(el.id).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return {
        code: `page.locator('#${id}')`,
        fullCode: `await page.locator('#${id}').${chain};`,
        target: { kind: 'id', value: el.id }
      };
    }
    const tag = (el.tagName && el.tagName.toLowerCase()) || 'body';
    return {
      code: `page.locator('${tag}')`,
      fullCode: `await page.locator('${tag}').first().${chain};`,
      target: { kind: 'css', value: tag }
    };
  }

  function bestLocatorFor(el, fallbackChain) {
    let best;
    try {
      const result = generateLocators(el);
      best = result.locators && result.locators[0];
    } catch (err) {
      console.warn('[LocatorLens] generateLocators failed during recording:', err);
    }
    if (!best) {
      const fb = recordFallbackLocator(el, fallbackChain || 'click()');
      best = { code: fb.code, fullCode: fb.fullCode, target: fb.target };
    }
    return best;
  }

  // Alt+Click → record a hover step.
  function recordHover(el) {
    const best = bestLocatorFor(el, 'hover()');
    sendRecordedAction({
      action: 'hover',
      value: '',
      code: best.code,
      fullCode: `await ${best.code}.hover();`,
      target: best.target
    });
  }

  function computeAssertValue(el, type) {
    if (type === 'toHaveText') return (el.innerText || el.textContent || '').trim().slice(0, 200);
    if (type === 'toHaveValue') return el.value != null ? String(el.value) : '';
    if (type === 'toBeChecked') return el.checked ? 'true' : 'false';
    return '';
  }

  // Assert mode → record an assertion on the clicked element.
  function recordAssertion(el) {
    const best = bestLocatorFor(el, 'click()');
    const type = assertType || 'toBeVisible';
    const value = computeAssertValue(el, type);
    let call = 'toBeVisible()';
    if (type === 'toHaveText') call = `toHaveText(${JSON.stringify(value)})`;
    else if (type === 'toHaveValue') call = `toHaveValue(${JSON.stringify(value)})`;
    else if (type === 'toBeEnabled') call = 'toBeEnabled()';
    else if (type === 'toBeChecked') call = value === 'false' ? 'not.toBeChecked()' : 'toBeChecked()';
    sendRecordedAction({
      action: 'assert',
      assertType: type,
      value: value,
      code: best.code,
      fullCode: `await expect(${best.code}).${call};`,
      target: best.target
    });
  }

  // Resolve the real element: composedPath()[0] can be a TEXT node inside <button>,
  // which previously caused us to skip the whole interaction.
  function resolvePrimaryTarget(e) {
    const path = (typeof e.composedPath === 'function' && e.composedPath()) || [];
    let n = path.length ? path[0] : e.target;
    while (n && n.nodeType !== Node.ELEMENT_NODE) {
      if (n instanceof ShadowRoot) n = n.host;
      else n = n.parentNode;
      if (!n || n === document || n === window) return null;
    }
    return n && n.nodeType === Node.ELEMENT_NODE ? n : null;
  }

  // pointerdown (preferred) + capture fires before target handlers; also covers
  // more pointer types than mousedown alone. Falls back to mousedown if needed.
  function onRecordPrimaryPointer(e) {
    if (!isRecording || isPaused) return;
    if (typeof e.button === 'number' && e.button !== 0) return;
    if (typeof e.isPrimary === 'boolean' && e.isPrimary === false) return;

    const rawTarget = resolvePrimaryTarget(e);
    if (!rawTarget) return;
    if (rawTarget === overlay || rawTarget === tooltip) return;
    if (traversalBar && traversalBar.contains(rawTarget)) return;

    const el = rawTarget;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();

    // Alt+Click records a hover; assert mode records an assertion. Both short-circuit
    // the normal click/fill capture below.
    if (e.altKey) { recordHover(el); return; }
    if (assertMode) { recordAssertion(el); return; }

    // Text inputs & textarea: we used to ignore pointer here and rely only on "change".
    // A click that only focuses the field never fires "change", so getByRole('textbox'…)
    // interactions looked "missing". Record a .click() for focus; actual typing still
    // comes from onRecordChange (fill) when the value is committed.
    if ((tag === 'input' && !['submit', 'button', 'checkbox', 'radio', 'reset'].includes(type)) || tag === 'textarea') {
      let best;
      try {
        const result = generateLocators(el);
        best = result.locators && result.locators[0];
      } catch (err) {
        console.warn('[LocatorLens] generateLocators failed during recording:', err);
      }
      if (!best) {
        const fb = recordFallbackLocator(el, 'click()');
        best = { code: fb.code, fullCode: fb.fullCode, target: fb.target };
      } else {
        const c = best.code;
        best = Object.assign({}, best, { fullCode: `await ${c}.click();` });
      }
      sendRecordedAction({
        action: 'click',
        value: '',
        code: best.code,
        fullCode: best.fullCode,
        target: best && best.target
      });
      return;
    }

    let best;
    try {
      const result = generateLocators(el);
      best = result.locators && result.locators[0];
    } catch (err) {
      console.warn('[LocatorLens] generateLocators failed during recording:', err);
    }
    if (!best) {
      const fb = recordFallbackLocator(el, (type === 'checkbox' || type === 'radio') ? 'check()' : 'click()');
      best = { code: fb.code, fullCode: fb.fullCode, target: fb.target };
    }

    const actionType = (type === 'checkbox' || type === 'radio') ? 'check' : 'click';

    sendRecordedAction({
      action: actionType,
      value: '',
      code: best.code,
      fullCode: best.fullCode,
      target: best && best.target
    });
  }

  const _recordPointerOptions = typeof PointerEvent !== 'undefined'
    ? { capture: true, passive: true }
    : { capture: true };

  /** Per-element debounce timers for the `input` event (React/controlled fields often skip native `change` until blur). */
  const _inputDebounceTimers = new WeakMap();
  /** After a debounced input emit, suppress the redundant native `change` for the same value. */
  const _suppressChangeAfterInput = new WeakMap();

  function isTextLikeField(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return !['submit', 'button', 'checkbox', 'radio', 'reset', 'file', 'hidden', 'image', 'color', 'range'].includes(t);
    }
    return false;
  }

  function getTextLikeValue(el) {
    if (el.isContentEditable) {
      return (el.innerText != null ? el.innerText : (el.textContent || '')).replace(/\r\n/g, '\n');
    }
    return el.value != null ? String(el.value) : '';
  }

  function sendFillForTextLike(el, markSuppressAfter) {
    if (!isRecording || isPaused || assertMode) return;
    let best;
    try {
      const result = generateLocators(el);
      best = result.locators && result.locators[0];
    } catch (err) {
      console.warn('[LocatorLens] generateLocators failed during recording:', err);
    }

    const value = getTextLikeValue(el);
    if (!best) {
      const esc = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const fb = recordFallbackLocator(el, `fill('${esc}')`);
      best = { code: fb.code, fullCode: fb.fullCode, target: fb.target };
    } else {
      const esc = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      best = Object.assign({}, best, { fullCode: `await ${best.code}.fill('${esc}');` });
    }

    sendRecordedAction({
      action: 'fill',
      value: value,
      code: best.code,
      fullCode: best.fullCode,
      target: best && best.target
    });
    if (markSuppressAfter) {
      _suppressChangeAfterInput.set(el, { v: value, t: Date.now() });
    }
  }

  function onRecordInputForDebounce(e) {
    if (!isRecording || isPaused || assertMode) return;
    const el = e.target;
    if (!isTextLikeField(el)) return;
    const prev = _inputDebounceTimers.get(el);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      _inputDebounceTimers.delete(el);
      sendFillForTextLike(el, true);
    }, 450);
    _inputDebounceTimers.set(el, t);
  }

  function onRecordChange(e) {
    if (!isRecording || isPaused || assertMode) return;
    const el = e.target;
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();

    if (tag === 'select' || type === 'checkbox' || type === 'radio') {
      let best;
      try {
        const result = generateLocators(el);
        best = result.locators && result.locators[0];
      } catch (err) {
        console.warn('[LocatorLens] generateLocators failed during recording:', err);
      }

      let actionType = 'fill';
      let value = el.value || '';
      if (tag === 'select') {
        actionType = 'selectOption';
        const opt = el.options[el.selectedIndex];
        value = opt ? opt.textContent.trim() : el.value;
      } else {
        actionType = el.checked ? 'check' : 'uncheck';
        value = '';
      }

      if (!best) {
        let chain = `fill('${String(el.value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')`;
        if (tag === 'select') {
          chain = `selectOption('${String(value).replace(/'/g, "\\'")}')`;
        } else {
          chain = el.checked ? 'check()' : 'uncheck()';
        }
        const fb = recordFallbackLocator(el, chain);
        best = { code: fb.code, fullCode: fb.fullCode, target: fb.target };
      }

      sendRecordedAction({
        action: actionType,
        value: value,
        code: best.code,
        fullCode: best.fullCode,
        target: best && best.target
      });
      return;
    }

    if (isTextLikeField(el) && e.type === 'change') {
      const val = getTextLikeValue(el);
      const sup = _suppressChangeAfterInput.get(el);
      if (sup && (Date.now() - sup.t) < 2000 && sup.v === val) {
        _suppressChangeAfterInput.delete(el);
        return;
      }
      sendFillForTextLike(el, false);
    }
  }

  function onRecordDblClick(e) {
    if (!isRecording || isPaused || assertMode) return;
    const el = resolvePrimaryTarget(e);
    if (!el || el === overlay || (traversalBar && traversalBar.contains(el))) return;
    let best;
    try {
      const result = generateLocators(el);
      best = result.locators && result.locators[0];
    } catch (err) {
      console.warn('[LocatorLens] generateLocators (dblclick):', err);
    }
    if (!best) {
      const fb = recordFallbackLocator(el, 'dblclick()');
      best = { code: fb.code, fullCode: fb.fullCode, target: fb.target };
    } else {
      best = Object.assign({}, best, { fullCode: `await ${best.code}.dblclick();` });
    }
    sendRecordedAction({
      action: 'dblclick',
      value: '',
      code: best.code,
      fullCode: best.fullCode,
      target: best && best.target
    });
  }

  function onRecordKeydown(e) {
    if (!isRecording || isPaused || assertMode) return;
    // Only record meaningful keypresses
    if (!['Enter', 'Tab', 'Escape'].includes(e.key)) return;

    sendRecordedAction({
      action: 'press',
      value: e.key,
      code: '',
      fullCode: `await page.keyboard.press(${JSON.stringify(e.key)});`
    });
  }

  // rearm = true when the background re-attaches capture after a full-page navigation.
  // In that case we only resume listening; we do NOT record a goto/viewport, because the
  // navigation was already produced by the previously-recorded action (the frameworks
  // auto-wait for it), and re-recording the size would be noise.
  function startRecording(rearm) {
    if (isRecording) return;
    recordActionSeq = 0;
    isRecording = true;
    isPaused = false;
    assertMode = false;
    if (typeof PointerEvent !== 'undefined') {
      document.addEventListener('pointerdown', onRecordPrimaryPointer, _recordPointerOptions);
    } else {
      document.addEventListener('mousedown', onRecordPrimaryPointer, true);
    }
    document.addEventListener('input', onRecordInputForDebounce, true);
    document.addEventListener('change', onRecordChange, true);
    document.addEventListener('keydown', onRecordKeydown, true);
    document.addEventListener('dblclick', onRecordDblClick, true);
    console.log('[LocatorLens] Recording Started.' + (rearm ? ' (resumed after navigation)' : ''));

    if (rearm) return;

    const now = Date.now();
    const href = window.location.href;
    sendRecordedAction({
      action: 'goto',
      value: href,
      code: '',
      fullCode: `await page.goto(${JSON.stringify(href)});`,
      timestamp: now
    });
    sendRecordedAction({
      action: 'viewport',
      value: `${window.innerWidth}x${window.innerHeight}`,
      code: '',
      fullCode: `await page.setViewportSize({ width: ${window.innerWidth}, height: ${window.innerHeight} });`,
      timestamp: now + 1
    });
  }

  function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    isPaused = false;
    assertMode = false;
    document.removeEventListener('pointerdown', onRecordPrimaryPointer, _recordPointerOptions);
    document.removeEventListener('mousedown', onRecordPrimaryPointer, true);
    document.removeEventListener('input', onRecordInputForDebounce, true);
    document.removeEventListener('change', onRecordChange, true);
    document.removeEventListener('keydown', onRecordKeydown, true);
    document.removeEventListener('dblclick', onRecordDblClick, true);
    console.log('[LocatorLens] Recording Stopped.');
  }

  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['customAttributes', 'llFramework', 'llLanguage'], (res) => {
      if (res && res.customAttributes && res.customAttributes.length > 0) {
        customTestAttributes = [...res.customAttributes, ...customTestAttributes];
        // Remove duplicates
        customTestAttributes = [...new Set(customTestAttributes)];
      }
      if (res && res.llFramework) llFramework = res.llFramework;
      if (res && res.llLanguage) llLanguage = res.llLanguage;
    });

    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace !== 'local') return;
      if (changes.customAttributes) {
        let newAttrs = changes.customAttributes.newValue || [];
        customTestAttributes = [...newAttrs, 'data-testid', 'data-qa', 'data-cy', 'data-test', 'data-automation-id', 'data-e2e'];
        customTestAttributes = [...new Set(customTestAttributes)];
      }
      if (changes.llFramework) llFramework = changes.llFramework.newValue || 'playwright';
      if (changes.llLanguage) llLanguage = changes.llLanguage.newValue || 'typescript';
    });
  }

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

      .ll-lab-highlight {
        outline: 4px solid #ff00ff !important;
        outline-offset: -4px !important;
        background: rgba(255, 0, 255, 0.15) !important;
        box-shadow: 0 0 12px rgba(255, 0, 255, 0.4) !important;
        z-index: 2147483646 !important;
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
    const lbl = document.createElement('span');
    lbl.className = 'll-trav-lbl';
    lbl.textContent = 'NAVIGATE';

    const btnParent = document.createElement('button');
    btnParent.id = 'll-trav-parent';
    btnParent.textContent = '▲ Parent';

    const btnChild = document.createElement('button');
    btnChild.id = 'll-trav-child';
    btnChild.textContent = '▼ Child';

    const hint = document.createElement('span');
    hint.className = 'll-trav-hint';
    hint.textContent = '↑↓ keys';

    traversalBar.appendChild(lbl);
    traversalBar.appendChild(btnParent);
    traversalBar.appendChild(btnChild);
    traversalBar.appendChild(hint);
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

    tooltip.textContent = '';
    const ttTag = document.createElement('span');
    ttTag.className = 'll-tag';
    ttTag.textContent = '<' + tag + (id || cls) + '>';
    tooltip.appendChild(ttTag);
    const ttHint = document.createElement('div');
    ttHint.className = 'll-hint';
    ttHint.textContent = 'Click to analyze · ▲/▼ to navigate · Esc to stop';
    tooltip.appendChild(ttHint);

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
    const toastIcon = document.createElement('span');
    toastIcon.className = 'll-toast-icon';
    toastIcon.textContent = '✅';
    toast.appendChild(toastIcon);
    const toastWrap = document.createElement('span');
    const toastLabel = document.createElement('span');
    toastLabel.className = 'll-toast-label';
    toastLabel.textContent = 'Copied: ';
    toastWrap.appendChild(toastLabel);
    const toastCode = document.createElement('span');
    toastCode.className = 'll-toast-code';
    toastCode.textContent = locatorCode;
    toastWrap.appendChild(toastCode);
    toast.appendChild(toastWrap);
    document.body.appendChild(toast);

    // Auto-dismiss after 3s with fade-out
    toastTimer = setTimeout(() => {
      toast.classList.add('ll-toast-out');
      setTimeout(() => toast.remove(), 320);
    }, 3000);
  }


  function generateLocators(el) {
    const E = globalThis.__LocatorLensEngine;
    if (!E) {
      console.error('[LocatorLens] Missing __LocatorLensEngine — ensure content-locator-engine.js is listed before content.js in the manifest.');
      return { elementData: {}, locators: [], avoidList: [], proTip: '', a11y: [] };
    }
    return E.generateLocators(el, customTestAttributes);
  }

  // Locator expression for quick-copy, honoring the side panel's framework/language.
  function copyLocatorCode(loc) {
    if (window.LLCodegen && loc && loc.target) {
      const expr = window.LLCodegen.locatorExpr(loc.target, llFramework, llLanguage);
      if (expr) return expr;
    }
    return (loc && loc.code) || '';
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

    lastPickedEl = el; // remember for Stress Test even after inspect stops

    const result = generateLocators(el);

    const bestCode = result.locators[0] ? copyLocatorCode(result.locators[0]) : '';
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

  // 🛡️ INITIALIZATION: Force Neutral State
  // Ensure we don't start in an active state on page load/script injection
  stopInspect();

  // ── Message listener ───────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'START_INSPECT') {
      startInspect();
      sendResponse({ ok: true });
    } else if (msg.type === 'STOP_INSPECT') {
      stopInspect();
      sendResponse({ ok: true });
    }
    // 🎬 RECORDING: Start/Stop recording user interactions
    else if (msg.type === 'START_RECORDING') {
      startRecording(msg.rearm);
      sendResponse({ ok: true });
    }
    else if (msg.type === 'STOP_RECORDING') {
      stopRecording();
      sendResponse({ ok: true });
    }
    else if (msg.type === 'PAUSE_RECORDING') {
      isPaused = true;
      sendResponse({ ok: true });
    }
    else if (msg.type === 'RESUME_RECORDING') {
      isPaused = false;
      sendResponse({ ok: true });
    }
    else if (msg.type === 'SET_ASSERT_MODE') {
      assertMode = !!msg.on;
      if (msg.assertType) assertType = msg.assertType;
      sendResponse({ ok: true });
    }
    // Handle context menu quick-copy
    else if (msg.type === 'CONTEXT_MENU_COPY') {
      const target = lastRightClickedEl || document.body;
      const result = generateLocators(target);

      const bestCode = result.locators[0] ? copyLocatorCode(result.locators[0]) : '';
      if (bestCode) {
        navigator.clipboard.writeText(bestCode).then(() => {
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

      if (isInspecting) {
        try {
          if (chrome.runtime && chrome.runtime.id) {
            chrome.runtime.sendMessage({ type: 'ELEMENT_PICKED', data: result });
          }
        } catch (e) { }
      }
      sendResponse({ ok: true });
    }

    // 🔬 SELECTOR LAB: Validation Engine
    else if (msg.type === 'LAB_VALIDATE') {
      const { selector } = msg;
      let matches = [];
      let via = null;
      document.querySelectorAll('.ll-lab-highlight').forEach(el => el.classList.remove('ll-lab-highlight'));

      // Resolve a pasted Playwright locator chain — e.g.
      //   await page.getByRole('textbox', { name: 'Username or Email' }).fill('x');
      // — down to the DOM element(s) it targets. Returns null for plain CSS/XPath.
      const resolvePlaywrightLocator = (raw) => {
        const E = globalThis.__LocatorLensEngine;
        let s = String(raw || '').trim();
        if (!/\b(getBy[A-Z]\w*|locator|frameLocator)\s*\(/.test(s)) return null;

        // Strip the boilerplate around the locator chain.
        s = s.replace(/;\s*$/, '').trim();
        s = s.replace(/^await\s+/, '');
        s = s.replace(/^(?:const|let|var)\s+[\w$]+\s*=\s*/, '');
        s = s.replace(/^await\s+/, '');
        s = s.replace(/^(?:this\s*\.\s*)?(?:page|component)\b\s*/, '');
        s = s.replace(/^\.\s*/, '');
        s = '.' + s; // so the scanner picks up the first call too

        // Split the chain into .method(args) segments (quote/paren aware).
        const segs = [];
        let i = 0;
        while (i < s.length) {
          const m = /\.([A-Za-z_$][\w$]*)\s*\(/.exec(s.slice(i));
          if (!m) break;
          const open = i + m.index + m[0].length - 1;
          let depth = 0, j = open, str = null;
          for (; j < s.length; j++) {
            const c = s[j];
            if (str) { if (c === '\\') { j++; } else if (c === str) str = null; continue; }
            if (c === '"' || c === "'" || c === '`') str = c;
            else if (c === '(') depth++;
            else if (c === ')') { if (--depth === 0) { j++; break; } }
          }
          segs.push({ method: m[1], args: s.slice(open + 1, j - 1) });
          i = j;
        }
        if (!segs.length) return null;

        const firstStr = (args) => {
          const m = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/.exec(args);
          return m ? m[2].replace(/\\(['"`])/g, '$1') : null;
        };
        const opt = (args, key) => {
          const m = new RegExp(key + "\\s*:\\s*(?:(['\"`])((?:\\\\.|(?!\\1)[\\s\\S])*?)\\1|(true|false)|(\\d+))").exec(args);
          if (!m) return undefined;
          if (m[2] !== undefined) return m[2].replace(/\\(['"`])/g, '$1');
          if (m[3] !== undefined) return m[3] === 'true';
          if (m[4] !== undefined) return parseInt(m[4], 10);
          return undefined;
        };
        const norm = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
        const matchText = (actual, expected, exact) => {
          const a = norm(actual), e = norm(expected);
          return exact ? a === e : a.toLowerCase().includes(e.toLowerCase());
        };
        const isHidden = (el) => {
          if (!el || el.nodeType !== 1) return true;
          if (el.closest('[aria-hidden="true"]') || el.hasAttribute('hidden')) return true;
          const cs = getComputedStyle(el);
          return cs.display === 'none' || cs.visibility === 'hidden';
        };
        const within = (root) => Array.from((root === document ? document : root).querySelectorAll('*'));

        const find = (method, args, root) => {
          const all = within(root);
          switch (method) {
            case 'getByRole': {
              const role = firstStr(args), name = opt(args, 'name'), exact = opt(args, 'exact') === true;
              if (!role || !E) return [];
              return all.filter(el => !isHidden(el) && E.getRole(el) === role &&
                (name == null || matchText(E.getAccessibleName(el), name, exact)));
            }
            case 'getByLabel': {
              const t = firstStr(args), exact = opt(args, 'exact') === true;
              if (t == null || !E) return [];
              return all.filter(el => /^(input|select|textarea)$/i.test(el.tagName) &&
                matchText(E.getAccessibleName(el), t, exact));
            }
            case 'getByPlaceholder': {
              const t = firstStr(args), exact = opt(args, 'exact') === true;
              if (t == null) return [];
              return all.filter(el => el.hasAttribute('placeholder') && matchText(el.getAttribute('placeholder'), t, exact));
            }
            case 'getByTestId': {
              const t = firstStr(args);
              return t == null ? [] : all.filter(el => el.getAttribute('data-testid') === t);
            }
            case 'getByTitle': {
              const t = firstStr(args), exact = opt(args, 'exact') === true;
              if (t == null) return [];
              return all.filter(el => el.hasAttribute('title') && matchText(el.getAttribute('title'), t, exact));
            }
            case 'getByAltText': {
              const t = firstStr(args), exact = opt(args, 'exact') === true;
              if (t == null) return [];
              return all.filter(el => el.hasAttribute('alt') && matchText(el.getAttribute('alt'), t, exact));
            }
            case 'getByText': {
              const t = firstStr(args), exact = opt(args, 'exact') === true;
              if (t == null) return [];
              const hit = all.filter(el => !isHidden(el) && matchText(el.innerText || el.textContent, t, exact));
              // keep the innermost matches (Playwright targets the smallest element)
              return hit.filter(el => !hit.some(o => o !== el && el.contains(o)));
            }
            case 'locator': {
              let sel = firstStr(args);
              if (sel == null) return [];
              sel = sel.replace(/^css=/, '');
              if (/^xpath=/.test(sel) || sel.startsWith('//') || sel.startsWith('(')) {
                const xp = sel.replace(/^xpath=/, ''), out = [];
                const r = document.evaluate(xp, root === document ? document : root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                for (let k = 0; k < r.snapshotLength; k++) out.push(r.snapshotItem(k));
                return out;
              }
              try { return Array.from((root === document ? document : root).querySelectorAll(sel)); }
              catch (e) { return []; }
            }
            default: return [];
          }
        };

        const LOC = new Set(['getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId', 'getByTitle', 'getByAltText', 'locator']);
        let result = [], started = false, lastLoc = null;
        for (const seg of segs) {
          if (LOC.has(seg.method)) {
            const roots = started ? result : [document];
            const next = [];
            for (const r of roots) for (const el of find(seg.method, seg.args, r)) if (!next.includes(el)) next.push(el);
            result = next; started = true; lastLoc = seg.method;
          } else if (seg.method === 'first') result = result.slice(0, 1);
          else if (seg.method === 'last') result = result.slice(-1);
          else if (seg.method === 'nth') { const n = parseInt(firstStr(seg.args) != null ? firstStr(seg.args) : seg.args, 10) || 0; result = result[n] ? [result[n]] : []; }
          else if (seg.method === 'filter') { const ht = opt(seg.args, 'hasText'); if (ht != null) result = result.filter(el => matchText(el.innerText || el.textContent, ht, false)); }
          // action methods (fill/click/check/press/...) are ignored
        }
        return started ? { matches: result, via: lastLoc } : null;
      };

      try {
        const pw = resolvePlaywrightLocator(selector);
        if (pw) {
          matches = pw.matches;
          via = pw.via;
        } else if (selector.startsWith('//') || selector.startsWith('(')) {
          const result = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (let i = 0; i < result.snapshotLength; i++) {
            matches.push(result.snapshotItem(i));
          }
        } else {
          matches = Array.from(document.querySelectorAll(selector));
        }

        matches.forEach(el => {
          if (el && el.nodeType === Node.ELEMENT_NODE) el.classList.add('ll-lab-highlight');
        });

        if (matches[0] && matches[0].scrollIntoView) {
          matches[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
        }

        chrome.runtime.sendMessage({ type: 'LAB_STATUS_UPDATE', count: matches.length, via });
        sendResponse({ ok: true, count: matches.length });
      } catch (err) {
        chrome.runtime.sendMessage({ type: 'LAB_ERROR', error: err.message });
        sendResponse({ ok: false, error: err.message });
      }
    }

    else if (msg.type === 'LAB_CLEAR') {
      document.querySelectorAll('.ll-lab-highlight').forEach(el => el.classList.remove('ll-lab-highlight'));
      sendResponse({ ok: true });
    }

    // 💥 STRESS TEST: Check if the picked element survives without id/class
    else if (msg.type === 'RUN_STRESS_TEST') {
      const E = globalThis.__LocatorLensEngine;
      if (!E) {
        sendResponse({ ok: true, data: { survived: false, unavailable: true } });
        return;
      }

      // Prefer the element the user actually picked; fall back to hover / right-click.
      // Skip stale references (e.g. removed after a navigation) and never silently test <body>.
      let target = [lastPickedEl, hoveredEl, lastRightClickedEl].find(el => el && el.isConnected);
      if (!target) {
        sendResponse({ ok: true, data: { survived: false, noTarget: true } });
        return;
      }

      const role = E.getRole(target);
      const name = E.getAccessibleName(target);
      const tag = target.tagName.toLowerCase();
      let survived = false;

      if (role && name) {
        const candidates = document.querySelectorAll(tag);
        let semanticMatches = 0;
        for (const c of candidates) {
          if (E.getRole(c) === role && E.getAccessibleName(c) === name) {
            semanticMatches++;
          }
        }
        survived = semanticMatches === 1;
      }

      sendResponse({ ok: true, data: { survived, role, name, tag } });
    }
  });
})();
