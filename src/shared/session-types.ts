// Data contract for recorded practice sessions. The analytics module imports
// these types; capture/storage (src/capture) produces them. No imports, so it
// can be copied or imported from anywhere.
//
// Files per session (sessions/<id>/, or fixtures/<id>/ after export-fixture):
//   session.json    Session
//   samples.ndjson  one SampleRecord per line, appended while recording
//   recording.mp4 | recording.webm   camera + mic, remuxed so it's seekable
//
// THE CLOCK: every tMs is milliseconds since the first frame of the video
// recording (video time 0). Seek the video to tMs / 1000 seconds and the
// samples with that tMs describe that frame. Presage timestamps are converted
// once, at capture time, using Session.clock; nothing downstream needs the
// SDK clock.
//
// Samples are appended in arrival order, not tMs order: vitals arrive
// 1-10 s after the moment they describe. Sort by tMs before use. Rarely, two
// rows of the same kind share a tMs (a frame whose readings straddled a
// flush); mergeSampleRecords() folds them together.

export const SESSION_SCHEMA_VERSION = 1;

export const EXPRESSION_NAMES = ['angry', 'contempt', 'disgust', 'fear', 'happy', 'neutral', 'sad', 'surprise'] as const;
export type ExpressionName = (typeof EXPRESSION_NAMES)[number];

