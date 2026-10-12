-- Phase 18: lifecycle operations (specs.md Phase 18).

-- 18.6 Worker revocation. `enabled = false` is the revocation of a Worker; every path that
-- changes it (CLI, Admin, direct SQL) gets the same consequences in the same transaction:
-- the Worker is DISABLED, its Workspaces are WORKER_OFFLINE and their model keys are revoked.
-- `agent_runtime.audit_source` (set with `set local`) names the caller in the Audit details.

-- Bring rows changed by hand before this migration in line with the invariant below.
UPDATE workspaces
SET state = 'WORKER_OFFLINE', updated_at = now()
WHERE worker_id IN (SELECT id FROM workers WHERE NOT enabled)
  AND state IN ('STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'ERROR');
UPDATE workers SET status = 'DISABLED', updated_at = now()
WHERE NOT enabled AND status <> 'DISABLED';
UPDATE workers SET status = 'OFFLINE', updated_at = now()
WHERE enabled AND status = 'DISABLED';

ALTER TABLE workers
  ADD CONSTRAINT workers_enabled_status CHECK (enabled = (status <> 'DISABLED'));

ALTER TABLE model_keys DROP CONSTRAINT model_keys_revoke_reason;
ALTER TABLE model_keys ADD CONSTRAINT model_keys_revoke_reason CHECK (revoke_reason IS NULL OR revoke_reason IN (
  'workspace_deleted', 'user_disabled', 'lost', 'admin', 'issue_failed', 'worker_disabled'
));

CREATE FUNCTION audit_source() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('agent_runtime.audit_source', true), ''), 'database')
$$;

CREATE FUNCTION workers_enabled_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.enabled AND NOT NEW.enabled THEN
    NEW.status := 'DISABLED';
  ELSIF NOT OLD.enabled AND NEW.enabled AND NEW.status = 'DISABLED' THEN
    NEW.status := 'OFFLINE';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workers_enabled_status
  BEFORE UPDATE OF enabled ON workers
  FOR EACH ROW EXECUTE FUNCTION workers_enabled_status();

CREATE FUNCTION workers_after_enabled_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  assigned integer;
  revoked integer := 0;
  workspace record;
BEGIN
  IF OLD.enabled AND NOT NEW.enabled THEN
    UPDATE workspaces
    SET state = 'WORKER_OFFLINE', updated_at = now()
    WHERE worker_id = NEW.id
      AND state IN ('STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'ERROR');
    SELECT count(*) INTO assigned FROM workspaces WHERE worker_id = NEW.id;
    FOR workspace IN SELECT id FROM workspaces WHERE worker_id = NEW.id LOOP
      revoked := revoked + model_keys_request_revoke(workspace.id, NULL, 'worker_disabled');
    END LOOP;
    INSERT INTO platform_audit_events (event_type, worker_id, details)
    VALUES ('worker.disabled', NEW.id, jsonb_build_object(
      'source', audit_source(), 'fromStatus', OLD.status,
      'workspaces', assigned, 'modelKeys', revoked
    ));
  ELSIF NOT OLD.enabled AND NEW.enabled THEN
    INSERT INTO platform_audit_events (event_type, worker_id, details)
    VALUES ('worker.enabled', NEW.id, jsonb_build_object('source', audit_source()));
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workers_after_enabled_change
  AFTER UPDATE OF enabled ON workers
  FOR EACH ROW EXECUTE FUNCTION workers_after_enabled_change();

-- The status change that comes with `enabled` is audited above, with its consequences.
CREATE OR REPLACE FUNCTION record_worker_audit_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO platform_audit_events (event_type, worker_id, details)
    VALUES ('worker.registered', NEW.id, '{}'::jsonb);
    RETURN NEW;
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status AND OLD.enabled IS NOT DISTINCT FROM NEW.enabled THEN
    INSERT INTO platform_audit_events (event_type, worker_id, details)
    VALUES (
      CASE NEW.status
        WHEN 'ONLINE' THEN 'worker.online'
        WHEN 'OFFLINE' THEN 'worker.offline'
        WHEN 'DISABLED' THEN 'worker.disabled'
        ELSE 'worker.registered'
      END,
      NEW.id,
      jsonb_build_object(
        'fromStatus', OLD.status,
        'toStatus', NEW.status
      )
    );
  END IF;

  IF OLD.architecture IS DISTINCT FROM NEW.architecture
    OR OLD.runtime_image IS DISTINCT FROM NEW.runtime_image
    OR OLD.runtime_version IS DISTINCT FROM NEW.runtime_version
    OR OLD.capabilities IS DISTINCT FROM NEW.capabilities
    OR OLD.max_workspaces IS DISTINCT FROM NEW.max_workspaces THEN
    INSERT INTO platform_audit_events (event_type, worker_id, details)
    VALUES (
      'worker.runtime_reported',
      NEW.id,
      jsonb_build_object(
        'architecture', NEW.architecture,
        'runtimeImage', NEW.runtime_image,
        'runtimeVersion', NEW.runtime_version,
        'capabilities', NEW.capabilities,
        'maxWorkspaces', NEW.max_workspaces
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

-- Deleting a Worker row is audited whichever path does it; Workspaces still assigned to
-- it block the delete (workspaces_worker_id_fkey ON DELETE RESTRICT).
CREATE FUNCTION workers_after_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO platform_audit_events (event_type, worker_id, details)
  VALUES ('worker.deleted', OLD.id, jsonb_build_object(
    'source', audit_source(), 'status', OLD.status, 'hostname', OLD.hostname
  ));
  RETURN OLD;
END;
$$;

CREATE TRIGGER workers_after_delete
  AFTER DELETE ON workers
  FOR EACH ROW EXECUTE FUNCTION workers_after_delete();
