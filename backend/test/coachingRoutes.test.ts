import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import createApp from "../src/app";

const body = {
  project: { id: "project-one", name: "Pricing pitch", category: "Other" },
  session: {
    id: "6f1c2d3e-5a4b-4c3d-8e2f-1a2b3c4d5e6f",
    title: "Run one",
    category: "Other",
    durationSeconds: 30,
    transcript: "Our pricing is simple.",
    wordsPerMinute: 120,
    fillerCount: 0,
    timedWords: [{ text: "pricing", start: 5, end: 5.4 }],
  },
  previousAttempts: [],
  attachments: [],
};
const rawResponse = JSON.stringify({
  summary: "Explain the price benefit earlier.",
  strengths: ["Clear value"],
  priorities: [
    {
      issue: "Pricing",
      evidence: "At 5s",
      action: "Pause before the price.",
      timestampSeconds: 5,
    },
  ],
  progressComparedToPrevious: "First run is the baseline.",
  estimatedPracticesRemaining: { count: 2, reason: "Check consistency." },
  suggestedInterviewQuestions: [],
});

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/coaching", () => {
  it("returns complete advice and stores every response when Tiger Data is configured", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: rawResponse }] } }],
          }),
          { status: 200 },
        ),
      ),
    );
    const save = vi.fn().mockResolvedValue(undefined);
    const response = await request(createApp({ coachingFeedback: { save } }))
      .post("/api/coaching")
      .send(body);
    expect(response.status).toBe(200);
    expect(response.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.body.rawResponse).toBe(rawResponse);
    expect(response.body.report.priorities[0].timestampSeconds).toBe(5);
    expect(save).toHaveBeenCalledWith(
      response.body.id,
      body.session.id,
      body.project.id,
      response.body.report,
      rawResponse,
    );
  });

  it("rejects invalid input and requires a key", async () => {
    const app = createApp();
    const invalid = await request(app)
      .post("/api/coaching")
      .send({
        ...body,
        attachments: [
          {
            name: "slides.exe",
            type: "application/octet-stream",
            data: "YQ==",
          },
        ],
      });
    expect(invalid.status).toBe(400);
    const missingKey = await request(app).post("/api/coaching").send(body);
    expect(missingKey.status).toBe(503);
  });

  it("still returns advice when Tiger Data is unavailable", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: rawResponse }] } }],
          }),
          { status: 200 },
        ),
      ),
    );
    const save = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const response = await request(createApp({ coachingFeedback: { save } }))
      .post("/api/coaching")
      .send(body);
    expect(response.status).toBe(200);
    expect(response.body.persistenceError).toMatch(/Tiger Data/);
    expect(response.body.rawResponse).toBe(rawResponse);
  });
});
