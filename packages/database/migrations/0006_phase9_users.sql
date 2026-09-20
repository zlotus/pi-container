ALTER TABLE users
  ADD COLUMN status text NOT NULL DEFAULT 'active',
  ADD COLUMN last_login_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT users_status_valid CHECK (status IN ('active', 'disabled'));

CREATE INDEX users_status_idx ON users(status);

CREATE INDEX user_sessions_user_active_idx
  ON user_sessions(user_id, expires_at)
  WHERE revoked_at IS NULL;
