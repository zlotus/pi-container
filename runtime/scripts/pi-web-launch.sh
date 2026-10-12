#!/bin/sh
# Starts pi-web with fresh preview-mode secrets (specs.md Phase 18.3). The secrets file
# lives in the container's /var/tmp tmpfs; pi-web rotates it there before Next starts.
set -eu
umask 077
manifest_dir=/var/tmp/pi-web
mkdir -p "$manifest_dir"
cp /opt/agent-runtime/lib/node_modules/@agegr/pi-web/.next/prerender-manifest.template.json \
  "$manifest_dir/prerender-manifest.json"
exec pi-web "$@"
