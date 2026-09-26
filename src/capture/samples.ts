// Turns the tracker's per-packet PresageSample / ValidationEvent stream into
// the stored SampleRecord rows (pure; no DOM, SDK or Electron).
//
// Why a holdback: one camera frame's face readings are often spread over
// consecutive packets (in a 60 s dump, 62% of frames were split across up to
// 4 packets; blinking/talking trail expression/landmarks by a frame). Face
// rows are therefore assembled per frame timestamp and only emitted once the
// stream has moved FACE_HOLDBACK_US past them.

import { estimateGaze } from '../presage/gaze';
import type { PresageSample, ValidationEvent as TrackerValidationEvent } from '../presage/types';
import {
  EXPRESSION_NAMES,
  FACE_MESH,
  type EyeLandmarks,
  type EyePoints,
  type ExpressionProbabilities,
  type FaceSample,
  type HeadPose,
  type Point2D,
  type SampleRecord,
  type VitalsSample,
} from '../shared/session-types';

export const FACE_HOLDBACK_US = 500_000;

/** Frontal value of noseDrop / eyeToChin in testing; HeadPose.pitch is relative to it. */
const PITCH_NEUTRAL = 0.31;

type FaceAcc = Omit<FaceSample, 'tMs'>;
type VitalsAcc = Omit<VitalsSample, 'tMs'>;

