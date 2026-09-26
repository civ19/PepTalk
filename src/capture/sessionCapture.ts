// Renderer-side session capture: records the SDK's camera stream plus the mic
// with MediaRecorder, converts Presage readings to video-relative time, and
// streams both to the main process (sessions/<id>/) while recording.
//
// Lifecycle (driven by the host page):
//   begin()           on Start, alongside tracker.startSession()
//   attachStream(s)   from tracker.onStream: starts MediaRecorder + clock probe
//   addSample / addValidation   from the tracker's events
//   stopRecording()   before tracker.stopSession(), so the video ends when the user pressed Stop
//   finish()          after the tracker stopped: final flush, remux, session.json, upload
//
// Nothing is held only in memory for long: video chunks go to main every
// second and samples every 500 ms, so a crash loses at most that much.

import type { PresageSample, ValidationEvent } from '../presage/types';
import type { ClockAnchor, Session, VideoInfo } from '../shared/session-types';
import type { CaptureHostBridge } from './bridge';
import { computeAnchor, matchSdkOffset, toVideoMs } from './clockMatch';
import { SampleAssembler } from './samples';

const FLUSH_MS = 500;
const VIDEO_TIMESLICE_MS = 1_000;
// SDK frames needed before trying to match the clock (~2 s). 30 was ambiguous on some real windows.
const MATCH_MIN_SDK_FRAMES = 60;
// Fall back to the wall-clock anchor if matching hasn't worked this long after the first SDK frame.
const MATCH_GIVE_UP_MS = 8_000;
// How long to wait for the mic before recording video only.
const MIC_WAIT_MS = 3_000;
// A first Presage reading later than this after video start is suspicious.
const FIRST_SAMPLE_WARN_MS = 3_000;

// First supported wins. Chromium records fragmented MP4 (H.264) since M126; WebM is the fallback.
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1,opus',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export interface SessionCaptureOptions {
  /** Record the microphone too (needs 'audio' in setupPresageMain's allowedMediaTypes). */
  audio?: boolean;
}

export interface CaptureResult {
  session: Session;
}

// --- Frame probe --------------------------------------------------------------
// Reads a clone of the camera track to learn the raw capture timestamps the
// SDK builds its clock from (see clockMatch.ts). Only VideoFrame handles are
// touched (no pixel copies), and it stops once the clock is anchored.

interface FrameLike {
  timestamp: number;
  close(): void;
}
type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<FrameLike> };

const epochUsNow = (): number => (performance.timeOrigin + performance.now()) * 1000;
const PROBE_KEEP_FRAMES = 900;

class FrameProbe {
  readonly raws: number[] = [];
  /** min(read wall clock - raw timestamp): maps capture time to wall clock. */
  epochOffsetUs: number | null = null;
  videoStartRawUs: number | null = null;
  private recorderStartPerf: number | null = null;
  private track: MediaStreamTrack | null = null;

