import { describe, expect, it } from "vitest";
import type { PracticeSession, VitalPoint } from "../src/types/interview";
import { breathingNote, dominantExpression } from "../src/utils/bodySignals";

const reading = (confidence: number, stable = false): VitalPoint => ({
  timeSeconds: 40,
  value: 14,
  confidence,
  stable,
});

function session(
  durationSeconds: number,
  vitals?: Partial<NonNullable<PracticeSession["vitals"]>>,
): PracticeSession {
  return {
    id: "6f1c2d3e-5a4b-4c3d-8e2f-1a2b3c4d5e6f",
    title: "Pitch",
    category: "Pitch",
    createdAt: "2026-09-27T04:00:00.000Z",
    durationSeconds,
    transcript: "",
    wordCount: 0,
    wordsPerMinute: 0,
    fillerCount: 0,
    hasRecording: true,
    vitals: vitals && {
      heartRate: [],
      breathingRate: [],
      cameraFacingPercent: null,
      cameraFacingSamples: 0,
      possibleBreathInterruptions: 0,
      hints: [],
      ...vitals,
    },
  };
}

describe("dominantExpression", () => {
  it("names the dominant expression, its share, and the next two", () => {
    expect(
      dominantExpression(
        session(60, {
          dominantExpression: "neutral",
          expressionShares: [
            { name: "neutral", percent: 79 },
            { name: "surprise", percent: 14 },
            { name: "happy", percent: 5 },
            { name: "sad", percent: 2 },
          ],
        }).vitals,
      ),
    ).toEqual({
      label: "Neutral",
      percent: 79,
      others: ["Surprise 14%", "Happy 5%"],
    });
  });

  it("is empty for sessions analyzed before expressions were measured", () => {
    expect(dominantExpression(session(60, {}).vitals)).toBeNull();
    expect(dominantExpression(undefined)).toBeNull();
  });
});

describe("breathingNote", () => {
  it("says nothing before analysis or when there is a reliable reading", () => {
    expect(breathingNote(session(60))).toBeNull();
    expect(
      breathingNote(session(60, { breathingRate: [reading(72, true)] })),
    ).toBeNull();
  });

  it("explains a run too short for Presage's breathing warm-up", () => {
    expect(breathingNote(session(19, { breathingRate: [reading(0)] }))).toMatch(
      /at least 30 seconds; this one was 19/,
    );
  });

  it("gives the best confidence when readings stayed below the bar", () => {
    expect(
      breathingNote(
        session(75, { breathingRate: [reading(28), reading(47), reading(12)] }),
      ),
    ).toMatch(/peaked at 47% confidence; 60% is needed/);
  });

  it("says when there was no breathing signal at all", () => {
    expect(breathingNote(session(45, { breathingRate: [] }))).toMatch(
      /no breathing signal/,
    );
  });
});
