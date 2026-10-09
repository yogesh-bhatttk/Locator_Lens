// @vitest-environment jsdom
//
// Role resolution and accessibility-tree visibility in the locator engine, pinned
// against Playwright itself. Every `pw-verified` table below was checked row by row
// against Playwright 1.59.1 in Chromium (page.getByRole(role, { includeHidden }) for
// roles, locator.count() for counts) — the engine claims to be a port of Playwright's
// role table, so Playwright, not the engine's current output, is the expected value.
// A row that disagrees with Playwright is an engine bug, not a test to update.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let E;
beforeAll(() => {
  // Loaded as a classic script, like the browser (and content-script.dom.test.mjs) does.
  vm.runInThisContext(readFileSync(join(ROOT, 'src/content-locator-engine.js'), 'utf8'), {
    filename: 'src/content-locator-engine.js',
  });
  E = globalThis.__LocatorLensEngine;
});

beforeEach(() => {
  document.body.innerHTML = '';
});

/** Find the first element matching `selector` in the document or any open shadow root. */
function deepFind(selector) {
  const roots = [document];
  for (const root of roots) {
    const hit = root.querySelector(selector);
    if (hit) return hit;
    root.querySelectorAll('*').forEach((e) => e.shadowRoot && roots.push(e.shadowRoot));
  }
  return null;
}

/** Render markup (plus optional open shadow roots) and return the subject element. */
function render(html, opts = {}) {
  document.body.innerHTML = html;
  for (const [host, inner] of opts.shadow ?? [])
    deepFind(host).attachShadow({ mode: 'open' }).innerHTML = inner;
  return deepFind(opts.subject ?? '#subject');
}

const role = (r, name, o = {}) => ({ kind: 'role', role: r, ...(name != null ? { name } : {}), ...o });
const byText = (value, o = {}) => ({ kind: 'text', value, ...o });

describe('implicit roles for every tag in the table', () => {
  // pw-verified:roles
  const IMPLICIT = [
    ['<map name="m"><area id="subject" href="#a" alt="Map area"></map>', 'link'],
    ['<map name="m"><area id="subject" alt="Map area"></map>', null],
    ['<blockquote id="subject">q</blockquote>', 'blockquote'],
    ['<table><caption id="subject">Cap</caption><tr><td>x</td></tr></table>', 'caption'],
    ['<code id="subject">x</code>', 'code'],
    ['<datalist id="subject"><option value="a"></option></datalist>', 'listbox'],
    ['<dl><dt>T</dt><dd id="subject">D</dd></dl>', 'definition'],
    ['<dl><dt id="subject">T</dt><dd>D</dd></dl>', 'term'],
    ['<del id="subject">x</del>', 'deletion'],
    ['<ins id="subject">x</ins>', 'insertion'],
    ['<details id="subject" open><summary>S</summary>b</details>', 'group'],
    ['<dfn id="subject">x</dfn>', 'term'],
    ['<em id="subject">x</em>', 'emphasis'],
    ['<fieldset id="subject"><legend>Legend text</legend><input></fieldset>', 'group'],
    ['<figure id="subject"><img alt="a"><figcaption>Fig caption</figcaption></figure>', 'figure'],
    ['<hr id="subject">', 'separator'],
    ['<p>x</p>', 'document', { subject: 'html' }],
    ['<mark id="subject">x</mark>', 'mark'],
    ['<math id="subject"><mi>x</mi></math>', 'math'],
    ['<menu id="subject"><li>a</li></menu>', 'list'],
    ['<meter id="subject" value="0.5" aria-label="Load"></meter>', 'meter'],
    ['<select><optgroup id="subject" label="Grp"><option>a</option></optgroup></select>', 'group'],
    ['<select><option id="subject">Opt A</option></select>', 'option'],
    ['<output id="subject">5</output>', 'status'],
    ['<p id="subject">para</p>', 'paragraph'],
    ['<progress id="subject" value="3" max="10" aria-label="Upload"></progress>', 'progressbar'],
    ['<search id="subject"><input></search>', 'search'],
    ['<select id="subject" multiple><option>a</option></select>', 'listbox'],
    ['<select id="subject" size="3"><option>a</option></select>', 'listbox'],
    ['<strong id="subject">x</strong>', 'strong'],
    ['<sub id="subject">x</sub>', 'subscript'],
    ['<sup id="subject">x</sup>', 'superscript'],
    ['<svg id="subject" aria-label="Logo"></svg>', 'img'],
    ['<table><tbody id="subject"><tr><td>x</td></tr></tbody></table>', 'rowgroup'],
    ['<table><thead id="subject"><tr><th>x</th></tr></thead></table>', 'rowgroup'],
    ['<table><tfoot id="subject"><tr><td>x</td></tr></tfoot></table>', 'rowgroup'],
    ['<time id="subject">noon</time>', 'time'],
    ['<table role="grid"><tr><td id="subject">x</td></tr></table>', 'gridcell'],
    ['<table role="treegrid"><tr><td id="subject">x</td></tr></table>', 'gridcell'],
  ];
  // end pw-verified

  it.each(IMPLICIT)('%s → %s', (html, expected, opts) => {
    expect(E.getRole(render(html, opts))).toBe(expected);
  });
});

