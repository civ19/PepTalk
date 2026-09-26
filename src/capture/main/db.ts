// TigerData (Postgres + TimescaleDB) upload, main process only. Schema:
// db/migrations/001_init.sql (apply with `npm run db:migrate`).
//
// One session = one transaction: the session row, every sample row (batched
// multi-row INSERTs), then uploaded = true. A failure rolls everything back,
// so the DB never holds half a session and a retry starts clean. Inserts use
// ON CONFLICT DO NOTHING, so re-uploading an already-uploaded session is harmless.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  EXPRESSION_NAMES,
  mergeSampleRecords,
  type FaceSample,
  type SampleRecord,
  type Session,
  type ValidationEvent,
  type VitalsSample,
} from '../../shared/session-types';

const ROWS_PER_INSERT = 500;

/** DATABASE_URL from the environment, or null when TigerData isn't configured (sessions stay local). */
export function databaseUrlFromEnv(): string | null {
  const url = process.env['DATABASE_URL']?.trim();
  return url ? url : null;
}

/**
 * pg client config that always uses verified TLS. `sslmode` is stripped from
 * the URL because pg lets connection-string SSL settings override the `ssl`
 * option; anything weaker than require is rejected outright.
 */
export function pgClientConfig(databaseUrl: string): pg.ClientConfig {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL is not a valid postgres:// URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new Error('DATABASE_URL must start with postgres://');
  const mode = url.searchParams.get('sslmode');
  if (mode && ['disable', 'allow', 'prefer'].includes(mode)) {
    throw new Error(`DATABASE_URL has sslmode=${mode}; TLS is required (use sslmode=require or leave it out)`);
  }
  url.searchParams.delete('sslmode');
  if (!url.password && !process.env['PGPASSWORD']) {
    throw new Error('DATABASE_URL has no password (postgres://user:<password>@host...), and PGPASSWORD is not set');
  }
  return { connectionString: url.toString(), ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 15_000 };
}

/** Parses samples.ndjson, skipping a torn last line left by a crash. */
export function parseSamples(text: string): SampleRecord[] {
  const out: SampleRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as SampleRecord;
      if (typeof rec.tMs === 'number' && (rec.kind === 'vitals' || rec.kind === 'face' || rec.kind === 'validation')) out.push(rec);
    } catch {
      /* torn line */
    }
  }
  return out;
}

/** Unix µs -> ISO 8601 with microseconds (timestamptz keeps µs; Date only ms). */
export function isoMicros(epochUs: number): string {
  const us = Math.round(epochUs);
  const ms = Math.floor(us / 1000);
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, -1)}${String(us - ms * 1000).padStart(3, '0')}Z`;
}

/** The slice of pg.Client used here; tests substitute an in-process Postgres. */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

export async function connect(databaseUrl: string): Promise<SqlClient> {
  const client = new pg.Client(pgClientConfig(databaseUrl));
  await client.connect();
  return client;
}

/** Multi-row INSERTs in chunks; `conflict` is the ON CONFLICT clause. */
export async function insertRows(client: SqlClient, table: string, columns: readonly string[], rows: readonly unknown[][], conflict: string): Promise<void> {
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + ROWS_PER_INSERT);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => `(${row.map((v) => (params.push(v), `$${params.length}`)).join(',')})`);
    await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')} ${conflict}`, params);
  }
}

const VITALS_COLUMNS = [
  'session_id', 't', 't_ms',
  'pulse_bpm', 'pulse_confidence', 'pulse_stable',
  'hrv_rmssd_ms', 'hrv_sdnn_ms', 'hrv_mean_nn_ms', 'hrv_baevsky', 'hrv_confidence', 'hrv_stable',
  'breathing_rate', 'breathing_confidence', 'breathing_stable',
] as const;

const FACE_COLUMNS = [
  'session_id', 't', 't_ms', 'blinking', 'talking',
  ...EXPRESSION_NAMES.map((n) => `expr_${n}`),
  'eye_landmarks', 'head_yaw', 'head_pitch', 'gaze_h', 'gaze_v', 'gaze_direction',
] as const;

