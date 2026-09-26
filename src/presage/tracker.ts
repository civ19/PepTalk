// Renderer-side tracker: the only place (besides decode.ts) that talks to the
// SmartSpectra SDK. The host app uses createPresageTracker() and the typed
// callbacks below; it never imports the SDK itself.

import {
  SmartSpectraSDK,
  ProcessingStatus,
  SmartSpectraErrorCode,
  ValidationCode,
  type ProcessingStatusValue,
} from '@smartspectra/node-sdk/renderer';
import { CARDIO_EXTRA_GRACE_MS, EMPTY_GROUP_WARNING_MS } from './constants';
import { decodePacket } from './decode';
import { estimateGaze } from './gaze';
import { REQUESTED_METRICS } from './metrics';
import { SessionRecorder, type PersistFn, type RecordedSession } from './sessionRecorder';
import type {
  MetricGroup,
  PresageError,
  PresageSample,
  PresageWarning,
  TrackerStatus,
  ValidationEvent,
  ValidationName,
} from './types';

const REQUESTED_GROUPS: readonly MetricGroup[] = ['face', 'cardio', 'breathing'];
// Valid-face time needed before an empty group is blamed on authorization.
const FACE_OK_MS_FOR_AUTH_VERDICT = 5_000;
const WATCHDOG_TICK_MS = 1_000;
const GROUP_DEADLINE_MS: Record<MetricGroup, number> = {
  face: EMPTY_GROUP_WARNING_MS,
  cardio: EMPTY_GROUP_WARNING_MS + CARDIO_EXTRA_GRACE_MS,
  breathing: EMPTY_GROUP_WARNING_MS,
};

/** Reverse a { kName: value } SDK constant table into value -> 'Name'. */
function namesOf(table: Readonly<Record<string, number>>): ReadonlyMap<number, string> {
  return new Map(Object.entries(table).map(([k, v]) => [v, k.replace(/^k/, '')]));
}
const VALIDATION_NAMES = namesOf(ValidationCode);
const ERROR_NAMES = namesOf(SmartSpectraErrorCode);

const ADVICE: Partial<Record<ValidationName, string>> = {
  NoFaceFound: 'Face the camera',
  MultipleFacesFound: 'Only one person in frame, please',
  FaceNotCentered: 'Center your face in the frame',
  FaceSizeOutOfRange: 'Adjust your distance to the camera',
  TooDark: 'Improve lighting',
  TooBright: 'Too bright: reduce backlight or glare',
  ChestNotVisible: 'Make sure your upper chest is visible',
  CameraTuning: 'Adjusting camera…',
  FrameRateTooLow: 'Camera frame rate too low',
  ExcessiveMotion: 'Hold still',
  FaceTooClose: 'Move back a little',
  FaceTooFar: 'Move closer',
  FaceTooHigh: 'Move down a little',
  FaceTooLow: 'Move up a little',
  FaceNotForward: 'Look straight at the camera',
};

function statusFromSdk(s: ProcessingStatusValue): TrackerStatus | null {
  switch (s) {
    case ProcessingStatus.kStarting:
      return 'starting';
    case ProcessingStatus.kRunning:
      return 'running';
    case ProcessingStatus.kStopping:
      return 'stopping';
    case ProcessingStatus.kError:
      return 'error';
    case ProcessingStatus.kIdle:
    case ProcessingStatus.kUninitialized:
      return 'idle';
    default:
      return null;
  }
}

/** Normalize something thrown by an SDK call into a PresageError. */
function errorFromThrown(err: unknown): PresageError {
  const rec = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
  const code = typeof rec['code'] === 'number' || typeof rec['code'] === 'string' ? rec['code'] : 'JS_ERROR';
  const message = err instanceof Error ? err.message : String(err);
  return {
    code,
    name: typeof code === 'number' ? (ERROR_NAMES.get(code) ?? `Error${code}`) : code,
    message,
    retryable: rec['retryable'] === true,
  };
}

// ---------------------------------------------------------------------------

interface TrackerEvents {
  sample: PresageSample;
  validation: ValidationEvent;
  error: PresageError;
  status: TrackerStatus;
  /** The live camera stream once the SDK acquires it; null when released. */
  stream: MediaStream | null;
  warning: PresageWarning;
}

type Unsubscribe = () => void;

