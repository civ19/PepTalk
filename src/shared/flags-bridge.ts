// IPC contract for window.flags (src/preload/flags.ts <-> src/main/flags/ipc.ts)
// and the clip:// URL format served by src/main/clips/protocol.ts. Shared by
// main, preload and renderer.

import type { Clip, Flag, NewFlag } from './flags';

export const FLAGS_IPC = {
  list: 'flags:list',
  add: 'flags:add',
  runDetectors: 'flags:run-detectors',
  generateClips: 'flags:generate-clips',
  /** main -> renderer: a clip was planned, finished or failed. */
  clipUpdate: 'flags:clip-update',
} as const;

/**
 * Privileged scheme that serves media files from the sessions folder:
 * clip://local/<sessionId>/<path inside the session folder>. Only media files
 * (.mp4, .webm, .jpg, .jpeg, .png) are served, and it supports range requests.
 */
export const CLIP_SCHEME = 'clip';
export const CLIP_HOST = 'local';

/** clip:// URL of a file in a session folder; `relPath` uses forward slashes, e.g. 'clips/<id>.mp4'. */
export function sessionFileUrl(sessionId: string, relPath: string): string {
  const segments = [sessionId, ...relPath.split('/').filter((s) => s.length > 0)];
  return `${CLIP_SCHEME}://${CLIP_HOST}/${segments.map(encodeURIComponent).join('/')}`;
}

/** What src/preload/flags.ts exposes on `window.flags`. */
export interface FlagsBridge {
  /** Current flags.json and clips.json (empty arrays if the session has none). */
  list(sessionId: string): Promise<{ flags: Flag[]; clips: Clip[] }>;
  /** Adds a manual flag. Adding the same type and range twice returns the existing flag. */
  add(sessionId: string, flag: NewFlag): Promise<Flag>;
  /** Runs every registered detector and replaces the session's detector flags. Manual flags are kept. */
  runDetectors(sessionId: string): Promise<Flag[]>;
  /**
   * Plans clips for every flag and cuts the missing ones (2 at a time across
   * the app). Resolves when all are ready or failed; each change also arrives
   * through onClipUpdate.
   */
  generateClips(sessionId: string): Promise<void>;
  /** Returns an unsubscribe function. */
  onClipUpdate(cb: (clip: Clip) => void): () => void;
  /** clip:// URL of the clip video. */
  clipUrl(clip: Clip): string;
  /** clip:// URL of the clip thumbnail. */
  thumbUrl(clip: Clip): string;
}

declare global {
  interface Window {
    flags?: FlagsBridge;
  }
}
