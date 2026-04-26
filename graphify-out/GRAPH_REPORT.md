# Graph report — LocatorLens architecture (2026-04-27)

This report summarizes the **optional** `graphify-out/` knowledge graph (nodes, edges, communities). It is maintained to align with the **current** codebase: **Playwright-only** locator UI, **POM** builder, **recorder**, and **selector lab**.

> **Note:** Counts and communities below reflect the last graph generation. After large refactors, re-run your Graphify (or equivalent) pipeline and replace `graph.json` / `graph.html` so metrics stay accurate.

## Corpus

- Mixed corpus: `README.md`, `build_process.md`, `src/*.js`, and related paths (see graph metadata in `graph.json`).
- Verdict: graph view is useful for onboarding and spotting cross-cutting functions (e.g. `generateLocators`, `renderResults`).

## Summary (from last generation)

- Order of **50+** nodes and **70+** edges (exact numbers in `graph.json`).
- Communities cluster **locator generation**, **side panel UI**, **injection/overlay**, **background relay**, **POM/recorder**, etc.

## Community hubs (navigation)

- **Locator generation logic** — `generateLocators()`, roles, names, stability helpers in `content-locator-engine.js`.
- **Side panel UI** — `renderResults()`, tabs, POM list, recorder timeline, `formatForPlaywright()`.
- **Inspection overlay & injection** — `startInspect`, `createOverlay`, styles in `content.js`.
- **DOM tree navigation** — `navigateParent` / `navigateChild`, overlay updates.
- **Extension popup** — quick open / toggle wiring.
- **Results rendering helpers** — `safeRender`, `esc`, `hl`.
- **Playwright & POM layer** — ranked locator display, `generatePOMCode`, `generateTestScaffold`, `inferActions`, storage-backed POM list (replaces older “multi-framework translator” naming in legacy graphs).
- **Background messaging relay** — `background.js` message routing.
- **Interaction handling** — click / hover pick pipeline in `content.js`.
- **Decommissioning** — `stopInspect`, `removeOverlay`, listener cleanup.
- **Selector lab** — validate selector on page from side panel.
- **Shadow DOM** — detection and user-facing hints in engine + UI.

## Core abstractions (high connectivity)

Typical high-degree symbols include:

- `generateLocators()` — central bridge between engine and UI.
- `getDeepElementAt()` / `onClick()` / `onMouseOver()` — pick pipeline.
- `updateOverlay()` — hover feedback.
- `getRole()` / `getAccessibleName()` — semantic locator inputs.
- `stopInspect()` / `renderResults()` — lifecycle and results surface.

## Surprising connections (inferred edges in older graphs)

Earlier graph runs inferred a **“Universal Framework Matrix”** linking to **Selenium** / **Cypress** translators. **That is obsolete:** the product is **Playwright-only**. Updated `graph.json` labels remap those conceptual nodes to **POM / scaffold / Playwright display** language; regenerate the graph after major edits for a fully consistent graph extract.

## Knowledge gaps (typical)

- Small **2-node** communities (clipboard helpers, decommissioning) are normal for utilities.
- **Document-only** nodes (e.g. “Lumina HUD” concept) may have few code edges until docs and code share explicit anchors—re-run extraction after doc updates.

## Suggested questions the graph can answer

- What calls **`generateLocators()`** from the page context vs side panel?
- How does **`chrome.runtime.sendMessage`** connect `content.js` to `background.js` and the side panel?
- Where is **selector lab** validation implemented end-to-end?

## Regenerating

1. Update `README.md` and `build_process.md` (source of truth for product description).
2. Run your graph pipeline from repo root so **`graph.json`** and **`graph.html`** refresh.
3. Open **`graphify-out/graph.html`** in a browser (requires network for CDN `vis-network`, or vendor the script locally for offline use).
