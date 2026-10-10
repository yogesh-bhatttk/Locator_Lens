// Locator health check (E) in the service worker: GET_ACTIVE_PAGE and HEALTH_CHECK.
//
// The frames here run the worker's real executeScript function: the harness
// serialises it (toString) and evaluates it in a fresh context per frame, as the
// browser does, with that frame's __LocatraHealthCheck and location.href. So the
// merge is tested against what the injected function actually returns, and a
// function that leaned on anything outside itself would fail here too.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONTENT_SCRIPT_FILES,
  TAB,
  WINDOW,
  flush,
  setWaiter,
  startWorker,
  until,
} from './background-harness.mjs';

const RESTRICTED =
  "Locatra can't run on this page (browser pages, the Web Store, PDFs and some file:// pages are off-limits).";
const OUTDATED = "Locatra's page script in this tab is out of date. Reload the page and check again.";
const PAGE = 'https://shop.example.com/checkout/pay';

const item = (id, extra = {}) => ({
  id,
  target: { kind: 'testid', value: id },
  fingerprint: { tag: 'button', testId: id },
  ...extra,
});

/** A frame whose health check answers `fn(items)`; records what it was given. */
function frame(frameId, fn, href = PAGE) {
  const seen = [];
  return {
    frameId,
    href,
    seen,
    check: (items) => {
      seen.push(items);
      return fn(items);
    },
  };
}

const owns =
  (...ids) =>
  (items) =>
    items.map((it) =>
      ids.includes(it.id) ? { id: it.id, owned: true, count: 1, status: 'ok' } : { id: it.id, owned: false }
    );

describe('GET_ACTIVE_PAGE', () => {
  it('answers the active tab, its redacted address and its site key', async () => {
    const w = startWorker({
      frames: {
        [TAB]: [
          { frameId: 0, href: 'https://ada:pw@shop.example.com/checkout/pay?access_token=abc&step=2#card' },
        ],
      },
    });
    expect(await w.ask({ type: 'GET_ACTIVE_PAGE', windowId: WINDOW })).toEqual({
      ok: true,
      tabId: TAB,
      url: 'https://shop.example.com/checkout/pay?access_token=REDACTED&step=2#card',
      siteKey: 'https://shop.example.com/checkout/pay',
    });
    // Read from the top frame itself (no `tabs` permission for tab.url), without injecting.
    expect(w.executed.map((e) => e.target)).toEqual([{ tabId: TAB }]);
    expect(w.injected).toEqual([]);
  });

  it('answers for the window asked about, not the focused one', async () => {
    const w = startWorker({
      tabs: [
        { id: 1, windowId: 1, active: true },
        { id: 2, windowId: 2, active: true },
      ],
      focusedWindow: 1,
      frames: {
        1: [{ frameId: 0, href: 'https://one.test/' }],
        2: [{ frameId: 0, href: 'http://two.test/x' }],
      },
    });
    expect(await w.ask({ type: 'GET_ACTIVE_PAGE', windowId: 2 })).toMatchObject({
      ok: true,
      tabId: 2,
      siteKey: 'http://two.test/x',
    });
    expect(await w.ask({ type: 'GET_ACTIVE_PAGE' })).toMatchObject({
      tabId: 1,
      siteKey: 'https://one.test/',
    });
  });

  it('a page Locatra may not touch, or that is not http(s), is restricted', async () => {
    const restricted = startWorker({ restrictedTabs: [TAB] });
    expect(await restricted.ask({ type: 'GET_ACTIVE_PAGE', windowId: WINDOW })).toEqual({
      ok: false,
      error: RESTRICTED,
    });
    for (const href of ['file:///home/me/a.html', 'about:blank', 'not a url', '']) {
      const w = startWorker({ frames: { [TAB]: [{ frameId: 0, href }] } });
      expect(await w.ask({ type: 'GET_ACTIVE_PAGE', windowId: WINDOW }), href).toEqual({
        ok: false,
        error: RESTRICTED,
      });
    }
    const throws = startWorker({ execute: () => 'throw' });
    expect((await throws.ask({ type: 'GET_ACTIVE_PAGE', windowId: WINDOW })).error).toBe(RESTRICTED);
    const noResults = startWorker({ frames: { [TAB]: [] } });
    expect((await noResults.ask({ type: 'GET_ACTIVE_PAGE', windowId: WINDOW })).error).toBe(RESTRICTED);
  });

  it('no active tab', async () => {
    const w = startWorker({ tabs: [] });
    expect(await w.ask({ type: 'GET_ACTIVE_PAGE', windowId: WINDOW })).toEqual({
      ok: false,
      error: 'No active tab.',
    });
  });

  it('is not answered for content scripts', () => {
    const w = startWorker();
    expect(w.fromTab({ type: 'GET_ACTIVE_PAGE' }).keptOpen).toBe(false);
    expect(w.executed).toEqual([]);
  });
});

