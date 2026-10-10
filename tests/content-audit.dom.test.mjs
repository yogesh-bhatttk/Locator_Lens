// @vitest-environment jsdom
//
// Regression tests for the audit findings fixed in content.js: secrets in value
// assertions (C2), icon clicks (M3), own UI known by identity (M4), multi-selects
// (C1), the shadow path on targets (C3), frame indices (C4), sensitiveOnScreen
// (C6), URL redaction (L3), the clipboard fallback (L4), untrusted events while
// inspecting (L5), the recorder's fallbacks (L6), label clicks (L7) and the
// shadow-root change listeners (L8).

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_SCRIPTS = ['src/codegen.js', 'src/content-locator-engine.js', 'src/content.js'];

let handlers = [];
let sent = [];
const allHandlers = [];

function stopAll() {
  for (const h of allHandlers) {
    try {
      h({ type: 'STOP_RECORDING' }, {}, () => {});
      h({ type: 'STOP_INSPECT' }, {}, () => {});
    } catch {
      /* torn down */
    }
  }
}

function load() {
  stopAll();
  if (globalThis.chrome && globalThis.chrome.runtime) delete globalThis.chrome.runtime.id;
  handlers = [];
  sent = [];
  globalThis.__LocatraTrustSyntheticEvents = true;
  globalThis.chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      sendMessage: (msg) => sent.push(msg),
      onMessage: {
        addListener: (fn) => {
          handlers.push(fn);
          allHandlers.push(fn);
        },
        removeListener: () => {},
      },
    },
    storage: {
      local: { get: (keys, cb) => cb({}) },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  };
  delete globalThis.__LocatorLensEngine;
  delete globalThis.LLCodegen;
  for (const file of CONTENT_SCRIPTS) {
    vm.runInThisContext(readFileSync(join(ROOT, file), 'utf8'), { filename: file });
  }
}

/** A same-origin iframe with its own copy of the content scripts. */
function loadIntoFrame(frame) {
  const w = frame.contentWindow;
  const frameHandlers = [];
  const frameSent = [];
  w.__LocatraTrustSyntheticEvents = true;
  w.chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      sendMessage: (m) => frameSent.push(m),
      onMessage: { addListener: (fn) => frameHandlers.push(fn), removeListener: () => {} },
    },
    storage: { local: { get: (k, cb) => cb({}) }, onChanged: { addListener: () => {} } },
  };
  for (const file of CONTENT_SCRIPTS)
    vm.runInContext(readFileSync(join(ROOT, file), 'utf8'), w, { filename: file });
  const frameSend = (msg) => {
    let r;
    for (const h of frameHandlers) h(msg, {}, (x) => (r = x));
    return r;
  };
  return { w, frameSend, frameSent };
}

function send(msg) {
  let response;
  for (const h of handlers) h(msg, {}, (r) => (response = r));
  return response;
}

const recorded = () => sent.filter((m) => m.type === 'RECORDED_ACTION').map((m) => m.data);
const steps = () => recorded().filter((s) => s.action !== 'goto' && s.action !== 'viewport');
const picks = () => sent.filter((m) => m.type === 'ELEMENT_PICKED').map((m) => m.data);
const pointAt = (el) => (document.elementFromPoint = () => el);
function pointer(el, init = {}) {
  el.dispatchEvent(
    new window.PointerEvent('pointerdown', {
      bubbles: true,
      composed: true,
      button: 0,
      isPrimary: true,
      ...init,
    })
  );
}
function change(el) {
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
}
function record() {
  send({ type: 'START_RECORDING' });
  sent.length = 0;
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.body.className = '';
  delete document.elementFromPoint;
  load();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  globalThis.__LocatraTrustSyntheticEvents = true;
});

describe('C2 · a value assertion on a sensitive field', () => {
  function assertValue(el) {
    record();
    send({ type: 'SET_ASSERT_MODE', on: true, assertType: 'toHaveValue' });
    pointer(el);
    return steps().find((s) => s.action === 'assert');
  }

  it('records an env-var reference for a password field, never the value', () => {
    document.body.innerHTML = '<label>Password <input id="p" type="password"></label>';
    const p = document.getElementById('p');
    p.value = 'hunter2-secret';
    const step = assertValue(p);
    expect(step).toMatchObject({
      action: 'assert',
      assertType: 'toHaveValue',
      sensitive: true,
      secretName: 'LOCATRA_PASSWORD',
      value: '',
    });
    expect(step.fullCode).toBe(
      "await expect(page.getByRole('textbox', { name: 'Password' })).toHaveValue(process.env.LOCATRA_PASSWORD ?? '');"
    );
    expect(JSON.stringify(sent)).not.toContain('hunter2');
  });

  it('a one-time code reads the secret variable; an ordinary field keeps its value', () => {
    document.body.innerHTML =
      '<label>Code <input id="c" autocomplete="one-time-code"></label><label>City <input id="t"></label>';
    document.getElementById('c').value = '424242';
    document.getElementById('t').value = 'Pune';
    const otp = assertValue(document.getElementById('c'));
    expect(otp).toMatchObject({ sensitive: true, secretName: 'LOCATRA_SECRET', value: '' });
    expect(otp.fullCode).toContain("toHaveValue(process.env.LOCATRA_SECRET ?? '')");
    pointer(document.getElementById('t'));
    const city = steps().filter((s) => s.action === 'assert')[1];
    expect(city).toMatchObject({ value: 'Pune' });
    expect(city.sensitive).toBeUndefined();
    expect(city.fullCode).toContain('toHaveValue("Pune")');
    expect(JSON.stringify(sent)).not.toContain('424242');
  });
});

