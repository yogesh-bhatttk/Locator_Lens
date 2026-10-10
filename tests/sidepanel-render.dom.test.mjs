/* global LLCodegen */
// @vitest-environment jsdom
//
// sidepanel.js is a classic script, not a module — it declares its helpers at top
// level and wires listeners on load. Rather than restructure shipping code to suit
// the tests, the real file is evaluated in this jsdom context (sloppy mode, so its
// declarations land on the global object) behind a minimal `chrome` stub.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

beforeAll(async () => {
  // sidepanel.html loads codegen.js first; formatLocator/buildActionCode need it.
  await import('../src/codegen.js');
  const noop = () => {};
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage: noop,
      connect: () => ({ onMessage: { addListener: noop }, onDisconnect: { addListener: noop } }),
      onMessage: { addListener: noop },
    },
    storage: { local: { get: noop, set: noop, remove: noop } },
  };
  vm.runInThisContext(readFileSync(join(ROOT, 'src/sidepanel.js'), 'utf8'), { filename: 'sidepanel.js' });
});

let host;
beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  host = document.getElementById('host');
});

describe('esc', () => {
  it('escapes every character that can break out of an attribute', () => {
    expect(esc(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('renders null and undefined as an empty string', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });

  it('preserves falsy values that are real content', () => {
    // String(s || '') used to turn a legitimate 0 into an empty cell.
    expect(esc(0)).toBe('0');
    expect(esc(false)).toBe('false');
  });
});

describe('safeRender', () => {
  it('renders ordinary markup', () => {
    safeRender(host, '<div class="a">hello</div>');
    expect(host.querySelector('.a').textContent).toBe('hello');
  });

  it('strips inline event handlers', () => {
    // DOMParser alone leaves these intact, and they execute once the node is
    // adopted into the live document — the reason parse-then-append is not
    // equivalent to sanitising.
    safeRender(host, '<img src="x" onerror="globalThis.__pwned = true">');
    expect(host.querySelector('img').hasAttribute('onerror')).toBe(false);
    expect(globalThis.__pwned).toBeUndefined();
  });

  it('strips handlers on nested elements too', () => {
    safeRender(host, '<div><span><b onclick="globalThis.__pwned = true">x</b></span></div>');
    expect(host.querySelector('b').hasAttribute('onclick')).toBe(false);
  });

  it('removes script and other executable elements', () => {
    safeRender(host, '<div>ok</div><script>globalThis.__pwned = true</script><iframe src="x"></iframe>');
    expect(host.querySelector('script')).toBeNull();
    expect(host.querySelector('iframe')).toBeNull();
    expect(host.textContent).toContain('ok');
  });

  it('drops javascript: URLs while keeping ordinary ones', () => {
    safeRender(host, '<a href="javascript:alert(1)">a</a><a id="ok" href="https://example.com">b</a>');
    expect(host.querySelector('a').hasAttribute('href')).toBe(false);
    expect(host.querySelector('#ok').getAttribute('href')).toBe('https://example.com');
  });

  it('drops <style>, <form>, <meta>, <base>, <link> and SVG animation/script outright', () => {
    safeRender(
      host,
      '<div id="keep">ok' +
        '<style>body{display:none}</style>' +
        '<form action="https://evil.test"><input name="q"></form>' +
        '<meta http-equiv="refresh" content="0;url=https://evil.test">' +
        '<base href="https://evil.test/">' +
        '<link rel="stylesheet" href="https://evil.test/x.css">' +
        '<svg><animate attributeName="href" to="javascript:alert(1)"/><set attributeName="onload" to="x"/><script>globalThis.__pwned=1</script></svg>' +
        '<template><img src=x onerror="globalThis.__pwned=1"></template>' +
        '</div>'
    );
    for (const sel of [
      'style',
      'form',
      'input',
      'meta',
      'base',
      'link',
      'svg',
      'animate',
      'set',
      'script',
      'template',
    ]) {
      expect(host.querySelector(sel), sel).toBeNull();
    }
    expect(host.querySelector('#keep').textContent).toBe('ok');
    expect(globalThis.__pwned).toBeUndefined();
  });

  it('strips dangerous attributes: formaction, srcdoc, xlink:href, obfuscated javascript: URLs', () => {
    safeRender(
      host,
      '<button formaction="javascript:alert(1)">b</button>' +
        '<a id="x" xlink:href="javascript:alert(1)" href="java\tscript:alert(1)">x</a>' +
        '<a id="y" href=" JaVaScRiPt:alert(1)">y</a>' +
        '<img id="z" srcdoc="<script>1</script>" src="data:image/svg+xml,<svg onload=alert(1)>">' +
        '<div id="s" style="background:url(javascript:alert(1))">s</div>'
    );
    expect(host.querySelector('button').hasAttribute('formaction')).toBe(false);
    expect(host.querySelector('#x').attributes).toHaveLength(1); // only id survives
    expect(host.querySelector('#y').hasAttribute('href')).toBe(false);
    expect(host.querySelector('#z').hasAttribute('srcdoc')).toBe(false);
    expect(host.querySelector('#z').hasAttribute('src')).toBe(false);
    expect(host.querySelector('#s').hasAttribute('style')).toBe(false);
  });

  it('keeps the attributes the panel templates rely on', () => {
    safeRender(
      host,
      '<button type="button" class="copy-btn" data-code="a&amp;b" aria-label="Copy" aria-expanded="false" title="t" style="animation-delay:0.1s">Copy</button>'
    );
    const b = host.querySelector('button');
    expect(b.getAttribute('data-code')).toBe('a&b');
    expect(b.getAttribute('aria-label')).toBe('Copy');
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(b.getAttribute('style')).toContain('animation-delay');
    expect(b.className).toBe('copy-btn');
  });

  it('replaces previous content rather than appending to it', () => {
    safeRender(host, '<p>first</p>');
    safeRender(host, '<p>second</p>');
    expect(host.querySelectorAll('p')).toHaveLength(1);
    expect(host.textContent).toBe('second');
  });

  it('neutralises a hostile value that reached the DOM through esc()', () => {
    const hostile = '"><img src=x onerror="globalThis.__pwned = true">';
    safeRender(host, `<div title="${esc(hostile)}">x</div>`);
    expect(host.querySelector('img')).toBeNull();
    expect(globalThis.__pwned).toBeUndefined();
    expect(host.querySelector('div').getAttribute('title')).toBe(hostile);
  });
});

describe('hl (syntax highlighting)', () => {
  const textOf = (code) => {
    safeRender(host, hl(code));
    return host.textContent;
  };

  it('never loses or alters the underlying code', () => {
    for (const code of [
      "await page.getByRole('button', { name: 'Save' }).click();",
      'driver.find_element(By.CSS_SELECTOR, "[data-qa=\\"x\\"]")',
      "cy.get('#id').should('have.text', 'Total: 42');",
      'expect(page.get_by_label("Email")).to_be_visible()',
    ]) {
      expect(textOf(code)).toBe(code);
    }
  });

  it('marks up single-quoted string literals', () => {
    safeRender(host, hl("page.getByText('hello')"));
    expect([...host.querySelectorAll('.str')].map((n) => n.textContent)).toContain("'hello'");
  });

  it('marks up double-quoted string literals', () => {
    safeRender(host, hl('page.get_by_text("hello")'));
    expect([...host.querySelectorAll('.str')].map((n) => n.textContent)).toContain('"hello"');
  });

  it('does not recolour keywords that appear inside a string', () => {
    safeRender(host, hl("page.getByText('await const page')"));
    expect(host.querySelector('.str').querySelector('.kw')).toBeNull();
  });

  it('escapes angle brackets so markup in a locator cannot inject nodes', () => {
    safeRender(host, hl("page.locator('<img src=x onerror=alert(1)>')"));
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('handles an empty or nullish input', () => {
    expect(() => hl('')).not.toThrow();
    expect(() => hl(null)).not.toThrow();
  });
});

// The panel is where a locator stops being data and becomes the line a user pastes
// into their suite. These cover the two ways that went wrong: a translated locator
// that quietly dropped its parent scope, and a payload shape that threw mid-render
// and left the panel stranded on a half-drawn result.
describe('output target translation', () => {
  const chained = {
    rank: 1,
    method: 'Chained/Filtered',
    stability: 'BEST',
    matchedAttr: 'Parent: row-2',
    code: "page.getByTestId('row-2').getByRole('button', { name: 'Delete' })",
    fullCode: "await page.getByTestId('row-2').getByRole('button', { name: 'Delete' }).click();",
    target: {
      kind: 'chain',
      parent: { kind: 'testid', attr: 'data-testid', value: 'row-2' },
      child: { kind: 'role', role: 'button', name: 'Delete' },
    },
  };

  /** outFramework/outLanguage are top-level `let`s, so assign them in the same realm. */
  const setOutput = (fw, lang) =>
    vm.runInThisContext(`outFramework = ${JSON.stringify(fw)}; outLanguage = ${JSON.stringify(lang)};`);

  afterEach(() => setOutput('playwright', 'typescript'));

  it('keeps Playwright JS/TS on the engine strings', () => {
    setOutput('playwright', 'typescript');
    expect(formatLocator(chained, 'click').code).toBe(chained.code);
  });

  it('keeps the parent scope when translating to another framework', () => {
    for (const [fw, lang] of [
      ['selenium', 'javascript'],
      ['selenium', 'python'],
      ['cypress', 'javascript'],
      ['playwright', 'python'],
    ]) {
      setOutput(fw, lang);
      const { code, fullCode } = formatLocator(chained, 'click');
      expect(code, `${fw}/${lang}`).toContain('row-2');
      expect(fullCode, `${fw}/${lang}`).toContain('row-2');
    }
  });

  it('labels a chained locator meaningfully outside Playwright', () => {
    setOutput('playwright', 'typescript');
    expect(strategyLabel(chained)).toBe('Chained/Filtered');
    setOutput('selenium', 'python');
    expect(strategyLabel(chained)).toBe('Scoped to parent');
  });

  it('generates a recorded step from the chain rather than the bare child', () => {
    for (const [fw, lang] of [
      ['playwright', 'typescript'],
      ['selenium', 'python'],
      ['cypress', 'javascript'],
    ]) {
      setOutput(fw, lang);
      const line = buildActionCode({ action: 'click', target: chained.target });
      expect(line, `${fw}/${lang}`).toContain('row-2');
      expect(line, `${fw}/${lang}`).not.toContain('undefined');
    }
  });
});

// A step recorded before structured targets existed only has the recorder's
// Playwright-TS fullCode. Pasting that verbatim into a Selenium/Cypress/Python file
// made the whole generated script unparseable.
describe('steps that cannot be converted', () => {
  const setOutput = (fw, lang) =>
    vm.runInThisContext(`outFramework = ${JSON.stringify(fw)}; outLanguage = ${JSON.stringify(lang)};`);
  afterEach(() => setOutput('playwright', 'typescript'));

  const legacy = {
    action: 'click',
    code: "page.locator('#go')",
    fullCode: "await page.locator('#go').click();",
  };

  it('keeps the Playwright line for Playwright JS/TS', () => {
    setOutput('playwright', 'typescript');
    expect(buildActionCode(legacy)).toBe(legacy.fullCode);
  });

  it('emits a language-appropriate TODO comment everywhere else', () => {
    for (const [fw, lang, prefix] of [
      ['selenium', 'python', '# TODO: could not convert step: click'],
      ['playwright', 'python', '# TODO: could not convert step: click'],
      ['selenium', 'javascript', '// TODO: could not convert step: click'],
      ['cypress', 'typescript', '// TODO: could not convert step: click'],
    ]) {
      setOutput(fw, lang);
      const line = buildActionCode(legacy);
      expect(line.startsWith(prefix), `${fw}/${lang}: ${line}`).toBe(true);
      expect(line).not.toContain('await ');
      expect(line).not.toMatch(/[\r\n]/);
    }
  });

  it('never leaks a newline out of the comment', () => {
    setOutput('selenium', 'python');
    expect(buildActionCode({ action: 'hover', code: "page.locator('a')\nimport os" })).not.toMatch(/\n/);
  });
});

describe('renderResults resilience', () => {
  /** The subset of sidepanel.html that renderResults writes into. */
  function mountPanel() {
    document.body.innerHTML = [
      'idleState',
      'resultsState',
      'a11yLabel',
      'a11yContainer',
      'elBar',
      'cardsContainer',
      'avoidLabel',
      'avoidContainer',
      'proTip',
    ]
      .map((id) => `<div id="${id}"></div>`)
      .join('');
  }

  beforeEach(mountPanel);

  it('renders a full result', () => {
    renderResults({
      elementData: { tag: 'button', role: 'button', suggestedAction: 'click' },
      locators: [
        {
          rank: 1,
          method: 'getByRole()',
          stability: 'BEST',
          matchedAttr: 'role="button"',
          code: "page.getByRole('button')",
          fullCode: "await page.getByRole('button').click();",
          target: { kind: 'role', role: 'button' },
          matchCount: 1,
          unique: true,
        },
      ],
      avoidList: [{ locator: 'xpath', reason: 'fragile' }],
      proTip: 'add a test id',
      a11y: [{ severity: 'high', message: 'no label' }],
    });
    expect(document.querySelectorAll('#cardsContainer .card')).toHaveLength(1);
    expect(document.getElementById('cardsContainer').textContent).toContain('getByRole');
    expect(document.getElementById('proTip').textContent).toContain('add a test id');
    expect(document.getElementById('resultsState').style.display).toBe('');
  });

  describe('per-framework order and long code (C9)', () => {
    const setOut = (fw, lang) =>
      vm.runInThisContext(`outFramework = ${JSON.stringify(fw)}; outLanguage = ${JSON.stringify(lang)};`);
    afterEach(() => setOut('playwright', 'typescript'));
    const role = {
      rank: 1,
      method: 'getByRole()',
      stability: 'BEST',
      code: "page.getByRole('textbox', { name: 'Username or Email' })",
      target: { kind: 'role', role: 'textbox', name: 'Username or Email' },
      matchCount: 1,
      unique: true,
    };
    const id = {
      rank: 2,
      method: 'locator(#id)',
      stability: 'GOOD',
      code: "page.locator('#username')",
      target: { kind: 'id', value: 'username' },
      matchCount: 1,
      unique: true,
    };
    const cardCodes = () =>
      [...document.querySelectorAll('#cardsContainer .code-txt')].map((n) => n.textContent);

    it('keeps the engine order for Playwright', () => {
      renderResults({ elementData: { tag: 'input' }, locators: [role, id], avoidList: [], a11y: [] });
      expect(cardCodes()[0]).toContain('getByRole');
    });

    it('puts a short, helper-free unique locator first for Selenium, and numbers cards in that order', () => {
      setOut('selenium', 'typescript');
      renderResults({ elementData: { tag: 'input' }, locators: [role, id], avoidList: [], a11y: [] });
      expect(cardCodes()[0]).toContain("By.id('username')");
      expect([...document.querySelectorAll('#cardsContainer .rank-num')].map((n) => n.textContent)).toEqual([
        '1',
        '2',
      ]);
      // Watch still acts on the locator the card shows.
      expect(document.querySelector('#cardsContainer .watch-btn').getAttribute('data-index')).toBe('1');
    });

    it('collapses a long locator behind "Show full locator", and copy includes any helper', () => {
      setOut('selenium', 'typescript');
      const real = LLCodegen.locatorSnippet;
      LLCodegen.locatorSnippet = () => ({ expr: 'x'.repeat(400), helpers: 'function helper() {}' });
      try {
        renderResults({ elementData: { tag: 'input' }, locators: [role], avoidList: [], a11y: [] });
      } finally {
        LLCodegen.locatorSnippet = real;
      }
      const code = document.querySelector('#cardsContainer .code-txt');
      const btn = document.querySelector('#cardsContainer .code-expand');
      expect(code.classList.contains('code-long')).toBe(true);
      expect(btn.textContent).toBe('Show full locator');
      toggleLongCode(btn);
      expect(code.classList.contains('code-long')).toBe(false);
      expect(btn.getAttribute('aria-expanded')).toBe('true');
      toggleLongCode(btn);
      expect(code.classList.contains('code-long')).toBe(true);
      const copy = document.querySelector('#cardsContainer .copy-btn').getAttribute('data-code');
      expect(copy.startsWith('function helper() {}')).toBe(true);
      expect(document.querySelector('#cardsContainer .code-note')).not.toBeNull();
    });
  });

  it('escapes an unknown stability and a non-numeric rank instead of rendering them as markup', () => {
    renderResults({
      elementData: { tag: 'button' },
      locators: [
        {
          rank: '<img src="https://evil.test/r">',
          method: 'getByRole()',
          stability: '<img src="https://evil.test/s">',
          code: "page.getByRole('button')",
          target: { kind: 'role', role: 'button' },
        },
      ],
      avoidList: [],
      a11y: [],
    });
    const cards = document.getElementById('cardsContainer');
    expect(cards.querySelector('img')).toBeNull();
    expect(cards.textContent).toContain('<img src="https://evil.test/s">');
    expect(cards.textContent).toContain('<img src="https://evil.test/r">');
  });

  it('does not throw on a payload missing every optional array', () => {
    // A result restored from storage can predate the current shape. One missing
    // array used to throw out of the render, leaving the panel unusable.
    expect(() => renderResults({ elementData: { tag: 'div' } })).not.toThrow();
    expect(() => renderResults({})).not.toThrow();
    expect(document.getElementById('avoidContainer').style.display).toBe('none');
    expect(document.getElementById('a11yContainer').style.display).toBe('none');
  });

  it('ignores a null payload without wiping the last result', () => {
    renderResults({ elementData: { tag: 'div' }, locators: [], avoidList: [], a11y: [] });
    expect(() => renderResults(null)).not.toThrow();
  });
});

// The panel's own startup used to cancel the action that opened it. Clicking Start
// Inspecting makes the worker open the side panel; the panel then loaded and sent
// STOP_INSPECT as a "force reset", tearing down the overlay the click had just
// switched on. Inspecting from the popup therefore did nothing at all whenever the
// panel was not already open.
describe('panel startup', () => {
  /** The real markup, so the DOMContentLoaded wiring runs against what ships. */
  function mountRealPanel() {
    const html = readFileSync(join(ROOT, 'src/sidepanel.html'), 'utf8');
    const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
    document.body.innerHTML = (body ? body[1] : '').replace(/<script[\s\S]*?<\/script>/gi, '');
  }

  let sentTypes;
  beforeEach(() => {
    mountRealPanel();
    sentTypes = [];
    chrome.runtime.sendMessage = (msg) => {
      if (msg && msg.type) sentTypes.push(msg.type);
    };
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
  });

  it('never tells the worker to stop inspecting just because it opened', () => {
    expect(sentTypes).not.toContain('STOP_INSPECT');
  });

  it('asks for the live state instead of forcing one', () => {
    expect(sentTypes).toContain('GET_INSPECT_STATE');
    expect(sentTypes).toContain('GET_RECORDING_STATE');
  });

  it('renders the not-inspecting default while waiting for the answer', () => {
    expect(document.getElementById('btnText').textContent).toBe('Start Inspecting');
  });
});

// A reopened panel only learns "recording is live" from GET_RECORDING_STATE, which
// used to say nothing about a pause — so it always rendered the Pause button (i.e.
// "capture is live") even while the tab was genuinely paused, with no way back to
// Resume short of stopping the whole recording. background.js now reports a `paused`
// flag (see tests/background.test.mjs), and the panel must act on it.
describe('reopening mid-paused-recording', () => {
  function mountRealPanel() {
    const html = readFileSync(join(ROOT, 'src/sidepanel.html'), 'utf8');
    const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
    document.body.innerHTML = (body ? body[1] : '').replace(/<script[\s\S]*?<\/script>/gi, '');
  }

  it('shows Resume (not Pause) when the worker reports the recording as paused', () => {
    mountRealPanel();
    chrome.runtime.sendMessage = (msg, cb) => {
      if (msg && msg.type === 'GET_RECORDING_STATE' && cb) {
        cb({ active: true, anyTab: true, paused: true });
      }
    };
    document.dispatchEvent(new window.Event('DOMContentLoaded'));

    expect(document.getElementById('pauseRecordingBtn').style.display).toBe('none');
    expect(document.getElementById('resumeRecordingBtn').style.display).toBe('');
  });

  it('shows Pause when the worker reports the recording as live (not paused)', () => {
    mountRealPanel();
    chrome.runtime.sendMessage = (msg, cb) => {
      if (msg && msg.type === 'GET_RECORDING_STATE' && cb) {
        cb({ active: true, anyTab: true, paused: false });
      }
    };
    document.dispatchEvent(new window.Event('DOMContentLoaded'));

    expect(document.getElementById('pauseRecordingBtn').style.display).toBe('');
    expect(document.getElementById('resumeRecordingBtn').style.display).toBe('none');
  });
});

// updateCodePreview() used to only protect a hand-edit while the editor had focus.
// Undo, Redo, remove-step, a framework/language switch, and a newly recorded action
// all call it too — any of them firing after the user clicked away silently discarded
// the edit and replaced it with fresh codegen output.
describe('preserving unsaved edits in the Generated Test Script', () => {
  function mountRealPanel() {
    const html = readFileSync(join(ROOT, 'src/sidepanel.html'), 'utf8');
    const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
    document.body.innerHTML = (body ? body[1] : '').replace(/<script[\s\S]*?<\/script>/gi, '');
  }

  beforeEach(() => {
    mountRealPanel();
    chrome.runtime.sendMessage = (msg, cb) => {
      if (cb) cb();
    };
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
    // sidepanel.js's top-level state (lastSyncedPreviewScript included) is shared
    // across every test in this file — reset it explicitly rather than relying on
    // whatever an earlier describe block happened to leave behind.
    lastSyncedPreviewScript = '';
    recordedActions = [{ action: 'click', target: { kind: 'id', value: 'go' }, code: "page.locator('#go')" }];
    updateCodePreview();
  });

  it('keeps a hand-edited script when a later trigger fires while the editor is not focused', () => {
    const ta = document.getElementById('codePreview');
    // A hand edit that no longer matches the last generated output — the DOM-level
    // equivalent of the user having typed something, regardless of focus.
    setPreviewCode(ta, lastSyncedPreviewScript + '\n// my custom assertion');
    expect(document.activeElement).not.toBe(ta);

    updateCodePreview(); // stands in for Undo / Redo / remove-step / a new action

    expect(getPreviewText(ta)).toContain('// my custom assertion');
  });

  it('still refreshes once the box matches what was last generated', () => {
    const firstScript = lastSyncedPreviewScript;
    recordedActions.push({
      action: 'click',
      target: { kind: 'id', value: 'submit' },
      code: "page.locator('#submit')",
    });

    updateCodePreview();

    expect(lastSyncedPreviewScript).not.toBe(firstScript);
    expect(getPreviewText(document.getElementById('codePreview'))).toBe(lastSyncedPreviewScript);
  });
});

// Undo/Redo always act on the true last action in the timeline, independent of the
// filter — which used to mean clicking Undo while filtered silently deleted an
// action that was never even shown, with the visible (filtered) rows unchanged, so
// there was no way to tell anything had happened at all.
describe('undo/redo clears an active timeline filter so the change is visible', () => {
  function mountRealPanel() {
    const html = readFileSync(join(ROOT, 'src/sidepanel.html'), 'utf8');
    const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
    document.body.innerHTML = (body ? body[1] : '').replace(/<script[\s\S]*?<\/script>/gi, '');
  }

  beforeEach(() => {
    mountRealPanel();
    chrome.runtime.sendMessage = (msg, cb) => {
      if (cb) cb();
    };
    document.dispatchEvent(new window.Event('DOMContentLoaded'));

    recRedoStack = [];
    seenActionKeys = new Set();
    recordedActions = [
      { action: 'click', target: { kind: 'id', value: 'a' }, code: "page.locator('#a')" },
      { action: 'fill', value: 'x', target: { kind: 'id', value: 'b' }, code: "page.locator('#b')" },
      { action: 'click', target: { kind: 'id', value: 'c' }, code: "page.locator('#c')" },
    ];
    renderTimeline();
  });

  it('removes the true last action and drops the filter that was hiding it', () => {
    const filterInput = document.getElementById('recFilterInput');
    filterInput.value = 'fill';
    recFilter = 'fill';
    renderTimeline();
    expect(document.getElementById('recorderTimeline').textContent).not.toContain('#c');

    document.getElementById('undoActionBtn').click();

    // The true last action (the "c" click, never shown under the filter) is gone...
    expect(recordedActions.map((a) => a.target.value)).toEqual(['a', 'b']);
    // ...and the filter was cleared so the timeline actually reflects that removal
    // instead of looking untouched.
    expect(recFilter).toBe('');
    expect(filterInput.value).toBe('');
    expect(document.getElementById('recorderTimeline').textContent).toContain('#b');
  });
});
