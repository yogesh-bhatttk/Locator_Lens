// @vitest-environment jsdom
//
// Accessible-name computation in the locator engine (the port of Playwright's
// getElementAccessibleName). getByRole('…', { name }) matches against exactly this
// string, so a name that differs from Playwright's turns into a locator that finds
// nothing. Every `pw-verified:names` row was checked against Playwright 1.59.1 in
// Chromium: page.getByRole(<role>, { name: <expected>, exact: true }) resolves to the
// subject element. Playwright is the expected value, not the engine's current output.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let E;
beforeAll(() => {
  vm.runInThisContext(readFileSync(join(ROOT, 'src/content-locator-engine.js'), 'utf8'), {
    filename: 'src/content-locator-engine.js',
  });
  E = globalThis.__LocatorLensEngine;
});

beforeEach(() => {
  document.body.innerHTML = '';
});

function deepFind(selector) {
  const roots = [document];
  for (const root of roots) {
    const hit = root.querySelector(selector);
    if (hit) return hit;
    root.querySelectorAll('*').forEach((e) => e.shadowRoot && roots.push(e.shadowRoot));
  }
  return null;
}

function render(html, opts = {}) {
  document.body.innerHTML = html;
  for (const [host, inner] of opts.shadow ?? [])
    deepFind(host).attachShadow({ mode: 'open' }).innerHTML = inner;
  return deepFind(opts.subject ?? '#subject');
}

/** The name the engine puts into a getByRole card (computed with the per-analysis caches). */
function roleCardName(el) {
  const card = E.generateLocators(el, []).locators.find((l) => l.target.kind === 'role');
  return card?.target.name ?? '';
}

describe('name from content', () => {
  // pw-verified:names
  const CONTENT = [
    // Block-level children are separated by a space; inline ones are glued together.
    ['<button id="subject"><div>Save</div><div>draft</div></button>', 'Save draft'],
    ['<button id="subject"><span>Sa</span><span>ve</span></button>', 'Save'],
    ['<a id="subject" href="#">Line<br>two</a>', 'Line two'],
    // Hidden descendants are left out — but only the hidden node itself.
    ['<button id="subject">Go <span style="display:none">secret</span>now</button>', 'Go now'],
    ['<button id="subject"><span aria-hidden="true">X</span>Close</button>', 'Close'],
    ['<button id="subject">A<span style="visibility:hidden">B</span>C</button>', 'AC'],
    ['<button id="subject">A<span hidden>B</span>C</button>', 'A C'],
    ['<button id="subject">A<script>var x=1</script><style>.x{}</style>B</button>', 'A B'],
    // Descendant alt / aria-label replace the descendant's own content.
    ['<a id="subject" href="#"><img alt="Home icon"> Home</a>', 'Home icon Home'],
    ['<button id="subject"><span aria-label="Delete item">🗑</span></button>', 'Delete item'],
    // Descendants with roles that allow content when nested contribute their text…
    ['<a id="subject" href="#"><ul><li>One</li><li>Two</li></ul></a>', 'One Two'],
    ['<a id="subject" href="#"><h3>Head</h3><p>para</p></a>', 'Head para'],
    ['<button id="subject"><span role="presentation">Pres</span> X</button>', 'Pres X'],
    ['<div id="subject" role="button">Outer <span role="button">Inner</span></div>', 'Outer Inner'],
    ['<div role="listbox"><div id="subject" role="option">Choice <b>one</b></div></div>', 'Choice one'],
    // …a group does not, unless it has its own aria-label or title.
    ['<button id="subject"><span role="group">Grp</span> X</button>', 'X'],
    ['<button id="subject"><span role="group" aria-label="G label">Grp</span> X</button>', 'G label X'],
    ['<button id="subject"><span role="group" title="G title"></span> X</button>', 'G title X'],
    // Zero-width space and soft hyphen are dropped by Playwright's normalisation.
    ['<button id="subject">Sa\u200bve\u00ad it</button>', 'Save it'],
    ['<button id="subject">Sa<!--x-->ve</button>', 'Save'],
    // Whitespace-only content falls through to title.
    ['<h2 id="subject">   </h2>', ''],
    ['<h2 id="subject" title="Fallback T">   </h2>', 'Fallback T'],
    ['<div id="subject" role="button" title="Div title"></div>', 'Div title'],
    ['<div id="subject" role="button" title="  "></div>', ''],
    ['<button id="subject" aria-label="   ">Text</button>', 'Text'],
  ];
  // end pw-verified

  it.each(CONTENT)('%s → %j', (html, expected) => {
    const el = render(html);
    expect(E.getAccessibleName(el) ?? '').toBe(expected);
    expect(roleCardName(el)).toBe(expected);
  });

  it('keeps the whole of a very long name (truncation is the locator card’s job)', () => {
    const words = Array(60).fill('word').join(' ');
    expect(E.getAccessibleName(render(`<button id="subject">${words} </button>`))).toBe(words);
  });

  // pw-verified:names
  const SHADOW = [
    // Slotted light-DOM content is read through the slot, in the shadow tree's order.
    [
      '<button id="subject"><x-a id="h">Light</x-a></button>',
      'Shadow Light',
      { shadow: [['#h', '<b>Shadow</b> <slot></slot>']] },
    ],
    [
      '<button id="subject"><x-b id="h2"></x-b></button>',
      'Inside shadow',
      { shadow: [['#h2', 'Inside shadow']] },
    ],
    [
      '<button id="subject"><x-c id="h3"></x-c></button>',
      'Fallback slot',
      { shadow: [['#h3', '<slot>Fallback slot</slot>']] },
    ],
  ];
  // end pw-verified

  it.each(SHADOW)('reads shadow content and slots: %s → %j', (html, expected, opts) => {
    expect(E.getAccessibleName(render(html, opts))).toBe(expected);
  });
});

