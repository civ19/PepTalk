import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import app from "../src/app";

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
  vi.unstubAllGlobals();
});

describe("POST /api/filler-analysis", () => {
  it("returns context aware fillers and adjacent repetitions", async () => {
    process.env.GEMINI_API_KEY = "gemini-test-key";
    const provider = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      fillerWords: [
                        { phrase: "so", count: 7, kind: "filler" },
                        { phrase: "uh", count: 1, kind: "filler" },
                        { phrase: "the the", count: 1, kind: "repetition" },
                        { phrase: "not spoken", count: 1, kind: "filler" },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", provider);

    const response = await request(app)
      .post("/api/filler-analysis")
      .send({ transcript: "So basically uh, the, the answer is yes." });

    expect(response.status).toBe(200);
    expect(response.body.fillerWords).toEqual([
      { phrase: "so", count: 1, kind: "filler" },
      { phrase: "uh", count: 1, kind: "filler" },
      { phrase: "the the", count: 1, kind: "repetition" },
    ]);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(provider.mock.calls[0][1].body).generationConfig.responseFormat
        .text.mimeType,
    ).toBe("APPLICATION_JSON");
  });

  it("requires a Gemini key", async () => {
    const response = await request(app)
      .post("/api/filler-analysis")
      .send({ transcript: "um" });
    expect(response.status).toBe(503);
  });
});
