// LocatorLens – popup.js (Launcher only — results live in the Side Panel)

let isInspecting = false;

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

function toggleInspect() {
  isInspecting = !isInspecting;
  updateInspectUI();
  // START_INSPECT will also auto-open the side panel via background.js
  chrome.runtime.sendMessage({ type: isInspecting ? 'START_INSPECT' : 'STOP_INSPECT' });
}

function openPanel() {
  const btn = document.getElementById('panelBtn');
  const txt = btn.querySelectorAll('span')[1];
  
  if (txt && txt.textContent.includes('Close')) {
    // In Firefox, we can actually close it
    if (typeof browser !== 'undefined' && browser.sidebarAction && browser.sidebarAction.close) {
      chrome.runtime.sendMessage({ type: 'CLOSE_SIDE_PANEL' });
      txt.textContent = 'Open Results Panel';
    } else {
      // In Chrome, we can only remind the user
      alert('Chrome does not support closing the Side Panel programmatically yet! Please use the sidebar "X" or the browser toggle button.');
    }
  } else {
    chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' });
    if (txt) txt.textContent = 'Close Result Panel';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('inspectBtn').addEventListener('click', toggleInspect);
  document.getElementById('panelBtn').addEventListener('click', openPanel);

  // Restore inspect state (e.g. if popup was re-opened while inspecting)
  chrome.runtime.sendMessage({ type: 'GET_INSPECT_STATE' }, (res) => {
    if (res && res.active) {
      isInspecting = true;
      updateInspectUI();
    }
  });

  // Check if side panel is already open to show 'Close' button
  chrome.runtime.sendMessage({ type: 'GET_PANEL_STATE' }, (res) => {
    if (res && res.active) {
      const txt = document.querySelectorAll('#panelBtn span')[1];
      if (txt) txt.textContent = 'Close Result Panel';
    }
  });
});
