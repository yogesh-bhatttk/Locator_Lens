# 🎯 LocatorLens: Playwright Tool (v1.1.0)

[![Chrome](https://img.shields.io/badge/Chrome-Ready-green?logo=google-chrome&logoColor=white)]()
[![Firefox](https://img.shields.io/badge/Firefox-Ready-orange?logo=firefox-browser&logoColor=white)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Repository](https://img.shields.io/badge/GitHub-Locator_Lens-blue?logo=github)](https://github.com/yogesh-bhatttk/Locator_Lens)

**LocatorLens** is a professional browser inspector purpose-built for **Playwright** automation engineers. It helps you instantly find the most stable, semantic locators for any element on any webpage.

---

## 📽 Features
- **🎯 Ranked Locators**: Instantly see `getByTestId()`, `getByRole()`, `getByLabel()`, and more, ranked by stability.
- **🛡 Stability Guard**: Automatically flags fragile CSS selectors or auto-generated IDs and tells you *why* to avoid them.
- **🎮 Continuous Inspection**: Toggle "Inspect Mode" once and capture multiple elements in sequence.
- **🛠 Code Explanations**: Deep-dive into *why* each locator was suggested based on Playwright best practices.
- **🚀 One-Click Copy**: Auto-copies the full Playwright command (`await page.getByRole(...)`) to your clipboard.
- **🖥 Cross-Browser**: Works flawlessly on Chrome, Edge, Brave, and Firefox.

---

## 🚀 Quick Start (Local Development)

### **1. Chrome, Edge, or Brave**
1.  Download or `git clone` this repository.
2.  Open your browser and navigate to `chrome://extensions`.
3.  Enable **"Developer mode"** (top-right).
4.  Click **"Load unpacked"** and select the project folder.

### 🛠️ Local Development (Zero Warnings)

To prevent "Unrecognized Key" warnings in the extension dashboard, load the specialized distribution folders:

- **Chrome / Edge / Brave**: Load the `dist-chrome` folder as an unpacked extension.
- **Firefox**: Load `manifest.json` from the `dist-firefox` folder as a temporary add-on.

Both folders are synced to the `src/` directory—edit once, see changes everywhere!

### **2. Firefox**
1.  Navigate to `about:debugging#/runtime/this-firefox`.
2.  Click **"Load Temporary Add-on..."**.
3.  Select the **`manifest.json`** file in the project folder.

---

## 📁 Project Structure

```text
├── manifests/          # Official Store versions (Chrome & Firefox)
├── src/                # Core JavaScript and HTML logic
│   ├── background.js   # Cross-browser Service Worker
│   ├── content.js      # Page injection & locator generation
│   ├── sidepanel.js    # Inspector UI & logic
│   └── sidepanel.html  # Modern UI sidebar
├── icons/              # High-res professional branding
└── manifest.json       # Universal manifest (Local Dev)
```

---

## 📦 Store Submission

To prepare the extension for official store release, we provide strict, pre-configured manifests in the **`manifests/`** folder:

### **For Chrome Web Store**
- Copy `manifests/manifest.chrome.json` to the root as `manifest.json`.
- Zip the `manifest.json`, `src/`, and `icons/` folders.

### **For Firefox Add-ons (AMO)**
- Copy `manifests/manifest.firefox.json` to the root as `manifest.json`.
- Zip the `manifest.json`, `src/`, and `icons/` folders.

---

## 👨‍💻 Contributing
Feel free to open issues or submit pull requests to help make **LocatorLens** the best Playwright inspector in the world!

🔗 **GitHub Repository**: [https://github.com/yogesh-bhatttk/Locator_Lens](https://github.com/yogesh-bhatttk/Locator_Lens)

### **Current Roadmap:**
- [ ] AI-powered locator refinement (coming soon)
- [ ] Multiple framework support (Cypress, Selenium)
- [ ] Custom `testId` attribute configuration

---

## 📄 License
This project is licensed under the **MIT License**.

Developed with ❤️ for the Playwright community.
