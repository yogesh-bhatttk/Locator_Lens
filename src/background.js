// Locatra – background.js (Service Worker)
// Handles communication between popup, side panel, and content script
//
// Everything here is window-scoped. The side panel is a per-window surface, so two
// windows can each inspect, each record and each have their own panel open at once;
// every piece of state below is keyed so that one window's activity can never
// steer, stop or show up in another's.

/** Load order matters: engine defines __LocatorLensEngine before content.js runs. */
const CONTENT_SCRIPT_FILES = ['src/codegen.js', 'src/content-locator-engine.js', 'src/content.js'];

/** Shown by the panel/popup when a page refuses the content script. */
const RESTRICTED_PAGE_ERROR =
  "Locatra can't run on this page (browser pages, the Web Store, PDFs and some file:// pages are off-limits).";

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
      // install that injection could not replace.
      void chrome.runtime.lastError;
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
      hydrated = true;
      hydrating = null;
      resolve();
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
      lastPick
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
              respond({ ok: false, error: RESTRICTED_PAGE_ERROR });
              return;
            }
            sendToFrame(tabId, { type: 'START_INSPECT' });
            relayToSidePanel({ type: 'START_INSPECT', windowId, tabId });
            respond({ ok: true });
          });
        });
      });
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
    queryActiveTab(msg.windowId, (tab) => {
      const windowId = isWindowId(msg.windowId) ? msg.windowId : tab ? tab.windowId : undefined;
      ready().then(() => {
        // The inspected tab need not still be the active one: stop every tab of
        // this window that is inspecting, plus the active tab.
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
        sendResponse({ ok: true });
      });
    });
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

  // Selector Lab results and dblclick supersession come straight from a page; the
  // panel ignores page broadcasts (it cannot tell which window they came from), so
  // they reach it through here, tagged.
  if (msg.type === 'LAB_STATUS_UPDATE' || msg.type === 'LAB_ERROR' || msg.type === 'RECORDED_ACTION_SUPERSEDE') {
    if (!fromTab) return;
    if (msg.type !== 'RECORDED_ACTION_SUPERSEDE') {
      relayToSidePanel(Object.assign({}, msg, { windowId: fromTab.windowId, tabId: fromTab.id }));
      return;
    }
    // A supersede belongs with its steps, which go to the session's window — and
    // through the same ready() queue, so it can never overtake them.
    ready().then(() => {
      const s = sessionForTab(fromTab.id);
      relayToSidePanel(Object.assign({}, msg, { windowId: s ? s.windowId : fromTab.windowId, tabId: fromTab.id }));
    });
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
      const tabId = tab.id;
      const windowId = isWindowId(tab.windowId) ? tab.windowId : isWindowId(msg.windowId) ? msg.windowId : -1;
      ready().then(() => {
        let s = sessions.get(windowId);
        const created = !s;
        if (!s) {
          s = { windowId, tabIds: new Set(), paused: false, assertMode: false, assertType: null };
          sessions.set(windowId, s);
          // A fresh recording: anything still buffered belongs to the last one.
          clearRecordBuffer(windowId);
        }
        // Pressing Start means "capture now", whatever the previous pause said.
        s.paused = false;
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
              });
              respond({ ok: false, error: RESTRICTED_PAGE_ERROR });
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
            respond({ ok: true });
          });
        });
      });
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
    queryActiveTab(msg.windowId, (tab) => {
      const windowId = isWindowId(msg.windowId) ? msg.windowId : tab ? tab.windowId : undefined;
      ready().then(() => {
        const s = isWindowId(windowId) ? sessions.get(windowId) : null;
        const targets = new Set(s ? s.tabIds : []);
        // No session on record (e.g. state lost): still reach the visible page, so
        // a Stop is never a no-op for a tab that is visibly recording.
        if (!s && tab) targets.add(tab.id);

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
        sendResponse({ ok: true });
      });
    });
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
    });
    return;
  }
});

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
      if (s.tabIds.size === 0) sessions.delete(windowId);
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
    ready().then(() => {
      let changed = sessions.delete(windowId);
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
      if (changed) persistState();
      clearRecordBuffer(windowId);
    });
  });
}

// Clean up on navigation (and sync UI)
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'loading' && info.status !== 'complete') return;
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
