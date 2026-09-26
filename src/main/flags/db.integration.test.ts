// Runs migrations 001 + 002 and the flags/clips sync SQL against an in-process
// Postgres (PGlite), like src/capture/main/db.integration.test.ts.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, Flag } from '../../shared/flags';
import type { Session } from '../../shared/session-types';
import { uploadSession, type SqlClient } from '../../capture/main/db';
import { syncFlagsToDb } from './db';

const migration = (name: string) => readFileSync(join(__dirname, '../../../db/migrations', name), 'utf8');

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`CREATE FUNCTION create_hypertable(relation regclass, time_column_name name, if_not_exists boolean DEFAULT false)
    RETURNS void LANGUAGE sql AS $$ SELECT $$;`);
  await db.exec(migration('001_init.sql').replace(/^CREATE EXTENSION.*$/m, ''));
  await db.exec(migration('002_flags_clips.sql'));
  return db;
}

const asClient = (db: PGlite): SqlClient => ({
  query: (text, params) => db.query(text, params),
  end: async () => undefined,
});

const SESSION_ID = '405d0588-302d-4b44-9e4e-96c8a73c75fe';

function makeSession(): { dir: string; session: Session } {
  const dir = mkdtempSync(join(tmpdir(), 'flags-db-'));
  writeFileSync(join(dir, 'samples.ndjson'), '');
  const session: Session = {
    schemaVersion: 1,
    id: SESSION_ID,
    startedAtIso: '2026-09-26T17:48:16.716Z',
    durationMs: 75_410,
    recordingPath: 'recording.mp4',
    appVersion: '0.1.0',
    clock: { method: 'frame-matched', videoStartEpochMs: 1_790_444_896_716.2, sdkToVideoOffsetUs: 0, sdkBiasMs: 765.6, firstSampleTMs: 333.2, containerStartMs: 0 },
    video: { mimeType: 'video/mp4;codecs=avc1,opus', width: 1280, height: 720, frameRate: 30, hasAudio: true, remuxed: true },
    status: 'complete',
    counts: { vitals: 0, face: 0, validation: 0 },
    upload: { status: 'uploaded', attemptedAt: null, error: null },
  };
  return { dir, session };
}

const flagA: Flag = {
  id: 'aaaaaaaaaaaaaaaa',
  sessionId: SESSION_ID,
  type: 'manual',
  startMs: 30_000,
  endMs: 33_000,
  severity: 'medium',
  source: 'manual',
  evidence: {},
  clipId: 'cccccccccccccccc',
  explanation: null,
};
const flagB: Flag = {
  ...flagA,
  id: 'bbbbbbbbbbbbbbbb',
  type: 'high_hr',
  startMs: 36_000,
  endMs: 38_000,
  source: 'detector',
  severity: 'high',
  evidence: { peakBpm: 104, baselineBpm: 78, placeholder: true, note: 'x' },
  explanation: { summary: 'Pulse rose.', suggestion: 'Pause and breathe.' },
};
const clip: Clip = {
  id: 'cccccccccccccccc',
  sessionId: SESSION_ID,
  flagIds: [flagA.id, flagB.id],
  startMs: 27_000,
  endMs: 40_000,
  path: 'clips/cccccccccccccccc.mp4',
  thumbPath: 'clips/cccccccccccccccc.jpg',
  status: 'ready',
};