  static supported(): boolean {
    return typeof (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor === 'function';
  }

  constructor(source: MediaStreamTrack) {
    const Processor = (globalThis as { MediaStreamTrackProcessor?: TrackProcessorCtor }).MediaStreamTrackProcessor;
    this.track = source.clone();
    if (!Processor) return;
    const reader = new Processor({ track: this.track }).readable.getReader();
    void (async () => {
      while (this.track) {
        const res = await reader.read().catch(() => null);
        if (!res || res.done) break;
        const readPerf = performance.now();
        const raw = res.value.timestamp;
        res.value.close();
        const off = epochUsNow() - raw;
        if (this.epochOffsetUs === null || off < this.epochOffsetUs) this.epochOffsetUs = off;
        this.raws.push(raw);
        if (this.raws.length > PROBE_KEEP_FRAMES) this.raws.shift();
        if (this.videoStartRawUs === null && this.recorderStartPerf !== null && readPerf >= this.recorderStartPerf) this.videoStartRawUs = raw;
      }
    })();
  }

  /** The next frame read after this moment is taken as the recording's first frame. */
  markRecorderStart(perfNow: number): void {
    this.recorderStartPerf = perfNow;
  }

  stop(): void {
    this.track?.stop();
    this.track = null;
  }
}

// --- Capture --------------------------------------------------------------------

type State = 'idle' | 'active' | 'stopping';

export class SessionCapture {
  private state: State = 'idle';
  private id: string | null = null;
  private beginPromise: Promise<string | null> = Promise.resolve(null);
  private mic: Promise<MediaStream | null> = Promise.resolve(null);
  private micStream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private recorderStopped: Promise<void> = Promise.resolve();
  private probe: FrameProbe | null = null;
  private assembler = new SampleAssembler();
  private anchor: ClockAnchor | null = null;
  private sdkFrameTs: number[] = [];
  private firstSdkAtPerf: number | null = null;
  private recorderStartEpochMs: number | null = null;
  private recorderStartPerf: number | null = null;
  private recorderStopPerf: number | null = null;
  private video: VideoInfo | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  // Chained so writes land in order.
  private sampleWrites: Promise<void> = Promise.resolve();
  private videoWrites: Promise<void> = Promise.resolve();
  private writeError: string | null = null;

  constructor(
    private readonly host: CaptureHostBridge,
    private readonly options: SessionCaptureOptions = {},
  ) {}

  get sessionId(): string | null {
    return this.id;
  }

  /** The current moment on the session clock (tMs), or null unless the video is recording. */
  videoTimeNowMs(): number | null {
    if (this.state !== 'active' || this.recorderStartPerf === null) return null;
    // The anchor pins video time 0 to the wall clock; before it exists, time since MediaRecorder.start() is within a frame or two.
    if (this.anchor) return epochUsNow() / 1000 - this.anchor.videoStartEpochMs;
    return performance.now() - this.recorderStartPerf;
  }

  begin(): void {
    if (this.state !== 'idle') throw new Error('SessionCapture: already capturing');
    this.reset();
    this.state = 'active';
    this.mic = this.options.audio
      ? navigator.mediaDevices.getUserMedia({ audio: true, video: false }).catch((err: unknown) => {
          console.warn('[capture] microphone unavailable; recording video only', err);
          return null;
        })
      : Promise.resolve(null);
    this.beginPromise = this.host.begin().then(
      ({ id, dir }) => {
        this.id = id;
        console.info(`[capture] session ${id} -> ${dir}`);
        return id;
      },
      (err: unknown) => {
        console.error('[capture] could not create the session folder', err);
        return null;
      },
    );
    this.flushTimer = setInterval(() => this.flush(false), FLUSH_MS);
  }

  attachStream(stream: MediaStream | null): void {
    if (!stream || this.state !== 'active' || this.recorder || this.probe) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    // Probe first, so it is already reading when the recorder starts.
    this.probe = FrameProbe.supported() ? new FrameProbe(track) : null;
    void this.startRecorder(track);
  }

  addSample(s: PresageSample): void {
    if (this.state === 'idle') return;
    this.assembler.addSample(s);
  }

  addValidation(v: ValidationEvent): void {
    if (this.state === 'idle') return;
    // Validation arrives once per processed frame: the SDK frame timestamps used for clock matching.
    if (this.firstSdkAtPerf === null) this.firstSdkAtPerf = performance.now();
    if (!this.anchor && this.sdkFrameTs.length < MATCH_MIN_SDK_FRAMES + 30) this.sdkFrameTs.push(v.tUs);
    this.assembler.addValidation(v);
  }

  /** Stops MediaRecorder and waits for its last chunk to be written. */
  async stopRecording(): Promise<void> {
    if (this.state !== 'active') return;
    this.state = 'stopping';
    const rec = this.recorder;
    if (rec && rec.state !== 'inactive') {
      rec.stop();
      await this.recorderStopped;
    }
    this.recorderStopPerf ??= performance.now();
    await this.videoWrites;
    for (const t of this.micStream?.getTracks() ?? []) t.stop();
  }

