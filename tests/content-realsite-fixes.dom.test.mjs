// @vitest-environment jsdom
//
// Regressions found by driving the built extension on real sites (Shoelace,
// TodoMVC, MDN, the-internet, Wikipedia, GitHub): a web-component check-mark
// recorded as an extra non-unique click, a checkbox locator built from the DOM its
// own click restyled, long positional shadow-host selectors (and none at all for a
// class-only shadow element), the traversal bar covering the next field, disabled
// controls that could not be picked, inspect picking the icon inside a button, the
// clipboard blocked in a cross-origin frame, and a stale top-frame hover UI while
// the pointer is in an iframe.

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

/** A same-origin iframe with its own copy of the content scripts; `reply` answers its sendMessage. */
function loadIntoFrame(frame, reply = () => undefined) {
  const w = frame.contentWindow;
  const frameHandlers = [];
  const frameSent = [];
  w.__LocatraTrustSyntheticEvents = true;
  w.chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      sendMessage: (m, cb) => {
        frameSent.push(m);
        const r = reply(m);
        if (cb && r !== undefined) Promise.resolve().then(() => cb(r));
      },
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
  let async = false;
  for (const h of handlers) if (h(msg, {}, (r) => (response = r)) === true) async = true;
  return async
    ? {
        async,
        get response() {
          return response;
        },
      }
    : response;
}

const recorded = () => sent.filter((m) => m.type === 'RECORDED_ACTION').map((m) => m.data);
const steps = () => recorded().filter((s) => s.action !== 'goto' && s.action !== 'viewport');
const picks = () => sent.filter((m) => m.type === 'ELEMENT_PICKED').map((m) => m.data);
const pointAt = (el) => (document.elementFromPoint = () => el);
const E = () => globalThis.__LocatorLensEngine;

function pointer(el, type = 'pointerdown', init = {}) {
  el.dispatchEvent(
    new window.PointerEvent(type, { bubbles: true, composed: true, button: 0, isPrimary: true, ...init })
  );
}
const click = (el) =>
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
const mouseover = (el, init = {}) =>
  el.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, composed: true, ...init }));
function rect(el, r) {
  el.getBoundingClientRect = () => ({
    left: r.x,
    top: r.y,
    x: r.x,
    y: r.y,
    width: r.w,
    height: r.h,
    right: r.x + r.w,
    bottom: r.y + r.h,
  });
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
  stopAll();
});

/**
 * Shoelace's <sl-checkbox>: in its shadow root a <label> wraps the hidden native
 * input and an <sl-icon>, whose own shadow root holds the check-mark <svg>.
 */
function shoelaceCheckboxes(names = ['Checkbox', 'Checked', 'Other']) {
  document.body.innerHTML = names.map((n) => `<x-check>${n}</x-check>`).join('');
  return Array.from(document.querySelectorAll('x-check')).map((host, i) => {
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      `<label part="base" class="checkbox"><input class="checkbox__input" type="checkbox" aria-label="${names[i]}">` +
      '<span part="control" class="checkbox__control"><x-icon name="check"></x-icon></span>' +
      '<div part="label" class="checkbox__label"><slot></slot></div></label>';
    const icon = root.querySelector('x-icon').attachShadow({ mode: 'open' });
    icon.innerHTML = '<svg part="svg" viewBox="0 0 16 16"><path d="M0 0L8 8"></path></svg>';
    return { host, root, input: root.querySelector('input'), svg: icon.querySelector('svg') };
  });
}

