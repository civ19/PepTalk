import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendRecording,
  getRecording,
  recordingUrl,
} from "../src/services/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recording API", () => {
  it("sends each chunk with the recorder's MIME type", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const chunk = new Blob(["chunk"]);
    await appendRecording("session-1", chunk, "video/webm;codecs=vp9,opus");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/session-1/recording",
      {
        method: "PUT",
        headers: { "Content-Type": "video/webm;codecs=vp9,opus" },
        body: chunk,
      },
    );
  });

  it("fails when the backend can't store a chunk", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );
    await expect(
      appendRecording("session-1", new Blob(["x"]), "video/webm"),
    ).rejects.toThrow("503");
  });

  it("treats a missing recording, or one on another device, as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(new Response(null, { status: 409 })),
    );
    await expect(getRecording("session-1")).resolves.toBeUndefined();
    await expect(getRecording("session-1")).resolves.toBeUndefined();
  });

  it("plays back straight from the backend", () => {
    expect(recordingUrl("session-1")).toBe("/api/sessions/session-1/recording");
  });
});
