# Store submission guide

Everything needed to build, verify and submit Locatra to the Chrome Web Store,
addons.mozilla.org and Microsoft Edge Add-ons, plus the permission justifications
reviewers ask for.

---

## 1. Build the packages

```bash
npm ci
npm run verify     # version + format check, lint, tests with coverage, build
npm run lint:firefox   # Mozilla's web-ext lint over dist/firefox (CI runs it too)
```

`npm run build` writes to `dist/`:

| Artifact                             | Use                                                       |
| ------------------------------------ | --------------------------------------------------------- |
| `dist/chrome/`                       | unpacked tree — `chrome://extensions` → Load unpacked     |
| `dist/firefox/`                      | unpacked tree — `about:debugging` → Load Temporary Add-on |
| `dist/edge/`                         | unpacked tree — `edge://extensions` → Load unpacked       |
| `dist/locatra-chrome-<version>.zip`  | upload to the Chrome Web Store                            |
| `dist/locatra-firefox-<version>.zip` | upload to AMO                                             |
| `dist/locatra-edge-<version>.zip`    | upload to Microsoft Edge Add-ons (Partner Center)         |

The Edge package is built from the Chrome manifest and holds byte-identical files
(Edge is Chromium: `chrome.sidePanel`, `commands` and `options_ui` behave the
same); it is a target of its own so the archive uploaded to Partner Center is
named for it and is checked by the same rules. `node scripts/build.mjs edge` builds
only it.

The build prints a SHA-256 for each archive, preceded by the Node and zlib versions
that produced it. Archives are reproducible: file order, timestamps and permissions
are fixed, so **the same commit built with the same Node major version (and
therefore the same bundled zlib) yields the same hash**. A different zlib can
compress the same bytes differently, so a hash may legitimately differ across Node
majors even though the extracted files are identical. `.nvmrc` pins Node 22, which
is what CI uses — record the hash and the printed `node`/`zlib` line with the
submission.

**Never zip the repository root.** `scripts/build.mjs` selects files from an
explicit allowlist (`SHIP`) and refuses to produce a package that violates store
policy. Zipping the root is what previously shipped a generated report page that
loaded a library from `unpkg.com` — remote code, and an automatic rejection.

## 2. What the build refuses to ship

`scripts/build.mjs` fails, rather than warns, on:

- remote code or resources: markup (`<script>`, `<link>`, `<iframe>`, `<img>`, …)
  pointing at an `http(s)` or protocol-relative (`//cdn…`) URL, `import()` /
  `import … from` a URL, `.src = 'https://…'` / `setAttribute('src', …)`, and CSS
  `@import` / `url()` of a remote URL
- dynamic code execution: `eval()`, `new Function()`, `importScripts()` of anything
  but a file shipped in the package, and `setTimeout` / `setInterval` called with a
  string
- a manifest that loosens the extension pages' Content Security Policy (anything but
  `'self'`, `'none'` or `'wasm-unsafe-eval'` in a script directive) or declares
  `externally_connectable`
- network APIs: `fetch()`, `XMLHttpRequest`, `navigator.sendBeacon()`,
  `WebSocket`, `EventSource` (they contradict the "runs locally, no network" claim)
- a manifest, page or injection that references a file the package does not
  contain — manifest keys (including `web_accessible_resources`), `<script src>` /
  `<link href>` in the HTML pages, and the files `background.js` passes to
  `scripting.executeScript`
- **a permission nothing in the code uses**, an explicitly banned permission
  (`tabs`), or a permission with no evidence rule at all — the check fails closed,
  so adding a permission requires a deliberate edit to `PERMISSION_EVIDENCE`. The
  same applies to `optional_permissions`; any host pattern outside `http://*/*` and
  `https://*/*` (in host permissions, optional host permissions, content-script
  matches or web-accessible-resource matches) is refused too

Comments are stripped before scanning, so a comment can neither trip a rule nor
count as evidence that a permission is used. The rules live in
`scripts/lib/policy.mjs`; `tests/package.test.mjs` drives them with fixtures that
must fail, re-runs them over freshly built packages, and reads the archives back
with independent zip readers (`unzip -t`, Python's `zipfile`, and a CRC-checking
reader of its own).

### Prior rejection on record

> **Chrome Web Store — violation "Purple Potassium"**
> _The following permission(s) need not be requested for the methods/properties
> implemented by the item: `tabs`._

