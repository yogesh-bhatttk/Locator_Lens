// @vitest-environment jsdom
//
// CSS generated content (::before / ::after, and `content: url() / "alt"` on the
// element itself) is part of the accessible name — icon fonts, "*" required markers,
// "New" badges. jsdom has no pseudo-element styles, so the engine skips them there
// (IS_JSDOM); this suite loads the engine as if in a real browser and replays the
// computed styles Chromium reports for each fixture.
//
// Every row's `computed` values are what Chromium's getComputedStyle(el, pseudo)
// returned for the CSS in the row's comment, and `expected` is the name Playwright
// 1.59.1 computed for the same page (ariaSnapshot / getByRole(…, { name, exact })).
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** element → { '::before'?, '::after'?, self? } computed values to replay. */
const replay = new Map();
const realGetComputedStyle = window.getComputedStyle;

let E;
beforeAll(() => {
  // Not jsdom as far as the engine can tell, so it asks for pseudo-element styles.
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    get: () => 'Mozilla/5.0 Chrome/140.0.0.0',
  });
  window.getComputedStyle = function (el, pseudo) {
    const rec = replay.get(el);
    if (pseudo) {
      // No rule: Chromium reports content "none" for a pseudo-element.
      return { content: 'none', display: 'inline', visibility: 'visible', ...rec?.[pseudo] };
    }
    const style = realGetComputedStyle.call(window, el);
    if (!rec?.self) return style;
    return new Proxy(style, { get: (target, key) => (key in rec.self ? rec.self[key] : target[key]) });
  };
  vm.runInThisContext(readFileSync(join(ROOT, 'src/content-locator-engine.js'), 'utf8'), {
    filename: 'src/content-locator-engine.js',
  });
  E = globalThis.__LocatorLensEngine;
});

afterAll(() => {
  window.getComputedStyle = realGetComputedStyle;
  delete navigator.userAgent; // back to the prototype's jsdom getter
});

beforeEach(() => {
  document.body.innerHTML = '';
  replay.clear();
});

/** Render, attach the replayed computed styles (keyed by selector), return #subject. */
function render(html, computed) {
  document.body.innerHTML = html;
  for (const [selector, rec] of Object.entries(computed)) replay.set(document.querySelector(selector), rec);
  return document.getElementById('subject');
}

const inline = (content) => ({ content, display: 'inline', visibility: 'visible' });

