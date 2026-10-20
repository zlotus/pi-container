#!/usr/bin/env bash
# Read-only security audit of a platform host (specs.md Phase 19.11, item 8). Changes
# nothing. Prints PASS / WARN / FAIL per check and exits 1 if anything FAILs.
#
#   sudo audit-host.sh                   every check that applies to this host
#   audit-host.sh --containers-only      only the Workspace container baseline (docker group)
#
# Environment: AGENT_RUNTIME_ETC (/etc/agent-runtime), WORKER_MANAGED_ROOT (from worker.env,
# else /var/lib/agent-runtime).
# pass/warn/fail always succeed, so `test && pass || fail` is a two-way choice (SC2015);
# docker --format templates are single-quoted on purpose (SC2016).
# shellcheck disable=SC2015,SC2016
set -uo pipefail

etc="${AGENT_RUNTIME_ETC:-/etc/agent-runtime}"
failures=0
warnings=0

pass() { printf 'PASS  %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; warnings=$((warnings + 1)); }
fail() { printf 'FAIL  %s\n' "$*"; failures=$((failures + 1)); }

env_value() { # env_value <file> <name>: the last plain KEY=value line, without quotes
  sed -n "s/^${2}=//p" "$1" 2>/dev/null | tail -n 1
}

caps_of() { # caps_of <mask hex>: capability names (capsh when present, else the mask)
  if command -v capsh >/dev/null; then capsh --decode="$1" | sed 's/.*=//'; else echo "0x$1"; fi
}

check_containers() {
  local ids id name
  ids="$(docker ps -aq --filter label=app=agent-runtime-platform 2>/dev/null)" || {
    fail "cannot list containers (run as root or in the docker group)"
    return
  }
  if [[ -z "$ids" ]]; then
    pass "no managed Workspace containers on this host"
    return
  fi
  for id in $ids; do
    name="$(docker inspect --format '{{.Name}}' "$id" | sed 's#^/##')"
    inspect() { docker inspect --format "$1" "$id"; }
    local problems=()
    [[ "$(inspect '{{.HostConfig.Privileged}}')" == "false" ]] || problems+=("privileged")
    [[ "$(inspect '{{json .HostConfig.CapDrop}}')" == *'"ALL"'* ]] || problems+=("capabilities not dropped")
    [[ "$(inspect '{{len .HostConfig.CapAdd}}')" == "0" ]] || problems+=("capabilities added")
    [[ "$(inspect '{{json .HostConfig.SecurityOpt}}')" == *no-new-privileges* ]] || problems+=("no-new-privileges missing")
    [[ "$(inspect '{{.HostConfig.ReadonlyRootfs}}')" == "true" ]] || problems+=("writable root filesystem")
    case "$(inspect '{{.HostConfig.NetworkMode}}')" in
      host | container:*) problems+=("shares a host or container network") ;;
    esac
    [[ "$(inspect '{{.HostConfig.PidMode}}')" != "host" ]] || problems+=("host PID namespace")
    [[ "$(inspect '{{.HostConfig.IpcMode}}')" != "host" ]] || problems+=("host IPC namespace")
    case "$(inspect '{{.Config.User}}')" in
      "" | root | 0 | 0:*) problems+=("runs as root") ;;
    esac
    [[ "$(inspect '{{.HostConfig.Memory}}')" != "0" ]] || problems+=("no memory limit")
    [[ "$(inspect '{{.HostConfig.NanoCpus}}')" != "0" ]] || problems+=("no CPU limit")
    case "$(inspect '{{.HostConfig.PidsLimit}}')" in
      "" | "<nil>" | 0 | -1) problems+=("no PID limit") ;;
    esac
    local mounts
    mounts="$(inspect '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}')"
    if grep -qE 'docker\.sock|containerd\.sock|/run/docker|/var/run/docker' <<<"$mounts"; then
      problems+=("Docker socket mounted")
    fi
    while read -r type source _ destination; do
      [[ -z "$type" ]] && continue
      [[ "$type" == "bind" ]] || continue
      [[ "$source" == "${managed_root}/workspaces/"* ]] || problems+=("bind mount outside the managed root: ${source} -> ${destination}")
    done <<<"$mounts"
    local ports
    ports="$(inspect '{{range $port, $bindings := .HostConfig.PortBindings}}{{range $bindings}}{{.HostIp}} {{end}}{{end}}')"
    for address in $ports; do
      [[ "$address" == "127.0.0.1" ]] || problems+=("port published on ${address:-all addresses}")
    done
    if ((${#problems[@]} == 0)); then
      pass "container ${name}: baseline"
    else
      for problem in "${problems[@]}"; do fail "container ${name}: ${problem}"; done
    fi
  done
}

check_env_file() { # check_env_file <file> <group>
  local file="$1" group="$2" mode owner
  mode="$(stat -c '%a' "$file")"
  owner="$(stat -c '%U:%G' "$file")"
  if [[ "$owner" == "root:${group}" && ( "$mode" == "640" || "$mode" == "600" ) ]]; then
    pass "${file}: ${owner} ${mode}"
  else
    fail "${file}: ${owner} ${mode} (expected root:${group} 0640)"
  fi
}

check_process() { # check_process <pattern> <expected user> <expected capability mask>
  local pid user eff bnd
  pid="$(pgrep -f "$1" | head -n 1)"
  if [[ -z "$pid" ]]; then
    warn "process '$1' is not running"
    return
  fi
  user="$(ps -o user= -p "$pid" | tr -d ' ')"
  [[ "$user" == "$2" ]] && pass "$1 runs as ${user}" || fail "$1 runs as ${user} (expected $2)"
  eff="$(awk '/^CapEff/ {print $2}' "/proc/${pid}/status")"
  bnd="$(awk '/^CapBnd/ {print $2}' "/proc/${pid}/status")"
  if [[ "$eff" == "$3" && "$bnd" == "$3" ]]; then
    pass "$1 capabilities: $(caps_of "$eff")"
  else
    fail "$1 capabilities effective $(caps_of "$eff") / bounding $(caps_of "$bnd") (expected $(caps_of "$3"))"
  fi
}

check_docker_tcp() {
  if ss -ltnH | awk '{print $4}' | grep -qE ':(2375|2376)$'; then
    fail "Docker Engine listens on TCP (2375/2376)"
  elif pgrep -a dockerd | grep -qE -- '-H[= ]?tcp://|--host[= ]tcp://'; then
    fail "dockerd is started with a TCP host"
  else
    pass "Docker Engine has no TCP listener"
  fi
}

check_uid_1000() {
  local entry name shell
  entry="$(getent passwd 1000)" || { pass "no account with UID 1000 (Workspace UID)"; return; }
  name="${entry%%:*}"
  shell="${entry##*:}"
  if id -nG "$name" | grep -qwE 'sudo|wheel|docker|adm' || [[ "$shell" != */nologin && "$shell" != */false ]]; then
    warn "UID 1000 (the Workspace UID) is the login account '${name}'; Workspace files belong to it (specs.md 19.15 Q12)"
  else
    pass "UID 1000 is '${name}' without login or admin groups"
  fi
}

check_plain_url() { # check_plain_url <label> <url>
  case "$2" in
    "" ) ;;
    ws://127.* | http://127.* | ws://localhost* | http://localhost* | ws://\[::1\]* | http://\[::1\]*)
      pass "$1 is loopback" ;;
    ws://* | http://*) fail "$1 is not encrypted across hosts: $2" ;;
    *) pass "$1 uses TLS" ;;
  esac
}

