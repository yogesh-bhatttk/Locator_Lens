let isInspecting = false;
let isRecording = false;
let isPaused = false; // recording is live but paused; only meaningful while isRecording
let recordedActions = [];
let recLastPageUrl = '';
let _recorderSaveTimer = null;
let _recorderSavePending = false;
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

// ── Feature state (declared up front: load-time callbacks can reach these) ────
// Settings shared with the content script / worker (chrome.storage.local).
const LL_SETTINGS_KEY = 'llSettings';
let llSettings = { autoAssertions: true, stepScreenshots: true };
// captureVisibleTab needs <all_urls> (optional, requested at runtime) or an
// activeTab grant. null = not known yet.
const LL_SHOT_ORIGINS = ['<all_urls>'];
let screenshotPermission = null;
let screenshotPermDeclined = false;
let _shotNoticeShownOnce = false;
let _wasRecording = false;

// Replay: one run at a time. Statuses are keyed by the step object itself, so a
// step removed or a suggestion accepted mid-run never shifts another step's badge.
const REPLAY_STATUSES = ['pending', 'running', 'passed', 'failed', 'skipped'];
const REPLAY_WATCHDOG_MS = 30000;
const REPLAY_STOP_GRACE_MS = 3000;
let replayRun = null;
let replayStatuses = new Map();
let replaySecretsOpen = false;

// Page Object export (in-memory only).
let pomModel = null;
let _pomLastResultJson = '';

// Step thumbnails: eventId → { url, width, height } (null = nothing stored yet).
const thumbCache = new Map();
const _thumbGen = new Map();
const _thumbInFlight = new Set();
let _thumbModalOpener = null;

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
  renderPomPreview();
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
      renderPomPreview();
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
  // An undone step stays restorable through Redo, so its screenshot is kept until
  // the redo history is dropped (see appendToRecorder / discardThumbs).
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
  if (msg.type === 'REPLAY_PROGRESS') handleReplayProgress(msg);
  if (msg.type === 'REPLAY_DONE') handleReplayDone(msg);
  if (msg.type === 'POM_RESULT' && msg.data) handlePomResult(msg.data);
  if (msg.type === 'POM_PICK_CANCELLED') handlePomPickCancelled();
  if (msg.type === 'STEP_THUMBNAIL') onStepThumbnail(msg.eventId);
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
  if (isFromContentScript(sender)) {
    // Exception: the region picker's Esc. It is idempotent, and sender.tab tells us
    // whether it came from one of this window's tabs.
    if (msg && msg.type === 'POM_PICK_CANCELLED' && sender.tab) {
      whenWindowId((windowId) => {
        if (typeof windowId !== 'number' || sender.tab.windowId === windowId) handlePomPickCancelled();
      });
    }
    return;
  }
  if (!msg) return;
  whenWindowId(() => handleRuntimeMessage(msg));
});

// While the screenshot preview is open, focus that wanders out of it is pulled back.
document.addEventListener('focusin', (e) => {
  if (!isThumbModalOpen()) return;
  const modal = document.getElementById('thumbModal');
  const close = document.getElementById('thumbModalClose');
  if (modal && close && !modal.contains(e.target)) close.focus();
});

// A grant/revoke made elsewhere (another panel, the browser's extension page).
try {
  if (chrome.permissions) {
    ['onAdded', 'onRemoved'].forEach((ev) => {
      const e = chrome.permissions[ev];
      if (e && typeof e.addListener === 'function') e.addListener(() => checkScreenshotPermission());
    });
  }
} catch (e) {}

