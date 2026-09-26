// The single adapter between SmartSpectra's protobuf payload and this module's
// own types. Everything the SDK hands us is treated as `unknown` and narrowed
// field by field here, so the rest of the codebase never sees the raw shape.
//
// Why so defensive:
//  - The root package's decodeMetrics() is typed `unknown` and returns the raw
//    Buffer when no Metrics class is registered. We use the renderer-safe
//    `@smartspectra/node-sdk/messages` decoder, which always decodes, but still
//    guard against a byte array coming back.
//  - int64 timestamps arrive as protobufjs `Long` objects (or numbers).
//  - proto3 omits empty repeated fields and zero scalars.
//
// Fields we deliberately never read: the cardio pressure-waveform trace and the
// breathing pause detector. They are part of the requested SDK bundles but are
// out of scope for a wellness-only practice app.

import { decodeMetrics, presage } from '@smartspectra/node-sdk/messages';
import {
  EXPRESSION_NAMES,
  type DetectionReading,
  type ExpressionName,
  type ExpressionReading,
  type GroupPresence,
  type HrvReading,
  type LandmarksReading,
  type Point2D,
  type RateReading,
} from './types';

export interface DecodedPacket {
  pulse: RateReading[];
  breathing: RateReading[];
  hrv: HrvReading[];
  blinking: DetectionReading[];
  talking: DetectionReading[];
  expressions: ExpressionReading[];
  landmarks: LandmarksReading | null;
  groups: GroupPresence;
}

export type DecodeResult = { ok: true; packet: DecodedPacket } | { ok: false; reason: string };

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null;

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** number | bigint | protobufjs Long | numeric string -> finite number, else null. */
function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (isRec(v) && typeof v['toNumber'] === 'function') {
    const n: unknown = (v['toNumber'] as () => unknown).call(v);
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  }
  return null;
}

const toBool = (v: unknown): boolean => v === true;

const field = (obj: unknown, key: string): unknown => (isRec(obj) ? obj[key] : undefined);

/** True when any repeated field of a metric group object has entries. */
function groupHasData(group: unknown): boolean {
  if (!isRec(group)) return false;
  return Object.values(group).some((v) => Array.isArray(v) && v.length > 0);
}

// ExpressionType int -> our lowercase names, read from the SDK's generated enum
// rather than hard-coded, so a renumbering upstream can't silently mislabel.
const expressionByCode: ReadonlyMap<number, ExpressionName> = (() => {
  const m = new Map<number, ExpressionName>();
  const enumObj: unknown = presage.smartspectra.ExpressionType;
  if (isRec(enumObj)) {
    for (const [name, value] of Object.entries(enumObj)) {
      const lower = name.toLowerCase();
      const known = EXPRESSION_NAMES.find((e) => e === lower);
      if (typeof value === 'number' && known) m.set(value, known);
    }
  }
  return m;
})();

function rateReadings(items: unknown): RateReading[] {
  const out: RateReading[] = [];
  for (const it of list(items)) {
    const tUs = toNumber(field(it, 'timestamp'));
    const value = toNumber(field(it, 'value'));
    if (tUs === null || value === null) continue;
    out.push({
      tUs,
      value,
      confidence: toNumber(field(it, 'confidence')) ?? 0,
      stable: toBool(field(it, 'stable')),
    });
  }
  return out;
}

function hrvReadings(items: unknown): HrvReading[] {
  const out: HrvReading[] = [];
  for (const it of list(items)) {
    const tUs = toNumber(field(it, 'timestamp'));
    if (tUs === null) continue;
    out.push({
      tUs,
      rmssdMs: toNumber(field(it, 'rmssd')) ?? 0,
      sdnnMs: toNumber(field(it, 'sdnn')) ?? 0,
      meanNnMs: toNumber(field(it, 'meanNn')) ?? 0,
      baevsky: toNumber(field(it, 'baevsky')) ?? 0,
      confidence: toNumber(field(it, 'confidence')) ?? 0,
      stable: toBool(field(it, 'stable')),
    });
  }
  return out;
}

function detectionReadings(items: unknown): DetectionReading[] {
  const out: DetectionReading[] = [];
  for (const it of list(items)) {
    const tUs = toNumber(field(it, 'timestamp'));
    if (tUs === null) continue;
    out.push({ tUs, detected: toBool(field(it, 'detected')), stable: toBool(field(it, 'stable')) });
  }
  return out;
}

function expressionReadings(items: unknown): ExpressionReading[] {
  const out: ExpressionReading[] = [];
  for (const it of list(items)) {
    const tUs = toNumber(field(it, 'timestamp'));
    if (tUs === null) continue;
    const scores: Partial<Record<ExpressionName, number>> = {};
    let top: ExpressionName | null = null;
    let topConfidence = 0;
    for (const s of list(field(it, 'scores'))) {
      // The decoder emits enum values as names ("HAPPY"); accept numbers too.
      const rawType = field(s, 'type');
      const name =
        typeof rawType === 'string'
          ? EXPRESSION_NAMES.find((e) => e === rawType.toLowerCase())
          : expressionByCode.get(toNumber(rawType) ?? -1);
      const conf = toNumber(field(s, 'confidence'));
      if (!name || conf === null) continue;
      scores[name] = conf;
      if (conf > topConfidence) {
        top = name;
        topConfidence = conf;
      }
    }
    out.push({ tUs, scores, top, topConfidence, stable: toBool(field(it, 'stable')) });
  }
  return out;
}

function latestLandmarks(items: unknown): LandmarksReading | null {
  const all = list(items);
  const last = all[all.length - 1];
  if (last === undefined) return null;
  const tUs = toNumber(field(last, 'timestamp'));
  if (tUs === null) return null;
  const points: Point2D[] = [];
  for (const p of list(field(last, 'value'))) {
    const x = toNumber(field(p, 'x'));
    const y = toNumber(field(p, 'y'));
    if (x !== null && y !== null) points.push({ x, y });
  }
  return { tUs, points, stable: toBool(field(last, 'stable')), reset: toBool(field(last, 'reset')) };
}

/** Decode one `metrics` event buffer into our typed packet. Never throws. */
export function decodePacket(buf: Uint8Array): DecodeResult {
  let raw: unknown;
  try {
    raw = decodeMetrics(buf);
  } catch (err) {
    return { ok: false, reason: `protobuf decode failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (raw instanceof Uint8Array || !isRec(raw)) {
    return { ok: false, reason: 'decoder returned raw bytes instead of a Metrics object' };
  }

  const face = raw['face'];
  const cardio = raw['cardio'];
  const breathing = raw['breathing'];

  return {
    ok: true,
    packet: {
      pulse: rateReadings(field(cardio, 'pulseRate')),
      breathing: rateReadings(field(breathing, 'rate')),
      hrv: hrvReadings(field(cardio, 'hrv')),
      blinking: detectionReadings(field(face, 'blinking')),
      talking: detectionReadings(field(face, 'talking')),
      expressions: expressionReadings(field(face, 'expression')),
      landmarks: latestLandmarks(field(face, 'landmarks')),
      groups: {
        face: groupHasData(face),
        cardio: groupHasData(cardio),
        breathing: groupHasData(breathing),
      },
    },
  };
}
