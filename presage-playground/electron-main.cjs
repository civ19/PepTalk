const { app, BrowserWindow, ipcMain, session } = require('electron');
const { loadEnvFile } = require('node:process');
const path = require('node:path');
const { bindSmartSpectraIpc } = require('@smartspectra/node-sdk/main');

try {
  loadEnvFile(path.join(__dirname, '..', '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

ipcMain.handle('demo:api-key', () => process.env.SMARTSPECTRA_API_KEY?.trim() || '');

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media' && webContents.getURL().startsWith('file://'));
  });

  const window = new BrowserWindow({
    width: 1060,
    height: 780,
    minWidth: 700,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'dist', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  bindSmartSpectraIpc(window);
  window.loadFile(path.join(__dirname, 'preview.html'));

  if (process.env.SMARTSPECTRA_PREVIEW_SMOKE === '1') {
    window.webContents.once('did-finish-load', async () => {
      const bridgeReady = await window.webContents.executeJavaScript(
        "typeof window.demo?.getApiKey === 'function' && typeof window.__smartspectraBridge?.attach === 'function'",
      );
      console.log(bridgeReady ? 'Preview bridges loaded' : 'Preview bridge missing');
      app.exit(bridgeReady ? 0 : 1);
    });
  }
});

app.on('window-all-closed', () => app.quit());
