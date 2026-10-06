-- Phase 15: per-Workspace disk limits and login throttling.

-- The data-project limit is chosen per Workspace (Control Plane default, admin adjustable);
-- usage is whatever the Worker last sampled. Existing Workspaces get the 20 GiB default;
-- the Control Plane always passes its configured value for new ones.
ALTER TABLE workspaces
  ADD COLUMN disk_limit_bytes bigint NOT NULL DEFAULT 21474836480,
  ADD COLUMN disk_used_bytes bigint,
  ADD COLUMN disk_used_inodes bigint,
  ADD COLUMN pi_used_bytes bigint,
  ADD COLUMN pi_limit_bytes bigint,
  ADD COLUMN disk_usage_at timestamptz,
  ADD CONSTRAINT workspaces_disk_limit_positive CHECK (disk_limit_bytes > 0);

-- What each Worker last reported about its quota filesystem. A Worker that has not
-- said otherwise is not enforcing quotas.
ALTER TABLE workers
  ADD COLUMN storage_enforced boolean NOT NULL DEFAULT false,
  ADD COLUMN storage_fs_type text,
  ADD COLUMN storage_total_bytes bigint,
  ADD COLUMN storage_free_bytes bigint,
  ADD COLUMN storage_checked_at timestamptz;

-- Failure counters for login throttling. Keys are HMACs, so neither a typed login
-- (which may be a mistyped password) nor its derivatives are stored in clear text.
CREATE TABLE auth_throttle (
  id uuid PRIMARY KEY,
  scope text NOT NULL,
  key_hash text NOT NULL,
  ip_address inet,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  failures integer NOT NULL,
  locked_until timestamptz,
  CONSTRAINT auth_throttle_scope CHECK (scope IN ('login_ip', 'ip', 'login', 'sso_start')),
  CONSTRAINT auth_throttle_failures CHECK (failures >= 0),
  CONSTRAINT auth_throttle_key_hash CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT auth_throttle_key UNIQUE (scope, key_hash)
);

CREATE INDEX auth_throttle_locked_until ON auth_throttle (locked_until)
  WHERE locked_until IS NOT NULL;
