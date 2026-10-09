// Locatra – content.js
// Injected into every page. Handles hover highlight + click capture + locator generation.

(function () {
  'use strict';

  // ── Re-injection guard (liveness, not a bare flag) ─────────────────────────
  // A plain "already injected" flag used to block recovery for good: after Locatra
  // is reloaded or updated, Chrome keeps the page's isolated world — flag included —
  // while every listener of the old instance is dead (its extension context is
  // gone). The old instance now publishes a liveness probe and a teardown; a fresh
  // injection only stands down when the previous one can still talk to the
  // extension, and otherwise dismantles it (listeners, overlay, highlights) first.
  const prior = window.__LocatorLensInstance;
  if (prior) {
    let priorAlive = false;
    try { priorAlive = typeof prior.isAlive === 'function' && !!prior.isAlive(); } catch (err) { priorAlive = false; }
    if (priorAlive) return;
    try { if (typeof prior.teardown === 'function') prior.teardown(); } catch (err) { /* already gone */ }
  }
  window.__LocatorLensInjected = true;
  // The chrome object this instance was born with. A reload swaps it for a new one
  // in a re-used world; the old one's runtime.id going away is the death signal.
  const ownChrome = chrome;
  let tornDown = false;
  function contextAlive() {
    if (tornDown) return false;
    try { return !!(ownChrome.runtime && ownChrome.runtime.id); } catch (err) { return false; }
  }

  // Script-dispatched events (el.click(), dispatchEvent) have isTrusted === false.
  // The recorder and the picker ignore them so a page's own automation — input
  // masks, prefill scripts, a synthetic el.click() while inspecting — is never
  // recorded or picked. The test suite drives jsdom, whose events are all
  // untrusted, so it opts in through a global that only this script's own world
  // can see: content scripts live in an isolated world (Chrome) / behind Xray
  // wrappers (Firefox), so a page cannot set it for us.
  function isUserEvent(e) {
    if (!e || e.isTrusted !== false) return true;
    return globalThis.__LocatraTrustSyntheticEvents === true;
  }

  // Diagnostic logging is off in released builds — a content script runs on every
  // page the user visits, so unconditional console output is other people's noise.
  // Enable with: chrome.storage.local.set({ llDebug: true })
  let llDebug = false;
  function debugLog() {
    if (!llDebug) return;
    // eslint-disable-next-line no-console -- this IS the opt-in debug channel
    console.log.apply(console, ['[Locatra]'].concat(Array.prototype.slice.call(arguments)));
  }
  function debugWarn() {
    if (!llDebug) return;
    console.warn.apply(console, ['[Locatra]'].concat(Array.prototype.slice.call(arguments)));
  }

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

  // Every message out of a content script can outlive its extension: reloading or
  // updating Locatra invalidates the context of every page already open, and an
  // unguarded sendMessage then throws into *the visited site's* console. Reading
  // lastError in the callback is what suppresses the "Unchecked runtime.lastError"
  // noise when nothing is listening.
  /** @returns false when the extension context is gone, so callers can stand down. */
  // An orphaned instance (Locatra reloaded/updated under an open page) can never be
  // heard again, so on the first failed send it dismantles itself instead of leaving
  // a dead crosshair, live listeners or highlights behind on someone's site.
  function safeSend(msg, callback) {
    let ok = false;
    try {
      if (contextAlive()) {
        ownChrome.runtime.sendMessage(msg, (res) => {
          let err = null;
          try { err = ownChrome.runtime.lastError; } catch (e) { err = e; }
          if (callback) callback(err ? undefined : res);
        });
        ok = true;
      }
    } catch (err) {
      ok = false;
    }
    if (!ok && !tornDown && !contextAlive()) setTimeout(teardown, 0);
    return ok;
  }

  // ── Sensitive values (never leave the page) ───────────────────────────────
  const SENSITIVE_AUTOCOMPLETE = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp'];
  const PASSWORD_AUTOCOMPLETE = ['current-password', 'new-password'];

  function autocompleteTokens(el) {
    return String((el.getAttribute && el.getAttribute('autocomplete')) || '').toLowerCase().split(/\s+/).filter(Boolean);
  }

  /** null for ordinary fields, otherwise the env-var name the generated test reads. */
  function sensitiveSecretName(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE || el.tagName.toLowerCase() !== 'input') return null;
    const type = (el.getAttribute('type') || '').toLowerCase();
    const tokens = autocompleteTokens(el);
    if (type === 'password' || tokens.some((t) => PASSWORD_AUTOCOMPLETE.includes(t))) return 'LOCATRA_PASSWORD';
    if (tokens.some((t) => SENSITIVE_AUTOCOMPLETE.includes(t))) return 'LOCATRA_SECRET';
    return null;
  }

  // Credentials and tokens that travel in a URL (OAuth implicit-flow hashes, magic
  // links) must not end up in a recorded test or a stored pick.
  const SENSITIVE_URL_PARAM_RE = /([?&#;])(password|passwd|pwd|secret|client_secret|access_token|id_token|refresh_token|api_key|apikey)=([^&#;]*)/gi;
  function redactUrl(href) {
    if (href == null) return href;
    return String(href).replace(SENSITIVE_URL_PARAM_RE, (m, sep, key) => `${sep}${key}=REDACTED`);
  }

  // Pending debounced fills, field → timer. Declared up here because every other
  // recorded step flushes them first (see sendRecordedAction).
  const _pendingFills = new Map();
  /** eventId + element of the most recent click steps, for dblclick supersedes. */
  let _recentClicks = [];

  /** @returns the eventId of the step it sent. */
  function sendRecordedAction(data) {
    // Typing is debounced; anything the user did after it (Enter, Tab, a click on
    // Submit, a select, an assertion…) must land *after* the fill it commits.
    flushPendingFills();
    const payload = {
      eventId: nextRecordEventId(),
      sequence: ++recordActionSeq,
      timestamp: data.timestamp != null ? data.timestamp : Date.now(),
      url: redactUrl(data.url != null ? data.url : window.location.href),
      action: data.action,
      value: data.value != null ? data.value : '',
      code: data.code != null ? data.code : '',
      fullCode: data.fullCode != null ? data.fullCode : '',
      target: data.target != null ? data.target : null,
      assertType: data.assertType != null ? data.assertType : null
    };
    ['sensitive', 'secretName', 'inputType', 'supersedes'].forEach((k) => {
      if (data[k] != null) payload[k] = data[k];
    });
    safeSend({ type: 'RECORDED_ACTION', data: payload });
    return payload.eventId;
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
      debugWarn('generateLocators failed during recording:', err);
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

  // toHaveText compares the WHOLE normalized text, so a truncated value can never
  // pass. Long text switches to toContainText on a word-trimmed prefix instead.
  const ASSERT_FULL_TEXT_MAX = 1000;
  const ASSERT_CONTAIN_PREFIX = 200;

  function normalizedText(el) {
    return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function containPrefix(text) {
    if (text.length <= ASSERT_CONTAIN_PREFIX) return text;
    const cut = text.slice(0, ASSERT_CONTAIN_PREFIX);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > ASSERT_CONTAIN_PREFIX / 2 ? cut.slice(0, lastSpace) : cut).trim();
  }

  /** The element a checked-state assertion is really about. */
  function checkedTargetFor(el) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) return el;
    if (tag === 'label' && el.control) return el.control;
    if (el.hasAttribute('aria-checked')) return el;
    return (el.closest && el.closest('[aria-checked]')) || el;
  }

  function isChecked(el) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) return !!el.checked;
    // role=checkbox / switch / menuitemcheckbox widgets carry their state here.
    return el.getAttribute('aria-checked') === 'true';
  }

  function computeAssertValue(el, type) {
    if (type === 'toHaveText' || type === 'toContainText') return normalizedText(el);
    if (type === 'toHaveValue') return el.value != null ? String(el.value) : '';
    if (type === 'toBeChecked') return isChecked(el) ? 'true' : 'false';
    return '';
  }

  // Assert mode → record an assertion on the clicked element.
  function recordAssertion(clicked) {
    let type = assertType || 'toBeVisible';
    const el = type === 'toBeChecked' ? checkedTargetFor(clicked) : clicked;
    const best = bestLocatorFor(el, 'click()');
    let value = computeAssertValue(el, type);
    if (type === 'toHaveText' && value.length > ASSERT_FULL_TEXT_MAX) type = 'toContainText';
    if (type === 'toContainText') value = containPrefix(value);
    let call = 'toBeVisible()';
    if (type === 'toHaveText') call = `toHaveText(${JSON.stringify(value)})`;
    else if (type === 'toContainText') call = `toContainText(${JSON.stringify(value)})`;
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
  // which previously caused us to skip the whole interaction. It is also the only
  // way to see the real field inside an open shadow root — at document level
  // e.target has been retargeted to the shadow host.
  function resolvePrimaryTarget(e) {
    const path = (typeof e.composedPath === 'function' && e.composedPath()) || [];
    let n = path.length ? path[0] : e.target;
    while (n && n.nodeType !== Node.ELEMENT_NODE) {
      if (typeof ShadowRoot !== 'undefined' && n instanceof ShadowRoot) n = n.host;
      else n = n.parentNode;
      if (!n || n === document || n === window) return null;
    }
    return n && n.nodeType === Node.ELEMENT_NODE ? n : null;
  }

  /** Locatra's own overlay / tooltip / toolbar — never recorded or picked. */
  function isOwnUi(el) {
    if (!el) return false;
    if (el === overlay || el === tooltip) return true;
    return !!(traversalBar && traversalBar.contains(el));
  }

  // ── Shadow-root change capture ────────────────────────────────────────────
  // `change` is not a composed event: fired inside a shadow root it never reaches
  // the document listener, so checkboxes, radios, selects, files and sliders in web
  // components were never recorded. Every open shadow root on the path of a
  // composed event (pointerdown, focusin, keydown, input — one of them always
  // precedes a change) gets its own capture listener. A non-composed change only
  // propagates inside the tree it was fired in, so exactly one listener sees it; the
  // WeakSet guards the composed case (and any listener registered twice).
  const _shadowChangeRoots = new Set();
  const _handledChangeEvents = new WeakSet();
  function adoptShadowRoots(e) {
    if (!isRecording || typeof ShadowRoot === 'undefined' || typeof e.composedPath !== 'function') return;
    const path = e.composedPath();
    for (let i = 0; i < path.length; i++) {
      const n = path[i];
      if (n instanceof ShadowRoot && !_shadowChangeRoots.has(n)) {
        _shadowChangeRoots.add(n);
        n.addEventListener('change', onRecordChange, true);
      }
    }
  }

  function bestWithChain(el, chain) {
    let best;
    try {
      const result = generateLocators(el);
      best = result.locators && result.locators[0];
    } catch (err) {
      debugWarn('generateLocators failed during recording:', err);
    }
    if (!best) {
      const fb = recordFallbackLocator(el, chain);
      return { code: fb.code, fullCode: fb.fullCode, target: fb.target };
    }
    return Object.assign({}, best, { fullCode: `await ${best.code}.${chain.replace(/;\s*$/, '')};` });
  }

  function rememberClick(el, eventId) {
    _recentClicks.push({ el, eventId, t: Date.now() });
    if (_recentClicks.length > 4) _recentClicks = _recentClicks.slice(-4);
  }

  // Assert mode and Alt+Click turn a click into a recorded assertion / hover. The
  // page must not ALSO act on it — "assert the Delete button is visible" used to
  // delete the row. The pointerdown that records it is swallowed, and so is the
  // rest of that gesture (mousedown → pointerup → mouseup → click).
  let _swallowGestureUntil = 0;
  function swallow(e) {
    if (e.cancelable !== false) e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onRecordSwallow(e) {
    if (!isRecording || isPaused || isInspecting) return;
    if (typeof e.button === 'number' && e.button !== 0) return;
    // Only the rest of a gesture whose pointerdown was recorded as an assertion /
    // hover — a keyboard-activated click (Enter on a button) is left alone.
    if (Date.now() >= _swallowGestureUntil) return;
    if (isOwnUi(resolvePrimaryTarget(e))) return;
    swallow(e);
    if (e.type === 'click') _swallowGestureUntil = 0;
  }

  // pointerdown (preferred) + capture fires before target handlers; also covers
  // more pointer types than mousedown alone. Falls back to mousedown if needed.
  // Registered on window (capture) so it runs before the page's own listeners and
  // can still swallow the gesture in assert mode.
  function onRecordPrimaryPointer(e) {
    adoptShadowRoots(e);
    if (!isRecording || isPaused) return;
    // Picking an element while recording is not part of the flow.
    if (isInspecting) return;
    if (typeof e.button === 'number' && e.button !== 0) return;
    if (typeof e.isPrimary === 'boolean' && e.isPrimary === false) return;

    const el = resolvePrimaryTarget(e);
    if (!el || isOwnUi(el)) return;

    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();

    // Alt+Click records a hover; assert mode records an assertion. Both short-circuit
    // the normal click/fill capture below, and the page never sees the gesture.
    if (e.altKey || assertMode) {
      swallow(e);
      _swallowGestureUntil = Date.now() + 1500;
      if (e.altKey) recordHover(el);
      else recordAssertion(el);
      return;
    }

    // File, colour and range inputs are recorded from their change (upload / fill
    // with the settled value). A click on them opens a native chooser in a replay.
    if (tag === 'input' && (type === 'file' || type === 'color' || type === 'range')) return;

    // Checkboxes and radios are recorded by onRecordChange, not here. Recording on
    // pointerdown as well emitted the step twice, and this early it could only
    // guess `check` — the element has not toggled yet, so unchecking a box also
    // produced `.check()`. The change handler sees the settled state and is right.
    if (type === 'checkbox' || type === 'radio') return;

    // Text inputs & textarea: we used to ignore pointer here and rely only on "change".
    // A click that only focuses the field never fires "change", so getByRole('textbox'…)
    // interactions looked "missing". Record a .click() for focus; actual typing still
    // comes from the input/change handlers (fill) when the value is committed.
    let best;
    if ((tag === 'input' && !['submit', 'button', 'reset'].includes(type)) || tag === 'textarea') {
      best = bestWithChain(el, 'click()');
    } else {
      best = bestLocatorFor(el, 'click()');
    }

    const eventId = sendRecordedAction({
      action: 'click',
      value: '',
      code: best.code,
      fullCode: best.fullCode,
      target: best && best.target
    });
    rememberClick(el, eventId);
  }

  const _recordPointerOptions = { capture: true };

  // ── Typing ────────────────────────────────────────────────────────────────
  // `input` is debounced per field (React/controlled fields often skip native
  // `change` until blur). Pending fills live in _pendingFills (declared next to
  // sendRecordedAction, which flushes them before every other step).
  const FILL_DEBOUNCE_MS = 450;
  /** The last value recorded per field, to drop the redundant native `change`. */
  const _lastFilled = new WeakMap();

  // Inputs whose fill value is not free text: the generated code has to set them
  // differently in some frameworks (C6 inputType).
  const SPECIAL_INPUT_TYPES = ['range', 'color', 'date', 'time', 'datetime-local', 'month', 'week'];
  function specialInputType(el) {
    if (!el || el.tagName.toLowerCase() !== 'input') return null;
    const t = (el.getAttribute('type') || '').toLowerCase();
    return SPECIAL_INPUT_TYPES.includes(t) ? t : null;
  }

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

  function escSingle(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  }

  /**
   * Record the field's current value as a fill. `force` is used by flushes: the
   * keystrokes were made while capture was live, so a pause/assert toggle that
   * arrives before the debounce fires must not drop them.
   */
  function sendFill(el, force) {
    if (!isRecording) return;
    if (!force && (isPaused || assertMode)) return;
    const value = getTextLikeValue(el);
    const secretName = sensitiveSecretName(el);
    const inputType = specialInputType(el);
    // A password / OTP / card field's value never leaves the page: the step carries
    // an env-var reference instead (C4).
    const valueExpr = secretName ? `process.env.${secretName} ?? ''` : `'${escSingle(value)}'`;
    const best = bestWithChain(el, `fill(${valueExpr})`);
    _lastFilled.set(el, value);
    sendRecordedAction({
      action: 'fill',
      value: secretName ? '' : value,
      code: best.code,
      fullCode: best.fullCode,
      target: best && best.target,
      sensitive: secretName ? true : null,
      secretName: secretName,
      inputType: inputType
    });
  }

  function cancelPendingFill(el) {
    const t = _pendingFills.get(el);
    if (!t) return false;
    clearTimeout(t);
    _pendingFills.delete(el);
    return true;
  }

  /** Emit every debounced fill now, in the order the fields were typed into. */
  function flushPendingFills() {
    if (!_pendingFills.size) return;
    const fields = Array.from(_pendingFills.keys());
    _pendingFills.forEach((t) => clearTimeout(t));
    _pendingFills.clear();
    fields.forEach((el) => sendFill(el, true));
  }

  function onRecordInputForDebounce(e) {
    adoptShadowRoots(e);
    if (!isRecording || isPaused || assertMode) return;
    // A mask / prefill script writing into the field is not the user typing.
    if (!isUserEvent(e)) return;
    const el = resolvePrimaryTarget(e);
    if (!isTextLikeField(el)) return;
    cancelPendingFill(el);
    // Map order is insertion order: re-inserting moves the field to the end, so
    // a flush emits fills in the order their typing finished.
    const t = setTimeout(() => {
      if (_pendingFills.get(el) !== t) return;
      _pendingFills.delete(el);
      sendFill(el, true);
    }, FILL_DEBOUNCE_MS);
    _pendingFills.set(el, t);
  }

  function recordUpload(el) {
    const names = Array.from(el.files || []).map((f) => f.name);
    const value = JSON.stringify(names);
    const best = bestWithChain(el, `setInputFiles(${value})`);
    sendRecordedAction({
      action: 'upload',
      value: value,
      code: best.code,
      fullCode: best.fullCode,
      target: best && best.target
    });
  }

  function onRecordChange(e) {
    if (_handledChangeEvents.has(e)) return;
    _handledChangeEvents.add(e);
    if (!isRecording || isPaused || assertMode) return;
    if (!isUserEvent(e)) return;
    const el = resolvePrimaryTarget(e);
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();

    if (tag === 'input' && type === 'file') { recordUpload(el); return; }

    // Sliders and colour pickers fire `input` continuously while dragging; the
    // settled value arrives with `change`.
    if (tag === 'input' && (type === 'range' || type === 'color')) { sendFill(el, false); return; }

    if (tag === 'select' || type === 'checkbox' || type === 'radio') {
      let best;
      try {
        const result = generateLocators(el);
        best = result.locators && result.locators[0];
      } catch (err) {
        debugWarn('generateLocators failed during recording:', err);
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
          chain = `selectOption('${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')`;
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
      // The commit supersedes the debounce: emit now (once), not again in 450ms.
      const hadPending = cancelPendingFill(el);
      const val = getTextLikeValue(el);
      if (!hadPending && _lastFilled.has(el) && _lastFilled.get(el) === val) return;
      sendFill(el, false);
    }
  }

  function onRecordDblClick(e) {
    if (!isRecording || isPaused || assertMode || isInspecting) return;
    const el = resolvePrimaryTarget(e);
    if (!el || isOwnUi(el)) return;
    const best = bestWithChain(el, 'dblclick()');
    // The two pointerdowns of this double-click were already recorded as clicks.
    // Name them so the panel can replace them with this single dblclick step (C6).
    const now = Date.now();
    const supersedes = _recentClicks
      .filter((c) => c.el === el && now - c.t < 1500)
      .slice(-2)
      .map((c) => c.eventId);
    _recentClicks = [];
    sendRecordedAction({
      action: 'dblclick',
      value: '',
      code: best.code,
      fullCode: best.fullCode,
      target: best && best.target,
      supersedes: supersedes.length ? supersedes : null
    });
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────
  const RECORDED_KEYS = ['Enter', 'Tab', 'Escape'];
  const SPACE_ACTIVATED_ROLES = ['button', 'link', 'checkbox', 'switch', 'radio', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'tab', 'option', 'treeitem'];

  /**
   * Space is only an action on a control it activates. Native checkboxes/radios
   * are left to their `change` (else the toggle would be recorded twice), and in
   * a text field Space is just typing.
   */
  function isSpaceActivated(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE || isTextLikeField(el)) return false;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input') return ['button', 'submit', 'reset', 'image'].includes(type);
    if (tag === 'select') return false;
    if (tag === 'button' || tag === 'summary') return true;
    const role = (el.getAttribute('role') || '').trim().toLowerCase();
    return SPACE_ACTIVATED_ROLES.includes(role);
  }

  function onRecordKeydown(e) {
    adoptShadowRoots(e);
    if (!isRecording || isPaused || assertMode) return;
    // Inspect owns the keyboard while it is on (arrows, Enter to pick, Esc to stop).
    if (isInspecting) return;
    // Mid-composition keys (IME: CJK, dead keys) belong to the text being composed.
    if (e.isComposing || e.keyCode === 229) return;

    let key = null;
    if (RECORDED_KEYS.includes(e.key)) key = e.key;
    else if (e.key === ' ' || e.key === 'Spacebar') {
      // Enter/Space on a button also synthesizes a click, but the recorder listens
      // for pointerdown, so this press is the one and only step for it.
      if (isSpaceActivated(resolvePrimaryTarget(e))) key = ' ';
    }
    if (!key) return;

    const mods = [];
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.metaKey) mods.push('Meta');
    if (e.shiftKey) mods.push('Shift');
    const combo = mods.length ? mods.concat(key === ' ' ? 'Space' : key).join('+') : key;

    sendRecordedAction({
      action: 'press',
      value: combo,
      code: '',
      fullCode: `await page.keyboard.press(${JSON.stringify(combo)});`
    });
  }

  // The page is going away (navigation, tab close, bfcache) or being hidden: a
  // fill still inside its debounce window would otherwise be lost with it.
  function onRecordPageHide() {
    if (isRecording) flushPendingFills();
  }
  function onRecordVisibility() {
    if (isRecording && document.visibilityState === 'hidden') flushPendingFills();
  }

  function setPaused(paused) {
    // Keystrokes made before Pause belong to the recording.
    if (paused && !isPaused) flushPendingFills();
    isPaused = !!paused;
  }

  function applyAssertState(state) {
    if (!state) return;
    if (typeof state.assertMode === 'boolean') {
      if (state.assertMode && !assertMode) flushPendingFills();
      assertMode = state.assertMode;
    }
    if (typeof state.assertType === 'string' && state.assertType) assertType = state.assertType;
  }

  const SWALLOWED_GESTURE_EVENTS = ['mousedown', 'pointerup', 'mouseup', 'click', 'auxclick'];

  // rearm = true when capture is re-attached to a page the recording already
  // covers — after a full-page navigation, or a frame arming itself via
  // CONTENT_READY. In that case we only resume listening; we do NOT record a
  // goto/viewport, because the navigation was already produced by the
  // previously-recorded action (the frameworks auto-wait for it).
  // `paused` carries background's last-known pause state across the rearm: this is a
  // fresh JS context that has never seen a PAUSE_RECORDING message, so without it a
  // paused recording would silently resume capturing on every new page.
  // Idempotent: a second START_RECORDING (the navigation rearm racing the frame's
  // own CONTENT_READY) only updates pause/assert state.
  function startRecording(rearm, paused, assertState) {
    if (tornDown) return;
    if (isRecording) {
      if (typeof paused === 'boolean') setPaused(paused);
      else if (!rearm) setPaused(false);
      applyAssertState(assertState);
      return;
    }
    recordActionSeq = 0;
    isRecording = true;
    isPaused = !!paused;
    assertMode = false;
    _recentClicks = [];
    applyAssertState(assertState);
    if (typeof PointerEvent !== 'undefined') {
      window.addEventListener('pointerdown', onRecordPrimaryPointer, _recordPointerOptions);
    } else {
      window.addEventListener('mousedown', onRecordPrimaryPointer, true);
    }
    SWALLOWED_GESTURE_EVENTS.forEach((t) => window.addEventListener(t, onRecordSwallow, true));
    document.addEventListener('input', onRecordInputForDebounce, true);
    document.addEventListener('change', onRecordChange, true);
    document.addEventListener('keydown', onRecordKeydown, true);
    document.addEventListener('dblclick', onRecordDblClick, true);
    document.addEventListener('focusin', adoptShadowRoots, true);
    document.addEventListener('visibilitychange', onRecordVisibility, true);
    window.addEventListener('pagehide', onRecordPageHide, true);
    window.addEventListener('beforeunload', onRecordPageHide, true);
    updateFrameWatcher();
    debugLog('Recording started.' + (rearm ? ' (resumed after navigation)' : ''));

    // Only the top document opens the flow: every frame used to add its own
    // goto(<iframe src>) + viewport, so a page with three iframes started with four
    // navigations, the last one into an iframe.
    if (rearm || window !== window.top) return;

    const now = Date.now();
    const href = redactUrl(window.location.href);
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
    // A keystroke made just before Stop is part of this recording — emit it now
    // rather than dropping it (or, as it once did, leaking it into the next session).
    flushPendingFills();
    isRecording = false;
    isPaused = false;
    assertMode = false;
    _recentClicks = [];
    _swallowGestureUntil = 0;
    window.removeEventListener('pointerdown', onRecordPrimaryPointer, _recordPointerOptions);
    window.removeEventListener('mousedown', onRecordPrimaryPointer, true);
    SWALLOWED_GESTURE_EVENTS.forEach((t) => window.removeEventListener(t, onRecordSwallow, true));
    document.removeEventListener('input', onRecordInputForDebounce, true);
    document.removeEventListener('change', onRecordChange, true);
    document.removeEventListener('keydown', onRecordKeydown, true);
    document.removeEventListener('dblclick', onRecordDblClick, true);
    document.removeEventListener('focusin', adoptShadowRoots, true);
    document.removeEventListener('visibilitychange', onRecordVisibility, true);
    window.removeEventListener('pagehide', onRecordPageHide, true);
    window.removeEventListener('beforeunload', onRecordPageHide, true);
    _shadowChangeRoots.forEach((root) => root.removeEventListener('change', onRecordChange, true));
    _shadowChangeRoots.clear();
    updateFrameWatcher();
    debugLog('Recording stopped.');
  }

  // ── New-frame watcher (C3) ────────────────────────────────────────────────
  // Frames added (or re-pointed) after recording/inspect started have no content
  // script: the manifest only injects the top frame. Ask background to inject; the
  // new frame then arms itself through CONTENT_READY.
  //
  // Shadow DOM: a MutationObserver on the document never sees mutations inside a
  // shadow root, and an <iframe>'s `load` neither bubbles nor composes, so it never
  // leaves the shadow root either. An iframe rendered by a web component (Lit,
  // Stencil, a payment or chat widget) used to stay script-less for good. So the
  // same observer and a capture `load` listener are attached to every open shadow
  // root as well: the ones present when watching starts (one walk), and the ones
  // found later in added subtrees, under a mutated host, or on a custom element
  // that only upgrades (attachShadow) after it was inserted — those are polled,
  // cheaply, until they get a root. Patching attachShadow is not an option: this
  // script runs in an isolated world, so page scripts never see such a patch.
  // Out of reach: closed shadow roots (host.shadowRoot is null to everyone but
  // their owner), and a non-custom element that attaches a root long after it was
  // inserted with no DOM change around it afterwards.
  let frameObserver = null;
  let frameRequestTimer = null;
  let shadowPollTimer = null;
  const FRAME_REQUEST_DEBOUNCE_MS = 350;
  const SHADOW_POLL_MS = 1000;
  const MAX_WATCHED_SHADOW_ROOTS = 5000; // bounds observers + listeners on huge component trees
  const MAX_PENDING_SHADOW_HOSTS = 2000; // bounds the per-tick poll
  const FRAME_OBSERVE_OPTIONS = { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] };
  const _frameShadowRoots = new Set();   // observed, each with a capture `load` listener
  const _pendingShadowHosts = new Set(); // custom elements with no shadow root (yet)

  function isFrameEl(n) {
    if (!n || n.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = n.tagName.toLowerCase();
    return tag === 'iframe' || tag === 'frame';
  }

  function containsFrame(n) {
    if (!n || n.nodeType !== Node.ELEMENT_NODE) return false;
    if (isFrameEl(n)) return true;
    try { return !!n.querySelector('iframe, frame'); } catch (err) { return false; }
  }

  function isShadowRoot(n) {
    return !!n && n.nodeType === Node.DOCUMENT_FRAGMENT_NODE && !!n.host;
  }

  function requestFrameInjection() {
    if (frameRequestTimer) return; // one request per burst of DOM churn
    frameRequestTimer = setTimeout(() => {
      frameRequestTimer = null;
      if (isRecording || isInspecting) safeSend({ type: 'REQUEST_FRAME_INJECTION' });
    }, FRAME_REQUEST_DEBOUNCE_MS);
  }

  // A frame navigating on its own (a link inside it) loads a fresh, script-less
  // document; its <iframe> fires `load` in our document (or its shadow root), which
  // capture sees.
  function onFrameLoad(e) {
    if (isFrameEl(e.target)) requestFrameInjection();
  }

  function watchShadowRoot(sr) {
    if (!frameObserver || _frameShadowRoots.has(sr) || _frameShadowRoots.size >= MAX_WATCHED_SHADOW_ROOTS) return false;
    try {
      frameObserver.observe(sr, FRAME_OBSERVE_OPTIONS);
      sr.addEventListener('load', onFrameLoad, true);
    } catch (err) {
      return false;
    }
    _frameShadowRoots.add(sr);
    return true;
  }

  /**
   * Watch every open shadow root at or under `start` (an element or a shadow root),
   * nested ones included. Walks only the given subtree and the roots newly found in
   * it — never the whole document again. Returns true when a newly watched root
   * already holds a frame (it was filled before we could observe it), unless
   * `quiet` (the initial sweep: frames present at start were injected with it).
   */
  function watchShadowTrees(start, quiet) {
    if (!start || !frameObserver) return false;
    let sawFrame = false;
    const trees = [];
    const adopt = (sr) => {
      if (!watchShadowRoot(sr)) return;
      if (!quiet) {
        try { if (sr.querySelector('iframe, frame')) sawFrame = true; } catch (err) { /* detached */ }
      }
      trees.push(sr);
    };
    if (isShadowRoot(start)) adopt(start);
    else if (start.nodeType === Node.ELEMENT_NODE) trees.push(start);
    while (trees.length) {
      const tree = trees.pop();
      const doc = tree.ownerDocument || document;
      let walker;
      try { walker = doc.createTreeWalker(tree, NodeFilter.SHOW_ELEMENT); } catch (err) { continue; }
      // The walker stays inside this tree; shadow roots are queued as trees of their own.
      for (let n = tree.nodeType === Node.ELEMENT_NODE ? tree : walker.nextNode(); n; n = walker.nextNode()) {
        const sr = n.shadowRoot;
        if (sr) {
          if (!_frameShadowRoots.has(sr)) adopt(sr);
        } else if (n.localName && n.localName.indexOf('-') > 0 && _pendingShadowHosts.size < MAX_PENDING_SHADOW_HOSTS) {
          _pendingShadowHosts.add(n); // may upgrade (and attach a root) later
        }
      }
    }
    scheduleShadowPoll();
    return sawFrame;
  }

  /** Late upgrades, and forgetting detached roots so they can be collected. */
  function pollShadowHosts() {
    shadowPollTimer = null;
    if (!frameObserver) return;
    let sawFrame = false;
    _pendingShadowHosts.forEach((el) => {
      if (!el.isConnected) { _pendingShadowHosts.delete(el); return; }
      const sr = el.shadowRoot;
      if (!sr) return;
      _pendingShadowHosts.delete(el);
      if (watchShadowTrees(sr, false)) sawFrame = true;
    });
    _frameShadowRoots.forEach((sr) => {
      if (sr.host && sr.host.isConnected) return;
      // Re-found by the added-subtree scan if the host is ever inserted again.
      sr.removeEventListener('load', onFrameLoad, true);
      _frameShadowRoots.delete(sr);
    });
    if (sawFrame) requestFrameInjection();
    scheduleShadowPoll();
  }

  function scheduleShadowPoll() {
    if (shadowPollTimer || !frameObserver) return;
    if (!_pendingShadowHosts.size && !_frameShadowRoots.size) return; // nothing to poll or prune
    shadowPollTimer = setTimeout(pollShadowHosts, SHADOW_POLL_MS);
  }

  function onFrameMutations(records) {
    let sawFrame = false;
    for (const r of records) {
      if (r.type === 'attributes') {
        if (isFrameEl(r.target)) sawFrame = true;
        continue;
      }
      if (!r.addedNodes.length) continue; // removals add no frames
      // A host that attached its root after insertion, noticed as its light DOM grows.
      const host = r.target;
      if (host && host.shadowRoot && !_frameShadowRoots.has(host.shadowRoot)) {
        _pendingShadowHosts.delete(host);
        if (watchShadowTrees(host.shadowRoot, false)) sawFrame = true;
      }
      for (const n of r.addedNodes) {
        if (n.nodeType !== Node.ELEMENT_NODE) continue;
        if (containsFrame(n)) sawFrame = true;
        // Only the added subtree is walked, and only while it is still in the page.
        if (n.isConnected && watchShadowTrees(n, false)) sawFrame = true;
      }
    }
    if (sawFrame) requestFrameInjection();
  }

  function updateFrameWatcher() {
    const want = (isRecording || isInspecting) && !tornDown;
    if (want && !frameObserver) {
      if (typeof MutationObserver === 'undefined' || !document.documentElement) return;
      frameObserver = new MutationObserver(onFrameMutations);
      frameObserver.observe(document.documentElement, FRAME_OBSERVE_OPTIONS);
      document.addEventListener('load', onFrameLoad, true);
      watchShadowTrees(document.documentElement, true);
    } else if (!want && frameObserver) {
      frameObserver.disconnect(); // every observed root, the document's included
      frameObserver = null;
      document.removeEventListener('load', onFrameLoad, true);
      _frameShadowRoots.forEach((sr) => sr.removeEventListener('load', onFrameLoad, true));
      _frameShadowRoots.clear();
      _pendingShadowHosts.clear();
      if (shadowPollTimer) { clearTimeout(shadowPollTimer); shadowPollTimer = null; }
      if (frameRequestTimer) { clearTimeout(frameRequestTimer); frameRequestTimer = null; }
    }
  }

  if (ownChrome.storage && ownChrome.storage.local) {
    ownChrome.storage.local.get(['customAttributes', 'llFramework', 'llLanguage', 'llDebug'], (res) => {
      if (ownChrome.runtime.lastError) return;
      if (res && res.customAttributes && res.customAttributes.length > 0) {
        customTestAttributes = [...res.customAttributes, ...customTestAttributes];
        // Remove duplicates
        customTestAttributes = [...new Set(customTestAttributes)];
      }
      if (res && res.llFramework) llFramework = res.llFramework;
      if (res && res.llLanguage) llLanguage = res.llLanguage;
      llDebug = !!(res && res.llDebug);
    });

    ownChrome.storage.onChanged.addListener(onStorageChanged);
  }

  function onStorageChanged(changes, namespace) {
    if (tornDown || namespace !== 'local') return;
    if (changes.customAttributes) {
      let newAttrs = changes.customAttributes.newValue || [];
      customTestAttributes = [...newAttrs, 'data-testid', 'data-qa', 'data-cy', 'data-test', 'data-automation-id', 'data-e2e'];
      customTestAttributes = [...new Set(customTestAttributes)];
    }
    if (changes.llFramework) llFramework = changes.llFramework.newValue || 'playwright';
    if (changes.llLanguage) llLanguage = changes.llLanguage.newValue || 'typescript';
    if (changes.llDebug) llDebug = !!changes.llDebug.newValue;
  }

  // ── Deep-Tracing Engine (Shadow DOM X-Ray) ────────────────────────────────
  function getDeepElementAt(x, y) {
    if (typeof document.elementFromPoint !== 'function') return null;
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot && typeof el.shadowRoot.elementFromPoint === 'function') {
      const shadowEl = el.shadowRoot.elementFromPoint(x, y);
      if (!shadowEl || shadowEl === el) break;
      el = shadowEl;
    }
    return el;
  }

  // ── Track right-clicked element (always active for context menu) ───────────
  // The event's own composed path names the element even for a keyboard-opened
  // menu (Shift+F10, clientX/Y = 0), where hit-testing would find the top-left one.
  function onContextMenuTrack(e) {
    if (tornDown) return;
    lastRightClickedEl = resolvePrimaryTarget(e) || getDeepElementAt(e.clientX, e.clientY);
  }
  document.addEventListener('contextmenu', onContextMenuTrack, true);

  // ── Styles injected into the page ─────────────────────────────────────────
  // Called by startInspect() and by the toasts. Selector Lab highlights are inline
  // styles (see addLabHighlight), so they need no stylesheet — and so they also
  // show inside shadow roots, which a document-level sheet cannot style.
  function injectStyles() {
    if (document.getElementById('ll-styles')) return;
    const mount = document.head || document.documentElement;
    if (!mount) return;
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
      #ll-tooltip .ll-hint { color: #a5aac2; font-size: 9px; margin-top: 3px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; white-space: normal !important; }
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
    mount.appendChild(style);
  }

  // ── Selector Lab highlight bookkeeping ────────────────────────────────────
  // Highlights are inline styles, saved and restored per property, plus a
  // data-locatra-lab marker. A class (the old .ll-lab-highlight) leaked into every
  // CSS locator generated while it was on, and a document-level stylesheet never
  // reaches inside shadow roots. Track the elements we marked instead of
  // re-querying: querySelectorAll never sees inside shadow roots either.
  const LAB_ATTR = 'data-locatra-lab';
  const LAB_STYLE = [
    ['outline', '4px solid #ff00ff'],
    ['outline-offset', '-4px'],
    ['box-shadow', '0 0 12px rgba(255, 0, 255, 0.4)']
  ];
  let labHighlighted = [];
  function addLabHighlight(el) {
    if (!el || !el.style || el.hasAttribute(LAB_ATTR)) return;
    const saved = LAB_STYLE.map(([prop]) => [prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
    const hadStyleAttr = el.hasAttribute('style');
    LAB_STYLE.forEach(([prop, value]) => el.style.setProperty(prop, value, 'important'));
    el.setAttribute(LAB_ATTR, '');
    labHighlighted.push({ el, saved, hadStyleAttr });
  }
  function clearLabHighlights() {
    labHighlighted.forEach(({ el, saved, hadStyleAttr }) => {
      try {
        saved.forEach(([prop, value, priority]) => {
          if (value) el.style.setProperty(prop, value, priority);
          else el.style.removeProperty(prop);
        });
        el.removeAttribute(LAB_ATTR);
        if (!hadStyleAttr && el.getAttribute('style') === '') el.removeAttribute('style');
      } catch (e) { /* detached */ }
    });
    labHighlighted = [];
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
    ttHint.textContent = 'Click or Enter to analyze · ▲/▼ to navigate · Esc to stop';
    tooltip.appendChild(ttHint);

    // Position tooltip: prefer below, fall back to above
    const TH = 64, TW = 300; // TH allows for the hint wrapping onto a second line
    let ty = r.bottom + 8;
    let tx = r.left;
    if (ty + TH > window.innerHeight) ty = r.top - TH - 8;
    if (tx + TW > window.innerWidth) tx = window.innerWidth - TW - 8;
    tx = Math.max(4, tx);
    ty = Math.max(4, ty);

    // The traversal bar hangs flush under the element's right edge, and the tooltip
    // sits under its left edge — on any element narrower than both combined they
    // overlapped, and the bar covered the tooltip's "Esc to stop" hint. Move the
    // tooltip clear of the bar: below it if there is room, otherwise above the element.
    const bar = traversalBar ? traversalBarPosition(r) : null;
    if (bar && tx < bar.x + bar.w && tx + TW > bar.x && ty < bar.y + bar.h && ty + TH > bar.y) {
      const belowBar = bar.y + bar.h + 6;
      const aboveEl = r.top - TH - 8;
      if (belowBar + TH <= window.innerHeight) ty = belowBar;
      else if (aboveEl >= 4) ty = aboveEl;
    }

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

    // Position traversal bar flush against the bottom-right of the overlay (or
    // above it near the viewport edge). There is deliberately no gap: a gap meant
    // the pointer crossed some other element on its way to the bar, which
    // re-targeted the selection — and moved the bar — before it could be clicked.
    if (bar) {
      const bx = bar.x, by = bar.y;
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

  /** Where the traversal bar goes for an element rect: flush under its right edge. */
  function traversalBarPosition(r) {
    const BW = 260, BH = 34;
    let bx = r.right - BW;
    let by = r.bottom;
    if (by + BH > window.innerHeight) by = r.top - BH;
    if (by < 4) by = Math.min(Math.max(4, r.bottom - BH), Math.max(4, window.innerHeight - BH - 4));
    if (bx < 4) bx = 4;
    if (bx + BW > window.innerWidth) bx = window.innerWidth - BW - 4;
    return { x: bx, y: by, w: BW, h: BH };
  }

  // ── Traversal helpers ──────────────────────────────────────────────────────
  // After ▲/▼ the selection is locked to the traversed element: hit-testing would
  // otherwise re-pick whatever is under the pointer (the original leaf) on the
  // next mouseover or click, so traversal had no visible effect. The lock holds
  // while the pointer stays within the anchor/selected elements (or the toolbar)
  // and is released once it moves somewhere else.
  // { anchor: Element, barRects: DOMRect[] } — the element traversal started from,
  // and every spot the toolbar occupied when ▲/▼ was clicked (the bar moves with
  // the selection, leaving the pointer where it used to be).
  let traversalLock = null;
  const LOCK_SLOP_PX = 12;

  function lockTraversal() {
    if (!hoveredEl) return;
    if (!traversalLock) traversalLock = { anchor: hoveredEl, barRects: [] };
    if (traversalBar && traversalLock.barRects.length < 32) {
      traversalLock.barRects.push(traversalBar.getBoundingClientRect());
    }
  }

  function inRect(r, x, y) {
    return !!r && x >= r.left - LOCK_SLOP_PX && x <= r.right + LOCK_SLOP_PX &&
      y >= r.top - LOCK_SLOP_PX && y <= r.bottom + LOCK_SLOP_PX;
  }

  function rectContains(el, x, y) {
    if (!el || !el.isConnected || typeof el.getBoundingClientRect !== 'function') return false;
    return inRect(el.getBoundingClientRect(), x, y);
  }

  function inTraversalLockZone(x, y) {
    if (!traversalLock || !hoveredEl || !hoveredEl.isConnected) return false;
    return rectContains(hoveredEl, x, y) || rectContains(traversalLock.anchor, x, y) ||
      rectContains(traversalBar, x, y) || traversalLock.barRects.some((r) => inRect(r, x, y));
  }

  // Never navigated into: they draw nothing, so ▼ used to land on a shadow root's
  // <style> and the overlay vanished.
  const NON_RENDERED_TAGS = ['style', 'script', 'template', 'meta', 'link', 'noscript', 'title', 'base', 'head'];

  function isRenderedElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (NON_RENDERED_TAGS.includes(el.tagName.toLowerCase())) return false;
    if (el.hidden) return false;
    let cs = null;
    try { cs = getComputedStyle(el); } catch (err) { cs = null; }
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
    if (cs && cs.display === 'contents') return true; // no box of its own, but its children draw
    const r = el.getBoundingClientRect();
    if (r.width > 0 || r.height > 0) return true;
    // Zero-size — unless the document has no layout at all (nothing can be judged).
    const root = document.documentElement.getBoundingClientRect();
    return root.width === 0 && root.height === 0;
  }

  /** Children in the order they render: shadow content (slots expanded), then light DOM. */
  function traversalChildren(el) {
    const out = [];
    const push = (n) => {
      if (!n || n.nodeType !== Node.ELEMENT_NODE) return;
      if (n.tagName.toLowerCase() === 'slot' && typeof n.assignedElements === 'function') {
        const assigned = n.assignedElements({ flatten: true });
        if (assigned.length) { assigned.forEach(push); return; }
      }
      out.push(n);
    };
    if (el.shadowRoot) Array.from(el.shadowRoot.children).forEach(push);
    Array.from(el.children).forEach((c) => { if (!out.includes(c)) out.push(c); });
    return out;
  }

  function navigateParent() {
    if (!hoveredEl) return;
    let parent = hoveredEl.parentElement;

    // 🧬 Shadow Boundary Jump: If no parent, check if we are in a shadow root
    if (!parent) {
      const root = hoveredEl.getRootNode();
      if (root instanceof ShadowRoot) parent = root.host;
    }

    if (parent && parent !== document.body && parent !== document.documentElement && parent.nodeType === Node.ELEMENT_NODE) {
      lockTraversal();
      hoveredEl = parent;
      updateOverlay(hoveredEl);
    }
  }

  function navigateChild() {
    if (!hoveredEl) return;

    // 🧬 Shadow Infiltration: a host's shadow content comes first, then light DOM.
    const child = traversalChildren(hoveredEl).find(isRenderedElement);

    if (child) {
      lockTraversal();
      hoveredEl = child;
      updateOverlay(hoveredEl);
    }
  }

  // ── Clipboard ──────────────────────────────────────────────────────────────
  // navigator.clipboard only exists in a secure context, and a content script
  // inherits the *page's* context — so on any http:// site it is undefined and
  // calling it threw straight out of the message listener, taking the context-menu
  // copy (and its sendResponse) with it. The textarea fallback is what actually
  // carries the copy on those pages.
  function copyTextFallback(text) {
    try {
      const host = document.body || document.documentElement;
      if (!host) return false;
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;';
      host.appendChild(ta);
      const selection = document.getSelection();
      const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (previous && selection) { selection.removeAllRanges(); selection.addRange(previous); }
      return ok;
    } catch (err) {
      return false;
    }
  }

  /** Resolves true only when the text really reached the clipboard. */
  function copyText(text) {
    if (!text) return Promise.resolve(false);
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text)
        .then(() => true)
        .catch(() => copyTextFallback(text));
    }
    return Promise.resolve(copyTextFallback(text));
  }

  // ── Toast notification ─────────────────────────────────────────────────────
  let toastTimer = null;
  /** `label` overrides the "Copied:" / "Copy blocked —" prefix (used for notices). */
  function showToast(locatorCode, ok, label) {
    // Remove any existing toast immediately
    const existing = document.getElementById('ll-toast');
    if (existing) existing.remove();
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }

    const copied = ok !== false;
    const toast = document.createElement('div');
    toast.id = 'll-toast';
    const toastIcon = document.createElement('span');
    toastIcon.className = 'll-toast-icon';
    toastIcon.textContent = copied ? '✅' : '⚠️';
    toast.appendChild(toastIcon);
    const toastWrap = document.createElement('span');
    const toastLabel = document.createElement('span');
    toastLabel.className = 'll-toast-label';
    // Saying "Copied" when the clipboard write failed sent people off to paste
    // nothing. The locator is still shown so it can be read off the screen.
    toastLabel.textContent = label != null ? label : (copied ? 'Copied: ' : 'Copy blocked — ');
    toastWrap.appendChild(toastLabel);
    const toastCode = document.createElement('span');
    toastCode.className = 'll-toast-code';
    toastCode.textContent = locatorCode;
    toastWrap.appendChild(toastCode);
    toast.appendChild(toastWrap);
    const host = document.body || document.documentElement;
    if (!host) return;
    host.appendChild(toast);

    // Auto-dismiss after 3s with fade-out
    toastTimer = setTimeout(() => {
      toast.classList.add('ll-toast-out');
      setTimeout(() => toast.remove(), 320);
    }, 3000);
  }


  // ── Frames ─────────────────────────────────────────────────────────────────
  // A locator generated inside an iframe is useless to a test runner unless it says
  // which frame to enter first. The engine deals in one document and knows nothing
  // about the frame tree, so the chain is computed here — this is the layer that can
  // actually see it — and wrapped around every target the engine produced.

  function attrQuote(v) {
    return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function cssEscape(v) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(v);
    return String(v).replace(/([^\w-])/g, '\\$1').replace(/^(\d)/, '\\3$1 ');
  }

  // Uniqueness is judged the way Playwright's frameLocator() resolves CSS: across
  // the composed tree. Its CSS engine pierces every open shadow root, and for `>`
  // (and descendant) combinators a shadow root's top-level children count the host
  // as their parent. An <iframe> inside a web component is therefore addressable by
  // plain CSS — but `#pay` must also be unique against same-id elements in other
  // shadow roots, which a per-document querySelectorAll never sees.

  /** The document and every open shadow root in it (closed roots are unreachable). */
  function openRootsOf(doc) {
    const roots = [doc];
    for (let i = 0; i < roots.length && roots.length < MAX_WATCHED_SHADOW_ROOTS; i++) {
      const walker = doc.createTreeWalker(roots[i], NodeFilter.SHOW_ELEMENT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.shadowRoot) roots.push(n.shadowRoot);
      }
    }
    return roots;
  }

  /** Every element in the composed tree matching a compound selector (no combinators across roots). */
  function composedMatches(roots, sel) {
    const out = [];
    roots.forEach((r) => Array.prototype.push.apply(out, r.querySelectorAll(sel)));
    return out;
  }

  /** Parent as Playwright's combinators see it: the parent element, or the shadow host. */
  function composedParent(n) {
    if (n.parentElement) return n.parentElement;
    const p = n.parentNode;
    return isShadowRoot(p) ? p.host : null;
  }

  /**
   * tag:nth-of-type steps from the frame up through any shadow hosts, joined with
   * `>`, anchored at the nearest ancestor with a composed-tree-unique id or at <html>.
   */
  function composedPathParts(fe, roots) {
    const parts = [];
    let n = fe;
    let guard = 0;
    while (n && n.nodeType === Node.ELEMENT_NODE && guard++ < 64) {
      if (n !== fe && n.id) {
        const anchor = '#' + cssEscape(n.id);
        let hits = [];
        try { hits = composedMatches(roots, anchor); } catch (err) { hits = []; }
        if (hits.length === 1 && hits[0] === n) {
          parts.unshift(anchor);
          return parts;
        }
      }
      let part = n.tagName.toLowerCase();
      const tree = n.parentNode; // element, shadow root or document: nth-of-type counts there
      if (tree && tree.children) {
        const same = Array.prototype.filter.call(tree.children, (c) => c.tagName === n.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
      parts.unshift(part);
      n = composedParent(n);
    }
    return parts;
  }

  /** Resolve an anchored `a > b > c` path with Playwright's shadow-piercing semantics. */
  function composedPathResolvesTo(parts, roots, fe) {
    if (!parts.length) return false;
    let set = composedMatches(roots, parts[0]);
    for (let i = 1; i < parts.length && set.length; i++) {
      const next = [];
      set.forEach((s) => {
        const kids = Array.prototype.slice.call(s.children);
        if (s.shadowRoot) Array.prototype.push.apply(kids, s.shadowRoot.children);
        kids.forEach((c) => { if (c.matches(parts[i]) && next.indexOf(c) === -1) next.push(c); });
      });
      set = next;
    }
    return set.length === 1 && set[0] === fe;
  }

  /**
   * A selector for `el` that is unique when run against `tree` alone (a document or
   * one shadow root) — the scope Selenium's findElement and Cypress's get/find
   * query in, neither of which pierces shadow roots. null if none verifies.
   */
  function treeSelectorFor(el, tree) {
    const unique = (sel) => {
      try {
        const m = tree.querySelectorAll(sel);
        return m.length === 1 && m[0] === el;
      } catch (err) {
        return false;
      }
    };
    const tag = el.tagName.toLowerCase();
    const candidates = [];
    if (el.id) candidates.push('#' + cssEscape(el.id));
    ['name', 'title', 'src'].forEach((attr) => {
      const v = el.getAttribute(attr);
      if (v) candidates.push(`${tag}[${attr}="${attrQuote(v)}"]`);
    });
    candidates.push(tag); // custom-element hosts are usually one of a kind
    for (const c of candidates) if (unique(c)) return c;
    const parts = [];
    let n = el;
    let guard = 0;
    while (n && n.nodeType === Node.ELEMENT_NODE && guard++ < 64) {
      let part = n.tagName.toLowerCase();
      const siblings = n.parentNode && n.parentNode.children;
      if (siblings) {
        const same = Array.prototype.filter.call(siblings, (c) => c.tagName === n.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
      parts.unshift(part);
      n = n.parentElement; // stops at the top of this tree
    }
    const path = parts.join(' > ');
    return unique(path) ? path : null;
  }

  /**
   * For an <iframe> inside shadow DOM: one selector per tree, outermost first —
   * the first host in the document, each further host in the previous host's
   * shadow root, the <iframe> in the last one. Selenium and Cypress walk it host by
   * host (getShadowRoot() / .shadow()); Playwright's pierced `>` path does not need
   * it. null for a light-DOM frame, a closed root, or a tree no selector verifies in.
   */
  function shadowPathFor(fe) {
    const path = [];
    let el = fe;
    let guard = 0;
    while (el && guard++ < 16) {
      const tree = el.getRootNode();
      const sel = treeSelectorFor(el, tree);
      if (!sel) return null;
      path.unshift(sel);
      if (!isShadowRoot(tree)) return path.length > 1 ? path : null;
      if (tree.host.shadowRoot !== tree) return null; // closed: no test tool reaches inside
      el = tree.host;
    }
    return null;
  }

  /**
   * A selector addressing this frame's <iframe> element *in its parent document*.
   * Every candidate is verified to match exactly this frame there: two widgets'
   * iframes sharing a name or title (common for ad/embed frames) used to produce a
   * selector that silently addressed the first one.
   */
  function frameSelectorFor(fe) {
    if (!fe) return null;
    try {
      const E = globalThis.__LocatorLensEngine;
      const doc = fe.ownerDocument;
      const inShadow = isShadowRoot(fe.getRootNode ? fe.getRootNode() : null);
      const roots = openRootsOf(doc);
      const isUnique = (sel) => {
        if (!sel) return false;
        try {
          const m = composedMatches(roots, sel);
          return m.length === 1 && m[0] === fe;
        } catch (err) {
          return false;
        }
      };
      const tag = fe.tagName.toLowerCase();
      const candidates = [];
      if (fe.id) candidates.push('#' + cssEscape(fe.id));
      ['name', 'title', 'src'].forEach((attr) => {
        const v = fe.getAttribute(attr);
        if (v) candidates.push(`${tag}[${attr}="${attrQuote(v)}"]`);
      });
      for (const c of candidates) if (isUnique(c)) return c;
      // Structural path, resolved against the parent document rather than ours. The
      // engine's builder stops at a shadow boundary, so a shadow-hosted frame skips
      // straight to the composed path below.
      const built = !inShadow && E && E.buildCSSSelector ? E.buildCSSSelector(fe, doc) : null;
      if (isUnique(built)) return built;
      const parts = composedPathParts(fe, roots);
      const path = parts.join(' > ');
      if (composedPathResolvesTo(parts, roots, fe)) return path;
      return built || path || null;
    } catch (err) {
      return null;
    }
  }

  /** Position among the parent's frames — the only handle a cross-origin frame has. */
  function frameIndexOf(win) {
    try {
      const siblings = win.parent.frames;
      for (let i = 0; i < siblings.length; i++) {
        if (siblings[i] === win) return i;
      }
    } catch (err) {
      /* even identity comparison can be blocked */
    }
    return 0;
  }

  /** Outermost frame first. Empty in the top document. */
  function frameChain() {
    const chain = [];
    let win = window;
    let guard = 0;
    while (win && win !== win.parent && guard++ < 8) {
      let selector = null;
      let shadow = false;
      let shadowPath = null;
      // frameElement is null across an origin boundary and throws when reaching
      // through a cross-origin ancestor — either way we fall back to the index.
      try {
        const fe = win.frameElement;
        selector = frameSelectorFor(fe);
        shadow = !!fe && isShadowRoot(fe.getRootNode());
        if (shadow && selector) shadowPath = shadowPathFor(fe);
      } catch (err) {
        selector = null;
        shadowPath = null;
      }
      chain.unshift({ selector, index: frameIndexOf(win), shadow, shadowPath });
      win = win.parent;
    }
    return chain;
  }

  function wrapInFrames(chain, target) {
    let wrapped = target;
    for (let i = chain.length - 1; i >= 0; i--) {
      wrapped = { kind: 'frame', selector: chain[i].selector, index: chain[i].index, child: wrapped };
      if (chain[i].shadowPath) wrapped.shadowPath = chain[i].shadowPath;
    }
    return wrapped;
  }

  function applyFramePath(result) {
    if (window.self === window.top) return result;
    const chain = frameChain();
    if (!chain.length) return result;

    const action = (result.elementData && result.elementData.suggestedAction) || 'click';
    const value = action === 'fill' ? 'your value' : (action === 'selectOption' ? 'option text' : '');
    (result.locators || []).forEach((l) => {
      if (!l || !l.target) return;
      l.target = wrapInFrames(chain, l.target);
      // Re-render the display strings from the wrapped target so the card can never
      // show a bare locator that would resolve against the top document.
      if (window.LLCodegen) {
        const expr = window.LLCodegen.locatorExpr(l.target, 'playwright', 'typescript');
        const stmt = window.LLCodegen.actionStatement({ action, target: l.target, value }, 'playwright', 'typescript');
        if (expr) l.code = expr;
        if (stmt) l.fullCode = stmt;
      }
    });

    const path = chain.map((f) => f.selector || `iframe (index ${f.index})`);
    if (result.elementData) result.elementData.framePath = path;
    const approximate = chain.some((f) => !f.selector);
    result.proTip = `Inside ${chain.length > 1 ? 'nested iframes' : 'an iframe'} (${path.join(' › ')}). ` +
      (approximate
        ? 'This frame is cross-origin, so its <iframe> element cannot be read from here and the generated code addresses it by position — pin it to a stable selector if the page order can change. '
        : '') +
      (chain.some((f) => f.shadow && f.selector)
        ? (chain.every((f) => !f.shadow || f.shadowPath)
          ? 'Its <iframe> lives inside a shadow root: Playwright\'s CSS reaches into open shadow roots, and the Selenium and Cypress code steps through each host\'s shadow root (getShadowRoot() / .shadow()) to find it. '
          : 'Its <iframe> lives inside a shadow root: Playwright\'s CSS reaches into open shadow roots, but Cypress needs includeShadowDom and Selenium has to find it through the host\'s shadow root (getShadowRoot()). ')
        : '') +
      'Selenium switches into the frame and back out again around the action; Playwright and Cypress address it inline.';
    return result;
  }

  function generateLocators(el) {
    const E = globalThis.__LocatorLensEngine;
    if (!E) {
      console.error('[Locatra] Missing __LocatorLensEngine — ensure content-locator-engine.js is listed before content.js in the manifest.');
      return { elementData: {}, locators: [], avoidList: [], proTip: '', a11y: [] };
    }
    // Everything — picks, recording, quick-copy — routes through here, so frame
    // wrapping applies once, in one place.
    return carryMatchCounts(applyFramePath(E.generateLocators(el, customTestAttributes)));
  }

  // The engine reports uniqueness on the locator, but recorded steps keep only its
  // structured target — and codegen reads the target to decide whether an unnamed
  // role locator needs a "may match several elements" note. Copy it across so the
  // note appears only where the engine actually found more than one match.
  function carryMatchCounts(result) {
    if (!result || !Array.isArray(result.locators)) return result;
    result.locators.forEach((loc) => {
      if (!loc || !loc.target || typeof loc.target !== 'object') return;
      if (typeof loc.matchCount === 'number' && loc.target.matchCount == null) loc.target.matchCount = loc.matchCount;
      if (typeof loc.unique === 'boolean' && loc.target.unique == null) loc.target.unique = loc.unique;
    });
    return result;
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
    const el = getDeepElementAt(e.clientX, e.clientY) || resolvePrimaryTarget(e);
    if (!el) return;

    // Ignore our own UI elements
    if (el === traversalBar || isOwnUi(el)) return;

    // Keep a traversed (▲/▼) selection while the pointer is still on it, its
    // starting element, or the toolbar.
    if (traversalLock) {
      if (inTraversalLockZone(e.clientX, e.clientY)) return;
      traversalLock = null;
    }

    hoveredEl = el;
    updateOverlay(el);
  }

  function isTraversalBarEvent(e) {
    if (!traversalBar) return false;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    return path.includes(traversalBar) || traversalBar.contains(e.target);
  }

  /** Where the page URL can be read (a cross-origin parent hides it), the top page's. */
  function pageInfo() {
    const frameUrl = redactUrl(window.location.href);
    let pageUrl = frameUrl;
    if (window !== window.top) {
      try { pageUrl = redactUrl(window.top.location.href); } catch (err) { pageUrl = redactUrl(document.referrer || window.location.href); }
    }
    return { pageUrl, frameUrl };
  }

  function pickElement(el) {
    lastPickedEl = el; // remember for Stress Test even after inspect stops

    const result = generateLocators(el);

    const bestCode = result.locators[0] ? copyLocatorCode(result.locators[0]) : '';
    if (bestCode) {
      copyText(bestCode).then((ok) => showToast(bestCode, ok));
    }

    // Flash the overlay green
    if (overlay) {
      overlay.style.background = 'rgba(58, 223, 250, 0.25)';
      setTimeout(() => {
        if (overlay) overlay.style.background = 'rgba(58, 223, 250, 0.05)';
      }, 300);
    }

    // The panel receives this twice — once as a broadcast (runtime.sendMessage
    // reaches every extension page) and once relayed by the worker over the port.
    // runtime.sendMessage cannot address the worker alone, so the pick carries an id
    // and the panel renders only the first copy it sees.
    result.pickId = nextRecordEventId();
    Object.assign(result, pageInfo());

    // A failed send here means Locatra was reloaded or updated while this page
    // stayed open. Nothing will ever answer again, so tear the overlay down instead
    // of leaving a dead crosshair cursor on someone's site.
    if (!safeSend({ type: 'ELEMENT_PICKED', data: result })) {
      debugWarn('Extension context invalidated. Please refresh the page.');
      stopInspect();
    }
  }

  // Picking must not drive the page: the click was already suppressed, but the
  // pointerdown / mousedown / mouseup before it still opened menus, started drags
  // and moved focus. Everything but the context menu is swallowed at window
  // capture — before any page listener — while inspecting.
  const INSPECT_SWALLOWED_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'auxclick', 'dblclick'];
  function onInspectSwallow(e) {
    if (!isInspecting || !isUserEvent(e) || isTraversalBarEvent(e)) return;
    swallow(e);
  }

  function onClick(e) {
    if (!isInspecting) return;
    // A page's own el.click() / dispatchEvent while inspecting has clientX/Y = 0:
    // it used to "pick" the top-left element and overwrite the clipboard.
    if (!isUserEvent(e)) return;
    // Let traversal bar button clicks go through (they have their own handlers)
    if (isTraversalBarEvent(e)) return;

    swallow(e);
    if (typeof e.button === 'number' && e.button !== 0) return;

    // After ▲/▼ the traversed element is the selection — re-hit-testing here used
    // to pick the leaf under the pointer and silently discard the traversal.
    let el = null;
    if (traversalLock && hoveredEl && hoveredEl.isConnected && inTraversalLockZone(e.clientX, e.clientY)) {
      el = hoveredEl;
    } else {
      el = getDeepElementAt(e.clientX, e.clientY) || resolvePrimaryTarget(e);
    }
    if (!el || isOwnUi(el)) return;
    pickElement(el);
  }

  function onKeyDown(e) {
    if (!isInspecting) return;

    if (e.key === 'Escape') {
      stopInspect();
      safeSend({ type: 'STOP_INSPECT' });
      return;
    }

    // Enter picks the current selection — the keyboard way to take a traversed element.
    if (e.key === 'Enter' && hoveredEl && hoveredEl.isConnected && isUserEvent(e)) {
      swallow(e);
      pickElement(hoveredEl);
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
    if (isInspecting || tornDown) return;
    if (!document.body) return; // nothing to overlay (e.g. a bare XML document)
    isInspecting = true;
    traversalLock = null;
    injectStyles();
    createOverlay();
    document.body.classList.add('ll-inspecting');
    document.addEventListener('mouseover', onMouseOver, true);
    // Window capture runs before any listener the page registers on document.
    window.addEventListener('click', onClick, true);
    INSPECT_SWALLOWED_EVENTS.forEach((t) => window.addEventListener(t, onInspectSwallow, true));
    document.addEventListener('keydown', onKeyDown, true);
    updateFrameWatcher();
  }

  function stopInspect() {
    isInspecting = false;
    if (document.body) document.body.classList.remove('ll-inspecting');

    // Total Decommission: Remove all tracking listeners
    document.removeEventListener('mouseover', onMouseOver, true);
    window.removeEventListener('click', onClick, true);
    INSPECT_SWALLOWED_EVENTS.forEach((t) => window.removeEventListener(t, onInspectSwallow, true));
    document.removeEventListener('keydown', onKeyDown, true);

    removeOverlay();
    hoveredEl = null;
    traversalLock = null;
    lastRightClickedEl = null;
    updateFrameWatcher();

    debugLog('Inspection deactivated.');
  }

  // ── Context-menu copy feedback ─────────────────────────────────────────────
  // One flash at a time: a second copy within 800ms used to save the first flash's
  // green outline as the "original" and restore it — leaving it on for good.
  let ctxFlash = null;
  function restoreCtxFlash() {
    if (!ctxFlash) return;
    const f = ctxFlash;
    ctxFlash = null;
    clearTimeout(f.timer);
    try {
      f.el.style.outline = f.outline;
      f.el.style.transition = f.transition;
    } catch (err) { /* detached */ }
  }
  function flashCopied(target) {
    if (!target || !target.style) return;
    restoreCtxFlash();
    ctxFlash = { el: target, outline: target.style.outline, transition: target.style.transition, timer: null };
    target.style.transition = 'outline 0.1s';
    target.style.outline = '3px solid #00ff9d';
    ctxFlash.timer = setTimeout(restoreCtxFlash, 800);
  }

  /** C10: the element the context menu was opened on, or null — never <body>. */
  function resolveContextMenuTarget(msg) {
    let target = null;
    if (msg && msg.targetElementId != null && typeof browser !== 'undefined' && browser.menus &&
        typeof browser.menus.getTargetElement === 'function') {
      try { target = browser.menus.getTargetElement(msg.targetElementId); } catch (err) { target = null; }
    }
    if (target && target.nodeType !== Node.ELEMENT_NODE) target = target.parentElement;
    if (!target || !target.isConnected) target = lastRightClickedEl;
    return target && target.isConnected ? target : null;
  }

  // ── Teardown (orphaned or superseded instance) ─────────────────────────────
  function teardown() {
    if (tornDown) return;
    tornDown = true; // first: nothing below may try to talk to the dead context
    try { stopRecording(); } catch (err) { /* best effort */ }
    try { stopInspect(); } catch (err) { /* best effort */ }
    try { clearLabHighlights(); } catch (err) { /* best effort */ }
    try { restoreCtxFlash(); } catch (err) { /* best effort */ }
    _pendingFills.forEach((t) => clearTimeout(t));
    _pendingFills.clear();
    document.removeEventListener('contextmenu', onContextMenuTrack, true);
    const styles = document.getElementById('ll-styles');
    if (styles) styles.remove();
    try { ownChrome.runtime.onMessage.removeListener(onMessage); } catch (err) { /* dead context */ }
    try { ownChrome.storage.onChanged.removeListener(onStorageChanged); } catch (err) { /* dead context */ }
    if (window.__LocatorLensInstance === instanceHandle) delete window.__LocatorLensInstance;
    lastPickedEl = null;
    lastRightClickedEl = null;
  }

  const instanceHandle = { isAlive: contextAlive, teardown };
  window.__LocatorLensInstance = instanceHandle;

  // 🛡️ INITIALIZATION: Force Neutral State
  // Ensure we don't start in an active state on page load/script injection
  stopInspect();

  // ── Message listener ───────────────────────────────────────────────────────
  function onMessage(msg, sender, sendResponse) {
    if (tornDown || !msg) return;
    if (msg.type === 'PING') {
      sendResponse({ ok: true });
    } else if (msg.type === 'START_INSPECT') {
      startInspect();
      sendResponse({ ok: true });
    } else if (msg.type === 'STOP_INSPECT') {
      stopInspect();
      sendResponse({ ok: true });
    }
    // 🎬 RECORDING: Start/Stop recording user interactions
    else if (msg.type === 'START_RECORDING') {
      startRecording(!!msg.rearm, typeof msg.paused === 'boolean' ? msg.paused : undefined, {
        assertMode: msg.assertMode,
        assertType: msg.assertType
      });
      sendResponse({ ok: true });
    }
    else if (msg.type === 'STOP_RECORDING') {
      stopRecording();
      sendResponse({ ok: true });
    }
    else if (msg.type === 'PAUSE_RECORDING') {
      setPaused(true);
      sendResponse({ ok: true });
    }
    else if (msg.type === 'RESUME_RECORDING') {
      setPaused(false);
      sendResponse({ ok: true });
    }
    else if (msg.type === 'SET_ASSERT_MODE') {
      applyAssertState({ assertMode: !!msg.on, assertType: msg.assertType });
      sendResponse({ ok: true });
    }
    // Handle context menu quick-copy
    else if (msg.type === 'CONTEXT_MENU_COPY') {
      const target = resolveContextMenuTarget(msg);
      if (!target) {
        // Copying a <body> locator (the old fallback) put garbage on the clipboard
        // — typical in a frame whose content script arrived after the right-click.
        injectStyles();
        showToast('Right-click the element again to copy its locator', false, '');
        sendResponse({ noTarget: true });
        return;
      }
      const result = generateLocators(target);

      const bestCode = result.locators[0] ? copyLocatorCode(result.locators[0]) : '';
      if (bestCode) {
        copyText(bestCode).then((ok) => {
          // No user gesture reaches the page for a context-menu click, so the
          // execCommand fallback cannot run here either: on a non-secure page this
          // genuinely cannot copy. Say so and show the locator, instead of leaving
          // the menu item looking like it silently did nothing.
          if (!ok) {
            injectStyles();
            showToast(bestCode, false);
            return;
          }
          flashCopied(target);
        });
      }

      if (isInspecting) {
        result.pickId = nextRecordEventId();
        Object.assign(result, pageInfo());
        safeSend({ type: 'ELEMENT_PICKED', data: result });
      }
      sendResponse({ ok: true });
    }

    // 🔬 SELECTOR LAB: Validation Engine
    else if (msg.type === 'LAB_VALIDATE') {
      const { selector } = msg;
      let matches = [];
      let via = null;
      let truncated = false;
      // Highlights are inline styles (addLabHighlight): visible without Inspect
      // having injected anything, and inside shadow roots too.
      clearLabHighlights();

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
        // Upper bound on the elements a whole chain may scan. A chain such as
        // locator('div').getByText('a') resolves the second step once per match of
        // the first — on a big page that is millions of nodes and froze the tab.
        let labBudget = 200000;
        // Every scope a step searches. A chained step scoped to a shadow HOST
        // must also search host.shadowRoot — querySelectorAll(host) only sees the
        // light DOM, so chaining into a web component found nothing.
        const scopesOf = (root) => {
          if (root === document) return [document];
          return root.shadowRoot ? [root.shadowRoot, root] : [root];
        };
        const deepAll = (sel, root) => {
          const seen = new Set();
          const out = [];
          for (const scope of scopesOf(root)) {
            if (labBudget <= 0) { truncated = true; break; }
            let found = null;
            if (E && E.deepQueryAll) found = E.deepQueryAll(sel, scope, labBudget);
            if (!found) {
              if (sel !== '*') scope.querySelectorAll(sel); // throws on an invalid selector, as before
              found = Array.from(scope.querySelectorAll(sel));
            }
            labBudget -= found.length;
            for (const el of found) if (!seen.has(el)) { seen.add(el); out.push(el); }
          }
          return out;
        };
        const within = (root) => deepAll('*', root);

        // Upper bound on how many text/role matches we resolve. The innermost-match
        // filter below is O(n²) in `hit`, and a loose substring like "a" can match
        // most of a page — without a cap that pins the tab.
        const LAB_MAX_MATCHES = 300;

        const find = (method, args, root) => {
          const all = within(root);
          switch (method) {
            case 'getByRole': {
              const role = firstStr(args), name = opt(args, 'name'), exact = opt(args, 'exact') === true;
              if (!role || !E) return [];
              // Role first: isHidden() forces a style recalc per element, so it must
              // run on the few survivors rather than on every node in the document.
              return all.filter(el => E.getRole(el) === role &&
                (name == null || matchText(E.getAccessibleName(el), name, exact)) &&
                !isHidden(el));
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
              const hit = [];
              for (let k = 0; k < all.length && hit.length < LAB_MAX_MATCHES; k++) {
                const el = all[k];
                if (!matchText(el.innerText || el.textContent, t, exact)) continue;
                if (isHidden(el)) continue;
                hit.push(el);
              }
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
              try {
                return deepAll(sel, root);
              }
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
            // Set membership, not next.includes(el): the old O(n²) dedupe alone
            // could pin the tab on a chain with a few thousand matches.
            const seen = new Set();
            const next = [];
            for (const r of roots) {
              if (labBudget <= 0) { truncated = true; break; }
              for (const el of find(seg.method, seg.args, r)) if (!seen.has(el)) { seen.add(el); next.push(el); }
            }
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
          const engine = globalThis.__LocatorLensEngine;
          const deep = engine && engine.deepQueryAll ? engine.deepQueryAll(selector, document, Infinity) : null;
          matches = deep || Array.from(document.querySelectorAll(selector));
        }

        matches.forEach(el => {
          if (el && el.nodeType === Node.ELEMENT_NODE) addLabHighlight(el);
        });

        if (matches[0] && matches[0].scrollIntoView) {
          matches[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
        }

        safeSend({ type: 'LAB_STATUS_UPDATE', count: matches.length, via, truncated: truncated || undefined });
        sendResponse(truncated ? { ok: true, count: matches.length, truncated: true } : { ok: true, count: matches.length });
      } catch (err) {
        safeSend({ type: 'LAB_ERROR', error: err.message });
        sendResponse({ ok: false, error: err.message });
      }
    }

    else if (msg.type === 'LAB_CLEAR') {
      clearLabHighlights();
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

      try {
        const role = E.getRole(target);
        const name = E.getAccessibleName(target);
        const tag = target.tagName.toLowerCase();
        let survived = false;

        if (role && name) {
          // Count what getByRole(role, { name }) would really match: Playwright's
          // name match is a case-insensitive, whitespace-normalized SUBSTRING, and
          // the role can come from any tag (<a role=button> vs <button>). Counting
          // same-tag exact-name twins reported "survived" for locators that are
          // ambiguous. The exact variant (C5) counts as surviving when it is unique.
          const target = { kind: 'role', role, name };
          let count = null;
          if (typeof E.countTargetMatches === 'function') {
            count = E.countTargetMatches(target);
            if (typeof count === 'number' && count > 1 && E.countTargetMatches(Object.assign({}, target, { exact: true })) === 1) count = 1;
          }
          if (typeof count !== 'number') {
            // Shadow-DOM-piercing: a plain querySelectorAll would never see a
            // uniquely-named element living inside an open shadow root.
            const norm = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
            const wanted = norm(name);
            const wantedLower = wanted.toLowerCase();
            const candidates = E.deepQueryAll('*', document, 20000) || [];
            let loose = 0, exact = 0;
            for (const c of candidates) {
              if (E.getRole(c) !== role) continue;
              const n = norm(E.getAccessibleName(c));
              if (n.toLowerCase().includes(wantedLower)) loose++;
              if (n === wanted) exact++;
            }
            count = loose === 1 || exact === 1 ? 1 : loose;
          }
          survived = count === 1;
        }

        sendResponse({ ok: true, data: { survived, role, name, tag } });
      } catch (err) {
        sendResponse({ ok: true, data: { survived: false, unavailable: true } });
      }
    }
  }
  ownChrome.runtime.onMessage.addListener(onMessage);

  // ── Self-arming (C3) ───────────────────────────────────────────────────────
  // Every fresh document — a full-page navigation, a new or re-navigated iframe —
  // asks background whether its tab is being recorded or inspected, instead of
  // waiting for a re-arm that used to arrive only after `load` (losing the first
  // interactions) and never arrived in frames at all.
  function whenBodyReady(fn) {
    if (document.body) { fn(); return; }
    document.addEventListener('DOMContentLoaded', function onReady() {
      document.removeEventListener('DOMContentLoaded', onReady);
      if (!tornDown) fn();
    });
  }
  safeSend({ type: 'CONTENT_READY' }, (res) => {
    if (tornDown || !res || typeof res !== 'object') return;
    if (res.recording) {
      startRecording(true, !!res.paused, { assertMode: res.assertMode, assertType: res.assertType });
    }
    if (res.inspecting) whenBodyReady(startInspect);
  });
})();
