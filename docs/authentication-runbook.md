# Authentication Audit And Break-glass Runbook

本手册用于 Phase 12 人工验收和 OIDC/OAuth2 故障排查。它不替代企业 IdP、TLS、反向代理、数据库
备份或安全事件响应流程，也不把平台扩展为通用 IAM。

## Security Baseline

- 始终保留至少一个已验证可登录的 `active` Local Admin；在单独浏览器 profile 中验证后再调整 IdP。
- HTTPS 部署必须设置 `SESSION_COOKIE_SECURE=true`。Portal 与 Workspace Host Cookie 均保持
  `Secure`、`HttpOnly`、`SameSite=Lax`、host-only，不配置 `Domain`。
- OIDC callback 固定为 `<PORTAL_ORIGIN>/auth/oidc/callback`，OAuth2 callback 固定为
  `<PORTAL_ORIGIN>/auth/oauth2/callback`。反向代理必须原样转发 `/auth`，不得根据请求参数改写目标。
- 普通访问日志不得记录 Cookie、Authorization header、POST body 或 `/auth/*/callback` query。
  OAuth2 query UserInfo 模式还必须在 IdP/API Gateway/反向代理侧关闭完整 query string 日志。
- client secret、authorization code、access/refresh/ID token 只属于 Control Plane 协议处理过程，
  不得进入 Portal storage、Audit、Worker、Runtime、Artifact 或排障截图。

## IdP Outage Drill

1. 不关闭 `state`、`nonce`、issuer、audience、PKCE、CSRF、Origin 或 callback 校验，也不把 IdP token
   临时改成平台 bearer token。
2. 在独立浏览器 profile 使用 Local Admin 登录 Portal，确认 `/ready` 正常且 Admin Users 可访问。
3. 在 Portal“审计”页选择类别“登录与会话”并限定日期范围，按时间检查“登录失败”（`auth.login_failed`，
   红点）；需要留档时可导出已加载事件为 CSV。只使用 `protocol`、`providerId`、`category`、
   `requestId`、IP 和 User-Agent 定位；不要收集 callback URL、token response 或完整 UserInfo。
4. 从服务端配置核对 issuer/authorization/token/UserInfo URL、client ID、callback 和 secret 是否存在，
   但不要把 secret 值打印到终端、工单或聊天记录。
5. 在 Control Plane 主机验证 IdP DNS、TLS、discovery/token/UserInfo endpoint 和反向代理 `/auth` 路由。
   环境问题先保留证据，不通过放宽认证校验继续联调。
6. 修复目标环境后重新发起全新的登录 transaction；进程重启会使旧 transaction 失效，这是预期的
   fail-closed 行为。
7. 验证 SSO 恢复、Local Admin 仍可登录，并确认测试用户仍受 Platform status、role 与 Workspace
   ownership 约束。

稳定失败类别包括：`invalid_request`、`invalid_credentials`、`provider_unavailable`、
`transaction_invalid`、`protocol_validation_failed`、`identity_not_bound`、
`provisioning_not_allowed` 和 `user_disabled`。类别用于排障，不回显底层异常或 Provider response。

## Audit Review

Admin 应看到以下追加式事件：

```text
auth.login_succeeded
auth.login_failed
auth.logout
auth.session_revoked
user.created
user.enabled
user.disabled
user.role_changed
user.password_reset
identity.bound
identity.unbound
auth.login_locked
auth.lock_cleared
```

普通用户的 Audit API 只返回自己的 `workspace.*` 事件，不返回认证、用户管理或 identity 管理事件。
可用只返回事件 ID 的查询检查可疑字段名，避免在终端输出完整 `details`：

```sql
select id, event_type, created_at
from platform_audit_events
where details::text ~* '(password|authorization[_ -]?code|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|client[_ -]?secret|cookie)';
```

命中必须人工确认并按安全事件处理；不要把疑似敏感 `details` 复制到普通日志。

## Login Protection (Phase 15)

本地登录与 SSO 入口的限速和临时锁定（`specs.md` 第 64 节 Phase 15.9）。全部锁定都会到期自动解除，没有
永久锁定。

| 计数 | 默认阈值 → 锁定 | 说明 |
|---|---|---|
| 账户 + 来源地址 | 15 分钟内失败 5 次 → 15 分钟 | 只影响这个地址对这个账户的尝试 |
| 来源地址 | 15 分钟内失败 20 次 → 15 分钟 | 含格式错误的登录请求与失败的 SSO callback |
| 账户（全部来源） | 1 小时内失败 50 次 → 1 小时 | 来自 `AUTH_TRUSTED_NETWORKS` 的请求不受此项限制 |
| SSO 发起 | 10 分钟内 30 次 → 10 分钟 | 防止单一来源耗尽进程内的 SSO transaction 容量 |