  /** Final flush, then remux + session.json + upload (in main). Resolves to the saved session, or null if nothing was recorded. */
  async finish(): Promise<CaptureResult | null> {
    if (this.state === 'idle') return null;
    await this.stopRecording();
    if (this.flushTimer !== null) clearInterval(this.flushTimer);
    this.flushTimer = null;
    const id = await this.beginPromise;
    this.flush(true);
    await this.sampleWrites;
    this.probe?.stop();
    this.state = 'idle';
    if (!id) return null;
    if (!this.recorder) {
      // The camera never came up: nothing worth keeping.
      await this.host.discard(id).catch(() => undefined);
      return null;
    }
    if (this.writeError) console.error(`[capture] some writes failed: ${this.writeError}`);
    const wallClockDurationMs =
      this.recorderStartPerf !== null && this.recorderStopPerf !== null ? Math.round(this.recorderStopPerf - this.recorderStartPerf) : 0;
    const session = await this.host.finish(id, { wallClockDurationMs });
    this.logClockCheck(session);
    return { session };
  }

  /** Synchronous teardown (page unload). Whatever was already flushed stays on disk. */
  dispose(): void {
    if (this.flushTimer !== null) clearInterval(this.flushTimer);
    this.flushTimer = null;
    try {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    } catch {
      /* already stopped */
    }
    for (const t of this.micStream?.getTracks() ?? []) t.stop();
    this.probe?.stop();
    this.state = 'idle';
  }

  // --- internals ---------------------------------------------------------------

  private reset(): void {
    this.id = null;
    this.micStream = null;
    this.recorder = null;
    this.probe = null;
    this.assembler = new SampleAssembler();
    this.anchor = null;
    this.sdkFrameTs = [];
    this.firstSdkAtPerf = null;
    this.recorderStartEpochMs = null;
    this.recorderStartPerf = null;
    this.recorderStopPerf = null;
    this.video = null;
    this.sampleWrites = Promise.resolve();
    this.videoWrites = Promise.resolve();
    this.writeError = null;
  }

