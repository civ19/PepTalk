import { describe, expect, it } from "vitest";
import { progressForAttempt } from "../src/utils/progress";
import type { PracticeSession } from "../src/types/interview";

function attempt(
  id: string,
  day: number,
  fillerCount: number,
  wordCount = 100,
): PracticeSession {
  return {
    id,
    projectId: "interview",
    title: "Interview",
    category: "Interview",
    createdAt: `2026-09-${String(day).padStart(2, "0")}T10:00:00Z`,
    durationSeconds: 60,
    transcript: "",
    wordCount,
    wordsPerMinute: 140,
    fillerCount,
    hasRecording: false,
  };
}

describe("progressForAttempt", () => {
  it("lists every earlier scored attempt and compares with the latest scored one", () => {
    const first = attempt("first", 1, 0);
    const unscored = attempt("unscored", 2, 0, 0);
    const third = attempt("third", 3, 10);
    const current = attempt("current", 4, 0);
    const future = attempt("future", 5, 20);
    const progress = progressForAttempt(current, [
      future,
      current,
      unscored,
      first,
      third,
    ]);
    expect(progress.previousScores).toEqual([
      { id: "first", attempt: 1, score: 100 },
      { id: "third", attempt: 3, score: 71 },
    ]);
    expect(progress.previousAttempts.map((item) => item.score)).toEqual([
      100,
      null,
      71,
    ]);
    expect(progress.delta).toBe(29);
    expect(progress.comparisonAttempt).toBe(3);
    expect(progress.currentIndex).toBe(3);
  });
});
