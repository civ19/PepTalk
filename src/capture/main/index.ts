// Main-process half of session capture: owns sessions/<id>/ on disk, remuxes
// the video, and uploads to TigerData. The renderer never touches the file
// system or the database.
//
//   sessions/<id>/session.json        written at begin, updated as info arrives, finalized at finish
//   sessions/<id>/samples.ndjson      appended every ~500 ms
//   sessions/<id>/recording.raw.<ext> MediaRecorder chunks, appended every second
//   sessions/<id>/recording.<ext>     remuxed at finish; the raw file is then deleted
//
// Crash safety: everything the renderer sent is already on disk. On the next
// launch, sessions still marked 'recording' are finalized as 'interrupted'
// (remuxed, counted) and uploaded like any other.

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { SESSION_SCHEMA_VERSION, type SampleRecord, type Session, type UploadState } from '../../shared/session-types';
import { CAPTURE_IPC, type FinishRequest, type SessionPatch, type UploadStatusEvent } from '../bridge';
import { databaseUrlFromEnv as databaseUrl, parseSamples, uploadSession } from './db';
import { writeJsonAtomic } from './files';
import { probe, remux } from './media';

export interface CaptureMainOptions {
  sessionsDir: string;
  /** Throws unless the IPC sender is our own page (see PresageMain.assertOwnPage). */
  assertOwnPage: (event: IpcMainInvokeEvent) => void;
  /** Called after a session's rows reached TigerData (e.g. to upload its flags and clips too). */
  onUploaded?: (sessionId: string) => void;
}

export interface CaptureMain {
  /** Finalizes sessions left 'recording' by a crash, then uploads anything not yet uploaded. */
  recoverAndUploadPending(): Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// How long quitting waits for in-flight remux/upload work.
const QUIT_WAIT_MS = 30_000;

const extFor = (mimeType: string): 'mp4' | 'webm' => (mimeType.startsWith('video/mp4') ? 'mp4' : 'webm');

function isSampleRecord(v: unknown): v is SampleRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (r['kind'] === 'vitals' || r['kind'] === 'face' || r['kind'] === 'validation') && typeof r['tMs'] === 'number' && Number.isFinite(r['tMs']);
}