describe('embedded controls contribute their value', () => {
  // pw-verified:names
  const EMBEDDED = [
    ['<div id="subject" role="checkbox">Remind me in <input value="5"> days</div>', 'Remind me in 5 days'],
    ['<div id="subject" role="link">Note <textarea>abc</textarea></div>', 'Note abc'],
    ['<div id="subject" role="button">Say <span role="textbox">hello</span></div>', 'Say hello'],
    [
      '<div id="subject" role="checkbox">Flavor <select><option>Vanilla</option><option selected>Mint</option></select></div>',
      'Flavor Mint',
    ],
    [
      '<div id="subject" role="checkbox">Pick <select multiple><option selected>A</option><option>B</option><option selected>C</option></select></div>',
      'Pick A C',
    ],
    // A <select> with nothing selected reads its first option.
    [
      '<div id="subject" role="checkbox">Pick <select multiple><option>A</option><option>B</option></select></div>',
      'Pick A',
    ],
    [
      '<div id="subject" role="checkbox">Color <div role="combobox"><div role="listbox"><div role="option" aria-selected="true">Red</div><div role="option">Blue</div></div></div></div>',
      'Color Red',
    ],
    ['<div id="subject" role="checkbox">Color <div role="combobox">typed</div></div>', 'Color'],
    [
      '<div id="subject" role="checkbox">Size <div role="listbox"><div role="option" aria-selected="true">L</div><div role="option" aria-selected="true">XL</div><div role="option">S</div></div></div>',
      'Size L XL',
    ],
    [
      '<div id="subject" role="checkbox">City <input list="cities" value="Paris"><datalist id="cities"><option value="Rome"></option></datalist></div>',
      'City Paris',
    ],
    [
      '<div id="subject" role="checkbox">Volume <input type="range" min="0" max="10" value="7"></div>',
      'Volume 7',
    ],
    [
      '<div id="subject" role="checkbox">Level <div role="slider" aria-valuetext="High" aria-valuenow="9"></div></div>',
      'Level High',
    ],
    ['<div id="subject" role="checkbox">Level <div role="slider" aria-valuenow="9"></div></div>', 'Level 9'],
    ['<div id="subject" role="checkbox">Qty <input type="number" value="3"></div>', 'Qty 3'],
    ['<div id="subject" role="checkbox">Done <progress value="40" max="100"></progress></div>', 'Done 40'],
    ['<div id="subject" role="checkbox">Disk <meter value="0.25"></meter></div>', 'Disk 0.25'],
    // Empty values contribute nothing.
    ['<div id="subject" role="checkbox">A <input> B</div>', 'A B'],
    [
      '<div id="subject" role="checkbox">Level <div role="slider" aria-valuetext="" aria-valuenow="9"></div></div>',
      'Level',
    ],
    ['<div id="subject" role="checkbox">Level <div role="slider" aria-valuenow=""></div></div>', 'Level'],
    ['<div id="subject" role="checkbox">M <div role="meter"></div></div>', 'M'],
    [
      '<div id="subject" role="button">Open <div role="menu"><div role="menuitem">Item</div></div></div>',
      'Open',
    ],
    // Inside a <label>, the labelled control itself is skipped but others' values count.
    ['<label>Remind me in <input id="subject" value="5"> days</label>', 'Remind me in days'],
    [
      '<span id="l1">Size <input value="12"> pt</span><button id="subject" aria-labelledby="l1">x</button>',
      'Size 12 pt',
    ],
  ];
  // end pw-verified

  it.each(EMBEDDED)('%s → %j', (html, expected) => {
    const el = render(html);
    expect(E.getAccessibleName(el)).toBe(expected);
    expect(roleCardName(el)).toBe(expected);
  });
});