describe('pseudo-element content in the accessible name', () => {
  const CASES = [
    // #subject::before { content: "\2605  " }
    [
      'icon glyph before',
      '<button id="subject">Star</button>',
      { '#subject': { '::before': inline('"★ "') } },
      '★ Star',
    ],
    // label::after { content: " *" } — the required marker reaches the input's name.
    [
      'marker after a label',
      '<label for="subject">Email</label><input id="subject">',
      { label: { '::after': inline('" *"') } },
      'Email *',
    ],
    // Chromium resolves attr() itself: content: attr(data-icon) " " → "Plus "
    [
      'resolved attr()',
      '<button id="subject" data-icon="Plus">Add</button>',
      { '#subject': { '::before': inline('"Plus "') } },
      'Plus Add',
    ],
    // Other engines (Firefox) report attr() unresolved; Playwright reads the attribute.
    [
      'unresolved attr()',
      '<button id="subject" data-icon="Plus">Add</button>',
      { '#subject': { '::before': inline('attr(data-icon) " "') } },
      'Plus Add',
    ],
    [
      'unresolved attr() of a missing attribute',
      '<button id="subject">Add</button>',
      { '#subject': { '::before': inline('attr(data-nope)') } },
      'Add',
    ],
    // content: url(x.png) / "Alt icon" — the alternative text after "/" is used.
    [
      'alt text after a slash',
      '<button id="subject">Go</button>',
      { '#subject': { '::before': inline('url("x.png") / "Alt icon"') } },
      'Alt iconGo',
    ],
    [
      'empty alt text hides the visible string',
      '<button id="subject">Go</button>',
      { '#subject': { '::before': inline('"Visible" / ""') } },
      'Go',
    ],
    [
      'only the part after the first slash',
      '<button id="subject">z</button>',
      { '#subject': { '::before': inline('"a" / "b" "c"') } },
      'bcz',
    ],
    // Anything that is not a string or attr() makes the whole value unusable.
    [
      'counter()',
      '<button id="subject">Item</button>',
      { '#subject': { '::before': inline('counter(item) ". "') } },
      'Item',
    ],
    [
      'open-quote',
      '<button id="subject">Q</button>',
      { '#subject': { '::before': inline('open-quote') } },
      'Q',
    ],
    // A block-level pseudo-element is separated by spaces; an inline one is glued on.
    [
      'block pseudo-elements',
      '<button id="subject">Mid</button>',
      {
        '#subject': {
          '::before': { ...inline('"Pre"'), display: 'block' },
          '::after': { ...inline('"Post"'), display: 'block' },
        },
      },
      'Pre Mid Post',
    ],
    [
      'inline pseudo-elements',
      '<button id="subject">Mid</button>',
      { '#subject': { '::before': inline('"Pre"'), '::after': inline('"Post"') } },
      'PreMidPost',
    ],
    [
      'empty block pseudo-element',
      '<button id="subject">E</button>',
      { '#subject': { '::before': { ...inline('""'), display: 'block' } } },
      'E',
    ],
    [
      'visibility:hidden pseudo-element',
      '<button id="subject">Shown</button>',
      { '#subject': { '::after': { ...inline('"Hidden"'), visibility: 'hidden' } } },
      'Shown',
    ],
    [
      'display:none pseudo-element',
      '<button id="subject">Shown</button>',
      { '#subject': { '::after': { ...inline('"Gone"'), display: 'none' } } },
      'Shown',
    ],
    // Escapes in the serialised CSS string.
    [
      'escaped quotes',
      '<button id="subject">now</button>',
      { '#subject': { '::before': inline('"say \\"hi\\" "') } },
      'say "hi" now',
    ],
    [
      'escaped backslash',
      '<button id="subject">c</button>',
      { '#subject': { '::before': inline('"a\\\\b "') } },
      'a\\b c',
    ],
    [
      'hex escape',
      '<button id="subject">d</button>',
      { '#subject': { '::before': inline('"\\41 BC "') } },
      'ABC d',
    ],
    [
      'single-quoted string',
      '<button id="subject">q</button>',
      { '#subject': { '::before': inline("'single '") } },
      'single q',
    ],
    // A descendant's pseudo-element contributes to the ancestor's name.
    [
      'descendant pseudo-element',
      '<button id="subject"><span class="ic"></span>Text</button>',
      { '.ic': { '::before': inline('"Icon "') } },
      'Icon Text',
    ],
  ];

  it.each(CASES)('%s', (_label, html, computed, expected) => {
    const el = render(html, computed);
    expect(E.getAccessibleName(el)).toBe(expected);
    // The getByRole card built during a full analysis uses the same name.
    const card = E.generateLocators(el, []).locators.find((l) => l.target.kind === 'role');
    expect(card.target.name).toBe(expected);
  });
});

describe('`content` on the element itself', () => {
  it('uses the alternative text of `content: url() / "alt"` instead of the children', () => {
    // #subject { content: url(x.png) / "Self alt" } on <div role="button">Kids</div>
    const el = render('<div id="subject" role="button">Kids</div>', {
      '#subject': { self: { content: 'url("x.png") / "Self alt"' } },
    });
    expect(E.getAccessibleName(el)).toBe('Self alt');
  });

  it('uses a descendant’s replaced-content alternative text', () => {
    const el = render('<button id="subject"><span class="c">kid</span> tail</button>', {
      '.c': { self: { content: 'url("x.png") / "Child alt"' } },
    });
    expect(E.getAccessibleName(el)).toBe('Child alt tail');
  });

  it('ignores a plain string `content` on a real element (only pseudo-elements use it)', () => {
    const el = render('<div id="subject" role="button">Kids</div>', {
      '#subject': { self: { content: '"Self string"' } },
    });
    expect(E.getAccessibleName(el)).toBe('Kids');
  });

  it('does not name a role that takes no name from content', () => {
    // role=img: Playwright's ariaSnapshot shows a bare `- img`.
    const el = render('<div id="subject" role="img"></div>', {
      '#subject': { self: { content: 'url("x.png") / "Self alt"' } },
    });
    expect(E.getAccessibleName(el)).toBeNull();
  });
});
