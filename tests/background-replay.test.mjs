// Replay orchestration in the service worker (F1): REPLAY_START / REPLAY_STOP, the
// step loop, navigation, timeouts, recording pause/restore and worker eviction.
// The content side is modelled by `respond` — what the frames of the tab answer to
// a REPLAY_STEP (or NO_ANSWER: no frame owns it / the page went away).

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONTENT_SCRIPT_FILES,
  NO_ANSWER,
  TAB,
  WINDOW,
  flush,
  startWorker,
  until,
} from './background-harness.mjs';

const URL1 = 'https://shop.example/checkout';

const click = (value = '#buy') => ({
  action: 'click',
  target: { kind: 'css', value },
  eventId: 'c-' + value,
});
const fill = (value = 'x', extra = {}) => ({
  action: 'fill',
  value,
  target: { kind: 'label', value: 'Email' },
  ...extra,
});
const goto = (url = URL1) => ({ action: 'goto', value: url });

/** Every REPLAY_* relay the panel would see, in order (port first, else broadcast). */
const replayMsgs = (w, panel) => (panel ? panel.posted : w.relayed).filter((m) => /^REPLAY_/.test(m.type));
const progress = (w, panel) =>
  replayMsgs(w, panel)
    .filter((m) => m.type === 'REPLAY_PROGRESS')
    .map((m) => `${m.index}:${m.status}${m.error ? ' ' + m.error : ''}`);
const done = (w, panel) => replayMsgs(w, panel).find((m) => m.type === 'REPLAY_DONE');
const stepsSent = (w) => w.sent.filter((s) => s.msg.type === 'REPLAY_STEP');

