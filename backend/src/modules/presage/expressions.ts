// Facial expressions from Presage: per-second scores and the run's dominant
// expression. Presage scores eight expressions as percentages for each frame.

/** In Presage's ExpressionType order (1 = angry ... 8 = surprise). */
export const EXPRESSIONS = [
  "angry",
  "contempt",
  "disgust",
  "fear",
  "happy",
  "neutral",
  "sad",
  "surprise",
] as const;
export type ExpressionName = (typeof EXPRESSIONS)[number];
export type ExpressionScores = Record<ExpressionName, number>;

/** One second's expression scores (0-100), averaged over its stable samples. */
export interface ExpressionPoint {
  timeSeconds: number;
  scores: ExpressionScores;
}

export interface ExpressionShare {
  name: ExpressionName;
  /** Percent of the measured seconds in which this expression scored highest. */
  percent: number;
}

/** Presage's expression type, as decoded (enum name like "NEUTRAL") or as its number. */
export function expressionName(type: unknown): ExpressionName | undefined {
  const name =
    typeof type === "number"
      ? EXPRESSIONS[type - 1]
      : String(type).toLowerCase();
  return EXPRESSIONS.find((known) => known === name);
}

export const emptyScores = (): ExpressionScores =>
  Object.fromEntries(EXPRESSIONS.map((name) => [name, 0])) as ExpressionScores;

/**
 * The expression that scored highest in the most seconds, with every
 * expression's share of those seconds (largest first). Null without face data.
 */
export function summarizeExpressions(points: ExpressionPoint[]): {
  dominantExpression: ExpressionName | null;
  expressionShares: ExpressionShare[];
} {
  const counts = new Map<ExpressionName, number>();
  for (const { scores } of points) {
    const strongest = EXPRESSIONS.reduce((best, name) =>
      scores[name] > scores[best] ? name : best,
    );
    counts.set(strongest, (counts.get(strongest) ?? 0) + 1);
  }
  const expressionShares = [...counts]
    .map(([name, count]) => ({
      name,
      percent: Math.round((100 * count) / points.length),
    }))
    .sort((a, b) => b.percent - a.percent);
  return {
    dominantExpression: expressionShares[0]?.name ?? null,
    expressionShares,
  };
}