// Settings can change from another window's panel; keep this one's toggles honest.
try {
  if (chrome.storage && chrome.storage.onChanged && typeof chrome.storage.onChanged.addListener === 'function') {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area && area !== 'local') return;
      if (changes && changes[LL_SETTINGS_KEY]) {
        llSettings = normalizeSettings(changes[LL_SETTINGS_KEY].newValue);
        applySettingsUI();
        updateScreenshotNotices();
      }
    });
  }
} catch (e) {}

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
      // The worker aborts a window's replay when its panel port goes away.
      if (replayRun) finishReplay('interrupted', 'the connection to the extension was lost');
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
  window.addEventListener('beforeunload', () => {
    clearInterval(panelHeartbeatId);
    flushRecorderPersist();
    // The redo history dies with the panel, so its screenshots can go (best effort;
    // anything missed is pruned by age in the worker).
    discardThumbs(recRedoStack);
  });
  window.addEventListener('pagehide', flushRecorderPersist);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshRecordingState();
    else flushRecorderPersist();
  });

  // ── Recorder Controls ──
  document.getElementById('recordBtn').addEventListener('click', toggleRecording);

  document.getElementById('clearTimelineBtn').addEventListener('click', () => {
    if (replayRun) stopReplay(true);
    // Screenshots go with the timeline. THUMBS_CLEAR covers this window; the explicit
    // ids also cover a timeline adopted from a window that no longer exists.
    const thumbIds = eventIdsOf(recordedActions.concat(recRedoStack));
    if (thumbIds.length) sendToBackground({ type: 'THUMBS_DELETE', eventIds: thumbIds });
    sendToBackground({ type: 'THUMBS_CLEAR' });
    releaseAllThumbs();
    replayStatuses = new Map();
    setReplaySummary('', '');
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
    const thumbBtn = e.target.closest ? e.target.closest('.ll-thumb-btn') : null;
    if (thumbBtn) {
      openThumbPreview(thumbBtn.getAttribute('data-eid'), thumbBtn);
      return;
    }
    if (e.target.classList.contains('accept-step-btn')) {
      acceptSuggestion(parseInt(e.target.getAttribute('data-index'), 10));
      return;
    }
    if (e.target.classList.contains('dismiss-step-btn')) {
      dismissSuggestion(parseInt(e.target.getAttribute('data-index'), 10));
      return;
    }
    // 1. Handle step removal
    if (e.target.classList.contains('remove-step-btn')) {
      const idx = parseInt(e.target.getAttribute('data-index'), 10);
      if (isNaN(idx) || idx < 0 || idx >= recordedActions.length) return;
      const removed = recordedActions.splice(idx, 1)[0];
      if (removed) {
        forgetActionKey(removed);
        // Removed with ✕ (not Undo): nothing can bring it back, so neither can its screenshot.
        discardThumbs([removed]);
      }

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

  initSettings();
  initReplayControls();
  initSuggestionControls();
  initPomControls();
  initThumbModal();

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

  // A replay drives the page; starting/stopping a recording underneath it would
  // fight the worker's own pause-and-restore around the run.
  if (btn && !_recToggleBusy) btn.disabled = !!replayRun;
  if (isRecording && !_wasRecording) { _wasRecording = true; onRecordingStarted(); }
  else if (!isRecording && _wasRecording) {
    _wasRecording = false;
    const tl = document.getElementById('shotPermTimelineNotice');
    if (tl) tl.hidden = true;
  }

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
  updateReplayUI();
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
  updateSuggestionsBar();
  updateReplayUI();
  pruneThumbCache();

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
      const isSuggested = !!act.suggested;
      let codeStr = '';
      try {
        // A suggestion previews the line it would add once accepted.
        codeStr = buildActionCode(isSuggested ? Object.assign({}, act, { suggested: false }) : act);
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
      const rs = replayStatuses.get(act);
      const rsName = rs && REPLAY_STATUSES.indexOf(rs.status) !== -1 ? rs.status : '';
      const classes = 'll-rec-step' + (isAssert ? ' is-assert' : '') + (isSuggested ? ' is-suggested' : '') +
        (rsName ? ' replay-' + rsName : '');
      // Suggestions are not part of the script yet, so they offer Accept/Dismiss
      // rather than Copy/Remove.
      const buttons = isSuggested
        ? `<button type="button" class="clear-btn accept-step-btn" data-index="${i}" aria-label="Accept suggested step ${i + 1}: ${esc(actionName)}" title="Add this check to the test">✓ Accept</button>
             <button type="button" class="clear-btn dismiss-step-btn" data-index="${i}" aria-label="Dismiss suggested step ${i + 1}: ${esc(actionName)}" title="Discard this suggestion">✕ Dismiss</button>`
        : `<button type="button" class="clear-btn copy-btn" data-code="${esc(codeStr)}" aria-label="Copy code for step ${i + 1}: ${esc(actionName)}">Copy</button>
             <button type="button" class="clear-btn remove-step-btn" data-index="${i}" aria-label="Remove step ${i + 1}: ${esc(actionName)}" title="Remove step ${i + 1}">✕</button>`;
      const badge = rsName
        ? `<span class="ll-replay-badge rs-${rsName}" title="Replay: ${rsName}">${esc(REPLAY_BADGE_TEXT[rsName])}</span>`
        : '';
      const reason = isSuggested && act.reason ? `<div class="ll-rec-step-reason">💡 ${esc(String(act.reason).slice(0, 200))}</div>` : '';
      const replayErr = rs && rs.error && (rsName === 'failed' || rsName === 'skipped')
        ? `<div class="ll-replay-error">${esc(String(rs.error).slice(0, 500))}</div>`
        : '';
      const thumbSlot = !isSuggested && typeof act.eventId === 'string' && act.eventId
        ? `<div class="ll-thumb-slot" data-eid="${esc(act.eventId)}"></div>`
        : '';

      return `
      <div class="${classes}" data-step-index="${i}">
        <div class="ll-rec-step-head">
           <span class="ll-rec-step-label">${icon} #${i + 1} ${label}${isSuggested ? ' <span class="ll-suggest-badge">Suggested</span>' : ''}</span>
           ${badge}
           <div class="ll-rec-step-actions">
             ${buttons}
           </div>
        </div>
        ${reason}
        ${replayErr}
        ${thumbSlot}
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
  hydrateThumbs(timelineList);
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
    const needsLoc = ['click', 'dblclick', 'check', 'uncheck', 'fill', 'selectOption', 'hover', 'assert', 'upload'].indexOf(act.action) !== -1 &&
      !isUrlAssert(act);
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
    case 'assert':
      if (isUrlAssert(act)) return `await expect(page).toHaveURL(${JSON.stringify(valStr)});`;
      return act.fullCode || `await expect(${locator}).toBeVisible();`;
    default: return act.fullCode || `await ${locator}.click();`;
  }
}

function generateTestScript() {
  if (typeof LLCodegen !== 'undefined') {
    // buildActionCode() controls per-line fidelity; wrapScript() supplies the
    // framework/language-correct file scaffold (imports, harness, indentation).
    const steps = committedActions();
    return LLCodegen.wrapScript(steps.map(buildActionCode), outFramework, outLanguage, steps);
  }
  const lines = committedActions().map(act => `  ${buildActionCode(act)}`).join('\n');
  return `import { test, expect } from '@playwright/test';

test('recorded test', async ({ page }) => {
${lines}
});
`;
}

/** Text shown in the editor, or generated from the timeline if the editor is empty. */
function getExportedTestScript() {
  const ta = document.getElementById('codePreview');
  const hasSteps = committedActions().length > 0;
  if (!ta || ta.style.display === 'none') {
    return hasSteps ? generateTestScript() : '';
  }
  const v = getPreviewText(ta).trim();
  return v || (hasSteps ? generateTestScript() : '');
}

/** Last script we pushed into the editor (so we can tell a hand edit from our own output). */
let lastSyncedPreviewScript = '';
/** Dedupe keys of the steps that script was generated from (drives the "N new steps" notice). */
let lastSyncedStepKeys = [];

function markEditorSynced(script) {
  lastSyncedPreviewScript = script;
  lastSyncedStepKeys = committedActions().map(dedupeKeyForAction);
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
  if (committedActions().length === 0) return;
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
  const current = committedActions().map(dedupeKeyForAction);
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

  // Suggestions alone don't make a script: they are excluded until accepted.
  if (committedActions().length === 0) {
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
  _recorderSavePending = true;
  _recorderSaveTimer = setTimeout(persistRecorderState, 200);
}

// The save above is debounced, so an edit made in the last 200 ms before the panel
// closes (a dismissed suggestion, a removed step) was never written and came back on
// reopen. Write it now instead when the panel is going away.
function flushRecorderPersist() {
  if (!_recorderSavePending) return;
  clearTimeout(_recorderSaveTimer);
  persistRecorderState();
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
  _recorderSavePending = false;
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
  if (ta && committedActions().length > 0) {
    const generated = generateTestScript();
    if (savedCode.trim() !== '' && savedCode !== generated) {
      // A hand-edited script: show it, and remember what it was generated from so
      // later steps are reported as missing from it rather than silently absent.
      setPreviewCode(ta, savedCode);
      lastSyncedPreviewScript = generated;
      lastSyncedStepKeys = Array.isArray(s.syncedStepKeys) && s.syncedStepKeys.length
        ? s.syncedStepKeys.slice()
        : committedActions().map(dedupeKeyForAction);
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
  const removed = recordedActions.filter(a => a && a.eventId != null && set.has(String(a.eventId)));
  if (!removed.length) return 0;
  recordedActions = recordedActions.filter(a => removed.indexOf(a) === -1);
  discardThumbs(removed);
  return removed.length;
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

  // A newly captured action invalidates the redo history — and with it the last
  // chance to bring those steps (and their screenshots) back.
  if (recRedoStack.length) discardThumbs(recRedoStack);
  recRedoStack = [];
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

// ══ Settings (llSettings) ═════════════════════════════════════════════════════
// { autoAssertions, stepScreenshots } — both default on; a missing key or field
// means the default. The content script and worker read the same key.
function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    autoAssertions: s.autoAssertions !== false,
    stepScreenshots: s.stepScreenshots !== false
  };
}

function applySettingsUI() {
  const a = document.getElementById('settingAutoAssertions');
  const s = document.getElementById('settingStepScreenshots');
  if (a) a.checked = llSettings.autoAssertions;
  if (s) s.checked = llSettings.stepScreenshots;
}

function saveSettingsFromUI() {
  const a = document.getElementById('settingAutoAssertions');
  const s = document.getElementById('settingStepScreenshots');
  llSettings = normalizeSettings({
    autoAssertions: a ? a.checked : llSettings.autoAssertions,
    stepScreenshots: s ? s.checked : llSettings.stepScreenshots
  });
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ [LL_SETTINGS_KEY]: Object.assign({}, llSettings) }, () => { void chrome.runtime.lastError; });
  }
}

function initSettings() {
  const auto = document.getElementById('settingAutoAssertions');
  if (auto) auto.addEventListener('change', saveSettingsFromUI);
  const shots = document.getElementById('settingStepScreenshots');
  if (shots) shots.addEventListener('change', () => {
    // The permission prompt needs this user gesture: ask before anything async.
    if (shots.checked && screenshotPermission !== true) requestScreenshotPermission();
    saveSettingsFromUI();
    updateScreenshotNotices();
  });
  ['shotPermGrantBtn', 'shotPermTimelineGrantBtn'].forEach((id) => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', () => requestScreenshotPermission());
  });
  const dismiss = document.getElementById('shotPermTimelineDismiss');
  if (dismiss) dismiss.addEventListener('click', () => {
    const n = document.getElementById('shotPermTimelineNotice');
    if (n) n.hidden = true;
  });
  applySettingsUI();
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(LL_SETTINGS_KEY, (res) => {
      void chrome.runtime.lastError;
      llSettings = normalizeSettings(res && res[LL_SETTINGS_KEY]);
      applySettingsUI();
      updateScreenshotNotices();
    });
  }
  checkScreenshotPermission();
}

// ── Screenshot permission ────────────────────────────────────────────────────
function permissionsApi() {
  return chrome.permissions && typeof chrome.permissions.contains === 'function' ? chrome.permissions : null;
}

/** Re-read whether <all_urls> is granted; `cb(granted|null)` after the notices update. */
function checkScreenshotPermission(cb) {
  const done = (granted) => {
    if (typeof granted === 'boolean') {
      screenshotPermission = granted;
      if (granted) screenshotPermDeclined = false;
    }
    updateScreenshotNotices();
    if (typeof cb === 'function') cb(screenshotPermission);
  };
  const api = permissionsApi();
  if (api) {
    try {
      api.contains({ origins: LL_SHOT_ORIGINS }, (granted) => {
        void chrome.runtime.lastError;
        done(typeof granted === 'boolean' ? granted : null);
      });
      return;
    } catch (e) {}
  }
  sendToBackground({ type: 'GET_SCREENSHOT_PERMISSION' }, (res) => {
    done(res && typeof res.granted === 'boolean' ? res.granted : null);
  });
}

/**
 * Ask for <all_urls>. Must run synchronously inside a click/change handler —
 * browsers only show the prompt for a user gesture.
 */
function requestScreenshotPermission() {
  const api = chrome.permissions && typeof chrome.permissions.request === 'function' ? chrome.permissions : null;
  if (!api) return;
  let settled = false;
  const after = (granted) => {
    if (settled) return;
    settled = true;
    void chrome.runtime.lastError;
    screenshotPermDeclined = granted !== true;
    if (granted === true) screenshotPermission = true;
    checkScreenshotPermission();
  };
  try {
    const p = api.request({ origins: LL_SHOT_ORIGINS }, after);
    // Promise-style implementations (Firefox's) may ignore the callback.
    if (p && typeof p.then === 'function') p.then(after, () => after(false));
  } catch (e) {
    after(false);
  }
}

function screenshotNoticeNeeded() {
  return llSettings.stepScreenshots && screenshotPermission === false;
}

function updateScreenshotNotices() {
  const need = screenshotNoticeNeeded();
  const settingsNotice = document.getElementById('shotPermNotice');
  if (settingsNotice) settingsNotice.hidden = !need;
  const tl = document.getElementById('shotPermTimelineNotice');
  if (tl && !need) tl.hidden = true;
  document.querySelectorAll('.ll-perm-declined').forEach((el) => { el.hidden = !(need && screenshotPermDeclined); });
}

/** A recording just started: point out missing screenshot access once per panel session. */
function onRecordingStarted() {
  if (_shotNoticeShownOnce || !llSettings.stepScreenshots) return;
  checkScreenshotPermission(() => {
    if (_shotNoticeShownOnce || !screenshotNoticeNeeded()) return;
    _shotNoticeShownOnce = true;
    const tl = document.getElementById('shotPermTimelineNotice');
    if (tl) tl.hidden = false;
  });
}

// ══ F3: suggested assertions ══════════════════════════════════════════════════
// The content script proposes checks (suggested:true). They show in the timeline
// but stay out of the script, replay, copy and download until accepted.
function committedActions() {
  return recordedActions.filter(a => a && !a.suggested);
}

function isUrlAssert(act) {
  return !!act && act.action === 'assert' && act.assertType === 'toHaveURL';
}

function afterTimelineEdit() {
  renderTimeline();
  updateCodePreview();
  scheduleRecorderPersist();
}

function acceptSuggestion(idx) {
  const act = recordedActions[idx];
  if (!act || !act.suggested) return;
  act.suggested = false;
  afterTimelineEdit();
  focusStepControl(idx, '.copy-btn');
}

function dismissSuggestion(idx) {
  const act = recordedActions[idx];
  if (!act || !act.suggested) return;
  recordedActions.splice(idx, 1);
  // Stays "seen": a re-delivery of the same event must not bring it back.
  seenActionKeys.add(dedupeKeyForAction(act));
  afterTimelineEdit();
  // Keep keyboard users in the list: the row that took its place, else the last one.
  const tl = document.getElementById('recorderTimeline');
  const rows = tl ? tl.querySelectorAll('.ll-rec-step') : [];
  const row = rows[Math.min(idx, rows.length - 1)];
  const btn = row && row.querySelector('.ll-rec-step-actions button');
  if (btn) btn.focus();
  else if (tl) tl.focus();
}

function acceptAllSuggestions() {
  let n = 0;
  recordedActions.forEach((a) => {
    if (a && a.suggested) { a.suggested = false; n++; }
  });
  if (n) afterTimelineEdit();
}

function focusStepControl(idx, selector) {
  const tl = document.getElementById('recorderTimeline');
  if (!tl) return;
  const row = tl.querySelector(`.ll-rec-step[data-step-index="${idx}"]`);
  const ctl = row && row.querySelector(selector);
  if (ctl) ctl.focus();
}

function updateSuggestionsBar() {
  const bar = document.getElementById('suggestionsBar');
  if (!bar) return;
  const n = recordedActions.filter(a => a && a.suggested).length;
  bar.hidden = n === 0;
  const txt = document.getElementById('suggestionsText');
  if (txt) {
    txt.textContent = n === 1
      ? '1 suggested assertion — not in the test until you accept it.'
      : `${n} suggested assertions — not in the test until you accept them.`;
  }
}

function initSuggestionControls() {
  const all = document.getElementById('acceptAllSuggestionsBtn');
  if (all) all.addEventListener('click', acceptAllSuggestions);
  const review = document.getElementById('reviewSuggestionsBtn');
  if (review) review.addEventListener('click', () => {
    if (recFilter) {
      recFilter = '';
      const fi = document.getElementById('recFilterInput');
      if (fi) fi.value = '';
      const fc = document.getElementById('recFilterClear');
      if (fc) fc.style.display = 'none';
      renderTimeline();
    }
    setTimelineExpanded(true);
    const first = document.querySelector('#recorderTimeline .ll-rec-step.is-suggested');
    if (first) {
      if (typeof first.scrollIntoView === 'function') first.scrollIntoView({ block: 'nearest' });
      const btn = first.querySelector('.accept-step-btn');
      if (btn) btn.focus();
    }
  });
}

// ══ F1: replay ════════════════════════════════════════════════════════════════
const REPLAY_BADGE_TEXT = {
  pending: '• pending', running: '⟳ running', passed: '✓ passed', failed: '✗ failed', skipped: '↷ skipped'
};

function setReplaySummary(text, kind) {
  const el = document.getElementById('replaySummary');
  if (!el) return;
  el.textContent = String(text || '');
  el.className = 'll-replay-summary' + (kind ? ' ' + kind : '');
  el.hidden = !text;
}

function updateReplayUI() {
  const btn = document.getElementById('replayBtn');
  const stop = document.getElementById('stopReplayBtn');
  const active = !!replayRun;
  const n = committedActions().length;
  if (btn) {
    btn.disabled = active || replaySecretsOpen || n === 0;
    btn.textContent = active ? '⟳ Replaying…' : '▶ Replay';
    btn.title = n === 0
      ? 'Record at least one step to replay it'
      : (isRecording && !isPaused
        ? 'Pauses recording, replays the steps in this tab, then resumes recording'
        : 'Replay the recorded steps in this tab');
  }
  if (stop) {
    stop.hidden = !active;
    stop.disabled = !!(replayRun && replayRun.stopping);
  }
  // The worker pauses the session for the run; manual pause/resume would fight it.
  ['pauseRecordingBtn', 'resumeRecordingBtn'].forEach((id) => {
    const b = document.getElementById(id);
    if (b) b.disabled = active;
  });
}

/** Unique env-var names of the sensitive steps, in order of first use. */
function secretNamesFor(steps) {
  const out = [];
  steps.forEach((a) => {
    if (!a || !a.sensitive) return;
    const name = secretNameOf(a);
    if (out.indexOf(name) === -1) out.push(name);
  });
  return out;
}

function onReplayClick() {
  if (replayRun || replaySecretsOpen) return;
  const steps = committedActions();
  if (!steps.length) return;
  setReplaySummary('', '');
  const names = secretNamesFor(steps);
  if (names.length) {
    openReplaySecrets(names);
    return;
  }
  startReplay(steps, {});
}

function openReplaySecrets(names) {
  const box = document.getElementById('replaySecrets');
  const fields = document.getElementById('replaySecretsFields');
  if (!box || !fields) {
    startReplay(committedActions(), {});
    return;
  }
  fields.textContent = '';
  names.forEach((name, i) => {
    const label = document.createElement('label');
    label.className = 'll-secret-field';
    const id = 'replaySecret-' + i;
    label.setAttribute('for', id);
    const span = document.createElement('span');
    span.textContent = name;
    const input = document.createElement('input');
    input.type = 'password';
    input.id = id;
    input.autocomplete = 'off';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('data-secret-name', name);
    input.setAttribute('aria-label', 'Value for ' + name + ' (used for this replay only)');
    label.appendChild(span);
    label.appendChild(input);
    fields.appendChild(label);
  });
  box.hidden = false;
  replaySecretsOpen = true;
  updateReplayUI();
  const first = fields.querySelector('input');
  if (first) first.focus();
}

/** Hide the form and wipe every value typed into it. */
function closeReplaySecrets() {
  const box = document.getElementById('replaySecrets');
  const fields = document.getElementById('replaySecretsFields');
  if (fields) {
    fields.querySelectorAll('input').forEach((i) => { i.value = ''; });
    fields.textContent = '';
  }
  if (box) box.hidden = true;
  replaySecretsOpen = false;
  updateReplayUI();
}

function submitReplaySecrets() {
  const fields = document.getElementById('replaySecretsFields');
  const secrets = {};
  if (fields) {
    fields.querySelectorAll('input[data-secret-name]').forEach((i) => {
      // Empty means "skip those steps" — the page reports them as skipped.
      if (i.value !== '') secrets[i.getAttribute('data-secret-name')] = i.value;
    });
  }
  closeReplaySecrets();
  const btn = document.getElementById('replayBtn');
  if (btn) btn.focus();
  const steps = committedActions();
  if (steps.length) startReplay(steps, secrets);
}

function replayOptions() {
  const sof = document.getElementById('replayStopOnFailure');
  const slow = document.getElementById('replaySlowMo');
  return {
    stopOnFailure: sof ? !!sof.checked : true,
    slowMoMs: slow && slow.checked ? 400 : 0,
    stepTimeoutMs: 5000
  };
}

/**
 * Start a run. `secrets` only rides along in the REPLAY_START message — nothing
 * here keeps a reference to it afterwards, and it is never persisted.
 */
function startReplay(steps, secrets) {
  if (replayRun) return;
  const run = {
    runId: null,
    steps: steps.slice(),
    pausedRecording: false,
    stopping: false,
    watchdog: null,
    stopTimer: null
  };
  replayRun = run;
  replayStatuses = new Map();
  run.steps.forEach(s => replayStatuses.set(s, { status: 'pending', error: '' }));
  setTimelineExpanded(true);
  setReplaySummary(`Replaying ${run.steps.length} step${run.steps.length === 1 ? '' : 's'}…`, 'info');
  renderTimeline();
  updateRecordUI();
  armReplayWatchdog(run);

  let payloadSecrets = secrets && typeof secrets === 'object' ? secrets : {};
  const go = () => {
    if (replayRun !== run) return; // stopped before it began
    const msg = {
      type: 'REPLAY_START',
      steps: run.steps.map(s => Object.assign({}, s)),
      secrets: payloadSecrets,
      options: replayOptions()
    };
    payloadSecrets = null;
    sendToBackground(msg, (res, err) => {
      if (replayRun !== run) return;
      if (!res || res.ok === false) {
        const why = (res && res.error) ||
          (err ? "the extension's background worker didn't answer — reload the page and try again" : 'it could not start');
        finishReplay('error', why);
        return;
      }
      if (run.runId == null && res.runId != null) run.runId = res.runId;
      armReplayWatchdog(run);
    });
  };

  // A live recording would capture the replayed actions: pause it first and
  // resume once the run is over (the worker also guards this on its side).
  if (isRecording && !isPaused) {
    run.pausedRecording = true;
    isPaused = true;
    updateRecordUI();
    sendRecorderCommand({ type: 'PAUSE_RECORDING' }, () => go());
  } else {
    go();
  }
}

function armReplayWatchdog(run) {
  if (run.watchdog) clearTimeout(run.watchdog);
  run.watchdog = setTimeout(() => {
    run.watchdog = null;
    if (replayRun !== run) return;
    sendToBackground({ type: 'REPLAY_STOP' });
    finishReplay('interrupted', 'no progress from the page for 30 s');
  }, REPLAY_WATCHDOG_MS);
}

/** True when a progress/done message belongs to the current run (adopting its id if unknown yet). */
function replayMessageMatches(run, msg) {
  if (msg.runId == null) return true;
  if (run.runId == null) {
    // Progress can overtake the REPLAY_START response.
    run.runId = msg.runId;
    return true;
  }
  return msg.runId === run.runId;
}

function handleReplayProgress(msg) {
  const run = replayRun;
  if (!run || !replayMessageMatches(run, msg)) return;
  const idx = msg.index;
  if (typeof idx !== 'number' || idx < 0 || idx >= run.steps.length || Math.floor(idx) !== idx) return;
  if (REPLAY_STATUSES.indexOf(msg.status) === -1) return;
  const stepObj = run.steps[idx];
  replayStatuses.set(stepObj, {
    status: msg.status,
    error: msg.error ? String(msg.error) : '',
    matchCount: msg.matchCount,
    durationMs: msg.durationMs
  });
  armReplayWatchdog(run);
  renderTimeline();
  if (msg.status === 'failed') revealReplayStep(stepObj, true);
  else if (msg.status === 'running') revealReplayStep(stepObj, false);
}

function handleReplayDone(msg) {
  const run = replayRun;
  if (!run || !replayMessageMatches(run, msg)) return;
  const result = ['passed', 'failed', 'stopped', 'error'].indexOf(msg.result) !== -1 ? msg.result : 'error';
  finishReplay(result, msg.error ? String(msg.error) : '', msg.failedIndex);
}

/** Display number (#N in the timeline) of a replayed step. */
function timelineNumberOf(stepObj, fallbackIndex) {
  const i = recordedActions.indexOf(stepObj);
  return i !== -1 ? i + 1 : fallbackIndex + 1;
}

function finishReplay(result, error, failedIndex) {
  const run = replayRun;
  if (!run) return;
  replayRun = null;
  if (run.watchdog) clearTimeout(run.watchdog);
  if (run.stopTimer) clearTimeout(run.stopTimer);
  // Steps that never ran keep no badge once the run is over.
  replayStatuses.forEach((v, k) => {
    if (v.status === 'pending' || v.status === 'running') replayStatuses.delete(k);
  });

  let failedStep = null;
  const n = run.steps.length;
  if (result === 'passed') {
    setReplaySummary(`Replay passed (${n} step${n === 1 ? '' : 's'})`, 'ok');
  } else if (result === 'failed') {
    let fi = typeof failedIndex === 'number' && failedIndex >= 0 && failedIndex < n ? failedIndex : -1;
    if (fi === -1) {
      fi = run.steps.findIndex(s => { const st = replayStatuses.get(s); return st && st.status === 'failed'; });
    }
    let why = error;
    if (fi !== -1) {
      failedStep = run.steps[fi];
      const st = replayStatuses.get(failedStep);
      if (!why && st && st.error) why = st.error;
      if (!st || st.status !== 'failed') replayStatuses.set(failedStep, { status: 'failed', error: why || '' });
      setReplaySummary(`Replay failed at step ${timelineNumberOf(failedStep, fi)}: ${why || 'unknown error'}`, 'err');
    } else {
      setReplaySummary(`Replay failed: ${why || 'unknown error'}`, 'err');
    }
  } else if (result === 'stopped') {
    setReplaySummary('Replay stopped', 'warn');
  } else if (result === 'interrupted') {
    setReplaySummary(`Replay interrupted — ${error || 'no answer from the page'}`, 'err');
  } else {
    setReplaySummary(`Replay couldn't run: ${error || 'unknown error'}`, 'err');
  }

  renderTimeline();
  updateRecordUI();
  if (failedStep) revealReplayStep(failedStep, true);

  if (run.pausedRecording && isRecording && isPaused) {
    isPaused = false;
    updateRecordUI();
    sendRecorderCommand({ type: 'RESUME_RECORDING' });
  }
}

/** Scroll a replayed step into view; a failed one also drops the filter hiding it. */
function revealReplayStep(stepObj, isFailure) {
  const idx = recordedActions.indexOf(stepObj);
  if (idx === -1) return;
  const tl = document.getElementById('recorderTimeline');
  if (!tl) return;
  let row = tl.querySelector(`.ll-rec-step[data-step-index="${idx}"]`);
  if (!row && isFailure && recFilter) {
    recFilter = '';
    const fi = document.getElementById('recFilterInput');
    if (fi) fi.value = '';
    const fc = document.getElementById('recFilterClear');
    if (fc) fc.style.display = 'none';
    renderTimeline();
    row = tl.querySelector(`.ll-rec-step[data-step-index="${idx}"]`);
  }
  if (isFailure) setTimelineExpanded(true);
  if (row && typeof row.scrollIntoView === 'function') {
    row.scrollIntoView({ block: isFailure ? 'center' : 'nearest' });
  }
}

/** Ask the worker to stop; `immediate` ends the run here without waiting for REPLAY_DONE. */
function stopReplay(immediate) {
  const run = replayRun;
  if (!run) return;
  if (immediate) {
    sendToBackground({ type: 'REPLAY_STOP' });
    finishReplay('stopped');
    return;
  }
  if (run.stopping) return;
  run.stopping = true;
  setReplaySummary('Stopping replay…', 'info');
  updateReplayUI();
  sendToBackground({ type: 'REPLAY_STOP' }, () => {
    if (replayRun !== run) return;
    // REPLAY_DONE normally follows; don't hang if it never does.
    run.stopTimer = setTimeout(() => {
      if (replayRun === run) finishReplay('stopped');
    }, REPLAY_STOP_GRACE_MS);
  });
}

function initReplayControls() {
  const btn = document.getElementById('replayBtn');
  if (btn) btn.addEventListener('click', onReplayClick);
  const stop = document.getElementById('stopReplayBtn');
  if (stop) stop.addEventListener('click', () => stopReplay(false));
  const form = document.getElementById('replaySecretsForm');
  if (form) form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitReplaySecrets();
  });
  const cancel = document.getElementById('replaySecretsCancel');
  if (cancel) cancel.addEventListener('click', () => {
    closeReplaySecrets();
    if (btn) btn.focus();
  });
  const box = document.getElementById('replaySecrets');
  if (box) box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeReplaySecrets();
      if (btn) btn.focus();
    }
  });
  // A fresh DOM (panel reload) starts with no form open.
  replaySecretsOpen = false;
  updateReplayUI();
}

