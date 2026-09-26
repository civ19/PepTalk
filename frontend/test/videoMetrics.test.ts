import { describe, expect, it } from "vitest";
import { extractMetrics } from "../src/utils/videoMetrics";

describe("extractMetrics", () => {
  it("returns a pulse reading", () => {
    expect(extractMetrics()).toEqual({ pulse: 72 });
  });
});