/** Pixel coordinates in the camera frame (Session.video.width x height), unmirrored: image-right is the person's left. */
export interface Point2D {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Session (session.json)

export interface ClockAnchor {
  /**
   * 'frame-matched': SDK timestamps were matched frame-by-frame to the camera
   *   capture clock, and video time 0 is the capture time of the first recorded
   *   frame. Accurate to about one frame (33 ms).
   * 'wall-clock': fallback when matching failed. Uses Date.now() at
   *   MediaRecorder start and the SDK's own epoch anchor, which runs ~30-100 ms
   *   ahead of real capture time.
   */
  method: 'frame-matched' | 'wall-clock';
  /** Wall-clock (Unix ms) of video time 0. Same instant as Session.startedAtIso. */
  videoStartEpochMs: number;
  /** tMs = (sdkTimestampUs - sdkToVideoOffsetUs) / 1000, for any SmartSpectra timestamp from this session. */
  sdkToVideoOffsetUs: number;
  /** How far the SDK's epoch timestamps ran ahead of real capture time (frame-matched only). */
  sdkBiasMs: number | null;
  /** tMs of the first Presage reading. Presage starts ~1 s after the camera does (SDK start-up), so this is normally 800-1500 ms. */
  firstSampleTMs: number | null;
  /** Presentation time of the first packet in the remuxed file, in ms (normally 0). Players start at this point. */
  containerStartMs: number | null;
}

export interface VideoInfo {
  /** MediaRecorder mime type actually used, e.g. 'video/mp4;codecs=avc1,opus'. */
  mimeType: string;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  hasAudio: boolean;
  /** True once ffmpeg remuxed the raw MediaRecorder output into a seekable file. */
  remuxed: boolean;
}

export type SessionStatus =
  /** Being recorded right now (or the app crashed; see 'interrupted'). */
  | 'recording'
  /** Stopped normally. */
  | 'complete'
  /** The app exited mid-session; recovered on the next launch. Data up to the last flush is kept. */
  | 'interrupted';

export interface UploadState {
  status: 'pending' | 'uploaded' | 'failed' | 'not-configured';
  /** ISO time of the last attempt. */
  attemptedAt: string | null;
  error: string | null;
}

export interface Session {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  /** UUID; also the folder name and the DB primary key. */
  id: string;
  /** Wall-clock time of video time 0 (tMs = 0). */
  startedAtIso: string;
  /** Video duration; null while recording or if the file couldn't be probed. */
  durationMs: number | null;
  /** Video file name relative to the folder holding session.json, e.g. 'recording.mp4'. Null if no video was written. */
  recordingPath: string | null;
  appVersion: string;
  /** Null only while waiting for the first Presage frame (no samples are written before it's set). */
  clock: ClockAnchor | null;
  video: VideoInfo;
  status: SessionStatus;
  /** Rows written to samples.ndjson. */
  counts: { vitals: number; face: number; validation: number };
  upload: UploadState;
}

// ---------------------------------------------------------------------------
// Samples (samples.ndjson)

/**
 * One vitals reading. Pulse, HRV and breathing are computed on their own
 * schedules, so usually only one group is non-null per row. Confidence is the
 * SDK's 0-100 scale; Presage's own "stable" cut-offs are pulse >= 40,
 * breathing >= 45, HRV >= 50. `tMs` is when the measurement applies, not when
 * it arrived (pulse arrives ~1.3 s later, breathing up to ~10 s later).
 */
export interface VitalsSample {
  tMs: number;
  /** 12 s average. First reading ~15 s into a session. */
  pulseBpm: number | null;
  pulseConfidence: number | null;
  pulseStable: boolean | null;
  /** 60 s window: nothing until ~60 s of clean signal. */
  hrvRmssdMs: number | null;
  hrvSdnnMs: number | null;
  hrvMeanNnMs: number | null;
  /** Baevsky stress index, unitless. Compare against the same person's baseline. */
  hrvBaevsky: number | null;
  hrvConfidence: number | null;
  hrvStable: boolean | null;
  /** 30 s average, breaths/min. Unreliable while talking (per Presage). */
  breathingRate: number | null;
  breathingConfidence: number | null;
  breathingStable: boolean | null;
}

/** Expression probabilities, 0-1, summing to ~1. */
export type ExpressionProbabilities = Record<ExpressionName, number>;

/** One eye, as MediaPipe Face Mesh points (indices in FACE_MESH). */
export interface EyePoints {
  /** Corner toward the ear. */
  outerCorner: Point2D;
  /** Corner toward the nose. */
  innerCorner: Point2D;
  /** Mid upper lid. */
  upperLid: Point2D;
  /** Mid lower lid. */
  lowerLid: Point2D;
  irisCenter: Point2D;
  /** Four points on the iris edge. */
  irisContour: [Point2D, Point2D, Point2D, Point2D];
}

/** Eyes named from the person's own perspective. */
export interface EyeLandmarks {
  right: EyePoints;
  left: EyePoints;
}

/**
 * Head orientation estimated from 2D landmarks. Unitless, not degrees, and
 * the neutral point varies per person: compare against the session's own
 * median rather than absolute thresholds.
 */
export interface HeadPose {
  /** Nose tip position across the face width, -1..1. 0 = facing the camera, positive = turned toward the person's left. */
  yaw: number;
  /** Nose drop below the eye line as a fraction of eye-to-chin distance, minus 0.31 (a frontal face in testing). Positive = tilted down. */
  pitch: number;
}

/** Where the eyes point relative to the camera, head turn included (see src/presage/gaze.ts). */
export interface GazeEstimate {
  /** Horizontal offset in eye widths. Positive = toward the person's left. */
  h: number;
  /** Vertical offset in eye widths. Positive = down. */
  v: number;
  /** 'camera' = roughly at the lens. Directions are from the person's perspective. */
  direction: 'camera' | 'left' | 'right' | 'up' | 'down';
}

/**
 * One camera frame's face readings (~30 per second while a face is visible).
 * Blinking/talking are reported for nearly every frame; expressions and
 * landmarks for ~75% of frames. Missing fields are null.
 */
export interface FaceSample {
  tMs: number;
  blinking: boolean | null;
  talking: boolean | null;
  expressions: ExpressionProbabilities | null;
  eyeLandmarks: EyeLandmarks | null;
  headPose: HeadPose | null;
  /** Null without landmarks, mid-blink, or if the landmark layout isn't recognized. */
  gaze: GazeEstimate | null;
}

/**
 * Positioning / signal-quality status. The SDK reports it every frame; only
 * changes are stored, so each event holds until the next one.
 */
export interface ValidationEvent {
  tMs: number;
  /** SmartSpectra ValidationCode (0 = Ok). */
  code: number;
  /** Code name, e.g. 'Ok', 'NoFaceFound', 'ExcessiveMotion', 'ChestNotVisible'. */
  name: string;
  /** SDK hint text, may be empty. */
  hint: string;
}

export type SampleRecord =
  | ({ kind: 'vitals' } & VitalsSample)
  | ({ kind: 'face' } & FaceSample)
  | ({ kind: 'validation' } & ValidationEvent);

/**
 * MediaPipe Face Mesh indices (478-point model with irises) used for
 * EyeLandmarks and HeadPose. Checked against Presage's linked reference
 * (https://storage.googleapis.com/mediapipe-assets/documentation/mediapipe_face_landmark_fullsize.png)
 * and MediaPipe's face_mesh_connections.py for the iris points 468-477.
 */
export const FACE_MESH = {
  rightEye: { outerCorner: 33, innerCorner: 133, upperLid: 159, lowerLid: 145, irisCenter: 468, irisContour: [469, 470, 471, 472] },
  leftEye: { outerCorner: 263, innerCorner: 362, upperLid: 386, lowerLid: 374, irisCenter: 473, irisContour: [474, 475, 476, 477] },
  noseTip: 1,
  chin: 152,
  /** Face-oval points at the cheek edges, image-left then image-right. */
  cheekImageLeft: 234,
  cheekImageRight: 454,
  pointCount: 478,
} as const;

/**
 * Folds rows of the same kind and tMs into one (non-null fields win, later
 * rows win ties) and sorts by tMs. Validation events are kept as-is.
 */
export function mergeSampleRecords(records: readonly SampleRecord[]): SampleRecord[] {
  const byKey = new Map<string, SampleRecord>();
  const out: SampleRecord[] = [];
  for (const r of records) {
    if (r.kind === 'validation') {
      out.push(r);
      continue;
    }
    const key = `${r.kind}:${r.tMs}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...r });
      continue;
    }
    const merged: Record<string, unknown> = { ...prev };
    for (const [k, v] of Object.entries(r)) if (v !== null && v !== undefined) merged[k] = v;
    byKey.set(key, merged as unknown as SampleRecord);
  }
  out.push(...byKey.values());
  return out.sort((a, b) => a.tMs - b.tMs);
}