managed_root="${WORKER_MANAGED_ROOT:-}"
if [[ -z "$managed_root" && -r "${etc}/worker.env" ]]; then
  managed_root="$(env_value "${etc}/worker.env" WORKER_MANAGED_ROOT)"
fi
managed_root="${managed_root:-/var/lib/agent-runtime}"

if [[ "${1:-}" == "--containers-only" ]]; then
  check_containers
else
  [[ "$(id -u)" -eq 0 ]] || echo "note: not root; some checks are skipped or incomplete" >&2

  if [[ -f "${etc}/worker.env" ]]; then
    echo "== Worker host"
    check_env_file "${etc}/worker.env" agent-runtime
    # NET_ADMIN, SYS_ADMIN, CHOWN, FOWNER, DAC_OVERRIDE (agent-runtime-worker.service).
    check_process "app/worker/server.mjs" agent-runtime 000000000020100b
    check_docker_tcp
    if findmnt -no FSTYPE,OPTIONS -T "$managed_root" | grep -qE '^xfs .*prjquota'; then
      pass "${managed_root} is XFS with prjquota"
    else
      fail "${managed_root} is not an XFS mount with prjquota"
    fi
    if command -v nft >/dev/null && nft list table inet agent_runtime >/dev/null 2>&1; then
      pass "egress table inet agent_runtime is loaded"
    else
      fail "egress table inet agent_runtime is not loaded (or not readable without root)"
    fi
    systemctl is-enabled --quiet agent-runtime-egress.service 2>/dev/null &&
      pass "agent-runtime-egress.service is enabled" || fail "agent-runtime-egress.service is not enabled"
    check_plain_url "CONTROL_PLANE_URL" "$(env_value "${etc}/worker.env" CONTROL_PLANE_URL)"
    check_plain_url "WORKER_MODEL_GATEWAY_URL" "$(env_value "${etc}/worker.env" WORKER_MODEL_GATEWAY_URL)"
    gateway_host="$(env_value "${etc}/worker.env" WORKER_GATEWAY_HOST)"
    if [[ "${gateway_host:-127.0.0.1}" != 127.* && -z "$(env_value "${etc}/worker.env" WORKER_GATEWAY_TLS_CERT_PATH)" ]]; then
      fail "Worker Gateway listens on ${gateway_host} without TLS"
    else
      pass "Worker Gateway is loopback-only or uses TLS"
    fi
    check_uid_1000
    check_containers
  fi

  if [[ -f "${etc}/control-plane.env" ]]; then
    echo "== Control Plane host"
    check_env_file "${etc}/control-plane.env" agent-runtime-cp
    check_env_file "${etc}/control-plane.secrets.env" agent-runtime-cp
    check_process "app/control-plane/server.mjs" agent-runtime-cp 0000000000000000
    cp_env="${etc}/control-plane.env"
    for name in HOST GATEWAY_HOST METRICS_HOST; do
      value="$(env_value "$cp_env" "$name")"
      [[ -z "$value" || "$value" == 127.* || "$value" == "::1" ]] &&
        pass "${name} is loopback" || fail "${name}=${value} is not loopback (nginx is the only entry point)"
    done
    [[ "$(env_value "$cp_env" SESSION_COOKIE_SECURE)" != "false" ]] &&
      pass "session cookies are Secure" || fail "SESSION_COOKIE_SECURE=false"
    [[ "$(env_value "$cp_env" PORTAL_ORIGIN)" == https://* ]] &&
      pass "PORTAL_ORIGIN uses HTTPS" || fail "PORTAL_ORIGIN does not use HTTPS"
    [[ "$(env_value "$cp_env" WORKSPACE_BASE_URL)" == https://* ]] &&
      pass "WORKSPACE_BASE_URL uses HTTPS" || fail "WORKSPACE_BASE_URL does not use HTTPS"
    [[ "$(env_value "$cp_env" DATABASE_MIGRATE_ON_START)" == "false" ]] &&
      pass "migrations run only by the migrate command" || warn "DATABASE_MIGRATE_ON_START is not false"
    for service in postgres litellm; do
      published="$(docker compose -p agent-runtime-prod -f "${etc}/compose.yml" port "$service" \
        "$([[ $service == postgres ]] && echo 5432 || echo 4000)" 2>/dev/null)"
      if [[ -z "$published" || "$published" == 127.0.0.1:* ]]; then
        pass "${service} is published on loopback only${published:+ (${published})}"
      else
        fail "${service} is published on ${published}"
      fi
    done
    for key in "${etc}"/tls/*.key; do
      [[ -e "$key" ]] || continue
      [[ "$(stat -c '%a' "$key")" =~ ^[64][04]0$ ]] && pass "${key} is not world-readable" ||
        fail "${key} is world-readable"
    done
    check_docker_tcp
  fi

  if [[ ! -f "${etc}/worker.env" && ! -f "${etc}/control-plane.env" ]]; then
    fail "neither ${etc}/worker.env nor ${etc}/control-plane.env exists; is this a platform host?"
  fi
fi

echo "-- ${failures} failed, ${warnings} warnings"
((failures == 0))
