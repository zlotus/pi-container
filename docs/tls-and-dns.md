# TLS 与 DNS

`specs.md` 19.6、19.6.1。本文说明生产部署需要哪些名字、哪些证书、链路怎样加密，以及在没有企业 PKI、没有可用 DNS 的环境中
怎样用平台自带的 `internal-ca.sh` 与 dnsmasq 完成。已有企业 PKI 或 DNS（如 Windows AD）时，只需把对应文件和记录换成企业的。

## 1. 名字与地址

以域名 `ar.internal` 为例（`.internal` 是 ICANN 保留的私有用途顶级域，不会与公网冲突）：

| 名字 | 解析到 | 用途 | 谁访问 |
|---|---|---|---|
| `portal.ar.internal` | Control Plane 主机在用户网络中的地址 | Portal、`/api`、`/auth`（SSO 回调） | 用户浏览器 |
| `*.agent.ar.internal` | 同上 | 每个 Workspace：`<workspace-id>.agent.ar.internal` | 用户浏览器 |
| （内部入口）`cp.ar.internal` 或直接用 IP | Control Plane 主机在 Worker 网络中的地址 | 8443 控制通道、8444 模型网关 | Worker |
| （每台 Worker）名字或 IP | Worker 在 Control Plane 可达网络中的地址 | Worker Gateway 3100 | Control Plane |

- `WORKSPACE_BASE_URL=https://agent.ar.internal`、`PORTAL_ORIGIN=https://portal.ar.internal`，二者必须与证书、DNS 一致。
- Workspace 名字是**一级通配**：`<uuid>.agent.ar.internal`。证书的 `*.agent.ar.internal` 恰好覆盖，不能再多一级。
- 内部入口与 Worker Gateway 可以直接用 IP（证书签 IP SAN），这样 Worker 与 Control Plane 互访不依赖 DNS。

## 2. 哪些链路加密

原则：**离开本机的链路都加密，只在 loopback 或本机网桥上的链路不加密。**

| 链路 | 加密 | 证书 / 信任方 |
|---|---|---|
| 浏览器 → nginx 443 | 是 | ① 用户入口证书；浏览器/操作系统信任内部根 CA |
| Worker → nginx 8443、8444 | 是 | ② 内部入口证书；Worker 以 `NODE_EXTRA_CA_CERTS` 信任 |
| Control Plane → Worker Gateway 3100 | 是 | ③ 每台 Worker 一张；Control Plane 以 `NODE_EXTRA_CA_CERTS` 信任 |
| LiteLLM → 模型服务商 | 是 | 服务商的公网证书 |
| nginx → Control Plane、Control Plane → PostgreSQL / LiteLLM | 否 | 都在 Control Plane 主机 127.0.0.1 |
| Worker Gateway → pi-web、Workspace → 本机模型中继 | 否 | 都在 Worker 主机内；容器里没有任何凭据 |

## 3. 用 internal-ca.sh 签发证书

在 Control Plane 主机上以 root 执行（发布包中 `deploy/scripts/internal-ca.sh`）。**SAN 列表要加引号**，否则 shell 会把 `*` 当通配符。

```bash
S=/opt/agent-runtime/current/deploy/scripts
# 0. 根 CA（一次；10 年）。ca.key 只留在 /etc/agent-runtime/ca（root 0700），离线备份
sudo $S/internal-ca.sh init
# 1. 用户入口（nginx 443）
sudo $S/internal-ca.sh issue /etc/agent-runtime/tls/public 'DNS:portal.ar.internal,DNS:*.agent.ar.internal'
# 2. 内部入口（nginx 8443/8444）：Worker 连接时使用的名字或 IP
sudo $S/internal-ca.sh issue /etc/agent-runtime/tls/internal 'IP:100.112.169.46'
# 3. 每台 Worker 的 Gateway：WORKER_GATEWAY_BASE_URL 中的名字或 IP；签好后拷到该 Worker
sudo $S/internal-ca.sh issue /etc/agent-runtime/ca/issued/worker-c-gateway 'IP:100.115.94.58'
# 根证书给 Control Plane 自己（信任 Worker Gateway）；目录需对服务用户可读
sudo install -m 0644 /etc/agent-runtime/ca/ca.crt /etc/agent-runtime/tls/internal-ca.crt
sudo chmod 0755 /etc/agent-runtime/tls
```

Worker 主机上需要：`/etc/agent-runtime/tls/internal-ca.crt`（同一根证书）、`worker-gateway.crt`、`worker-gateway.key`
（`root:agent-runtime 0640`）。拷贝时私钥只经 root 到 root 的通道（例如 `sudo tar ... | ssh ... sudo tar -x`），不要放进共享目录。

**续期**：服务器证书 397 天。到期前 30 天内用同一命令重签（旧文件保留为 `*.old`），然后
`docker compose -p agent-runtime-prod -f /etc/agent-runtime/compose.yml restart nginx`；Worker Gateway 证书重签后重启该 Worker。
检查到期时间：

```bash
for f in /etc/agent-runtime/tls/*.crt; do echo "$f $(openssl x509 -in "$f" -noout -enddate)"; done
```

