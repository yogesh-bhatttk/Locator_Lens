# Privacy Policy – Locatra

**Last updated:** October 9, 2026

## Overview

Locatra is a browser extension for test authoring. It inspects web page elements
and surfaces ranked, uniqueness-checked locators, validates selectors against the live
page (Selector Lab), and optionally records your interactions into a runnable test
script for **Playwright**, **Selenium** or **Cypress** in TypeScript, JavaScript or
Python. Everything runs locally in your browser.

## Data collection and transmission

**Locatra does not collect or transmit your data.** There are no Locatra-operated
servers, analytics endpoints or advertising SDKs, and the extension makes no network
requests at all. The only data it keeps is stored locally in your browser, as
described below.

Specifically, we do **not**:

- Collect personal information (name, email, address, etc.) for our own use
- Log your browsing history to a remote service
- Use third-party analytics or crash reporting tied to our infrastructure
- Sell or broker user data

## How the extension works

- **When the content script runs.** The extension declares a content script for
  every `http://` and `https://` page. The browser loads it into each such page
  when the page finishes loading (`document_idle`). On load it only:
  - reads the extension's own settings from local storage (framework, language,
    your custom test-id attributes and secret variable names — see below);
  - registers a right-click (`contextmenu`) listener that remembers which element
    was right-clicked, so **Copy Best Locator** knows what to copy;
  - sends a short "ready" message to the extension's own background worker, which
    answers whether this tab is currently being inspected or recorded (so a
    recording continues after a navigation). The message contains no page
    content.
- **When it reads the page.** Element details, text and attributes are read only
  while you use a feature you started — Inspect, Record, Replay, Selector Lab,
  Stress Test, Page Object export, a locator health check or Copy Best Locator — and
  only for the elements involved.
- Locator ranking and explanations run **entirely in your browser** (see
  `content-locator-engine.js` and `content.js`).
- The side panel and popup run in extension UI contexts; they do not send page
  content anywhere.

## What is never recorded

- **Passwords and one-time codes.** Typing into a password field, or into a field
  marked as a one-time code or card number/security code (`autocomplete` values
  `current-password`, `new-password`, `one-time-code`, `cc-number`, `cc-csc`,
  `cc-exp`), is recorded as a step **without its value**. The generated test reads
  the value from an environment variable instead — `LOCATRA_PASSWORD` for passwords,
  `LOCATRA_SECRET` for the others (both names can be changed on the Settings page) —
  so the secret never leaves the page, never
  reaches extension storage and never appears in a script.
- **Secrets in URLs.** Before a page address is stored or written into a test, the
  values of query/fragment parameters that commonly carry credentials (`password`,
  `passwd`, `pwd`, `secret`, `client_secret`, `access_token`, `id_token`,
  `refresh_token`, `api_key`, `apikey`) are replaced with `REDACTED`.
- **File contents.** An upload step records only the selected file **names**, never
  the files.

## Data kept locally on your device

Everything below stays inside your browser profile. None of it is sent to
Locatra or anyone else, and the extension does not use synced storage.

`chrome.storage.local` (persists until you clear it or uninstall):

- **Last pick** — the locators and element details for the element you last
  inspected, and the page it came from, so the side panel can show it again after
  being reopened.
- **Recorder state** — the recorded steps (timeline) and the current text of the
  generated test script, so an in-progress recording survives closing the panel.
  Steps contain element descriptions, the values you typed into ordinary fields,
  and page addresses (with secret parameters redacted, as above). If you rename or
  edit a test-data variable, the new name and value are stored with the steps.
- **Preferences** — your chosen output framework and language.
- **Settings** (`llSettings`), edited on the extension's Settings page and partly in
  the side panel:
  - whether automatic assertion suggestions, step screenshots and test-data
    variables are switched on (all are, by default);
  - your custom test-id attribute names (such as `data-qa`);
  - the environment-variable names generated tests use for secrets;
  - whether watched locators are re-checked automatically.
    An older version stored custom test-id attributes under `customAttributes`; the
    Settings page moves them into `llSettings` and removes that key. A debug-logging
    flag (`llDebug`) is read if you set it yourself from the browser's developer tools.
