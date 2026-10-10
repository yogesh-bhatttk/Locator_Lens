// @vitest-environment jsdom
//
// C9.1 · altTargets through the content script: every recorded step with a target,
// every pick, every Page Object element and every health-check suggestion carries
// the engine's simple alternatives (≤ 3, best first) — framed and shadow-pathed
// exactly like the primary target, each resolving to the same single element —
// and never one that spells out a secret. Plus the `xpath` target kind in replay
// and in the health check, with and without the engine's resolveTarget.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_SCRIPTS = ['src/codegen.js', 'src/content-locator-engine.js', 'src/content.js'];
const SOURCES = CONTENT_SCRIPTS.map((file) => [file, readFileSync(join(ROOT, file), 'utf8')]);

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

function load(storage = {}) {
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
      local: { get: (keys, cb) => cb(storage) },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  };
  delete globalThis.__LocatorLensEngine;
  delete globalThis.LLCodegen;
  for (const [file, src] of SOURCES) vm.runInThisContext(src, { filename: file });
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
      sendMessage: (msg) => frameSent.push(msg),
      onMessage: { addListener: (fn) => frameHandlers.push(fn), removeListener: () => {} },
    },
    storage: { local: { get: (k, cb) => cb({}) }, onChanged: { addListener: () => {} } },
  };
  // runInContext (not w.eval) so coverage attributes the frame's run to src/.
  for (const [file, src] of SOURCES) vm.runInContext(src, w, { filename: file });
  const frameSend = (msg) => {
    let response;
    for (const h of frameHandlers) h(msg, {}, (r) => (response = r));
    return response;
  };
  return { w, frameSend, frameSent };
}

function send(msg) {
  let response;
  for (const h of handlers) h(msg, {}, (r) => (response = r));
  return response;
}

const E = () => globalThis.__LocatorLensEngine;
const recorded = (box = sent) => box.filter((m) => m.type === 'RECORDED_ACTION').map((m) => m.data);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const health = (items) => globalThis.__LocatraHealthCheck(items);

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
  el.dispatchEvent(new window.Event('change', { bubbles: true, composed: true }));
}

/** Every alternative resolves (from the top document) to `el` alone. */
function expectAltsResolveTo(alts, el) {
  expect(alts.length).toBeGreaterThan(0);
  expect(alts.length).toBeLessThanOrEqual(3);
  for (const t of alts) expect(E().resolveTarget(t)).toEqual([el]);
}

/** The frame wrappers of a target, without the inner target (or the primary's match count). */
function frameLevels(t) {
  const out = [];
  while (t && t.kind === 'frame') {
    // eslint-disable-next-line no-unused-vars
    const { child, matchCount, unique, ...level } = t;
    out.push(level);
    t = child;
  }
  return out;
}

const LOGIN =
  '<form><input id="username" name="user" aria-label="Username or Email">' +
  '<input type="password" id="pw" aria-label="Password"></form>';
const LOGIN_ALTS = [
  { kind: 'id', value: 'username' },
  { kind: 'name', value: 'user' },
  { kind: 'xpath', value: '//input[@aria-label="Username or Email"]' },
];

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  load();
});

afterEach(() => {
  stopAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete document.elementFromPoint;
});

