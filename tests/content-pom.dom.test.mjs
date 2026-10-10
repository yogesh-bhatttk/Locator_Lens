// @vitest-environment jsdom
//
// F2 · Page Object export, content side: the "Pick region" mode built on the
// inspect overlay, the "Whole page" scan, and the POM_RESULT model they send.

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

function load() {
  for (const h of allHandlers) {
    try {
      h({ type: 'STOP_RECORDING' }, {}, () => {});
      h({ type: 'STOP_INSPECT' }, {}, () => {});
    } catch {
      /* torn down */
    }
  }
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
      },
    },
    storage: {
      local: { get: (keys, cb) => cb({}) },
      onChanged: { addListener: () => {} },
    },
  };
  delete globalThis.__LocatorLensEngine;
  delete globalThis.LLCodegen;
  for (const file of CONTENT_SCRIPTS) {
    vm.runInThisContext(readFileSync(join(ROOT, file), 'utf8'), { filename: file });
  }
}

function send(msg) {
  let response;
  let returned;
  for (const h of handlers) returned = h(msg, {}, (r) => (response = r));
  return response === undefined ? { noResponse: true, returned } : response;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** The POM_RESULT the scan sends (it builds asynchronously). */
async function pomResult() {
  for (let i = 0; i < 200; i++) {
    const hit = sent.find((m) => m.type === 'POM_RESULT');
    if (hit) return hit.data;
    await tick(10);
  }
  throw new Error('no POM_RESULT sent');
}

function hover(el) {
  document.elementFromPoint = () => el;
  el.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
}
function click(el) {
  document.elementFromPoint = () => el;
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}
function keydown(k) {
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}

let originalUrl;
beforeEach(() => {
  originalUrl = window.location.href;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.body.className = '';
  document.title = '';
  delete document.elementFromPoint;
  load();
});
afterEach(() => {
  window.history.replaceState(null, '', originalUrl);
});

const CHECKOUT = `
  <header><a href="/">Home</a></header>
  <form id="checkout" aria-label="Checkout">
    <label>Email <input type="email" id="email"></label>
    <label>Email <input type="email" id="email2" name="confirm"></label>
    <input type="hidden" name="csrf" value="t">
    <label>Notes <textarea></textarea></label>
    <label>Country <select><option>NL</option></select></label>
    <label><input type="checkbox"> Gift wrap</label>
    <label><input type="radio" name="ship"> Express</label>
    <input type="submit" value="Place order">
    <div style="display:none"><button>Hidden</button></div>
    <x-promo></x-promo>
    <details><summary>More</summary></details>
    <div contenteditable="true" aria-label="Message"></div>
    <div role="switch" aria-checked="false" aria-label="Newsletter"></div>
    <div role="textbox" aria-label="Fake"></div>
  </form>`;

function mountCheckout() {
  document.body.innerHTML = CHECKOUT;
  const host = document.querySelector('x-promo');
  host.attachShadow({ mode: 'open' }).innerHTML = '<input placeholder="Promo code"><button>Apply</button>';
}

describe('POM_SCAN (whole page)', () => {
  it('sends the interactive, visible elements in document order, shadow roots included', async () => {
    mountCheckout();
    document.title = 'Checkout';
    window.history.replaceState(null, '', '/checkout?access_token=abc&step=2');
    expect(send({ type: 'POM_SCAN' })).toEqual({ ok: true });
    const data = await pomResult();

    expect(data.pageUrl).toContain('access_token=REDACTED');
    expect(data.pageUrl).not.toContain('abc');
    expect(data.title).toBe('Checkout');
    expect(data.region).toEqual({ tag: 'body', locator: "page.locator('body')" });
    expect(data.truncated).toBe(false);

    const summary = data.elements.map((e) => [e.name, e.kind, e.tag]);
    expect(summary).toEqual([
      ['homeLink', 'link', 'a'],
      ['emailInput', 'input', 'input'],
      ['emailInput2', 'input', 'input'],
      ['notesField', 'textarea', 'textarea'],
      ['countrySelect', 'select', 'select'],
      ['giftWrapCheckbox', 'checkbox', 'input'],
      ['expressRadio', 'radio', 'input'],
      ['placeOrderButton', 'button', 'input'],
      ['promoCodeInput', 'input', 'input'],
      ['applyButton', 'button', 'button'],
      [expect.any(String), 'other', 'summary'],
      [expect.any(String), 'other', 'div'],
      ['newsletterCheckbox', 'checkbox', 'div'],
      [expect.any(String), 'other', 'div'],
    ]);
  });

  it('describes each element: role, inputType, label, its best locator and uniqueness', async () => {
    mountCheckout();
    send({ type: 'POM_SCAN' });
    const { elements } = await pomResult();
    const email = elements.find((e) => e.name === 'emailInput');
    expect(email).toMatchObject({
      kind: 'input',
      role: 'textbox',
      tag: 'input',
      inputType: 'email',
      label: 'Email',
    });
    expect(email.target).toEqual({ kind: 'id', value: 'email', matchCount: 1, unique: true });
    expect(email.code).toBe("page.locator('#email')");
    expect(email.matchCount).toBe(1);
    expect(email.unique).toBe(true);
    const order = elements.find((e) => e.name === 'placeOrderButton');
    expect(order).toMatchObject({ role: 'button', inputType: 'submit', unique: true });
    expect(order.target.kind).toBe('role');
    const notes = elements.find((e) => e.kind === 'textarea');
    expect(notes.inputType).toBeUndefined();
  });

  it('keeps a non-unique element, marked unique:false', async () => {
    document.body.innerHTML = '<ul><li><button>Edit</button></li><li><button>Edit</button></li></ul>';
    send({ type: 'POM_SCAN' });
    const { elements } = await pomResult();
    expect(elements).toHaveLength(2);
    expect(elements.map((e) => e.name)).toEqual(['editButton', 'editButton2']);
    expect(elements.every((e) => typeof e.matchCount === 'number')).toBe(true);
  });

  it('stops at 200 elements and says so', async () => {
    document.body.innerHTML = Array.from({ length: 205 }, (_, i) => `<button id="b${i}">B${i}</button>`).join(
      ''
    );
    // Locator generation is not what is under test here; keep it cheap.
    globalThis.__LocatorLensEngine.generateLocators = (el) => ({
      elementData: {},
      locators: [{ code: `#${el.id}`, target: { kind: 'id', value: el.id }, matchCount: 1, unique: true }],
    });
    send({ type: 'POM_SCAN' });
    const data = await pomResult();
    expect(data.elements).toHaveLength(200);
    expect(data.truncated).toBe(true);
    expect(new Set(data.elements.map((e) => e.name)).size).toBe(200);
  });

  it('skips Locatra’s own UI and non-rendering tags', async () => {
    document.body.innerHTML = '<button>Real</button><template><button>T</button></template>';
    send({ type: 'START_INSPECT' }); // creates the overlay + traversal bar buttons
    send({ type: 'POM_SCAN' });
    const { elements } = await pomResult();
    expect(elements.map((e) => e.name)).toEqual(['realButton']);
    send({ type: 'STOP_INSPECT' });
  });

  it('names elements itself when the engine has no suggestName', async () => {
    delete globalThis.__LocatorLensEngine.suggestName;
    document.body.innerHTML = `
      <button data-testid="place-order">Buy</button>
      <input placeholder="Search products">
      <input id="zipCode">
      <a href="/x">2 for 1</a>
      <button>class</button>
      <select name="size"><option>S</option></select>
      <textarea aria-label="Comment field"></textarea>
      <span role="tab">Overview</span>`;
    send({ type: 'POM_SCAN' });
    const { elements } = await pomResult();
    expect(elements.map((e) => e.name)).toEqual([
      'placeOrderButton',
      'searchProductsInput',
      'zipCodeInput',
      'el2For1Link',
      'classButton',
      'sizeSelect',
      'commentField',
      'overview',
    ]);
  });

  it('falls back to its own naming when suggestName throws or returns junk', async () => {
    const E = globalThis.__LocatorLensEngine;
    let call = 0;
    E.suggestName = () =>
      call++ === 0
        ? 'not an identifier!'
        : (() => {
            throw new Error('boom');
          })();
    document.body.innerHTML = '<button>Save</button><button>Load</button>';
    send({ type: 'POM_SCAN' });
    const { elements } = await pomResult();
    expect(elements.map((e) => e.name)).toEqual(['saveButton', 'loadButton']);
  });

  it('falls back to a structural locator when the engine has none', async () => {
    const E = globalThis.__LocatorLensEngine;
    E.generateLocators = () => ({ elementData: {}, locators: [] });
    document.body.innerHTML = '<button id="solo">Solo</button><button>A</button><button>B</button>';
    send({ type: 'POM_SCAN' });
    const { elements } = await pomResult();
    expect(elements[0]).toMatchObject({ target: { kind: 'id', value: 'solo' }, matchCount: 1, unique: true });
    // A structural selector built to be unique, not a bare tag that matched all three.
    expect(elements[1]).toMatchObject({
      target: { kind: 'css', value: 'button:nth-of-type(2)' },
      matchCount: 1,
      unique: true,
    });
  });

  it('is answered by the top frame only', () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const w = frame.contentWindow;
    const frameHandlers = [];
    const frameSent = [];
    w.chrome = {
      runtime: {
        id: 'x',
        lastError: null,
        sendMessage: (m) => frameSent.push(m),
        onMessage: { addListener: (fn) => frameHandlers.push(fn) },
      },
      storage: { local: { get: (k, cb) => cb({}) }, onChanged: { addListener: () => {} } },
    };
    // runInContext (not w.eval) so coverage attributes the frame's run to src/.
    for (const file of CONTENT_SCRIPTS)
      vm.runInContext(readFileSync(join(ROOT, file), 'utf8'), w, { filename: file });
    let answered = false;
    const returned = frameHandlers.map((h) => h({ type: 'POM_SCAN' }, {}, () => (answered = true)));
    expect(returned).toEqual([false]);
    expect(answered).toBe(false);
    expect(frameSent.filter((m) => m.type === 'POM_RESULT')).toEqual([]);
  });
});

