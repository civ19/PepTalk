import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeRecording } from "../src/modules/elevenlabs/transcriptionService";

afterEach(() => vi.unstubAllGlobals());

describe("ElevenLabs transcript timing", () => {
  it("keeps spoken word times and excludes spacing or audio events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            text: "Um, hello.",
            words: [
              { text: "Um", start: 1.2, end: 1.5, type: "word" },
              { text: ",", start: 1.5, end: 1.5, type: "spacing" },
              { text: "hello", start: 2, end: 2.5, type: "word" },
              { text: "applause", start: 3, end: 4, type: "audio_event" },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const result = await transcribeRecording(
      Buffer.from("video"),
      "video/webm",
      "key",
    );
    expect(result.timedWords).toEqual([
      { text: "Um", start: 1.2, end: 1.5 },
      { text: "hello", start: 2, end: 2.5 },
    ]);
  });
});
