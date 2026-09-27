-- Presage body signals: one row per second of a practice session's recording,
-- written after each /api/vitals analysis (vitalSamplesRepository.ts).
-- recorded_at is the session's start time plus elapsed_seconds.
--
-- The table first came from the live Presage prototype, so this mirrors the
-- shape it already has in Tiger Data; there it is a no-op. The rate checks
-- mean a rate Presage reports as 0 must be stored as NULL.
--
-- Apply with `npm run db:migrate`.

CREATE TABLE IF NOT EXISTS presage_vital_samples (
  session_id              uuid NOT NULL,
  recorded_at             timestamptz NOT NULL,
  heart_rate_bpm          double precision CHECK (heart_rate_bpm IS NULL OR heart_rate_bpm > 0),
  heart_confidence        double precision,
  heart_stable            boolean,
  resting_heart_rate_bpm  double precision,
  breathing_rate_bpm      double precision CHECK (breathing_rate_bpm IS NULL OR breathing_rate_bpm > 0),
  breathing_confidence    double precision,
  breathing_stable        boolean,
  expression_scores       jsonb,
  expression_stable       boolean,
  elapsed_seconds         integer,
  PRIMARY KEY (session_id, recorded_at)
);

-- A hypertable on Tiger Data / TimescaleDB. Databases without the extension
-- (PGlite in the tests) keep a plain table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('presage_vital_samples', 'recorded_at', if_not_exists => TRUE);
  END IF;
END $$;
