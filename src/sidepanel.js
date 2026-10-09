let isInspecting = false;
let isRecording = false;
let isPaused = false; // recording is live but paused; only meaningful while isRecording
let recordedActions = [];
let recLastPageUrl = '';
let _recorderSaveTimer = null;
const LL_RECORDER_STATE_KEY = 'llRecorderState';

// ── Output target (framework + language) ─────────────────────────────────────
// Drives how inspect locators and recorder steps are rendered. Persisted in storage.
let outFramework = 'playwright';
let outLanguage = 'typescript';
const LL_FW_KEY = 'llFramework';
const LL_LANG_KEY = 'llLanguage';

// Recorder UI state
let recFilter = '';          // timeline filter text
let recRedoStack = [];       // actions removed via undo, available to redo
let timelineExpanded = false; // collapsible timeline (collapsed by default)
let _recFilterTimer = null;

// ── Window scoping ───────────────────────────────────────────────────────────
// Each browser window has its own panel, and the background keeps one recording
// session per window. Everything this panel sends carries its windowId (so the
// background acts on THIS window's session/active tab, not whichever window has
// focus), and anything addressed to another window is ignored.
let panelWindowId = null;
let _windowIdResolved = false;
const _windowIdWaiters = [];

function resolvePanelWindowId(id) {
  if (_windowIdResolved) return;
  panelWindowId = typeof id === 'number' ? id : null;
  _windowIdResolved = true;
  const waiters = _windowIdWaiters.splice(0);
  for (const fn of waiters) {
    try { fn(panelWindowId); } catch (e) { console.warn('[Locatra] window-id waiter failed:', e); }
  }
}

/** Runs fn(windowId) once the panel knows its window (synchronously if it already does). */
function whenWindowId(fn) {
  if (_windowIdResolved) fn(panelWindowId);
  else _windowIdWaiters.push(fn);
}

(function initPanelWindowId() {
  try {
    if (chrome.windows && typeof chrome.windows.getCurrent === 'function') {
      // Never wait forever: a panel that can't learn its window still has to work.
      const fallback = setTimeout(() => resolvePanelWindowId(null), 1500);
      chrome.windows.getCurrent((w) => {
        void chrome.runtime.lastError;
        clearTimeout(fallback);
        resolvePanelWindowId(w && w.id);
      });
      return;
    }
  } catch (e) {}
  resolvePanelWindowId(null);
})();

/**
 * runtime.sendMessage with this panel's windowId attached. `cb(res, err)` always
 * fires (err set when nothing answered), and lastError is always consumed so an
 * unanswered fire-and-forget message never surfaces as an uncaught error.
 */
function sendToBackground(msg, cb) {
  whenWindowId((windowId) => {
    const out = Object.assign({}, msg);
    if (typeof windowId === 'number') out.windowId = windowId;
    try {
      chrome.runtime.sendMessage(out, (res) => {
        const err = chrome.runtime.lastError;
        if (typeof cb === 'function') cb(err ? undefined : res, err || null);
      });
    } catch (e) {
      if (typeof cb === 'function') cb(undefined, e);
    }
  });
}

/** True when a relay names a window and it is not this panel's. */
function isForeignWindowMessage(msg) {
  return !!msg && typeof msg.windowId === 'number' &&
    typeof panelWindowId === 'number' && msg.windowId !== panelWindowId;
}

// ── Inline status line (replaces alert() for errors / results) ───────────────
let _panelStatusTimer = null;
function showPanelStatus(text, kind) {
  const el = document.getElementById('panelStatus');
  if (!el) return;
  if (_panelStatusTimer) { clearTimeout(_panelStatusTimer); _panelStatusTimer = null; }
  el.textContent = String(text || '');
  el.className = 'panel-status' + (kind ? ' ' + kind : '');
  el.hidden = !text;
  // Errors stay until the next action; informational notes fade on their own.
  if (text && kind !== 'err') {
    _panelStatusTimer = setTimeout(() => { el.hidden = true; el.textContent = ''; }, 6000);
  }
}
function clearPanelStatus() { showPanelStatus('', ''); }

// ── Safe DOM renderer ─────────────────────────────────────────────────────────
// Parses a trusted markup template off-document and adopts the nodes. DOMParser
// alone is NOT equivalent to sanitisation: <script> stays inert, but event-handler
// content attributes (onerror, onclick, …) are compiled once the node is adopted
// into this live document, so a parsed-then-appended string behaves like innerHTML.
// Every caller here builds markup from esc()'d values, and this scrub is the
// backstop that keeps that an invariant rather than a convention.
//
// Allowlist, not blocklist: a blocklist kept missing things (<style>, <form>,
// <base>, <meta>, SVG <animate>/<set>, formaction, srcdoc, xlink:href …). Only the
// handful of tags/attributes the panel's own templates use survive; anything else
// is dropped together with its subtree.
var SAFE_TAGS = [
  'div', 'span', 'strong', 'b', 'i', 'em', 'u', 'small', 'br', 'p', 'pre', 'code',
  'kbd', 'mark', 'sub', 'sup', 'ul', 'ol', 'li', 'button', 'a', 'img', 'label', 'hr'
];
var SAFE_ATTRS = ['class', 'id', 'title', 'style', 'role', 'type', 'tabindex', 'disabled', 'alt', 'href', 'src'];
var URL_ATTRS = ['href', 'src'];

function isSafeUrl(value) {
  // Browsers ignore control characters and whitespace inside a scheme
  // ("java\tscript:"), so strip them before looking at it.
  var raw = String(value);
  var v = '';
  for (var i = 0; i < raw.length; i++) {
    var c = raw.charCodeAt(i);
    if (c > 0x20 && (c < 0x7f || c > 0x9f)) v += raw[i];
  }
  var m = /^([a-z][a-z0-9+.-]*):/i.exec(v);
  if (!m) return true; // relative URL / fragment
  var scheme = m[1].toLowerCase();
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}

function isSafeAttr(name, value) {
  if (name.indexOf('data-') === 0 || name.indexOf('aria-') === 0) return /^[a-z0-9_.-]+$/.test(name);
  if (SAFE_ATTRS.indexOf(name) === -1) return false;
  if (URL_ATTRS.indexOf(name) !== -1) return isSafeUrl(value);
  if (name === 'style') return !/url\s*\(|expression\s*\(|@import|javascript:/i.test(value);
  return true;
}

function scrubNode(node) {
  if (node.nodeType === 8) { node.remove(); return; } // comments: nothing to keep
  if (node.nodeType !== 1) return;
  // Element in the HTML namespace with a tag the templates actually use — or gone.
  var tag = node.tagName.toLowerCase();
  if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || SAFE_TAGS.indexOf(tag) === -1) {
    node.remove();
    return;
  }
  var attrs = Array.prototype.slice.call(node.attributes);
  for (var i = 0; i < attrs.length; i++) {
    var name = attrs[i].name.toLowerCase();
    if (!isSafeAttr(name, attrs[i].value)) node.removeAttribute(attrs[i].name);
  }
  var children = Array.prototype.slice.call(node.childNodes);
  for (var j = 0; j < children.length; j++) scrubNode(children[j]);
}

function safeRender(el, html) {
  el.textContent = '';
  var doc = new DOMParser().parseFromString(String(html), 'text/html');
  var kids = Array.prototype.slice.call(doc.body.childNodes);
  for (var i = 0; i < kids.length; i++) scrubNode(kids[i]);
  while (doc.body.firstChild) el.appendChild(doc.body.firstChild);
}
let lastResultData = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Escape for *element content* only. Deliberately leaves ' and " alone: hl()'s
// output is inserted as a node's children, never into an attribute value, and the
// string-literal regex below needs the real quote characters to find literals.
// Anything bound for an attribute must use esc() instead.
function escHighlight(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Syntax highlighter shared by the locator cards and the Generated Test Script.
// String literals are protected first (via a  sentinel) so keyword/number rules
// never recolor text inside them; escaped quotes (e.g. Selenium's "[id=\"x\"]") are
// kept intact. Covers Playwright / Selenium / Cypress across JS / TS / Python.
function hl(code) {
  const SENT = String.fromCharCode(0); // sentinel — never appears in code
  let s = escHighlight(code);
  const STR_RE = /'(?:\\.|[^'\n])*'|"(?:\\.|[^"\n])*"/g;
  const strs = [];
  s = s.replace(STR_RE, (m) => { strs.push(m); return SENT; });
  s = s
    .replace(/\b(await|const|let|var|function|return|if|else|for|while|try|catch|finally|from|import|as|with|def|assert|describe|it|test|async|not|None|True|False)\b/g, '<span class="kw">$1</span>')
    .replace(/\b(page|browser|context|expect|driver|cy|webdriver|By|Key|Keys|Select|Builder|ActionChains)\b/g, '<span class="kw">$1</span>')
    .replace(/\b(getBy[A-Za-z]+|get_by_[a-z_]+|locator|click|dblclick|fill|check|uncheck|selectOption|select_option|select_by_visible_text|press|hover|goto|visit|get|contains|should|trigger|find_element|findElement|send_keys|sendKeys|move_to_element|move|perform|set_viewport_size|setViewportSize|set_window_size|isDisplayed|is_displayed|isSelected|is_selected|isEnabled|is_enabled|getText|getAttribute|get_attribute|to[A-Z][A-Za-z]+|to_[a-z_]+|not_to_[a-z_]+|strictEqual|ok)\b/g, '<span class="fn">$1</span>')
    .replace(/\b([0-9]+)\b/g, '<span class="num">$1</span>');
  let k = 0;
  s = s.replace(new RegExp(SENT, 'g'), () => '<span class="str">' + (strs[k++] || '') + '</span>');
  return s;
}

// Generated Test Script is an editable, syntax-highlighted contenteditable div.
function getPreviewText(el) {
  if (!el) return '';
  return el.innerText != null ? el.innerText : (el.textContent || '');
}
function setPreviewCode(el, code) {
  if (!el) return;
  safeRender(el, hl(code));
}

