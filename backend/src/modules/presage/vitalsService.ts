import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { decodeMetrics } from "@smartspectra/node-sdk/messages";
import {
  EXPRESSIONS,
  emptyScores,
  expressionName,
  summarizeExpressions,
  type ExpressionName,
  type ExpressionPoint,
  type ExpressionShare,
} from "./expressions";
import {
  FRAME_HEIGHT,
  FRAME_RATE,
  FRAME_WIDTH,
  readFrames,
} from "./videoFrames";

type Metrics = ReturnType<typeof decodeMetrics>;
type Measurement = NonNullable<
  NonNullable<Metrics["cardio"]>["pulseRate"]
>[number];

export interface VitalPoint {
  timeSeconds: number;
  value: number;
  confidence: number;
  stable: boolean;
}

export interface ValidationPoint {
  timeSeconds: number;
  code: number;
  hint: string;
}

export interface VitalsResult {
  durationSeconds: number;
  heartRate: VitalPoint[];
  breathingRate: VitalPoint[];
  validation: ValidationPoint[];
  expressions: ExpressionPoint[];
  /** The expression Presage scored highest for the most seconds. */
  dominantExpression: ExpressionName | null;
  expressionShares: ExpressionShare[];
  cameraFacingPercent: number | null;
  cameraFacingSamples: number;
  cameraFacing: { timeSeconds: number; facing: boolean }[];
  possibleBreathInterruptions: number;
  hints: string[];
}

let pending: Promise<unknown> = Promise.resolve();
const serialize = <T>(job: () => Promise<T>): Promise<T> => {
  const result = pending.then(job, job);
  pending = result.catch(() => undefined);
  return result;
};

const TIMEOUT_MS = 180_000;
// The SDK drops frames it can't keep up with, so only a few are pushed ahead of it.
const MAX_FRAMES_IN_FLIGHT = 8;

function cameraFacing(
  points: NonNullable<
    NonNullable<NonNullable<Metrics["face"]>["landmarks"]>[number]["value"]
  >,
): boolean | null {
  if (!points) return null;
  if (points.length < 478) return null;
  const x = (index: number) => points[index]?.x;
  const eyeRatio = (iris: number, a: number, b: number) => {
    const left = Math.min(a, b);
    const width = Math.abs(a - b);
    return width > 0 ? (iris - left) / width : NaN;
  };
  const right = eyeRatio(x(468)!, x(33)!, x(133)!);
  const left = eyeRatio(x(473)!, x(362)!, x(263)!);
  const faceCenter = (x(33)! + x(263)!) / 2;
  const faceWidth = Math.abs(x(33)! - x(263)!);
  const noseOffset =
    faceWidth > 0 ? Math.abs(x(1)! - faceCenter) / faceWidth : NaN;
  if (![right, left, noseOffset].every(Number.isFinite)) return null;
  // A coarse camera-facing cue, not a calibrated gaze or eye-contact measurement.
  return (
    right >= 0.3 &&
    right <= 0.7 &&
    left >= 0.3 &&
    left <= 0.7 &&
    noseOffset <= 0.18
  );
}