// ══ F2: Page Object export ════════════════════════════════════════════════════
// Names become class members in JS/TS and (snake_cased) Python, so they must be
// identifiers in both, avoid keywords, and not clash with the class's own members.
const POM_RESERVED = new Set((
  'break case catch class const continue debugger default delete do else enum export extends false finally for ' +
  'function if import in instanceof new null return super switch this throw true try typeof var void while with ' +
  'yield let static implements interface package private protected public await async arguments eval undefined ' +
  'nan infinity none and as assert def del elif except from global is lambda nonlocal not or pass raise self ' +
  'page driver goto visit constructor prototype match case type hasownproperty isprototypeof ' +
  'propertyisenumerable tolocalestring tostring valueof'
).split(' '));
const POM_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function pomNameError(name) {
  if (!name) return 'A name is required.';
  if (!POM_IDENT_RE.test(name)) return 'Use letters, digits and _ only, not starting with a digit.';
  if (POM_RESERVED.has(name.toLowerCase())) return `"${name}" is a reserved word or a built-in member.`;
  return '';
}

function setPomStatus(text, kind) {
  const el = document.getElementById('pomStatus');
  if (!el) return;
  el.textContent = String(text || '');
  el.className = 'll-pom-status' + (kind ? ' ' + kind : '');
  el.hidden = !text;
}

