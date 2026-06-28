let isInspecting = false;
let isRecording = false;
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



// ── Safe DOM renderer (avoids innerHTML for AMO compliance) ───────────────────
function safeRender(el, html) {
  el.textContent = '';
  var doc = new DOMParser().parseFromString(html, 'text/html');
  while (doc.body.firstChild) el.appendChild(doc.body.firstChild);
}
let lastResultData = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Syntax highlighter shared by the locator cards and the Generated Test Script.
// String literals are protected first (via a  sentinel) so keyword/number rules
// never recolor text inside them; escaped quotes (e.g. Selenium's "[id=\"x\"]") are
// kept intact. Covers Playwright / Selenium / Cypress across JS / TS / Python.
function hl(code) {
  const SENT = String.fromCharCode(0); // sentinel — never appears in code
  let s = esc(code); // escapes & < > "  (single quotes stay literal)
  const STR_RE = /'(?:\\.|[^'\n])*'|&quot;(?:\\&quot;|(?!&quot;)[^\n])*&quot;/g;
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
  const originalLabel = btn.textContent;
  const onSuccess = () => {
    btn.textContent = '✓ Copied';
    btn.classList.add('done');
    setTimeout(() => { btn.textContent = originalLabel; btn.classList.remove('done'); }, 2000);
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
      setTimeout(() => { btn.textContent = originalLabel; }, 2000);
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
  chrome.runtime.sendMessage({ type: isInspecting ? 'START_INSPECT' : 'STOP_INSPECT' });
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
    id: 'ID', name: 'Name', css: 'CSS selector'
  };
  return map[t.kind] || loc.method;
}

// ── Output target (framework + language) wiring ──────────────────────────────
function recorderFileName() {
  if (outLanguage === 'python') return 'test_recorded.py';
  const ext = outLanguage === 'typescript' ? 'ts' : 'js';
  if (outFramework === 'cypress') return `recorded.cy.${ext}`;
  if (outFramework === 'playwright') return `locatorlens-recorded.spec.${ext}`;
  return `locatorlens-recorded.${ext}`;
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
}

function initOutputSelectors() {
  const fwSel = document.getElementById('fwSelect');
  const langSel = document.getElementById('langSelect');
  if (!fwSel || !langSel || typeof LLCodegen === 'undefined') return;

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
    fwSel.value = outFramework;
    populateLangOptions();
    langSel.value = outLanguage;
  };

  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get([LL_FW_KEY, LL_LANG_KEY], (res) => {
      if (res && res[LL_FW_KEY]) outFramework = res[LL_FW_KEY];
      if (res && res[LL_LANG_KEY]) outLanguage = res[LL_LANG_KEY];
      finalize();
      if (lastResultData) renderResults(lastResultData);
      renderTimeline();
      updateCodePreview();
    });
  } else {
    finalize();
  }

  fwSel.addEventListener('change', () => {
    outFramework = fwSel.value;
    populateLangOptions();
    langSel.value = outLanguage;
    applyOutputChange();
  });
  langSel.addEventListener('change', () => {
    outLanguage = langSel.value;
    applyOutputChange();
  });
}

// ── Recorder controls (pause / assert / undo-redo / filter / collapse) ───────
function sendAssertMode() {
  const toggle = document.getElementById('assertModeToggle');
  const typeSel = document.getElementById('assertTypeSelect');
  const on = !!(toggle && toggle.checked);
  const assertType = (typeSel && typeSel.value) || 'toBeVisible';
  chrome.runtime.sendMessage({ type: 'SET_ASSERT_MODE', on: on, assertType: assertType });
}

