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
