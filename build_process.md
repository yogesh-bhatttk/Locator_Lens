# Locatra — build process and architecture

This document describes how the extension is structured and how distribution folders relate to `src/`. The product inspects elements and records flows, generating code for **Playwright / Selenium / Cypress** in **TypeScript / JavaScript / Python** (Cypress is JS/TS only).

---

## 1. UI (side panel / popup)

- Warm, minimal theme with automatic **light/dark** mode (follows the OS preference); no decorative runtime/animations.
- Side panel is the primary surface with two tabs: **Inspect** and **Record**.

---

## 2. Locator pipeline + multi-framework codegen

- **`content-locator-engine.js`** (injected first) ranks candidate locators, attaches a structured `target` (kind + values) and live **uniqueness** (`matchCount` / `unique`) per candidate, plus explanations. Runs in the content script (it needs the live DOM).
- **`codegen.js`** is a pure module (loaded as a content script, in the side panel and on the Settings page) that translates a `target` + action into **Playwright / Selenium / Cypress** code for **JS / TS / Python**. `LLCodegen.isValidCombo()` blocks the impossible combo (Cypress + Python).
- **Target modules** add more output through `LLCodegen.registerTarget()`, each in its own classic script loaded right after `codegen.js`:
  - `codegen-java.js`: Playwright for Java and Selenium for Java (JUnit 5).
  - `codegen-csharp.js`: Playwright for .NET and Selenium for C# (NUnit).
  - `codegen-wdio.js`: WebdriverIO v9 (TypeScript/JavaScript, Mocha).

  A module supplies `locatorExpr`, `actionStatement`, `wrapScript` and `pageObject` (and optionally `todo`) for its framework × language pairs, and uses the shared helpers on `LLCodegen._internals`, so a Selenium Java or C# locator is the same XPath/CSS that Selenium JS emits. Asking a module's framework for a language it doesn't support falls back to its own first language.

