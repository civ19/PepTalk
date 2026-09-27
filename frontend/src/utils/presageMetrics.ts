// Adapted from Hackathon/presage-playground/metric-points.cjs.
// The browser UI can consume these points once SmartSpectra is connected.
export interface MetricSample {
  timestamp?: number | bigint | string;
  value?: number;
  confidence?: number;
  stable?: boolean;
}

export interface ExpressionSample {
  timestamp?: number | bigint | string;
  stable?: boolean;
  scores?: { type: number; confidence: number }[];
}

export interface MetricPoint {
  timeSeconds: number;
  value: number;
  confidence: number;
  stable: boolean;
}

export interface ExpressionPoint {
  timeSeconds: number;
  stable: boolean;
  scores: { type: number; name: string; confidence: number }[];
  top: { type: number; name: string; confidence: number } | null;
}

const expressionNames = [
  "unspecified",
  "angry",
  "contempt",
  "disgust",
  "fear",
  "happy",
  "neutral",
  "sad",
  "surprise",
];

function secondsSinceStart(
  timestamp: MetricSample["timestamp"],
  startedAtMs: number,
): number {
  const microseconds = Number(timestamp);
  const sampleMs = Number.isFinite(microseconds)
    ? microseconds / 1000
    : Date.now();
  return Math.max(0, Math.floor((sampleMs - startedAtMs) / 1000));
}

export function ratePoint(
  sample: MetricSample | undefined,
  startedAtMs: number,
): MetricPoint | null {
  if (!sample || !Number.isFinite(sample.value)) return null;
  return {
    timeSeconds: secondsSinceStart(sample.timestamp, startedAtMs),
    value: sample.value as number,
    confidence: Number.isFinite(sample.confidence)
      ? (sample.confidence as number)
      : 0,
    stable: sample.stable === true,
  };
}

export function expressionPoint(
  sample: ExpressionSample | undefined,
  startedAtMs: number,
): ExpressionPoint | null {
  if (!sample) return null;
  const scores = (sample.scores ?? [])
    .filter(
      (score) =>
        Number.isInteger(score.type) && Number.isFinite(score.confidence),
    )
    .map((score) => ({
      type: score.type,
      name: expressionNames[score.type] ?? "unknown",
      confidence: score.confidence,
    }));
  const top = scores.reduce<ExpressionPoint["top"]>(
    (best, score) =>
      !best || score.confidence > best.confidence ? score : best,
    null,
  );
  return {
    timeSeconds: secondsSinceStart(sample.timestamp, startedAtMs),
    stable: sample.stable === true,
    scores,
    top,
  };
}

export function metricPoints(
  metrics: {
    cardio?: { pulseRate?: MetricSample[] };
    breathing?: { rate?: MetricSample[] };
    face?: { expression?: ExpressionSample[] };
  },
  startedAtMs: number,
) {
  return {
    heartRateData: ratePoint(metrics.cardio?.pulseRate?.at(-1), startedAtMs),
    breathingData: ratePoint(metrics.breathing?.rate?.at(-1), startedAtMs),
    expressionData: expressionPoint(
      metrics.face?.expression?.at(-1),
      startedAtMs,
    ),
  };
}
