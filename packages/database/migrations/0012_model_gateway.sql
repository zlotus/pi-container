-- Phase 16: model gateway virtual keys (specs.md Phase 16.6, 16.8).

-- One row per virtual key the platform asked the gateway for. The secret is never stored
-- here; `key_alias` is how the gateway locates the key. A key is revoked only once the
-- gateway confirmed it (`revoked`); until then it stays `revoking` and is retried.
CREATE TABLE model_keys (
  id uuid PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  key_alias text NOT NULL UNIQUE,
  status text NOT NULL,
  issue_reason text NOT NULL,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoke_requested_at timestamptz,
  revoked_at timestamptz,
  revoke_attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error_code text,
  CONSTRAINT model_keys_status CHECK (status IN ('issuing', 'active', 'revoking', 'revoked')),
  CONSTRAINT model_keys_issue_reason CHECK (issue_reason IN ('start', 'reissue', 'rotation')),
  CONSTRAINT model_keys_revoke_reason CHECK (revoke_reason IS NULL OR revoke_reason IN (
    'workspace_deleted', 'user_disabled', 'lost', 'admin', 'issue_failed'
  )),
  CONSTRAINT model_keys_alias CHECK (key_alias ~ '^arw-[0-9a-f-]{36}-[1-9][0-9]{0,9}$'),
  -- A usable key always belongs to an existing Workspace.
  CONSTRAINT model_keys_live_has_workspace CHECK (
    workspace_id IS NOT NULL OR status IN ('revoking', 'revoked')
  ),
  CONSTRAINT model_keys_revoke_state CHECK (
    (status IN ('issuing', 'active')) = (revoke_requested_at IS NULL)
  ),
  CONSTRAINT model_keys_error_code CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  )
);

CREATE UNIQUE INDEX model_keys_one_live_per_workspace ON model_keys (workspace_id)
  WHERE status IN ('issuing', 'active');
CREATE INDEX model_keys_pending ON model_keys (next_attempt_at) WHERE status = 'revoking';
CREATE INDEX model_keys_user ON model_keys (user_id) WHERE status IN ('issuing', 'active');

-- Starts revoking the live keys of one Workspace or one user, with an Audit event each.
CREATE FUNCTION model_keys_request_revoke(
  target_workspace uuid,
  target_user uuid,
  reason text
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  revoked integer;
BEGIN
  WITH changed AS (
    UPDATE model_keys
    SET status = 'revoking',
        revoke_reason = reason,
        revoke_requested_at = now(),
        next_attempt_at = now()
    WHERE status IN ('issuing', 'active')
      AND (target_workspace IS NULL OR workspace_id = target_workspace)
      AND (target_user IS NULL OR user_id = target_user)
    RETURNING id, workspace_id, user_id, key_alias
  ), audited AS (
    INSERT INTO platform_audit_events (event_type, owner_user_id, workspace_id, details)
    SELECT 'model.key_revoke_requested', user_id, workspace_id,
           jsonb_build_object('keyAlias', key_alias, 'reason', reason, 'source', 'database')
    FROM changed
    RETURNING 1
  )
  SELECT count(*) INTO revoked FROM changed;
  RETURN revoked;
END;
$$;

-- Every path that deletes a Workspace row revokes its keys first (before ON DELETE SET NULL).
CREATE FUNCTION model_keys_on_workspace_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM model_keys_request_revoke(OLD.id, NULL, 'workspace_deleted');
  RETURN OLD;
END;
$$;

CREATE TRIGGER model_keys_workspace_delete
  BEFORE DELETE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION model_keys_on_workspace_delete();

-- Every path that disables a user revokes all of the user's keys in the same transaction.
CREATE FUNCTION model_keys_on_user_disable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'disabled' AND OLD.status IS DISTINCT FROM 'disabled' THEN
    PERFORM model_keys_request_revoke(NULL, NEW.id, 'user_disabled');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER model_keys_user_disable
  AFTER UPDATE OF status ON users
  FOR EACH ROW EXECUTE FUNCTION model_keys_on_user_disable();

-- Per-user budget override in USD; NULL uses the Control Plane default.
ALTER TABLE users
  ADD COLUMN model_budget_usd numeric(12, 2),
  ADD CONSTRAINT users_model_budget_range CHECK (
    model_budget_usd IS NULL OR (model_budget_usd >= 0 AND model_budget_usd <= 1000000)
  );

-- What each Worker last reported about its model relay.
ALTER TABLE workers
  ADD COLUMN model_relay_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN model_relay_port integer,
  ADD COLUMN model_relay_listening boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT workers_model_relay_port CHECK (
    model_relay_port IS NULL OR (model_relay_port BETWEEN 1 AND 65535)
  );
