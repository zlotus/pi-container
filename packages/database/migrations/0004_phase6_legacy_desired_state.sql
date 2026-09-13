ALTER TABLE workspaces
  DROP CONSTRAINT workspaces_desired_state_check;

ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_desired_state_check CHECK (
    desired_state IN ('RUNNING', 'STOPPED', 'DELETED', 'UNKNOWN')
  );

UPDATE workspaces
SET desired_state = 'UNKNOWN'
WHERE state IN ('ERROR', 'WORKER_OFFLINE')
  AND desired_state = 'STOPPED';
