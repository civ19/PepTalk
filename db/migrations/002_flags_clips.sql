-- Flags (moments worth reviewing) and the clips cut around them. See
-- src/shared/flags.ts for the data contract.
--
-- The app's sessions/<id>/flags.json and clips.json are the source of truth;
-- these tables mirror them (src/main/flags/db.ts). Each sync is one
-- transaction that upserts every row and deletes the session's rows that no
-- longer exist locally. Clip videos and thumbnails stay on the recording
-- machine: only their file:// URIs are stored, never video data.
--
-- Same clock as 001: t = sessions.started_at + t_ms.
--
-- Apply with `npm run db:migrate`.

CREATE TABLE IF NOT EXISTS clips (
  id          text PRIMARY KEY,                  -- deterministic from (session, start_ms, end_ms); also the file name
  session_id  uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  flag_ids    text[] NOT NULL,                   -- every flag the clip covers
  start_ms    double precision NOT NULL,         -- padded range on the session clock
  end_ms      double precision NOT NULL,
  t_start     timestamptz NOT NULL,
  t_end       timestamptz NOT NULL,
  clip_uri    text NOT NULL,                     -- file:// URI of the .mp4 on the recording machine
  thumb_uri   text NOT NULL,                     -- file:// URI of the .jpg thumbnail
  status      text NOT NULL CHECK (status IN ('pending', 'ready', 'error')),
  error       text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clips_session_id_idx ON clips (session_id);

CREATE TABLE IF NOT EXISTS flags (
  id           text PRIMARY KEY,                 -- deterministic from (session, source, type, start_ms, end_ms)
  session_id   uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  type         text NOT NULL,                    -- FlagType; not constrained here, so a new detector needs no migration
  start_ms     double precision NOT NULL,        -- the flagged moment itself, unpadded
  end_ms       double precision NOT NULL,
  t_start      timestamptz NOT NULL,
  t_end        timestamptz NOT NULL,
  severity     text NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  source       text NOT NULL CHECK (source IN ('detector', 'manual')),
  evidence     jsonb NOT NULL,                   -- e.g. {"peakBpm": 104, "baselineBpm": 78}
  clip_id      text REFERENCES clips (id) ON DELETE SET NULL,
  explanation  jsonb,                            -- {"summary", "suggestion"} from the explainer; null = pending
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flags_session_id_idx ON flags (session_id);
