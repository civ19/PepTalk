import { describe, expect, it } from "vitest";
import { extractMetrics, formatDuration } from "../src/utils/videoMetrics";
import { metricPoints } from "../src/utils/presageMetrics";

describe("practice metrics", () => {
  it("calculates pace and filler words from a transcript", () => {
    expect(
      extractMetrics("Um, I actually like this. You know, uh, it works.", 30),
    ).toEqual({
      wordCount: 10,
      wordsPerMinute: 20,
      fillerCount: 5,
      fillerBreakdown: [
        { word: "um", count: 1 },
        { word: "uh", count: 1 },
        { word: "like", count: 1 },
        { word: "you know", count: 1 },
        { word: "actually", count: 1 },
      ],
    });
  });

  it("handles an empty transcript and formats time", () => {
    expect(extractMetrics("  ", 60).wordsPerMinute).toBe(0);
    expect(formatDuration(125)).toBe("02:05");
  });
});

describe("Presage metric adapter", () => {
  it("keeps confidence and stability with the latest SDK samples", () => {
    const result = metricPoints(
      {
        cardio: {
          pulseRate: [
            {
              timestamp: 1_000_000_000,
              value: 72,
              confidence: 92,
              stable: true,
            },
          ],
        },
        breathing: {
          rate: [
            {
              timestamp: 1_000_000_000,
              value: 16,
              confidence: 74,
              stable: false,
            },
          ],
        },
        face: {
          expression: [
            {
              timestamp: 1_000_000_000,
              stable: true,
              scores: [
                { type: 5, confidence: 81 },
                { type: 6, confidence: 19 },
              ],
            },
          ],
        },
      },
      999_000,
    );
    expect(result.heartRateData).toEqual({
      timeSeconds: 1,
      value: 72,
      confidence: 92,
      stable: true,
    });
    expect(result.breathingData?.stable).toBe(false);
    expect(result.expressionData?.top?.name).toBe("happy");
  });
});
