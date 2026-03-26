# 🎯 LocatorLens: Lumina Cyber HUD (v1.5.0)

[![Chrome](https://img.shields.io/badge/Chrome-Ready-green?logo=google-chrome&logoColor=white)]()
[![Firefox](https://img.shields.io/badge/Firefox-Ready-orange?logo=firefox-browser&logoColor=white)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**LocatorLens** is a next-generation, high-fidelity browser inspector for modern automation engineers. Featuring the **Lumina Cyber HUD**, it provides real-time, multi-framework locator generation with deep-trace "X-Ray" vision for even the most complex web applications.

---

## 📽 Key Features

### 1. 🌌 Lumina Cyber HUD
Experience a tactical-grade developer interface with holographic animations, scanline textures, and a high-focus obsidian/cyan aesthetic. 

### 2. 🛰️ Universal Framework Matrix
Switch between **Playwright**, **Selenium (Python/Java/C#)**, and **Cypress** on-the-fly. The HUD instantly translates semantic locators into the correct syntax for your chosen framework.

### 3. 🧬 Shadow DOM X-Ray Vision
Pierce the veil of encapsulated Web Components. Our **Deep-Trace Engine** automatically identifies Shadow Roots and provides "Shadow-aware" locators that work where others fail.

### 4. 🕹️ Precision Navigation
Use **Arrow Up/Down** keyboard shortcuts to traverse the DOM tree. Our "Boundary Jumper" logic allows you to navigate in and out of Shadow DOM layers seamlessly.

### 5. 🛡️ Stability Intelligence
- **Ranked Locators**: Automatically prioritizes `getByTestId()`, `getByRole()`, and `getByLabel()`.
- **Anti-Ghost Guard**: Total event-listener decommissioning ensures zero "ghost-hover" effects when inspection is stopped.
- **Auto-Sync**: Real-time state synchronization between Popup, Sidepanel, and Page.

---

## 🚀 Quick Start (Masterpiece Edition)

### **1. Initial Setup (Zero-Warning Mode)**
To ensure you have 0 warnings in your browser, run the setup script for your target platform:
- **Windows**: Open terminal in project root and run `setup.bat chrome` (or `firefox`)
- **Mac/Linux**: Open terminal in project root and run `./setup.sh chrome` (or `firefox`)

### **2. Chrome, Edge, or Brave**
1.  Open your browser and navigate to `chrome://extensions`.
2.  Enable **"Developer mode"** (top-right).
3.  Click **"Load unpacked"** and select the **root project folder**.

### **3. Firefox**
1.  Navigate to `about:debugging#/runtime/this-firefox`.
2.  Click **"Load Temporary Add-on..."**.
3.  Select the **`manifest.json`** file in the root project folder.

---

## 📁 Project Structure

```text
├── src/                # Core JavaScript and HTML logic
│   ├── background.js   # Master Relay & Navigation Shield
│   ├── content.js      # Deep-Trace X-Ray Engine & Page Injection
│   ├── sidepanel.js    # Multi-Framework Translator & HUD Logic
│   └── sidepanel.html  # Lumina Cyber HUD UI (CSS/HTML)
├── dist-chrome/        # Chrome-optimized build (Junctioned)
├── dist-firefox/       # Firefox-optimized build (Junctioned)
└── icons/              # High-fidelity Lumina branding icons
```

---

## 👨‍💻 Engineering Insights
LocatorLens follows a **Semantic-First** philosophy. It ignores brittle XPaths and CSS coordinates whenever possible, focusing instead on the underlying **Accessibility Tree** to ensure your tests survive UI redesigns.

🔗 **GitHub Repository**: [https://github.com/yogesh-bhatttk/Locator_Lens](https://github.com/yogesh-bhatttk/Locator_Lens)

Developed with ⚡️ and 🧠 for the global automation community.
