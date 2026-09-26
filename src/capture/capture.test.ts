import { describe, expect, it } from 'vitest';
import type { PresageSample } from '../presage/types';
import { mergeSampleRecords, type SampleRecord } from '../shared/session-types';
import { computeAnchor, matchSdkOffset, toVideoMs } from './clockMatch';
import { isoMicros, parseSamples, pgClientConfig } from './main/db';
import { FACE_HOLDBACK_US, SampleAssembler, headPose } from './samples';

// Camera frames at ~31 fps with the jitter seen in a real dump: gaps of
// 31-33 ms in 100 µs steps, and the occasional late frame.
function rawFrames(n: number, start = 3_477_721_100): number[] {
  let seed = 7;
  const rand = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const out: number[] = [];
  let t = start;
  for (let i = 0; i < n; i++) {
    out.push(t);
    t += rand() < 0.05 ? 47_800 : 31_000 + Math.floor(rand() * 21) * 100;
  }
  return out;
}

describe('matchSdkOffset', () => {
  const raws = rawFrames(300);
  const C = 1_790_438_874_920_900;
  // The SDK starts ~1 s after the probe and reports its frames with ±100 µs rounding.
  const sdk = raws.slice(35, 95).map((r, i) => r + C + ((i % 3) - 1) * 100);

  it('recovers the SDK offset from matching frames', () => {
    const m = matchSdkOffset(sdk, raws, { expectedUs: C - 65_000 });
    expect(m).not.toBeNull();
    expect(Math.abs((m?.sdkOffsetUs ?? 0) - C)).toBeLessThanOrEqual(100);
    expect(m?.hits).toBe(sdk.length);
    expect(m?.runnerUpHits).toBeLessThan(sdk.length * 0.6);
  });

  it('returns null when the SDK frames are not in the probe window', () => {
    expect(matchSdkOffset(sdk, rawFrames(300, 9_000_000_000), { expectedUs: C, windowUs: 1_000_000 })).toBeNull();
  });
});

describe('computeAnchor', () => {
  it('uses frame matching when all inputs are known', () => {
    const a = computeAnchor({ recorderStartEpochMs: 1_000_000, sdkOffsetUs: 5_065_000, videoStartRawUs: 2_000_000, probeEpochOffsetUs: 5_000_000 });
    expect(a.method).toBe('frame-matched');
    expect(a.sdkToVideoOffsetUs).toBe(7_065_000);
    expect(a.sdkBiasMs).toBe(65);
    expect(a.videoStartEpochMs).toBe(7_000);
    // The SDK frame captured at the first recorded frame maps to tMs 0.
    expect(toVideoMs(2_000_000 + 5_065_000, a.sdkToVideoOffsetUs)).toBe(0);
  });

  it('falls back to the wall clock', () => {
    const a = computeAnchor({ recorderStartEpochMs: 1_790_000_000_000, sdkOffsetUs: null, videoStartRawUs: 1, probeEpochOffsetUs: 1 });
    expect(a).toEqual({ method: 'wall-clock', videoStartEpochMs: 1_790_000_000_000, sdkToVideoOffsetUs: 1_790_000_000_000_000, sdkBiasMs: null });
  });
});

const emptySample = (tUs: number): PresageSample => ({
  tUs,
  tMs: 0,
  pulse: [],
  breathing: [],
  hrv: [],
  blinking: [],
  talking: [],
  expressions: [],
  landmarks: null,
  landmarkSets: [],
  gaze: null,
  groups: { face: true, cardio: false, breathing: false },
});