async function runToEnd(w, msg, panel, timeout = 4000) {
  const res = await w.ask({ type: 'REPLAY_START', windowId: WINDOW, secrets: {}, ...msg });
  if (!res.ok) return { res };
  await until(() => done(w, panel), { timeout, what: 'REPLAY_DONE' });
  return { res, done: done(w, panel) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('replay: the happy path', () => {
  it('plays goto, skips viewport, sends element steps to every frame and reports each one', async () => {
    const w = startWorker({
      respond: (tabId, msg) => (msg.type === 'REPLAY_STEP' ? { ok: true, matchCount: 1 } : NO_ANSWER),
    });
    const panel = w.connectPanel(WINDOW);
    const steps = [goto(), { action: 'viewport', value: '1280x720' }, click(), fill('ada@example.com')];
    const { res, done: end } = await runToEnd(
      w,
      { steps, options: { stopOnFailure: true, slowMoMs: 0 } },
      panel
    );

    expect(res).toEqual({ ok: true, runId: expect.any(String) });
    expect(end).toEqual({ type: 'REPLAY_DONE', windowId: WINDOW, runId: res.runId, result: 'passed' });
    expect(progress(w, panel)).toEqual([
      '0:running',
      '0:passed',
      '1:running',
      '1:skipped viewport is not changed during replay',
      '2:running',
      '2:passed',
      '3:running',
      '3:passed',
    ]);
    // goto navigates the tab itself.
    expect(w.updates).toEqual([{ tabId: TAB, props: { url: URL1 } }]);
    // Element steps go to all frames (no frameId) with the run, the index and the
    // default 5 s budget; only the owning frame answers.
    const sent = stepsSent(w);
    expect(sent.map((s) => [s.msg.index, s.frameId])).toEqual([
      [2, undefined],
      [3, undefined],
    ]);
    expect(sent[0].msg).toEqual({
      type: 'REPLAY_STEP',
      runId: res.runId,
      index: 2,
      step: steps[2],
      timeoutMs: 5000,
      highlight: true,
    });
    expect('secrets' in sent[0].msg).toBe(false);
    // Every relay is tagged for this window and run, passed steps carry matchCount and timing.
    for (const m of replayMsgs(w, panel)) {
      expect(m.windowId).toBe(WINDOW);
      expect(m.runId).toBe(res.runId);
    }
    const passed = panel.posted.filter(
      (m) => m.type === 'REPLAY_PROGRESS' && m.index === 2 && m.status === 'passed'
    );
    expect(passed[0]).toMatchObject({ matchCount: 1, durationMs: expect.any(Number) });
    // The panel's port got everything; nothing leaked to the broadcast channel.
    expect(w.relayed.filter((m) => /^REPLAY_/.test(m.type))).toEqual([]);
  });

  it('injects every frame before starting, and again after the goto loads', async () => {
    const w = startWorker({ respond: () => ({ ok: true, matchCount: 1 }) });
    await runToEnd(w, { steps: [goto(), click()] });
    const allFrames = w.injected.filter((i) => i.target.allFrames === true);
    expect(allFrames.length).toBeGreaterThanOrEqual(2);
    expect(allFrames[0].files).toEqual(CONTENT_SCRIPT_FILES);
  });

  it('honours the step timeout and clamps silly values', async () => {
    const w = startWorker({ respond: () => ({ ok: true }) });
    await runToEnd(w, { steps: [click()], options: { stepTimeoutMs: 1 } });
    expect(stepsSent(w)[0].msg.timeoutMs).toBe(100);
    const w2 = startWorker({ respond: () => ({ ok: true }) });
    await runToEnd(w2, { steps: [click()], options: { stepTimeoutMs: 'soon' } });
    expect(stepsSent(w2)[0].msg.timeoutMs).toBe(5000);
  });

  it('waits slowMoMs between steps', async () => {
    const at = [];
    const w = startWorker({
      respond: () => {
        at.push(Date.now());
        return { ok: true };
      },
    });
    await runToEnd(w, { steps: [fill('a'), fill('b'), fill('c')], options: { slowMoMs: 60 } });
    expect(at).toHaveLength(3);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(55);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(55);
  });

  it('works without a panel port: relays fall back to the broadcast, still tagged', async () => {
    const w = startWorker({ respond: () => ({ ok: true }) });
    const { res, done: end } = await runToEnd(w, { steps: [click()] });
    expect(end).toMatchObject({ windowId: WINDOW, runId: res.runId, result: 'passed' });
  });

  it('a run without windowId uses the focused window', async () => {
    const w = startWorker({ respond: () => ({ ok: true }) });
    const res = await w.ask({ type: 'REPLAY_START', steps: [click()] });
    expect(res.ok).toBe(true);
    await until(() => done(w));
    expect(done(w).windowId).toBe(WINDOW);
  });
});

describe('replay: failures', () => {
  const failing = (badIndex) => (tabId, msg) =>
    msg.type !== 'REPLAY_STEP'
      ? NO_ANSWER
      : msg.index === badIndex
        ? { ok: false, error: 'no element matches #gone', matchCount: 0 }
        : { ok: true, matchCount: 1 };

  it('stops at the first failure by default', async () => {
    const w = startWorker({ respond: failing(1) });
    const { res, done: end } = await runToEnd(w, { steps: [click('#a'), click('#gone'), click('#c')] });
    expect(end).toEqual({
      type: 'REPLAY_DONE',
      windowId: WINDOW,
      runId: res.runId,
      result: 'failed',
      failedIndex: 1,
      error: 'no element matches #gone',
    });
    expect(progress(w)).toEqual(['0:running', '0:passed', '1:running', '1:failed no element matches #gone']);
    expect(stepsSent(w).map((s) => s.msg.index)).toEqual([0, 1]);
    const failedMsg = w.relayed.find((m) => m.type === 'REPLAY_PROGRESS' && m.status === 'failed');
    expect(failedMsg.matchCount).toBe(0);
  });

  it('keeps going with stopOnFailure off, and still reports the first failure', async () => {
    const respond = (tabId, msg) =>
      msg.index === 0 || msg.index === 2 ? { ok: false, error: `bad ${msg.index}` } : { ok: true };
    const w = startWorker({ respond });
    const { done: end } = await runToEnd(w, {
      steps: [click('#a'), click('#b'), click('#c'), click('#d')],
      options: { stopOnFailure: false },
    });
    expect(end).toMatchObject({ result: 'failed', failedIndex: 0, error: 'bad 0' });
    expect(progress(w).filter((p) => !p.endsWith('running'))).toEqual([
      '0:failed bad 0',
      '1:passed',
      '2:failed bad 2',
      '3:passed',
    ]);
  });

  it('a failure without an error message still says something', async () => {
    const w = startWorker({ respond: () => ({ ok: false }) });
    const { done: end } = await runToEnd(w, { steps: [click()] });
    expect(end.error).toBe('step failed');
  });

  it('when no frame owns the step it injects, retries once, then fails', async () => {
    const w = startWorker({ respond: () => NO_ANSWER });
    const { done: end } = await runToEnd(w, { steps: [click()] });
    expect(end).toMatchObject({
      result: 'failed',
      failedIndex: 0,
      error: 'frame not found or page navigated',
    });
    expect(stepsSent(w)).toHaveLength(2);
  });

  it('an answer that is not an object counts as no answer', async () => {
    let n = 0;
    const w = startWorker({ respond: () => (n++ === 0 ? 'yes' : { ok: true }) });
    const { done: end } = await runToEnd(w, { steps: [click()] });
    expect(end.result).toBe('passed');
    expect(stepsSent(w)).toHaveLength(2);
  });

  it('a frame that never answers times out after the step budget plus grace', async () => {
    vi.useFakeTimers();
    const w = startWorker({ respond: () => new Promise(() => {}) });
    const r = w.send({
      type: 'REPLAY_START',
      windowId: WINDOW,
      steps: [click()],
      options: { stepTimeoutMs: 1000 },
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(r.response.ok).toBe(true);
    await vi.advanceTimersByTimeAsync(2900);
    expect(done(w)).toBeUndefined(); // 1 s budget + 2 s grace not over yet
    await vi.advanceTimersByTimeAsync(200);
    expect(done(w)).toMatchObject({ result: 'failed', failedIndex: 0, error: 'step timed out after 1s' });
  });
});

describe('replay: heartbeat', () => {
  it('tells the panel a long step is still running every 5 s, and stops once it ends', async () => {
    vi.useFakeTimers();
    let finish;
    const w = startWorker({ respond: () => new Promise((r) => (finish = r)) });
    const r = w.send({
      type: 'REPLAY_START',
      windowId: WINDOW,
      steps: [click()],
      options: { stepTimeoutMs: 60000 },
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(r.response.ok).toBe(true);
    const beats = () => replayMsgs(w).filter((m) => m.type === 'REPLAY_PROGRESS' && m.heartbeat);
    await vi.advanceTimersByTimeAsync(16000);
    expect(beats()).toHaveLength(3);
    expect(beats()[0]).toMatchObject({ index: 0, status: 'running', heartbeat: true });
    finish({ ok: true });
    await vi.advanceTimersByTimeAsync(500); // the click's settle time
    expect(done(w)).toMatchObject({ result: 'passed' });
    await vi.advanceTimersByTimeAsync(20000);
    expect(beats()).toHaveLength(3);
  });
});

describe('replay: step kinds handled by the worker', () => {
  it('skips suggested steps, and reports content-side skips (uploads) as skipped', async () => {
    const respond = (tabId, msg) =>
      msg.step.action === 'upload'
        ? { ok: false, skipped: true, error: "file uploads can't be replayed in the browser" }
        : { ok: true };
    const w = startWorker({ respond });
    const steps = [
      { action: 'assert', assertType: 'toHaveURL', value: URL1, suggested: true },
      { action: 'upload', target: { kind: 'css', value: 'input' } },
      click(),
    ];
    const { done: end } = await runToEnd(w, { steps });
    expect(end.result).toBe('passed');
    expect(progress(w).filter((p) => !p.endsWith('running'))).toEqual([
      '0:skipped suggested step was not accepted',
      "1:skipped file uploads can't be replayed in the browser",
      '2:passed',
    ]);
    expect(stepsSent(w).map((s) => s.msg.index)).toEqual([1, 2]);
  });

  it('a skipped answer without a reason says "skipped"', async () => {
    const w = startWorker({ respond: () => ({ ok: false, skipped: true }) });
    await runToEnd(w, { steps: [click()] });
    expect(progress(w)).toContain('0:skipped skipped');
  });

  it('refuses to navigate to anything but http(s)', async () => {
    const w = startWorker({ respond: () => ({ ok: true }) });
    const { done: end } = await runToEnd(w, {
      steps: [goto('javascript:alert(1)'), { action: 'goto' }],
      options: { stopOnFailure: false },
    });
    expect(w.updates).toEqual([]);
    expect(end.error).toMatch(/can't navigate to "javascript:alert\(1\)"/);
    expect(progress(w)).toContain(
      '1:failed can\'t navigate to "" (only http and https pages can be replayed)'
    );
  });

  it('reports a navigation the browser refuses', async () => {
    const w = startWorker({ navigate: () => 'error', respond: () => ({ ok: true }) });
    const { done: end } = await runToEnd(w, { steps: [goto(), click()] });
    expect(end).toMatchObject({
      result: 'failed',
      failedIndex: 0,
      error: 'navigation failed: Navigation blocked.',
    });
  });

  it('a goto that changes only the hash (no load) passes after a short grace', async () => {
    const w = startWorker({ navigate: () => 'same-document', respond: () => ({ ok: true }) });
    const t0 = Date.now();
    const { done: end } = await runToEnd(w, { steps: [goto(URL1 + '#top')] });
    expect(end.result).toBe('passed');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });

  it('a goto that never finishes loading fails after 15 s', async () => {
    vi.useFakeTimers();
    const w = startWorker({ navigate: () => 'hang' });
    w.send({ type: 'REPLAY_START', windowId: WINDOW, steps: [goto(), click()] });
    await vi.advanceTimersByTimeAsync(14000);
    expect(done(w)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000);
    expect(done(w)).toMatchObject({ result: 'failed', failedIndex: 0, error: 'page did not finish loading' });
  });

  it('a goto onto a page that refuses the content script fails with the restricted-page error', async () => {
    let w;
    w = startWorker({
      navigate: (tabId, url) => {
        if (url.includes('chromewebstore')) w.restrict(tabId);
        return 'normal';
      },
    });
    const { done: end } = await runToEnd(w, { steps: [goto('https://chromewebstore.google.com/x')] });
    expect(end.result).toBe('failed');
    expect(end.error).toMatch(/can't run on this page/);
  });
});

describe('replay: navigation between and during steps', () => {
  it('a click that navigates away before answering counts as passed, and the next step waits for the load', async () => {
    let w;
    const order = [];
    w = startWorker({
      navDelay: 40,
      respond: (tabId, msg) => {
        if (msg.type !== 'REPLAY_STEP') return NO_ANSWER;
        order.push(`step${msg.index}@${w.tabs.get(TAB).status}`);
        if (msg.index === 0) {
          // The link click starts a navigation; the old document's port closes unanswered.
          w.fireUpdated(TAB, 'loading');
          setTimeout(() => w.fireUpdated(TAB, 'complete'), 40);
          return NO_ANSWER;
        }
        return { ok: true };
      },
    });
    const { done: end } = await runToEnd(w, { steps: [click('a[href="/next"]'), fill('x')] });
    expect(end.result).toBe('passed');
    expect(progress(w)).toEqual(['0:running', '0:passed', '1:running', '1:passed']);
    // The click is never sent twice; the fill only goes out once the new page is complete.
    expect(order).toEqual(['step0@complete', 'step1@complete']);
    // Frames of the new page were injected before the next step.
    expect(w.injected.length).toBeGreaterThanOrEqual(2);
  });

  it('a non-action step that loses the race with a navigation is retried once on the new page', async () => {
    let w;
    let calls = 0;
    w = startWorker({
      respond: (tabId, msg) => {
        if (msg.type !== 'REPLAY_STEP') return NO_ANSWER;
        calls++;
        if (calls === 1) {
          w.fireUpdated(TAB, 'loading');
          setTimeout(() => w.fireUpdated(TAB, 'complete'), 10);
          return NO_ANSWER;
        }
        return { ok: true, matchCount: 1 };
      },
    });
    const { done: end } = await runToEnd(w, { steps: [fill('ada')] });
    expect(end.result).toBe('passed');
    expect(stepsSent(w).map((s) => s.msg.index)).toEqual([0, 0]);
  });

  it('…but only once', async () => {
    let w;
    w = startWorker({
      respond: (tabId, msg) => {
        if (msg.type !== 'REPLAY_STEP') return NO_ANSWER;
        w.fireUpdated(TAB, 'loading');
        setTimeout(() => w.fireUpdated(TAB, 'complete'), 5);
        return NO_ANSWER;
      },
    });
    const { done: end } = await runToEnd(w, { steps: [fill('ada')] });
    expect(end).toMatchObject({ result: 'failed', error: 'frame not found or page navigated' });
    expect(stepsSent(w)).toHaveLength(2);
  });

  it('a navigation that starts just after an unanswered step is still noticed', async () => {
    let w;
    w = startWorker({
      respond: (tabId, msg) => {
        if (msg.type !== 'REPLAY_STEP') return NO_ANSWER;
        setTimeout(() => {
          w.fireUpdated(TAB, 'loading');
          setTimeout(() => w.fireUpdated(TAB, 'complete'), 5);
        }, 50);
        return NO_ANSWER;
      },
    });
    const { done: end } = await runToEnd(w, { steps: [click()] });
    expect(end.result).toBe('passed');
    expect(stepsSent(w)).toHaveLength(1);
  });

  it('a step after a page that never finishes loading fails with "page did not finish loading"', async () => {
    vi.useFakeTimers();
    let w;
    w = startWorker({
      respond: (tabId, msg) => {
        if (msg.index === 0) {
          w.fireUpdated(TAB, 'loading'); // and never completes
          return { ok: true };
        }
        return { ok: true };
      },
    });
    w.send({ type: 'REPLAY_START', windowId: WINDOW, steps: [click(), fill('x')] });
    await vi.advanceTimersByTimeAsync(16000);
    expect(done(w)).toMatchObject({ result: 'failed', failedIndex: 1, error: 'page did not finish loading' });
    expect(stepsSent(w).map((s) => s.msg.index)).toEqual([0]);
  });

  it('a navigation the worker saw while idle is waited for before the next step', async () => {
    let w;
    w = startWorker({
      respond: (tabId, msg) => {
        if (msg.index === 0) {
          // Navigated and finished between two steps: the load count moved on.
          w.fireUpdated(TAB, 'loading');
          w.fireUpdated(TAB, 'complete');
        }
        return { ok: true };
      },
    });
    const injectedBefore = () => w.injected.length;
    const { done: end } = await runToEnd(w, { steps: [click(), fill('x')] });
    expect(end.result).toBe('passed');
    // start + the re-check after the navigation
    expect(injectedBefore()).toBeGreaterThanOrEqual(2);
  });
});

describe('replay: sensitive values', () => {
  it('never puts a secret on REPLAY_STEP: the owning frame asks for it, once', async () => {
    const seen = [];
    const answers = [];
    let w;
    w = startWorker({
      respond: (tabId, msg) => {
        if (msg.type !== 'REPLAY_STEP') return NO_ANSWER;
        seen.push(msg);
        if (msg.step.sensitive) {
          const ask = { type: 'REPLAY_SECRET_REQUEST', runId: msg.runId, index: msg.index };
          answers.push(w.fromTab(ask).response);
          // A second frame (or a compromised one) asking for the same attempt gets nothing.
          answers.push(w.fromTab(ask, TAB, { frameId: 3 }).response);
        }
        return { ok: true };
      },
    });
    const steps = [
      fill('', { sensitive: true, secretName: 'password' }),
      fill('plain'),
      fill('', { sensitive: true, secretName: 'pin' }),
    ];
    await runToEnd(w, { steps, secrets: { password: 's3cret', otp: '123456', pin: '', junk: 42 } });
    expect(seen.map((m) => 'secrets' in m)).toEqual([false, false, false]);
    // An empty value is "not provided": nothing to hand out, the page reports the skip.
    expect(answers).toEqual([{ ok: true, value: 's3cret' }, { ok: false }, { ok: false }, { ok: false }]);
    expect(JSON.stringify(w.session)).not.toContain('s3cret');
  });

  it('serves LOCATRA_PASSWORD to a legacy step with no (or an invalid) secretName, as the panel prompts', async () => {
    const answers = [];
    let w;
    w = startWorker({
      respond: (tabId, msg) => {
        if (msg.type !== 'REPLAY_STEP') return NO_ANSWER;
        if (msg.step.sensitive) {
          answers.push(
            w.fromTab({ type: 'REPLAY_SECRET_REQUEST', runId: msg.runId, index: msg.index }).response
          );
        }
        return { ok: true };
      },
    });
    const steps = [
      fill('', { sensitive: true }), // recorded before secretName existed
      fill('', { sensitive: true, secretName: 'not valid!' }),
      fill('', { sensitive: true, secretName: 42 }),
      fill('', { sensitive: true, secretName: 'LOCATRA_SECRET' }),
    ];
    await runToEnd(w, { steps, secrets: { LOCATRA_PASSWORD: 'typed-pw', LOCATRA_SECRET: 'otp-1' } });
    expect(answers).toEqual([
      { ok: true, value: 'typed-pw' },
      { ok: true, value: 'typed-pw' },
      { ok: true, value: 'typed-pw' },
      { ok: true, value: 'otp-1' },
    ]);
  });

  it('refuses a secret request from another tab, an extension page, a stale run or a non-current step', async () => {
    let w;
    const answers = {};
    w = startWorker({
      tabs: [
        { id: TAB, windowId: WINDOW, active: true, status: 'complete' },
        { id: TAB + 1, windowId: WINDOW, active: false, status: 'complete' },
      ],
      respond: (tabId, msg) => {
        if (msg.type !== 'REPLAY_STEP' || !msg.step.sensitive)
          return msg.type === 'REPLAY_STEP' ? { ok: true } : NO_ANSWER;
        const ask = { type: 'REPLAY_SECRET_REQUEST', runId: msg.runId, index: msg.index };
        answers.otherTab = w.fromTab(ask, TAB + 1).response;
        answers.page = w.send(ask).responded;
        answers.staleRun = w.fromTab({ ...ask, runId: 'other-run' }).response;
        answers.otherStep = w.fromTab({ ...ask, index: msg.index + 1 }).response;
        answers.owner = w.fromTab(ask).response;
        return { ok: true };
      },
    });
    await runToEnd(w, {
      steps: [fill('', { sensitive: true, secretName: 'password' })],
      secrets: { password: 'pw' },
    });
    expect(answers).toEqual({
      otherTab: { ok: false },
      page: false,
      staleRun: { ok: false },
      otherStep: { ok: false },
      owner: { ok: true, value: 'pw' },
    });
    // After the run, nothing is left to ask for.
    expect(w.fromTab({ type: 'REPLAY_SECRET_REQUEST', runId: 'x', index: 0 }).response).toEqual({
      ok: false,
    });
  });

  it('propagates the page’s "no value provided" as a skipped step without failing the run', async () => {
    const w = startWorker({
      respond: (tabId, msg) =>
        msg.step.sensitive ? { ok: false, skipped: true, error: 'no value provided' } : { ok: true },
    });
    const { done: end } = await runToEnd(w, {
      steps: [fill('', { sensitive: true, secretName: 'password' }), click()],
      secrets: null,
    });
    expect(end.result).toBe('passed');
    expect(progress(w)).toContain('0:skipped no value provided');
  });
});

describe('replay: start validation', () => {
  it('refuses an empty or malformed step list', async () => {
    const w = startWorker();
    expect(await w.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [] })).toEqual({
      ok: false,
      error: 'There are no steps to replay.',
    });
    expect((await w.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [null, { action: 1 }] })).ok).toBe(
      false
    );
    expect((await w.ask({ type: 'REPLAY_START', windowId: WINDOW })).ok).toBe(false);
  });

  it('refuses absurdly long runs', async () => {
    const w = startWorker();
    const steps = Array.from({ length: 5001 }, () => click());
    expect((await w.ask({ type: 'REPLAY_START', windowId: WINDOW, steps })).error).toMatch(/Too many steps/);
  });

  it('is only accepted from the extension’s own pages', () => {
    const w = startWorker({ respond: () => ({ ok: true }) });
    const r = w.fromTab({ type: 'REPLAY_START', windowId: WINDOW, steps: [click()] });
    expect(r.keptOpen).toBe(false);
    expect(r.responded).toBe(false);
    expect(w.fromTab({ type: 'REPLAY_STOP', windowId: WINDOW }).responded).toBe(false);
  });

  it('refuses a restricted page unless the run starts by navigating away', async () => {
    const w = startWorker({ restrictedTabs: [TAB] });
    const res = await w.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [click()] });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/can't run on this page/);
    // Nothing is left claiming the window.
    const again = await w.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [click()] });
    expect(again.error).not.toMatch(/already running/);

    const w2 = startWorker({ restrictedTabs: [TAB] });
    const ok = await w2.ask({
      type: 'REPLAY_START',
      windowId: WINDOW,
      steps: [{ action: 'viewport', value: '1x1' }, goto()],
    });
    expect(ok.ok).toBe(true);
  });

  it('falls back to the first tab of the window’s recording when the window has no active tab', async () => {
    const w = startWorker({
      tabs: [{ id: 5, windowId: WINDOW, active: true }],
      respond: () => ({ ok: true }),
    });
    await w.ask({ type: 'START_RECORDING', windowId: WINDOW });
    w.tabs.get(5).active = false;
    const res = await w.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [click()] });
    expect(res.ok).toBe(true);
    await until(() => done(w));
    expect(stepsSent(w)[0].tabId).toBe(5);
  });

  it('with neither an active tab nor a recording there is nothing to replay on', async () => {
    const w = startWorker({ tabs: [] });
    expect(await w.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [click()] })).toEqual({
      ok: false,
      error: 'No tab to replay in.',
    });
    expect(await w.ask({ type: 'REPLAY_START', steps: [click()] })).toEqual({
      ok: false,
      error: 'No window to replay in.',
    });
  });
});

