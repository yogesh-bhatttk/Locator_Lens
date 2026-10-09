# Locatra — build process and architecture

This document describes how the extension is structured and how distribution folders relate to `src/`. The product inspects elements and records flows, generating code for **Playwright / Selenium / Cypress** in **TypeScript / JavaScript / Python** (Cypress is JS/TS only).

---

## 1. UI (side panel / popup)

- Warm, minimal theme with automatic **light/dark** mode (follows the OS preference); no decorative runtime/animations.
- Side panel is the primary surface with two tabs: **Inspect** and **Record**.

---

## 2. Locator pipeline + multi-framework codegen

- **`content-locator-engine.js`** (injected first) ranks candidate locators, attaches a structured `target` (kind + values) and live **uniqueness** (`matchCount` / `unique`) per candidate, plus explanations. Runs in the content script (it needs the live DOM).
- **`codegen.js`** is a pure module (loaded as a content script _and_ in the side panel) that translates a `target` + action into **Playwright / Selenium / Cypress** code for **JS / TS / Python**. `LLCodegen.isValidCombo()` blocks the impossible combo (Cypress + Python).
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
It writes `dist/chrome/` and `dist/firefox/` plus a versioned `.zip` for each, and
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

| Suite                                 | Environment | Covers                                                                                                                                                                                                                                                 |
| ------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/codegen.test.mjs`              | node        | Every framework × language combination, action and assertion statements, script scaffolding, and escaping of values containing quotes, backslashes and newlines                                                                                        |
| `tests/locator-engine.dom.test.mjs`   | jsdom       | Role resolution, accessible-name computation, ranking and stability, live uniqueness counts, the a11y audit, and CSS-special identifiers                                                                                                               |
| `tests/content-script.dom.test.mjs`   | jsdom       | Loads all three content scripts in manifest order behind a `chrome` stub and drives them through the background's message API — inspect lifecycle, Selector Lab, Stress Test, recorder controls                                                        |
| `tests/sidepanel-render.dom.test.mjs` | jsdom       | `esc` / `hl` / `safeRender`, including that inline event handlers, `<script>` and `javascript:` URLs never survive rendering, plus panel startup, recorder timeline and script-editor behaviour                                                        |
| `tests/background.test.mjs`           | node        | The service worker, run in fresh `node:vm` contexts over a shared `chrome` stub — message routing, injection and recording state across worker eviction                                                                                                |
| `tests/popup.dom.test.mjs`            | jsdom       | The popup launcher's buttons and its state sync with the service worker                                                                                                                                                                                |
| `tests/package.test.mjs`              | node        | The store-policy rules (`scripts/lib/policy.mjs`) against fixtures that must fail; both packages built into a temp dir and checked; archives read back with `unzip -t`, Python `zipfile` and a CRC-checking reader; docs checked against the manifests |

`.github/workflows/ci.yml` runs version check → format check → lint → tests with
coverage → build → `web-ext lint` (Mozilla's validator, over `dist/firefox`) on every
push and pull request and uploads both `.zip` files as artifacts; a second job runs
the browser smoke test below under `xvfb`. A pre-commit hook runs Prettier and ESLint
over staged files via `lint-staged`.

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

Requires a display, so it is not part of `npm run verify`; CI runs it under `xvfb`
in its own job. Run it locally before submitting too:

```bash
npm run build && npm run smoke
```

---

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
