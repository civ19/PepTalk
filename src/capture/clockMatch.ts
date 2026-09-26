// Clock alignment math (pure; no DOM). See sessionCapture.ts for how the
// inputs are collected.
//
// Measured with `npm run debug:dump` (SDK 3.3.0, Electron 44, Windows):
//  - SmartSpectra stamps every frame with VideoFrame.timestamp + C, where
//    VideoFrame.timestamp is Chromium's capture clock (monotonic, not
//    page-relative) and C is fixed per SDK instance: Date.now() * 1000 minus
//    the raw timestamp of the first frame its frame loop reads. All 1661 face
//    and 1711 validation timestamps in a 60 s dump matched a raw frame
//    timestamp to within ±200 µs with one C.
//  - Because C comes from Date.now() at *read* time (after the SDK's start
//    handshake), SDK epoch timestamps ran ~65 ms ahead of real capture time.
//  - Every clone of the camera track sees the same frames with the same raw
//    timestamps, so a probe on a clone can observe the SDK's clock domain.
//
// So instead of trusting either epoch anchor, we find C by matching and
// express everything relative to the raw timestamp of the first recorded frame.

import type { ClockAnchor } from '../shared/session-types';

export interface OffsetMatch {
  /** C: SDK timestamp minus raw capture timestamp, in µs. */
  sdkOffsetUs: number;
  /** SDK timestamps that matched a probe frame at this offset. */
  hits: number;
  /** Best competing offset's hits (should be far lower). */
  runnerUpHits: number;
}

export interface MatchOptions {
  /** Rough expected C (e.g. the probe's own epoch offset); candidates further than windowUs away are ignored. */
  expectedUs: number;
  windowUs?: number;
  /**
   * How close SDK and probe timestamps must be. They agree to ~100 µs (rounding);
   * frames are ~32 ms apart with only ~1 ms of jitter, so a loose tolerance
   * lets offsets shifted by whole frames score almost as well as the true one.
   */
  toleranceUs?: number;
  /** Fraction of SDK timestamps that must match. */
  minHitFraction?: number;
}

/** True if sorted `xs` has a value within tol of x. */
function hasNear(xs: readonly number[], x: number, tol: number): boolean {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid] ?? 0) < x - tol) lo = mid + 1;
    else hi = mid;
  }
  return lo < xs.length && (xs[lo] ?? Number.POSITIVE_INFINITY) <= x + tol;
}

/**
 * Finds C such that SDK frame timestamps minus C land on raw capture
 * timestamps the probe saw. Candidates come from pairing the first few SDK
 * timestamps with every probe frame; each is scored by how many SDK
 * timestamps it explains. Returns null unless one candidate explains nearly
 * all of them and clearly beats the rest (real 60-frame windows: 60 vs <= 20).
 */
export function matchSdkOffset(sdkTsUs: readonly number[], rawTsUs: readonly number[], opts: MatchOptions): OffsetMatch | null {
  const windowUs = opts.windowUs ?? 5_000_000;
  const tol = opts.toleranceUs ?? 200;
  const minHitFraction = opts.minHitFraction ?? 0.9;
  if (sdkTsUs.length === 0 || rawTsUs.length === 0) return null;
  const raws = [...rawTsUs].sort((a, b) => a - b);

  const candidates = new Set<number>();
  // A few seeds, in case the probe missed the very first SDK frame.
  for (const t of sdkTsUs.slice(0, 3)) {
    for (const r of raws) {
      const c = t - r;
      if (Math.abs(c - opts.expectedUs) <= windowUs) candidates.add(c);
    }
  }
  const scored = [...candidates]
    .map((c) => ({ c, hits: sdkTsUs.filter((t) => hasNear(raws, t - c, tol)).length }))
    .sort((a, b) => b.hits - a.hits);
  const best = scored[0];
  if (!best) return null;
  // Candidates within tolerance of the winner are the same offset seen from another seed.
  const runnerUp = scored.find((x) => Math.abs(x.c - best.c) > 2 * tol)?.hits ?? 0;
  if (best.hits < Math.ceil(sdkTsUs.length * minHitFraction) || runnerUp > best.hits * 0.75) return null;

  // Refine: median residual over the matched frames.
  const residuals: number[] = [];
  for (const t of sdkTsUs) {
    const target = t - best.c;
    let nearest: number | null = null;
    for (const r of raws) if (Math.abs(r - target) <= tol && (nearest === null || Math.abs(r - target) < Math.abs(nearest - target))) nearest = r;
    if (nearest !== null) residuals.push(t - nearest);
  }
  residuals.sort((a, b) => a - b);
  return { sdkOffsetUs: Math.round(residuals[Math.floor(residuals.length / 2)] ?? best.c), hits: best.hits, runnerUpHits: runnerUp };
}

export interface AnchorInputs {
  /** Wall clock when MediaRecorder.start() was called (fallback anchor). */
  recorderStartEpochMs: number;
  /** C from matchSdkOffset, if matching succeeded. */
  sdkOffsetUs: number | null;
  /** Raw capture timestamp of the first frame the recorder received. */
  videoStartRawUs: number | null;
  /** min(read wall clock - raw timestamp) over probe frames: raw -> epoch with ~1 ms read latency. */
  probeEpochOffsetUs: number | null;
}

export function computeAnchor(i: AnchorInputs): Omit<ClockAnchor, 'firstSampleTMs' | 'containerStartMs'> {
  if (i.sdkOffsetUs !== null && i.videoStartRawUs !== null && i.probeEpochOffsetUs !== null) {
    return {
      method: 'frame-matched',
      videoStartEpochMs: round3((i.videoStartRawUs + i.probeEpochOffsetUs) / 1000),
      sdkToVideoOffsetUs: i.sdkOffsetUs + i.videoStartRawUs,
      sdkBiasMs: round3((i.sdkOffsetUs - i.probeEpochOffsetUs) / 1000),
    };
  }
  return {
    method: 'wall-clock',
    videoStartEpochMs: i.recorderStartEpochMs,
    sdkToVideoOffsetUs: i.recorderStartEpochMs * 1000,
    sdkBiasMs: null,
  };
}

/** SDK timestamp (µs) -> ms since video start, at 0.1 ms resolution (the SDK's own granularity). */
export function toVideoMs(tUs: number, sdkToVideoOffsetUs: number): number {
  return Math.round((tUs - sdkToVideoOffsetUs) / 100) / 10;
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;
