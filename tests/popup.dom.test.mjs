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

beforeAll(() => {
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => {
        sent.push(msg);
        if (cb && responders[msg.type]) cb(responders[msg.type]);
      },
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
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
  mountPopup();
  // popup.js is evaluated once, so its top-level `isInspecting` survives between
  // tests. It is a global lexical binding, which is assignable from the same realm.
  vm.runInThisContext('isInspecting = false;');
});

describe('markup contract', () => {
  it('has every element popup.js reaches for', () => {
    for (const id of ['inspectBtn', 'statusDot', 'btnIcon', 'btnText', 'hintRow', 'panelBtn']) {
      expect(document.getElementById(id), id).not.toBeNull();
    }
    // openPanel() addresses the label as the second <span> of the button.
    expect(document.querySelectorAll('#panelBtn span').length).toBeGreaterThanOrEqual(2);
  });
});

describe('opening the popup', () => {
  it('asks the worker for both pieces of state it renders', () => {
    open();
    expect(types()).toContain('GET_INSPECT_STATE');
    expect(types()).toContain('GET_PANEL_STATE');
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
    expect(types()).toEqual(['START_INSPECT']);
    expect(btnText()).toBe('Stop Inspecting');
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

  it('ignores broadcasts it has no business acting on', () => {
    open();
    expect(() => messageListeners.forEach((fn) => fn({ type: 'RECORDED_ACTION', data: {} }))).not.toThrow();
    expect(btnText()).toBe('Start Inspecting');
  });
});

describe('the panel button', () => {
  it('asks the worker to open the panel', () => {
    open();
    sent.length = 0;
    document.getElementById('panelBtn').click();
    expect(types()).toEqual(['OPEN_SIDE_PANEL']);
    expect(panelLabel()).toContain('Close');
  });

  it('explains that Chrome cannot close the panel programmatically', () => {
    // Chrome exposes no API for this, so the honest thing is to say so rather than
    // send a message nothing will act on.
    const alerts = [];
    window.alert = (m) => alerts.push(m);
    open();
    document.getElementById('panelBtn').click(); // -> "Close ..."
    sent.length = 0;
    document.getElementById('panelBtn').click(); // -> asks to close

    expect(sent).toHaveLength(0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/does not support closing/i);
  });

  it('closes the sidebar on Firefox, where the API exists', () => {
    globalThis.browser = { sidebarAction: { close: () => {}, open: () => {} } };
    try {
      open();
      document.getElementById('panelBtn').click(); // -> "Close ..."
      sent.length = 0;
      document.getElementById('panelBtn').click();

      expect(types()).toEqual(['CLOSE_SIDE_PANEL']);
      expect(panelLabel()).toContain('Open');
    } finally {
      delete globalThis.browser;
    }
  });
});