describe('recorded steps carry altTargets', () => {
  it('click on (a): id, name and aria-label XPath, all resolving to the field', () => {
    document.body.innerHTML = LOGIN;
    send({ type: 'START_RECORDING' });
    const el = document.getElementById('username');
    pointer(el);
    const step = recorded().find((s) => s.action === 'click');
    expect(step.target).toMatchObject({ kind: 'role', role: 'textbox', name: 'Username or Email' });
    expect(step.altTargets).toEqual(LOGIN_ALTS);
    expectAltsResolveTo(step.altTargets, el);
  });

  it('click on (b): a bare button gets its CSS and text XPath', () => {
    document.body.innerHTML = '<div><p>Profile</p><button>Save</button></div>';
    send({ type: 'START_RECORDING' });
    const el = document.querySelector('button');
    pointer(el);
    const step = recorded().find((s) => s.action === 'click');
    expect(step.altTargets).toEqual([
      { kind: 'css', value: 'button' },
      { kind: 'xpath', value: '//button[normalize-space(.)="Save"]' },
    ]);
    expectAltsResolveTo(step.altTargets, el);
  });

  it('fill (a sensitive one included) — never the typed value', () => {
    document.body.innerHTML = LOGIN;
    send({ type: 'START_RECORDING' });
    const user = document.getElementById('username');
    user.value = 'alice@example.com';
    change(user);
    const pw = document.getElementById('pw');
    pw.value = 'hunter22';
    change(pw);
    const [fUser, fPw] = recorded().filter((s) => s.action === 'fill');
    expect(fUser.altTargets).toEqual(LOGIN_ALTS);
    expect(fPw.sensitive).toBe(true);
    expect(fPw.altTargets).toEqual([
      { kind: 'id', value: 'pw' },
      { kind: 'xpath', value: '//input[@aria-label="Password"]' },
    ]);
    expectAltsResolveTo(fPw.altTargets, pw);
    expect(JSON.stringify(recorded().map((s) => s.altTargets))).not.toMatch(/hunter22|alice@example/);
    expect(JSON.stringify(recorded())).not.toContain('hunter22');
  });

  it('selectOption and check', () => {
    document.body.innerHTML =
      '<label>Country <select name="country"><option>Nepal</option><option>India</option></select></label>' +
      '<label><input type="checkbox" name="tos"> I agree</label>';
    send({ type: 'START_RECORDING' });
    const select = document.querySelector('select');
    select.selectedIndex = 1;
    change(select);
    const box = document.querySelector('[type=checkbox]');
    box.checked = true;
    change(box);
    const sel = recorded().find((s) => s.action === 'selectOption');
    const chk = recorded().find((s) => s.action === 'check');
    expect(sel.altTargets[0]).toEqual({ kind: 'name', value: 'country' });
    expectAltsResolveTo(sel.altTargets, select);
    expect(chk.altTargets[0]).toEqual({ kind: 'name', value: 'tos' });
    expectAltsResolveTo(chk.altTargets, box);
  });

  it('an assertion, a hover and a double-click', () => {
    document.body.innerHTML = '<button>Save</button><button>Cancel</button>';
    send({ type: 'START_RECORDING' });
    const save = document.querySelector('button');
    send({ type: 'SET_ASSERT_MODE', on: true, assertType: 'toBeVisible' });
    pointer(save);
    send({ type: 'SET_ASSERT_MODE', on: false });
    pointer(save, { altKey: true });
    save.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, composed: true }));
    const want = [{ kind: 'xpath', value: '//button[normalize-space(.)="Save"]' }];
    for (const action of ['assert', 'hover', 'dblclick']) {
      const step = recorded().find((s) => s.action === action);
      expect(step.altTargets).toEqual(want);
    }
  });

  it('an upload', () => {
    document.body.innerHTML = '<label>Avatar <input type="file" name="avatar"></label><input type="file">';
    send({ type: 'START_RECORDING' });
    const file = document.querySelector('[name=avatar]');
    change(file);
    const step = recorded().find((s) => s.action === 'upload');
    expect(step.altTargets[0]).toEqual({ kind: 'name', value: 'avatar' });
    expectAltsResolveTo(step.altTargets, file);
  });

  it('none when the primary is already simple, and none on a target-less step', () => {
    document.body.innerHTML = '<button data-testid="save">Save</button><input aria-label="q">';
    send({ type: 'START_RECORDING' });
    pointer(document.querySelector('button'));
    document
      .querySelector('input')
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const click = recorded().find((s) => s.action === 'click');
    expect(click.target.kind).toBe('testid');
    expect('altTargets' in click).toBe(false);
    const press = recorded().find((s) => s.action === 'press');
    expect('altTargets' in press).toBe(false);
  });

  it('the fallback locator (engine failed) has none', () => {
    document.body.innerHTML = '<button>Save</button>';
    send({ type: 'START_RECORDING' });
    E().generateLocators = () => {
      throw new Error('boom');
    };
    pointer(document.querySelector('button'));
    const step = recorded().find((s) => s.action === 'click');
    expect(step.target.kind).toBe('css');
    expect('altTargets' in step).toBe(false);
  });

  it('one pointerdown generates candidates once and evaluates one XPath', () => {
    document.body.innerHTML = LOGIN;
    send({ type: 'START_RECORDING' });
    const gen = vi.spyOn(E(), 'generateLocators');
    const evaluate = vi.spyOn(document, 'evaluate');
    pointer(document.getElementById('username'));
    expect(gen).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(recorded().find((s) => s.action === 'click').altTargets).toHaveLength(3);
  });
});

