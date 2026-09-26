// Runs the real migration and upload SQL against an in-process Postgres
// (PGlite). PGlite has no TimescaleDB, so create_hypertable is stubbed; the
// hypertable call itself is only exercised against TigerData.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SampleRecord, Session } from '../../shared/session-types';
import { uploadSession, type SqlClient } from './db';

const MIGRATION = readFileSync(join(__dirname, '../../../db/migrations/001_init.sql'), 'utf8');

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`CREATE FUNCTION create_hypertable(relation regclass, time_column_name name, if_not_exists boolean DEFAULT false)
    RETURNS void LANGUAGE sql AS $$ SELECT $$;`);
  await db.exec(MIGRATION.replace(/^CREATE EXTENSION.*$/m, ''));
  return db;
}

const asClient = (db: PGlite): SqlClient => ({
  query: (text, params) => db.query(text, params),
  end: async () => undefined,
});

const face = (tMs: number, patch: Partial<Extract<SampleRecord, { kind: 'face' }>> = {}): SampleRecord => ({
  kind: 'face',
  tMs,
  blinking: false,
  talking: null,
  expressions: null,
  eyeLandmarks: null,
  headPose: null,
  gaze: null,
  ...patch,
});

function makeSession(records: SampleRecord[]): { dir: string; session: Session } {
  const dir = mkdtempSync(join(tmpdir(), 'capture-db-'));
  const session: Session = {
    schemaVersion: 1,
    id: '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
    startedAtIso: '2026-09-26T17:24:21.380Z',
    durationMs: 57_990,
    recordingPath: 'recording.mp4',
    appVersion: '0.1.0',
    clock: {
      method: 'frame-matched',
      videoStartEpochMs: 1_790_443_461_380.8,
      sdkToVideoOffsetUs: 1_790_443_462_166_700,
      sdkBiasMs: 785.9,
      firstSampleTMs: 367.3,
      containerStartMs: 0,
    },
    video: { mimeType: 'video/mp4;codecs=avc1,opus', width: 1280, height: 720, frameRate: 30, hasAudio: true, remuxed: true },
    status: 'complete',
    counts: { vitals: 0, face: 0, validation: 0 },
    upload: { status: 'pending', attemptedAt: null, error: null },
  };
  writeFileSync(join(dir, 'samples.ndjson'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return { dir, session };
}

const eyes = {
  right: { outerCorner: { x: 1, y: 2 }, innerCorner: { x: 3, y: 4 }, upperLid: { x: 5, y: 6 }, lowerLid: { x: 7, y: 8 }, irisCenter: { x: 9, y: 10 }, irisContour: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }, { x: 4, y: 4 }] },
  left: { outerCorner: { x: 1, y: 2 }, innerCorner: { x: 3, y: 4 }, upperLid: { x: 5, y: 6 }, lowerLid: { x: 7, y: 8 }, irisCenter: { x: 9, y: 10 }, irisContour: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }, { x: 4, y: 4 }] },
} as const;

describe('uploadSession (PGlite)', () => {
  let db: PGlite;
  beforeEach(async () => {
    db = await freshDb();
  });

  it('writes the session and samples in one transaction, keyed by session start + tMs', async () => {
    const records: SampleRecord[] = [
      face(367.3, { expressions: { angry: 0.1, contempt: 0, disgust: 0, fear: 0, happy: 0.6, neutral: 0.3, sad: 0, surprise: 0 }, eyeLandmarks: eyes as never, headPose: { yaw: 0.1, pitch: -0.05 }, gaze: { h: 0.02, v: 0.01, direction: 'camera' } }),
      face(400.1),
      // The same frame's blink arriving in a later flush: merged into one row.
      face(367.3, { blinking: true }),
      { kind: 'vitals', tMs: 18_700.4, pulseBpm: 72.3, pulseConfidence: 61, pulseStable: true, hrvRmssdMs: null, hrvSdnnMs: null, hrvMeanNnMs: null, hrvBaevsky: null, hrvConfidence: null, hrvStable: null, breathingRate: null, breathingConfidence: null, breathingStable: null },
      { kind: 'validation', tMs: 367.3, code: 0, name: 'Ok', hint: 'Hold still and record.' },
      { kind: 'validation', tMs: 1680.2, code: 7, name: 'ChestNotVisible', hint: '' },
    ];
    const { dir, session } = makeSession(records);
    const counts = await uploadSession('postgres://unused', dir, session, async () => asClient(db));
    expect(counts).toEqual({ vitals: 1, face: 2, validation: 2 });

    const s = await db.query<{ uploaded: boolean; started_at: Date; recording_uri: string; clock: { method: string } }>('SELECT * FROM sessions');
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]?.uploaded).toBe(true);
    expect(s.rows[0]?.clock.method).toBe('frame-matched');
    expect(s.rows[0]?.recording_uri).toMatch(/^file:\/\/.*recording\.mp4$/);

    const f = await db.query<{ t_ms: number; blinking: boolean; expr_happy: number; eye_landmarks: typeof eyes; gaze_direction: string; micros: string }>(
      `SELECT f.*, to_char(f.t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS micros FROM face_samples f ORDER BY t`,
    );
    expect(f.rows.map((r) => r.t_ms)).toEqual([367.3, 400.1]);
    expect(f.rows[0]?.blinking).toBe(true);
    expect(f.rows[0]?.expr_happy).toBeCloseTo(0.6);
    expect(f.rows[0]?.eye_landmarks.right.irisCenter).toEqual({ x: 9, y: 10 });
    expect(f.rows[0]?.gaze_direction).toBe('camera');
    // 1790443461380.8 ms + 367.3 ms = ...461748.1 ms
    expect(f.rows[0]?.micros).toBe('2026-09-26T17:24:21.748100');

    const offset = await db.query<{ d: number }>(
      `SELECT extract(epoch FROM (v.t - s.started_at)) * 1000 AS d FROM vitals_samples v JOIN sessions s ON s.id = v.session_id`,
    );
    expect(Number(offset.rows[0]?.d)).toBeCloseTo(18_700.4, 1);
  });

  it('is idempotent when re-uploaded', async () => {
    const { dir, session } = makeSession([face(100), face(133.3), { kind: 'validation', tMs: 100, code: 0, name: 'Ok', hint: '' }]);
    await uploadSession('postgres://unused', dir, session, async () => asClient(db));
    await uploadSession('postgres://unused', dir, session, async () => asClient(db));
    const n = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM face_samples');
    expect(n.rows[0]?.n).toBe(2);
  });

  it('rolls back everything when a row fails', async () => {
    const bad = { kind: 'validation', tMs: 5, code: 1, name: 'NoFaceFound', hint: null } as unknown as SampleRecord;
    const { dir, session } = makeSession([face(1), bad]);
    await expect(uploadSession('postgres://unused', dir, session, async () => asClient(db))).rejects.toThrow();
    const n = await db.query<{ s: number; f: number }>('SELECT (SELECT count(*) FROM sessions)::int AS s, (SELECT count(*) FROM face_samples)::int AS f');
    expect(n.rows[0]).toEqual({ s: 0, f: 0 });
  });
});
