# 31 安全

## 1. 安全边界（可以这样描述）

- 基于 Docker 的 Workspace 隔离：非特权、无 capability（`--cap-drop ALL`、`no-new-privileges`）、只读根文件系统、非 root 用户、独立网络、
  CPU/内存/进程数上限、磁盘配额；容器内没有 Docker socket，也没有任何平台凭据。
- 内网默认拒绝的出口控制：Workspace 可访问公网，不能访问 RFC1918、Worker 主机、平台地址与 IPv6；内网按白名单放行，平台地址永远不能放行。
- 经认证的反向代理：每个 Workspace 请求与 WebSocket 都校验会话、所有权、Worker 状态；Workspace 地址（UUID）不是凭据。
- 全部跨主机链路使用 TLS；平台服务只监听 loopback，nginx 是唯一入口；Worker 控制通道与模型网关只对 Worker 地址开放。
- 应用层授权：普通用户只能操作自己的 Workspace；管理员不能打开他人的 Workspace。
- 企业身份认证（OIDC / OAuth2）只决定“是谁”；授权、禁用与角色由平台决定，外部身份默认不会成为管理员。

**不要宣称**：VM 级隔离、防御任意恶意代码、零信任沙箱、能阻止所有容器逃逸、面向公众的任意代码执行云。平台面向**可信企业内部用户之间**
的隔离。

## 2. 已知限制与运维要求

| 项 | 说明 | 要求 |
|---|---|---|
| Workspace 的 UID 1000 | Workspace 进程在宿主机上以 UID 1000 运行；若该 UID 属于有登录或 sudo 权限的账户，容器逃逸后可写该账户的文件 | Worker 主机上不要让 UID/GID 1000 属于管理员账户（新装系统时先建一个其他 UID 的管理员）；`audit-host.sh` 会告警 |
| Worker 的权限 | Worker 用户在 docker 组（等价于 root），另有 `NET_ADMIN SYS_ADMIN CHOWN FOWNER DAC_OVERRIDE`；`systemd-analyze security` 评分 5.3（MEDIUM），主要来自这些必要权限 | Worker 主机只运行平台，不给他人登录 |
| 非内网地址的 Worker | 出口规则默认只拒绝 RFC1918；Worker 若在 CGNAT（含 Tailscale `100.64.0.0/10`）或公网地址上，必须把每台 Worker 的地址写进 `PLATFORM_EGRESS_PROTECTED`，否则 Workspace 能连到其他 Worker 的 Gateway 端口（仍需 token） | [10](10-operations.md) 第 4、6 节 |
| 主机防火墙 | 平台不管理主机防火墙；nginx 已按地址白名单拒绝 8443/8444 的非 Worker 访问（HTTP 403），但端口在 TCP 层仍可达 | 按 [01](01-planning.md) 第 1 节配置防火墙 |
| 单实例 Control Plane | 会话交换码、SSO 登录过程、连接注册表都在进程内存中；重启会使正在进行的 SSO 登录失败、打开的 Workspace 连接中断 | 正常现象，刷新即可 |
| 备份含敏感数据 | 数据库、受管根（含虚拟 key 文件）、`/etc/agent-runtime` | 备份加密、限制访问（[21](21-backup-restore.md)） |

## 3. 发布前安全复查清单

每次正式发布前在目标环境执行，结果存档。第 4 节为 v1.0 的记录。

1. **端口**：从用户网络、Worker 网络各探测 Control Plane 与 Worker 主机，只出现 [90](90-reference.md) 第 6 节的预期端口。
2. **TLS**：只接受 TLS 1.2/1.3；证书链与 SAN 正确；Portal 有 HSTS；80 只做跳转。
3. **Cookie 与响应头**：Portal 会话 Cookie 为 `__Host-`、`Secure`、`HttpOnly`、`SameSite=Lax`、无 `Domain`；Portal 有 CSP、`frame-ancestors 'none'`、
   `nosniff`、`no-referrer`。
4. **入口路径**：公开入口上 `/api/workers/connect` 为 404；8444 上只有推理路径（`/key/generate`、`/metrics` 等为 404）；非白名单地址访问 8443/8444 为 403。
5. **日志**：触发登录、SSO 回调、打开 Workspace 后，journald 与 nginx 日志中没有 query string、Cookie、token、口令、数据库口令。
6. **密钥文件**：`/etc/agent-runtime` 下 env、私钥的属主与权限；进程命令行中没有密钥。
7. **进程权限**：Control Plane 无 capability；Worker 的 capability 恰为上表；均非 root。
8. **容器基线**：`audit-host.sh` 在每台主机 0 失败。
9. **出口**：在 Workspace 中访问 Control Plane 主机各端口、Worker Gateway、内网网关均被拒绝，公网可达，平台模型可用。
10. **依赖漏洞**：对发布包、Runtime 镜像与第三方镜像做漏洞扫描（第 5 节），HIGH/CRITICAL 逐项分级。
11. **Break-glass**：IdP 不可用时本地管理员能登录。
12. **表述**：文档与发布说明符合第 1 节，不夸大隔离强度；AMD64 只标注为“CI 证据”。

