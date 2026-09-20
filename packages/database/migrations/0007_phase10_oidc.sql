CREATE TABLE user_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  provider_subject text NOT NULL,
  email_snapshot text,
  display_name_snapshot text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  CONSTRAINT user_identities_provider_length CHECK (
    char_length(provider_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT user_identities_subject_length CHECK (
    char_length(provider_subject) BETWEEN 1 AND 1024
  ),
  CONSTRAINT user_identities_email_snapshot_length CHECK (
    email_snapshot IS NULL OR char_length(email_snapshot) <= 320
  ),
  CONSTRAINT user_identities_display_name_snapshot_length CHECK (
    display_name_snapshot IS NULL OR char_length(display_name_snapshot) <= 256
  ),
  CONSTRAINT user_identities_provider_subject_unique UNIQUE (
    provider_id,
    provider_subject
  )
);

CREATE INDEX user_identities_user_id_idx ON user_identities(user_id);
