import { app, BrowserWindow, protocol } from 'electron';
import { join } from 'node:path';
import { setupCaptureMain } from '../capture/main';
import { databaseUrlFromEnv } from '../capture/main/db';
import { setupPresageMain, type PresageMain } from '../presage/main';
import { CLIP_SCHEME } from '../shared/flags-bridge';
import { CLIP_SCHEME_PRIVILEGES } from './clips/protocol';
import { setupFlagsMain } from './flags/ipc';

const rendererFile = join(__dirname, '../renderer/index.html');
const devServerUrl = process.env['ELECTRON_RENDERER_URL'];

// Must happen before 'ready', and Electron takes only one call: register any
// other privileged schemes in this same list.
protocol.registerSchemesAsPrivileged([{ scheme: CLIP_SCHEME, privileges: CLIP_SCHEME_PRIVILEGES }]);

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
  const { sessionsDir, assertOwnPage } = presage;
  const flags = setupFlagsMain({ sessionsDir, assertOwnPage, databaseUrl: databaseUrlFromEnv });
  // A session's flags and clips go to TigerData right after the session itself does.
  const capture = setupCaptureMain({ sessionsDir, assertOwnPage, onUploaded: (id) => flags.afterSessionUpload(id) });
  console.log(`[main] sessions will be written to ${sessionsDir}`);
  createWindow(presage);
  void capture.recoverAndUploadPending().then(() => flags.syncPending());
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(presage);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
