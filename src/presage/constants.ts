// Tunables for the session recorder. Confidence values are the SDK's 0–100 scale.

/**
 * Minimum confidence for a vitals reading to count in the summary. Defaults are
 * the SDK's own "stable" cut-offs from the Presage data-types docs:
 * pulse >= 40 (±3 bpm), breathing >= 45 (±1 br/min), HRV >= 50 (±5 ms).
 */
export const MIN_VITALS_CONFIDENCE = {
  pulse: 40,
  breathing: 45,
  hrv: 50,
} as const;

/** Width of the pulse / expression timeline buckets. */
export const TIMELINE_BUCKET_MS = 10_000;

/** Breathing rate is a 30 s rolling average (Presage model card). */
export const BREATHING_WINDOW_MS = 30_000;

/**
 * Presage: breathing rate "does not work when talking". A breathing reading is
 * used only if talking covered at most this fraction of its 30 s window.
 * Set to 0 for "no talking at all"; the default tolerates a little
 * talking-detector noise.
 */
export const BREATHING_MAX_TALKING_FRACTION = 0.1;

/** Warn if a requested metric group has produced nothing this long after the SDK reports Running. */
export const EMPTY_GROUP_WARNING_MS = 15_000;

/**
 * Extra grace for the cardio group: pulse is a 12 s average and in testing its
 * first reading arrived ~16 s after Running, so 15 s would always false-alarm.
 */
export const CARDIO_EXTRA_GRACE_MS = 10_000;
