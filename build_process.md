# LocatorLens — build process and architecture

This document describes how the extension is structured and how distribution folders relate to `src/`. The product inspects elements and records flows, generating code for **Playwright / Selenium / Cypress** in **TypeScript / JavaScript / Python** (Cypress is JS/TS only).

---

## 1. UI (side panel / popup)

- Warm, minimal theme with automatic **light/dark** mode (follows the OS preference); no decorative runtime/animations.
- Side panel is the primary surface with two tabs: **Inspect** and **Record**.

---

## 2. Locator pipeline + multi-framework codegen

- **`content-locator-engine.js`** (injected first) ranks candidate locators, attaches a structured `target` (kind + values) and live **uniqueness** (`matchCount` / `unique`) per candidate, plus explanations. Runs in the content script (it needs the live DOM).
- **`codegen.js`** is a pure module (loaded as a content script *and* in the side panel) that translates a `target` + action into **Playwright / Selenium / Cypress** code for **JS / TS / Python**. `LLCodegen.isValidCombo()` blocks the impossible combo (Cypress + Python).
- **`content.js`** handles overlay, pick, keyboard traversal, stress test, recorder hooks, selector-lab validation, and framework-aware quick-copy (context menu + click).
- **`sidepanel.js`** renders cards via **`formatLocator()`** (native Playwright JS/TS, else `codegen`), the uniqueness badges, and all recorder logic; the chosen framework/language is persisted in `chrome.storage.local`.

---

## 3. Shadow DOM–aware inspection

- Deep element resolution at pointer coordinates across **open** shadow roots where the browser exposes the tree.
- UI surfaces a **SHADOW** hint when the picked node lives inside a shadow root.

---

## 4. Precision navigation

- Arrow **Up** / **Down** adjust the current target along parent/child relationships while inspecting.
- **Escape** stops inspection and tears down listeners and overlay state.

---

## 5. Reliability and state

- **Background** relays messages between the content script, side panel, and popup where needed.
- **Side panel heartbeat** keeps lightweight awareness that the panel is open.
- **Stop inspecting** removes listeners and overlay to avoid “ghost” hover behavior.

---

## 6. Recorder and test-script export

- Recorded actions (with their structured `target`) live in **`chrome.storage.local`** (`llRecorderState`) and render in a **filterable, collapsible** timeline.
- Captures clicks, fills, selects, key presses, **hover** (Alt+click), and **assertions** (visible / has-text / has-value / enabled / checked); supports **pause/resume** and **undo/redo**, and **re-arms after full-page navigation** (background tracks recording tabs).
- **generateTestScript** runs each step through `codegen` and wraps it in the right scaffold for the chosen framework/language; the editable, syntax-highlighted editor's current text is what **Copy** / **Download** use.

---

## 7. Distribution and local dev

Some setups use a **dual-dist** layout (`dist-chrome/`, `dist-firefox/`) with junctions or copies of `src/` and manifest variants so each browser loads a clean MV3 manifest. Your **`setup.bat` / `setup.sh`** scripts define the exact flow for this repo.

If you load **unpack from repo root**, `manifest.json` is the source of truth for that workflow.

---

## 8. Optional architecture graph (`graphify-out/`)

- **`GRAPH_REPORT.md`** — human-readable summary of modules and communities (may lag code until you re-run your graph pipeline).
- **`graph.html` / `graph.json`** — interactive **vis-network** graph; opening `graph.html` pulls **vis-network** from a CDN (see privacy policy). Regenerate when large refactors land so labels match `src/`.
