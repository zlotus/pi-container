# Phase 3 Minimal Runtime

This image deliberately contains only the Phase 3 baseline: pi-web, Pi Coding
Agent, a shell and core CLI, Git, Python, Node.js, and pnpm. Rust, browser,
Office, PDF, and media tooling remain Phase 7 work.

Pinned runtime versions:

- Node.js `22.20.0-bookworm-slim`, pinned by multi-platform manifest digest
- pnpm `11.24.0`
- `@agegr/pi-web` `0.9.0`
- `@earendil-works/pi-coding-agent` `0.85.1`

Build from the repository root:

```bash
docker build --tag agent-runtime:phase3-minimal runtime
```

The Worker starts this image as UID/GID 1000, binds `/workspace` and
`/agent/pi` from its managed root, and publishes pi-web only to an ephemeral
`127.0.0.1` host port. `PI_CODING_AGENT_DIR=/agent/pi` keeps Pi configuration,
credentials, and sessions in the persistent Pi mount.
