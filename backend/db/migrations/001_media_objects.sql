-- Practice sessions and the media files recorded for them.
--
-- Video files stay on the machine that recorded them, in its media folder
-- (backend/src/modules/storage/mediaRoot.ts). Rows store a relative
-- object_key such as 'sessions/<uuid>/recording.webm', never an absolute
-- path, so they mean the same thing on Windows, macOS and Linux.
--
-- The table is practice_sessions, not sessions, so it can share a Tiger Data
-- database with the Electron app's sessions table (noah/eye-tracking).
--
-- Apply with `npm run db:migrate`.

CREATE TABLE IF NOT EXISTS practice_sessions (
  id            uuid PRIMARY KEY,
  status        text NOT NULL CHECK (status IN ('recording', 'complete')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

CREATE TABLE IF NOT EXISTS media_objects (
  id           uuid PRIMARY KEY,
  session_id   uuid NOT NULL REFERENCES practice_sessions (id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('recording', 'clip', 'thumbnail')),
  storage      text NOT NULL DEFAULT 'local' CHECK (storage IN ('local', 's3')),
  object_key   text NOT NULL,                  -- relative to the media folder; never an absolute path
  device_id    uuid,                           -- the media folder holding a 'local' object (its device.json)
  mime_type    text NOT NULL,
  byte_size    bigint,
  sha256       text,
  duration_ms  integer,
  status       text NOT NULL CHECK (status IN ('writing', 'ready', 'missing')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage, object_key)
);
CREATE INDEX IF NOT EXISTS media_objects_session_id_idx ON media_objects (session_id);