function hasPageObjectCodegen() {
  return typeof LLCodegen !== 'undefined' && typeof LLCodegen.pageObject === 'function';
}

function startPomPick(type) {
  const pick = type === 'POM_PICK_START';
  setPomStatus(pick
    ? 'Hover a container on the page and click it to pick it — Esc on the page cancels.'
    : 'Scanning the page…', 'info');
  sendToBackground({ type: type }, (res, err) => {
    if (res && res.ok === false) {
      setPomStatus(res.error || "Locatra can't run on this page.", 'err');
    } else if (err && !res) {
      setPomStatus("Couldn't reach the page. Reload it and try again.", 'err');
    }
  });
}

function handlePomPickCancelled() {
  setPomStatus('Region pick cancelled.', 'info');
}

function handlePomResult(data) {
  if (!data || typeof data !== 'object') return;
  // The same result can arrive twice (port relay + fallback broadcast); rebuilding
  // the list would throw away names the user already edited.
  let json = '';
  try { json = JSON.stringify(data); } catch (e) {}
  if (json && json === _pomLastResultJson && pomModel) return;
  _pomLastResultJson = json;

  const elements = (Array.isArray(data.elements) ? data.elements : [])
    .filter(e => e && typeof e === 'object')
    .map(e => Object.assign({}, e, { name: String(e.name || ''), include: true }));
  if (!elements.length) {
    pomModel = null;
    const res = document.getElementById('pomResult');
    if (res) res.hidden = true;
    setPomStatus('No interactive elements found there. Try a larger region or Whole page.', 'info');
    return;
  }
  pomModel = {
    pageUrl: typeof data.pageUrl === 'string' ? data.pageUrl : '',
    title: typeof data.title === 'string' ? data.title : '',
    region: data.region && typeof data.region === 'object' ? data.region : null,
    truncated: !!data.truncated,
    className: '',
    elements: elements
  };
  const cls = document.getElementById('pomClassName');
  if (cls) cls.value = '';
  setPomStatus(data.truncated
    ? `Found ${elements.length} elements (the list was capped — pick a smaller region for the rest).`
    : `Found ${elements.length} element${elements.length === 1 ? '' : 's'}.`, 'info');
  renderPomResult();
}