describe('replay: one run per window', () => {
  it('rejects a second run in the same window while the first is going', async () => {
    const w = startWorker({ respond: () => new Promise(() => {}) });
    const first = await w.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [click()] });
    expect(first.ok).toBe(true);
    const second = await w.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [click()] });
    expect(second).toEqual({ ok: false, error: 'A replay is already running in this window.' });
    await w.ask({ type: 'REPLAY_STOP', windowId: WINDOW });
  });

  it('two windows replay independently', async () => {
    const w = startWorker({
      tabs: [
        { id: 1, windowId: 10, active: true },
        { id: 2, windowId: 20, active: true },
      ],
      respond: (tabId) => ({ ok: true, matchCount: tabId }),
    });
    const a = await w.ask({ type: 'REPLAY_START', windowId: 10, steps: [click()] });
    const b = await w.ask({ type: 'REPLAY_START', windowId: 20, steps: [click()] });
    expect(a.ok && b.ok).toBe(true);
    await until(() => w.relayed.filter((m) => m.type === 'REPLAY_DONE').length === 2);
    const dones = w.relayed.filter((m) => m.type === 'REPLAY_DONE');
    expect(dones.map((d) => [d.windowId, d.runId, d.result]).sort()).toEqual(
      [
        [10, a.runId, 'passed'],
        [20, b.runId, 'passed'],
      ].sort()
    );
    expect(
      stepsSent(w)
        .map((s) => s.tabId)
        .sort()
    ).toEqual([1, 2]);
  });

  it('a new run may start once the previous one is done', async () => {
    const w = startWorker({ respond: () => ({ ok: true }) });
    await runToEnd(w, { steps: [click()] });
    const again = await w.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [click()] });
    expect(again.ok).toBe(true);
  });
});