describe('#1 · a click on a web component’s check-mark records only the toggle', () => {
  it('the svg inside the icon’s shadow root is held, and dropped when the input changes', () => {
    vi.useFakeTimers();
    const [, checked] = shoelaceCheckboxes();
    checked.input.checked = true;
    record();
    pointer(checked.svg);
    pointer(checked.svg, 'pointerup');
    // The click reaches the <label> through both shadow roots, and its activation
    // unchecks the native input — whose change does not leave the shadow root.
    click(checked.svg);
    expect(checked.input.checked).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(steps().map((s) => [s.action, s.target.kind, s.target.name])).toEqual([
      ['uncheck', 'role', 'Checked'],
    ]);
  });

  it('with no change (the page toggles in script), the click goes to a uniquely named element, not `svg`', () => {
    vi.useFakeTimers();
    const [, checked] = shoelaceCheckboxes();
    checked.svg.addEventListener('click', (e) => e.preventDefault()); // no label activation
    record();
    pointer(checked.svg);
    pointer(checked.svg, 'pointerup');
    click(checked.svg);
    expect(checked.input.checked).toBe(false);
    vi.advanceTimersByTime(1000);
    const [step] = steps();
    expect(step.action).toBe('click');
    expect(step.target.value).not.toBe('svg');
    expect(step.target.unique).not.toBe(false);
    expect(E().resolveTarget(step.target)).toEqual([checked.input]);
  });

  it('a role=switch host with the native input in its shadow root: one step, not click + check', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<x-switch role="switch" aria-label="Dark mode"></x-switch>';
    const host = document.querySelector('x-switch');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<input type="checkbox" aria-label="Dark mode"><span class="thumb"></span>';
    const input = root.querySelector('input');
    record();
    pointer(root.querySelector('span'));
    pointer(root.querySelector('span'), 'pointerup');
    input.checked = true;
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    click(root.querySelector('span'));
    vi.advanceTimersByTime(1000);
    expect(steps().map((s) => s.action)).toEqual(['check']);
  });

  it('an ARIA checkbox with no native input is still recorded as its click', () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<div><input type="checkbox" aria-label="Elsewhere"><div role="checkbox" aria-checked="false" aria-label="Remember"><svg><path d="M0 0"/></svg></div></div>';
    record();
    pointer(document.querySelector('path'));
    vi.advanceTimersByTime(1000);
    expect(steps().map((s) => [s.action, s.target.name])).toEqual([['click', 'Remember']]);
  });

  it('a non-unique click with an interactive host around it is promoted across shadow roots', () => {
    document.body.innerHTML =
      '<x-button aria-label="Save" role="button"></x-button><x-button aria-label="Open" role="button"></x-button>';
    const hosts = Array.from(document.querySelectorAll('x-button'));
    hosts.forEach((h) => {
      h.attachShadow({ mode: 'open' }).innerHTML = '<span class="label"><b>·</b></span>';
    });
    record();
    pointer(hosts[1].shadowRoot.querySelector('b'));
    const [step] = steps();
    expect(step.target).toMatchObject({ kind: 'role', role: 'button', name: 'Open' });
  });
});

describe('#2 · a check / select is located from the DOM before its gesture', () => {
  function todos() {
    document.body.innerHTML =
      '<ul class="todo-list">' +
      ['Feed the cat', 'Read a book', 'Water plants']
        .map(
          (t) => `<li><div class="view"><input class="toggle" type="checkbox"><label>${t}</label></div></li>`
        )
        .join('') +
      '</ul>';
    const items = Array.from(document.querySelectorAll('li'));
    // The app restyles the row inside the click, before `change` reaches anyone.
    items.forEach((li) =>
      li.addEventListener('click', () => {
        li.classList.toggle('finished');
        li.classList.toggle('completed');
      })
    );
    return items.map((li) => li.querySelector('.toggle'));
  }

  it('the locator is taken at pointerdown: no class the click itself added', () => {
    const toggles = todos();
    record();
    pointer(toggles[1]);
    toggles[1].click(); // jsdom: click → the row's handler → checked → change
    const [step] = steps();
    expect(step.action).toBe('check');
    expect(JSON.stringify(step.target)).not.toMatch(/finished|completed/);
    expect(E().resolveTarget(step.target)).toEqual([toggles[1]]);
    // …and it still finds the same box in the original DOM, which is what a replay starts from.
    toggles[1].closest('li').className = '';
    expect(E().resolveTarget(step.target)).toEqual([toggles[1]]);
  });

  it('a label click uses the control’s pre-click locator too', () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<div class="row"><label><input type="checkbox"> Done</label></div><div class="row"><label><input type="checkbox"> Done</label></div>';
    const row = document.querySelectorAll('.row')[1];
    const label = row.querySelector('label');
    const input = row.querySelector('input');
    label.addEventListener('click', () => {
      row.classList.remove('row');
      row.classList.add('ticked');
    });
    record();
    pointer(label);
    label.click();
    vi.advanceTimersByTime(1000);
    const [step] = steps();
    expect(step.action).toBe('check');
    expect(JSON.stringify(step.target)).not.toContain('ticked');
    row.className = 'row'; // the DOM a replay starts from
    expect(E().resolveTarget(step.target)).toEqual([input]);
  });

  it('a keyboard toggle (no pointerdown) generates afresh, never another control’s memo', () => {
    const toggles = todos();
    record();
    pointer(toggles[0]); // pressed, then released elsewhere: no change
    toggles[2].checked = true;
    toggles[2].dispatchEvent(new window.Event('change', { bubbles: true }));
    const [step] = steps();
    expect(E().resolveTarget(step.target)).toEqual([toggles[2]]);
  });

  it('a <select>: the option’s pointerdown remembers the select', () => {
    document.body.innerHTML =
      '<div class="f"><select><option>One</option><option>Two</option></select></div><div class="f"><select><option>One</option><option>Two</option></select></div>';
    const wrap = document.querySelectorAll('.f')[1];
    const select = wrap.querySelector('select');
    record();
    pointer(select.options[1]);
    wrap.className = 'touched-now'; // the page restyles it the moment the menu opens
    select.value = 'Two';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    const [step] = steps();
    expect(step.action).toBe('selectOption');
    expect(JSON.stringify(step.target)).not.toContain('touched-now');
    wrap.className = 'f'; // the DOM a replay starts from
    expect(E().resolveTarget(step.target)).toEqual([select]);
  });
});

