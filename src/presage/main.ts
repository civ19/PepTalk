// Main-process half of the Presage module. The host app calls
// setupPresageMain() once, then attachWindow(win) for the window that runs
// the tracker. Nothing outside src/presage imports the SDK.

import { app, ipcMain, session, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IPC } from './bridge';

type SdkMainModule = typeof import('@smartspectra/node-sdk/main');

export interface PresageMainOptions {
  /** Absolute path of the bundled renderer page (the only file:// page allowed the camera). */
  rendererFile: string;
  /** Dev-server URL (electron-vite's ELECTRON_RENDERER_URL); its origin is trusted in dev. */
  devServerUrl?: string | undefined;
  /**
   * Media types the permission handler may grant. Defaults to camera only.
   * Add 'audio' once the host app records speech for transcription.
   */
  allowedMediaTypes?: ReadonlyArray<'video' | 'audio'>;
  /** Where session JSON is written. Defaults to ./sessions in dev, <userData>/sessions when packaged. */
  sessionsDir?: string;
}

export interface PresageMain {
  /** Wire the SmartSpectra IPC bridge and harden navigation for a window running the tracker. */
  attachWindow(win: BrowserWindow): void;
  readonly sessionsDir: string;
}

const NATIVE_LIB: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'smartspectra_capi.dll',
  darwin: 'libsmartspectra_capi.dylib',
  linux: 'libsmartspectra_capi.so',
};

/**
 * In a packaged app the native runtime ships as an extra resource at
 * resources/smartspectra/ (a DLL can't be loaded from inside app.asar), so point
 * the SDK's resolver there. Must run before the SDK is first required.
 */
function pointSdkAtPackagedRuntime(): void {
  if (!app.isPackaged || process.env['SMARTSPECTRA_CAPI_PATH']) return;
  const lib = NATIVE_LIB[process.platform];
  if (!lib) {
    console.error(`[presage] packaged build on unsupported platform ${process.platform}; native runtime will not load`);
    return;
  }
  process.env['SMARTSPECTRA_CAPI_PATH'] = join(process.resourcesPath, 'smartspectra', lib);
}

/** PRESAGE_API_KEY from the environment, falling back to .env in the app directory. Not bundled anywhere. */
function readApiKey(): string | null {
  if (!process.env['PRESAGE_API_KEY']) {
    const envFile = join(app.getAppPath(), '.env');
    // loadEnvFile never overrides variables that are already set.
    if (existsSync(envFile)) process.loadEnvFile(envFile);
  }
  const key = process.env['PRESAGE_API_KEY']?.trim();
  return key ? key : null;
}

function isoFileStem(epochMs: number): string {
  // ':' is not allowed in Windows file names.
  return new Date(epochMs).toISOString().replace(/:/g, '-');
}

function isSummaryLike(v: unknown): v is { schemaVersion: 1; startedAtEpochMs: number } {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return r['schemaVersion'] === 1 && typeof r['startedAtEpochMs'] === 'number' && Number.isFinite(r['startedAtEpochMs']);
}

// How long the renderer gets to stop the SDK (and save the session) on close.
const SHUTDOWN_TIMEOUT_MS = 10_000;
// After the renderer reports done, give the main-process SDK time to finish its
// native teardown. Closing while a session is still draining made koffi call
// back into a Node environment that was already exiting (fatal napi_throw).
const NATIVE_TEARDOWN_GRACE_MS = 750;

/**
 * Holds the window's first close until the renderer has stopped and destroyed
 * the SDK (see PresageHostBridge.onShutdownRequest), then closes for real.
 */