describe('frames and shadow DOM', () => {
  it('a step in an iframe: every alternative is wrapped in exactly the primary’s frames', () => {
    document.body.innerHTML = '<iframe id="payment-frame" title="Payment details"></iframe>';
    const frame = document.getElementById('payment-frame');
    const { w, frameSend, frameSent } = loadIntoFrame(frame);
    w.document.body.innerHTML =
      '<label for="card">Card number</label>' +
      '<input id="card" name="card" inputmode="numeric" placeholder="4242 4242 4242 4242">' +
      '<button type="button" data-testid="pay-now">Pay now</button>';
    frameSend({ type: 'START_RECORDING' });
    const card = w.document.getElementById('card');
    pointer(card);
    const step = recorded(frameSent).find((s) => s.action === 'click');
    expect(step.target).toMatchObject({ kind: 'frame', selector: '#payment-frame', child: { kind: 'role' } });
    expect(step.altTargets.map((t) => t.child)).toEqual([
      { kind: 'id', value: 'card' },
      { kind: 'name', value: 'card' },
      { kind: 'xpath', value: '//input[@placeholder="4242 4242 4242 4242"]' },
    ]);
    for (const t of step.altTargets) expect(frameLevels(t)).toEqual(frameLevels(step.target));
    expectAltsResolveTo(step.altTargets, card);
    frameSend({ type: 'STOP_RECORDING' });
  });

  it('a pick in an iframe carries framed altTargets', () => {
    document.body.innerHTML = '<iframe id="pay"></iframe>';
    const { w, frameSend, frameSent } = loadIntoFrame(document.getElementById('pay'));
    w.document.body.innerHTML = '<button>Pay now</button><button>Back</button>';
    frameSend({ type: 'START_INSPECT' });
    const btn = w.document.querySelector('button');
    w.document.elementFromPoint = () => btn;
    btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    frameSend({ type: 'STOP_INSPECT' });
    const data = frameSent.find((m) => m.type === 'ELEMENT_PICKED').data;
    expect(data.altTargets).toEqual([
      {
        kind: 'frame',
        selector: '#pay',
        index: 0,
        framesIndex: 0,
        child: { kind: 'xpath', value: '//button[normalize-space(.)="Pay now"]' },
      },
    ]);
    expectAltsResolveTo(data.altTargets, btn);
  });

  it('a step in a shadow root: alternatives carry the same shadowHosts/shadowCss, and no XPath', () => {
    document.body.innerHTML = '<x-login id="login"></x-login>';
    const sr = document.getElementById('login').attachShadow({ mode: 'open' });
    sr.innerHTML = '<input id="user" aria-label="User name"><button>Go</button>';
    send({ type: 'START_RECORDING' });
    const input = sr.getElementById('user');
    pointer(input);
    const step = recorded().find((s) => s.action === 'click');
    expect(step.target).toMatchObject({ kind: 'role', shadowHosts: ['#login'], shadowCss: '#user' });
    expect(step.altTargets).toEqual([
      { kind: 'id', value: 'user', shadowHosts: ['#login'], shadowCss: '#user' },
    ]);
    expectAltsResolveTo(step.altTargets, input);
    pointer(sr.querySelector('button'));
    const go = recorded().filter((s) => s.action === 'click')[1];
    expect(JSON.stringify(go.altTargets || [])).not.toContain('xpath');
  });
});

