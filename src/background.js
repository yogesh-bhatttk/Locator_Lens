// Locatra – background.js (Service Worker)
// Handles communication between popup, side panel, and content script
//
// Everything here is window-scoped. The side panel is a per-window surface, so two
// windows can each inspect, each record and each have their own panel open at once;
// every piece of state below is keyed so that one window's activity can never
// steer, stop or show up in another's.

// Step-screenshot storage (globalThis.LLThumbs), shared with the side panel.
// Chrome runs this file as a classic service worker, so it pulls the store in
// itself (resolved next to this file: src/thumbs-store.js). Firefox's background is
// a module page with no importScripts; its manifest lists thumbs-store.js before
// this file instead. Either way a missing store only means no thumbnails.
/* global importScripts */
if (typeof importScripts === 'function' && !globalThis.LLThumbs) {
  try {
    importScripts('thumbs-store.js');
  } catch (e) {}
}

/**
 * Load order matters: the code-generator targets register themselves on
 * LLCodegen (codegen.js) and the engine defines __LocatorLensEngine, both before
 * content.js runs. Same list, same order, as content_scripts in both manifests.
 */
const CONTENT_SCRIPT_FILES = [
  'src/codegen.js',
  'src/codegen-java.js',
  'src/codegen-csharp.js',
  'src/codegen-wdio.js',
  'src/content-locator-engine.js',
  'src/content.js'
];

/** Shown by the panel/popup when a page refuses the content script. */
const RESTRICTED_PAGE_ERROR =
  "Locatra can't run on this page (browser pages, the Web Store, PDFs and some file:// pages are off-limits).";

/**
 * Shown instead when the browser refused the script for want of a permission: the
 * user set site access to "on click" (or revoked it), and a side-panel button is no
 * gesture that grants activeTab.
 */
const SITE_ACCESS_ERROR =
  "Locatra may not have access to this page. If it is a website, allow Locatra site access from the browser's " +
  'extensions menu, then try again. (Browser pages, the Web Store and PDFs stay off-limits.)';

/** tabId -> the browser's message from the last failed injection into that tab. */
const injectErrors = new Map();
const PERMISSION_REFUSAL = /must request permission|missing host permission|permission to access/i;

// Chrome refuses about:blank with the very words it uses for a site whose access
// the user withheld, so the message alone cannot tell the two apart. What can: is
// the http/https host access the manifest asks for actually granted right now?
const WEB_ORIGINS = { origins: ['http://*/*', 'https://*/*'] };
let hostAccessWithheld = false;

function checkHostAccess() {
  const perms = chrome.permissions;
  if (!perms || typeof perms.contains !== 'function') return;
  try {
    perms.contains(WEB_ORIGINS, (granted) => {
      hostAccessWithheld = !chrome.runtime.lastError && granted === false;
    });
  } catch (e) {
    hostAccessWithheld = false;
  }
}
checkHostAccess();

/** Why a tab's page has no live content script, in words the user can act on. */
function unreachableError(tabId) {
  const refusedForPermission = PERMISSION_REFUSAL.test(injectErrors.get(tabId) || '');
  return refusedForPermission && hostAccessWithheld ? SITE_ACCESS_ERROR : RESTRICTED_PAGE_ERROR;
}

function noteInjection(tabId) {
  const err = chrome.runtime.lastError;
  if (err) {
    injectErrors.set(tabId, String(err.message || err));
    // Site access can change from the browser's menu at any moment; the ping that
    // follows this injection gives the answer time to land before it is used.
    checkHostAccess();
  } else injectErrors.delete(tabId);
}

// The manifest injects only the top frame, deliberately: a content script declared
// with all_frames runs in every ad and tracking iframe of every page the user
// visits, and parsing it there costs them something for nothing. Frames that
// actually matter get the script when a feature is switched on, and content.js
// no-ops on a frame that already has it.
function injectAllFrames(tabId, done) {
  chrome.scripting.executeScript(
    { target: { tabId, allFrames: true }, files: CONTENT_SCRIPT_FILES },
    () => {
      // Restricted page, or a frame that vanished. Swallowed here on purpose: the
      // caller that needs to know whether the page is usable asks it directly
      // (pingTopFrame), which also catches an orphaned script from a previous
      // install that injection could not replace. The reason is kept for the
      // message the user sees if that check fails.
      noteInjection(tabId);
      if (done) done();
    }
  );
}

/** Send to one frame when we know which; otherwise every frame in the tab. */
function sendToFrame(tabId, msg, frameId, cb) {
  const options = typeof frameId === 'number' ? { frameId } : undefined;
  if (options) chrome.tabs.sendMessage(tabId, msg, options, cb || (() => void chrome.runtime.lastError));
  else chrome.tabs.sendMessage(tabId, msg, cb || (() => void chrome.runtime.lastError));
}

/** Does the tab's top frame have a live content script? cb(boolean). */
function pingTopFrame(tabId, cb) {
  sendToFrame(tabId, { type: 'PING' }, 0, (res) => {
    cb(!chrome.runtime.lastError && !!res && res.ok === true);
  });
}

/**
 * "The active tab" for a message. The panel and popup say which window they live
 * in; falling back to currentWindow is only for callers that predate that, and is
 * exactly what used to aim a second window's Stop at the first window's tab.
 */
function queryActiveTab(windowId, cb) {
  const q = typeof windowId === 'number' ? { active: true, windowId } : { active: true, currentWindow: true };
  chrome.tabs.query(q, (tabs) => {
    void chrome.runtime.lastError;
    cb((tabs && tabs[0]) || null);
  });
}

const isWindowId = (v) => typeof v === 'number';

// Long-lived channels so the service worker can push UI updates (recording, picks)
// to the side panel reliably.
//
// One panel exists per browser window, so this is a map of port -> the window the
// panel said it lives in (PANEL_HELLO). A relay is delivered only to the panel of
// the window it concerns; a port that has not said hello yet (null) gets everything,
// and the panel filters by windowId itself as well.
const sidePanelPorts = new Map();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'll-sidepanel') return;
  sidePanelPorts.set(port, null);
  if (port.onMessage && port.onMessage.addListener) {
    port.onMessage.addListener((msg) => handlePortMessage(port, msg));
  }
  port.onDisconnect.addListener(() => {
    const windowId = sidePanelPorts.get(port);
    sidePanelPorts.delete(port);
    // A replay reports to its panel; with that panel gone nobody can see or stop
    // it, so it stops too.
    if (isWindowId(windowId) && !hasPanelPort(windowId)) {
      const run = replayRuns.get(windowId);
      if (run) abortReplay(run, 'stopped');
    }
    // The panel closed. Forget its heartbeat now rather than letting the popup
    // claim "open" for another TTL's worth of seconds.
    if (isWindowId(windowId) && !hasPanelPort(windowId)) {
      ready().then(() => {
        if (hasPanelPort(windowId) || !(windowId in panelSeen)) return;
        delete panelSeen[windowId];
        persistState();
      });
    }
  });
});

function hasPanelPort(windowId) {
  for (const w of sidePanelPorts.values()) if (w === windowId) return true;
  return false;
}

function handlePortMessage(port, msg) {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'PANEL_HELLO') {
    const windowId = isWindowId(msg.windowId) ? msg.windowId : null;
    sidePanelPorts.set(port, windowId);
    if (windowId === null) return;
    ready().then(() => {
      panelSeen[windowId] = Date.now();
      persistState();
      // Steps recorded while this window's panel was closed (C7). Replayed in
      // order as ordinary relays; the panel dedupes by eventId, and the buffer is
      // only dropped once it acknowledges.
      const buffered = recordBuffers[windowId] || [];
      for (const data of buffered) {
        try {
          port.postMessage({ type: 'RECORDED_ACTION', data, windowId, tabId: data.tabId, replayed: true });
        } catch (e) {
          return; // the panel went away mid-replay; keep the buffer for next time
        }
      }
      try {
        port.postMessage({ type: 'PANEL_BUFFER_REPLAYED', windowId, count: buffered.length });
      } catch (e) {}
      // A replay this panel was watching died with the previous worker instance.
      settleInterruptedReplays(windowId);
    });
    return;
  }
  if (msg.type === 'PANEL_BUFFER_ACK') {
    const windowId = isWindowId(msg.windowId) ? msg.windowId : sidePanelPorts.get(port);
    clearRecordBuffer(windowId);
  }
}

// ── Durable service-worker state ─────────────────────────────────────────────
// MV3 tears down an idle service worker after ~30 seconds and every module-scope
// variable goes with it. That is not a theoretical concern here: the recording
// sessions are what re-arm capture after a full-page navigation, so once the worker
// had been evicted a multi-page recording silently stopped collecting steps partway
// through, and the inspect set made GET_INSPECT_STATE report "not inspecting" to a
// popup whose page was still in inspect mode.
//
// chrome.storage.session holds these for the life of the browser session and is
// never written to disk. Where it is unavailable we degrade to the old in-memory
// behaviour rather than fall back to storage.local, which would resurrect stale
// tab ids after a browser restart.
const SESSION_STATE_KEY = 'llWorkerState';
const RECORD_BUFFER_KEY = 'llRecordBuffer';
const RECORD_BUFFER_CAP = 1000;
const sessionArea = (chrome.storage && chrome.storage.session) || null;

/** tabId -> windowId (or null when unknown) for every tab in inspect mode. */
const inspectTabs = new Map();

// A recording session belongs to one window: { windowId, tabIds:Set, paused,
// assertMode, assertType }. Stop/Pause/Resume/Assert act on every tab of the
// session — not on whichever tab happens to be active — and tabs opened from a
// session tab join it. Pause lives here (not just in the content scripts) so a
// panel reopened mid-pause, and a page re-armed after navigation, both learn it.
const sessions = new Map();

// Panel liveness per window: windowId -> last heartbeat. Kept alive by the panel's
// heartbeat; the TTL comparison in isPanelActive() is what expires a stale one — a
// setTimeout would not survive worker eviction anyway. 'any' collects heartbeats
// from a panel that did not say which window it is in.
const PANEL_HEARTBEAT_TTL_MS = 12000;
let panelSeen = {};

// Which tab+frame produced the last pick. The Stress Test runs against that element,
// and only the frame holding it can answer — broadcasting to every frame would have
// them all race to sendResponse. Cleared when that tab closes or navigates.
let lastPick = null;

/** windowId -> RECORDED_ACTION payloads not yet acknowledged by that window's panel. */
let recordBuffers = {};

/** windowId -> the replay running in that window (at most one per window). */
const replayRuns = new Map();

/**
 * Replays whose worker instance died mid-run: { windowId, runId, resume, at }.
 * Kept (and persisted) until that window's panel has been told the run ended.
 */
let interruptedReplays = [];
const INTERRUPTED_REPLAY_TTL_MS = 60 * 60 * 1000;

function isPanelActive(windowId) {
  const fresh = (t) => typeof t === 'number' && t > 0 && Date.now() - t < PANEL_HEARTBEAT_TTL_MS;
  if (isWindowId(windowId)) return hasPanelPort(windowId) || fresh(panelSeen[windowId]);
  if (sidePanelPorts.size > 0) return true;
  return Object.keys(panelSeen).some((k) => fresh(panelSeen[k]));
}

/** The session a tab records into, if any. */
function sessionForTab(tabId) {
  for (const s of sessions.values()) if (s.tabIds.has(tabId)) return s;
  return null;
}

let hydrated = !sessionArea;
let hydrating = null;

