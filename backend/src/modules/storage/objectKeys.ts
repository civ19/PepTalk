// Object keys name media files relative to the media folder, e.g.
// 'sessions/<uuid>/recording.webm'. They use forward slashes and lowercase
// ASCII, with no drive letters or dot segments, so a key stored in Tiger Data
// resolves the same way on Windows, macOS and Linux.

import { join } from "node:path";

export type RecordingExtension = "webm" | "mp4";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;

export const isUuid = (value: string): boolean => UUID.test(value);

/** Every object for one session lives under this prefix. */
export function sessionPrefix(sessionId: string): string {
  if (!isUuid(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
  return `sessions/${sessionId}`;
}

/** MediaRecorder chunks are appended here while recording. */
export const rawRecordingKey = (
  sessionId: string,
  ext: RecordingExtension,
): string => `${sessionPrefix(sessionId)}/recording.raw.${ext}`;

/** The finished, seekable recording. */
export const recordingKey = (
  sessionId: string,
  ext: RecordingExtension,
): string => `${sessionPrefix(sessionId)}/recording.${ext}`;

export const isObjectKey = (key: string): boolean =>
  key.split("/").every((segment) => SEGMENT.test(segment));

/** Absolute path of `key` under `root`, with this OS's separators. */
export function objectPath(root: string, key: string): string {
  if (!isObjectKey(key)) throw new Error(`invalid object key: ${key}`);
  return join(root, ...key.split("/"));
}