describe('picks, page objects and health suggestions', () => {
  it('ELEMENT_PICKED data.altTargets', () => {
    document.body.innerHTML = LOGIN;
    const el = document.getElementById('username');
    send({ type: 'START_INSPECT' });
    document.elementFromPoint = () => el;
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    send({ type: 'STOP_INSPECT' });
    const data = sent.find((m) => m.type === 'ELEMENT_PICKED').data;
    expect(data.altTargets).toEqual(LOGIN_ALTS);
    expectAltsResolveTo(data.altTargets, el);
  });

  it('a pick whose primary is simple has none', () => {
    document.body.innerHTML = '<div id="panel"></div>';
    const el = document.getElementById('panel');
    send({ type: 'START_INSPECT' });
    document.elementFromPoint = () => el;
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    send({ type: 'STOP_INSPECT' });
    expect('altTargets' in sent.find((m) => m.type === 'ELEMENT_PICKED').data).toBe(false);
  });

  it('a pick with alternatives but no locator to go with them has none', () => {
    document.body.innerHTML = '<button>Go</button>';
    const el = document.querySelector('button');
    E().generateLocators = () => ({
      elementData: {},
      locators: [],
      altTargets: [{ kind: 'css', value: 'button' }],
    });
    send({ type: 'START_INSPECT' });
    document.elementFromPoint = () => el;
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    send({ type: 'STOP_INSPECT' });
    expect('altTargets' in sent.find((m) => m.type === 'ELEMENT_PICKED').data).toBe(false);
  });

  it('Page Object elements', async () => {
    document.body.innerHTML = LOGIN + '<button data-testid="go">Go</button>';
    expect(send({ type: 'POM_SCAN' })).toEqual({ ok: true });
    let data = null;
    for (let i = 0; i < 100 && !data; i++) {
      const hit = sent.find((m) => m.type === 'POM_RESULT');
      if (hit) data = hit.data;
      else await tick(10);
    }
    const user = data.elements.find((e) => e.target.kind === 'role' && e.target.name === 'Username or Email');
    expect(user.altTargets).toEqual(LOGIN_ALTS);
    expectAltsResolveTo(user.altTargets, document.getElementById('username'));
    const go = data.elements.find((e) => e.target.kind === 'testid');
    expect('altTargets' in go).toBe(false);
  });

  it('a health suggestion carries verified alternatives', () => {
    document.body.innerHTML =
      '<form><label for="em">Email address</label><input id="em" name="email" type="email"></form>' +
      '<input id="other" name="other" type="email">';
    const [res] = health([
      {
        id: 'w1',
        target: { kind: 'testid', attr: 'data-testid', value: 'email-input' },
        fingerprint: {
          tag: 'input',
          id: 'em',
          testId: 'email-input',
          testAttr: 'data-testid',
          role: 'textbox',
          name: 'email',
          label: 'Email address',
          type: 'email',
          classes: [],
        },
      },
    ]);
    expect(res.suggestion.target).toMatchObject({ kind: 'role', name: 'Email address' });
    expect(res.suggestion.altTargets).toEqual([
      { kind: 'id', value: 'em' },
      { kind: 'name', value: 'email' },
    ]);
    expectAltsResolveTo(res.suggestion.altTargets, document.getElementById('em'));
  });

  it('a health suggestion drops an alternative that does not resolve here, and frames the rest', () => {
    document.body.innerHTML = '<iframe id="f"></iframe>';
    const { w } = loadIntoFrame(document.getElementById('f'));
    w.document.body.innerHTML = '<button id="buy">Pay now</button>';
    const realGen = w.__LocatorLensEngine.generateLocators;
    w.__LocatorLensEngine.generateLocators = (el, attrs) => {
      const r = realGen(el, attrs);
      r.altTargets = r.altTargets.concat({ kind: 'css', value: 'nope' });
      return r;
    };
    const [res] = w.__LocatraHealthCheck([
      {
        id: 'h',
        target: {
          kind: 'frame',
          selector: '#f',
          index: 0,
          child: { kind: 'role', role: 'button', name: 'Buy' },
        },
        fingerprint: { tag: 'button', id: 'buy', role: 'button', label: 'Buy', text: 'Buy', classes: [] },
      },
    ]);
    expect(res.status).toBe('broken');
    expect(res.suggestion.altTargets).toEqual([
      { kind: 'frame', selector: '#f', index: 0, child: { kind: 'id', value: 'buy' } },
      {
        kind: 'frame',
        selector: '#f',
        index: 0,
        child: { kind: 'xpath', value: '//button[normalize-space(.)="Pay now"]' },
      },
    ]);
    expectAltsResolveTo(res.suggestion.altTargets, w.document.getElementById('buy'));
  });
});

