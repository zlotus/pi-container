# Model Gateway Runbook

Phase 16（`specs.md` 第 64 节 Phase 16）的运维说明：平台通过 LiteLLM Proxy 托管真实上游 key，为每个
Workspace 签发可吊销的虚拟 key，按平台用户计量与限额。Workspace 不能直接访问网关：Pi 只连接本机 Worker 的
模型中继，中继按 TCP 连接识别 Workspace 并注入虚拟 key，虚拟 key 不进入容器。

当前目录只包含 DeepSeek；Xiaomi MiMo 的接入放到 Phase 18（Pi / pi-web 升级后再验证，见 `specs.md` 16.15）。

## 1. 组成

| 组件 | 位置 | 作用 |
|---|---|---|
| LiteLLM Proxy 1.104.1（pin digest） | `deploy/model-gateway/compose.yml`、`config.yaml` | 持有上游 key；签发、删除虚拟 key；计量与预算 |
| 网关数据库 | 现有 PostgreSQL 实例中的独立库 `litellm`（独立 role） | LiteLLM 自己迁移；平台库不与其共享 |
| 平台模型目录 | `MODEL_GATEWAY_CATALOG_FILE`（示例 `deploy/model-gateway/catalog.example.json`） | 写入 Pi `models.json` 的平台 provider 模型定义，id 与 `config.yaml` 的 `model_name` 一一对应 |
| Worker 模型中继 | `apps/worker/src/model-relay/`，端口 `WORKER_MODEL_RELAY_PORT`（默认 3101） | 只转发推理路径；丢弃客户端认证头，注入该 Workspace 的虚拟 key |
| 出口规则例外 | `inet agent_runtime` 表：`ws_prerouting` 中只放行中继端口；`relay_input` 链拒绝非 `arw-*` 接口访问该端口 | Workspace 只能访问宿主机上的这一个端口 |
| Worker 本地 key | `${WORKER_MANAGED_ROOT}/workspaces/<id>/metadata/model-key.json`（`0600`，不挂载进容器） | Worker 重启后恢复 |
| 平台记录 | PostgreSQL `model_keys`（只存 alias 与状态，不存明文）；Audit `model.*` | 吊销以网关确认删除为准 |

## 2. 配置

网关（开发环境，负责人本机）：

```bash
install -m 600 /dev/null ~/.config/agent-runtime/litellm.env     # 填 DEEPSEEK_API_KEY、LITELLM_MASTER_KEY（sk-…）
tools/dev/init-litellm-db.sh ~/.config/agent-runtime/litellm.env   # 建 litellm role/库，追加 DATABASE_URL
LITELLM_ENV_FILE=~/.config/agent-runtime/litellm.env docker compose -f deploy/model-gateway/compose.yml up -d
```

开发网关监听 `127.0.0.1:4400`（Q8B 的 4000 已被占用）。生产部署模板见 Phase 19。

Control Plane：

```bash
MODEL_GATEWAY_ADMIN_URL=http://127.0.0.1:4400        # HTTPS，或 loopback HTTP
MODEL_GATEWAY_MASTER_KEY=sk-...                      # 只给 Control Plane，日志脱敏
MODEL_GATEWAY_CATALOG_FILE=/abs/path/catalog.json    # 启动时校验，失败则拒绝启动
MODEL_GATEWAY_USER_BUDGET_USD=                       # 每用户每周期预算，空 = 不限
MODEL_GATEWAY_BUDGET_DURATION=30d
MODEL_GATEWAY_KEY_RPM=60
```

三项必填项要么全部设置，要么全部为空（部分配置会拒绝启动）。网关地址自动加入出口保护地址。

Worker：

```bash
WORKER_MODEL_GATEWAY_URL=http://127.0.0.1:4400       # 未设置 = 不启用中继
WORKER_MODEL_RELAY_PORT=3101                         # 不能与 WORKER_GATEWAY_PORT 相同
```

