# Store submission guide

Everything needed to build, verify and submit Locatra to the Chrome Web Store
and addons.mozilla.org, plus the permission justifications reviewers ask for.

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
| `dist/locatra-chrome-<version>.zip`  | upload to the Chrome Web Store                            |
| `dist/locatra-firefox-<version>.zip` | upload to AMO                                             |

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
- dynamic code execution: `eval()`, `new Function()`, `importScripts()`, and
  `setTimeout` / `setInterval` called with a string
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

**Short description** (112 chars, limit 132)

> Inspect elements for ranked Playwright locators and record flows into test scripts—runs locally in your browser.

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
come from `chrome.tabs.captureVisibleTab`, which the existing host permissions
already allow — no new permission — and are stored only as local IndexedDB
thumbnails, deleted with their steps, after 14 days, or never taken when the
setting is off.

Certify all three: no unauthorised use, no unauthorised transfer, no
creditworthiness use. The package contains no network API at all, which
`scripts/build.mjs` enforces — so these answers are checkable against the code
rather than merely asserted.

## 4. Permission justifications

Paste these into the Chrome Web Store "Privacy practices" tab. Each permission is
exercised by the feature named; there are no unused permissions.

| Permission                                         | Justification                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activeTab`                                        | Grants access to the tab the user is on at the moment they click Inspect, Record, Validate or Stress Test (or use the context menu), so those actions keep working when the user has set the extension's site access to "on click" in Chrome or revoked its host permission in Firefox.                                                                                                                                                 |
| `scripting`                                        | The inspector, recorder and Selector Lab are content scripts. When a page loaded before the extension did — or after an extension update — `chrome.scripting.executeScript` re-injects them so the user does not have to reload the page.                                                                                                                                                                                               |
| `storage`                                          | `chrome.storage.local` keeps the user's framework/language choice and settings, the last inspected element and the in-progress recording (timeline and script draft); `chrome.storage.session` keeps the service worker's inspect/recording state and steps recorded while the panel was closed. Passwords and one-time codes are never recorded. Local only; nothing is transmitted.                                                   |
| `contextMenus`                                     | Adds the right-click "Copy Best Locator" and "Open/Close Results Panel" entries.                                                                                                                                                                                                                                                                                                                                                        |
| `sidePanel` (Chrome)                               | The results panel is the extension's primary UI surface.                                                                                                                                                                                                                                                                                                                                                                                |
| `optional_host_permissions: <all_urls>` (optional) | Step screenshots: `chrome.tabs.captureVisibleTab` requires `<all_urls>` or an activeTab grant — http/https host access is not enough. It is optional and requested with `chrome.permissions.request` only when the user switches step screenshots on in the panel, never at install; declining keeps every other feature. Thumbnails are stored locally in IndexedDB, deleted with their steps or after 14 days, and never transmitted. |
| `host_permissions: http://*/* + https://*/*`       | See below.                                                                                                                                                                                                                                                                                                                                                                                                                              |

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
> details are read only while the user runs Inspect, Record, Selector Lab, Stress
> Test or Copy Best Locator, are used solely to generate locator and test code
> shown in the side panel, and are never transmitted: there is no backend, no
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

## 8. If a submission is rejected

1. Record the exact reviewer text in `CHANGELOG.md` under the version.
2. Reproduce the finding against `dist/<target>/` — the reviewer read those bytes.
3. Add a failing assertion to `tests/package.test.mjs` if the finding is about what
   the package contains, so it cannot recur silently.
4. Fix, bump the version, rebuild, resubmit.
