#!/usr/bin/env bash
# Creates the platform and gateway roles and databases in the Control Plane host's
# PostgreSQL (deploy/production/compose.yml), with the passwords init-secrets.sh generated
# (specs.md Phase 19.5). Idempotent: existing roles get their password reset to the files'
# values, existing databases are kept. Prints no secret.
#
#   init-postgres.sh
#
# Environment: AGENT_RUNTIME_ETC (/etc/agent-runtime), AGENT_RUNTIME_COMPOSE_PROJECT
# (ar-platform).
set -euo pipefail

etc="${AGENT_RUNTIME_ETC:-/etc/agent-runtime}"
project="${AGENT_RUNTIME_COMPOSE_PROJECT:-ar-platform}"

fail() {
  echo "init-postgres.sh: $*" >&2
  exit 1
}

[[ "$(id -u)" -eq 0 ]] || fail "run as root"

password_of() { # password_of <env file> : the password in its DATABASE_URL
  sed -n 's#^DATABASE_URL=postgres\(ql\)\{0,1\}://[^:]*:\([^@]*\)@.*#\2#p' "$1" | tail -n 1
}

platform_password="$(password_of "${etc}/control-plane.secrets.env")"
litellm_password="$(password_of "${etc}/litellm.env")"
for password in "$platform_password" "$litellm_password"; do
  # Generated hex: safe inside a quoted SQL literal.
  [[ "$password" =~ ^[0-9a-f]{32,}$ ]] || fail "unexpected DATABASE_URL password format; regenerate with init-secrets.sh"
done

psql() {
  docker compose -p "$project" -f "${etc}/compose.yml" exec -T postgres \
    sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -tA' 
}

for _ in $(seq 1 30); do
  if docker compose -p "$project" -f "${etc}/compose.yml" exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER"' >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

for spec in "agent_runtime:${platform_password}" "litellm:${litellm_password}"; do
  role="${spec%%:*}"
  password="${spec#*:}"
  psql <<SQL >/dev/null
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
    CREATE ROLE ${role} LOGIN PASSWORD '${password}';
  ELSE
    ALTER ROLE ${role} LOGIN PASSWORD '${password}';
  END IF;
END
\$\$;
SQL
  if [[ "$(echo "SELECT 1 FROM pg_database WHERE datname = '${role}'" | psql)" != "1" ]]; then
    echo "CREATE DATABASE ${role} OWNER ${role}" | psql >/dev/null
    echo "created database ${role}"
  fi
  echo "REVOKE ALL ON DATABASE ${role} FROM PUBLIC" | psql >/dev/null
  echo "role ${role} ready"
done