describe('M3 · clicks on icons go to the control', () => {
  const ICONS = `
    <header>
      <button aria-label="Close"><svg viewBox="0 0 10 10"><g><path id="close-path" d="M0 0L10 10"/></g></svg></button>
      <a href="/home" aria-label="Home"><span class="icon"><svg id="home-svg"><use id="home-use" href="#i"/></svg></span></a>
      <svg id="lonely"><circle id="dot" r="1"/></svg>
      <svg id="svg-btn" role="button" aria-label="Zoom"><path id="zoom-path" d="M0 0"/></svg>
      <button aria-label="Help"><svg id="named-img" role="img" aria-label="Question mark"></svg></button>
      <a href="/docs"><span id="docs-text">Docs</span></a>
      <div><span id="plain">Plain text</span></div>
    </header>`;

  it('records the button / link around a <path>, <use> or bare <svg>, not the drawing', () => {
    document.body.innerHTML = ICONS;
    record();
    pointer(document.getElementById('close-path'));
    pointer(document.getElementById('home-use'));
    pointer(document.getElementById('home-svg'));
    pointer(document.getElementById('docs-text'));
    const codes = steps().map((s) => s.fullCode);
    expect(codes).toEqual([
      "await page.getByRole('button', { name: 'Close' }).click();",
      "await page.getByRole('link', { name: 'Home' }).click();",
      "await page.getByRole('link', { name: 'Home' }).click();",
      "await page.getByRole('link', { name: 'Docs' }).click();",
    ]);
  });

  it('keeps SVG with a role of its own, and named text outside any control', () => {
    document.body.innerHTML = ICONS;
    record();
    pointer(document.getElementById('zoom-path')); // inside <svg role=button>
    pointer(document.getElementById('svg-btn'));
    pointer(document.getElementById('named-img')); // role=img with a name: a target of its own
    pointer(document.getElementById('plain'));
    const codes = steps().map((s) => s.fullCode);
    expect(codes[0]).toBe("await page.getByRole('button', { name: 'Zoom' }).click();");
    expect(codes[1]).toBe(codes[0]);
    expect(codes[2]).toBe("await page.getByRole('img', { name: 'Question mark' }).click();");
    expect(codes[3]).toBe("await page.getByText('Plain text').click();");
  });

  it('an SVG part with no control around it becomes its outermost <svg>', () => {
    document.body.innerHTML = ICONS;
    record();
    pointer(document.getElementById('dot'));
    expect(steps()[0].target).toMatchObject({ kind: 'id', value: 'lonely' });
  });

  it('crosses shadow boundaries to find the control', () => {
    document.body.innerHTML = '<x-btn id="host"></x-btn>';
    const sr = document.getElementById('host').attachShadow({ mode: 'open' });
    sr.innerHTML = '<button aria-label="Send"><svg><path id="p" d="M0 0"/></svg></button>';
    record();
    pointer(sr.getElementById('p'));
    expect(steps()[0].fullCode).toBe("await page.getByRole('button', { name: 'Send' }).click();");
  });

  it('assertions, double-clicks and Alt+Click hovers use the same promotion rules', () => {
    document.body.innerHTML = ICONS;
    record();
    pointer(document.getElementById('home-use'), { altKey: true });
    document.getElementById('close-path').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    send({ type: 'SET_ASSERT_MODE', on: true, assertType: 'toBeVisible' });
    pointer(document.getElementById('close-path')); // an icon: promoted
    send({ type: 'SET_ASSERT_MODE', on: true, assertType: 'toHaveText' });
    pointer(document.getElementById('docs-text')); // text the user pointed at: kept
    const out = steps().map((s) => [s.action, s.code]);
    expect(out.slice(0, 3)).toEqual([
      ['hover', "page.getByRole('link', { name: 'Home' })"],
      ['dblclick', "page.getByRole('button', { name: 'Close' })"],
      ['assert', "page.getByRole('button', { name: 'Close' })"],
    ]);
    expect(out[3][1]).toMatch(/getByText\('Docs'\)$/); // the <span>, not the link around it
  });

  it('inspect and the context menu promote icon parts only', () => {
    document.body.innerHTML = ICONS;
    send({ type: 'START_INSPECT' });
    pointAt(document.getElementById('close-path'));
    document.body.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    expect(document.getElementById('ll-tooltip').textContent).toContain('<button>');
    document.getElementById('close-path').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    pointAt(document.getElementById('docs-text'));
    document.getElementById('docs-text').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(picks().map((p) => p.elementData.tag)).toEqual(['button', 'span']);
    send({ type: 'STOP_INSPECT' });

    const use = document.getElementById('home-use');
    use.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, composed: true }));
    sent.length = 0;
    send({ type: 'START_INSPECT' });
    send({ type: 'CONTEXT_MENU_COPY' });
    expect(picks()[0].elementData.tag).toBe('a');
  });
});

