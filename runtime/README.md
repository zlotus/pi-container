# Phase 7 Runtime Toolchain

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

Pinned inputs:

- Node.js `22.20.0-bookworm-slim`, pinned by multi-platform manifest digest
- Rust `1.90.0-slim-bookworm`, pinned by multi-platform manifest digest
- uv `0.12.13`
- pnpm `11.24.0`
- Playwright `1.63.0` and its matching Chromium revision
- `@agegr/pi-web` `0.9.0`
- `@earendil-works/pi-coding-agent` `0.85.1`

Build and verify on each native architecture:

```bash
docker build \
  --platform linux/arm64 \
  --tag agent-runtime:phase7-toolchain \
  runtime
runtime/scripts/verify-image.sh agent-runtime:phase7-toolchain arm64
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

The Worker still starts Workspaces as UID/GID 1000 by default, binds only
`/workspace` and `/agent/pi`, and publishes pi-web only to an ephemeral host
loopback port. `PI_CODING_AGENT_DIR=/agent/pi` keeps Pi credentials and sessions
in the persistent Pi mount. `PI_WEB_DEFAULT_CWD=/workspace` retains the pinned,
version-checked pi-web patch and existing legacy-container compatibility.

The Phase 7 image name is `agent-runtime:phase7-toolchain` and its runtime
version is `phase-7`. Existing Workspace metadata remains pinned to the image
name with which it was created; changing a Worker's configured image does not
silently rebuild, migrate, or delete an existing Phase 3 Runtime. Recreate a
Workspace only through the existing explicit destructive delete flow when the
new toolchain is required.
