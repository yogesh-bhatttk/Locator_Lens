# LocatorLens — Playwright locator HUD

[![Chrome](https://img.shields.io/badge/Chrome-Ready-green?logo=google-chrome&logoColor=white)]()
[![Firefox](https://img.shields.io/badge/Firefox-Ready-orange?logo=firefox-browser&logoColor=white)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**LocatorLens** is a browser extension for **Playwright**-oriented test automation: inspect any element, get **ranked locators** with short explanations, validate selectors, record flows, and build **page objects** and **test scaffolds** from the side panel.

Extension version is defined in `manifest.json` (currently **1.1.6**).

---

## Key features

### Inspector and ranked locators
- Semantic-first ranking (`getByTestId`, `getByRole`, `getByLabel`, etc.) via `content-locator-engine.js`.
- Side panel shows stability hints, accessibility notes where available, and “why this locator” copy.
- **Playwright-only** output: no Selenium or Cypress code paths in the product UI.

### Shadow DOM–aware picking
- Coordinate-based deep hit testing so targets inside **open shadow roots** can be inspected and described.

### DOM traversal while inspecting
- **Arrow Up / Down** to move between parent and child elements; **Escape** to stop.

### Selector lab
- Type a CSS selector or XPath in the side panel to **highlight matches** on the active page (with counts and errors surfaced in the UI).

### Recorder (side panel)
- Capture clicks, typing (debounced fills), and some keys; sync an editable **Playwright test** draft and copy/download.

### POM builder
- Add locators from cards into a **saved list**, rename inline, drag to reorder, optional **health** checks against the live page.
- Export **TypeScript or JavaScript** page objects with optional **action methods** and **JSDoc**.
- **Generate test** downloads a `.spec.ts` scaffold that imports from `./PageObject` (same pattern as the combined POM file you download).

### Lumina-style UI
- Dark “HUD” styling in the side panel and popup (cosmetic only; behavior is the same on all themes).

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
│   ├── content-locator-engine.js  # Locator ranking (injected first)
│   ├── content.js              # Overlay, inspect, recorder, selector lab
│   ├── sidepanel.js / .html    # Main UI: inspect, record, POM, settings
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