function initRecorderControls() {
  const pauseBtn = document.getElementById('pauseRecordingBtn');
  const resumeBtn = document.getElementById('resumeRecordingBtn');
  if (pauseBtn) pauseBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'PAUSE_RECORDING' });
    pauseBtn.style.display = 'none';
    if (resumeBtn) resumeBtn.style.display = '';
  });
  if (resumeBtn) resumeBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'RESUME_RECORDING' });
    resumeBtn.style.display = 'none';
    if (pauseBtn) pauseBtn.style.display = '';
  });

  const assertToggle = document.getElementById('assertModeToggle');
  const assertType = document.getElementById('assertTypeSelect');
  if (assertToggle) assertToggle.addEventListener('change', () => {
    if (assertType) assertType.style.display = assertToggle.checked ? '' : 'none';
    sendAssertMode();
  });
  if (assertType) assertType.addEventListener('change', sendAssertMode);

  const undoBtn = document.getElementById('undoActionBtn');
  const redoBtn = document.getElementById('redoActionBtn');
  if (undoBtn) undoBtn.addEventListener('click', () => {
    if (recordedActions.length === 0) return;
    const act = recordedActions.pop();
    if (act) { seenActionKeys.delete(dedupeKeyForAction(act)); recRedoStack.push(act); }
    renderTimeline();
    updateCodePreview();
    scheduleRecorderPersist();
  });
  if (redoBtn) redoBtn.addEventListener('click', () => {
    if (recRedoStack.length === 0) return;
    const act = recRedoStack.pop();
    if (act) { recordedActions.push(act); seenActionKeys.add(dedupeKeyForAction(act)); }
    renderTimeline();
    updateCodePreview();
    scheduleRecorderPersist();
  });

  const filterInput = document.getElementById('recFilterInput');
  const filterClear = document.getElementById('recFilterClear');
  if (filterInput) filterInput.addEventListener('input', () => {
    if (_recFilterTimer) clearTimeout(_recFilterTimer);
    _recFilterTimer = setTimeout(() => {
      recFilter = filterInput.value.trim();
      if (filterClear) filterClear.style.display = recFilter ? '' : 'none';
      renderTimeline();
    }, 200);
  });
  if (filterClear) filterClear.addEventListener('click', () => {
    if (filterInput) filterInput.value = '';
    recFilter = '';
    filterClear.style.display = 'none';
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
  const { elementData: el, locators, avoidList, proTip, a11y } = data;

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
        <span class="a11y-severity ${issue.severity === 'high' ? 'high' : 'low'}">${issue.severity}</span>
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
  
  if (el.isInShadow) {
    chips.push(`<span class="el-chip shadow">🧬 SHADOW</span>`);
    if (el.shadowHost) chips.push(`<span class="el-chip shadow"><span class="k">host: </span>${esc(el.shadowHost)}</span>`);
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
            <button class="copy-btn" data-code="${esc(fullCode)}">Copy</button>
          </div>
        </div>
        <div class="why-row">
          <button class="toggle-explain">▶ Why?</button>
        </div>
        <div class="card-explain">${esc(loc.explanation || '')}</div>
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
  const code = btn.getAttribute('data-code')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  copyToClipboard(code, btn);
}

function toggleExplain(btn) {
  const card = btn.closest('.card');
  const exp = card.querySelector('.card-explain');
  const open = exp.classList.toggle('open');
  btn.textContent = open ? '▼ Why?' : '▶ Why?';
}

// ── Message listener (also used by port bridge from background) ─────────────
function handleRuntimeMessage(msg) {
  if (msg.type === 'ELEMENT_PICKED' && msg.data) {
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
    const btn = document.getElementById('stressTestBtn');
    btn.textContent = '💥 Stress Test';
    if (window._llStressTimer) { clearTimeout(window._llStressTimer); window._llStressTimer = null; }
    const d = msg.data || {};
    if (d.unavailable) {
      alert("Stress Test: couldn't reach this page. It may be a restricted page (chrome://, the Web Store, a PDF) or not fully loaded — try a normal http(s) page and reload.");
      return;
    }
    if (d.noTarget) {
      alert('Stress Test: no element selected. Turn on Inspect and click an element first, then run the Stress Test.');
      return;
    }
    const what = d.role ? `\nTarget: <${d.tag || '?'}> · role="${d.role}"${d.name ? ` · name="${d.name}"` : ''}` : '';
    alert(`Stress Test Complete!${what}\nElement locatable without classes/id? ${d.survived ? 'Yes ✅' : 'No ❌'}`);
  }
  if (msg.type === 'RECORDED_ACTION' && msg.data) {
    appendToRecorder(msg.data);
  }
}

chrome.runtime.onMessage.addListener(handleRuntimeMessage);

(function connectSidePanelBridge() {
  try {
    const port = chrome.runtime.connect({ name: 'll-sidepanel' });
    port.onMessage.addListener(handleRuntimeMessage);
    port.onDisconnect.addListener(() => setTimeout(connectSidePanelBridge, 400));
  } catch (e) {
    setTimeout(connectSidePanelBridge, 800);
  }
})();

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


  document.getElementById('stressTestBtn').addEventListener('click', () => {
    const btn = document.getElementById('stressTestBtn');
    btn.textContent = 'Testing...';
    // Safety net: reset the button even if no result ever comes back (e.g. tab closed mid-run).
    if (window._llStressTimer) clearTimeout(window._llStressTimer);
    window._llStressTimer = setTimeout(() => {
      btn.textContent = '💥 Stress Test';
      window._llStressTimer = null;
      alert('Stress Test timed out — no response from the page. Reload the page and try again.');
    }, 5000);
    chrome.runtime.sendMessage({ type: 'RUN_STRESS_TEST' });
  });

  // Clear button
  document.getElementById('clearBtn').addEventListener('click', () => {
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.remove('lastElement');
    }
    document.getElementById('resultsState').style.display = 'none';
    document.getElementById('idleState').style.display = '';
  });

  // ── STARTUP: Force Absolute Reset ──
  chrome.runtime.sendMessage({ type: 'STOP_INSPECT' });
  isInspecting = false;
  updateInspectUI();

  chrome.runtime.sendMessage({ type: 'GET_INSPECT_STATE' }, (res) => {
    if (res && res.active) {
      isInspecting = true;
      updateInspectUI();
    }
  });

  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get('lastElement', (result) => {
      if (result && result.lastElement) {
        renderResults(result.lastElement);
      }
    });
  }

  // ── Selector Lab Events ──
  const labInput = document.getElementById('lab-input');
  const labValidateBtn = document.getElementById('lab-validate-btn');
  const labClearBtn = document.getElementById('lab-clear-btn');

  const runValidation = () => {
    const selector = labInput.value.trim();
    if (!selector) return;
    chrome.runtime.sendMessage({ type: 'LAB_VALIDATE', selector });
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
    chrome.runtime.sendMessage({ type: 'LAB_CLEAR' });
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

  // Keep background aware the panel is open (single ping expires after ~12s).
  const sendPanelHeartbeat = () => chrome.runtime.sendMessage({ type: 'PANEL_HEARTBEAT' });
  sendPanelHeartbeat();
  const panelHeartbeatId = setInterval(sendPanelHeartbeat, 4000);
  window.addEventListener('beforeunload', () => clearInterval(panelHeartbeatId));

  // ── Recorder Controls ──
  document.getElementById('recordBtn').addEventListener('click', toggleRecording);

  document.getElementById('clearTimelineBtn').addEventListener('click', () => {
    recordedActions = [];
    recRedoStack = [];
    seenActionKeys.clear();
    lastSyncedPreviewScript = '';
    recLastPageUrl = '';
    updateRecPageUrlUI();
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.remove(LL_RECORDER_STATE_KEY);
    }
    renderTimeline();
    updateCodePreview();
  });

  document.getElementById('exportTestBtn').addEventListener('click', (e) => {
    const script = getExportedTestScript();
    if (!script) return alert('Record some actions first, or paste a script into the editor.');
    copyToClipboard(script, e.target);
  });

  document.getElementById('regenerateScriptBtn').addEventListener('click', () => {
    if (recordedActions.length === 0) return;
    const ta = document.getElementById('codePreview');
    if (!ta) return;
    const next = generateTestScript();
    setPreviewCode(ta, next);
    lastSyncedPreviewScript = next;
    ta.focus();
    scheduleRecorderPersist();
  });

  const codePreviewEl = document.getElementById('codePreview');
  if (codePreviewEl) {
    codePreviewEl.addEventListener('input', () => scheduleRecorderPersist());
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
        alert('Record some actions first, or paste a script into the editor.');
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
      const idx = parseInt(e.target.getAttribute('data-index'));
      const removed = recordedActions.splice(idx, 1)[0];
      
      // Also remove from seenActionKeys to allow re-recording if it was the same interaction
      if (removed) {
        seenActionKeys.delete(dedupeKeyForAction(removed));
      }

      renderTimeline();
      updateCodePreview();
      scheduleRecorderPersist();
    }
    // 2. Handle individual step copy
    if (e.target.classList.contains('copy-btn') && e.target.closest('#recorderTimeline')) {
        handleCopy(e.target);
    }
  });

  loadRecorderState();
});

