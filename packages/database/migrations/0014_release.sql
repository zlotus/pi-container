-- Phase 19: production deployment and the v1.0 release (specs.md Phase 19.8).

-- The software version each Worker reported in its last hello (protocol v7). Null for a
-- Worker that has not connected since this migration.
ALTER TABLE workers
  ADD COLUMN worker_version text NULL
    CONSTRAINT workers_worker_version_format
      CHECK (worker_version ~ '^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$');

-- Upgrades and rollbacks of a Worker leave a trace in the Audit.
CREATE FUNCTION workers_after_version_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO platform_audit_events (event_type, worker_id, details)
  VALUES ('worker.version_reported', NEW.id, jsonb_build_object(
    'fromVersion', OLD.worker_version,
    'toVersion', NEW.worker_version
  ));
  RETURN NEW;
END;
$$;

CREATE TRIGGER workers_after_version_change
  AFTER UPDATE OF worker_version ON workers
  FOR EACH ROW
  WHEN (OLD.worker_version IS DISTINCT FROM NEW.worker_version)
  EXECUTE FUNCTION workers_after_version_change();
