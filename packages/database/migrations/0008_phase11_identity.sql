ALTER TABLE users
  ALTER COLUMN email DROP NOT NULL,
  ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users
  DROP CONSTRAINT users_email_key,
  DROP CONSTRAINT users_email_normalized,
  DROP CONSTRAINT users_email_length;

ALTER TABLE users
  ADD CONSTRAINT users_email_normalized CHECK (
    email IS NULL OR email = lower(email)
  ),
  ADD CONSTRAINT users_email_length CHECK (
    email IS NULL OR char_length(email) BETWEEN 3 AND 320
  ),
  ADD CONSTRAINT users_login_method_present CHECK (
    password_hash IS NULL OR email IS NOT NULL OR username IS NOT NULL
  );

CREATE UNIQUE INDEX users_local_email_unique
  ON users(email)
  WHERE password_hash IS NOT NULL AND email IS NOT NULL;

ALTER TABLE user_identities
  ADD COLUMN username_snapshot text,
  ADD CONSTRAINT user_identities_username_snapshot_length CHECK (
    username_snapshot IS NULL OR char_length(username_snapshot) <= 256
  );
