# Runtime Capability Matrix

This matrix records native execution evidence for the Phase 7 image. A build or
manifest entry alone is not a pass. `PASS` means `runtime-smoke`, the real
Playwright/Chromium local-page smoke, and the strict Worker capability probe ran
successfully on that architecture under the Runtime security constraints.

Last reviewed: 2026-09-30

| Capability | linux/amd64 | linux/arm64 |
| --- | --- | --- |
| Image builds for native architecture | PASS | PASS |
| Base/build CLI and requested diagnostics | PASS | PASS |
| Python / uv | PASS | PASS |
| Node.js / pnpm | PASS | PASS |
| Rust / cargo / rustup | PASS | PASS |
| ffmpeg / ffprobe | PASS | PASS |
| PDF / pandoc / LibreOffice headless | PASS | PASS |
| Playwright launches Chromium, opens local page, evaluates JS, closes | PASS | PASS |
| pi / pi-web and Phase 3-6 Worker Docker regressions | PASS | PASS |
| Worker hello capability object | all six `true` | all six `true` |

The ARM64 result was produced locally on 2026-09-14 with Docker Engine 29.7.2.
The image used Playwright 1.63.0 with the native ARM64 Chrome for Testing
153.0.8010.12 download. The full Worker Docker suite passed 23/23, including
the Phase 3-6 persistence, pi-web, Gateway, reconciliation, and network-isolation
regressions.

The AMD64 result comes from the GitHub-hosted `ubuntu-24.04` runner in
`.github/workflows/runtime-toolchain.yml` (run 36691473375, 2026-09-30, pull request
#1). On both `linux/amd64` and `linux/arm64` runners the native image build,
`verify-image.sh` (toolchain plus the real Playwright/Chromium smoke with Chrome for
Testing 153.0.8010.12) and the full Worker suite with `TEST_DOCKER_RUNTIME=1` passed
28/28, including the real-Docker persistence, pi-web, reconciliation and
network-isolation regressions. The workflow reruns weekly and on Runtime changes to
master.

To reproduce on a native Worker of either architecture (the Docker regressions must
run with permission to chown managed directories to the Runtime UID, as a production
Worker does):

```bash
docker build \
  --platform linux/amd64 \
  --tag agent-runtime:phase7-toolchain \
  runtime
runtime/scripts/verify-image.sh agent-runtime:phase7-toolchain amd64
sudo -E env "PATH=$PATH" TEST_DOCKER_RUNTIME=1 \
  TEST_RUNTIME_IMAGE=agent-runtime:phase7-toolchain \
  pnpm --filter @agent-runtime/worker test
```

A table entry is evidence, not a runtime switch. Live scheduling does
not consume this documentation table: every Worker probes its own exact local
image before hello and reports the measured boolean capability object. An
architecture mismatch or invalid/missing probe prevents hello; an individual
tool group failure is reported as `false`, allowing existing capability filters
to reject workloads that require it.