/** Resolve once this worker instance has its state back. Cheap after the first call. */
function ready() {
  if (hydrated) return Promise.resolve();
  if (hydrating) return hydrating;
  hydrating = new Promise((resolve) => {
    sessionArea.get([SESSION_STATE_KEY, RECORD_BUFFER_KEY], (res) => {
      void chrome.runtime.lastError;
      const saved = (res && res[SESSION_STATE_KEY]) || {};
      if (Array.isArray(saved.inspect)) {
        saved.inspect.forEach((entry) => {
          // Current shape is [tabId, windowId]; a bare id is the pre-window shape.
          if (Array.isArray(entry)) inspectTabs.set(entry[0], isWindowId(entry[1]) ? entry[1] : null);
          else if (typeof entry === 'number') inspectTabs.set(entry, null);
        });
      }
      if (Array.isArray(saved.sessions)) {
        saved.sessions.forEach((s) => {
          if (!s || !isWindowId(s.windowId)) return;
          sessions.set(s.windowId, {
            windowId: s.windowId,
            tabIds: new Set(Array.isArray(s.tabIds) ? s.tabIds : []),
            paused: !!s.paused,
            assertMode: !!s.assertMode,
            assertType: s.assertType || null
          });
        });
      }
      if (saved.panelSeen && typeof saved.panelSeen === 'object') panelSeen = Object.assign({}, saved.panelSeen);
      else if (typeof saved.panelLastSeen === 'number') panelSeen = { any: saved.panelLastSeen };
      if (saved.lastPick) lastPick = saved.lastPick;
      const buf = res && res[RECORD_BUFFER_KEY];
      if (buf && typeof buf === 'object') recordBuffers = Object.assign({}, buf);
      // Any replay on record belonged to a previous worker instance, and its step
      // loop died with it: nothing is driving it any more.
      if (Array.isArray(saved.replays)) {
        const cutoff = Date.now() - INTERRUPTED_REPLAY_TTL_MS;
        saved.replays.forEach((r) => {
          if (!r || !isWindowId(r.windowId) || typeof r.runId !== 'string') return;
          if (typeof r.at === 'number' && r.at < cutoff) return;
          interruptedReplays.push({
            windowId: r.windowId,
            runId: r.runId,
            resume: Array.isArray(r.resume) ? r.resume.filter(isWindowId) : [],
            at: typeof r.at === 'number' ? r.at : Date.now()
          });
        });
      }
      hydrated = true;
      hydrating = null;
      resolve();
      if (interruptedReplays.length) settleInterruptedReplays();
    });
  });
  return hydrating;
}

// Writes are chained so they land in the order they were made: each one snapshots
// the state synchronously, and a slow earlier set() can never overwrite a later one.
let writeChain = Promise.resolve();
function queueWrite(obj) {
  if (!sessionArea) return;
  writeChain = writeChain.then(
    () =>
      new Promise((resolve) => {
        sessionArea.set(obj, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      })
  );
}

function persistState() {
  queueWrite({
    [SESSION_STATE_KEY]: {
      inspect: Array.from(inspectTabs.entries()),
      sessions: Array.from(sessions.values()).map((s) => ({
        windowId: s.windowId,
        tabIds: Array.from(s.tabIds),
        paused: s.paused,
        assertMode: s.assertMode,
        assertType: s.assertType
      })),
      panelSeen,
      lastPick,
      // Only what is needed to clean up after a worker restart — never the steps
      // or the secrets of a run.
      replays: Array.from(replayRuns.values())
        .map((r) => ({ windowId: r.windowId, runId: r.runId, resume: Array.from(r.resume), at: r.startedAt }))
        .concat(interruptedReplays)
    }
  });
}

function persistBuffers() {
  queueWrite({ [RECORD_BUFFER_KEY]: recordBuffers });
}

function bufferRecordedAction(windowId, data) {
  if (!isWindowId(windowId)) return;
  ready().then(() => {
    const list = recordBuffers[windowId] || (recordBuffers[windowId] = []);
    list.push(data);
    if (list.length > RECORD_BUFFER_CAP) list.splice(0, list.length - RECORD_BUFFER_CAP);
    persistBuffers();
  });
}

function clearRecordBuffer(windowId) {
  if (!isWindowId(windowId)) return;
  ready().then(() => {
    if (!recordBuffers[windowId]) return;
    delete recordBuffers[windowId];
    persistBuffers();
  });
}

// ── Register context menu on install ────────────────────────────────────────
// onInstalled also fires with reason "update", and menu items survive updates —
// re-creating an existing id fails with "Cannot create item with duplicate id"
// and leaves the menu half-registered. removeAll() first makes this idempotent.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({
      id: 'll-copy-locator',
      title: '🎯 Copy Best Locator',
      contexts: ['all']
    }, () => { void chrome.runtime.lastError; });
    // Neither browser lets a background page close the panel, so the item only
    // promises what it does.
    chrome.contextMenus.create({
      id: 'll-toggle-panel',
      title: '📋 Open Results Panel',
      contexts: ['all']
    }, () => { void chrome.runtime.lastError; });
  });
});

// ── Context menu click ────────────────────────────────────────────────────────
chrome.contextMenus.onClicked.addListener((info, tab) => {
  // Any menu click grants activeTab on that tab: a capture there may work again.
  if (tab && typeof tab.id === 'number') captureBlockedTabs.delete(tab.id);
  if (info.menuItemId === 'll-toggle-panel' && tab && tab.windowId) {
    // Synchronous on purpose: the menu click is the user gesture open() needs.
    openSidePanel(tab.windowId);
    return;
  }
  if (info.menuItemId !== 'll-copy-locator') return;
  if (!tab || !tab.id) return;

  // info.frameId identifies the frame the user right-clicked in. Without it the
  // message goes to every frame and each one answers for whatever *it* last saw
  // under the cursor — so the copied locator would be a race between frames.
  // targetElementId (Firefox) lets that frame resolve the exact element instead of
  // relying on its own record of the last right-click.
  const frameId = typeof info.frameId === 'number' ? info.frameId : 0;
  const copyMsg = { type: 'CONTEXT_MENU_COPY', targetElementId: info.targetElementId };
  sendToFrame(tab.id, copyMsg, frameId, () => {
    if (!chrome.runtime.lastError) return;
    injectAllFrames(tab.id, () => {
      setTimeout(() => sendToFrame(tab.id, copyMsg, frameId), 100);
    });
  });
});

// ── Helper: open side panel for a window ──────────────────────────────────────
// Only for callers already on a user gesture (the context menu). The popup opens
// the panel itself, inside its own click handler: a message hop to this worker
// plus an async tab query used to lose the gesture, so open() was rejected and the
// rejection swallowed while the popup claimed the panel was open.
/** @returns a promise that rejects with the browser's reason, or null if unsupported. */
function openSidePanel(windowId) {
  if (!windowId) return null;
  // Use bracket notation to avoid static analyzer warnings in Firefox
  const sidePanel = chrome['sidePanel'];
  let p = null;
  if (sidePanel && sidePanel.open) {
    p = sidePanel.open({ windowId });
  } else if (typeof browser !== 'undefined' && browser.sidebarAction && browser.sidebarAction.open) {
    p = browser.sidebarAction.open();
  }
  if (p && p.catch) p.catch(() => { });
  return p;
}

// ── Helper: relay message to side panel ──────────────────────────────────────
/**
 * Deliver to the panel of the window the message concerns (msg.windowId). Ports
 * that have not said hello yet get everything. With no matching panel connected,
 * fall back to a broadcast — which also reaches the popup, and which the panel
 * filters by windowId.
 */
function relayToSidePanel(msg) {
  let delivered = 0;
  for (const [port, portWindow] of Array.from(sidePanelPorts.entries())) {
    if (isWindowId(msg.windowId) && isWindowId(portWindow) && portWindow !== msg.windowId) continue;
    try {
      port.postMessage(msg);
      delivered++;
    } catch (e) {
      sidePanelPorts.delete(port); // disconnected between the check and the post
    }
  }
  if (delivered > 0) return;
  chrome.runtime.sendMessage(msg, () => {
    void chrome.runtime.lastError;
  });
}

const respondOnce = (sendResponse) => {
  let done = false;
  return (r) => {
    if (done) return;
    done = true;
    try {
      sendResponse(r);
    } catch (e) {}
  };
};

// A content script's sender has a tab, but so does an extension page opened as a
// normal tab (sidepanel.html or popup.html loaded directly — the smoke test does
// this, and so can a user). Classifying by sender.tab alone made those pages look
// like content scripts, so their START_RECORDING / START_INSPECT went unanswered.
// The sender's URL is what tells them apart.
function isExtensionPageSender(sender) {
  if (!sender || typeof sender.url !== 'string') return false;
  try {
    return sender.url.startsWith(chrome.runtime.getURL(''));
  } catch (e) {
    return false;
  }
}
function isContentScriptSender(sender) {
  return !!(sender && sender.tab && typeof sender.tab.id === 'number' && !isExtensionPageSender(sender));
}

