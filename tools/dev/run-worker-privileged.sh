#!/usr/bin/env bash
# DEV ONLY: runs `pnpm dev:worker` as the current user, adding exactly two capabilities:
# CAP_NET_ADMIN to manage the Worker's nftables table (specs.md Phase 14.4) and
# CAP_SYS_ADMIN to set XFS project quota limits (Phase 15.3). It does not run the Worker
# as root and does not `setcap` the node binary. Production uses the systemd unit's
# AmbientCapabilities=CAP_NET_ADMIN CAP_SYS_ADMIN instead.
#
# Usage (from the repository root): tools/dev/run-worker-privileged.sh .data/worker-a.env
set -euo pipefail

env_file="$(realpath "${1:?usage: tools/dev/run-worker-privileged.sh <worker env file>}")"
uid="$(id -u)"
gid="$(id -g)"

# sudo is only used to obtain the capability; setpriv immediately drops back to this
# user and group (with its supplementary groups, e.g. docker) and keeps both capabilities
# ambient, inherited by pnpm, tsx, node and the nft / xfs_quota child processes.
exec sudo /usr/bin/setpriv \
  --reuid="$uid" --regid="$gid" --init-groups \
  --inh-caps=+net_admin,+sys_admin --ambient-caps=+net_admin,+sys_admin \
  -- /usr/bin/env -i \
  HOME="$HOME" USER="$USER" LOGNAME="$USER" PATH="$PATH" LANG="${LANG:-C.UTF-8}" \
  TERM="${TERM:-dumb}" \
  bash -c 'set -a; . "$1"; set +a; exec pnpm dev:worker' _ "$env_file"