function pillClass(s) {
  const m = { BEST: 'p-best', GOOD: 'p-good', OK: 'p-ok', AVOID: 'p-avoid' };
  return m[String(s).toUpperCase()] || 'p-ok';
}
function pillLabel(s) {
  const m = { BEST: '★ BEST', GOOD: '✓ GOOD', OK: '~ OK', AVOID: '✗ AVOID' };
  return m[String(s).toUpperCase()] || s;
}

function rankClass(r) {
  return r === 1 ? 'r1' : r === 2 ? 'r2' : r === 3 ? 'r3' : 'rX';
}


function copyToClipboard(text, btn) {
  // Remember the button's real label once. Reading btn.textContent on every click
  // captured "✓ Copied" when clicked again within 2s, and the timer then "restored"
  // that, leaving the button stuck on "✓ Copied" for good.
  if (!btn.hasAttribute('data-label')) btn.setAttribute('data-label', btn.textContent);
  const originalLabel = btn.getAttribute('data-label');
  const restoreLater = () => {
    if (btn._llCopyTimer) clearTimeout(btn._llCopyTimer);
    btn._llCopyTimer = setTimeout(() => {
      btn._llCopyTimer = null;
      btn.textContent = originalLabel;
      btn.classList.remove('done');
    }, 2000);
  };
  const onSuccess = () => {
    btn.textContent = '✓ Copied';
    btn.classList.add('done');
    restoreLater();
  };

  const fallbackCopy = () => {
    try {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      onSuccess();
    } catch (e) {
      btn.textContent = 'Copy failed';
      btn.classList.remove('done');
      restoreLater();
    }
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(onSuccess).catch(fallbackCopy);
  } else {
    fallbackCopy();
  }
}

// ── Toggle inspect mode ────────────────────────────────────────────────────────
function toggleInspect() {
  isInspecting = !isInspecting;
  updateInspectUI();
  if (!isInspecting) {
    sendToBackground({ type: 'STOP_INSPECT' });
    return;
  }
  clearPanelStatus();
  sendToBackground({ type: 'START_INSPECT' }, (res) => {
    // Restricted pages (chrome://, the Web Store, PDFs…) can't host the overlay; the
    // worker says so instead of leaving the button claiming "Stop Inspecting".
    if (res && res.ok === false) {
      isInspecting = false;
      updateInspectUI();
      showPanelStatus(res.error || "Locatra can't run on this page.", 'err');
    }
  });
}

function updateInspectUI() {
  const btn = document.getElementById('inspectBtn');
  const dot = document.getElementById('statusDot');
  const icon = document.getElementById('btnIcon');
  const txt = document.getElementById('btnText');
  const hint = document.getElementById('hintRow');

  if (isInspecting) {
    btn.classList.add('active');
    dot.classList.add('active');
    icon.textContent = '⏹';
    txt.textContent = 'Stop Inspecting';
    hint.style.display = 'block';
  } else {
    btn.classList.remove('active');
    dot.classList.remove('active');
    icon.textContent = '🎯';
    txt.textContent = 'Start Inspecting';
    hint.style.display = 'none';
  }
}

// ── Locator display (framework/language aware) ────────────────────────────────
// Returns { code, fullCode } for the current output target. Playwright JS/TS keeps
// the engine's native strings (best fidelity incl. chained/frame); everything else
// is translated from the structured `loc.target` via codegen.
function formatLocator(loc, suggestedAction) {
  if (outFramework === 'playwright' && outLanguage !== 'python') {
    return { code: loc.code || '', fullCode: loc.fullCode || '' };
  }
  if (typeof LLCodegen !== 'undefined' && loc.target) {
    const expr = LLCodegen.locatorExpr(loc.target, outFramework, outLanguage);
    const act = suggestedAction || 'click';
    const value = act === 'fill' ? 'your value' : (act === 'selectOption' ? 'option text' : '');
    const stmt = LLCodegen.actionStatement({ action: act, target: loc.target, value: value }, outFramework, outLanguage);
    return { code: expr || (loc.code || ''), fullCode: stmt || (loc.fullCode || '') };
  }
  return { code: loc.code || '', fullCode: loc.fullCode || '' };
}

// Card heading: keep Playwright's native API name; use a neutral strategy label
// for Selenium/Cypress (where "getByRole()" would be misleading).
function strategyLabel(loc) {
  if (outFramework === 'playwright') return loc.method;
  const t = loc.target || {};
  const map = {
    testid: 'Test ID', role: t.name ? 'Role + name' : 'Role', label: 'Label',
    placeholder: 'Placeholder', altText: 'Alt text', title: 'Title', text: 'Text',
    id: 'ID', name: 'Name', css: 'CSS selector', chain: 'Scoped to parent'
  };
  return map[t.kind] || loc.method;
}

// ── Output target (framework + language) wiring ──────────────────────────────
function recorderFileName(fw, lang) {
  const f = fw || outFramework;
  const l = lang || outLanguage;
  if (l === 'python') return 'test_recorded.py';
  const ext = l === 'typescript' ? 'ts' : 'js';
  if (f === 'cypress') return `recorded.cy.${ext}`;
  if (f === 'playwright') return `locatra-recorded.spec.${ext}`;
  return `locatra-recorded.${ext}`;
}

// The saved framework/language preference loads asynchronously; restoring the
// recorder (which may carry an edited script for a specific target) waits for it.
let _outputReady = false;
const _outputReadyWaiters = [];
function markOutputReady() {
  if (_outputReady) return;
  _outputReady = true;
  const waiters = _outputReadyWaiters.splice(0);
  for (const fn of waiters) {
    try { fn(); } catch (e) { console.warn('[Locatra] output-ready waiter failed:', e); }
  }
}
function whenOutputReady(fn) {
  if (_outputReady) fn();
  else _outputReadyWaiters.push(fn);
}

function targetLabel(fw, lang) {
  if (typeof LLCodegen === 'undefined') return fw + ' / ' + lang;
  const f = (LLCodegen.FRAMEWORKS || []).find(x => x.id === fw);
  const l = (LLCodegen.LANGUAGES || []).find(x => x.id === lang);
  return (f ? f.label : fw) + ' · ' + (l ? l.label : lang);
}

function populateLangOptions() {
  const langSel = document.getElementById('langSelect');
  if (!langSel || typeof LLCodegen === 'undefined') return;
  // Keep every language visible (so it's obvious Python exists); disable the ones the
  // framework can't produce — e.g. Cypress is JS/TS only, so Python shows greyed out.
  if (!LLCodegen.isValidCombo(outFramework, outLanguage)) {
    const firstValid = LLCodegen.languagesFor(outFramework)[0];
    if (firstValid) outLanguage = firstValid.id;
  }
  langSel.textContent = '';
  LLCodegen.LANGUAGES.forEach(l => {
    const ok = LLCodegen.isValidCombo(outFramework, l.id);
    const o = document.createElement('option');
    o.value = l.id;
    o.textContent = ok ? l.label : l.label + ' — n/a in Cypress';
    o.disabled = !ok;
    if (l.id === outLanguage) o.selected = true;
    langSel.appendChild(o);
  });
}

/** Puts the two <select>s back in line with outFramework/outLanguage. */
function syncOutputSelects() {
  const fwSel = document.getElementById('fwSelect');
  const langSel = document.getElementById('langSelect');
  if (fwSel) fwSel.value = outFramework;
  populateLangOptions();
  if (langSel) langSel.value = outLanguage;
}

function applyOutputChange() {
  if (chrome.storage && chrome.storage.local) {
    const patch = {};
    patch[LL_FW_KEY] = outFramework;
    patch[LL_LANG_KEY] = outLanguage;
    chrome.storage.local.set(patch);
  }
  if (lastResultData) renderResults(lastResultData);
  renderTimeline();
  updateCodePreview();
  scheduleRecorderPersist();
}

/**
 * Switch the output target. A hand-edited script stays in the editor across a
 * switch (updateCodePreview never overwrites edits), so Download/Copy used to ship
 * e.g. Playwright TS under a "test_recorded.py" name. Now the user decides: either
 * regenerate for the new target (discarding the edits) or keep the edits and the
 * target they were written for.
 */
function changeOutputTarget(fw, lang) {
  const prevFw = outFramework;
  const prevLang = outLanguage;
  const hadEdits = editorHasUserEdits();
  if (fw) outFramework = fw;
  if (lang) outLanguage = lang;
  populateLangOptions(); // may move outLanguage to the first valid one
  if (outFramework === prevFw && outLanguage === prevLang) {
    syncOutputSelects();
    return;
  }
  if (hadEdits) {
    const ok = window.confirm(
      `The Generated Test Script has your own edits (${targetLabel(prevFw, prevLang)}).\n\n` +
      `Switching to ${targetLabel(outFramework, outLanguage)} regenerates it from the timeline and DISCARDS those edits.\n\n` +
      'OK = regenerate · Cancel = keep my edits and stay on the current output'
    );
    if (!ok) {
      outFramework = prevFw;
      outLanguage = prevLang;
      syncOutputSelects();
      return;
    }
    syncOutputSelects();
    regenerateEditorFromTimeline(false);
  } else {
    syncOutputSelects();
  }
  applyOutputChange();
}

function initOutputSelectors() {
  const fwSel = document.getElementById('fwSelect');
  const langSel = document.getElementById('langSelect');
  if (!fwSel || !langSel || typeof LLCodegen === 'undefined') {
    markOutputReady();
    return;
  }

  fwSel.textContent = '';
  LLCodegen.FRAMEWORKS.forEach(f => {
    const o = document.createElement('option');
    o.value = f.id;
    o.textContent = f.label;
    fwSel.appendChild(o);
  });

  const finalize = () => {
    if (!LLCodegen.isValidCombo(outFramework, outLanguage)) {
      outLanguage = LLCodegen.languagesFor(outFramework)[0].id;
    }
    syncOutputSelects();
  };

  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get([LL_FW_KEY, LL_LANG_KEY], (res) => {
      if (res && res[LL_FW_KEY]) outFramework = res[LL_FW_KEY];
      if (res && res[LL_LANG_KEY]) outLanguage = res[LL_LANG_KEY];
      finalize();
      if (lastResultData) renderResults(lastResultData);
      renderTimeline();
      updateCodePreview();
      markOutputReady();
    });
  } else {
    finalize();
    markOutputReady();
  }

  fwSel.addEventListener('change', () => changeOutputTarget(fwSel.value, null));
  langSel.addEventListener('change', () => changeOutputTarget(null, langSel.value));
}

