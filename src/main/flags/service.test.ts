// FlagsService end to end with the bundled ffmpeg and an in-process Postgres
// (PGlite): flags -> detectors -> clip plan -> ffmpeg -> clips.json -> sync.
//
// The synthetic recording encodes time in brightness: frame N has luma
// 16 + (N mod 25) * 8. So reading one frame of a clip tells exactly which
// source frame it is, and a cut that is off by a single frame fails. Like a
// MediaRecorder file it has a variable frame rate (frame gaps of 46, 46 and
// 8 ms), and clips must keep those frame times.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Clip, ClipsFile, FlagsFile } from '../../shared/flags';
import type { SampleRecord, Session } from '../../shared/session-types';
import { uploadSession, type SqlClient } from '../../capture/main/db';
import { ffmpegPath, probe } from '../../capture/main/media';
import { FlagsService, parseNewFlag } from './service';

const ID = '405d0588-302d-4b44-9e4e-96c8a73c75fe';
const FPS = 30;
const DURATION_S = 60;
const ffmpeg = ffmpegPath() ?? 'ffmpeg';

let sessionsDir: string;
let dir: string;
let db: PGlite;
let service: FlagsService;
const updates: Clip[] = [];

/** Mean luma of the frame shown at `tSec` (the same decode path for source and clips). */
function lumaAt(file: string, tSec: number): number {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-ss', tSec.toFixed(3), '-i', file, '-frames:v', '1', '-vf', 'format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 });
  if (r.status !== 0 || r.stdout.length === 0) throw new Error(`luma read failed: ${r.stderr.toString()}`);
  return r.stdout.reduce((sum, v) => sum + v, 0) / r.stdout.length;
}
/** Presentation times (s) of the first `count` frames from `fromSec` on, relative to fromSec. */
function frameTimes(file: string, fromSec: number, count: number): number[] {
  const r = spawnSync(ffmpeg, ['-v', 'info', '-ss', fromSec.toFixed(3), '-i', file, '-frames:v', String(count), '-vf', 'showinfo', '-fps_mode', 'passthrough', '-f', 'null', '-']);
  // showinfo can see a few frames past -frames:v.
  return [...r.stderr.toString().matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1])).slice(0, count);
}
const readJson = <T>(name: string): T => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;
const mtime = (rel: string): number => statSync(join(dir, rel)).mtimeMs;

const pulse = (tMs: number, bpm: number): SampleRecord => ({
  kind: 'vitals', tMs, pulseBpm: bpm, pulseConfidence: 80, pulseStable: true,
  hrvRmssdMs: null, hrvSdnnMs: null, hrvMeanNnMs: null, hrvBaevsky: null, hrvConfidence: null, hrvStable: null,
  breathingRate: null, breathingConfidence: null, breathingStable: null,
});

