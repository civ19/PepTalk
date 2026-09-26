// Flags and clips for recorded sessions: the logic behind window.flags, the
// flag/clips CLI and the TigerData mirror. No Electron imports (ipc.ts does the
// wiring), so scripts/flags.ts runs the same code in plain Node.
//
//   add / runDetectors   -> flags.json
//   generateClips        -> plan (clips/plan.ts) -> clips.json + flag.clipId
//                        -> cut missing files through a shared queue (2 at a time)
//                        -> clips.json status + onClipUpdate events
//   after each change    -> mirror to TigerData if the session is uploaded there

import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { FLAG_SEVERITIES, FLAG_TYPES, type Clip, type Flag, type FlagEvidence, type FlagSeverity, type FlagType, type NewFlag } from '../../shared/flags';
import type { SqlClient } from '../../capture/main/db';
import { probe } from '../../capture/main/media';
import { encodeClip, extractFrame } from '../clips/ffmpeg';
import { planClips, type PlannedClip } from '../clips/plan';
import { JobQueue } from '../clips/queue';
import { syncFlagsToDb, type FlagSyncCounts } from './db';
import { DETECTORS } from './detectors';
import { flagIdFor } from './ids';
import { contentHash, FlagStore } from './store';

export interface FlagsServiceOptions {
  sessionsDir: string;
  /** DATABASE_URL, or null to keep everything local. Read at every sync. */
  databaseUrl: () => string | null;
  /** How many clips are cut at the same time, across all sessions. Default 2. */
  concurrency?: number;
  /** Sync to TigerData in the background after every change. Default true; the CLI calls sync() itself instead. */
  autoSync?: boolean;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
  /** Replaces the Postgres connection (tests). */
  openDb?: (url: string) => Promise<SqlClient>;
}

export type SyncResult =
  | ({ status: 'synced' } & FlagSyncCounts)
  | { status: 'unchanged' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Files in clips/: <id>.mp4, <id>.jpg, and ffmpeg's temp outputs <id>.tmp.mp4 / .tmp.jpg. */
const CLIP_FILE_RE = /^([0-9a-f]{16})(\.tmp)?\.(mp4|jpg)$/;
const MAX_EVIDENCE_KEYS = 50;
const MAX_EVIDENCE_STRING = 1_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFlagType = (v: unknown): v is FlagType => (FLAG_TYPES as readonly unknown[]).includes(v);
const isSeverity = (v: unknown): v is FlagSeverity => (FLAG_SEVERITIES as readonly unknown[]).includes(v);
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const fileExists = (p: string): Promise<boolean> => stat(p).then((s) => s.isFile() && s.size > 0, () => false);

function isEvidence(v: unknown): v is FlagEvidence {
  if (!isRecord(v)) return false;
  const entries = Object.entries(v);
  return (
    entries.length <= MAX_EVIDENCE_KEYS &&
    entries.every(
      ([, x]) => typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x)) || (typeof x === 'string' && x.length <= MAX_EVIDENCE_STRING),
    )
  );
}

/** Validates a NewFlag coming from IPC or the command line. */
export function parseNewFlag(v: unknown): NewFlag {
  if (!isRecord(v)) throw new Error('flag must be an object');
  const { type, startMs, endMs, severity, evidence } = v;
  if (!isFlagType(type)) throw new Error(`flag type must be one of: ${FLAG_TYPES.join(', ')}`);
  if (typeof startMs !== 'number' || typeof endMs !== 'number' || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs < startMs) {
    throw new Error('need 0 <= startMs <= endMs, in ms since the recording started');
  }
  if (severity !== undefined && !isSeverity(severity)) throw new Error(`severity must be one of: ${FLAG_SEVERITIES.join(', ')}`);
  if (evidence !== undefined && !isEvidence(evidence)) {
    throw new Error(`evidence must map up to ${MAX_EVIDENCE_KEYS} names to numbers, booleans or short strings`);
  }
  return { type, startMs, endMs, ...(severity !== undefined ? { severity } : {}), ...(evidence !== undefined ? { evidence } : {}) };
}

