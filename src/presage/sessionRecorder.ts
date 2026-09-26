// Framework-agnostic session recorder: no DOM, no SDK, no Electron imports.
// Feed it PresageSample / ValidationEvent objects between start() and stop();
// stop() builds a SessionSummary and hands it to an injected `persist`
// function (the Electron host writes sessions/<iso-date>.json).

import {
  BREATHING_MAX_TALKING_FRACTION,
  BREATHING_WINDOW_MS,
  MIN_VITALS_CONFIDENCE,
  TIMELINE_BUCKET_MS,
} from './constants';
import type {
  DetectionReading,
  ExpressionName,
  ExpressionWindow,
  HrvReading,
  Interval,
  MetricGroup,
  PresageSample,
  RateReading,
  RateSummary,
  SessionSummary,
  TimeWindowStat,
  ValidationEvent,
  ValidationIssueInterval,
} from './types';

/** Saves a finished summary; resolves to where it was written (or null). */
export type PersistFn = (summary: SessionSummary) => Promise<string | null>;

export interface SessionRecorderOptions {
  persist?: PersistFn;
  /** Epoch-ms clock; injectable for tests. */
  now?: () => number;
}

export interface RecordedSession {
  summary: SessionSummary;
  savedTo: string | null;
  saveError: string | null;
}

/** Raw data collected during a session; input to summarizeSession(). */
export interface SessionData {
  startedAtEpochMs: number;
  endedAtEpochMs: number;
  pulse: RateReading[];
  breathing: RateReading[];
  hrv: HrvReading[];
  blinking: DetectionReading[];
  talking: DetectionReading[];
  expressions: { tUs: number; top: ExpressionName | null }[];
  validation: ValidationEvent[];
  groupsSeen: ReadonlySet<MetricGroup>;
  firstSdkTimestampUs: number | null;
  lastSdkTimestampUs: number | null;
}

// A per-frame detection (blink/talking) is assumed to hold until the next
// reading, but never longer than this. Stops a lost face from being counted as
// minutes of "talking".
const DETECTION_MAX_HOLD_MS = 1_000;
// Talking intervals closer than this are merged (pauses between words).
const TALKING_MERGE_GAP_MS = 400;
// Blinks-per-minute needs at least this much observed face time to mean anything.
const MIN_BLINK_OBSERVATION_MS = 10_000;

const ALL_GROUPS: readonly MetricGroup[] = ['face', 'cardio', 'breathing'];

export class SessionRecorder {
  private readonly persist: PersistFn | undefined;
  private readonly now: () => number;
  private data: SessionData | null = null;
  private groupsSeen = new Set<MetricGroup>();
  // Per-series high-water marks, so an overlapping packet can't double-count.
  private lastTs = new Map<string, number>();

  constructor(options: SessionRecorderOptions = {}) {
    this.persist = options.persist;
    this.now = options.now ?? Date.now;
  }

  get recording(): boolean {
    return this.data !== null;
  }

  /** Session-relative ms for an SDK timestamp (NaN when not recording). */
  toSessionMs(tUs: number): number {
    return this.data ? Math.round(tUs / 1000 - this.data.startedAtEpochMs) : Number.NaN;
  }

  start(): void {
    this.groupsSeen = new Set();
    this.lastTs = new Map();
    this.data = {
      startedAtEpochMs: this.now(),
      endedAtEpochMs: 0,
      pulse: [],
      breathing: [],
      hrv: [],
      blinking: [],
      talking: [],
      expressions: [],
      validation: [],
      groupsSeen: this.groupsSeen,
      firstSdkTimestampUs: null,
      lastSdkTimestampUs: null,
    };
  }

  addSample(sample: PresageSample): void {
    const d = this.data;
    if (!d) return;
    this.noteTimestamp(sample.tUs);
    for (const g of ALL_GROUPS) if (sample.groups[g]) this.groupsSeen.add(g);
    this.append('pulse', d.pulse, sample.pulse);
    this.append('breathing', d.breathing, sample.breathing);
    this.append('hrv', d.hrv, sample.hrv);
    this.append('blinking', d.blinking, sample.blinking);
    this.append('talking', d.talking, sample.talking);
    this.append(
      'expressions',
      d.expressions,
      sample.expressions.map((e) => ({ tUs: e.tUs, top: e.top })),
    );
  }

  addValidation(event: ValidationEvent): void {
    const d = this.data;
    if (!d) return;
    this.noteTimestamp(event.tUs);
    d.validation.push(event);
  }

