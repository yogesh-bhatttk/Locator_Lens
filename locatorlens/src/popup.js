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
  chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' });
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
});