  private async startRecorder(videoTrack: MediaStreamTrack): Promise<void> {
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), MIC_WAIT_MS));
    const mic = await Promise.race([this.mic, timeout]);
    const id = await this.beginPromise;
    if (this.state !== 'active' || !id) {
      for (const t of mic?.getTracks() ?? []) t.stop();
      return;
    }
    this.micStream = mic;
    const audioTracks = mic?.getAudioTracks() ?? [];
    const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
    const rec = new MediaRecorder(new MediaStream([videoTrack, ...audioTracks]), {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: 2_500_000,
      audioBitsPerSecond: 96_000,
    });
    this.recorderStopped = new Promise((resolve) => rec.addEventListener('stop', () => resolve(), { once: true }));
    rec.addEventListener('dataavailable', (e) => {
      if (e.data.size === 0) return;
      const blob = e.data;
      this.videoWrites = this.videoWrites
        .then(async () => this.host.appendVideo(id, new Uint8Array(await blob.arrayBuffer())))
        .catch((err: unknown) => this.noteWriteError('video', err));
    });
    rec.addEventListener('error', (e) => console.error('[capture] MediaRecorder error', e));
    rec.addEventListener('stop', () => {
      this.recorderStopPerf ??= performance.now();
    });

    const settings = videoTrack.getSettings();
    this.video = {
      mimeType: rec.mimeType || mimeType,
      width: settings.width ?? null,
      height: settings.height ?? null,
      frameRate: settings.frameRate ?? null,
      hasAudio: audioTracks.length > 0,
      remuxed: false,
    };
    this.recorder = rec;
    this.recorderStartPerf = performance.now();
    this.recorderStartEpochMs = Date.now();
    this.probe?.markRecorderStart(this.recorderStartPerf);
    rec.start(VIDEO_TIMESLICE_MS);
    console.info(`[capture] recording ${this.video.mimeType}${this.video.hasAudio ? ' with mic' : ' (no audio)'}`);
    void this.host
      .update(id, { video: this.video, startedAtIso: new Date(this.recorderStartEpochMs).toISOString() })
      .catch((err: unknown) => this.noteWriteError('session update', err));
  }

  /** Sets the clock anchor once it can be determined; until then samples stay buffered. */
  private tryAnchor(final: boolean): void {
    if (this.anchor || this.recorderStartEpochMs === null) return;
    const probe = this.probe;
    let match = null;
    if (probe && probe.epochOffsetUs !== null && probe.videoStartRawUs !== null && this.sdkFrameTs.length >= MATCH_MIN_SDK_FRAMES) {
      match = matchSdkOffset(this.sdkFrameTs, probe.raws, { expectedUs: probe.epochOffsetUs });
    }
    const waitedTooLong = this.firstSdkAtPerf !== null && performance.now() - this.firstSdkAtPerf > MATCH_GIVE_UP_MS;
    if (!match && !final && !waitedTooLong && probe) return;
    if (!match && this.assembler.firstTimestampUs === null && !final) return;

    const base = computeAnchor({
      recorderStartEpochMs: this.recorderStartEpochMs,
      sdkOffsetUs: match?.sdkOffsetUs ?? null,
      videoStartRawUs: probe?.videoStartRawUs ?? null,
      probeEpochOffsetUs: probe?.epochOffsetUs ?? null,
    });
    const first = this.assembler.firstTimestampUs;
    this.anchor = { ...base, firstSampleTMs: first === null ? null : toVideoMs(first, base.sdkToVideoOffsetUs), containerStartMs: null };
    if (match) console.info(`[capture] clock matched: ${match.hits}/${this.sdkFrameTs.length} SDK frames (runner-up ${match.runnerUpHits})`);
    else console.warn('[capture] could not match the SDK clock to camera frames; using the wall-clock anchor (~30-100 ms less precise)');
    probe?.stop();
    if (this.id) {
      void this.host
        .update(this.id, { clock: this.anchor, startedAtIso: new Date(this.anchor.videoStartEpochMs).toISOString() })
        .catch((err: unknown) => this.noteWriteError('session update', err));
    }
  }

  private flush(final: boolean): void {
    this.tryAnchor(final);
    const anchor = this.anchor;
    const id = this.id;
    if (!anchor || !id) return;
    const records = this.assembler.drain((tUs) => toVideoMs(tUs, anchor.sdkToVideoOffsetUs), final);
    if (records.length === 0) return;
    this.sampleWrites = this.sampleWrites
      .then(() => this.host.appendSamples(id, records))
      .catch((err: unknown) => this.noteWriteError('samples', err));
  }

  private noteWriteError(what: string, err: unknown): void {
    const msg = `${what}: ${err instanceof Error ? err.message : String(err)}`;
    if (!this.writeError) console.error(`[capture] write failed (${msg})`);
    this.writeError = msg;
  }

  private logClockCheck(session: Session): void {
    const c = session.clock;
    if (!c) {
      console.warn(`[capture] session ${session.id}: no Presage data arrived, so there is no clock anchor`);
      return;
    }
    const first = c.firstSampleTMs;
    const line =
      `[capture] clock check (${c.method}): first Presage sample at tMs=${first ?? 'n/a'} ` +
      `(offset from video start), SDK bias ${c.sdkBiasMs ?? 'n/a'} ms, container start ${c.containerStartMs ?? 'n/a'} ms`;
    if (first !== null && (first < -50 || first > FIRST_SAMPLE_WARN_MS)) console.warn(`${line} -- OUT OF RANGE, check the recording`);
    else console.info(line);
  }
}