class Emitter<E> {
  private readonly listeners: { [K in keyof E]?: Set<(value: E[K]) => void> } = {};

  on<K extends keyof E>(event: K, cb: (value: E[K]) => void): Unsubscribe {
    const set = (this.listeners[event] ??= new Set());
    set.add(cb);
    return () => set.delete(cb);
  }

  emit<K extends keyof E>(event: K, value: E[K]): void {
    for (const cb of this.listeners[event] ?? []) {
      try {
        cb(value);
      } catch (err) {
        console.error(`[presage] ${String(event)} listener threw`, err);
      }
    }
  }
}

export interface PresageTrackerOptions {
  /** The SmartSpectra API key, or an async getter (called on every startSession). */
  apiKey: string | (() => Promise<string>);
  /** Where finished session summaries go; see SessionRecorder. */
  persist?: PersistFn;
  /** Debug hook: every raw `metrics` buffer, before decoding (see debugDump.ts). */
  onRawMetrics?: (buf: Uint8Array, tUs: number) => void;
}

export interface PresageTracker {
  onSample(cb: (sample: PresageSample) => void): Unsubscribe;
  onValidation(cb: (event: ValidationEvent) => void): Unsubscribe;
  onError(cb: (error: PresageError) => void): Unsubscribe;
  onStatus(cb: (status: TrackerStatus) => void): Unsubscribe;
  onStream(cb: (stream: MediaStream | null) => void): Unsubscribe;
  onWarning(cb: (warning: PresageWarning) => void): Unsubscribe;
  readonly status: TrackerStatus;
  /** True between a successful startSession() and stopSession(), including after an SDK error (so the partial session can still be stopped and saved). */
  readonly sessionActive: boolean;
  /** Acquires the camera and starts measuring + recording. */
  startSession(): Promise<void>;
  /** Stops the SDK, releases the camera, and returns (and persists) the session summary. */
  stopSession(): Promise<RecordedSession>;
  /**
   * Graceful teardown for window close: stops and saves an active session
   * (sdk.stop() + destroy(), camera released), otherwise just disposes.
   */
  shutdown(): Promise<RecordedSession | null>;
  /** Synchronous last-resort teardown (e.g. page reload): destroys the SDK and releases the camera. The in-progress session is discarded. */
  dispose(): void;
}

class Tracker implements PresageTracker {
  private readonly events = new Emitter<TrackerEvents>();
  private readonly recorder: SessionRecorder;
  private sdk: SmartSpectraSDK | null = null;
  private currentStatus: TrackerStatus = 'idle';
  private stopping = false;

  // Empty-group watchdog state (reset per session).
  private groupsSeen = new Set<MetricGroup>();
  private warnedGroups = new Map<MetricGroup, 'signal' | 'auth'>();
  // Accumulated time the validation status has been Ok since Running.
  private okMs = 0;
  private okSince: number | null = null;
  private runningAt: number | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private decodeFailures = 0;

  constructor(private readonly options: PresageTrackerOptions) {
    this.recorder = new SessionRecorder(options.persist ? { persist: options.persist } : {});
  }

  get status(): TrackerStatus {
    return this.currentStatus;
  }

  get sessionActive(): boolean {
    return this.sdk !== null && this.recorder.recording;
  }

  onSample(cb: (s: PresageSample) => void): Unsubscribe {
    return this.events.on('sample', cb);
  }
  onValidation(cb: (e: ValidationEvent) => void): Unsubscribe {
    return this.events.on('validation', cb);
  }
  onError(cb: (e: PresageError) => void): Unsubscribe {
    return this.events.on('error', cb);
  }
  onStatus(cb: (s: TrackerStatus) => void): Unsubscribe {
    return this.events.on('status', cb);
  }
  onStream(cb: (s: MediaStream | null) => void): Unsubscribe {
    return this.events.on('stream', cb);
  }
  onWarning(cb: (w: PresageWarning) => void): Unsubscribe {
    return this.events.on('warning', cb);
  }

