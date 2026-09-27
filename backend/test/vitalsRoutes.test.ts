import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const analyzeVideo = vi.hoisted(() => vi.fn());
vi.mock("../src/modules/presage/vitalsService", () => ({ analyzeVideo }));
import app from "../src/app";

afterEach(() => {
  delete process.env.SMARTSPECTRA_API_KEY;
  analyzeVideo.mockReset();
});

describe("POST /api/vitals", () => {
  it("analyzes a recorded video and returns body signals", async () => {
    process.env.SMARTSPECTRA_API_KEY = "test-key";
    const result = {
      heartRate: [{ timeSeconds: 12, value: 76, confidence: 92, stable: true }],
      breathingRate: [],
      cameraFacingPercent: 70,
      cameraFacingSamples: 10,
      possibleBreathInterruptions: 0,
      hints: [],
    };
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