describe('SampleAssembler', () => {
  const toMs = (tUs: number): number => toVideoMs(tUs, 0);

  it('merges one frame split across packets and holds it back until the stream moves on', () => {
    const a = new SampleAssembler();
    const f1 = 1_000_000;
    a.addSample({ ...emptySample(f1), expressions: [{ tUs: f1, scores: { happy: 90, neutral: 10 }, top: 'happy', topConfidence: 90, stable: true }] });
    expect(a.drain(toMs)).toEqual([]);
    // Blink for the same frame arrives a packet later.
    a.addSample({ ...emptySample(f1 + 33_000), blinking: [{ tUs: f1, detected: true, stable: true }] });
    a.addSample({ ...emptySample(f1 + FACE_HOLDBACK_US + 1), talking: [{ tUs: f1 + FACE_HOLDBACK_US + 1, detected: false, stable: true }] });
    const rows = a.drain(toMs);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.kind).toBe('face');
    if (row?.kind !== 'face') return;
    expect(row.tMs).toBe(1000);
    expect(row.blinking).toBe(true);
    expect(row.expressions?.happy).toBeCloseTo(0.9);
    expect(row.expressions?.sad).toBe(0);
    // The newer frame comes out on the final drain.
    expect(a.drain(toMs, true)).toHaveLength(1);
  });

  it('emits vitals immediately at their own timestamps', () => {
    const a = new SampleAssembler();
    a.addSample({ ...emptySample(20_000_000), pulse: [{ tUs: 18_700_000, value: 72.345, confidence: 61.2, stable: true }] });
    expect(a.drain(toMs)).toEqual([
      expect.objectContaining({ kind: 'vitals', tMs: 18_700, pulseBpm: 72.35, pulseConfidence: 61.2, pulseStable: true, breathingRate: null }),
    ]);
  });

  it('keeps only validation changes', () => {
    const a = new SampleAssembler();
    const v = (tUs: number, code: number, name: string) => ({ tUs, tMs: 0, code, name: name as 'Ok', ok: code === 0, hint: '', advice: '' });
    a.addValidation(v(1_000, 0, 'Ok'));
    a.addValidation(v(34_000, 0, 'Ok'));
    a.addValidation(v(67_000, 12, 'ExcessiveMotion'));
    a.addValidation(v(100_000, 0, 'Ok'));
    expect(a.drain(toMs).map((r) => (r.kind === 'validation' ? `${r.name}@${r.tMs}` : r.kind))).toEqual(['Ok@1', 'ExcessiveMotion@67', 'Ok@100']);
    expect(a.firstTimestampUs).toBe(1_000);
  });
});

describe('headPose', () => {
  it('is ~0 yaw for a symmetric face and grows positive when the nose moves image-right', () => {
    const pts = Array.from({ length: 478 }, () => ({ x: 0, y: 0 }));
    const set = (i: number, x: number, y: number): void => {
      pts[i] = { x, y };
    };
    set(234, 100, 200);
    set(454, 300, 200);
    set(33, 140, 150);
    set(263, 260, 150);
    set(152, 200, 350);
    set(1, 200, 212); // drop 62 of 200 = 0.31 -> pitch 0
    expect(headPose(pts)).toEqual({ yaw: 0, pitch: 0 });
    set(1, 240, 212);
    expect(headPose(pts)?.yaw).toBeCloseTo(0.4);
  });
});

describe('mergeSampleRecords', () => {
  it('folds rows with the same kind and tMs and sorts by tMs', () => {
    const base = { blinking: null, talking: null, expressions: null, eyeLandmarks: null, headPose: null, gaze: null };
    const recs: SampleRecord[] = [
      { kind: 'face', tMs: 66, ...base, talking: true },
      { kind: 'face', tMs: 33, ...base, blinking: true },
      { kind: 'face', tMs: 33, ...base, talking: false },
    ];
    expect(mergeSampleRecords(recs)).toEqual([
      { kind: 'face', tMs: 33, ...base, blinking: true, talking: false },
      { kind: 'face', tMs: 66, ...base, talking: true },
    ]);
  });
});

describe('db helpers', () => {
  it('forces verified TLS and rejects weak sslmode', () => {
    const cfg = pgClientConfig('postgres://u:p@host.tsdb.cloud.timescale.com:5432/tsdb?sslmode=require');
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
    expect(cfg.connectionString).not.toContain('sslmode');
    expect(() => pgClientConfig('postgres://u:p@h/db?sslmode=disable')).toThrow(/TLS is required/);
    expect(() => pgClientConfig('mysql://h/db')).toThrow();
  });

  it('formats microsecond timestamps', () => {
    expect(isoMicros(1_790_442_351_484_123.2)).toBe('2026-09-26T17:05:51.484123Z');
    expect(isoMicros(1_790_442_351_000_007)).toBe('2026-09-26T17:05:51.000007Z');
  });

  it('skips a torn last line', () => {
    const text = '{"kind":"validation","tMs":1,"code":0,"name":"Ok","hint":""}\n{"kind":"face","tMs":';
    expect(parseSamples(text)).toHaveLength(1);
  });
});
