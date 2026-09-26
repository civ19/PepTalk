// Data contract for flags (moments worth reviewing) and the clips cut around
// them. Detectors and manual flagging produce Flags, the clip pipeline
// (src/main/clips) turns them into Clips, and the review page shows both. No
// imports, so it can be copied or imported from anywhere (like session-types.ts).
//
// Files per session, next to session.json:
//   flags.json               FlagsFile
//   clips.json               ClipsFile
//   clips/<clipId>.mp4       H.264 + AAC, moov atom first (plays before it's fully read)
//   clips/<clipId>.jpg       thumbnail: the frame at the flagged moment's midpoint
//
// flags.json and clips.json are the source of truth. TigerData (tables flags
// and clips) mirrors them; the videos themselves never leave the machine.
//
// Times use the session clock (see session-types.ts): ms since the first frame
// of recording.mp4.

export const FLAGS_SCHEMA_VERSION = 1;

export const FLAG_TYPES = ['high_hr', 'low_eye_contact', 'fast_pace', 'slow_pace', 'tense_expression', 'manual'] as const;
export type FlagType = (typeof FLAG_TYPES)[number];

export const FLAG_SEVERITIES = ['low', 'medium', 'high'] as const;
export type FlagSeverity = (typeof FLAG_SEVERITIES)[number];

/** The numbers behind a flag, e.g. { peakBpm: 104, baselineBpm: 78 }. Shown on the review page and given to the explainer. */
export type FlagEvidence = Record<string, number | string | boolean>;

export interface FlagExplanation {
  summary: string;
  suggestion: string;
}

export interface Flag {
  /** Deterministic from (sessionId, source, type, startMs, endMs), so re-running detectors keeps ids stable. */
  id: string;
  sessionId: string;
  type: FlagType;
  /** The moment itself, unpadded (whole ms). */
  startMs: number;
  endMs: number;
  severity: FlagSeverity;
  source: 'detector' | 'manual';
  evidence: FlagEvidence;
  /** The clip that shows this flag. Set by clip generation. */
  clipId?: string;
  /** Filled in later by the explainer (Gemini). Missing or null means analysis is pending. */
  explanation?: FlagExplanation | null;
}

export type ClipStatus = 'pending' | 'ready' | 'error';

export interface Clip {
  /** Deterministic from (sessionId, startMs, endMs); also the file name. */
  id: string;
  sessionId: string;
  /** Every flag this clip covers. Flags whose padded windows overlap share one clip. */
  flagIds: string[];
  /** Padded and clamped to the video (whole ms). Clip time 0 is session time startMs. */
  startMs: number;
  endMs: number;
  /** Relative to the session folder, e.g. 'clips/<id>.mp4'. */
  path: string;
  thumbPath: string;
  status: ClipStatus;
  error?: string;
}

export interface FlagsFile {
  schemaVersion: typeof FLAGS_SCHEMA_VERSION;
  flags: Flag[];
}

export interface ClipsFile {
  schemaVersion: typeof FLAGS_SCHEMA_VERSION;
  clips: Clip[];
}

/** A flag added by a person (window.flags.add, the "Flag this moment" button, `npm run flag`). */
export interface NewFlag {
  type: FlagType;
  startMs: number;
  endMs: number;
  /** Default 'medium'. */
  severity?: FlagSeverity;
  evidence?: FlagEvidence;
}
