import { describe, expect, it } from "vitest";
import {
  VitalSamplesRepository,
  toSampleRows,
} from "../src/modules/persistence/vitalSamplesRepository";
import { migratedDb, pgliteClient } from "./helpers";

const SESSION = "6f1c2d3e-5a4b-4c3d-8e2f-1a2b3c4d5e6f";
const OTHER_SESSION = "0b6f7d2e-1c3a-4e5f-9a8b-7c6d5e4f3a2b";
const STARTED_AT = new Date("2026-09-26T20:00:00.000Z");

const point = (
  timeSeconds: number,
  value: number,
  confidence = 90,
  stable = true,
) => ({ timeSeconds, value, confidence, stable });

describe("toSampleRows", () => {
  it("merges heart and breathing readings into one row per second", () => {
    expect(
      toSampleRows(STARTED_AT, {
        heartRate: [point(13, 77, 93, false), point(12, 76, 92)],
        breathingRate: [point(13, 14, 70)],
      }),
    ).toEqual([
      {
        elapsedSeconds: 12,
        recordedAt: "2026-09-26T20:00:12.000Z",
        heartRateBpm: 76,
        heartConfidence: 92,
        heartStable: true,
        breathingRateBpm: null,
        breathingConfidence: null,
        breathingStable: null,
      },
      {
        elapsedSeconds: 13,
        recordedAt: "2026-09-26T20:00:13.000Z",
        heartRateBpm: 77,
        heartConfidence: 93,
        heartStable: false,
        breathingRateBpm: 14,
        breathingConfidence: 70,
        breathingStable: true,
      },
    ]);
  });

  it("treats rates of 0 or below as missing, since the table rejects them", () => {
    const rows = toSampleRows(STARTED_AT, {
      heartRate: [point(5, 0), point(6, 72)],
      breathingRate: [point(6, -1)],
    });
    expect(rows).toEqual([
      expect.objectContaining({
        elapsedSeconds: 6,
        heartRateBpm: 72,
        breathingRateBpm: null,
        breathingConfidence: null,
        breathingStable: null,
      }),
    ]);
  });
});

describe("VitalSamplesRepository", () => {
  it("saves one row per second, timed from the session's start", async () => {
    const db = await migratedDb();
    const repository = new VitalSamplesRepository(db);
    await expect(repository.check()).resolves.toBeUndefined();

    const written = await repository.replaceSession(SESSION, STARTED_AT, {
      heartRate: [point(12, 76, 92), point(13, 0)],
      breathingRate: [point(13, 14, 70, false)],
    });

    expect(written).toBe(2);
    const { rows } = await db.query(
      `SELECT session_id, recorded_at, elapsed_seconds, heart_rate_bpm, heart_confidence, heart_stable,
              breathing_rate_bpm, breathing_confidence, breathing_stable
       FROM presage_vital_samples ORDER BY recorded_at`,
      [],
    );
    expect(rows).toEqual([
      {
        session_id: SESSION,
        recorded_at: new Date("2026-09-26T20:00:12.000Z"),
        elapsed_seconds: 12,
        heart_rate_bpm: 76,
        heart_confidence: 92,
        heart_stable: true,
        breathing_rate_bpm: null,
        breathing_confidence: null,
        breathing_stable: null,
      },
      {
        session_id: SESSION,
        recorded_at: new Date("2026-09-26T20:00:13.000Z"),
        elapsed_seconds: 13,
        heart_rate_bpm: null,
        heart_confidence: null,
        heart_stable: null,
        breathing_rate_bpm: 14,
        breathing_confidence: 70,
        breathing_stable: false,
      },
    ]);
  });

  it("replaces a session's rows when it is analyzed again, leaving other sessions alone", async () => {
    const db = await migratedDb();
    const repository = new VitalSamplesRepository(db);
    await repository.replaceSession(OTHER_SESSION, STARTED_AT, {
      heartRate: [point(1, 60)],
      breathingRate: [],
    });
    await repository.replaceSession(SESSION, STARTED_AT, {
      heartRate: [point(0, 70), point(1, 71), point(2, 72)],
      breathingRate: [point(2, 15)],
    });

    const written = await repository.replaceSession(SESSION, STARTED_AT, {
      heartRate: [point(1, 99), point(3, 73)],
      breathingRate: [point(3, 16)],
    });

    expect(written).toBe(2);
    const { rows } = await db.query(
      "SELECT session_id, elapsed_seconds, heart_rate_bpm, breathing_rate_bpm FROM presage_vital_samples ORDER BY session_id, recorded_at",
      [],
    );
    expect(rows).toEqual([
      {
        session_id: OTHER_SESSION,
        elapsed_seconds: 1,
        heart_rate_bpm: 60,
        breathing_rate_bpm: null,
      },
      {
        session_id: SESSION,
        elapsed_seconds: 1,
        heart_rate_bpm: 99,
        breathing_rate_bpm: null,
      },
      {
        session_id: SESSION,
        elapsed_seconds: 3,
        heart_rate_bpm: 73,
        breathing_rate_bpm: 16,
      },
    ]);
  });

  it("clears a session whose new analysis has no usable readings", async () => {
    const db = await migratedDb();
    const repository = new VitalSamplesRepository(db);
    await repository.replaceSession(SESSION, STARTED_AT, {
      heartRate: [point(4, 70)],
      breathingRate: [],
    });

    expect(
      await repository.replaceSession(SESSION, STARTED_AT, {
        heartRate: [],
        breathingRate: [point(4, 0)],
      }),
    ).toBe(0);
    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM presage_vital_samples",
      [],
    );
    expect(rows[0].n).toBe(0);
  });

  it("reports a database without the table", async () => {
    const repository = new VitalSamplesRepository(pgliteClient());
    await expect(repository.check()).rejects.toThrow(/presage_vital_samples/);
  });
});
