#!/usr/bin/env bash
# DEV ONLY: creates the Prometheus scrape token for the Control Plane metrics listener
# (specs.md Phase 17.7). The file is 0600; an existing file is left unchanged. Nothing secret
# is printed.
#
# Usage: tools/dev/init-metrics-token.sh [token file]   (default ~/.config/agent-runtime/metrics.token)
set -euo pipefail

token_file="${1:-$HOME/.config/agent-runtime/metrics.token}"
if [[ -e "$token_file" || -L "$token_file" ]]; then
  echo "token file already exists, left unchanged: $token_file" >&2
  exit 0
fi
install -d -m 700 "$(dirname "$token_file")"
umask 077
# 48 random bytes, URL-safe base64 without padding: 64 printable characters.
head -c 48 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' > "$token_file"
chmod 600 "$token_file"
echo "created $token_file (0600, $(wc -c < "$token_file") characters)"
