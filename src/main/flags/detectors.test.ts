import { describe, expect, it } from 'vitest';
import type { Session, VitalsSample } from '../../shared/session-types';
import { DETECTORS, highHrPlaceholder, type LoadedSession } from './detectors';

const session = { id: '405d0588-302d-4b44-9e4e-96c8a73c75fe' } as Session;

const pulse = (tMs: number, bpm: number, confidence = 80): VitalsSample => ({
  tMs,
  pulseBpm: bpm,
  pulseConfidence: confidence,
  pulseStable: confidence >= 40,
  hrvRmssdMs: null,
  hrvSdnnMs: null,
  hrvMeanNnMs: null,
  hrvBaevsky: null,
  hrvConfidence: null,
  hrvStable: null,
  breathingRate: null,
  breathingConfidence: null,
  breathingStable: null,
});

const loaded = (vitals: VitalsSample[]): LoadedSession => ({ session, dir: '', samples: [], vitals, face: [], validation: [] });

/** One reading every 800 ms from `fromMs` to `toMs` inclusive. */
const series = (fromMs: number, toMs: number, bpm: number | ((t: number) => number)): VitalsSample[] => {
  const out: VitalsSample[] = [];
  for (let t = fromMs; t <= toMs; t += 800) out.push(pulse(t, typeof bpm === 'number' ? bpm : bpm(t)));
  return out;
};

describe('highHrPlaceholder (placeholder detector)', () => {
  it('is registered', () => {
    expect(DETECTORS).toContain(highHrPlaceholder);
  });

  it('flags pulse above baseline + 15 for 5 s or more', () => {
    // Baseline 70 over the first 30 s, then 90 bpm from 40 s to 46.4 s.
    const vitals = [...series(14_000, 30_000, 70), ...series(30_800, 39_200, 72), ...series(40_000, 46_400, 90), ...series(47_200, 60_000, 72)];
    const flags = highHrPlaceholder(loaded(vitals));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      sessionId: session.id,
      type: 'high_hr',
      source: 'detector',
      startMs: 40_000,
      endMs: 46_400,
      severity: 'medium',
      evidence: { placeholder: true, baselineBpm: 70, thresholdBpm: 85, peakBpm: 90, meanBpm: 90, readings: 9 },
    });
    expect(flags[0]?.id).toMatch(/^[0-9a-f]{16}$/);
    // Same input, same id.
    expect(highHrPlaceholder(loaded(vitals))[0]?.id).toBe(flags[0]?.id);
  });

  it('ignores shorter rises, low-confidence readings and breaks at gaps', () => {
    const base = series(14_000, 29_600, 70);
    // 4.8 s above: too short.
    expect(highHrPlaceholder(loaded([...base, ...series(40_000, 44_800, 95), pulse(45_600, 70)]))).toEqual([]);
    // Long rise, but every reading is below the confidence cut-off.
    expect(highHrPlaceholder(loaded([...base, ...series(40_000, 50_000, 95).map((v) => ({ ...v, pulseConfidence: 20 }))]))).toEqual([]);
    // 3 s + 3.2 s above with a 3.2 s gap between them: two short runs, no flag.
    expect(highHrPlaceholder(loaded([...base, ...series(40_000, 43_200, 95), ...series(46_400, 49_600, 95)]))).toEqual([]);
  });

  it('needs a baseline', () => {
    expect(highHrPlaceholder(loaded(series(31_000, 60_000, 120)))).toEqual([]);
  });

  it('grades severity by how far the peak is above baseline', () => {
    const base = series(14_000, 29_600, 70);
    const severityAt = (bpm: number) => highHrPlaceholder(loaded([...base, ...series(40_000, 46_400, bpm)]))[0]?.severity;
    expect(severityAt(86)).toBe('low');
    expect(severityAt(92)).toBe('medium');
    expect(severityAt(101)).toBe('high');
  });
});