function renderPomResult() {
  const box = document.getElementById('pomResult');
  if (!box) return;
  if (!pomModel) { box.hidden = true; return; }
  box.hidden = false;

  const meta = document.getElementById('pomMeta');
  if (meta) {
    const parts = [];
    if (pomModel.region && pomModel.region.locator) parts.push('Region: ' + String(pomModel.region.locator));
    else if (pomModel.region && pomModel.region.tag) parts.push('Region: <' + String(pomModel.region.tag) + '>');
    else parts.push('Region: whole page');
    if (pomModel.pageUrl) parts.push('Page: ' + pomModel.pageUrl);
    meta.textContent = parts.join(' · ');
  }

  const list = document.getElementById('pomList');
  if (list) {
    list.textContent = '';
    pomModel.elements.forEach((el, i) => list.appendChild(buildPomRow(el, i)));
  }
  updatePomValidation();
}

function buildPomRow(el, i) {
  const row = document.createElement('div');
  row.className = 'll-pom-row' + (el.include ? '' : ' excluded');
  row.setAttribute('role', 'listitem');

  const kind = String(el.kind || 'other');
  const inc = document.createElement('input');
  inc.type = 'checkbox';
  inc.className = 'll-pom-include';
  inc.checked = !!el.include;
  inc.setAttribute('data-index', String(i));
  inc.setAttribute('aria-label', `Include element ${i + 1} (${kind}) in the Page Object`);

  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'll-pom-name';
  name.value = el.name;
  name.spellcheck = false;
  name.setAttribute('autocomplete', 'off');
  name.setAttribute('data-index', String(i));
  name.setAttribute('aria-label', `Name for element ${i + 1} (${kind})`);
  name.setAttribute('aria-describedby', 'pomErr-' + i);

  const info = document.createElement('div');
  info.className = 'll-pom-info';
  const kindEl = document.createElement('span');
  kindEl.className = 'll-pom-kind';
  kindEl.textContent = kind;
  info.appendChild(kindEl);
  const uniq = document.createElement('span');
  if (el.unique) {
    uniq.className = 'uniq uniq-ok';
    uniq.textContent = '✓ unique';
    uniq.title = 'The locator matches exactly one element';
  } else {
    const mc = typeof el.matchCount === 'number' ? el.matchCount : 0;
    uniq.className = 'uniq uniq-warn';
    uniq.textContent = mc > 1 ? `⚠ ${mc >= 10 ? '10+' : mc} matches` : '⚠ not unique';
    uniq.title = 'The locator is ambiguous — check it before relying on it';
  }
  info.appendChild(uniq);
  if (el.code) {
    const code = document.createElement('span');
    code.className = 'll-pom-code';
    const c = String(el.code);
    code.textContent = c.length > 120 ? c.slice(0, 117) + '…' : c;
    code.title = c;
    info.appendChild(code);
  }

  const err = document.createElement('div');
  err.className = 'll-pom-err';
  err.id = 'pomErr-' + i;
  err.hidden = true;

  row.appendChild(inc);
  row.appendChild(name);
  row.appendChild(info);
  row.appendChild(err);
  return row;
}