describe('M4 · own UI is known by identity, not by an ll- id', () => {
  it('page elements called ll-trav-parent / ll-toast / ll-styles are left alone', () => {
    document.head.innerHTML = '<style id="ll-styles">.page{}</style>';
    document.body.innerHTML =
      '<button id="ll-trav-parent">Page parent</button><div id="ll-toast">Page toast</div><div id="wrap"><p id="x">x</p></div>';
    let pageClicks = 0;
    document.getElementById('ll-trav-parent').addEventListener('click', () => pageClicks++);
    send({ type: 'START_INSPECT' });
    // Our stylesheet is injected even though the page has an #ll-styles of its own…
    const sheets = document.querySelectorAll('style');
    expect(sheets).toHaveLength(2);
    expect(sheets[1].textContent).toMatch(/#ll-toast\[data-locatra-ui="[a-z0-9]+"\]/);
    expect(sheets[1].textContent).not.toMatch(/#ll-toast[ .{]/);
    // …the traversal toolbar binds its own buttons, not the page's lookalike…
    pointAt(document.getElementById('x'));
    document.body.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    const ownParent = Array.from(document.querySelectorAll('#ll-trav-parent')).find((b) =>
      b.closest('#ll-traversal-bar')
    );
    ownParent.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(document.getElementById('ll-tooltip').textContent).toContain('<div#wrap>');
    expect(pageClicks).toBe(0);
    // …and closing inspect, a toast, or a teardown never removes the page's elements.
    send({ type: 'CONTEXT_MENU_COPY' }); // no target: shows our own toast
    send({ type: 'STOP_INSPECT' });
    expect(document.querySelectorAll('#ll-toast')).toHaveLength(1);
    expect(document.getElementById('ll-toast').textContent).toBe('Page toast');
    // A page that throws our stylesheet away gets a fresh one on the next start.
    document.querySelectorAll('style')[1].remove();
    send({ type: 'START_INSPECT' });
    expect(document.querySelectorAll('style')).toHaveLength(2);
    send({ type: 'STOP_INSPECT' });
    window.__LocatorLensInstance.teardown();
    expect(document.getElementById('ll-styles').textContent).toBe('.page{}');
    expect(document.querySelectorAll('[data-locatra-ui]')).toHaveLength(0);
  });

  it('a page subtree under an ll- id is picked, counted and scanned like any other', async () => {
    document.body.innerHTML =
      '<div id="ll-root"><button data-testid="save">Save</button></div><div id="locatra-x"><a href="/a">A</a></div>';
    record();
    pointer(document.querySelector('button'));
    expect(steps()[0].target).toMatchObject({ kind: 'testid', value: 'save', unique: true });
    sent.length = 0;
    send({ type: 'POM_SCAN' });
    await new Promise((r) => setTimeout(r, 0));
    const pom = sent.find((m) => m.type === 'POM_RESULT').data;
    expect(pom.elements.map((e) => e.tag)).toEqual(['button', 'a']);
  });

  it('the overlay is skipped by the page-object scan and never recorded', async () => {
    document.body.innerHTML = '<button>Real</button>';
    send({ type: 'START_INSPECT' });
    send({ type: 'POM_SCAN' });
    await new Promise((r) => setTimeout(r, 0));
    const pom = sent.find((m) => m.type === 'POM_RESULT').data;
    expect(pom.elements.map((e) => e.label)).toEqual(['Real']);
  });

  it('a replay highlight is our own UI while it shows', async () => {
    document.body.innerHTML = '<button>Go</button>';
    const msg = {
      type: 'REPLAY_STEP',
      runId: 'r',
      index: 0,
      step: { action: 'click', target: { kind: 'css', value: 'div' } },
      timeoutMs: 0,
      highlight: true,
    };
    document.body.insertAdjacentHTML('beforeend', '<div id="only">x</div>');
    const res = await new Promise((done) => handlers.forEach((h) => h(msg, {}, done)));
    expect(res).toEqual({ ok: true, matchCount: 1 });
    expect(document.querySelectorAll('div')).toHaveLength(2); // the page's div and our highlight
    const again = await new Promise((done) => handlers.forEach((h) => h(msg, {}, done)));
    expect(again).toEqual({ ok: true, matchCount: 1 }); // the highlight is not a second match
  });
});

describe('C1 · selectOption steps', () => {
  it('records the normalised option label, and every selected option of a multi-select', () => {
    document.body.innerHTML = `
      <label for="sel">Country</label><select id="sel"><option value="us">United
         States</option><option value="in" label="Bharat">India</option></select>
      <label for="ms">Tags</label><select id="ms" multiple><option>A</option><option>B</option><option>C</option></select>`;
    record();
    const sel = document.getElementById('sel');
    change(sel);
    sel.selectedIndex = 1;
    change(sel);
    const ms = document.getElementById('ms');
    ms.options[1].selected = true;
    change(ms);
    ms.options[2].selected = true;
    change(ms);
    const out = steps().map((s) => [s.value, s.values, s.fullCode]);
    expect(out).toEqual([
      [
        'United States',
        undefined,
        "await page.getByRole('combobox', { name: 'Country' }).selectOption('United States');",
      ],
      ['Bharat', undefined, "await page.getByRole('combobox', { name: 'Country' }).selectOption('Bharat');"],
      ['B', undefined, "await page.getByRole('listbox', { name: 'Tags' }).selectOption('B');"],
      ['B', ['B', 'C'], "await page.getByRole('listbox', { name: 'Tags' }).selectOption(['B', 'C']);"],
    ]);
  });

  it('an empty selection records the select’s value; an empty label attribute falls back to the text', () => {
    document.body.innerHTML =
      '<select id="s" multiple><option>A</option></select><select id="e"><option label="">  Plain   text </option></select>';
    record();
    change(document.getElementById('s'));
    change(document.getElementById('e'));
    expect(steps().map((s) => s.value)).toEqual(['', 'Plain text']);
  });
});

describe('C3 · targets inside open shadow DOM carry shadowHosts / shadowCss', () => {
  function build() {
    document.body.innerHTML = '<x-app id="app"></x-app><x-app></x-app>';
    const outer = document.getElementById('app').attachShadow({ mode: 'open' });
    outer.innerHTML = '<x-form data-testid="form"></x-form><button name="b1">Outer</button>';
    const inner = outer.querySelector('x-form').attachShadow({ mode: 'open' });
    inner.innerHTML = '<div><button>One</button><button>Two</button></div><input placeholder="Email">';
    return { outer, inner };
  }

  it('records the host chain, outermost first, and a CSS selector for the element', () => {
    const { outer, inner } = build();
    record();
    pointer(inner.querySelectorAll('button')[1]);
    pointer(outer.querySelector('button'));
    const [two, outerBtn] = steps();
    expect(two.target).toMatchObject({
      kind: 'role',
      name: 'Two',
      shadowHosts: ['#app', '[data-testid="form"]'],
      shadowCss: 'div > button:nth-of-type(2)',
    });
    expect(outerBtn.target).toMatchObject({ shadowHosts: ['#app'], shadowCss: 'button[name="b1"]' });
    // The engine still resolves the target (it pierces and ignores the extra fields).
    expect(globalThis.__LocatorLensEngine.resolveTarget(two.target)).toEqual([
      inner.querySelectorAll('button')[1],
    ]);
  });

  it('every card of a pick carries it, and light-DOM targets do not', () => {
    const { inner } = build();
    document.body.insertAdjacentHTML('beforeend', '<button id="light">Light</button>');
    send({ type: 'START_INSPECT' });
    const input = inner.querySelector('input');
    pointAt(input);
    input.dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true }));
    const light = document.getElementById('light');
    pointAt(light);
    light.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const [shadowPick, lightPick] = picks();
    expect(shadowPick.locators.length).toBeGreaterThan(1);
    for (const l of shadowPick.locators) {
      expect(l.target.shadowHosts).toEqual(['#app', '[data-testid="form"]']);
      expect(l.target.shadowCss).toBe('input[placeholder="Email"]');
    }
    for (const l of lightPick.locators) expect(l.target.shadowHosts).toBeUndefined();
  });

  it('tells same-tag hosts apart structurally, and leaves closed roots out', () => {
    document.body.innerHTML = '<x-a></x-a><x-a></x-a><x-c id="c"></x-c>';
    const twin = document.querySelectorAll('x-a')[1].attachShadow({ mode: 'open' });
    twin.innerHTML = '<button>Twin</button>';
    const closed = document.getElementById('c').attachShadow({ mode: 'closed' });
    closed.innerHTML = '<button>Closed</button>';
    record();
    pointer(twin.querySelector('button'));
    pointer(closed.querySelector('button'));
    const [a, b] = steps();
    expect(a.target).toMatchObject({
      shadowHosts: ['html > body > x-a:nth-of-type(2)'],
      shadowCss: 'button',
    });
    expect(b.target.shadowHosts).toBeUndefined();
  });

  it('keeps the hosts but no shadowCss when the element itself has no unique selector', () => {
    document.body.innerHTML = '<x-a id="a"></x-a>';
    const sr = document.getElementById('a').attachShadow({ mode: 'open' });
    sr.innerHTML = '<span>One</span>';
    const span = sr.querySelector('span');
    const real = sr.querySelectorAll.bind(sr);
    sr.querySelectorAll = (sel) => (sel === 'span' ? [span, span] : real(sel)); // defeat every candidate
    record();
    pointer(span);
    expect(steps()[0].target.shadowHosts).toEqual(['#a']);
    expect(steps()[0].target.shadowCss).toBeUndefined();
  });

  it('an open root under a closed one gives no chain: no test tool reaches it', () => {
    document.body.innerHTML = '<x-a id="a"></x-a>';
    const outer = document.getElementById('a').attachShadow({ mode: 'closed' });
    outer.innerHTML = '<x-b id="b"></x-b>';
    const inner = outer.querySelector('x-b').attachShadow({ mode: 'open' });
    inner.innerHTML = '<button>Deep</button>';
    record();
    pointer(inner.querySelector('button'));
    expect(steps()[0].target.shadowHosts).toBeUndefined();
  });

  it('a health suggestion for a shadow element carries the path too', () => {
    const { inner } = build();
    inner.querySelectorAll('button')[1].setAttribute('data-testid', 'two');
    const [res] = globalThis.__LocatraHealthCheck([
      {
        id: 1,
        target: { kind: 'testid', attr: 'data-testid', value: 'gone' },
        fingerprint: { tag: 'button', testAttr: 'data-testid', testId: 'two', text: 'Two' },
      },
    ]);
    expect(res.suggestion.target).toMatchObject({ shadowHosts: ['#app', '[data-testid="form"]'] });
  });
});