- 被锁定的请求直接返回 429 与 `Retry-After`，不再校验密码、不再计数，响应不说明是哪一项锁定。存在与
  不存在的账户行为完全一致。
- 一次成功登录只清除“账户 + 来源地址”计数；来源地址与账户计数继续累积，攻击者不能借合法用户的一次
  登录重置计数。管理员重置某用户密码时清除该用户的全部锁定。
- 数据库只保存登录名的 HMAC（以 `SESSION_SECRET` 派生的密钥），不保存明文登录名。
- 计数存储不可用时登录返回 503 `AUTH_UNAVAILABLE`，不跳过限速。
- 被锁定期间的每次拒绝不逐条写 Audit（避免刷写审计表），只在开始锁定时写一次 `auth.login_locked`。

### 客户端地址

`AUTH_TRUSTED_PROXIES` 列出可信的反向代理；只有 TCP 对端在该列表中时才读取 `X-Forwarded-For`，并从右往左
取第一个不可信的地址。其他来源伪造的 `X-Forwarded-For` 一律忽略。开发时 Portal 经 Vite proxy（已开启
`xfwd`）访问，配置 `AUTH_TRUSTED_PROXIES=127.0.0.1/32,::1/128`。**生产必须只填写真实的反向代理地址**；
填写过宽会让任何人伪造来源地址绕过按地址的限速。该地址同时写入 Audit 的 `ipAddress`。

### Break-glass

1. 外部攻击者只能锁定自己的来源地址，或某个账户对自己地址的尝试；管理员换一个地址即可登录。
2. 分布式攻击可以触发“账户（全部来源）”锁定，但它对 `AUTH_TRUSTED_NETWORKS`（默认仅 loopback，生产配置为
   管理网段）不生效：管理员从管理网络用正确密码仍可登录。
3. Portal“用户”页底部的“登录锁定”列出生效中的锁定，可逐条解除（记 `auth.lock_cleared`）。
4. 能登录 Control Plane 宿主机即可直接解除（同样记 Audit，`details.source=cli`）：

   ```bash
   set -a; . ./.env; set +a                      # 需要 DATABASE_URL 与 SESSION_SECRET
   pnpm auth:unlock login admin@example.com      # 某个账户（邮箱或用户名）
   pnpm auth:unlock ip 198.51.100.7              # 某个来源地址
   pnpm auth:unlock all                          # 全部
   ```

## Phase 12 Manual Acceptance

1. 完成 Local login/logout、OIDC login，并故意制造一次 OIDC failure。
2. 对测试用户执行 disable/enable、role change、password reset 和 session revoke。
3. 检查事件完整，且没有 password、code、token、secret、完整 UserInfo、Pi 对话/tool stream 或文件内容。
4. 验证 logout/disable/revoke 后 Portal、Workspace Host、既有 HTTP/SSE/WebSocket 都立即失效。
5. 回归 Workspace HTTP/SSE/WebSocket/Terminal/Files、Stop/Start 与 recovery。
6. 按上述 outage drill 暂停或错误配置测试 IdP，确认 Local Admin 仍能登录并完成排障。

自动测试使用 mock Provider，不能替代目标企业 IdP、生产 TLS、反向代理日志策略和浏览器人工验收。

## Development Mock OAuth2 Provider

`tools/dev/mock_oauth2_userinfo.py` 是开发联调用的模拟 OAuth2 + UserInfo Provider，模拟 UserInfo 返回
嵌套 `attributes` 的企业系统。它只用于开发，不进入任何部署产物，也不做完整 PKCE 校验。

```bash
python3 tools/dev/mock_oauth2_userinfo.py   # 监听 0.0.0.0:9000
```

Control Plane 只接受 loopback 的 HTTP OAuth2 endpoint，因此模拟服务必须与 Control Plane 在同一台主机，
浏览器也必须能以 `127.0.0.1:9000` 访问它（同机浏览器或端口转发）。对应的 `.env` 配置：

```bash
AUTH_OAUTH2_ENABLED=true
AUTH_OAUTH2_AUTHORIZATION_URL=http://127.0.0.1:9000/authorize
AUTH_OAUTH2_TOKEN_URL=http://127.0.0.1:9000/token
AUTH_OAUTH2_USERINFO_URL=http://127.0.0.1:9000/profile
AUTH_OAUTH2_CLIENT_ID=pi-container-test
AUTH_OAUTH2_CLIENT_SECRET=pi-container-secret
AUTH_OAUTH2_SUBJECT_FIELD=attributes.workcode
AUTH_OAUTH2_USERNAME_FIELD=attributes.workcode
AUTH_OAUTH2_EMAIL_FIELD=attributes.email
AUTH_OAUTH2_DISPLAY_NAME_FIELD=attributes.displayName
```

修改脚本顶部的 `CURRENT_USER` 可切换模拟登录的用户。
