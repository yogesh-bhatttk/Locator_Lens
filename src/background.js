// LocatorLens – background.js (Service Worker)
// Handles communication between popup, side panel, and content script

/** Load order matters: engine defines __LocatorLensEngine before content.js runs. */
const CONTENT_SCRIPT_FILES = ['src/codegen.js', 'src/content-locator-engine.js', 'src/content.js'];

// The manifest injects only the top frame, deliberately: a content script declared
// with all_frames runs in every ad and tracking iframe of every page the user
// visits, and parsing it there costs them something for nothing. Frames that
// actually matter get the script when a feature is switched on, and content.js
// no-ops on a frame that already has it.
function injectAllFrames(tabId, done) {
  chrome.scripting.executeScript(
    { target: { tabId, allFrames: true }, files: CONTENT_SCRIPT_FILES },
    () => {
      void chrome.runtime.lastError; // restricted page, or a frame that vanished
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

// Long-lived channels so the service worker can push UI updates (recording, picks)
// to the side panel reliably.
//
// One panel exists per browser window, so this has to be a set: a single slot meant
// opening a second window silently muted the first window's panel, which kept its
// port but never received another relay. Every connected panel is a view of the same
// session — one recording, one last pick — so a relay goes to all of them.
const sidePanelPorts = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'll-sidepanel') return;
  sidePanelPorts.add(port);
  port.onDisconnect.addListener(() => sidePanelPorts.delete(port));
});

// ── Durable service-worker state ─────────────────────────────────────────────
// MV3 tears down an idle service worker after ~30 seconds and every module-scope
// variable goes with it. That is not a theoretical concern here: `recordingTabs`
// is what re-arms capture after a full-page navigation, so once the worker had
// been evicted a multi-page recording silently stopped collecting steps partway
// through, and `inspectTabs` made GET_INSPECT_STATE report "not inspecting" to a
// popup whose page was still in inspect mode.
//
// chrome.storage.session holds these for the life of the browser session and is
// never written to disk. Where it is unavailable we degrade to the old in-memory
// behaviour rather than fall back to storage.local, which would resurrect stale
// tab ids after a browser restart.
const SESSION_STATE_KEY = 'llWorkerState';
const sessionArea = (chrome.storage && chrome.storage.session) || null;

const inspectTabs = new Set();
const recordingTabs = new Set(); // tabs with an active recording (so we can re-arm after navigation)

// The side panel is a single window-level surface with no sender.tab, so it can't be
// tracked per tab — it's one timestamp kept alive by a heartbeat. (It used to be a Set
// that heartbeats added 'global' to while tab teardown deleted numeric ids from, so
// the cleanup never actually matched anything.)
const PANEL_HEARTBEAT_TTL_MS = 12000;
let panelLastSeen = 0;
// Which tab+frame produced the last pick. The Stress Test runs against that element,
// and only the frame holding it can answer — broadcasting to every frame would have
// them all race to sendResponse.
let lastPick = null;
function isPanelActive() {
  return panelLastSeen > 0 && (Date.now() - panelLastSeen) < PANEL_HEARTBEAT_TTL_MS;
}

let hydrated = !sessionArea;
let hydrating = null;

/** Resolve once this worker instance has its state back. Cheap after the first call. */
function ready() {
  if (hydrated) return Promise.resolve();
  if (hydrating) return hydrating;
  hydrating = new Promise((resolve) => {
    sessionArea.get(SESSION_STATE_KEY, (res) => {
      void chrome.runtime.lastError;
      const saved = (res && res[SESSION_STATE_KEY]) || {};
      if (Array.isArray(saved.inspect)) saved.inspect.forEach((id) => inspectTabs.add(id));
      if (Array.isArray(saved.recording)) saved.recording.forEach((id) => recordingTabs.add(id));
      if (typeof saved.panelLastSeen === 'number') panelLastSeen = saved.panelLastSeen;
      if (saved.lastPick) lastPick = saved.lastPick;
      hydrated = true;
      hydrating = null;
      resolve();
    });
  });
  return hydrating;
}

function persistState() {
  if (!sessionArea) return;
  sessionArea.set({
    [SESSION_STATE_KEY]: {
      inspect: Array.from(inspectTabs),
      recording: Array.from(recordingTabs),
      panelLastSeen,
      lastPick
    }
  }, () => { void chrome.runtime.lastError; });
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
    chrome.contextMenus.create({
      id: 'll-toggle-panel',
      title: '📋 Open/Close Results Panel',
      contexts: ['all']
    }, () => { void chrome.runtime.lastError; });
  });
});

