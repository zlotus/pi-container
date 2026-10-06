# Workspace Egress Runbook

Phase 14（`specs.md` 第 64 节 Phase 14）的运维说明：Workspace 默认可以访问公网，不能访问内网与 Worker
宿主机；内网目标由管理员在 Portal“网络出口”页面按网段/端口放行；平台管理地址永远不可放行。规则无法
确认生效时 fail-closed：不启动 Workspace、关闭 Gateway、停止正在运行的 Workspace（数据保留）。

这是基础的出口控制，不是零信任网络隔离；不做域名级策略、DNS 过滤或流量审计。

## 1. 组成

| 组件 | 位置 | 作用 |
|---|---|---|
| 平台独占的 nftables 表 | `table inet agent_runtime` | 只匹配 `arw-*` Workspace bridge 的入口流量；不修改 Docker、Tailscale 等其他表 |
| Worker egress controller | `apps/worker/src/egress/` | 以 `nft -j -f <临时文件>` 原子替换整张表，读回校验，随心跳检查漂移并修复 |
| 开机加载 unit | `deploy/egress/agent-runtime-egress.service` | 在 `docker.service` 之前加载 Worker 最近一次校验通过的规则快照，失败时加载基础规则 |
| 基础规则 | `deploy/egress/agent-runtime-egress.nft` | 拒绝宿主机、RFC1918 与全部 IPv6，无白名单 |
| 规则快照 | `${WORKER_MANAGED_ROOT}/egress/{policy.json,ruleset.json}` | 最近一次应用的策略与完整 nft 事务（root 开机加载） |
| 策略与审计 | PostgreSQL `egress_rules`、`egress_policy_state`；Audit `egress.*`、`worker.egress_*` | Control Plane 保存并下发给所有 Worker |

Workspace bridge 名为 `arw-<Workspace UUID 去掉连字符后的前 11 位>`（agent-runtime workspace）。

## 2. 配置

Worker：

```bash
# 额外的平台保护地址（逗号分隔的 IPv4 地址或 CIDR）。Worker 已自动保护 CONTROL_PLANE_URL 的地址
# 与宿主机自身的全部地址；这里填写其他不得被放行的平台组件，例如远端 PostgreSQL。
WORKER_EGRESS_PROTECTED=
# nft 可执行文件
WORKER_EGRESS_NFT_PATH=/usr/sbin/nft
```

Control Plane：

```bash
# 平台保护地址；DATABASE_URL 主机的 IPv4 地址会被自动加入。
PLATFORM_EGRESS_PROTECTED=
```

主机名在每次下发策略时解析，生产环境建议直接配置 IP 地址。

## 3. 安装（每台 Worker 宿主机，root 执行一次）

```bash
sudo apt-get install -y nftables          # 只需要 nft 命令，不需要启用 nftables.service
sudo install -D -m 0644 deploy/egress/agent-runtime-egress.nft /etc/agent-runtime/egress-base.nft
sudo install -m 0644 deploy/egress/agent-runtime-egress.service /etc/systemd/system/
# WORKER_MANAGED_ROOT 不是 /var/lib/agent-runtime 时，先修改 unit 中 ruleset.json 的路径。
sudo systemctl daemon-reload
sudo systemctl enable --now agent-runtime-egress.service
sudo nft list table inet agent_runtime    # 应看到 ws_prerouting / ws_forward 两条链
```

不要启用发行版自带的 `nftables.service`：Ubuntu 默认的 `/etc/nftables.conf` 以 `flush ruleset` 开头，
会清除平台表（以及 Docker 的规则）。如果已经启用，Worker 会在一个心跳周期内发现并恢复平台表，但
Docker 的规则需要重启 Docker 才会恢复。

## 4. 运行 Worker

Worker 需要 `CAP_NET_ADMIN` 才能管理平台表；它仍以普通用户（docker 组）运行，不使用 root。docker 组
本身已等价于 root，增加这一项 capability 不扩大 Worker 的实际权限面。

生产（Phase 19 提供完整 unit）：

```ini
[Service]
User=agent-runtime
SupplementaryGroups=docker
AmbientCapabilities=CAP_NET_ADMIN
CapabilityBoundingSet=CAP_NET_ADMIN
```

开发：

