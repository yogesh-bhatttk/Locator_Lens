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
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
    for (const id of [
      'inspectBtn',
      'statusDot',
      'btnIcon',
      'btnText',
      'hintRow',
      'panelBtn',
      'popupMsg',
      'inspectKey',
      'recordKey',
      'settingsBtn',
    ]) {
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

describe('degraded environments and failures', () => {
  const msgText = () => document.getElementById('popupMsg').textContent;

  it('says so when the window is not known yet, instead of opening a panel somewhere else', async () => {
    const getCurrent = globalThis.chrome.windows.getCurrent;
    globalThis.chrome.windows.getCurrent = (cb) => cb(undefined);
    try {
      open();
      calls.length = 0;
      document.getElementById('panelBtn').click();
      await flush();
      expect(calls).toEqual([]);
      expect(msgText()).toMatch(/window not resolved yet/);
      expect(panelLabel()).toContain('Open');
      // Without a window the worker is asked without one (it falls back itself).
      expect(sent).toContainEqual({ type: 'GET_INSPECT_STATE' });
    } finally {
      globalThis.chrome.windows.getCurrent = getCurrent;
    }
  });

  it('works without chrome.windows at all', () => {
    const windows = globalThis.chrome.windows;
    delete globalThis.chrome.windows;
    try {
      vm.runInThisContext('popupWindowId = null;');
      open();
      expect(sent).toContainEqual({ type: 'GET_PANEL_STATE' });
    } finally {
      globalThis.chrome.windows = windows;
    }
  });

  it('a browser with no side-panel API gets an explanation', async () => {
    const sidePanel = globalThis.chrome.sidePanel;
    delete globalThis.chrome.sidePanel;
    try {
      open();
      document.getElementById('panelBtn').click();
      await flush();
      expect(msgText()).toMatch(/no side panel API/);
    } finally {
      globalThis.chrome.sidePanel = sidePanel;
    }
  });

  it('an open() that throws synchronously is reported, and inspect still starts', async () => {
    sidePanelResult = () => {
      throw new Error('sync boom');
    };
    open();
    document.getElementById('panelBtn').click();
    await flush();
    expect(msgText()).toMatch(/Couldn't open the results panel: sync boom/);
    document.getElementById('inspectBtn').click();
    await flush();
    expect(btnText()).toBe('Stop Inspecting');
    expect(types()).toContain('START_INSPECT');
  });

  it('a close() that throws or rejects is reported and the label stays', async () => {
    responders.GET_PANEL_STATE = { active: true };
    globalThis.chrome.sidePanel.close = () => {
      throw new Error('close boom');
    };
    open();
    document.getElementById('panelBtn').click();
    await flush();
    expect(msgText()).toMatch(/Couldn't close the results panel: close boom/);
    expect(panelLabel()).toContain('Close');
    globalThis.chrome.sidePanel.close = () => Promise.reject(new Error('later boom'));
    document.getElementById('panelBtn').click();
    await flush();
    expect(msgText()).toMatch(/later boom/);
  });

  it('a worker that is unreachable while loading state leaves the defaults', () => {
    responders.GET_INSPECT_STATE = { active: true };
    responders.GET_PANEL_STATE = { active: true };
    const rt = globalThis.chrome.runtime;
    const realSend = rt.sendMessage;
    rt.sendMessage = (msg, cb) => {
      sent.push(msg);
      rt.lastError = { message: 'Could not establish connection.' };
      try {
        if (cb) cb(undefined);
      } finally {
        rt.lastError = null;
      }
    };
    try {
      open();
      expect(btnText()).toBe('Start Inspecting');
      expect(panelLabel()).toContain('Open');
      // …and a failed START_INSPECT says why, with the browser's message.
      document.getElementById('inspectBtn').click();
      expect(btnText()).toBe('Start Inspecting');
      expect(msgText()).toMatch(/Couldn't start inspecting: Could not establish connection/);
    } finally {
      rt.sendMessage = realSend;
    }
  });

  it('stopping swallows a dead worker quietly', () => {
    responders.STOP_INSPECT = { ok: true };
    responders.GET_INSPECT_STATE = { active: true };
    open();
    document.getElementById('inspectBtn').click();
    expect(types()).toContain('STOP_INSPECT');
    expect(btnText()).toBe('Start Inspecting');
  });

  it('a missing message area never throws', () => {
    responders.START_INSPECT = { ok: false, error: 'nope' };
    open();
    document.getElementById('popupMsg').remove();
    expect(() => document.getElementById('inspectBtn').click()).not.toThrow();
  });

  it('ignores untyped messages', () => {
    open();
    expect(() => messageListeners.forEach((fn) => fn(null, {}))).not.toThrow();
    expect(() => messageListeners.forEach((fn) => fn({ type: 3 }, {}))).not.toThrow();
  });

  it("treats this extension's own page opened as a tab as a UI sender, not a page", () => {
    globalThis.chrome.runtime.getURL = (p) => 'chrome-extension://abc/' + p;
    try {
      responders.GET_INSPECT_STATE = { active: true };
      open();
      messageListeners.forEach((fn) =>
        fn(
          { type: 'STOP_INSPECT', windowId: WINDOW },
          { tab: { id: 1 }, url: 'chrome-extension://abc/src/sidepanel.html' }
        )
      );
      expect(btnText()).toBe('Start Inspecting');
      messageListeners.forEach((fn) =>
        fn({ type: 'START_INSPECT', windowId: WINDOW }, { tab: { id: 1 }, url: 'https://page.example/' })
      );
      expect(btnText()).toBe('Start Inspecting');
    } finally {
      delete globalThis.chrome.runtime.getURL;
    }
  });
});

describe('keyboard-shortcut hints', () => {
  const hint = (id) => document.getElementById(id);
  afterEach(() => {
    delete globalThis.chrome.commands;
    globalThis.chrome.runtime.lastError = null;
  });

  it('shows the keys the user has now, next to Inspect and Record', () => {
    let calls = 0;
    globalThis.chrome.commands = {
      getAll: (cb) => {
        calls++;
        cb([
          { name: '_execute_action', shortcut: 'Ctrl+Shift+L' },
          { name: 'toggle-inspect', shortcut: 'Alt+Shift+E', description: 'Start or stop inspecting' },
          { name: 'toggle-recording', shortcut: ' ⌥⇧K ' },
        ]);
      },
    };
    open();
    expect(calls).toBe(1);
    expect(hint('inspectKey').hidden).toBe(false);
    expect(hint('inspectKey').textContent).toBe('Alt+Shift+E');
    expect(hint('recordKey').hidden).toBe(false);
    expect(hint('recordKey').textContent).toBe('⌥⇧K');
    // The button's own label is untouched.
    expect(btnText()).toBe('Start Inspecting');
  });

  it('shows nothing for a command with no key bound (the user cleared it, or Chrome did not assign it)', () => {
    globalThis.chrome.commands = {
      getAll: (cb) => cb([{ name: 'toggle-inspect', shortcut: '' }, { name: 'toggle-recording' }]),
    };
    open();
    expect(hint('inspectKey').hidden).toBe(true);
    expect(hint('inspectKey').textContent).toBe('');
    expect(hint('recordKey').hidden).toBe(true);
  });

  it('stays hidden without the commands API, on an error, a bad answer, or a throw', () => {
    open(); // no chrome.commands
    expect(hint('inspectKey').hidden).toBe(true);
    globalThis.chrome.commands = {
      getAll: (cb) => {
        globalThis.chrome.runtime.lastError = { message: 'nope' };
        cb(undefined);
        globalThis.chrome.runtime.lastError = null;
      },
    };
    open();
    expect(hint('inspectKey').hidden).toBe(true);
    globalThis.chrome.commands = { getAll: (cb) => cb({ not: 'an array' }) };
    open();
    expect(hint('inspectKey').hidden).toBe(true);
    globalThis.chrome.commands = { getAll: (cb) => cb([null, { name: 'toggle-inspect', shortcut: 7 }]) };
    open();
    expect(hint('inspectKey').hidden).toBe(true);
    globalThis.chrome.commands = {
      getAll: () => {
        throw new Error('boom');
      },
    };
    expect(() => open()).not.toThrow();
  });

  it('a markup without the hint elements is fine', () => {
    hint('recordKey').remove();
    globalThis.chrome.commands = {
      getAll: (cb) => cb([{ name: 'toggle-recording', shortcut: 'Alt+Shift+K' }]),
    };
    expect(() => open()).not.toThrow();
  });
});

describe('the ⚙ Settings link', () => {
  const settings = () => document.getElementById('settingsBtn');
  afterEach(() => {
    delete globalThis.chrome.runtime.openOptionsPage;
    globalThis.chrome.runtime.lastError = null;
  });

  it('is a labelled button that opens the extension’s settings page', () => {
    let opened = 0;
    globalThis.chrome.runtime.openOptionsPage = (cb) => {
      opened++;
      cb();
    };
    open();
    expect(settings().tagName).toBe('BUTTON');
    expect(settings().textContent.trim()).toBe('⚙ Settings');
    settings().click();
    expect(opened).toBe(1);
    expect(document.getElementById('popupMsg').hidden).toBe(true);
  });

  it('says why when the browser cannot open it', () => {
    const msg = () => document.getElementById('popupMsg');
    globalThis.chrome.runtime.openOptionsPage = (cb) => {
      globalThis.chrome.runtime.lastError = { message: 'Could not create an options page.' };
      cb();
      globalThis.chrome.runtime.lastError = null;
    };
    open();
    settings().click();
    expect(msg().hidden).toBe(false);
    expect(msg().textContent).toBe("Couldn't open the settings: Could not create an options page.");
    expect(msg().classList.contains('error')).toBe(true);

    globalThis.chrome.runtime.openOptionsPage = () => {
      throw new Error('blocked');
    };
    settings().click();
    expect(msg().textContent).toBe("Couldn't open the settings: blocked");

    delete globalThis.chrome.runtime.openOptionsPage;
    settings().click();
    expect(msg().textContent).toBe("Couldn't open the settings: this browser has no settings page API");
  });

  it('a markup without the link is fine', () => {
    settings().remove();
    expect(() => open()).not.toThrow();
  });
});
