# Runtime Image

The Phase 7 image keeps the pinned pi-web/Pi integration and adds the bounded
engineering workstation toolchain from `specs.md`:

- Python 3, pip, and pinned uv
- pinned Node.js and pnpm
- pinned Rust, cargo, and rustup
- GCC/G++, make, CMake, and pkg-config
- ffmpeg and ffprobe
- Poppler PDF utilities, pandoc, and headless LibreOffice
- pinned Playwright with its matching Chromium download
- common shell, archive, filesystem, process, and network-debugging CLI tools
- base English and CJK fonts

The image intentionally does not add tcpdump, nmap, Wireshark, iperf, a Docker
client/socket, or tools that need privileged mode or extra Linux capabilities.

`ping` is installed (`iputils-ping`), but default Workspaces use `CapDrop=ALL`.
ICMP ping may therefore fail with `Operation not permitted`. This is an expected
security restriction, not a missing binary; do not add `CAP_NET_RAW` just to
enable ping. Use `nc`, `curl`, `dig`, `ip`, `ss`, and `lsof` for routine network
diagnostics. The smoke test checks that `ping` exists, not that ICMP is permitted.

Pinned inputs:

- Node.js `22.20.0-bookworm-slim`, pinned by multi-platform manifest digest
- Rust `1.90.0-slim-bookworm`, pinned by multi-platform manifest digest
- uv `0.12.13`
- pnpm `11.24.0`
- Playwright `1.63.0` and its matching Chromium revision
- the whole Node package tree (pi-web, Pi, Playwright, pnpm and every transitive
  dependency) via `packages/package-lock.json`, installed with `npm ci`
- `@agegr/pi-web` `0.12.0`
- `@earendil-works/pi-coding-agent` `1.1.0` (the exact version pi-web depends on)

Build and verify on each native architecture:

```bash
# Preferred: builds, verifies, refuses an existing tag and writes a distributable archive.
deploy/production/scripts/build-runtime-image.sh 2026.10-pi1.1
# By hand (the runtime version label comes from the build argument and must equal the tag):
docker build \
  --platform linux/arm64 \
  --build-arg RUNTIME_VERSION=2026.10-pi1.1 \
  --tag agent-runtime:2026.10-pi1.1 \
  runtime
runtime/scripts/verify-image.sh agent-runtime:2026.10-pi1.1 arm64
```

Use `linux/amd64` and `amd64` respectively on an AMD64 host. The verification
container uses no network, drops all Linux capabilities, enables
`no-new-privileges`, and runs as the image's non-root user. The smoke test checks
the language/build/document/media tools, every baseline diagnostic command,
pi/pi-web, and a real Playwright flow that launches Chromium, opens a local HTML
page, evaluates JavaScript, and closes the browser.

The native AMD64/ARM64 workflow in
`.github/workflows/runtime-toolchain.yml` runs the same build, smoke, and Worker
Docker regression suite on both architectures. Do not replace native browser
validation with a manifest-only or binary-exists check.

## Runtime capability reporting

The Worker no longer derives capability values from architecture. Before every
authenticated hello it creates a short-lived, network-disabled container from
its exact configured `RUNTIME_IMAGE`, verifies that the local image platform
matches the Worker, and runs `runtime-capability-probe` with the same non-root,
cap-drop, no-new-privileges, memory, and PID constraints used by Workspaces.

The strict result maps the existing scheduler capabilities as follows:

- `browser`: Playwright launches its matching Chromium and completes the local-page JS smoke
- `office`: LibreOffice, pdftotext, and pandoc all execute successfully
- `ffmpeg`: ffmpeg and ffprobe both execute successfully
- `python`: python, python3, and uv all execute successfully
- `node`: node and pnpm both execute successfully
- `rust`: rustc, cargo, and rustup all execute successfully

Individual failed groups report `false`. A missing probe, an invalid report, an
image/host architecture mismatch, or an unavailable image prevents Worker hello
instead of registering guessed capabilities. The probe timeout is controlled by
`RUNTIME_CAPABILITY_PROBE_TIMEOUT_MS` and defaults to 120 seconds.

See [the capability matrix](../docs/runtime-capability-matrix.md) for recorded
native results and the exact acceptance boundary.

## Persistence and upgrade boundary

The Worker starts Workspaces as UID/GID 1000 by default with a read-only root,
binds only the managed `/workspace`, `/home/agent`, `/tmp` and `/agent/pi`
directories, and publishes pi-web only to an ephemeral host loopback port.
`PI_CODING_AGENT_DIR=/agent/pi` keeps Pi credentials, sessions, MCP settings and
project-trust decisions in the persistent Pi mount.

The current image is `agent-runtime:2026.10-pi1.1` (runtime version `2026.10-pi1.1`,
pi-web 0.12.0, Pi 1.1.0; the same Dockerfile as `phase18-pi1.1-r2`, built once and
distributed as an archive, specs.md Phase 19.4.2). `patches/pi-web-0.12.0.mjs` makes the default-cwd
route honor `PI_WEB_DEFAULT_CWD=/workspace` and lets pi-web rotate its
preview-mode secrets in tmpfs; `pi-web-launch` (the image command) seeds that
file on every start. Never rebuild an existing tag: every content change gets a
new tag and runtime version.

Workers offer several images at once (`RUNTIME_IMAGES`, pinned by digest), and a
stopped Workspace can be moved to another offered image and back without losing
data. See `docs/lifecycle-runbook.md`. The previous image
(`agent-runtime:phase7-toolchain`, pi-web 0.9.0 / Pi 0.85.1) can be rebuilt from
tag `v1.0.0-alpha.5`.