## 4. 让客户端信任根证书

把 `/etc/agent-runtime/ca/ca.crt`（公开内容）分发给用户设备：

- **Ubuntu / Debian**：`sudo cp ca.crt /usr/local/share/ca-certificates/agent-runtime-ca.crt && sudo update-ca-certificates`。
  Chrome/Chromium 使用 NSS 数据库，另执行：`certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "Agent Runtime CA" -i ca.crt`
  （`libnss3-tools` 提供 `certutil`）。
- **Firefox**：使用自己配置目录中的证书库，**不读 Linux 系统证书库**（`security.enterprise_roots.enabled` 只在 Windows/macOS 上读取系统库）。
  - 界面：设置 → 隐私与安全 → 证书 → 查看证书 → 证书颁发机构 → 导入 → **选择 `ca.crt` 文件后**才会弹出“信任由此证书颁发机构来标识网站”，
    勾选后确定。文件选择框可能读不到 `/etc` 下的文件（snap 版 Firefox 尤其如此），先把证书拷到 `~/Downloads`。
  - 命令行（Linux）：找到配置目录 `find ~ -name cert9.db -path '*firefox*'`（deb 版 ESR 为 `~/.mozilla/firefox-esr/<profile>/`，snap 版为
    `~/snap/firefox/common/.mozilla/firefox/<profile>/`），然后
    `certutil -d sql:<该目录> -A -t "C,," -n "Agent Runtime CA" -i ca.crt`。之后**完全退出 Firefox 再打开**（运行中的 Firefox 不会重新读取）。
- **Windows**：双击 `ca.crt` → 安装证书 → 本地计算机 → “受信任的根证书颁发机构”；域环境用组策略分发（第 6 节）。
- **macOS**：钥匙串访问 → 系统 → 导入 → 双击证书 → 信任 → “始终信任”。

验证（在客户端）：`openssl s_client -connect portal.ar.internal:443 -servername portal.ar.internal -CAfile ca.crt </dev/null | grep Verify`
应为 `Verify return code: 0 (ok)`。

## 5. dnsmasq（没有企业 DNS 时）

dnsmasq 是一个很小的 DNS 服务器；这里只用它回答 `ar.internal` 下的名字，其他查询转给上游 DNS。

### 5.1 选主机与地址

放在任意一台用户设备能访问的常开主机上。注意：

- 如果该主机已有程序占用 53 端口（`systemd-resolved` 占 127.0.0.53/127.0.0.54；Clash TUN 常占 `*:53`），dnsmasq 只能绑定其他地址，
  例如该主机的局域网或 Tailscale 地址。检查：`sudo ss -lunp | grep ':53 '`。
- 本实验环境：Control Plane 主机 worker-a 的 53 被 Clash TUN 占用，因此 dnsmasq 放在 worker-c，只绑定 `100.115.94.58`。

### 5.2 安装与配置

```bash
sudo apt-get install -y dnsmasq-base     # 只要程序，不启用发行版的 dnsmasq.service（它会尝试占用所有地址的 53）
sudo install -d /etc/agent-runtime
sudo tee /etc/agent-runtime/dnsmasq.conf >/dev/null <<'EOF'
# 只监听这个地址，不读 /etc/hosts 与 /etc/resolv.conf 之外的东西
listen-address=100.115.94.58
bind-interfaces
port=53
no-hosts
# portal.ar.internal 与任意 <x>.agent.ar.internal（含多级）都解析到 Control Plane 的用户入口地址
address=/portal.ar.internal/192.168.1.124
address=/agent.ar.internal/192.168.1.124
# 内部入口（Worker 用 IP 时可省略）
address=/cp.ar.internal/100.112.169.46
# ar.internal 下其他名字一律“不存在”，不外泄到公网 DNS
local=/ar.internal/
# 其他查询转发给上游
server=223.5.5.5
server=119.29.29.29
cache-size=1000
log-queries=extra
log-facility=-
EOF
sudo tee /etc/systemd/system/agent-runtime-dnsmasq.service >/dev/null <<'EOF'
[Unit]
Description=dnsmasq for the agent runtime names
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
ExecStart=/usr/sbin/dnsmasq --keep-in-foreground --conf-file=/etc/agent-runtime/dnsmasq.conf
Restart=on-failure
# The listen address may appear late (Tailscale); retry until it exists.
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now agent-runtime-dnsmasq
```

验证：`dig @100.115.94.58 x1.agent.ar.internal +short` 与 `dig @100.115.94.58 portal.ar.internal +short` 都返回 `192.168.1.124`；
`dig @100.115.94.58 nothing.ar.internal` 为 `NXDOMAIN`。`journalctl -u agent-runtime-dnsmasq` 中有查询记录（`log-queries`，排障后可删除）。

### 5.3 让客户端使用它

只需把 `ar.internal` 这一个域交给 dnsmasq，其余仍用原有 DNS：

