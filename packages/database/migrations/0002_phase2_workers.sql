CREATE TABLE workers (
  id text PRIMARY KEY,
  credential_hash text NOT NULL UNIQUE,
  hostname text,
  architecture text CHECK (
    architecture IS NULL OR architecture IN ('amd64', 'arm64')
  ),
  status text NOT NULL DEFAULT 'REGISTERED' CHECK (
    status IN ('REGISTERED', 'ONLINE', 'OFFLINE', 'DISABLED')
  ),
  enabled boolean NOT NULL DEFAULT true,
  runtime_image text,
  runtime_version text,
  gateway_base_url text,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  max_workspaces integer CHECK (max_workspaces IS NULL OR max_workspaces > 0),
  allocated_workspaces integer NOT NULL DEFAULT 0 CHECK (allocated_workspaces >= 0),
  cpu_capacity jsonb NOT NULL DEFAULT '{}'::jsonb,
  memory_bytes bigint CHECK (memory_bytes IS NULL OR memory_bytes > 0),
  last_heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workers_id_length CHECK (char_length(id) BETWEEN 1 AND 64),
  CONSTRAINT workers_id_format CHECK (
    id ~ '^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$'
  ),
  CONSTRAINT workers_credential_hash_length CHECK (
    char_length(credential_hash) = 43
  ),
  CONSTRAINT workers_capabilities_object CHECK (
    jsonb_typeof(capabilities) = 'object'
  ),
  CONSTRAINT workers_cpu_capacity_object CHECK (
    jsonb_typeof(cpu_capacity) = 'object'
  ),
  CONSTRAINT workers_memory_safe_integer CHECK (
    memory_bytes IS NULL OR memory_bytes <= 9007199254740991
  ),
  CONSTRAINT workers_allocation_within_capacity CHECK (
    max_workspaces IS NULL OR allocated_workspaces <= max_workspaces
  )
);

ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_worker_id_fkey
  FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE RESTRICT;

CREATE INDEX workers_last_heartbeat_idx
  ON workers(last_heartbeat_at)
  WHERE enabled;
