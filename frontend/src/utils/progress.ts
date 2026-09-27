import type { PracticeSession } from "../types/interview";
import { confidenceFor, samePractice } from "./confidence";

export function progressForAttempt(
  session: PracticeSession,
  sessions: PracticeSession[],
) {
  const attempts = sessions
    .filter((item) => samePractice(item, session))
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  const currentIndex = attempts.findIndex((item) => item.id === session.id);
  const previousAttempts = attempts
    .slice(0, Math.max(0, currentIndex))
    .map((item, index) => ({
      id: item.id,
      attempt: index + 1,
      score: confidenceFor(item).score,
    }));
  const previousScores = previousAttempts.filter(
    (item): item is typeof item & { score: number } => item.score !== null,
  );
  const score = confidenceFor(session);
  const latest = previousScores.at(-1);
  return {
    attempts,
    currentIndex,
    previousScores,
    previousAttempts,
    score,
    delta: score.score === null || !latest ? null : score.score - latest.score,
    comparisonAttempt: latest?.attempt ?? null,
  };
}