// ── Recording Toggle (hoisted) ──
function toggleRecording() {
  isRecording = !isRecording;
  updateRecordUI();
  chrome.runtime.sendMessage({ type: isRecording ? 'START_RECORDING' : 'STOP_RECORDING' });
}

function updateRecordUI() {
  const btn = document.getElementById('recordBtn');
  const icon = document.getElementById('recBtnIcon');
  const txt = document.getElementById('recBtnText');
  const hint = document.getElementById('recHint');
  const ctrls = document.getElementById('recControls');
  const pauseBtn = document.getElementById('pauseRecordingBtn');
  const resumeBtn = document.getElementById('resumeRecordingBtn');

  if (isRecording) {
    btn.style.background = 'var(--surf2)';
    btn.style.color = 'var(--error)';
    btn.style.border = '1px solid var(--error)';
    btn.style.boxShadow = '0 0 15px rgba(255, 113, 108, 0.3)';
    icon.textContent = '⏹';
    txt.textContent = 'Stop Recording';
    hint.style.display = 'block';
    if (ctrls) ctrls.style.display = 'flex';
    if (pauseBtn) pauseBtn.style.display = '';
    if (resumeBtn) resumeBtn.style.display = 'none';
  } else {
    btn.style.background = 'var(--error)';
    btn.style.color = 'var(--bg)';
    btn.style.border = 'none';
    btn.style.boxShadow = '0 0 15px rgba(255, 113, 108, 0.2)';
    icon.textContent = '⏺';
    txt.textContent = 'Start Recording';
    hint.style.display = 'none';
    if (ctrls) ctrls.style.display = 'none';
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
    'uncheck': '⬜', 'selectOption': '📃', 'press': '⌨️', 'hover': '🖱️', 'assert': '✔️'
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
      if (filter) {
        const hay = (String(act.action || '') + ' ' + String(act.assertType || '') + ' ' + codeStr + ' ' + String(act.value || '')).toLowerCase();
        if (hay.indexOf(filter) === -1) return '';
      }
      rendered++;
      const icon = actionIcons[act.action] || '🔵';
      const label = isAssert
        ? `ASSERT · ${esc(String(act.assertType || 'toBeVisible'))}`
        : esc(String(act.action || 'step').toUpperCase());
      const valueStr = String(act.value != null ? act.value : '');
      const valuePreview = valueStr.slice(0, 80);

      return `
      <div class="ll-rec-step${isAssert ? ' is-assert' : ''}">
        <div class="ll-rec-step-head">
           <span class="ll-rec-step-label">${icon} #${i + 1} ${label}</span>
           <div class="ll-rec-step-actions">
             <button type="button" class="clear-btn copy-btn" data-code="${esc(codeStr)}">Copy</button>
             <button type="button" class="clear-btn remove-step-btn" data-index="${i}">✕</button>
           </div>
        </div>
        ${valueStr ? `<div class="ll-rec-step-value">value: "${esc(valuePreview)}"</div>` : ''}
        <div class="ll-rec-step-code">${hl(codeStr)}</div>
      </div>
    `;
    }).join('');
  } catch (err) {
    console.warn('[LocatorLens] renderTimeline failed:', err);
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

function buildActionCode(act) {
  // Route through codegen for every framework/language. We deliberately do NOT reuse
  // act.fullCode for Playwright here: the recorder's fullCode carries the engine's
  // suggestAction placeholder for selectOption ('option text') and says .check() even
  // for uncheck events — codegen rebuilds from the action + actual value + target,
  // which is correct for all cases. (locators[0] is always a top semantic locator,
  // so codegen reproduces the Playwright line identically.)
  if (typeof LLCodegen !== 'undefined') {
    const needsLoc = ['click', 'dblclick', 'check', 'uncheck', 'fill', 'selectOption', 'hover', 'assert'].indexOf(act.action) !== -1;
    if (needsLoc && !act.target) {
      // Older recording captured before structured targets existed — fall back.
      return act.fullCode || '';
    }
    const line = LLCodegen.actionStatement(act, outFramework, outLanguage);
    if (line) return line;
  }
  // Legacy Playwright fallback (LLCodegen unavailable).
  const locator = act.code || '';
  const valStr = String(act.value != null ? act.value : '');
  switch (act.action) {
    case 'goto': return `await page.goto(${JSON.stringify(valStr)});`;
    case 'fill': return `await ${locator}.fill('${valStr.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');`;
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
    return LLCodegen.wrapScript(recordedActions.map(buildActionCode), outFramework, outLanguage);
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

/** Last script we pushed into the editor (so we can refresh while focused if unchanged). */
let lastSyncedPreviewScript = '';

function updateCodePreview() {
  const previewEl = document.getElementById('codePreview');
  const labelEl = document.getElementById('codePreviewLabel');
  if (!previewEl || !labelEl) return;

  if (recordedActions.length === 0) {
    previewEl.style.display = 'none';
    labelEl.style.display = 'none';
    previewEl.textContent = '';
    lastSyncedPreviewScript = '';
    return;
  }

  labelEl.style.display = '';
  previewEl.style.display = '';

  const next = generateTestScript();
  if (document.activeElement === previewEl) {
    // user is editing — only re-highlight if they haven't changed our last output
    if (getPreviewText(previewEl) === lastSyncedPreviewScript) {
      setPreviewCode(previewEl, next);
      lastSyncedPreviewScript = next;
    }
    return;
  }

  setPreviewCode(previewEl, next);
  lastSyncedPreviewScript = next;
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

function scheduleRecorderPersist() {
  if (!chrome.storage || !chrome.storage.local) return;
  clearTimeout(_recorderSaveTimer);
  _recorderSaveTimer = setTimeout(persistRecorderState, 200);
}

function persistRecorderState() {
  if (!chrome.storage || !chrome.storage.local) return;
  const ta = document.getElementById('codePreview');
  const codePreview = ta && ta.style.display !== 'none' ? getPreviewText(ta) : '';
  chrome.storage.local.set({
    [LL_RECORDER_STATE_KEY]: {
      actions: recordedActions,
      seenKeys: Array.from(seenActionKeys),
      codePreview: codePreview,
      lastPageUrl: recLastPageUrl
    }
  });
}

function loadRecorderState(callback) {
  if (!chrome.storage || !chrome.storage.local) {
    if (typeof callback === 'function') callback();
    return;
  }
  chrome.storage.local.get(LL_RECORDER_STATE_KEY, (r) => {
    const s = r && r[LL_RECORDER_STATE_KEY];
    if (s && Array.isArray(s.actions) && s.actions.length > 0) {
      recordedActions = s.actions;
      seenActionKeys = new Set(Array.isArray(s.seenKeys) ? s.seenKeys : []);
      recLastPageUrl = typeof s.lastPageUrl === 'string' ? s.lastPageUrl : '';
      const ta = document.getElementById('codePreview');
      const label = document.getElementById('codePreviewLabel');
      const savedEdits = s.codePreview != null && String(s.codePreview).trim() !== '';
      if (ta && savedEdits) {
        setPreviewCode(ta, s.codePreview);
        lastSyncedPreviewScript = s.codePreview;
        ta.style.display = '';
        if (label) label.style.display = '';
      }
      updateRecPageUrlUI();
      renderTimeline();
      if (!savedEdits) {
        updateCodePreview();
      }
    } else if (s && typeof s.lastPageUrl === 'string' && s.lastPageUrl) {
      recLastPageUrl = s.lastPageUrl;
      updateRecPageUrlUI();
    }
    if (typeof callback === 'function') callback();
  });
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
  const val = actionData.value != null ? String(actionData.value) : '';
  return `${tabId}_${actionData.timestamp}_${actionData.action}_${val}_${code}`;
}

function appendToRecorder(actionData) {
  if (!actionData) return;

  const key = dedupeKeyForAction(actionData);
  if (seenActionKeys.has(key)) return;
  seenActionKeys.add(key);

  recRedoStack = []; // a newly captured action invalidates the redo history
  recordedActions.push(Object.assign({}, actionData));
  if (actionData.url && typeof actionData.url === 'string') {
    recLastPageUrl = actionData.url;
    updateRecPageUrlUI();
  }
  renderTimeline();
  updateCodePreview();
  scheduleRecorderPersist();

  // Auto-scroll timeline to bottom
  const timelineList = document.getElementById('recorderTimeline');
  if (timelineList) timelineList.scrollTop = timelineList.scrollHeight;
}