describe('C4 · frame wrappers carry index and framesIndex', () => {
  it('index counts the parent document’s <iframe>s, framesIndex its window.frames', () => {
    document.body.innerHTML = '<iframe id="a"></iframe><iframe id="b"></iframe>';
    const { w, frameSend, frameSent } = loadIntoFrame(document.getElementById('b'));
    w.document.body.innerHTML = '<button>Pay</button>';
    frameSend({ type: 'START_INSPECT' });
    w.document.querySelector('button').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    const pick = frameSent.find((m) => m.type === 'ELEMENT_PICKED').data;
    expect(pick.locators[0].target).toMatchObject({
      kind: 'frame',
      selector: '#b',
      index: 1,
      framesIndex: 1,
    });

    // <iframe>s in shadow roots count for `index` (Playwright pierces) but jsdom gives
    // them no window: the engine's pierce order decides, window.frames does not.
    const E = w.__LocatorLensEngine;
    const fe = document.getElementById('b');
    E.deepQueryAll = () => [document.getElementById('a'), document.createElement('iframe'), fe];
    frameSent.length = 0;
    w.document.querySelector('button').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    const again = frameSent.find((m) => m.type === 'ELEMENT_PICKED').data;
    expect(again.locators[0].target).toMatchObject({ index: 2, framesIndex: 1 });
    // A <frame> (not counted among <iframe>s) falls back to its window.frames position.
    E.deepQueryAll = () => [];
    frameSent.length = 0;
    w.document.querySelector('button').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    expect(frameSent.find((m) => m.type === 'ELEMENT_PICKED').data.locators[0].target).toMatchObject({
      index: 1,
      framesIndex: 1,
    });
  });
});