```bash
tools/dev/run-worker-with-egress.sh .data/worker-a.env
# 确认 capability 已生效（CapAmb 应包含 0x1000，即 cap_net_admin）：
grep CapAmb /proc/$(pgrep -f 'apps/worker.*src/server.ts' | head -1)/status
```

不带 `CAP_NET_ADMIN` 启动时 Worker 仍会连接 Control Plane，但上报“出口控制未生效”，拒绝启动任何
Workspace，并停止已在运行的 Workspace。日志：`egress rules are not enforced`，`reason` 中包含
`Operation not permitted`。

## 5. 验证

```bash
sudo nft list table inet agent_runtime          # 规则内容
ls -l /var/lib/agent-runtime/egress/            # policy.json / ruleset.json
tools/dev/egress-probe.sh <workspace-id>        # 在 Workspace 内按应用层响应判定可达性
```

Portal：Admin“Worker”页的“出口控制”列、“网络出口”页的各 Worker 已应用版本。

`egress-probe.sh` 的结果：`REACHABLE`（收到应用层数据）、`BLOCKED`（连接失败或超时，即被规则拒绝）、
`HANDSHAKE_ONLY`（握手成功但无数据：通常是 Clash TUN 代答，视为不可达）。

## 6. 升级到 Phase 14

1. 升级前停止全部 Workspace（Portal 中逐个停止）。
2. 同时升级 Control Plane 与所有 Worker：Worker 协议升到 v2，Control Plane 拒绝 v1 Worker。
3. 在每台 Worker 宿主机完成第 3 节安装，并按第 4 节带 `CAP_NET_ADMIN` 启动 Worker。
4. 再次启动 Workspace 时，Worker 把旧的 `br-<id>` 网络原地迁移为 `arw-` bridge，文件与 Pi Session 不变。

升级时仍在运行的旧网络 Workspace 会在 reconciliation 中被停止并置为“异常”
（`EGRESS_NETWORK_LEGACY`），用户重新启动即可完成迁移。

## 7. 故障处理

| 现象 | 处理 |
|---|---|
| 启动 Workspace 返回“Worker 网络出口规则未生效” | 查看该 Worker 日志中 `egress rules are not enforced` 的 `reason`；常见原因是缺少 `CAP_NET_ADMIN` 或未安装 `nft` |
| Worker 日志 `egress rules were missing or changed and have been re-applied` | 有人或其他服务清除/修改了平台表（例如 `nft flush ruleset`）。确认来源，避免重复发生 |
| “网络出口”页某 Worker 版本显示“待更新” | 该 Worker 离线或应用失败；它重连时会自动获取最新策略。在此期间它不接受新的 Workspace 分配 |
| 删除拒绝网段时提示仍有放行规则依赖 | 先删除位于该网段内的放行规则 |
| 添加放行规则提示包含平台保护地址 | 缩小网段，避开“平台保护地址”列表中的地址 |

需要收集的信息：Worker 日志（`journalctl` 或终端输出）、`sudo nft -j list table inet agent_runtime`、
`ip -br link | grep arw-`、`docker network inspect agent-runtime-<workspace-id>`、Portal“网络出口”页截图。

## 8. 开发环境：Clash Verge 与 Tailscale

两者只存在于开发设备，默认规则不针对它们（`docs/v1-roadmap.md` 决策 D3）。

- Clash 的代理端口（如 `7897`）和 DNS（`53`）、Tailscale 地址都属于宿主机地址，Workspace 无法连接。
- 以 IP 地址访问内网时，规则在流量进入 Clash TUN 之前生效。
- fake-ip 模式下，以**域名**访问内网主机时，连接由 mihomo 在宿主机上发起，平台规则看不到真实目的地址，
  可能被绕过。需要验证“内网域名”场景时，把 mihomo `dns.enhanced-mode` 改为 `redir-host`，或关闭 TUN。
- TUN 会为任意目的地址完成 TCP 握手，所以用 `egress-probe.sh` 而不是“能否 connect”判断可达性。
- Tailscale 的 `100.64.0.0/10` 默认不拒绝；需要时在“网络出口”页追加拒绝网段。Control Plane 经 Tailscale
  连接时，其 `100.x` 地址由 Worker 自动保护。
- Worker 启动日志会提示检测到的 TUN 默认路由与 Tailscale 接口。
