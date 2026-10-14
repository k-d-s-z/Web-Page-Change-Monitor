\# Web Page Change Monitor



!\[Manifest](https://img.shields.io/badge/manifest-v3-green.svg)

!\[License](https://img.shields.io/badge/license-GPLv3-orange.svg)



An open-source browser extension built for Chromium-based browsers (Google Chrome, Brave, Microsoft Edge, Opera, etc.) designed for real-time monitoring, state tracking, and interface management.



\## 🚀 Key Features



\- ⚡ \*\*Manifest V3 Compliant\*\* – Built using the latest Chromium extensions standard for enhanced security and performance.

\- 🔄 \*\*Background Service Worker\*\* – Handles persistent background tasks, alarms, events, and conditional requests (`background.js`).

\- 🗂️ \*\*Dynamic Card System \& Drag \& Drop\*\* – Interactive dashboard interface with custom layout organization (`cards.js`, `drag.js`).

\- 👁️ \*\*Change Preview (diff)\*\* – When a change is detected, the previous and current snapshots are compared line-by-line with word-level highlighting on a dedicated page (`diff.html`, `diff.js`).

\- 🌐 \*\*Internationalization Support (i18n)\*\* – Built-in localization for English and Polish (`i18n.js`).

\- 💾 \*\*Storage \& Backup Management\*\* – Persistent data storage with import/export backup capabilities (`storage.js`).

\- 🎨 \*\*Popup Interface\*\* – Clean and responsive popup UI managed via `popup.html` and `popup.js`.



\## 🛠️ Project Structure



```text

.

├── manifest.json              # Extension manifest (Manifest V3 configuration)

├── background.js              # Background service worker script

├── popup.html                 # Main extension popup view

├── popup.js                   # Popup interface logic and event handling

├── storage.js                 # Messaging wrappers for the service worker

├── cards.js                   # UI card component generation and state rendering

├── drag.js                    # Drag-and-drop interaction functionality

├── i18n.js                    # Localization (EN/PL)

├── diff.html                  # Change preview page

├── diff.js                    # Diff rendering (LCS on lines + word diff)

├── eslint.config.js           # ESLint configuration for code quality

├── package.json               # Node.js dependencies and project scripts

└── icon16.png / 48 / 128      # Extension icons