describe('C6 · sensitiveOnScreen', () => {
  it('is set while a non-password secret field shows a value, and only then', () => {
    document.body.innerHTML = `
      <input id="otp" autocomplete="one-time-code"><input id="pw" type="password">
      <input id="mail" autocomplete="email" value="me@example.test">
      <input id="card" autocomplete="cc-number"><button id="go">Go</button>`;
    record();
    const go = document.getElementById('go');
    pointer(go);
    document.getElementById('pw').value = 'hunter2'; // masked on screen
    pointer(go);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000); // past the candidate cache
    document.getElementById('otp').value = '123456';
    pointer(go);
    expect(steps().map((s) => s.sensitiveOnScreen)).toEqual([undefined, undefined, true]);
  });

  it('measures the viewport when there is layout: a field scrolled away does not count', () => {
    document.body.innerHTML = '<input id="card" autocomplete="cc-number"><button id="go">Go</button>';
    document.documentElement.getBoundingClientRect = () => ({
      width: 800,
      height: 600,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
    });
    const card = document.getElementById('card');
    card.value = '4242424242424242';
    const at = (top) =>
      (card.getBoundingClientRect = () => ({
        top,
        left: 0,
        width: 100,
        height: 20,
        bottom: top + 20,
        right: 100,
      }));
    try {
      record();
      at(10);
      pointer(document.getElementById('go'));
      at(5000);
      pointer(document.getElementById('go'));
      expect(steps().map((s) => s.sensitiveOnScreen)).toEqual([true, undefined]);
    } finally {
      delete document.documentElement.getBoundingClientRect;
    }
  });

  it('sees the step’s own field and fields inside known shadow roots', () => {
    document.body.innerHTML = '<x-pay id="h"></x-pay>';
    const sr = document.getElementById('h').attachShadow({ mode: 'open' });
    sr.innerHTML = '<input id="cvc" autocomplete="cc-csc"><button>Pay</button>';
    record();
    sr.getElementById('cvc').value = '123';
    pointer(sr.querySelector('button'));
    expect(steps()[0].sensitiveOnScreen).toBe(true);
  });
});

describe('L3 · redactUrl', () => {
  const urlOf = (path) => {
    window.history.pushState(null, '', path);
    load();
    send({ type: 'START_RECORDING' });
    const goto = recorded().find((s) => s.action === 'goto').value;
    send({ type: 'STOP_RECORDING' });
    return goto.replace(/^https?:\/\/[^/]+/, '');
  };
  let original;
  beforeEach(() => (original = window.location.href));
  afterEach(() => window.history.replaceState(null, '', original));

  it('always redacts names that can only mean a credential (case-insensitive)', () => {
    const keys = [
      'access_token',
      'id_token',
      'refresh_token',
      'signature',
      'X-Amz-Signature',
      'X-Amz-Credential',
      'X-Amz-Security-Token',
      'apikey',
      'api_key',
      'API_KEY',
      'client_secret',
      'secret',
      'SessionId',
      'password',
      'passwd',
      'pwd',
    ];
    for (const k of keys) expect(urlOf(`/cb?${k}=s3cr3t&q=shoes`)).toBe(`/cb?${k}=REDACTED&q=shoes`);
    expect(urlOf('/cb#access_token=abc&state=1')).toBe('/cb#access_token=REDACTED&state=1');
  });

  it('keeps ordinary values of generic names (code, token, key, auth, sig, session)', () => {
    // A search term, a promo code, a page number, a slug: replay and every export
    // must navigate to the same URL the recording started on.
    expect(urlOf('/search?key=shoes')).toBe('/search?key=shoes');
    expect(urlOf('/cart?code=SUMMER')).toBe('/cart?code=SUMMER');
    expect(urlOf('/talks?session=2')).toBe('/talks?session=2');
    expect(urlOf('/p?code=summer-sale-2024&token=x&auth=sso&sig=1')).toBe(
      '/p?code=summer-sale-2024&token=x&auth=sso&sig=1'
    );
    expect(urlOf('/s?key=running-shoes-for-men&code=1234567890123456')).toBe(
      '/s?key=running-shoes-for-men&code=1234567890123456'
    );
  });

  it('redacts generic names whose value looks like a secret: OAuth codes, hex/base64 tokens, JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl';
    expect(urlOf('/cb?code=4/0AX4XfWhq3Lk9vZpT2mR8nB&scope=email')).toBe('/cb?code=REDACTED&scope=email');
    expect(urlOf('/cb?code=4%2F0AX4XfWhq3Lk9vZpT2mR8nB')).toBe('/cb?code=REDACTED');
    expect(urlOf('/x?token=9f86d081884c7d659a2feaa0c55ad015&q=1')).toBe('/x?token=REDACTED&q=1');
    expect(urlOf(`/x?Token=${jwt}`)).toBe('/x?Token=REDACTED');
    expect(urlOf('/x#auth=dGhpc2lzYXNlY3JldDEyMw==&sig=Zx81kQp2Lm7Vb3Nc')).toBe(
      '/x#auth=REDACTED&sig=REDACTED'
    );
    expect(urlOf('/x?KEY=AKIA1234ABCD5678EFGH&session=s3ss10nIdQ8wX2vB')).toBe(
      '/x?KEY=REDACTED&session=REDACTED'
    );
  });

  it('leaves ordinary parameters (and lookalike names) alone', () => {
    expect(urlOf('/s?q=a&page=2&id=7&author=me&keyword=x&codes=1')).toBe(
      '/s?q=a&page=2&id=7&author=me&keyword=x&codes=1'
    );
  });
});

describe('L4 · the clipboard fallback cannot be rewritten by the page', () => {
  it('a page copy listener does not replace the locator', async () => {
    document.body.innerHTML = '<button id="b">Buy</button>';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const data = {};
    const pageListener = vi.fn((e) => {
      e.clipboardData.setData('text/plain', 'Read more at evil.example');
      e.preventDefault();
    });
    document.addEventListener('copy', pageListener);
    document.execCommand = vi.fn(() => {
      const ev = new window.Event('copy', { bubbles: true, cancelable: true });
      ev.clipboardData = { setData: (type, v) => (data[type] = v) };
      document.activeElement.dispatchEvent(ev);
      return true;
    });
    try {
      send({ type: 'START_INSPECT' });
      const b = document.getElementById('b');
      pointAt(b);
      b.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
      expect(data['text/plain']).toBe("page.getByRole('button', { name: 'Buy' })");
      expect(pageListener).not.toHaveBeenCalled();
      expect(document.querySelector('textarea')).toBeNull();
      // Outside our copy, the page's listener works as before.
      document.dispatchEvent(
        Object.assign(new window.Event('copy'), { clipboardData: { setData: () => {} } })
      );
      expect(pageListener).toHaveBeenCalledTimes(1);
      // A copy event without clipboardData still ends with our selection copied.
      document.execCommand = vi.fn(() => {
        document.activeElement.dispatchEvent(new window.Event('copy', { bubbles: true, cancelable: true }));
        return true;
      });
      b.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
      expect(document.getElementById('ll-toast').textContent).toContain('Copied');
    } finally {
      delete document.execCommand;
      delete navigator.clipboard;
      document.removeEventListener('copy', pageListener);
    }
  });
});