// ── Popup / SidePanel ↔ Content message relay ─────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  const fromTab = isContentScriptSender(sender) ? sender.tab : null;

  // PING is answered by content scripts; the worker has nothing to say.
  if (msg.type === 'PING') return;

  // The user invoked Locatra on the window's active tab: a capture there may work again.
  if (!fromTab && TAB_INVOKING_COMMANDS.has(msg.type)) unblockActiveTabCapture(msg.windowId);

  // ── Content script lifecycle (C3) ──
  // Every freshly initialised frame asks what it should be doing. That is how a
  // page loaded mid-recording, and an iframe added mid-recording, arm themselves.
  if (msg.type === 'CONTENT_READY') {
    if (!fromTab) return;
    ready().then(() => {
      const s = sessionForTab(fromTab.id);
      sendResponse({
        recording: !!s,
        paused: s ? s.paused : false,
        assertMode: s ? s.assertMode : false,
        assertType: s ? s.assertType : null,
        inspecting: inspectTabs.has(fromTab.id)
      });
    });
    return true;
  }

  if (msg.type === 'REQUEST_FRAME_INJECTION') {
    if (!fromTab) return;
    requestFrameInjection(fromTab.id);
    return;
  }

  // START_INSPECT (panel/popup): activate on the window's active tab. The panel is
  // not opened here — see openSidePanel().
  if (msg.type === 'START_INSPECT') {
    if (fromTab) return; // only the UI starts inspecting
    const respond = respondOnce(sendResponse);
    queryActiveTab(msg.windowId, (tab) => {
      if (!tab) {
        respond({ ok: false, error: 'No active tab to inspect.' });
        return;
      }
      startInspect(tab, respond);
    });
    return true;
  }

  if (msg.type === 'STOP_INSPECT') {
    if (fromTab) {
      // The page stopped by itself (Esc, or its extension context died). Stop the
      // tab's other frames too, and tell that window's UI.
      ready().then(() => {
        if (inspectTabs.delete(fromTab.id)) persistState();
      });
      sendToFrame(fromTab.id, { type: 'STOP_INSPECT' });
      relayToSidePanel({ type: 'STOP_INSPECT', windowId: fromTab.windowId, tabId: fromTab.id });
      return;
    }
    queryActiveTab(msg.windowId, (tab) => stopInspect(msg.windowId, tab, sendResponse));
    return true;
  }

  // ELEMENT_PICKED: store + relay to side panel
  if (msg.type === 'ELEMENT_PICKED') {
    const tabId = fromTab ? fromTab.id : undefined;
    const windowId = fromTab ? fromTab.windowId : undefined;
    const data = Object.assign({}, msg.data || {}, { tabId, windowId });
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ lastElement: data }); // local storage for cross-browser compatibility
    }
    if (fromTab) {
      ready().then(() => {
        lastPick = { tabId, windowId, frameId: typeof sender.frameId === 'number' ? sender.frameId : 0 };
        persistState();
      });
    }
    relayToSidePanel({ type: 'ELEMENT_PICKED', data, windowId, tabId });
    return;
  }

  // Selector Lab results come straight from a page; the panel ignores page
  // broadcasts (it cannot tell which window they came from), so they reach it
  // through here, tagged. (A dblclick's supersession rides inside its
  // RECORDED_ACTION, so it stays in order with the steps it replaces.)
  // Page Object results (POM_RESULT / POM_PICK_CANCELLED) travel the same way.
  if (
    msg.type === 'LAB_STATUS_UPDATE' ||
    msg.type === 'LAB_ERROR' ||
    msg.type === 'POM_RESULT' ||
    msg.type === 'POM_PICK_CANCELLED'
  ) {
    if (!fromTab) return;
    relayToSidePanel(Object.assign({}, msg, { windowId: fromTab.windowId, tabId: fromTab.id }));
    // Region picking runs in every frame, but only the frame that got the click
    // (or Esc) ends by itself: take the others out of pick mode too.
    if (msg.type === 'POM_RESULT' || msg.type === 'POM_PICK_CANCELLED') {
      sendToFrame(fromTab.id, { type: 'POM_PICK_STOP' });
    }
    return;
  }

  // Popup / SidePanel checking inspect state
  if (msg.type === 'GET_INSPECT_STATE') {
    ready().then(() => {
      queryActiveTab(msg.windowId, (tab) => {
        sendResponse({ active: tab ? inspectTabs.has(tab.id) : false });
      });
    });
    return true;
  }

  // Side panel reopened mid-session: without this it renders "Start Recording"
  // while the page is still capturing, and the next click sends START on an
  // already-recording tab instead of stopping it.
  if (msg.type === 'GET_RECORDING_STATE') {
    ready().then(() => {
      const answer = (windowId) => {
        const s = isWindowId(windowId) ? sessions.get(windowId) : null;
        sendResponse({
          active: !!s,
          paused: s ? s.paused : false,
          assertMode: s ? s.assertMode : false,
          assertType: s ? s.assertType : null,
          tabIds: s ? Array.from(s.tabIds) : [],
          anyTab: sessions.size > 0
        });
      };
      if (isWindowId(msg.windowId)) answer(msg.windowId);
      else queryActiveTab(undefined, (tab) => answer(tab ? tab.windowId : undefined));
    });
    return true;
  }

  // OPEN_SIDE_PANEL / CLOSE_SIDE_PANEL: kept for older callers. The popup now
  // opens/closes the panel itself; from here open() only works when the message
  // still carries the user's gesture, so the outcome is reported, not assumed.
  if (msg.type === 'OPEN_SIDE_PANEL') {
    if (fromTab) return; // panel control belongs to the extension's own pages
    const settle = (p) => {
      if (!p) {
        sendResponse({ ok: false, error: 'Side panel API unavailable.' });
        return;
      }
      p.then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ ok: false, error: String((err && err.message) || err) })
      );
    };
    if (isWindowId(msg.windowId)) settle(openSidePanel(msg.windowId));
    else queryActiveTab(undefined, (tab) => settle(tab ? openSidePanel(tab.windowId) : null));
    return true;
  }

  if (msg.type === 'CLOSE_SIDE_PANEL') {
    if (fromTab) return;
    const sidePanel = chrome['sidePanel'];
    let p = null;
    if (typeof browser !== 'undefined' && browser.sidebarAction && browser.sidebarAction.close) {
      p = browser.sidebarAction.close();
    } else if (sidePanel && typeof sidePanel.close === 'function' && isWindowId(msg.windowId)) {
      p = sidePanel.close({ windowId: msg.windowId });
    }
    if (!p) {
      sendResponse({ ok: false, error: 'This browser cannot close the panel programmatically.' });
      return;
    }
    p.then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String((err && err.message) || err) })
    );
    return true;
  }

  // Track panel open/close per window.
  if (msg.type === 'PANEL_HEARTBEAT') {
    if (fromTab) return; // only the panel itself can say it is open
    const key = isWindowId(msg.windowId) ? msg.windowId : 'any';
    ready().then(() => {
      // The panel pings every 4s. Only write when the stored stamp is drifting far
      // enough to matter against the TTL, rather than on every ping.
      const now = Date.now();
      const worthWriting = now - (panelSeen[key] || 0) > PANEL_HEARTBEAT_TTL_MS / 3;
      panelSeen[key] = now;
      if (worthWriting) persistState();
    });
    return;
  }

  if (msg.type === 'GET_PANEL_STATE') {
    ready().then(() => sendResponse({ active: isPanelActive(msg.windowId) }));
    return true;
  }

  if (msg.type === 'PANEL_BUFFER_ACK') {
    if (fromTab) return; // a page must not be able to drop another window's steps
    clearRecordBuffer(msg.windowId);
    return;
  }

  // RUN_STRESS_TEST: relay from side panel to content script
  if (msg.type === 'RUN_STRESS_TEST') {
    queryActiveTab(msg.windowId, (tab) => {
      if (!tab) {
        relayToSidePanel({
          type: 'STRESS_TEST_RESULT',
          data: { survived: false, unavailable: true },
          windowId: msg.windowId
        });
        return;
      }
      const tabId = tab.id;
      const windowId = tab.windowId;
      const finish = (res) => {
        // Always relay something so the side-panel button never hangs on "Testing…".
        const data = (res && res.data) ? res.data : { survived: false, unavailable: true };
        relayToSidePanel({ type: 'STRESS_TEST_RESULT', data, windowId, tabId });
      };
      ready().then(() => {
        // Nothing picked on this tab: frame 0 would fall back to whatever happens
        // to be hovered, and the result would describe an element nobody chose.
        if (!lastPick || lastPick.tabId !== tabId) {
          finish({ data: { survived: false, noTarget: true } });
          return;
        }
        // Only the frame holding the picked element can answer; every other frame
        // would report noTarget and race it to sendResponse.
        const frameId = lastPick.frameId;
        sendToFrame(tabId, { type: 'RUN_STRESS_TEST' }, frameId, (res) => {
          if (chrome.runtime.lastError) {
            injectAllFrames(tabId, () => {
              setTimeout(() => sendToFrame(tabId, { type: 'RUN_STRESS_TEST' }, frameId, finish), 100);
            });
            return;
          }
          finish(res);
        });
      });
    });
    return;
  }

  // 🔬 SELECTOR LAB: relay validate/clear to the active tab's content script.
  // (Side panel uses runtime.sendMessage, which never reaches content scripts on its own.)
  if (msg.type === 'LAB_VALIDATE' || msg.type === 'LAB_CLEAR') {
    if (fromTab) return;
    queryActiveTab(msg.windowId, (tab) => {
      if (!tab) return;
      const tabId = tab.id;
      // Validation resolves against the top document and reports a single count, so
      // it goes to frame 0 — letting every frame answer would make the number shown
      // depend on whichever reply arrived last. Clearing highlights is safe (and
      // necessary) everywhere.
      const frameId = msg.type === 'LAB_VALIDATE' ? 0 : undefined;
      sendToFrame(tabId, msg, frameId, () => {
        if (!chrome.runtime.lastError) return;
        // Content script not yet present — inject, then retry.
        injectAllFrames(tabId, () => {
          setTimeout(() => sendToFrame(tabId, msg, frameId), 100);
        });
      });
    });
    return;
  }

  // 🎬 RECORDING: start/join the session of the panel's window with its active tab
  if (msg.type === 'START_RECORDING') {
    if (fromTab) return;
    const respond = respondOnce(sendResponse);
    queryActiveTab(msg.windowId, (tab) => {
      if (!tab) {
        respond({ ok: false, error: 'No active tab to record.' });
        return;
      }
      startRecording(tab, msg.windowId, respond);
    });
    return true;
  }

  // Stop/Pause/Resume/Assert act on the whole session of the sender's window — every
  // tab that joined it — not on whatever tab is active right now.
  if (
    msg.type === 'STOP_RECORDING' ||
    msg.type === 'PAUSE_RECORDING' ||
    msg.type === 'RESUME_RECORDING' ||
    msg.type === 'SET_ASSERT_MODE'
  ) {
    if (fromTab) return;
    queryActiveTab(msg.windowId, (tab) => applyRecordingCommand(msg, tab, sendResponse));
    return true;
  }

  // RECORDED_ACTION: relay from content script to side panel. Every field is
  // forwarded (new step fields must survive the hop); the page's tab and the
  // session's window are added so the right panel — and only it — gets the step.
  if (msg.type === 'RECORDED_ACTION') {
    if (!fromTab) return;
    const tabId = fromTab.id;
    ready().then(() => {
      const s = sessionForTab(tabId);
      const windowId = s ? s.windowId : fromTab.windowId;
      const data = Object.assign({}, msg.data || {});
      // Raw candidate arrays are large and the panel never reads them.
      delete data.locators;
      data.tabId = tabId;
      data.windowId = windowId;
      bufferRecordedAction(windowId, data);
      relayToSidePanel({ type: 'RECORDED_ACTION', data, windowId, tabId });
      maybeCaptureStep(fromTab, data);
    });
    return;
  }

  // 🧩 PAGE OBJECT: region pick in every frame of the active tab (each frame
  // hit-tests its own document, as inspect does); whole-page scan in the top frame.
  if (msg.type === 'POM_PICK_START' || msg.type === 'POM_SCAN') {
    if (fromTab) return;
    const respond = respondOnce(sendResponse);
    queryActiveTab(msg.windowId, (tab) => {
      if (!tab) {
        respond({ ok: false, error: 'No active tab to scan.' });
        return;
      }
      const tabId = tab.id;
      const go = (alive) => {
        if (!alive) {
          respond({ ok: false, error: unreachableError(tabId) });
          return;
        }
        if (msg.type === 'POM_PICK_START') sendToFrame(tabId, { type: 'POM_PICK_START' });
        else sendToFrame(tabId, { type: 'POM_SCAN' }, 0);
        respond({ ok: true, tabId });
      };
      if (msg.type === 'POM_PICK_START') injectAllFrames(tabId, () => pingTopFrame(tabId, go));
      else ensureTopFrame(tabId, go);
    });
    return true;
  }

  // ▶ REPLAY
  if (msg.type === 'REPLAY_START') {
    if (fromTab) return;
    startReplay(msg, respondOnce(sendResponse));
    return true;
  }

  // The frame that owns a sensitive replay step asks for its value. Only that step's
  // value, only to a frame of the tab being replayed, and only to the first frame
  // that asks — the step itself goes to every frame, the secret does not.
  if (msg.type === 'REPLAY_SECRET_REQUEST') {
    if (!fromTab) return;
    sendResponse(takeReplaySecret(fromTab.id, msg.runId, msg.index));
    return;
  }

  if (msg.type === 'REPLAY_STOP') {
    if (fromTab) return;
    const stop = (windowId) => {
      const run = isWindowId(windowId) ? replayRuns.get(windowId) : null;
      if (run) abortReplay(run, 'stopped');
      sendResponse({ ok: true });
      // A panel still waiting on a run that died with an earlier worker gets its end.
      if (isWindowId(windowId) && !run) ready().then(() => settleInterruptedReplays(windowId));
    };
    if (isWindowId(msg.windowId)) stop(msg.windowId);
    else queryActiveTab(undefined, (tab) => stop(tab ? tab.windowId : undefined));
    return true;
  }

  // 🖼 STEP SCREENSHOTS: may the worker capture at all? granted: <all_urls> is held
  // (false also when it cannot be told); available: the permissions API exists, so
  // the panel can offer to request it.
  if (msg.type === 'GET_SCREENSHOT_PERMISSION') {
    if (fromTab) return;
    screenshotPermission().then((granted) => {
      sendResponse({ granted: granted === true, available: granted !== null });
    });
    return true;
  }

  // 🖼 STEP SCREENSHOTS: the panel removed steps, or cleared its timeline.
  if (msg.type === 'THUMBS_DELETE' || msg.type === 'THUMBS_CLEAR') {
    if (fromTab) return;
    const store = thumbStore();
    let pending;
    if (msg.type === 'THUMBS_DELETE') {
      const ids = (Array.isArray(msg.eventIds) ? msg.eventIds : []).filter(isEventId);
      forgetThumbs(ids, undefined);
      pending = store && ids.length ? store.deleteMany(ids) : Promise.resolve(0);
    } else {
      if (!isWindowId(msg.windowId)) {
        sendResponse({ ok: false, error: 'THUMBS_CLEAR needs a windowId.' });
        return;
      }
      forgetThumbs(null, msg.windowId);
      pending = store ? store.clearWindow(msg.windowId) : Promise.resolve(0);
    }
    pending.then(
      (n) => sendResponse({ ok: true, deleted: typeof n === 'number' ? n : 0 }),
      () => sendResponse({ ok: false, error: 'Could not delete thumbnails.' })
    );
    return true;
  }

  // 🖼 STEP SCREENSHOTS: the settings page's "Clear step screenshots" — every
  // window's thumbnails, and any capture still in flight.
  if (msg.type === 'THUMBS_CLEAR_ALL') {
    if (fromTab) return;
    forgetAllThumbs();
    const store = thumbStore();
    let pending = Promise.resolve(0);
    if (store && typeof store.clearAll === 'function') pending = store.clearAll();
    else if (store) pending = store.prune(0);
    Promise.resolve(pending).then(
      (n) => {
        relayToSidePanel({ type: 'THUMBS_CLEARED', all: true });
        sendResponse({ ok: true, deleted: typeof n === 'number' ? n : 0 });
      },
      () => sendResponse({ ok: false, error: 'Could not delete thumbnails.' })
    );
    return true;
  }

  // 🩺 LOCATOR HEALTH: which page is the panel's window showing?
  if (msg.type === 'GET_ACTIVE_PAGE') {
    if (fromTab) return;
    const respond = respondOnce(sendResponse);
    queryActiveTab(msg.windowId, (tab) => {
      if (!tab) {
        respond({ ok: false, error: 'No active tab.' });
        return;
      }
      topFrameHref(tab.id, (href) => {
        const page = pageKeys(href);
        if (!page) {
          respond({ ok: false, error: RESTRICTED_PAGE_ERROR });
          return;
        }
        respond({ ok: true, tabId: tab.id, url: page.url, siteKey: page.siteKey });
      });
    });
    return true;
  }

  // 🩺 LOCATOR HEALTH: re-resolve watched locators on the window's active tab.
  if (msg.type === 'HEALTH_CHECK') {
    if (fromTab) return;
    runHealthCheck(msg, respondOnce(sendResponse));
    return true;
  }
});

