CREATE TABLE IF NOT EXISTS app_users (
  auth_subject text PRIMARY KEY,
  display_name text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  picture_url text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS practice_projects (
  user_sub text NOT NULL REFERENCES app_users(auth_subject) ON DELETE CASCADE,
  id text NOT NULL,
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_sub, id)
);

CREATE TABLE IF NOT EXISTS preparations (
  user_sub text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_sub, id),
  FOREIGN KEY (user_sub, project_id) REFERENCES practice_projects(user_sub, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS preparations_project_idx ON preparations(user_sub, project_id, created_at);