describe('#3/#4 · shadow host and shadowCss selectors are short and verified', () => {
  it('a host with no id of its own is anchored to the nearest id ancestor, not spelled from <html>', () => {
    document.body.innerHTML =
      '<header><nav><div></div><div></div><div id="navigation__popup"><div></div><div><x-search></x-search></div></div></nav></header>' +
      '<main><x-search></x-search></main>';
    const host = document.querySelector('x-search');
    host.attachShadow({ mode: 'open' }).innerHTML = '<button>Search</button>';
    document.querySelectorAll('x-search')[1].attachShadow({ mode: 'open' }).innerHTML =
      '<button>Find</button>';
    record();
    pointer(host.shadowRoot.querySelector('button'));
    expect(steps()[0].target).toMatchObject({
      shadowHosts: ['#navigation__popup x-search'],
      shadowCss: 'button',
    });
  });

  it('a host told apart by a data-* attribute (or an href file name) uses it', () => {
    document.body.innerHTML =
      '<section><x-tab data-panel="billing"></x-tab></section><section><x-tab data-panel="profile"></x-tab></section>' +
      '<x-card href="/docs/a.html"></x-card><x-card href="/docs/b.html"></x-card>';
    const tab = document.querySelectorAll('x-tab')[1];
    tab.attachShadow({ mode: 'open' }).innerHTML = '<button>Profile</button>';
    const card = document.querySelectorAll('x-card')[1];
    card.attachShadow({ mode: 'open' }).innerHTML = '<button>Read</button>';
    record();
    pointer(tab.shadowRoot.querySelector('button'));
    pointer(card.shadowRoot.querySelector('button'));
    const [a, b] = steps();
    expect(a.target.shadowHosts).toEqual(['x-tab[data-panel="profile"]']);
    expect(b.target.shadowHosts).toEqual(['x-card[href$="b.html"]']);
  });

  it('a shadow element known only by its class gets a class selector', () => {
    document.body.innerHTML = '<x-dialog id="wa-dialog"></x-dialog>';
    const root = document.getElementById('wa-dialog').attachShadow({ mode: 'open' });
    root.innerHTML =
      '<div class="dialog"><div class="dialog__overlay"></div><div class="dialog__panel"><div class="dialog__body"></div></div></div>';
    const overlay = root.querySelector('.dialog__overlay');
    send({ type: 'START_INSPECT' });
    pointAt(overlay);
    click(overlay);
    const [pick] = picks();
    for (const l of pick.locators) {
      expect(l.target.shadowHosts).toEqual(['#wa-dialog']);
      expect(l.target.shadowCss).toBe('div.dialog__overlay');
    }
    expect(Array.from(root.querySelectorAll('div.dialog__overlay'))).toEqual([overlay]);
  });

  it('state classes are never the distinguishing class', () => {
    document.body.innerHTML = '<x-list id="l"></x-list>';
    const root = document.getElementById('l').attachShadow({ mode: 'open' });
    root.innerHTML =
      '<div class="item"></div><div class="item is-selected active"></div><div class="item"></div>';
    const el = root.querySelectorAll('div')[1];
    record();
    pointer(el);
    const css = steps()[0].target.shadowCss;
    expect(css).not.toMatch(/active|is-selected/);
    expect(Array.from(root.querySelectorAll(css))).toEqual([el]);
  });

  it('only then a short positional path, rooted in the shadow root’s own children', () => {
    document.body.innerHTML = '<x-menu id="m"></x-menu>';
    const root = document.getElementById('m').attachShadow({ mode: 'open' });
    root.innerHTML = '<ul><li><span>a</span></li><li><span>b</span></li></ul><p><span>c</span></p>';
    const el = root.querySelectorAll('li span')[1];
    record();
    pointer(el);
    const css = steps()[0].target.shadowCss;
    expect(css).toBe('li:nth-of-type(2) > span');
    expect(Array.from(root.querySelectorAll(css))).toEqual([el]);
  });

  it('twin hosts get a short positional selector, verified in the document', () => {
    document.body.innerHTML = '<div><div><x-a></x-a><x-a></x-a></div></div>';
    const twin = document.querySelectorAll('x-a')[1];
    twin.attachShadow({ mode: 'open' }).innerHTML = '<button>Twin</button>';
    record();
    pointer(twin.shadowRoot.querySelector('button'));
    const [host] = steps()[0].target.shadowHosts;
    expect(host).toBe('x-a:nth-of-type(2)');
    expect(Array.from(document.querySelectorAll(host))).toEqual([twin]);
  });
});

