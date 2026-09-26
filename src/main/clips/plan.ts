// Which clips to cut for a session's flags (pure; no I/O).
//
//   1. Pad each flag 3 s before and 2 s after, clamped to [0, video duration].
//   2. Flags whose padded windows overlap (or touch) share one clip, and so do
//      chains of them, unless the merged clip would pass 20 s. Then a new clip
//      starts, so a long chain becomes several clips of at most 20 s.
//   3. A single flag longer than 20 s padded keeps its first 20 s (the onset).
//   4. Clips shorter than 4 s (only possible at the ends of the video) are
//      widened to 4 s, or to the whole video if it's shorter than that.
//
// A clip's id depends only on (sessionId, startMs, endMs), so planning the
// same flags again gives the same ids and existing files can be reused.

import type { Flag } from '../../shared/flags';
import { clipIdFor } from '../flags/ids';

export const CLIP_PAD_BEFORE_MS = 3_000;
export const CLIP_PAD_AFTER_MS = 2_000;
export const CLIP_MIN_MS = 4_000;
export const CLIP_MAX_MS = 20_000;

export interface PlannedClip {
  id: string;
  startMs: number;
  endMs: number;
  /** In the order the flags start. */
  flagIds: string[];
  /** Session time of the thumbnail frame: the midpoint of the flagged moment(s), kept inside the clip. */
  thumbMs: number;
}

type FlagRange = Pick<Flag, 'id' | 'startMs' | 'endMs'>;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** Flags that start at or after the end of the video get no clip. */
export function planClips(sessionId: string, flags: readonly FlagRange[], durationMs: number): PlannedClip[] {
  const duration = Math.max(0, Math.round(durationMs));
  const windows = flags
    .filter((f) => f.startMs < duration)
    .map((f) => ({
      flag: f,
      start: clamp(f.startMs - CLIP_PAD_BEFORE_MS, 0, duration),
      end: clamp(f.endMs + CLIP_PAD_AFTER_MS, 0, duration),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end || a.flag.id.localeCompare(b.flag.id));

  const groups: { start: number; end: number; flags: FlagRange[] }[] = [];
  for (const w of windows) {
    const g = groups.at(-1);
    if (g && w.start <= g.end && Math.max(g.end, w.end) - g.start <= CLIP_MAX_MS) {
      g.end = Math.max(g.end, w.end);
      g.flags.push(w.flag);
    } else {
      groups.push({ start: w.start, end: w.end, flags: [w.flag] });
    }
  }

  return groups.map((g) => {
    let start = g.start;
    let end = Math.min(g.end, start + CLIP_MAX_MS);
    if (end - start < CLIP_MIN_MS) {
      end = Math.min(duration, start + CLIP_MIN_MS);
      start = Math.max(0, end - CLIP_MIN_MS);
    }
    start = Math.round(start);
    end = Math.round(end);
    const momentStart = Math.min(...g.flags.map((f) => f.startMs));
    const momentEnd = Math.max(...g.flags.map((f) => f.endMs));
    // Stay a little before the end so there's a frame to grab.
    const thumbMs = Math.round(clamp((momentStart + momentEnd) / 2, start, Math.max(start, end - 100)));
    return { id: clipIdFor(sessionId, start, end), startMs: start, endMs: end, flagIds: g.flags.map((f) => f.id), thumbMs };
  });
}