describe('landmarks that depend on context or a name', () => {
  // pw-verified:roles
  const LANDMARKS = [
    ['<article><footer id="subject">f</footer></article>', null],
    ['<section><header id="subject">h</header></section>', null],
    ['<div role="main"><header id="subject">h</header></div>', null],
    ['<nav><footer id="subject">f</footer></nav>', null],
    ['<div><footer id="subject">f</footer></div>', 'contentinfo'],
    // The sectioning ancestor is found across the shadow boundary, as Playwright does.
    [
      '<article><x-wrap id="host"></x-wrap></article>',
      null,
      { shadow: [['#host', '<header id="subject">h</header>']] },
    ],
    [
      '<div><x-wrap id="host"></x-wrap></div>',
      'banner',
      { shadow: [['#host', '<header id="subject">h</header>']] },
    ],
    ['<form id="subject"><input></form>', null],
    ['<span id="fl">Signup</span><form id="subject" aria-labelledby="fl"><input></form>', 'form'],
    ['<section id="subject">x</section>', null],
    ['<span id="sl">News</span><section id="subject" aria-labelledby="sl">x</section>', 'region'],
  ];
  // end pw-verified

  it.each(LANDMARKS)('%s → %s', (html, expected, opts) => {
    expect(E.getRole(render(html, opts))).toBe(expected);
  });
});

describe('<th> header heuristics', () => {
  // pw-verified:roles
  const TH = [
    [
      '<table><tr><th id="subject" scope="col">H</th><th>I</th></tr><tr><td>1</td><td>2</td></tr></table>',
      'columnheader',
    ],
    ['<table><tr><th id="subject" scope="colgroup">H</th></tr><tr><td>1</td></tr></table>', 'columnheader'],
    ['<table><tr><th id="subject" scope="row">H</th><td>1</td></tr></table>', 'rowheader'],
    ['<table><tr><th id="subject" scope="rowgroup">H</th><td>1</td></tr></table>', 'rowheader'],
    // A lone <th> in a one-row table is not a header of anything.
    ['<table><tr><th id="subject">H</th></tr></table>', null],
    [
      '<table><tr><th>A</th><th id="subject">B</th><th>C</th></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>',
      'columnheader',
    ],
    [
      '<table><tr><th id="subject">A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>',
      'columnheader',
    ],
    [
      '<table><tr><th id="subject">Name</th><td>Ada</td></tr><tr><th>Age</th><td>36</td></tr></table>',
      'rowheader',
    ],
    [
      '<table><tr><td>Ada</td><th id="subject">Name</th></tr><tr><td>x</td><td>y</td></tr></table>',
      'rowheader',
    ],
    // An empty neighbouring cell does not make it a row header…
    [
      '<table><tr><th id="subject">Name</th><td></td></tr><tr><td>x</td><td>y</td></tr></table>',
      'columnheader',
    ],
    // …but a cell with element content (even without text) does.
    [
      '<table><tr><th id="subject">Name</th><td><img alt=""></td></tr><tr><td>x</td><td>y</td></tr></table>',
      'rowheader',
    ],
  ];
  // end pw-verified

  it.each(TH)('%s → %s', (html, expected) => {
    expect(E.getRole(render(html))).toBe(expected);
  });
});

