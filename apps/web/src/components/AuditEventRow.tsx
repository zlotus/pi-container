import { authProtocolLabel, transitionValueLabel } from "../labels.js";
import type { AuditEvent, User, Workspace } from "../types.js";
import { AbsoluteTime } from "./RelativeTime.js";

const AUDIT_LABELS: Record<string, string> = {
  "workspace.created": "Workspace 已创建",
  "workspace.scheduled": "Workspace 已分配运行资源",
  "workspace.starting": "Workspace 正在启动",
  "workspace.running": "Workspace 已启动",
  "workspace.opened": "已打开 Workspace",
  "workspace.stopping": "Workspace 正在停止",
  "workspace.stopped": "Workspace 已停止",
  "workspace.deleting": "Workspace 正在删除",
  "workspace.deleted": "Workspace 已永久删除",
  "workspace.error": "Workspace 运行异常",
  "workspace.worker_offline": "Worker 已离线",
  "worker.registered": "Worker 已添加",
  "worker.online": "Worker 已上线",
  "worker.offline": "Worker 已离线",
  "worker.disabled": "Worker 已禁用",
  "worker.scheduling_paused": "Worker 已暂停调度",
  "worker.scheduling_resumed": "Worker 已恢复调度",
  "worker.runtime_reported": "Worker 运行环境已更新",
  "identity.bound": "登录方式已绑定",
  "identity.unbound": "登录方式已解绑",
  "auth.login_succeeded": "登录成功",
  "auth.login_failed": "登录失败",
  "auth.logout": "已退出登录",
  "auth.session_revoked": "登录会话已撤销",
  "user.created": "用户已创建",
  "user.enabled": "用户已启用",
  "user.disabled": "用户已禁用",
  "user.role_changed": "用户角色已变更",
  "user.password_reset": "本地密码已重置",
};

export type AuditSeverity = "success" | "info" | "warning" | "danger";

const AUDIT_SEVERITY: Record<string, AuditSeverity> = {
  "auth.login_succeeded": "success",
  "workspace.running": "success",
  "worker.online": "success",
  "worker.scheduling_resumed": "success",
  "user.enabled": "success",
  "auth.login_failed": "danger",
  "workspace.error": "danger",
  "workspace.worker_offline": "danger",
  "worker.offline": "danger",
  "auth.session_revoked": "warning",
  "user.disabled": "warning",
  "user.role_changed": "warning",
  "user.password_reset": "warning",
  "identity.unbound": "warning",
  "workspace.deleted": "warning",
  "worker.disabled": "warning",
  "worker.scheduling_paused": "warning",
};

export function auditSeverity(eventType: string): AuditSeverity {
  return AUDIT_SEVERITY[eventType] ?? "info";
}

const SEVERITY_LABELS: Record<AuditSeverity, string> = {
  success: "成功",
  info: "信息",
  warning: "注意",
  danger: "异常",
};

function auditDetail(details: Record<string, unknown>): string | null {
  const fromState = details.fromState;
  const toState = details.toState;
  if (typeof fromState === "string" && typeof toState === "string") {
    return `${transitionValueLabel(fromState)} → ${transitionValueLabel(toState)}`;
  }
  const fromStatus = details.fromStatus;
  const toStatus = details.toStatus;
  if (typeof fromStatus === "string" && typeof toStatus === "string") {
    return `${transitionValueLabel(fromStatus)} → ${transitionValueLabel(toStatus)}`;
  }
  const fromRole = details.fromRole;
  const toRole = details.toRole;
  if (typeof fromRole === "string" && typeof toRole === "string") {
    return `${transitionValueLabel(fromRole)} → ${transitionValueLabel(toRole)}`;
  }
  const protocol = details.protocol;
  const category = details.category;
  if (typeof protocol === "string" && typeof category === "string") {
    return `${authProtocolLabel(protocol)} · ${category}`;
  }
  return typeof protocol === "string" ? authProtocolLabel(protocol) : null;
}

function auditUserName(
  userId: string,
  users: readonly Pick<User, "id" | "username" | "email">[],
): string {
  const user = users.find((candidate) => candidate.id === userId);
  return user?.username ?? user?.email ?? userId.slice(0, 8);
}

export interface AuditEventDescription {
  label: string;
  subject: string;
  detail: string | null;
  severity: AuditSeverity;
  severityLabel: string;
}

/** Single source of the human-readable event text, shared by the list and the CSV export. */
export function describeAuditEvent(
  event: AuditEvent,
  workspaces: readonly Pick<Workspace, "id" | "name">[],
  users: readonly Pick<User, "id" | "username" | "email">[],
  isAdmin: boolean,
): AuditEventDescription {
  const workspace = workspaces.find((candidate) => candidate.id === event.workspaceId);
  const recordedName = event.details.name;
  const workspaceName = workspace?.name ??
    (typeof recordedName === "string" ? recordedName : null) ??
    (event.workspaceId === null ? "平台" : `${event.workspaceId.slice(0, 8)}…`);
  const isUserEvent = ["auth.", "user.", "identity."].some(
    (prefix) => event.eventType.startsWith(prefix),
  );
  const targetUserId = event.ownerUserId ?? event.actorUserId;
  const actor = event.actorUserId;
  const isWorkerAdminEvent = event.eventType.startsWith("worker.scheduling_");
  const workspaceSubject = isAdmin && event.workspaceId !== null && event.ownerUserId !== null
    ? `${workspaceName}（${auditUserName(event.ownerUserId, users)}）`
    : workspaceName;
  const subject = isAdmin && isUserEvent && targetUserId !== null
    ? `${auditUserName(targetUserId, users)}${
      actor !== null && actor !== targetUserId
        ? ` · 操作者 ${auditUserName(actor, users)}`
        : ""
    }`
    : isAdmin && isWorkerAdminEvent && actor !== null
      ? `操作者 ${auditUserName(actor, users)}`
      : workspaceSubject;
  const severity = auditSeverity(event.eventType);
  return {
    label: AUDIT_LABELS[event.eventType] ?? event.eventType,
    subject,
    detail: auditDetail(event.details),
    severity,
    severityLabel: SEVERITY_LABELS[severity],
  };
}

export function AuditEventRow({
  event,
  workspaces,
  adminUsers,
  isAdmin,
}: {
  event: AuditEvent;
  workspaces: readonly Pick<Workspace, "id" | "name">[];
  adminUsers: readonly Pick<User, "id" | "username" | "email">[];
  isAdmin: boolean;
}) {
  const { label, subject, detail, severity, severityLabel } = describeAuditEvent(
    event,
    workspaces,
    adminUsers,
    isAdmin,
  );

  return (
    <li>
      <span className={`audit-dot audit-${severity}`} role="img" aria-label={severityLabel} title={severityLabel} />
      <div>
        <strong>{label}</strong>
        <p>{subject}{event.workerId === null ? "" : ` · ${event.workerId}`}{detail === null ? "" : ` · ${detail}`}</p>
      </div>
      <AbsoluteTime value={event.createdAt} />
    </li>
  );
}
