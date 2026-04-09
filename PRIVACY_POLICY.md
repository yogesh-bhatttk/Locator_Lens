# Privacy Policy – LocatorLens

**Last updated:** April 9, 2026

## Overview

LocatorLens is a browser extension that inspects web page elements and generates automation test locators. Your privacy is important to us.

## Data Collection

**LocatorLens does NOT collect, store, or transmit any user data.**

Specifically, we do NOT collect:
- Personal information (name, email, address, etc.)
- Browsing history or web activity
- Cookies or tracking data
- Authentication credentials
- Financial information
- Location data

## How the Extension Works

- LocatorLens reads the DOM structure of the active web page **only when you activate the inspector**.
- All processing happens **locally in your browser**. No data is sent to any external server.
- User preferences (such as selected framework) are stored **locally** using Chrome's `storage.local` API and never leave your device.

## Permissions

LocatorLens requests the following permissions, all used strictly for local functionality:

| Permission | Purpose |
|---|---|
| `activeTab` | Access the current tab's DOM for element inspection |
| `scripting` | Inject the inspector script into the active page |
| `storage` | Save user preferences locally |
| `contextMenus` | Add right-click menu for quick inspection |
| `sidePanel` | Display locator results in the browser side panel |
| `host_permissions` | Enable background tracking required for precise context menu functionality on all sites |

## Third-Party Services

LocatorLens does **not** use any third-party analytics, tracking, or advertising services.

## Data Sharing

We do **not** sell, transfer, or share any user data with third parties.

## Changes to This Policy

If we update this privacy policy, changes will be reflected in this document with an updated date.

## Contact

If you have questions about this privacy policy, please open an issue on the [GitHub repository](https://github.com/yogesh-bhatttk/Locator_Lens).