describe('<input> and <img> roles', () => {
  // pw-verified:roles
  const INPUTS = [
    ['<input id="subject" type="hidden" value="x">', null],
    ['<input id="subject" type="file">', 'button'],
    ['<input id="subject" type="image" alt="Go">', 'button'],
    ['<input id="subject" type="color">', 'textbox'],
    ['<input id="subject" type="date">', 'textbox'],
    ['<input id="subject" type="bogus">', 'textbox'],
    ['<input id="subject" type="search" list="dl"><datalist id="dl"></datalist>', 'combobox'],
    ['<input id="subject" list="dl2"><datalist id="dl2"></datalist>', 'combobox'],
    // list= only makes a combobox when it points at a <datalist>.
    ['<input id="subject" list="dl3"><div id="dl3"></div>', 'textbox'],
    ['<input id="subject" list="nope">', 'textbox'],
    ['<img id="subject" alt="">', 'presentation'],
    ['<img id="subject" alt="" title="t">', 'img'],
    ['<img id="subject" alt="" aria-describedby="x">', 'img'],
    ['<img id="subject" alt="" tabindex="-1">', 'img'],
    ['<img id="subject">', 'img'],
  ];
  // end pw-verified

  it.each(INPUTS)('%s → %s', (html, expected) => {
    expect(E.getRole(render(html))).toBe(expected);
  });
});

describe('explicit roles and presentational-role conflict resolution', () => {
  // pw-verified:roles
  const EXPLICIT = [
    // The first *valid* token wins; unknown tokens are skipped, not adopted.
    ['<div id="subject" role="foo  link">x</div>', 'link'],
    ['<div id="subject" role="foo bar">x</div>', null],
    ['<button id="subject" role="bogus">x</button>', 'button'],
    // role=none/presentation is ignored on a focusable element…
    ['<button id="subject" role="presentation">X</button>', 'button'],
    ['<a id="subject" role="none" href="#">x</a>', 'link'],
    ['<input id="subject" role="none">', 'textbox'],
    ['<select id="subject" role="none"></select>', 'combobox'],
    ['<div id="subject" role="none" tabindex="0">x</div>', null],
    // …but honoured when the element cannot take focus.
    ['<button id="subject" role="presentation" disabled>X</button>', 'presentation'],
    ['<input id="subject" role="none" disabled>', 'none'],
    ['<fieldset disabled><button id="subject" role="none">x</button></fieldset>', 'none'],
    ['<a id="subject" role="none">x</a>', 'none'],
    ['<div id="subject" role="none" tabindex="abc">x</div>', 'none'],
    // A global ARIA attribute also cancels it — unless that attribute is prohibited
    // on the element's implicit role (aria-label on a paragraph).
    ['<h1 id="subject" role="none" aria-describedby="d">x</h1>', 'heading'],
    ['<h1 id="subject" role="none" aria-label="L">x</h1>', 'heading'],
    ['<p id="subject" role="presentation" aria-label="L">x</p>', 'presentation'],
  ];
  // end pw-verified

  it.each(EXPLICIT)('%s → %s', (html, expected) => {
    expect(E.getRole(render(html))).toBe(expected);
  });

  // pw-verified:roles
  const INHERITED = [
    ['<ul role="presentation"><li id="subject">x</li></ul>', 'presentation'],
    ['<ul role="none" tabindex="0"><li id="subject">x</li></ul>', 'listitem'],
    ['<ul role="none" aria-busy="true"><li id="subject">x</li></ul>', 'listitem'],
    ['<table role="presentation"><tbody><tr><td id="subject">x</td></tr></tbody></table>', 'presentation'],
    ['<table role="presentation"><tr id="subject"><td>x</td></tr></table>', 'presentation'],
    ['<dl role="presentation"><dt>t</dt><dd id="subject">x</dd></dl>', 'presentation'],
    ['<dl role="presentation"><div><dt id="subject">t</dt></div></dl>', 'presentation'],
    ['<dl><div role="presentation"><dt id="subject">t</dt></div></dl>', 'presentation'],
    ['<ol><li id="subject">x</li></ol>', 'listitem'],
    // Only the required owner passes it down: a presentational <div> around an <li> does not.
    ['<div role="presentation"><li id="subject">x</li></div>', 'listitem'],
  ];
  // end pw-verified

  it.each(INHERITED)('presentation inherited from the required owner: %s → %s', (html, expected) => {
    expect(E.getRole(render(html))).toBe(expected);
  });

  it('returns null for anything that is not an element', () => {
    document.body.innerHTML = 'just text';
    expect(E.getRole(document.body.firstChild)).toBeNull();
    expect(E.getRole(null)).toBeNull();
  });
});

