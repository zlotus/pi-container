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
};

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
    throw new ApiError(
      apiErrorText(code, body?.error?.message ?? `请求失败（HTTP ${response.status}）`),
      response.status,
      code,
    );
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
