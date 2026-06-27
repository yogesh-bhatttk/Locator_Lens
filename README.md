# LocatorLens — locator inspector & test recorder

[![Chrome](https://img.shields.io/badge/Chrome-Ready-green?logo=google-chrome&logoColor=white)]()
[![Firefox](https://img.shields.io/badge/Firefox-Ready-orange?logo=firefox-browser&logoColor=white)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**LocatorLens** is a browser extension for end-to-end test authoring: inspect any element to get **ranked, uniqueness-checked locators**, validate selectors, and **record a flow into a runnable test** — all from the side panel. Output targets **Playwright, Selenium, or Cypress** in **TypeScript, JavaScript, or Python** (Cypress is JS/TS only).

Extension version is defined in `manifest.json` (currently **1.1.6**).

---

## Key features

### Frameworks & languages
- Pick a **framework** (Playwright · Selenium · Cypress) and **language** (TypeScript · JavaScript · Python) from the side-panel bar — inspector cards and recorder output update instantly. Cypress is JS/TS only (Python is shown but disabled).
- Translation lives in `codegen.js`, a pure module shared by the inspector, the recorder, and the right-click “Copy Best Locator”.

### Inspector and ranked locators
- Semantic-first ranking (`getByTestId`, `getByRole`, `getByLabel`, …) via `content-locator-engine.js`.
- **Live uniqueness:** every card shows whether the locator matches **exactly one** element (✓ unique) or **several** (⚠ N matches), checked against the real page.
- Stability hints, accessibility notes, and a “why this locator” explanation per card.

### Shadow DOM–aware picking
- Coordinate-based deep hit testing so targets inside **open shadow roots** can be inspected and described.

### DOM traversal while inspecting
- **Arrow Up / Down** to move between parent and child elements; **Escape** to stop.

### Selector lab
- Type a CSS selector or XPath in the side panel to **highlight matches** on the active page (with counts and errors surfaced in the UI).

### Recorder (side panel)
- Captures clicks, typing (debounced fills), selects, key presses, **hovers** (Alt+click), and **assertions** (visible / has-text / has-value / enabled / checked).
- **Pause/resume**, **undo/redo**, a **filterable, collapsible timeline**, and recording that **survives full-page navigation**.
- Produces an editable, **syntax-highlighted** test script in your chosen framework + language; copy or download.

### Clean, theme-aware UI
- Warm, minimal side panel and popup with automatic **light/dark mode** (follows your OS preference).

---

## Quick start

### Windows
From the project root: `setup.bat chrome` or `setup.bat firefox`.

### macOS / Linux
`./setup.sh chrome` or `./setup.sh firefox`.

### Chrome, Edge, or Brave
1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. **Load unpacked** and choose the **project root** (or your `dist-chrome` folder if you use the dual-dist layout—see `build_process.md`).

### Firefox
1. Open `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** and select **`manifest.json`** in the project root.

---

## Project layout

```text
├── src/
│   ├── background.js           # Extension service worker / messaging
│   ├── codegen.js              # Framework/language code generation (pure module)
│   ├── content-locator-engine.js  # Locator ranking + live uniqueness (injected first)
│   ├── content.js              # Overlay, inspect, recorder, selector lab
│   ├── sidepanel.js / .html    # Main UI: inspect + record
│   ├── popup.js / .html        # Compact launcher
├── manifests/                  # Browser-specific manifest variants
├── graphify-out/               # Optional architecture graph (see GRAPH_REPORT.md)
├── icons/
└── manifest.json               # Primary manifest (see setup scripts for dist copies)
```

---

## Engineering notes

- **Semantic-first**: prefer roles, labels, and test ids over long CSS chains or positional selectors when the DOM exposes them.
- **Privacy**: no LocatorLens-operated cloud; see `PRIVACY_POLICY.md`.

**Repository:** [github.com/yogesh-bhatttk/Locator_Lens](https://github.com/yogesh-bhatttk/Locator_Lens)
