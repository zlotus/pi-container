# 04 部署 Worker 主机

每台 Worker 一遍。前置：03 已完成（注册 Worker 在 Control Plane 主机上执行）。

所有命令以有 sudo 权限的管理员执行。示例名字：`portal.ar.internal`、`*.agent.ar.internal`；Control Plane 用户入口地址
`192.168.1.124`、内部入口地址 `100.112.169.46`；Worker `worker-c`，地址 `100.115.94.58`。替换为你的环境。

## 1. Worker 主机

### 1.1 前置

```bash
sudo apt-get install -y nftables xfsprogs zstd
sudo systemctl disable --now nftables.service 2>/dev/null || true   # 发行版的 nftables.service 会 flush ruleset，不要启用
```

受管根：按 [storage-runbook.md](../storage-runbook.md) 第 3 节（独立磁盘/LV）或第 4 节（loop 镜像）准备挂载在 `/var/lib/agent-runtime`
的 XFS（`prjquota`，挂载早于 Docker）。确认：`findmnt -T /var/lib/agent-runtime` 为 `xfs` 且选项含 `prjquota`。

### 1.2 用户、发布包与出口规则

```bash
sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin agent-runtime
sudo usermod -aG docker agent-runtime
sudo chown agent-runtime:agent-runtime /var/lib/agent-runtime && sudo chmod 0755 /var/lib/agent-runtime
# 发布包（同 03 第 1.1 节的 release.sh 两步）
sudo /tmp/release.sh install ~/release/agent-runtime-$V-linux-arm64.tar.gz && sudo /tmp/release.sh activate $V
for b in agent-runtime-image migrate-legacy-workspace; do sudo ln -sfn /opt/agent-runtime/current/bin/$b /usr/local/bin/$b; done
C=/opt/agent-runtime/current/deploy
sudo install -D -m 0644 $C/egress/agent-runtime-egress.nft /etc/agent-runtime/egress-base.nft
sudo install -m 0644 $C/egress/agent-runtime-egress.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now agent-runtime-egress.service
sudo nft list table inet agent_runtime | head -3       # 平台表；只过滤 Workspace 网桥（arw-*），不影响主机自身流量
```

### 1.3 Runtime 镜像

```bash
sudo agent-runtime-image load ~/release/agent-runtime_<tag>_linux-arm64.tar.zst    # 校验 sha256，输出 RUNTIME_IMAGES 项
```

### 1.4 注册 Worker（在 Control Plane 主机上）

```bash
# 输出含两个 token，只出现一次：写进 root-only 文件，不要贴进聊天或工单
sudo bash -c 'umask 077; WORKER_ID=worker-c WORKER_GATEWAY_BASE_URL=https://100.115.94.58:3100 \
  agent-runtime-ctl worker:provision > /root/worker-c.provision'
# Control Plane 用 WORKER_GATEWAY_TOKEN 访问该 Worker：加入 control-plane.secrets.env 的
#   WORKER_GATEWAY_TOKENS_JSON={"worker-c":"<WORKER_GATEWAY_TOKEN>"}  （多台 Worker 写在同一个 JSON 中）
sudo nano /etc/agent-runtime/control-plane.secrets.env
sudo systemctl restart agent-runtime-control-plane
```

把 `/root/worker-c.provision` 与该 Worker 的 Gateway 证书、私钥、根证书经 root 通道拷到 Worker 主机，例如：

```bash
sudo tar -C / -cf - root/worker-c.provision etc/agent-runtime/ca/ca.crt \
  etc/agent-runtime/ca/issued/worker-c-gateway.crt etc/agent-runtime/ca/issued/worker-c-gateway.key \
  | ssh admin@100.115.94.58 'sudo bash -c "umask 077; mkdir -p /root/incoming && tar -C /root/incoming -xf -"'
```

### 1.5 Worker 配置与证书（在 Worker 主机上）

```bash
I=/root/incoming
sudo install -d -m 0755 /etc/agent-runtime/tls
sudo install -m 0644 $I/etc/agent-runtime/ca/ca.crt /etc/agent-runtime/tls/internal-ca.crt
sudo install -m 0644 $I/etc/agent-runtime/ca/issued/worker-c-gateway.crt /etc/agent-runtime/tls/worker-gateway.crt
sudo install -m 0640 -o root -g agent-runtime $I/etc/agent-runtime/ca/issued/worker-c-gateway.key /etc/agent-runtime/tls/worker-gateway.key
sudo install -m 0640 -o root -g agent-runtime $C/env/worker.env.example /etc/agent-runtime/worker.env
sudo nano /etc/agent-runtime/worker.env   # CONTROL_PLANE_URL、WORKER_ID、两个 token（来自 $I/root/worker-c.provision）、
                                          # WORKER_GATEWAY_HOST、WORKSPACE_BASE_URL、RUNTIME_IMAGES、WORKER_MODEL_GATEWAY_URL
sudo shred -u $I/root/worker-c.provision   # 写入后删除
sudo -u agent-runtime /opt/agent-runtime/current/bin/node --env-file=/etc/agent-runtime/worker.env \
  /opt/agent-runtime/current/app/worker/server.mjs --check-config
```

### 1.6 启动

```bash
sudo install -m 0644 $C/systemd/agent-runtime-worker.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now agent-runtime-worker
journalctl -u agent-runtime-worker -n 30 -o cat      # control channel connected；无 error
sudo $C/scripts/audit-host.sh
```

Portal → Worker：该 Worker `在线`、版本与平台一致、出口控制与磁盘配额“已生效”、镜像 capability 全部为真。之后在 Portal 新建
Workspace 并打开，确认 Prompt、Terminal、Files 正常。

### 1.7 单机部署

Control Plane 与 Worker 在同一主机时：两种角色各自的用户、配置与 unit 都按上文安装；`CONTROL_PLANE_URL` 与
`WORKER_MODEL_GATEWAY_URL` 指向本机的内部入口（证书 SAN 包含该地址），`WORKER_GATEWAY_HOST=127.0.0.1`、
`WORKER_GATEWAY_BASE_URL=https://127.0.0.1:3100`（Gateway 证书签 `IP:127.0.0.1`）。