// ── Recording state (owned by the background, one session per window) ────────
// The panel never decides on its own that a recording is live/paused/asserting: it
// sends the command, then adopts whatever GET_RECORDING_STATE reports. A state
// query that was already in flight when the user clicked something is discarded
// (epoch check) so a stale answer can't flip the controls back.
let _recOpsInFlight = 0;
let _recStateEpoch = 0;
let _recToggleBusy = false;
let _recToggleTimer = null;

function setAssertUI(on, assertType) {
  const toggle = document.getElementById('assertModeToggle');
  const typeSel = document.getElementById('assertTypeSelect');
  if (toggle) toggle.checked = !!on;
  if (typeSel) {
    if (assertType && Array.prototype.some.call(typeSel.options, o => o.value === assertType)) {
      typeSel.value = assertType;
    }
    typeSel.style.display = on ? '' : 'none';
  }
}

/** Adopt a GET_RECORDING_STATE answer: { active, paused, assertMode, assertType }. */
function applyRecordingState(res) {
  if (!res || typeof res !== 'object') return;
  isRecording = !!res.active;
  isPaused = isRecording && !!res.paused;
  updateRecordUI();
  if (isRecording) setAssertUI(!!res.assertMode, res.assertType);
}

function refreshRecordingState() {
  if (_recOpsInFlight > 0 || _recToggleBusy) return;
  const epoch = _recStateEpoch;
  sendToBackground({ type: 'GET_RECORDING_STATE' }, (res, err) => {
    if (err || !res) return;
    if (epoch !== _recStateEpoch || _recOpsInFlight > 0 || _recToggleBusy) return;
    applyRecordingState(res);
  });
}

/** Send a recorder command for this window, then re-read the real state. */
function sendRecorderCommand(msg, onDone) {
  _recOpsInFlight++;
  _recStateEpoch++;
  sendToBackground(msg, (res, err) => {
    _recOpsInFlight = Math.max(0, _recOpsInFlight - 1);
    _recStateEpoch++;
    if (res && res.ok === false && res.error) showPanelStatus(res.error, 'err');
    if (typeof onDone === 'function') onDone(res, err);
    refreshRecordingState();
  });
}

function sendAssertMode() {
  const toggle = document.getElementById('assertModeToggle');
  const typeSel = document.getElementById('assertTypeSelect');
  const on = !!(toggle && toggle.checked);
  const assertType = (typeSel && typeSel.value) || 'toBeVisible';
  sendRecorderCommand({ type: 'SET_ASSERT_MODE', on: on, assertType: assertType });
}

function initRecorderControls() {
  const pauseBtn = document.getElementById('pauseRecordingBtn');
  const resumeBtn = document.getElementById('resumeRecordingBtn');
  // Pause/Resume flip the buttons immediately (the user needs to see the click
  // land), then reconcile with the worker's per-window session state.
  if (pauseBtn) pauseBtn.addEventListener('click', () => {
    isPaused = true;
    updateRecordUI();
    sendRecorderCommand({ type: 'PAUSE_RECORDING' });
  });
  if (resumeBtn) resumeBtn.addEventListener('click', () => {
    isPaused = false;
    updateRecordUI();
    sendRecorderCommand({ type: 'RESUME_RECORDING' });
  });

  const assertToggle = document.getElementById('assertModeToggle');
  const assertType = document.getElementById('assertTypeSelect');
  if (assertToggle) assertToggle.addEventListener('change', () => {
    if (assertType) assertType.style.display = assertToggle.checked ? '' : 'none';
    sendAssertMode();
  });
  if (assertType) assertType.addEventListener('change', sendAssertMode);

  const filterInput = document.getElementById('recFilterInput');
  const filterClear = document.getElementById('recFilterClear');

  // Undo/Redo always act on the *true* last action, regardless of the timeline
  // filter — but that action can be filtered out of view, so the row list wouldn't
  // change at all and the user would have no way to tell whether the click did
  // anything. Dropping the filter is what actually shows the effect.
  function clearRecFilter() {
    if (!recFilter) return;
    if (filterInput) filterInput.value = '';
    recFilter = '';
    if (filterClear) filterClear.style.display = 'none';
  }

  const undoBtn = document.getElementById('undoActionBtn');
  const redoBtn = document.getElementById('redoActionBtn');
  if (undoBtn) undoBtn.addEventListener('click', () => {
    if (recordedActions.length === 0) return;
    const act = recordedActions.pop();
    if (act) { forgetActionKey(act); recRedoStack.push(act); }
    clearRecFilter();
    renderTimeline();
    updateCodePreview();
    scheduleRecorderPersist();
  });
  if (redoBtn) redoBtn.addEventListener('click', () => {
    if (recRedoStack.length === 0) return;
    const act = recRedoStack.pop();
    if (act) { recordedActions.push(act); seenActionKeys.add(dedupeKeyForAction(act)); }
    clearRecFilter();
    renderTimeline();
    updateCodePreview();
    scheduleRecorderPersist();
  });

  if (filterInput) filterInput.addEventListener('input', () => {
    if (_recFilterTimer) clearTimeout(_recFilterTimer);
    _recFilterTimer = setTimeout(() => {
      recFilter = filterInput.value.trim();
      if (filterClear) filterClear.style.display = recFilter ? '' : 'none';
      renderTimeline();
    }, 200);
  });
  if (filterClear) filterClear.addEventListener('click', () => {
    clearRecFilter();
    renderTimeline();
    if (filterInput) filterInput.focus();
  });

  const hdr = document.getElementById('timelineToggleHeader');
  if (hdr) {
    hdr.addEventListener('click', () => setTimelineExpanded(!timelineExpanded));
    hdr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTimelineExpanded(!timelineExpanded); }
    });
  }
  setTimelineExpanded(false);
}

// ── Render results ─────────────────────────────────────────────────────────────
function renderResults(data) {
  if (!data) return;
  lastResultData = data;
  // The port bridge is wired at script load, so a pick relayed by the background the
  // instant the panel opens can arrive before the markup exists. Render it once the
  // document is ready rather than throwing on a null container and dropping it.
  if (!document.getElementById('cardsContainer')) {
    document.addEventListener('DOMContentLoaded', () => renderResults(data), { once: true });
    return;
  }
  // A payload restored from storage can predate the current result shape, and one
  // missing array used to throw out of the render and leave the panel stuck on a
  // half-drawn result with no way back short of reopening it.
  const el = data.elementData || {};
  const locators = Array.isArray(data.locators) ? data.locators.filter(Boolean) : [];
  const avoidList = Array.isArray(data.avoidList) ? data.avoidList : [];
  const proTip = data.proTip;
  const a11y = Array.isArray(data.a11y) ? data.a11y : [];

  document.getElementById('idleState').style.display = 'none';
  document.getElementById('resultsState').style.display = '';

  // ── A11y & Semantics ──
  const a11yLabel = document.getElementById('a11yLabel');
  const a11yContainer = document.getElementById('a11yContainer');
  if (a11y && a11y.length > 0) {
    a11yLabel.style.display = 'block';
    a11yContainer.style.display = 'block';
    safeRender(a11yContainer, a11y.map(issue => `
      <div class="a11y-row">
        <span class="a11y-severity ${issue.severity === 'high' ? 'high' : 'low'}">${esc(issue.severity)}</span>
        <div class="a11y-msg">${esc(issue.message)}</div>
      </div>
    `).join(''));
  } else {
    // Show a "perfect" state if no issues found? 
    // For now just hide to keep it clean, or show a subtle "No major issues"
    a11yLabel.style.display = 'none';
    a11yContainer.style.display = 'none';
  }

  // ── Element bar ── (Keep as is)
  const elBar = document.getElementById('elBar');
  const chips = [];
  if (el.tag) chips.push(`<span class="el-chip"><span class="k">&lt;</span><span class="v">${esc(el.tag)}</span><span class="k">&gt;</span></span>`);
  if (el.role) chips.push(`<span class="el-chip"><span class="k">role: </span><span class="v">${esc(el.role)}</span></span>`);
  if (el.visibleText) chips.push(`<span class="el-chip"><span class="k">text: </span><span class="v">"${esc(el.visibleText.slice(0, 30))}"</span></span>`);
  if (el.id) chips.push(`<span class="el-chip"><span class="k">id: </span><span class="v">${esc(el.id)}</span></span>`);
  if (el.testId) chips.push(`<span class="el-chip"><span class="k">testid: </span><span class="v">${esc(el.testId)}</span></span>`);
  if (el.ariaLabel) chips.push(`<span class="el-chip"><span class="k">aria: </span><span class="v">${esc(el.ariaLabel.slice(0, 25))}</span></span>`);
  if (el.placeholder) chips.push(`<span class="el-chip"><span class="k">ph: </span><span class="v">${esc(el.placeholder.slice(0, 25))}</span></span>`);
  if (el.hasUnstableClasses) chips.push(`<span class="el-chip"><span class="k">classes: </span><span class="v warn">⚠ auto-generated</span></span>`);
  
  // An element inside an iframe generates code that must enter the frame first —
  // surface that, because otherwise the locator looks ordinary and inexplicably
  // fails against the top document.
  if (el.framePath && el.framePath.length) {
    chips.push(`<span class="el-chip shadow">🖼 IFRAME</span>`);
    chips.push(`<span class="el-chip shadow"><span class="k">frame: </span>${esc(el.framePath.join(' › '))}</span>`);
  }

  if (el.isInShadow) {
    chips.push(`<span class="el-chip shadow">🧬 SHADOW</span>`);
    if (el.shadowHost) chips.push(`<span class="el-chip shadow"><span class="k">host: </span>${esc(el.shadowHost)}</span>`);
  }

  // Where the pick came from — a result restored on reopen may belong to a page
  // the user has since left, and the locators only make sense against that page.
  const pageUrl = typeof data.pageUrl === 'string' ? data.pageUrl : (typeof el.pageUrl === 'string' ? el.pageUrl : '');
  if (pageUrl) {
    chips.push(`<span class="el-chip el-chip-url" title="${esc(pageUrl)}"><span class="k">page: </span>${esc(pageUrl.length > 80 ? pageUrl.slice(0, 77) + '…' : pageUrl)}</span>`);
  }
  
  safeRender(elBar, chips.join(''));

  // ── Locator cards ──
  const container = document.getElementById('cardsContainer');
  safeRender(container, locators.map((loc, i) => {
    const rc = rankClass(loc.rank);
    const delayStyle = `animation-delay:${i * 0.06}s`;
    
    const { code, fullCode } = formatLocator(loc, el.suggestedAction);

    const uniqChip = (typeof loc.matchCount === 'number')
      ? (loc.unique
          ? '<span class="uniq uniq-ok" title="Matches exactly one element on the page">✓ unique</span>'
          : `<span class="uniq uniq-warn" title="Matches multiple elements — may be ambiguous">⚠ ${loc.matchCount >= 10 ? '10+' : loc.matchCount} matches</span>`)
      : '';

    return `
      <div class="card ${rc}" style="${delayStyle}">
        <div class="card-head">
          <div class="card-left">
            <div class="rank-num">${loc.rank}</div>
            <div>
              <div class="method-name">${esc(strategyLabel(loc))}</div>
              <div class="match-attr" title="${esc(loc.matchedAttr)}">${esc(loc.matchedAttr)}</div>
            </div>
          </div>
          <div class="card-badges">
            <span class="pill ${pillClass(loc.stability)}">${pillLabel(loc.stability)}</span>
            ${uniqChip}
          </div>
        </div>
        <div class="card-code">
          <div class="code-txt">${hl(code)}</div>
          <div style="display:flex; flex-direction:column; gap:4px;">
            <button type="button" class="copy-btn" data-code="${esc(fullCode)}" aria-label="Copy locator ${i + 1}: ${esc(strategyLabel(loc))}">Copy</button>
          </div>
        </div>
        <div class="why-row">
          <button type="button" class="toggle-explain" aria-expanded="false" aria-controls="ll-explain-${i}">▶ Why?</button>
        </div>
        <div class="card-explain" id="ll-explain-${i}">${esc(loc.explanation || '')}</div>
      </div>`;
  }).join(''));

  // ── Avoid section ──
  const avoidLabel = document.getElementById('avoidLabel');
  const avoidSec = document.getElementById('avoidContainer');
  if (avoidList && avoidList.length > 0) {
    avoidLabel.style.display = '';
    avoidSec.style.display = '';
    safeRender(avoidSec, `
      <div class="avoid-title">⚠️ Avoid these locators</div>
      ${avoidList.map(a => `
        <div class="avoid-row">
          <span class="avoid-x">✗</span>
          <div><span class="avoid-code">${esc(a.locator)}</span><br>${esc(a.reason)}</div>
        </div>`).join('')}`);
  } else {
    avoidLabel.style.display = 'none';
    avoidSec.style.display = 'none';
  }

  // ── Pro tip ──
  const tipEl = document.getElementById('proTip');
  if (proTip) {
    tipEl.style.display = '';
    // Use textContent for plain text tips
    tipEl.textContent = `💡 Pro Tip: ${proTip}`;
  } else {
    tipEl.style.display = 'none';
  }
}

