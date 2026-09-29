export interface User {
  id: string;
  email: string | null;
  username: string | null;
  role: "user" | "admin";
  status: "active" | "disabled";
}

export interface AdminUser extends User {
  source: "local" | "external";
  workspaceCount: number;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  workerId: string | null;
  state: string;
  createdAt: string;
}

export interface AdminWorkspace extends Workspace {
  updatedAt: string;
  lastActivityAt: string;
  owner: { id: string; username: string | null; email: string | null };
}

export interface Worker {
  id: string;
  hostname: string | null;
  architecture: "amd64" | "arm64" | null;
  status: "ONLINE" | "OFFLINE" | "DISABLED";
  /** false when an admin paused new placements on this Worker. */
  schedulable: boolean;
  runtimeImage: string | null;
  runtimeVersion: string | null;
  capabilities: Record<string, boolean>;
  maxWorkspaces: number | null;
  assignedWorkspaces: number;
  allocatedWorkspaces: number;
  systemResources: {
    logicalCpuCount: number | null;
    memoryBytes: number | null;
  };
  lastHeartbeatAt: string | null;
}

export interface AuditEvent {
  id: string;
  eventType: string;
  actorUserId: string | null;
  ownerUserId: string | null;
  workspaceId: string | null;
  workerId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface SessionResponse {
  user: User;
  csrfToken: string;
}

export interface AuthMethodsResponse {
  oidc: { enabled: boolean; providerId: string | null };
  oauth2: { enabled: boolean; providerId: string | null };
}

export interface ExternalIdentity {
  id: string;
  userId: string;
  providerId: string;
  providerSubject: string;
  usernameSnapshot: string | null;
  emailSnapshot: string | null;
  displayNameSnapshot: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface WorkspaceOpenResponse {
  exchangeUrl: string;
  code: string;
}
