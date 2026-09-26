// Detector seam. A detector reads one recorded session and returns the
// moments it thinks are worth reviewing. Everything downstream (flags.json,
// clips, the review page, the explainer) works the same whatever found them.
//
// To add a detector: write a Detector, build its flags with detectorFlag() so
// ids stay stable across re-runs, and append it to DETECTORS. runDetectors()
// replaces all detector flags with the new results and keeps manual ones.
// A detector that throws is logged and skipped; the others still run.

import { MIN_VITALS_CONFIDENCE } from '../../presage/constants';
import type { Flag, FlagEvidence, FlagSeverity, FlagType } from '../../shared/flags';
import type { FaceSample, SampleRecord, Session, ValidationEvent, VitalsSample } from '../../shared/session-types';
import { flagIdFor } from './ids';

/** A recorded session, ready for analysis. All sample arrays are sorted by tMs, with split rows merged (mergeSampleRecords). */
export interface LoadedSession {
  session: Session;
  /** Absolute path of the session folder. */
  dir: string;
  samples: SampleRecord[];
  vitals: VitalsSample[];
  face: FaceSample[];
  validation: ValidationEvent[];
}

export type Detector = (session: LoadedSession) => Flag[];

/** Builds a detector flag with a deterministic id. Times are rounded to whole ms. */
export function detectorFlag(
  session: Session,
  f: { type: FlagType; startMs: number; endMs: number; severity: FlagSeverity; evidence: FlagEvidence },
): Flag {
  const startMs = Math.round(f.startMs);
  const endMs = Math.round(f.endMs);
  return {
    id: flagIdFor(session.id, 'detector', f.type, startMs, endMs),
    sessionId: session.id,
    type: f.type,
    startMs,
    endMs,
    severity: f.severity,
    source: 'detector',
    evidence: f.evidence,
    explanation: null,
  };
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
};

const round1 = (x: number): number => Math.round(x * 10) / 10;

// ---------------------------------------------------------------------------
// PLACEHOLDER: not real detection logic.
//
// A deliberately simple high-pulse rule that exists only so the
// flag -> clip -> review pipeline can be run end to end on recorded sessions.
// Replace it (and its tests in detectors.test.ts) with the real detector; the
// thresholds below were not tuned on anything.
//
// Rule: baseline = median pulse over the first 30 s of the session; flag every
// stretch where pulse stays above baseline + 15 bpm for 5 s or more. Only
// readings at or above the SDK's confidence cut-off count. A stretch ends at
// the first reading at or below the threshold, or at a gap of more than 3 s
// between readings. It runs from its first to its last reading above the
// threshold.

export const HIGH_HR_PLACEHOLDER = {
  baselineWindowMs: 30_000,
  /** Fewer baseline readings than this: no baseline, no flags. */
  minBaselineReadings: 5,
  riseBpm: 15,
  minDurationMs: 5_000,
  maxGapMs: 3_000,
} as const;

export const highHrPlaceholder: Detector = ({ session, vitals }) => {
  const cfg = HIGH_HR_PLACEHOLDER;
  const pulse: { tMs: number; bpm: number }[] = [];
  for (const v of vitals) {
    if (v.pulseBpm !== null && v.pulseConfidence !== null && v.pulseConfidence >= MIN_VITALS_CONFIDENCE.pulse) pulse.push({ tMs: v.tMs, bpm: v.pulseBpm });
  }
  const baselineReadings = pulse.filter((p) => p.tMs < cfg.baselineWindowMs).map((p) => p.bpm);
  if (baselineReadings.length < cfg.minBaselineReadings) return [];
  const baselineBpm = median(baselineReadings);
  const thresholdBpm = baselineBpm + cfg.riseBpm;

  const flags: Flag[] = [];
  let run: { tMs: number; bpm: number }[] = [];
  const closeRun = (): void => {
    const first = run[0];
    const last = run.at(-1);
    if (first && last && last.tMs - first.tMs >= cfg.minDurationMs) {
      const peakBpm = Math.max(...run.map((p) => p.bpm));
      const excess = peakBpm - baselineBpm;
      flags.push(
        detectorFlag(session, {
          type: 'high_hr',
          startMs: first.tMs,
          endMs: last.tMs,
          severity: excess >= 30 ? 'high' : excess >= 20 ? 'medium' : 'low',
          evidence: {
            placeholder: true,
            baselineBpm: round1(baselineBpm),
            thresholdBpm: round1(thresholdBpm),
            peakBpm: round1(peakBpm),
            meanBpm: round1(run.reduce((sum, p) => sum + p.bpm, 0) / run.length),
            readings: run.length,
          },
        }),
      );
    }
    run = [];
  };
  for (const p of pulse) {
    const prev = run.at(-1);
    if (prev && p.tMs - prev.tMs > cfg.maxGapMs) closeRun();
    if (p.bpm > thresholdBpm) run.push(p);
    else closeRun();
  }
  closeRun();
  return flags;
};

// ---------------------------------------------------------------------------

/** Every detector runDetectors() runs, in order. */
export const DETECTORS: readonly Detector[] = [highHrPlaceholder];