// ── Event handlers ─────────────────────────────────────────────────────────────
function handleCopy(btn) {
  // getAttribute() already returns the decoded value — the parser resolved the
  // entities esc() wrote. Decoding a second time corrupted any literal entity in
  // the user's own code (e.g. a selector containing "&amp;lt;" collapsed to "<").
  copyToClipboard(btn.getAttribute('data-code') || '', btn);
}

function toggleExplain(btn) {
  const card = btn.closest('.card');
  const exp = card.querySelector('.card-explain');
  const open = exp.classList.toggle('open');
  btn.textContent = open ? '▼ Why?' : '▶ Why?';
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

// ── Message listener (also used by port bridge from background) ─────────────
let lastRenderedPickId = null;

// Stress test: one request at a time. The 5s safety timeout used to alert "timed
// out" and then a late result alerted "complete" — two contradictory dialogs. Now
// the outcome is one inline line: a late result simply replaces the timeout note,
// and a result nobody asked for (no request outstanding) is ignored.
let _stressState = null; // null | 'pending' | 'timedout'
let _stressTimer = null;

function showStressResult(text, kind) {
  const el = document.getElementById('stressResult');
  if (!el) {
    if (text) showPanelStatus(text, kind);
    return;
  }
  el.textContent = String(text || '');
  el.className = 'stress-result' + (kind ? ' ' + kind : '');
  el.hidden = !text;
}

function resetStressButton() {
  const btn = document.getElementById('stressTestBtn');
  if (btn) btn.textContent = '💥 Stress Test';
}

function handleStressResult(d) {
  if (_stressState === null) return; // not ours / already answered
  _stressState = null;
  if (_stressTimer) { clearTimeout(_stressTimer); _stressTimer = null; }
  resetStressButton();
  d = d || {};
  if (d.unavailable) {
    showStressResult("Stress Test: couldn't reach this page. It may be a restricted page (chrome://, the Web Store, a PDF) or not fully loaded — try a normal http(s) page and reload.", 'err');
    return;
  }
  if (d.noTarget) {
    showStressResult('Stress Test: no element selected. Turn on Inspect and click an element first, then run the Stress Test.', 'err');
    return;
  }
  const what = d.role ? ` Target: <${d.tag || '?'}> · role="${d.role}"${d.name ? ` · name="${d.name}"` : ''}.` : '';
  showStressResult(`Stress Test complete.${what} Element locatable without classes/id? ${d.survived ? 'Yes ✅' : 'No ❌'}`, d.survived ? 'ok' : 'warn');
}

function runStressTest() {
  const btn = document.getElementById('stressTestBtn');
  if (_stressState === 'pending') return;
  _stressState = 'pending';
  if (btn) btn.textContent = 'Testing...';
  showStressResult('', '');
  // Safety net: reset the button even if no result ever comes back (e.g. tab closed mid-run).
  if (_stressTimer) clearTimeout(_stressTimer);
  _stressTimer = setTimeout(() => {
    _stressTimer = null;
    if (_stressState !== 'pending') return;
    _stressState = 'timedout';
    resetStressButton();
    showStressResult('Stress Test timed out — no response from the page. Reload the page and try again.', 'err');
  }, 5000);
  sendToBackground({ type: 'RUN_STRESS_TEST' });
}

function supersedeIdsOf(msg) {
  const d = msg.data || {};
  const ids = msg.supersedes || msg.eventIds || d.supersedes || d.eventIds;
  return Array.isArray(ids) ? ids : [];
}

function handleRuntimeMessage(msg) {
  if (!msg || isForeignWindowMessage(msg)) return;
  if (msg.type === 'ELEMENT_PICKED' && msg.data) {
    // The same pick can be delivered more than once (port relay + fallback
    // broadcast); rendering both rebuilt every card for nothing.
    const id = msg.data.pickId;
    if (id && id === lastRenderedPickId) return;
    if (id) lastRenderedPickId = id;
    renderResults(msg.data);
  }
  if (msg.type === 'STOP_INSPECT') {
    isInspecting = false;
    updateInspectUI();
  }
  if (msg.type === 'START_INSPECT') {
    isInspecting = true;
    updateInspectUI();
  }
  if (msg.type === 'LAB_STATUS_UPDATE') {
      const statusEl = document.getElementById('lab-status');
      const countEl = document.getElementById('lab-count');
      if (msg.count > 0) {
        statusEl.textContent = `Identification successful. Found ${msg.count} match(es).` + (msg.via ? ` · via ${msg.via}()` : '');
        statusEl.className = 'lab-status success';
        countEl.textContent = `(${msg.count})`;
        countEl.style.display = 'inline';
      } else {
        statusEl.textContent = msg.via
          ? `Parsed ${msg.via}() but found no matches in the current DOM.`
          : 'No matches found in the current DOM.';
        statusEl.className = 'lab-status err';
        countEl.style.display = 'none';
      }
  }
  if (msg.type === 'LAB_ERROR') {
    const statusEl = document.getElementById('lab-status');
    statusEl.textContent = `Invalid Selector: ${msg.error}`;
    statusEl.className = 'lab-status err';
    document.getElementById('lab-count').style.display = 'none';
  }
  if (msg.type === 'STRESS_TEST_RESULT') {
    handleStressResult(msg.data);
  }
  if (msg.type === 'RECORDED_ACTION' && msg.data) {
    receiveRecordedAction(msg.data);
  }
  if (msg.type === 'RECORDED_ACTION_SUPERSEDE') {
    receiveSupersede(supersedeIdsOf(msg));
  }
}

// Steps that arrive before the persisted timeline has been restored are held here
// and appended after it — restoring used to overwrite recordedActions wholesale and
// drop whatever had already arrived (e.g. the background's replay of steps recorded
// while the panel was closed).
let _recorderRestored = false;
const _pendingRecorded = [];

function receiveRecordedAction(data) {
  if (!_recorderRestored) {
    _pendingRecorded.push({ action: data });
    return;
  }
  appendToRecorder(data);
  // A navigation re-arms the page; re-read assert/pause so the controls match.
  if (data && data.action === 'goto') refreshRecordingState();
}

function receiveSupersede(ids) {
  if (!ids.length) return;
  if (!_recorderRestored) {
    _pendingRecorded.push({ supersedes: ids });
    return;
  }
  if (removeSupersededSteps(ids) > 0) {
    renderTimeline();
    updateCodePreview();
    scheduleRecorderPersist();
  }
}

// Content scripts carry sender.tab — but so does this extension's own page when it
// is opened as a normal tab, which must not be mistaken for one.
function isFromContentScript(sender) {
  if (!sender || !sender.tab) return false;
  try {
    return !(typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL('')));
  } catch (e) {
    return true;
  }
}

