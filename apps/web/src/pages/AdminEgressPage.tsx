import { type FormEvent, useCallback, useEffect, useState } from "react";

import { api } from "../api.js";
import { ConfirmDialog, Modal } from "../components/Modal.js";
import { RelativeTime } from "../components/RelativeTime.js";
import type { EgressPolicyResponse, EgressRule, SessionResponse } from "../types.js";

export interface EgressRuleForm {
  action: string;
  network: string;
  protocol: string;
  ports: string;
  description: string;
}

/**
 * Turns the form into the API body. Ports are `80` or `8000-8100`; returns an error text
 * instead when the input cannot be sent. The server re-validates everything.
 */
export function egressRuleRequest(
  form: EgressRuleForm,
): { body: Record<string, unknown> } | { error: string } {
  const action = form.action === "deny" ? "deny" : "allow";
  const body: Record<string, unknown> = { action, network: form.network.trim() };
  if (form.description.trim() !== "") body.description = form.description.trim();
  if (action === "deny") return { body };
  if (form.protocol === "tcp" || form.protocol === "udp") body.protocol = form.protocol;
  const ports = form.ports.trim();
  if (ports === "") return { body };
  if (body.protocol === undefined) return { error: "指定端口时需要选择协议" };
  const match = /^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/.exec(ports);
  if (match === null) return { error: "端口格式应为 80 或 8000-8100" };
  body.portMin = Number(match[1]);
  body.portMax = Number(match[2] ?? match[1]);
  return { body };
}

export function egressServiceText(rule: Pick<EgressRule, "protocol" | "portMin" | "portMax">): string {
  if (rule.protocol === null) return "全部";
  if (rule.portMin === null || rule.portMax === null) return `${rule.protocol} 全部端口`;
  return `${rule.protocol} ${rule.portMin === rule.portMax ? rule.portMin : `${rule.portMin}-${rule.portMax}`}`;
}

const EMPTY_FORM: EgressRuleForm = { action: "allow", network: "", protocol: "", ports: "", description: "" };