// ── Inspect / record, shared by the UI messages and the keyboard shortcuts ────

/** Switch inspect mode on in `tab`. respond({ ok, error? }). */
function startInspect(tab, respond) {
  const tabId = tab.id;
  const windowId = tab.windowId;
  ready().then(() => {
    inspectTabs.set(tabId, isWindowId(windowId) ? windowId : null);
    persistState();
    // Inject first, then broadcast: sub-frames have no content script until now,
    // and each frame overlays and hit-tests its own document.
    injectAllFrames(tabId, () => {
      pingTopFrame(tabId, (alive) => {
        if (!alive) {
          // Restricted page (or one that refused injection): do not leave the
          // tab marked as inspecting, and tell every UI so.
          ready().then(() => {
            if (inspectTabs.delete(tabId)) persistState();
          });
          relayToSidePanel({ type: 'STOP_INSPECT', windowId, tabId });
          respond({ ok: false, error: unreachableError(tabId) });
          return;
        }
        sendToFrame(tabId, { type: 'START_INSPECT' });
        relayToSidePanel({ type: 'START_INSPECT', windowId, tabId });
        respond({ ok: true });
      });
    });
  });
}

/**
 * Switch inspect mode off for a window: every tab of it that is inspecting, plus
 * `tab` (the active one) — the inspected tab need not still be active.
 */
function stopInspect(requestedWindowId, tab, respond) {
  const windowId = isWindowId(requestedWindowId) ? requestedWindowId : tab ? tab.windowId : undefined;
  ready().then(() => {
    const targets = new Set();
    if (tab) targets.add(tab.id);
    for (const [id, w] of inspectTabs) if (isWindowId(windowId) && w === windowId) targets.add(id);
    let changed = false;
    for (const id of targets) {
      if (inspectTabs.delete(id)) changed = true;
      sendToFrame(id, { type: 'STOP_INSPECT' });
    }
    if (changed) persistState();
    relayToSidePanel({ type: 'STOP_INSPECT', windowId, tabId: tab ? tab.id : undefined });
    respond({ ok: true });
  });
}

/**
 * Tell the window's panel where its recording stands, after any change from any
 * source (panel, popup, shortcut, a closed tab or window, a replay's pause), so it
 * never has to poll GET_RECORDING_STATE.
 */
function relayRecordingState(windowId) {
  const s = sessions.get(windowId);
  relayToSidePanel({
    type: 'RECORDING_STATE',
    windowId,
    active: !!s,
    paused: s ? s.paused : false,
    assertMode: s ? s.assertMode : false,
    assertType: s ? s.assertType : null
  });
}

/** Start (or join) the recording session of `tab`'s window. respond({ ok, error? }). */
function startRecording(tab, requestedWindowId, respond) {
  const tabId = tab.id;
  const windowId = isWindowId(tab.windowId) ? tab.windowId : isWindowId(requestedWindowId) ? requestedWindowId : -1;
  ready().then(() => {
    let s = sessions.get(windowId);
    const created = !s;
    if (!s) {
      s = { windowId, tabIds: new Set(), paused: false, assertMode: false, assertType: null };
      sessions.set(windowId, s);
      // Steps still buffered here were recorded while no panel was open and have
      // not reached one yet. They stay: the panel takes them, in order, ahead of
      // this recording's steps when it next connects, and acknowledges them.
    }
    // Pressing Start means "capture now", whatever the previous pause said.
    s.paused = false;
    releaseReplayPause(windowId);
    const joined = !s.tabIds.has(tabId);
    s.tabIds.add(tabId);
    persistState();

    // Every frame records its own events — a click inside an iframe never reaches
    // the top document's listeners.
    injectAllFrames(tabId, () => {
      pingTopFrame(tabId, (alive) => {
        if (!alive) {
          ready().then(() => {
            const cur = sessions.get(windowId);
            if (cur && joined) cur.tabIds.delete(tabId);
            if (cur && created && cur.tabIds.size === 0) sessions.delete(windowId);
            persistState();
            relayRecordingState(windowId);
          });
          respond({ ok: false, error: unreachableError(tabId) });
          return;
        }
        // Stopped while the page was being checked: do not arm it after all.
        if (sessions.get(windowId) !== s || !s.tabIds.has(tabId)) {
          respond({ ok: true });
          return;
        }
        sendToFrame(tabId, {
          type: 'START_RECORDING',
          paused: s.paused,
          assertMode: s.assertMode,
          assertType: s.assertType
        });
        relayRecordingState(windowId);
        respond({ ok: true });
      });
    });
  });
}

/**
 * STOP_RECORDING / PAUSE_RECORDING / RESUME_RECORDING / SET_ASSERT_MODE: act on
 * the whole session of the window — every tab that joined it — not on whatever tab
 * is active right now.
 */
function applyRecordingCommand(msg, tab, respond) {
  const windowId = isWindowId(msg.windowId) ? msg.windowId : tab ? tab.windowId : undefined;
  ready().then(() => {
    const s = isWindowId(windowId) ? sessions.get(windowId) : null;
    const targets = new Set(s ? s.tabIds : []);
    // No session on record (e.g. state lost): still reach the visible page, so
    // a Stop is never a no-op for a tab that is visibly recording.
    if (!s && tab) targets.add(tab.id);

    // The user changing the recording state mid-replay overrides the replay's
    // own "pause, then restore" — it must not undo what they just chose.
    if (msg.type !== 'SET_ASSERT_MODE') releaseReplayPause(windowId);
    if (s) {
      if (msg.type === 'STOP_RECORDING') sessions.delete(windowId);
      else if (msg.type === 'PAUSE_RECORDING') s.paused = true;
      else if (msg.type === 'RESUME_RECORDING') s.paused = false;
      else {
        s.assertMode = !!msg.on;
        if (msg.assertType) s.assertType = msg.assertType;
      }
      persistState();
    }

    // Forward the whole message (SET_ASSERT_MODE carries `on`/`assertType`).
    const out = Object.assign({}, msg);
    delete out.windowId;
    for (const id of targets) sendToFrame(id, out);
    if (s) relayRecordingState(windowId);
    respond({ ok: true });
  });
}

// ── Keyboard shortcuts (manifest `commands`) ─────────────────────────────────
// A command acts on the focused window's active tab — the `tab` the browser hands
// the listener, when it does. Inspect and record go through exactly the paths the
// panel's buttons use, restricted-page rollback included; a failure has nowhere to
// show but the toolbar button, so it flashes a "!" badge with the reason as the
// button's tooltip, and goes to the window's panel as ACTIVATION_FAILED.
const COMMAND_FEATURES = { 'toggle-inspect': 'inspect', 'toggle-recording': 'recording' };
const ACTIVATION_BADGE_MS = 4000;
const ACTIVATION_BADGE_COLOR = '#B83A2E';
/** tabId (or 'all') -> the timer that clears its failure badge. */
const badgeTimers = new Map();

function defaultActionTitle() {
  try {
    const m = chrome.runtime.getManifest();
    return (m && m.action && m.action.default_title) || 'Locatra';
  } catch (e) {
    return 'Locatra';
  }
}

