import { describe, expect, it, vi } from 'vitest';
import { SessionRecorder } from './sessionRecorder';
import type { PresageSample, ValidationEvent, ValidationName } from './types';

const START_MS = 1_750_000_000_000; // arbitrary epoch ms
const us = (sessionMs: number): number => (START_MS + sessionMs) * 1000;

function sample(partial: Partial<PresageSample> & { at: number }): PresageSample {
  const { at, ...rest } = partial;
  return {
    tUs: us(at),
    tMs: at,
    pulse: [],
    breathing: [],
    hrv: [],
    blinking: [],
    talking: [],
    expressions: [],
    landmarks: null,
    landmarkSets: [],
    gaze: null,
    groups: { face: false, cardio: false, breathing: false },
    ...rest,
  };
}

function validation(at: number, name: ValidationName, code: number): ValidationEvent {
  return { tUs: us(at), tMs: at, code, name, ok: name === 'Ok', hint: '', advice: name === 'Ok' ? '' : 'x' };
}

function recorderAt(endMs: number, persist?: () => Promise<string | null>) {
  let now = START_MS;
  const rec = new SessionRecorder({ now: () => now, ...(persist ? { persist } : {}) });
  rec.start();
  return { rec, finish: () => ((now = START_MS + endMs), rec.stop()) };
}

