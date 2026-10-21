# 离线部署（纯内网，AMD64）

> **状态：未经真实 AMD64 设备与真实离线环境验证**（`specs.md` 19.15 Q3/Q4）。步骤与 ARM64 联网部署（已验证）相同，只是所有
> 依赖改为预先准备的介质。实测后去掉此标注。ARM64 离线部署把文中的 `amd64` 换成 `arm64` 即可。

目标环境不能访问互联网。在一台**联网的准备机**上收集全部介质，校验后拷入内网，再按 [运维手册](README.md) 部署。

## 1. 准备机

与目标主机**相同的发行版版本与架构**（例如都是 Ubuntu 24.04 amd64），装有 Docker。准备机最好是一台干净的系统，这样下载到的 .deb 依赖
才完整。

## 2. 收集介质

```bash
mkdir -p ~/ar-offline/{release,images,debs} && cd ~/ar-offline
```

### 2.1 平台发布包与 Runtime 镜像

- 平台发布包：GitHub Release 的 `agent-runtime-<版本>-linux-amd64.tar.gz` 与 `SHA256SUMS-<版本>-amd64`，或按
  [23 从源码构建](23-build-from-source.md) 自行构建 → `release/`。
- Runtime 镜像归档：`agent-runtime_<tag>_linux-amd64.tar.zst` 与 `.sha256`（build-from-source.md 第 3 节）→ `images/`。

### 2.2 第三方镜像（Control Plane 主机用）

版本与 digest 以发布包中 `deploy/compose.yml` 为准：

```bash
for ref in $(tar -xzf release/agent-runtime-*-linux-amd64.tar.gz --wildcards '*/deploy/compose.yml' -O | sed -n 's/^ *image: *//p'); do
  docker pull --platform linux/amd64 "$ref"
  name=$(echo "${ref%@*}" | tr '/:' '__')
  docker save "$ref" | zstd -q -T0 -o images/$name.tar.zst
  docker image inspect "$ref" --format "{{.Id}}  $ref" >> images/third-party.ids
done
```

### 2.3 系统软件包

Docker Engine（离线安装包来自 Docker 官方源）与平台需要的软件包：

```bash
# Docker：按 https://docs.docker.com/engine/install/ubuntu/ 的“Install from a package”，下载与目标版本一致的
#   containerd.io、docker-ce、docker-ce-cli、docker-buildx-plugin、docker-compose-plugin 五个 .deb 到 debs/
# 其余：在干净的准备机上只下载不安装，依赖一并下载
sudo apt-get update
sudo apt-get install --download-only -y nftables xfsprogs zstd jq curl openssl
cp /var/cache/apt/archives/*.deb debs/
```

### 2.4 校验和与打包

```bash
cd ~/ar-offline && find . -type f ! -name MEDIA.sha256 -exec sha256sum {} + > MEDIA.sha256
cd ~ && tar -cf ar-offline.tar ar-offline       # 用企业允许的方式拷入内网
```

## 3. 目标主机（内网）

```bash
tar -xf ar-offline.tar && cd ar-offline && sha256sum --check --quiet MEDIA.sha256 && echo media-ok
sudo apt-get install -y ./debs/*.deb            # 本地 .deb，不访问网络
docker info --format '{{.Driver}} {{json .DriverStatus}}'
```

**第三方镜像**（Control Plane 主机）：

```bash
for f in images/*.tar.zst; do case "$f" in *agent-runtime_*) continue ;; esac; zstd -dc "$f" | sudo docker load; done
while read -r id ref; do echo "$ref $( [ "$(sudo docker image inspect "$ref" --format '{{.Id}}' 2>/dev/null)" = "$id" ] && echo ok || echo MISMATCH )"; done < images/third-party.ids
```

`compose.yml` 以 `<tag>@sha256:<digest>` 引用镜像。Docker 使用 containerd 镜像存储（`docker info` 显示
`io.containerd.snapshotter.v1`，Docker 29 新装的默认值）时，`docker load` 保留 digest，compose 无需改动。使用旧的存储驱动且上面的检查
显示 `MISMATCH` 或 compose 启动时试图联网拉取镜像时，在确认镜像 ID 一致后，把 `/etc/agent-runtime/compose.yml` 中三处 `image:` 改为只写
tag（去掉 `@sha256:…`）。

**Runtime 镜像**（每台 Worker）：`sudo agent-runtime-image load images/agent-runtime_<tag>_linux-amd64.tar.zst`（安装发布包后可用）。

然后按 [03](03-control-plane-host.md)、[04](04-worker-host.md)部署。离线环境的差异：

| 项 | 处理 |
|---|---|
| 证书与 DNS | 用企业 PKI / AD DNS，或 `internal-ca.sh` + dnsmasq（[02 TLS 与 DNS](02-tls-and-dns.md)）；均不需要外网 |
| 模型网关 | 上游必须是内网可达的模型服务（例如企业自建的 OpenAI 兼容服务）：在 `model-gateway/config.yaml` 中把 `api_base` 指向它，并更新 `catalog.json`；没有可用的模型服务时，把 `control-plane.env` 中三个 `MODEL_GATEWAY_*` 留空并从 compose 中去掉 litellm。LiteLLM 已设置 `LITELLM_LOCAL_MODEL_COST_MAP=True`，不会联网下载价格表 |
| Workspace 内的软件安装 | 默认出口策略“允许公网”在离线环境无效；若有内网 npm / PyPI / apt 镜像，按 [egress-runbook.md](../egress-runbook.md) 为其地址添加白名单，并在 Runtime 中配置镜像源（用户的 `~/.npmrc`、`pip.conf` 等，位于持久化的 home） |
| Pi / pi-web 的联网行为 | 镜像中已关闭 telemetry 与版本检查（`PI_TELEMETRY=0`、`PI_SKIP_VERSION_CHECK=1`、`PI_WEB_SKIP_VERSION_CHECK=1`） |
| 时间同步 | TLS 与会话依赖正确的时间；配置内网 NTP |

## 4. 企业内部镜像仓库（可选）

有 Harbor 等内部仓库时，可以把 Runtime 镜像推送进去，Worker 从仓库拉取而不是拷贝归档。平台只认本地名与 digest，所以拉取后要打成同一个
本地名：

```bash
# 推送（在能访问仓库的主机上，归档已 docker load）
docker tag agent-runtime:2026.10-pi1.1 harbor.example.internal/platform/agent-runtime:2026.10-pi1.1
docker push harbor.example.internal/platform/agent-runtime:2026.10-pi1.1        # 记下输出的 digest
# 每台 Worker
docker pull harbor.example.internal/platform/agent-runtime:2026.10-pi1.1@sha256:<digest>
docker tag harbor.example.internal/platform/agent-runtime:2026.10-pi1.1@sha256:<digest> agent-runtime:2026.10-pi1.1
sudo agent-runtime-image verify agent-runtime:2026.10-pi1.1                    # 输出 RUNTIME_IMAGES 项
```

## 5. 离线升级

与 [20 升级与回滚](20-upgrade.md) 相同，只是新版本的发布包、Runtime 镜像归档（若默认镜像变化）与第三方镜像（若 compose 中的 pin
变化）都按第 2 节准备成介质。先比较新旧发布包中的 `deploy/compose.yml`，只有镜像引用变化时才需要第 2.2 节。
