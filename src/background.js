// LocatorLens – background.js (Service Worker)
// Handles communication between popup, side panel, and content script

/** Load order matters: engine defines __LocatorLensEngine before content.js runs. */
const CONTENT_SCRIPT_FILES = ['src/codegen.js', 'src/content-locator-engine.js', 'src/content.js'];

/** Long-lived channel so the service worker can push UI updates (recording, picks) to the side panel reliably. */
let llSidePanelPort = null;
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'll-sidepanel') return;
  llSidePanelPort = port;
  port.onDisconnect.addListener(() => {
    if (llSidePanelPort === port) llSidePanelPort = null;
  });
});

// Track inspect mode per tab
const inspectTabs = new Set();
const activePanels = new Set(); // Track which tabs have an open side panel
const recordingTabs = new Set(); // tabs with an active recording (so we can re-arm after navigation)

// ── Register context menu on install ────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'll-copy-locator',
    title: '🎯 Copy Best Locator',
    contexts: ['all']
  });
  chrome.contextMenus.create({
    id: 'll-toggle-panel',
    title: '📋 Open/Close Results Panel',
    contexts: ['all']
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

  chrome.tabs.sendMessage(tab.id, { type: 'CONTEXT_MENU_COPY' }, (res) => {
    if (chrome.runtime.lastError) {
      chrome.scripting.executeScript(
        { target: { tabId: tab.id }, files: CONTENT_SCRIPT_FILES },
        () => {
          setTimeout(() => {
            chrome.tabs.sendMessage(tab.id, { type: 'CONTEXT_MENU_COPY' });
          }, 100);
        }
      );
    }
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
  if (llSidePanelPort) {
    try {
      llSidePanelPort.postMessage(msg);
      return;
    } catch (e) {
      llSidePanelPort = null;
    }
  }
  chrome.runtime.sendMessage(msg, () => {
    void chrome.runtime.lastError;
  });
}

// ── Popup / SidePanel ↔ Content message relay ─────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // START_INSPECT: activate on the current tab + open side panel
  if (msg.type === 'START_INSPECT') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      const tabId = tabs[0].id;
      const winId = tabs[0].windowId;
      inspectTabs.add(tabId);

      // Open side panel first so user can see results
      openSidePanel(winId);

      // Tell side panel inspect is active
      relayToSidePanel({ type: 'START_INSPECT' });

      chrome.tabs.sendMessage(tabId, { type: 'START_INSPECT' }, (r) => {
        if (chrome.runtime.lastError) {
          chrome.scripting.executeScript({
            target: { tabId },
            files: CONTENT_SCRIPT_FILES
          }, () => {
            chrome.tabs.sendMessage(tabId, { type: 'START_INSPECT' });
          });
        }
      });
    });
  }

  if (msg.type === 'STOP_INSPECT') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      const tabId = tabs[0].id;
      inspectTabs.delete(tabId);
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
    relayToSidePanel({ type: 'ELEMENT_PICKED', data: msg.data });
  }

  // Popup / SidePanel checking inspect state
  if (msg.type === 'GET_INSPECT_STATE') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      sendResponse({ active: tabs[0] ? inspectTabs.has(tabs[0].id) : false });
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

  // Track panel open/close with timeout safety
  if (msg.type === 'PANEL_HEARTBEAT') {
    // Side panel / extension pages often have no sender.tab; treat as one logical panel.
    const key = 'global';
    activePanels.add(key);
    if (globalThis._llPanelHeartbeatTimer) clearTimeout(globalThis._llPanelHeartbeatTimer);
    globalThis._llPanelHeartbeatTimer = setTimeout(() => {
      activePanels.delete(key);
    }, 12000);
  }

  if (msg.type === 'GET_PANEL_STATE') {
    sendResponse({ active: activePanels.size > 0 });
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
      chrome.tabs.sendMessage(tabId, { type: 'RUN_STRESS_TEST' }, (res) => {
        if (chrome.runtime.lastError) {
          chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES }, () => {
            void chrome.runtime.lastError;
            setTimeout(() => {
              chrome.tabs.sendMessage(tabId, { type: 'RUN_STRESS_TEST' }, finish);
            }, 100);
          });
          return;
        }
        finish(res);
      });
    });
  }

  // 🔬 SELECTOR LAB: relay validate/clear to the active tab's content script.
  // (Side panel uses runtime.sendMessage, which never reaches content scripts on its own.)
  if (msg.type === 'LAB_VALIDATE' || msg.type === 'LAB_CLEAR') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      const tabId = tabs[0].id;
      chrome.tabs.sendMessage(tabId, msg, () => {
        if (chrome.runtime.lastError) {
          // Content script not yet present — inject, then retry.
          chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES }, () => {
            void chrome.runtime.lastError;
            setTimeout(() => {
              chrome.tabs.sendMessage(tabId, msg, () => void chrome.runtime.lastError);
            }, 100);
          });
        }
      });
    });
  }

  // 🎬 RECORDING: Start/Stop recording on the active tab
  if (msg.type === 'START_RECORDING') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      const tabId = tabs[0].id;
      recordingTabs.add(tabId); // so we can re-arm capture after a full-page navigation
      chrome.tabs.sendMessage(tabId, { type: 'START_RECORDING' }, (r) => {
        if (chrome.runtime.lastError) {
          // Inject content script first, then start recording
          chrome.scripting.executeScript({
            target: { tabId },
            files: CONTENT_SCRIPT_FILES
          }, () => {
            void chrome.runtime.lastError;
            setTimeout(() => {
              chrome.tabs.sendMessage(tabId, { type: 'START_RECORDING' }, () => void chrome.runtime.lastError);
            }, 80);
          });
        }
      });
    });
  }

  if (msg.type === 'STOP_RECORDING') {
    recordingTabs.clear(); // single recording session — stop re-arming on any tab
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
  inspectTabs.delete(tabId);
  activePanels.delete(tabId);
  recordingTabs.delete(tabId);
});
// Clean up on navigation (and sync UI)
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    if (inspectTabs.has(tabId)) {
      inspectTabs.delete(tabId);
      // Explicitly tell the UI that this tab is no longer inspecting
      relayToSidePanel({ type: 'STOP_INSPECT' });
    }
    activePanels.delete(tabId);
  }
  // Re-arm recording after a full-page navigation so multi-page flows keep capturing.
  // The content script (re-injected by the manifest on load) records a fresh goto on start.
  if (info.status === 'complete' && recordingTabs.has(tabId)) {
    chrome.tabs.sendMessage(tabId, { type: 'START_RECORDING', rearm: true }, () => {
      if (chrome.runtime.lastError) {
        chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES }, () => {
          void chrome.runtime.lastError;
          setTimeout(() => {
            chrome.tabs.sendMessage(tabId, { type: 'START_RECORDING', rearm: true }, () => void chrome.runtime.lastError);
          }, 80);
        });
      }
    });
  }
});