- **Watched locators** (`llWatched`) — the locators you choose to watch for the
  locator health check, grouped by page address (origin and path only, no query or
  fragment). Each entry keeps the locator, a short description of its element (tag,
  id, test id, role, accessible name, label, placeholder, up to 80 characters of
  text, type, link address with secrets redacted, alt, title and a few class names)
  so a broken locator can be matched to its element again, and the result of the last
  check. Typed field values are never part of it. Export and import are files you
  choose to save or open; nothing is uploaded.

`chrome.storage.session` (cleared when the browser closes):

- The background worker's state — which tabs are being inspected or recorded, and
  whether a recording is paused or in assertion mode.
- Steps recorded while the side panel was closed, buffered until the panel opens
  again and takes them.

IndexedDB (database `locatra`, persists until you clear it or uninstall):

- **Step screenshots** — while you record, the extension takes a small screenshot
  of the visible tab after each recorded step (`chrome.tabs.captureVisibleTab`),
  shrinks it to a thumbnail and keeps it in IndexedDB so the timeline can show what
  each step did. Thumbnails never leave the browser: they are not uploaded, synced,
  or written into the generated script. Removing a step or clearing the timeline
  deletes its thumbnails, thumbnails older than 14 days are deleted automatically,
  and switching **Step screenshots** off in Settings stops capturing them. Like any
  screenshot, a thumbnail shows whatever was on screen — turn the setting off
  before recording pages that display sensitive information.

Features that work on what is already stored, entirely inside your browser:

- **Replay** runs the recorded steps again in your current tab, in the page itself.
  Values for password steps are asked for each time, used for that run only and
  never saved.
- **Page Object export** scans the elements of a region you pick (or the whole
  page) and generates a page-object class; the result is shown in the side panel
  for you to copy or download.
- **Locator health check** re-checks your watched locators against the page you
  have open, in that page, and suggests a replacement for one that broke. Results are
  stored with the watched locators.
- **Test-data variables** turn the values you typed into named variables in the
  generated script; you can rename them, edit them, or copy/download them as a JSON
  file.
- **Automatic assertion suggestions** watch, during a recording, for the page
  address changing and for confirmation messages appearing after you submit a form,
  and propose checks for them. Suggestions never contain the values of password or
  other sensitive fields, and nothing is added to your test until you accept it.

**Keyboard shortcuts** (Alt+Shift+E to inspect, Alt+Shift+K to record, changeable in
the browser) only start and stop features; they read nothing on their own.

**Copy and download:** if you copy generated code or download a script, that is
**you** saving or sharing it through your operating system or clipboard — not an
upload by Locatra.

## Permissions

Permissions are used **only** to deliver the features below. See
`manifests/manifest.chrome.json` and `manifests/manifest.firefox.json` for the
authoritative set.

| Permission / access                                  | Purpose                                                                                                                                                                                                                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activeTab`                                          | Act on the tab you are using at the moment you invoke the extension, even if you have restricted its site access to "on click"                                                                                                                              |
| `scripting`                                          | Inject the inspector / recorder / Selector Lab into pages that loaded before the extension did                                                                                                                                                              |
| `storage`                                            | Keep the last pick, the recorder state, your preferences and settings on your device (see above)                                                                                                                                                            |
| `contextMenus`                                       | The right-click "Copy Best Locator" and panel entries                                                                                                                                                                                                       |
| `sidePanel` (Chrome)                                 | Show results in the browser side panel (Firefox uses its built-in sidebar instead)                                                                                                                                                                          |
| `host_permissions`: `http://*/*` and `https://*/*`   | Run the content script on the web pages you test; no `file://` or other schemes are requested                                                                                                                                                               |
| `optional_host_permissions`: `<all_urls>` (optional) | Only for step screenshots: the browser's tab-capture API requires it. Asked for when you switch step screenshots on, never at install; you can decline and keep recording without thumbnails. Screenshots stay in local IndexedDB and are never transmitted |

## Third-party services

**None.** Locatra bundles no third-party libraries, loads no code or assets from
any remote origin, and embeds no trackers, analytics or ads. The published package
contains only the files listed in this repository's `src/` and `icons/` directories.

The extension makes no network requests of any kind. The shipped code contains no
`fetch`, `XMLHttpRequest`, `sendBeacon`, `WebSocket` or `EventSource`, loads nothing
from a remote URL, and the build refuses to produce a package that does.

## Changes to this policy

Updates will be reflected in this document with a revised **Last updated** date.

## Contact

Questions about this policy: open an issue on the [GitHub repository](https://github.com/yogesh-bhatttk/Locator_Lens).
