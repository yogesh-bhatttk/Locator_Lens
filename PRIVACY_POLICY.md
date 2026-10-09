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
    and two optional advanced settings — see below);
  - registers a right-click (`contextmenu`) listener that remembers which element
    was right-clicked, so **Copy Best Locator** knows what to copy;
  - sends a short "ready" message to the extension's own background worker, which
    answers whether this tab is currently being inspected or recorded (so a
    recording continues after a navigation). The message contains no page
    content.
- **When it reads the page.** Element details, text and attributes are read only
  while you use a feature you started — Inspect, Record, Selector Lab, Stress Test
  or Copy Best Locator — and only for the elements involved.
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
  `LOCATRA_SECRET` for the others — so the secret never leaves the page, never
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
  and page addresses (with secret parameters redacted, as above).
- **Preferences** — your chosen output framework and language.
- **Advanced settings with no UI** — an optional list of additional attribute names
  to treat as test ids (`customAttributes`) and a debug-logging flag (`llDebug`).
  The extension only reads these; they exist only if you set them yourself from the
  browser's developer tools.

`chrome.storage.session` (cleared when the browser closes):

- The background worker's state — which tabs are being inspected or recorded, and
  whether a recording is paused or in assertion mode.
- Steps recorded while the side panel was closed, buffered until the panel opens
  again and takes them.

**Copy and download:** if you copy generated code or download a script, that is
**you** saving or sharing it through your operating system or clipboard — not an
upload by Locatra.

## Permissions

Permissions are used **only** to deliver the features below. See
`manifests/manifest.chrome.json` and `manifests/manifest.firefox.json` for the
authoritative set.

| Permission / access                                | Purpose                                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `activeTab`                                        | Act on the tab you are using at the moment you invoke the extension, even if you have restricted its site access to "on click" |
| `scripting`                                        | Inject the inspector / recorder / Selector Lab into pages that loaded before the extension did                                 |
| `storage`                                          | Keep the last pick, the recorder state and your preferences on your device (see above)                                         |
| `contextMenus`                                     | The right-click "Copy Best Locator" and panel entries                                                                          |
| `sidePanel` (Chrome)                               | Show results in the browser side panel (Firefox uses its built-in sidebar instead)                                             |
| `host_permissions`: `http://*/*` and `https://*/*` | Run the content script on the web pages you test; no `file://` or other schemes are requested                                  |

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
