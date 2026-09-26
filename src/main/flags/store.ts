// sessions/<id>/flags.json and clips.json: the source of truth for flags and
// clips (see src/shared/flags.ts). Nothing is cached between calls, so a
// change made by the CLI shows up in the app on the next read.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FLAG_SEVERITIES, FLAG_TYPES, FLAGS_SCHEMA_VERSION, type Clip, type ClipsFile, type Flag, type FlagsFile } from '../../shared/flags';
import { mergeSampleRecords, type FaceSample, type Session, type ValidationEvent, type VitalsSample } from '../../shared/session-types';
import { parseSamples } from '../../capture/main/db';
import { writeJsonAtomic } from '../../capture/main/files';
import type { LoadedSession } from './detectors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Written after flags and clips were mirrored to TigerData; a hash mismatch means they changed since. */
const SYNC_MARKER = 'flags-sync.json';

interface SyncMarker {
  hash: string;
  syncedAt: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function isFlag(v: unknown): v is Flag {
  return (
    isRecord(v) &&
    typeof v['id'] === 'string' &&
    typeof v['sessionId'] === 'string' &&
    (FLAG_TYPES as readonly unknown[]).includes(v['type']) &&
    isFiniteNumber(v['startMs']) &&
    isFiniteNumber(v['endMs']) &&
    (FLAG_SEVERITIES as readonly unknown[]).includes(v['severity']) &&
    (v['source'] === 'detector' || v['source'] === 'manual') &&
    isRecord(v['evidence'])
  );
}

function isClip(v: unknown): v is Clip {
  return (
    isRecord(v) &&
    typeof v['id'] === 'string' &&
    typeof v['sessionId'] === 'string' &&
    Array.isArray(v['flagIds']) &&
    isFiniteNumber(v['startMs']) &&
    isFiniteNumber(v['endMs']) &&
    typeof v['path'] === 'string' &&
    typeof v['thumbPath'] === 'string' &&
    (v['status'] === 'pending' || v['status'] === 'ready' || v['status'] === 'error')
  );
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Parses flags.json / clips.json. A damaged file throws instead of reading as empty, so it's never overwritten silently. */
function parseList<T>(text: string, file: string, key: 'flags' | 'clips', check: (v: unknown) => v is T): T[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (fix or delete it): ${err instanceof Error ? err.message : String(err)}`);
  }
  const list = isRecord(data) ? data[key] : undefined;
  if (!Array.isArray(list)) throw new Error(`${file} has no "${key}" array`);
  const bad = list.findIndex((item) => !check(item));
  if (bad >= 0) throw new Error(`${file}: entry ${bad} is not a valid ${key === 'flags' ? 'Flag' : 'Clip'}`);
  return list as T[];
}

/** Hash of what the database should mirror. */
export const contentHash = (flags: readonly Flag[], clips: readonly Clip[]): string =>
  createHash('sha256').update(JSON.stringify({ flags, clips })).digest('hex');

export class FlagStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(readonly sessionsDir: string) {}

  dirOf(sessionId: string): string {
    if (!UUID_RE.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
    return join(this.sessionsDir, sessionId);
  }

  /**
   * Runs `fn` after every earlier withLock call for this session has settled.
   * Wrap every read-modify-write of flags.json / clips.json in it.
   */
  withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(sessionId) ?? Promise.resolve()).then(fn, fn);
    const settled = next.catch(() => undefined);
    this.locks.set(sessionId, settled);
    void settled.then(() => {
      if (this.locks.get(sessionId) === settled) this.locks.delete(sessionId);
    });
    return next;
  }

  async readSession(sessionId: string): Promise<Session> {
    const file = join(this.dirOf(sessionId), 'session.json');
    const text = await readOptional(file);
    if (text === null) throw new Error(`session ${sessionId} not found in ${this.sessionsDir}`);
    return JSON.parse(text) as Session;
  }

  /** session.json plus merged, sorted samples: the input to detectors. */
  async loadSession(sessionId: string): Promise<LoadedSession> {
    const session = await this.readSession(sessionId);
    const dir = this.dirOf(sessionId);
    const samples = mergeSampleRecords(parseSamples((await readOptional(join(dir, 'samples.ndjson'))) ?? ''));
    const vitals: VitalsSample[] = [];
    const face: FaceSample[] = [];
    const validation: ValidationEvent[] = [];
    for (const r of samples) {
      if (r.kind === 'vitals') vitals.push(r);
      else if (r.kind === 'face') face.push(r);
      else validation.push(r);
    }
    return { session, dir, samples, vitals, face, validation };
  }

  async readFlags(sessionId: string): Promise<Flag[]> {
    const file = join(this.dirOf(sessionId), 'flags.json');
    const text = await readOptional(file);
    return text === null ? [] : parseList(text, file, 'flags', isFlag);
  }

  async readClips(sessionId: string): Promise<Clip[]> {
    const file = join(this.dirOf(sessionId), 'clips.json');
    const text = await readOptional(file);
    return text === null ? [] : parseList(text, file, 'clips', isClip);
  }

  /** Writes flags.json, sorted by time. */
  async writeFlags(sessionId: string, flags: Flag[]): Promise<void> {
    const sorted = [...flags].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id));
    const file: FlagsFile = { schemaVersion: FLAGS_SCHEMA_VERSION, flags: sorted };
    await writeJsonAtomic(join(this.dirOf(sessionId), 'flags.json'), file);
  }

  /** Writes clips.json, sorted by time. */
  async writeClips(sessionId: string, clips: Clip[]): Promise<void> {
    const sorted = [...clips].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    const file: ClipsFile = { schemaVersion: FLAGS_SCHEMA_VERSION, clips: sorted };
    await writeJsonAtomic(join(this.dirOf(sessionId), 'clips.json'), file);
  }

  /** True if the session has a flags.json or clips.json. */
  async hasFlagFiles(sessionId: string): Promise<boolean> {
    const dir = this.dirOf(sessionId);
    return (await readOptional(join(dir, 'flags.json'))) !== null || (await readOptional(join(dir, 'clips.json'))) !== null;
  }

  async readSyncedHash(sessionId: string): Promise<string | null> {
    const text = await readOptional(join(this.dirOf(sessionId), SYNC_MARKER));
    if (text === null) return null;
    try {
      const marker = JSON.parse(text) as Partial<SyncMarker>;
      return typeof marker.hash === 'string' ? marker.hash : null;
    } catch {
      return null;
    }
  }

  async writeSyncedHash(sessionId: string, hash: string): Promise<void> {
    const marker: SyncMarker = { hash, syncedAt: new Date().toISOString() };
    await writeJsonAtomic(join(this.dirOf(sessionId), SYNC_MARKER), marker);
  }
}
