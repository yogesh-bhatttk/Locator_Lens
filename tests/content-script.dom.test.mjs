// @vitest-environment jsdom
//
// Loads the three content scripts in manifest order into one jsdom page, behind a
// chrome stub, and drives them through the message API the background uses. This is
// the closest thing to "the extension actually runs" that can live in CI, and it
// covers the wiring that unit-testing each file separately would miss.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The order the manifest declares. content.js depends on both of the others.
const CONTENT_SCRIPTS = ['src/codegen.js', 'src/content-locator-engine.js', 'src/content.js'];

let messageHandlers;
let storageValues;

/** Fresh page + fresh copy of the content scripts, as if the tab had just loaded. */
function loadContentScripts() {
  messageHandlers = [];
  storageValues = {};

  globalThis.chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      sendMessage: () => {},
      onMessage: { addListener: (fn) => messageHandlers.push(fn) },
    },
    storage: {
      local: {
        get: (keys, cb) => cb(storageValues),
        set: (obj, cb) => {
          Object.assign(storageValues, obj);
          if (cb) cb();
        },
      },
      onChanged: { addListener: () => {} },
    },
  };

  // Each injection is a fresh script run; content.js guards re-injection with a
  // window flag, so clear it along with the engine globals.
  delete globalThis.__LocatorLensInjected;
  delete globalThis.__LocatorLensEngine;
  delete globalThis.LLCodegen;
  delete window.__LocatorLensInjected;

  for (const file of CONTENT_SCRIPTS) {
    vm.runInThisContext(readFileSync(join(ROOT, file), 'utf8'), { filename: file });
  }
}

/** Deliver a message the way chrome.runtime does, returning the handler's response. */
function send(msg) {
  let response;
  for (const handler of messageHandlers) handler(msg, {}, (r) => (response = r));
  return response;
}

/**
 * jsdom implements no layout, so it has no elementFromPoint — the hit-testing the
 * picker relies on. Point it at a chosen element to simulate the cursor being there.
 */
function pointAt(el) {
  document.elementFromPoint = () => el;
}

beforeEach(() => {
  // A fresh tab means a fresh document: the injected stylesheet lives in <head>,
  // so clearing only <body> would leak it into the next test.
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.body.className = '';
  delete document.elementFromPoint;
  loadContentScripts();
});

describe('injection', () => {
  it('publishes both engines onto the page globals', () => {
    expect(globalThis.LLCodegen).toBeDefined();
    expect(globalThis.__LocatorLensEngine).toBeDefined();
  });

  it('starts inert — no overlay and no styles until asked', () => {
    expect(document.getElementById('ll-overlay')).toBeNull();
    expect(document.getElementById('ll-styles')).toBeNull();
  });

  it('registers a message listener', () => {
    expect(messageHandlers.length).toBeGreaterThan(0);
  });
});

describe('inspect lifecycle', () => {
  it('builds the overlay and marks the body on START_INSPECT', () => {
    expect(send({ type: 'START_INSPECT' })).toEqual({ ok: true });
    expect(document.getElementById('ll-overlay')).not.toBeNull();
    expect(document.getElementById('ll-tooltip')).not.toBeNull();
    expect(document.getElementById('ll-traversal-bar')).not.toBeNull();
    expect(document.body.classList.contains('ll-inspecting')).toBe(true);
  });

  it('tears everything down on STOP_INSPECT', () => {
    send({ type: 'START_INSPECT' });
    expect(send({ type: 'STOP_INSPECT' })).toEqual({ ok: true });
    expect(document.getElementById('ll-overlay')).toBeNull();
    expect(document.getElementById('ll-tooltip')).toBeNull();
    expect(document.getElementById('ll-traversal-bar')).toBeNull();
    expect(document.body.classList.contains('ll-inspecting')).toBe(false);
  });

  it('is idempotent across repeated start/stop cycles', () => {
    for (let i = 0; i < 3; i++) {
      send({ type: 'START_INSPECT' });
      send({ type: 'START_INSPECT' });
      send({ type: 'STOP_INSPECT' });
    }
    expect(document.querySelectorAll('#ll-overlay')).toHaveLength(0);
    expect(document.querySelectorAll('#ll-styles')).toHaveLength(1);
  });
});

