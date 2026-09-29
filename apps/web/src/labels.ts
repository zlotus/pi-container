// Display labels for platform enums. API values stay unchanged; only the Portal
// presentation is localized here so pages and tests share one mapping.

const WORKSPACE_STATE_LABELS: Record<string, string> = {
  CREATED: "已创建",
  SCHEDULING: "调度中",
  STARTING: "启动中",
  RUNNING: "运行中",
  STOPPING: "停止中",
  STOPPED: "已停止",
  DELETING: "删除中",
  ERROR: "异常",
  WORKER_OFFLINE: "Worker 离线",
};

const WORKER_STATUS_LABELS: Record<string, string> = {
  ONLINE: "在线",
  OFFLINE: "离线",
  DISABLED: "已停用",
};

const USER_STATUS_LABELS: Record<string, string> = {
  active: "正常",
  disabled: "已禁用",
};

const ROLE_LABELS: Record<string, string> = {
  user: "普通用户",
  admin: "管理员",
};

const AUTH_PROTOCOL_LABELS: Record<string, string> = {
  LOCAL: "本地账户",
  OIDC: "OIDC",
  OAUTH2: "OAuth2",
};

/** Workspace states that settle on their own; the Portal polls while any is present. */
export const TRANSITIONAL_WORKSPACE_STATES: readonly string[] = [
  "SCHEDULING",
  "STARTING",
  "STOPPING",
  "DELETING",
];

/** Mirrors the Control Plane start precondition; other states are rejected with WORKSPACE_CHANGED. */
export const STARTABLE_WORKSPACE_STATES: readonly string[] = [
  "CREATED",
  "STOPPED",
  "ERROR",
  "WORKER_OFFLINE",
];

export function workspaceStateLabel(state: string): string {
  return WORKSPACE_STATE_LABELS[state] ?? state;
}

export function workerStatusLabel(status: string): string {
  return WORKER_STATUS_LABELS[status] ?? status;
}

export function userStatusLabel(status: string): string {
  return USER_STATUS_LABELS[status] ?? status;
}

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

export function authProtocolLabel(protocol: string): string {
  return AUTH_PROTOCOL_LABELS[protocol] ?? protocol;
}

/** Labels a state/status value from any platform enum used in audit transitions. */
export function transitionValueLabel(value: string): string {
  return WORKSPACE_STATE_LABELS[value] ??
    WORKER_STATUS_LABELS[value] ??
    USER_STATUS_LABELS[value] ??
    ROLE_LABELS[value] ??
    value;
}

export function formatAbsoluteTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

// Each unit is used until its rounded value reaches the next unit's size.
const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number, number]> = [
  ["minute", 60, 60],
  ["hour", 3600, 24],
  ["day", 24 * 3600, 30],
  ["month", 30 * 24 * 3600, 12],
  ["year", 365 * 24 * 3600, Number.POSITIVE_INFINITY],
];

const relativeFormat = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });

export function formatRelativeTime(value: string, now: number = Date.now()): string {
  const seconds = Math.round((new Date(value).getTime() - now) / 1000);
  if (Number.isNaN(seconds)) return "—";
  if (Math.abs(seconds) < 45) return "刚刚";
  for (const [unit, size, limit] of RELATIVE_UNITS) {
    const amount = Math.round(seconds / size);
    if (Math.abs(amount) < limit) return relativeFormat.format(amount === 0 ? Math.sign(seconds) : amount, unit);
  }
  return relativeFormat.format(Math.round(seconds / (365 * 24 * 3600)), "year");
}
