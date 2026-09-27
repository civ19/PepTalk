import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeCoaching,
  validateCoachingInput,
  type CoachingInput,
} from "../src/modules/gemini/coachingService";

const input: CoachingInput = {
  project: {
    id: "summer-interview",
    name: "Summer interview",
    category: "Interview",
    contextNotes: "Interview for a product role",
  },
  session: {
    id: "6f1c2d3e-5a4b-4c3d-8e2f-1a2b3c4d5e6f",
    title: "Second attempt",
    category: "Interview",
    durationSeconds: 60,
    transcript: "Um, I improved the pricing explanation.",
    wordsPerMinute: 140,
    fillerCount: 1,
    fillerWords: [{ phrase: "Um", count: 1, kind: "filler" }],
    timedWords: [{ text: "Um", start: 2, end: 2.3 }],
    vitals: {
      heartRate: [
        ...Array.from({ length: 5 }, (_, timeSeconds) => ({
          timeSeconds,
          value: 70,
          confidence: 90,
          stable: true,
        })),
        ...[20, 21, 22].map((timeSeconds) => ({
          timeSeconds,
          value: 90,
          confidence: 90,
          stable: true,
        })),
      ],
      cameraFacing: [20, 21, 22, 23].map((timeSeconds) => ({
        timeSeconds,
        facing: false,
      })),
    },
  },
  previousAttempts: [
    {
      title: "First attempt",
      createdAt: "2026-09-26T00:00:00Z",
      wordsPerMinute: 180,
      fillerCount: 5,
      feedback: { priorities: [{ action: "Pause before pricing." }] },
    },
  ],
  historySummary: { totalAttempts: 1, averageConfidenceScore: 72 },
  attachments: [
    {
      name: "questions.txt",
      type: "text/plain",
      data: Buffer.from("Why this role?").toString("base64"),
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Gemini coaching", () => {
  it("sends this attempt, earlier advice, timed clues and reference files", async () => {
    const rawResponse = JSON.stringify({
      summary: "Clearer pricing explanation.",
      strengths: ["Specific example"],
      priorities: [
        {
          issue: "Filler",
          evidence: "Um at 2s",
          action: "Pause once.",
          timestampSeconds: 2,
        },
      ],
      progressComparedToPrevious: "Pace improved from 180 to 140 WPM.",
      estimatedPracticesRemaining: {
        count: 2,
        reason: "Repeat at a steadier pace.",
      },
      suggestedInterviewQuestions: ["How would you test pricing?"],
    });
    const provider = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: rawResponse }] } }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", provider);

    const result = await analyzeCoaching(input, "test-key");
    expect(result.rawResponse).toBe(rawResponse);
    expect(result.report.priorities[0].timestampSeconds).toBe(2);
    const request = JSON.parse(provider.mock.calls[0][1].body);
    expect(request.generationConfig.responseFormat.text.mimeType).toBe(
      "APPLICATION_JSON",
    );
    const prompt = request.contents[0].parts[0].text;
    expect(prompt).toContain("Pause before pricing.");
    expect(prompt).toContain('"averageConfidenceScore":72');
    expect(prompt).toContain("Possible filler phrase cluster");
    expect(prompt).toContain("near 2.0s");
    expect(prompt).toContain("Pulse rose to at least 90 BPM from 20s");
    expect(prompt).toContain("Camera-facing estimate was false");
    expect(prompt).toContain("Interview mode");
    expect(request.contents[0].parts[1].text).toContain("Why this role?");
  });

  it("does not accept invented timestamps outside the recording", async () => {
    const rawResponse = JSON.stringify({
      summary: "Practice again.",
      strengths: [],
      priorities: [
        {
          issue: "Pace",
          evidence: "Fast",
          action: "Pause",
          timestampSeconds: 999,
        },
      ],
      progressComparedToPrevious: "No comparison.",
      estimatedPracticesRemaining: { count: 3, reason: "Estimate." },
      suggestedInterviewQuestions: [],
    });
    const provider = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: rawResponse }] } }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", provider);
    const result = await analyzeCoaching(
      {
        ...input,
        session: { ...input.session, category: "Presentation" },
        attachments: [
          { name: "slides.pdf", type: "application/pdf", data: "YQ==" },
        ],
      },
      "key",
    );
    expect(result.report.priorities[0].timestampSeconds).toBeNull();
    const request = JSON.parse(provider.mock.calls[0][1].body);
    expect(request.contents[0].parts[0].text).toContain(
      "natural head movement",
    );
    expect(request.contents[0].parts[2].inlineData).toEqual({
      mimeType: "application/pdf",
      data: "YQ==",
    });
  });

  it("rejects oversized and unsupported project references", () => {
    expect(validateCoachingInput(input)).not.toBeNull();
    expect(
      validateCoachingInput({
        ...input,
        attachments: [
          {
            name: "slides.pptx",
            type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            data: "YQ==",
          },
        ],
      }),
    ).toBeNull();
    expect(
      validateCoachingInput({
        ...input,
        session: { ...input.session, durationSeconds: -1 },
      }),
    ).toBeNull();
  });

  it("reports Gemini's actual validation error without revealing the key", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { message: "Invalid response_format; key=test-key" },
          }),
          { status: 400 },
        ),
      ),
    );
    await expect(analyzeCoaching(input, "test-key")).rejects.toThrow(
      "Gemini rejected this coaching request (400): Invalid response_format; key=[redacted]",
    );
  });

  it("removes model timestamps when no timed measurement exists", async () => {
    const rawResponse = JSON.stringify({
      summary: "Try a pause.",
      strengths: [],
      priorities: [
        {
          issue: "Pace",
          evidence: "Pace",
          action: "Pause",
          timestampSeconds: 5,
        },
      ],
      progressComparedToPrevious: "Baseline.",
      estimatedPracticesRemaining: { count: 2, reason: "Estimate." },
      suggestedInterviewQuestions: [],
    });
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
    const result = await analyzeCoaching(
      {
        ...input,
        session: { ...input.session, timedWords: [], vitals: undefined },
      },
      "key",
    );
    expect(result.report.priorities[0].timestampSeconds).toBeNull();
  });

  it("points Gemini to the densest filler stretch and fastest speech window", async () => {
    const rawResponse = JSON.stringify({
      summary: "Slow down.",
      strengths: [],
      priorities: [
        {
          issue: "Rush",
          evidence: "A fast stretch",
          action: "Pause",
          timestampSeconds: 30,
        },
      ],
      progressComparedToPrevious: "Baseline.",
      estimatedPracticesRemaining: { count: 2, reason: "Estimate." },
      suggestedInterviewQuestions: [],
    });
    const provider = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: rawResponse }] } }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", provider);
    const timedWords = [
      { text: "um", start: 2, end: 2.2 },
      ...[25, 27, 29].map((start) => ({ text: "um", start, end: start + 0.2 })),
      ...Array.from({ length: 50 }, (_, index) => ({
        text: "answer",
        start: 40 + index * 0.2,
        end: 40.1 + index * 0.2,
      })),
    ];
    await analyzeCoaching(
      {
        ...input,
        session: {
          ...input.session,
          durationSeconds: 60,
          wordsPerMinute: 120,
          timedWords,
          fillerWords: [{ phrase: "um", count: 4, kind: "filler" }],
        },
      },
      "key",
    );
    const prompt = JSON.parse(provider.mock.calls[0][1].body).contents[0]
      .parts[0].text;
    expect(prompt).toContain("3 occurrences in 15 seconds near 25.0s");
    expect(prompt).toContain("Fast speech near");
  });
});