  /** Discards the current session without building or saving a summary. */
  abort(): void {
    this.data = null;
  }

  /** Ends the session, builds the summary, and persists it (if a persist fn was given). */
  async stop(): Promise<RecordedSession> {
    const d = this.data;
    if (!d) throw new Error('SessionRecorder.stop() called while not recording');
    this.data = null;
    d.endedAtEpochMs = this.now();
    const summary = summarizeSession(d);
    let savedTo: string | null = null;
    let saveError: string | null = null;
    if (this.persist) {
      try {
        savedTo = await this.persist(summary);
      } catch (err) {
        saveError = err instanceof Error ? err.message : String(err);
      }
    }
    return { summary, savedTo, saveError };
  }

  private noteTimestamp(tUs: number): void {
    const d = this.data;
    if (!d) return;
    if (d.firstSdkTimestampUs === null || tUs < d.firstSdkTimestampUs) d.firstSdkTimestampUs = tUs;
    if (d.lastSdkTimestampUs === null || tUs > d.lastSdkTimestampUs) d.lastSdkTimestampUs = tUs;
  }

  private append<T extends { tUs: number }>(key: string, target: T[], items: readonly T[]): void {
    let last = this.lastTs.get(key) ?? Number.NEGATIVE_INFINITY;
    for (const it of items) {
      if (it.tUs <= last) continue;
      target.push(it);
      last = it.tUs;
    }
    this.lastTs.set(key, last);
  }
}

// ---------------------------------------------------------------------------
// Summary computation (pure)
// ---------------------------------------------------------------------------

const round1 = (x: number): number => Math.round(x * 10) / 10;
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

function stats(values: readonly number[]): { avg: number | null; min: number | null; max: number | null } {
  if (values.length === 0) return { avg: null, min: null, max: null };
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { avg: round1(sum / values.length), min: round1(min), max: round1(max) };
}

function buckets(durationMs: number): Interval[] {
  const out: Interval[] = [];
  for (let start = 0; start < Math.max(durationMs, 1); start += TIMELINE_BUCKET_MS) {
    out.push({ startMs: start, endMs: Math.min(start + TIMELINE_BUCKET_MS, Math.max(durationMs, 1)) });
  }
  return out;
}

interface Segment {
  startMs: number;
  endMs: number;
  on: boolean;
}

/** Turns per-frame detections into held segments (each capped at DETECTION_MAX_HOLD_MS). */
function detectionSegments(readings: readonly { tMs: number; on: boolean }[], endMs: number): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < readings.length; i++) {
    const cur = readings[i];
    if (!cur) continue;
    const next = readings[i + 1];
    const stop = Math.min(next ? next.tMs : endMs, cur.tMs + DETECTION_MAX_HOLD_MS, endMs);
    if (stop > cur.tMs) out.push({ startMs: cur.tMs, endMs: stop, on: cur.on });
  }
  return out;
}

function overlapMs(seg: Interval, from: number, to: number): number {
  return Math.max(0, Math.min(seg.endMs, to) - Math.max(seg.startMs, from));
}

function mergeIntervals(segs: readonly Segment[], gapMs: number): Interval[] {
  const out: Interval[] = [];
  for (const s of segs) {
    if (!s.on) continue;
    const prev = out[out.length - 1];
    if (prev && s.startMs - prev.endMs <= gapMs) prev.endMs = Math.max(prev.endMs, s.endMs);
    else out.push({ startMs: s.startMs, endMs: s.endMs });
  }
  return out;
}