describe('L5 · inspect ignores events a page script dispatches', () => {
  it('untrusted mouseover, keys and toolbar clicks do nothing', () => {
    document.body.innerHTML = '<div id="outer"><button id="b">B</button></div><p id="p">P</p>';
    send({ type: 'START_INSPECT' });
    pointAt(document.getElementById('b'));
    document.body.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    expect(document.getElementById('ll-tooltip').textContent).toContain('<button#b>');

    globalThis.__LocatraTrustSyntheticEvents = false; // from here on: the page's own events
    pointAt(document.getElementById('p'));
    document.body.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    expect(document.getElementById('ll-tooltip').textContent).toContain('<button#b>');
    const key = (k) =>
      document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('ArrowUp');
    expect(document.getElementById('ll-tooltip').textContent).toContain('<button#b>');
    key('Enter');
    expect(picks()).toHaveLength(0);
    document.querySelector('#ll-traversal-bar #ll-trav-parent').click();
    document.querySelector('#ll-traversal-bar #ll-trav-child').click();
    expect(document.getElementById('ll-tooltip').textContent).toContain('<button#b>');
    key('Escape');
    expect(document.getElementById('ll-overlay')).not.toBeNull();
    expect(sent.some((m) => m.type === 'STOP_INSPECT')).toBe(false);

    globalThis.__LocatraTrustSyntheticEvents = true;
    document.querySelector('#ll-traversal-bar #ll-trav-child').click();
    key('Escape');
    expect(document.getElementById('ll-overlay')).toBeNull();
  });
});

describe('L6 · recorder fallbacks', () => {
  function breakEngine() {
    globalThis.__LocatorLensEngine.generateLocators = () => {
      throw new Error('engine down');
    };
  }

  it('escapes the id and keeps code, statement and target in agreement', () => {
    breakEngine();
    document.body.innerHTML = '<button id="a.b\'c">Go</button>';
    record();
    pointer(document.querySelector('button'));
    const [s] = steps();
    expect(s.target).toMatchObject({ kind: 'id', value: "a.b'c", unique: true, matchCount: 1 });
    expect(s.code).toBe(String.raw`page.locator('#a\\.b\\\'c')`);
    expect(s.fullCode).toBe(`await ${s.code}.click();`);
  });

  it('a bare tag fallback is marked as not unique, never silently narrowed', () => {
    breakEngine();
    const E = globalThis.__LocatorLensEngine;
    E.buildCSSSelector = () => {
      throw new Error('also down');
    };
    document.body.innerHTML = '<span>a</span><span>b</span>';
    record();
    pointer(document.querySelectorAll('span')[1]);
    const [s] = steps();
    expect(s.target).toEqual({ kind: 'css', value: 'span', unique: false, matchCount: 2 });
    expect(s.fullCode).toBe("await page.locator('span').click();");
    delete E.countTargetMatches;
    pointer(document.querySelectorAll('span')[0]);
    expect(steps()[1].target).toEqual({ kind: 'css', value: 'span', unique: false });
  });

  it('CONTEXT_MENU_COPY always answers, even when the engine throws', () => {
    breakEngine();
    document.body.innerHTML = '<button id="b">B</button>';
    document.getElementById('b').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
    expect(send({ type: 'CONTEXT_MENU_COPY' })).toEqual({ ok: false, error: 'engine down' });
  });
});

describe('L7 · a click on a checkbox’s label records only the check', () => {
  it('wrapping and for= labels, radios too; a link inside the label is still a click', () => {
    document.body.innerHTML = `
      <label id="wrap"><input id="cb" type="checkbox"> <span id="txt">Accept terms</span> <a href="/t" id="terms">terms</a></label>
      <label for="r" id="forlbl">Express</label><input type="radio" id="r" name="ship">
      <label for="name" id="namelbl">Name</label><input id="name">`;
    record();
    const cb = document.getElementById('cb');
    pointer(document.getElementById('wrap'));
    cb.checked = true;
    change(cb);
    pointer(document.getElementById('txt'));
    cb.checked = false;
    change(cb);
    pointer(document.getElementById('forlbl'));
    document.getElementById('r').checked = true;
    change(document.getElementById('r'));
    pointer(document.getElementById('terms'));
    pointer(document.getElementById('namelbl')); // a text field's label is an ordinary click
    expect(steps().map((s) => s.action)).toEqual(['check', 'uncheck', 'check', 'click', 'click']);
  });
});

describe('L8 · shadow-root change listeners do not pile up', () => {
  it('roots whose host left the page are dropped once the set has doubled', () => {
    record();
    const focusIn = (host) => {
      const sr = host.attachShadow({ mode: 'open' });
      sr.innerHTML = '<input>';
      sr.querySelector('input').dispatchEvent(
        new window.FocusEvent('focusin', { bubbles: true, composed: true })
      );
      return sr;
    };
    const removed = [];
    for (let i = 0; i < 70; i++) {
      const host = document.createElement('x-row');
      document.body.appendChild(host);
      const sr = focusIn(host);
      if (i < 69) {
        host.remove();
        removed.push(sr);
      }
    }
    // The last root is still live: a change inside it is recorded…
    const live = document.querySelector('x-row').shadowRoot;
    const box = document.createElement('input');
    box.type = 'checkbox';
    live.appendChild(box);
    box.checked = true;
    box.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(steps().filter((s) => s.action === 'check')).toHaveLength(1);
    // …while a pruned root's listener is gone.
    const old = removed[0];
    const oldBox = document.createElement('input');
    oldBox.type = 'checkbox';
    old.appendChild(oldBox);
    oldBox.checked = true;
    oldBox.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(steps().filter((s) => s.action === 'check')).toHaveLength(1);
  });
});

