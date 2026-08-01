# Changelog

All notable changes to LocatorLens. Versions follow [semantic versioning](https://semver.org).

## [1.2.0] — 2026-08-02

Store-readiness release. Fixes the packaging flaw behind the Chrome Web Store
rejection, plus a set of correctness and performance defects found while auditing
the extension for submission.

### Chrome Web Store rejection

Violation **"Purple Potassium"** — the submitted package requested the `tabs`
permission, which nothing in the item needs.

No manifest committed to this repository has ever declared `tabs`; the rejected
upload was built by hand from a stale, untracked `dist-chrome/` directory whose
manifest matched no source in git. The root cause was therefore the release
process, not the source, and the fix is a build script that packages tracked files
and verifies the result:

- the build now fails if a declared permission is not backed by an API the code
  actually calls, if `tabs` appears at all, or if a permission has no evidence rule
  (unknown permissions fail closed)
- `tests/package.test.mjs` additionally asserts the code never reads `url`,
  `title` or `favIconUrl` off a tab — the only properties `tabs` would unlock

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
- **Checkboxes and radios were recorded twice.** Both the pointer handler and the
  change handler emitted a step, so every tick produced a duplicate line. The
  pointer copy was also always `.check()` — it ran before the control toggled, so
  *unchecking* a box generated `.check()` too. Only the change handler records
  these now, and it sees the settled state.
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
- `npm run screenshots` — captures listing images from the built extension driven
  against a demo page, replacing a set that could not legitimately be submitted:
  seven images showed a different product (AI / Fix Test / Diagnostics tabs this
  extension does not have) and the rest were rendered mock-ups with garbled
  placeholder text.
- 156 tests (Vitest) covering the code generator, locator engine, the content
  scripts driven end to end through their message API, render sanitisation, and
  the contents of the built packages.
- ESLint, Prettier, a pre-commit hook and GitHub Actions CI.
- `STORE_SUBMISSION.md` with permission justifications and per-store checklists.
- `LICENSE` (MIT — the README already declared it).

## [1.1.6] and earlier

See the git history. Highlights: multi-framework codegen (Playwright / Selenium /
Cypress across TypeScript / JavaScript / Python), the upgraded recorder with
pause/resume, undo/redo and navigation survival, live locator uniqueness badges,
Playwright-locator support in the Selector Lab, and Shadow DOM–aware picking.
