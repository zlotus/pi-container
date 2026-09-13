ALTER TABLE workspaces
  ADD COLUMN desired_state text;

UPDATE workspaces
SET desired_state = CASE
  WHEN state IN ('STARTING', 'RUNNING') THEN 'RUNNING'
  WHEN state = 'DELETING' THEN 'DELETED'
  ELSE 'STOPPED'
END;

ALTER TABLE workspaces
  ALTER COLUMN desired_state SET DEFAULT 'STOPPED',
  ALTER COLUMN desired_state SET NOT NULL,
  ADD CONSTRAINT workspaces_desired_state_check CHECK (
    desired_state IN ('RUNNING', 'STOPPED', 'DELETED')
  );