describe('suggested assertions never carry a secret in an alternative', () => {
  function startWithForm() {
    document.body.innerHTML =
      '<form id="f"><label>Password <input type="password" id="pw"></label><button>Log in</button></form>';
    const form = document.getElementById('f');
    form.addEventListener('submit', (e) => e.preventDefault());
    send({ type: 'START_RECORDING' });
    sent.length = 0;
    document.getElementById('pw').value = 'hunter22';
    return form;
  }
  const suggestions = () => recorded().filter((s) => s.suggested);

  it('keeps only the alternatives that do not spell it out (or none)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const form = startWithForm();
    let alts = [
      { kind: 'xpath', value: '//div[normalize-space(.)="hunter22 rejected"]' },
      { kind: 'css', value: 'div.toast' },
    ];
    E().generateLocators = () => ({
      elementData: {},
      locators: [
        { code: "page.getByText('hunter22 rejected')", target: { kind: 'text', value: 'hunter22 rejected' } },
        { code: "page.getByRole('status')", target: { kind: 'role', role: 'status' } },
      ],
      altTargets: alts,
    });
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    document.body.insertAdjacentHTML('beforeend', '<div class="toast" role="status">hunter22 rejected</div>');
    await vi.advanceTimersByTimeAsync(200);
    const [s] = suggestions();
    expect(s.target).toEqual({ kind: 'role', role: 'status' });
    expect(s.altTargets).toEqual([{ kind: 'css', value: 'div.toast' }]);

    // Every alternative leaks: none at all.
    alts = [{ kind: 'xpath', value: '//div[.="hunter22"]' }];
    const form2 = startWithForm();
    form2.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    document.body.insertAdjacentHTML('beforeend', '<div class="toast" role="status">hunter22 again</div>');
    await vi.advanceTimersByTimeAsync(200);
    const [s2] = suggestions();
    expect(s2.target).toEqual({ kind: 'role', role: 'status' });
    expect('altTargets' in s2).toBe(false);
    expect(JSON.stringify(suggestions().map((x) => x.altTargets))).not.toContain('hunter22');
  });
});

