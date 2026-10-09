// @vitest-environment jsdom
//
// popup.js is the launcher: two buttons, and state it has to keep in step with a
// service worker that may have been evicted since the popup last opened. It was the
// only source file with no coverage at all.
//
// Like the side panel, it is a classic script whose declarations land on the global
// object, so the real shipping file is evaluated once in this jsdom context behind a
// chrome stub, and each test re-mounts the real markup and re-fires DOMContentLoaded.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let sent; // every runtime.sendMessage the popup makes
let responders; // type -> canned response, as the worker would answer
let messageListeners;
let calls; // ordered log of side-panel API calls and messages, to check the gesture path
let sidePanelResult; // () => promise returned by chrome.sidePanel.open/close

const WINDOW = 7;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeAll(() => {
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => {
        sent.push(msg);
        calls.push(`send:${msg.type}`);
        if (cb && responders[msg.type]) cb(responders[msg.type]);
      },
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      getManifest: () => ({ version: '1.3.0' }),
    },
    windows: {
      getCurrent: (cb) => cb({ id: WINDOW }),
    },
    sidePanel: {
      open: (arg) => {
        calls.push(`open:${JSON.stringify(arg)}`);
        return sidePanelResult();
      },
    },
  };
  vm.runInThisContext(readFileSync(join(ROOT, 'src/popup.js'), 'utf8'), { filename: 'popup.js' });
});

/** The real popup markup, minus its script tag. */
function mountPopup() {
  const html = readFileSync(join(ROOT, 'src/popup.html'), 'utf8');
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  document.body.innerHTML = (body ? body[1] : '').replace(/<script[\s\S]*?<\/script>/gi, '');
}

function open() {
  document.dispatchEvent(new window.Event('DOMContentLoaded'));
}

const types = () => sent.map((m) => m.type);
const btnText = () => document.getElementById('btnText').textContent;
const panelLabel = () => document.querySelectorAll('#panelBtn span')[1]?.textContent;

beforeEach(() => {
  sent = [];
  responders = {};
  messageListeners = [];
  calls = [];
  sidePanelResult = () => Promise.resolve();
  delete globalThis.chrome.sidePanel.close;
  mountPopup();
  // popup.js is evaluated once, so its top-level state survives between tests.
  // These are global lexical bindings, assignable from the same realm.
  vm.runInThisContext('isInspecting = false; panelOpen = false; popupWindowId = null;');
});

describe('markup contract', () => {
  it('has every element popup.js reaches for', () => {
    for (const id of ['inspectBtn', 'statusDot', 'btnIcon', 'btnText', 'hintRow', 'panelBtn', 'popupMsg']) {
      expect(document.getElementById(id), id).not.toBeNull();
    }
    // openPanel() addresses the label as the second <span> of the button.
    expect(document.querySelectorAll('#panelBtn span').length).toBeGreaterThanOrEqual(2);
  });
});

describe('version display', () => {
  // The subtitle used to hardcode a version string ("v1.1.6") that nothing in the
  // build kept in step with package.json/the manifests, and it silently fell behind.
  // Reading it from chrome.runtime.getManifest() at open time means it can't go stale.
  it('shows the real extension version from the manifest, not a hardcoded string', () => {
    open();
    expect(document.getElementById('brandSub').textContent).toBe('Smart locators · v1.3.0');
  });
});

describe('opening the popup', () => {
  it('asks the worker for both pieces of state it renders, for its own window', () => {
    open();
    expect(sent).toContainEqual({ type: 'GET_INSPECT_STATE', windowId: WINDOW });
    expect(sent).toContainEqual({ type: 'GET_PANEL_STATE', windowId: WINDOW });
  });

  it('shows the idle state when nothing is active', () => {
    open();
    expect(btnText()).toBe('Start Inspecting');
    expect(document.getElementById('btnIcon').textContent).toBe('🎯');
    // The hint starts hidden via the .hint-row rule; the popup must not reveal it.
    expect(document.getElementById('hintRow').style.display).not.toBe('block');
    expect(document.getElementById('inspectBtn').classList.contains('active')).toBe(false);
  });

  it('restores the inspecting state for a page that is still inspecting', () => {
    // The worker keeps this in storage.session precisely so a reopened popup agrees
    // with the crosshair still showing on the page.
    responders.GET_INSPECT_STATE = { active: true };
    open();
    expect(btnText()).toBe('Stop Inspecting');
    expect(document.getElementById('inspectBtn').classList.contains('active')).toBe(true);
    expect(document.getElementById('statusDot').classList.contains('active')).toBe(true);
  });

  it('offers to close the panel when one is already open', () => {
    responders.GET_PANEL_STATE = { active: true };
    open();
    expect(panelLabel()).toContain('Close');
  });

  it('offers to open the panel when none is', () => {
    open();
    expect(panelLabel()).toContain('Open');
  });
});

