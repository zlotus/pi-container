#!/usr/bin/env bash
# DEV/ACCEPTANCE TOOL - not part of any deployment.
#
# Probes TCP targets from inside a running Workspace container and classifies each one
# by application-level evidence, so Clash TUN (whose gvisor stack completes a TCP
# handshake for any destination) cannot make a blocked or nonexistent target look
# reachable (specs.md Phase 14.8).
#
#   REACHABLE       connected and received at least one byte (banner or HTTP reply)
#   HANDSHAKE_ONLY  connected but nothing came back: typically a TUN proxy answering
#                   for an address it cannot reach; treat as "not reachable"
#   BLOCKED         connection refused or timed out (what the egress rules produce)
#
# Usage: tools/dev/egress-probe.sh <workspace-id|container-name> [host:port ...]
# Without targets it probes a default set: the Worker host through the Workspace
# gateway (Worker Gateway 3100, Control Plane 3000/3001, SSH 22, Clash 7897), every
# IPv4 address of this host on port 22, the default IPv4 router on port 80, and a
# public HTTP endpoint (1.1.1.1:80).
set -euo pipefail

if [[ $# -lt 1 ]]; then
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi

target="$1"
shift
container="$target"
if [[ "$target" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  container="agent-runtime-$target"
fi

if [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" != "true" ]]; then
  echo "container $container is not running" >&2
  exit 1
fi

targets=("$@")
if [[ ${#targets[@]} -eq 0 ]]; then
  gateway="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}' "$container")"
  for port in 3100 3000 3001 22 7897; do targets+=("$gateway:$port"); done
  while read -r address; do
    targets+=("$address:22")
  done < <(ip -4 -o addr show scope global | awk '{split($4, a, "/"); print a[1]}' |
    grep -v -e '^172\.1[6-9]\.' -e '^172\.2[0-9]\.' -e '^172\.3[01]\.')
  router="$(ip -4 route show default | awk '/^default/ {print $3; exit}')"
  [[ -n "$router" ]] && targets+=("$router:80")
  targets+=("1.1.1.1:80")
fi

printf '%-28s %s\n' "TARGET" "RESULT"
for entry in "${targets[@]}"; do
  host="${entry%:*}"
  port="${entry##*:}"
  # Runs inside the container: no tools beyond bash and coreutils `timeout` are needed.
  result="$(docker exec "$container" bash -c '
    host="$1"; port="$2"
    if ! timeout 3 bash -c "exec 3<>/dev/tcp/$host/$port" 2>/dev/null; then
      echo BLOCKED; exit 0
    fi
    output="$(timeout 3 bash -c "
      exec 3<>/dev/tcp/$host/$port || exit 1
      printf \"HEAD / HTTP/1.0\r\nHost: %s\r\n\r\n\" \"$host\" >&3
      head -c 1 <&3
    " 2>/dev/null | od -An -c | tr -d " \n")"
    if [[ -n "$output" ]]; then echo REACHABLE; else echo HANDSHAKE_ONLY; fi
  ' _ "$host" "$port")"
  printf '%-28s %s\n' "$entry" "$result"
done
