// Page Object routing (F2) and the auto-assertion relay (F3) in the service worker.

import { describe, expect, it } from 'vitest';

import { TAB, WINDOW, flush, startWorker } from './background-harness.mjs';

const RESTRICTED = /can't run on this page/;
const toTab = (w, type) => w.sent.filter((s) => s.msg.type === type);

describe('POM_PICK_START', () => {
  it('injects every frame, then starts region picking in all of them', async () => {
    const w = startWorker();
    const res = await w.ask({ type: 'POM_PICK_START', windowId: WINDOW });
    expect(res).toEqual({ ok: true, tabId: TAB });
    expect(w.injected[0]).toEqual({
      target: { tabId: TAB, allFrames: true },
      files: ['src/codegen.js', 'src/content-locator-engine.js', 'src/content.js'],
    });
    // Exactly the spec's message, to every frame (each hit-tests its own document).
    expect(toTab(w, 'POM_PICK_START')).toEqual([
      { tabId: TAB, msg: { type: 'POM_PICK_START' }, frameId: undefined },
    ]);
  });

  it('targets the active tab of the panel’s own window', async () => {
    const w = startWorker({
      tabs: [
        { id: 1, windowId: 10, active: true },
        { id: 2, windowId: 20, active: true },
      ],
      focusedWindow: 10,
    });
    await w.ask({ type: 'POM_PICK_START', windowId: 20 });
    expect(toTab(w, 'POM_PICK_START').map((s) => s.tabId)).toEqual([2]);
  });

  it('reports a restricted page like START_INSPECT does, and starts nothing', async () => {
    const w = startWorker({ restrictedTabs: [TAB] });
    const res = await w.ask({ type: 'POM_PICK_START', windowId: WINDOW });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(RESTRICTED);
    expect(toTab(w, 'POM_PICK_START')).toEqual([]);
  });

  it('with no active tab it says so', async () => {
    const w = startWorker({ tabs: [] });
    expect(await w.ask({ type: 'POM_PICK_START', windowId: WINDOW })).toEqual({
      ok: false,
      error: 'No active tab to scan.',
    });
  });

  it('is ignored from content scripts', () => {
    const w = startWorker();
    const r = w.fromTab({ type: 'POM_PICK_START' });
    expect(r.keptOpen).toBe(false);
    expect(w.injected).toEqual([]);
  });
});

describe('POM_SCAN', () => {
  it('asks only the top frame, without injecting when it already has the script', async () => {
    const w = startWorker();
    const res = await w.ask({ type: 'POM_SCAN', windowId: WINDOW });
    expect(res).toEqual({ ok: true, tabId: TAB });
    expect(w.injected).toEqual([]);
    expect(toTab(w, 'POM_SCAN')).toEqual([{ tabId: TAB, msg: { type: 'POM_SCAN' }, frameId: 0 }]);
  });

  it('injects the top frame only when it has no script yet', async () => {
    const w = startWorker({ unreachableTabs: [TAB] });
    const res = await w.ask({ type: 'POM_SCAN', windowId: WINDOW });
    expect(res.ok).toBe(true);
    expect(w.injected).toEqual([
      {
        target: { tabId: TAB },
        files: ['src/codegen.js', 'src/content-locator-engine.js', 'src/content.js'],
      },
    ]);
    expect(toTab(w, 'POM_SCAN')).toHaveLength(1);
  });

  it('reports a restricted page', async () => {
    const w = startWorker({ restrictedTabs: [TAB] });
    const res = await w.ask({ type: 'POM_SCAN', windowId: WINDOW });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(RESTRICTED);
    expect(toTab(w, 'POM_SCAN')).toEqual([]);
  });

  it('is ignored from content scripts', () => {
    const w = startWorker();
    expect(w.fromTab({ type: 'POM_SCAN' }).responded).toBe(false);
  });
});

