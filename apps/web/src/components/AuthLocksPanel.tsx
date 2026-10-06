import { useCallback, useEffect, useState } from "react";

import { api } from "../api.js";
import { formatAbsoluteTime, lockScopeLabel } from "../labels.js";
import type { AuthLock, SessionResponse } from "../types.js";
import { useConfirm } from "./Modal.js";

/** Who or what an active login lock applies to, in one line. */
export function authLockSubject(lock: AuthLock): string {
  const user = lock.user === null ? null : (lock.user.email ?? lock.user.id.slice(0, 8));
  return [user, lock.ipAddress].filter((part) => part !== null).join(" · ") || "未知账户";
}

/** Active login locks with a manual release (specs.md Phase 15.9). */
export function AuthLocksPanel({ session }: { session: SessionResponse }) {
  const [locks, setLocks] = useState<AuthLock[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  const refresh = useCallback(async () => {
    try {
      setLocks((await api<{ locks: AuthLock[] }>("/api/admin/auth/locks")).locks);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法载入登录锁定");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function release(lock: AuthLock) {
    const confirmed = await confirm({
      title: "解除登录锁定",
      message: `解除对 ${authLockSubject(lock)}（${lockScopeLabel(lock.scope)}）的锁定？该操作会记入审计。`,
      confirmLabel: "解除锁定",
    });
    if (!confirmed) return;
    setPendingId(lock.id);
    try {
      await api(`/api/admin/auth/locks/${lock.id}`, {
        method: "DELETE",
        headers: { "x-csrf-token": session.csrfToken },
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "解除失败");
    } finally {
      setPendingId(null);
      await refresh();
    }
  }

  return (
    <section className="user-panel" aria-label="登录锁定">
      <div className="filter-bar">
        <strong>登录锁定</strong>
        <span className="muted">连续登录失败触发的临时锁定，到期自动解除。</span>
        <button className="secondary compact-button" onClick={() => void refresh()}>刷新</button>
      </div>
      {error === null ? null : <p className="error" role="alert">{error}</p>}
      {locks.length === 0 ? (
        <p className="muted">当前没有生效的登录锁定。</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>对象</th><th>范围</th><th>失败次数</th><th>解除时间</th><th>操作</th></tr>
            </thead>
            <tbody>
              {locks.map((lock) => (
                <tr key={lock.id}>
                  <td>{authLockSubject(lock)}</td>
                  <td>{lockScopeLabel(lock.scope)}</td>
                  <td>{lock.failures}</td>
                  <td>{formatAbsoluteTime(lock.lockedUntil)}</td>
                  <td>
                    <button
                      className="secondary compact-button"
                      disabled={pendingId === lock.id}
                      onClick={() => void release(lock)}
                    >解除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {confirmDialog}
    </section>
  );
}