export async function analyzeVideo(
  video: Buffer,
  mimeType: string,
  apiKey: string,
): Promise<VitalsResult> {
  return serialize(async () => {
    const {
      SmartSpectraSDK,
      FrameTransform,
      PixelFormat,
      ProcessingStatus,
      breathingMetrics,
      cardioMetrics,
      faceMetrics,
    } = await import("@smartspectra/node-sdk");
    const { decodeMetrics } = await import("@smartspectra/node-sdk/messages");
    const directory = await mkdtemp(join(tmpdir(), "preptalk-presage-"));
    const path = join(
      directory,
      mimeType === "video/mp4" ? "recording.mp4" : "recording.webm",
    );
    let sdk: InstanceType<typeof SmartSpectraSDK> | undefined;
    try {
      await writeFile(path, video);
      sdk = new SmartSpectraSDK({
        apiKey,
        requestedMetrics: [
          ...new Set([...breathingMetrics, ...cardioMetrics, ...faceMetrics]),
        ],
        enableTelemetry: false,
      });
      const heartRate = new Map<number, VitalPoint>();
      const breathingRate = new Map<number, VitalPoint>();
      const facing = new Map<number, boolean>();
      const validation = new Map<number, ValidationPoint>();
      // Per second: each expression's summed score over the stable samples, and how many.
      const expressionSums = new Map<
        number,
        { scores: Record<ExpressionName, number>; samples: number }
      >();
      const hints = new Set<string>();
      let firstAbsoluteTimestamp: number | undefined;
      const time = (timestamp: number | undefined) => {
        if (!Number.isFinite(timestamp) || timestamp! < 0) return 0;
        // Custom input is timestamped from video start. Some SDK payloads use
        // epoch microseconds instead, so keep a separate origin for those.
        if (timestamp! < 1_000_000_000_000)
          return Math.floor(timestamp! / 1_000_000);
        firstAbsoluteTimestamp ??= timestamp;
        return Math.max(
          0,
          Math.floor((timestamp! - firstAbsoluteTimestamp!) / 1_000_000),
        );
      };
      const collect = (
        target: Map<number, VitalPoint>,
        samples: Measurement[] | null | undefined,
      ) => {
        for (const sample of samples ?? []) {
          if (
            !Number.isFinite(sample.value) ||
            !Number.isFinite(sample.confidence)
          )
            continue;
          const second = time(Number(sample.timestamp));
          target.set(second, {
            timeSeconds: second,
            value: Math.round(sample.value! * 10) / 10,
            confidence: Math.round(sample.confidence!),
            stable: sample.stable === true,
          });
        }
      };
      // Set by the SDK's error events or the deadline; stops the frame loop.
      let failure: Error | undefined;
      const fail = (error: Error) => {
        failure ??= error;
      };
      sdk.on("metrics", (buffer, timestamp) => {
        try {
          const data: Metrics = decodeMetrics(buffer);
          time(timestamp);
          collect(heartRate, data.cardio?.pulseRate);
          collect(breathingRate, data.breathing?.rate);
          for (const landmarks of data.face?.landmarks ?? []) {
            if (!landmarks.stable || !landmarks.value) continue;
            const estimate = cameraFacing(landmarks.value);
            if (estimate !== null)
              facing.set(time(Number(landmarks.timestamp)), estimate);
          }
          for (const expression of data.face?.expression ?? []) {
            if (!expression.stable || !expression.scores?.length) continue;
            const second = time(Number(expression.timestamp));
            const sum = expressionSums.get(second) ?? {
              scores: emptyScores(),
              samples: 0,
            };
            for (const score of expression.scores) {
              const name = expressionName(score.type);
              if (name && Number.isFinite(score.confidence))
                sum.scores[name] += score.confidence!;
            }
            sum.samples++;
            expressionSums.set(second, sum);
          }
        } catch (error) {
          fail(
            error instanceof Error
              ? error
              : new Error("Presage metrics could not be decoded."),
          );
        }
      });
      sdk.on("validationStatus", (code, timestamp, hint) => {
        const second = time(timestamp);
        validation.set(second, { timeSeconds: second, code, hint: hint ?? "" });
        if (code !== 0 && hint) hints.add(hint);
      });
      sdk.on("error", (_code, message) => {
        fail(new Error(message || "Presage could not analyze the video."));
      });
      sdk.on("processingStatus", (status) => {
        if (status === ProcessingStatus.kError)
          fail(new Error("Presage stopped before analysis completed."));
      });
      let framesThrough = 0;
      sdk.on("frameSentThrough", () => {
        framesThrough++;
      });
      const deadline = Date.now() + TIMEOUT_MS;
      const failed = (): boolean => {
        if (Date.now() > deadline)
          fail(
            new Error("Presage analysis timed out. Try a shorter recording."),
          );
        return failure !== undefined;
      };
      // Decode here and push frames, as the SDK recommends for server-side
      // use; videoFrames.ts says why its own file reader isn't used.
      sdk.useCustomInput(FrameTransform.kNone);
      sdk.start();
      let framesSent = 0;
      for await (const frame of readFrames(path)) {
        while (framesSent - framesThrough >= MAX_FRAMES_IN_FLIGHT && !failed())
          await delay(2);
        if (failed()) break;
        sdk.sendFrame(
          frame,
          FRAME_WIDTH,
          FRAME_HEIGHT,
          FRAME_WIDTH * 3,
          PixelFormat.kRGB,
          Math.round((framesSent * 1_000_000) / FRAME_RATE),
        );
        framesSent++;
      }
      // Drains the pipeline, so the metrics for every pushed frame have arrived.
      await sdk.stopAsync();
      if (failure) throw failure;
      if (framesSent === 0)
        throw new Error("No video frames could be decoded.");
      const durationSeconds = Math.ceil(framesSent / FRAME_RATE);
      const reliableBreaths = [...breathingRate.values()].filter(
        (point) => point.stable && point.confidence >= 60 && point.value > 0,
      );
      // Changes sustained across adjacent reliable readings are only a prompt to review video.
      let interruptions = 0;
      for (let i = 1; i < reliableBreaths.length; i++) {
        if (
          reliableBreaths[i].timeSeconds - reliableBreaths[i - 1].timeSeconds <=
            3 &&
          Math.abs(reliableBreaths[i].value - reliableBreaths[i - 1].value) >= 8
        )
          interruptions++;
      }
      const expressions = [...expressionSums]
        .sort(([a], [b]) => a - b)
        .map(([timeSeconds, { scores, samples }]) => ({
          timeSeconds,
          scores: Object.fromEntries(
            EXPRESSIONS.map((name) => [
              name,
              Math.round((scores[name] / samples) * 10) / 10,
            ]),
          ) as Record<ExpressionName, number>,
        }));
      return {
        durationSeconds,
        heartRate: [...heartRate.values()].sort(
          (a, b) => a.timeSeconds - b.timeSeconds,
        ),
        breathingRate: [...breathingRate.values()].sort(
          (a, b) => a.timeSeconds - b.timeSeconds,
        ),
        validation: [...validation.values()].sort(
          (a, b) => a.timeSeconds - b.timeSeconds,
        ),
        expressions,
        ...summarizeExpressions(expressions),
        cameraFacingPercent: facing.size
          ? Math.round(
              (100 * [...facing.values()].filter(Boolean).length) / facing.size,
            )
          : null,
        cameraFacingSamples: facing.size,
        cameraFacing: [...facing]
          .sort(([a], [b]) => a - b)
          .map(([timeSeconds, isFacing]) => ({
            timeSeconds,
            facing: isFacing,
          })),
        possibleBreathInterruptions: interruptions,
        hints: [...hints].slice(0, 5),
      };
    } finally {
      if (sdk) await sdk.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
