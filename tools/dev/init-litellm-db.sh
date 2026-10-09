#!/usr/bin/env bash
# DEV ONLY: creates the `litellm` role and database for the model gateway (specs.md Phase 16.3)
# in the development PostgreSQL container started by deploy/compose.dev.yml. The gateway never
# uses the platform database `agent_runtime`; this role owns only its own database.
#
# Idempotent. When the gateway env file has no DATABASE_URL yet, a random password is generated,
# the role is created with it and DATABASE_URL is appended to the env file (kept 0600). An
# existing DATABASE_URL is left unchanged. No secret is printed.
#
# Usage: tools/dev/init-litellm-db.sh ~/.config/agent-runtime/litellm.env
set -euo pipefail

env_file="${1:?usage: tools/dev/init-litellm-db.sh <gateway env file>}"
container="${POSTGRES_CONTAINER:-agent-runtime-platform-postgres-1}"
admin_user="${POSTGRES_USER:-agent_runtime}"

if [[ ! -f "$env_file" || -L "$env_file" ]]; then
  echo "env file must be an existing regular file: $env_file" >&2
  exit 1
fi
if [[ "$(stat -c '%a' "$env_file")" != "600" ]]; then
  echo "env file must have mode 0600: $env_file" >&2
  exit 1
fi

psql() {
  docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U "$admin_user" -d postgres -tA "$@"
}

if grep -q '^DATABASE_URL=' "$env_file"; then
  echo "DATABASE_URL already present; leaving the role password unchanged"
  password=""
else
  password="$(openssl rand -hex 24)"
fi

if [[ "$(psql -c "select 1 from pg_roles where rolname = 'litellm'")" != "1" ]]; then
  if [[ -z "$password" ]]; then
    echo "role litellm is missing but DATABASE_URL exists; remove DATABASE_URL and rerun" >&2
    exit 1
  fi
  # The password is hex, so it cannot break out of the quoted literal.
  psql -c "create role litellm login password '${password}'" >/dev/null
  echo "created role litellm"
elif [[ -n "$password" ]]; then
  psql -c "alter role litellm password '${password}'" >/dev/null
  echo "reset password of existing role litellm"
fi

if [[ "$(psql -c "select 1 from pg_database where datname = 'litellm'")" != "1" ]]; then
  psql -c "create database litellm owner litellm" >/dev/null
  echo "created database litellm"
fi
psql -c "revoke all on database litellm from public" >/dev/null

if [[ -n "$password" ]]; then
  # `postgres` is the service name on the compose network that the gateway joins.
  printf 'DATABASE_URL=postgresql://litellm:%s@postgres:5432/litellm\n' "$password" >>"$env_file"
  echo "appended DATABASE_URL to $env_file"
fi
