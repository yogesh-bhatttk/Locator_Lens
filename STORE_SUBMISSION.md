# Store submission guide

Everything needed to build, verify and submit LocatorLens to the Chrome Web Store
and addons.mozilla.org, plus the permission justifications reviewers ask for.

---

## 1. Build the packages

```bash
npm ci
npm run verify     # version check + lint + tests + build
```

`npm run build` writes to `dist/`:

| Artifact | Use |
|---|---|
| `dist/chrome/` | unpacked tree — `chrome://extensions` → Load unpacked |
| `dist/firefox/` | unpacked tree — `about:debugging` → Load Temporary Add-on |
| `dist/locatorlens-chrome-<version>.zip` | upload to the Chrome Web Store |
| `dist/locatorlens-firefox-<version>.zip` | upload to AMO |

The build prints a SHA-256 for each archive. Builds are byte-reproducible, so the
same commit always yields the same hash — record it with the submission.

**Never zip the repository root.** `scripts/build.mjs` selects files from an
explicit allowlist (`SHIP`) and refuses to produce a package that violates store
policy. Zipping the root is what previously shipped a generated report page that
loaded a library from `unpkg.com` — remote code, and an automatic rejection.

## 2. What the build refuses to ship

`scripts/build.mjs` fails, rather than warns, on:

- a `<script>` or `<link>` pointing at an `http(s)` URL (remote code)
- `eval()`, `new Function()`, `importScripts()` (dynamic code execution)
- `fetch` / `XMLHttpRequest` (contradicts the "runs locally, no network" claim)
- a manifest that references a file the package does not contain

`tests/package.test.mjs` re-asserts all of it against the built output, so CI
catches a regression before an upload does.

## 3. Version bumps

One command keeps `package.json` and all three manifests in step:

```bash
node scripts/version.mjs minor     # or patch / major / an explicit 1.2.3
node scripts/version.mjs           # verify they agree
```

Both stores reject an update that reuses a published version number, and AMO
rejects a *decrease*. Always bump before resubmitting — including after a
rejection, because the rejected version number is consumed on Chrome.

## 4. Permission justifications

Paste these into the Chrome Web Store "Privacy practices" tab. Each permission is
exercised by the feature named; there are no unused permissions.

| Permission | Justification |
|---|---|
| `activeTab` | Grants access to the tab the user is on at the moment they click Inspect, Record, Validate or Stress Test, so those actions work even when the user has restricted the extension's site access to "on click". |
| `scripting` | The inspector, recorder and Selector Lab are content scripts. When a page loaded before the extension did — or after an extension update — `chrome.scripting.executeScript` re-injects them so the user does not have to reload the page. |
| `storage` | Persists the user's framework/language choice, custom test-id attribute list, the last inspected element and the in-progress recording timeline. Local only; nothing is transmitted. |
| `contextMenus` | Adds the right-click "Copy Best Locator" and "Open/Close Results Panel" entries. |
| `sidePanel` (Chrome) | The results panel is the extension's primary UI surface. |
| `host_permissions: <all_urls>` | See below. |

### Broad host access

> LocatorLens is a test-authoring tool for QA engineers. Its entire function is to
> analyse the page the user is currently testing and generate a locator for it.
> The user chooses that page — it may be any internal staging host, localhost port
> or customer environment — so the set of URLs cannot be enumerated in advance.
> The extension reads the DOM of a page only while the user has explicitly started
> Inspect, Record or Selector Lab on it, uses the result solely to generate locator
> text shown in the side panel, and transmits nothing: there is no backend, no
> analytics and no network request of any kind. This is verifiable — the packaged
> code contains no `fetch` or `XMLHttpRequest`, which the build enforces.

### Data handling declarations

Tick **no** for every data-collection category. LocatorLens has no server, sends
no telemetry and makes no network requests. The Firefox manifest declares this
formally via `browser_specific_settings.gecko.data_collection_permissions.required = ["none"]`.

Chrome additionally requires a hosted privacy-policy URL in the dashboard —
`PRIVACY_POLICY.md` is the source text; publish it at a stable URL and link it.

## 5. Chrome Web Store checklist

- [ ] `npm run verify` passes
- [ ] version bumped past the last **submitted** version (not just the published one)
- [ ] upload `dist/locatorlens-chrome-<version>.zip`
- [ ] single purpose: "generate and validate test locators for the current page"
- [ ] permission justifications from §4 pasted in
- [ ] privacy policy URL set and reachable
- [ ] data-collection questions all answered "no"
- [ ] screenshots (1280×800 or 640×400) show real functionality, no mockups

## 6. AMO checklist

- [ ] `npm run verify` passes
- [ ] version strictly greater than the currently listed one
- [ ] upload `dist/locatorlens-firefox-<version>.zip`
- [ ] source code is unminified and unbundled — the package ships the same files as
      the repository, so no "source code submission" step is required
- [ ] `browser_specific_settings.gecko.id` unchanged (`locatorlens@yogesh-bhatttk.com`);
      changing it creates a *new* add-on rather than updating the existing listing
- [ ] `strict_min_version` still correct for the APIs in use

## 7. If a submission is rejected

1. Record the exact reviewer text in `CHANGELOG.md` under the version.
2. Reproduce the finding against `dist/<target>/` — the reviewer read those bytes.
3. Add a failing assertion to `tests/package.test.mjs` if the finding is about what
   the package contains, so it cannot recur silently.
4. Fix, bump the version, rebuild, resubmit.