/** Call one chrome.action setter, ignoring every way it can fail. */
function actionCall(name, details) {
  const action = chrome.action;
  if (!action || typeof action[name] !== 'function') return;
  try {
    const p = action[name](details, () => void chrome.runtime.lastError);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {}
}

function flashFailureBadge(tabId, error) {
  const scope = typeof tabId === 'number' ? { tabId } : {};
  const key = typeof tabId === 'number' ? tabId : 'all';
  actionCall('setBadgeBackgroundColor', Object.assign({ color: ACTIVATION_BADGE_COLOR }, scope));
  actionCall('setBadgeText', Object.assign({ text: '!' }, scope));
  actionCall('setTitle', Object.assign({ title: `Locatra: ${error}` }, scope));
  clearTimeout(badgeTimers.get(key));
  badgeTimers.set(
    key,
    setTimeout(() => {
      badgeTimers.delete(key);
      actionCall('setBadgeText', Object.assign({ text: '' }, scope));
      actionCall('setTitle', Object.assign({ title: defaultActionTitle() }, scope));
    }, ACTIVATION_BADGE_MS)
  );
}

function reportActivationFailure(tab, windowId, feature, error) {
  flashFailureBadge(tab ? tab.id : undefined, error);
  relayToSidePanel({
    type: 'ACTIVATION_FAILED',
    windowId: tab && isWindowId(tab.windowId) ? tab.windowId : windowId,
    feature,
    error
  });
}

/**
 * Open the window's panel from a command. Synchronous on purpose: the key press is
 * the user gesture open() needs, and it does not survive an await. Best effort.
 */
function openPanelFromCommand(windowId) {
  try {
    const sidePanel = chrome['sidePanel'];
    let p = null;
    if (sidePanel && typeof sidePanel.open === 'function') {
      if (isWindowId(windowId)) p = sidePanel.open({ windowId });
    } else if (typeof browser !== 'undefined' && browser.sidebarAction && browser.sidebarAction.open) {
      p = browser.sidebarAction.open();
    }
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {}
}

function handleCommand(command, tab) {
  const feature = COMMAND_FEATURES[command];
  if (!feature) return;
  const given = tab && typeof tab.id === 'number' ? tab : null;
  // The user invoked Locatra on this tab: a capture there may work again.
  if (given) captureBlockedTabs.delete(given.id);
  // Starting to inspect opens the panel, which is where the results go. Whether
  // this press starts or stops is only known synchronously once state is loaded;
  // when it is not, opening a panel is the harmless guess.
  if (feature === 'inspect' && !(hydrated && given && inspectTabs.has(given.id))) {
    openPanelFromCommand(given ? given.windowId : undefined);
  }
  const act = (t) => {
    if (!t) {
      reportActivationFailure(null, undefined, feature, `No active tab to ${feature === 'inspect' ? 'inspect' : 'record'}.`);
      return;
    }
    if (!given) captureBlockedTabs.delete(t.id);
    ready().then(() => {
      const fail = (res) => {
        if (res && res.ok === false) reportActivationFailure(t, t.windowId, feature, res.error);
      };
      if (feature === 'inspect') {
        if (inspectTabs.has(t.id)) stopInspect(t.windowId, t, () => {});
        else startInspect(t, fail);
        return;
      }
      if (isWindowId(t.windowId) && sessions.has(t.windowId)) {
        applyRecordingCommand({ type: 'STOP_RECORDING', windowId: t.windowId }, t, () => {});
      } else {
        startRecording(t, t.windowId, fail);
      }
    });
  };
  if (given) act(given);
  else queryActiveTab(undefined, act);
}

if (chrome.commands && chrome.commands.onCommand && typeof chrome.commands.onCommand.addListener === 'function') {
  chrome.commands.onCommand.addListener(handleCommand);
}

// ── Locator health check ─────────────────────────────────────────────────────
// The panel keeps watched locators per page (llWatched, keyed by siteKey); this
// re-resolves them in the window's active tab. Every frame gets the content script
// (a watched locator may live in an iframe), then one executeScript call runs the
// content script's own __LocatraHealthCheck in every frame — in the ISOLATED world,
// which is the content script's — and the frames' answers are merged: the frame
// that owns an item (by frame path, as replay decides it) has the say.
const HEALTH_CHECK_TIMEOUT_MS = 10000;
const HEALTH_CHECK_MAX_ITEMS = 2000;
const HEALTH_STATUSES = new Set(['ok', 'broken', 'ambiguous', 'frame-missing', 'error']);
const HEALTH_OUTDATED_ERROR =
  "Locatra's page script in this tab is out of date. Reload the page and check again.";

// Credentials and tokens that travel in a URL (as content.js redacts them).
const SENSITIVE_URL_PARAM_RE =
  /([?&#;])(password|passwd|pwd|secret|client_secret|access_token|id_token|refresh_token|api_key|apikey)=([^&#;]*)/gi;

/**
 * { url, siteKey } for a page, or null for anything that is not an http(s) page.
 * url drops credentials and redacts secret parameters; siteKey is origin + path —
 * no query, no hash — which is how watched locators are grouped.
 */
function pageKeys(href) {
  if (typeof href !== 'string' || !href) return null;
  let u;
  try {
    u = new URL(href);
  } catch (e) {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.username = '';
  u.password = '';
  return {
    url: u.href.replace(SENSITIVE_URL_PARAM_RE, (m, sep, key) => `${sep}${key}=REDACTED`),
    siteKey: u.origin + u.pathname
  };
}

/**
 * The top frame's address, read from the page itself — the host permission (or an
 * activeTab grant) already allows that, so no `tabs` permission is needed for
 * tab.url. cb(href | null); null on a page Locatra may not touch.
 */
function topFrameHref(tabId, cb) {
  try {
    chrome.scripting.executeScript({ target: { tabId }, func: () => location.href }, (results) => {
      const failed = !!chrome.runtime.lastError;
      const first = !failed && Array.isArray(results) ? results[0] : null;
      cb(first && typeof first.result === 'string' ? first.result : null);
    });
  } catch (e) {
    cb(null);
  }
}

/**
 * Runs inside each frame (serialised by executeScript, so it must not refer to
 * anything outside itself). Wraps the content script's answer with the frame's
 * address and anything it threw.
 */
function healthCheckInFrame(items) {
  let results = null;
  let error = null;
  try {
    const check = globalThis.__LocatraHealthCheck;
    results = typeof check === 'function' ? check(items) : null;
  } catch (e) {
    error = String((e && e.message) || e);
  }
  let href = null;
  try {
    href = String(location.href);
  } catch (e) {}
  return { results: Array.isArray(results) ? results : null, error, href };
}

function sanitizeHealthItems(items) {
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object' || typeof it.id !== 'string' || !it.id) continue;
    out.push({ id: it.id, target: it.target, fingerprint: it.fingerprint });
  }
  return out;
}

/** One frame's answer for an item it owns, reduced to the response contract. */
function normalizeHealthResult(id, r) {
  const count = typeof r.count === 'number' && isFinite(r.count) && r.count >= 0 ? Math.floor(r.count) : 0;
  let status = HEALTH_STATUSES.has(r.status) ? r.status : null;
  if (!status) status = count === 1 ? 'ok' : count === 0 ? 'broken' : 'ambiguous';
  const out = { id, status, count };
  const sug = r.suggestion;
  if (sug && typeof sug === 'object' && sug.target && typeof sug.target === 'object' && typeof sug.code === 'string') {
    out.suggestion = { target: sug.target, code: sug.code };
  }
  if (typeof r.error === 'string' && r.error) out.error = r.error;
  return out;
}

/**
 * Merge executeScript's per-frame results. For each item the frame that owns it
 * answers; no owner means the frame is gone ('frame-missing') — or, when a frame
 * threw, that the check itself failed there ('error').
 */
function mergeHealthResults(items, injection) {
  const frames = (Array.isArray(injection) ? injection : [])
    .filter((f) => f && typeof f === 'object')
    .sort((a, b) => (a.frameId || 0) - (b.frameId || 0));
  let href = null;
  let answered = 0;
  const errors = [];
  const owned = new Map();
  for (const f of frames) {
    if (f.error) errors.push(String(f.error.message || f.error));
    const out = f.result;
    if (!out || typeof out !== 'object') continue;
    if ((f.frameId || 0) === 0 && href === null && typeof out.href === 'string') href = out.href;
    if (out.error) errors.push(String(out.error));
    if (!Array.isArray(out.results)) continue;
    answered++;
    for (const r of out.results) {
      if (r && typeof r === 'object' && r.owned === true && typeof r.id === 'string' && !owned.has(r.id)) {
        owned.set(r.id, r);
      }
    }
  }
  const page = pageKeys(href);
  if (!page) return { ok: false, error: RESTRICTED_PAGE_ERROR };
  // Not one frame could run the check, and none failed trying: the content script
  // predates it (an extension update since the page loaded).
  if (!answered && !errors.length) return { ok: false, error: HEALTH_OUTDATED_ERROR };
  const results = items.map((it) => {
    const r = owned.get(it.id);
    if (r) return normalizeHealthResult(it.id, r);
    if (errors.length) return { id: it.id, status: 'error', count: 0, error: errors[0] };
    return { id: it.id, status: 'frame-missing', count: 0 };
  });
  return { ok: true, siteKey: page.siteKey, results };
}

function runHealthCheck(msg, respond) {
  if (!Array.isArray(msg.items)) {
    respond({ ok: false, error: 'HEALTH_CHECK needs an items array.' });
    return;
  }
  if (msg.items.length > HEALTH_CHECK_MAX_ITEMS) {
    respond({ ok: false, error: `Too many locators to check at once (max ${HEALTH_CHECK_MAX_ITEMS}).` });
    return;
  }
  const items = sanitizeHealthItems(msg.items);
  // Time-boxed: a frame stuck in a long task must not leave the panel waiting.
  const timer = setTimeout(
    () => respond({ ok: false, error: `The health check timed out after ${HEALTH_CHECK_TIMEOUT_MS / 1000} s.` }),
    HEALTH_CHECK_TIMEOUT_MS
  );
  const done = (r) => {
    clearTimeout(timer);
    respond(r);
  };
  queryActiveTab(msg.windowId, (tab) => {
    if (!tab) {
      done({ ok: false, error: 'No active tab to check.' });
      return;
    }
    const tabId = tab.id;
    injectAllFrames(tabId, () => {
      pingTopFrame(tabId, (alive) => {
        if (!alive) {
          done({ ok: false, error: unreachableError(tabId) });
          return;
        }
        try {
          chrome.scripting.executeScript(
            { target: { tabId, allFrames: true }, func: healthCheckInFrame, args: [items] },
            (injection) => {
              const err = chrome.runtime.lastError;
              if (err) {
                done({ ok: false, error: `Could not check this page: ${err.message || err}` });
                return;
              }
              done(mergeHealthResults(items, injection));
            }
          );
        } catch (e) {
          done({ ok: false, error: `Could not check this page: ${(e && e.message) || e}` });
        }
      });
    });
  });
}

// ── New frames (C3) ───────────────────────────────────────────────────────────
// Content scripts report iframes added after injection; injecting is per tab and
// idempotent per frame, so bursts are coalesced. New frames arm themselves via
// CONTENT_READY.
const FRAME_INJECTION_DEBOUNCE_MS = 400;
const frameInjectionTimers = new Map();
function requestFrameInjection(tabId) {
  if (frameInjectionTimers.has(tabId)) return;
  frameInjectionTimers.set(
    tabId,
    setTimeout(() => {
      frameInjectionTimers.delete(tabId);
      ready().then(() => {
        if (sessionForTab(tabId) || inspectTabs.has(tabId)) injectAllFrames(tabId);
      });
    }, FRAME_INJECTION_DEBOUNCE_MS)
  );
}

// Tabs opened from a recording tab (target=_blank, window.open) join its session.
if (chrome.tabs.onCreated) {
  chrome.tabs.onCreated.addListener((tab) => {
    if (!tab || typeof tab.id !== 'number' || typeof tab.openerTabId !== 'number') return;
    ready().then(() => {
      const s = sessionForTab(tab.openerTabId);
      if (!s || s.tabIds.has(tab.id)) return;
      s.tabIds.add(tab.id);
      persistState();
      // Armed on its first 'complete' (onUpdated below) or by its own CONTENT_READY.
    });
  });
}

// A tab dragged to another window keeps inspecting; follow it.
if (chrome.tabs.onAttached) {
  chrome.tabs.onAttached.addListener((tabId, info) => {
    ready().then(() => {
      if (inspectTabs.has(tabId) && info && isWindowId(info.newWindowId)) {
        inspectTabs.set(tabId, info.newWindowId);
        persistState();
      }
    });
  });
}

// Clean up when tab closes
chrome.tabs.onRemoved.addListener((tabId) => {
  tabLoadSeq.delete(tabId);
  pendingCaptures.delete(tabId);
  captureBlockedTabs.delete(tabId);
  injectErrors.delete(tabId);
  for (const run of Array.from(replayRuns.values())) {
    if (run.tabId === tabId) abortReplay(run, 'error', 'The tab being replayed was closed.');
  }
  const timer = frameInjectionTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    frameInjectionTimers.delete(tabId);
  }
  ready().then(() => {
    // Each cleanup must run regardless of the others' result — an `||` chain
    // short-circuits once the first is true, which used to leave a closed tab stuck
    // in the recording set whenever it was also the inspected tab.
    let changed = inspectTabs.delete(tabId);
    for (const [windowId, s] of Array.from(sessions.entries())) {
      if (!s.tabIds.delete(tabId)) continue;
      changed = true;
      if (s.tabIds.size === 0) {
        sessions.delete(windowId);
        relayRecordingState(windowId); // the session's last tab closed: it ended
      }
    }
    if (lastPick && lastPick.tabId === tabId) {
      lastPick = null;
      changed = true;
    }
    if (changed) persistState();
  });
});

// A closed window takes its session, panel and buffered steps with it.
if (chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener((windowId) => {
    const run = replayRuns.get(windowId);
    if (run) abortReplay(run, 'stopped');
    ready().then(() => {
      let changed = sessions.delete(windowId);
      if (changed) relayRecordingState(windowId);
      if (windowId in panelSeen) {
        delete panelSeen[windowId];
        changed = true;
      }
      for (const [id, w] of Array.from(inspectTabs.entries())) {
        if (w === windowId) {
          inspectTabs.delete(id);
          changed = true;
        }
      }
      const before = interruptedReplays.length;
      interruptedReplays = interruptedReplays.filter((r) => r.windowId !== windowId);
      if (interruptedReplays.length !== before) changed = true;
      if (changed) persistState();
      clearRecordBuffer(windowId);
    });
  });
}

// Clean up on navigation (and sync UI)
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'loading' && info.status !== 'complete') return;
  // Counted synchronously, outside ready(): a replay compares these counts to tell
  // "the page navigated" from "nobody answered".
  if (info.status === 'loading') {
    tabLoadSeq.set(tabId, (tabLoadSeq.get(tabId) || 0) + 1);
    captureBlockedTabs.delete(tabId); // a new page: an activeTab grant may apply again
  }
  ready().then(() => {
    if (info.status === 'loading') {
      let changed = false;
      const inspectWindow = inspectTabs.get(tabId);
      if (inspectTabs.delete(tabId)) {
        changed = true;
        // Explicitly tell that window's UI this tab is no longer inspecting
        const windowId = tab && isWindowId(tab.windowId) ? tab.windowId : inspectWindow;
        relayToSidePanel({ type: 'STOP_INSPECT', windowId: isWindowId(windowId) ? windowId : undefined, tabId });
      }
      // The picked element is gone with the old document.
      if (lastPick && lastPick.tabId === tabId) {
        lastPick = null;
        changed = true;
      }
      if (changed) persistState();
      return;
    }
    // Re-arm recording after a full-page navigation so multi-page flows keep capturing.
    // Always inject first: the manifest only re-injects the top frame, and a rearm
    // that reached it would otherwise leave every iframe on the new page dead. The
    // new contexts have no memory of pause/assert state, so it rides along.
    const s = sessionForTab(tabId);
    if (!s) return;
    injectAllFrames(tabId, () => {
      sendToFrame(tabId, {
        type: 'START_RECORDING',
        rearm: true,
        paused: s.paused,
        assertMode: s.assertMode,
        assertType: s.assertType
      });
    });
  });
});

