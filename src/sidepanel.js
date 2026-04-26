let isInspecting = false;
let isRecording = false;
let currentFramework = 'playwright';
let savedPOMElements = [];
let recordedActions = [];
let recLastPageUrl = '';
let _recorderSaveTimer = null;
const LL_RECORDER_STATE_KEY = 'llRecorderState';

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

function hl(code) {
  return esc(code)
    .replace(/\b(await|const|let|var|function|return|if|else|for|while|try|catch|By|driver|cy|By\.CSS_SELECTOR|By\.ID|By\.NAME|By\.XPATH)\b/g, '<span class="kw">$1</span>')
    .replace(/\b(page|browser|context|expect|test|find_element|get|contains|find_elements|shadow|shadowRoot)\b/g, '<span class="kw">$1</span>')
    .replace(/\b(getByRole|getByLabel|getByPlaceholder|getByText|getByAltText|getByTitle|getByTestId|locator|click|dblclick|fill|check|selectOption|press|type|hover|focus|blur|waitFor|toBeVisible|toHaveText|toBeChecked)\b/g, '<span class="fn">$1</span>')
    .replace(/(&#39;[^<]*?&#39;|&quot;[^<]*?&quot;)/g, '<span class="str">$1</span>')
    .replace(/([0-9]+)/g, '<span class="num">$1</span>');
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
  const onSuccess = () => {
    btn.textContent = '✓ Copied';
    btn.classList.add('done');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 2000);
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
      setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
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

// ── Format Translator ──────────────────────────────────────────────────────────
function formatForFramework(loc, framework) {
  const method = loc.method || '';
  const code = loc.code || '';
  const attr = loc.matchedAttr || '';
  const action = loc.fullCode ? loc.fullCode.split('.').pop() : 'click()';

  if (framework === 'playwright') return { code, fullCode: loc.fullCode };

  // 🧪 Selenium Translator (Universal Style)
  if (framework === 'selenium') {
    let selCode = '';
    if (method.includes('TestId')) {
      const id = attr.split('"')[1] || '';
      selCode = `driver.find_element(By.CSS_SELECTOR, "[data-testid='${id}']")`;
    } else if (method.includes('getByRole')) {
      const match = code.match(/getByRole\('([^']+)'(?:, \{ name: '([^']+)' \})?\)/);
      if (match) {
        const role = match[1];
        const name = match[2];
        selCode = name 
          ? `driver.find_element(By.CSS_SELECTOR, "${role}[aria-label='${name}'], ${role}[name='${name}']")`
          : `driver.find_element(By.CSS_SELECTOR, "${role}")`;
      }
    } else if (method.includes('id')) {
      const id = attr.split('"')[1] || '';
      selCode = `driver.find_element(By.ID, "${id}")`;
    } else if (method.includes('name')) {
      const name = attr.split('"')[1] || '';
      selCode = `driver.find_element(By.NAME, "${name}")`;
    } else if (method.includes('Text')) {
      const txt = attr.split('"')[1] || '';
      selCode = `driver.find_element(By.XPATH, "//*[contains(text(), '${txt}')]")`;
    } else {
      selCode = `driver.find_element(By.CSS_SELECTOR, "${attr.replace(/'/g, "\\'")}")`;
    }
    return { code: selCode, fullCode: `${selCode}.${action.replace('click()', 'click')}` };
  }

  // 🌲 Cypress Translator
  if (framework === 'cypress') {
    let cyCode = '';
    if (method.includes('TestId')) {
      const id = attr.split('"')[1] || '';
      cyCode = `cy.get('[data-testid="${id}"]')`;
    } else if (method.includes('getByRole')) {
      const match = code.match(/getByRole\('([^']+)'(?:, \{ name: '([^']+)' \})?\)/);
      if (match) {
        const role = match[1];
        const name = match[2];
        cyCode = name ? `cy.get('${role}').contains('${name}')` : `cy.get('${role}')`;
      }
    } else if (method.includes('id')) {
      cyCode = `cy.get('#${attr.split('"')[1]}')`;
    } else if (method.includes('Text')) {
      cyCode = `cy.contains('${attr.split('"')[1]}')`;
    } else {
      cyCode = `cy.get('${attr.replace(/'/g, "\\'")}')`;
    }
    return { code: cyCode, fullCode: `${cyCode}.${action.replace('click()', 'click()')}` };
  }

  return { code, fullCode: loc.fullCode };
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
    
    // Translate based on chosen framework
    const { code, fullCode } = formatForFramework(loc, currentFramework);
    
    return `
      <div class="card ${rc}" style="${delayStyle}">
        <div class="card-head">
          <div class="card-left">
            <div class="rank-num">${loc.rank}</div>
            <div>
              <div class="method-name">${esc(loc.method)}</div>
              <div class="match-attr" title="${esc(loc.matchedAttr)}">${esc(loc.matchedAttr)}</div>
            </div>
          </div>
          <span class="pill ${pillClass(loc.stability)}">${pillLabel(loc.stability)}</span>
        </div>
        <div class="card-code">
          <div class="code-txt">${hl(code)}</div>
          <div style="display:flex; flex-direction:column; gap:4px;">
            <button class="copy-btn" data-code="${esc(fullCode)}">Copy</button>
            <button class="copy-btn add-pom-btn" data-code="${esc(code.replace('page.', ''))}" style="background:var(--primary-dim); color:var(--text);">+ POM</button>
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
      statusEl.textContent = `Identification successful. Found ${msg.count} match(es).`;
      statusEl.className = 'lab-status success';
      countEl.textContent = `(${msg.count})`;
      countEl.style.display = 'inline';
    } else {
      statusEl.textContent = 'No matches found in the current DOM.';
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
    alert(`Stress Test Complete!\nElement locatable without classes/id? ${msg.data.survived ? 'Yes ✅' : 'No ❌'}`);
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
    if (e.target.classList.contains('copy-btn') && !e.target.classList.contains('add-pom-btn')) {
      handleCopy(e.target);
    } else if (e.target.classList.contains('toggle-explain')) {
      toggleExplain(e.target);
    } else if (e.target.classList.contains('add-pom-btn')) {
      const code = e.target.getAttribute('data-code').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      const name = prompt("Name this element (e.g. loginButton):", "element" + (savedPOMElements.length + 1));
      if (name) {
        savedPOMElements.push({ name, code });
        chrome.storage.local.set({ savedPOMElements });
        renderPOMList();
        e.target.textContent = '✓ Added';
        setTimeout(() => { e.target.textContent = '+ POM'; }, 2000);
      }
    }
  });

  document.getElementById('stressTestBtn').addEventListener('click', () => {
    const btn = document.getElementById('stressTestBtn');
    btn.textContent = 'Testing...';
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
  // This ensures that if the extension reloaded, any old listeners on the page are killed.
  chrome.runtime.sendMessage({ type: 'STOP_INSPECT' });
  isInspecting = false;
  updateInspectUI();

  // Check inspect state (verify if we should actually be active)
  chrome.runtime.sendMessage({ type: 'GET_INSPECT_STATE' }, (res) => {
    if (res && res.active) {
      isInspecting = true;
      updateInspectUI();
    }
  });

  // Restore last element picked (local storage for cross-browser compatibility)
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get('lastElement', (result) => {
      if (result && result.lastElement) {
        renderResults(result.lastElement);
      }
    });
  }

  // Framework selection
  const fwSelect = document.getElementById('framework-select');
  fwSelect.addEventListener('change', (e) => {
    currentFramework = e.target.value;
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ framework: currentFramework });
    }
    // Hot-swap re-render
    if (lastResultData) renderResults(lastResultData);
  });

  // Restore framework preference
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get('framework', (r) => {
      if (r && r.framework) {
        currentFramework = r.framework;
        fwSelect.value = currentFramework;
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
      // Remove active from all tabs and contents
      tabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      // Add active to clicked tab
      tab.classList.add('active');
      const targetId = tab.getAttribute('data-target');
      document.getElementById(targetId).classList.add('active');
    });
  });

  // ── POM Builder ──
  function renderPOMList() {
    const pomList = document.getElementById('pomList');
    const emptyState = document.getElementById('pomEmptyState');
    if (!emptyState) return; // Not initialized yet

    if (savedPOMElements.length === 0) {
      pomList.innerHTML = '';
      pomList.appendChild(emptyState);
      emptyState.style.display = 'block';
      return;
    }

    pomList.innerHTML = savedPOMElements.map((el, i) => `
      <div class="card" style="padding: 10px; display: flex; justify-content: space-between; align-items: center;">
        <div style="flex: 1;">
          <div style="font-weight: bold; color: var(--primary);">${esc(el.name)}</div>
          <div style="font-family: monospace; font-size: 10px; color: var(--muted); margin-top: 4px;">${hl(el.code)}</div>
        </div>
        <button class="clear-btn remove-pom-btn" data-index="${i}" style="width: 30px; border-color: var(--error); color: var(--error);">✕</button>
      </div>
    `).join('');
  }

  document.getElementById('pomList').addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-pom-btn')) {
      const idx = e.target.getAttribute('data-index');
      savedPOMElements.splice(idx, 1);
      chrome.storage.local.set({ savedPOMElements });
      renderPOMList();
    }
  });

  document.getElementById('clearPOMBtn').addEventListener('click', () => {
    const emptyState = document.getElementById('pomEmptyState');
    savedPOMElements = [];
    chrome.storage.local.set({ savedPOMElements });
    document.getElementById('pomList').innerHTML = '';
    document.getElementById('pomList').appendChild(emptyState);
    emptyState.style.display = 'block';
  });

  document.getElementById('exportPOMBtn').addEventListener('click', (e) => {
    if (savedPOMElements.length === 0) return alert("Add locators first!");
    
    let code = '';
    if (currentFramework === 'playwright') {
        const lines = savedPOMElements.map(el => `    this.${el.name} = page.${el.code};`).join('\n');
        code = `
