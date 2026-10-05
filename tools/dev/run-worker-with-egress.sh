#!/usr/bin/env bash
# DEV ONLY: runs `pnpm dev:worker` as the current user, adding exactly one capability,
# CAP_NET_ADMIN, which the Worker needs to manage its nftables table (specs.md Phase
# 14.4). It does not run the Worker as root and does not `setcap` the node binary.
# Production uses the systemd unit's AmbientCapabilities=CAP_NET_ADMIN instead.
#
# Usage (from the repository root): tools/dev/run-worker-with-egress.sh .data/worker-a.env
set -euo pipefail

env_file="$(realpath "${1:?usage: tools/dev/run-worker-with-egress.sh <worker env file>}")"
uid="$(id -u)"
gid="$(id -g)"

# sudo is only used to obtain the capability; setpriv immediately drops back to this
# user and group (with its supplementary groups, e.g. docker) and keeps CAP_NET_ADMIN
# as an ambient capability inherited by pnpm, tsx, node and the nft child process.
exec sudo /usr/bin/setpriv \
  --reuid="$uid" --regid="$gid" --init-groups \
  --inh-caps=+net_admin --ambient-caps=+net_admin \
  -- /usr/bin/env -i \
  HOME="$HOME" USER="$USER" LOGNAME="$USER" PATH="$PATH" LANG="${LANG:-C.UTF-8}" \
  TERM="${TERM:-dumb}" \
  bash -c 'set -a; . "$1"; set +a; exec pnpm dev:worker' _ "$env_file"
