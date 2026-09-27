import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const analyzeVideo = vi.hoisted(() => vi.fn());
vi.mock("../src/modules/presage/vitalsService", () => ({ analyzeVideo }));
import createApp from "../src/app";

const app = createApp();
const result = {
  heartRate: [{ timeSeconds: 12, value: 76, confidence: 92, stable: true }],
  breathingRate: [],
  cameraFacingPercent: 70,
  cameraFacingSamples: 10,
  possibleBreathInterruptions: 0,
  hints: [],
};
const SESSION = "6f1c2d3e-5a4b-4c3d-8e2f-1a2b3c4d5e6f";

afterEach(() => {
  delete process.env.SMARTSPECTRA_API_KEY;
  delete process.env.VERCEL;
  analyzeVideo.mockReset();
  vi.restoreAllMocks();
});

describe("POST /api/vitals", () => {
  it("says Presage runs only locally when deployed on Vercel", async () => {
    process.env.SMARTSPECTRA_API_KEY = "test-key";
    process.env.VERCEL = "1";
    const response = await request(app)
      .post("/api/vitals")
      .set("Content-Type", "video/webm")
      .send(Buffer.from("video"));
    expect(response.status).toBe(501);
    expect(response.body.error).toMatch(/local backend/);
    expect(analyzeVideo).not.toHaveBeenCalled();
  });

  it("analyzes a recorded video and returns body signals", async () => {
    process.env.SMARTSPECTRA_API_KEY = "test-key";
    analyzeVideo.mockResolvedValue(result);
    const response = await request(app)
      .post("/api/vitals")
      .set("Content-Type", "video/webm")
      .send(Buffer.from("video"));
    expect(response.status).toBe(200);
    expect(response.body).toEqual(result);
    expect(analyzeVideo).toHaveBeenCalledWith(
      Buffer.from("video"),
      "video/webm",
      "test-key",
    );
  });

  it("requires a server key and a valid recording", async () => {
    const missingKey = await request(app)
      .post("/api/vitals")
      .set("Content-Type", "video/mp4")
      .send(Buffer.from("video"));
    expect(missingKey.status).toBe(503);
    process.env.SMARTSPECTRA_API_KEY = "test-key";
    const wrongType = await request(app)
      .post("/api/vitals")
      .set("Content-Type", "text/plain")
      .send("video");
    expect(wrongType.status).toBe(415);
    const empty = await request(app)
      .post("/api/vitals")
      .set("Content-Type", "video/mp4")
      .send(Buffer.alloc(0));
    expect(empty.status).toBe(400);
    expect(analyzeVideo).not.toHaveBeenCalled();
  });
});

describe("saving vitals to Tiger Data", () => {
  it("saves the samples under the session the request names", async () => {
    process.env.SMARTSPECTRA_API_KEY = "test-key";
    analyzeVideo.mockResolvedValue(result);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const replaceSession = vi.fn().mockResolvedValue(1);
    const response = await request(
      createApp({ vitalSamples: { replaceSession } }),
    )
      .post("/api/vitals")
      .set("Content-Type", "video/webm")
      .set("X-Session-Id", SESSION)
      .set("X-Session-Started-At", "2026-09-26T20:00:00.000Z")
      .send(Buffer.from("video"));
    expect(response.status).toBe(200);
    expect(response.body).toEqual(result);
    expect(replaceSession).toHaveBeenCalledWith(
      SESSION,
      new Date("2026-09-26T20:00:00.000Z"),
      result,
    );
  });

  it("still returns the analysis when the session is missing or saving fails", async () => {
    process.env.SMARTSPECTRA_API_KEY = "test-key";
    analyzeVideo.mockResolvedValue(result);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const replaceSession = vi
      .fn()
      .mockRejectedValue(new Error("connection refused"));
    const withDatabase = createApp({ vitalSamples: { replaceSession } });

    const unnamed = await request(withDatabase)
      .post("/api/vitals")
      .set("Content-Type", "video/webm")
      .set("X-Session-Id", "not-a-uuid")
      .send(Buffer.from("video"));
    expect(unnamed.status).toBe(200);
    expect(unnamed.body).toEqual(result);
    expect(replaceSession).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("vitals not saved"),
    );

    const failed = await request(withDatabase)
      .post("/api/vitals")
      .set("Content-Type", "video/webm")
      .set("X-Session-Id", SESSION)
      .set("X-Session-Started-At", "2026-09-26T20:00:00.000Z")
      .send(Buffer.from("video"));
    expect(failed.status).toBe(200);
    expect(failed.body).toEqual(result);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("connection refused"),
    );
  });

  it("doesn't save an analysis that failed", async () => {
    process.env.SMARTSPECTRA_API_KEY = "test-key";
    analyzeVideo.mockRejectedValue(new Error("no face"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const replaceSession = vi.fn();
    const response = await request(
      createApp({ vitalSamples: { replaceSession } }),
    )
      .post("/api/vitals")
      .set("Content-Type", "video/webm")
      .set("X-Session-Id", SESSION)
      .set("X-Session-Started-At", "2026-09-26T20:00:00.000Z")
      .send(Buffer.from("video"));
    expect(response.status).toBe(502);
    expect(replaceSession).not.toHaveBeenCalled();
  });
});
