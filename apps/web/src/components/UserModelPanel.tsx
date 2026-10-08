import { type FormEvent, useCallback, useEffect, useState } from "react";

import { api, ApiError } from "../api.js";
import { formatAbsoluteTime, formatUsd, parseUsdInput } from "../labels.js";
import type { ModelUsage, SessionResponse } from "../types.js";
import { ConfirmDialog } from "./Modal.js";

interface UserModelUsage {
  budgetUsd: number | null;
  available: boolean;
  usage: ModelUsage | null;
}

/**
 * One user's platform model usage, budget override and key rotation (specs.md Phase 16.8).
 * Renders nothing when platform models are not configured.
 */
export function UserModelPanel({ session, userId }: { session: SessionResponse; userId: string }) {
  const [state, setState] = useState<UserModelUsage | null | "disabled">(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await api<UserModelUsage>(`/api/admin/users/${userId}/model-usage`));
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "MODEL_GATEWAY_DISABLED") setState("disabled");
      else setError(caught instanceof Error ? caught.message : "无法载入模型用量");
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveBudget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseUsdInput(String(new FormData(event.currentTarget).get("budget") ?? ""));
    if (parsed === null) {
      setError("预算须为 0～1000000 之间、最多两位小数的美元金额；留空表示使用默认预算");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await api<{ appliedToGateway: boolean }>(`/api/admin/users/${userId}/model-budget`, {
        method: "PUT",
        headers: { "x-csrf-token": session.csrfToken },
        body: JSON.stringify({ budgetUsd: parsed === "default" ? null : parsed }),
      });
      setNotice(result.appliedToGateway ? "预算已更新" : "预算已保存，模型网关暂不可用，将在下次签发凭据时生效");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法更新预算");
    } finally {
      setPending(false);
    }
  }

  async function rotate() {
    setPending(true);
    setError(null);
    try {
      const result = await api<{ revoked: number }>(`/api/admin/users/${userId}/model-keys/rotate`, {
        method: "POST",
        headers: { "x-csrf-token": session.csrfToken },
        body: "{}",
      });
      setNotice(`已作废 ${result.revoked} 个模型凭据，运行中的 Workspace 会自动获得新凭据`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法轮换模型凭据");
    } finally {
      setPending(false);
      setRotateOpen(false);
    }
  }

  if (state === "disabled") return null;
  return (
    <div className="detail-block">
      <strong>平台模型</strong>
      {error === null ? null : <p className="error" role="alert">{error}</p>}
      {notice === null ? null : <p className="muted" role="status">{notice}</p>}
      {state === null ? (
        <p className="muted">正在载入…</p>
      ) : (
        <>
          <p>
            {!state.available
              ? "模型网关暂不可用，无法获取用量。"
              : state.usage === null
                ? "本周期尚未使用平台模型。"
                : `本周期花费 ${formatUsd(state.usage.spendUsd)} / 预算 ${formatUsd(state.usage.maxBudgetUsd)}` +
                  (state.usage.budgetResetAt === null ? "" : `，${formatAbsoluteTime(state.usage.budgetResetAt)} 重置`)}
          </p>
          <form className="inline-form" onSubmit={(event) => void saveBudget(event)}>
            <label>
              每周期预算（美元，留空为默认）
              <input
                name="budget"
                inputMode="decimal"
                defaultValue={state.budgetUsd === null ? "" : String(state.budgetUsd)}
                aria-label="每周期预算（美元）"
              />
            </label>
            <button type="submit" className="secondary" disabled={pending}>保存预算</button>
            <button type="button" className="secondary" disabled={pending} onClick={() => setRotateOpen(true)}>
              轮换模型凭据…
            </button>
          </form>
        </>
      )}
      <ConfirmDialog
        open={rotateOpen}
        title="轮换模型凭据"
        confirmLabel="轮换"
        pending={pending}
        tone="primary"
        onConfirm={() => void rotate()}
        onCancel={() => setRotateOpen(false)}
      >
        <p>将作废该用户全部 Workspace 的平台模型凭据并在网关中删除。</p>
        <p>运行中的 Workspace 会自动获得新凭据，正在执行的 Agent 任务不受影响。用于怀疑凭据泄露（例如 Worker 主机）时。</p>
      </ConfirmDialog>
    </div>
  );
}