const emptyFace = (): FaceAcc => ({ blinking: null, talking: null, expressions: null, eyeLandmarks: null, headPose: null, gaze: null });
const emptyVitals = (): VitalsAcc => ({
  pulseBpm: null,
  pulseConfidence: null,
  pulseStable: null,
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

const r = (x: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};

export class SampleAssembler {
  private face = new Map<number, FaceAcc>();
  private vitals = new Map<number, VitalsAcc>();
  private validation: { tUs: number; code: number; name: string; hint: string }[] = [];
  private lastValidationKey: string | null = null;
  private newestFaceUs = Number.NEGATIVE_INFINITY;
  private firstUs: number | null = null;

  /** Earliest SDK timestamp seen (µs), for the clock check. */
  get firstTimestampUs(): number | null {
    return this.firstUs;
  }

  addSample(s: PresageSample): void {
    for (const p of s.pulse) this.setVitals(p.tUs, { pulseBpm: r(p.value, 2), pulseConfidence: r(p.confidence, 2), pulseStable: p.stable });
    for (const b of s.breathing) this.setVitals(b.tUs, { breathingRate: r(b.value, 2), breathingConfidence: r(b.confidence, 2), breathingStable: b.stable });
    for (const h of s.hrv) {
      this.setVitals(h.tUs, {
        hrvRmssdMs: r(h.rmssdMs, 2),
        hrvSdnnMs: r(h.sdnnMs, 2),
        hrvMeanNnMs: r(h.meanNnMs, 2),
        hrvBaevsky: r(h.baevsky, 2),
        hrvConfidence: r(h.confidence, 2),
        hrvStable: h.stable,
      });
    }
    for (const b of s.blinking) this.setFace(b.tUs, { blinking: b.detected });
    for (const t of s.talking) this.setFace(t.tUs, { talking: t.detected });
    for (const e of s.expressions) {
      // The SDK reports percentages summing to 100.
      const probs = Object.fromEntries(EXPRESSION_NAMES.map((n) => [n, r((e.scores[n] ?? 0) / 100, 4)])) as ExpressionProbabilities;
      this.setFace(e.tUs, { expressions: probs });
    }
    for (const lm of s.landmarkSets) {
      const g = estimateGaze(lm);
      this.setFace(lm.tUs, {
        eyeLandmarks: eyeLandmarks(lm.points),
        headPose: headPose(lm.points),
        gaze: g ? { h: r(g.h, 4), v: r(g.v, 4), direction: g.direction } : null,
      });
    }
  }

  /** Keeps only changes: the SDK repeats the current status every frame. */
  addValidation(v: TrackerValidationEvent): void {
    this.noteTs(v.tUs);
    const key = `${v.code}|${v.hint}`;
    if (key === this.lastValidationKey) return;
    this.lastValidationKey = key;
    this.validation.push({ tUs: v.tUs, code: v.code, name: v.name, hint: v.hint });
  }

  /**
   * Emits rows that are ready, converting SDK µs to video ms with `toMs`.
   * With `final`, everything still held back is emitted too.
   */
  drain(toMs: (tUs: number) => number, final = false): SampleRecord[] {
    const out: SampleRecord[] = [];
    for (const [tUs, v] of [...this.vitals.entries()].sort((a, b) => a[0] - b[0])) out.push({ kind: 'vitals', tMs: toMs(tUs), ...v });
    this.vitals.clear();
    const cutoff = final ? Number.POSITIVE_INFINITY : this.newestFaceUs - FACE_HOLDBACK_US;
    for (const [tUs, f] of [...this.face.entries()].sort((a, b) => a[0] - b[0])) {
      if (tUs > cutoff) continue;
      out.push({ kind: 'face', tMs: toMs(tUs), ...f });
      this.face.delete(tUs);
    }
    for (const v of this.validation) out.push({ kind: 'validation', tMs: toMs(v.tUs), code: v.code, name: v.name, hint: v.hint });
    this.validation = [];
    return out;
  }

  private noteTs(tUs: number): void {
    if (this.firstUs === null || tUs < this.firstUs) this.firstUs = tUs;
  }

  private setFace(tUs: number, patch: Partial<FaceAcc>): void {
    this.noteTs(tUs);
    if (tUs > this.newestFaceUs) this.newestFaceUs = tUs;
    const acc = this.face.get(tUs) ?? emptyFace();
    this.face.set(tUs, { ...acc, ...patch });
  }

  private setVitals(tUs: number, patch: Partial<VitalsAcc>): void {
    this.noteTs(tUs);
    const acc = this.vitals.get(tUs) ?? emptyVitals();
    this.vitals.set(tUs, { ...acc, ...patch });
  }
}

function eye(points: readonly Point2D[], idx: (typeof FACE_MESH)['rightEye'] | (typeof FACE_MESH)['leftEye']): EyePoints | null {
  const at = (i: number): Point2D | null => {
    const p = points[i];
    return p ? { x: p.x, y: p.y } : null;
  };
  const outerCorner = at(idx.outerCorner);
  const innerCorner = at(idx.innerCorner);
  const upperLid = at(idx.upperLid);
  const lowerLid = at(idx.lowerLid);
  const irisCenter = at(idx.irisCenter);
  const [c0, c1, c2, c3] = idx.irisContour.map(at);
  if (!outerCorner || !innerCorner || !upperLid || !lowerLid || !irisCenter || !c0 || !c1 || !c2 || !c3) return null;
  return { outerCorner, innerCorner, upperLid, lowerLid, irisCenter, irisContour: [c0, c1, c2, c3] };
}

export function eyeLandmarks(points: readonly Point2D[]): EyeLandmarks | null {
  if (points.length < FACE_MESH.pointCount) return null;
  const right = eye(points, FACE_MESH.rightEye);
  const left = eye(points, FACE_MESH.leftEye);
  return right && left ? { right, left } : null;
}

export function headPose(points: readonly Point2D[]): HeadPose | null {
  if (points.length < FACE_MESH.pointCount) return null;
  const nose = points[FACE_MESH.noseTip];
  const chin = points[FACE_MESH.chin];
  const cl = points[FACE_MESH.cheekImageLeft];
  const cr = points[FACE_MESH.cheekImageRight];
  const er = points[FACE_MESH.rightEye.outerCorner];
  const el = points[FACE_MESH.leftEye.outerCorner];
  if (!nose || !chin || !cl || !cr || !er || !el) return null;

  // Yaw: nose tip across the cheek-to-cheek axis (same measure as gaze.ts).
  const face = { x: cr.x - cl.x, y: cr.y - cl.y };
  const f2 = face.x * face.x + face.y * face.y;
  if (f2 < 1e-9) return null;
  const yaw = (((nose.x - cl.x) * face.x + (nose.y - cl.y) * face.y) / f2 - 0.5) * 2;

  // Pitch: nose drop below the eye line relative to eye-line-to-chin, along the face's own "down".
  const axis = { x: el.x - er.x, y: el.y - er.y };
  const w = Math.hypot(axis.x, axis.y);
  if (w < 1e-6) return null;
  const down = { x: -axis.y / w, y: axis.x / w };
  const mid = { x: (er.x + el.x) / 2, y: (er.y + el.y) / 2 };
  const drop = (p: Point2D): number => (p.x - mid.x) * down.x + (p.y - mid.y) * down.y;
  const chinDrop = drop(chin);
  if (Math.abs(chinDrop) < 1e-6) return null;
  return { yaw: r(yaw, 4), pitch: r(drop(nose) / chinDrop - PITCH_NEUTRAL, 4) };
}

