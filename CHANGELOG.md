# Changelog

All notable changes to LocatorLens. Versions follow [semantic versioning](https://semver.org).

## [1.3.0] — 2026-08-02

Adds iframe support, and clears the remaining known gaps from the 1.2.1 audit.

### Added

- **Locators for elements inside iframes.** Previously an iframe was a dead end: the
  picker highlighted the whole frame box and described the `<iframe>` element itself,
  and nothing inside it could be inspected or recorded — which rules out most real
  checkouts, since payment fields are almost always framed. Elements inside frames
  are now first-class, and the generated code enters the frame before acting:
  `page.frameLocator(…)` for Playwright, a `switchTo().frame(…)` /
  `switch_to.default_content()` pair wrapped around the action for Selenium (which
  has no frame-scoped locator — switching is a statement), and `contentDocument`
  traversal for Cypress. Nested frames compose, and a chained locator inside a frame
  renders correctly through both wrappers.
  - The content script is still declared for the top frame only. It is injected into
    sub-frames when Inspect or Record is switched on, so ordinary browsing does not
    pay for parsing it inside every ad and tracking iframe.
  - A cross-origin frame's `<iframe>` element is unreadable from inside the frame, so
    those are addressed by position and the panel flags the locator as approximate.
  - Messages that carry a reply are now aimed at a single frame: the context-menu copy
    goes to the frame that was right-clicked, and the Stress Test to the frame that
    made the pick. Broadcasting them would have every frame race to answer.

### Fixed

- **Start Inspecting did nothing when the side panel was not already open.** The
  worker opens the panel, and the panel's startup "force reset" then told the worker
  to stop inspecting — cancelling the click that had opened it. Found by the new
  browser smoke test; the panel now asks for the live state instead of imposing one.
- **A second browser window silently muted the first window's panel.** The worker
  held a single side-panel port, so connecting a second panel replaced the first,
  which then kept its port and never received another update. Every connected panel
  now receives relays.
- **Copying a locator on a non-HTTPS page.** `navigator.clipboard` does not exist in
  a non-secure context, so 1.2.0 threw and 1.2.1 reported the failure honestly
  without being able to act on it. There is now an `execCommand` fallback, which
  covers every copy that happens inside a user gesture — the picker's click-to-copy
  and the panel's own Copy buttons. The right-click "Copy Best Locator" on a
  non-HTTPS page still cannot copy, because a context-menu click delivers no gesture
  to the page and bypassing that requires the `clipboardWrite` permission.
  Deliberately not requested: this item was once rejected for carrying a permission
  nothing needed, and a convenience on non-HTTPS pages does not justify widening the
  permission set. That path reports "Copy blocked" and shows the locator to read off
  the screen.
- Every pick rendered the panel twice — the content script broadcast reaches the
  panel directly and the worker also relayed it over the port. Picks carry an id and
  the panel renders the first copy only.
- `seenActionKeys` grew without bound in memory during a long recording session; it
  was only trimmed when persisted.

### Store submission

- **Host access narrowed from `<all_urls>` to `http://*/*` + `https://*/*`**, in both
  the grant and the content-script matches. `<all_urls>` also covers `file://`,
  `ftp://` and every other scheme; this extension analyses web pages and has no use
  for them. "The narrowest permission that works" is the rule a reviewer applies, and
  the previous rejection was in that category.
- The declared permission set is now pinned by test, per browser, so it cannot grow
  by accident — the existing "every permission is justified" check could only inspect
  what was declared and had no opinion on the set growing.
- The Chrome Web Store dashboard text is verified against the manifest. The listing's
  short description must be byte-identical to `manifest.description`, the
  justification table must name exactly the permissions the manifests declare, and the
  host-access row must state the grant actually requested. A listing that describes
  something the manifest does not is a review finding, and the two drift the moment
  they are maintained apart.
- `STORE_SUBMISSION.md` now carries the single-purpose statement and every data-use
  disclosure answer, so the dashboard is filled in from a reviewed source rather than
  from memory.

### Changed

- CI actions moved to `@v5`, off the deprecated Node 20 runtime.
- `npm run test:coverage` is meaningful and enforced. It previously reported 23% and
  a flat 0% for `background.js`, `content.js`, `sidepanel.js` and `popup.js` — the
  most heavily tested files in the repo — because their suites run the real shipping
  file through `node:vm`, which v8 coverage cannot instrument. Coverage is now scoped
  to the two files it can genuinely measure, with thresholds: 90.6% statements, 98%
  functions, 92% lines.
- The browser smoke test runs in CI under xvfb, as its own job.

### Testing

- `tests/popup.dom.test.mjs` is new — `popup.js` was the last source file with no
  coverage at all.
- The demo page now embeds a real cross-document payment iframe (not `srcdoc`, which
  Chrome will not inject content scripts into), and the smoke test picks a field
  inside it and hands the generated `frameLocator` chain back to Playwright to
  resolve.
- 271 unit tests (was 204) and 34 smoke checks (was 27).

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

The finding is correct and applies to v1.1.3, whose manifests declared `tabs`
(commit `9706b85`) although no code path read a property it unlocks. The
permission was removed in v1.1.4 (commit `8d6792c`). What was missing was
anything to stop it coming back, so the release process now enforces it:

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