The finding is correct, and it lands on **v1.1.3** — the last version whose
manifests declared `tabs`, in both `manifest.json` and
`manifests/manifest.chrome.json` (commit `9706b85`). No code path ever read a
property the permission unlocks, so it was pure over-request. It was dropped in
**v1.1.4** (commit `8d6792c`) and no version since has declared it.

There is nothing here to appeal: the remedy is to upload a build of 1.1.4 or
later. The guards above exist so it cannot come back unnoticed.

Everything the extension calls on `chrome.tabs` works without the permission:
`tabs.query` (reads only `id` and `windowId`), `tabs.sendMessage` (needs host
access, not `tabs`), `tabs.onUpdated` (reads only `status`) and `tabs.onRemoved`.
The permission only adds `url` / `title` / `favIconUrl`, which nothing reads —
`tests/package.test.mjs` asserts that stays true.

## 3. Version bumps

One command keeps `package.json` and all three manifests in step:

```bash
node scripts/version.mjs minor     # or patch / major / an explicit 1.2.3
node scripts/version.mjs           # verify they agree
```

Both stores reject an update that reuses a published version number, and AMO
rejects a _decrease_. Always bump before resubmitting — including after a
rejection, because the rejected version number is consumed on Chrome.

## 3b. Listing copy and disclosures

Paste verbatim. `tests/package.test.mjs` asserts the short description here is
byte-identical to the one in the manifest — a listing that describes something the
manifest does not is a review finding, and the two drift the moment they are
maintained separately.

**Short description** (132 chars, limit 132). The Chrome Web Store summary, the AMO
summary and the Edge short description; the manifests ship the same text.

> Inspect elements for ranked, unique locators and record flows into Playwright, Selenium, Cypress or WebdriverIO tests. Runs locally.

**Detailed description** (1840 characters; plain text, as all three stores show it).
The Chrome Web Store description, the AMO description and the Edge description
(which must be 250–10,000 characters):

> Locatra helps QA engineers and developers write end-to-end tests faster. Point at any element to get locators that are ranked, checked for uniqueness against the live page, and ready to paste, or record a flow and get a runnable test.
>
> INSPECT ANY ELEMENT
> • Hover and click an element to see ranked locators: test id, role and accessible name, label, placeholder, text, CSS and XPath.
> • Every locator is checked against the page, so you can see whether it matches exactly one element.
> • Works inside iframes (including cross-origin payment frames) and open shadow DOM.
> • Move to the parent or child element with ▲ / ▼, or press Alt+Shift+E on any page.
>
> YOUR FRAMEWORK, YOUR LANGUAGE
> • Playwright, Selenium, Cypress and WebdriverIO, in TypeScript, JavaScript, Python, Java and C#.
> • Locators read naturally in each framework. Selenium gets By.id("email") when the element has an id, instead of a long XPath.
>
> RECORD AND REPLAY
> • Record clicks, typing, selects, checkboxes, keys and assertions into a complete test script (Alt+Shift+K).
> • Replay the flow in the page step by step to check it before you export it.
> • Passwords, one-time codes and card numbers are never recorded: the test reads them from environment variables.
> • Typed values can become test data, and suggested assertions (page changed, message shown) are one click away.
>
> PAGE OBJECTS, SELECTOR LAB AND HEALTH CHECK
> • Export a Page Object class for a form or a whole page.
> • Selector Lab: paste a CSS selector, XPath or Playwright locator and see what it matches.
> • Watch the locators your tests rely on and re-check them with one click when the page changes.
>
> PRIVATE BY DESIGN
> • Everything runs locally in your browser. No account, no server, no analytics.
> • The extension contains no network code, and its source is public: https://github.com/yogesh-bhatttk/Locator_Lens

**Single purpose**

> Locatra inspects an element on the page the user is testing and produces a
> ranked, uniqueness-checked locator for it, plus optional recording of a flow into
> a runnable test script. Every feature serves that one purpose: inspecting page
> elements to author test locators.

**Data use** — answer every Chrome Web Store disclosure with _no collection_:

