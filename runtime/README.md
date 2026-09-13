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

Platform Workspace semantics fix the persistent project root at `/workspace`.
Pinned pi-web 0.9.0 has no default-cwd setting and otherwise creates
`~/pi-cwd-YYYYMMDD`, so the image applies the narrowly scoped, version-checked
build patch in `patches/pi-web-0.9.0-default-cwd.mjs` and sets
`PI_WEB_DEFAULT_CWD=/workspace`. The patched route still creates the selected
directory and registers it as an allowed file root. If the variable is unset,
the exact upstream `~/pi-cwd-YYYYMMDD` fallback remains in effect.

The persistence boundary remains:

```text
/workspace  -> <worker-managed-root>/workspaces/<workspace-id>/workspace
/agent/pi   -> <worker-managed-root>/workspaces/<workspace-id>/pi
```

New Pi Session JSONL metadata therefore records `cwd: "/workspace"`, while the
JSONL itself remains under `/agent/pi/sessions`. `/home/agent` is not mounted and
is not part of the platform's persistent Workspace contract.

Upgrade compatibility is intentionally asymmetric. A managed container created
before `PI_WEB_DEFAULT_CWD` was introduced remains safe to inspect, stop, start,
proxy, and delete when every ownership and security identity check still
matches. It keeps the upstream default-cwd behavior until the user explicitly
deletes and recreates the Workspace; the Worker never recreates it or removes
persistent data automatically. Newly created containers must contain the current
`PI_WEB_DEFAULT_CWD=/workspace` setting. An explicit conflicting value blocks
ensure/start/proxy, while inspect/stop/delete remain available for safe cleanup.