describe('the xpath target kind in replay and health', () => {
  const replay = (step) =>
    new Promise((done) => {
      const msg = { type: 'REPLAY_STEP', runId: 'r', index: 0, step, timeoutMs: 300, highlight: false };
      handlers.forEach((h) => h(msg, {}, done));
    });

  it('replays a click on an xpath target', async () => {
    document.body.innerHTML = '<button>Save</button><button>Cancel</button>';
    const clicks = [];
    document.querySelector('button').addEventListener('click', () => clicks.push('save'));
    const res = await replay({
      action: 'click',
      target: { kind: 'xpath', value: '//button[normalize-space(.)="Save"]' },
    });
    expect(res).toEqual({ ok: true, matchCount: 1 });
    expect(clicks).toEqual(['save']);
  });

  it('health-checks xpath targets: ok, ambiguous, broken, and an invalid one', () => {
    document.body.innerHTML = '<button>Save</button><button>Cancel</button>';
    const out = health([
      { id: 'a', target: { kind: 'xpath', value: '//button[normalize-space(.)="Save"]' } },
      { id: 'b', target: { kind: 'xpath', value: '//button' } },
      { id: 'c', target: { kind: 'xpath', value: '//a' } },
      { id: 'd', target: { kind: 'xpath', value: '//button[' } },
    ]);
    expect(out.map((r) => r.status)).toEqual(['ok', 'ambiguous', 'broken', 'error']);
    expect(out[3].error).toMatch(/cannot evaluate/);
  });

  it('an engine without resolveTarget still resolves xpath (local fallback)', async () => {
    document.body.innerHTML = '<button>Save</button><button>Cancel</button>';
    delete E().resolveTarget;
    const out = health([
      { id: 'a', target: { kind: 'xpath', value: '//button[normalize-space(.)="Cancel"]' } },
      { id: 'b', target: { kind: 'xpath', value: '//button/text()' } },
      { id: 'c', target: { kind: 'xpath', value: '//button[' } },
    ]);
    expect(out.map((r) => [r.status, r.count])).toEqual([
      ['ok', 1],
      ['broken', 0],
      ['error', 0],
    ]);
    const res = await replay({ action: 'click', target: { kind: 'xpath', value: '//button[2]' } });
    expect(res).toEqual({ ok: true, matchCount: 1 });
  });
});

describe('quick copy prefers the simple alternative outside Playwright (C9.2)', () => {
  let copied;
  beforeEach(() => {
    copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t) => (copied.push(t), Promise.resolve()) },
    });
  });
  afterEach(() => {
    delete navigator.clipboard;
  });

  it('a pick copies By.ID for Selenium, the role locator for Playwright', async () => {
    load({ llFramework: 'selenium', llLanguage: 'python' });
    document.body.innerHTML = LOGIN;
    const el = document.getElementById('username');
    send({ type: 'START_INSPECT' });
    document.elementFromPoint = () => el;
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await tick();
    expect(copied).toEqual([
      globalThis.LLCodegen.locatorExpr({ kind: 'id', value: 'username' }, 'selenium', 'python'),
    ]);

    load({ llFramework: 'playwright', llLanguage: 'typescript' });
    document.body.innerHTML = LOGIN;
    const again = document.getElementById('username');
    send({ type: 'START_INSPECT' });
    document.elementFromPoint = () => again;
    again.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await tick();
    expect(copied[1]).toBe("page.getByRole('textbox', { name: 'Username or Email' })");
  });

  it('the context-menu copy does the same, and its pick carries the alternatives', async () => {
    load({ llFramework: 'cypress', llLanguage: 'javascript' });
    document.body.innerHTML = LOGIN + '<button data-testid="go">Go</button>';
    send({ type: 'START_INSPECT' });
    const el = document.getElementById('username');
    document.elementFromPoint = () => el;
    el.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
    expect(send({ type: 'CONTEXT_MENU_COPY' })).toEqual({ ok: true });
    await tick();
    expect(copied).toEqual([
      globalThis.LLCodegen.locatorExpr({ kind: 'id', value: 'username' }, 'cypress', 'javascript'),
    ]);
    const picked = sent.filter((m) => m.type === 'ELEMENT_PICKED').map((m) => m.data);
    expect(picked.at(-1).altTargets).toEqual(LOGIN_ALTS);

    // A simple primary: nothing to prefer, nothing attached.
    const go = document.querySelector('[data-testid=go]');
    document.elementFromPoint = () => go;
    go.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
    send({ type: 'CONTEXT_MENU_COPY' });
    await tick();
    const last = sent.filter((m) => m.type === 'ELEMENT_PICKED').at(-1).data;
    expect(last.locators[0].target.kind).toBe('testid');
    expect('altTargets' in last).toBe(false);
    send({ type: 'STOP_INSPECT' });
  });
});