/** Per-row errors (invalid / duplicate names among included rows). */
function pomValidationErrors() {
  const errors = pomModel.elements.map(() => '');
  const seen = new Map();
  pomModel.elements.forEach((el, i) => {
    if (!el.include) return;
    const name = String(el.name || '').trim();
    const e = pomNameError(name);
    if (e) { errors[i] = e; return; }
    // emailInput and email_input collide once Python snake_cases them.
    const key = name.toLowerCase().replace(/_/g, '');
    if (seen.has(key)) {
      // Both rows are flagged, so the one being edited shows the problem whichever
      // comes first in the list.
      const first = seen.get(key);
      errors[i] = `Duplicate of "${pomModel.elements[first].name.trim()}".`;
      if (!errors[first]) errors[first] = `Duplicate of "${name}".`;
    } else seen.set(key, i);
  });
  return errors;
}

function pomClassNameError(v) {
  if (!v) return '';
  if (!POM_IDENT_RE.test(v)) return 'Use letters, digits and _ only, not starting with a digit.';
  if (POM_RESERVED.has(v.toLowerCase())) return `"${v}" is a reserved word.`;
  return '';
}

/** Refresh error markers + button state, then the preview. Returns true when exportable. */
function updatePomValidation() {
  if (!pomModel) return false;
  const errors = pomValidationErrors();
  const list = document.getElementById('pomList');
  errors.forEach((msg, i) => {
    const input = list && list.querySelector(`.ll-pom-name[data-index="${i}"]`);
    if (input) input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    const errEl = document.getElementById('pomErr-' + i);
    if (errEl) { errEl.textContent = msg; errEl.hidden = !msg; }
    const row = input && input.closest('.ll-pom-row');
    if (row) row.classList.toggle('excluded', !pomModel.elements[i].include);
  });

  const clsInput = document.getElementById('pomClassName');
  const clsErr = pomClassNameError(pomModel.className);
  const clsErrEl = document.getElementById('pomClassError');
  if (clsErrEl) { clsErrEl.textContent = clsErr; clsErrEl.hidden = !clsErr; }
  if (clsInput) clsInput.setAttribute('aria-invalid', clsErr ? 'true' : 'false');

  const bad = errors.filter(Boolean).length;
  const included = pomModel.elements.filter(e => e.include).length;
  let problem = '';
  if (!hasPageObjectCodegen()) problem = "This build can't generate Page Objects (codegen is out of date).";
  else if (!included) problem = 'Include at least one element.';
  else if (bad) problem = `Fix ${bad} name${bad === 1 ? '' : 's'} before exporting.`;
  else if (clsErr) problem = 'Fix the class name before exporting.';

  const v = document.getElementById('pomValidation');
  if (v) { v.textContent = problem; v.hidden = !problem; }
  ['pomCopyBtn', 'pomDownloadBtn'].forEach((id) => {
    const b = document.getElementById(id);
    if (b) b.disabled = !!problem;
  });
  renderPomPreview(problem);
  return !problem;
}