export function AdminEgressPage({ session }: { session: SessionResponse }) {
  const [policy, setPolicy] = useState<EgressPolicyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<EgressRuleForm>(EMPTY_FORM);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<EgressRule | null>(null);
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setPolicy(await api<EgressPolicyResponse>("/api/admin/egress"));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法载入出口策略");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function createRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = egressRuleRequest(form);
    if ("error" in request) {
      setCreateError(request.error);
      return;
    }
    setPending(true);
    try {
      await api("/api/admin/egress/rules", {
        method: "POST",
        headers: { "x-csrf-token": session.csrfToken },
        body: JSON.stringify(request.body),
      });
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      await refresh();
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : "无法添加出口规则");
    } finally {
      setPending(false);
    }
  }

  async function deleteRule(rule: EgressRule) {
    setPending(true);
    try {
      await api(`/api/admin/egress/rules/${rule.id}`, {
        method: "DELETE",
        headers: { "x-csrf-token": session.csrfToken },
      });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法删除出口规则");
    } finally {
      setPending(false);
      setDeleteTarget(null);
    }
  }

  const rules = policy?.rules ?? [];
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>网络出口</h1>
          <p>Workspace 默认可以访问公网，不能访问内网与 Worker 宿主机。这里管理内网放行规则和额外的拒绝网段。</p>
        </div>
        <div className="page-toolbar">
          <button className="secondary" onClick={() => void refresh()}>刷新</button>
          <button onClick={() => { setCreateError(null); setForm(EMPTY_FORM); setCreateOpen(true); }}>添加规则</button>
        </div>
      </div>
      {error === null ? null : <p className="error banner" role="alert">{error}</p>}

      <section className="user-panel" aria-label="默认规则">
        <dl className="worker-details">
          <div><dt>策略版本</dt><dd>{policy?.revision ?? "—"}</dd></div>
          <div><dt>默认拒绝</dt><dd>{policy?.defaultDeny.join("、") ?? "—"}，以及 Worker 宿主机的全部地址</dd></div>
          <div><dt>平台保护地址（永不放行）</dt><dd>{policy === null ? "—" : policy.protected.length === 0 ? "无（Worker 另行保护其 Control Plane 地址）" : policy.protected.join("、")}</dd></div>
        </dl>
      </section>

      <section className="user-panel" aria-label="出口规则">
        {policy === null ? (
          <p className="muted">正在载入出口策略…</p>
        ) : rules.length === 0 ? (
          <p className="muted">尚无规则：所有内网目标均被拒绝。</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>类型</th><th>网段</th><th>协议与端口</th><th>说明</th><th>添加于</th><th>操作</th></tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <td><span className={`state ${rule.action === "allow" ? "worker-online" : "worker-offline"}`}>{rule.action === "allow" ? "放行" : "拒绝"}</span></td>
                    <td><strong>{rule.network}</strong></td>
                    <td>{rule.action === "allow" ? egressServiceText(rule) : "—"}</td>
                    <td>{rule.description === "" ? "—" : rule.description}</td>
                    <td><RelativeTime value={rule.createdAt} /></td>
                    <td><button className="secondary compact-button" disabled={pending} onClick={() => setDeleteTarget(rule)}>删除</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="user-panel" aria-label="Worker 出口状态">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Worker</th><th>出口规则</th><th>已应用版本</th><th>最近确认</th></tr>
            </thead>
            <tbody>
              {(policy?.workers ?? []).map((worker) => (
                <tr key={worker.id}>
                  <td><strong>{worker.id}</strong>{worker.enabled ? null : <small>已停用</small>}</td>
                  <td>
                    {worker.enforced ? (
                      <span className="state worker-online">已生效</span>
                    ) : (
                      <span className="state worker-offline" title="该 Worker 不会启动任何 Workspace">未生效</span>
                    )}
                  </td>
                  <td>{worker.revision === null ? "—" : worker.revision === policy?.revision ? `${worker.revision}（最新）` : `${worker.revision}（待更新）`}</td>
                  <td><RelativeTime value={worker.checkedAt} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Modal open={createOpen} title="添加出口规则" onClose={() => setCreateOpen(false)}>
        <form className="modal-body" onSubmit={(event) => void createRule(event)}>
          <label>
            类型
            <select value={form.action} onChange={(event) => setForm({ ...form, action: event.target.value })}>
              <option value="allow">放行（内网白名单）</option>
              <option value="deny">拒绝（额外的拒绝网段）</option>
            </select>
          </label>
          <label>
            网段
            <input value={form.network} onChange={(event) => setForm({ ...form, network: event.target.value })} placeholder="192.168.1.10 或 10.20.0.0/16" maxLength={18} required autoFocus />
          </label>
          {form.action === "allow" ? (
            <>
              <label>
                协议
                <select value={form.protocol} onChange={(event) => setForm({ ...form, protocol: event.target.value })}>
                  <option value="">全部协议与端口</option>
                  <option value="tcp">TCP</option>
                  <option value="udp">UDP</option>
                </select>
              </label>
              <label>
                端口（可选）
                <input value={form.ports} onChange={(event) => setForm({ ...form, ports: event.target.value })} placeholder="80 或 8000-8100，留空表示全部端口" maxLength={11} />
              </label>
            </>
          ) : null}
          <label>
            说明（可选）
            <input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} maxLength={200} />
          </label>
          <p className="muted modal-note">
            放行规则只能位于内网（RFC1918）或已有拒绝网段之内，且不能包含平台保护地址；Worker 宿主机地址始终不可放行。规则对所有 Worker 立即生效。
          </p>
          {createError === null ? null : <p className="error" role="alert">{createError}</p>}
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={() => setCreateOpen(false)}>取消</button>
            <button type="submit" disabled={pending}>添加</button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除出口规则"
        confirmLabel="删除"
        pending={pending}
        onConfirm={() => {
          if (deleteTarget !== null) void deleteRule(deleteTarget);
        }}
        onCancel={() => setDeleteTarget(null)}
      >
        <p>
          删除{deleteTarget?.action === "allow" ? "放行" : "拒绝"}规则 <strong>{deleteTarget?.network}</strong>？
        </p>
        <p>{deleteTarget?.action === "allow" ? "删除后，Workspace 到该目标的连接（包括已建立的连接）会立即被拒绝。" : "删除后，该网段中的公网地址将重新允许访问。"}</p>
      </ConfirmDialog>
    </>
  );
}