describe('#5 · the traversal bar never covers the element or the next field below it', () => {
  const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const barRect = () => {
    const bar = document.getElementById('ll-traversal-bar');
    return { x: parseFloat(bar.style.left), y: parseFloat(bar.style.top), w: 260, h: 34 };
  };

  it('a login form: hovering Username leaves Password (directly below) uncovered', () => {
    document.body.innerHTML =
      '<input id="username" aria-label="Username"><input id="password" aria-label="Password">';
    const user = { x: 100, y: 200, w: 200, h: 40 };
    const pass = { x: 100, y: 260, w: 200, h: 40 };
    rect(document.getElementById('username'), user);
    rect(document.getElementById('password'), pass);
    send({ type: 'START_INSPECT' });
    pointAt(document.getElementById('username'));
    mouseover(document.getElementById('username'));
    const bar = barRect();
    expect(overlaps(bar, user)).toBe(false);
    expect(overlaps(bar, { x: user.x, y: user.y + user.h, w: user.w, h: 400 })).toBe(false);
    expect(overlaps(bar, pass)).toBe(false);
    expect(bar.y + bar.h).toBe(user.y); // flush: reaching it crosses nothing else
  });

  it('entering a field whose edge is on a fraction of a pixel selects the field, not its wrapper', () => {
    document.body.innerHTML =
      '<div class="large-6"><label for="password">Password</label><input id="password"></div>';
    const wrap = document.querySelector('.large-6');
    const input = document.getElementById('password');
    send({ type: 'START_INSPECT' });
    pointAt(wrap); // elementFromPoint(296) — the field starts at 297.375
    mouseover(input, { clientX: 300, clientY: 296 });
    expect(document.getElementById('ll-tooltip').textContent).toContain('<input#password>');
    click(input);
    expect(picks()[0].elementData.id).toBe('password');
  });

  it('a pointer moving up (region pick: field row → card heading) never meets the bar on the way', () => {
    document.body.innerHTML =
      '<div class="card"><h2>Contact details</h2><div class="row"><input aria-label="First"><input aria-label="Last"></div>' +
      '<input aria-label="Email"></div>';
    const card = document.querySelector('.card');
    const h2 = document.querySelector('h2');
    const row = document.querySelector('.row');
    const first = row.querySelector('input');
    const email = document.querySelector('[aria-label="Email"]');
    rect(card, { x: 194, y: 177, w: 528, h: 370 });
    rect(h2, { x: 219, y: 190, w: 478, h: 40 });
    rect(row, { x: 219, y: 242, w: 478, h: 83 });
    rect(first, { x: 219, y: 260, w: 230, h: 40 });
    rect(email, { x: 219, y: 400, w: 478, h: 40 });
    send({ type: 'POM_PICK_START' });
    pointAt(email);
    mouseover(email, { clientX: 400, clientY: 420 });
    pointAt(first);
    mouseover(first, { clientX: 400, clientY: 280 }); // moving up: frames the field row
    expect(document.getElementById('ll-tooltip').textContent).toContain('<div.row>');
    const bar = barRect();
    expect(overlaps(bar, { x: 219, y: 190, w: 478, h: 40 })).toBe(false); // the heading stays reachable
    expect(bar.y).toBe(325); // flush under the row, behind the pointer
    pointAt(h2);
    mouseover(h2, { clientX: 400, clientY: 210 });
    const overlay = document.getElementById('ll-overlay');
    expect([parseFloat(overlay.style.left), parseFloat(overlay.style.top)]).toEqual([194, 177]);
    send({ type: 'POM_PICK_STOP' });
  });

  it('at the top of the viewport it sits beside the element, then on its other side', () => {
    document.body.innerHTML = '<button id="a">A</button><button id="b">B</button>';
    const a = { x: 100, y: 10, w: 200, h: 30 };
    const b = { x: window.innerWidth - 150, y: 10, w: 140, h: 30 };
    rect(document.getElementById('a'), a);
    rect(document.getElementById('b'), b);
    send({ type: 'START_INSPECT' });
    pointAt(document.getElementById('a'));
    mouseover(document.getElementById('a'));
    expect(barRect()).toMatchObject({ x: 300, y: 10 });
    pointAt(document.getElementById('b'));
    mouseover(document.getElementById('b'));
    expect(barRect()).toMatchObject({ x: b.x - 260, y: 10 });
    expect(overlaps(barRect(), b)).toBe(false);
  });

  it('an element filling the viewport: docked in a bottom corner away from the pointer', () => {
    document.body.innerHTML = '<div id="all">All</div>';
    const all = document.getElementById('all');
    rect(all, { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
    send({ type: 'START_INSPECT' });
    pointAt(all);
    mouseover(all, { clientX: 20, clientY: 20 });
    expect(barRect()).toMatchObject({ x: window.innerWidth - 264, y: window.innerHeight - 38 });
    mouseover(all, { clientX: window.innerWidth - 20, clientY: window.innerHeight - 10 });
    expect(barRect()).toMatchObject({ x: 4, y: window.innerHeight - 38 });
  });
});

describe('#6 · a disabled control is picked on the pointer gesture it still gets', () => {
  it('the release picks it (no click ever comes), once', () => {
    document.body.innerHTML =
      '<input id="d" disabled aria-label="Disabled field"><button id="e">Enabled</button>';
    const d = document.getElementById('d');
    send({ type: 'START_INSPECT' });
    pointAt(d);
    pointer(d);
    pointer(d, 'pointerup');
    d.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, button: 0 }));
    expect(picks().map((p) => p.elementData.tag)).toEqual(['input']);
    // Were a click to follow after all, it would not pick it a second time.
    click(d);
    expect(picks()).toHaveLength(1);
  });

  it('the gesture is swallowed, and an enabled element still waits for its click', () => {
    document.body.innerHTML = '<button id="e">Enabled</button>';
    const e = document.getElementById('e');
    let pageSaw = 0;
    e.addEventListener('pointerup', () => pageSaw++);
    send({ type: 'START_INSPECT' });
    pointAt(e);
    pointer(e, 'pointerup');
    expect(picks()).toEqual([]);
    expect(pageSaw).toBe(0);
    click(e);
    expect(picks().map((p) => p.elementData.tag)).toEqual(['button']);
  });

  it('the icon inside a disabled button picks the button', () => {
    document.body.innerHTML = '<button id="b" disabled><span class="icon"></span> Save</button>';
    const icon = document.querySelector('.icon');
    send({ type: 'START_INSPECT' });
    pointAt(icon);
    pointer(icon, 'pointerup');
    expect(picks().map((p) => p.elementData.id)).toEqual(['b']);
  });
});

