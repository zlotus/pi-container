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
  };
}