describe('isHiddenForAria: what getByRole() skips', () => {
  // pw-verified:counts
  const HIDDEN = [
    // display:contents is hidden only when it has nothing visible inside.
    ...[
      [role('navigation'), 2],
      [role('navigation', 'Main'), 1],
      [role('navigation', 'Empty'), 0],
      [role('navigation', 'Ws'), 0],
      [role('navigation', 'Txt'), 1],
      [role('navigation', 'HidKid'), 0],
    ].map(([t, n]) => [
      '<div><nav style="display:contents" aria-label="Main"><a href="#">A</a></nav></div>' +
        '<div><nav style="display:contents" aria-label="Empty"></nav></div>' +
        '<div><nav style="display:contents" aria-label="Ws">   </nav></div>' +
        '<div><nav style="display:contents" aria-label="Txt">hello</nav></div>' +
        '<div><nav style="display:contents" aria-label="HidKid"><span hidden>x</span></nav></div>',
      t,
      n,
    ]),
    [
      '<button style="display:contents">Contents btn</button><button style="display:contents"></button>',
      role('button'),
      1,
    ],
    [
      '<div><nav style="display:contents" aria-label="ScriptOnly"><script>1</script></nav></div>',
      role('navigation'),
      0,
    ],
    [
      '<div><nav style="display:contents" aria-label="CommentOnly"><!-- c --></nav></div>',
      role('navigation'),
      0,
    ],
    // A light-DOM child of a shadow host that no <slot> renders is not in the tree.
    [
      '<div id="h"><button>Unassigned</button></div><div id="h2"><button>Assigned</button></div>',
      role('button'),
      1,
      {
        shadow: [
          ['#h', '<p>no slot</p>'],
          ['#h2', '<slot></slot>'],
        ],
      },
    ],
    [
      '<div id="h"><button>Unassigned</button></div>',
      role('button', 'Unassigned'),
      0,
      { shadow: [['#h', '<p>no slot</p>']] },
    ],
    // …though getByText (not an a11y-tree query) still finds it.
    [
      '<div id="h"><button>Unassigned</button></div>',
      byText('Unassigned'),
      1,
      { shadow: [['#h', '<p>no slot</p>']] },
    ],
    // Closed <details>: only the <summary> is rendered.
    [
      '<details><summary>Sum</summary><button>Inside</button><p><a href="#">Deep</a></p></details>',
      role('button', 'Inside', { exact: true }),
      0,
    ],
    [
      '<details><summary>Sum</summary><button>Inside</button><p><a href="#">Deep</a></p></details>',
      role('link', 'Deep'),
      0,
    ],
    [
      '<details><summary><button>In summary</button></summary><p>body</p></details>',
      role('button', 'In summary'),
      1,
    ],
    [
      '<details open><summary>S2</summary><button>Open inside</button></details>',
      role('button', 'Open inside'),
      1,
    ],
    ['<details><summary>Sum</summary><button>Inside</button></details>', byText('Inside'), 1],
    // visibility is inherited but can be overridden by a descendant.
    [
      '<button style="visibility:hidden">V1</button><div style="visibility:hidden"><button style="visibility:visible">V2</button></div><button style="visibility:collapse">V3</button>',
      role('button'),
      1,
    ],
    [
      '<div style="visibility:hidden"><button style="visibility:visible">V2</button></div>',
      role('button', 'V2'),
      1,
    ],
    // An <option> inside a <select> is exempt from the visibility check; an ARIA option is not.
    [
      '<select><option>A</option><option style="visibility:hidden">B</option></select>',
      role('option', 'B'),
      1,
    ],
    [
      '<div role="listbox"><div role="option" style="visibility:hidden">C</div></div>',
      role('option', 'C'),
      0,
    ],
    // aria-hidden is case-insensitive and only "true" hides.
    [
      '<div aria-hidden="false"><button>F</button></div><div aria-hidden="TRUE"><button>T</button></div>',
      role('button'),
      1,
    ],
    ['<div aria-hidden="TRUE"><button>T</button></div>', role('button', 'T'), 0],
    ['<template><button>Tpl</button></template><button>Real</button>', role('button'), 1],
    [
      '<style>.gone{display:none}</style><div class="gone"><button>Css hidden</button></div><button>Shown</button>',
      role('button'),
      1,
    ],
    [
      '<style>.gone{display:none}</style><div class="gone"><button>Css hidden</button></div>',
      byText('Css hidden'),
      1,
    ],
    // display:none on a shadow host hides everything inside its shadow root.
    [
      '<div id="h3" style="display:none"></div><div id="h4"></div>',
      role('button'),
      1,
      {
        shadow: [
          ['#h3', '<button>In hidden host</button>'],
          ['#h4', '<button>In shown host</button>'],
        ],
      },
    ],
    [
      '<div id="h3" style="display:none"></div>',
      role('button', 'In hidden host'),
      0,
      { shadow: [['#h3', '<button>In hidden host</button>']] },
    ],
  ];
  // end pw-verified

  it.each(HIDDEN)('%s %j → %i', (html, target, count, opts) => {
    render(html, opts);
    expect(E.countTargetMatches(target)).toBe(count);
  });
});