- **Linux（systemd-resolved）**：`sudo resolvectl dns tailscale0 100.115.94.58 && sudo resolvectl domain tailscale0 '~ar.internal'`
  （临时）；持久做法写 `/etc/systemd/resolved.conf.d/ar-internal.conf`：`[Resolve]` 下 `DNS=100.115.94.58` 与 `Domains=~ar.internal`，
  然后 `sudo systemctl restart systemd-resolved`。
- **Tailscale 网络中的全部设备**：Tailscale 管理台 → DNS → Nameservers → Add nameserver → Custom，地址 `100.115.94.58`，勾选
  “Restrict to domain”并填 `ar.internal`（split DNS）。之后每台开启 MagicDNS 的设备都能解析。
- **Windows / macOS 单机**：把 dnsmasq 地址加为网卡的 DNS 服务器（会把所有查询都发给它，由它转发上游）。
- **Clash（TUN 或系统代理）**：Clash 会接管 DNS（fake-ip），必须让它对 `ar.internal` 用真实解析并直连。在配置（或 Clash Verge 的
  “扩展配置/覆写”）中加入：

  ```yaml
  dns:
    fake-ip-filter:
      - '+.ar.internal'
    nameserver-policy:
      '+.ar.internal': '100.115.94.58'
  rules:
    - DOMAIN-SUFFIX,ar.internal,DIRECT
    - IP-CIDR,192.168.1.124/32,DIRECT,no-resolve
    - IP-CIDR,100.64.0.0/10,DIRECT,no-resolve
  ```

  规则要放在其他规则之前。修改后在 Clash 中重载配置，再在浏览器中访问 `https://portal.ar.internal`。浏览器若开了“安全 DNS（DoH）”，
  要关闭或为该域设置例外，否则它绕过系统与 Clash 的解析。

## 6. Windows Server 2008 R2 AD 集成 DNS（有域环境时）

2008 R2 已于 2020 年停止支持，以下步骤在 2012 R2 及以后的版本中基本相同。

1. **建区**：服务器管理器 → 角色 → DNS 服务器 → 正向查找区域 → 新建区域 → 主要区域、存储在 AD 中、复制范围“域中的所有 DNS 服务器”，
   区域名 `ar.internal`；动态更新选“只允许安全的动态更新”。（若企业已有内部域如 `corp.example`，也可以在其下建子域
   `agent.corp.example`，后续名字相应替换。）
2. **记录**：在 `ar.internal` 下新建主机（A）记录 `portal` → Control Plane 用户入口地址；新建“域” `agent`，在其中新建主机记录，
   名称填 `*` → 同一地址（通配记录；DNS 管理器界面支持直接输入 `*`）。命令行等价：

   ```bat
   dnscmd /RecordAdd ar.internal portal A 192.168.1.124
   dnscmd /RecordAdd ar.internal *.agent A 192.168.1.124
   dnscmd /RecordAdd ar.internal cp A 100.112.169.46
   ```

3. **验证**：`nslookup x1.agent.ar.internal <DC 地址>` 返回该地址。
4. **根证书**：组策略管理 → 选择链接到用户计算机所在 OU 的 GPO（或新建）→ 编辑 → 计算机配置 → 策略 → Windows 设置 → 安全设置 →
   公钥策略 → 受信任的根证书颁发机构 → 右键“导入” `ca.crt`。客户端 `gpupdate /force` 后生效；Chrome 与 Edge 使用系统证书库，
   Firefox 需 `security.enterprise_roots.enabled=true`（可经 Firefox 的企业策略统一下发）。
5. 若企业使用 AD 证书服务（AD CS），可以直接由企业 CA 签发第 3 节的三类证书（Web 服务器模板，SAN 写法同上），不再需要
   `internal-ca.sh`。

## 7. 排障

| 现象 | 检查 |
|---|---|
| 浏览器“无法访问此网站” | `dig portal.ar.internal`（客户端）；Clash 的 fake-ip 地址（198.18.x.x）说明 fake-ip-filter 未生效；`curl -v --resolve portal.ar.internal:443:<地址> https://portal.ar.internal/` |
| “您的连接不是私密连接” / `NET::ERR_CERT_AUTHORITY_INVALID` | 根证书未导入该浏览器所用的证书库（Chrome on Linux 用 NSS，见第 4 节） |
| `ERR_CERT_COMMON_NAME_INVALID` | 访问的名字不在证书 SAN 中：`internal-ca.sh show /etc/agent-runtime/tls/public.crt` |
| Workspace 打开后 404 | `WORKSPACE_BASE_URL` 的主机名与 DNS、证书不一致；nginx 必须原样转发 `Host` |
| Worker 日志 `self-signed certificate in certificate chain` / `unable to verify` | Worker 主机缺少 `/etc/agent-runtime/tls/internal-ca.crt` 或 unit 中的 `NODE_EXTRA_CA_CERTS` |
| Worker 日志 `Hostname/IP does not match certificate's altnames` | `CONTROL_PLANE_URL` 用的名字/IP 不在内部入口证书 SAN 中 |
| Admin 中 Worker 在线但打开 Workspace 失败 | Control Plane 访问 `WORKER_GATEWAY_BASE_URL` 的证书问题：`journalctl -u agent-runtime-control-plane` |