// Content scripts broadcast some messages directly as well; those carry no window
// tag and would reach every window's panel. The background relays everything the
// panel needs over the port, tagged with its window, so direct ones are ignored.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (isFromContentScript(sender)) return;
  if (!msg) return;
  whenWindowId(() => handleRuntimeMessage(msg));
});

// C7: the background buffers RECORDED_ACTIONs per window while no panel is open
// and replays them after PANEL_HELLO. It may drop the buffer once we acknowledge,
// so the ack is only sent after the steps are safely persisted.
let sidePanelPort = null;
let _bufferAckPending = false;

function sendBufferAck() {
  _bufferAckPending = false;
  whenWindowId((windowId) => {
    const ack = { type: 'PANEL_BUFFER_ACK', windowId: windowId };
    if (sidePanelPort) {
      try { sidePanelPort.postMessage(ack); } catch (e) {}
    }
    sendToBackground({ type: 'PANEL_BUFFER_ACK' });
  });
}

function onPortMessage(msg) {
  if (!msg) return;
  whenWindowId(() => {
    if (isForeignWindowMessage(msg)) return;
    handleRuntimeMessage(msg);
    if (msg.type === 'RECORDED_ACTION') {
      _bufferAckPending = true;
      scheduleRecorderPersist(); // the ack rides on the next successful save
    }
  });
}

function connectSidePanelBridge() {
  try {
    const port = chrome.runtime.connect({ name: 'll-sidepanel' });
    sidePanelPort = port;
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (sidePanelPort === port) sidePanelPort = null;
      setTimeout(connectSidePanelBridge, 400);
    });
    whenWindowId((windowId) => {
      try { port.postMessage({ type: 'PANEL_HELLO', windowId: windowId }); } catch (e) {}
    });
    // A reconnect usually means the worker restarted: re-read the truth.
    if (document.readyState !== 'loading') refreshRecordingState();
  } catch (e) {
    setTimeout(connectSidePanelBridge, 800);
  }
}
connectSidePanelBridge();

/** Move focus somewhere sensible after the step at `idx` was removed. */
function focusAfterStepRemoval(idx) {
  const tl = document.getElementById('recorderTimeline');
  if (!tl) return;
  const btns = Array.prototype.slice.call(tl.querySelectorAll('.remove-step-btn'));
  const next = btns.find(b => parseInt(b.getAttribute('data-index'), 10) >= idx) || btns[btns.length - 1];
  if (next) next.focus();
  else tl.focus();
}

