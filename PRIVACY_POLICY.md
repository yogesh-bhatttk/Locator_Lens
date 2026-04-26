# Privacy Policy – LocatorLens

**Last updated:** April 27, 2026

## Overview

LocatorLens is a browser extension that inspects web page elements and surfaces **Playwright**-style locators, a selector lab, optional interaction recording, and a Page Object Model (POM) builder. Your privacy is important to us.

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
- Saved POM elements and related settings (actions/JSDoc toggles)
- Recorder timeline / generated script draft (if you use recording)
- Other UI preferences

This data **stays on your machine** inside the browser profile. It is **not** synced to LocatorLens by the extension itself.

**Export / import:** If you use **Download**, **Export session**, or copy generated code, that is **you** saving or sharing data through your OS or clipboard—not an automatic upload by LocatorLens.

## Permissions

Permissions are used **only** to deliver the features below. Exact lists may vary slightly by browser; see `manifest.json` and `manifests/manifest.*.json` for the authoritative set.

| Permission / access | Purpose |
|---------------------|---------|
| `activeTab` | Operate on the tab you are using when you invoke the extension |
| `scripting` | Inject the inspector / recorder / selector-lab logic when needed |
| `storage` | Persist local preferences and saved POM data (see above) |
| `contextMenus` | Optional quick actions from the right-click menu (where enabled) |
| `sidePanel` (Chromium) | Show results in the browser side panel |
| `host_permissions` / `<all_urls>` matches | Allow the content script to run on pages you open so inspection and validation work on your sites |

## Third-party services

- **Vis-Network** (loaded from `unpkg.com`) is used **only** in the optional local `graphify-out/graph.html` architecture viewer, if you open that file. It is not used by the extension runtime against arbitrary pages you visit for inspection.
- The extension itself does **not** embed remote trackers or ads.

## Changes to this policy

Updates will be reflected in this document with a revised **Last updated** date.

## Contact

Questions about this policy: open an issue on the [GitHub repository](https://github.com/yogesh-bhatttk/Locator_Lens).