  async startSession(): Promise<void> {
    if (this.sdk) throw new Error('A session is already active');
    this.resetWatchdog();
    this.stopping = false;
    this.setStatus('starting');

    let apiKey: string;
    try {
      apiKey = typeof this.options.apiKey === 'function' ? await this.options.apiKey() : this.options.apiKey;
    } catch (err) {
      this.fail(errorFromThrown(err));
      throw err;
    }

    const sdk = new SmartSpectraSDK({ apiKey, requestedMetrics: [...REQUESTED_METRICS], enableAccumulatedOutput: false });
    this.sdk = sdk;

    sdk.on('processingStatus', (s) => this.handleProcessingStatus(s));
    sdk.on('validationStatus', (code, tUs, hint) => this.handleValidation(code, tUs, hint));
    sdk.on('metrics', (buf, tUs) => this.handleMetrics(buf, tUs));
    sdk.on('error', (code, message, retryable) => {
      this.events.emit('error', { code, name: ERROR_NAMES.get(code) ?? `Error${code}`, message, retryable });
    });
    sdk.on('streamAvailable', (stream) => this.events.emit('stream', stream));

    this.recorder.start();
    try {
      await sdk.start();
    } catch (err) {
      this.recorder.abort();
      this.teardownSdk();
      this.fail(errorFromThrown(err));
      throw err;
    }
  }

  async stopSession(): Promise<RecordedSession> {
    const sdk = this.sdk;
    if (!sdk || !this.recorder.recording) throw new Error('No active session');
    this.stopping = true;
    this.setStatus('stopping');
    this.stopWatchdog();
    const wasError = this.currentStatus === 'error';
    try {
      await sdk.stop();
    } catch (err) {
      // After an SDK error, stop() failing is expected and adds nothing new.
      if (!wasError) this.events.emit('error', errorFromThrown(err));
    }
    this.teardownSdk();

    const result = await this.recorder.stop();
    if (result.saveError) {
      this.events.emit('error', { code: 'SAVE_FAILED', name: 'SaveFailed', message: result.saveError, retryable: false });
    }
    const ranMs = this.runningAt === null ? 0 : performance.now() - this.runningAt;
    for (const g of result.summary.emptyMetricGroups) {
      if (ranMs >= GROUP_DEADLINE_MS[g]) {
        console.warn(`[presage] session ended with no ${g} data at all; check that your plan includes ${g} metrics`);
      } else {
        console.info(`[presage] no ${g} data yet: the session was too short (${Math.round(ranMs / 1000)}s running)`);
      }
    }
    this.stopping = false;
    this.setStatus('idle');
    return result;
  }

  async shutdown(): Promise<RecordedSession | null> {
    if (this.sessionActive && !this.stopping) {
      try {
        return await this.stopSession();
      } catch (err) {
        this.events.emit('error', errorFromThrown(err));
      }
    }
    this.dispose();
    return null;
  }

  dispose(): void {
    this.stopWatchdog();
    if (this.recorder.recording) this.recorder.abort();
    this.teardownSdk();
  }

  // --- internals -------------------------------------------------------------

  private setStatus(s: TrackerStatus): void {
    if (s === this.currentStatus) return;
    this.currentStatus = s;
    this.events.emit('status', s);
  }

  private fail(error: PresageError): void {
    this.events.emit('error', error);
    this.setStatus('error');
  }

  private teardownSdk(): void {
    const sdk = this.sdk;
    this.sdk = null;
    if (!sdk) return;
    try {
      // Releases the SDK-acquired camera and tells the main process to destroy its native session.
      sdk.destroy();
    } catch {
      /* already destroyed */
    }
    this.events.emit('stream', null);
  }

  private handleProcessingStatus(s: ProcessingStatusValue): void {
    const mapped = statusFromSdk(s);
    if (!mapped) return;
    // While stopSession() is in flight, keep reporting 'stopping' until it finishes.
    if (this.stopping && mapped !== 'error') return;
    if (mapped === 'running' && this.runningAt === null) this.startWatchdog();
    // An errored pipeline produces nothing, so empty groups say nothing about authorization.
    if (mapped === 'error') this.stopWatchdog();
    this.setStatus(mapped);
  }

  private handleValidation(code: number, tUs: number, hint: string): void {
    const name = (VALIDATION_NAMES.get(code) ?? `Unknown${code}`) as ValidationName;
    const ok = code === ValidationCode.kOk;
    const now = performance.now();
    if (this.okSince !== null) this.okMs += now - this.okSince;
    this.okSince = ok && this.runningAt !== null ? now : null;
    const event: ValidationEvent = {
      tUs,
      tMs: this.recorder.toSessionMs(tUs),
      code,
      name,
      ok,
      hint: hint.trim(),
      advice: ok ? '' : (ADVICE[name] ?? 'Adjust your position'),
    };
    this.recorder.addValidation(event);
    this.events.emit('validation', event);
  }