describe('#7 · inspect picks the button, not the icon or label span inside it', () => {
  it('hover and pick promote like the recorder; ▼ Child still reaches the span', () => {
    document.body.innerHTML =
      '<button id="toggle" aria-label="Toggle subsection"><span class="vector-icon"></span></button>' +
      '<button id="google"><span class="Button-label">Continue with Google</span></button>' +
      '<button id="login"><i class="fa fa-sign-in"></i> Login</button>';
    const span = document.querySelector('.vector-icon');
    send({ type: 'START_INSPECT' });
    pointAt(span);
    mouseover(span);
    expect(document.getElementById('ll-tooltip').textContent).toContain('<button#toggle>');
    click(span);
    for (const sel of ['.Button-label', '.fa']) {
      const inner = document.querySelector(sel);
      pointAt(inner);
      click(inner);
    }
    expect(picks().map((p) => p.elementData.id)).toEqual(['toggle', 'google', 'login']);
    // The inner element is one ▼ away.
    pointAt(span);
    mouseover(span);
    document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.getElementById('ll-tooltip').textContent).toContain('<span.vector-icon>');
  });

  it('text with a meaning of its own (a heading inside a link) is still picked itself', () => {
    document.body.innerHTML = '<a href="/x"><h3 id="h">Title</h3></a>';
    const h = document.getElementById('h');
    send({ type: 'START_INSPECT' });
    pointAt(h);
    click(h);
    expect(picks()[0].elementData.tag).toBe('h3');
  });
});

