// Mirrors one session's flags.json and clips.json into TigerData (tables flags
// and clips, db/migrations/002_flags_clips.sql). One transaction per sync: the
// session's rows that no longer exist locally are deleted and the rest are
// upserted, so after a successful sync the tables match the files exactly.
// Clip videos stay local; only their file:// URIs are stored.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Clip, Flag } from '../../shared/flags';
import type { Session } from '../../shared/session-types';
import { connect, insertRows, isoMicros, type SqlClient } from '../../capture/main/db';

const CLIP_COLUMNS = ['id', 'session_id', 'flag_ids', 'start_ms', 'end_ms', 't_start', 't_end', 'clip_uri', 'thumb_uri', 'status', 'error'] as const;
const FLAG_COLUMNS = [
  'id', 'session_id', 'type', 'start_ms', 'end_ms', 't_start', 't_end',
  'severity', 'source', 'evidence', 'clip_id', 'explanation',
] as const;

const upsert = (columns: readonly string[]): string =>
  `ON CONFLICT (id) DO UPDATE SET ${columns
    .filter((c) => c !== 'id')
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(', ')}, updated_at = now()`;

export interface FlagSyncCounts {
  flags: number;
  clips: number;
}

interface FlagRow {
  id: string;
  type: string;
  start_ms: number;
  end_ms: number;
  /** t_start - sessions.started_at, and t_end - ..., in ms. */
  t_start_ms: number;
  t_end_ms: number;
  severity: string;
  source: string;
  evidence: unknown;
  clip_id: string | null;
  explanation: unknown;
}

interface ClipRow {
  id: string;
  flag_ids: string[];
  start_ms: number;
  end_ms: number;
  t_start_ms: number;
  t_end_ms: number;
  clip_uri: string;
  thumb_uri: string;
  status: string;
  error: string | null;
}

/** Differences between the local files and the session's rows in TigerData; empty when they agree. */
export async function diffFlagsWithDb(
  databaseUrl: string,
  dir: string,
  session: Session,
  flags: readonly Flag[],
  clips: readonly Clip[],
  open: (url: string) => Promise<SqlClient> = connect,
): Promise<string[]> {
  const client = await open(databaseUrl);
  let flagRows: FlagRow[];
  let clipRows: ClipRow[];
  try {
    const offsets = `extract(epoch FROM (x.t_start - s.started_at)) * 1000 AS t_start_ms, extract(epoch FROM (x.t_end - s.started_at)) * 1000 AS t_end_ms`;
    flagRows = ((await client.query(`SELECT x.*, ${offsets} FROM flags x JOIN sessions s ON s.id = x.session_id WHERE x.session_id = $1`, [session.id])) as { rows: FlagRow[] }).rows;
    clipRows = ((await client.query(`SELECT x.*, ${offsets} FROM clips x JOIN sessions s ON s.id = x.session_id WHERE x.session_id = $1`, [session.id])) as { rows: ClipRow[] }).rows;
  } finally {
    await client.end().catch(() => undefined);
  }

  const problems: string[] = [];
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  const near = (a: unknown, b: number): boolean => Math.abs(Number(a) - b) < 0.01;
  const check = (what: string, ok: boolean, local: unknown, db: unknown): void => {
    if (!ok) problems.push(`${what}: local ${JSON.stringify(local)}, database ${JSON.stringify(db)}`);
  };
  const sortKeys = (v: unknown): unknown =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v;

  const flagById = new Map(flagRows.map((r) => [r.id, r]));
  for (const f of flags) {
    const r = flagById.get(f.id);
    if (!r) {
      problems.push(`flag ${f.id}: missing in the database`);
      continue;
    }
    const w = `flag ${f.id}`;
    check(`${w} type`, r.type === f.type, f.type, r.type);
    check(`${w} range`, near(r.start_ms, f.startMs) && near(r.end_ms, f.endMs), [f.startMs, f.endMs], [r.start_ms, r.end_ms]);
    check(`${w} t_start/t_end`, near(r.t_start_ms, f.startMs) && near(r.t_end_ms, f.endMs), [f.startMs, f.endMs], [r.t_start_ms, r.t_end_ms]);
    check(`${w} severity/source`, r.severity === f.severity && r.source === f.source, [f.severity, f.source], [r.severity, r.source]);
    check(`${w} evidence`, same(sortKeys(r.evidence), sortKeys(f.evidence)), f.evidence, r.evidence);
    check(`${w} clip_id`, r.clip_id === (f.clipId ?? null), f.clipId ?? null, r.clip_id);
    check(`${w} explanation`, same(sortKeys(r.explanation ?? null), sortKeys(f.explanation ?? null)), f.explanation ?? null, r.explanation);
  }
  for (const r of flagRows) if (!flags.some((f) => f.id === r.id)) problems.push(`flag ${r.id}: in the database but not in flags.json`);

  const clipById = new Map(clipRows.map((r) => [r.id, r]));
  for (const c of clips) {
    const r = clipById.get(c.id);
    if (!r) {
      problems.push(`clip ${c.id}: missing in the database`);
      continue;
    }
    const w = `clip ${c.id}`;
    check(`${w} flag_ids`, same(r.flag_ids, c.flagIds), c.flagIds, r.flag_ids);
    check(`${w} range`, near(r.start_ms, c.startMs) && near(r.end_ms, c.endMs), [c.startMs, c.endMs], [r.start_ms, r.end_ms]);
    check(`${w} t_start/t_end`, near(r.t_start_ms, c.startMs) && near(r.t_end_ms, c.endMs), [c.startMs, c.endMs], [r.t_start_ms, r.t_end_ms]);
    const uris = [pathToFileURL(join(dir, c.path)).href, pathToFileURL(join(dir, c.thumbPath)).href];
    check(`${w} uris`, r.clip_uri === uris[0] && r.thumb_uri === uris[1], uris, [r.clip_uri, r.thumb_uri]);
    check(`${w} status`, r.status === c.status && r.error === (c.error ?? null), [c.status, c.error ?? null], [r.status, r.error]);
  }
  for (const r of clipRows) if (!clips.some((c) => c.id === r.id)) problems.push(`clip ${r.id}: in the database but not in clips.json`);
  return problems;
}

