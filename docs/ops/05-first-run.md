# 05 首次启动与验收

03、04 完成后，确认平台可用并留下一次可对比的“健康基线”。

## 1. 主机自检

```bash
# 每台主机
sudo /opt/agent-runtime/current/deploy/scripts/audit-host.sh       # 0 failed；UID 1000 的告警见 31
sudo agent-runtime-ctl version | jq '{version, protocolVersion}'   # Control Plane 主机
systemctl is-active agent-runtime-platform agent-runtime-control-plane   # Control Plane 主机
systemctl is-active agent-runtime-egress agent-runtime-worker            # 每台 Worker
```

## 2. Portal 验收

1. 客户端信任根证书并能解析名字（[02](02-tls-and-dns.md) 第 4、5 节）。浏览器打开 `https://portal.<域>`，无证书警告。
2. 以管理员登录。「Worker」页：每台 Worker `在线`、版本与平台一致、出口控制与磁盘配额“已生效”、镜像 capability 全部为真；页首显示空闲
   回收策略。
3. 「用户」页创建一个普通用户，用它登录，新建 Workspace → 启动 → 打开（新标签页 `https://<id>.agent.<域>`，无证书警告）。
4. 在 Workspace 中：新建会话，选择平台模型（`platform/…`）完成一次带工具调用的对话；Terminal 可交互；Files 上传、下载文件。
5. 刷新、直接打开 `https://portal.<域>/admin/workers` 这样的深链接、前进/后退：页面正常，登录状态保持。
6. 停止 Workspace 再启动：文件与会话都在。Portal 卡片显示空闲回收提示（启用时）。
7. 「审计」页能看到以上登录、创建、启动、打开、停止事件。

## 3. 网络与出口抽查

```bash
# Worker 主机：在一个运行中的 Workspace 容器内
c=$(docker ps -q --filter label=app=agent-runtime-platform | head -1)
for t in https://<Control Plane 地址> https://<Control Plane 地址>:8443 https://www.example.com; do
  printf '%-40s ' "$t"; docker exec "$c" curl -sk -o /dev/null --max-time 6 -w '%{http_code}\n' "$t" || echo BLOCKED
done          # Control Plane 与内网地址 BLOCKED，公网有状态码
```

从**用户网络**的另一台机器确认只有 80/443 可达：`nc -zvw2 <用户入口地址> 3000`、`... 8443` 等应失败（8443/8444 只对 Worker 开放）。

## 4. 开机顺序（重启验证）

开机时依次：受管根挂载 → `agent-runtime-egress`（早于 Docker，Workspace 第一个数据包起就受出口规则约束）→ Docker（重新拉起原本运行中
的 Workspace 容器）→ `agent-runtime-platform`（PostgreSQL、LiteLLM、nginx）→ `agent-runtime-control-plane`；Worker 主机上
`agent-runtime-worker` 在 Docker 与出口规则之后启动并 reconcile。重启后运行中的 Workspace 回到 `运行中`，停止的保持停止。
建议首次部署后各重启一次主机确认。

## 5. 记录基线

把以下输出存档，日后排障或升级前后对比：`agent-runtime-ctl version`、`audit-host.sh` 输出、Portal「Worker」页截图、
`/etc/agent-runtime` 的文件清单（`sudo ls -la /etc/agent-runtime /etc/agent-runtime/tls`，不要存档密钥内容）。