- **Test-data variables:** `extractVariables()` / `applyVariables()` / `variablesJson()` turn typed values into named variables. `testScript(steps, fw, lang, { variables: true })` declares them once per file (`testData` in JS/TS, `TEST_DATA` in Python and Java, `TestData` in C#) and references them from each fill or select. Sensitive values stay environment variables.
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
- **Secrets are never recorded:** a fill into a password / one-time-code / card field is stored with an empty value and `sensitive: true`, and codegen emits a read of `LOCATRA_PASSWORD` or `LOCATRA_SECRET` from the environment instead. Credential-like URL parameters are replaced with `REDACTED` before a URL is stored or emitted. File inputs record an **upload** step (file names only) that becomes `setInputFiles` / `send_keys` / `selectFile`.
- **generateTestScript** runs each step through `codegen` and wraps it in the right scaffold for the chosen framework/language; the editable, syntax-highlighted editor's current text is what **Copy** / **Download** use.

---

## 7. Distribution

`npm run build` (`scripts/build.mjs`) is the only supported way to produce a package.
It writes `dist/chrome/`, `dist/firefox/` and `dist/edge/` plus a versioned `.zip` for each
(the Edge package is byte-identical to Chrome's; `npm run build:edge` builds only it), and
prints a SHA-256 per archive, preceded by the Node and zlib versions used. Archives
are reproducible — sorted entries, a fixed timestamp, fixed Unix permissions — so the
same commit built with the same Node major (and so the same bundled zlib) yields the
same hash. Deflate output can differ between zlib releases, so hashes are only
comparable across machines on the same Node major; `.nvmrc` pins Node 22, as CI does.
`--out-dir <dir>` (or `LOCATRA_OUT_DIR`) writes somewhere other than `dist/`; the test
suite uses it so `npm test` never touches your real packages.

The shipping file set is an **allowlist** (the `SHIP` array in the script), not an
ignore list. Adding a file to a package has to be a deliberate edit. This replaced a
flow that swapped `manifest.json` at the repo root and zipped the whole directory —
which had no file selection at all, and so shipped a generated report page that
loaded a library from a CDN. Remote code is an automatic rejection on both stores.

The build refuses to emit a package containing remote code or resources (markup,
`import()`, `.src` assignments or CSS pointing at `http(s)://` or `//` URLs), dynamic
code (`eval`, `new Function`, `importScripts`, string `setTimeout`/`setInterval`), a
network API (`fetch`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`, `EventSource`), a
reference it cannot resolve (manifest keys, `<script src>`/`<link href>` in the pages,
`executeScript` files), or a permission or host pattern outside the reviewed policy.
Comments are stripped before any of this is scanned. The rules live in
`scripts/lib/policy.mjs`; `tests/package.test.mjs` unit-tests them with fixtures that
must fail and re-runs them against freshly built packages.

`setup.sh` / `setup.bat` are development helpers and never modify tracked files: for
Chrome they point you at the repository root (whose `manifest.json` is always the
Chrome manifest); for Firefox they build `dist/firefox/` and print the path to load.

Full submission process and permission justifications: **`STORE_SUBMISSION.md`**.

---

## 8. Versioning

`node scripts/version.mjs [patch|minor|major|x.y.z]` sets the version in
`package.json` and all three manifests at once; with no argument it verifies they
agree and exits non-zero if they do not. CI runs the check on every push, because
both stores reject an update that reuses a published version number.

---

## 9. Selector Lab — accepted syntaxes and live resolution

The Selector Lab (Inspector tab) highlights, on the active page, the element(s) a selector resolves to. It accepts **three** input kinds and picks the strategy automatically.

**Accepted input**

1. **CSS** — passed straight to `document.querySelectorAll`.
2. **XPath** — anything starting with `//` or `(` is run through `document.evaluate`.
3. **Playwright locator chains** — full lines as generated by the inspector/recorder, resolved live against the DOM.

**Playwright resolution (`resolvePlaywrightLocator` in `content.js`)**

- **Boilerplate is stripped** before parsing: a leading `await`, a `const/let/var x =` assignment, the `page.` / `this.page.` / `component.` handle, and any trailing **action** call (`.fill()`, `.click()`, `.check()`, `.press()`, `.selectOption()`, `.hover()`, …). So a verbatim generated line resolves as-is.
- The chain is split into `.method(args)` segments with a quote/paren-aware scanner (handles commas, nested objects, and escaped quotes inside arguments).
- **Locator methods** resolve via the shared `__LocatorLensEngine` (roles + accessible names) or attributes:
  | Method | Resolution |
  |---|---|
  | `getByRole(role, { name, exact })` | `engine.getRole` + `engine.getAccessibleName`; hidden/`aria-hidden`/`display:none` elements are excluded |
  | `getByLabel(text, { exact })` | accessible name of `input`/`select`/`textarea` |
  | `getByPlaceholder(text, { exact })` | `[placeholder]` |
  | `getByText(text, { exact })` | element text; keeps the **innermost** match (mirrors Playwright) |
  | `getByTestId(id)` | `[data-testid="id"]` (exact) |
  | `getByTitle` / `getByAltText` | `[title]` / `[alt]` |
  | `locator('css' \| '//xpath' \| 'css=' \| 'xpath=')` | CSS or XPath, scoped to the current match set |
- **Chained scoping** (`a.locator(b)`, `a.getByRole(...)`) searches within the descendants of the current matches.
- **Reducers** `.first()` / `.last()` / `.nth(n)` and `.filter({ hasText })` narrow the set.
- Name/text matching follows Playwright defaults: whitespace-normalised, **case-insensitive substring** unless `{ exact: true }`.

**Behaviour:** the first match is scrolled into view; the status line reports the count and the method that matched (`via getByRole()`); parse-but-no-match is reported distinctly from a hard selector error.

**Message path:** the side panel sends `LAB_VALIDATE` / `LAB_CLEAR` with `chrome.runtime.sendMessage`. Because runtime messages do **not** reach content scripts, **`background.js` relays them to the active tab** via `chrome.tabs.sendMessage` (injecting the content scripts first if they are not yet present). The content script highlights matches and posts `LAB_STATUS_UPDATE` / `LAB_ERROR` back to the side panel (which, being an extension page, receives them directly).

---

## 10. Stress Test — target selection and robustness

The **💥 Stress Test** button (next to the target metadata) checks whether the selected element stays **locatable without its `id`/`class`** — i.e. whether its semantic **role + accessible name** uniquely identify it among same-tag elements on the page.

- **Target priority:** the element the user **picked** (`lastPickedEl`, set on every inspect-click and **kept after inspection stops**), then the currently hovered element, then the last right-clicked element. Disconnected (stale) nodes are skipped via `isConnected`, so a target removed by a navigation/SPA re-render is never tested.
- **No silent `<body>` fallback:** if nothing valid is selected the content script returns a `noTarget` flag and the UI prompts the user to pick an element first (previously it silently tested `<body>` and always reported “No ❌”).
- **The button can’t hang:** `background.js` always relays a `STRESS_TEST_RESULT` (with an `unavailable` flag when the page can’t be reached — e.g. `chrome://`, the Web Store, PDFs), and the side panel runs a 5 s safety timeout that resets the button regardless.
- **Result detail:** the response carries `tag` / `role` / `name`, so the completion dialog names what was tested alongside the **Yes ✅ / No ❌** verdict.

---

## 11. Permissions and cross-browser manifests

`src/` is shared by both browsers; only the manifest differs. There are exactly
three manifests — the root one plus the two in `manifests/` — and `scripts/version.mjs`
keeps their versions in step. The root `manifest.json` is always byte-identical to
`manifests/manifest.chrome.json` (a test enforces it), so Chrome can load the
repository root directly. The Chrome manifest sets `minimum_chrome_version: "116"`.

**Declared permissions and why they are needed**

| Permission / key                                          | Used by                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activeTab`                                               | Host access to the tab the user is on at the moment they invoke a feature. Keeps Inspect / Record / Lab / Stress Test working for users who set Chrome site access to "on click" or revoke Firefox host permissions. It gates no API, so there is no call signature to point at (`HOST_ACCESS_PERMISSIONS` in `scripts/lib/policy.mjs`). |
| `optional_host_permissions: <all_urls>` (optional)        | `chrome.tabs.captureVisibleTab` for step screenshots, which needs `<all_urls>` or an activeTab grant; requested with `chrome.permissions.request` when the user enables screenshots, never at install. The policy check accepts `<all_urls>` only here, and only when the package calls `permissions.request` with it                    |
| `scripting` + `host_permissions: http://*/*, https://*/*` | `chrome.scripting.executeScript` (inject content scripts on demand — pages that loaded before the extension, sub-frames for Inspect/Record, the Lab relay, Stress Test, context-menu copy) and content-script messaging on any web page                                                                                                  |
| `storage`                                                 | `chrome.storage.local` (last picked element, recorder timeline and script draft, framework/language) and `chrome.storage.session` (worker state, steps buffered while the panel is closed)                                                                                                                                               |
| `contextMenus`                                            | the “Copy Best Locator” / panel entries                                                                                                                                                                                                                                                                                                  |
| `sidePanel` + `side_panel` (Chrome)                       | the side-panel surface                                                                                                                                                                                                                                                                                                                   |
| `sidebar_action` (Firefox)                                | the sidebar surface — Firefox has **no** `sidePanel` permission; `background.js` detects this and falls back from `chrome.sidePanel` to `browser.sidebarAction`                                                                                                                                                                          |

### The `tabs` permission is deliberately **not** requested

A Chrome Web Store submission was rejected under violation **"Purple Potassium"**
for requesting `tabs` when nothing needed it. Everything this extension does with
`chrome.tabs` works without the permission:

| Call                                                       | Why it needs no permission                                                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chrome.tabs.query({ active: true, currentWindow: true })` | Returns tabs either way. `tabs` only adds `url`, `title` and `favIconUrl` to the result; the code reads `id` and `windowId`, which are always present. |
| `chrome.tabs.sendMessage(tabId, …)`                        | Gated by **host** access, not by `tabs`.                                                                                                               |
| `chrome.tabs.onUpdated`                                    | Fires either way. `tabs` only adds `url` to `changeInfo`; the code reads `status`.                                                                     |
| `chrome.tabs.onRemoved`                                    | Never required a permission.                                                                                                                           |

This is enforced, not just documented: `scripts/build.mjs` fails the build if any
manifest declares `tabs`, if a declared permission is not backed by an API the
packaged code calls, or if a permission has no evidence rule at all (unknown
permissions fail closed). `tests/package.test.mjs` additionally asserts the code
never reads `url` / `title` / `favIconUrl` off a tab, so the justification above
cannot quietly stop being true.

**Cross-browser notes**

- **Background:** Chrome uses `background.service_worker`; Firefox uses `background.scripts` + `"type": "module"`. `src/background.js` is plain (no top-level imports) and uses only APIs available in both, so the single file works in either context.
- **Firefox requirements:** `browser_specific_settings.gecko.id`, `strict_min_version: "142.0"`, and `data_collection_permissions: { required: ["none"] }` are present so AMO/`about:debugging` accept the add-on without data-collection prompts. Changing `gecko.id` would create a _new_ add-on rather than update the existing listing.
- **Namespaces:** code uses the `chrome.*` namespace, which Firefox aliases; Firefox-only calls (`browser.sidebarAction`) are guarded with `typeof browser !== 'undefined'`.
- All three manifests are valid MV3 JSON, and the build verifies that every path a manifest references is actually present in its package.

---

## 12. Tests and CI

`npm test` runs the Vitest suites below. They drive the real shipping files —
nothing is duplicated or re-implemented for testability.

| Suite                                                                                                                                                                  | Environment  | Covers                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/codegen.test.mjs`                                                                                                                                               | node         | Every framework × language combination, action and assertion statements, script scaffolding, and escaping of values containing quotes, backslashes and newlines                                                                                             |
| `tests/locator-engine.dom.test.mjs`                                                                                                                                    | jsdom        | Role resolution, accessible-name computation, ranking and stability, live uniqueness counts, the a11y audit, and CSS-special identifiers                                                                                                                    |
| `tests/content-script.dom.test.mjs`                                                                                                                                    | jsdom        | Loads all three content scripts in manifest order behind a `chrome` stub and drives them through the background's message API — inspect lifecycle, Selector Lab, Stress Test, recorder controls                                                             |
| `tests/sidepanel-render.dom.test.mjs`                                                                                                                                  | jsdom        | `esc` / `hl` / `safeRender`, including that inline event handlers, `<script>` and `javascript:` URLs never survive rendering, plus panel startup, recorder timeline and script-editor behaviour                                                             |
| `tests/background.test.mjs`                                                                                                                                            | node         | The service worker, run in fresh `node:vm` contexts over a shared `chrome` stub — message routing, injection and recording state across worker eviction                                                                                                     |
| `tests/popup.dom.test.mjs`                                                                                                                                             | jsdom        | The popup launcher's buttons and its state sync with the service worker                                                                                                                                                                                     |
| `tests/*-replay*.test.mjs`, `tests/*pom*.test.mjs`, `tests/content-suggestions.dom.test.mjs`, `tests/*thumbs*.test.mjs`, `tests/sidepanel-features/flows.dom.test.mjs` | node / jsdom | Replay orchestration and in-page step execution, Page Object scanning and generation, automatic assertion suggestions, the IndexedDB thumbnail store, and the panel flows that drive them                                                                   |
| `tests/support/coverage-accuracy.test.mjs`                                                                                                                             | node         | Proves coverage of the classic scripts is measured correctly (see below): a throwaway project measures the same workload through `vm` and through `import`, and both must equal Vite's source-mapped measurement statement for statement, branch for branch |
| `tests/package.test.mjs`                                                                                                                                               | node         | The store-policy rules (`scripts/lib/policy.mjs`) against fixtures that must fail; both packages built into a temp dir and checked; archives read back with `unzip -t`, Python `zipfile` and a CRC-checking reader; docs checked against the manifests      |

`.github/workflows/ci.yml` runs version check → format check → lint → tests with
coverage → build → `web-ext lint` (Mozilla's validator, over `dist/firefox`) on every
push and pull request and uploads both `.zip` files as artifacts; a second job runs
the browser smoke test below under `xvfb`, and two more run the exported tests for
real (`npm run test:exports`, below) — Playwright and Selenium in one, Cypress in
the other. A pre-commit hook runs Prettier and ESLint
over staged files via `lint-staged`.

### Coverage of classic scripts

Every file in `src/` is a classic script, and most suites run it through `node:vm`.
The stock `@vitest/coverage-v8` provider remapped those runs' raw V8 offsets onto
Vite's _transformed_ copy of the file, so executed statements and implicit `else`
branches were reported as uncovered (the locator engine read 86.7% branches when
96.4% were taken), and an `import` plus a `vm` run of the same file were merged as
if they were one script. `tests/support/` fixes that in three parts:
`vm-coverage.mjs` tags every `vm` compile of a `src/` file; `classic-scripts.mjs`
(a Vite plugin in `vitest.config.mjs`) turns an `import` of a `src/` file into a
`vm` run of the same bytes; and `coverage-provider.mjs` keeps only the tagged
entries and measures them against the file on disk, untransformed. Thresholds are
global and per file, set just below the accurate numbers.

jsdom has no layout, so `document.elementFromPoint` (the picker's hit test),
`innerText` semantics and the real message plumbing between content script, service
worker and side panel are outside its reach. `npm run smoke` covers that gap.

The side panel's HTML and CSS are still not tested; only its rendering helpers are.

### `npm run smoke`

Loads the **built** extension into Chromium and drives the whole product against
the demo page — inspect and pick by real mouse hit test, keyboard traversal, Escape
teardown, Selector Lab, and a recording that exercises fill / select / check /
uncheck.

The last group is the useful one: it extracts the locators the extension just wrote
into the generated script and **runs them back through Playwright against the same
page**, asserting each matches exactly one element. A locator that reads plausibly
but does not resolve fails the run.

It also asserts the content script writes nothing to the page console, and that a
recording survives reopening the panel.

It also covers two of the newer features through the panel's real buttons:

- **Replay.** A recorded checkout is replayed and must actually place the order.
  The secret is entered in the replay form and is never stored. Replayed actions are
  not recorded. Leaving the secret empty marks that step as skipped. Replaying
  against a page with a missing field must fail at that step, highlighted, with the
  reason.
- **Suggested assertions.** Placing the order suggests `toHaveURL` and
  `toContainText`. They stay out of the script until accepted, and Dismiss removes
  one for good.

Two more scripts cover the other features. Each uses its own port and browser
profile, so they can run alongside the main one.

- `npm run smoke:pom`, **Page Object export**:
  - A whole-page scan, a real region pick, and Esc to cancel a pick.
  - Every generated locator must match exactly one element, and the right one.
  - The generated TypeScript and JavaScript classes are imported and used to fill
    and submit the checkout.
  - The Selenium locator strings must resolve too.
  - Renaming and name validation, plus Copy and Download.
- `npm run smoke:screenshots`, **step screenshots**:
  - Without the optional `<all_urls>` grant: recording still works and the panel
    shows "Grant access".
  - With the grant (seeded into the profile, because the permission prompt is
    native and can't be clicked):
    - every step gets a thumbnail outlining the element in the right place;
    - the preview opens, Esc closes it, and focus returns to the thumbnail;
    - removing a step deletes its stored screenshot, and Clear Timeline deletes them
      all;
    - the setting switches capture off and on;
    - suggested and viewport steps never get one.

- `npm run smoke:settings`, **the Settings page, shortcuts, health check and Edge**:
  - every section of the Settings page; test-id attributes are validated, saved and
    used live by the content script; legacy `customAttributes` is migrated; secret
    names reach recorded steps; hostile settings imports are rejected;
  - both keyboard-shortcut commands toggle Inspect and Record, and a restricted page
    shows the "!" badge;
  - the health check answers ok / broken (with a suggestion that resolves to one
    element) / ambiguous / frame missing, including inside the payment iframe;
  - the Edge package is byte-identical to Chrome's and loads.
- `npm run smoke:data-health`, **test-data variables and the Health tab** through the
  real side panel.
- `npm run smoke:frames`, **frames behind a cross-origin parent**: real clicks in a
  payment frame, a frame nested two cross-origin levels deep and a shadow-hosted
  frame, on pages where `<iframe>` order and `window.frames` order differ (an
  `<object>`, a late-inserted iframe). Each recorded frame `index` must equal what
  Playwright counts, and each exported Playwright locator must find exactly one
  element.
- `npm run smoke:firefox`, **the Firefox package in a real Firefox**: it is installed
  as a temporary add-on through Selenium and geckodriver, and
  - the background page answers, and http/https access is granted;
  - Inspect injects the content script;
  - a recording of real WebDriver input lands in the sidebar Firefox opens by itself,
    with the password step empty and the password nowhere in extension storage;
  - the export reads the password from the environment;
  - a replay re-fills the page, its secret fetched by the owning frame;
  - the health check works inside the payment iframe;
  - `about:robots` is refused.

  It needs Firefox and geckodriver 0.36 or later (`LOCATRA_FIREFOX` /
  `LOCATRA_GECKODRIVER`, else `PATH`). Without them it says so and passes. WebDriver
  will not open a `moz-extension://` page, so the panel tab is opened from Firefox's
  privileged context, which is why geckodriver is started with
  `--allow-system-access`.

`npm run smoke:all` runs all seven.

They need a browser, so they are not part of `npm run verify`. CI runs them in their
own job, the Chromium ones under `xvfb` and the Firefox one headless (there it must
run: `LOCATRA_REQUIRE_FIREFOX=1` makes a missing Firefox or geckodriver a failure).
Run them locally before submitting too:

```bash
npm run build && npm run smoke:all
```

The Page Object smoke reads the clipboard back by pasting into a page, through the
system clipboard. Under native Wayland the compositor ignores a copy from a window
without keyboard focus, which an automated window often lacks, so the smoke runs
Chromium on X11 (XWayland) when both displays are available — the same as CI's
`xvfb`. A real user's click gives the panel focus, so the extension itself is not
affected.

---

### `npm run test:exports`

The unit suites prove exported code parses; this proves it **works**. It serves the
demo checkout (`scripts/screenshots/demo-page.html`, with its payment iframe) and
runs the export of a flow in every framework × language, each in its real runner:

| Export             | Runs with                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------- |
| Playwright TS / JS | `@playwright/test` (pinned to the `playwright` version) with a generated config             |
| Playwright Python  | `pytest` + `pytest-playwright`                                                              |
| Selenium TS / JS   | `node` + `selenium-webdriver` (TS through Node's type stripping); Selenium Manager's driver |
| Selenium Python    | `python` + `selenium`                                                                       |
| Cypress TS / JS    | `cypress run` (Electron) with `cypress-real-events` for combo key presses                   |
| Playwright Java    | Maven + JUnit 5 (`npm run test:exports:setup-java` installs a JDK and Maven if missing)     |
| Selenium Java      | Maven + JUnit 5, Selenium Manager's driver                                                  |
| Playwright C#      | `dotnet test` + NUnit (`npm run test:exports:setup-csharp` installs the .NET SDK)           |
| Selenium C#        | `dotnet test` + NUnit, Selenium Manager's driver                                            |
| WebdriverIO TS/JS  | the `wdio` CLI + Mocha (`npm run test:exports:setup-webdriverio`)                           |

Cypress is pinned to 15.x (`npm run test:exports:setup-cypress`). Exported specs
read secrets through a small `locatraSecret()` helper emitted into the spec: it calls
`cy.env([name])` where that exists (Cypress 15 and later; Cypress 16 removed
`Cypress.env()`) and falls back to `Cypress.env(name)` on older versions. Either way
the value comes from `CYPRESS_LOCATRA_PASSWORD`, which the harness sets from
`LOCATRA_PASSWORD`, and it is never logged.

Every runner drives the Chromium Playwright installed; the scripts are run exactly as
exported, and only the browser launch is redirected (headless, that binary) by small
shims in `tests/e2e/support/`.

Two flows are run. **canonical** is `tests/e2e/fixtures/checkout-flow.json`, steps in
the exact shape the side panel stores: fills (one a password, read from
`LOCATRA_PASSWORD`), a value check on that password field (also read from the
environment, and never printed when it fails), a select, a multi-select, a field
inside an open shadow root, check/uncheck, hover, viewport, clicks and an assertion
inside the payment iframe (one addressed only by position), Tab / Shift+Tab / Enter,
and `toBeVisible`, `toHaveText`, `toContainText`, `toBeChecked`, `toHaveValue` and
`toHaveURL`.

For this run only (`startDemoServer({ exportExtras: true })`; the store screenshots
and the other smokes see the plain page), the server adds three things to the demo
page (`scripts/e2e/demo-server.mjs`): the Interests multi-select, whose option text
has stray whitespace; the Promo code field inside `<promo-code>`'s shadow root; and
a hidden `<object>` before the payment iframe. The `<object>` is a browsing context
that is not an `<iframe>`: a frame addressed only by position (as one behind a
cross-origin parent is) must still be the first `<iframe>` in every framework. The
recorded flow must contain the sensitive value check, a two-value multi-select step
and the shadow-root fill, and no click on an `<option>`, or it fails before any
runner starts.
**recorded** is the same checkout recorded through the built extension in a real
browser (suggested assertions accepted with the panel's own button) and read back
from the panel's storage — recorder, storage, codegen and framework end to end.

A run passes only if it exits cleanly **and** the demo server received exactly one
order matching `tests/e2e/fixtures/checkout-flow.expect.json` — names, country, gift
wrap, card number from the iframe, the password from the environment, both chosen
interests, the promo code typed into the shadow root, and the field
that had focus when Enter submitted (which proves the Tab and Shift+Tab steps). A
runner that is not installed is skipped with the command that installs it;
`--require all` (used in CI) turns such a skip into a failure. Generated scripts and
each runner's output are kept in `.tmp-exports/port-<n>/`, one folder per `--port`, so
runs started in parallel don't clear each other's files.

Scripts are generated with test-data variables on, which is what users get by
default; `--literals` runs the same flows with inline values. Each runner lives in
`scripts/e2e/runners/` (or in `run-exports.mjs` for the original eight) and installs
its toolchain into `node_modules/.cache/locatra-e2e/`, so `package.json` is unchanged.
CI runs each language in its own job.

```bash
npm run build && npm run test:exports
npm run test:exports -- --only selenium-python,cypress-typescript --flow canonical
```

## 13. Store screenshots

`npm run screenshots` (`scripts/screenshots/capture.mjs`) loads **`dist/chrome`** into
Chromium, drives it against `scripts/screenshots/demo-page.html`, and writes real
captures to `screenshots/store/`. Run `npm run build` first — it photographs the built
package, not the source tree.

Two implementation details worth knowing before editing it:

- **It uses Playwright's bundled Chromium, not the installed Google Chrome.** Chrome
  137 removed the `--load-extension` switch, so a stock Chrome starts with no
  extension loaded and silently produces screenshots of an empty browser.
- **Messages are addressed to the demo tab explicitly, from the service worker.** The
  side panel has to be opened as a tab to be captured, which makes it the active tab —
  so anything routed through the background's `tabs.query({ active: true })` would act
  on the panel instead of the page under test.

The `store-*.png` files are 1280×800 (the size the Chrome Web Store requires) and place
the real page capture beside the real panel capture at the geometry Chrome uses when a
panel is docked. Both halves are genuine screenshots; nothing is redrawn. Listing
images must show functionality the extension actually has — the previous set did not,
which is covered in `STORE_SUBMISSION.md` §5.
