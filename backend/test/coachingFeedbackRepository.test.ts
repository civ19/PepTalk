import { describe, expect, it } from "vitest";
import { CoachingFeedbackRepository } from "../src/modules/persistence/coachingFeedbackRepository";
import { migratedDb } from "./helpers";

describe("CoachingFeedbackRepository", () => {
  it("retains every raw Gemini response when the same attempt is analyzed again", async () => {
    const db = await migratedDb();
    const repository = new CoachingFeedbackRepository(db);
    const sessionId = "6f1c2d3e-5a4b-4c3d-8e2f-1a2b3c4d5e6f";
    const report = {
      summary: "Practice the pricing answer.",
      strengths: [],
      priorities: [],
      progressComparedToPrevious: "Baseline.",
      estimatedPracticesRemaining: {
        count: 2,
        reason: "One more consistent run.",
      },
      suggestedInterviewQuestions: [],
    };
    await repository.save(
      "a1111111-1111-4111-8111-111111111111",
      sessionId,
      "project",
      report,
      "response one",
    );
    await repository.save(
      "b2222222-2222-4222-8222-222222222222",
      sessionId,
      "project",
      report,
      "response two",
    );
    const { rows } = await db.query(
      "SELECT raw_response, report FROM coaching_feedback WHERE session_id = $1 ORDER BY raw_response",
      [sessionId],
    );
    expect(rows.map((row) => row.raw_response)).toEqual([
      "response one",
      "response two",
    ]);
    expect(rows[0].report.summary).toBe("Practice the pricing answer.");
  });
});
