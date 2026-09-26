// IPC contract between the renderer-side SessionCapture and the main-process
// session store (src/capture/main). Shared by main, preload and renderer.

import type { ClockAnchor, SampleRecord, Session, UploadState, VideoInfo } from '../shared/session-types';

export const CAPTURE_IPC = {
  begin: 'capture:begin',
  update: 'capture:update',
  appendVideo: 'capture:append-video',
  appendSamples: 'capture:append-samples',
  finish: 'capture:finish',
  discard: 'capture:discard',
  retryUpload: 'capture:retry-upload',
  listSessions: 'capture:list-sessions',
  /** main -> renderer: an upload finished or failed. */
  uploadStatus: 'capture:upload-status',
} as const;

export interface SessionPatch {
  clock?: ClockAnchor;
  video?: VideoInfo;
  /** Wall-clock start (refined when the clock is anchored). */
  startedAtIso?: string;
}

export interface FinishRequest {
  /** Wall-clock recording length, used if ffmpeg can't read the duration. */
  wallClockDurationMs: number;
}

export interface UploadStatusEvent {
  sessionId: string;
  upload: UploadState;
}

/** What src/capture/preload.ts exposes on `window.captureHost`. */
export interface CaptureHostBridge {
  /** Creates sessions/<id>/ with a 'recording' session.json. */
  begin(): Promise<{ id: string; dir: string }>;
  update(id: string, patch: SessionPatch): Promise<void>;
  /** Appends a MediaRecorder chunk to the raw recording file. */
  appendVideo(id: string, chunk: Uint8Array): Promise<void>;
  /** Appends rows to samples.ndjson. */
  appendSamples(id: string, records: SampleRecord[]): Promise<void>;
  /** Remuxes the video, writes the final session.json, and starts the upload in the background. */
  finish(id: string, req: FinishRequest): Promise<Session>;
  /** Deletes a session that never started recording (e.g. the camera failed). */
  discard(id: string): Promise<void>;
  /** Uploads (again) a session whose upload failed or never ran. */
  retryUpload(id: string): Promise<UploadState>;
  /** Every session.json in the sessions folder, newest first. */
  listSessions(): Promise<Session[]>;
  onUploadStatus(cb: (e: UploadStatusEvent) => void): void;
}

declare global {
  interface Window {
    captureHost?: CaptureHostBridge;
  }
}
