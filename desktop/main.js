const path = require('node:path');
const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');

const APP_URL = 'https://mulakhail.rmautomation.workers.dev';
const ALLOWED_ORIGIN = new URL(APP_URL).origin;
const ICON_PATH = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

app.setAppUserModelId('com.rmautomation.desktop');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;

function isSafeExternalUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function safeOpenExternal(rawUrl) {
  if (!isSafeExternalUrl(rawUrl)) return false;
  shell.openExternal(String(rawUrl));
  return true;
}

function buildContextMenu(params) {
  const template = [];
  if (params.isEditable) {
    template.push(
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' }
    );
  } else if (params.selectionText) {
    template.push({ role: 'copy' }, { type: 'separator' }, { role: 'selectAll' });
  } else {
    template.push({ role: 'reload' }, { role: 'forceReload' });
  }
  return Menu.buildFromTemplate(template);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'RM Automation',
    icon: ICON_PATH,
    backgroundColor: '#090d16',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      partition: 'persist:rmautomation',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });

  mainWindow.webContents.on('context-menu', (_event, params) => {
    buildContextMenu(params).popup({ window: mainWindow });
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    safeOpenExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl.startsWith('file://')) return;
    try {
      const parsed = new URL(targetUrl);
      // Never open Google OAuth login inside Electron webview — Google blocks embedded webviews.
      if (parsed.origin !== ALLOWED_ORIGIN || parsed.pathname.startsWith('/auth/google/')) {
        event.preventDefault();
        safeOpenExternal(targetUrl);
      }
    } catch {
      event.preventDefault();
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, _errorDesc, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    if (validatedURL && !validatedURL.startsWith('file://')) {
      mainWindow.loadFile(path.join(__dirname, 'offline.html'));
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(APP_URL);
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

ipcMain.handle('desktop:open-external', (_event, rawUrl) => {
  return safeOpenExternal(rawUrl);
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
