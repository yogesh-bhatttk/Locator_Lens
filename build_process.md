# LocatorLens — build process and architecture

This document describes how the extension is structured and how distribution folders relate to `src/`. Feature descriptions match the **Playwright-only** implementation (side panel badge, POM TS/JS, recorder, selector lab).

---

## 1. Lumina-style HUD (side panel / popup)

- Dark theme, monospace accents, and motion used for scanlines and status—not a separate runtime.
- Side panel is the primary surface: **Inspect**, **Record**, **POM**, **Settings** tabs.

---

## 2. Playwright locator pipeline

- **`content-locator-engine.js`** (injected before `content.js`) ranks candidate locators and attaches explanations.
- **`content.js`** handles overlay, pick, keyboard traversal, stress test messaging, recorder hooks, and selector-lab validation messages to/from the page.
- **`sidepanel.js`** renders cards via **`formatForPlaywright()`** (pass-through of engine `code` / `fullCode`), copy buttons, POM add-from-card, and all POM/recorder logic.

There is **no** in-product translation to Selenium or Cypress.

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

## 6. POM and test scaffold

- Saved elements live in **`chrome.storage.local`** (`savedPOMElements`).
- **generatePOMCode** emits Playwright **TypeScript** (with `Locator` types) or **JavaScript** page objects; optional **inferActions** helpers use **`expect`** when action methods are enabled.
- **generateTestScaffold** emits a **`.spec.ts`** file that imports page classes from **`./PageObject`** (align your download filename with your repo layout).

---

## 7. Distribution and local dev

Some setups use a **dual-dist** layout (`dist-chrome/`, `dist-firefox/`) with junctions or copies of `src/` and manifest variants so each browser loads a clean MV3 manifest. Your **`setup.bat` / `setup.sh`** scripts define the exact flow for this repo.

If you load **unpack from repo root**, `manifest.json` is the source of truth for that workflow.

---

## 8. Optional architecture graph (`graphify-out/`)

- **`GRAPH_REPORT.md`** — human-readable summary of modules and communities (may lag code until you re-run your graph pipeline).
- **`graph.html` / `graph.json`** — interactive **vis-network** graph; opening `graph.html` pulls **vis-network** from a CDN (see privacy policy). Regenerate when large refactors land so labels match `src/`.
