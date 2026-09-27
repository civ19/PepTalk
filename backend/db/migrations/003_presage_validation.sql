-- Keep Presage's per-second camera quality feedback alongside the vitals.
ALTER TABLE presage_vital_samples
  ADD COLUMN IF NOT EXISTS validation_code integer,
  ADD COLUMN IF NOT EXISTS validation_hint text;