// ── Context menu click ────────────────────────────────────────────────────────
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'll-toggle-panel' && tab && tab.windowId) {
    // If it's already open, it will just stay open or reload in Chrome
    openSidePanel(tab.windowId);
    return;
  }
  if (info.menuItemId !== 'll-copy-locator') return;
  if (!tab || !tab.id) return;

  // info.frameId identifies the frame the user right-clicked in. Without it the
  // message goes to every frame and each one answers for whatever *it* last saw
  // under the cursor — so the copied locator would be a race between frames.
  const frameId = typeof info.frameId === 'number' ? info.frameId : 0;
  sendToFrame(tab.id, { type: 'CONTEXT_MENU_COPY' }, frameId, () => {
    if (!chrome.runtime.lastError) return;
    injectAllFrames(tab.id, () => {
      setTimeout(() => sendToFrame(tab.id, { type: 'CONTEXT_MENU_COPY' }, frameId), 100);
    });
  });
});

// ── Helper: open side panel for the active window ─────────────────────────────
function openSidePanel(windowId) {
  if (!windowId) return;
  // Use bracket notation to avoid static analyzer warnings in Firefox
  const sidePanel = chrome['sidePanel'];
  if (sidePanel && sidePanel.open) {
    sidePanel.open({ windowId }).catch(() => { });
  } else if (typeof browser !== 'undefined' && browser.sidebarAction && browser.sidebarAction.open) {
    browser.sidebarAction.open().catch(() => { });
  }
}

// ── Helper: relay message to side panel ──────────────────────────────────────
function relayToSidePanel(msg) {
  let delivered = 0;
  for (const port of Array.from(sidePanelPorts)) {
    try {
      port.postMessage(msg);
      delivered++;
    } catch (e) {
      sidePanelPorts.delete(port); // disconnected between the check and the post
    }
  }
  if (delivered > 0) return;
  // No panel is connected over a port — fall back to a broadcast, which also
  // reaches the popup.
  chrome.runtime.sendMessage(msg, () => {
    void chrome.runtime.lastError;
  });
}

