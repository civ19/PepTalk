import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeVitals } from "../src/services/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("analyzeVitals", () => {
  it("names the session and its start so the backend can save the samples", async () => {
    const result = {
      heartRate: [],
      breathingRate: [],
      cameraFacingPercent: null,
      cameraFacingSamples: 0,
      possibleBreathInterruptions: 0,
      hints: [],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(result)));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      analyzeVitals(new Blob(["video"], { type: "video/webm;codecs=vp9" }), {
        id: "6f1c2d3e-5a4b-4c3d-8e2f-1a2b3c4d5e6f",
        // createdAt is stamped when the 90 second run stopped.
        createdAt: "2026-09-26T20:01:30.000Z",
        durationSeconds: 90,
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/vitals",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "video/webm",
          "X-Session-Id": "6f1c2d3e-5a4b-4c3d-8e2f-1a2b3c4d5e6f",
          "X-Session-Started-At": "2026-09-26T20:00:00.000Z",
        },
      }),
    );
  });

  it("explains a host's upload limit instead of a bare 413", async () => {
    // Vercel answers oversized uploads itself, in plain text.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("Request Entity Too Large FUNCTION_PAYLOAD_TOO_LARGE", {
          status: 413,
        }),
      ),
    );

    await expect(
      analyzeVitals(new Blob(["video"], { type: "video/webm" }), {
        id: "6f1c2d3e-5a4b-4c3d-8e2f-1a2b3c4d5e6f",
        createdAt: "2026-09-26T20:01:30.000Z",
        durationSeconds: 90,
      }),
    ).rejects.toThrow(/too large for the hosted server/);
  });
});