describe('isHiddenForAria with Element.checkVisibility (as in Chromium)', () => {
  // jsdom lacks checkVisibility, so the engine falls back to a <details> walk there.
  // Chromium has it, and Playwright trusts it; these stub it the way Chromium answers.
  const proto = window.Element.prototype;
  function withCheckVisibility(impl, fn) {
    proto.checkVisibility = impl;
    try {
      return fn();
    } finally {
      delete proto.checkVisibility;
    }
  }

  it('hides what checkVisibility() reports invisible', () => {
    render('<details><summary>Sum</summary><button>Inside</button></details><button>Outside</button>');
    const closedDetailsContent = function () {
      const d = this.closest('details');
      return !d || d.open || this.closest('summary') !== null || this === d;
    };
    // Same counts Playwright gives in Chromium for this markup.
    expect(withCheckVisibility(closedDetailsContent, () => E.countTargetMatches(role('button')))).toBe(1);
    expect(
      withCheckVisibility(closedDetailsContent, () => E.countTargetMatches(role('button', 'Inside')))
    ).toBe(0);
  });

  it('falls back to the visibility style when checkVisibility() throws', () => {
    render('<button>One</button><button style="visibility:hidden">Two</button>');
    const throwing = () => {
      throw new Error('not supported here');
    };
    expect(withCheckVisibility(throwing, () => E.countTargetMatches(role('button')))).toBe(1);
  });
});

