-- Keep every Gemini coaching response for each attempt. Reanalysis inserts a new row.
CREATE TABLE IF NOT EXISTS coaching_feedback (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL,
  project_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  report jsonb NOT NULL,
  raw_response text NOT NULL
);

CREATE INDEX IF NOT EXISTS coaching_feedback_session_created_idx
  ON coaching_feedback (session_id, created_at);

ALTER TABLE presage_vital_samples
  ADD COLUMN IF NOT EXISTS camera_facing boolean;