describe('#9 · quick copy in a frame whose policy blocks the clipboard goes through the top frame', () => {
  it('no clipboard call in the frame; the top frame copies it; the toast says so', async () => {
    document.body.innerHTML = '<iframe id="xo"></iframe>';
    const fe = document.getElementById('xo');
    const { w, frameSend, frameSent } = loadIntoFrame(fe, (m) =>
      m.type === 'COPY_VIA_TOP' ? { ok: true } : undefined
    );
    const writeText = vi.fn(() => Promise.reject(new Error('blocked')));
    Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText } });
    w.document.execCommand = vi.fn(() => false);
    Object.defineProperty(w.document, 'featurePolicy', {
      configurable: true,
      value: { allowsFeature: (f) => f !== 'clipboard-write' },
    });
    w.document.body.innerHTML = '<button>Pay</button>';
    frameSend({ type: 'START_INSPECT' });
    w.document.querySelector('button').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    const relay = frameSent.find((m) => m.type === 'COPY_VIA_TOP');
    expect(relay && relay.text).toContain('Pay');
    expect(writeText).not.toHaveBeenCalled();
    expect(w.document.execCommand).not.toHaveBeenCalled();
    expect(w.document.getElementById('ll-toast').textContent).toContain('Copied');
    frameSend({ type: 'STOP_INSPECT' });
  });

  it('the top frame answers COPY_TEXT with the clipboard’s word; a subframe ignores it', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      const r = send({ type: 'COPY_TEXT', text: "page.getByRole('button')" });
      expect(r.async).toBe(true);
      await new Promise((res) => setTimeout(res, 0));
      expect(writeText).toHaveBeenCalledWith("page.getByRole('button')");
      expect(r.response).toEqual({ ok: true });

      document.body.innerHTML = '<iframe id="f"></iframe>';
      const { w, frameSend } = loadIntoFrame(document.getElementById('f'));
      const frameWrite = vi.fn(() => Promise.resolve());
      Object.defineProperty(w.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: frameWrite },
      });
      expect(frameSend({ type: 'COPY_TEXT', text: 'x' })).toBeUndefined();
      expect(frameWrite).not.toHaveBeenCalled();
    } finally {
      delete window.navigator.clipboard;
    }
  });

  it('a frame the policy allows copies by itself', async () => {
    document.body.innerHTML = '<iframe id="ok"></iframe>';
    const { w, frameSend, frameSent } = loadIntoFrame(document.getElementById('ok'));
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText } });
    Object.defineProperty(w.document, 'featurePolicy', {
      configurable: true,
      value: { allowsFeature: () => true },
    });
    w.document.body.innerHTML = '<button>Pay</button>';
    frameSend({ type: 'START_INSPECT' });
    w.document.querySelector('button').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(writeText).toHaveBeenCalled();
    expect(frameSent.some((m) => m.type === 'COPY_VIA_TOP')).toBe(false);
    frameSend({ type: 'STOP_INSPECT' });
  });
});

