#!/usr/bin/env bash
# Installs and switches platform releases under /opt/agent-runtime (specs.md Phase 19.5).
#
#   release.sh install <agent-runtime-<version>-linux-<arch>.tar.gz>
#       checks the archive against the SHA256SUMS-* file next to it and unpacks it to
#       releases/<version>; never overwrites an installed release; does not activate it
#   release.sh activate <version>    points `current` at releases/<version> (atomic);
#                                    restart the services afterwards
#   release.sh list                  installed releases, the active one marked
#   release.sh prune <version>       removes an installed release that is not active
#
# Run as root. AGENT_RUNTIME_ROOT overrides /opt/agent-runtime.
set -euo pipefail

root="${AGENT_RUNTIME_ROOT:-/opt/agent-runtime}"
releases="${root}/releases"

fail() {
  echo "release.sh: $*" >&2
  exit 1
}

valid_version() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || fail "invalid version '$1'"
}

active_version() {
  if [[ -L "${root}/current" ]]; then basename "$(readlink "${root}/current")"; fi
}

case "${1:-}" in
  install)
    archive="$(realpath "${2:?usage: release.sh install <archive.tar.gz>}")"
    name="$(basename "$archive")"
    [[ "$name" =~ ^agent-runtime-(.+)-linux-(arm64|amd64)\.tar\.gz$ ]] || fail "unexpected archive name $name"
    version="${BASH_REMATCH[1]}"
    arch="${BASH_REMATCH[2]}"
    valid_version "$version"
    host_arch="$(uname -m)"
    case "$host_arch" in aarch64) host_arch=arm64 ;; x86_64) host_arch=amd64 ;; esac
    [[ "$arch" == "$host_arch" ]] || fail "$name is for $arch; this host is $host_arch"
    sums="$(dirname "$archive")/SHA256SUMS-${version}-${arch}"
    [[ -f "$sums" ]] || fail "missing $sums"
    (cd "$(dirname "$archive")" && grep -F "  ${name}" "$sums" | sha256sum --check --strict --quiet -) ||
      fail "checksum mismatch for $name; do not install it"
    [[ ! -e "${releases}/${version}" ]] || fail "release ${version} is already installed"
    mkdir -p "$releases"
    staging="$(mktemp -d "${releases}/.install-XXXXXX")"
    trap 'rm -rf "$staging"' EXIT
    tar -xzf "$archive" -C "$staging" --no-same-owner
    [[ -f "${staging}/agent-runtime-${version}/release.json" ]] || fail "archive has no release.json"
    chmod -R go-w "${staging}/agent-runtime-${version}"
    mv "${staging}/agent-runtime-${version}" "${releases}/${version}"
    echo "installed ${releases}/${version} (not active; activate with: release.sh activate ${version})"
    ;;
  activate)
    version="${2:?usage: release.sh activate <version>}"
    valid_version "$version"
    [[ -f "${releases}/${version}/release.json" ]] || fail "release ${version} is not installed"
    previous="$(active_version)"
    ln -sfn "releases/${version}" "${root}/.current.new"
    mv -T "${root}/.current.new" "${root}/current"
    echo "active release: ${version}${previous:+ (was ${previous})}"
    echo "now restart: systemctl restart agent-runtime-control-plane (Control Plane host),"
    echo "  docker compose -p ar-platform -f /etc/agent-runtime/compose.yml restart nginx,"
    echo "  systemctl restart agent-runtime-worker (each Worker host)"
    ;;
  list)
    active="$(active_version)"
    [[ -d "$releases" ]] || exit 0
    for dir in "$releases"/*/; do
      [[ -f "${dir}release.json" ]] || continue
      version="$(basename "$dir")"
      marker=" "
      [[ "$version" == "$active" ]] && marker="*"
      echo "${marker} ${version}"
    done
    ;;
  prune)
    version="${2:?usage: release.sh prune <version>}"
    valid_version "$version"
    [[ "$version" != "$(active_version)" ]] || fail "release ${version} is active"
    [[ -d "${releases}/${version}" ]] || fail "release ${version} is not installed"
    rm -rf "${releases:?}/${version}"
    echo "removed release ${version}"
    ;;
  *)
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
