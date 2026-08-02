# Changelog

All notable changes to LocatorLens. Versions follow [semantic versioning](https://semver.org).

## [1.2.1] — 2026-08-02

Correctness release. Six defects that produced wrong output or silently lost work,
found by auditing the paths the test suite did not reach — chiefly the service
worker, which had no coverage at all until this release.

### Fixed

- **Recording stopped partway through any multi-page flow.** MV3 evicts an idle
  service worker after roughly 30 seconds and every module-scope variable goes with
  it, including the set of tabs being recorded. Re-arming capture after a navigation
  reads that set, so once the worker had been evicted — which needs nothing more
  than half a minute spent reading the page — the navigation was ignored and every
  step after it was dropped without any indication. Worker state now lives in
  `chrome.storage.session`, which survives eviction and never touches disk.
  `GET_INSPECT_STATE` was wrong across the same boundary, so the popup and panel
  reported "not inspecting" for a page that still had the crosshair on it.
- **Chained locators generated code for the wrong element.** The "Chained/Filtered"
  card displayed `page.getByTestId('row-2').getByRole('button', …)` while its
  structured target held only the bare child selector. Everything that reads the
  target rather than the display string — the Selenium, Cypress and Python
  translations, and every recorded step whose best locator was this one — therefore
  dropped the parent scope and addressed the _first_ matching row on the page. The
  chain is now a first-class target that every framework renders with the scope
  intact, including the leading `.` that makes a Selenium child XPath relative.
- **Copying a locator did nothing on `http://` pages.** A content script inherits the
  page's security context, so `navigator.clipboard` is undefined on any non-secure
  site. The context-menu copy called it unguarded and threw out of the message
  listener; the inspect-click path guarded the call but then showed "✅ Copied"
  regardless, sending people off to paste an empty buffer. There is now a real
  `execCommand` fallback, and the toast reports a blocked copy as blocked.
- **`page.locator('')` for `<body>`.** The CSS fallback walks up _to_ `<body>`, so
  `<body>` itself yielded an empty selector — a runtime error in every framework.
  Reachable by right-clicking before anything had been tracked.
- **Labelled web components read as unnamed.** `aria-labelledby` and `label[for]`
  were resolved against `document`, but IDREFs are scoped to their root, so a
  control inside a shadow root could never find its own label.
- **A keystroke could leak into the next recording.** Typing is emitted on a 450 ms
  debounce whose timer was not cancelled on stop, so stopping and starting again
  inside that window opened the new recording with a fill nobody performed in it.

### Changed

- The side panel asks the worker whether recording is live when it opens, instead of
  showing "Start Recording" over a session that is still capturing.
- Content-script messaging is funnelled through one guarded helper, so reloading the
  extension can no longer throw into a visited site's console — and a pick that can
  no longer be delivered tears the overlay down rather than leaving a dead crosshair.
- A result payload missing an optional array renders instead of throwing and
  stranding the panel on a half-drawn card.

### Testing

- `tests/background.test.mjs` is new: the service worker had no coverage. Each case
  runs it in its own VM context, and an eviction is reproduced by starting a second
  context over the same `storage.session` store. Six of these fail against the
  previous release.
- The browser smoke test now records across a real navigation, driven through the
  service worker rather than straight into the content script.
- 204 unit tests (was 156) and 29 smoke checks (was 27).

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
  injected by _Start Inspecting_, so validating a selector marked the matches but
  showed nothing unless the user had already inspected on that page.
- **Context menus broke after every extension update.** `onInstalled` also fires on
  update and menu items persist, so re-creating them failed with a duplicate-id
  error and left the menu half-registered. Creation is now idempotent.
- **Copy corrupted code containing HTML entities.** The copy handler decoded
  entities a second time on a value the DOM had already decoded, so a locator
  containing `&amp;lt;` was copied as `<`.
- **Generated code broke on values containing quotes.** Attribute values were
  interpolated into CSS selectors unescaped, and Selenium XPath literals had every
  double quote _deleted_ — so a button labelled `Delete "row"` silently generated a
  locator that matched something else. XPath now uses `concat()` where required.
- **Element ids with CSS-special characters produced invalid selectors.** Ids such
  as `md:w-1/2` (Tailwind, Rails, Angular) are now escaped, in both the engine and
  the code generator.
- **Recording state could exceed the storage quota and vanish.** The timeline is
  now capped and the failing write is handled instead of being discarded silently.
- **Checkboxes and radios were recorded twice.** Both the pointer handler and the
  change handler emitted a step, so every tick produced a duplicate line. The
  pointer copy was also always `.check()` — it ran before the control toggled, so
  _unchecking_ a box generated `.check()` too. Only the change handler records
  these now, and it sees the settled state.
- Inspecting a document without a `<body>` no longer throws.

### Performance

- Bounded every full-DOM scan in the locator engine and switched uniqueness
  counting from `innerText` to `textContent`. Reading `innerText` forces a layout
  flush per node, and these scans run for every candidate locator on every element
  pick _and_ every recorded click — on a large page that was a visible freeze.
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
- `npm run smoke` — 27 end-to-end checks against the built extension in a real
  browser, covering what jsdom cannot: the pointer hit test, keyboard traversal,
  the content-script/worker/panel message path, and console hygiene. It also feeds
  the locators the extension generates back through Playwright to confirm each one
  resolves to exactly one element on the page.
- ESLint, Prettier, a pre-commit hook and GitHub Actions CI.
- `STORE_SUBMISSION.md` with permission justifications and per-store checklists.
- `LICENSE` (MIT — the README already declared it).

## [1.1.6] and earlier

See the git history. Highlights: multi-framework codegen (Playwright / Selenium /
Cypress across TypeScript / JavaScript / Python), the upgraded recorder with
pause/resume, undo/redo and navigation survival, live locator uniqueness badges,
Playwright-locator support in the Selector Lab, and Shadow DOM–aware picking.
