# Containerized Agent Runtime Platform

面向企业私有环境的多用户容器化 Agent Workspace 原型。平台复用
[pi-web](https://github.com/agegr/pi-web) 与 Pi Coding Agent，自身只负责认证、
Workspace、Worker、Docker 生命周期、调度和安全代理。

Phase 9 与 Phase 10 已完成人工验收。当前仓库已完成 **Phase 11：Provisioning / Identity Binding /
OAuth2 Compatibility** 的工程实现与自动验证，等待目标企业 IdP 人工验收。平台保留 Local Account /
Local Admin 与 Phase 10 Generic OIDC 的完整验证，新增默认关闭的 JIT、exact `allowed_domains` gate、
Admin External Identity list/bind/unbind，以及与 OIDC 严格分离的 Generic OAuth2 + UserInfo adapter。
OIDC 与 OAuth2 都归一化为稳定 `(provider_id, subject) -> Platform User -> server-side Platform Session`，
不按 email 自动合并，也不允许 IdP claim 授予 admin。Phase 12 Authentication Audit / Hardening 尚未进入。
Runtime 现包含
Python/uv、Node/pnpm、Rust、build tools、ffmpeg、PDF/Office 工具、Playwright/Chromium 和克制的
Linux/network debugging CLI；Worker 在 hello 前通过本机精确镜像的实际探针上报 capability，不按
architecture 猜测。Portal 现在展示 Worker/Workspace placement、能力、容量和结构化
Platform Audit Trail。Artifact 继续复用 pi-web 的 `/workspace` Files 查看/下载，不复制文件或 Pi
message/tool stream。仓库记录的 ARM64 工程验证已通过，AMD64 native 自动验证记录仍待补齐。
HTTP、SSE 与 WebSocket 仍由两级 Gateway 透明代理到原始 pi-web，不复制其
Chat、Terminal 或 streaming 实现。

## Prerequisites

- Node.js 22.20.0 或更高版本
- pnpm 11.24.0
- Docker Engine 与 Docker Compose

## Bootstrap

```bash
pnpm install
cp deploy/.env.example .env
# 将 SESSION_SECRET 替换为：openssl rand -hex 32
docker compose --env-file .env -f deploy/compose.dev.yml up -d postgres
docker build --tag agent-runtime:phase7-toolchain runtime
runtime/scripts/verify-image.sh agent-runtime:phase7-toolchain
set -a
. ./.env
set +a
pnpm db:migrate
pnpm typecheck
pnpm test
pnpm lint
pnpm test:e2e
pnpm test:e2e:runtime
```

`test:e2e` 是无需外部模型的确定性平台主链；`test:e2e:runtime` 使用本机真实 Docker image，经
pi-web bash tool 生成 Artifact，并验证 Files、Stop/Start、reconciliation 和持久化。比赛演示与
人工验收步骤见 [Phase 8 Demo Runbook](docs/demo-runbook.md)。

`verify-image.sh` 接受 `amd64` 或 `arm64`，会检查本地镜像架构，并在 non-root、无 network、
drop-all-capabilities、`no-new-privileges` 的容器中运行完整命令 smoke 和真实
Playwright/Chromium local-page JS smoke。两个架构的当前证据和验收命令见
[Runtime Capability Matrix](docs/runtime-capability-matrix.md)。

Runtime 已安装 `ping` binary，但默认 Workspace 使用 `CapDrop=ALL`，ICMP ping 可能报
`Operation not permitted`。这是预期安全限制，不应为了 ping 增加 `CAP_NET_RAW`。常规网络诊断
推荐使用 `nc`、`curl`、`dig`、`ip`、`ss`、`lsof`；smoke 只要求 `ping` 命令存在，不要求 ICMP 可用。

开发 compose 中的 PostgreSQL 使用 `restart: unless-stopped`，只保证它在宿主机 reboot、Docker daemon
恢复后随之恢复。Control Plane、Portal 与 Worker 的进程托管不属于本项；本仓库未因此新增 systemd 或
生产部署方案。

## Create local users

本地账户不开放公共注册。已有 admin 可在 Portal 的 Admin Users 页面创建普通 Local User，并执行
启停、role、密码与 session 管理。首次部署或恢复 break-glass Local Admin 时，使用以下运维命令：

```bash
export LOCAL_USER_EMAIL=user-a@example.internal
export LOCAL_USER_USERNAME=user-a
export LOCAL_USER_ROLE=user
read -rsp "Password: " LOCAL_USER_PASSWORD
export LOCAL_USER_PASSWORD
pnpm user:create
unset LOCAL_USER_PASSWORD
```

密码至少 12 个字符，以 scrypt 和随机 salt 保存。`LOCAL_USER_USERNAME` 可省略。首次创建的
break-glass 账户应将 `LOCAL_USER_ROLE` 设置为 `admin`；Admin API 会拒绝禁用或降级最后一个
`active` Local Admin。Admin Users 的创建接口固定创建普通 `user`，需要升权时再走独立 role 操作。

## Configure Phase 11 external authentication

Phase 10 的单 Generic OIDC Provider 保持不变。先在 IdP 注册 confidential client，并把 callback
精确设置为：

```text
<PORTAL_ORIGIN>/auth/oidc/callback
```

例如本地 Portal 的 callback 是 `http://127.0.0.1:5173/auth/oidc/callback`。Vite 开发代理同时转发
`/api` 与 `/auth` 到 Control Plane；生产 Portal 前置代理也必须把这两个 path 转发到 Control Plane，
且保持浏览器可见 origin 与 `PORTAL_ORIGIN` 完全一致。除 loopback HTTP 测试外，issuer 必须使用 HTTPS。

在未提交的 `.env` 中配置：

```env
AUTH_OIDC_ENABLED=true
AUTH_OIDC_PROVIDER_ID=enterprise-oidc
AUTH_OIDC_ISSUER=https://idp.example.internal/realms/enterprise
AUTH_OIDC_CLIENT_ID=agent-runtime-platform
AUTH_OIDC_CLIENT_SECRET=<server-side-client-secret>
AUTH_OIDC_AUTO_PROVISION=false
AUTH_OIDC_ALLOWED_DOMAINS=
```

`AUTH_OIDC_AUTO_PROVISION=false` 时维持 manual provisioning：Local Admin 在 Admin Users 对目标用户绑定
精确 provider + `sub`。设为 `true` 后，未知 identity 首次登录会创建 external-only Platform User，role
固定为 `user`。`AUTH_OIDC_ALLOWED_DOMAINS` 留空表示不启用域名 gate；非空时是逗号分隔的 exact domain，
JIT identity 必须提供有效 email 且 domain 完全匹配，否则 fail-closed。该 allowlist 只决定未知 identity
能否 JIT，不以 email 查找、绑定或合并既有用户。

OAuth2 + UserInfo 仅用于没有 OIDC 的企业系统，也可与 OIDC 同时启用，但两个 `provider_id` 必须不同：

```env
AUTH_OAUTH2_ENABLED=true
AUTH_OAUTH2_PROVIDER_ID=enterprise-portal
AUTH_OAUTH2_AUTHORIZATION_URL=https://portal.example.internal/oauth/authorize
AUTH_OAUTH2_TOKEN_URL=https://portal.example.internal/oauth/token
AUTH_OAUTH2_USERINFO_URL=https://portal.example.internal/oauth/userinfo
AUTH_OAUTH2_USERINFO_TOKEN_METHOD=bearer
AUTH_OAUTH2_CLIENT_ID=agent-runtime-platform
AUTH_OAUTH2_CLIENT_SECRET=<server-side-client-secret>
AUTH_OAUTH2_SCOPE=profile
AUTH_OAUTH2_SUBJECT_FIELD=attributes.workcode
AUTH_OAUTH2_USERNAME_FIELD=attributes.workcode
AUTH_OAUTH2_EMAIL_FIELD=attributes.email
AUTH_OAUTH2_DISPLAY_NAME_FIELD=attributes.displayName
AUTH_OAUTH2_AUTO_PROVISION=false
AUTH_OAUTH2_ALLOWED_DOMAINS=
```

其 callback 固定为 `<PORTAL_ORIGIN>/auth/oauth2/callback`。字段路径支持 dot-separated JSON path，
并兼容 `attributes["workcode"]` 形式；
`subject_field` 必须得到非空 string，其他已配置字段若存在也必须是 string。缺少稳定 subject、类型错误、
token/UserInfo endpoint 异常、state 不匹配都会 fail-closed。Authorization Code Flow 使用 PKCE；access
token 只在 callback 内存中用于紧接着的 UserInfo 请求，随后只保留映射后的 identity profile。
`AUTH_OAUTH2_USERINFO_TOKEN_METHOD` 默认为标准 `bearer`；只有直接对接要求
`?access_token=...` 的非标准 profile endpoint 时才显式设为 `query`。query 模式不会把 token 写入平台日志、
数据库或 Audit，但上游反向代理也必须禁记 query string。

Admin Users 可查看每个用户的 External Identities，并为当前已启用 provider 明确 bind/unbind。解绑不能
移除用户最后一个可用登录方式；Local Account 凭据继续作为可用方式，因此 break-glass Local Admin 不会
因 identity unbind 被锁死。bind/unbind 与 `identity.bound` / `identity.unbound` Audit 在同一数据库事务提交。

OIDC/OAuth2 client secret、authorization code、access/refresh/ID token 仅在 Control Plane 的协议处理
期间使用，不返回 Portal、不写 localStorage/普通日志/Audit，也不进入 Worker、managed metadata 或
Runtime。OIDC/OAuth2 不可用或配置错误时，既有 Local Admin 登录仍独立可用。Phase 11 不新增 Provider
CRUD、Organization/group RBAC、SCIM/LDAP sync，也不提前实现 Phase 12 的完整 authentication Audit。

## Single-host local development

`deploy/.env.example` is the single-host profile. Keep all listeners on loopback and use the
browser-resolvable `.localhost` wildcard:

```env
HOST=127.0.0.1
PORT=3000

GATEWAY_HOST=127.0.0.1
GATEWAY_PORT=3001

PORTAL_ORIGIN=http://127.0.0.1:5173
PORTAL_ALLOWED_ORIGINS=
WORKSPACE_BASE_URL=http://agent.localhost:3001
```

启动 Control Plane：

```bash
set -a
. ./.env
set +a
pnpm dev:control-plane
```

另一个终端启动 Portal：

```bash
pnpm dev:web
```

打开 `http://127.0.0.1:5173`。Vite 将 `/api` 代理到 `127.0.0.1:3000`；该地址必须与
canonical `PORTAL_ORIGIN` 或 `PORTAL_ALLOWED_ORIGINS` 中的一项完全匹配。Control Plane
默认还在 `127.0.0.1:3001` 启动 Workspace Gateway；开发环境使用
`http://<workspace-id>.agent.localhost:3001`。`GET /health` 是
Control Plane 进程存活检查，`GET /ready` 会验证 PostgreSQL 连接。

`*.agent.localhost` 只适合浏览器、Portal、Control Plane 和 Worker 位于同一台机器的本地开发，
不能直接复用于远端 Worker 或其他主机上的浏览器。

本地 HTTP 开发环境显式设置 `SESSION_COOKIE_SECURE=false`，使用 host-only
`platform-session` Cookie。HTTPS 部署必须设置 `SESSION_COOKIE_SECURE=true`，此时平台
使用带 `Secure`、`HttpOnly`、`SameSite=Lax` 的 `__Host-platform-session` Cookie。
所有修改状态的 API 同时校验配置的 Origin 和 session-bound CSRF token。Origin 校验始终为
完整字符串 exact-match；缺失 Origin、未列入配置的 Origin、wildcard 和 `*` 均不放行。

## Provision and run Workers

Worker 不会自行注册身份。管理员使用 Control Plane 数据库预注册每个 Worker，同时登记
只能由 Control Plane 访问的 Worker Gateway 地址。命令只输出一次 control token 和独立的
data-plane token；数据库只保存 control token 的 hash，data-plane token 分别放入 Worker
私有环境和 Control Plane 的按 Worker ID 映射：

```bash
export WORKER_ID=worker-a
export WORKER_GATEWAY_BASE_URL=http://127.0.0.1:3100
pnpm worker:provision
# 安全保存输出的 WORKER_TOKEN 与 WORKER_GATEWAY_TOKEN，然后为其他 Worker 重复一次
```

第二台 Worker 必须使用不同的 `WORKER_ID`、control/data-plane token 和 Gateway 地址；不同宿主机
可以使用相同监听端口，仅同宿主机运行多个 Worker daemon 时端口必须不同。例如预注册
`worker-c` 的受保护地址 `https://worker-c.internal:3100`，再把
其私有环境中的 `WORKER_ID=worker-c`、`WORKER_GATEWAY_HOST` 和 token 与该预注册记录对应起来。
Control Plane 的 `WORKER_GATEWAY_TOKENS_JSON` 需要同时包含 `worker-a`、`worker-c`；不要复制
第一台 Worker 的 credential。

将 `WORKER_GATEWAY_TOKEN` 写入该 Worker 的私有环境；同时把同一值放入 Control Plane
`.env` 的 JSON 映射，例如：

```env
WORKER_GATEWAY_TOKENS_JSON={"worker-a":"<worker-a-gateway-token>","worker-c":"<worker-c-gateway-token>"}
```

每个 Worker 的 `WORKER_TOKEN` 和 `WORKER_GATEWAY_TOKEN` 都必须独立。前者只认证 Worker 主动建立的
WebSocket control channel，后者只认证 Control Plane 到 Worker Gateway 的 data plane；两类 token
不得混用，不同 Worker 之间也不得复用。

为已有 Phase 3 Worker 补登记 Gateway 时使用：

```bash
export WORKER_ID=worker-a
export WORKER_GATEWAY_BASE_URL=http://127.0.0.1:3100
pnpm worker:configure-gateway
```

该命令会生成新的 `WORKER_GATEWAY_TOKEN`；更新 Worker 私有环境和 Control Plane 映射后，
重启双方进程。data-plane token 与 `WORKER_TOKEN` 不得复用。

Worker 默认将 Workspace 持久数据写入 `/var/lib/agent-runtime`。首次在一台宿主机运行 Worker
前，需要由管理员创建该目录并将其交给运行 Worker 的系统用户；Worker 本身不应以 root 身份运行：

```bash
sudo install -d \
  -o "$(id -u)" \
  -g "$(id -g)" \
  -m 0700 \
  /var/lib/agent-runtime
```

复制 `deploy/worker.env.example` 到已被 `.gitignore` 排除的 `.data/`，为每个 Worker
保留各自的私有环境文件，填入对应 ID/token 后启动；不要提交这些文件：

```bash
mkdir -p .data
cp deploy/worker.env.example .data/worker-a.env
set -a
. ./.data/worker-a.env
set +a
pnpm dev:worker
```

Worker 每次建立 control channel 时，都会先对 `RUNTIME_IMAGE` 启动一次短时、无网络且受资源/
安全约束的 capability probe。只有镜像 OS/architecture 与宿主机匹配且 probe 返回严格 typed 结果，
Worker 才发送 hello；各能力组的失败会如实上报 `false`。超时可通过
`RUNTIME_CAPABILITY_PROBE_TIMEOUT_MS` 调整，默认 120 秒。新部署的 Control Plane 和 Worker 默认
使用 `agent-runtime:phase7-toolchain` / `phase-7`；已有私有环境文件中的显式旧值不会被自动改写。

## Real multi-host development and acceptance

真实跨主机环境必须把 bind address、浏览器 canonical origin 和节点间访问地址分开配置。以下是
Phase 5 人工验收拓扑的开发示例：Control Plane/Portal 位于 `192.168.1.124`，远端
`worker-c` 位于 `192.168.1.123`。

### Control Plane and Portal host

Control Plane 的 `.env` 使用：

```env
HOST=0.0.0.0
PORT=3000

GATEWAY_HOST=0.0.0.0
GATEWAY_PORT=3001

PORTAL_ORIGIN=http://192.168.1.124:5173
PORTAL_ALLOWED_ORIGINS=http://127.0.0.1:5173,http://100.64.0.10:5173
WORKSPACE_BASE_URL=http://agent.192.168.1.124.nip.io:3001
```

- `HOST=0.0.0.0` 让远端 Worker 能主动连接 Control Plane 的 WebSocket control channel。
- `GATEWAY_HOST=0.0.0.0` 让其他主机上的浏览器能访问 Workspace Gateway。
- `PORTAL_ORIGIN` 是浏览器真正访问的 canonical origin，必须包含真实 hostname/IP 和端口；
  `0.0.0.0` 只是 bind address，不能写入 `PORTAL_ORIGIN`。
- `PORTAL_ALLOWED_ORIGINS` 可选，用逗号分隔额外可信的完整 HTTP(S) origin，例如 localhost、
  LAN IP 或 Tailscale IP 入口。每一项都执行 exact-match；不支持 hostname wildcard 或 `*`。
  canonical origin 会始终自动受信，不需要在 allowlist 中重复；同一 allowlist 同时用于
  Control Plane state-changing API 和 Workspace session exchange 的 Origin 校验。
- `WORKSPACE_BASE_URL` 必须使用客户端可解析、且指向 Control Plane Gateway 的 wildcard hostname。
  `agent.192.168.1.124.nip.io` 会让 `<workspace-id>.agent.192.168.1.124.nip.io` 解析到该主机。

Portal 当前的 `pnpm dev:web` 脚本固定监听 `127.0.0.1`。跨主机验收可在 Control Plane 主机上
临时运行下列命令；长期运行的开发服务也应把同一 `vite --host 0.0.0.0` 命令写入其进程配置：

```bash
VITE_API_PROXY_TARGET=http://127.0.0.1:3000 \
  pnpm --filter @agent-runtime/web exec vite --host 0.0.0.0
```

此处 `--host` 控制 Vite listener，`PORTAL_ORIGIN` 与可选 `PORTAL_ALLOWED_ORIGINS` 仍控制
浏览器/API 安全语义，两者不能替代 listener 配置。`nip.io` 只作为开发/验收 wildcard DNS 示例；生产环境应使用企业
内部 DNS、wildcard certificate 和受信 TLS termination，本次验收没有证明生产 TLS 已完成。

### Remote Worker

`worker-c` 的私有环境示例：

```env
CONTROL_PLANE_URL=ws://192.168.1.124:3000/api/workers/connect

WORKER_ID=worker-c
WORKER_TOKEN=<worker-c-control-token>
WORKER_GATEWAY_TOKEN=<worker-c-data-plane-token>
WORKER_GATEWAY_HOST=0.0.0.0
WORKER_GATEWAY_PORT=3100

WORKSPACE_BASE_URL=http://agent.192.168.1.124.nip.io:3001
```

在 Control Plane 主机预注册的则是 Control Plane 实际访问 Worker Gateway 的地址：

```bash
export WORKER_ID=worker-c
export WORKER_GATEWAY_BASE_URL=http://192.168.1.123:3100
pnpm worker:provision
```

`WORKER_GATEWAY_HOST` 是 Worker 本机 listener 的 bind address；`WORKER_GATEWAY_BASE_URL` 是
Control Plane 持久化并实际访问的 route。真实多主机时，后者绝不能注册成远端 Worker 自己的
`127.0.0.1`。开发期使用 `0.0.0.0` listener 时也应通过主机防火墙或受保护 LAN/VPN 限制只有
Control Plane 可达，不得把 Worker Gateway 作为用户入口。

### Multi-host troubleshooting

若 Workspace session exchange 的 `POST /_platform/session` 返回 `200`，但随后 `GET /` 返回
`404 WORKSPACE_NOT_FOUND` 或 unavailable，优先核对：

1. Workspace 绑定的 Worker ID 与数据库中预注册的 `WORKER_GATEWAY_BASE_URL`；
2. 该 Worker 的 authenticated heartbeat 是否仍在线、新鲜，且 Gateway route 从 Control Plane 可达；
3. `WORKER_GATEWAY_TOKENS_JSON` 是否使用完全相同的 Worker ID 作为 key，并匹配该 Worker 的
   `WORKER_GATEWAY_TOKEN`。

本次验收曾把 `worker-c` 的 gateway token 错写到 `worker-b` key 下，表现正是 exchange 成功、
随后 Workspace 根路径不可用。修正映射后仍应保持每个 Worker 的 control/data-plane token 相互独立。

同一 credential 不能在 `worker.hello` 中声明另一个 Worker ID。默认每 10 秒 heartbeat，
35 秒未收到服务端认可的 hello/heartbeat 后 Admin 列表显示 `OFFLINE`。轮换凭证使用：

Worker 超过 offline timeout 后，绑定其上的相关 Workspace 会持久化为 `WORKER_OFFLINE`，
Gateway 保持拒绝访问。Worker daemon 重新完成 authenticated hello 后，Control Plane 会对这些
Workspace 下发 `worker.reconcile`，其中只含该 Worker 的 PostgreSQL authoritative assignments 和
持久化 desired state。Worker 对 Docker 与 managed root 做完整只读 inventory；只有 Container、
network、metadata、bind mount、安全/资源配置、runtime image 和运行状态均能确认时才返回 observed
结果。Control Plane 在 reconciliation 开始前将该 Worker 的 Workspace 置为 `WORKER_OFFLINE`，并以
Workspace ID、Worker ID、runtime image、desired state 和当前状态为条件更新：期望运行且确认运行时
恢复 `RUNNING`，期望停止且确认停止时恢复 `STOPPED`；unexpected stop、状态相反、资源缺失或确定的
identity/config mismatch 进入 `ERROR`；Docker 暂时不可用、pi-web 暂未 ready、断线或不完整响应继续
保持 `WORKER_OFFLINE`。该流程不会改变原 `workerId`，不会迁移、隐式 ensure/start 或删除 Runtime。

Worker 会把不在 authoritative assignments 中的本地资源分类为 `MANAGED_ORPHAN`、
`FOREIGN_MANAGED_RESOURCE` 或 `UNKNOWN_RESOURCE` 并写入 Control Plane 结构化 warning；任何类别都只告警、
不自动删除。只有先前已明确进入 destructive delete、且一次完整 inventory 明确确认对应 Container、
network 和 managed directory 全部不存在时，Control Plane 才可补完成因响应丢失/重启中断的 metadata
删除。新建 Container 使用 Docker `unless-stopped` restart policy，使宿主机恢复时原本运行的 Runtime
自动恢复、原本显式停止的保持停止；Phase 5 及更早创建且缺少该 policy 的合法 legacy Container 仍可
管理，不会被自动重建或修改。

Control Plane 每次进程启动都会先把持久化为 ONLINE 的 Worker 及其已分配 Workspace 置为 offline，
避免使用重启前的 heartbeat/state 放行 Gateway；Worker 重新 hello 并完成 inventory 后才恢复。已有
session exchange code 仍是进程内短时状态，Control Plane restart 后失效，用户可重新点击“打开”。

```bash
export WORKER_ID=worker-a
pnpm worker:rotate
```

轮换会立即使旧 token 无法重连，并在旧连接的下一条消息或 heartbeat 时关闭它。生产网络
应使用 `wss://`；示例中的 `ws://127.0.0.1` 仅用于 loopback 开发。

Worker Gateway 默认仅监听 `127.0.0.1:3100`。多主机部署必须改为 Control Plane 可达、
最终用户不可达的受保护 LAN/VPN 地址，并把对应 URL 预注册为 `WORKER_GATEWAY_BASE_URL`。
开发验收可以在受保护网络使用 HTTP；生产应使用 HTTPS。可通过
`WORKER_GATEWAY_TLS_CERT_PATH` 与 `WORKER_GATEWAY_TLS_KEY_PATH` 启用原生 TLS；两项必须
同时配置。Runtime 不持有 control 或 data-plane credential。

Platform API：

```text
GET    /api/auth/methods
POST   /api/auth/login
POST   /api/auth/logout
GET    /auth/oidc/login
GET    /auth/oidc/callback
GET    /auth/oauth2/login
GET    /auth/oauth2/callback
GET    /api/me
GET    /api/workspaces
GET    /api/audit-events
POST   /api/workspaces
GET    /api/workspaces/:id
DELETE /api/workspaces/:id
POST   /api/workspaces/:id/start
POST   /api/workspaces/:id/stop
POST   /api/workspaces/:id/open
GET    /api/admin/workers
GET    /api/admin/users
POST   /api/admin/users
PATCH  /api/admin/users/:id
POST   /api/admin/users/:id/reset-password
POST   /api/admin/users/:id/revoke-sessions
GET    /api/admin/users/:id/workspaces
POST   /api/admin/users/:id/oidc-identities
GET    /api/admin/users/:id/identities
POST   /api/admin/users/:id/identities
DELETE /api/admin/users/:id/identities/:identityId
WS     /api/workers/connect
```

所有 Admin Users 写操作都要求 active admin session、exact-match Portal Origin 与 session-bound CSRF。
`disabled` User 不能登录；disable/revoke 后 Portal 与 Workspace Host 的 Cookie 会在服务端立即失效，
已建立的 Workspace WebSocket 也会被断开。User 管理 API 不提供 destructive delete 或 Workspace
ownership 改写。

Phase 11 identity 管理只允许 active admin；写操作要求 exact-match Portal Origin 与 session-bound CSRF，
且 `providerId` 必须属于当前启用的 OIDC/OAuth2 provider。旧的 OIDC 预绑定 path 保留兼容，新的通用
identity API 支持 list/bind/unbind；平台仍不提供 Provider CRUD 或基于 email 的自动绑定。

首次启动会从当前 Control Plane 已认证连接、在线、enabled、heartbeat 新鲜、容量未满且
Runtime image/架构/capability 兼容的 Worker 中选择。load score 为 PostgreSQL 中该 Worker 的
sticky Workspace assignment 数除以 `max_workspaces`，最低者优先，相同 score 按 Worker ID
升序确定性选择。capacity 的 authoritative source 是 `workspaces.worker_id` assignment count；
heartbeat 的 `allocated_workspaces` 只作为 Worker 本机观测，不参与 reservation。选择和写入
`worker_id` 在同一 PostgreSQL placement transaction 中完成，因此并发首次启动不能共同占用
最后一个 slot。Admin Worker 表的 `Workspace` 列显示 authoritative assignment/max，悬停可看
最近 heartbeat 上报的 Runtime 数。

Workspace 一旦拥有 `workerId` 就保持 sticky placement；stop、Worker offline/reconnect、Runtime
错误或 Worker capability 变化都不会触发 Scheduler 自动迁移。已分配 Workspace 的删除必须等待
原 Worker 明确确认 managed Container、独立 network 与持久目录均已删除，Control Plane 才删除
metadata 并释放该 assignment。

平台把 `/workspace` 固定为 Workspace 的 persistent project root。Runtime image 和 Worker
Container 都显式设置 working directory `/workspace`；针对 pinned pi-web 0.9.0 的小型构建期 patch
让 `PI_WEB_DEFAULT_CWD=/workspace` 成为新 Pi Session 的默认 cwd，并由原路由把它加入合法 file
root。Session JSONL 的 header 记录 `cwd: "/workspace"`，文件本身继续持久化在
`PI_CODING_AGENT_DIR=/agent/pi`。平台只承诺 `/workspace` 与 `/agent/pi` 两个 managed bind mount，
不持久化整个 `/home/agent`；未设置该环境变量时 patch 保留上游 `~/pi-cwd-YYYYMMDD` fallback。

升级兼容性：在引入 `PI_WEB_DEFAULT_CWD` 前创建、但仍满足完整 managed ownership/security
identity 的 Container 会作为 legacy Runtime 继续支持 ensure/start/inspect/stop/Gateway/delete，
不会被自动重建或删除。它仍保留创建时的 pi-web default-cwd 行为；只有新建 Container 才获得并
严格验证当前 `/workspace` 配置。若 Container 显式设置了冲突的 `PI_WEB_DEFAULT_CWD`，Worker
拒绝 ensure/start/Gateway，但仍允许 inspect/stop/delete，以便安全完成生命周期清理。正常
destructive delete 得到 Worker 确认后，Control Plane 才删除 metadata 并释放 sticky assignment；
需要当前 baseline 时应由用户明确删除旧 Workspace 后新建，不会触碰未授权的持久数据。

Runtime 诊断时，仍可在 Worker 宿主机用下面的命令查看仅绑定 loopback 的端口：

```bash
docker port agent-runtime-<workspace-uuid> 30141/tcp
```

该地址只用于本机诊断，不是最终用户入口，不应暴露到 LAN。正常用户从 Portal 点击“打开”，Portal
会立即保留当前列表页并预开一个新浏览器标签页，再签发 60 秒内有效、单次使用且绑定 user/workspace
的 exchange code，并在新标签页以 top-level POST 进入 Workspace Host。Gateway 随后为该 Host 设置
host-only session Cookie；原始 code
不会进入 query string、pi-web 或 Referer。exchange 响应是一个禁止缓存、禁止嵌入并带严格
CSP 的最小 Workspace-origin bootstrap 页面；它使用 `location.replace("/")` 发起新的同源导航，
而不是用 HTTP redirect 延续 Portal 发起的跨站导航链。Gateway 因此仍可拒绝所有进入 pi-web
的 cross-site fetch、XHR、subresource 与 iframe 请求。

生产部署需为 `WORKSPACE_BASE_URL` 配置内部 wildcard DNS 和 wildcard certificate，并把
Workspace Host 原样保留 `Host` 转发到 `GATEWAY_HOST:GATEWAY_PORT`；前置代理还必须允许
WebSocket upgrade、关闭响应缓冲并为 SSE/长连接配置合适的 timeout。公开 Gateway 本身默认
提供 HTTP listener，HTTPS 应由受信反向代理终止；不要把 Worker Gateway 或 pi-web loopback
endpoint 暴露给用户。

架构与安全边界以 [AGENTS.md](AGENTS.md) 为长期规则，以 [specs.md](specs.md)
为产品范围和分阶段验收规范。当前状态见 [docs/progress.md](docs/progress.md)。