describe('replay: stopping', () => {
  it('REPLAY_STOP ends the run at once with "stopped" and sends nothing further', async () => {
    const w = startWorker({ respond: () => new Promise(() => {}) });
    const panel = w.connectPanel(WINDOW);
    const res = await w.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [click(), click('#2')] });
    await until(() => stepsSent(w).length === 1);
    expect(await w.ask({ type: 'REPLAY_STOP', windowId: WINDOW })).toEqual({ ok: true });
    expect(done(w, panel)).toEqual({
      type: 'REPLAY_DONE',
      windowId: WINDOW,
      runId: res.runId,
      result: 'stopped',
    });
    await flush(30);
    expect(stepsSent(w)).toHaveLength(1);
    expect(panel.of('REPLAY_DONE')).toHaveLength(1);
    // The window is free again.
    expect((await w.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [click()] })).ok).toBe(true);
  });

  it('REPLAY_STOP during a slow-motion pause or a load wait ends promptly', async () => {
    const w = startWorker({ respond: () => ({ ok: true }), navigate: () => 'hang' });
    await w.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [goto(), click()] });
    await flush(30);
    await w.ask({ type: 'REPLAY_STOP', windowId: WINDOW });
    expect(done(w).result).toBe('stopped');
    const w2 = startWorker({ respond: () => ({ ok: true }) });
    await w2.ask({
      type: 'REPLAY_START',
      windowId: WINDOW,
      steps: [click(), click()],
      options: { slowMoMs: 5000 },
    });
    await until(() => stepsSent(w2).length === 1);
    await flush(20);
    await w2.ask({ type: 'REPLAY_STOP', windowId: WINDOW });
    expect(done(w2).result).toBe('stopped');
    await flush(20);
    expect(stepsSent(w2)).toHaveLength(1);
  });

  it('REPLAY_STOP with nothing running is a harmless ok; without windowId it uses the focused window', async () => {
    const w = startWorker({ respond: () => new Promise(() => {}) });
    expect(await w.ask({ type: 'REPLAY_STOP', windowId: WINDOW })).toEqual({ ok: true });
    await w.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [click()] });
    expect(await w.ask({ type: 'REPLAY_STOP' })).toEqual({ ok: true });
    expect(done(w).result).toBe('stopped');
  });

  it('stopping one window leaves another window’s run alone', async () => {
    const w = startWorker({
      tabs: [
        { id: 1, windowId: 10, active: true },
        { id: 2, windowId: 20, active: true },
      ],
      respond: () => new Promise(() => {}),
    });
    await w.ask({ type: 'REPLAY_START', windowId: 10, steps: [click()] });
    await w.ask({ type: 'REPLAY_START', windowId: 20, steps: [click()] });
    await w.ask({ type: 'REPLAY_STOP', windowId: 10 });
    const dones = w.relayed.filter((m) => m.type === 'REPLAY_DONE');
    expect(dones.map((d) => d.windowId)).toEqual([10]);
  });

  it('closing the window’s panel stops its run', async () => {
    const w = startWorker({ respond: () => new Promise(() => {}) });
    const panel = w.connectPanel(WINDOW);
    const other = w.connectPanel(99);
    await w.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [click()] });
    other.disconnect(); // another window's panel: irrelevant
    await flush(10);
    expect(done(w, panel)).toBeUndefined();
    panel.disconnect();
    expect(w.relayed.find((m) => m.type === 'REPLAY_DONE')).toMatchObject({
      windowId: WINDOW,
      result: 'stopped',
    });
  });

  it('a second panel of the same window keeps the run alive when one disconnects', async () => {
    const w = startWorker({ respond: () => new Promise(() => {}) });
    const a = w.connectPanel(WINDOW);
    const b = w.connectPanel(WINDOW);
    await w.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [click()] });
    a.disconnect();
    expect(done(w, b)).toBeUndefined();
    await w.ask({ type: 'REPLAY_STOP', windowId: WINDOW });
  });

  it('closing the replayed tab ends the run with an error', async () => {
    const w = startWorker({ respond: () => new Promise(() => {}) });
    await w.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [click()] });
    w.closeTab(TAB);
    expect(done(w)).toMatchObject({ result: 'error', error: 'The tab being replayed was closed.' });
  });

  it('a tab that disappears between steps ends the run with an error', async () => {
    let w;
    w = startWorker({
      respond: () => {
        w.tabs.delete(TAB); // gone without onRemoved having fired yet
        return { ok: true };
      },
    });
    const { done: end } = await runToEnd(w, { steps: [click(), click()] });
    expect(end).toMatchObject({
      result: 'error',
      failedIndex: 1,
      error: 'The tab being replayed was closed.',
    });
  });

  it('closing the window drops its run', async () => {
    const w = startWorker({ respond: () => new Promise(() => {}) });
    await w.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [click()] });
    w.closeWindow(WINDOW);
    expect(done(w).result).toBe('stopped');
  });
});

