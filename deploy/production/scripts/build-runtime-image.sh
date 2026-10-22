#!/usr/bin/env bash
# Builds a Runtime image once on this host and writes a distributable archive
# (specs.md Phase 19.4.2). Other Workers load the archive instead of building, so every
# Worker runs the same image under the same digest. A tag is never rebuilt: any change
# gets a new tag and runtime version (Phase 18.15).
#
# Usage (from a checkout of the release commit):
#   deploy/production/scripts/build-runtime-image.sh <tag> [output directory]
# Example: deploy/production/scripts/build-runtime-image.sh 2026.10-pi1.1
#   -> image agent-runtime:2026.10-pi1.1 (runtime version 2026.10-pi1.1)
#   -> <output>/agent-runtime_2026.10-pi1.1_linux-arm64.tar.zst (+ .sha256, .manifest.txt)
set -euo pipefail

tag="${1:?usage: build-runtime-image.sh <tag> [output directory]}"
if [[ ! "${tag}" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$ ]]; then
  echo "tag must be 1-64 characters of letters, digits, '.', '_', '+', '-'" >&2
  exit 2
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
output="$(realpath -m "${2:-${root}/dist/runtime-images}")"
image="agent-runtime:${tag}"

if docker image inspect "${image}" >/dev/null 2>&1; then
  echo "${image} already exists on this host; a Runtime image tag is never rebuilt." >&2
  echo "Choose a new tag (and runtime version) for any change." >&2
  exit 1
fi
command -v zstd >/dev/null || { echo "zstd is required" >&2; exit 1; }
architecture="$(docker version --format '{{.Server.Arch}}')"
commit="$(git -C "${root}" rev-parse HEAD 2>/dev/null || echo unknown)"
if [[ -n "$(git -C "${root}" status --porcelain -- runtime 2>/dev/null)" ]]; then
  echo "runtime/ has uncommitted changes; build from a clean checkout" >&2
  exit 1
fi

docker build \
  --platform "linux/${architecture}" \
  --build-arg "RUNTIME_VERSION=${tag}" \
  --tag "${image}" \
  "${root}/runtime"
"${root}/runtime/scripts/verify-image.sh" "${image}" "${architecture}"

mkdir -p "${output}"
base="${output}/agent-runtime_${tag}_linux-${architecture}"
image_id="$(docker image inspect "${image}" --format '{{.Id}}')"
{
  echo "image: ${image}"
  echo "image_id: ${image_id}"
  echo "architecture: linux/${architecture}"
  echo "commit: ${commit}"
  echo "built_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "base_images:"
  grep -E '^ARG (NODE|RUST)_IMAGE=' "${root}/runtime/Dockerfile" | sed 's/^ARG /  /'
  echo "labels:"
  docker image inspect "${image}" --format '{{range $k, $v := .Config.Labels}}  {{$k}}={{$v}}{{"\n"}}{{end}}'
  echo "debian_packages:"
  docker run --rm --network none --entrypoint dpkg-query "${image}" -W -f '  ${Package} ${Version}\n'
  echo "node_packages:"
  docker run --rm --network none --entrypoint npm "${image}" ls --all --prefix /opt/agent-runtime | sed 's/^/  /'
} >"${base}.manifest.txt"

docker save "${image}" | zstd -T0 -6 -q -o "${base}.tar.zst" --force
(cd "${output}" && sha256sum "$(basename "${base}.tar.zst")" >"$(basename "${base}.tar.zst").sha256")

echo
echo "Built ${image}"
echo "  image ID: ${image_id}"
echo "  archive:  ${base}.tar.zst"
echo "  manifest: ${base}.manifest.txt"
echo "Load it on each Worker with: agent-runtime-image load ${base##*/}.tar.zst"
echo "RUNTIME_IMAGES entry: ${image}@${image_id}"