## 4. v1.0 复查记录（2026-10-21，worker-a 与 worker-c 部署）

| # | 结果 |
|---|---|
| 1 | worker-a：用户网络只有 80、443；8443/8444 只在 Worker 网络地址上监听；3000/3001/3100/3200/3201/4400/4410/5432/5442/9464/9465 均不可达。worker-c：80、443、8443、8444 可达（单机形态，内外入口同一地址），其余平台端口不可达。（实验环境的 Tailscale 地址 443 是开发用 Keycloak 的 `tailscale serve`，与平台无关） |
| 2 | TLS 1.2、1.3 可用，更低版本被拒；证书由内部 CA 签发且 SAN 正确；HSTS `max-age=31536000`；`http://` 301 到 `https://` |
| 3 | `__Host-platform-session`，`Secure; HttpOnly; SameSite=Lax`，无 `Domain`；Portal 页面 CSP、`X-Frame-Options: DENY`、`nosniff`、`no-referrer` 齐全 |
| 4 | 公开 `/api/workers/connect` 404；白名单内地址访问 8443 根路径 404，非白名单地址 403；8444 路径白名单由自动测试覆盖（`pnpm test:deploy`） |
| 5 | 两天的 Control Plane 与 Worker 日志（约 2.8 万行）与 nginx 日志中，master key、会话 Cookie、Bearer token、OAuth code、`access_token`、数据库口令出现次数均为 0 |
| 6 | 全部 env 文件 0640（root:服务组）或 0600，私钥 0600/0640；进程命令行不含密钥 |
| 7 | Control Plane：`agent-runtime-cp`，CapEff/CapBnd 为 0，`systemd-analyze security` 1.7（OK）；Worker：`agent-runtime`，恰为五项 capability，5.3（MEDIUM，见第 2 节） |
| 8 | 两台主机 `audit-host.sh` 0 失败（仅 UID 1000 告警） |
| 9 | 两台 Worker 上的 Workspace：Control Plane 主机 443/8443/8444、Worker Gateway、内网网关均 BLOCKED，公网 200，平台模型经中继鉴权成功 |
| 10 | 见第 5 节 |
| 11 | 本地管理员登录不依赖 IdP（演练环境未在生产部署上接入 IdP；OIDC 校验由自动测试与 Phase 12 验收覆盖） |
| 12 | 文档复核于发布前完成 |

## 5. 漏洞扫描（Trivy 0.76.0，HIGH/CRITICAL，2026-10-21）

| 对象 | CRITICAL | HIGH | 结论 |
|---|---|---|---|
| 平台发布包（Control Plane、Worker 的全部依赖与内置 Node 24.22.0） | 0 | 0 | — |
| nginx `1.30.6-alpine` | 0 | 2 | `libexpat`、`libx11`（模板未使用 XML/X11 相关模块）；随官方 `stable-alpine` 更新升级 |
| PostgreSQL `17.6-alpine` | 3 | 51 | OpenSSL（`libcrypto3`/`libssl3` 3.5.4 → 3.5.6）与 `gosu` 的 Go 标准库；PostgreSQL 只监听 loopback。建议升级到最新的 17.x 补丁镜像（小版本，数据兼容） |
| LiteLLM `1.104.1` | 1 | 4 | `certifi` CA 证书包过期等 Python 依赖；只监听 loopback 与受限的 8444。随 LiteLLM 升级处理（需按 Phase 16 流程验证） |
| Runtime 镜像 `2026.10-pi1.1` | 35 | 747 | 主要是 Debian 12 基础包（其中 182 项已有修复版本，其余上游未修复）、镜像内 npm 自带的 `tar` 等、`uv` 0.12.13。Workspace 内本就允许用户运行任意代码，这些漏洞主要影响用户自己的环境；按 [lifecycle-runbook](../lifecycle-runbook.md) 1.x 的节奏做基础层刷新（新 tag），与 pi-web/Pi 升级分开 |

复现：`docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:0.76.0 image --scanners vuln --severity HIGH,CRITICAL <镜像>`；
发布包：`trivy fs` 扫描解包后的目录。
