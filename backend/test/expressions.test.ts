import { describe, expect, it } from "vitest";
import {
  emptyScores,
  expressionName,
  summarizeExpressions,
} from "../src/modules/presage/expressions";

const second = (timeSeconds: number, scores: Record<string, number>) => ({
  timeSeconds,
  scores: { ...emptyScores(), ...scores },
});

describe("expressionName", () => {
  it("reads Presage's type as decoded (enum name) or as its number", () => {
    expect(expressionName("NEUTRAL")).toBe("neutral");
    expect(expressionName(5)).toBe("happy");
    expect(expressionName("UNSPECIFIED")).toBeUndefined();
    expect(expressionName(0)).toBeUndefined();
  });
});

describe("summarizeExpressions", () => {
  it("picks the expression that scored highest for the most seconds", () => {
    expect(
      summarizeExpressions([
        second(3, { neutral: 70, happy: 30 }),
        second(4, { neutral: 30, happy: 70 }),
        second(5, { neutral: 90, surprise: 10 }),
      ]),
    ).toEqual({
      dominantExpression: "neutral",
      expressionShares: [
        { name: "neutral", percent: 67 },
        { name: "happy", percent: 33 },
      ],
    });
  });

  it("has no dominant expression without face data", () => {
    expect(summarizeExpressions([])).toEqual({
      dominantExpression: null,
      expressionShares: [],
    });
  });
});