describe('aria-labelledby', () => {
  // pw-verified:names
  const LABELLEDBY = [
    // Self-reference: the element's own content is used (not recursion into labelledby).
    [
      '<span id="l2">Delete</span><button id="subject" aria-labelledby="l2 subject">File.txt</button>',
      'Delete File.txt',
    ],
    ['<button id="subject" aria-labelledby="subject">Own text</button>', 'Own text'],
    // Hidden targets still name the element, including their hidden subtree…
    [
      '<span id="l3" hidden>Hidden label</span><button id="subject" aria-labelledby="l3">Visible</button>',
      'Hidden label',
    ],
    [
      '<div id="l4" style="display:none">Outer <span>inner</span></div><button id="subject" aria-labelledby="l4">V</button>',
      'Outer inner',
    ],
    // …but a hidden child of a *visible* target is skipped.
    [
      '<div id="l5">Shown <span hidden>gone</span></div><button id="subject" aria-labelledby="l5">V</button>',
      'Shown',
    ],
    ['<span id="l6">Once</span><button id="subject" aria-labelledby="l6 l6">V</button>', 'Once'],
    ['<span id="l7">Here</span><button id="subject" aria-labelledby="gone l7">V</button>', 'Here'],
    // An empty result falls through to aria-label.
    [
      '<span id="l8"></span><button id="subject" aria-labelledby="l8" aria-label="Fallback">V</button>',
      'Fallback',
    ],
    // aria-labelledby is not followed recursively; a target's aria-label is used.
    [
      '<span id="a1" aria-labelledby="a2">First</span><span id="a2">Second</span><button id="subject" aria-labelledby="a1">V</button>',
      'First',
    ],
    [
      '<span id="a3" aria-label="From label">ignored</span><button id="subject" aria-labelledby="a3">V</button>',
      'From label',
    ],
  ];
  // end pw-verified

  it.each(LABELLEDBY)('%s → %j', (html, expected) => {
    const el = render(html);
    expect(E.getAccessibleName(el)).toBe(expected);
    expect(roleCardName(el)).toBe(expected);
  });

  it('ignores aria-labelledby on a detached element (no root to resolve ids in)', () => {
    document.body.innerHTML = '<span id="ref">Referenced</span>';
    const btn = document.createElement('button');
    btn.setAttribute('aria-labelledby', 'ref');
    btn.textContent = 'Own';
    expect(E.getAccessibleName(btn)).toBe('Own');
  });
});

