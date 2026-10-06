// Shared record types, database row shapes and mappers used across domain repositories.
export type UserRole = "user" | "admin";
export type UserStatus = "active" | "disabled";

export type AuthenticationProtocol = "LOCAL" | "OIDC" | "OAUTH2";

export interface AuthenticationAuditMetadata {
  protocol: AuthenticationProtocol;
  providerId: string;
  requestId: string;
  ipAddress: string;
  userAgent: string | null;
}

export interface UserRecord {
  id: string;
  email: string | null;
  username: string | null;
  passwordHash: string | null;
  role: UserRole;
  status: UserStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthenticatedSessionRecord {
  sessionId: string;
  expiresAt: Date;
  user: Omit<UserRecord, "passwordHash">;
}

export interface WorkspaceRecord {
  id: string;
  userId: string;
  name: string;
  workerId: string | null;
  state:
    | "CREATED"
    | "SCHEDULING"
    | "STARTING"
    | "RUNNING"
    | "STOPPING"
    | "STOPPED"
    | "DELETING"
    | "ERROR"
    | "WORKER_OFFLINE";
  runtimeImage: string;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date;
  disk: WorkspaceDiskRecord;
}

/** The data-project limit and the Worker's latest usage sample (null until sampled). */
export interface WorkspaceDiskRecord {
  limitBytes: number;
  usedBytes: number | null;
  usedInodes: number | null;
  piUsedBytes: number | null;
  piLimitBytes: number | null;
  sampledAt: Date | null;
}

export interface UserRow {
  id: string;
  email: string | null;
  username: string | null;
  password_hash: string | null;
  role: UserRole;
  status: UserStatus;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface WorkspaceRow {
  id: string;
  user_id: string;
  name: string;
  worker_id: string | null;
  state: WorkspaceRecord["state"];
  runtime_image: string;
  created_at: Date;
  updated_at: Date;
  last_activity_at: Date;
  disk_limit_bytes: string;
  disk_used_bytes: string | null;
  disk_used_inodes: string | null;
  pi_used_bytes: string | null;
  pi_limit_bytes: string | null;
  disk_usage_at: Date | null;
}

function optionalNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

export function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role,
    status: row.status,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapWorkspace(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    workerId: row.worker_id,
    state: row.state,
    runtimeImage: row.runtime_image,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    disk: {
      limitBytes: Number(row.disk_limit_bytes),
      usedBytes: optionalNumber(row.disk_used_bytes),
      usedInodes: optionalNumber(row.disk_used_inodes),
      piUsedBytes: optionalNumber(row.pi_used_bytes),
      piLimitBytes: optionalNumber(row.pi_limit_bytes),
      sampledAt: row.disk_usage_at,
    },
  };
}
