import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { setupCaptureMain } from '../capture/main';
import { setupPresageMain, type PresageMain } from '../presage/main';

const rendererFile = join(__dirname, '../renderer/index.html');
const devServerUrl = process.env['ELECTRON_RENDERER_URL'];

function createWindow(presage: PresageMain): void {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#0f1115',
    title: 'Presage Vitals Module',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  presage.attachWindow(win);
  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadFile(rendererFile);
}

app.whenReady().then(() => {
  // 'audio': the session recording includes the microphone.
  const presage = setupPresageMain({ rendererFile, devServerUrl, allowedMediaTypes: ['video', 'audio'] });
  const capture = setupCaptureMain({ sessionsDir: presage.sessionsDir, assertOwnPage: presage.assertOwnPage });
  console.log(`[main] sessions will be written to ${presage.sessionsDir}`);
  createWindow(presage);
  void capture.recoverAndUploadPending();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(presage);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