/** The model handed to LLCodegen.pageObject (included rows, trimmed names). */
function pomExportModel() {
  return {
    className: pomModel.className || undefined,
    pageUrl: pomModel.pageUrl,
    title: pomModel.title,
    elements: pomModel.elements
      .filter(e => e.include)
      .map((e) => {
        const out = Object.assign({}, e, { name: String(e.name).trim() });
        delete out.include;
        return out;
      })
  };
}

/** Generated file text, or '' when it can't be generated. */
function pomCode() {
  if (!pomModel || !hasPageObjectCodegen()) return '';
  try {
    return String(LLCodegen.pageObject(pomExportModel(), outFramework, outLanguage) || '');
  } catch (e) {
    console.warn('[Locatra] pageObject codegen failed:', e);
    return '';
  }
}

/**
 * The class name the generated file actually declares. Codegen normalises what the
 * user typed (e.g. appends "Page"), so this asks codegen — or reads the output —
 * rather than echoing the field, keeping the file name and the class in step.
 */
function pomClassNameFor(code, model) {
  const m = /\bclass\s+([A-Za-z_$][\w$]*)/.exec(code || '');
  if (m) return m[1];
  if (typeof LLCodegen !== 'undefined' && typeof LLCodegen.pageObjectClassName === 'function') {
    try { return String(LLCodegen.pageObjectClassName(model || pomExportModel())); } catch (e) {}
  }
  return (pomModel && pomModel.className) || 'PageObject';
}

function pomFileName(code) {
  const ext = outLanguage === 'python' ? 'py' : (outLanguage === 'typescript' ? 'ts' : 'js');
  return pomClassNameFor(code) + '.' + ext;
}

function renderPomPreview(problem) {
  const pre = document.getElementById('pomPreview');
  if (!pre || !pomModel) return;
  if (problem === undefined) {
    updatePomValidation(); // recomputes the problem, then calls back here
    return;
  }
  if (problem) {
    pre.textContent = '';
    return;
  }
  const code = pomCode();
  if (!code) {
    pre.textContent = '';
    const v = document.getElementById('pomValidation');
    if (v) { v.textContent = "Couldn't generate the Page Object for this framework."; v.hidden = false; }
    ['pomCopyBtn', 'pomDownloadBtn'].forEach((id) => {
      const b = document.getElementById(id);
      if (b) b.disabled = true;
    });
    return;
  }
  safeRender(pre, hl(code));
  const cls = document.getElementById('pomClassName');
  if (cls && !pomModel.className) cls.placeholder = pomClassNameFor(code);
  const out = document.getElementById('pomFileHint');
  if (out) out.textContent = 'Saves as ' + pomFileName(code);
}

function downloadText(text, fileName) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function initPomControls() {
  const pickBtn = document.getElementById('pomPickBtn');
  if (pickBtn) pickBtn.addEventListener('click', () => startPomPick('POM_PICK_START'));
  const scanBtn = document.getElementById('pomScanBtn');
  if (scanBtn) scanBtn.addEventListener('click', () => startPomPick('POM_SCAN'));

  const list = document.getElementById('pomList');
  if (list) {
    list.addEventListener('input', (e) => {
      if (!pomModel || !e.target.classList.contains('ll-pom-name')) return;
      const i = parseInt(e.target.getAttribute('data-index'), 10);
      if (!pomModel.elements[i]) return;
      pomModel.elements[i].name = e.target.value;
      updatePomValidation();
    });
    list.addEventListener('change', (e) => {
      if (!pomModel || !e.target.classList.contains('ll-pom-include')) return;
      const i = parseInt(e.target.getAttribute('data-index'), 10);
      if (!pomModel.elements[i]) return;
      pomModel.elements[i].include = !!e.target.checked;
      updatePomValidation();
    });
  }
  const cls = document.getElementById('pomClassName');
  if (cls) cls.addEventListener('input', () => {
    if (!pomModel) return;
    pomModel.className = cls.value.trim();
    updatePomValidation();
  });

  const copyBtn = document.getElementById('pomCopyBtn');
  if (copyBtn) copyBtn.addEventListener('click', () => {
    if (!updatePomValidation()) return;
    const code = pomCode();
    if (code) copyToClipboard(code, copyBtn);
  });
  const dlBtn = document.getElementById('pomDownloadBtn');
  if (dlBtn) dlBtn.addEventListener('click', () => {
    if (!updatePomValidation()) return;
    const code = pomCode();
    if (code) downloadText(code, pomFileName(code));
  });
  const closeBtn = document.getElementById('pomCloseBtn');
  if (closeBtn) closeBtn.addEventListener('click', () => {
    pomModel = null;
    _pomLastResultJson = '';
    renderPomResult();
    setPomStatus('', '');
    if (pickBtn) pickBtn.focus();
  });
  renderPomResult();
}

// ══ F4: step thumbnails ═══════════════════════════════════════════════════════
// The worker stores a small JPEG per step in IndexedDB (thumbs-store.js) and says
// STEP_THUMBNAIL when one is ready. The panel only ever holds object URLs for the
// steps on screen; llRecorderState never carries image data.
function thumbsApi() {
  const t = typeof globalThis !== 'undefined' ? globalThis.LLThumbs : undefined;
  return t && typeof t.get === 'function' ? t : null;
}

function canMakeObjectUrl() {
  return typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
}

function eventIdsOf(steps) {
  const out = [];
  (steps || []).forEach((a) => {
    if (a && typeof a.eventId === 'string' && a.eventId && out.indexOf(a.eventId) === -1) out.push(a.eventId);
  });
  return out;
}

function stepByEventId(id) {
  return recordedActions.find(a => a && a.eventId === id) || null;
}

function revokeThumb(id) {
  const entry = thumbCache.get(id);
  if (entry && entry.url) {
    try { URL.revokeObjectURL(entry.url); } catch (e) {}
  }
  thumbCache.delete(id);
}

function releaseAllThumbs() {
  closeThumbPreview();
  Array.from(thumbCache.keys()).forEach(revokeThumb);
  _thumbGen.clear();
  _thumbInFlight.clear();
}

/** Steps removed for good: drop their object URLs and their stored screenshots. */
function discardThumbs(steps) {
  const ids = eventIdsOf((steps || []).filter(a => a && !a.suggested));
  if (!ids.length) return;
  ids.forEach((id) => { revokeThumb(id); _thumbGen.delete(id); _thumbInFlight.delete(id); });
  sendToBackground({ type: 'THUMBS_DELETE', eventIds: ids });
}

/** Revoke the URLs of steps no longer in the timeline (undo keeps the stored image). */
function pruneThumbCache() {
  if (!thumbCache.size) return;
  const live = new Set(eventIdsOf(recordedActions));
  Array.from(thumbCache.keys()).forEach((id) => {
    if (!live.has(id)) revokeThumb(id);
  });
}

/** getMany may answer with an array (aligned or keyed by eventId), a Map or an object. */
function normalizeThumbRecords(ids, res) {
  const map = new Map();
  if (!res) return map;
  if (typeof Map !== 'undefined' && res instanceof Map) {
    res.forEach((v, k) => map.set(k, v));
  } else if (Array.isArray(res)) {
    res.forEach((rec, i) => {
      if (!rec) return;
      map.set(typeof rec.eventId === 'string' ? rec.eventId : ids[i], rec);
    });
  } else if (typeof res === 'object') {
    ids.forEach((id) => { if (res[id]) map.set(id, res[id]); });
  }
  return map;
}