| Question                     | Answer | Why                                                                                                                                                                     |
| ---------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personally identifiable info | No     | none is read, derived or stored                                                                                                                                         |
| Health, financial, auth info | No     | password, one-time-code and card fields are recorded without their value (tests read it from `LOCATRA_PASSWORD` / `LOCATRA_SECRET`); secret URL parameters are redacted |
| Personal communications      | No     |                                                                                                                                                                         |
| Location                     | No     |                                                                                                                                                                         |
| Web history                  | No     | the recorded page URL (secret parameters redacted) is written into the generated script and stored locally, never transmitted                                           |
| User activity                | No     | recording is explicit, local, and user-initiated                                                                                                                        |
| Website content              | No     | page structure is read in-memory to compute a locator; step screenshots are kept as thumbnails in local IndexedDB (switchable off); nothing leaves the browser          |

Features that touch page content, for the reviewer's notes: **Replay** re-runs the
stored steps inside the user's own tab (no network); **Page Object export** builds a
class from the elements of a region the user picks; **automatic assertion
suggestions** propose checks (URL changed, confirmation message shown) that stay out
of the test until accepted and never carry sensitive values; **step screenshots**
come from `chrome.tabs.captureVisibleTab`, which needs the optional `<all_urls>`
grant (requested only when the user switches screenshots on — see §4). They are
stored only as local IndexedDB thumbnails, deleted with their steps, after 14 days,
or never taken when the setting is off, and no screenshot is taken of a password,
one-time-code or card step or while such a value shows in a field. The **locator
health check** re-checks the user's saved locators against the page they are on,
when they press Check or, if they opt in, when such a page loads.

Certify all three: no unauthorised use, no unauthorised transfer, no
creditworthiness use. The package contains no network API at all, which
`scripts/build.mjs` enforces — so these answers are checkable against the code
rather than merely asserted.

## 4. Permission justifications

Paste these into the Chrome Web Store "Privacy practices" tab. Each permission is
exercised by the feature named; there are no unused permissions.

| Permission                                         | Justification                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `activeTab`                                        | Grants access to the tab the user is on when they click the toolbar button, use a context-menu item or press one of the keyboard shortcuts (Alt+Shift+E inspect, Alt+Shift+K record), so those entry points keep working when the user has set the extension's site access to "on click" in Chrome or revoked its host permission in Firefox. Side-panel buttons are no such gesture; there the extension tells the user to allow site access instead. |
| `scripting`                                        | The inspector, recorder and Selector Lab are content scripts. When a page loaded before the extension did — or after an extension update — `chrome.scripting.executeScript` re-injects them so the user does not have to reload the page.                                                                                                                                                                                                              |
| `storage`                                          | `chrome.storage.local` keeps the user's framework/language choice and settings, the last inspected element and the in-progress recording (timeline and script draft); `chrome.storage.session` keeps the service worker's inspect/recording state and steps recorded while the panel was closed. Passwords and one-time codes are never recorded. Local only; nothing is transmitted.                                                                  |
| `contextMenus`                                     | Adds the right-click "Copy Best Locator" and "Open Results Panel" entries.                                                                                                                                                                                                                                                                                                                                                                             |
| `sidePanel` (Chrome)                               | The results panel is the extension's primary UI surface.                                                                                                                                                                                                                                                                                                                                                                                               |
| `optional_host_permissions: <all_urls>` (optional) | Step screenshots: `chrome.tabs.captureVisibleTab` requires `<all_urls>` or an activeTab grant — http/https host access is not enough. It is optional and requested with `chrome.permissions.request` only when the user switches step screenshots on in the panel, never at install; declining keeps every other feature. Thumbnails are stored locally in IndexedDB, deleted with their steps or after 14 days, and never transmitted.                |
| `host_permissions: http://*/* + https://*/*`       | See below.                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### Broad host access

> Locatra is a test-authoring tool for QA engineers. Its entire function is to
> analyse the page the user is currently testing and generate a locator for it.
> The user chooses that page — it may be any internal staging host, localhost port
> or customer environment — so the set of URLs cannot be enumerated in advance.
>
> The required grant is narrowed to `http://*/*` and `https://*/*` rather than `<all_urls>`:
> the extension analyses web pages, so it has no use for `file://`, `ftp://` or any
> other scheme, and does not ask for them.
> The content script is declared for http(s) pages and loads at `document_idle`.
> Until the user starts a feature it only reads the extension's own settings from
> local storage, listens for right-clicks (so "Copy Best Locator" knows its
> target), and tells the extension's service worker it is ready so an in-progress
> recording can continue after a navigation — it reads no page content. Element
> details are read only while the user runs Inspect, Record, Replay, Selector Lab,
> Stress Test, Page Object export, the locator health check (on request, or on page
> load if the user switched that on) or Copy Best Locator, are used solely to
> generate locator and test code shown in the side panel or to check the user's own
> saved locators, and are never transmitted: there is no backend, no
> analytics and no network request of any kind. This is verifiable — the packaged
> code contains no `fetch`, `XMLHttpRequest`, `sendBeacon`, `WebSocket` or
> `EventSource`, which the build enforces.

