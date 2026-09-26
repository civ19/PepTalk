// Public, SDK-independent types for the Presage module. Nothing in here
// imports @smartspectra/node-sdk, so the host app can depend on these freely.
//
// Clock conventions used everywhere in this module:
//   tUs — SmartSpectra timestamp in microseconds. In Electron the renderer SDK
//         anchors camera frame times to the Unix epoch once, then keeps them
//         strictly monotonic, so tUs is both monotonic and comparable to
//         Date.now() * 1000.
//   tMs — milliseconds since the session started (SessionSummary.startedAtEpochMs),
//         i.e. tMs = tUs / 1000 - startedAtEpochMs. A transcript whose offsets are
//         measured from the same start instant lines up directly.

export const EXPRESSION_NAMES = ['angry', 'contempt', 'disgust', 'fear', 'happy', 'neutral', 'sad', 'surprise'] as const;
export type ExpressionName = (typeof EXPRESSION_NAMES)[number];

export interface Point2D {
  x: number;
  y: number;
}

/** A rate reading (pulse or breathing) with the SDK's 0–100 confidence. */
export interface RateReading {
  tUs: number;
  value: number;
  confidence: number;
  stable: boolean;
}

export interface HrvReading {
  tUs: number;
  rmssdMs: number;
  sdnnMs: number;
  meanNnMs: number;
  /** Baevsky index. Unitless; compare against the same person's baseline. */
  baevsky: number;
  confidence: number;
  stable: boolean;
}

export interface DetectionReading {
  tUs: number;
  detected: boolean;
  stable: boolean;
}

export interface ExpressionReading {
  tUs: number;
  /** Per-expression confidence, 0–100. */
  scores: Partial<Record<ExpressionName, number>>;
  top: ExpressionName | null;
  topConfidence: number;
  stable: boolean;
}

export interface LandmarksReading {
  tUs: number;
  /** 478 points in source-frame pixel coordinates (see frameWidth/frameHeight on the tracker's stream). */
  points: Point2D[];
  stable: boolean;
  /** True when this set cannot be associated with the previous one (face re-acquired). */
  reset: boolean;
}

/** Where the person is looking, from their own perspective ('left' = their left). */
export type GazeDirection = 'camera' | 'left' | 'right' | 'up' | 'down';

/** Gaze estimate derived from one landmark set (see gaze.ts). */
export interface GazeReading {
  tUs: number;
  /** Horizontal offset in eye widths, head turn included. Positive = toward the person's left. */
  h: number;
  /** Vertical offset in eye widths. Positive = down. */
  v: number;
  direction: GazeDirection;
}

/** Which requested metric groups carried any data in a metrics packet. */
export interface GroupPresence {
  face: boolean;
  cardio: boolean;
  breathing: boolean;
}

/**
 * One decoded SmartSpectra `metrics` event. Each event carries the readings
 * produced since the previous event, so arrays can hold 0..n entries.
 */
export interface PresageSample {
  /** Packet timestamp from the SDK event (µs, see clock conventions above). */
  tUs: number;
  /** Milliseconds since the session started. */
  tMs: number;
  pulse: RateReading[];
  breathing: RateReading[];
  hrv: HrvReading[];
  blinking: DetectionReading[];
  talking: DetectionReading[];
  expressions: ExpressionReading[];
  /** Latest landmark set in this packet, if any (older sets in the same packet are dropped). */
  landmarks: LandmarksReading | null;
  /** Gaze estimated from `landmarks`; null without landmarks, mid-blink, or if the layout isn't recognized. */
  gaze: GazeReading | null;
  groups: GroupPresence;
}

export type ValidationName =
  | 'Ok'
  | 'NoFaceFound'
  | 'MultipleFacesFound'
  | 'FaceNotCentered'
  | 'FaceSizeOutOfRange'
  | 'TooDark'
  | 'TooBright'
  | 'ChestNotVisible'
  | 'CameraTuning'
  | 'FrameRateTooLow'
  | 'ExcessiveMotion'
  | 'FaceTooClose'
  | 'FaceTooFar'
  | 'FaceTooHigh'
  | 'FaceTooLow'
  | 'FaceNotForward'
  | `Unknown${number}`;

export interface ValidationEvent {
  tUs: number;
  tMs: number;
  code: number;
  name: ValidationName;
  ok: boolean;
  /** Hint text exactly as the SDK sent it (may be empty). */
  hint: string;
  /** Short user-facing advice for this code, e.g. "Move closer". Empty when ok. */
  advice: string;
}

