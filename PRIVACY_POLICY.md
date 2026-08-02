# Privacy Policy – LocatorLens

**Last updated:** August 2, 2026

## Overview

LocatorLens is a browser extension for test authoring. It inspects web page elements
and surfaces ranked, uniqueness-checked locators, validates selectors against the live
page (Selector Lab), and optionally records your interactions into a runnable test
script for **Playwright**, **Selenium** or **Cypress** in TypeScript, JavaScript or
Python. Everything runs locally in your browser.

## Data collection and transmission

**LocatorLens does not collect, store, or transmit your data to LocatorLens servers.** There are no LocatorLens-operated backends, analytics endpoints, or advertising SDKs.

Specifically, we do **not**:

- Collect personal information (name, email, address, etc.) for our own use
- Log your browsing history to a remote service
- Use third-party analytics or crash reporting tied to our infrastructure
- Sell or broker user data

## How the extension works

- The content script reads the DOM of the active page **only while you use inspection, recording, selector validation, or related features you start**.
- Locator ranking and explanations run **entirely in your browser** (see `content-locator-engine.js` and `content.js`).
- The side panel and popup run in extension UI contexts; they do not send page content to us.

## Data kept locally on your device

Chrome’s `chrome.storage.local` (or the equivalent in other Chromium-based browsers / Firefox) may persist **only for your convenience**, for example:

- Last inspection result (so the side panel can show it after reopening)
- Your chosen output framework and language
- Any custom test-id attributes you configure
- Recorder timeline / generated script draft (if you use recording)
- Other UI preferences

This data **stays on your machine** inside the browser profile. It is **not** synced to LocatorLens by the extension itself.

**Export / import:** If you use **Download**, **Export session**, or copy generated code, that is **you** saving or sharing data through your OS or clipboard—not an automatic upload by LocatorLens.

## Permissions

Permissions are used **only** to deliver the features below. Exact lists may vary slightly by browser; see `manifest.json` and `manifests/manifest.*.json` for the authoritative set.

| Permission / access                       | Purpose                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `activeTab`                               | Operate on the tab you are using when you invoke the extension                                    |
| `scripting`                               | Inject the inspector / recorder / selector-lab logic when needed                                  |
| `storage`                                 | Persist local preferences and saved POM data (see above)                                          |
| `contextMenus`                            | Optional quick actions from the right-click menu (where enabled)                                  |
| `clipboardWrite`                          | Write a locator you asked to copy to your clipboard                                               |
| `sidePanel` (Chromium)                    | Show results in the browser side panel                                                            |
| `host_permissions` / `<all_urls>` matches | Allow the content script to run on pages you open so inspection and validation work on your sites |

## Third-party services

**None.** LocatorLens bundles no third-party libraries, loads no code or assets from
any remote origin, and embeds no trackers, analytics or ads. The published package
contains only the files listed in this repository's `src/` and `icons/` directories.

The extension makes no network requests of any kind — there is no `fetch` or
`XMLHttpRequest` in the shipped code, and the build refuses to produce a package
that contains one.

## Changes to this policy

Updates will be reflected in this document with a revised **Last updated** date.

## Contact

Questions about this policy: open an issue on the [GitHub repository](https://github.com/yogesh-bhatttk/Locator_Lens).