describe('syncFlagsToDb (PGlite)', () => {
  let db: PGlite;
  let dir: string;
  let session: Session;
  const open = async () => asClient(db);

  beforeEach(async () => {
    db = await freshDb();
    ({ dir, session } = makeSession());
    await uploadSession('postgres://unused', dir, session, open);
  });

  it('writes flags and clips that mirror the JSON', async () => {
    expect(await syncFlagsToDb('postgres://unused', dir, session, [flagA, flagB], [clip], open)).toEqual({ flags: 2, clips: 1 });

    const clips = await db.query<Record<string, unknown>>('SELECT * FROM clips');
    expect(clips.rows).toHaveLength(1);
    expect(clips.rows[0]).toMatchObject({
      id: clip.id,
      session_id: SESSION_ID,
      flag_ids: [flagA.id, flagB.id],
      start_ms: 27_000,
      end_ms: 40_000,
      clip_uri: pathToFileURL(join(dir, clip.path)).href,
      thumb_uri: pathToFileURL(join(dir, clip.thumbPath)).href,
      status: 'ready',
      error: null,
    });

    const flags = await db.query<Record<string, unknown>>('SELECT * FROM flags ORDER BY start_ms');
    expect(flags.rows.map((r) => [r['id'], r['type'], r['source'], r['severity'], r['clip_id']])).toEqual([
      [flagA.id, 'manual', 'manual', 'medium', clip.id],
      [flagB.id, 'high_hr', 'detector', 'high', clip.id],
    ]);
    expect(flags.rows[1]?.['evidence']).toEqual(flagB.evidence);
    expect(flags.rows[1]?.['explanation']).toEqual(flagB.explanation);
    expect(flags.rows[0]?.['explanation']).toBeNull();

    // t = sessions.started_at + t_ms
    const offset = await db.query<{ d: number }>(
      `SELECT extract(epoch FROM (f.t_start - s.started_at)) * 1000 AS d FROM flags f JOIN sessions s ON s.id = f.session_id WHERE f.id = $1`,
      [flagB.id],
    );
    expect(Number(offset.rows[0]?.d)).toBeCloseTo(36_000, 1);
  });

  it('deletes rows that disappeared locally and updates changed ones', async () => {
    await syncFlagsToDb('postgres://unused', dir, session, [flagA, flagB], [clip], open);
    const newClip: Clip = { ...clip, id: 'dddddddddddddddd', flagIds: [flagA.id], endMs: 35_000, status: 'error', error: 'ffmpeg exit 1' };
    await syncFlagsToDb('postgres://unused', dir, session, [{ ...flagA, clipId: newClip.id, severity: 'high' }], [newClip], open);

    const clips = await db.query<{ id: string; status: string; error: string }>('SELECT id, status, error FROM clips');
    expect(clips.rows).toEqual([{ id: newClip.id, status: 'error', error: 'ffmpeg exit 1' }]);
    const flags = await db.query<{ id: string; clip_id: string; severity: string }>('SELECT id, clip_id, severity FROM flags');
    expect(flags.rows).toEqual([{ id: flagA.id, clip_id: newClip.id, severity: 'high' }]);

    // Nothing left locally: nothing left in the database.
    await syncFlagsToDb('postgres://unused', dir, session, [], [], open);
    const n = await db.query<{ f: number; c: number }>('SELECT (SELECT count(*) FROM flags)::int AS f, (SELECT count(*) FROM clips)::int AS c');
    expect(n.rows[0]).toEqual({ f: 0, c: 0 });
  });

  it('is idempotent', async () => {
    await syncFlagsToDb('postgres://unused', dir, session, [flagA, flagB], [clip], open);
    await syncFlagsToDb('postgres://unused', dir, session, [flagA, flagB], [clip], open);
    const n = await db.query<{ f: number; c: number }>('SELECT (SELECT count(*) FROM flags)::int AS f, (SELECT count(*) FROM clips)::int AS c');
    expect(n.rows[0]).toEqual({ f: 2, c: 1 });
  });

  it('stores a flag without a clip (not cut yet) with clip_id null', async () => {
    const { clipId: _unused, ...unclipped } = flagA;
    await syncFlagsToDb('postgres://unused', dir, session, [unclipped], [], open);
    const flags = await db.query<{ clip_id: string | null }>('SELECT clip_id FROM flags');
    expect(flags.rows).toEqual([{ clip_id: null }]);
  });

  it('refuses a session that is not in the database, and leaves nothing behind', async () => {
    const other = { ...session, id: '00000000-0000-4000-8000-000000000000' };
    await expect(syncFlagsToDb('postgres://unused', dir, other, [{ ...flagA, sessionId: other.id }], [], open)).rejects.toThrow(/not in TigerData yet/);
    const n = await db.query<{ f: number }>('SELECT count(*)::int AS f FROM flags');
    expect(n.rows[0]?.f).toBe(0);
  });

  it('removes flags and clips with their session', async () => {
    await syncFlagsToDb('postgres://unused', dir, session, [flagA, flagB], [clip], open);
    await db.query('DELETE FROM sessions WHERE id = $1', [SESSION_ID]);
    const n = await db.query<{ f: number; c: number }>('SELECT (SELECT count(*) FROM flags)::int AS f, (SELECT count(*) FROM clips)::int AS c');
    expect(n.rows[0]).toEqual({ f: 0, c: 0 });
  });
});
