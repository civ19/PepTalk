import type { PracticeSession } from "../types/interview";
import { RELIABLE_CONFIDENCE, reliable } from "./confidence";

/** Presage needs about this long before it reports breathing. */
export const BREATHING_WARMUP_SECONDS = 30;

const label = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/**
 * The expression Presage scored highest for the most seconds, its share of
 * the run, and the next two. Null when the session has no expression data.
 */
export function dominantExpression(
  vitals: PracticeSession["vitals"],
): { label: string; percent: number; others: string[] } | null {
  const [top, ...rest] = vitals?.expressionShares ?? [];
  if (!top) return null;
  return {
    label: label(top.name),
    percent: top.percent,
    others: rest
      .filter((share) => share.percent > 0)
      .slice(0, 2)
      .map((share) => `${label(share.name)} ${share.percent}%`),
  };
}

/**
 * Why no breathing rate is shown: null when there is a reliable reading or
 * the run hasn't been analyzed.
 */
export function breathingNote(session: PracticeSession): string | null {
  const readings = session.vitals?.breathingRate;
  if (!readings || reliable(readings).length) return null;
  if (session.durationSeconds < BREATHING_WARMUP_SECONDS) {
    return `Breathing needs a run of at least ${BREATHING_WARMUP_SECONDS} seconds; this one was ${session.durationSeconds}.`;
  }
  if (!readings.length) {
    return "Presage found no breathing signal. Keep your upper chest in view and hold still.";
  }
  const best = Math.max(...readings.map((point) => point.confidence));
  return `Presage's breathing readings peaked at ${Math.round(best)}% confidence; ${RELIABLE_CONFIDENCE}% is needed. Keep your upper chest in view; talking and movement lower it.`;
}