describe('replay: recording is paused for the run and restored afterwards', () => {
  const recordingState = (w) => w.ask({ type: 'GET_RECORDING_STATE', windowId: WINDOW });
  const toTab = (w, type) => w.sent.filter((s) => s.tabId === TAB && s.msg.type === type);

  it('pauses a live recording, then resumes it', async () => {
    let w;
    let pausedDuringStep = null;
    w = startWorker({
      respond: (tabId, msg) => {
        if (msg.type === 'REPLAY_STEP') pausedDuringStep = w.session.llWorkerState.sessions[0].paused;
        return { ok: true };
      },
    });
    await w.ask({ type: 'START_RECORDING', windowId: WINDOW });
    await runToEnd(w, { steps: [click()] });
    expect(pausedDuringStep).toBe(true);
    expect(toTab(w, 'PAUSE_RECORDING')).toHaveLength(1);
    expect(toTab(w, 'RESUME_RECORDING')).toHaveLength(1);
    expect((await recordingState(w)).paused).toBe(false);
  });

  it('leaves an already paused recording paused', async () => {
    const w = startWorker({ respond: () => ({ ok: true }) });
    await w.ask({ type: 'START_RECORDING', windowId: WINDOW });
    await w.ask({ type: 'PAUSE_RECORDING', windowId: WINDOW });
    await runToEnd(w, { steps: [click()] });
    expect(toTab(w, 'RESUME_RECORDING')).toHaveLength(0);
    expect((await recordingState(w)).paused).toBe(true);
  });

  it('does nothing to recording when there is none', async () => {
    const w = startWorker({ respond: () => ({ ok: true }) });
    await runToEnd(w, { steps: [click()] });
    expect(toTab(w, 'PAUSE_RECORDING')).toHaveLength(0);
    expect((await recordingState(w)).active).toBe(false);
  });

  it('restores after a stop, and after a failure', async () => {
    const w = startWorker({ respond: () => ({ ok: false, error: 'nope' }) });
    await w.ask({ type: 'START_RECORDING', windowId: WINDOW });
    await runToEnd(w, { steps: [click()] });
    expect((await recordingState(w)).paused).toBe(false);

    const w2 = startWorker({ respond: () => new Promise(() => {}) });
    await w2.ask({ type: 'START_RECORDING', windowId: WINDOW });
    await w2.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [click()] });
    expect((await w2.ask({ type: 'GET_RECORDING_STATE', windowId: WINDOW })).paused).toBe(true);
    await w2.ask({ type: 'REPLAY_STOP', windowId: WINDOW });
    expect((await w2.ask({ type: 'GET_RECORDING_STATE', windowId: WINDOW })).paused).toBe(false);
  });

  it('a pause the user chose during the run is not undone', async () => {
    const w = startWorker({ respond: () => new Promise(() => {}) });
    await w.ask({ type: 'START_RECORDING', windowId: WINDOW });
    await w.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [click()] });
    await w.ask({ type: 'PAUSE_RECORDING', windowId: WINDOW });
    await w.ask({ type: 'REPLAY_STOP', windowId: WINDOW });
    expect((await recordingState(w)).paused).toBe(true);
    expect(toTab(w, 'RESUME_RECORDING')).toHaveLength(0);
  });

  it('a recording stopped during the run stays stopped', async () => {
    const w = startWorker({ respond: () => new Promise(() => {}) });
    await w.ask({ type: 'START_RECORDING', windowId: WINDOW });
    await w.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [click()] });
    await w.ask({ type: 'STOP_RECORDING', windowId: WINDOW });
    await w.ask({ type: 'REPLAY_STOP', windowId: WINDOW });
    expect((await recordingState(w)).active).toBe(false);
    expect(toTab(w, 'RESUME_RECORDING')).toHaveLength(0);
  });

  it('START_RECORDING during a run hands control back to the user too', async () => {
    const w = startWorker({ respond: () => new Promise(() => {}) });
    await w.ask({ type: 'START_RECORDING', windowId: WINDOW });
    await w.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [click()] });
    await w.ask({ type: 'START_RECORDING', windowId: WINDOW });
    await w.ask({ type: 'PAUSE_RECORDING', windowId: WINDOW });
    await w.ask({ type: 'REPLAY_STOP', windowId: WINDOW });
    expect((await recordingState(w)).paused).toBe(true);
  });

  it('a goto during the run re-arms the recording tab still paused', async () => {
    const w = startWorker({ respond: () => ({ ok: true }) });
    await w.ask({ type: 'START_RECORDING', windowId: WINDOW });
    await runToEnd(w, { steps: [goto()] });
    const rearm = w.sent.find((s) => s.msg.type === 'START_RECORDING' && s.msg.rearm);
    expect(rearm.msg.paused).toBe(true);
  });
});