/** Requires the session row (uploaded by uploadSession) to exist already. */
export async function syncFlagsToDb(
  databaseUrl: string,
  dir: string,
  session: Session,
  flags: readonly Flag[],
  clips: readonly Clip[],
  open: (url: string) => Promise<SqlClient> = connect,
): Promise<FlagSyncCounts> {
  if (!session.clock) throw new Error('session has no clock anchor, so it was never uploaded');
  const startUs = session.clock.videoStartEpochMs * 1000;
  const t = (ms: number): string => isoMicros(startUs + ms * 1000);
  const uri = (relPath: string): string => pathToFileURL(join(dir, relPath)).href;
  const clipIds = new Set(clips.map((c) => c.id));

  const client = await open(databaseUrl);
  try {
    await client.query('BEGIN');
    // Locks the session row, so two syncs of one session (app + CLI) run one after the other.
    const found = (await client.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [session.id])) as { rows: unknown[] };
    if (found.rows.length === 0) throw new Error(`session ${session.id} is not in TigerData yet; upload the session first`);
    await client.query('DELETE FROM flags WHERE session_id = $1 AND NOT (id = ANY($2::text[]))', [session.id, flags.map((f) => f.id)]);
    await client.query('DELETE FROM clips WHERE session_id = $1 AND NOT (id = ANY($2::text[]))', [session.id, clips.map((c) => c.id)]);
    await insertRows(
      client,
      'clips',
      CLIP_COLUMNS,
      clips.map((c) => [c.id, session.id, c.flagIds, c.startMs, c.endMs, t(c.startMs), t(c.endMs), uri(c.path), uri(c.thumbPath), c.status, c.error ?? null]),
      upsert(CLIP_COLUMNS),
    );
    await insertRows(
      client,
      'flags',
      FLAG_COLUMNS,
      flags.map((f) => [
        f.id, session.id, f.type, f.startMs, f.endMs, t(f.startMs), t(f.endMs),
        f.severity, f.source, JSON.stringify(f.evidence),
        // A clipId without a clip row would fail the foreign key; generateClips never writes one.
        f.clipId !== undefined && clipIds.has(f.clipId) ? f.clipId : null,
        f.explanation ? JSON.stringify(f.explanation) : null,
      ]),
      upsert(FLAG_COLUMNS),
    );
    await client.query('COMMIT');
    return { flags: flags.length, clips: clips.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    const msg = err instanceof Error ? err.message : String(err);
    if (/relation "(flags|clips)" does not exist/.test(msg)) throw new Error(`${msg}. Run \`npm run db:migrate\` first.`);
    throw err;
  } finally {
    await client.end().catch(() => undefined);
  }
}
