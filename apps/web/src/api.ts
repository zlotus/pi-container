// Chinese text for stable Control Plane error codes. Unknown codes keep the server message,
// so a new backend code degrades to English rather than to a misleading translation.
const API_ERROR_MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: "登录已失效，请重新登录",
  FORBIDDEN: "需要管理员权限",
  INVALID_ORIGIN: "请求来源不受信任，请从平台页面操作",
  INVALID_CSRF: "页面安全令牌已失效，请刷新页面后重试",
  INVALID_CREDENTIALS: "账号或密码错误",
  INVALID_REQUEST: "提交的内容不符合要求",
  USER_ALREADY_EXISTS: "邮箱或用户名已存在",
  USER_NOT_FOUND: "用户不存在",
  LOCAL_USER_NOT_FOUND: "该用户没有本地账户",
  LAST_ACTIVE_LOCAL_ADMIN: "必须至少保留一个可用的本地管理员",
  LAST_LOGIN_METHOD: "不能移除该用户最后一种登录方式",
  IDENTITY_NOT_FOUND: "登录方式不存在",
  IDENTITY_ALREADY_BOUND: "该外部身份已绑定到其他用户",
  EXTERNAL_IDENTITY_ALREADY_BOUND: "该外部身份已绑定到其他用户",
  OIDC_IDENTITY_ALREADY_BOUND: "该外部身份已绑定到其他用户",
  EXTERNAL_PROVIDER_MISMATCH: "外部身份提供方不匹配",
  OIDC_PROVIDER_MISMATCH: "外部身份提供方不匹配",
  EXTERNAL_AUTH_DISABLED: "外部登录未启用",
  OIDC_DISABLED: "外部登录未启用",
  OIDC_UNAVAILABLE: "外部登录暂时不可用",
  WORKSPACE_NOT_FOUND: "Workspace 不存在",
  WORKSPACE_NAME_EXISTS: "已存在同名 Workspace",
  WORKSPACE_CHANGED: "Workspace 状态已变化，请刷新后重试",
  WORKSPACE_NOT_STOPPED: "请先停止 Workspace，再切换 Runtime 版本",
  RUNTIME_ALREADY_CURRENT: "Workspace 已在使用该 Runtime 版本",
  RUNTIME_IMAGE_UNAVAILABLE: "所在 Worker 未提供该 Runtime 版本",
  RUNTIME_NO_PREVIOUS: "没有可回滚的上一版本",
  RUNTIME_NO_INCOMPLETE_CHANGE: "没有需要重试的 Runtime 切换",
  RUNTIME_CHANGE_INCOMPLETE: "Runtime 切换未完成，请先重试或回滚",
  WORKSPACE_RUNNING: "Workspace 仍在运行，请先停止",
  WORKSPACE_METADATA_MISMATCH: "Workspace 记录与 Worker 上的数据不一致，请联系管理员",
  WORKSPACE_NOT_RUNNING: "Workspace 未在运行",
  WORKSPACE_DELETE_REQUIRES_WORKER: "需要所在 Worker 在线才能删除该 Workspace",
  NO_ELIGIBLE_WORKER: "当前没有可用的 Worker，请稍后重试或联系管理员",
  WORKER_UNAVAILABLE: "Workspace 所在的 Worker 当前不可用",
  WORKER_NOT_CONNECTED: "Workspace 所在的 Worker 当前不可用",
  WORKER_NOT_FOUND: "Worker 不存在",
  WORKER_COMMAND_TIMEOUT: "Worker 响应超时，请稍后重试",
  WORKER_CONNECTION_CLOSED: "Worker 连接中断，请稍后重试",
  WORKER_COMMAND_FAILED: "Worker 执行操作失败",
  INVALID_WORKER_RESPONSE: "Worker 返回了异常结果",
  WORKER_RESPONSE_MISMATCH: "Worker 返回了异常结果",
  EGRESS_UNENFORCED: "Worker 网络出口规则未生效，暂时无法启动",
  EGRESS_NETWORK_LEGACY: "Workspace 仍在旧网络上，已被停止，请重新启动",
  EGRESS_RULE_EXISTS: "相同的出口规则已存在",
  EGRESS_RULE_NOT_FOUND: "出口规则不存在",
  EGRESS_RULE_IN_USE: "仍有放行规则依赖这个拒绝网段，请先删除这些放行规则",
  EGRESS_ALLOW_OUTSIDE_DENY: "放行规则必须位于内网（RFC1918）或已有拒绝网段之内",
  EGRESS_ALLOW_OVERLAPS_PROTECTED: "放行规则不能包含平台保护地址",
  EGRESS_RULE_LIMIT: "出口规则数量已达上限",
  AUTH_RATE_LIMITED: "登录尝试过于频繁，请稍后再试",
  AUTH_UNAVAILABLE: "登录服务暂时不可用，请稍后重试",
  AUTH_LOCK_NOT_FOUND: "该锁定不存在或已到期",
  STORAGE_QUOTA_UNENFORCED: "Worker 磁盘配额未生效，暂时无法启动",
  STORAGE_QUOTA_APPLY_FAILED: "Workspace 磁盘配额设置失败，请稍后重试",
  STORAGE_MIGRATION_REQUIRED: "该 Workspace 创建于磁盘配额启用之前，需要管理员完成存储迁移后才能启动",
  DISK_LIMIT_OUT_OF_RANGE: "磁盘上限超出允许范围",
  MODEL_GATEWAY_DISABLED: "平台模型未启用",
};

/** “请在 N 分钟后重试” for a 429 with Retry-After; null when there is nothing to add. */
export function retryAfterText(header: string | null): string | null {
  if (header === null || !/^\d+$/.test(header)) return null;
  const minutes = Math.max(1, Math.ceil(Number(header) / 60));
  return `请在 ${minutes} 分钟后重试`;
}

export function apiErrorText(code: string | undefined, serverMessage: string): string {
  return (code === undefined ? undefined : API_ERROR_MESSAGES[code]) ?? serverMessage;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    const code = body?.error?.code;
    const text = apiErrorText(code, body?.error?.message ?? `请求失败（HTTP ${response.status}）`);
    const retry = response.status === 429 ? retryAfterText(response.headers.get("retry-after")) : null;
    throw new ApiError(
      retry === null ? text : `${text.replace(/，请稍后再试$/, "")}，${retry}`,
      response.status,
      code,
    );
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
