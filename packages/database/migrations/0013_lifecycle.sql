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

-- 18.4 Runtime images. Every image a Worker offers, as its hello reported it:
-- [{ image, imageId, runtimeVersion, piWebVersion, piVersion, capabilities }]. The older
-- runtime_image / runtime_version / capabilities columns keep the first entry.
ALTER TABLE workers
  ADD COLUMN runtime_images jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT workers_runtime_images_array CHECK (jsonb_typeof(runtime_images) = 'array');
UPDATE workers
SET runtime_images = jsonb_build_array(jsonb_build_object(
  'image', runtime_image,
  'imageId', NULL,
  'runtimeVersion', runtime_version,
  'piWebVersion', NULL,
  'piVersion', NULL,
  'capabilities', capabilities
))
WHERE runtime_image IS NOT NULL AND runtime_version IS NOT NULL;

-- A Runtime change in progress is its own state (Control Plane only); the previous image
-- is the rollback target. 18.5: Gateway access time and why a Workspace was last stopped.
ALTER TABLE workspaces DROP CONSTRAINT workspaces_state_check;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_state_check CHECK (state IN (
  'CREATED', 'SCHEDULING', 'STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'DELETING',
  'ERROR', 'WORKER_OFFLINE', 'UPGRADING'
));
ALTER TABLE workspaces
  ADD COLUMN previous_runtime_image text,
  ADD COLUMN runtime_changed_at timestamptz,
  ADD COLUMN last_access_at timestamptz,
  ADD COLUMN last_stop_reason text,
  ADD CONSTRAINT workspaces_last_stop_reason CHECK (last_stop_reason IS NULL OR last_stop_reason IN ('idle'));

CREATE OR REPLACE FUNCTION record_workspace_audit_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO platform_audit_events (
      event_type, owner_user_id, workspace_id, worker_id, details
    ) VALUES (
      'workspace.created',
      NEW.user_id,
      NEW.id,
      NEW.worker_id,
      jsonb_build_object(
        'name', NEW.name,
        'runtimeImage', NEW.runtime_image
      )
    );
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.worker_id IS DISTINCT FROM NEW.worker_id AND NEW.worker_id IS NOT NULL THEN
      INSERT INTO platform_audit_events (
        event_type, owner_user_id, workspace_id, worker_id, details
      ) VALUES (
        'workspace.scheduled',
        NEW.user_id,
        NEW.id,
        NEW.worker_id,
        jsonb_build_object('sticky', OLD.worker_id IS NOT NULL)
      );
    END IF;

    IF OLD.state IS DISTINCT FROM NEW.state THEN
      INSERT INTO platform_audit_events (
        event_type, owner_user_id, workspace_id, worker_id, details
      ) VALUES (
        CASE NEW.state
          WHEN 'STARTING' THEN 'workspace.starting'
          WHEN 'RUNNING' THEN 'workspace.running'
          WHEN 'STOPPING' THEN 'workspace.stopping'
          WHEN 'STOPPED' THEN 'workspace.stopped'
          WHEN 'DELETING' THEN 'workspace.deleting'
          WHEN 'ERROR' THEN 'workspace.error'
          WHEN 'WORKER_OFFLINE' THEN 'workspace.worker_offline'
          WHEN 'UPGRADING' THEN 'workspace.runtime_upgrading'
          ELSE 'workspace.state_changed'
        END,
        NEW.user_id,
        NEW.id,
        NEW.worker_id,
        jsonb_build_object(
          'fromState', OLD.state,
          'toState', NEW.state
        )
      );
    END IF;
    RETURN NEW;
  END IF;

  INSERT INTO platform_audit_events (
    event_type, owner_user_id, workspace_id, worker_id, details
  ) VALUES (
    'workspace.deleted',
    OLD.user_id,
    OLD.id,
    OLD.worker_id,
    jsonb_build_object(
      'name', OLD.name,
      'previousState', OLD.state
    )
  );
  RETURN OLD;
END;
$$;

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
      AND state IN ('STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'ERROR', 'UPGRADING');
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
    OR OLD.runtime_images IS DISTINCT FROM NEW.runtime_images
    OR OLD.max_workspaces IS DISTINCT FROM NEW.max_workspaces THEN
    INSERT INTO platform_audit_events (event_type, worker_id, details)
    VALUES (
      'worker.runtime_reported',
      NEW.id,
      jsonb_build_object(
        'architecture', NEW.architecture,
        'runtimeImages', (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'image', entry->>'image',
            'runtimeVersion', entry->>'runtimeVersion',
            'capabilities', entry->'capabilities'
          )), '[]'::jsonb)
          FROM jsonb_array_elements(NEW.runtime_images) AS entry
        ),
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
