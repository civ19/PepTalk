-- Practice-session storage (see src/shared/session-types.ts for the data contract).
--
-- One clock everywhere: t_ms = milliseconds since the first frame of the
-- session's video, and t = sessions.started_at + t_ms (timestamptz, µs). Video
-- files stay on the recording machine; sessions.recording_uri points at them.
--
-- Apply with `npm run db:migrate`.

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS sessions (
  id              uuid PRIMARY KEY,
  started_at      timestamptz NOT NULL,           -- wall clock of video time 0
  duration_ms     integer,
  recording_uri   text,                            -- file:// URI on the recording machine; the video is not stored here
  app_version     text NOT NULL,
  schema_version  smallint NOT NULL,
  status          text NOT NULL CHECK (status IN ('recording', 'complete', 'interrupted')),
  clock           jsonb NOT NULL,                  -- ClockAnchor: how SDK timestamps were mapped to t_ms
  video           jsonb NOT NULL,                  -- VideoInfo: mime type, size, audio, remuxed
  uploaded        boolean NOT NULL DEFAULT false,  -- set true in the same transaction as the sample rows
  uploaded_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Pulse / HRV / breathing readings. Usually only one group is non-null per row.
-- Confidence is the SDK's 0-100 scale.
CREATE TABLE IF NOT EXISTS vitals_samples (
  session_id            uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  t                     timestamptz NOT NULL,
  t_ms                  double precision NOT NULL,
  pulse_bpm             real,
  pulse_confidence      real,
  pulse_stable          boolean,
  hrv_rmssd_ms          real,
  hrv_sdnn_ms           real,
  hrv_mean_nn_ms        real,
  hrv_baevsky           real,
  hrv_confidence        real,
  hrv_stable            boolean,
  breathing_rate        real,
  breathing_confidence  real,
  breathing_stable      boolean,
  PRIMARY KEY (session_id, t)
);
SELECT create_hypertable('vitals_samples', 't', if_not_exists => TRUE);

-- One row per camera frame with face data (~30/s). Expression columns are
-- probabilities (0-1, summing to ~1). eye_landmarks is EyeLandmarks JSON in
-- frame pixel coordinates; head_* and gaze_* are unitless estimates.
CREATE TABLE IF NOT EXISTS face_samples (
  session_id      uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  t               timestamptz NOT NULL,
  t_ms            double precision NOT NULL,
  blinking        boolean,
  talking         boolean,
  expr_angry      real,
  expr_contempt   real,
  expr_disgust    real,
  expr_fear       real,
  expr_happy      real,
  expr_neutral    real,
  expr_sad        real,
  expr_surprise   real,
  eye_landmarks   jsonb,
  head_yaw        real,
  head_pitch      real,
  gaze_h          real,
  gaze_v          real,
  gaze_direction  text,
  PRIMARY KEY (session_id, t)
);
SELECT create_hypertable('face_samples', 't', if_not_exists => TRUE);

-- Positioning / signal-quality changes. Each status holds until the next row.
CREATE TABLE IF NOT EXISTS validation_events (
  session_id  uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  t           timestamptz NOT NULL,
  t_ms        double precision NOT NULL,
  code        integer NOT NULL,
  name        text NOT NULL,
  hint        text NOT NULL,
  PRIMARY KEY (session_id, t, code)
);
