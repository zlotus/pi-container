import { Fragment, type FormEvent, useCallback, useEffect, useState } from "react";

import { api, ApiError } from "../api.js";
import type {
  AdminUser,
  ExternalIdentity,
  SessionResponse,
  User,
  Workspace,
} from "../types.js";

export type AdminUserUpdate = { role?: User["role"]; status?: User["status"] };

interface AdminUserUpdateTarget {
  email: string | null;
  username: string | null;
  role: User["role"];
}

export function adminUserUpdateConfirmation(
  user: AdminUserUpdateTarget,
  update: AdminUserUpdate,
): string {
  const identifier = user.username ?? user.email ?? "external user";
  if (update.status !== undefined) {
    return `${update.status === "active" ? "Enable" : "Disable"} user "${identifier}"?`;
  }
  return `Change "${identifier}" role from ${user.role} to ${update.role}?`;
}

export function confirmAdminUserUpdate(
  user: AdminUserUpdateTarget,
  update: AdminUserUpdate,
  confirm: (message: string) => boolean,
): boolean {
  return confirm(adminUserUpdateConfirmation(user, update));
}

export async function runConfirmedAdminUserUpdate(
  user: AdminUserUpdateTarget,
  update: AdminUserUpdate,
  confirm: (message: string) => boolean,
  request: () => Promise<void>,
): Promise<boolean> {
  if (!confirmAdminUserUpdate(user, update, confirm)) return false;
  await request();
  return true;
}

export function adminUsersErrorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof ApiError) {
    return caught.code === undefined
      ? caught.message
      : `${caught.code}: ${caught.message}`;
  }
  return caught instanceof Error ? caught.message : fallback;
}

