import type { PracticeSession } from "../types/interview";
import { confidenceFor } from "./confidence";

export type TrendMetric = "confidence" | "fillers" | "pace";
export interface TrendPoint {
  attempt: number;
  value: number;
  session: PracticeSession;
}

export function metricFor(
  session: PracticeSession,
  metric: TrendMetric,
): number | null {
  if (metric === "confidence") return confidenceFor(session).score;
  if (
    !session.wordCount ||
    !Number.isFinite(session.durationSeconds) ||
    session.durationSeconds <= 0
  )
    return null;
  if (metric === "pace") return session.wordsPerMinute;
  return (session.fillerCount * 60) / session.durationSeconds;
}

function percentile(sorted: number[], fraction: number): number {
  const position = (sorted.length - 1) * fraction;
  const before = Math.floor(position);
  const after = Math.ceil(position);
  return (
    sorted[before] + (sorted[after] - sorted[before]) * (position - before)
  );
}

/** Hide implausible isolated spikes without changing any saved measurement. */
export function trendFor(
  sessions: PracticeSession[],
  metric: TrendMetric,
): TrendPoint[] {
  const ordered = [...sessions].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const points = ordered.flatMap((session, index) => {
    const value = metricFor(session, metric);
    return value !== null && Number.isFinite(value) && value >= 0
      ? [{ attempt: index + 1, value, session }]
      : [];
  });
  if (points.length < 5) return points;
  const values = points.map((point) => point.value).sort((a, b) => a - b);
  const q1 = percentile(values, 0.25);
  const q3 = percentile(values, 0.75);
  const median = percentile(values, 0.5);
  const spread = q3 - q1;
  const tolerance =
    spread > 0 ? spread * 3 : Math.max(10, Math.abs(median) * 2);
  const low = spread > 0 ? q1 - tolerance : median - tolerance;
  const high = spread > 0 ? q3 + tolerance : median + tolerance;
  return points.filter((point) => point.value >= low && point.value <= high);
}
