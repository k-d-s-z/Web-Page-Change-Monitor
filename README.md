Web Page Change Monitor
![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)
![Manifest](https://img.shields.io/badge/manifest-v3-green.svg)
![License](https://img.shields.io/badge/license-GPLv3-orange.svg)
An open-source browser extension built for Chromium-based browsers (Google Chrome, Brave, Microsoft Edge, Opera, etc.) designed for real-time monitoring, state tracking, and interface management.
🚀 Key Features
⚡ Manifest V3 Compliant – Built using the latest Chromium extensions standard for enhanced security and performance.
🔄 Background Service Worker – Handles persistent background tasks, alarms, events, and background sync (`background.js`).
🗂️ Dynamic Card System & Drag & Drop – Interactive dashboard interface with custom layout organization (`cards.js`, `drag.js`).
🌐 Internationalization Support (i18n) – Built-in localization architecture for seamless multi-language support (`i18n.js`).
💾 Storage & Backup Management – Reliable persistent data storage with import/export backup capabilities (`storage.js`, `monitoring-backup.json`).
🎨 Popup Interface – Clean and responsive popup UI managed via `popup.html` and `popup.js`.
---
🛠️ Project Structure
```text
.
├── manifest.json              # Extension manifest (Manifest V3 configuration)
├── background.js              # Background service worker script
├── popup.html                 # Main extension popup view
├── popup.js                   # Popup interface logic and event handling
├── storage.js                 # Chrome Storage API wrapper and storage utilities
├── cards.js                   # UI card component generation and state rendering
├── drag.js                    # Drag-and-drop interaction functionality
├── shared.js                  # Common helper utilities and shared constants
├── i18n.js                    # Localization and language helper functions
├── monitoring-backup.json     # Sample/default backup dataset
├── eslint.config.js           # ESLint configuration for code quality
├── package.json               # Node.js dependencies and project scripts
└── icon16.png / 48 / 128      # Extension icons
```
---
📦 Installation (Developer Mode)
Clone the repository:
```bash
   git clone https://github.com/k-d-s-z/Web-Page-Change-Monitor.git
   ```
Open Extensions in your browser:
Chrome / Brave: `chrome://extensions/`
Microsoft Edge: `edge://extensions/`
Enable Developer Mode:
Toggle the Developer mode switch in the top-right corner.
Load the Extension:
Click the Load unpacked button.
Select the directory containing this project repository.
---
🧑‍💻 Development
This project includes pre-configured tools for code quality and linting.
Install Dependencies
```bash
npm install
```
Run Linter
```bash
npm run lint
```
---
📄 License
This project is licensed under the GNU General Public License v3.0 (GPLv3). See the LICENSE file for details.
---
🤝 Contributing
Contributions, issues, and feature requests are welcome!
Fork the project.
Create your feature branch (`git checkout -b feature/AmazingFeature`).
Commit your changes (`git commit -m 'Add some AmazingFeature'`).
Push to the branch (`git push origin feature/AmazingFeature`).
Open a Pull Request.
