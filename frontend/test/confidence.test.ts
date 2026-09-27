import { describe, expect, it } from "vitest";
import type { PracticeSession } from "../src/types/interview";
import { confidenceFor, samePractice } from "../src/utils/confidence";

const base: PracticeSession = {
  id: "one",
  title: "My demo",
  category: "Presentation",
  createdAt: "2026-01-01",
  durationSeconds: 60,
  transcript: "test",
  wordCount: 130,
  wordsPerMinute: 130,
  fillerCount: 2,
  hasRecording: true,
};

describe("practice confidence estimate", () => {
  it("uses available factors and ignores unstable body samples", () => {
    const withVitals: PracticeSession = {
      ...base,
      vitals: {
        heartRate: [
          { timeSeconds: 15, value: 120, confidence: 90, stable: false },
        ],
        breathingRate: [],
        cameraFacingPercent: 70,
        cameraFacingSamples: 10,
        possibleBreathInterruptions: 0,
        hints: [],
      },
    };
    expect(
      confidenceFor(withVitals).factors.map((factor) => factor.name),
    ).toEqual(["Filler words", "Speaking pace", "Camera-facing estimate"]);
    expect(
      confidenceFor({ ...base, wordCount: 0, vitals: undefined }).score,
    ).toBeNull();
  });

  it("uses a stricter camera target for interviews", () => {
    const vitals = {
      heartRate: [],
      breathingRate: [],
      cameraFacingPercent: 40,
      cameraFacingSamples: 12,
      possibleBreathInterruptions: 0,
      hints: [],
    };
    const presentation = confidenceFor({ ...base, vitals });
    const interview = confidenceFor({ ...base, category: "Interview", vitals });
    expect(presentation.factors.at(-1)?.score).toBe(100);
    expect(interview.factors.at(-1)?.score).toBe(50);
    const fixedGaze = { ...vitals, cameraFacingPercent: 100 };
    expect(
      confidenceFor({ ...base, vitals: fixedGaze }).factors.at(-1)?.score,
    ).toBeLessThan(100);
    expect(
      confidenceFor({
        ...base,
        category: "Interview",
        vitals: fixedGaze,
      }).factors.at(-1)?.score,
    ).toBe(100);
  });

  it("groups repeated attempts by normalized name and type", () => {
    expect(samePractice(base, { ...base, title: " MY   DEMO " })).toBe(true);
    expect(samePractice(base, { ...base, category: "Interview" })).toBe(false);
  });

  it("places scores in red, yellow, and green stages", () => {
    expect(
      confidenceFor({ ...base, fillerCount: 90, wordsPerMinute: 30 }).stage,
    ).toBe("red");
    expect(
      confidenceFor({ ...base, fillerCount: 8, wordsPerMinute: 80 }).stage,
    ).toBe("yellow");
    expect(confidenceFor(base).stage).toBe("green");
  });
});
