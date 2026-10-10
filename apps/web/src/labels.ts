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

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

/** Binary units with at most one decimal, e.g. `1.5 GiB`; `—` when unknown. */
export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return "—";
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < BYTE_UNITS.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  const text = unit === 0 || amount >= 100 ? String(Math.round(amount)) : amount.toFixed(1).replace(/\.0$/, "");
  return `${text} ${BYTE_UNITS[unit]}`;
}

export type DiskUsageLevel = "unknown" | "ok" | "warning" | "full";

/** CPU cores with two decimals at most (`0.35`, `2`). */
export function formatCores(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "—";
  return String(Math.round(value * 100) / 100);
}

/** CPU or memory against its limit; warning from 90 % (Phase 17.7). */
export function resourceUsageLevel(used: number | null, limit: number): "unknown" | "ok" | "warning" {
  if (used === null || limit <= 0) return "unknown";
  return used / limit >= 0.9 ? "warning" : "ok";
}

/** Portal thresholds (specs.md Phase 15.7): warn from 90 %, full at the limit. */
export function diskUsageLevel(usedBytes: number | null, limitBytes: number): DiskUsageLevel {
  if (usedBytes === null || limitBytes <= 0) return "unknown";
  if (usedBytes >= limitBytes) return "full";
  return usedBytes / limitBytes >= 0.9 ? "warning" : "ok";
}

/** Parses an administrator's GiB input (`20`, `1.5`); null unless a positive number. */
export function parseGibInput(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const bytes = Math.round(Number(trimmed) * 1024 ** 3);
  return bytes > 0 ? bytes : null;
}

const LOCK_SCOPE_LABELS: Record<string, string> = {
  login_ip: "账户 + 来源地址",
  ip: "来源地址",
  login: "账户（全部来源）",
  sso_start: "SSO 发起频率",
};

export function lockScopeLabel(scope: string): string {
  return LOCK_SCOPE_LABELS[scope] ?? scope;
}

/** Local time as YYYY-MM-DD HH:mm:ss, the Portal's single absolute timestamp format. */
export function formatAbsoluteTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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

const MODEL_ACCESS_REASON_LABELS: Record<string, string> = {
  MODEL_KEY_PENDING: "平台模型凭据正在签发，或模型网关暂时不可用",
  MODEL_RELAY_DISABLED: "该 Worker 未启用模型中继",
  USER_CONFIG_INVALID: "models.json 格式错误，平台模型未注入，请修复或删除该文件后重启 Workspace",
};

/** Text and tone for a Workspace's platform model access (specs.md Phase 16.8). */
export function modelAccessLabel(access: { status: string; reason: string | null }): {
  text: string;
  tone: "ok" | "muted" | "warn";
  detail: string | null;
} {
  switch (access.status) {
    case "available":
      return { text: "可用", tone: "ok", detail: null };
    case "pending":
      return { text: "启动后可用", tone: "muted", detail: null };
    case "unavailable":
      return {
        text: "暂不可用",
        tone: "warn",
        detail: access.reason === null ? null : (MODEL_ACCESS_REASON_LABELS[access.reason] ?? access.reason),
      };
    default:
      return { text: "未启用", tone: "muted", detail: null };
  }
}

/** USD amounts: cents below $100, whole dollars above. */
export function formatUsd(value: number | null): string {
  if (value === null) return "不限";
  return value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`;
}

/** Parses a budget input in USD; empty means "default", invalid input is null. */
export function parseUsdInput(text: string): number | "default" | null {
  const trimmed = text.trim();
  if (trimmed === "") return "default";
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value <= 1_000_000 ? value : null;
}