import { Page, Locator } from '@playwright/test';

export class PageObject {
  readonly page: Page;
${savedPOMElements.map(el => `  readonly ${el.name}: Locator;`).join('\n')}

  constructor(page: Page) {
    this.page = page;
${lines}
  }
}
`.trim();
    } else {
        code = "// Custom POM export format for " + currentFramework + " coming soon!\n" + 
               savedPOMElements.map(el => `const ${el.name} = driver.${el.code};`).join('\n');
    }

    copyToClipboard(code, e.target);
  });

  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get('savedPOMElements', (res) => {
      if (res && res.savedPOMElements) {
        savedPOMElements = res.savedPOMElements;
        renderPOMList();
      }
    });
  }

  // Keep background aware the panel is open (single ping expires after ~12s).
  const sendPanelHeartbeat = () => chrome.runtime.sendMessage({ type: 'PANEL_HEARTBEAT' });
  sendPanelHeartbeat();
  const panelHeartbeatId = setInterval(sendPanelHeartbeat, 4000);
  window.addEventListener('beforeunload', () => clearInterval(panelHeartbeatId));

  // ── Recorder Controls ──
  document.getElementById('recordBtn').addEventListener('click', toggleRecording);

  document.getElementById('clearTimelineBtn').addEventListener('click', () => {
    recordedActions = [];
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
    ta.value = next;
    lastSyncedPreviewScript = next;
    ta.focus();
    scheduleRecorderPersist();
  });

  const codePreviewEl = document.getElementById('codePreview');
  if (codePreviewEl) {
    codePreviewEl.addEventListener('input', () => scheduleRecorderPersist());
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
      a.download = 'locatorlens-recorded-test.spec.ts';
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

  // ── Settings (Custom Attributes) ──
  const customAttrsInput = document.getElementById('custom-attrs-input');
  const saveSettingsBtn = document.getElementById('save-settings-btn');
  const settingsStatus = document.getElementById('settings-status');

  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get('customAttributes', (res) => {
      if (res && res.customAttributes) {
        customAttrsInput.value = res.customAttributes.join(', ');
      }
    });
  }

  saveSettingsBtn.addEventListener('click', () => {
    const rawArgs = customAttrsInput.value.split(',').map(s => s.trim()).filter(s => s);
    chrome.storage.local.set({ customAttributes: rawArgs }, () => {
      settingsStatus.textContent = "Saved! Reload page to apply.";
      settingsStatus.className = 'lab-status success';
      setTimeout(() => {
        settingsStatus.textContent = "";
        settingsStatus.className = 'lab-status';
      }, 3000);
    });
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

  if (isRecording) {
    btn.style.background = 'var(--surf2)';
    btn.style.color = 'var(--error)';
    btn.style.border = '1px solid var(--error)';
    btn.style.boxShadow = '0 0 15px rgba(255, 113, 108, 0.3)';
    icon.textContent = '⏹';
    txt.textContent = 'Stop Recording';
    hint.style.display = 'block';
  } else {
    btn.style.background = 'var(--error)';
    btn.style.color = 'var(--bg)';
    btn.style.border = 'none';
    btn.style.boxShadow = '0 0 15px rgba(255, 113, 108, 0.2)';
    icon.textContent = '⏺';
    txt.textContent = 'Start Recording';
    hint.style.display = 'none';
    if (recordedActions.length > 0) updateCodePreview();
  }
}

// ── Recorder Timeline (hoisted so message listener can call them) ──
function renderTimeline() {
  const timelineList = document.getElementById('recorderTimeline');
  if (!timelineList) return;

  const countEl = document.getElementById('recCount');

  if (recordedActions.length === 0) {
    timelineList.innerHTML = `<div class="ll-rec-empty">🎬 Hit <strong style="color: var(--primary);">Start Recording</strong> then use the page. Clicks, double-clicks, typing, and Enter/Tab/Escape are captured.</div>`;
    if (countEl) { countEl.style.display = 'none'; }
    return;
  }

  if (countEl) {
    countEl.textContent = `(${recordedActions.length})`;
    countEl.style.display = 'inline';
  }

  const actionIcons = {
    'goto': '🌐', 'viewport': '🖥️', 'click': '👆', 'dblclick': '👆👆', 'fill': '⌨️', 'check': '☑️',
    'uncheck': '⬜', 'selectOption': '📃', 'press': '⌨️'
  };

  let html = '';
  try {
    html = recordedActions.map((act, i) => {
      const icon = actionIcons[act.action] || '🔵';
      const label = String(act.action || 'step').toUpperCase();
      let codeStr = '';
      try {
        codeStr = buildActionCode(act);
      } catch (err) {
        codeStr = String(act.fullCode || '// (unavailable)').slice(0, 500);
      }
      const valueStr = String(act.value != null ? act.value : '');
      const valuePreview = valueStr.slice(0, 80);

      return `
      <div class="ll-rec-step">
        <div class="ll-rec-step-head">
           <span class="ll-rec-step-label">${icon} #${i + 1} ${esc(label)}</span>
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
  }

  timelineList.innerHTML = html;
}

