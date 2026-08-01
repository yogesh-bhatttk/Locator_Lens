# Changelog

All notable changes to LocatorLens. Versions follow [semantic versioning](https://semver.org).

## [1.2.0] — 2026-08-02

Store-readiness release. Fixes the packaging flaw behind the Chrome Web Store
rejection, plus a set of correctness and performance defects found while auditing
the extension for submission.

### Fixed

- **Selector Lab highlights were invisible.** The `.ll-lab-highlight` style was only
  injected by *Start Inspecting*, so validating a selector marked the matches but
  showed nothing unless the user had already inspected on that page.
- **Context menus broke after every extension update.** `onInstalled` also fires on
  update and menu items persist, so re-creating them failed with a duplicate-id
  error and left the menu half-registered. Creation is now idempotent.
- **Copy corrupted code containing HTML entities.** The copy handler decoded
  entities a second time on a value the DOM had already decoded, so a locator
  containing `&amp;lt;` was copied as `<`.
- **Generated code broke on values containing quotes.** Attribute values were
  interpolated into CSS selectors unescaped, and Selenium XPath literals had every
  double quote *deleted* — so a button labelled `Delete "row"` silently generated a
  locator that matched something else. XPath now uses `concat()` where required.
- **Element ids with CSS-special characters produced invalid selectors.** Ids such
  as `md:w-1/2` (Tailwind, Rails, Angular) are now escaped, in both the engine and
  the code generator.
- **Recording state could exceed the storage quota and vanish.** The timeline is
  now capped and the failing write is handled instead of being discarded silently.
- Inspecting a document without a `<body>` no longer throws.

### Performance

- Bounded every full-DOM scan in the locator engine and switched uniqueness
  counting from `innerText` to `textContent`. Reading `innerText` forces a layout
  flush per node, and these scans run for every candidate locator on every element
  pick *and* every recorded click — on a large page that was a visible freeze.
- The Selector Lab's `getByRole` / `getByText` resolution now applies its cheap
  predicates before the expensive `getComputedStyle` visibility check, and caps the
  match set so a loose substring cannot pin the tab.

### Security

- `safeRender` now actually sanitises. It previously parsed markup with `DOMParser`
  and adopted the nodes, which is equivalent to `innerHTML` for anything using an
  event-handler attribute — `onerror` and friends execute once adopted into the live
  document. Handler attributes, executable elements and `javascript:` URLs are now
  stripped.
- `esc()` escapes single quotes; syntax highlighting moved to a separate
  content-context escape so the two uses cannot be confused.

### Changed

- Diagnostic `console` output from the content script is off by default. Enable with
  `chrome.storage.local.set({ llDebug: true })`.
- Removed `graphify-out/`, a generated architecture report that loaded
  `vis-network` from `unpkg.com`. Because the previous release flow zipped the
  repository root, that remote `<script src>` was part of the submitted package —
  remote code, which both stores reject automatically.

### Added

- `scripts/build.mjs` — reproducible, allowlist-based packaging for Chrome and
  Firefox that fails the build on remote code, dynamic evaluation, network APIs,
  stray files, or a manifest referencing a file the package omits.
- `scripts/version.mjs` — keeps `package.json` and all three manifests in step.
- 124 tests (Vitest) covering the code generator, locator engine, render
  sanitisation and the contents of the built packages.
- ESLint, Prettier, a pre-commit hook and GitHub Actions CI.
- `STORE_SUBMISSION.md` with permission justifications and per-store checklists.
- `LICENSE` (MIT — the README already declared it).

## [1.1.6] and earlier

See the git history. Highlights: multi-framework codegen (Playwright / Selenium /
Cypress across TypeScript / JavaScript / Python), the upgraded recorder with
pause/resume, undo/redo and navigation survival, live locator uniqueness badges,
Playwright-locator support in the Selector Lab, and Shadow DOM–aware picking.