describe('HEALTH_CHECK', () => {
  it('injects every frame, runs the check in all of them and keeps each item’s owner’s answer', async () => {
    const top = frame(0, (items) =>
      items.map((it) =>
        it.id === 'a'
          ? { id: 'a', owned: true, count: 1, status: 'ok' }
          : it.id === 'b'
            ? {
                id: 'b',
                owned: true,
                count: 0,
                status: 'broken',
                suggestion: { target: { kind: 'id', value: 'buy' }, code: "page.locator('#buy')", extra: 1 },
              }
            : { id: it.id, owned: false, count: 0, status: 'broken' }
      )
    );
    const child = frame(
      3,
      (items) =>
        items.map((it) =>
          it.id === 'c'
            ? { id: 'c', owned: true, count: 2, status: 'ambiguous', junk: 'x' }
            : { id: it.id, owned: false }
        ),
      'https://pay.example.net/frame'
    );
    const w = startWorker({ frames: { [TAB]: [top, child] } });
    const res = await w.ask({
      type: 'HEALTH_CHECK',
      windowId: WINDOW,
      items: [item('a'), item('b'), item('c'), item('d')],
    });
    expect(res).toEqual({
      ok: true,
      siteKey: 'https://shop.example.com/checkout/pay',
      results: [
        { id: 'a', status: 'ok', count: 1 },
        {
          id: 'b',
          status: 'broken',
          count: 0,
          suggestion: { target: { kind: 'id', value: 'buy' }, code: "page.locator('#buy')" },
        },
        { id: 'c', status: 'ambiguous', count: 2 },
        { id: 'd', status: 'frame-missing', count: 0 },
      ],
    });
    // Injected first, every frame, the manifest's files.
    expect(w.injected[0]).toEqual({ target: { tabId: TAB, allFrames: true }, files: CONTENT_SCRIPT_FILES });
    expect(w.executed).toHaveLength(1);
    expect(w.executed[0].target).toEqual({ tabId: TAB, allFrames: true });
    expect(w.executed[0].world).toBeUndefined(); // the content script's (ISOLATED) world
    // Each frame got the items, reduced to what the check needs.
    expect(top.seen[0]).toEqual([item('a'), item('b'), item('c'), item('d')]);
    expect(child.seen[0]).toEqual(top.seen[0]);
  });

  it('sends only id/target/fingerprint, and drops items without an id', async () => {
    const top = frame(0, owns('ok-1'));
    const w = startWorker({ frames: { [TAB]: [top] } });
    const res = await w.ask({
      type: 'HEALTH_CHECK',
      windowId: WINDOW,
      items: [
        item('ok-1', { label: 'Buy', code: 'x', lastCheck: {} }),
        null,
        'x',
        { id: '' },
        { id: 7 },
        { target: {} },
      ],
    });
    expect(top.seen[0]).toEqual([item('ok-1')]);
    expect(res.results).toEqual([{ id: 'ok-1', status: 'ok', count: 1 }]);
  });

  it('derives a missing or unknown status from the count, and repairs a bad count', async () => {
    const top = frame(0, () => [
      { id: 'one', owned: true, count: 1 },
      { id: 'none', owned: true, count: 0, status: 'weird' },
      { id: 'many', owned: true, count: 3.7 },
      { id: 'nan', owned: true, count: 'x' },
      { id: 'neg', owned: true, count: -2, status: 'error', error: 'resolve failed' },
    ]);
    const w = startWorker({ frames: { [TAB]: [top] } });
    const ids = ['one', 'none', 'many', 'nan', 'neg'];
    const res = await w.ask({ type: 'HEALTH_CHECK', windowId: WINDOW, items: ids.map((id) => item(id)) });
    expect(res.results).toEqual([
      { id: 'one', status: 'ok', count: 1 },
      { id: 'none', status: 'broken', count: 0 },
      { id: 'many', status: 'ambiguous', count: 3 },
      { id: 'nan', status: 'broken', count: 0 },
      { id: 'neg', status: 'error', count: 0, error: 'resolve failed' },
    ]);
  });

  it('drops a malformed suggestion and ignores malformed entries', async () => {
    const top = frame(0, () => [
      null,
      'nope',
      { id: 'x', owned: 'yes', count: 1 },
      { id: 5, owned: true, count: 1 },
      { id: 'x', owned: true, count: 0, suggestion: { target: { kind: 'id', value: 'q' } } },
      { id: 'y', owned: true, count: 0, suggestion: { target: 'css', code: 'c' } },
      { id: 'z', owned: true, count: 0, suggestion: 'page.locator(...)' },
    ]);
    const w = startWorker({ frames: { [TAB]: [top] } });
    const res = await w.ask({
      type: 'HEALTH_CHECK',
      windowId: WINDOW,
      items: [item('x'), item('y'), item('z')],
    });
    expect(res.results).toEqual([
      { id: 'x', status: 'broken', count: 0 },
      { id: 'y', status: 'broken', count: 0 },
      { id: 'z', status: 'broken', count: 0 },
    ]);
  });

  it('keeps a suggestion’s altTargets (objects only, at most three) — C9.1', async () => {
    const alt = (v) => ({ kind: 'frame', selector: '#f', index: 0, child: { kind: 'id', value: v } });
    const sug = (altTargets) => ({
      target: { kind: 'role', role: 'button', name: 'Buy' },
      code: 'c',
      altTargets,
    });
    const top = frame(0, () => [
      {
        id: 'x',
        owned: true,
        count: 0,
        suggestion: sug([alt('a'), null, 'css', alt('b'), alt('c'), alt('d')]),
      },
      { id: 'y', owned: true, count: 0, suggestion: sug([null]) },
      { id: 'z', owned: true, count: 0, suggestion: sug('nope') },
    ]);
    const w = startWorker({ frames: { [TAB]: [top] } });
    const res = await w.ask({
      type: 'HEALTH_CHECK',
      windowId: WINDOW,
      items: [item('x'), item('y'), item('z')],
    });
    const plain = { target: { kind: 'role', role: 'button', name: 'Buy' }, code: 'c' };
    expect(res.results).toEqual([
      {
        id: 'x',
        status: 'broken',
        count: 0,
        suggestion: { ...plain, altTargets: [alt('a'), alt('b'), alt('c')] },
      },
      { id: 'y', status: 'broken', count: 0, suggestion: plain },
      { id: 'z', status: 'broken', count: 0, suggestion: plain },
    ]);
  });

  it('two frames claiming one item: the lower frame id wins, whatever order the browser lists them in', async () => {
    const a = frame(5, () => [{ id: 'x', owned: true, count: 2 }], 'https://f.test/');
    const b = frame(2, () => [{ id: 'x', owned: true, count: 1 }], 'https://f.test/');
    const top = frame(0, () => []);
    const w = startWorker({ frames: { [TAB]: [a, top, b] } });
    const res = await w.ask({ type: 'HEALTH_CHECK', windowId: WINDOW, items: [item('x')] });
    expect(res.results).toEqual([{ id: 'x', status: 'ok', count: 1 }]);
  });

  it('a frame whose check throws turns the items nobody owns into errors', async () => {
    const top = frame(0, owns('a'));
    const bad = frame(4, () => {
      throw new Error('engine exploded');
    });
    const w = startWorker({ frames: { [TAB]: [top, bad] } });
    const res = await w.ask({ type: 'HEALTH_CHECK', windowId: WINDOW, items: [item('a'), item('b')] });
    expect(res.results).toEqual([
      { id: 'a', status: 'ok', count: 1 },
      { id: 'b', status: 'error', count: 0, error: 'engine exploded' },
    ]);
  });

  it('a frame the browser could not run the script in (InjectionResult.error) counts the same', async () => {
    const top = frame(0, owns('a'));
    const w = startWorker({ frames: { [TAB]: [top, { frameId: 9, href: PAGE, throws: 'frame detached' }] } });
    const res = await w.ask({ type: 'HEALTH_CHECK', windowId: WINDOW, items: [item('a'), item('b')] });
    expect(res.results[1]).toEqual({ id: 'b', status: 'error', count: 0, error: 'frame detached' });
    // Even when that is the only answer there is.
    const w2 = startWorker({
      frames: {
        [TAB]: [
          { frameId: 0, href: PAGE, check: () => 'not an array' },
          { frameId: 1, href: PAGE, throws: 'gone' },
        ],
      },
    });
    const res2 = await w2.ask({ type: 'HEALTH_CHECK', windowId: WINDOW, items: [item('a')] });
    expect(res2).toEqual({
      ok: true,
      siteKey: 'https://shop.example.com/checkout/pay',
      results: [{ id: 'a', status: 'error', count: 0, error: 'gone' }],
    });
  });

  it('a content script that predates the health check (no frame can run it) asks for a reload', async () => {
    const w = startWorker(); // default frame: no __LocatraHealthCheck
    expect(await w.ask({ type: 'HEALTH_CHECK', windowId: WINDOW, items: [item('a')] })).toEqual({
      ok: false,
      error: OUTDATED,
    });
  });

  it('an empty list is a valid check', async () => {
    const w = startWorker({ frames: { [TAB]: [frame(0, () => [])] } });
    expect(await w.ask({ type: 'HEALTH_CHECK', windowId: WINDOW, items: [] })).toEqual({
      ok: true,
      siteKey: 'https://shop.example.com/checkout/pay',
      results: [],
    });
  });

  it('restricted pages: refused injection, or a top frame that is not an http(s) page', async () => {
    const w = startWorker({ restrictedTabs: [TAB] });
    expect(await w.ask({ type: 'HEALTH_CHECK', windowId: WINDOW, items: [item('a')] })).toEqual({
      ok: false,
      error: RESTRICTED,
    });
    expect(w.executed).toEqual([]);
    const w2 = startWorker({ frames: { [TAB]: [frame(0, owns('a'), 'about:blank')] } });
    expect((await w2.ask({ type: 'HEALTH_CHECK', windowId: WINDOW, items: [item('a')] })).error).toBe(
      RESTRICTED
    );
    // No top frame among the answers at all.
    const w3 = startWorker({ frames: { [TAB]: [frame(2, owns('a'))] } });
    expect((await w3.ask({ type: 'HEALTH_CHECK', windowId: WINDOW, items: [item('a')] })).error).toBe(
      RESTRICTED
    );
  });

  it('reports an executeScript failure, thrown or as lastError', async () => {
    const w = startWorker({ execute: () => ({ error: 'Frame with ID 0 was removed.' }) });
    expect(await w.ask({ type: 'HEALTH_CHECK', windowId: WINDOW, items: [item('a')] })).toEqual({
      ok: false,
      error: 'Could not check this page: Frame with ID 0 was removed.',
    });
    const w2 = startWorker({ execute: () => 'throw' });
    expect(await w2.ask({ type: 'HEALTH_CHECK', windowId: WINDOW, items: [item('a')] })).toEqual({
      ok: false,
      error: 'Could not check this page: executeScript exploded',
    });
  });

  it('validates the request', async () => {
    const w = startWorker();
    expect(await w.ask({ type: 'HEALTH_CHECK', windowId: WINDOW })).toEqual({
      ok: false,
      error: 'HEALTH_CHECK needs an items array.',
    });
    const many = Array.from({ length: 2001 }, (_, i) => item('i' + i));
    expect(await w.ask({ type: 'HEALTH_CHECK', windowId: WINDOW, items: many })).toEqual({
      ok: false,
      error: 'Too many locators to check at once (max 2000).',
    });
    expect(w.injected).toEqual([]);
    const none = startWorker({ tabs: [] });
    expect(await none.ask({ type: 'HEALTH_CHECK', windowId: WINDOW, items: [] })).toEqual({
      ok: false,
      error: 'No active tab to check.',
    });
  });

  it('checks the active tab of the window asked about', async () => {
    const w = startWorker({
      tabs: [
        { id: 1, windowId: 1, active: true },
        { id: 2, windowId: 2, active: true },
      ],
      frames: { 1: [frame(0, owns('a'), 'https://one.test/')], 2: [frame(0, owns(), 'https://two.test/')] },
    });
    const res = await w.ask({ type: 'HEALTH_CHECK', windowId: 2, items: [item('a')] });
    expect(res.siteKey).toBe('https://two.test/');
    expect(res.results[0].status).toBe('frame-missing');
  });

  it('is not answered for content scripts', () => {
    const w = startWorker();
    expect(w.fromTab({ type: 'HEALTH_CHECK', items: [] }).keptOpen).toBe(false);
  });
});