describe('native labelling: <label>, title, placeholder, alt, legend, caption', () => {
  // pw-verified:names
  const NATIVE = [
    [
      '<label for="subject">First</label><label for="subject">Second</label><input id="subject">',
      'First Second',
    ],
    ['<label>Wrap <input id="subject"></label><label for="subject">For</label>', 'Wrap For'],
    ['<label for="subject" style="display:none">Hidden lbl</label><input id="subject">', 'Hidden lbl'],
    [
      '<label for="subject">Email <span style="display:none">(secret)</span></label><input id="subject">',
      'Email',
    ],
    ['<label for="subject">Labelled btn</label><button id="subject">Inner</button>', 'Labelled btn'],
    ['<label for="subject">Total</label><output id="subject">5</output>', 'Total'],
    ['<output id="subject" title="Result">5</output>', 'Result'],
    ['<output id="subject">5</output>', ''],
    ['<label for="subject">Fuel</label><meter id="subject" value="0.5"></meter>', ''],
    ['<label for="subject">Country</label><select id="subject"><option>UK</option></select>', 'Country'],
    ['<label for="subject">Bio</label><textarea id="subject"></textarea>', 'Bio'],
    // A label pointing at a non-labelable element does nothing.
    ['<label for="subject">Nope</label><div id="subject" role="textbox"></div>', ''],
    ['<label for="subject">Upload CV</label><input id="subject" type="file">', 'Upload CV'],
    ['<input id="subject" type="file">', 'Choose File'],
    ['<label for="subject">Img label</label><input id="subject" type="image" alt="Alt">', 'Img label'],
    ['<input id="subject" type="image" alt="Go">', 'Go'],
    ['<input id="subject" type="image" title="Img title">', 'Img title'],
    ['<input id="subject" type="image">', 'Submit'],
    ['<input id="subject" type="button" title="Btn title">', 'Btn title'],
    ['<input id="subject" type="button">', ''],
    ['<input id="subject" type="reset">', 'Reset'],
    ['<input id="subject" type="submit" value="  ">', 'Submit'],
    // title beats placeholder; placeholder only for text-like inputs.
    ['<input id="subject" placeholder="Ph" title="Tt">', 'Tt'],
    ['<input id="subject" type="email" placeholder="you@x.com">', 'you@x.com'],
    ['<input id="subject" type="number" placeholder="Count">', ''],
    ['<input id="subject" type="number" title="Count title">', 'Count title'],
    ['<textarea id="subject" placeholder="Write here"></textarea>', 'Write here'],
    ['<select id="subject" title="Sel title"><option>a</option></select>', 'Sel title'],
    ['<fieldset id="subject"><legend>Legend text</legend><input></fieldset>', 'Legend text'],
    ['<fieldset id="subject" title="FS title"><input></fieldset>', 'FS title'],
    ['<fieldset id="subject"><div>x</div><legend>Late legend</legend></fieldset>', 'Late legend'],
    ['<figure id="subject"><img alt="a"><figcaption>Fig caption</figcaption></figure>', 'Fig caption'],
    ['<figure id="subject"><img alt="a"></figure>', ''],
    ['<table id="subject"><caption>Prices</caption><tr><td>1</td></tr></table>', 'Prices'],
    ['<table id="subject" summary="Sum"><tr><td>1</td></tr></table>', 'Sum'],
    ['<table id="subject" title="TT"><tr><td>1</td></tr></table>', 'TT'],
    [
      '<table id="subject"><caption style="display:none">Hidden cap</caption><tr><td>1</td></tr></table>',
      'Hidden cap',
    ],
    ['<img id="subject" title="Img title">', 'Img title'],
    ['<img id="subject" alt="  " title="T2">', 'T2'],
    ['<svg id="subject"><title>Chart title</title><circle r="1"></circle></svg>', 'Chart title'],
    ['<svg><g id="subject" role="img"><title>Group title</title></g></svg>', 'Group title'],
    ['<svg id="subject"><circle r="1"></circle></svg>', ''],
    ['<meter id="subject" value="0.5" aria-label="Load"></meter>', 'Load'],
    ['<section id="subject" aria-label="Sec"><p>x</p></section>', 'Sec'],
    // Roles that prohibit naming report no name at all.
    ['<p id="subject" aria-label="Para label">text</p>', ''],
    ['<ul id="subject" aria-label=""><li>a</li></ul>', ''],
  ];
  // end pw-verified

  it.each(NATIVE)('%s → %j', (html, expected) => {
    const el = render(html);
    expect(E.getAccessibleName(el) ?? '').toBe(expected);
    // Same answer from the full analysis, which resolves labels through its page-wide index.
    expect(roleCardName(el)).toBe(expected);
  });

  it('gives a hidden input no name even when a label points at it', () => {
    const el = render('<label for="subject">Token</label><input id="subject" type="hidden">');
    expect(E.getAccessibleName(el)).toBeNull();
    expect(E.generateLocators(el, []).locators.map((l) => l.target.kind)).toEqual(['id']);
  });

  it('names <summary> from its content unless it is presentational', () => {
    // Neither has an ARIA role in Playwright's table, so this is the engine's own
    // accname path; the content rule mirrors Playwright's SUMMARY special case.
    expect(
      E.getAccessibleName(render('<details open><summary id="subject">More <b>info</b></summary>x</details>'))
    ).toBe('More info');
    expect(
      E.getAccessibleName(render('<details open><summary id="subject" role="none">More</summary>x</details>'))
    ).toBeNull();
  });

  it('names an <iframe> and a generic <div> from title / aria-label', () => {
    expect(E.getAccessibleName(render('<iframe id="subject" title="Frame title"></iframe>'))).toBe(
      'Frame title'
    );
    // `generic` prohibits naming, but Playwright's role table has no implicit
    // generic for <div>, so its aria-label still names it.
    expect(E.getAccessibleName(render('<div id="subject" aria-label="Div label">text</div>'))).toBe(
      'Div label'
    );
  });

  it('returns null for things that are not elements', () => {
    document.body.innerHTML = 'text';
    expect(E.getAccessibleName(document.body.firstChild)).toBeNull();
    expect(E.getAccessibleName(null)).toBeNull();
  });

  it('names a detached control from the label it sits in during a full analysis', () => {
    // Detached nodes are not in the page-wide label index; element.labels is used.
    const label = document.createElement('label');
    label.textContent = 'Detached label ';
    const input = document.createElement('input');
    label.append(input);
    const r = E.generateLocators(input, []);
    expect(r.locators.find((l) => l.target.kind === 'role').target).toEqual({
      kind: 'role',
      role: 'textbox',
      name: 'Detached label',
      level: null,
    });
    // Not on the page, so nothing on the page matches it.
    expect(r.locators.every((l) => l.matchesElement === false)).toBe(true);
  });
});

