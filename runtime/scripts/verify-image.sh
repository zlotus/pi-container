#!/usr/bin/env bash
set -euo pipefail

image=${1:-agent-runtime:phase7-toolchain}
expected_architecture=${2:-}

case "${expected_architecture}" in
  ""|amd64|arm64) ;;
  *)
    echo "expected architecture must be amd64 or arm64" >&2
    exit 2
    ;;
esac

actual_architecture=$(docker image inspect "${image}" --format '{{.Architecture}}')
if [[ -n "${expected_architecture}" && "${actual_architecture}" != "${expected_architecture}" ]]; then
  echo "image architecture ${actual_architecture} does not match ${expected_architecture}" >&2
  exit 1
fi

echo "Verifying ${image} (${actual_architecture})"
docker run --rm \
  --network none \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 512 \
  --entrypoint /usr/local/bin/runtime-smoke \
  "${image}"