describe('HEALTH_CHECK time box', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setWaiter((ms) => vi.advanceTimersByTimeAsync(ms));
  });
  afterEach(() => {
    setWaiter(null);
    vi.useRealTimers();
  });

  it('gives up after 10 s when the page never answers', async () => {
    let late;
    const w = startWorker({
      execute: (tabId, opts) => {
        late = opts;
        return 'hang';
      },
    });
    const r = w.send({ type: 'HEALTH_CHECK', windowId: WINDOW, items: [item('a')] });
    expect(r.keptOpen).toBe(true);
    await flush(9900);
    expect(r.responded).toBe(false);
    await flush(200);
    expect(r.response).toEqual({ ok: false, error: 'The health check timed out after 10 s.' });
    expect(late).toBeTruthy();
  });

  it('a check that answers in time clears its timer', async () => {
    const w = startWorker({ frames: { [TAB]: [frame(0, owns('a'))] } });
    const r = w.send({ type: 'HEALTH_CHECK', windowId: WINDOW, items: [item('a')] });
    await until(() => r.responded);
    expect(r.response.ok).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the injected functions, run where they are defined', () => {
  // The harness runs them serialised in per-frame contexts (as the browser does);
  // this runs the same functions in the worker's own context, with the frame's
  // globals put there, to pin down their contract directly.
  it('healthCheckInFrame wraps the content script’s answer with the frame address', () => {
    const w = startWorker();
    const fn = w.context.healthCheckInFrame;
    w.context.location = { href: PAGE };
    expect(fn([item('a')])).toEqual({ results: null, error: null, href: PAGE });
    w.context.__LocatraHealthCheck = (items) => items.map((it) => ({ id: it.id, owned: true, count: 1 }));
    expect(fn([item('a')])).toEqual({
      results: [{ id: 'a', owned: true, count: 1 }],
      error: null,
      href: PAGE,
    });
    w.context.__LocatraHealthCheck = () => ({ not: 'an array' });
    expect(fn([]).results).toBeNull();
    w.context.__LocatraHealthCheck = () => {
      throw new Error('bad target');
    };
    expect(fn([])).toEqual({ results: null, error: 'bad target', href: PAGE });
    w.context.__LocatraHealthCheck = () => {
      throw 'plain';
    };
    expect(fn([]).error).toBe('plain');
    // A frame whose location cannot be read still answers.
    Object.defineProperty(w.context, 'location', {
      get() {
        throw new Error('cross-origin');
      },
      configurable: true,
    });
    w.context.__LocatraHealthCheck = () => [];
    expect(fn([])).toEqual({ results: [], error: null, href: null });
  });

  it('GET_ACTIVE_PAGE’s probe returns the top frame’s address', async () => {
    const w = startWorker();
    // Route the probe through the worker context instead of a frame sandbox.
    const real = w.chrome.scripting.executeScript;
    w.chrome.scripting.executeScript = (opts, cb) => {
      if (typeof opts.func === 'function' && !opts.args) {
        w.context.location = { href: 'https://in.context/path?x=1' };
        cb([{ frameId: 0, result: opts.func() }]);
        return;
      }
      real(opts, cb);
    };
    expect(await w.ask({ type: 'GET_ACTIVE_PAGE', windowId: WINDOW })).toMatchObject({
      ok: true,
      siteKey: 'https://in.context/path',
    });
  });
});