describe('C6 · tab-wide: each frame reports a secret on screen (SENSITIVE_ON_SCREEN)', () => {
  const flags = (list = sent) => list.filter((m) => m.type === 'SENSITIVE_ON_SCREEN').map((m) => m.visible);
  const input = (el, init = {}) =>
    el.dispatchEvent(new window.Event('input', { bubbles: true, composed: true, ...init }));

  it('reports a card number as it appears and goes, once per change; masked and plain fields never', () => {
    document.body.innerHTML = `
      <input id="card" autocomplete="cc-number"><input id="pw" type="password"><input id="q">`;
    record();
    const card = document.getElementById('card');
    const pw = document.getElementById('pw');
    pw.value = 'hunter2';
    input(pw);
    document.getElementById('q').value = 'shoes';
    input(document.getElementById('q'));
    expect(flags()).toEqual([]);
    card.value = '4';
    input(card);
    card.value = '42';
    input(card);
    card.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true, composed: true }));
    expect(flags()).toEqual([true]); // only on change, not per keystroke
    card.value = '';
    input(card);
    expect(flags()).toEqual([true, false]);
    expect(JSON.stringify(sent)).not.toContain('42');
  });

  it('counts a value a page script or autofill writes (untrusted events), and one present before recording', () => {
    document.body.innerHTML = '<input id="otp" autocomplete="one-time-code" value="">';
    const otp = document.getElementById('otp');
    otp.value = '123456';
    record(); // record() clears sent: start again to see the start-up report
    send({ type: 'STOP_RECORDING' });
    sent.length = 0;
    send({ type: 'START_RECORDING' });
    expect(flags()).toEqual([]); // the last answer (yes) still stands: nothing changed
    globalThis.__LocatraTrustSyntheticEvents = false;
    otp.value = '';
    input(otp);
    expect(flags()).toEqual([false]);
    otp.value = '654321';
    otp.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(flags()).toEqual([false, true]);
  });

  it('reports a value present when recording starts', () => {
    document.body.innerHTML = '<input id="card" autocomplete="cc-number" value="4242424242424242">';
    send({ type: 'START_RECORDING' });
    expect(flags()).toEqual([true]);
  });

  it('is sent before the step that leaves the frame, and sees fields in open shadow roots', () => {
    document.body.innerHTML = '<x-pay id="h"></x-pay><button id="go">Go</button>';
    const sr = document.getElementById('h').attachShadow({ mode: 'open' });
    sr.innerHTML = '<input id="cvc" autocomplete="cc-csc">';
    record();
    const cvc = sr.getElementById('cvc');
    cvc.value = '123';
    input(cvc);
    expect(flags()).toEqual([true]);
    sent.length = 0;
    cvc.remove(); // gone without an event: the step re-evaluates first
    pointer(document.getElementById('go'));
    expect(sent.map((m) => m.type + (m.type === 'SENSITIVE_ON_SCREEN' ? ':' + m.visible : ''))).toEqual([
      'SENSITIVE_ON_SCREEN:false',
      'RECORDED_ACTION', // the pending (sensitive) fill, flushed by the click
      'RECORDED_ACTION',
    ]);
    expect(steps().map((s) => s.action)).toEqual(['fill', 'click']);
  });

  it('remembers the field that said yes until it no longer shows a secret (re-checked each second)', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<input id="card" autocomplete="cc-number"><button id="go">Go</button>';
    record();
    const card = document.getElementById('card');
    card.value = '4242';
    input(card);
    // A click elsewhere moves focus away; the field still shows the number.
    pointer(document.getElementById('go'));
    expect(flags()).toEqual([true]);
    card.style.display = 'none'; // hidden by the page, no event
    vi.advanceTimersByTime(1000);
    expect(flags()).toEqual([true, false]);
    vi.advanceTimersByTime(5000);
    expect(flags()).toEqual([true, false]); // no re-check (nor message) while the answer is no
  });

  it('a frame going away says it shows nothing; not on a cancellable beforeunload', () => {
    document.body.innerHTML = '<input id="card" autocomplete="cc-number">';
    record();
    const card = document.getElementById('card');
    card.value = '4242';
    input(card);
    window.dispatchEvent(new window.Event('beforeunload'));
    expect(flags()).toEqual([true]);
    window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: true }));
    expect(flags()).toEqual([true, false]);
    window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: true }));
    expect(flags()).toEqual([true, false, true]); // back from the bfcache, still showing
  });

  it('a payment iframe reports for itself: its own messages, keyed by its frame', () => {
    document.body.innerHTML = '<iframe id="pay"></iframe><button id="pay-btn">Pay</button>';
    const { w, frameSend, frameSent } = loadIntoFrame(document.getElementById('pay'));
    w.document.body.innerHTML = '<input id="cc" autocomplete="cc-number">';
    record();
    frameSend({ type: 'START_RECORDING', rearm: true });
    const cc = w.document.getElementById('cc');
    cc.value = '4242424242424242';
    cc.dispatchEvent(new w.Event('input', { bubbles: true, composed: true }));
    expect(flags(frameSent)).toEqual([true]);
    pointer(document.getElementById('pay-btn'));
    // The top frame cannot see it; background combines the frames' answers.
    expect(steps()[0].sensitiveOnScreen).toBeUndefined();
    expect(flags()).toEqual([]);
  });
});