export class FlagsService {
  readonly store: FlagStore;
  private readonly queue: JobQueue;
  private readonly log: Pick<Console, 'info' | 'warn' | 'error'>;
  private readonly listeners = new Set<(clip: Clip) => void>();
  /** Per session: the latest generateClips run, so runs of one session never overlap. */
  private readonly clipRuns = new Map<string, Promise<unknown>>();
  /** Per session: the latest sync, and one that is queued but hasn't started (later changes join it). */
  private readonly syncTails = new Map<string, Promise<SyncResult>>();
  private readonly queuedSyncs = new Map<string, Promise<SyncResult>>();
  private readonly shutdownController = new AbortController();

  constructor(private readonly options: FlagsServiceOptions) {
    this.store = new FlagStore(options.sessionsDir);
    this.queue = new JobQueue(options.concurrency ?? 2);
    this.log = options.log ?? console;
  }

  /** Called with every planned, finished or failed clip. Returns an unsubscribe function. */
  onClipUpdate(cb: (clip: Clip) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  async list(sessionId: string): Promise<{ flags: Flag[]; clips: Clip[] }> {
    const [flags, clips] = await Promise.all([this.store.readFlags(sessionId), this.store.readClips(sessionId)]);
    return { flags, clips };
  }

  /** Adds a manual flag (also while the session is recording). The same type and range twice returns the existing flag. */
  async add(sessionId: string, input: NewFlag): Promise<Flag> {
    const n = parseNewFlag(input);
    const session = await this.store.readSession(sessionId);
    const startMs = Math.round(n.startMs);
    let endMs = Math.round(n.endMs);
    if (session.durationMs !== null) {
      if (startMs >= session.durationMs) throw new Error(`flag starts at ${startMs} ms, but the recording is only ${session.durationMs} ms long`);
      endMs = Math.min(endMs, session.durationMs);
    }
    const flag: Flag = {
      id: flagIdFor(sessionId, 'manual', n.type, startMs, endMs),
      sessionId,
      type: n.type,
      startMs,
      endMs,
      severity: n.severity ?? 'medium',
      source: 'manual',
      evidence: n.evidence ?? {},
      explanation: null,
    };
    const saved = await this.store.withLock(sessionId, async () => {
      const flags = await this.store.readFlags(sessionId);
      const existing = flags.find((f) => f.id === flag.id);
      if (existing) return existing;
      await this.store.writeFlags(sessionId, [...flags, flag]);
      return flag;
    });
    this.scheduleSync(sessionId);
    return saved;
  }

  /**
   * Runs every detector and replaces the session's detector flags with the
   * result; manual flags are kept. A flag found again (same id) keeps its
   * explanation and clip. Returns the detector flags.
   */
  async runDetectors(sessionId: string): Promise<Flag[]> {
    const loaded = await this.store.loadSession(sessionId);
    if (loaded.session.status === 'recording') throw new Error('the session is still recording');
    const found = new Map<string, Flag>();
    for (const detect of DETECTORS) {
      let flags: Flag[];
      try {
        flags = detect(loaded);
      } catch (err) {
        this.log.error(`[flags] ${sessionId}: detector ${detect.name || '(anonymous)'} failed; skipping it`, err);
        continue;
      }
      for (const f of flags) {
        if (f.sessionId !== sessionId || f.source !== 'detector' || !Number.isFinite(f.startMs) || !(f.endMs >= f.startMs)) {
          this.log.warn(`[flags] ${sessionId}: detector ${detect.name || '(anonymous)'} returned an invalid flag; dropped`, f);
          continue;
        }
        found.set(f.id, f);
      }
    }
    const detected = await this.store.withLock(sessionId, async () => {
      const current = await this.store.readFlags(sessionId);
      const previous = new Map(current.map((f) => [f.id, f]));
      const next = [...found.values()].map((f): Flag => {
        const prev = previous.get(f.id);
        if (!prev) return f;
        return { ...f, ...(prev.clipId !== undefined ? { clipId: prev.clipId } : {}), explanation: prev.explanation ?? f.explanation ?? null };
      });
      await this.store.writeFlags(sessionId, [...current.filter((f) => f.source === 'manual'), ...next]);
      return next;
    });
    this.log.info(`[flags] ${sessionId}: detectors found ${detected.length} flag(s)`);
    this.scheduleSync(sessionId);
    return detected;
  }

  /**
   * Plans clips for the session's flags, writes clips.json (and each flag's
   * clipId), and cuts the clips whose files don't exist yet. Resolves with the
   * final clips once every one is ready or failed. Calls for one session run
   * one after the other; a repeat call is cheap because existing files are kept.
   */
  generateClips(sessionId: string): Promise<Clip[]> {
    const previous = this.clipRuns.get(sessionId) ?? Promise.resolve();
    const run = previous.then(
      () => this.cutClips(sessionId),
      () => this.cutClips(sessionId),
    );
    const settled = run.catch(() => undefined);
    this.clipRuns.set(sessionId, settled);
    void settled.then(() => {
      if (this.clipRuns.get(sessionId) === settled) this.clipRuns.delete(sessionId);
    });
    return run;
  }

  /**
   * Mirrors the session's flags and clips to TigerData. Skipped when
   * DATABASE_URL isn't set or the session itself isn't uploaded yet (then
   * afterSessionUpload syncs it). Never rejects.
   */
  sync(sessionId: string): Promise<SyncResult> {
    const queued = this.queuedSyncs.get(sessionId);
    if (queued) return queued;
    const tail = this.syncTails.get(sessionId) ?? Promise.resolve();
    const next = tail.then(() => {
      // Started: changes from now on need another sync.
      this.queuedSyncs.delete(sessionId);
      return this.syncNow(sessionId);
    });
    this.queuedSyncs.set(sessionId, next);
    this.syncTails.set(sessionId, next);
    void next.then(() => {
      if (this.syncTails.get(sessionId) === next) this.syncTails.delete(sessionId);
    });
    return next;
  }

  /** sync() in the background (unless autoSync is off); failures are logged and retried by syncPending() at the next launch. */
  scheduleSync(sessionId: string): void {
    if (this.options.autoSync === false) return;
    void this.sync(sessionId);
  }

  /** Syncs every uploaded session whose flags or clips changed since their last sync (e.g. while offline). */
  async syncPending(): Promise<void> {
    if (!this.options.databaseUrl()) return;
    const names = await readdir(this.options.sessionsDir).catch(() => [] as string[]);
    for (const id of names.filter((n) => UUID_RE.test(n))) {
      if (await this.store.hasFlagFiles(id).catch(() => false)) await this.sync(id);
    }
  }

  /** Stops running ffmpeg processes (app quit). Their clips stay pending and are cut on the next generateClips. */
  shutdown(): void {
    this.shutdownController.abort();
  }

  // --- internals ---------------------------------------------------------------

  private emit(clip: Clip): void {
    for (const cb of this.listeners) {
      try {
        cb(clip);
      } catch (err) {
        this.log.error('[clips] clip update listener failed', err);
      }
    }
  }

  private async cutClips(sessionId: string): Promise<Clip[]> {
    const session = await this.store.readSession(sessionId);
    if (session.status === 'recording') throw new Error('the session is still recording; clips can be cut once it has stopped');
    if (!session.recordingPath) throw new Error('the session has no recording');
    const dir = this.store.dirOf(sessionId);
    const input = join(dir, session.recordingPath);
    const durationMs = session.durationMs ?? (await probe(input)).durationMs;
    if (durationMs === null) throw new Error(`could not read the duration of ${session.recordingPath}`);
    const clipsDir = join(dir, 'clips');
    await mkdir(clipsDir, { recursive: true });

    const planned = await this.store.withLock(sessionId, async () => {
      const flags = await this.store.readFlags(sessionId);
      const plan = planClips(sessionId, flags, durationMs);
      const clipOfFlag = new Map<string, string>();
      for (const p of plan) for (const flagId of p.flagIds) clipOfFlag.set(flagId, p.id);
      const jobs = await Promise.all(
        plan.map(async (p) => {
          const clip: Clip = {
            id: p.id,
            sessionId,
            flagIds: p.flagIds,
            startMs: p.startMs,
            endMs: p.endMs,
            path: `clips/${p.id}.mp4`,
            thumbPath: `clips/${p.id}.jpg`,
            status: 'pending',
          };
          const ready = (await fileExists(join(dir, clip.path))) && (await fileExists(join(dir, clip.thumbPath)));
          return { plan: p, clip: ready ? { ...clip, status: 'ready' as const } : clip };
        }),
      );
      const linked = flags.map((f): Flag => {
        const { clipId: _previous, ...rest } = f;
        const clipId = clipOfFlag.get(f.id);
        return clipId !== undefined ? { ...rest, clipId } : rest;
      });
      await this.store.writeClips(sessionId, jobs.map((j) => j.clip));
      await this.store.writeFlags(sessionId, linked);
      await this.removeStaleFiles(clipsDir, new Set(plan.map((p) => p.id)));
      return jobs;
    });

    const todo = planned.filter((j) => j.clip.status !== 'ready');
    this.log.info(`[clips] ${sessionId}: ${planned.length} clip(s), ${todo.length} to cut`);
    for (const { clip } of planned) this.emit(clip);
    const clips = await Promise.all(
      planned.map(({ plan, clip }) => (clip.status === 'ready' ? clip : this.queue.run(() => this.cutOne(input, dir, plan, clip)))),
    );
    this.scheduleSync(sessionId);
    return clips;
  }

  private async cutOne(input: string, dir: string, plan: PlannedClip, clip: Clip): Promise<Clip> {
    const signal = this.shutdownController.signal;
    const started = Date.now();
    let result: Clip;
    try {
      const video = join(dir, clip.path);
      const thumb = join(dir, clip.thumbPath);
      if (!(await fileExists(video))) await encodeClip(input, video, clip.startMs, clip.endMs, signal);
      if (!(await fileExists(thumb))) {
        try {
          await extractFrame(input, thumb, plan.thumbMs, signal);
        } catch (err) {
          // No frame there (e.g. the video track ends before the audio does): use the clip's first frame.
          if (signal.aborted || plan.thumbMs === clip.startMs) throw err;
          await extractFrame(input, thumb, clip.startMs, signal);
        }
      }
      result = { ...clip, status: 'ready' };
      const secs = ((clip.endMs - clip.startMs) / 1000).toFixed(1);
      this.log.info(`[clips] ${clip.sessionId}: cut ${clip.id} (${secs} s) in ${Date.now() - started} ms`);
    } catch (err) {
      // Quitting: leave it pending; the next generateClips cuts it.
      if (signal.aborted) return clip;
      result = { ...clip, status: 'error', error: errorText(err) };
      this.log.error(`[clips] ${clip.sessionId}: clip ${clip.id} failed: ${result.error ?? ''}`);
    }
    await this.store.withLock(clip.sessionId, async () => {
      const clips = await this.store.readClips(clip.sessionId);
      const i = clips.findIndex((c) => c.id === clip.id);
      if (i < 0) return;
      clips[i] = result;
      await this.store.writeClips(clip.sessionId, clips);
    });
    this.emit(result);
    return result;
  }

  /** Deletes clip files no longer in the plan, and leftover temp files. Best effort: a file that's playing can't be deleted on Windows. */
  private async removeStaleFiles(clipsDir: string, keep: ReadonlySet<string>): Promise<void> {
    const names = await readdir(clipsDir).catch(() => [] as string[]);
    await Promise.all(
      names.map(async (name) => {
        const m = CLIP_FILE_RE.exec(name);
        if (!m || (keep.has(m[1] ?? '') && m[2] === undefined)) return;
        await rm(join(clipsDir, name), { force: true }).catch(() => undefined);
      }),
    );
  }

  private async syncNow(sessionId: string): Promise<SyncResult> {
    try {
      const url = this.options.databaseUrl();
      if (!url) return { status: 'skipped', reason: 'DATABASE_URL is not set' };
      const session = await this.store.readSession(sessionId);
      if (session.upload.status !== 'uploaded') return { status: 'skipped', reason: 'the session is not in TigerData yet; its flags follow its upload' };
      const { flags, clips } = await this.store.withLock(sessionId, () => this.list(sessionId));
      const hash = contentHash(flags, clips);
      if (hash === (await this.store.readSyncedHash(sessionId))) return { status: 'unchanged' };
      const counts = await syncFlagsToDb(url, this.store.dirOf(sessionId), session, flags, clips, this.options.openDb);
      await this.store.writeSyncedHash(sessionId, hash);
      this.log.info(`[flags] ${sessionId}: TigerData now has ${counts.flags} flag(s), ${counts.clips} clip(s)`);
      return { status: 'synced', ...counts };
    } catch (err) {
      const error = errorText(err);
      this.log.warn(`[flags] ${sessionId}: TigerData sync failed (local files kept; retried at next launch): ${error}`);
      return { status: 'failed', error };
    }
  }
}