describe('Selector Lab', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="save">Save</button>
      <button id="cancel">Cancel</button>
      <input placeholder="Email">`;
  });

  // The regression this file exists for: the highlight class was applied but its
  // stylesheet was only ever injected by Start Inspecting, so validating a selector
  // without inspecting first appeared to do nothing at all.
  it('injects the highlight stylesheet without requiring Inspect first', () => {
    expect(document.getElementById('ll-styles')).toBeNull();
    send({ type: 'LAB_VALIDATE', selector: '#save' });
    expect(document.getElementById('ll-styles')).not.toBeNull();
    expect(document.getElementById('ll-styles').textContent).toContain('ll-lab-highlight');
  });

  it('highlights CSS matches and reports the count', () => {
    expect(send({ type: 'LAB_VALIDATE', selector: 'button' })).toEqual({ ok: true, count: 2 });
    expect(document.querySelectorAll('.ll-lab-highlight')).toHaveLength(2);
  });

  it('resolves an XPath expression', () => {
    expect(send({ type: 'LAB_VALIDATE', selector: '//button' }).count).toBe(2);
  });

  it('resolves a pasted Playwright locator line, boilerplate and all', () => {
    const res = send({
      type: 'LAB_VALIDATE',
      selector: "await page.getByRole('button', { name: 'Save' }).click();",
    });
    expect(res.count).toBe(1);
    expect(document.getElementById('save').classList.contains('ll-lab-highlight')).toBe(true);
  });

  it('resolves getByPlaceholder', () => {
    expect(send({ type: 'LAB_VALIDATE', selector: "page.getByPlaceholder('Email')" }).count).toBe(1);
  });

  it('applies a positional reducer', () => {
    expect(send({ type: 'LAB_VALIDATE', selector: "page.locator('button').first()" }).count).toBe(1);
  });

  it('clears the previous highlights on the next validation', () => {
    send({ type: 'LAB_VALIDATE', selector: 'button' });
    send({ type: 'LAB_VALIDATE', selector: '#save' });
    expect(document.querySelectorAll('.ll-lab-highlight')).toHaveLength(1);
  });

  it('removes every highlight on LAB_CLEAR', () => {
    send({ type: 'LAB_VALIDATE', selector: 'button' });
    expect(send({ type: 'LAB_CLEAR' })).toEqual({ ok: true });
    expect(document.querySelectorAll('.ll-lab-highlight')).toHaveLength(0);
  });

  it('reports an invalid selector instead of throwing', () => {
    const res = send({ type: 'LAB_VALIDATE', selector: '<<<not a selector' });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

describe('stress test', () => {
  it('reports noTarget when nothing has been picked', () => {
    expect(send({ type: 'RUN_STRESS_TEST' }).data).toMatchObject({ noTarget: true });
  });

  it('passes an element whose role and accessible name are unique', () => {
    document.body.innerHTML = '<button id="only">Unique Action</button><button>Other</button>';
    const target = document.getElementById('only');
    pointAt(target);
    target.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));

    const { data } = send({ type: 'RUN_STRESS_TEST' });
    expect(data).toMatchObject({ survived: true, role: 'button', name: 'Unique Action', tag: 'button' });
  });

  it('fails an element whose role and name are shared with a sibling', () => {
    document.body.innerHTML = '<button id="a">Duplicate</button><button id="b">Duplicate</button>';
    const target = document.getElementById('a');
    pointAt(target);
    target.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));

    expect(send({ type: 'RUN_STRESS_TEST' }).data).toMatchObject({ survived: false, name: 'Duplicate' });
  });
});

describe('recorder control messages', () => {
  it('acknowledges the full control surface', () => {
    for (const type of ['START_RECORDING', 'PAUSE_RECORDING', 'RESUME_RECORDING', 'STOP_RECORDING']) {
      expect(send({ type }), type).toEqual({ ok: true });
    }
  });

  it('accepts an assert-mode change', () => {
    expect(send({ type: 'SET_ASSERT_MODE', on: true, assertType: 'toHaveText' })).toEqual({ ok: true });
  });

  it('survives start/stop recording cycles without throwing', () => {
    expect(() => {
      for (let i = 0; i < 3; i++) {
        send({ type: 'START_RECORDING' });
        send({ type: 'STOP_RECORDING' });
      }
    }).not.toThrow();
  });
});

describe('debug logging', () => {
  it('stays silent unless llDebug is set', () => {
    const calls = [];
    const original = console.log;
    console.log = (...args) => calls.push(args);
    try {
      send({ type: 'START_RECORDING' });
      send({ type: 'STOP_RECORDING' });
      send({ type: 'STOP_INSPECT' });
    } finally {
      console.log = original;
    }
    expect(calls).toHaveLength(0);
  });
});
