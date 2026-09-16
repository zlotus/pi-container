CREATE TABLE platform_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type text NOT NULL,
  actor_user_id uuid,
  owner_user_id uuid,
  workspace_id uuid,
  worker_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_audit_events_type_length CHECK (
    char_length(event_type) BETWEEN 3 AND 80
  ),
  CONSTRAINT platform_audit_events_worker_id_length CHECK (
    worker_id IS NULL OR char_length(worker_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT platform_audit_events_details_object CHECK (
    jsonb_typeof(details) = 'object'
  )
);

CREATE INDEX platform_audit_events_owner_cursor_idx
  ON platform_audit_events(owner_user_id, id DESC);
CREATE INDEX platform_audit_events_workspace_cursor_idx
  ON platform_audit_events(workspace_id, id DESC)
  WHERE workspace_id IS NOT NULL;
CREATE INDEX platform_audit_events_created_at_idx
  ON platform_audit_events(created_at DESC);

CREATE FUNCTION record_workspace_audit_event()
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

CREATE TRIGGER workspace_platform_audit
AFTER INSERT OR UPDATE OR DELETE ON workspaces
FOR EACH ROW EXECUTE FUNCTION record_workspace_audit_event();

CREATE FUNCTION record_worker_audit_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO platform_audit_events (event_type, worker_id, details)
    VALUES ('worker.registered', NEW.id, '{}'::jsonb);
    RETURN NEW;
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
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

CREATE TRIGGER worker_platform_audit
AFTER INSERT OR UPDATE ON workers
FOR EACH ROW EXECUTE FUNCTION record_worker_audit_event();
