// Recording lifecycle. The browser streams MediaRecorder chunks here while
// recording; finishing remuxes the file so players can seek it, hashes it and
// records it in Tiger Data. Files stay in the media folder and Tiger Data only
// gets their keys.
//
//   sessions/<id>/recording.raw.<ext>   chunks, appended as they arrive
//   sessions/<id>/recording.<ext>       remuxed at finish; the raw file is then deleted

import { randomUUID } from "node:crypto";
import type {
  MediaObject,
  TigerDataRepository,
} from "../persistence/tigerDataRepository";
import { probeDurationMs, remux } from "./ffmpeg";
import type { LocalMediaStore } from "./mediaStore";
import {
  isUuid,
  rawRecordingKey,
  recordingKey,
  sessionPrefix,
  type RecordingExtension,
} from "./objectKeys";

/** A failure the API reports with this HTTP status. */
export class RecordingError extends Error {
  constructor(
    readonly status: 404 | 409 | 415,
    message: string,
  ) {
    super(message);
  }
}

/** ffmpeg, replaceable in tests. */
export interface MediaTools {
  remux(input: string, output: string): Promise<void>;
  probeDurationMs(file: string): Promise<number | null>;
}

const EXTENSIONS: readonly RecordingExtension[] = ["webm", "mp4"];

/** The container for a MediaRecorder MIME type such as 'video/webm;codecs=vp9,opus'. */
export function recordingExtension(
  mimeType: string,
): RecordingExtension | null {
  const type = mimeType.split(";")[0].trim().toLowerCase();
  if (type === "video/webm") return "webm";
  if (type === "video/mp4") return "mp4";
  return null;
}

const sessionNotFound = (): RecordingError =>
  new RecordingError(404, "Session not found.");

export class RecordingService {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly repository: TigerDataRepository,
    private readonly store: LocalMediaStore,
    private readonly deviceId: string,
    private readonly tools: MediaTools = { remux, probeDurationMs },
  ) {}

  async createSession(): Promise<string> {
    const id = randomUUID();
    await this.repository.createSession(id);
    return id;
  }

  /** Appends one chunk. A session's chunks are written in the order they arrive. */
  append(
    sessionId: string,
    mimeType: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const ext = recordingExtension(mimeType);
    if (!ext) {
      return Promise.reject(
        new RecordingError(415, "Recordings must be video/webm or video/mp4."),
      );
    }
    return this.withLock(sessionId, async () => {
      const key = rawRecordingKey(sessionId, ext);
      // Only the first chunk checks the session, so stray ids can't create folders.
      const started = (await this.store.size(key)) !== null;
      if (!started && !(await this.repository.sessionExists(sessionId))) {
        throw sessionNotFound();
      }
      await this.store.append(key, bytes);
    });
  }

  /** Remuxes, hashes and records the session's recording. Safe to call again. */
  finish(sessionId: string): Promise<MediaObject> {
    return this.withLock(sessionId, async () => {
      for (const ext of EXTENSIONS) {
        const raw = rawRecordingKey(sessionId, ext);
        const key = recordingKey(sessionId, ext);
        if ((await this.store.size(raw)) !== null) {
          await this.finalize(sessionId, raw, key);
        }
        const byteSize = await this.store.size(key);
        if (byteSize === null) continue;
        const media = await this.repository.completeSession({
          id: randomUUID(),
          sessionId,
          kind: "recording",
          storage: "local",
          objectKey: key,
          deviceId: this.deviceId,
          mimeType: `video/${ext}`,
          byteSize,
          sha256: await this.store.sha256(key),
          durationMs: await this.tools
            .probeDurationMs(this.store.pathOf(key))
            .catch(() => null),
          status: "ready",
        });
        if (!media) throw sessionNotFound();
        return media;
      }
      throw new RecordingError(409, "No video was uploaded for this session.");
    });
  }

  /** Where the session's recording is, for res.sendFile. */
  async recordingFile(
    sessionId: string,
  ): Promise<{ root: string; key: string }> {
    if (!isUuid(sessionId)) throw sessionNotFound();
    const media = await this.repository.findRecording(sessionId);
    if (!media) throw new RecordingError(404, "This session has no recording.");
    if (media.storage !== "local" || media.deviceId !== this.deviceId) {
      throw new RecordingError(
        409,
        "This recording is stored on another device.",
      );
    }
    if (media.status !== "ready") {
      throw new RecordingError(
        404,
        "The recording file is missing from this computer's media folder.",
      );
    }
    return { root: this.store.root, key: media.objectKey };
  }

  /** Deletes the session's files and its Tiger Data rows. */
  delete(sessionId: string): Promise<void> {
    return this.withLock(sessionId, async () => {
      await this.store.deletePrefix(sessionPrefix(sessionId));
      await this.repository.deleteSession(sessionId);
    });
  }

  /**
   * Checks this device's media rows against the files on disk. A row whose
   * file is gone or has changed size becomes 'missing', and 'ready' again if
   * the file comes back.
   */
  async reconcile(): Promise<{ missing: number; restored: number }> {
    const missing: string[] = [];
    const restored: string[] = [];
    for (const media of await this.repository.listLocalMedia(this.deviceId)) {
      const size = await this.store.size(media.objectKey).catch(() => null);
      const present =
        size !== null && (media.byteSize === null || size === media.byteSize);
      if (media.status === "ready" && !present) missing.push(media.id);
      if (media.status === "missing" && present) restored.push(media.id);
    }
    await this.repository.setMediaStatus(missing, "missing");
    await this.repository.setMediaStatus(restored, "ready");
    return { missing: missing.length, restored: restored.length };
  }

  /** The raw file becomes the recording: remuxed if ffmpeg can, as recorded if not. */
  private async finalize(
    sessionId: string,
    raw: string,
    key: string,
  ): Promise<void> {
    try {
      await this.tools.remux(this.store.pathOf(raw), this.store.pathOf(key));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[storage] ${sessionId}: remux failed, keeping the recording as recorded (it may not be seekable): ${reason}`,
      );
      await this.store.move(raw, key);
      return;
    }
    await this.store.delete(raw);
  }

  /** Runs `job` after every earlier job for this session has settled. */
  private withLock<T>(sessionId: string, job: () => Promise<T>): Promise<T> {
    if (!isUuid(sessionId)) return Promise.reject(sessionNotFound());
    const next = (this.locks.get(sessionId) ?? Promise.resolve()).then(
      job,
      job,
    );
    const settled = next.catch(() => undefined);
    this.locks.set(sessionId, settled);
    void settled.then(() => {
      if (this.locks.get(sessionId) === settled) this.locks.delete(sessionId);
    });
    return next;
  }
}