function loadThumbs(ids) {
  const api = thumbsApi();
  if (!api || !canMakeObjectUrl() || !ids.length) return;
  const gens = ids.map((id) => {
    const g = (_thumbGen.get(id) || 0) + 1;
    _thumbGen.set(id, g);
    _thumbInFlight.add(id);
    return g;
  });
  let p;
  try {
    p = typeof api.getMany === 'function' ? api.getMany(ids) : Promise.all(ids.map(id => api.get(id)));
  } catch (e) {
    p = Promise.reject(e);
  }
  Promise.resolve(p).then((res) => {
    const recs = normalizeThumbRecords(ids, res);
    ids.forEach((id, i) => {
      if (_thumbGen.get(id) !== gens[i]) return; // superseded by a newer load
      _thumbInFlight.delete(id);
      setThumbFromRecord(id, recs.get(id));
    });
  }, () => {
    ids.forEach((id, i) => {
      if (_thumbGen.get(id) !== gens[i]) return;
      _thumbInFlight.delete(id);
      if (stepByEventId(id)) thumbCache.set(id, null);
    });
  });
}

function setThumbFromRecord(id, rec) {
  if (!stepByEventId(id)) return; // removed while loading
  revokeThumb(id);
  if (!rec || !rec.blob) {
    thumbCache.set(id, null);
    return;
  }
  let url = '';
  try { url = URL.createObjectURL(rec.blob); } catch (e) { url = ''; }
  if (!url) { thumbCache.set(id, null); return; }
  thumbCache.set(id, { url: url, width: Number(rec.width) || 0, height: Number(rec.height) || 0 });
  document.querySelectorAll('#recorderTimeline .ll-thumb-slot').forEach((slot) => {
    if (slot.getAttribute('data-eid') === id) fillThumbSlot(slot, id);
  });
}

/** Fill the rendered slots from the cache; fetch the ones not loaded yet. */
function hydrateThumbs(root) {
  if (!root || !thumbsApi() || !canMakeObjectUrl()) return;
  const missing = [];
  root.querySelectorAll('.ll-thumb-slot').forEach((slot) => {
    const id = slot.getAttribute('data-eid');
    if (!id) return;
    if (thumbCache.has(id)) fillThumbSlot(slot, id);
    else if (!_thumbInFlight.has(id) && missing.indexOf(id) === -1) missing.push(id);
  });
  if (missing.length) loadThumbs(missing);
}

/** The step's rect as percentages of its viewport (clipped), or null. */
function thumbRectPercent(act) {
  const r = act && act.rect;
  const vp = act && act.viewport;
  if (!r || !vp) return null;
  const vw = Number(vp.width), vh = Number(vp.height);
  const x = Number(r.x), y = Number(r.y), w = Number(r.width), h = Number(r.height);
  if (![vw, vh, x, y, w, h].every(Number.isFinite) || vw <= 0 || vh <= 0 || w <= 0 || h <= 0) return null;
  const left = Math.max(0, x), top = Math.max(0, y);
  const right = Math.min(vw, x + w), bottom = Math.min(vh, y + h);
  if (right <= left || bottom <= top) return null; // entirely off-screen
  return {
    left: left / vw * 100, top: top / vh * 100,
    width: (right - left) / vw * 100, height: (bottom - top) / vh * 100
  };
}

function buildThumbFrame(entry, act, large) {
  const frame = document.createElement('div');
  frame.className = 'll-thumb-frame' + (large ? ' ll-thumb-frame-lg' : '');
  const img = document.createElement('img');
  img.src = entry.url;
  img.alt = large ? 'Screenshot taken when this step was recorded' : '';
  if (entry.width && entry.height) {
    img.width = large ? entry.width : 72;
    img.height = large ? entry.height : Math.round(72 * entry.height / entry.width);
  }
  frame.appendChild(img);
  const pct = thumbRectPercent(act);
  if (pct) {
    const box = document.createElement('div');
    box.className = 'll-thumb-rect';
    box.style.left = pct.left.toFixed(2) + '%';
    box.style.top = pct.top.toFixed(2) + '%';
    box.style.width = pct.width.toFixed(2) + '%';
    box.style.height = pct.height.toFixed(2) + '%';
    frame.appendChild(box);
  }
  return frame;
}

function stepCaption(act) {
  const i = recordedActions.indexOf(act);
  const what = act.action === 'assert'
    ? 'assert ' + String(act.assertType || 'toBeVisible')
    : String(act.action || 'step');
  return `Step ${i + 1}: ${what}`;
}

function fillThumbSlot(slot, id) {
  slot.textContent = '';
  const entry = thumbCache.get(id);
  const act = stepByEventId(id);
  if (!entry || !act) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'll-thumb-btn';
  btn.setAttribute('data-eid', id);
  btn.setAttribute('aria-label', 'Preview screenshot — ' + stepCaption(act));
  btn.title = 'Preview screenshot';
  btn.appendChild(buildThumbFrame(entry, act, false));
  slot.appendChild(btn);
}

function onStepThumbnail(eventId) {
  if (typeof eventId !== 'string' || !eventId) return;
  if (!stepByEventId(eventId)) return; // not (or no longer) in this timeline
  revokeThumb(eventId);
  loadThumbs([eventId]);
}

function isThumbModalOpen() {
  const m = document.getElementById('thumbModal');
  return !!m && !m.hidden;
}

function openThumbPreview(id, opener) {
  const entry = thumbCache.get(id);
  const act = stepByEventId(id);
  const modal = document.getElementById('thumbModal');
  const body = document.getElementById('thumbModalBody');
  if (!entry || !act || !modal || !body) return;
  body.textContent = '';
  body.appendChild(buildThumbFrame(entry, act, true));
  const title = document.getElementById('thumbModalTitle');
  if (title) title.textContent = stepCaption(act);
  _thumbModalOpener = { el: opener || document.activeElement, eventId: id };
  modal.hidden = false;
  const close = document.getElementById('thumbModalClose');
  if (close) close.focus();
}

function closeThumbPreview() {
  const modal = document.getElementById('thumbModal');
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  const body = document.getElementById('thumbModalBody');
  if (body) body.textContent = '';
  const back = _thumbModalOpener;
  _thumbModalOpener = null;
  if (!back) return;
  // The opener may have been re-rendered while the preview was open.
  let target = back.el && back.el.isConnected ? back.el : null;
  if (!target) {
    target = Array.prototype.find.call(
      document.querySelectorAll('#recorderTimeline .ll-thumb-btn'),
      b => b.getAttribute('data-eid') === back.eventId
    ) || document.getElementById('recorderTimeline');
  }
  if (target && typeof target.focus === 'function') target.focus();
}

function initThumbModal() {
  const modal = document.getElementById('thumbModal');
  if (!modal) return;
  const close = document.getElementById('thumbModalClose');
  if (close) close.addEventListener('click', closeThumbPreview);
  const backdrop = document.getElementById('thumbModalBackdrop');
  if (backdrop) backdrop.addEventListener('click', closeThumbPreview);
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeThumbPreview();
      return;
    }
    if (e.key === 'Tab') {
      // Keep focus inside the dialog.
      const focusables = Array.prototype.filter.call(
        modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
        el => !el.disabled
      );
      if (!focusables.length) { e.preventDefault(); return; }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!modal.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    }
  });
  modal.hidden = true;
}
