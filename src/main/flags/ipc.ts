// Electron wiring for flags and clips: the window.flags IPC handlers, clip
// update events, and the clip:// protocol. The logic is in FlagsService, which
// the CLI (scripts/flags.ts) shares.
//
// The clip scheme must also be registered as privileged before the app is
// ready: see CLIP_SCHEME_PRIVILEGES in src/main/index.ts.

import { app, BrowserWindow, ipcMain, protocol, type IpcMainInvokeEvent } from 'electron';
import { CLIP_SCHEME, FLAGS_IPC } from '../../shared/flags-bridge';
import { createClipHandler } from '../clips/protocol';
import { FlagsService, parseNewFlag } from './service';

export interface FlagsMainOptions {
  sessionsDir: string;
  /** Throws unless the IPC sender is our own page (see PresageMain.assertOwnPage). */
  assertOwnPage: (event: IpcMainInvokeEvent) => void;
  /** DATABASE_URL or null; read at every sync. */
  databaseUrl: () => string | null;
}

export interface FlagsMain {
  readonly service: FlagsService;
  /** Mirrors a session's flags and clips to TigerData once the session itself is there. */
  afterSessionUpload(sessionId: string): void;
  /** Mirrors flags and clips that changed while TigerData was unreachable. */
  syncPending(): Promise<void>;
}

const asSessionId = (v: unknown): string => {
  if (typeof v !== 'string') throw new Error('sessionId must be a string');
  return v;
};

export function setupFlagsMain(options: FlagsMainOptions): FlagsMain {
  const { sessionsDir, assertOwnPage } = options;
  const service = new FlagsService({ sessionsDir, databaseUrl: options.databaseUrl });

  ipcMain.handle(FLAGS_IPC.list, (event, sessionId: unknown) => {
    assertOwnPage(event);
    return service.list(asSessionId(sessionId));
  });
  ipcMain.handle(FLAGS_IPC.add, (event, sessionId: unknown, flag: unknown) => {
    assertOwnPage(event);
    return service.add(asSessionId(sessionId), parseNewFlag(flag));
  });
  ipcMain.handle(FLAGS_IPC.runDetectors, (event, sessionId: unknown) => {
    assertOwnPage(event);
    return service.runDetectors(asSessionId(sessionId));
  });
  ipcMain.handle(FLAGS_IPC.generateClips, async (event, sessionId: unknown) => {
    assertOwnPage(event);
    await service.generateClips(asSessionId(sessionId));
  });

  service.onClipUpdate((clip) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(FLAGS_IPC.clipUpdate, clip);
  });

  protocol.handle(CLIP_SCHEME, createClipHandler(sessionsDir));
  app.on('will-quit', () => service.shutdown());

  return {
    service,
    afterSessionUpload: (sessionId) => service.scheduleSync(sessionId),
    syncPending: () => service.syncPending(),
  };
}