const VALIDATION_COLUMNS = ['session_id', 't', 't_ms', 'code', 'name', 'hint'] as const;

export interface UploadCounts {
  vitals: number;
  face: number;
  validation: number;
}

export async function uploadSession(
  databaseUrl: string,
  dir: string,
  session: Session,
  open: (url: string) => Promise<SqlClient> = connect,
): Promise<UploadCounts> {
  if (!session.clock) throw new Error('session has no clock anchor (no Presage data was recorded); nothing to upload');
  const startUs = session.clock.videoStartEpochMs * 1000;
  const t = (tMs: number): string => isoMicros(startUs + tMs * 1000);

  let text = '';
  try {
    text = await readFile(join(dir, 'samples.ndjson'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const records = mergeSampleRecords(parseSamples(text));
  const vitals = records.filter((r): r is { kind: 'vitals' } & VitalsSample => r.kind === 'vitals');
  const face = records.filter((r): r is { kind: 'face' } & FaceSample => r.kind === 'face');
  // Two validation events on the same frame with the same code can't both be keyed; keep the last.
  const validationByKey = new Map<string, ValidationEvent>();
  for (const r of records) if (r.kind === 'validation') validationByKey.set(`${r.tMs}|${r.code}`, r);
  const validation = [...validationByKey.values()];

  const id = session.id;
  const recordingUri = session.recordingPath ? pathToFileURL(join(dir, session.recordingPath)).href : null;

  const client = await open(databaseUrl);
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO sessions (id, started_at, duration_ms, recording_uri, app_version, schema_version, status, clock, video, uploaded)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false)
       ON CONFLICT (id) DO UPDATE SET started_at = EXCLUDED.started_at, duration_ms = EXCLUDED.duration_ms,
         recording_uri = EXCLUDED.recording_uri, app_version = EXCLUDED.app_version, schema_version = EXCLUDED.schema_version,
         status = EXCLUDED.status, clock = EXCLUDED.clock, video = EXCLUDED.video`,
      [id, t(0), session.durationMs, recordingUri, session.appVersion, session.schemaVersion, session.status, JSON.stringify(session.clock), JSON.stringify(session.video)],
    );
    await insertRows(
      client,
      'vitals_samples',
      VITALS_COLUMNS,
      vitals.map((v) => [
        id, t(v.tMs), v.tMs,
        v.pulseBpm, v.pulseConfidence, v.pulseStable,
        v.hrvRmssdMs, v.hrvSdnnMs, v.hrvMeanNnMs, v.hrvBaevsky, v.hrvConfidence, v.hrvStable,
        v.breathingRate, v.breathingConfidence, v.breathingStable,
      ]),
      'ON CONFLICT (session_id, t) DO NOTHING',
    );
    await insertRows(
      client,
      'face_samples',
      FACE_COLUMNS,
      face.map((f) => [
        id, t(f.tMs), f.tMs, f.blinking, f.talking,
        ...EXPRESSION_NAMES.map((n) => f.expressions?.[n] ?? null),
        f.eyeLandmarks ? JSON.stringify(f.eyeLandmarks) : null,
        f.headPose?.yaw ?? null, f.headPose?.pitch ?? null,
        f.gaze?.h ?? null, f.gaze?.v ?? null, f.gaze?.direction ?? null,
      ]),
      'ON CONFLICT (session_id, t) DO NOTHING',
    );
    await insertRows(
      client,
      'validation_events',
      VALIDATION_COLUMNS,
      validation.map((v) => [id, t(v.tMs), v.tMs, v.code, v.name, v.hint]),
      'ON CONFLICT (session_id, t, code) DO NOTHING',
    );
    await client.query('UPDATE sessions SET uploaded = true, uploaded_at = now() WHERE id = $1', [id]);
    await client.query('COMMIT');
    return { vitals: vitals.length, face: face.length, validation: validation.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    const msg = err instanceof Error ? err.message : String(err);
    if (/relation "(sessions|vitals_samples|face_samples|validation_events)" does not exist/.test(msg)) {
      throw new Error(`${msg}. Run \`npm run db:migrate\` first.`);
    }
    throw err;
  } finally {
    await client.end().catch(() => undefined);
  }
}
