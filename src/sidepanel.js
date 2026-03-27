let isInspecting = false;
let currentFramework = 'playwright';
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
    .replace(/\b(getByRole|getByLabel|getByPlaceholder|getByText|getByAltText|getByTitle|getByTestId|locator|click|fill|check|selectOption|press|type|hover|focus|blur|waitFor|toBeVisible|toHaveText|toBeChecked)\b/g, '<span class="fn">$1</span>')
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

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(onSuccess).catch(onSuccess);
  } else {
    try {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
    } catch (e) {}
    onSuccess();
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
  const { elementData: el, locators, avoidList, proTip } = data;

  document.getElementById('idleState').style.display = 'none';
  document.getElementById('resultsState').style.display = '';

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
  
  elBar.innerHTML = chips.join('');

  // ── Locator cards ──
  const container = document.getElementById('cardsContainer');
  container.innerHTML = locators.map((loc, i) => {
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
          <button class="copy-btn" data-code="${esc(fullCode)}">Copy</button>
        </div>
        <div class="why-row">
          <button class="toggle-explain">▶ Why?</button>
        </div>
        <div class="card-explain">${esc(loc.explanation || '')}</div>
      </div>`;
  }).join('');

  // ── Avoid section ──
  const avoidLabel = document.getElementById('avoidLabel');
  const avoidSec = document.getElementById('avoidContainer');
  if (avoidList && avoidList.length > 0) {
    avoidLabel.style.display = '';
    avoidSec.style.display = '';
    avoidSec.innerHTML = `
      <div class="avoid-title">⚠️ Avoid these locators</div>
      ${avoidList.map(a => `
        <div class="avoid-row">
          <span class="avoid-x">✗</span>
          <div><span class="avoid-code">${esc(a.locator)}</span><br>${esc(a.reason)}</div>
        </div>`).join('')}`;
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

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
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
});

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

  // Tell background/popup I am open!
  chrome.runtime.sendMessage({ type: 'PANEL_HEARTBEAT' });
});