// ── DOMContentLoaded: bind all events + restore state ────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Bind inspect button
  document.getElementById('inspectBtn').addEventListener('click', toggleInspect);

  // Event delegation for card buttons
  const cardsContainer = document.getElementById('cardsContainer');
  cardsContainer.addEventListener('click', (e) => {
    if (e.target.classList.contains('copy-btn')) {
      handleCopy(e.target);
    } else if (e.target.classList.contains('toggle-explain')) {
      toggleExplain(e.target);
    }
  });

  document.getElementById('stressTestBtn').addEventListener('click', runStressTest);

  // Clear button. lastResultData has to go too: a framework/language switch
  // re-renders it, which used to bring the "reset" result straight back.
  document.getElementById('clearBtn').addEventListener('click', () => {
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.remove('lastElement');
    }
    lastResultData = null;
    lastRenderedPickId = null;
    showStressResult('', '');
    document.getElementById('resultsState').style.display = 'none';
    document.getElementById('idleState').style.display = '';
  });

  // ── STARTUP ──
  // Show "not inspecting" until the worker answers, but do NOT tell it to stop.
  // Sending STOP_INSPECT here cancelled the action that opened this panel: clicking
  // Start Inspecting makes the worker open the side panel, the panel loads, and this
  // line then tore down the overlay the click had just switched on — so inspecting
  // from the popup silently did nothing whenever the panel was not already open.
  // GET_INSPECT_STATE below reports the truth, which is all this needed.
  isInspecting = false;
  updateInspectUI();

  sendToBackground({ type: 'GET_INSPECT_STATE' }, (res, err) => {
    if (err) return;
    if (res && res.active) {
      isInspecting = true;
      updateInspectUI();
    }
  });

  // Reopening the panel mid-recording used to show "Start Recording" while the page
  // was still capturing (or recording in another tab of this window), so the obvious
  // next click armed an already-recording tab instead of stopping it. The answer is
  // per window and includes pause + assert state.
  refreshRecordingState();

  // The stored last pick is global; only show it in the window it came from (a pick
  // without a windowId predates window tagging and is shown as before).
  if (chrome.storage && chrome.storage.local) {
    whenWindowId((windowId) => {
      chrome.storage.local.get('lastElement', (result) => {
        const le = result && result.lastElement;
        if (!le || lastResultData) return; // a live pick that arrived first wins
        if (typeof le.windowId === 'number' && typeof windowId === 'number' && le.windowId !== windowId) return;
        renderResults(le);
      });
    });
  }

  // ── Selector Lab Events ──
  const labInput = document.getElementById('lab-input');
  const labValidateBtn = document.getElementById('lab-validate-btn');
  const labClearBtn = document.getElementById('lab-clear-btn');

  const runValidation = () => {
    const selector = labInput.value.trim();
    if (!selector) return;
    sendToBackground({ type: 'LAB_VALIDATE', selector });
  };

  labValidateBtn.addEventListener('click', runValidation);
  labInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runValidation();
  });

  labClearBtn.addEventListener('click', () => {
    labInput.value = '';
    document.getElementById('lab-status').textContent = 'Ready to validate...';
    document.getElementById('lab-status').className = 'lab-status';
    document.getElementById('lab-count').style.display = 'none';
    sendToBackground({ type: 'LAB_CLEAR' });
  });

  // ── Tab Switching Logic ──
  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      tabContents.forEach(c => c.classList.remove('active'));

      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      const targetId = tab.getAttribute('data-target');
      document.getElementById(targetId).classList.add('active');
    });
  });

  // ── Framework + Language selectors ──
  initOutputSelectors();

  // ── Recorder controls (pause / assert / undo-redo / filter / collapse) ──
  initRecorderControls();

  // Keep background aware the panel is open (single ping expires after ~12s), and
  // use the same tick to keep pause/assert in step with the window's session — a
  // navigation, another tab, or the popup can change it behind the panel's back.
  const sendPanelHeartbeat = () => sendToBackground({ type: 'PANEL_HEARTBEAT' });
  sendPanelHeartbeat();
  const panelHeartbeatId = setInterval(() => {
    sendPanelHeartbeat();
    refreshRecordingState();
  }, 4000);
  window.addEventListener('beforeunload', () => clearInterval(panelHeartbeatId));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshRecordingState();
  });

  // ── Recorder Controls ──
  document.getElementById('recordBtn').addEventListener('click', toggleRecording);

  document.getElementById('clearTimelineBtn').addEventListener('click', () => {
    recordedActions = [];
    recRedoStack = [];
    seenActionKeys.clear();
    lastSyncedPreviewScript = '';
    lastSyncedStepKeys = [];
    recLastPageUrl = '';
    // Anything still queued for the restore belongs to the timeline being cleared.
    _pendingRecorded.length = 0;
    _recorderRestored = true;
    updateRecPageUrlUI();
    removePersistedRecorderState();
    renderTimeline();
    updateCodePreview();
  });

  document.getElementById('exportTestBtn').addEventListener('click', (e) => {
    const script = getExportedTestScript();
    if (!script) {
      showPanelStatus('Record at least one action first — the editor stays hidden until then.', 'info');
      return;
    }
    copyToClipboard(script, e.currentTarget);
  });

  document.getElementById('regenerateScriptBtn').addEventListener('click', () => regenerateEditorFromTimeline(true));
  const staleSyncBtn = document.getElementById('scriptStaleSyncBtn');
  if (staleSyncBtn) staleSyncBtn.addEventListener('click', () => regenerateEditorFromTimeline(true));

  const codePreviewEl = document.getElementById('codePreview');
  if (codePreviewEl) {
    codePreviewEl.addEventListener('input', () => {
      updateScriptStaleNotice();
      scheduleRecorderPersist();
    });
    // contenteditable pastes rich HTML by default — force plain text so the script
    // editor can't get polluted with markup.
    codePreviewEl.addEventListener('paste', (e) => {
      e.preventDefault();
      const cd = e.clipboardData || window.clipboardData;
      const text = cd ? cd.getData('text/plain') : '';
      if (text) document.execCommand('insertText', false, text);
    });
  }

  const downloadTestBtn = document.getElementById('downloadTestBtn');
  if (downloadTestBtn) {
    downloadTestBtn.addEventListener('click', () => {
      const script = getExportedTestScript();
      if (!script) {
        showPanelStatus('Record at least one action first — the editor stays hidden until then.', 'info');
        return;
      }
      const blob = new Blob([script], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = recorderFileName();
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
  }

  document.getElementById('recorderTimeline').addEventListener('click', (e) => {
    // 1. Handle step removal
    if (e.target.classList.contains('remove-step-btn')) {
      const idx = parseInt(e.target.getAttribute('data-index'), 10);
      if (isNaN(idx) || idx < 0 || idx >= recordedActions.length) return;
      const removed = recordedActions.splice(idx, 1)[0];
      if (removed) forgetActionKey(removed);

      renderTimeline();
      updateCodePreview();
      scheduleRecorderPersist();
      // The re-render destroyed the focused button; keep keyboard users in place.
      focusAfterStepRemoval(idx);
      return;
    }
    // 2. Handle individual step copy
    if (e.target.classList.contains('copy-btn') && e.target.closest('#recorderTimeline')) {
        handleCopy(e.target);
    }
  });

  loadRecorderState();
});

// ── Recording Toggle (hoisted) ──
// Start/Stop wait for the worker's answer instead of flipping the UI first: on a
// restricted page (chrome://, the Web Store, a PDF) nothing can be captured and the
// worker answers { ok:false, error }, which is shown inline while the UI stays idle.
function setRecordButtonBusy(label) {
  const btn = document.getElementById('recordBtn');
  const txt = document.getElementById('recBtnText');
  if (btn) btn.disabled = true;
  if (txt) txt.textContent = label;
}

function toggleRecording() {
  if (_recToggleBusy) return;
  const starting = !isRecording;
  _recToggleBusy = true;
  clearPanelStatus();
  setRecordButtonBusy(starting ? 'Starting…' : 'Stopping…');
  const finish = (res) => {
    if (!_recToggleBusy) return;
    _recToggleBusy = false;
    if (_recToggleTimer) { clearTimeout(_recToggleTimer); _recToggleTimer = null; }
    if (res && res.ok === false) {
      if (starting) isRecording = false;
      if (!res.error) showPanelStatus(starting ? "Couldn't start recording on this page." : "Couldn't stop recording.", 'err');
    } else {
      // ok:true — or no structured answer from an older worker; the state query
      // sendRecorderCommand issues right after this corrects any mismatch.
      isRecording = starting;
    }
    isPaused = false;
    updateRecordUI();
  };
  // Never leave the button disabled if the worker doesn't answer at all.
  _recToggleTimer = setTimeout(() => {
    _recToggleTimer = null;
    finish(undefined);
    refreshRecordingState();
  }, 5000);
  sendRecorderCommand({ type: starting ? 'START_RECORDING' : 'STOP_RECORDING' }, (res) => finish(res));
}

function updateRecordUI() {
  const btn = document.getElementById('recordBtn');
  const icon = document.getElementById('recBtnIcon');
  const txt = document.getElementById('recBtnText');
  const hint = document.getElementById('recHint');
  const ctrls = document.getElementById('recControls');
  const pauseBtn = document.getElementById('pauseRecordingBtn');
  const resumeBtn = document.getElementById('resumeRecordingBtn');

  if (btn && !_recToggleBusy) btn.disabled = false;

  if (isRecording) {
    btn.style.background = 'var(--surf2)';
    btn.style.color = 'var(--error)';
    btn.style.border = '1px solid var(--error)';
    btn.style.boxShadow = '0 0 15px rgba(255, 113, 108, 0.3)';
    icon.textContent = '⏹';
    txt.textContent = 'Stop Recording';
    hint.style.display = 'block';
    if (ctrls) ctrls.style.display = 'flex';
    if (pauseBtn) pauseBtn.style.display = isPaused ? 'none' : '';
    if (resumeBtn) resumeBtn.style.display = isPaused ? '' : 'none';
  } else {
    btn.style.background = 'var(--error)';
    btn.style.color = 'var(--bg)';
    btn.style.border = 'none';
    btn.style.boxShadow = '0 0 15px rgba(255, 113, 108, 0.2)';
    icon.textContent = '⏺';
    txt.textContent = 'Start Recording';
    hint.style.display = 'none';
    if (ctrls) ctrls.style.display = 'none';
    isPaused = false;
    // Reset assert-mode UI (content script resets its own state on stop/start).
    const at = document.getElementById('assertModeToggle');
    const ats = document.getElementById('assertTypeSelect');
    if (at) at.checked = false;
    if (ats) ats.style.display = 'none';
    if (recordedActions.length > 0) updateCodePreview();
  }
}

// ── Recorder timeline UI helpers ──
function updateUndoRedoButtons() {
  const u = document.getElementById('undoActionBtn');
  const r = document.getElementById('redoActionBtn');
  if (u) u.disabled = recordedActions.length === 0;
  if (r) r.disabled = recRedoStack.length === 0;
}

function setTimelineExpanded(expanded) {
  timelineExpanded = expanded;
  const tl = document.getElementById('recorderTimeline');
  const fw = document.getElementById('recFilterWrap');
  const hdr = document.getElementById('timelineToggleHeader');
  if (tl) tl.style.display = expanded ? '' : 'none';
  if (fw) fw.style.display = expanded ? '' : 'none';
  if (hdr) {
    hdr.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    const chev = hdr.querySelector('.ll-timeline-chevron');
    if (chev) chev.textContent = expanded ? '▼' : '▶';
  }
}

// ── Recorder Timeline (hoisted so message listener can call them) ──
function renderTimeline() {
  const timelineList = document.getElementById('recorderTimeline');
  if (!timelineList) return;

  const countEl = document.getElementById('recCount');
  updateUndoRedoButtons();

  if (recordedActions.length === 0) {
    safeRender(timelineList, `<div class="ll-rec-empty">🎬 Hit <strong style="color: var(--primary);">Start Recording</strong> then use the page. Clicks, typing, hovers (Alt+click), and assertions are captured.</div>`);
    if (countEl) { countEl.style.display = 'none'; }
    return;
  }

  if (countEl) {
    countEl.textContent = `(${recordedActions.length})`;
    countEl.style.display = 'inline';
  }

  const actionIcons = {
    'goto': '🌐', 'viewport': '🖥️', 'click': '👆', 'dblclick': '👆👆', 'fill': '⌨️', 'check': '☑️',
    'uncheck': '⬜', 'selectOption': '📃', 'press': '⌨️', 'hover': '🖱️', 'assert': '✔️', 'upload': '📎'
  };
  const filter = (recFilter || '').toLowerCase();
  let rendered = 0;

  let html = '';
  try {
    html = recordedActions.map((act, i) => {
      const isAssert = act.action === 'assert';
      let codeStr = '';
      try {
        codeStr = buildActionCode(act);
      } catch (err) {
        codeStr = String(act.fullCode || '// (unavailable)').slice(0, 500);
      }
      // A sensitive step's value never reaches the panel (or storage); show where the
      // generated test reads it from instead.
      const valueStr = act.sensitive
        ? `•••••• (env ${secretNameOf(act)})`
        : String(act.value != null ? act.value : '');
      if (filter) {
        const hay = (String(act.action || '') + ' ' + String(act.assertType || '') + ' ' + codeStr + ' ' + valueStr).toLowerCase();
        if (hay.indexOf(filter) === -1) return '';
      }
      rendered++;
      const icon = actionIcons[act.action] || '🔵';
      const label = isAssert
        ? `ASSERT · ${esc(String(act.assertType || 'toBeVisible'))}`
        : esc(String(act.action || 'step').toUpperCase());
      const valuePreview = valueStr.slice(0, 80);
      const actionName = String(act.action || 'step') + (isAssert ? ' ' + String(act.assertType || 'toBeVisible') : '');

      return `
      <div class="ll-rec-step${isAssert ? ' is-assert' : ''}">
        <div class="ll-rec-step-head">
           <span class="ll-rec-step-label">${icon} #${i + 1} ${label}</span>
           <div class="ll-rec-step-actions">
             <button type="button" class="clear-btn copy-btn" data-code="${esc(codeStr)}" aria-label="Copy code for step ${i + 1}: ${esc(actionName)}">Copy</button>
             <button type="button" class="clear-btn remove-step-btn" data-index="${i}" aria-label="Remove step ${i + 1}: ${esc(actionName)}" title="Remove step ${i + 1}">✕</button>
           </div>
        </div>
        ${act.sensitive
          ? `<div class="ll-rec-step-value">value: ${esc(valuePreview)}</div>`
          : (valueStr ? `<div class="ll-rec-step-value">value: "${esc(valuePreview)}"</div>` : '')}
        <div class="ll-rec-step-code">${hl(codeStr)}</div>
      </div>
    `;
    }).join('');
  } catch (err) {
    console.warn('[Locatra] renderTimeline failed:', err);
    html = recordedActions.map((act, i) => `
      <div class="ll-rec-step">
        <div class="ll-rec-step-head"><span class="ll-rec-step-label">#${i + 1} ${esc(String(act.action || ''))}</span></div>
        <pre class="ll-rec-step-code" style="white-space:pre-wrap;">${esc(String(act.fullCode || act.code || ''))}</pre>
      </div>`).join('');
    rendered = recordedActions.length;
  }

  if (filter && rendered === 0) {
    html = `<div class="ll-rec-empty-filter">No actions match "${esc(recFilter)}".</div>`;
  }

  safeRender(timelineList, html);
}


function secretNameOf(act) {
  return (act && typeof act.secretName === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(act.secretName))
    ? act.secretName
    : 'LOCATRA_PASSWORD';
}

function isPlaywrightJsTs() {
  return outFramework === 'playwright' && outLanguage !== 'python';
}

/**
 * A language-appropriate placeholder for a step codegen can't express in the
 * current output. Pasting the recorder's Playwright-TS fullCode into a Selenium,
 * Cypress or Python file used to make the whole script unparseable.
 */
function unconvertibleStepComment(act) {
  const c = outLanguage === 'python' ? '#' : '//';
  const what = String((act && act.action) || 'step').replace(/[\r\n]+/g, ' ');
  const loc = act && act.code ? ' on ' + String(act.code).replace(/[\r\n]+/g, ' ').slice(0, 200) : '';
  return `${c} TODO: could not convert step: ${what}${loc} — re-record it to generate this line`;
}

function buildActionCode(act) {
  // Route through codegen for every framework/language. We deliberately do NOT reuse
  // act.fullCode for Playwright here: the recorder's fullCode carries the engine's
  // suggestAction placeholder for selectOption ('option text') and says .check() even
  // for uncheck events — codegen rebuilds from the action + actual value + target,
  // which is correct for all cases. (locators[0] is always a top semantic locator,
  // so codegen reproduces the Playwright line identically.)
  if (typeof LLCodegen !== 'undefined') {
    const needsLoc = ['click', 'dblclick', 'check', 'uncheck', 'fill', 'selectOption', 'hover', 'assert', 'upload'].indexOf(act.action) !== -1;
    if (needsLoc && !act.target) {
      // Older recording captured before structured targets existed. Its fullCode is
      // Playwright JS/TS, so it is only usable verbatim there.
      if (isPlaywrightJsTs() && act.fullCode) return act.fullCode;
      return unconvertibleStepComment(act);
    }
    let line = '';
    try {
      line = LLCodegen.actionStatement(act, outFramework, outLanguage);
    } catch (err) {
      console.warn('[Locatra] codegen failed for step:', err);
    }
    if (line) return line;
    if (!isPlaywrightJsTs()) return unconvertibleStepComment(act);
  }
  // Legacy Playwright fallback (LLCodegen unavailable).
  const locator = act.code || '';
  const valStr = String(act.value != null ? act.value : '');
  switch (act.action) {
    case 'goto': return `await page.goto(${JSON.stringify(valStr)});`;
    case 'fill':
      if (act.sensitive) return `await ${locator}.fill(process.env.${secretNameOf(act)} ?? '');`;
      return `await ${locator}.fill('${valStr.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');`;
    case 'selectOption': return `await ${locator}.selectOption('${valStr.replace(/'/g, "\\'")}');`;
    case 'uncheck': return `await ${locator}.uncheck();`;
    case 'press': return `await page.keyboard.press(${JSON.stringify(valStr)});`;
    default: return act.fullCode || `await ${locator}.click();`;
  }
}

function generateTestScript() {
  if (typeof LLCodegen !== 'undefined') {
    // buildActionCode() controls per-line fidelity; wrapScript() supplies the
    // framework/language-correct file scaffold (imports, harness, indentation).
    return LLCodegen.wrapScript(recordedActions.map(buildActionCode), outFramework, outLanguage, recordedActions);
  }
  const lines = recordedActions.map(act => `  ${buildActionCode(act)}`).join('\n');
  return `import { test, expect } from '@playwright/test';

test('recorded test', async ({ page }) => {
${lines}
});
`;
}

/** Text shown in the editor, or generated from the timeline if the editor is empty. */
function getExportedTestScript() {
  const ta = document.getElementById('codePreview');
  if (!ta || ta.style.display === 'none') {
    return recordedActions.length ? generateTestScript() : '';
  }
  const v = getPreviewText(ta).trim();
  return v || (recordedActions.length ? generateTestScript() : '');
}

/** Last script we pushed into the editor (so we can tell a hand edit from our own output). */
let lastSyncedPreviewScript = '';
/** Dedupe keys of the steps that script was generated from (drives the "N new steps" notice). */
let lastSyncedStepKeys = [];

function markEditorSynced(script) {
  lastSyncedPreviewScript = script;
  lastSyncedStepKeys = recordedActions.map(dedupeKeyForAction);
  updateScriptStaleNotice();
}

/** True when the visible editor holds text the user changed by hand. */
function editorHasUserEdits() {
  const ta = document.getElementById('codePreview');
  if (!ta || ta.style.display === 'none') return false;
  const text = getPreviewText(ta);
  return text.trim() !== '' && text !== lastSyncedPreviewScript;
}

/** Replace the editor with freshly generated code (discarding hand edits). */
function regenerateEditorFromTimeline(focus) {
  if (recordedActions.length === 0) return;
  const ta = document.getElementById('codePreview');
  if (!ta) return;
  const next = generateTestScript();
  setPreviewCode(ta, next);
  markEditorSynced(next);
  if (focus) ta.focus();
  scheduleRecorderPersist();
}

/**
 * Hand edits are never overwritten, so steps recorded afterwards are missing from
 * what Copy/Download hand out. Say so, with a one-click way to bring them in.
 */
function updateScriptStaleNotice() {
  const box = document.getElementById('scriptStaleNotice');
  if (!box) return;
  const txt = document.getElementById('scriptStaleText');
  if (!editorHasUserEdits()) { box.hidden = true; return; }
  const synced = new Set(lastSyncedStepKeys);
  const current = recordedActions.map(dedupeKeyForAction);
  const currentSet = new Set(current);
  const fresh = current.filter(k => !synced.has(k)).length;
  const gone = lastSyncedStepKeys.filter(k => !currentSet.has(k)).length;
  if (!fresh && !gone) { box.hidden = true; return; }
  let msg;
  if (fresh) {
    msg = `${fresh} new step${fresh === 1 ? '' : 's'} not in your edited script`;
    if (gone) msg += ` (and ${gone} removed step${gone === 1 ? '' : 's'} still in it)`;
  } else {
    msg = `${gone} removed step${gone === 1 ? '' : 's'} still in your edited script`;
  }
  if (txt) txt.textContent = msg;
  box.hidden = false;
}

function updateCodePreview() {
  const previewEl = document.getElementById('codePreview');
  const labelEl = document.getElementById('codePreviewLabel');
  if (!previewEl || !labelEl) return;

  if (recordedActions.length === 0) {
    previewEl.style.display = 'none';
    labelEl.style.display = 'none';
    previewEl.textContent = '';
    lastSyncedPreviewScript = '';
    lastSyncedStepKeys = [];
    updateScriptStaleNotice();
    return;
  }

  labelEl.style.display = '';
  previewEl.style.display = '';

  // Only refresh when the box still shows exactly what we last generated. Gating this
  // on focus instead used to only protect an edit while the editor had focus — Undo,
  // Redo, remove-step, a framework/language switch, and a new recorded action all call
  // this too, and any of them firing right after the user clicked away silently threw
  // the edit out and replaced it with fresh codegen output.
  if (getPreviewText(previewEl) !== lastSyncedPreviewScript) {
    updateScriptStaleNotice();
    return;
  }

  const next = generateTestScript();
  // Unchanged output: leave the DOM alone. Re-rendering identical text still resets
  // the caret, and the periodic state re-sync reaches here every few seconds.
  if (next === lastSyncedPreviewScript) {
    updateScriptStaleNotice();
    return;
  }
  setPreviewCode(previewEl, next);
  markEditorSynced(next);
}

let seenActionKeys = new Set();

function updateRecPageUrlUI() {
  const el = document.getElementById('recPageUrl');
  if (!el) return;
  if (recLastPageUrl) {
    el.textContent = 'Page: ' + recLastPageUrl;
    el.style.display = 'block';
  } else {
    el.textContent = '';
    el.style.display = 'none';
  }
}

// ── Persistence (per window) ─────────────────────────────────────────────────
// One storage key per window ("llRecorderState:<windowId>"): with a single shared
// key, two windows' panels overwrote each other's timelines. Window ids don't
// survive a browser restart, so a panel with no entry of its own adopts the most
// recent entry whose window no longer exists (and the pre-1.4 flat key).
const LL_RECORDER_KEY_PREFIX = LL_RECORDER_STATE_KEY + ':';
const LL_ORPHAN_STATE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function recorderStorageKey(windowId) {
  return LL_RECORDER_KEY_PREFIX + (typeof windowId === 'number' ? windowId : 'default');
}

/** A copy of a step that is safe to keep: sensitive steps never hold their value. */
function sanitizeStep(step) {
  const out = Object.assign({}, step);
  if (out.sensitive) {
    out.value = '';
    // A fullCode from before env-var codegen would embed the literal value.
    if (typeof out.fullCode === 'string' && out.fullCode.indexOf('process.env') === -1) out.fullCode = '';
  }
  return out;
}

function scheduleRecorderPersist() {
  if (!chrome.storage || !chrome.storage.local) {
    if (_bufferAckPending) sendBufferAck(); // nothing more durable to wait for
    return;
  }
  clearTimeout(_recorderSaveTimer);
  _recorderSaveTimer = setTimeout(persistRecorderState, 200);
}

// chrome.storage.local is a 10 MB budget shared with everything else the extension
// stores. A long recording session used to grow the payload without limit and the
// failing set() reported through lastError that nobody read — so the timeline
// silently stopped surviving a panel reopen. Trim the oldest entries instead.
const LL_MAX_PERSISTED_ACTIONS = 500;
const LL_MAX_SEEN_KEYS = 2000;

function removePersistedRecorderState() {
  if (!chrome.storage || !chrome.storage.local) return;
  clearTimeout(_recorderSaveTimer);
  whenWindowId((windowId) => {
    chrome.storage.local.remove([recorderStorageKey(windowId), LL_RECORDER_STATE_KEY], () => {
      void chrome.runtime.lastError;
      if (_bufferAckPending) sendBufferAck();
    });
  });
}

function persistRecorderState() {
  if (!chrome.storage || !chrome.storage.local) return;
  // Until the saved timeline is restored, memory holds only part of it — saving
  // now would overwrite the stored timeline with that fragment.
  if (!_recorderRestored) return;
  whenWindowId((windowId) => {
    const key = recorderStorageKey(windowId);
    if (recordedActions.length === 0 && !recLastPageUrl) {
      removePersistedRecorderState();
      return;
    }
    const edited = editorHasUserEdits();
    const ta = document.getElementById('codePreview');
    const codePreview = edited && ta ? getPreviewText(ta) : '';
    const actions = (recordedActions.length > LL_MAX_PERSISTED_ACTIONS
      ? recordedActions.slice(-LL_MAX_PERSISTED_ACTIONS)
      : recordedActions).map(sanitizeStep);
    const seenKeys = Array.from(seenActionKeys).slice(-LL_MAX_SEEN_KEYS);
    const state = {
      actions: actions,
      seenKeys: seenKeys,
      codePreview: codePreview,
      codeEdited: edited,
      codeFramework: outFramework,
      codeLanguage: outLanguage,
      syncedStepKeys: edited ? lastSyncedStepKeys.slice(-LL_MAX_PERSISTED_ACTIONS) : [],
      lastPageUrl: recLastPageUrl,
      windowId: typeof windowId === 'number' ? windowId : null,
      updatedAt: Date.now()
    };

    chrome.storage.local.set({ [key]: state }, () => {
      const err = chrome.runtime.lastError;
      if (!err) {
        if (_bufferAckPending) sendBufferAck();
        return;
      }
      // Out of room: drop the editor text (much the largest field) and keep the
      // timeline, which is what the user actually can't reproduce.
      chrome.storage.local.set({
        [key]: Object.assign({}, state, {
          actions: actions.slice(-100),
          seenKeys: seenKeys.slice(-500),
          codePreview: '',
          codeEdited: false,
          syncedStepKeys: []
        })
      }, () => {
        if (!chrome.runtime.lastError && _bufferAckPending) sendBufferAck();
      });
    });
  });
}

/** Every stored recorder entry: [{ key, state, windowId, legacy, updatedAt }]. */
function collectRecorderEntries(all) {
  const out = [];
  Object.keys(all || {}).forEach((key) => {
    const state = all[key];
    if (!state || typeof state !== 'object') return;
    if (key === LL_RECORDER_STATE_KEY) {
      // Pre-window-scoping flat shape: { actions, seenKeys, codePreview, lastPageUrl }.
      out.push({ key, state, windowId: null, legacy: true, updatedAt: Number(state.updatedAt) || 0 });
    } else if (key.indexOf(LL_RECORDER_KEY_PREFIX) === 0) {
      const suffix = key.slice(LL_RECORDER_KEY_PREFIX.length);
      const n = Number(suffix);
      out.push({
        key, state,
        windowId: suffix !== '' && suffix !== 'default' && Number.isFinite(n) ? n : null,
        legacy: false,
        updatedAt: Number(state.updatedAt) || 0
      });
    }
  });
  return out;
}

function listLiveWindowIds(cb) {
  try {
    if (chrome.windows && typeof chrome.windows.getAll === 'function') {
      chrome.windows.getAll({}, (wins) => {
        if (chrome.runtime.lastError || !Array.isArray(wins)) { cb(null); return; }
        cb(new Set(wins.map(w => w.id)));
      });
      return;
    }
  } catch (e) {}
  cb(null);
}

function hasRecorderContent(state) {
  return !!state && ((Array.isArray(state.actions) && state.actions.length > 0) ||
    (typeof state.lastPageUrl === 'string' && state.lastPageUrl !== ''));
}

/** Pick this window's entry, or adopt an orphan. Returns { entry, stale[] }. */
function chooseRecorderEntry(entries, windowId, liveIds) {
  const ownKey = recorderStorageKey(windowId);
  const own = entries.find(e => e.key === ownKey);
  const isOrphan = (e) => {
    if (e.key === ownKey) return false;
    if (e.legacy) return true;
    if (liveIds) return !(typeof e.windowId === 'number' && liveIds.has(e.windowId));
    return e.windowId === null; // can't tell which windows exist — only the shared default
  };
  const orphans = entries.filter(isOrphan);
  let entry = own && hasRecorderContent(own.state) ? own : null;
  if (!entry) {
    entry = orphans
      .filter(e => hasRecorderContent(e.state))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
  }
  const now = Date.now();
  const stale = orphans.filter(e => e !== entry && (e.legacy || now - e.updatedAt > LL_ORPHAN_STATE_TTL_MS));
  return { entry, stale };
}

/** Restore a saved state into memory, then merge whatever arrived in the meantime. */
function applyRestoredState(s) {
  const early = recordedActions;
  recordedActions = (Array.isArray(s && s.actions) ? s.actions : [])
    .filter(a => a && typeof a === 'object')
    .map(sanitizeStep);
  // Keep only the stable (eventId / sequence) keys: the legacy fallback key embeds
  // the step's value — for an old password step, the password itself.
  const savedKeys = Array.isArray(s && s.seenKeys) ? s.seenKeys : [];
  seenActionKeys = new Set(savedKeys.filter(k => typeof k === 'string' && (k.indexOf('eid:') === 0 || k.indexOf('seq:') === 0)));
  recordedActions.forEach(a => seenActionKeys.add(dedupeKeyForAction(a)));
  if (s && typeof s.lastPageUrl === 'string' && s.lastPageUrl) recLastPageUrl = s.lastPageUrl;

  // The edited script belongs to the target it was written for.
  const savedCode = s && s.codePreview != null ? String(s.codePreview) : '';
  if (savedCode.trim() !== '' && s.codeEdited !== false && s.codeFramework && s.codeLanguage &&
      typeof LLCodegen !== 'undefined' && LLCodegen.isValidCombo(s.codeFramework, s.codeLanguage) &&
      (s.codeFramework !== outFramework || s.codeLanguage !== outLanguage)) {
    outFramework = s.codeFramework;
    outLanguage = s.codeLanguage;
    syncOutputSelects();
    if (lastResultData) renderResults(lastResultData);
  }

  const ta = document.getElementById('codePreview');
  const label = document.getElementById('codePreviewLabel');
  if (ta && recordedActions.length > 0) {
    const generated = generateTestScript();
    if (savedCode.trim() !== '' && savedCode !== generated) {
      // A hand-edited script: show it, and remember what it was generated from so
      // later steps are reported as missing from it rather than silently absent.
      setPreviewCode(ta, savedCode);
      lastSyncedPreviewScript = generated;
      lastSyncedStepKeys = Array.isArray(s.syncedStepKeys) && s.syncedStepKeys.length
        ? s.syncedStepKeys.slice()
        : recordedActions.map(dedupeKeyForAction);
      ta.style.display = '';
      if (label) label.style.display = '';
    } else {
      lastSyncedPreviewScript = getPreviewText(ta);
    }
  }

  // Steps that were already in memory before the restore (rare) go back on top.
  early.forEach(a => {
    const key = dedupeKeyForAction(a);
    if (seenActionKeys.has(key)) return;
    seenActionKeys.add(key);
    recordedActions.push(a);
  });
}

function finishRecorderRestore() {
  _recorderRestored = true;
  const queued = _pendingRecorded.splice(0);
  queued.forEach((q) => {
    if (q.supersedes) receiveSupersede(q.supersedes);
    else receiveRecordedAction(q.action);
  });
  updateRecPageUrlUI();
  renderTimeline();
  updateCodePreview();
  scheduleRecorderPersist();
}

function loadRecorderState(callback) {
  const done = () => {
    if (!_recorderRestored) finishRecorderRestore();
    if (typeof callback === 'function') callback();
  };
  if (!chrome.storage || !chrome.storage.local) {
    done();
    return;
  }
  whenWindowId((windowId) => whenOutputReady(() => {
    chrome.storage.local.get(null, (all) => {
      void chrome.runtime.lastError;
      // Clear Timeline (or anything else) may have settled the state meanwhile.
      if (_recorderRestored) { done(); return; }
      listLiveWindowIds((liveIds) => {
        if (_recorderRestored) { done(); return; }
        const { entry, stale } = chooseRecorderEntry(collectRecorderEntries(all), windowId, liveIds);
        if (entry) applyRestoredState(entry.state);
        const toRemove = stale.map(e => e.key);
        // Adopted from a closed window: it is ours now (re-saved under our key below).
        if (entry && entry.key !== recorderStorageKey(windowId)) toRemove.push(entry.key);
        if (toRemove.length) chrome.storage.local.remove(toRemove, () => { void chrome.runtime.lastError; });
        done();
      });
    });
  }));
}

function dedupeKeyForAction(actionData) {
  if (actionData.eventId && typeof actionData.eventId === 'string') {
    return 'eid:' + actionData.eventId;
  }
  const tabId = typeof actionData.tabId === 'number' && !Number.isNaN(actionData.tabId) ? actionData.tabId : 0;
  if (typeof actionData.sequence === 'number' && !Number.isNaN(actionData.sequence)) {
    return 'seq:' + tabId + ':' + actionData.sequence;
  }
  const code = actionData.code || '';
  // Never let a sensitive value into a key — keys are persisted.
  const val = actionData.sensitive ? '' : (actionData.value != null ? String(actionData.value) : '');
  return `${tabId}_${actionData.timestamp}_${actionData.action}_${val}_${code}`;
}

/**
 * Removing/undoing a step must not let a re-delivery (the background's buffer
 * replay, a reconnect) bring it back, so stable eventId/sequence keys are kept.
 * Only the legacy content-derived key is released.
 */
function forgetActionKey(act) {
  const key = dedupeKeyForAction(act);
  if (key.indexOf('eid:') === 0 || key.indexOf('seq:') === 0) return;
  seenActionKeys.delete(key);
}

/** C6: drop the click steps a dblclick replaced. Returns how many were removed. */
function removeSupersededSteps(ids) {
  const set = new Set((ids || []).filter(x => x != null).map(String));
  if (!set.size) return 0;
  // A superseded click that arrives after its dblclick must stay out too.
  set.forEach(id => seenActionKeys.add('eid:' + id));
  const before = recordedActions.length;
  recordedActions = recordedActions.filter(a => !(a && a.eventId != null && set.has(String(a.eventId))));
  return before - recordedActions.length;
}

function appendToRecorder(actionData) {
  if (!actionData || typeof actionData !== 'object') return;
  const act = sanitizeStep(actionData);

  const key = dedupeKeyForAction(act);
  if (seenActionKeys.has(key)) return;
  seenActionKeys.add(key);
  // Trim in memory too, not only when persisting: a long session used to grow this
  // without bound. A Set iterates in insertion order, so this drops the oldest keys,
  // which are the least likely to be re-delivered.
  if (seenActionKeys.size > LL_MAX_SEEN_KEYS) {
    let excess = seenActionKeys.size - LL_MAX_SEEN_KEYS;
    for (const old of seenActionKeys) {
      seenActionKeys.delete(old);
      if (--excess <= 0) break;
    }
  }

  if (Array.isArray(act.supersedes) && act.supersedes.length) removeSupersededSteps(act.supersedes);

  recRedoStack = []; // a newly captured action invalidates the redo history
  recordedActions.push(act);
  if (act.url && typeof act.url === 'string') {
    recLastPageUrl = act.url;
    updateRecPageUrlUI();
  }
  renderTimeline();
  updateCodePreview();
  scheduleRecorderPersist();

  // Auto-scroll timeline to bottom
  const timelineList = document.getElementById('recorderTimeline');
  if (timelineList) timelineList.scrollTop = timelineList.scrollHeight;
}
