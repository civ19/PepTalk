import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import createApp from "../src/app";

const app = createApp();

afterEach(() => {
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.GEMINI_API_KEY;
  vi.unstubAllGlobals();
});

describe("POST /api/transcriptions", () => {
  it("sends recorded media to ElevenLabs and returns its transcript", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    process.env.GEMINI_API_KEY = "gemini-test-key";
    const provider = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            text: "My presentation starts now, uh.",
            language_code: "en",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        fillerWords: [
                          { phrase: "uh", count: 1, kind: "filler" },
                          { phrase: "missing", count: 1, kind: "filler" },
                        ],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", provider);

    const response = await request(app)
      .post("/api/transcriptions")
      .set("Content-Type", "video/webm")
      .send(Buffer.from("My presentation starts now, uh."));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      text: "My presentation starts now, uh.",
      languageCode: "en",
      fillerWords: [{ phrase: "uh", count: 1, kind: "filler" }],
    });
    const [url, options] = provider.mock.calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(options.headers).toEqual({ "xi-api-key": "test-key" });
    expect(options.body.get("model_id")).toBe("scribe_v2");
    expect(options.body.get("file")).toBeInstanceOf(Blob);
    expect(provider).toHaveBeenCalledTimes(2);
    const [geminiUrl, geminiOptions] = provider.mock.calls[1];
    expect(geminiUrl).toContain("generativelanguage.googleapis.com");
    expect(geminiOptions.headers["x-goog-api-key"]).toBe("gemini-test-key");
    expect(JSON.parse(geminiOptions.body).contents[0].parts[0].text).toContain(
      "My presentation starts now, uh.",
    );
  });

  it("keeps the transcript when Gemini is unavailable", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    process.env.GEMINI_API_KEY = "gemini-test-key";
    const provider = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: "So basically uh, hello." }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", provider);
    const response = await request(app)
      .post("/api/transcriptions")
      .set("Content-Type", "video/webm")
      .send(Buffer.from("recorded media"));
    expect(response.status).toBe(200);
    expect(response.body.text).toBe("So basically uh, hello.");
    expect(response.body.fillerWords).toBeNull();
    expect(response.body.analysisError).toMatch(/Gemini/);
  });

  it("does not call ElevenLabs without a configured key", async () => {
    const provider = vi.fn();
    vi.stubGlobal("fetch", provider);
    const response = await request(app)
      .post("/api/transcriptions")
      .set("Content-Type", "video/webm")
      .send(Buffer.from("recorded media"));
    expect(response.status).toBe(503);
    expect(provider).not.toHaveBeenCalled();
  });

  it("rejects unsupported media types", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    const response = await request(app)
      .post("/api/transcriptions")
      .set("Content-Type", "text/plain")
      .send("not a recording");
    expect(response.status).toBe(415);
  });
});
