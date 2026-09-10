CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  username text UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_normalized CHECK (email = lower(email)),
  CONSTRAINT users_email_length CHECK (char_length(email) BETWEEN 3 AND 320),
  CONSTRAINT users_username_normalized CHECK (
    username IS NULL OR username = lower(username)
  ),
  CONSTRAINT users_username_length CHECK (
    username IS NULL OR char_length(username) BETWEEN 3 AND 64
  ),
  CONSTRAINT users_username_format CHECK (
    username IS NULL OR username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'
  )
);

CREATE TABLE user_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_sessions_token_hash_length CHECK (char_length(token_hash) = 43)
);

CREATE INDEX user_sessions_user_id_idx ON user_sessions(user_id);
CREATE INDEX user_sessions_active_expiry_idx
  ON user_sessions(expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name text NOT NULL,
  worker_id text,
  state text NOT NULL DEFAULT 'CREATED' CHECK (
    state IN (
      'CREATED',
      'SCHEDULING',
      'STARTING',
      'RUNNING',
      'STOPPING',
      'STOPPED',
      'DELETING',
      'ERROR',
      'WORKER_OFFLINE'
    )
  ),
  runtime_image text NOT NULL,
  required_architecture text CHECK (
    required_architecture IS NULL OR required_architecture IN ('amd64', 'arm64')
  ),
  required_capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspaces_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT workspaces_user_name_unique UNIQUE (user_id, name)
);

CREATE INDEX workspaces_user_id_idx ON workspaces(user_id);
CREATE INDEX workspaces_worker_id_idx
  ON workspaces(worker_id)
  WHERE worker_id IS NOT NULL;