describe('<th> outside a table row', () => {
  // Built with DOM calls (the HTML parser would drop a stray <th>). Playwright in
  // Chromium, same construction: getByRole('columnheader', { name: 'Loose' }) and
  // getByRole('rowheader', { name: 'Pair' }) both count 1.
  it('is a column header on its own and a row header next to a filled cell', () => {
    const loose = document.body
      .appendChild(document.createElement('div'))
      .appendChild(document.createElement('th'));
    loose.textContent = 'Loose';
    const pairRow = document.body.appendChild(document.createElement('div'));
    const pair = pairRow.appendChild(document.createElement('th'));
    pair.textContent = 'Pair';
    pairRow.appendChild(document.createElement('td')).textContent = 'v';
    expect(E.getRole(loose)).toBe('columnheader');
    expect(E.getRole(pair)).toBe('rowheader');
    expect(E.countTargetMatches(role('columnheader', 'Loose'))).toBe(1);
    expect(E.countTargetMatches(role('rowheader', 'Pair'))).toBe(1);
  });
});

describe('heading and aria-level', () => {
  const TITLES =
    '<h1>Title</h1><h2>Title</h2><div role="heading" aria-level="2">Title</div><div role="heading">Title</div>' +
    '<div role="heading" aria-level="0">Title</div><div role="heading" aria-level="2.5">Title</div>' +
    '<div role="heading" aria-level="x">Title</div><h3 aria-level="2">Title</h3>';
  // pw-verified:counts
  const LEVELS = [
    [TITLES, role('heading', 'Title', { level: 1 }), 1],
    // A native <hN> level beats aria-level; invalid/zero/fractional aria-level is no level.
    [TITLES, role('heading', 'Title', { level: 2 }), 2],
    [TITLES, role('heading', 'Title', { level: 3 }), 1],
    [TITLES, role('heading', 'Title'), 8],
    // aria-level also applies to listitem and treeitem.
    ['<ul><li aria-level="2">a</li></ul><ul><li>b</li></ul>', role('listitem', null, { level: 2 }), 1],
    ['<div role="treeitem" aria-level="3">t</div>', role('treeitem', null, { level: 3 }), 1],
  ];
  // end pw-verified

  it.each(LEVELS)('%s %j → %i', (html, target, count) => {
    render(html);
    expect(E.countTargetMatches(target)).toBe(count);
  });

  it('puts the heading level into the generated getByRole locator', () => {
    const el = render('<h2>Intro</h2><h3 id="subject">Intro</h3>');
    const r = E.generateLocators(el, []);
    const byRole = r.locators.find((l) => l.target.kind === 'role');
    // Verified in Playwright: getByRole('heading', { name: 'Intro', level: 3 }).count() === 1
    expect(byRole.code).toBe("page.getByRole('heading', { name: 'Intro', level: 3 })");
    expect(byRole.matchedAttr).toBe('role="heading", name="Intro" at level 3');
    expect(byRole.matchCount).toBe(1);
    expect(byRole.unique).toBe(true);
  });

  it('gives an ARIA heading without a valid aria-level no level option', () => {
    const el = render('<div id="subject" role="heading" aria-level="0">Solo</div>');
    const byRole = E.generateLocators(el, []).locators.find((l) => l.target.kind === 'role');
    expect(byRole.code).toBe("page.getByRole('heading', { name: 'Solo' })");
    expect(byRole.target.level).toBeNull();
  });
});

describe('role-only queries that scan every element', () => {
  // pw-verified:counts
  const SCANS = [
    // none/presentation have no candidate-tag list, so every element is checked.
    [
      '<div role="none">a</div><span role="presentation">b</span><button role="none">c</button><img alt="">',
      role('none'),
      1,
    ],
    [
      '<div role="none">a</div><span role="presentation">b</span><button role="none">c</button><img alt="">',
      role('presentation'),
      2,
    ],
    ['<div>plain</div>', role('generic'), 0],
    ['<div role="widget">x</div>', role('widget'), 0],
    [
      '<div id="h7"></div><button>Light</button>',
      role('button'),
      2,
      { shadow: [['#h7', '<button>Shadow btn</button>']] },
    ],
  ];
  // end pw-verified

  it.each(SCANS)('%s %j → %i', (html, target, count, opts) => {
    render(html, opts);
    expect(E.countTargetMatches(target)).toBe(count);
  });
});
