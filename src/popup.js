// Locatra – popup.js (Launcher only — results live in the Side Panel)

// Content scripts carry sender.tab — but so does this extension's own page when it
// is opened as a normal tab, which must not be mistaken for one.
function isFromContentScript(sender) {
  if (!sender || !sender.tab) return false;
  try {
    return !(typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL('')));
  } catch (e) {
    return true;
  }
}


let isInspecting = false;
let panelOpen = false;
// This popup's window, resolved at load. Opening the panel needs it synchronously
// inside the click handler (the user gesture does not survive an await), and the
// worker needs it to act on this window rather than whichever one has focus.
let popupWindowId = null;

const PANEL_OPEN_LABEL = 'Open Results Panel';
const PANEL_CLOSE_LABEL = 'Close Results Panel';

function updateInspectUI() {
  const btn = document.getElementById('inspectBtn');
  const dot = document.getElementById('statusDot');
  const icon = document.getElementById('btnIcon');
  const txt = document.getElementById('btnText');
  const hint = document.getElementById('hintRow');

  if (isInspecting) {
    btn.classList.add('active');
    dot.classList.add('active');
    icon.textContent = '⏹';
    txt.textContent = 'Stop Inspecting';
    hint.style.display = 'block';
  } else {
    btn.classList.remove('active');
    dot.classList.remove('active');
    icon.textContent = '🎯';
    txt.textContent = 'Start Inspecting';
    hint.style.display = 'none';
  }
}

function updatePanelUI() {
  const txt = document.querySelectorAll('#panelBtn span')[1];
  if (txt) txt.textContent = panelOpen ? PANEL_CLOSE_LABEL : PANEL_OPEN_LABEL;
}

/** Inline notice (never alert(): it blocks, and a popup alert is easy to lose). */
function showMessage(text, kind) {
  const el = document.getElementById('popupMsg');
  if (!el) return;
  if (!text) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.textContent = text;
  el.className = 'popup-msg' + (kind === 'error' ? ' error' : '');
  el.hidden = false;
}

const errorText = (err) => String((err && err.message) || err || 'unknown error');

const firefoxSidebar = () =>
  typeof browser !== 'undefined' && browser.sidebarAction ? browser.sidebarAction : null;
// Bracket notation keeps Firefox's static analysis from flagging a Chrome-only API.
const chromeSidePanel = () => (typeof chrome !== 'undefined' && chrome['sidePanel']) || null;

/**
 * Open the panel. MUST run synchronously inside a click handler: both browsers
 * reject open() once the gesture has been awaited away.
 * @returns a promise of the outcome (rejects with the browser's reason).
 */
function openPanelNow() {
  const sidebar = firefoxSidebar();
  if (sidebar && typeof sidebar.open === 'function') return sidebar.open();
  const sidePanel = chromeSidePanel();
  if (sidePanel && typeof sidePanel.open === 'function') {
    if (typeof popupWindowId !== 'number') return Promise.reject(new Error('window not resolved yet — try again'));
    return sidePanel.open({ windowId: popupWindowId });
  }
  return Promise.reject(new Error('this browser has no side panel API'));
}

/** @returns a promise, or null when the browser cannot close the panel from here. */
function closePanelNow() {
  const sidebar = firefoxSidebar();
  if (sidebar && typeof sidebar.close === 'function') return sidebar.close();
  const sidePanel = chromeSidePanel();
  // chrome.sidePanel.close exists from Chrome 141.
  if (sidePanel && typeof sidePanel.close === 'function' && typeof popupWindowId === 'number') {
    return sidePanel.close({ windowId: popupWindowId });
  }
  return null;
}

/** Labels follow what the browser actually did, not what was asked for. */
function trackPanelOpen(promise) {
  return Promise.resolve(promise).then(
    () => {
      panelOpen = true;
      updatePanelUI();
      return true;
    },
    (err) => {
      showMessage(`Couldn't open the results panel: ${errorText(err)}`, 'error');
      return false;
    }
  );
}

function withWindow(msg) {
  if (typeof popupWindowId === 'number') msg.windowId = popupWindowId;
  return msg;
}

