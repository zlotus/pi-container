# Runtime Capability Matrix

This matrix records native execution evidence for the Phase 7 image. A build or
manifest entry alone is not a pass. `PASS` means `runtime-smoke`, the real
Playwright/Chromium local-page smoke, and the strict Worker capability probe ran
successfully on that architecture under the Runtime security constraints.

Last reviewed: 2026-09-14

| Capability | linux/amd64 | linux/arm64 |
| --- | --- | --- |
| Image builds for native architecture | PENDING native runner | PASS |
| Base/build CLI and requested diagnostics | PENDING native runner | PASS |
| Python / uv | PENDING native runner | PASS |
| Node.js / pnpm | PENDING native runner | PASS |
| Rust / cargo / rustup | PENDING native runner | PASS |
| ffmpeg / ffprobe | PENDING native runner | PASS |
| PDF / pandoc / LibreOffice headless | PENDING native runner | PASS |
| Playwright launches Chromium, opens local page, evaluates JS, closes | PENDING native runner | PASS |
| pi / pi-web and Phase 3-6 Worker Docker regressions | PENDING native runner | PASS |
| Worker hello capability object | PENDING native runner | all six `true` |

The ARM64 result was produced locally on 2026-09-14 with Docker Engine 29.7.2.
The image used Playwright 1.63.0 with the native ARM64 Chrome for Testing
153.0.8010.12 download. The full Worker Docker suite passed 23/23, including
the Phase 3-6 persistence, pi-web, Gateway, reconciliation, and network-isolation
regressions.

No native AMD64 Docker endpoint is available in the current workspace. The
previous multi-host example at `192.168.1.123` was unreachable during this run,
so AMD64 is intentionally not marked supported from ARM64-only evidence. Run
the `linux/amd64` job in `.github/workflows/runtime-toolchain.yml`, or execute on
a native AMD64 Worker:

```bash
docker build \
  --platform linux/amd64 \
  --tag agent-runtime:phase7-toolchain \
  runtime
runtime/scripts/verify-image.sh agent-runtime:phase7-toolchain amd64
TEST_DOCKER_RUNTIME=1 \
TEST_RUNTIME_IMAGE=agent-runtime:phase7-toolchain \
  pnpm --filter @agent-runtime/worker test
```

Until that run passes, AMD64 is `unverified`, not `true`. Live scheduling does
not consume this documentation table: every Worker probes its own exact local
image before hello and reports the measured boolean capability object. An
architecture mismatch or invalid/missing probe prevents hello; an individual
tool group failure is reported as `false`, allowing existing capability filters
to reject workloads that require it.
