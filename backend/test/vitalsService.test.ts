import { beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for the native SmartSpectra SDK: records pushed frames and
// reports each one through the pipeline a moment later, as the real one does.
const fake = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  const state = { frameCount: 3, failOnFrame: 0 };
  class FakeSdk {
    static last: FakeSdk | undefined;
    handlers = new Map<string, Handler>();
    input = "";
    frames: {
      width: number;
      height: number;
      stride: number;
      timestampUs: number;
    }[] = [];
    inFlight = 0;
    maxInFlight = 0;
    stopped = false;
    destroyed = false;
    constructor() {
      FakeSdk.last = this;
    }
    on(event: string, handler: Handler) {
      this.handlers.set(event, handler);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      this.handlers.get(event)?.(...args);
    }
    useCustomInput() {
      this.input = "custom";
      return this;
    }
    useFile() {
      this.input = "file";
      return this;
    }
    start() {}
    sendFrame(
      _buffer: Buffer,
      width: number,
      height: number,
      stride: number,
      _format: number,
      timestampUs: number,
    ) {
      this.frames.push({ width, height, stride, timestampUs });
      this.maxInFlight = Math.max(this.maxInFlight, ++this.inFlight);
      setTimeout(() => {
        this.inFlight--;
        this.emit("frameSentThrough", true, timestampUs);
      }, 1);
      if (this.frames.length === state.failOnFrame) {
        this.emit("error", 8, "Processing failed.", false);
      }
      return true;
    }
    async stopAsync() {
      this.stopped = true;
      // Draining delivers the metrics for the frames pushed so far.
      this.emit("metrics", Buffer.alloc(0), 0);
      this.emit("validationStatus", 0, 0, "");
    }
    async destroy() {
      this.destroyed = true;
    }
  }
  return { FakeSdk, state };
});

vi.mock("@smartspectra/node-sdk", () => ({
  SmartSpectraSDK: fake.FakeSdk,
  FrameTransform: { kNone: 0 },
  PixelFormat: { kRGB: 0 },
  ProcessingStatus: { kIdle: 1, kError: 5 },
  breathingMetrics: [],
  cardioMetrics: [],
  faceMetrics: [],
}));
vi.mock("@smartspectra/node-sdk/messages", () => ({
  decodeMetrics: () => ({
    cardio: {
      pulseRate: [
        { value: 72.34, confidence: 91.6, stable: true, timestamp: 12_000_000 },
      ],
    },
    breathing: {
      rate: [
        { value: 14, confidence: 70, stable: true, timestamp: 30_000_000 },
      ],
    },
    // As the real decoder gives them: enum names and string timestamps.
    face: {
      expression: [
        {
          stable: true,
          timestamp: "3100000",
          scores: [
            { type: "NEUTRAL", confidence: 80 },
            { type: "HAPPY", confidence: 20 },
          ],
        },
        {
          stable: true,
          timestamp: "3600000",
          scores: [
            { type: "NEUTRAL", confidence: 60 },
            { type: "HAPPY", confidence: 40 },
          ],
        },
        {
          stable: false,
          timestamp: "4200000",
          scores: [{ type: "ANGRY", confidence: 99 }],
        },
        {
          stable: true,
          timestamp: "4500000",
          scores: [
            { type: 6, confidence: 30 },
            { type: 5, confidence: 70 },
          ],
        },
        {
          stable: true,
          timestamp: "5500000",
          scores: [{ type: "NEUTRAL", confidence: 90 }],
        },
      ],
    },
  }),
}));
vi.mock("../src/modules/presage/videoFrames", () => ({
  FRAME_WIDTH: 1280,
  FRAME_HEIGHT: 720,
  FRAME_RATE: 30,
  readFrames: async function* () {
    for (let i = 0; i < fake.state.frameCount; i++) yield Buffer.alloc(8);
  },
}));
import { analyzeVideo } from "../src/modules/presage/vitalsService";

beforeEach(() => {
  fake.state.frameCount = 3;
  fake.state.failOnFrame = 0;
});

describe("analyzeVideo", () => {
  it("pushes the decoded frames to Presage and returns its readings", async () => {
    const result = await analyzeVideo(
      Buffer.from("video"),
      "video/webm",
      "key",
    );

    const sdk = fake.FakeSdk.last!;
    expect(sdk.input).toBe("custom");
    expect(sdk.frames).toEqual(
      [0, 33_333, 66_667].map((timestampUs) => ({
        width: 1280,
        height: 720,
        stride: 1280 * 3,
        timestampUs,
      })),
    );
    expect(sdk.stopped).toBe(true);
    expect(sdk.destroyed).toBe(true);
    expect(result.durationSeconds).toBe(1);
    expect(result.validation).toEqual([{ timeSeconds: 0, code: 0, hint: "" }]);
    expect(result.heartRate).toEqual([
      { timeSeconds: 12, value: 72.3, confidence: 92, stable: true },
    ]);
    expect(result.breathingRate).toEqual([
      { timeSeconds: 30, value: 14, confidence: 70, stable: true },
    ]);
  });

  it("averages expression scores per second and finds the dominant one", async () => {
    const result = await analyzeVideo(
      Buffer.from("video"),
      "video/webm",
      "key",
    );

    // Unstable samples are skipped; each second averages its stable ones.
    expect(result.expressions.map((point) => point.timeSeconds)).toEqual([
      3, 4, 5,
    ]);
    expect(result.expressions[0].scores).toMatchObject({
      neutral: 70,
      happy: 30,
      angry: 0,
    });
    expect(result.expressions[1].scores).toMatchObject({
      neutral: 30,
      happy: 70,
      angry: 0,
    });
    expect(result.dominantExpression).toBe("neutral");
    expect(result.expressionShares).toEqual([
      { name: "neutral", percent: 67 },
      { name: "happy", percent: 33 },
    ]);
  });

  it("keeps only a few frames ahead of Presage", async () => {
    fake.state.frameCount = 40;
    await analyzeVideo(Buffer.from("video"), "video/webm", "key");

    const sdk = fake.FakeSdk.last!;
    expect(sdk.frames).toHaveLength(40);
    expect(sdk.maxInFlight).toBeLessThanOrEqual(8);
  });

  it("stops pushing and fails when Presage reports an error", async () => {
    fake.state.frameCount = 40;
    fake.state.failOnFrame = 2;

    await expect(
      analyzeVideo(Buffer.from("video"), "video/webm", "key"),
    ).rejects.toThrow("Processing failed.");
    const sdk = fake.FakeSdk.last!;
    expect(sdk.frames).toHaveLength(2);
    expect(sdk.stopped).toBe(true);
    expect(sdk.destroyed).toBe(true);
  });
});