export function setupCaptureMain(options: CaptureMainOptions): CaptureMain {
  const { sessionsDir, assertOwnPage, onUploaded } = options;
  // DATABASE_URL may live in .env next to the app (loadEnvFile never overrides what's already set).
  const envFile = join(app.getAppPath(), '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const appVersion = app.getVersion();
  // Per-session work queues keep appends, updates and finish strictly ordered.
  const queues = new Map<string, Promise<unknown>>();
  const pending = new Set<Promise<unknown>>();

  const dirOf = (id: string): string => {
    if (!UUID_RE.test(id)) throw new Error(`invalid session id: ${id}`);
    return join(sessionsDir, id);
  };
  const enqueue = <T>(id: string, job: () => Promise<T>): Promise<T> => {
    const next = (queues.get(id) ?? Promise.resolve()).then(job, job);
    const tracked = next.catch(() => undefined);
    queues.set(id, tracked);
    pending.add(tracked);
    void tracked.finally(() => pending.delete(tracked));
    return next;
  };
  const readSession = async (id: string): Promise<Session> =>
    JSON.parse(await readFile(join(dirOf(id), 'session.json'), 'utf8')) as Session;
  const saveSession = (s: Session): Promise<void> => writeJsonAtomic(join(dirOf(s.id), 'session.json'), s);

  const broadcast = (e: UploadStatusEvent): void => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(CAPTURE_IPC.uploadStatus, e);
  };

  /** Remuxes the raw recording (if any) and fills in duration, counts and container start. */
  async function finalize(s: Session, status: Session['status'], wallClockDurationMs: number | null): Promise<Session> {
    const dir = dirOf(s.id);
    const ext = extFor(s.video.mimeType);
    const raw = join(dir, `recording.raw.${ext}`);
    const out = join(dir, `recording.${ext}`);
    if (existsSync(raw)) {
      try {
        await remux(raw, out);
        await rm(raw, { force: true });
        s.video.remuxed = true;
        s.recordingPath = `recording.${ext}`;
      } catch (err) {
        console.error(`[capture] ${s.id}: remux failed, keeping the raw recording`, err);
        s.video.remuxed = false;
        s.recordingPath = `recording.raw.${ext}`;
      }
    } else if (existsSync(out)) {
      s.recordingPath = `recording.${ext}`;
    }
    if (s.recordingPath) {
      const info = await probe(join(dir, s.recordingPath)).catch(() => null);
      s.durationMs = info?.durationMs ?? wallClockDurationMs;
      if (s.clock) s.clock.containerStartMs = info?.startMs ?? null;
    }
    const text = await readFile(join(dir, 'samples.ndjson'), 'utf8').catch(() => '');
    const recs = parseSamples(text);
    s.counts = {
      vitals: recs.filter((r) => r.kind === 'vitals').length,
      face: recs.filter((r) => r.kind === 'face').length,
      validation: recs.filter((r) => r.kind === 'validation').length,
    };
    s.status = status;
    if (!databaseUrl()) s.upload = { status: 'not-configured', attemptedAt: null, error: 'DATABASE_URL is not set' };
    await saveSession(s);
    return s;
  }

  async function upload(id: string): Promise<UploadState> {
    const s = await readSession(id);
    const url = databaseUrl();
    let uploaded = false;
    if (!url) {
      s.upload = { status: 'not-configured', attemptedAt: null, error: 'DATABASE_URL is not set' };
    } else {
      const attemptedAt = new Date().toISOString();
      try {
        const n = await uploadSession(url, dirOf(id), s);
        s.upload = { status: 'uploaded', attemptedAt, error: null };
        console.info(`[capture] ${id}: uploaded ${n.face} face, ${n.vitals} vitals, ${n.validation} validation rows`);
        uploaded = true;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        s.upload = { status: 'failed', attemptedAt, error };
        console.error(`[capture] ${id}: upload failed (local copy kept; retry from the app): ${error}`);
      }
    }
    await saveSession(s);
    broadcast({ sessionId: id, upload: s.upload });
    if (uploaded) onUploaded?.(id);
    return s.upload;
  }

  ipcMain.handle(CAPTURE_IPC.begin, async (event) => {
    assertOwnPage(event);
    const id = randomUUID();
    const dir = dirOf(id);
    await mkdir(dir, { recursive: true });
    const session: Session = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      id,
      startedAtIso: new Date().toISOString(),
      durationMs: null,
      recordingPath: null,
      appVersion,
      clock: null,
      video: { mimeType: '', width: null, height: null, frameRate: null, hasAudio: false, remuxed: false },
      status: 'recording',
      counts: { vitals: 0, face: 0, validation: 0 },
      upload: { status: 'pending', attemptedAt: null, error: null },
    };
    await saveSession(session);
    return { id, dir };
  });

  ipcMain.handle(CAPTURE_IPC.update, (event, id: string, patch: SessionPatch) => {
    assertOwnPage(event);
    return enqueue(id, async () => {
      const s = await readSession(id);
      if (patch.clock) s.clock = patch.clock;
      if (patch.video) s.video = patch.video;
      if (typeof patch.startedAtIso === 'string') s.startedAtIso = patch.startedAtIso;
      await saveSession(s);
    });
  });

  ipcMain.handle(CAPTURE_IPC.appendVideo, (event, id: string, chunk: unknown) => {
    assertOwnPage(event);
    if (!(chunk instanceof Uint8Array)) throw new Error('appendVideo: chunk must be a Uint8Array');
    return enqueue(id, async () => {
      const s = await readSession(id);
      if (!s.video.mimeType) throw new Error('appendVideo before the video mime type was set');
      await appendFile(join(dirOf(id), `recording.raw.${extFor(s.video.mimeType)}`), chunk);
    });
  });

  ipcMain.handle(CAPTURE_IPC.appendSamples, (event, id: string, records: unknown) => {
    assertOwnPage(event);
    if (!Array.isArray(records) || !records.every(isSampleRecord)) throw new Error('appendSamples: expected SampleRecord[]');
    if (records.length === 0) return;
    const text = `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
    return enqueue(id, () => appendFile(join(dirOf(id), 'samples.ndjson'), text, 'utf8'));
  });

  ipcMain.handle(CAPTURE_IPC.finish, (event, id: string, req: FinishRequest) => {
    assertOwnPage(event);
    const done = enqueue(id, async () => finalize(await readSession(id), 'complete', req.wallClockDurationMs || null));
    // Upload in the background; the renderer hears about it via uploadStatus.
    void done.then(() => enqueue(id, () => upload(id))).catch(() => undefined);
    return done;
  });

  ipcMain.handle(CAPTURE_IPC.discard, (event, id: string) => {
    assertOwnPage(event);
    return enqueue(id, () => rm(dirOf(id), { recursive: true, force: true }));
  });

  ipcMain.handle(CAPTURE_IPC.retryUpload, (event, id: string) => {
    assertOwnPage(event);
    return enqueue(id, () => upload(id));
  });

  ipcMain.handle(CAPTURE_IPC.listSessions, async (event): Promise<Session[]> => {
    assertOwnPage(event);
    const names = await readdir(sessionsDir).catch(() => [] as string[]);
    const sessions = await Promise.all(names.filter((n) => UUID_RE.test(n)).map((n) => readSession(n).catch(() => null)));
    return sessions.filter((s): s is Session => s !== null).sort((a, b) => b.startedAtIso.localeCompare(a.startedAtIso));
  });

  // Let in-flight remux/upload work finish before the process exits.
  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting || pending.size === 0) return;
    e.preventDefault();
    quitting = true;
    console.info(`[capture] waiting for ${pending.size} save/upload job(s) before quitting`);
    const timeout = new Promise((resolve) => setTimeout(resolve, QUIT_WAIT_MS));
    void Promise.race([Promise.allSettled([...pending]), timeout]).then(() => app.quit());
  });

  return {
    async recoverAndUploadPending() {
      let names: string[];
      try {
        names = await readdir(sessionsDir);
      } catch {
        return;
      }
      for (const name of names) {
        if (!UUID_RE.test(name)) continue;
        let s: Session;
        try {
          s = await readSession(name);
        } catch {
          continue;
        }
        if (s.status === 'recording') {
          console.warn(`[capture] ${s.id}: session was interrupted; recovering what was saved`);
          await enqueue(s.id, () => finalize(s, 'interrupted', null)).catch((err: unknown) => console.error(`[capture] ${s.id}: recovery failed`, err));
        }
        if (databaseUrl() && s.upload.status !== 'uploaded' && s.clock) {
          await enqueue(s.id, () => upload(s.id)).catch(() => undefined);
        }
      }
    },
  };
}
