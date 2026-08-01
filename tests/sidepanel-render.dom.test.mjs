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
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

beforeAll(() => {
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
