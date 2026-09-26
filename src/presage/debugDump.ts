// Debug-only raw payload dump (PRESAGE_DEBUG_DUMP_SECONDS). Writes NDJSON to
// debug/payload-dump.ndjson through the main process:
//
//   {type:'meta'}        session start: wall clock, performance.timeOrigin
//   {type:'status'}      tracker status changes
//   {type:'stream'}      when the SDK's camera stream became available (+ track settings)
//   {type:'frame'}       every camera frame seen by a probe on a clone of the
//                        camera track: raw VideoFrame.timestamp and the wall
//                        clock at read time, to pin down the SDK's clock
//   {type:'validation'}  validationStatus events as received
//   {type:'metrics'}     every `metrics` event: event tUs, receive time, and
//                        the fully decoded protobuf (int64 -> number, enums -> names)
//
// Everything is batched and flushed every 500 ms. Nothing here runs unless the
// dump is switched on.

import { decodeMetrics, presage } from '@smartspectra/node-sdk/messages';
import type { PresageHostBridge } from './bridge';
import type { TrackerStatus, ValidationEvent } from './types';

const FLUSH_MS = 500;

// MediaStreamTrackProcessor is Chromium-only and not in the TS DOM lib.
interface FrameLike {
  timestamp: number;
  codedWidth: number;
  codedHeight: number;
  close(): void;
}
type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<FrameLike> };

export class PayloadDump {
  private lines: string[] = [];
  private truncateNext = true;
  private flushTimer: number | null = null;
  private stopTimer: number | null = null;
  private probeTrack: MediaStreamTrack | null = null;
  private active = false;
  private file: string | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly host: PresageHostBridge,
    private readonly seconds: number,
    private readonly onDone: (file: string | null) => void,
  ) {}

  start(): void {
    this.active = true;
    this.truncateNext = true;
    this.push({
      type: 'meta',
      startedEpochMs: Date.now(),
      perfNowMs: performance.now(),
      perfTimeOriginMs: performance.timeOrigin,
      dumpSeconds: this.seconds,
    });
    this.flushTimer = window.setInterval(() => void this.flush(), FLUSH_MS);
    this.stopTimer = window.setTimeout(() => void this.finish(), this.seconds * 1000);
  }

  get running(): boolean {
    return this.active;
  }

  onRawMetrics(buf: Uint8Array, tUs: number): void {
    if (!this.active) return;
    const recvEpochMs = Date.now();
    const recvPerfMs = performance.now();
    let payload: unknown;
    try {
      payload = presage.smartspectra.Metrics.toObject(decodeMetrics(buf), { longs: Number, enums: String });
    } catch (err) {
      payload = { decodeError: err instanceof Error ? err.message : String(err), bytes: buf.byteLength };
    }
    this.push({ type: 'metrics', tUs, recvEpochMs, recvPerfMs, bytes: buf.byteLength, payload });
  }

  onValidation(e: ValidationEvent): void {
    if (this.active) this.push({ type: 'validation', tUs: e.tUs, recvEpochMs: Date.now(), recvPerfMs: performance.now(), code: e.code, name: e.name, hint: e.hint });
  }

  onStatus(status: TrackerStatus): void {
    if (this.active) this.push({ type: 'status', status, recvEpochMs: Date.now(), recvPerfMs: performance.now() });
  }

  onStream(stream: MediaStream | null): void {
    if (!this.active) return;
    const track = stream?.getVideoTracks()[0];
    this.push({ type: 'stream', available: stream !== null, recvEpochMs: Date.now(), recvPerfMs: performance.now(), settings: track?.getSettings() ?? null });
    if (track) this.probeFrames(track);
  }

  /** Stops the dump early (session stopped before the time was up). */
  async finish(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    if (this.flushTimer !== null) clearInterval(this.flushTimer);
    if (this.stopTimer !== null) clearTimeout(this.stopTimer);
    this.probeTrack?.stop();
    this.probeTrack = null;
    await this.flush();
    console.info(`[presage debug] payload dump written to ${this.file ?? '(nothing written)'}`);
    this.onDone(this.file);
  }

  private probeFrames(track: MediaStreamTrack): void {
    const Processor = (globalThis as { MediaStreamTrackProcessor?: TrackProcessorCtor }).MediaStreamTrackProcessor;
    if (!Processor) {
      this.push({ type: 'probe-error', message: 'MediaStreamTrackProcessor unavailable' });
      return;
    }
    const clone = track.clone();
    this.probeTrack = clone;
    const reader = new Processor({ track: clone }).readable.getReader();
    void (async () => {
      let n = 0;
      while (this.active) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done || !value) break;
        this.push({ type: 'frame', n: n++, rawTsUs: value.timestamp, readEpochMs: Date.now(), readPerfMs: performance.now(), w: value.codedWidth, h: value.codedHeight });
        value.close();
      }
    })();
  }

  private push(obj: object): void {
    this.lines.push(JSON.stringify(obj));
  }

  // Appends are chained so batches land in order.
  private flush(): Promise<void> {
    const lines = this.lines;
    this.lines = [];
    if (lines.length === 0 && !this.truncateNext) return this.writing;
    const truncate = this.truncateNext;
    this.truncateNext = false;
    this.writing = this.writing.then(async () => {
      try {
        this.file = await this.host.debugAppend(lines, truncate);
      } catch (err) {
        console.error('[presage debug] could not write payload dump', err);
      }
    });
    return this.writing;
  }
}
