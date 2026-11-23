# RM Automation Desktop (Electron)

Wraps `https://mulakhail.rmautomation.workers.dev` into a standalone Windows/macOS desktop app with the RM Automation icon, persistent sessions, and external browser Google Drive OAuth support.

## Option 1: Build `.exe` Automatically on GitHub (Recommended)
1. Push your repository to GitHub.
2. Open your repository on GitHub -> click the **Actions** tab.
3. Click **Build RM Automation Desktop (.exe)** -> **Run workflow**.
4. Wait ~2 minutes, open the completed run, and download **RM-Automation-Windows-Installer** from **Artifacts**.

## Option 2: Build `.exe` on Your Windows PC
1. Install **Node.js (20+)** from `https://nodejs.org`.
2. Double-click `BUILD-EXE.bat` inside the `desktop` folder (or run `npm install` then `npm run build` in CMD).
3. Find `RM-Automation-Setup-1.0.0.exe` and `RM-Automation-Portable-1.0.0.exe` in `desktop/dist/`.
