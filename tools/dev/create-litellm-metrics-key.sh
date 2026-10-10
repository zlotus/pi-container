#!/usr/bin/env bash
# DEV ONLY: creates the LiteLLM key Prometheus uses to read the gateway's /metrics
# (specs.md Phase 17.11, docs/observability-runbook.md 2.2). The key may call /metrics and
# nothing else (no models, one allowed route). The master key is read from the gateway env
# file and passed to curl on stdin; neither key is printed.
#
# Usage: tools/dev/create-litellm-metrics-key.sh ~/.config/agent-runtime/litellm.env [token file]
set -euo pipefail

env_file="${1:?usage: tools/dev/create-litellm-metrics-key.sh <gateway env file> [token file]}"
token_file="${2:-$HOME/.config/agent-runtime/litellm-metrics.token}"
gateway="${LITELLM_URL:-http://127.0.0.1:4400}"

if [[ ! -f "$env_file" || -L "$env_file" || "$(stat -c '%a' "$env_file")" != "600" ]]; then
  echo "env file must be an existing regular 0600 file: $env_file" >&2
  exit 1
fi
if [[ -e "$token_file" || -L "$token_file" ]]; then
  echo "token file already exists, left unchanged: $token_file" >&2
  exit 0
fi
master_key="$(sed -n 's/^LITELLM_MASTER_KEY=//p' "$env_file" | tail -n 1)"
if [[ -z "$master_key" ]]; then
  echo "LITELLM_MASTER_KEY is not set in $env_file" >&2
  exit 1
fi

umask 077
response="$(mktemp)"
trap 'rm -f "$response"' EXIT
status="$(
  printf 'header = "Authorization: Bearer %s"\n' "$master_key" |
    curl -sS -o "$response" -w '%{http_code}' -K - \
      -H 'Content-Type: application/json' \
      -d '{"key_alias":"prometheus-metrics","allowed_routes":["/metrics"],"models":["no-default-models"]}' \
      "$gateway/key/generate"
)"
if [[ "$status" != "200" ]]; then
  echo "key generation failed with HTTP $status (an existing alias prometheus-metrics must be deleted first)" >&2
  exit 1
fi
install -d -m 700 "$(dirname "$token_file")"
python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["key"], end="")' "$response" > "$token_file"
chmod 600 "$token_file"
echo "created $token_file (0600)"