beforeAll(async () => {
  sessionsDir = join(mkdtempSync(join(tmpdir(), 'flags-service-')), 'sessions');
  dir = join(sessionsDir, ID);
  mkdirSync(dir, { recursive: true });
  const gen = spawnSync(ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=gray:s=64x36:r=${FPS}:d=${DURATION_S}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${DURATION_S}`,
    // Frame N at N/30 s plus 0, 12.5 or 25 ms: between the 1/120 s grid points an encoder would snap to.
    '-vf', "geq=lum='16+mod(N\\,25)*8':cb=128:cr=128,settb=1/30000,setpts='(N/30+0.0125*mod(N\\,3))/TB'",
    '-fps_mode', 'passthrough', '-enc_time_base', '1:30000',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    join(dir, 'recording.mp4'),
  ]);
  if (gen.status !== 0) throw new Error(`could not make the test recording: ${gen.stderr.toString()}`);

  // Pulse every 800 ms from 5 s: baseline 70, then 95 for the readings from 35.4 s to 41.8 s (the placeholder detector's case).
  const samples: SampleRecord[] = [];
  for (let t = 5_000; t < 60_000; t += 800) samples.push(pulse(t, t >= 35_000 && t <= 42_200 ? 95 : 70));
  writeFileSync(join(dir, 'samples.ndjson'), `${samples.map((s) => JSON.stringify(s)).join('\n')}\n`);

  const session: Session = {
    schemaVersion: 1,
    id: ID,
    startedAtIso: '2026-09-26T17:48:16.716Z',
    durationMs: DURATION_S * 1000,
    recordingPath: 'recording.mp4',
    appVersion: '0.1.0',
    clock: { method: 'frame-matched', videoStartEpochMs: 1_790_444_896_716.2, sdkToVideoOffsetUs: 0, sdkBiasMs: null, firstSampleTMs: 5_000, containerStartMs: 0 },
    video: { mimeType: 'video/mp4;codecs=avc1,opus', width: 64, height: 36, frameRate: FPS, hasAudio: true, remuxed: true },
    status: 'complete',
    counts: { vitals: samples.length, face: 0, validation: 0 },
    upload: { status: 'uploaded', attemptedAt: null, error: null },
  };
  writeFileSync(join(dir, 'session.json'), JSON.stringify(session));

  db = new PGlite();
  await db.exec(`CREATE FUNCTION create_hypertable(relation regclass, time_column_name name, if_not_exists boolean DEFAULT false)
    RETURNS void LANGUAGE sql AS $$ SELECT $$;`);
  const migrations = join(__dirname, '../../../db/migrations');
  await db.exec(readFileSync(join(migrations, '001_init.sql'), 'utf8').replace(/^CREATE EXTENSION.*$/m, ''));
  await db.exec(readFileSync(join(migrations, '002_flags_clips.sql'), 'utf8'));
  const openDb = async (): Promise<SqlClient> => ({ query: (text, params) => db.query(text, params), end: async () => undefined });
  await uploadSession('postgres://pglite', dir, session, openDb);

  const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
  service = new FlagsService({ sessionsDir, databaseUrl: () => 'postgres://pglite', openDb, log: quiet });
  service.onClipUpdate((c) => updates.push(c));
}, 60_000);

describe('FlagsService', () => {
  it('adds manual flags, returns the existing one for a repeat, and validates input', async () => {
    const a = await service.add(ID, { type: 'manual', startMs: 10_000, endMs: 12_000 });
    await service.add(ID, { type: 'tense_expression', startMs: 14_000.4, endMs: 15_000, severity: 'high', evidence: { note: 'jaw' } });
    await service.add(ID, { type: 'manual', startMs: 52_000, endMs: 53_000 });
    expect(await service.add(ID, { type: 'manual', startMs: 10_000, endMs: 12_000 })).toEqual(a);
    expect(a).toMatchObject({ sessionId: ID, source: 'manual', severity: 'medium', evidence: {}, explanation: null });

    const { flags } = await service.list(ID);
    expect(flags.map((f) => [f.type, f.startMs, f.endMs])).toEqual([
      ['manual', 10_000, 12_000],
      ['tense_expression', 14_000, 15_000],
      ['manual', 52_000, 53_000],
    ]);
    await expect(service.add(ID, { type: 'manual', startMs: 61_000, endMs: 62_000 })).rejects.toThrow(/only 60000 ms long/);
    expect(() => parseNewFlag({ type: 'nope', startMs: 0, endMs: 1 })).toThrow(/flag type/);
    expect(() => parseNewFlag({ type: 'manual', startMs: 5, endMs: 1 })).toThrow(/startMs <= endMs/);
    expect(() => parseNewFlag({ type: 'manual', startMs: 0, endMs: 1, evidence: { x: { nested: 1 } } })).toThrow(/evidence/);
  });

  it('runs detectors, keeping manual flags', async () => {
    const found = await service.runDetectors(ID);
    expect(found.map((f) => [f.type, f.startMs, f.endMs, f.source])).toEqual([['high_hr', 35_400, 41_800, 'detector']]);
    // Twice: same flags, not duplicated.
    await service.runDetectors(ID);
    const { flags } = await service.list(ID);
    expect(flags.map((f) => f.type)).toEqual(['manual', 'tense_expression', 'high_hr', 'manual']);
  });

  it('cuts one clip per group of overlapping flags, exact to the frame', async () => {
    const clips = await service.generateClips(ID);
    expect(clips.map((c) => [c.startMs, c.endMs, c.status])).toEqual([
      [7_000, 17_000, 'ready'], // manual [10, 12] + tense [14, 15]: padded windows overlap
      [32_400, 43_800, 'ready'], // detector
      [49_000, 55_000, 'ready'], // manual [52, 53]
    ]);
    const { flags } = await service.list(ID);
    expect(clips[0]?.flagIds).toEqual([flags[0]?.id, flags[1]?.id]);
    for (const f of flags) expect(clips.find((c) => c.id === f.clipId)?.flagIds).toContain(f.id);

    // Files on disk match clips.json, and the JSON matches what generateClips returned.
    expect(readJson<ClipsFile>('clips.json').clips).toEqual(clips);
    expect(readJson<FlagsFile>('flags.json').flags).toEqual(flags);
    for (const c of clips) {
      const info = await probe(join(dir, c.path));
      expect(Math.abs((info.durationMs ?? 0) - (c.endMs - c.startMs))).toBeLessThan(120);
      // The clip's first frame is the source frame at startMs (luma steps 8 per frame).
      expect(lumaAt(join(dir, c.path), 0)).toBeCloseTo(lumaAt(join(dir, 'recording.mp4'), c.startMs / 1000), -0.5);
      // Its frames keep the recording's own irregular frame times.
      const clipTimes = frameTimes(join(dir, c.path), 0, 12);
      const sourceTimes = frameTimes(join(dir, 'recording.mp4'), c.startMs / 1000, 12);
      expect(clipTimes).toHaveLength(12);
      clipTimes.forEach((t, i) => expect(Math.abs(t - (sourceTimes[i] ?? Number.NaN))).toBeLessThan(0.0015));
      const jpg = readFileSync(join(dir, c.thumbPath));
      expect([jpg[0], jpg[1]]).toEqual([0xff, 0xd8]);
    }
    // Progress events: each clip pending, then ready.
    for (const c of clips) expect(updates.filter((u) => u.id === c.id).map((u) => u.status)).toEqual(['pending', 'ready']);
    expect((await readdir(join(dir, 'clips'))).sort()).toEqual(clips.flatMap((c) => [`${c.id}.jpg`, `${c.id}.mp4`]).sort());
  }, 60_000);

  it('regenerating is idempotent: nothing is re-encoded', async () => {
    const before = readJson<ClipsFile>('clips.json').clips;
    const times = before.map((c) => [mtime(c.path), mtime(c.thumbPath)]);
    updates.length = 0;
    const again = await service.generateClips(ID);
    expect(again).toEqual(before);
    expect(before.map((c) => [mtime(c.path), mtime(c.thumbPath)])).toEqual(times);
    expect(updates.every((u) => u.status === 'ready')).toBe(true);
  });

  it('a flag that joins a group replaces its clip and removes the old files', async () => {
    const old = readJson<ClipsFile>('clips.json').clips[0];
    // Pads to [14.5, 20]: overlaps the first clip's window, which grows to [7, 20].
    await service.add(ID, { type: 'slow_pace', startMs: 17_500, endMs: 18_000 });
    const clips = await service.generateClips(ID);
    expect(clips.map((c) => [c.startMs, c.endMs, c.flagIds.length])).toEqual([
      [7_000, 20_000, 3],
      [32_400, 43_800, 1],
      [49_000, 55_000, 1],
    ]);
    const files = await readdir(join(dir, 'clips'));
    expect(files).not.toContain(`${old?.id ?? ''}.mp4`);
    expect(files).toHaveLength(6);
  }, 60_000);

  it('mirrors flags.json and clips.json to the database', async () => {
    const result = await service.sync(ID);
    expect(['synced', 'unchanged']).toContain(result.status);
    const { flags, clips } = await service.list(ID);
    const dbFlags = await db.query<{ id: string; clip_id: string | null; start_ms: number; end_ms: number; type: string }>(
      'SELECT id, clip_id, start_ms, end_ms, type FROM flags ORDER BY start_ms, id',
    );
    expect(dbFlags.rows).toEqual(
      [...flags]
        .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id))
        .map((f) => ({ id: f.id, clip_id: f.clipId ?? null, start_ms: f.startMs, end_ms: f.endMs, type: f.type })),
    );
    const dbClips = await db.query<{ id: string; flag_ids: string[]; status: string }>('SELECT id, flag_ids, status FROM clips ORDER BY start_ms');
    expect(dbClips.rows).toEqual(clips.map((c) => ({ id: c.id, flag_ids: c.flagIds, status: c.status })));
    expect(await service.sync(ID)).toEqual({ status: 'unchanged' });
  });

  it('refuses to cut clips while the session is recording', async () => {
    const file = join(dir, 'session.json');
    const session = JSON.parse(readFileSync(file, 'utf8')) as Session;
    writeFileSync(file, JSON.stringify({ ...session, status: 'recording' }));
    try {
      await expect(service.generateClips(ID)).rejects.toThrow(/still recording/);
      await expect(service.runDetectors(ID)).rejects.toThrow(/still recording/);
    } finally {
      writeFileSync(file, JSON.stringify(session));
    }
  });
});
