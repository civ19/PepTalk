// Presage body signals in Tiger Data: one presage_vital_samples row per
// second of a session's recording. Schema:
// backend/db/migrations/001_presage_vital_samples.sql (npm run db:migrate).

import type { VitalPoint, VitalsResult } from "../presage/vitalsService";
import type { SqlClient } from "./database";

type Readings = Pick<VitalsResult, "heartRate" | "breathingRate">;

export interface VitalSampleRow {
  elapsedSeconds: number;
  /** The session's start plus elapsedSeconds, as an ISO timestamp. */
  recordedAt: string;
  heartRateBpm: number | null;
  heartConfidence: number | null;
  heartStable: boolean | null;
  breathingRateBpm: number | null;
  breathingConfidence: number | null;
  breathingStable: boolean | null;
}

/** The table's checks reject rates of 0 or below, so those count as no reading. */
const usable = (point: VitalPoint | undefined): VitalPoint | undefined =>
  point && point.value > 0 ? point : undefined;

/**
 * One row per second with a usable heart or breathing reading, in time order.
 * A second that has only one of the two stores NULLs for the other.
 */
export function toSampleRows(
  startedAt: Date,
  readings: Readings,
): VitalSampleRow[] {
  const heart = new Map(readings.heartRate.map((p) => [p.timeSeconds, p]));
  const breathing = new Map(
    readings.breathingRate.map((p) => [p.timeSeconds, p]),
  );
  const seconds = [...new Set([...heart.keys(), ...breathing.keys()])].sort(
    (a, b) => a - b,
  );
  const rows: VitalSampleRow[] = [];
  for (const second of seconds) {
    const h = usable(heart.get(second));
    const b = usable(breathing.get(second));
    if (!h && !b) continue;
    rows.push({
      elapsedSeconds: second,
      recordedAt: new Date(startedAt.getTime() + second * 1000).toISOString(),
      heartRateBpm: h?.value ?? null,
      heartConfidence: h?.confidence ?? null,
      heartStable: h?.stable ?? null,
      breathingRateBpm: b?.value ?? null,
      breathingConfidence: b?.confidence ?? null,
      breathingStable: b?.stable ?? null,
    });
  }
  return rows;
}

export class VitalSamplesRepository {
  constructor(private readonly db: SqlClient) {}

  /** Fails if Tiger Data can't be reached or the table is missing. */
  async check(): Promise<void> {
    await this.db.query("SELECT 1 FROM presage_vital_samples LIMIT 0", []);
  }

  /**
   * Makes the session's rows match `readings`, so analyzing a recording again
   * replaces its samples. One statement: it upserts every second and deletes
   * the seconds the new readings no longer have. The two touch different
   * keys, so it doesn't matter which Postgres runs first. Returns the rows written.
   */
  async replaceSession(
    sessionId: string,
    startedAt: Date,
    readings: Readings,
  ): Promise<number> {
    const rows = toSampleRows(startedAt, readings);
    const recordedAt = rows.map((row) => row.recordedAt);
    await this.db.query(
      `WITH stale AS (
         DELETE FROM presage_vital_samples
         WHERE session_id = $1::uuid AND NOT (recorded_at = ANY ($2::timestamptz[]))
       )
       INSERT INTO presage_vital_samples
         (session_id, recorded_at, elapsed_seconds, heart_rate_bpm, heart_confidence, heart_stable,
          breathing_rate_bpm, breathing_confidence, breathing_stable)
       SELECT $1::uuid, t.*
       FROM unnest($2::timestamptz[], $3::int[], $4::float8[], $5::float8[], $6::bool[],
                   $7::float8[], $8::float8[], $9::bool[]) AS t
       ON CONFLICT (session_id, recorded_at) DO UPDATE SET
         elapsed_seconds = EXCLUDED.elapsed_seconds,
         heart_rate_bpm = EXCLUDED.heart_rate_bpm,
         heart_confidence = EXCLUDED.heart_confidence,
         heart_stable = EXCLUDED.heart_stable,
         breathing_rate_bpm = EXCLUDED.breathing_rate_bpm,
         breathing_confidence = EXCLUDED.breathing_confidence,
         breathing_stable = EXCLUDED.breathing_stable`,
      [
        sessionId,
        recordedAt,
        rows.map((row) => row.elapsedSeconds),
        rows.map((row) => row.heartRateBpm),
        rows.map((row) => row.heartConfidence),
        rows.map((row) => row.heartStable),
        rows.map((row) => row.breathingRateBpm),
        rows.map((row) => row.breathingConfidence),
        rows.map((row) => row.breathingStable),
      ],
    );
    return rows.length;
  }
}

/** What the vitals route needs from the repository; tests pass a fake. */
export type VitalSamplesStore = Pick<VitalSamplesRepository, "replaceSession">;