describe('L7 · a label click the page handles itself is still recorded', () => {
  const up = (el) =>
    el.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, composed: true }));
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

  beforeEach(() => {
    document.body.innerHTML = `
      <label id="lbl" for="cb">Remember me</label><input type="checkbox" id="cb">
      <button id="go">Go</button>`;
  });

  it('records the click when the page cancels it and toggles state in script (no change)', () => {
    vi.useFakeTimers();
    const lbl = document.getElementById('lbl');
    const cb = document.getElementById('cb');
    lbl.addEventListener('click', (e) => {
      e.preventDefault();
      cb.checked = !cb.checked; // no change event
    });
    record();
    pointer(lbl);
    up(lbl);
    click(lbl);
    expect(steps()).toEqual([]); // held until the click's task is over
    vi.advanceTimersByTime(0);
    expect(steps().map((s) => [s.action, s.code])).toEqual([['click', "page.getByText('Remember me')"]]);
  });

  it('records only the check when the browser toggles the control (native label activation)', () => {
    vi.useFakeTimers();
    const lbl = document.getElementById('lbl');
    record();
    pointer(lbl);
    up(lbl);
    click(lbl); // jsdom runs the label's activation: the checkbox toggles and fires change
    vi.advanceTimersByTime(1000);
    expect(steps().map((s) => s.action)).toEqual(['check']);
  });

  it('keeps its place: the next step flushes it first; release elsewhere or a lost gesture settle it', () => {
    vi.useFakeTimers();
    const lbl = document.getElementById('lbl');
    const go = document.getElementById('go');
    record();
    pointer(lbl);
    pointer(go); // no gesture end seen: the next step sends the held click before itself
    expect(steps().map((s) => [s.action, s.target.kind])).toEqual([
      ['click', 'text'],
      ['click', 'role'],
    ]);
    expect(steps()[0].timestamp).toBeLessThanOrEqual(steps()[1].timestamp);

    sent.length = 0;
    pointer(lbl);
    up(go); // released elsewhere: no click follows
    vi.advanceTimersByTime(99);
    expect(steps()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(steps().map((s) => s.action)).toEqual(['click']);

    sent.length = 0;
    pointer(lbl);
    vi.advanceTimersByTime(5000); // never saw the end of the gesture
    expect(steps().map((s) => s.action)).toEqual(['click']);

    sent.length = 0;
    pointer(lbl);
    send({ type: 'STOP_RECORDING' }); // a stop sends it too
    expect(steps().map((s) => s.action)).toEqual(['click']);
  });

  it('typing that follows the press lands after the held click; a double-click supersedes both clicks', () => {
    vi.useFakeTimers();
    document.body.insertAdjacentHTML('beforeend', '<input id="name" aria-label="Name">');
    const lbl = document.getElementById('lbl');
    const cb = document.getElementById('cb');
    lbl.addEventListener('click', (e) => e.preventDefault());
    record();
    pointer(lbl);
    up(document.getElementById('go')); // released elsewhere: settles in 100 ms
    const name = document.getElementById('name');
    name.value = 'Ada';
    name.dispatchEvent(new window.Event('input', { bubbles: true }));
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(450);
    expect(steps().map((s) => s.action)).toEqual(['click', 'fill']);

    sent.length = 0;
    pointer(lbl);
    up(lbl);
    click(lbl);
    vi.advanceTimersByTime(0);
    pointer(lbl);
    up(lbl);
    click(lbl); // the second click's settle is still pending when dblclick fires
    lbl.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    const [c1, c2, dbl] = steps();
    expect([c1.action, c2.action, dbl.action]).toEqual(['click', 'click', 'dblclick']);
    expect(dbl.supersedes).toEqual([c1.eventId, c2.eventId]);
    expect(cb.checked).toBe(false);
  });

  it('a page going away sends a held click', () => {
    record();
    pointer(document.getElementById('lbl'));
    window.dispatchEvent(new window.PageTransitionEvent('pagehide'));
    expect(steps().map((s) => s.action)).toEqual(['click']);
  });

  it('a pause, or assert mode, sends a held click first', () => {
    const lbl = document.getElementById('lbl');
    record();
    pointer(lbl);
    send({ type: 'PAUSE_RECORDING' });
    expect(steps().map((s) => s.action)).toEqual(['click']);
    send({ type: 'RESUME_RECORDING' });
    pointer(lbl);
    send({ type: 'SET_ASSERT_MODE', on: true, assertType: 'toBeVisible' });
    expect(steps().map((s) => s.action)).toEqual(['click', 'click']);
  });
});

describe('<option> clicks inside a <select> are left to its change', () => {
  it('a listbox click and Ctrl+click record only selectOption steps, the last with every value', () => {
    document.body.innerHTML = `
      <label for="t">Toppings</label>
      <select id="t" multiple size="4"><option>Cheese</option><option>Ham</option>
        <optgroup id="veg" label="Veg"><option>Olive</option></optgroup></select>`;
    record();
    const sel = document.getElementById('t');
    pointer(sel.options[0]);
    sel.options[0].selected = true;
    change(sel);
    pointer(sel.options[1], { ctrlKey: true });
    sel.options[1].selected = true;
    change(sel);
    pointer(document.getElementById('veg'));
    sel.options[1].dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    expect(steps().map((s) => [s.action, s.values])).toEqual([
      ['selectOption', undefined],
      ['selectOption', ['Cheese', 'Ham']],
    ]);
    expect(steps()[1].fullCode).toBe(
      "await page.getByRole('listbox', { name: 'Toppings' }).selectOption(['Cheese', 'Ham']);"
    );
  });

  it('a dropdown option click (Firefox dispatches it) is not a step; the select’s own click still is', () => {
    document.body.innerHTML =
      '<select id="d" aria-label="Size"><option>S</option><option>M</option></select>';
    record();
    const sel = document.getElementById('d');
    pointer(sel);
    pointer(sel.options[1]);
    sel.selectedIndex = 1;
    change(sel);
    expect(steps().map((s) => s.action)).toEqual(['click', 'selectOption']);
  });
});