/** Make sure the top frame has a live content script, injecting only it if not. cb(alive). */
function ensureTopFrame(tabId, cb) {
  pingTopFrame(tabId, (alive) => {
    if (alive) {
      cb(true);
      return;
    }
    chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES }, () => {
      noteInjection(tabId);
      pingTopFrame(tabId, cb);
    });
  });
}

// ── Settings ─────────────────────────────────────────────────────────────────
// llSettings in storage.local is edited by the panel and the settings page; a
// missing key or field means the default. Only stepScreenshots matters to the worker.
const SETTINGS_KEY = 'llSettings';
let stepScreenshotsEnabled = true;
let settingsLoad = null;

function applySettings(value) {
  stepScreenshotsEnabled = !(value && typeof value === 'object' && value.stepScreenshots === false);
  if (!stepScreenshotsEnabled) dropPendingCaptures();
}

function loadSettings() {
  if (settingsLoad) return settingsLoad;
  settingsLoad = new Promise((resolve) => {
    const local = chrome.storage && chrome.storage.local;
    if (!local || typeof local.get !== 'function') {
      resolve();
      return;
    }
    try {
      local.get(SETTINGS_KEY, (res) => {
        void chrome.runtime.lastError;
        applySettings(res && res[SETTINGS_KEY]);
        resolve();
      });
    } catch (e) {
      resolve();
    }
  });
  return settingsLoad;
}

if (chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes || !changes[SETTINGS_KEY]) return;
    // A change also counts as loaded: it is newer than anything get() could return.
    if (!settingsLoad) settingsLoad = Promise.resolve();
    applySettings(changes[SETTINGS_KEY].newValue);
  });
}

// ── Step screenshots (F4) ────────────────────────────────────────────────────
// After relaying a recorded step, capture the visible tab and keep a small JPEG of
// it in IndexedDB (thumbs-store.js) for the panel's timeline. Strictly best
// effort: a skipped or failed capture just means that step has no thumbnail.
//
// Chrome allows captureVisibleTab about twice a second per extension, so captures
// are spaced CAPTURE_MIN_INTERVAL_MS apart and only the newest pending step per
// tab waits for the next slot — a burst of steps never builds a backlog of stale
// screenshots.
const THUMB_MAX_WIDTH = 360;
const CAPTURE_MIN_INTERVAL_MS = 500;
/** tabId -> the newest step from that tab still waiting for a capture slot. */
const pendingCaptures = new Map();
let captureBusy = false;
let captureTimer = null;
let lastCaptureAt = 0;
/** Steps the panel deleted (or windows it cleared) while their capture was in flight. */
const forgottenThumbIds = new Set();
const thumbsClearedAt = new Map();
/** When every thumbnail was last cleared (THUMBS_CLEAR_ALL). */
let thumbsAllClearedAt = 0;

const isEventId = (v) => (typeof v === 'string' && v.length > 0) || (typeof v === 'number' && isFinite(v));

function thumbStore() {
  const t = globalThis.LLThumbs;
  return t && typeof t.put === 'function' ? t : null;
}

function dropPendingCaptures() {
  pendingCaptures.clear();
  if (captureTimer) {
    clearTimeout(captureTimer);
    captureTimer = null;
  }
}

function forgetThumbs(eventIds, windowId) {
  for (const [tabId, job] of Array.from(pendingCaptures.entries())) {
    if ((eventIds && eventIds.includes(job.eventId)) || (isWindowId(windowId) && job.windowId === windowId)) {
      pendingCaptures.delete(tabId);
    }
  }
  if (eventIds) {
    eventIds.forEach((id) => forgottenThumbIds.add(id));
    // Bounded: only captures already in flight can still need the reminder.
    while (forgottenThumbIds.size > 500) forgottenThumbIds.delete(forgottenThumbIds.values().next().value);
  }
  if (isWindowId(windowId)) thumbsClearedAt.set(windowId, Date.now());
}

/** Every capture still waiting or in flight is for a step whose thumbnail was just cleared. */
function forgetAllThumbs() {
  pendingCaptures.clear();
  thumbsAllClearedAt = Date.now();
}

/** Did the panel delete this step (or clear its window, or everything) after it was queued? */
function thumbForgotten(job) {
  return (
    forgottenThumbIds.has(job.eventId) ||
    (thumbsClearedAt.get(job.windowId) || 0) >= job.queuedAt ||
    thumbsAllClearedAt >= job.queuedAt
  );
}

// captureVisibleTab needs the literal <all_urls> host permission (http/https host
// access is not enough) or an activeTab grant. <all_urls> is optional: the panel
// requests it when the user wants screenshots. Without it a capture is still tried —
// an activeTab grant (the user invoked Locatra on that tab) is enough — and a refusal
// stays silent. So that a tab with no grant is not asked again on every step, a
// failure there blocks the tab until it navigates, the user invokes the extension on
// it again, or <all_urls> is granted.
const ALL_URLS = { origins: ['<all_urls>'] };
/** true / false once known; null when it cannot be told. */
let allUrlsGranted = null;
let permissionCheck = null;
/** Tabs whose last capture failed without <all_urls>: no further attempts for now. */
const captureBlockedTabs = new Set();

/** A UI command that acts on the window's active tab: the user invoked us there. */
const TAB_INVOKING_COMMANDS = new Set([
  'START_INSPECT',
  'START_RECORDING',
  'RESUME_RECORDING',
  'POM_PICK_START',
  'POM_SCAN',
  'REPLAY_START',
  'LAB_VALIDATE',
  'RUN_STRESS_TEST'
]);

function unblockActiveTabCapture(windowId) {
  if (!captureBlockedTabs.size) return;
  queryActiveTab(windowId, (tab) => {
    if (tab) captureBlockedTabs.delete(tab.id);
  });
}

function checkAllUrlsPermission() {
  const perms = chrome.permissions;
  if (!perms || typeof perms.contains !== 'function') {
    allUrlsGranted = null;
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      perms.contains(ALL_URLS, (granted) => {
        allUrlsGranted = chrome.runtime.lastError ? null : !!granted;
        resolve(allUrlsGranted);
      });
    } catch (e) {
      allUrlsGranted = null;
      resolve(null);
    }
  });
}

/** The cached answer, checked once per worker instance and on every grant/revoke. */
function screenshotPermission() {
  if (!permissionCheck) permissionCheck = checkAllUrlsPermission();
  return permissionCheck;
}

if (chrome.permissions) {
  const recheck = () => {
    checkHostAccess();
    permissionCheck = checkAllUrlsPermission();
    permissionCheck.then((granted) => {
      if (granted === true) captureBlockedTabs.clear();
    });
  };
  if (chrome.permissions.onAdded && chrome.permissions.onAdded.addListener) chrome.permissions.onAdded.addListener(recheck);
  if (chrome.permissions.onRemoved && chrome.permissions.onRemoved.addListener) chrome.permissions.onRemoved.addListener(recheck);
}

function maybeCaptureStep(fromTab, data) {
  // Suggestions are not steps the user took; a viewport step is the same moment
  // as the goto before it, and would take that step's capture slot. A sensitive
  // step (password, one-time code, card) gets no picture, nor does any step taken
  // while such a value shows in a field: the privacy policy promises it never
  // reaches extension storage.
  if (!data || data.suggested || data.sensitive || data.sensitiveOnScreen) return;
  if (data.action === 'viewport' || !isEventId(data.eventId)) return;
  if (!fromTab || fromTab.active === false || !isWindowId(fromTab.windowId)) return;
  if (typeof chrome.tabs.captureVisibleTab !== 'function' || !thumbStore()) return;
  const job = {
    tabId: fromTab.id,
    tabWindowId: fromTab.windowId,
    windowId: isWindowId(data.windowId) ? data.windowId : fromTab.windowId,
    eventId: data.eventId,
    queuedAt: Date.now()
  };
  Promise.all([loadSettings(), screenshotPermission()]).then(() => {
    if (!stepScreenshotsEnabled || captureBlockedTabs.has(job.tabId) || thumbForgotten(job)) return;
    pendingCaptures.delete(job.tabId); // re-insert so the map stays in arrival order
    pendingCaptures.set(job.tabId, job);
    pumpCaptures();
  });
}

function pumpCaptures() {
  if (captureBusy || captureTimer || pendingCaptures.size === 0) return;
  const wait = lastCaptureAt + CAPTURE_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) {
    captureTimer = setTimeout(() => {
      captureTimer = null;
      pumpCaptures();
    }, wait);
    return;
  }
  const [tabId, job] = pendingCaptures.entries().next().value;
  pendingCaptures.delete(tabId);
  captureBusy = true;
  captureStep(job)
    .catch(() => {})
    .then(() => {
      captureBusy = false;
      pumpCaptures();
    });
}