describe('SessionRecorder', () => {
  it('filters pulse by confidence, counts drops, and builds a 10 s timeline', async () => {
    const { rec, finish } = recorderAt(25_000);
    rec.addSample(
      sample({
        at: 5_000,
        groups: { face: false, cardio: true, breathing: false },
        pulse: [
          { tUs: us(2_000), value: 70, confidence: 80, stable: true },
          { tUs: us(4_000), value: 200, confidence: 10, stable: false }, // dropped
          { tUs: us(12_000), value: 80, confidence: 60, stable: true },
          { tUs: us(21_000), value: 90, confidence: 40, stable: true }, // exactly at threshold: kept
        ],
      }),
    );
    const { summary } = await finish();
    expect(summary.durationMs).toBe(25_000);
    expect(summary.pulse).toMatchObject({ avg: 80, min: 70, max: 90, samplesUsed: 3, samplesDroppedLowConfidence: 1 });
    expect(summary.pulse.timeline.map((b) => [b.startMs, b.endMs, b.avg, b.samples])).toEqual([
      [0, 10_000, 70, 1],
      [10_000, 20_000, 80, 1],
      [20_000, 25_000, 90, 1],
    ]);
    expect(summary.series.pulse[0]).toMatchObject({ tMs: 2_000, tUs: us(2_000), bpm: 70 });
    expect(summary.emptyMetricGroups).toEqual(['face', 'breathing']);
  });

  it('ignores readings already seen in an earlier packet', async () => {
    const { rec, finish } = recorderAt(10_000);
    const r = { tUs: us(1_000), value: 70, confidence: 90, stable: true };
    rec.addSample(sample({ at: 1_000, pulse: [r] }));
    rec.addSample(sample({ at: 2_000, pulse: [r, { ...r, tUs: us(2_000), value: 72 }] }));
    const { summary } = await finish();
    expect(summary.pulse.samplesUsed).toBe(2);
  });

  it('excludes breathing readings whose 30 s window was mostly talking', async () => {
    const { rec, finish } = recorderAt(90_000);
    // Talking (detected every 100 ms) from 0-30 s, silent from 30-90 s.
    const talking = [];
    for (let t = 0; t < 90_000; t += 100) talking.push({ tUs: us(t), detected: t < 30_000, stable: true });
    rec.addSample(sample({ at: 0, talking }));
    rec.addSample(
      sample({
        at: 80_000,
        breathing: [
          { tUs: us(30_000), value: 20, confidence: 90, stable: true }, // window 0-30 s: all talking
          { tUs: us(75_000), value: 12, confidence: 90, stable: true }, // window 45-75 s: silent
          { tUs: us(80_000), value: 30, confidence: 20, stable: false }, // low confidence
        ],
      }),
    );
    const { summary } = await finish();
    expect(summary.breathing).toMatchObject({
      avg: 12,
      samplesUsed: 1,
      samplesExcludedWhileTalking: 1,
      samplesDroppedLowConfidence: 1,
    });
    expect(summary.series.breathing.map((b) => b.excludedWhileTalking)).toEqual([true, false]);
    expect(summary.talking.ratio).toBeCloseTo(1 / 3, 2);
    expect(summary.talking.intervals).toEqual([{ startMs: 0, endMs: 30_000 }]);
  });

  it('summarizes eye contact, look-aways and their directions', async () => {
    const { rec, finish } = recorderAt(20_000);
    for (let t = 0; t < 20_000; t += 100) {
      // A 2.5 s look down, plus a 0.3 s glance left that is too short to list.
      const direction = t >= 10_000 && t < 12_500 ? 'down' : t >= 5_000 && t < 5_300 ? 'left' : 'camera';
      rec.addSample(sample({ at: t, gaze: { tUs: us(t), h: 0, v: 0, direction } }));
    }
    const { summary } = await finish();
    expect(summary.gaze.observedMs).toBe(20_000);
    expect(summary.gaze.eyeContactRatio).toBe(0.86);
    expect(summary.gaze.lookAways).toEqual([{ startMs: 10_000, endMs: 12_500, direction: 'down' }]);
    expect(summary.gaze.longestLookAwayMs).toBe(2_500);
    expect(summary.gaze.awayDirections).toEqual({ down: 0.893, left: 0.107 });
    expect(summary.gaze.timeline.map((b) => b.eyeContactRatio)).toEqual([0.97, 0.75]);
  });

  it('counts blink onsets and normalizes per observed minute', async () => {
    const { rec, finish } = recorderAt(60_000);
    const blinking = [];
    for (let t = 0; t < 60_000; t += 100) {
      // 3-frame blink every 4 s -> 15 blinks per minute
      blinking.push({ tUs: us(t), detected: t % 4_000 < 300, stable: true });
    }
    rec.addSample(sample({ at: 0, blinking }));
    const { summary } = await finish();
    expect(summary.blinks.count).toBe(15);
    expect(summary.blinks.perMinute).toBe(15);
    expect(summary.blinks.onsetsMs.slice(0, 2)).toEqual([0, 4_000]);
  });

  it('computes expression distribution and per-window dominant expression', async () => {
    const { rec, finish } = recorderAt(20_000);
    const expressions = [
      { tUs: us(1_000), top: 'neutral' as const },
      { tUs: us(2_000), top: 'neutral' as const },
      { tUs: us(3_000), top: 'happy' as const },
      { tUs: us(12_000), top: 'happy' as const },
    ].map((e) => ({ ...e, scores: {}, topConfidence: 50, stable: true }));
    rec.addSample(sample({ at: 0, expressions }));
    const { summary } = await finish();
    expect(summary.expressions.distribution).toEqual({ neutral: 0.5, happy: 0.5 });
    expect(summary.expressions.timeline.map((w) => w.dominant)).toEqual(['neutral', 'happy']);
  });

  it('reports face validity (excluding camera tuning) and merged issue intervals', async () => {
    const { rec, finish } = recorderAt(40_000);
    rec.addValidation(validation(0, 'CameraTuning', 10));
    rec.addValidation(validation(5_000, 'Ok', 0));
    rec.addValidation(validation(20_000, 'TooDark', 5));
    rec.addValidation(validation(25_000, 'TooDark', 5)); // repeated code: merged
    rec.addValidation(validation(30_000, 'Ok', 0));
    const { summary } = await finish();
    expect(summary.face).toEqual({ validRatio: 0.714, validMs: 25_000, observedMs: 35_000 });
    expect(summary.validationIssues).toEqual([{ code: 5, name: 'TooDark', hint: 'x', startMs: 20_000, endMs: 30_000 }]);
  });

  it('keeps only the latest stable HRV above threshold', async () => {
    const { rec, finish } = recorderAt(90_000);
    rec.addSample(
      sample({
        at: 80_000,
        hrv: [
          { tUs: us(40_000), rmssdMs: 10, sdnnMs: 10, meanNnMs: 800, baevsky: 100, confidence: 0, stable: false },
          { tUs: us(65_000), rmssdMs: 42, sdnnMs: 50, meanNnMs: 820, baevsky: 90, confidence: 70, stable: true },
          { tUs: us(70_000), rmssdMs: 44, sdnnMs: 51, meanNnMs: 830, baevsky: 88, confidence: 55, stable: false },
        ],
      }),
    );
    const { summary } = await finish();
    expect(summary.hrv.latestStable).toMatchObject({ tMs: 65_000, rmssdMs: 42 });
    expect(summary.hrv).toMatchObject({ samplesUsed: 2, samplesDroppedLowConfidence: 1 });
  });

  it('persists on stop and reports save failures without throwing', async () => {
    const persist = vi.fn(async () => 'sessions/x.json');
    const ok = recorderAt(1_000, persist);
    expect((await ok.finish()).savedTo).toBe('sessions/x.json');
    expect(persist).toHaveBeenCalledOnce();

    const bad = recorderAt(1_000, async () => {
      throw new Error('disk full');
    });
    expect(await bad.finish()).toMatchObject({ savedTo: null, saveError: 'disk full' });
  });

  it('produces JSON free of blood-pressure and clinical wording', async () => {
    const { finish } = recorderAt(1_000);
    const json = JSON.stringify((await finish()).summary);
    expect(json).not.toMatch(/pressure|arterial|apnea|medical|clinical|diagnos/i);
  });
});
