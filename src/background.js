// LocatorLens – background.js (Service Worker)
// Handles communication between popup, side panel, and content script

// Track inspect mode per tab
const inspectTabs = new Set();
const activePanels = new Set(); // Track which tabs have an open side panel

// ── Register context menu on install ────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'll-copy-locator',
    title: '🎯 Copy Best Playwright Locator',
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
        { target: { tabId: tab.id }, files: ['src/content.js'] },
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
  chrome.runtime.sendMessage(msg, () => {
    void chrome.runtime.lastError; // suppress if panel is closed
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
            files: ['src/content.js']
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
    const key = (sender.tab && sender.tab.id) ? sender.tab.id : 'global';
    activePanels.add(key);
    
    // Using a simple timeout to remove the panel from active state if it goes silent
    if (globalThis[`timeout_${key}`]) clearTimeout(globalThis[`timeout_${key}`]);
    globalThis[`timeout_${key}`] = setTimeout(() => {
      activePanels.delete(key);
    }, 4500); 
  }
  
  if (msg.type === 'GET_PANEL_STATE') {
    // We check for 'global' as the side panel is usually global for the window in Chrome
    sendResponse({ active: activePanels.has('global') });
  }
});

// Clean up when tab closes
chrome.tabs.onRemoved.addListener((tabId) => {
  inspectTabs.delete(tabId);
  activePanels.delete(tabId);
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
});