function interceptCloseForShutdown(win: BrowserWindow): void {
  let state: 'open' | 'shutting-down' | 'ready' = 'open';
  win.on('close', (event) => {
    if (state === 'ready') return;
    event.preventDefault();
    if (state === 'shutting-down') return;
    state = 'shutting-down';
    console.info('[presage] window closing: asking renderer to stop the SDK first');
    const wc = win.webContents;
    const finish = (): void => {
      clearTimeout(timer);
      ipcMain.removeListener(IPC.shutdownDone, onDone);
      setTimeout(() => {
        state = 'ready';
        console.info('[presage] SDK shut down; closing window');
        if (!win.isDestroyed()) win.close();
      }, NATIVE_TEARDOWN_GRACE_MS);
    };
    const onDone = (e: Electron.IpcMainEvent): void => {
      if (e.sender !== wc) return;
      console.info('[presage] renderer confirmed shutdown');
      finish();
    };
    const timer = setTimeout(() => {
      console.warn('[presage] renderer did not confirm shutdown in time; closing anyway');
      finish();
    }, SHUTDOWN_TIMEOUT_MS);
    ipcMain.on(IPC.shutdownDone, onDone);
    if (wc.isDestroyed() || wc.isCrashed()) finish();
    else wc.send(IPC.shutdownRequest);
  });
}

export function setupPresageMain(options: PresageMainOptions): PresageMain {
  pointSdkAtPackagedRuntime();
  // Lazy require: an ES import of an external is hoisted above the line above,
  // which would load the native runtime before SMARTSPECTRA_CAPI_PATH is set.
  const { bindSmartSpectraIpc } = require('@smartspectra/node-sdk/main') as SdkMainModule;

  const allowed = new Set(options.allowedMediaTypes ?? ['video']);
  const rendererHref = pathToFileURL(options.rendererFile).href;
  const devOrigin = options.devServerUrl ? new URL(options.devServerUrl).origin : null;
  const sessionsDir =
    options.sessionsDir ?? (app.isPackaged ? join(app.getPath('userData'), 'sessions') : join(app.getAppPath(), 'sessions'));

  const isOwnPage = (url: string): boolean => {
    if (!url) return false;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (devOrigin && parsed.origin === devOrigin) return true;
    if (parsed.protocol !== 'file:') return false;
    const bare = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    return process.platform === 'win32' ? bare.toLowerCase() === rendererHref.toLowerCase() : bare === rendererHref;
  };

  // Grant camera (and only the configured media types) to our own page; deny everything else.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = details.requestingUrl || wc.getURL();
    const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
    const ok =
      permission === 'media' && isOwnPage(url) && mediaTypes.length > 0 && mediaTypes.every((t) => allowed.has(t));
    if (!ok) console.warn(`[presage] denied permission "${permission}" (${mediaTypes.join(',') || '-'}) for ${url}`);
    callback(ok);
  });

  const assertOwnPage = (event: IpcMainInvokeEvent): void => {
    const url = event.senderFrame?.url ?? '';
    if (!isOwnPage(url)) throw new Error(`presage IPC rejected from untrusted page: ${url}`);
  };

  ipcMain.handle(IPC.getApiKey, (event) => {
    assertOwnPage(event);
    const key = readApiKey();
    if (!key) throw new Error('PRESAGE_API_KEY is not set. Copy .env.example to .env and add your key.');
    return key;
  });

  ipcMain.handle(IPC.saveSession, async (event, summary: unknown) => {
    assertOwnPage(event);
    if (!isSummaryLike(summary)) throw new Error('saveSession: payload is not a SessionSummary');
    await mkdir(sessionsDir, { recursive: true });
    const stem = isoFileStem(summary.startedAtEpochMs);
    const json = JSON.stringify(summary, null, 2);
    for (let n = 0; n < 100; n++) {
      const file = join(sessionsDir, `${stem}${n ? `-${n}` : ''}.json`);
      try {
        await writeFile(file, json, { encoding: 'utf8', flag: 'wx' });
        return file;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    throw new Error(`saveSession: could not find a free file name for ${stem}`);
  });

  return {
    sessionsDir,
    attachWindow(win) {
      // Owns one SDK per renderer connection and tears it down (releasing the
      // native session) when the window closes.
      bindSmartSpectraIpc(win);
      interceptCloseForShutdown(win);
      // The camera grant is tied to our page, so never let this window leave it.
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (event, url) => {
        if (!isOwnPage(url)) event.preventDefault();
      });
    },
  };
}