export function AdminUsersPage({
  session,
  oidcProviderId,
  oauth2ProviderId,
  onSessionChanged,
  onSessionEnded,
}: {
  session: SessionResponse;
  oidcProviderId: string | null;
  oauth2ProviderId: string | null;
  onSessionChanged: (session: SessionResponse) => void;
  onSessionEnded: () => void;
}) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [workspaceUserId, setWorkspaceUserId] = useState<string | null>(null);
  const [managedWorkspaces, setManagedWorkspaces] = useState<Workspace[]>([]);
  const [identityUserId, setIdentityUserId] = useState<string | null>(null);
  const [managedIdentities, setManagedIdentities] = useState<ExternalIdentity[]>([]);

  const loadUsers = useCallback(async () => {
    const result = await api<{ users: AdminUser[] }>("/api/admin/users");
    setUsers(result.users);
  }, []);

  const refreshUsers = useCallback(async () => {
    setError(null);
    try {
      await loadUsers();
    } catch (caught) {
      setError(adminUsersErrorMessage(caught, "Unable to load Users"));
    }
  }, [loadUsers]);

  useEffect(() => {
    let active = true;
    void loadUsers()
      .catch((caught: unknown) => {
        if (active) setError(adminUsersErrorMessage(caught, "Unable to load Users"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadUsers]);

  async function createLocalUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setError(null);
    try {
      await api("/api/admin/users", {
        method: "POST",
        headers: { "x-csrf-token": session.csrfToken },
        body: JSON.stringify({
          email: form.get("email"),
          username: form.get("username") || undefined,
          password: form.get("password"),
        }),
      });
      formElement.reset();
      await loadUsers();
    } catch (caught) {
      setError(adminUsersErrorMessage(caught, "Unable to create Local User"));
    }
  }

  async function updateManagedUser(user: AdminUser, update: AdminUserUpdate) {
    await runConfirmedAdminUserUpdate(
      user,
      update,
      (message) => window.confirm(message),
      async () => {
        setError(null);
        setPendingUserId(user.id);
        try {
          const result = await api<{ user: AdminUser }>(`/api/admin/users/${user.id}`, {
            method: "PATCH",
            headers: { "x-csrf-token": session.csrfToken },
            body: JSON.stringify(update),
          });
          if (user.id === session.user.id) {
            if (result.user.status === "disabled") {
              onSessionEnded();
              return;
            }
            onSessionChanged({
              ...session,
              user: {
                ...session.user,
                role: result.user.role,
                status: result.user.status,
              },
            });
            if (result.user.role !== "admin") return;
          }
          await loadUsers();
        } catch (caught) {
          setError(adminUsersErrorMessage(caught, "Unable to update User"));
        } finally {
          setPendingUserId(null);
        }
      },
    );
  }

  async function resetManagedPassword(user: AdminUser) {
    const password = window.prompt(`为 ${user.username ?? user.email ?? user.id} 设置新密码（至少 12 个字符）`);
    if (password === null) return;
    setError(null);
    setPendingUserId(user.id);
    try {
      await api(`/api/admin/users/${user.id}/reset-password`, {
        method: "POST",
        headers: { "x-csrf-token": session.csrfToken },
        body: JSON.stringify({ password }),
      });
    } catch (caught) {
      setError(adminUsersErrorMessage(caught, "Unable to reset password"));
    } finally {
      setPendingUserId(null);
    }
  }

  async function bindManagedIdentity(user: AdminUser, providerId: string) {
    const providerSubject = window.prompt(
      `将 ${providerId} 的精确 subject 绑定到 ${user.username ?? user.email ?? user.id}`,
    );
    if (providerSubject === null || providerSubject.length === 0) return;
    setError(null);
    setPendingUserId(user.id);
    try {
      await api(`/api/admin/users/${user.id}/identities`, {
        method: "POST",
        headers: { "x-csrf-token": session.csrfToken },
        body: JSON.stringify({ providerId, providerSubject }),
      });
    } catch (caught) {
      setError(adminUsersErrorMessage(caught, "Unable to bind external identity"));
    } finally {
      setPendingUserId(null);
    }
  }

  async function toggleManagedIdentities(user: AdminUser) {
    if (identityUserId === user.id) {
      setIdentityUserId(null);
      setManagedIdentities([]);
      return;
    }
    setError(null);
    setPendingUserId(user.id);
    try {
      const result = await api<{ identities: ExternalIdentity[] }>(
        `/api/admin/users/${user.id}/identities`,
      );
      setManagedIdentities(result.identities);
      setIdentityUserId(user.id);
    } catch (caught) {
      setError(adminUsersErrorMessage(caught, "Unable to load external identities"));
    } finally {
      setPendingUserId(null);
    }
  }

  async function unbindManagedIdentity(user: AdminUser, identity: ExternalIdentity) {
    if (!window.confirm(`解除 ${identity.providerId} / ${identity.providerSubject} 的绑定？`)) return;
    setError(null);
    setPendingUserId(user.id);
    try {
      await api(`/api/admin/users/${user.id}/identities/${identity.id}`, {
        method: "DELETE",
        headers: { "x-csrf-token": session.csrfToken },
      });
      const result = await api<{ identities: ExternalIdentity[] }>(
        `/api/admin/users/${user.id}/identities`,
      );
      setManagedIdentities(result.identities);
    } catch (caught) {
      setError(adminUsersErrorMessage(caught, "Unable to unbind external identity"));
    } finally {
      setPendingUserId(null);
    }
  }

  async function revokeManagedSessions(user: AdminUser) {
    if (!window.confirm(`撤销 ${user.username ?? user.email ?? user.id} 的全部登录会话？`)) return;
    setError(null);
    setPendingUserId(user.id);
    try {
      await api(`/api/admin/users/${user.id}/revoke-sessions`, {
        method: "POST",
        headers: { "x-csrf-token": session.csrfToken },
        body: "{}",
      });
      if (user.id === session.user.id) onSessionEnded();
    } catch (caught) {
      setError(adminUsersErrorMessage(caught, "Unable to revoke sessions"));
    } finally {
      setPendingUserId(null);
    }
  }

  async function toggleManagedWorkspaces(user: AdminUser) {
    if (workspaceUserId === user.id) {
      setWorkspaceUserId(null);
      setManagedWorkspaces([]);
      return;
    }
    setError(null);
    setPendingUserId(user.id);
    try {
      const result = await api<{ workspaces: Workspace[] }>(
        `/api/admin/users/${user.id}/workspaces`,
      );
      setManagedWorkspaces(result.workspaces);
      setWorkspaceUserId(user.id);
    } catch (caught) {
      setError(adminUsersErrorMessage(caught, "Unable to load Workspace information"));
    } finally {
      setPendingUserId(null);
    }
  }

  function toggleDetails(userId: string) {
    if (expandedUserId === userId) {
      setExpandedUserId(null);
      setWorkspaceUserId(null);
      setIdentityUserId(null);
      setManagedWorkspaces([]);
      setManagedIdentities([]);
      return;
    }
    setExpandedUserId(userId);
    setWorkspaceUserId(null);
    setIdentityUserId(null);
    setManagedWorkspaces([]);
    setManagedIdentities([]);
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">ADMIN</p>
          <h1>Users</h1>
          <p>管理平台用户及其登录方式和访问权限。</p>
        </div>
        <button className="secondary" onClick={() => void refreshUsers()}>刷新</button>
      </div>
      {error === null ? null : <p className="error banner" role="alert">{error}</p>}
      <section className="user-panel" aria-labelledby="create-user-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">NEW USER</p>
            <h2 id="create-user-title">创建本地用户</h2>
          </div>
        </div>
        <form className="user-create-form" onSubmit={createLocalUser}>
          <input name="email" type="email" placeholder="email@example.com" maxLength={320} required />
          <input name="username" placeholder="username（可选）" minLength={3} maxLength={64} pattern="[a-z0-9][a-z0-9._-]{2,63}" />
          <input name="password" type="password" placeholder="初始密码（至少 12 位）" minLength={12} maxLength={1024} autoComplete="new-password" required />
          <button type="submit">创建本地用户</button>
        </form>
      </section>
      <section className="user-panel" aria-labelledby="users-list-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">USERS</p>
            <h2 id="users-list-title">用户列表</h2>
          </div>
        </div>
        {loading ? (
          <p className="muted">正在载入用户…</p>
        ) : users.length === 0 ? (
          <p className="muted">尚无用户记录。</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>User</th><th>来源</th><th>Role</th><th>状态</th><th>Workspace</th><th>最近登录</th><th>管理</th></tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <Fragment key={user.id}>
                    <tr>
                      <td><strong>{user.username ?? user.email ?? user.id}</strong><small>{user.email ?? "无 email"}</small></td>
                      <td>{user.source === "local" ? "Local" : "External"}</td>
                      <td><span className="state">{user.role}</span></td>
                      <td><span className={`state user-${user.status}`}>{user.status}</span></td>
                      <td>{user.workspaceCount}</td>
                      <td>{user.lastLoginAt === null ? "—" : new Date(user.lastLoginAt).toLocaleString()}</td>
                      <td>
                        <button
                          className="secondary compact-button"
                          aria-expanded={expandedUserId === user.id}
                          onClick={() => toggleDetails(user.id)}
                        >{expandedUserId === user.id ? "收起" : "管理"}</button>
                      </td>
                    </tr>
                    {expandedUserId === user.id ? (
                      <tr className="metadata-row">
                        <td colSpan={7}>
                          <div className="table-actions">
                            <button className="secondary" disabled={pendingUserId === user.id} onClick={() => void updateManagedUser(user, { status: user.status === "active" ? "disabled" : "active" })}>{user.status === "active" ? "禁用" : "启用"}</button>
                            <button className="secondary" disabled={pendingUserId === user.id} onClick={() => void updateManagedUser(user, { role: user.role === "admin" ? "user" : "admin" })}>设为 {user.role === "admin" ? "user" : "admin"}</button>
                            {user.source === "local" ? <button className="secondary" disabled={pendingUserId === user.id} onClick={() => void resetManagedPassword(user)}>重置密码</button> : null}
                            {oidcProviderId === null ? null : <button className="secondary" disabled={pendingUserId === user.id} onClick={() => void bindManagedIdentity(user, oidcProviderId)}>绑定 OIDC subject</button>}
                            {oauth2ProviderId === null ? null : <button className="secondary" disabled={pendingUserId === user.id} onClick={() => void bindManagedIdentity(user, oauth2ProviderId)}>绑定 OAuth2 subject</button>}
                            <button className="secondary" disabled={pendingUserId === user.id} onClick={() => void toggleManagedIdentities(user)}>登录方式</button>
                            <button className="secondary" disabled={pendingUserId === user.id} onClick={() => void revokeManagedSessions(user)}>撤销会话</button>
                            <button className="secondary" disabled={pendingUserId === user.id} onClick={() => void toggleManagedWorkspaces(user)}>Workspace 信息</button>
                          </div>
                          {workspaceUserId === user.id ? (
                            <div className="detail-block">
                              <strong>Workspace 信息</strong>
                              {managedWorkspaces.length === 0 ? <p className="muted">该用户没有 Workspace。</p> : (
                                <ul>{managedWorkspaces.map((workspace) => <li key={workspace.id}><strong>{workspace.name}</strong><span>{workspace.state} · {workspace.workerId ?? "未分配"} · {workspace.id}</span></li>)}</ul>
                              )}
                            </div>
                          ) : null}
                          {identityUserId === user.id ? (
                            <div className="detail-block">
                              <strong>登录方式</strong>
                              {managedIdentities.length === 0 ? <p className="muted">该用户没有外部登录方式。</p> : (
                                <ul>{managedIdentities.map((identity) => <li key={identity.id}><strong>{identity.providerId}</strong><span>{identity.providerSubject}{identity.emailSnapshot === null ? "" : ` · ${identity.emailSnapshot}`}{identity.lastLoginAt === null ? "" : ` · 最近登录 ${new Date(identity.lastLoginAt).toLocaleString()}`}</span><button className="secondary" disabled={pendingUserId === user.id} onClick={() => void unbindManagedIdentity(user, identity)}>解绑</button></li>)}</ul>
                              )}
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