describe('#10 · the top frame’s hover UI goes when the pointer goes into a child frame', () => {
  const shown = (id) => {
    const n = document.getElementById(id);
    return !!n && n.style.visibility !== 'hidden';
  };

  it('nothing shows before the first hover (an unplaced bar sat in the page flow of every frame)', () => {
    document.body.innerHTML = '<button id="b">B</button>';
    send({ type: 'START_INSPECT' });
    expect(['ll-overlay', 'll-tooltip', 'll-traversal-bar'].some(shown)).toBe(false);
    pointAt(document.getElementById('b'));
    mouseover(document.getElementById('b'));
    expect(['ll-overlay', 'll-tooltip', 'll-traversal-bar'].every(shown)).toBe(true);
  });

  it('entering an <iframe> hides overlay, tooltip and bar; the next hover here shows them again', () => {
    document.body.innerHTML = '<button id="b">B</button><iframe id="f"></iframe>';
    const b = document.getElementById('b');
    const f = document.getElementById('f');
    send({ type: 'START_INSPECT' });
    pointAt(b);
    mouseover(b);
    expect(['ll-overlay', 'll-tooltip', 'll-traversal-bar'].every(shown)).toBe(true);
    pointAt(f);
    b.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: f }));
    mouseover(f);
    expect(['ll-overlay', 'll-tooltip', 'll-traversal-bar'].some(shown)).toBe(false);
    // Enter does not pick a selection nobody can see.
    document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(picks()).toEqual([]);
    pointAt(b);
    mouseover(b);
    expect(['ll-overlay', 'll-tooltip', 'll-traversal-bar'].every(shown)).toBe(true);
  });

  it('a frame that starts hovering says so once; another frame’s word hides this one’s UI', () => {
    document.body.innerHTML = '<button id="b">B</button><button id="c">C</button>';
    const b = document.getElementById('b');
    send({ type: 'START_INSPECT' });
    pointAt(b);
    mouseover(b);
    pointAt(document.getElementById('c'));
    mouseover(document.getElementById('c'));
    const said = sent.filter((m) => m.type === 'INSPECT_HOVERED');
    expect(said).toHaveLength(1);
    // Its own echo changes nothing…
    send({ type: 'HIDE_HOVER_UI', token: said[0].token });
    expect(shown('ll-traversal-bar')).toBe(true);
    // …a hover in a cross-origin child frame (no mouse event reaches this document) hides it.
    send({ type: 'HIDE_HOVER_UI', token: 'another-frame' });
    expect(['ll-overlay', 'll-tooltip', 'll-traversal-bar'].some(shown)).toBe(false);
    // Hovering here again shows it, and says so again.
    pointAt(b);
    mouseover(b);
    expect(shown('ll-traversal-bar')).toBe(true);
    expect(sent.filter((m) => m.type === 'INSPECT_HOVERED')).toHaveLength(2);
  });

  it('a child frame hides its own when the pointer leaves its document', () => {
    document.body.innerHTML = '<iframe id="f"></iframe>';
    const { w, frameSend } = loadIntoFrame(document.getElementById('f'));
    w.document.body.innerHTML = '<button>In frame</button>';
    const btn = w.document.querySelector('button');
    frameSend({ type: 'START_INSPECT' });
    btn.dispatchEvent(new w.MouseEvent('mouseover', { bubbles: true }));
    expect(w.document.getElementById('ll-traversal-bar').style.visibility).not.toBe('hidden');
    btn.dispatchEvent(new w.MouseEvent('mouseout', { bubbles: true, relatedTarget: null }));
    expect(w.document.getElementById('ll-traversal-bar').style.visibility).toBe('hidden');
    expect(w.document.getElementById('ll-overlay').style.visibility).toBe('hidden');
    frameSend({ type: 'STOP_INSPECT' });
  });
});