describe('the inspect button', () => {
  it('starts inspecting and reflects it immediately', () => {
    open();
    sent.length = 0;
    document.getElementById('inspectBtn').click();
    expect(sent).toEqual([{ type: 'START_INSPECT', windowId: WINDOW }]);
    expect(btnText()).toBe('Stop Inspecting');
  });

  // The worker used to open the panel after an async tab query, by which point the
  // click's user gesture was gone and open() was rejected (C8).
  it('opens the panel inside the click itself, before asking the worker to inspect', async () => {
    open();
    calls.length = 0;
    document.getElementById('inspectBtn').click();
    expect(calls).toEqual([`open:{"windowId":${WINDOW}}`, 'send:START_INSPECT']);
    await flush();
    expect(panelLabel()).toContain('Close');
  });

  it('goes back to idle and says why when the page refuses to be inspected', () => {
    responders.START_INSPECT = { ok: false, error: "Locatra can't run on this page." };
    open();
    document.getElementById('inspectBtn').click();
    expect(btnText()).toBe('Start Inspecting');
    const msg = document.getElementById('popupMsg');
    expect(msg.hidden).toBe(false);
    expect(msg.textContent).toMatch(/can't run on this page/);
  });

  it('stops inspecting on a second click', () => {
    open();
    document.getElementById('inspectBtn').click();
    sent.length = 0;
    document.getElementById('inspectBtn').click();
    expect(types()).toEqual(['STOP_INSPECT']);
    expect(btnText()).toBe('Start Inspecting');
  });

  it('follows a stop that came from somewhere else', () => {
    // Navigating the page makes the worker broadcast STOP_INSPECT; the popup must
    // not keep offering "Stop Inspecting" for a page that is no longer inspected.
    responders.GET_INSPECT_STATE = { active: true };
    open();
    expect(btnText()).toBe('Stop Inspecting');

    messageListeners.forEach((fn) => fn({ type: 'STOP_INSPECT' }));
    expect(btnText()).toBe('Start Inspecting');

    messageListeners.forEach((fn) => fn({ type: 'START_INSPECT' }));
    expect(btnText()).toBe('Stop Inspecting');
  });

  it("ignores another window's inspect changes, and pages' own broadcasts", () => {
    responders.GET_INSPECT_STATE = { active: true };
    open();
    messageListeners.forEach((fn) => fn({ type: 'STOP_INSPECT', windowId: WINDOW + 1 }, {}));
    expect(btnText()).toBe('Stop Inspecting');
    messageListeners.forEach((fn) => fn({ type: 'STOP_INSPECT' }, { tab: { id: 3, windowId: WINDOW + 1 } }));
    expect(btnText()).toBe('Stop Inspecting');
    messageListeners.forEach((fn) => fn({ type: 'STOP_INSPECT', windowId: WINDOW }, {}));
    expect(btnText()).toBe('Start Inspecting');
  });

  it('ignores broadcasts it has no business acting on', () => {
    open();
    expect(() => messageListeners.forEach((fn) => fn({ type: 'RECORDED_ACTION', data: {} }))).not.toThrow();
    expect(btnText()).toBe('Start Inspecting');
  });
});

describe('the panel button', () => {
  it('opens the panel itself, synchronously, and only then says "Close"', async () => {
    open();
    calls.length = 0;
    document.getElementById('panelBtn').click();
    expect(calls).toEqual([`open:{"windowId":${WINDOW}}`]); // no worker hop
    expect(panelLabel()).toContain('Open'); // not claimed before the browser agrees
    await flush();
    expect(panelLabel()).toContain('Close');
  });

  it('keeps offering "Open" and explains when the browser refuses', async () => {
    sidePanelResult = () => Promise.reject(new Error('may only be called in response to a user gesture'));
    open();
    document.getElementById('panelBtn').click();
    await flush();
    expect(panelLabel()).toContain('Open');
    expect(document.getElementById('popupMsg').textContent).toMatch(/user gesture/);
  });

  it('closes the panel with chrome.sidePanel.close where Chrome has it', async () => {
    const closed = [];
    globalThis.chrome.sidePanel.close = (arg) => {
      closed.push(arg);
      return Promise.resolve();
    };
    responders.GET_PANEL_STATE = { active: true };
    open();
    document.getElementById('panelBtn').click();
    expect(closed).toEqual([{ windowId: WINDOW }]);
    await flush();
    expect(panelLabel()).toContain('Open');
  });

  it('explains inline, without alert(), when Chrome cannot close the panel', () => {
    const alerts = [];
    window.alert = (m) => alerts.push(m);
    responders.GET_PANEL_STATE = { active: true };
    open();
    sent.length = 0;
    document.getElementById('panelBtn').click();

    expect(sent).toHaveLength(0);
    expect(alerts).toHaveLength(0);
    const msg = document.getElementById('popupMsg');
    expect(msg.hidden).toBe(false);
    expect(msg.textContent).toMatch(/can't close the side panel/i);
    expect(panelLabel()).toContain('Close');
  });

  it('opens and closes the sidebar on Firefox, where the API exists', async () => {
    const log = [];
    globalThis.browser = {
      sidebarAction: {
        open: () => {
          log.push('open');
          return Promise.resolve();
        },
        close: () => {
          log.push('close');
          return Promise.resolve();
        },
      },
    };
    try {
      open();
      document.getElementById('panelBtn').click();
      await flush();
      expect(panelLabel()).toContain('Close');
      document.getElementById('panelBtn').click();
      await flush();
      expect(log).toEqual(['open', 'close']);
      expect(panelLabel()).toContain('Open');
      expect(types()).not.toContain('OPEN_SIDE_PANEL');
      expect(types()).not.toContain('CLOSE_SIDE_PANEL');
    } finally {
      delete globalThis.browser;
    }
  });

  it("trusts Firefox's own answer about whether this window's sidebar is open", async () => {
    globalThis.browser = { sidebarAction: { isOpen: (arg) => Promise.resolve(arg.windowId === WINDOW) } };
    try {
      open();
      await flush();
      expect(panelLabel()).toContain('Close');
    } finally {
      delete globalThis.browser;
    }
  });
});