function shareOf(counts: Map<ExpressionName, number>, total: number): Partial<Record<ExpressionName, number>> {
  const out: Partial<Record<ExpressionName, number>> = {};
  if (total === 0) return out;
  for (const [name, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) out[name] = round3(n / total);
  return out;
}

function dominant(counts: Map<ExpressionName, number>): ExpressionName | null {
  let best: ExpressionName | null = null;
  let bestN = 0;
  for (const [name, n] of counts) {
    if (n > bestN) {
      best = name;
      bestN = n;
    }
  }
  return best;
}

export function summarizeSession(d: SessionData): SessionSummary {
  const durationMs = Math.max(0, d.endedAtEpochMs - d.startedAtEpochMs);
  const toMs = (tUs: number): number => Math.round(tUs / 1000 - d.startedAtEpochMs);
  const bucketList = buckets(durationMs);

  // --- Pulse ---------------------------------------------------------------
  const pulseOk = d.pulse.filter((r) => r.confidence >= MIN_VITALS_CONFIDENCE.pulse);
  const pulseSeries = pulseOk.map((r) => ({ tMs: toMs(r.tUs), tUs: r.tUs, bpm: round1(r.value), confidence: round1(r.confidence) }));
  const pulseTimeline: TimeWindowStat[] = bucketList.map((b) => {
    const vals = pulseSeries.filter((p) => p.tMs >= b.startMs && p.tMs < b.endMs).map((p) => p.bpm);
    return { ...b, avg: stats(vals).avg, samples: vals.length };
  });

  // --- Talking (needed by breathing) -----------------------------------------
  const talkSegs = detectionSegments(
    d.talking.map((r) => ({ tMs: toMs(r.tUs), on: r.detected })),
    durationMs,
  );
  const talkingMs = talkSegs.reduce((acc, s) => acc + (s.on ? s.endMs - s.startMs : 0), 0);
  const talkObservedMs = talkSegs.reduce((acc, s) => acc + (s.endMs - s.startMs), 0);

  // --- Breathing -----------------------------------------------------------
  const breathOk = d.breathing.filter((r) => r.confidence >= MIN_VITALS_CONFIDENCE.breathing);
  const haveTalkingData = talkSegs.length > 0;
  const breathSeries = breathOk.map((r) => {
    const tMs = toMs(r.tUs);
    const from = tMs - BREATHING_WINDOW_MS;
    let talk = 0;
    let seen = 0;
    for (const s of talkSegs) {
      const o = overlapMs(s, from, tMs);
      seen += o;
      if (s.on) talk += o;
    }
    const excludedWhileTalking = seen > 0 && talk / seen > BREATHING_MAX_TALKING_FRACTION;
    return { tMs, tUs: r.tUs, breathsPerMin: round1(r.value), confidence: round1(r.confidence), excludedWhileTalking };
  });
  const breathUsed = breathSeries.filter((b) => !b.excludedWhileTalking);

  // --- HRV -----------------------------------------------------------------
  const hrvOk = d.hrv.filter((r) => r.confidence >= MIN_VITALS_CONFIDENCE.hrv);
  const lastStable = [...hrvOk].reverse().find((r) => r.stable) ?? null;

  // --- Blinks --------------------------------------------------------------
  const blinkReadings = d.blinking.map((r) => ({ tMs: toMs(r.tUs), on: r.detected }));
  const blinkSegs = detectionSegments(blinkReadings, durationMs);
  const blinkObservedMs = blinkSegs.reduce((acc, s) => acc + (s.endMs - s.startMs), 0);
  const onsetsMs: number[] = [];
  for (let i = 0; i < blinkReadings.length; i++) {
    const cur = blinkReadings[i];
    const prev = blinkReadings[i - 1];
    if (!cur?.on) continue;
    if (!prev || !prev.on || cur.tMs - prev.tMs > DETECTION_MAX_HOLD_MS) onsetsMs.push(cur.tMs);
  }

  // --- Expressions ---------------------------------------------------------
  const expr = d.expressions
    .filter((e): e is { tUs: number; top: ExpressionName } => e.top !== null)
    .map((e) => ({ tMs: toMs(e.tUs), top: e.top }));
  const totalCounts = new Map<ExpressionName, number>();
  for (const e of expr) totalCounts.set(e.top, (totalCounts.get(e.top) ?? 0) + 1);
  const exprTimeline: ExpressionWindow[] = bucketList.map((b) => {
    const counts = new Map<ExpressionName, number>();
    let n = 0;
    for (const e of expr) {
      if (e.tMs < b.startMs || e.tMs >= b.endMs) continue;
      counts.set(e.top, (counts.get(e.top) ?? 0) + 1);
      n++;
    }
    return { ...b, dominant: dominant(counts), distribution: shareOf(counts, n), samples: n };
  });

  // --- Face validity + validation issues -----------------------------------
  // Validation status holds until the next event (the SDK reports changes, not
  // a fixed-rate stream). Camera-tuning time at start-up is neither valid nor
  // an issue, so it is left out of the ratio.
  const val = [...d.validation].sort((a, b) => a.tUs - b.tUs);
  let validMs = 0;
  let observedMs = 0;
  const issues: ValidationIssueInterval[] = [];
  for (let i = 0; i < val.length; i++) {
    const ev = val[i];
    if (!ev) continue;
    const startMs = Math.max(0, toMs(ev.tUs));
    const next = val[i + 1];
    const endMs = Math.min(durationMs, next ? toMs(next.tUs) : durationMs);
    if (endMs <= startMs) continue;
    if (ev.name === 'CameraTuning') continue;
    observedMs += endMs - startMs;
    if (ev.ok) {
      validMs += endMs - startMs;
      continue;
    }
    const prev = issues[issues.length - 1];
    if (prev && prev.code === ev.code && prev.endMs === startMs) prev.endMs = endMs;
    else issues.push({ code: ev.code, name: ev.name, hint: ev.hint || ev.advice, startMs, endMs });
  }

  const pulseStats = stats(pulseSeries.map((p) => p.bpm));
  const breathStats = stats(breathUsed.map((b) => b.breathsPerMin));

  const pulse: RateSummary = {
    ...pulseStats,
    samplesUsed: pulseSeries.length,
    samplesDroppedLowConfidence: d.pulse.length - pulseOk.length,
    minConfidence: MIN_VITALS_CONFIDENCE.pulse,
  };

  return {
    schemaVersion: 1,
    startedAt: new Date(d.startedAtEpochMs).toISOString(),
    endedAt: new Date(d.endedAtEpochMs).toISOString(),
    startedAtEpochMs: d.startedAtEpochMs,
    durationMs,
    clock: {
      description:
        'tMs = milliseconds since startedAtEpochMs. tUs = SmartSpectra timestamp in microseconds ' +
        '(epoch-anchored and monotonic in Electron), so tMs = tUs / 1000 - startedAtEpochMs. ' +
        'To align a transcript, express its offsets relative to startedAtEpochMs.',
      firstSdkTimestampUs: d.firstSdkTimestampUs,
      lastSdkTimestampUs: d.lastSdkTimestampUs,
    },
    pulse: { ...pulse, unit: 'bpm', timeline: pulseTimeline },
    breathing: {
      ...breathStats,
      unit: 'breaths/min',
      samplesUsed: breathUsed.length,
      samplesDroppedLowConfidence: d.breathing.length - breathOk.length,
      samplesExcludedWhileTalking: breathSeries.length - breathUsed.length,
      minConfidence: MIN_VITALS_CONFIDENCE.breathing,
      note:
        'Breathing rate is a 30 s rolling average and is unreliable while talking (per Presage). ' +
        `Readings whose 30 s window was more than ${Math.round(BREATHING_MAX_TALKING_FRACTION * 100)}% talking are excluded from avg/min/max.` +
        (haveTalkingData ? '' : ' No talking data was available this session, so no readings could be excluded on that basis.'),
    },
    hrv: {
      latestStable: lastStable
        ? {
            tMs: toMs(lastStable.tUs),
            rmssdMs: round1(lastStable.rmssdMs),
            sdnnMs: round1(lastStable.sdnnMs),
            meanNnMs: round1(lastStable.meanNnMs),
            baevsky: round1(lastStable.baevsky),
            confidence: round1(lastStable.confidence),
          }
        : null,
      samplesUsed: hrvOk.length,
      samplesDroppedLowConfidence: d.hrv.length - hrvOk.length,
      minConfidence: MIN_VITALS_CONFIDENCE.hrv,
      note: 'HRV uses a 60 s window; confidence stays 0 until the window fills, so sessions under ~60 s have no HRV.',
    },
    blinks: {
      count: onsetsMs.length,
      perMinute: blinkObservedMs >= MIN_BLINK_OBSERVATION_MS ? round1(onsetsMs.length / (blinkObservedMs / 60_000)) : null,
      onsetsMs,
    },
    talking: {
      ratio: talkObservedMs > 0 ? round3(talkingMs / talkObservedMs) : null,
      talkingMs,
      observedMs: talkObservedMs,
      intervals: mergeIntervals(talkSegs, TALKING_MERGE_GAP_MS),
    },
    expressions: {
      distribution: shareOf(totalCounts, expr.length),
      timeline: exprTimeline,
      samples: expr.length,
    },
    face: {
      validRatio: observedMs > 0 ? round3(validMs / observedMs) : null,
      validMs,
      observedMs,
    },
    validationIssues: issues,
    emptyMetricGroups: ALL_GROUPS.filter((g) => !d.groupsSeen.has(g)),
    series: {
      pulse: pulseSeries,
      breathing: breathSeries,
      hrv: hrvOk.map((r) => ({
        tMs: toMs(r.tUs),
        tUs: r.tUs,
        rmssdMs: round1(r.rmssdMs),
        sdnnMs: round1(r.sdnnMs),
        baevsky: round1(r.baevsky),
        confidence: round1(r.confidence),
      })),
    },
  };
}
