# Changelog

All notable changes to Locatra (formerly LocatorLens). Versions follow [semantic versioning](https://semver.org).

## [1.5.0] — 2026-10-10

### Added

- **Replay in the browser.** "▶ Replay" in the Record tab runs the recorded flow on
  the page, step by step, using the same locator semantics the exported test will use.
  - Each step shows pending, running, passed, failed or skipped.
  - The failing step is highlighted with the reason: no match, several matches, hidden
    or disabled, or expected vs actual for assertions.
  - Replay waits for page loads between steps, works inside iframes, and can stop at
    the first failure or run in slow motion.
  - Values for sensitive steps are asked for at replay time and never stored.
  - Replayed actions are never recorded.
  - File uploads can't be replayed in the browser and show as skipped.
- **Page Object export.** Pick a region (or scan the whole page) to get a page class
  with a named, unique locator for every field, button and link.
  - Helpers: `fill…`, `select…`, `check…`, `click…`.
  - Available for Playwright, Selenium and Cypress, in TypeScript, JavaScript and Python.
  - Names are editable and validated, and the class can be copied or downloaded.
- **Suggested assertions.** While recording, the extension suggests:
  - `toHaveURL` after a navigation (including single-page-app URL changes);
  - `toContainText` / `toBeVisible` for the success or error message that appears
    after a submit.

  Suggestions are left out of the script until you accept them (one by one or "Accept
  all"). They can be switched off in Settings.

- **Step screenshots.** Each recorded step gets a thumbnail, with the target element
  outlined, and a larger preview.
  - Screenshots are stored only in the browser (IndexedDB) and pruned after 14 days.
  - They can be switched off in Settings.
  - Capturing every page needs the optional `<all_urls>` permission, requested only
    when you enable the feature. Without it, thumbnails still appear on tabs where
    Locatra was opened from the toolbar.
- `toHaveURL` and `toHaveValue` assertions in every framework.
- **Java, C# and WebdriverIO export.** Every recording, locator and Page Object now
  exports to:
  - Playwright for Java and Selenium for Java (JUnit 5);
  - Playwright for .NET and Selenium for C# (NUnit);
  - WebdriverIO v9 (TypeScript and JavaScript, Mocha).

  They support the same steps, frames, shadow DOM, secrets and assertions as the
  other frameworks.

- **Test-data variables.** Values you type while recording become named variables in
  one `testData` declaration, so a recording is reusable instead of hard-coded.
  - The Record tab's **Test data** section lets you rename variables and edit their
    values; replay uses the edited values.
  - Copy or download them as `test-data.json`.
  - A setting turns variables off for inline values.
- **Settings page.** A full options page:
  - custom test-id attributes (such as `data-qa`), in priority order;
  - default framework and language;
  - secret variable names, and the recorder toggles;
  - keyboard shortcuts;
  - export/import/reset of settings, and clearing stored data.

  Custom test-id attributes set the old way, by hand, are moved over automatically.

- **Keyboard shortcuts:** Alt+Shift+E starts or stops inspecting, and Alt+Shift+K
  starts or stops recording. Both can be changed in the browser. A restricted page
  shows a "!" on the toolbar icon with the reason.
- **Locator health check.** ☆ Watch a locator (or "Watch all" from a Page Object
  scan). The new **Health** tab re-checks watched locators on the page and marks each
  ok, broken, ambiguous or "frame missing". For a broken one it suggests a
  replacement found from the element's saved description; "Use suggested locator"
  applies it. Watched locators are kept per page and can be exported and imported, and
  can be re-checked automatically when you open a watched page.
- **Microsoft Edge package** (`npm run build:edge`), byte-identical to the Chrome
  one, with listing text for Edge Add-ons.

### Fixed

- Exported Cypress specs read secrets with `cy.env()` on Cypress 16, which removed
  `Cypress.env()`, and fall back to `Cypress.env()` on older versions.
- `getByLabel` matches are returned in document order, as Playwright returns them.
- Selenium Page Objects: an element inside a frame that was located through a parent
  element generated `By.css('body')`. The chained lookup is now generated inside the
  frame.
- Changing a setting in the side panel no longer erases settings made elsewhere.
- An edit made just before the side panel closed (a dismissed suggestion, a removed
  step) is no longer lost.
- Steps recorded with the side panel closed are no longer lost when a second
  recording starts before the panel is opened.
- No step screenshot is taken of a password, one-time-code or card step, or of any
  step taken while such a value shows in a field.
- A long replay step (a slow page load, a redirect chain) no longer trips the panel's
  30-second "Replay interrupted" watchdog: the worker reports that the step is still
  running every 5 seconds.
- When site access is set to "on click", side-panel actions say to allow site access
  instead of claiming the page is off-limits.
- A saved timeline that outgrows the 500-step cap keeps its opening `goto`, and the
  panel says that older steps were dropped.
- "Clear timelines" on the Settings page also deletes those steps' screenshots.
- Imported watched locators: the file's code text is replaced with code generated
  from its target, and numeric target fields (`level`, frame indexes) must be plain
  integers, so a shared file cannot inject code into an exported test.

- Selenium and WebdriverIO exports find text, names and labels that contain a
  non-breaking space, soft hyphen or zero-width space, as the extension does.
- Text assertions compare the rendered text the recorder captured: Playwright
  exports pass `useInnerText`, and Cypress checks `innerText`. Markup like
  `<h3>Title</h3><p>Body</p>` no longer fails the exported test.
- Selenium-family XPath matches an `aria-labelledby` that lists several ids.
- Selenium, Cypress and WebdriverIO role selectors agree with the extension's role
  table: `select[size]` is a listbox, a `<th>` beside data cells is a row header,
  `time`/`sub`/`sup`/`math` have their roles, and `role="a b"` is matched by token.
  A parity test checks every row of the Playwright-verified role table.
- Clicking an icon inside a button or link records the button or link, not the
  SVG `<path>`.
- A page element whose id starts with `ll-` or `locatra-` is no longer hidden from
  locators, replay, the health check and Page Object scans; the extension tells its
  own UI apart by reference.
- `selectOption` records the option's label, whitespace-normalised, and a
  multi-select records every selected option (exported in each framework's array
  form, and replayed in full).
- Elements inside open shadow roots export for Selenium (`getShadowRoot()` chains),
  Cypress (`.shadow()` chains) and WebdriverIO (`shadow$`).
- Frame indexes: Playwright, Cypress and WebdriverIO count `<iframe>` elements, and
  Selenium uses the `window.frames` position, each as its framework does.
- Clicking a checkbox's label records only the check, not an extra text click.
- Selector Lab counts matches with the same engine as the locators it shows
  (`getByLabel` on any labelled control, `level`, `frameLocator`, `nth`, `filter`).
- A replayed step whose frame cannot be verified is not claimed by a same-index
  frame.
- Copy fallback: a page's own `copy` handler can no longer replace the copied text.
- A failure to generate locators is reported, never replaced by a silent,
  non-unique `page.locator('<tag>')`.

- Frames behind a cross-origin parent are addressed exactly: the frame's content
  script asks the parent's (through the worker) for its position among the
  parent's `<iframe>` elements, so an `<object>`, a late-inserted ad iframe or a
  shadow-hosted iframe before it no longer shifts the exported index.
- Selenium, WebdriverIO and Cypress enter such a frame by element (the same
  shadow-piercing `<iframe>` count Playwright uses), not by a bare frame number,
  which ChromeDriver and geckodriver count differently.
- Selenium role locators follow the browser's role rules exactly (`role="none"` on
  a focusable element, unknown role tokens, `list=` pointing at a `<datalist>`,
  headers inside sectioning elements, lone `<th>`s); Cypress checks the role with a
  small helper ported from the extension's engine.
- Re-injecting the content script (a new iframe while inspecting, a health check)
  no longer makes Locatra's own overlay buttons and toast count as page elements.
- URL redaction keeps ordinary parameters (`?key=shoes`, `?code=SUMMER`); generic
  names like `code`, `token` and `key` are redacted only when the value looks like a
  credential.
- A click on a checkbox's label is still recorded when the page handles it in
  script (no `change` event); clicks on an `<option>` are not recorded (the
  selection is).
- A replayed step from an older recording without a secret name gets the
  `LOCATRA_PASSWORD` value the panel asked for.
- Headings with `aria-level` above 6 keep their level in exports and imports.

### Security

- A failing Playwright value check on a password field no longer prints the
  password: every framework reports only the environment variable's name.
- No step screenshot is taken while a password, one-time-code or card value is
  filled in anywhere on the page, payment iframes included, and a capture already
  queued is cancelled when such a value appears.
- A password, one-time-code or card field's value is no longer copied into a
  "has value" assertion; the test reads it from the environment like a sensitive
  fill.
- Exported code: numeric target fields (`level`, frame indexes, viewport size) are
  emitted only as validated integers, closing a code-injection path from imported
  files.
- More credential parameters are redacted from recorded URLs: OAuth `code`, `token`,
  `auth`, signatures (including pre-signed S3 URLs), `key`, `session`.
- Inspect mode ignores synthetic (untrusted) keyboard and mouse events, so a page
  cannot stop inspection or steer the pick.
- A sensitive value typed for a replay is no longer sent to every frame of the tab.
  The frame that owns the step asks for it, and only the first request for that step
  gets an answer.
- Messages that only the side panel may send (buffer acknowledgement, heartbeat,
  open/close panel) are ignored when they come from a web page's content script.
- The build fails on a manifest that loosens the extension pages' Content Security
  Policy or declares `externally_connectable`.
- The retired `RECORDED_ACTION_SUPERSEDE` message is gone; a double-click's
  supersession travels inside its step.

### Accessibility

- New recorded steps are announced on their own, instead of the whole timeline
  being read again on every step.
- The Selector Lab input and its icon buttons have labels, and its status line is a
  live region.

### Tests

- `npm run smoke:firefox` installs the Firefox package in a real Firefox (Selenium +
  geckodriver) and records, exports, replays and health-checks through it; CI runs
  it.
- `npm run smoke:frames` records real clicks behind cross-origin parents (two levels
  deep and shadow-hosted) and checks every recorded index against Playwright's own
  count.
- The export run covers a multi-select, a field inside a shadow root, a sensitive
  value check and a frame addressed only by position, in every framework, and fails
  if the recorded flow lacks any of them.
- Dev dependencies upgraded (vitest 4.1.11, lint-staged 17): `npm audit` reports no
  vulnerabilities.
- Every exported script runs for real in CI, against a demo checkout:
  - Playwright TypeScript/JavaScript/Python/Java/C#, Selenium
    TypeScript/JavaScript/Python/Java/C#, Cypress TypeScript/JavaScript and
    WebdriverIO TypeScript/JavaScript (14 combinations);
  - with test-data variables and with inline values;
  - for a hand-written flow and for one recorded through the extension.

  A run passes only if the order it places matches the expected one, including the
  secret read from the environment and the card number typed inside the iframe.

- Coverage of classic scripts is now measured accurately. A custom provider stops V8
  offsets from being mapped onto Vite-transformed code.
  - Coverage is about 96% statements and 90% branches across all source files.
  - Each file has its own threshold.

## [1.4.0] — 2026-10-09

A full audit of every feature and file. Renames the extension to **Locatra** and fixes
everything the audit found. Locator uniqueness now matches what Playwright actually
does, the recorder no longer captures secrets, and the Selenium and Cypress exports
now find labelled form fields.

### Security & privacy

- **Passwords, one-time codes and card fields are never recorded.** The step stores no
  value. The generated fill reads `LOCATRA_PASSWORD` / `LOCATRA_SECRET` from the
  environment (`process.env`, `os.environ`, `Cypress.env`, with `log: false`).
  Previously the real password was shown in the timeline, written into the script and
  kept in `chrome.storage.local`.
- Secret URL parameters (`password`, `access_token`, `api_key`, …) are redacted in
  recorded URLs.
- The side panel's HTML sanitizer is now an allowlist.

### Fixed — locators

- The CSS fallback no longer returns an ancestor's `#id` instead of the element.
- Uniqueness is counted with Playwright's own matching rules: case-insensitive
  substring, whitespace-normalized, and hidden elements excluded for `getByRole`. When
  only the exact text is unique, the locator says `exact: true`. "Save" next to
  "Save draft" is no longer reported as unique.
- Unique locators always rank above ambiguous ones, so the recorder never picks an
  ambiguous locator when a unique one exists.
- Implicit roles and accessible names follow Playwright: `aria-labelledby` before
  `aria-label`, `select[multiple]` is a listbox, `alt=""` images are presentation,
  unnamed `<section>`s are not regions, and more.
- `getByText` matches the smallest element containing the text, as Playwright does.
  Text over 60 characters no longer produces a locator that matches nothing.
- `getByLabel` covers `aria-labelledby` and labelled ARIA widgets.
- There is no longer a 4,000-element scan limit, and open shadow roots are counted
  everywhere.
- Generated-class and generated-id detection: Bootstrap classes such as
  `btn-primary` are no longer flagged. CSS-modules, styled-components and emotion
  hashes, React `useId` ids, Radix, MUI and Angular Material ids and UUIDs are now
  caught.

### Fixed — recorder

- Recording on a page with iframes (ads, reCAPTCHA, chat widgets) no longer adds
  `page.goto(<iframe url>)` steps.
- A fill is always recorded before the Enter or click that commits it, and only once.
- Typing, checkboxes and selects inside shadow DOM components are recorded.
- Capture resumes immediately after navigation, including inside iframes and iframes
  added later. Tabs opened from the recorded tab join the recording.
- Stop, Pause, Resume and assert mode act on the tab being recorded, not whichever
  tab is active. Assert mode survives navigation.
- Steps recorded while the side panel is closed are kept and delivered when it
  reopens.
- Recording inspects without clicking the page. Assert mode and Alt+Click no longer
  trigger the page's own action.
- File uploads record `setInputFiles`. Range, color and date inputs record their
  value. Double-click records one step. Keyboard combos such as Shift+Tab are recorded
  correctly, and IME composition no longer records a stray Enter.
- Long-text assertions no longer fail, because they use `toContainText`.
- A tab whose content script was orphaned by an extension update recovers without a
  page reload.
- Iframes added inside open shadow DOM, such as payment or chat widgets built as web
  components, now get the content script. Their frame selectors are checked for
  uniqueness across all shadow roots.

### Fixed — Selenium & Cypress export

- Role, label and text locators now match form controls by their accessible name:
  `<label for>`, a wrapping `<label>`, `aria-label`, `aria-labelledby`. Previously they
  matched nothing.
- The Selenium text XPath no longer resolves to `<html>`.
- Cypress: Tab uses `cy.press`. Typed values containing `{…}` are typed literally.
  ARIA checkboxes can be checked. Cross-origin steps are wrapped in `cy.origin`.
- Selenium: check and uncheck are idempotent, and the viewport step sets the viewport
  size rather than the window size.
- Every control character is escaped in every language. A NUL byte no longer breaks
  Python output.
- Cypress key combos, such as Shift+Tab, use `cy.realPress` from
  [cypress-real-events](https://github.com/dmtrKovalenko/cypress-real-events). Unlike
  `cy.type` modifiers, it makes the browser do the real thing, such as moving focus
  backwards.
  - The import is added only when a spec needs it.
  - Specs that use it run in Chromium-based browsers only.
  - Inside `cy.origin()` blocks it also needs `experimentalOriginDependencies: true`.
- Frames inside shadow DOM: Selenium steps through `getShadowRoot()` / `shadow_root`,
  and Cypress through `.shadow()`, to reach the frame.
- Custom test-attribute names containing CSS-special characters (`data:qa`) are
  escaped.

### Fixed — UI

- "Open Results Panel" in the popup now actually opens the panel. It is opened
  directly from the click, which browsers require. Firefox can also close it.
- Locatra reports when it can't run on a page (browser pages, the Web Store, PDFs)
  instead of showing "Recording" while capturing nothing.
- Side panels in different windows no longer receive each other's steps or picks.
- Switching framework after editing the script asks before discarding the edits.
- Reset no longer comes back after a framework switch.
- The panel works in narrow Firefox sidebars.
- The Copy button no longer gets stuck on "✓ Copied".
- The Stress Test no longer shows two contradictory results.
- Accessibility fixes: labelled step buttons, `aria-expanded` on toggles, and focus
  kept after removing a step.

### Tooling

- CI was red on formatting. The pre-commit hook now runs Prettier as well as ESLint.
- ESLint 9 with a flat config.
- Coverage is measured for every source file, with ratcheted thresholds. Locator
  engine coverage went from 70% to 99% statements, and the expected values in its
  tests are checked against real Playwright.
- The store-policy build check is stricter and its own tests now include fixtures
  that must fail.
- Firefox packages are validated with `web-ext lint`.
- The smoke test now proves in a real browser that passwords are never stored and
  that Selenium locators resolve.
- Store promo art and docs use the Locatra name. The privacy policy describes exactly
  what is stored.

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