describe('POM_PICK_START (region pick)', () => {
  it('hover highlights the container, a click scans it and leaves the page as it was', async () => {
    mountCheckout();
    expect(send({ type: 'POM_PICK_START' })).toEqual({ ok: true });
    expect(document.getElementById('ll-overlay')).not.toBeNull();
    const email = document.getElementById('email');
    hover(email);
    expect(document.getElementById('ll-tooltip').textContent).toContain('<form#checkout>');
    expect(document.getElementById('ll-tooltip').textContent).toContain('Esc to cancel');

    click(email);
    const data = await pomResult();
    expect(data.region).toEqual({ tag: 'form', locator: "page.getByRole('form', { name: 'Checkout' })" });
    expect(data.elements.map((e) => e.name)).not.toContain('homeLink');
    expect(data.elements[0].name).toBe('emailInput');
    // Inspect was not on before: the overlay goes away again, and nothing was "picked".
    expect(document.getElementById('ll-overlay')).toBeNull();
    expect(document.body.classList.contains('ll-inspecting')).toBe(false);
    expect(sent.filter((m) => m.type === 'ELEMENT_PICKED')).toEqual([]);
  });

  it('a div holding several controls counts as a region; a lone control falls back to <body>', async () => {
    document.body.innerHTML =
      '<div id="bar"><span><button>One</button></span><button>Two</button></div><p><button id="lone">Lone</button></p>';
    send({ type: 'POM_PICK_START' });
    hover(document.querySelector('button'));
    expect(document.getElementById('ll-tooltip').textContent).toContain('<div#bar>');
    hover(document.getElementById('lone'));
    expect(document.getElementById('ll-tooltip').textContent).toContain('<body.ll-inspecting>');
    send({ type: 'POM_PICK_STOP' });
  });

  it('Esc cancels with POM_PICK_CANCELLED and does not stop an inspect that was already on', async () => {
    document.body.innerHTML = '<form><input aria-label="A"><button>Go</button></form>';
    send({ type: 'START_INSPECT' });
    send({ type: 'POM_PICK_START' });
    hover(document.querySelector('input'));
    keydown('Escape');
    expect(sent.filter((m) => m.type === 'POM_PICK_CANCELLED')).toHaveLength(1);
    expect(sent.filter((m) => m.type === 'STOP_INSPECT')).toHaveLength(0);
    // Inspect carries on: a click picks the element itself, as usual.
    expect(document.getElementById('ll-overlay')).not.toBeNull();
    click(document.querySelector('button'));
    const picked = sent.filter((m) => m.type === 'ELEMENT_PICKED');
    expect(picked).toHaveLength(1);
    expect(picked[0].data.elementData.tagName || picked[0].data.locators[0].code).toBeTruthy();
    expect(sent.filter((m) => m.type === 'POM_RESULT')).toHaveLength(0);
    send({ type: 'STOP_INSPECT' });
  });

  it('Esc without a prior inspect removes the overlay', () => {
    document.body.innerHTML = '<form><input aria-label="A"></form>';
    send({ type: 'POM_PICK_START' });
    keydown('Escape');
    expect(sent.map((m) => m.type)).toContain('POM_PICK_CANCELLED');
    expect(document.getElementById('ll-overlay')).toBeNull();
  });

  it('Enter picks the highlighted region; ▲ widens it first', async () => {
    document.body.innerHTML =
      '<main id="m"><section id="s"><input aria-label="A"><input aria-label="B"></section><button>Out</button></main>';
    send({ type: 'POM_PICK_START' });
    hover(document.querySelector('input'));
    expect(document.getElementById('ll-tooltip').textContent).toContain('<section#s>');
    keydown('ArrowUp');
    expect(document.getElementById('ll-tooltip').textContent).toContain('<main#m>');
    keydown('Enter');
    const data = await pomResult();
    expect(data.region.tag).toBe('main');
    expect(data.elements).toHaveLength(3);
  });

  it('a second POM_PICK_START is harmless and STOP_INSPECT ends region mode', () => {
    document.body.innerHTML = '<form><input aria-label="A"></form>';
    expect(send({ type: 'POM_PICK_START' })).toEqual({ ok: true });
    expect(send({ type: 'POM_PICK_START' })).toEqual({ ok: true });
    send({ type: 'STOP_INSPECT' });
    expect(document.getElementById('ll-overlay')).toBeNull();
    // Inspect started afresh is the normal mode again.
    send({ type: 'START_INSPECT' });
    hover(document.querySelector('input'));
    expect(document.getElementById('ll-tooltip').textContent).toContain('Esc to stop');
    send({ type: 'STOP_INSPECT' });
  });

  it('picking a region while recording records nothing', async () => {
    document.body.innerHTML = '<form><input aria-label="A"><button>Go</button></form>';
    send({ type: 'START_RECORDING' });
    sent.length = 0;
    send({ type: 'POM_PICK_START' });
    const btn = document.querySelector('button');
    btn.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true }));
    click(btn);
    await pomResult();
    expect(sent.filter((m) => m.type === 'RECORDED_ACTION')).toEqual([]);
    send({ type: 'STOP_RECORDING' });
  });

  it('a page without a body cannot be scanned', () => {
    const body = document.body;
    body.remove();
    try {
      expect(send({ type: 'POM_SCAN' })).toEqual({ ok: false, error: 'this page has no body to scan' });
      expect(send({ type: 'POM_PICK_START' })).toEqual({ ok: false });
    } finally {
      document.documentElement.appendChild(body);
    }
  });

  it('an orphaned instance sends no result', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      document.body.innerHTML = Array.from({ length: 30 }, (_, i) => `<button>B${i}</button>`).join('');
      send({ type: 'POM_SCAN' });
      delete globalThis.chrome.runtime.id; // context gone mid-scan
      await vi.advanceTimersByTimeAsync(50);
      expect(sent.filter((m) => m.type === 'POM_RESULT')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