中继端口的出口例外需要 Worker 具备 `CAP_NET_ADMIN`（与 Phase 14 相同，开发用
`tools/dev/run-worker-privileged.sh`）。Admin“Worker”页面的“模型网关”面板与 Worker 详情中的“模型中继”显示状态。

## 3. 新增或调整模型

1. 在 `config.yaml` 增加条目，统一使用 `litellm_proxy/<上游模型>` + `api_base` + `api_key: os.environ/...`，
   并在 `model_info` 写明单价（该路由没有内置价格，预算依赖它）。**不要用** `deepseek/`（丢弃
   `reasoning_effort`）或 `openai/`（拒绝 `thinking`）。
2. 在目录文件中增加同 id 的模型；`compat` 必须显式写全（平台 provider 的 baseUrl 是中继地址，Pi 不会按
   域名自动推断 DeepSeek 的 compat），`thinkingLevelMap` 把上游不支持的思考强度设为 `null`。同一目录不能
   混用 OpenAI 与 Anthropic 类 API。
3. 重启网关与 Control Plane；Workspace 在下一次启动时得到新的模型列表（运行中的不改写 `models.json`）。
   Admin 面板中“网关中缺少”应为空。
4. 验证：`tools/dev/model-gateway-spike.py <env>`（真实上游，网关层面）与
   `pnpm --filter @agent-runtime/worker exec tsx ../../tools/dev/model-relay-smoke.ts <env>`（真实 Pi 经中继）。

## 4. 凭据生命周期

| 事件 | 行为 |
|---|---|
| Workspace 启动 | ensure 之后、start 之前签发 key 并交给 Worker；网关不可用时照常启动，平台模型暂不可用，后台每 30 秒补签 |
| 用户禁用 | 数据库触发器在同一事务把该用户全部 key 置为待吊销；Worker 立即停用，网关删除成功后才算吊销 |
| Workspace 删除 | 同上（任何删除路径都由触发器覆盖） |
| 撤销 session / logout | key 不变（key 从不离开 Worker；被撤销的 session 已无法进入 Workspace） |
| Worker 重连 | 清除 Worker 不应持有的 key；Worker 丢失的 key 自动轮换 |
| 管理员轮换 | Admin“用户”→管理→平台模型→“轮换模型凭据…”（怀疑 Worker 主机或 key 文件泄露时） |

## 5. 排查

- **待吊销数量不为 0**：网关不可达或拒绝删除。修复网关后在重试周期内（30 秒起指数退避，最长 10 分钟）
  自动完成；不要手工改 `model_keys` 状态。
- **Workspace 显示“暂不可用”**：`MODEL_KEY_PENDING`（网关不可用或刚启动）、`MODEL_RELAY_DISABLED`（Worker 未配置中继）、
  `USER_CONFIG_INVALID`（用户的 `/agent/pi/models.json` 不是合法 JSON 或是符号链接，平台不覆盖，用户修复/删除后重启）。
- **Pi 中报 `MODEL_KEY_UNAVAILABLE`（403）**：该 Workspace 当前没有 key；看 Control Plane 日志 `model key could not be issued`。
- **`MODEL_GATEWAY_UNAVAILABLE`（502）**：Worker 连不上 `WORKER_MODEL_GATEWAY_URL`。
- **预算用尽**：网关返回 `budget_exceeded`（422），Pi 显示该错误；Admin 调整预算或等待周期重置。
- 网关日志不含 prompt（`store_prompts_in_spend_logs: false`）；需要时用
  `docker logs agent-runtime-model-gateway-litellm-1` 查看；粘贴到工单前先确认其中没有 key。

## 6. 升级网关

只升级到经过验证的版本：更新 `compose.yml` 的 tag 与 digest（核对 changelog 与供应链公告，避开
1.82.7 / 1.82.8），运行 `pnpm test:model-gateway` 与 `tools/dev/model-gateway-spike.py`，再在 `specs.md`
16.15 记录。
