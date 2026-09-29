-- Admin scheduling pause (cordon). A paused Worker keeps its identity, control
-- channel, Gateway route and sticky Workspaces; it is only excluded from new
-- first placements. This is distinct from `enabled = false`, which revokes the
-- Worker entirely.
ALTER TABLE workers
  ADD COLUMN schedulable boolean NOT NULL DEFAULT true;