/** Capture one step. Resolves when done, whatever the outcome; never rejects. */
function captureStep(job) {
  return new Promise((resolve) => {
    if (!stepScreenshotsEnabled || captureBlockedTabs.has(job.tabId) || thumbForgotten(job)) {
      resolve();
      return;
    }
    // captureVisibleTab shoots whatever the window shows: only worth it while the
    // step's own tab is still the one on screen.
    queryActiveTab(job.tabWindowId, (tab) => {
      if (!tab || tab.id !== job.tabId) {
        resolve();
        return;
      }
      lastCaptureAt = Date.now();
      try {
        chrome.tabs.captureVisibleTab(job.tabWindowId, { format: 'jpeg', quality: 60 }, (dataUrl) => {
          // Restricted page, missing activeTab grant, minimised window…: no thumbnail.
          const failed = !!chrome.runtime.lastError || typeof dataUrl !== 'string';
          if (failed) {
            // No <all_urls> and no (longer an) activeTab grant on this tab: stop asking.
            if (allUrlsGranted !== true) captureBlockedTabs.add(job.tabId);
            resolve();
            return;
          }
          storeThumbnail(job, dataUrl).then(resolve, resolve);
        });
      } catch (e) {
        resolve();
      }
    });
  });
}

async function storeThumbnail(job, dataUrl) {
  const store = thumbStore();
  const image = await makeThumbnail(dataUrl);
  if (!store || !image) return;
  // Removed while the capture was in flight: storing it would only orphan it.
  if (thumbForgotten(job)) return;
  const ok = await store.put({
    eventId: job.eventId,
    windowId: job.windowId,
    blob: image.blob,
    width: image.width,
    height: image.height,
    createdAt: Date.now()
  });
  if (ok) relayToSidePanel({ type: 'STEP_THUMBNAIL', windowId: job.windowId, eventId: job.eventId });
}

/** data: URL -> Blob, without fetch() (which nothing in this package may call). */
function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0) return null;
  const meta = dataUrl.slice(5, comma);
  const type = meta.split(';')[0] || 'image/jpeg';
  const body = dataUrl.slice(comma + 1);
  let bin;
  try {
    bin = /;base64/i.test(meta) ? atob(body) : decodeURIComponent(body);
  } catch (e) {
    return null;
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/**
 * Downscale to at most THUMB_MAX_WIDTH px wide. Without createImageBitmap or
 * OffscreenCanvas (or if decoding fails) the original capture is kept as is.
 * @returns {Promise<{blob, width, height}|null>} width/height null when unknown
 */
async function makeThumbnail(dataUrl) {
  const original = dataUrlToBlob(dataUrl);
  if (!original) return null;
  const asIs = (w, h) => ({ blob: original, width: typeof w === 'number' ? w : null, height: typeof h === 'number' ? h : null });
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return asIs();
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(original);
    const w = bitmap.width;
    const h = bitmap.height;
    if (!(w > 0 && h > 0)) return asIs();
    if (w <= THUMB_MAX_WIDTH) return asIs(w, h);
    const tw = THUMB_MAX_WIDTH;
    const th = Math.max(1, Math.round((h * THUMB_MAX_WIDTH) / w));
    const canvas = new OffscreenCanvas(tw, th);
    const ctx = canvas.getContext('2d');
    if (!ctx) return asIs(w, h);
    ctx.drawImage(bitmap, 0, 0, tw, th);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
    return blob ? { blob, width: tw, height: th } : asIs(w, h);
  } catch (e) {
    return asIs(bitmap ? bitmap.width : undefined, bitmap ? bitmap.height : undefined);
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  }
}

// Old thumbnails go on every worker start (the panel's recorder state is the only
// thing that refers to them, and it is not kept for weeks).
try {
  const store = thumbStore();
  if (store) store.prune().catch(() => {});
} catch (e) {}

// ── Replay (F1) ──────────────────────────────────────────────────────────────
// The panel hands over its recorded steps; this loop plays them, one at a time, on
// one tab of the panel's window. Page-level steps (goto, waiting for loads) happen
// here; everything that touches an element is a REPLAY_STEP to the tab's frames,
// where only the frame the step was recorded in answers.
//
// Progress goes back as REPLAY_PROGRESS / REPLAY_DONE relays tagged with the
// window. Every run ends with exactly one REPLAY_DONE — including when this worker
// is torn down mid-run: the run is persisted (ids only, never steps or secrets),
// and the next worker instance reports it as result 'error' as soon as it hears
// from that window's panel (PANEL_HELLO when its port reconnects, or REPLAY_STOP).
const REPLAY_DEFAULT_STEP_TIMEOUT_MS = 5000;
const REPLAY_LOAD_TIMEOUT_MS = 15000;
const REPLAY_POLL_MS = 100;
/** While a step runs, how often the panel hears it is still alive (its watchdog is 30 s). */
const REPLAY_HEARTBEAT_MS = 5000;
/** How long a goto waits for its navigation to show up before assuming none (a same-page hash change). */
const REPLAY_NAV_START_GRACE_MS = 1000;
/** Extra time over the step's own timeout before giving up on the frame's answer. */
const REPLAY_RESPONSE_GRACE_MS = 2000;
/** After an action, a moment for a navigation it caused to start. */
const REPLAY_SETTLE_MS = 150;
/** "No frame answered" is retried once after this, in case the page was swapping documents. */
const REPLAY_NO_ANSWER_RETRY_MS = 300;
const REPLAY_MAX_STEPS = 5000;
const REPLAY_INTERRUPTED_ERROR =
  'Replay was interrupted because the extension restarted in the background. Run it again.';
/** Actions that are not idempotent: once sent, they are never sent again. */
const REPLAY_ACTIONS = new Set(['click', 'dblclick', 'press']);

/** tabId -> how many times the tab started loading (tabs.onUpdated 'loading'). */
const tabLoadSeq = new Map();
const loadSeqOf = (tabId) => tabLoadSeq.get(tabId) || 0;

let replaySeq = 0;
function newRunId() {
  replaySeq++;
  return 'run-' + Date.now().toString(36) + '-' + replaySeq + '-' + Math.random().toString(36).slice(2, 7);
}

function clampNumber(v, min, max, dflt) {
  return typeof v === 'number' && isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;
}

function tabGet(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.get(tabId, (tab) => {
        resolve(chrome.runtime.lastError ? null : tab || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function tabUpdate(tabId, props) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.update(tabId, props, () => {
        const err = chrome.runtime.lastError;
        resolve(err ? { ok: false, error: String(err.message || err) } : { ok: true });
      });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
    }
  });
}

const pingP = (tabId) => new Promise((resolve) => pingTopFrame(tabId, resolve));
const injectP = (tabId) => new Promise((resolve) => injectAllFrames(tabId, resolve));