function toggleInspect() {
  showMessage('');
  if (isInspecting) {
    isInspecting = false;
    updateInspectUI();
    chrome.runtime.sendMessage(withWindow({ type: 'STOP_INSPECT' }), () => {
      void chrome.runtime.lastError;
    });
    return;
  }

  // Open the panel first, still on the click's gesture, so results have somewhere
  // to go. Inspect proceeds even if that fails (the page still copies on click).
  let opening;
  try {
    opening = openPanelNow();
  } catch (err) {
    opening = Promise.reject(err);
  }
  trackPanelOpen(opening);

  isInspecting = true;
  updateInspectUI();
  chrome.runtime.sendMessage(withWindow({ type: 'START_INSPECT' }), (res) => {
    const lastError = chrome.runtime.lastError;
    if (lastError || (res && res.ok === false)) {
      isInspecting = false;
      updateInspectUI();
      showMessage((res && res.error) || `Couldn't start inspecting: ${errorText(lastError)}`, 'error');
    }
  });
}

function openPanel() {
  showMessage('');
  if (panelOpen) {
    let closing;
    try {
      closing = closePanelNow();
    } catch (err) {
      closing = Promise.reject(err);
    }
    if (!closing) {
      // Chrome before 141 has no close API.
      showMessage(
        "This version of Chrome can't close the side panel from here. Use the ✕ in the panel or the side-panel button in the toolbar.",
        'info'
      );
      return;
    }
    Promise.resolve(closing).then(
      () => {
        panelOpen = false;
        updatePanelUI();
      },
      (err) => showMessage(`Couldn't close the results panel: ${errorText(err)}`, 'error')
    );
    return;
  }

  let opening;
  try {
    opening = openPanelNow();
  } catch (err) {
    opening = Promise.reject(err);
  }
  trackPanelOpen(opening);
}

function loadState() {
  // Restore inspect state (e.g. if popup was re-opened while inspecting)
  chrome.runtime.sendMessage(withWindow({ type: 'GET_INSPECT_STATE' }), (res) => {
    if (chrome.runtime.lastError) return;
    if (res && res.active) {
      isInspecting = true;
      updateInspectUI();
    }
  });

  // Check if side panel is already open to show 'Close' button
  chrome.runtime.sendMessage(withWindow({ type: 'GET_PANEL_STATE' }), (res) => {
    if (chrome.runtime.lastError) return;
    if (res && res.active) {
      panelOpen = true;
      updatePanelUI();
    }
  });

  // Firefox can answer for this window directly, which beats a heartbeat.
  const sidebar = firefoxSidebar();
  if (sidebar && typeof sidebar.isOpen === 'function' && typeof popupWindowId === 'number') {
    Promise.resolve(sidebar.isOpen({ windowId: popupWindowId })).then(
      (open) => {
        panelOpen = !!open;
        updatePanelUI();
      },
      () => {}
    );
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Read the version from the manifest rather than hardcoding it here: a hardcoded
  // string is exactly what went stale (this once read "v1.1.6" long after the
  // extension had moved past 1.3.0), and nothing else in the build re-checks it.
  const brandSub = document.getElementById('brandSub');
  if (brandSub && chrome.runtime && typeof chrome.runtime.getManifest === 'function') {
    const version = chrome.runtime.getManifest().version;
    if (version) brandSub.textContent = `Smart locators · v${version}`;
  }

  panelOpen = false;
  updatePanelUI();
  document.getElementById('inspectBtn').addEventListener('click', toggleInspect);
  document.getElementById('panelBtn').addEventListener('click', openPanel);

  if (chrome.windows && typeof chrome.windows.getCurrent === 'function') {
    chrome.windows.getCurrent((win) => {
      void chrome.runtime.lastError;
      if (win && typeof win.id === 'number') popupWindowId = win.id;
      loadState();
    });
  } else {
    loadState();
  }

  // Real-time sync with background relays (e.g. from page refresh). Only for this
  // window: another window's tab navigating must not flip this popup's state, and a
  // page's own broadcast (sender.tab set) does not say which window it means.
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (isFromContentScript(sender)) return;
    if (typeof msg.windowId === 'number' && typeof popupWindowId === 'number' && msg.windowId !== popupWindowId) {
      return;
    }
    if (msg.type === 'START_INSPECT') {
      isInspecting = true;
      updateInspectUI();
    }
    if (msg.type === 'STOP_INSPECT') {
      isInspecting = false;
      updateInspectUI();
    }
  });
});