// ── Popup / SidePanel ↔ Content message relay ─────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  // START_INSPECT: activate on the current tab + open side panel
  if (msg.type === 'START_INSPECT') {
    // openSidePanel() must stay on the synchronous path from the user's click:
    // Chrome rejects sidePanel.open() once the gesture has been awaited away.
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      const tabId = tabs[0].id;
      const winId = tabs[0].windowId;

      // Open side panel first so user can see results
      openSidePanel(winId);

      // Tell side panel inspect is active
      relayToSidePanel({ type: 'START_INSPECT' });

      ready().then(() => {
        inspectTabs.add(tabId);
        persistState();
      });

      // Inject first, then broadcast: sub-frames have no content script until now,
      // and each frame overlays and hit-tests its own document.
      injectAllFrames(tabId, () => {
        sendToFrame(tabId, { type: 'START_INSPECT' });
      });
    });
  }

  if (msg.type === 'STOP_INSPECT') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      const tabId = tabs[0].id;
      ready().then(() => {
        inspectTabs.delete(tabId);
        persistState();
      });
      chrome.tabs.sendMessage(tabId, { type: 'STOP_INSPECT' }, () => {
        void chrome.runtime.lastError;
      });
      relayToSidePanel({ type: 'STOP_INSPECT' });
    });
  }

  // ELEMENT_PICKED: store + relay to side panel
  if (msg.type === 'ELEMENT_PICKED') {
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ lastElement: msg.data }); // local storage for cross-browser compatibility
    }
    if (sender && sender.tab) {
      ready().then(() => {
        lastPick = { tabId: sender.tab.id, frameId: typeof sender.frameId === 'number' ? sender.frameId : 0 };
        persistState();
      });
    }
    relayToSidePanel({ type: 'ELEMENT_PICKED', data: msg.data });
  }

  // Popup / SidePanel checking inspect state
  if (msg.type === 'GET_INSPECT_STATE') {
    ready().then(() => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        sendResponse({ active: tabs[0] ? inspectTabs.has(tabs[0].id) : false });
      });
    });
    return true;
  }

  // Side panel reopened mid-session: without this it renders "Start Recording"
  // while the page is still capturing, and the next click sends START on an
  // already-recording tab instead of stopping it.
  if (msg.type === 'GET_RECORDING_STATE') {
    ready().then(() => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const active = tabs[0] ? recordingTabs.has(tabs[0].id) : false;
        sendResponse({ active, anyTab: recordingTabs.size > 0 });
      });
    });
    return true;
  }

  // OPEN_SIDE_PANEL: called from popup when user clicks "Open Panel"
  if (msg.type === 'OPEN_SIDE_PANEL') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) openSidePanel(tabs[0].windowId);
    });
  }

  // CLOSE_SIDE_PANEL: only works in Firefox
  if (msg.type === 'CLOSE_SIDE_PANEL') {
    if (typeof browser !== 'undefined' && browser.sidebarAction && browser.sidebarAction.close) {
      browser.sidebarAction.close().catch(() => { });
    }
  }

  // Track panel open/close. The TTL comparison in isPanelActive() is what expires a
  // stale heartbeat — a setTimeout would not survive worker eviction anyway.
  if (msg.type === 'PANEL_HEARTBEAT') {
    ready().then(() => {
      // The panel pings every 4s. Only write when the stored stamp is drifting far
      // enough to matter against the TTL, rather than on every ping.
      const now = Date.now();
      const worthWriting = now - panelLastSeen > PANEL_HEARTBEAT_TTL_MS / 3;
      panelLastSeen = now;
      if (worthWriting) persistState();
    });
  }

  if (msg.type === 'GET_PANEL_STATE') {
    ready().then(() => sendResponse({ active: isPanelActive() }));
    return true;
  }

  // RUN_STRESS_TEST: relay from side panel to content script
  if (msg.type === 'RUN_STRESS_TEST') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      const tabId = tabs[0].id;
      const finish = (res) => {
        // Always relay something so the side-panel button never hangs on "Testing…".
        const data = (res && res.data) ? res.data : { survived: false, unavailable: true };
        relayToSidePanel({ type: 'STRESS_TEST_RESULT', data });
      };
      ready().then(() => {
        // Only the frame holding the picked element can answer; every other frame
        // would report noTarget and race it to sendResponse.
        const frameId = lastPick && lastPick.tabId === tabId ? lastPick.frameId : 0;
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
  }

  // 🔬 SELECTOR LAB: relay validate/clear to the active tab's content script.
  // (Side panel uses runtime.sendMessage, which never reaches content scripts on its own.)
  if (msg.type === 'LAB_VALIDATE' || msg.type === 'LAB_CLEAR') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      const tabId = tabs[0].id;
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
  }

  // 🎬 RECORDING: Start/Stop recording on the active tab
  if (msg.type === 'START_RECORDING') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      const tabId = tabs[0].id;
      // so we can re-arm capture after a full-page navigation
      ready().then(() => { recordingTabs.add(tabId); persistState(); });
      // Every frame records its own events — a click inside an iframe never reaches
      // the top document's listeners.
      injectAllFrames(tabId, () => {
        sendToFrame(tabId, { type: 'START_RECORDING' });
      });
    });
  }

  if (msg.type === 'STOP_RECORDING') {
    // single recording session — stop re-arming on any tab
    ready().then(() => { recordingTabs.clear(); persistState(); });
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { type: 'STOP_RECORDING' }, () => {
        void chrome.runtime.lastError;
      });
    });
  }

  // Pause/resume + assert-mode: forward the whole message (carries `on`/`assertType`).
  if (msg.type === 'PAUSE_RECORDING' || msg.type === 'RESUME_RECORDING' || msg.type === 'SET_ASSERT_MODE') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, msg, () => { void chrome.runtime.lastError; });
    });
  }

  // RECORDED_ACTION: relay from content script to side panel (slim payload — large locator arrays can fail clone)
  if (msg.type === 'RECORDED_ACTION') {
    const d = msg.data || {};
    const tabId = sender && sender.tab ? sender.tab.id : 0;
    relayToSidePanel({
      type: 'RECORDED_ACTION',
      data: {
        action: d.action,
        value: d.value,
        code: d.code,
        fullCode: d.fullCode,
        target: d.target, // structured locator — required for non-Playwright codegen
        assertType: d.assertType, // for recorded assertions
        sequence: d.sequence,
        timestamp: d.timestamp,
        url: d.url,
        tabId,
        eventId: d.eventId
      }
    });
  }
});

// Clean up when tab closes
chrome.tabs.onRemoved.addListener((tabId) => {
  ready().then(() => {
    const changed = inspectTabs.delete(tabId) || recordingTabs.delete(tabId);
    if (changed) persistState();
  });
});
// Clean up on navigation (and sync UI)
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'loading' && info.status !== 'complete') return;
  ready().then(() => {
    if (info.status === 'loading') {
      if (inspectTabs.delete(tabId)) {
        persistState();
        // Explicitly tell the UI that this tab is no longer inspecting
        relayToSidePanel({ type: 'STOP_INSPECT' });
      }
      return;
    }
    // Re-arm recording after a full-page navigation so multi-page flows keep capturing.
    // The content script (re-injected by the manifest on load) records a fresh goto on start.
    if (!recordingTabs.has(tabId)) return;
    sendToFrame(tabId, { type: 'START_RECORDING', rearm: true }, undefined, () => {
      if (!chrome.runtime.lastError) return;
      injectAllFrames(tabId, () => {
        setTimeout(() => sendToFrame(tabId, { type: 'START_RECORDING', rearm: true }), 80);
      });
    });
  });
});
