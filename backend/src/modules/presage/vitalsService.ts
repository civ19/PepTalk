import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { decodeMetrics } from "@smartspectra/node-sdk/messages";

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

export interface VitalsResult {
  heartRate: VitalPoint[];
  breathingRate: VitalPoint[];
  cameraFacingPercent: number | null;
  cameraFacingSamples: number;
  possibleBreathInterruptions: number;
  hints: string[];
}

let pending: Promise<unknown> = Promise.resolve();
const serialize = <T>(job: () => Promise<T>): Promise<T> => {
  const result = pending.then(job, job);
  pending = result.catch(() => undefined);
  return result;
};

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
      const hints = new Set<string>();
      let firstTimestamp: number | undefined;
      const time = (timestamp: number | undefined) => {
        if (!Number.isFinite(timestamp)) return 0;
        firstTimestamp ??= timestamp;
        return Math.max(
          0,
          Math.floor((timestamp! - (firstTimestamp ?? timestamp!)) / 1_000_000),
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
      let settled = false;
      let resolveDone!: () => void;
      let rejectDone!: (error: Error) => void;
      const done = new Promise<void>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
      });
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
        } catch (error) {
          if (!settled) {
            settled = true;
            rejectDone(
              error instanceof Error
                ? error
                : new Error("Presage metrics could not be decoded."),
            );
          }
        }
      });
      sdk.on("validationStatus", (code, _timestamp, hint) => {
        if (code !== 0 && hint) hints.add(hint);
      });
      sdk.on("error", (_code, message) => {
        if (!settled) {
          settled = true;
          rejectDone(
            new Error(message || "Presage could not analyze the video."),
          );
        }
      });
      sdk.on("processingStatus", (status) => {
        if (settled) return;
        if (status === ProcessingStatus.kIdle) {
          settled = true;
          resolveDone();
        } else if (status === ProcessingStatus.kError) {
          settled = true;
          rejectDone(new Error("Presage stopped before analysis completed."));
        }
      });
      sdk.useFile(path);
      sdk.start();
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          rejectDone(
            new Error("Presage analysis timed out. Try a shorter recording."),
          );
        }
      }, 180_000);
      try {
        await done;
      } finally {
        clearTimeout(timeout);
      }
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
      return {
        heartRate: [...heartRate.values()].sort(
          (a, b) => a.timeSeconds - b.timeSeconds,
        ),
        breathingRate: [...breathingRate.values()].sort(
          (a, b) => a.timeSeconds - b.timeSeconds,
        ),
        cameraFacingPercent: facing.size
          ? Math.round(
              (100 * [...facing.values()].filter(Boolean).length) / facing.size,
            )
          : null,
        cameraFacingSamples: facing.size,
        possibleBreathInterruptions: interruptions,
        hints: [...hints].slice(0, 5),
      };
    } finally {
      if (sdk) await sdk.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
