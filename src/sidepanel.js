let isInspecting = false;
let isRecording = false;
let currentPOMFramework = 'playwright-ts';
let savedPOMElements = [];
let recordedActions = [];
let recLastPageUrl = '';
let _recorderSaveTimer = null;
let _pomHealthQueue = [];
let _pomHealthActive = false;
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

function pomStabilityClass(s) {
  const u = String(s || '').toUpperCase();
  if (u === 'BEST') return 'pom-stab-best';
  if (u === 'GOOD') return 'pom-stab-good';
  if (u === 'AVOID') return 'pom-stab-avoid';
  return 'pom-stab-ok';
}
function rankClass(r) {
  return r === 1 ? 'r1' : r === 2 ? 'r2' : r === 3 ? 'r3' : 'rX';
}

// ── POM v3 Feature Flags ─────────────────────────────────────────────────────
let pomActionsEnabled = true;
let pomJsdocEnabled   = true;

// ── POM Helpers ───────────────────────────────────────────────────────────────
function toPascalCase(str) {
  return String(str || 'Page').replace(/[^a-zA-Z0-9\s]/g, ' ').trim()
    .split(/\s+/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('')
    || 'Page';
}

function toCamelCase(str) {
  const words = String(str || '').replace(/[^a-zA-Z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
  return words.map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('') || 'element';
}

function toSnakeCase(str) {
  return String(str || '').replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '').replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_');
}

/** Valid JS identifier for generated class fields & methods (reserved words, leading digits). */
const POM_JS_RESERVED = new Set([
  'arguments', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'eval', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in',
  'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'static', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

function sanitizePOMIdentifier(raw) {
  let s = toCamelCase(String(raw || 'element').replace(/^[^a-zA-Z_$]+/, ''));
  if (!s) s = 'element';
  if (/^[0-9]/.test(s)) s = 'el' + s;
  if (POM_JS_RESERVED.has(s)) s += 'El';
  return s;
}

function escapeJsDocLine(s) {
  return String(s || '').replace(/\*\//g, '*\\/');
}

/** Ensures unique `genName` per field inside one page object class. */
function resolvePOMFieldNames(elements) {
  const used = new Set();
  return elements.map(el => {
    let base = sanitizePOMIdentifier(el.name);
    let genName = base;
    let n = 2;
    while (used.has(genName)) {
      genName = `${base}${n++}`;
    }
    used.add(genName);
    return { ...el, genName };
  });
}

function autoName(el, index) {
  const text = (el.visibleText || el.ariaLabel || el.placeholder || el.attr || '').slice(0, 40);
  const clean = toCamelCase(text);
  if (clean && clean.length > 1 && !/^[0-9]/.test(clean)) return clean;
  return (el.tag || 'element') + (index + 1);
}

function isFragileLocator(item) {
  const m = String(item.method || '').toLowerCase();
  const a = String(item.attr  || item.code || '');
  return m.includes('nth') || m.includes('xpath') ||
    /\.([\w-]+)/.test(a) && !a.includes('[data-') ||
    /nth-of-type|nth-child/.test(a) ||
    (m === 'css' && !a.includes('[data-'));
}

function hasDuplicate(name, code, skipIdx) {
  return savedPOMElements.some((el, i) =>
    i !== skipIdx && (el.name === name || el.code === code || (el.attr && el.attr === code)));
}

// ── Action method inference (Playwright-native) ───────────────────────────────
function inferActions(el) {
  const tag = String(el.tag || '').toLowerCase();
  const type = String(el.inputType || el.type || '').toLowerCase();
  const name = sanitizePOMIdentifier(el.name);
  const Cap = name.charAt(0).toUpperCase() + name.slice(1);
  const actions = [];

  const fillTypes = new Set(['text', 'email', 'password', 'search', 'tel', 'url', 'number', 'date', 'time', 'datetime-local', 'month', 'week', 'color', '']);
  const isFillInput = tag === 'input' && (fillTypes.has(type) || !type);

  if (tag === 'button' || tag === 'a' || type === 'submit' || type === 'button' || type === 'reset') {
    actions.push({ method: `click${Cap}`, body: `await this.${name}.click();`, doc: `Click ${name}` });
    actions.push({ method: `waitFor${Cap}`, body: `await this.${name}.waitFor({ state: 'visible' });`, doc: `Wait until ${name} is visible` });
    actions.push({ method: `expect${Cap}Visible`, body: `await expect(this.${name}).toBeVisible();`, doc: `Assert ${name} is visible` });
  } else if (tag === 'input' && type === 'radio') {
    actions.push({ method: `check${Cap}`, body: `await this.${name}.check();`, doc: `Select ${name} radio` });
    actions.push({ method: `is${Cap}Checked`, body: `return await this.${name}.isChecked();`, returnType: 'Promise<boolean>', doc: `Whether ${name} is selected` });
  } else if (tag === 'input' && type === 'checkbox') {
    actions.push({ method: `check${Cap}`, body: `await this.${name}.check();`, doc: `Check ${name}` });
    actions.push({ method: `uncheck${Cap}`, body: `await this.${name}.uncheck();`, doc: `Uncheck ${name}` });
    actions.push({ method: `is${Cap}Checked`, body: `return await this.${name}.isChecked();`, returnType: 'Promise<boolean>', doc: `Whether ${name} is checked` });
  } else if (tag === 'input' && type === 'hidden') {
    actions.push({ method: `expect${Cap}Value`, body: `await expect(this.${name}).toHaveValue(expected);`, param: 'expected: string', doc: `Assert ${name} hidden value` });
  } else if (tag === 'input' && type === 'file') {
    actions.push({
      method: `upload${Cap}`,
      body: `await this.${name}.setInputFiles(files);`,
      param: 'files: string | string[] | Buffer | { name: string; mimeType: string; buffer: Buffer }',
      doc: `Attach file(s) to ${name}`,
    });
  } else if (tag === 'input' && type === 'range') {
    actions.push({ method: `set${Cap}Value`, body: `await this.${name}.fill(String(value));`, param: 'value: number', doc: `Set ${name} slider value` });
  } else if (isFillInput) {
    actions.push({ method: `fill${Cap}`, body: `await this.${name}.fill(value);`, param: 'value: string', doc: `Fill ${name}` });
    actions.push({ method: `clear${Cap}`, body: `await this.${name}.clear();`, doc: `Clear ${name}` });
    actions.push({ method: `expect${Cap}Value`, body: `await expect(this.${name}).toHaveValue(expected);`, param: 'expected: string', doc: `Assert ${name} value` });
  } else if (tag === 'select') {
    actions.push({ method: `select${Cap}Option`, body: `await this.${name}.selectOption(option);`, param: 'option: string | { label?: string; value?: string; index?: number }', doc: `Select option in ${name}` });
  } else if (tag === 'textarea') {
    actions.push({ method: `fill${Cap}`, body: `await this.${name}.fill(value);`, param: 'value: string', doc: `Fill ${name}` });
    actions.push({ method: `expect${Cap}Value`, body: `await expect(this.${name}).toHaveValue(expected);`, param: 'expected: string', doc: `Assert ${name} text` });
  } else {
    actions.push({ method: `click${Cap}`, body: `await this.${name}.click();`, doc: `Click ${name}` });
    actions.push({ method: `get${Cap}Text`, body: `return await this.${name}.textContent();`, returnType: 'Promise<string | null>', doc: `Read text from ${name}` });
    actions.push({ method: `expect${Cap}Visible`, body: `await expect(this.${name}).toBeVisible();`, doc: `Assert ${name} is visible` });
  }
  return actions;
}

// ── JSDoc builder ─────────────────────────────────────────────────────────────
function makeJsDoc(el, indentStr) {
  if (!pomJsdocEnabled) return '';
  const lines = [];
  lines.push(`/**`);
  if (el.loc && el.loc.method) lines.push(` * @locator ${el.loc.method}('${escapeJsDocLine(el.attr || '')}')`);
  if (el.loc && el.loc.stability) lines.push(` * @stability ${String(el.loc.stability).toLowerCase()}`);
  if (el.loc && el.loc.rank != null) lines.push(` * @rank ${el.loc.rank} (from LocatorLens ranking)`);
  if (el.loc && el.loc.fullCode) lines.push(` * @example ${escapeJsDocLine(el.loc.fullCode)}`);
  if (el.capturedAt) lines.push(` * @capturedAt ${el.capturedAt.slice(0, 10)}`);
  if (el.pageUrl) lines.push(` * @page ${escapeJsDocLine(el.pageUrl)}`);
  lines.push(` */`);
  return lines.map(l => indentStr + l).join('\n') + '\n';
}

// ── Locator code for POM (Playwright only) ────────────────────────────────────
function getLocatorCode(item) {
  if (!item.loc) return item.code || '';
  return (item.loc.code || item.code || '').replace(/^page\./, '');
}

// ── Main code generator ───────────────────────────────────────────────────────
function generatePOMCode(framework) {
  if (!savedPOMElements.length)
    return '// No elements yet.\n// Go to the Inspector tab and click + POM on any locator card.';

  const groups = {};
  savedPOMElements.forEach(el => {
    const key = el.pageTitle || el.pageUrl || 'PageObject';
    if (!groups[key]) groups[key] = { url: el.pageUrl || '', elements: [] };
    groups[key].elements.push(el);
  });

  const timestamp = new Date().toISOString().slice(0, 10);
  const banner = `// ─────────────────────────────────────────────────────────────
// Generated by LocatorLens  •  ${timestamp}
// ─────────────────────────────────────────────────────────────\n`;

  const headers = {
    'playwright-ts': `${banner}import { Page, Locator${pomActionsEnabled ? ', expect' : ''} } from '@playwright/test';\n`,
    'playwright-js': `${banner}${pomActionsEnabled ? "import { expect } from '@playwright/test';\n" : ''}`,
  };

  const blocks = Object.entries(groups).map(([pageKey, { url, elements: rawEls }]) => {
    const rawName  = pageKey.replace(/https?:\/\/[^/]+/, '').replace(/[^a-zA-Z0-9]/g, ' ').trim();
    const className = (toPascalCase(rawName) || 'Page') + 'Page';
    const elements = resolvePOMFieldNames(rawEls);

    // ── Playwright TypeScript ──
    if (framework === 'playwright-ts') {
      const decls   = elements.map(el => {
        const jsdoc = makeJsDoc(el, '  ');
        const fragile = isFragileLocator(el) ? '  // ⚠ FRAGILE — consider a more stable locator\n' : '';
        return `${jsdoc}${fragile}  readonly ${el.genName}: Locator;`;
      }).join('\n');

      const assigns  = elements.map(el => `    this.${el.genName} = page.${getLocatorCode(el)};`).join('\n');

      let methods = '';
      if (pomActionsEnabled) {
        methods = '\n' + elements.flatMap(el => {
          const elFor = { ...el, name: el.genName };
          return inferActions(elFor).map(a => {
            const jsdoc = pomJsdocEnabled ? `  /** ${a.doc} */\n` : '';
            const param  = a.param ? `${a.param}` : '';
            const ret    = a.returnType ? `: ${a.returnType}` : ': Promise<void>';
            return `${jsdoc}  async ${a.method}(${param})${ret} {\n    ${a.body}\n  }`;
          });
        }).join('\n\n') + '\n';
      }

      return `// Page: ${url || pageKey}\nexport class ${className} {\n${decls}\n\n  constructor(readonly page: Page) {\n${assigns}\n  }${methods}}`;
    }

    // ── Playwright JavaScript ──
    if (framework === 'playwright-js') {
      const assigns = elements.map(el => `    this.${el.genName} = page.${getLocatorCode(el)};`).join('\n');
      let methods = '';
      if (pomActionsEnabled) {
        methods = '\n' + elements.flatMap(el => {
          const elFor = { ...el, name: el.genName };
          return inferActions(elFor).map(a => {
            const jsdoc = pomJsdocEnabled ? `  /** ${a.doc} */\n` : '';
            const paramJs = a.param ? a.param.split(':')[0].trim() : '';
            return `${jsdoc}  async ${a.method}(${paramJs}) {\n    ${a.body}\n  }`;
          });
        }).join('\n\n') + '\n';
      }
      return `// Page: ${url || pageKey}\nexport class ${className} {\n  constructor(page) {\n${assigns}\n  }${methods}}`;
    }

    return '';
  });

  return (headers[framework] || headers['playwright-ts']) + '\n' + blocks.join('\n\n');
}

// ── Test Scaffold Generator ───────────────────────────────────────────────────
function generateTestScaffold() {
  if (!savedPOMElements.length) return '// No elements yet.';
  const timestamp = new Date().toISOString().slice(0, 10);

  const groups = {};
  savedPOMElements.forEach(el => {
    const key = el.pageTitle || el.pageUrl || 'PageObject';
    if (!groups[key]) groups[key] = { url: el.pageUrl || '', elements: [] };
    groups[key].elements.push(el);
  });

  const classNames = Object.keys(groups).map(pageKey => {
    const rawName = pageKey.replace(/https?:\/\/[^/]+/, '').replace(/[^a-zA-Z0-9]/g, ' ').trim();
    return (toPascalCase(rawName) || 'Page') + 'Page';
  });
  const uniqueClassNames = [...new Set(classNames)];
  const imports = uniqueClassNames.length
    ? `import { ${uniqueClassNames.join(', ')} } from './PageObject';`
    : '';

  const suites = Object.entries(groups).map(([pageKey, { url, elements: rawEls }]) => {
    const rawName   = pageKey.replace(/https?:\/\/[^/]+/, '').replace(/[^a-zA-Z0-9]/g, ' ').trim();
    const className = (toPascalCase(rawName) || 'Page') + 'Page';
    const varName   = className.charAt(0).toLowerCase() + className.slice(1);
    const elements  = resolvePOMFieldNames(rawEls);

    const actionTests = elements.flatMap(el => {
      const elFor = { ...el, name: el.genName };
      const actions = inferActions(elFor);
      return actions.slice(0, 2).map(a => {
        const param = a.param
          ? (a.param.includes('expected') ? `'TODO'` : a.param.includes('number') ? '42' : a.param.includes('files') ? `'./fixtures/TODO.pdf'` : `'TODO'`)
          : '';
        const assertLine = a.body.includes('expect(')
          ? ''
          : `    await expect(${varName}.${el.genName}).toBeVisible();\n`;
        return `\n  test('${a.doc}', async () => {\n${assertLine}    await ${varName}.${a.method}(${param});\n  });`;
      });
    }).join('');

    return `test.describe('${className}', () => {\n  let ${varName}: ${className};\n\n  test.beforeEach(async ({ page }) => {\n    ${varName} = new ${className}(page);\n    await page.goto('${(url || 'TODO: enter URL').replace(/'/g, "\\'")}');\n  });${actionTests}\n});`;
  }).join('\n\n');

  return `// ────────────────────────────────────────────────────────────
// Test Scaffold — generated by LocatorLens  •  ${timestamp}
// Run with: npx playwright test
// POM classes: import from the same file you downloaded (e.g. ./PageObject).
// ────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test';
${imports}

${suites}`;
}


function updatePOMPreview() {
  const textarea = document.getElementById('pomCodePreview');
  const filename = document.getElementById('pomPreviewFilename');
  const countBadge = document.getElementById('pomCountBadge');
  if (!textarea) return;
  const code = generatePOMCode(currentPOMFramework);
  textarea.value = code;
  const names = { 'playwright-ts': 'PageObject.ts', 'playwright-js': 'PageObject.js' };
  if (filename) filename.textContent = names[currentPOMFramework] || 'PageObject.ts';
  if (countBadge) countBadge.textContent = savedPOMElements.length ? `(${savedPOMElements.length})` : '';
}

// \u2500\u2500 POM Health Check Queue \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
let _pomHealthCurrentIdx = -1;

function processPomHealthQueue() {
  if (_pomHealthQueue.length === 0) { _pomHealthActive = false; _pomHealthCurrentIdx = -1; return; }
  _pomHealthActive = true;
  const { idx, selector } = _pomHealthQueue.shift();
  _pomHealthCurrentIdx = idx;
  chrome.runtime.sendMessage({ type: 'LAB_VALIDATE', selector });
}

function handlePomHealthResult(count) {
  if (_pomHealthCurrentIdx < 0 || !savedPOMElements[_pomHealthCurrentIdx]) {
    _pomHealthCurrentIdx = -1;
    setTimeout(processPomHealthQueue, 80);
    return;
  }
  const item = savedPOMElements[_pomHealthCurrentIdx];
  if (count > 1)      { item.health = 'multi'; item.healthCount = count; }
  else if (count === 1) { item.health = 'live'; }
  else                 { item.health = 'gone'; }
  _pomHealthCurrentIdx = -1;
  chrome.storage.local.set({ savedPOMElements });
  renderPOMList();
  setTimeout(processPomHealthQueue, 100);
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

// ── Locator display (Playwright only) ─────────────────────────────────────────
function formatForPlaywright(loc) {
  return { code: loc.code || '', fullCode: loc.fullCode };
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
    
    const { code, fullCode } = formatForPlaywright(loc);
    
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
            <button class="copy-btn add-pom-btn"
              data-code="${esc(code.replace('page.', ''))}"
              data-method="${esc(loc.method)}"
              data-attr="${esc(loc.matchedAttr)}"
              data-tag="${esc(el.tag || '')}"
              data-type="${esc(el.type || '')}"
              data-text="${esc((el.visibleText || '').slice(0,40))}"
              data-aria="${esc((el.ariaLabel || '').slice(0,40))}"
              data-ph="${esc((el.placeholder || '').slice(0,40))}"
              style="background:var(--primary-dim); color:var(--text);">+ POM</button>
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
    if (_pomHealthActive && _pomHealthCurrentIdx >= 0) {
      handlePomHealthResult(msg.count);
    } else {
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
      const btn = e.target;
      const code = btn.getAttribute('data-code').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      const method      = btn.getAttribute('data-method') || '';
      const attr        = btn.getAttribute('data-attr') || '';
      const elTag       = btn.getAttribute('data-tag') || 'element';
      const elText      = btn.getAttribute('data-text') || '';
      const elAria      = btn.getAttribute('data-aria') || '';
      const elPh        = btn.getAttribute('data-ph') || '';
      const elInputType = btn.getAttribute('data-type') || '';
      const elNameRaw   = autoName({ tag: elTag, visibleText: elText, ariaLabel: elAria, placeholder: elPh, attr }, savedPOMElements.length);
      const elName        = sanitizePOMIdentifier(elNameRaw);

      // Duplicate detection
      const dupCode = savedPOMElements.some(el => el.code === code);
      const dupName = savedPOMElements.some(el => el.name === elName);
      if (dupCode) {
        const existing = savedPOMElements.find(el => el.code === code);
        showPomWarning(`⚠ Already in POM as "${existing ? existing.name : elName}" — adding anyway.`);
      } else if (dupName) {
        showPomWarning(`⚠ Name "${elName}" already exists — adding with suffix.`);
      }
      const finalName = dupName && !dupCode
        ? elName + (savedPOMElements.filter(el => el.name.startsWith(elName)).length + 1)
        : elName;

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const pageUrl   = (tabs && tabs[0] && tabs[0].url)   || 'Unknown Page';
        const pageTitle = (tabs && tabs[0] && tabs[0].title) || pageUrl;
        const loc = lastResultData && lastResultData.locators
          ? lastResultData.locators.find(l => l.matchedAttr === attr) || null : null;
        const inputType = elInputType || (lastResultData && lastResultData.elementData && lastResultData.elementData.type) || '';
        savedPOMElements.push({
          name: sanitizePOMIdentifier(finalName), code, method, attr,
          tag: elTag, inputType,
          pageUrl, pageTitle, loc, health: 'pending',
          capturedAt: new Date().toISOString()
        });
        chrome.storage.local.set({ savedPOMElements });
        renderPOMList();
        updatePOMPreview();
        btn.textContent = '✓ Added';
        setTimeout(() => { btn.textContent = '+ POM'; }, 1800);
      });
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
      tabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      tab.classList.add('active');
      const targetId = tab.getAttribute('data-target');
      document.getElementById(targetId).classList.add('active');
    });
  });

  // ── POM Builder (world-class rewrite) ──
  let _pomDragIdx = null;

  function renderPOMList() {
    const list = document.getElementById('pomList');
    const empty = document.getElementById('pomEmptyState');
    if (!list) return;
    if (savedPOMElements.length === 0) {
      list.innerHTML = '';
      if (empty) { empty.style.display = ''; list.appendChild(empty); }
      updatePOMPreview();
      return;
    }
    if (empty) empty.style.display = 'none';

    // Group by page
    const groups = {};
    savedPOMElements.forEach((el, i) => {
      const key = el.pageTitle || el.pageUrl || 'Page';
      if (!groups[key]) groups[key] = [];
      groups[key].push({ el, i });
    });

    const multiGroup = Object.keys(groups).length > 1;
    let html = '';
    Object.entries(groups).forEach(([pageKey, items]) => {
      if (multiGroup) html += `<div class="pom-group-label">${esc(pageKey)}</div>`;
      items.forEach(({ el, i }) => {
        const fragile   = isFragileLocator(el);
        const stab      = el.loc && el.loc.stability;
        const stabHtml  = stab ? `<span class="pom-stability ${pomStabilityClass(stab)}" title="Locator ranking stability">${esc(pillLabel(stab))}</span>` : '';
        const healthClass = el.health || 'pending';
        const healthText  = healthClass === 'live' ? '● LIVE' : healthClass === 'gone' ? '✗ GONE' : healthClass === 'multi' ? `~ ${el.healthCount || '?'}` : '...';
        const capturedLabel = el.capturedAt ? new Date(el.capturedAt).toLocaleDateString() : '';
        html += `
          <div class="pom-entry${fragile ? ' pom-entry-fragile' : ''}" draggable="true" data-idx="${i}">
            <span class="pom-drag-handle" title="Drag to reorder">⠇</span>
            <div class="pom-entry-body">
              <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                <input class="pom-entry-name-input" type="text" value="${esc(el.name)}" data-idx="${i}" title="Click to rename" />
                ${stabHtml}
                ${fragile ? '<span class="pom-fragile-badge" title="Fragile locator — may break when DOM changes">⚠ FRAGILE</span>' : ''}
              </div>
              <div class="pom-entry-locator" title="${esc(el.code)}">${esc(el.code)}</div>
              ${el.pageUrl ? `<div class="pom-entry-page">${esc(el.pageUrl)}${capturedLabel ? ` · ${capturedLabel}` : ''}</div>` : ''}
            </div>
            <span class="pom-health ${healthClass}">${healthText}</span>
            <button class="pom-remove-btn" data-remove="${i}" title="Remove">×</button>
          </div>`;
      });
    });

    safeRender(list, html);

    // Bind inline rename
    list.querySelectorAll('.pom-entry-name-input').forEach(input => {
      input.addEventListener('blur', () => {
        const idx = parseInt(input.getAttribute('data-idx'), 10);
        if (!isNaN(idx) && savedPOMElements[idx]) {
          const raw = input.value.trim() || savedPOMElements[idx].name;
          savedPOMElements[idx].name = sanitizePOMIdentifier(raw);
          input.value = savedPOMElements[idx].name;
          chrome.storage.local.set({ savedPOMElements });
          updatePOMPreview();
        }
      });
      input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
    });

    // Bind remove buttons
    list.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-remove'), 10);
        savedPOMElements.splice(idx, 1);
        chrome.storage.local.set({ savedPOMElements });
        renderPOMList();
        updatePOMPreview();
      });
    });

    // Drag-to-reorder
    list.querySelectorAll('.pom-entry').forEach(entry => {
      entry.addEventListener('dragstart', () => {
        _pomDragIdx = parseInt(entry.getAttribute('data-idx'), 10);
        entry.style.opacity = '0.5';
      });
      entry.addEventListener('dragend', () => { entry.style.opacity = ''; });
      entry.addEventListener('dragover', e => { e.preventDefault(); entry.classList.add('drag-over'); });
      entry.addEventListener('dragleave', () => entry.classList.remove('drag-over'));
      entry.addEventListener('drop', e => {
        e.preventDefault();
        entry.classList.remove('drag-over');
        const targetIdx = parseInt(entry.getAttribute('data-idx'), 10);
        if (_pomDragIdx !== null && _pomDragIdx !== targetIdx) {
          const moved = savedPOMElements.splice(_pomDragIdx, 1)[0];
          savedPOMElements.splice(targetIdx, 0, moved);
          chrome.storage.local.set({ savedPOMElements });
          renderPOMList();
          updatePOMPreview();
        }
        _pomDragIdx = null;
      });
    });

    updatePOMPreview();
  }

  // Framework chips
  document.querySelectorAll('.pom-fw-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.pom-fw-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentPOMFramework = chip.getAttribute('data-pomfw');
      updatePOMPreview();
    });
  });

  // Copy POM
  document.getElementById('copyPOMBtn').addEventListener('click', (e) => {
    if (savedPOMElements.length === 0) return;
    copyToClipboard(generatePOMCode(currentPOMFramework), e.target);
  });

  // Download POM
  document.getElementById('downloadPOMBtn').addEventListener('click', () => {
    if (savedPOMElements.length === 0) return;
    const code = generatePOMCode(currentPOMFramework);
    const names = { 'playwright-ts': 'PageObject.ts', 'playwright-js': 'PageObject.js' };
    const blob = new Blob([code], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = names[currentPOMFramework] || 'PageObject.ts';
    a.click(); URL.revokeObjectURL(url);
  });

  // ── POM v3 Feature Handlers ─────────────────────────────────────────────────

  // Warning toast
  function showPomWarning(msg) {
    let w = document.getElementById('pomWarnToast');
    if (!w) {
      w = document.createElement('div');
      w.id = 'pomWarnToast';
      w.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);background:#ffb86c;color:#1e1e2e;padding:6px 12px;border-radius:4px;font-size:10px;font-weight:700;z-index:9999;max-width:280px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.4);';
      document.body.appendChild(w);
    }
    w.textContent = msg; w.style.display = 'block';
    clearTimeout(w._t);
    w._t = setTimeout(() => { w.style.display = 'none'; }, 3500);
  }

  // Actions toggle
  const actionsToggle = document.getElementById('pomActionsToggle');
  if (actionsToggle) {
    actionsToggle.addEventListener('change', () => { pomActionsEnabled = actionsToggle.checked; updatePOMPreview(); });
  }

  // JSDoc toggle
  const jsdocToggle = document.getElementById('pomJsdocToggle');
  if (jsdocToggle) {
    jsdocToggle.addEventListener('change', () => { pomJsdocEnabled = jsdocToggle.checked; updatePOMPreview(); });
  }

  // Clear POM
  document.getElementById('clearPOMBtn').addEventListener('click', () => {
    savedPOMElements = [];
    chrome.storage.local.set({ savedPOMElements });
    renderPOMList();
  });

  // Generate Test Scaffold
  document.getElementById('generateTestBtn').addEventListener('click', () => {
    if (!savedPOMElements.length) return showPomWarning('Add elements first.');
    const code = generateTestScaffold();
    const blob = new Blob([code], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'locatorlens.spec.ts';
    a.click(); URL.revokeObjectURL(url);
  });

  // Export Session
  document.getElementById('exportSessionBtn').addEventListener('click', () => {
    if (!savedPOMElements.length) return showPomWarning('Nothing to export yet.');
    const session = {
      version: '3.0', exportedAt: new Date().toISOString(), framework: currentPOMFramework,
      pages: Object.values(savedPOMElements.reduce((acc, el) => {
        const k = el.pageUrl || 'Unknown';
        (acc[k] = acc[k] || { url: el.pageUrl || '', title: el.pageTitle || '', elements: [] }).elements.push(el);
        return acc;
      }, {}))
    };
    const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'locatorlens-session.json';
    a.click(); URL.revokeObjectURL(url);
  });

  // Import Session
  document.getElementById('importSessionBtn').addEventListener('click', () => {
    const fi = document.createElement('input');
    fi.type = 'file'; fi.accept = '.json';
    fi.addEventListener('change', () => {
      const file = fi.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const session = JSON.parse(ev.target.result);
          if (!session.pages) throw new Error('Invalid format');
          const imported = session.pages.flatMap(p =>
            (p.elements || []).map(el => ({
              ...el,
              name: sanitizePOMIdentifier(el.name || 'element'),
              pageUrl: p.url || el.pageUrl || '',
              pageTitle: p.title || el.pageTitle || '',
              health: 'pending',
            }))
          );
          if (!imported.length) return showPomWarning('No elements found.');
          const existing = new Set(savedPOMElements.map(el => el.code));
          const toAdd = imported.filter(el => !existing.has(el.code));
          const skipped = imported.length - toAdd.length;
          savedPOMElements = [...savedPOMElements, ...toAdd];
          chrome.storage.local.set({ savedPOMElements });
          renderPOMList(); updatePOMPreview();
          showPomWarning(`✓ Imported ${toAdd.length} element${toAdd.length!==1?'s':''}${skipped?` (${skipped} duplicate${skipped>1?'s':''} skipped)`:''}.`);
        } catch (err) { showPomWarning('⚠ Could not read file: ' + err.message); }
      };
      reader.readAsText(file);
    });
    fi.click();
  });

  // Check Health
  document.getElementById('checkHealthBtn').addEventListener('click', () => {
    if (!savedPOMElements.length) return;
    savedPOMElements.forEach(el => { el.health = 'pending'; el.healthCount = null; });
    renderPOMList(); _pomHealthQueue = [];
    let i = 0;
    function checkNext() {
      if (i >= savedPOMElements.length) { if (!_pomHealthActive) processPomHealthQueue(); return; }
      const item = savedPOMElements[i];
      const attr = String(item.attr || item.code || '');
      let selector = null;
      if (/^[\[#.]/.test(attr)) selector = attr;
      else if (/testid/i.test(item.method || '')) selector = `[data-testid="${attr.replace(/^["']/,'').replace(/["']$/,'')}"]`;
      else if (/\bid\b/i.test(item.method||'') && !/testid/i.test(item.method||'')) selector = `#${attr.replace(/^["']/,'').replace(/["']$/,'')}`;
      else if (/name/i.test(item.method||'')) selector = `[name="${attr.replace(/^["']/,'').replace(/["']$/,'')}"]`;
      if (selector) _pomHealthQueue.push({ idx: i, selector });
      i++; setTimeout(checkNext, 30);
    }
    checkNext();
  });

  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get('savedPOMElements', (res) => {
      if (res && res.savedPOMElements) {
        savedPOMElements = res.savedPOMElements.map(el => ({
          ...el,
          name: sanitizePOMIdentifier(el.name || 'element'),
        }));
        chrome.storage.local.set({ savedPOMElements });
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