export type TrackerStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'error';

export interface PresageError {
  /** Numeric SmartSpectraErrorCode, or a string code for host-side failures (e.g. 'SMARTSPECTRA_IPC_TIMEOUT'). */
  code: number | string;
  name: string;
  message: string;
  retryable: boolean;
}

export type MetricGroup = keyof GroupPresence;

export interface PresageWarning {
  kind: 'metric-group-empty' | 'metric-group-recovered';
  group: MetricGroup;
  message: string;
}

// ---------------------------------------------------------------------------
// Session summary (the JSON written to sessions/<iso-date>.json)
// ---------------------------------------------------------------------------

export interface TimeWindowStat {
  startMs: number;
  endMs: number;
  avg: number | null;
  samples: number;
}

export interface RateSummary {
  avg: number | null;
  min: number | null;
  max: number | null;
  samplesUsed: number;
  samplesDroppedLowConfidence: number;
  minConfidence: number;
}

export interface Interval {
  startMs: number;
  endMs: number;
}

export interface ValidationIssueInterval extends Interval {
  code: number;
  name: ValidationName;
  hint: string;
}

export interface ExpressionWindow extends Interval {
  dominant: ExpressionName | null;
  /** Share of expression readings in the window where each expression was the top one (sums to ~1). */
  distribution: Partial<Record<ExpressionName, number>>;
  samples: number;
}

export interface SessionSummary {
  schemaVersion: 1;
  startedAt: string;
  endedAt: string;
  startedAtEpochMs: number;
  durationMs: number;
  clock: {
    description: string;
    /** First SDK timestamp seen in this session (µs). */
    firstSdkTimestampUs: number | null;
    /** Last SDK timestamp seen in this session (µs). */
    lastSdkTimestampUs: number | null;
  };
  pulse: RateSummary & {
    unit: 'bpm';
    /** Per-10s windows over the session (accepted samples only). */
    timeline: TimeWindowStat[];
  };
  breathing: RateSummary & {
    unit: 'breaths/min';
    samplesExcludedWhileTalking: number;
    note: string;
  };
  hrv: {
    latestStable: (Omit<HrvReading, 'tUs' | 'stable'> & { tMs: number }) | null;
    samplesUsed: number;
    samplesDroppedLowConfidence: number;
    minConfidence: number;
    note: string;
  };
  blinks: {
    count: number;
    perMinute: number | null;
    /** Session-relative ms of each blink onset. */
    onsetsMs: number[];
  };
  gaze: {
    /** Fraction of observed gaze time spent looking at the camera. */
    eyeContactRatio: number | null;
    onCameraMs: number;
    observedMs: number;
    /** Share of off-camera time per direction (sums to ~1). */
    awayDirections: Partial<Record<Exclude<GazeDirection, 'camera'>, number>>;
    /** Off-camera stretches long enough to be more than a glance. */
    lookAways: (Interval & { direction: Exclude<GazeDirection, 'camera'> })[];
    longestLookAwayMs: number;
    /** Per-10s windows. */
    timeline: (Interval & { eyeContactRatio: number | null })[];
    note: string;
  };
  talking: {
    ratio: number | null;
    talkingMs: number;
    observedMs: number;
    intervals: Interval[];
  };
  expressions: {
    /** Share of all expression readings where each expression was the top one. */
    distribution: Partial<Record<ExpressionName, number>>;
    /** Per-10s windows. */
    timeline: ExpressionWindow[];
    samples: number;
  };
  face: {
    /** Fraction of observed time with validation status Ok (camera-tuning time excluded). */
    validRatio: number | null;
    validMs: number;
    observedMs: number;
  };
  validationIssues: ValidationIssueInterval[];
  /** Requested metric groups that produced no data at all during the session. */
  emptyMetricGroups: MetricGroup[];
  /** Accepted readings, for aligning with transcript timestamps later. */
  series: {
    pulse: { tMs: number; tUs: number; bpm: number; confidence: number }[];
    breathing: { tMs: number; tUs: number; breathsPerMin: number; confidence: number; excludedWhileTalking: boolean }[];
    hrv: { tMs: number; tUs: number; rmssdMs: number; sdnnMs: number; baevsky: number; confidence: number }[];
  };
}