describe('label resolution without HTMLLabelElement.control', () => {
  // Older engines lack label.control; labelControl() then resolves `for` and the
  // first labelable descendant itself. Whatever path is taken, the answers must be
  // the ones Playwright gives (and that the native path gives).
  // pw-verified:names
  const LABELS = [
    ['<label for="subject">Native for</label><input id="subject">', 'Native for'],
    ['<label>Wrapped <input type="hidden"><input id="subject"></label>', 'Wrapped'],
    [
      '<label for="subject">For a select</label><select id="subject"><option>o</option></select>',
      'For a select',
    ],
    ['<label for="subject">Not a control</label><div id="subject" role="button">Div</div>', 'Div'],
    ['<label for="missing">Dangling</label><input id="subject" title="Own title">', 'Own title'],
    [
      '<x-f id="h"></x-f>',
      'In shadow',
      { subject: '#si', shadow: [['#h', '<label for="si">In shadow</label><input id="si">']] },
    ],
  ];
  // end pw-verified

  function withoutLabelControl(fn) {
    const proto = window.HTMLLabelElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'control');
    delete proto.control;
    try {
      return fn();
    } finally {
      Object.defineProperty(proto, 'control', desc);
    }
  }

  it.each(LABELS)('%s → %j', (html, expected, opts) => {
    const el = render(html, opts);
    expect(roleCardName(el)).toBe(expected);
    expect(withoutLabelControl(() => roleCardName(el))).toBe(expected);
  });

  it('ignores a `for` that points at a hidden input when resolving it by hand', () => {
    const el = render(
      '<label for="hid">Hidden target</label><input id="hid" type="hidden"><input id="subject">'
    );
    expect(withoutLabelControl(() => E.countTargetMatches({ kind: 'label', value: 'Hidden target' }))).toBe(
      0
    );
    expect(withoutLabelControl(() => E.getAccessibleName(el))).toBeNull();
  });
});