describe('replay: the worker is evicted mid-run', () => {
  it('the next worker tells the panel the run ended in error, and gives the recording back', async () => {
    const session = {};
    const w1 = startWorker({ session, respond: () => new Promise(() => {}) });
    await w1.ask({ type: 'START_RECORDING', windowId: WINDOW });
    const res = await w1.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [click()] });
    await flush(10);
    expect(session.llWorkerState.replays).toEqual([
      { windowId: WINDOW, runId: res.runId, resume: [WINDOW], at: expect.any(Number) },
    ]);
    expect(session.llWorkerState.sessions[0].paused).toBe(true);

    // Chrome kills w1. The panel's port reconnects to a fresh instance.
    const w2 = startWorker({ session });
    const panel = w2.connectPanel(WINDOW);
    await until(() => panel.of('REPLAY_DONE').length);
    expect(panel.of('REPLAY_DONE')).toEqual([
      {
        type: 'REPLAY_DONE',
        windowId: WINDOW,
        runId: res.runId,
        result: 'error',
        error: expect.stringMatching(/interrupted/),
      },
    ]);
    expect(w2.sent.filter((s) => s.msg.type === 'RESUME_RECORDING')).toHaveLength(1);
    expect((await w2.ask({ type: 'GET_RECORDING_STATE', windowId: WINDOW })).paused).toBe(false);
    await flush(10);
    expect(session.llWorkerState.replays).toEqual([]);

    // Told once: a third instance has nothing more to say.
    const w3 = startWorker({ session });
    const panel3 = w3.connectPanel(WINDOW);
    await flush(10);
    expect(panel3.of('REPLAY_DONE')).toEqual([]);
  });

  it('when the panel is not back yet, it is told on its next REPLAY_STOP or hello', async () => {
    const session = {};
    const w1 = startWorker({ session, respond: () => new Promise(() => {}) });
    const res = await w1.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [click()] });
    await flush(5);

    const w2 = startWorker({ session });
    // Some other event wakes the worker first; no panel port yet → best-effort broadcast.
    await w2.ask({ type: 'GET_PANEL_STATE', windowId: WINDOW });
    expect(w2.relayed.filter((m) => m.type === 'REPLAY_DONE')).toHaveLength(1);
    await flush(5);
    expect(session.llWorkerState.replays).toHaveLength(1); // not yet confirmed delivered

    const other = w2.connectPanel(99); // another window's panel does not consume it
    await flush(5);
    expect(other.of('REPLAY_DONE')).toEqual([]);

    // The panel never reconnected its port but presses Stop.
    w2.relayed.length = 0;
    expect(await w2.ask({ type: 'REPLAY_STOP', windowId: WINDOW })).toEqual({ ok: true });
    await flush(5);
    expect(w2.relayed.find((m) => m.type === 'REPLAY_DONE')).toMatchObject({
      runId: res.runId,
      result: 'error',
    });

    const panel = w2.connectPanel(WINDOW);
    await until(() => panel.of('REPLAY_DONE').length);
    await flush(5);
    expect(session.llWorkerState.replays).toEqual([]);
  });

  it('a new run in that window supersedes the interrupted one', async () => {
    const session = {};
    const w1 = startWorker({ session, respond: () => new Promise(() => {}) });
    await w1.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [click()] });
    await flush(5);
    const w2 = startWorker({ session, respond: () => new Promise(() => {}) });
    const res = await w2.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [click()] });
    expect(res.ok).toBe(true);
    await flush(5);
    expect(session.llWorkerState.replays.map((r) => r.runId)).toEqual([res.runId]);
  });

  it('forgets interrupted runs that are very old, malformed, or whose window closed', async () => {
    const session = {
      llWorkerState: {
        replays: [
          { windowId: WINDOW, runId: 'ancient', resume: [], at: Date.now() - 2 * 60 * 60 * 1000 },
          { windowId: 'x', runId: 'bad' },
          null,
          { windowId: 8, runId: 'closing', resume: 'nope' },
        ],
      },
    };
    const w = startWorker({ session });
    await w.ask({ type: 'GET_PANEL_STATE', windowId: WINDOW });
    expect(w.relayed.filter((m) => m.type === 'REPLAY_DONE').map((m) => m.runId)).toEqual(['closing']);
    w.closeWindow(8);
    await flush(5);
    expect(session.llWorkerState.replays).toEqual([]);
  });

  it('a user who changed the recording state meanwhile keeps it after the restart', async () => {
    const session = {};
    const w1 = startWorker({ session, respond: () => new Promise(() => {}) });
    await w1.ask({ type: 'START_RECORDING', windowId: WINDOW });
    await w1.ask({ type: 'REPLAY_START', windowId: WINDOW, steps: [click()] });
    await flush(5);
    const w2 = startWorker({ session });
    // The first message hydrates the new instance (which gives the recording back),
    // then applies the user's pause: the pause is what sticks.
    await w2.ask({ type: 'PAUSE_RECORDING', windowId: WINDOW });
    await flush(5);
    expect((await w2.ask({ type: 'GET_RECORDING_STATE', windowId: WINDOW })).paused).toBe(true);
    expect(session.llWorkerState.sessions[0].paused).toBe(true);
  });
});