### Data handling declarations

Tick **no** for every data-collection category. Locatra has no server, sends
no telemetry and makes no network requests. The Firefox manifest declares this
formally via `browser_specific_settings.gecko.data_collection_permissions.required = ["none"]`.

Chrome additionally requires a hosted privacy-policy URL in the dashboard —
`PRIVACY_POLICY.md` is the source text; publish it at a stable URL and link it.

## 5. Listing screenshots

```bash
npm run build          # the screenshots are taken of dist/chrome
npm run screenshots
```

`scripts/screenshots/capture.mjs` loads the **built** extension into Chromium,
drives it against `scripts/screenshots/demo-page.html` and captures the result.
Every image is a real capture — nothing is drawn or mocked up.

| File                        | Size     | Upload?                                                             |
| --------------------------- | -------- | ------------------------------------------------------------------- |
| `store-01-inspect.png`      | 1280×800 | ✅ ranked locators for a picked field                               |
| `store-02-selector-lab.png` | 1280×800 | ✅ Selector Lab resolving a Playwright locator                      |
| `store-03-recorder.png`     | 1280×800 | ✅ the recorder timeline                                            |
| `store-04-codegen.png`      | 1280×800 | ✅ the generated test script                                        |
| `store-05-iframes.png`      | 1280×800 | ✅ a field inside a payment iframe, addressed with `frameLocator()` |
| `01`–`11-*.png`             | native   | raw captures — source material, and fine for AMO                    |

The `store-*` images place the real page capture and the real panel capture at the
geometry Chrome uses with a side panel docked (820 + 460 = 1280). They are a layout
of genuine screenshots, which the stores allow; a redrawn approximation is not.

> **Why this matters here.** The previous listing set could not be used. Seven of the
> images showed a _different product_ — a build with AI, Fix Test and Diagnostics
> tabs that this extension does not contain — and the rest were rendered mock-ups
> with garbled placeholder text and code the generator never emits. Either is a
> straightforward rejection: listing images must depict the item's actual
> functionality.

Regenerate whenever the UI changes, and re-check that every screenshot still shows a
feature that exists.

## 6. Chrome Web Store checklist

- [ ] `npm run verify` passes
- [ ] `npm run smoke` passes — drives the built extension in a real browser and
      re-runs the locators it generates against the page (jsdom cannot cover this)
- [ ] version bumped past the last **submitted** version (not just the published one)
- [ ] upload `dist/locatra-chrome-<version>.zip`
- [ ] single purpose: "generate and validate test locators for the current page"
- [ ] permission justifications from §4 pasted in
- [ ] privacy policy URL set and reachable
- [ ] data-collection questions all answered "no"
- [ ] upload the five `store-*.png` images from §5 (1280×800, real captures), and
      the two `promo-*.png` tiles (`npm run promo`)

## 7. AMO checklist

- [ ] `npm run verify`, `npm run lint:firefox` and `npm run smoke` pass
- [ ] version strictly greater than the currently listed one
- [ ] upload `dist/locatra-firefox-<version>.zip`
- [ ] source code is unminified and unbundled — the package ships the same files as
      the repository, so no "source code submission" step is required
- [ ] `browser_specific_settings.gecko.id` unchanged (`locatorlens@yogesh-bhatttk.com`);
      changing it creates a _new_ add-on rather than updating the existing listing
- [ ] `strict_min_version` still correct for the APIs in use

## 7b. Microsoft Edge Add-ons (Partner Center)

Submit at Partner Center → Microsoft Edge → **Create new extension** (or the
existing item → **Update**). Every field, in the order Partner Center asks:

**Packages**

