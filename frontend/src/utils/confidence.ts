import type { PracticeSession, VitalPoint } from "../types/interview";

export interface ConfidenceResult {
  score: number | null;
  factors: { name: string; score: number }[];
  stage: "red" | "yellow" | "green" | null;
}

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
/** Readings below this confidence are left out of averages, charts and scores. */
export const RELIABLE_CONFIDENCE = 60;
export const reliable = (points: VitalPoint[] | undefined) =>
  (points ?? []).filter(
    (point) =>
      point.stable &&
      point.confidence >= RELIABLE_CONFIDENCE &&
      Number.isFinite(point.value) &&
      point.value > 0,
  );

function steadiness(points: VitalPoint[]): number | null {
  if (points.length < 5) return null;
  const values = points.map((point) => point.value);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const deviation = Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length,
  );
  return clamp(100 - (deviation / mean) * 300);
}

export function confidenceFor(session: PracticeSession): ConfidenceResult {
  const factors: { name: string; score: number; weight: number }[] = [];
  if (session.wordCount > 0) {
    factors.push({
      name: "Filler words",
      score: clamp(100 - (session.fillerCount / session.wordCount) * 500),
      weight: 35,
    });
    // A broad practice range, not a universal ideal speaking rate.
    const pace = session.wordsPerMinute;
    factors.push({
      name: "Speaking pace",
      score: clamp(100 - Math.max(0, 110 - pace, pace - 170) * 1.25),
      weight: 25,
    });
  }
  if (
    session.vitals?.cameraFacingPercent != null &&
    session.vitals.cameraFacingSamples >= 5
  ) {
    const target =
      session.category === "Interview"
        ? 65
        : session.category === "Pitch"
          ? 45
          : 30;
    const percent = session.vitals.cameraFacingPercent;
    factors.push({
      name: "Camera-facing estimate",
      score: clamp(100 - Math.max(0, target - percent) * 2),
      weight: session.category === "Interview" ? 25 : 12,
    });
  }
  const breathing = steadiness(reliable(session.vitals?.breathingRate));
  if (breathing !== null)
    factors.push({
      name: "Breathing steadiness",
      score: clamp(
        breathing - (session.vitals?.possibleBreathInterruptions ?? 0) * 10,
      ),
      weight: 10,
    });
  const pulse = steadiness(reliable(session.vitals?.heartRate));
  if (pulse !== null)
    factors.push({ name: "Pulse steadiness", score: pulse, weight: 10 });
  if (!factors.length) return { score: null, factors: [], stage: null };
  const score = clamp(
    factors.reduce((sum, factor) => sum + factor.score * factor.weight, 0) /
      factors.reduce((sum, factor) => sum + factor.weight, 0),
  );
  return {
    score,
    factors: factors.map(({ name, score: value }) => ({ name, score: value })),
    stage: score < 50 ? "red" : score < 75 ? "yellow" : "green",
  };
}

export function samePractice(a: PracticeSession, b: PracticeSession): boolean {
  return (
    a.category === b.category &&
    a.title.trim().toLocaleLowerCase().replace(/\s+/g, " ") ===
      b.title.trim().toLocaleLowerCase().replace(/\s+/g, " ")
  );
}