/** Sleep that ends early when the run is aborted. */
function replayWait(run, ms) {
  return new Promise((resolve) => {
    if (run.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    run.abortPromise.then(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

function replayProgress(run, index, status, extra) {
  if (run.done) return;
  const msg = { type: 'REPLAY_PROGRESS', windowId: run.windowId, runId: run.runId, index, status };
  if (extra) {
    if (extra.error) msg.error = String(extra.error);
    if (typeof extra.matchCount === 'number') msg.matchCount = extra.matchCount;
    if (typeof extra.durationMs === 'number') msg.durationMs = extra.durationMs;
    if (extra.heartbeat) msg.heartbeat = true;
  }
  relayToSidePanel(msg);
}

// ── recording pause around a replay ──

/** Pause the window's recording session (and the replayed tab's, if another) for the run. */
function pauseForReplay(run) {
  const windows = new Set([run.windowId]);
  const tabSession = sessionForTab(run.tabId);
  if (tabSession) windows.add(tabSession.windowId);
  let changed = false;
  for (const w of windows) {
    const s = sessions.get(w);
    if (!s || s.paused) continue;
    s.paused = true;
    run.resume.add(w);
    changed = true;
    for (const id of s.tabIds) sendToFrame(id, { type: 'PAUSE_RECORDING' });
    relayRecordingState(w);
  }
  if (changed) persistState();
}

/** Undo pauseForReplay for one session — only if it is still the replay's pause. */
function resumeAfterReplay(windowId) {
  const s = sessions.get(windowId);
  if (!s || !s.paused) return;
  s.paused = false;
  persistState();
  for (const id of s.tabIds) sendToFrame(id, { type: 'RESUME_RECORDING' });
  relayRecordingState(windowId);
}

/** The user set this window's recording state themselves: the replay no longer restores it. */
function releaseReplayPause(windowId) {
  if (!isWindowId(windowId)) return;
  let changed = false;
  for (const run of replayRuns.values()) if (run.resume.delete(windowId)) changed = true;
  for (const r of interruptedReplays) {
    const i = r.resume.indexOf(windowId);
    if (i >= 0) {
      r.resume.splice(i, 1);
      changed = true;
    }
  }
  if (changed) persistState();
}

/**
 * Clean up after runs that died with an earlier worker: give back the recording
 * they paused, and tell their panel (only `windowId`'s, when given) that they ended.
 */
function settleInterruptedReplays(windowId) {
  if (!interruptedReplays.length) return;
  let changed = false;
  interruptedReplays = interruptedReplays.filter((r) => {
    if (r.resume.length) {
      // A new run in the same window has already taken over the pause.
      if (!replayRuns.has(r.windowId)) r.resume.forEach(resumeAfterReplay);
      r.resume = [];
      changed = true;
    }
    if (isWindowId(windowId) && r.windowId !== windowId) return true;
    const delivered = hasPanelPort(r.windowId);
    relayToSidePanel({
      type: 'REPLAY_DONE',
      windowId: r.windowId,
      runId: r.runId,
      result: 'error',
      error: REPLAY_INTERRUPTED_ERROR
    });
    if (delivered) changed = true;
    return !delivered;
  });
  if (changed) persistState();
}

// ── run lifecycle ──

function finishReplay(run, outcome) {
  if (run.done) return;
  run.done = true;
  run.aborted = true;
  run.abortResolve();
  if (replayRuns.get(run.windowId) === run) replayRuns.delete(run.windowId);
  for (const w of run.resume) resumeAfterReplay(w);
  run.resume.clear();
  run.secrets = {};
  run.secretGate = null;
  persistState();
  const msg = { type: 'REPLAY_DONE', windowId: run.windowId, runId: run.runId, result: outcome.result };
  if (typeof outcome.failedIndex === 'number') msg.failedIndex = outcome.failedIndex;
  if (outcome.error) msg.error = String(outcome.error);
  relayToSidePanel(msg);
}

/** Stop a run now. Its REPLAY_DONE goes out immediately; the step loop notices and exits. */
function abortReplay(run, result, error) {
  if (run.done) return;
  if (!run.started) {
    // Still in its pre-flight checks: startReplay answers the panel instead.
    run.aborted = true;
    run.abortResolve();
    return;
  }
  finishReplay(run, { result, error });
}

function sanitizeSecrets(secrets) {
  const out = {};
  if (!secrets || typeof secrets !== 'object') return out;
  for (const k of Object.keys(secrets)) {
    if (typeof secrets[k] === 'string' && secrets[k] !== '') out[k] = secrets[k];
  }
  return out;
}

function startReplay(msg, respond) {
  const steps = (Array.isArray(msg.steps) ? msg.steps : []).filter(
    (s) => s && typeof s === 'object' && typeof s.action === 'string'
  );
  if (!steps.length) {
    respond({ ok: false, error: 'There are no steps to replay.' });
    return;
  }
  if (steps.length > REPLAY_MAX_STEPS) {
    respond({ ok: false, error: `Too many steps to replay (max ${REPLAY_MAX_STEPS}).` });
    return;
  }
  queryActiveTab(msg.windowId, (active) => {
    ready().then(() => {
      const windowId = isWindowId(msg.windowId) ? msg.windowId : active ? active.windowId : undefined;
      if (!isWindowId(windowId)) {
        respond({ ok: false, error: 'No window to replay in.' });
        return;
      }
      if (replayRuns.has(windowId)) {
        respond({ ok: false, error: 'A replay is already running in this window.' });
        return;
      }
      // The window's active tab; failing that, the first tab of its recording.
      const s = sessions.get(windowId);
      const tabId = active ? active.id : s && s.tabIds.size ? s.tabIds.values().next().value : undefined;
      if (typeof tabId !== 'number') {
        respond({ ok: false, error: 'No tab to replay in.' });
        return;
      }
      const options = msg.options && typeof msg.options === 'object' ? msg.options : {};
      let abortResolve;
      const run = {
        runId: newRunId(),
        windowId,
        tabId,
        steps,
        secrets: sanitizeSecrets(msg.secrets),
        stopOnFailure: options.stopOnFailure !== false,
        slowMoMs: clampNumber(options.slowMoMs, 0, 10000, 0),
        stepTimeoutMs: clampNumber(options.stepTimeoutMs, 100, 60000, REPLAY_DEFAULT_STEP_TIMEOUT_MS),
        resume: new Set(),
        startedAt: Date.now(),
        started: false,
        aborted: false,
        done: false,
        abortPromise: new Promise((r) => (abortResolve = r)),
        abortResolve: () => abortResolve()
      };
      // Claimed synchronously with the check above, so a second start is refused.
      replayRuns.set(windowId, run);
      const before = interruptedReplays.length;
      interruptedReplays = interruptedReplays.filter((r) => r.windowId !== windowId || r.resume.length);
      if (interruptedReplays.length !== before) persistState();

      // Every frame needs the content script (a step may live in an iframe). A page
      // that refuses it can still be replayed when the first step navigates away.
      const firstRunnable = steps.find((st) => st.action !== 'viewport' && !st.suggested);
      const startsWithGoto = !!firstRunnable && firstRunnable.action === 'goto';
      injectAllFrames(tabId, () => {
        pingTopFrame(tabId, (alive) => {
          if (run.aborted || (!alive && !startsWithGoto)) {
            if (replayRuns.get(windowId) === run) replayRuns.delete(windowId);
            run.done = true;
            respond({ ok: false, error: run.aborted ? 'Replay was stopped.' : unreachableError(tabId) });
            return;
          }
          run.started = true;
          run.readySeq = loadSeqOf(tabId);
          pauseForReplay(run);
          persistState();
          respond({ ok: true, runId: run.runId });
          // After the response, so the panel knows the runId before any progress.
          setTimeout(() => runReplay(run), 0);
        });
      });
    });
  });
}

async function runReplay(run) {
  let failedIndex;
  let failedError;
  try {
    for (let i = 0; i < run.steps.length; i++) {
      if (run.aborted) return;
      if (i > 0 && run.slowMoMs > 0) await replayWait(run, run.slowMoMs);
      if (run.aborted) return;
      replayProgress(run, i, 'running');
      const t0 = Date.now();
      // One step can legitimately outlast the panel's watchdog (a page load, the
      // step's own wait, then a redirect chain), so keep telling it we are alive.
      const beat = setInterval(() => replayProgress(run, i, 'running', { heartbeat: true }), REPLAY_HEARTBEAT_MS);
      let out;
      try {
        out = await replayStep(run, i, run.steps[i]);
      } finally {
        clearInterval(beat);
      }
      if (run.aborted) return;
      if (out.fatal) {
        finishReplay(run, { result: 'error', failedIndex: i, error: out.error });
        return;
      }
      replayProgress(run, i, out.status, {
        error: out.error,
        matchCount: out.matchCount,
        durationMs: Date.now() - t0
      });
      if (out.status === 'failed') {
        if (failedIndex === undefined) {
          failedIndex = i;
          failedError = out.error;
        }
        if (run.stopOnFailure) break;
      }
    }
    finishReplay(
      run,
      failedIndex === undefined ? { result: 'passed' } : { result: 'failed', failedIndex, error: failedError }
    );
  } catch (e) {
    finishReplay(run, { result: 'error', error: String((e && e.message) || e) });
  }
}

const failed = (error, extra) => Object.assign({ status: 'failed', error }, extra || {});
const TAB_GONE = { status: 'failed', error: 'The tab being replayed was closed.', fatal: true };

/** Map a waitForTabReady outcome that is not 'ready' to a step result. */
function loadFailure(state, tabId) {
  if (state === 'gone') return TAB_GONE;
  if (state === 'unreachable') return failed(unreachableError(tabId));
  if (state === 'aborted') return { status: 'aborted' };
  return failed('page did not finish loading');
}

/**
 * Wait until the tab has finished loading and its top frame answers PING
 * (injecting every frame first — the manifest only injects the top one).
 * expectNavigation: a navigation was just requested; give it a moment to start
 * (navSeq is the load count from before the request) so the old, already
 * complete document is not mistaken for the new one.
 * @returns 'ready' | 'timeout' | 'unreachable' | 'gone' | 'aborted'
 */
async function waitForTabReady(run, opts) {
  const { expectNavigation = false, navSeq = loadSeqOf(run.tabId), timeoutMs = REPLAY_LOAD_TIMEOUT_MS } = opts || {};
  let waited = 0;
  let pingFailures = 0;
  for (;;) {
    if (run.aborted) return 'aborted';
    const tab = await tabGet(run.tabId);
    if (run.aborted) return 'aborted';
    if (!tab) return 'gone';
    const started = loadSeqOf(run.tabId) !== navSeq;
    const loading = tab.status === 'loading';
    if (!loading && (!expectNavigation || started || waited >= REPLAY_NAV_START_GRACE_MS)) {
      await injectP(run.tabId);
      if (run.aborted) return 'aborted';
      if (await pingP(run.tabId)) {
        run.readySeq = loadSeqOf(run.tabId);
        return 'ready';
      }
      // Complete but no script, even after injecting: a page Locatra may not run on.
      if (++pingFailures >= 5) return 'unreachable';
    }
    if (waited >= timeoutMs) return 'timeout';
    await replayWait(run, REPLAY_POLL_MS);
    waited += REPLAY_POLL_MS;
  }
}

async function replayStep(run, index, step) {
  if (step.suggested) return { status: 'skipped', error: 'suggested step was not accepted' };
  if (step.action === 'viewport') return { status: 'skipped', error: 'viewport is not changed during replay' };
  if (step.action === 'goto') return replayGoto(run, step);

  // Between steps: let a navigation the previous step started finish first.
  const tab = await tabGet(run.tabId);
  if (!tab) return TAB_GONE;
  if (tab.status === 'loading' || loadSeqOf(run.tabId) !== run.readySeq) {
    const state = await waitForTabReady(run);
    if (state !== 'ready') return loadFailure(state, run.tabId);
  }
  return replayInPage(run, index, step, 0);
}

async function replayGoto(run, step) {
  const url = typeof step.value === 'string' ? step.value.trim() : '';
  if (!/^https?:\/\//i.test(url)) return failed(`can't navigate to "${url}" (only http and https pages can be replayed)`);
  const navSeq = loadSeqOf(run.tabId);
  const res = await tabUpdate(run.tabId, { url });
  if (run.aborted) return { status: 'aborted' };
  if (!res.ok) {
    if (!(await tabGet(run.tabId))) return TAB_GONE;
    return failed(`navigation failed: ${res.error || 'unknown error'}`);
  }
  const state = await waitForTabReady(run, { expectNavigation: true, navSeq });
  return state === 'ready' ? { status: 'passed' } : loadFailure(state, run.tabId);
}

/** Send one REPLAY_STEP to every frame of the tab. Resolves {res} | {noAnswer} | {timedOut} | {aborted}. */
function sendReplayStep(run, msg) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    };
    timer = setTimeout(() => finish({ timedOut: true }), msg.timeoutMs + REPLAY_RESPONSE_GRACE_MS);
    run.abortPromise.then(() => finish({ aborted: true }));
    try {
      chrome.tabs.sendMessage(run.tabId, msg, (res) => {
        const err = chrome.runtime.lastError;
        finish(err || !res || typeof res !== 'object' ? { noAnswer: true } : { res });
      });
    } catch (e) {
      finish({ noAnswer: true });
    }
  });
}

/** REPLAY_SECRET_REQUEST from a frame of `tabId`: {ok, value} once per step attempt, else {ok:false}. */
function takeReplaySecret(tabId, runId, index) {
  for (const run of replayRuns.values()) {
    if (run.done || run.tabId !== tabId || run.runId !== runId) continue;
    const gate = run.secretGate;
    if (!gate || gate.served || gate.index !== index) return { ok: false };
    const step = run.steps[index];
    const name = step && step.sensitive ? step.secretName : null;
    if (typeof name !== 'string' || typeof run.secrets[name] !== 'string') return { ok: false };
    gate.served = true;
    return { ok: true, value: run.secrets[name] };
  }
  return { ok: false };
}

async function replayInPage(run, index, step, attempt) {
  const msg = {
    type: 'REPLAY_STEP',
    runId: run.runId,
    index,
    step,
    timeoutMs: run.stepTimeoutMs,
    highlight: true
  };
  // A sensitive step's value is not sent with it: the frame that owns the step
  // fetches it with REPLAY_SECRET_REQUEST, and this attempt opens one such fetch.
  run.secretGate = step.sensitive ? { index, attempt, served: false } : null;
  const seqBefore = loadSeqOf(run.tabId);
  const reply = await sendReplayStep(run, msg);
  run.secretGate = null; // answered or gave up: a late request gets nothing
  if (run.aborted || reply.aborted) return { status: 'aborted' };

  if (reply.res) {
    const r = reply.res;
    const extra = typeof r.matchCount === 'number' ? { matchCount: r.matchCount } : {};
    if (r.ok === true) {
      if (REPLAY_ACTIONS.has(step.action)) await replayWait(run, REPLAY_SETTLE_MS);
      return Object.assign({ status: 'passed' }, extra);
    }
    if (r.skipped) return Object.assign({ status: 'skipped', error: String(r.error || 'skipped') }, extra);
    return failed(String(r.error || 'step failed'), extra);
  }

  // Nobody answered (or not in time). Either the page navigated underneath the
  // step — typically because the step itself clicked a link — or no frame owns it.
  const navigated = async () => {
    const tab = await tabGet(run.tabId);
    if (!tab) return null;
    return loadSeqOf(run.tabId) !== seqBefore || tab.status === 'loading';
  };
  let nav = await navigated();
  if (nav === null) return TAB_GONE;
  if (!nav && !reply.timedOut) {
    await replayWait(run, REPLAY_NO_ANSWER_RETRY_MS);
    if (run.aborted) return { status: 'aborted' };
    nav = await navigated();
    if (nav === null) return TAB_GONE;
  }
  if (nav) {
    const state = await waitForTabReady(run);
    if (state !== 'ready') return loadFailure(state, run.tabId);
    // An action that navigated did its job. Anything else is idempotent and never
    // got to run on the old page, so it gets one go on the new one.
    if (REPLAY_ACTIONS.has(step.action)) return { status: 'passed' };
    if (attempt === 0) return replayInPage(run, index, step, 1);
    return failed('frame not found or page navigated');
  }
  if (reply.timedOut) return failed(`step timed out after ${Math.round(run.stepTimeoutMs / 100) / 10}s`);
  if (attempt === 0) {
    // A frame may have been added (or reloaded) since the last injection.
    await injectP(run.tabId);
    if (run.aborted) return { status: 'aborted' };
    return replayInPage(run, index, step, 1);
  }
  return failed('frame not found or page navigated');
}