- [ ] `npm run verify` and `npm run smoke` pass; version bumped past the last
      version **submitted to Edge** (Edge, like Chrome, consumes a rejected number)
- [ ] upload `dist/locatra-edge-<version>.zip`. Partner Center reads name, version,
      description and icons from its manifest — nothing to retype

**Availability**

- **Visibility**: Public
- **Markets**: all markets

**Properties**

| Field                       | Value                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| Category                    | Developer tools                                                                                  |
| Privacy policy requirements | **No** — the extension does not access, collect or transmit personal information (see §3b)       |
| Privacy policy URL          | https://github.com/yogesh-bhatttk/Locator_Lens/blob/master/PRIVACY_POLICY.md (set it regardless) |
| Website URL                 | https://github.com/yogesh-bhatttk/Locator_Lens                                                   |
| Support contact details     | https://github.com/yogesh-bhatttk/Locator_Lens/issues                                            |
| Mature content              | No                                                                                               |

**Store listing** (English)

| Field                  | Value                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Display name           | Locatra – Smart Locator Automation (from the manifest)                                                                                       |
| Description            | The detailed description from §3b, verbatim (Partner Center wants 250–10,000 characters)                                                     |
| Store logo             | `icons/icon128.png` meets the 128×128 minimum; a 300×300 rendering of the same mark is recommended (not generated yet)                       |
| Small promotional tile | `screenshots/store/promo-small-440x280.png` (optional)                                                                                       |
| Large promotional tile | `screenshots/store/promo-marquee-1400x560.png` (optional)                                                                                    |
| Screenshots            | the five `screenshots/store/store-*.png` images from §5 (1280×800, real captures of the Chromium build — Edge renders the panel identically) |
| YouTube video URL      | leave empty                                                                                                                                  |
| Search terms           | `playwright`, `selenium`, `cypress`, `webdriverio`, `locator`, `test recorder`, `qa automation` (7 terms, each ≤ 30 characters)              |

The short description, verbatim from the manifest:

> Inspect elements for ranked, unique locators and record flows into Playwright, Selenium, Cypress or WebdriverIO tests. Runs locally.

**Permissions.** Partner Center has no per-permission form; reviewers read the
justification from the notes below. Same set, same reasons as §4:

- `activeTab` — act on the tab the user invokes Locatra on (button, context menu
  or keyboard shortcut), also when site access is set to "on click".
- `scripting` — inject the inspector/recorder content scripts into pages that loaded
  before the extension, and run the locator health check in the page's frames.
- `storage` — settings, the recorder timeline, watched locators (local), and the
  worker's inspect/recording state (session). Nothing is transmitted.
- `contextMenus` — the right-click "Copy Best Locator" / "Open Results Panel" items.
- `sidePanel` — the results panel, the extension's main surface.
- host access `http://*/*`, `https://*/*` — the user tests arbitrary internal and
  public hosts; see §4 "Broad host access". `<all_urls>` is optional and requested
  at run time only for step screenshots.

**Submission options → Notes for certification** (paste):

> Locatra is a developer tool for writing end-to-end tests. To try it: open any
> http(s) page (for example https://example.com), click the toolbar icon →
> "Start Inspecting" and hover/click an element — ranked locators appear in the
> side panel. In the panel's Record tab press "Start Recording", click and type on
> the page, then "Stop" to see the generated test. Alt+Shift+E / Alt+Shift+K toggle
> inspecting / recording from the keyboard; the ⚙ Settings link in the popup opens
> the options page. No account or test credentials are needed. The package has no
> network code (no fetch, XMLHttpRequest, WebSocket, EventSource or sendBeacon) and
> no remote code; the source is https://github.com/yogesh-bhatttk/Locator_Lens.
> Permissions: activeTab, scripting, storage, contextMenus, sidePanel and
> http/https host access, each used as described in the listing; the optional
> <all_urls> grant is requested only when the user turns on step screenshots.

- [ ] Edge reviews can take up to 7 business days; an update replaces the listing
      only after certification

## 8. If a submission is rejected

1. Record the exact reviewer text in `CHANGELOG.md` under the version.
2. Reproduce the finding against `dist/<target>/` — the reviewer read those bytes.
3. Add a failing assertion to `tests/package.test.mjs` if the finding is about what
   the package contains, so it cannot recur silently.
4. Fix, bump the version, rebuild, resubmit.