describe('POM_RESULT / POM_PICK_CANCELLED relay', () => {
  const data = {
    pageUrl: 'https://shop.example/checkout',
    title: 'Checkout',
    region: { tag: 'form', locator: "page.locator('form')" },
    elements: [
      {
        name: 'emailInput',
        kind: 'input',
        role: 'textbox',
        tag: 'input',
        inputType: 'email',
        label: 'Email',
        target: { kind: 'label', value: 'Email' },
        code: "page.getByLabel('Email')",
        matchCount: 1,
        unique: true,
      },
    ],
    truncated: false,
  };

  it('relays the page’s result, intact and tagged, to that window’s panel only', () => {
    const w = startWorker({
      tabs: [
        { id: TAB, windowId: WINDOW, active: true },
        { id: 9, windowId: 99, active: true },
      ],
    });
    const mine = w.connectPanel(WINDOW);
    const other = w.connectPanel(99);
    w.fromTab({ type: 'POM_RESULT', data });
    expect(mine.of('POM_RESULT')).toEqual([{ type: 'POM_RESULT', data, windowId: WINDOW, tabId: TAB }]);
    expect(other.of('POM_RESULT')).toEqual([]);
    w.fromTab({ type: 'POM_PICK_CANCELLED' });
    expect(mine.of('POM_PICK_CANCELLED')).toEqual([
      { type: 'POM_PICK_CANCELLED', windowId: WINDOW, tabId: TAB },
    ]);
    expect(other.of('POM_PICK_CANCELLED')).toEqual([]);
  });

  it('ends region picking in every frame of that tab once one frame picked or cancelled', () => {
    const w = startWorker({
      tabs: [
        { id: TAB, windowId: WINDOW, active: true },
        { id: 9, windowId: 99, active: true },
      ],
    });
    w.fromTab({ type: 'POM_RESULT', data }, TAB, { frameId: 4 });
    expect(toTab(w, 'POM_PICK_STOP')).toEqual([
      { tabId: TAB, msg: { type: 'POM_PICK_STOP' }, frameId: undefined },
    ]);
    w.fromTab({ type: 'POM_PICK_CANCELLED' }, 9);
    expect(toTab(w, 'POM_PICK_STOP').map((s) => s.tabId)).toEqual([TAB, 9]);
    // Other page relays do not touch pick mode.
    w.fromTab({ type: 'LAB_STATUS_UPDATE', data: {} }, TAB);
    expect(toTab(w, 'POM_PICK_STOP')).toHaveLength(2);
  });

  it('does not relay a POM_RESULT that did not come from a page', () => {
    const w = startWorker();
    const panel = w.connectPanel(WINDOW);
    w.send({ type: 'POM_RESULT', data, windowId: WINDOW });
    expect(panel.of('POM_RESULT')).toEqual([]);
    expect(w.relayed).toEqual([]);
    expect(toTab(w, 'POM_PICK_STOP')).toEqual([]);
  });
});

describe('suggested assertions (F3) ride the normal step relay', () => {
  it('keeps suggested and reason, and never screenshots a suggestion', async () => {
    const w = startWorker();
    const panel = w.connectPanel(WINDOW);
    const suggestion = {
      eventId: 'sug-1',
      action: 'assert',
      assertType: 'toHaveURL',
      value: 'https://shop.example/confirmation',
      target: null,
      suggested: true,
      reason: 'Page navigated to /confirmation',
      locators: [{ big: 'array' }],
    };
    w.fromTab({ type: 'RECORDED_ACTION', data: suggestion });
    await flush(30);
    const relayed = panel.of('RECORDED_ACTION');
    expect(relayed).toHaveLength(1);
    expect(relayed[0].data).toEqual({
      eventId: 'sug-1',
      action: 'assert',
      assertType: 'toHaveURL',
      value: 'https://shop.example/confirmation',
      target: null,
      suggested: true,
      reason: 'Page navigated to /confirmation',
      tabId: TAB,
      windowId: WINDOW,
    });
    expect(w.captures).toEqual([]);
    // Buffered for a closed panel like any other step.
    await flush(5);
    expect(w.session.llRecordBuffer[WINDOW][0].suggested).toBe(true);
  });
});
