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
3. 在 Audit 中按时间检查 `auth.login_failed`。只使用 `protocol`、`providerId`、`category`、
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
```

普通用户的 Audit API 只返回自己的 `workspace.*` 事件，不返回认证、用户管理或 identity 管理事件。
可用只返回事件 ID 的查询检查可疑字段名，避免在终端输出完整 `details`：

```sql
select id, event_type, created_at
from platform_audit_events
where details::text ~* '(password|authorization[_ -]?code|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|client[_ -]?secret|cookie)';
```

命中必须人工确认并按安全事件处理；不要把疑似敏感 `details` 复制到普通日志。

## Phase 12 Manual Acceptance

1. 完成 Local login/logout、OIDC login，并故意制造一次 OIDC failure。
2. 对测试用户执行 disable/enable、role change、password reset 和 session revoke。
3. 检查事件完整，且没有 password、code、token、secret、完整 UserInfo、Pi 对话/tool stream 或文件内容。
4. 验证 logout/disable/revoke 后 Portal、Workspace Host、既有 HTTP/SSE/WebSocket 都立即失效。
5. 回归 Workspace HTTP/SSE/WebSocket/Terminal/Files、Stop/Start 与 recovery。
6. 按上述 outage drill 暂停或错误配置测试 IdP，确认 Local Admin 仍能登录并完成排障。

自动测试使用 mock Provider，不能替代目标企业 IdP、生产 TLS、反向代理日志策略和浏览器人工验收。