  private handleMetrics(buf: Uint8Array, tUs: number): void {
    try {
      this.options.onRawMetrics?.(buf, tUs);
    } catch (err) {
      console.error('[presage] onRawMetrics hook threw', err);
    }
    const result = decodePacket(buf);
    if (!result.ok) {
      // Log the first few failures; one bad packet shouldn't flood the UI.
      if (++this.decodeFailures <= 3) {
        this.events.emit('error', { code: 'DECODE_FAILED', name: 'DecodeFailed', message: result.reason, retryable: true });
      }
      return;
    }
    const { landmarks } = result.packet;
    const sample: PresageSample = {
      tUs,
      tMs: this.recorder.toSessionMs(tUs),
      ...result.packet,
      gaze: landmarks ? estimateGaze(landmarks) : null,
    };
    for (const g of REQUESTED_GROUPS) {
      if (!sample.groups[g] || this.groupsSeen.has(g)) continue;
      this.groupsSeen.add(g);
      if (this.warnedGroups.has(g) && this.runningAt !== null) {
        const secs = Math.round((performance.now() - this.runningAt) / 1000);
        this.warn({
          kind: 'metric-group-recovered',
          group: g,
          message: `${g} data arrived ${secs}s after Running; the earlier warning was warm-up or signal, not authorization.`,
        });
      }
    }
    this.recorder.addSample(sample);
    this.events.emit('sample', sample);
  }

  // --- empty-group watchdog -----------------------------------------------------
  // Presage: metrics the plan isn't authorized for come back empty with no error.
  // Once a group's deadline after Running passes (EMPTY_GROUP_WARNING_MS, plus
  // extra grace for cardio), report it if it has produced nothing. If the face
  // has been valid for a while, an empty group points at authorization; if not,
  // it's more likely signal/positioning, and the verdict is revisited later.

  private startWatchdog(): void {
    this.runningAt = performance.now();
    this.watchdog = setInterval(() => this.checkEmptyGroups(), WATCHDOG_TICK_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private resetWatchdog(): void {
    this.stopWatchdog();
    this.groupsSeen = new Set();
    this.warnedGroups = new Map();
    this.okMs = 0;
    this.okSince = null;
    this.runningAt = null;
    this.decodeFailures = 0;
  }

  private checkEmptyGroups(): void {
    if (this.runningAt === null) return;
    const elapsedMs = performance.now() - this.runningAt;
    const secs = Math.round(elapsedMs / 1000);
    const missing = REQUESTED_GROUPS.filter((g) => !this.groupsSeen.has(g));
    if (missing.length === 0) {
      this.stopWatchdog();
      return;
    }
    const okSecs = Math.round((this.okMs + (this.okSince !== null ? performance.now() - this.okSince : 0)) / 1000);
    const likelyCause = okSecs * 1000 >= FACE_OK_MS_FOR_AUTH_VERDICT ? 'auth' : 'signal';
    for (const g of missing) {
      if (elapsedMs < GROUP_DEADLINE_MS[g]) continue;
      if (this.warnedGroups.get(g) === likelyCause) continue;
      this.warnedGroups.set(g, likelyCause);
      const why =
        likelyCause === 'auth'
          ? `The face has been valid for ${okSecs}s, so this most likely means your API key's plan is not authorized for ${g} metrics (unauthorized metrics come back empty, with no error).`
          : `The face has only been valid for ${okSecs}s, so this is more likely signal/positioning than authorization; you'll get another warning if it stays empty once the face is valid.`;
      this.warn({
        kind: 'metric-group-empty',
        group: g,
        message: `No ${g} data ${secs}s after SmartSpectra reported Running. ${why}`,
      });
    }
  }

  private warn(w: PresageWarning): void {
    (w.kind === 'metric-group-empty' ? console.warn : console.info)(`[presage] ${w.message}`);
    this.events.emit('warning', w);
  }
}

export function createPresageTracker(options: PresageTrackerOptions): PresageTracker {
  return new Tracker(options);
}