function buildActionCode(act) {
  const locator = act.code || '';
  const valStr = String(act.value != null ? act.value : '');
  switch (act.action) {
    case 'goto':
      return `await page.goto(${JSON.stringify(valStr)});`;
    case 'viewport': {
      const raw = valStr || '0x0';
      const parts = raw.split('x');
      const w = parts[0] || '0';
      const h = parts[1] != null && parts[1] !== '' ? parts[1] : (parts[0] || '0');
      return `await page.setViewportSize({ width: ${Number(w) || 0}, height: ${Number(h) || 0} });`;
    }
    case 'click':
      return `await ${locator}.click();`;
    case 'dblclick':
      return `await ${locator}.dblclick();`;
    case 'fill':
      return `await ${locator}.fill('${valStr.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');`;
    case 'check':
      return `await ${locator}.check();`;
    case 'uncheck':
      return `await ${locator}.uncheck();`;
    case 'selectOption':
      return `await ${locator}.selectOption('${valStr.replace(/'/g, "\\'")}');`;
    case 'press':
      return `await page.keyboard.press(${JSON.stringify(valStr)});`;
    default:
      return act.fullCode || `await ${locator}.click();`;
  }
}

function generateTestScript() {
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
  const v = ta.value.trim();
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
    previewEl.value = '';
    lastSyncedPreviewScript = '';
    return;
  }

  labelEl.style.display = '';
  previewEl.style.display = '';

  const next = generateTestScript();
  if (document.activeElement === previewEl) {
    if (previewEl.value === lastSyncedPreviewScript) {
      previewEl.value = next;
      lastSyncedPreviewScript = next;
    }
    return;
  }

  previewEl.value = next;
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
  const codePreview = ta && ta.style.display !== 'none' ? (ta.value || '') : '';
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
        ta.value = s.codePreview;
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
