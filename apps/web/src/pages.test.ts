import { afterEach, describe, expect, it, vi } from "vitest";

import { egressRuleText } from "./components/AuditEventRow.js";
import { egressRuleRequest, egressServiceText } from "./pages/AdminEgressPage.js";

import { api, ApiError } from "./api.js";
import {
  EMPTY_ADMIN_USER_FILTER,
  filterAdminUsers,
  runConfirmedAdminUserUpdate,
} from "./pages/AdminUsersPage.js";
import { filterAdminWorkspaces } from "./pages/AdminWorkspacesPage.js";
import type { AdminUser, AdminWorkspace } from "./types.js";

function user(overrides: Partial<AdminUser>): AdminUser {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    email: null,
    username: null,
    role: "user",
    status: "active",
    source: "local",
    workspaceCount: 0,
    lastLoginAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("Admin user filtering", () => {
  const users = [
    user({ id: "a", username: "alice", email: "alice@corp.test", role: "admin" }),
    user({ id: "b", username: "bob", source: "external", status: "disabled" }),
    user({ id: "c", username: null, email: "carol@corp.test" }),
  ];

  it("combines text search with source, role, and status", () => {
    const ids = (filter: Partial<typeof EMPTY_ADMIN_USER_FILTER>) =>
      filterAdminUsers(users, { ...EMPTY_ADMIN_USER_FILTER, ...filter }).map((entry) => entry.id);
    expect(ids({})).toEqual(["a", "b", "c"]);
    expect(ids({ query: "CORP.test" })).toEqual(["a", "c"]);
    expect(ids({ source: "external" })).toEqual(["b"]);
    expect(ids({ role: "admin", query: "carol" })).toEqual([]);
    expect(ids({ status: "disabled" })).toEqual(["b"]);
  });
});

describe("Admin Workspace filtering", () => {
  const workspace = (overrides: Partial<AdminWorkspace>): AdminWorkspace => ({
    id: "w",
    name: "w",
    workerId: null,
    state: "RUNNING",
    createdAt: "2026-09-01T00:00:00.000Z",
    disk: { limitBytes: 20 * 1024 ** 3, usedBytes: null, usedInodes: null, piUsedBytes: null, piLimitBytes: null, sampledAt: null },
    updatedAt: "2026-09-01T00:00:00.000Z",
    lastActivityAt: "2026-09-01T00:00:00.000Z",
    owner: { id: "u", username: "alice", email: null },
    ...overrides,
  });
  const workspaces = [
    workspace({ id: "1", name: "build", workerId: "worker-a" }),
    workspace({ id: "2", name: "docs", workerId: null, state: "CREATED", owner: { id: "v", username: "bob", email: null } }),
  ];

  it("filters by owner text, state, and unassigned Worker", () => {
    const ids = (filter: { query?: string; state?: string; workerId?: string }) =>
      filterAdminWorkspaces(workspaces, { query: "", state: "", workerId: "", ...filter })
        .map((entry) => entry.id);
    expect(ids({ query: "bob" })).toEqual(["2"]);
    expect(ids({ state: "RUNNING" })).toEqual(["1"]);
    expect(ids({ workerId: "__none__" })).toEqual(["2"]);
    expect(ids({ workerId: "worker-a" })).toEqual(["1"]);
  });
});

describe("API error localization", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubError(status: number, body: unknown) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
  }

  it("translates known codes and keeps the server message for unknown ones", async () => {
    stubError(409, { error: { code: "WORKSPACE_NAME_EXISTS", message: "Workspace name already exists" } });
    await expect(api("/api/workspaces")).rejects.toMatchObject({
      message: "已存在同名 Workspace",
      code: "WORKSPACE_NAME_EXISTS",
      status: 409,
    });

    stubError(409, { error: { code: "SOMETHING_NEW", message: "Something new happened" } });
    await expect(api("/api/workspaces")).rejects.toMatchObject({ message: "Something new happened" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 502 })));
    const error = await api("/api/workspaces").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe("请求失败（HTTP 502）");
  });
});

describe("Asynchronous confirmation", () => {
  it("waits for a dialog-style confirmation before sending the request", async () => {
    const target = { email: null, username: "alice", role: "user" as const };
    const request = vi.fn(async () => undefined);
    await expect(
      runConfirmedAdminUserUpdate(target, { status: "disabled" }, async () => false, request),
    ).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
    await expect(
      runConfirmedAdminUserUpdate(target, { status: "disabled" }, async () => true, request),
    ).resolves.toBe(true);
    expect(request).toHaveBeenCalledOnce();
  });
});

describe("Admin egress rules", () => {
  const base = { action: "allow", network: " 192.168.1.1 ", protocol: "", ports: "", description: "" };

  it("builds API bodies for whole networks, protocols and port ranges", () => {
    expect(egressRuleRequest(base)).toEqual({ body: { action: "allow", network: "192.168.1.1" } });
    expect(egressRuleRequest({ ...base, protocol: "tcp", ports: "80", description: " router " })).toEqual({
      body: { action: "allow", network: "192.168.1.1", protocol: "tcp", portMin: 80, portMax: 80, description: "router" },
    });
    expect(egressRuleRequest({ ...base, protocol: "udp", ports: "8000 - 8100" })).toMatchObject({
      body: { protocol: "udp", portMin: 8000, portMax: 8100 },
    });
    // A deny range never carries a service.
    expect(egressRuleRequest({ ...base, action: "deny", protocol: "tcp", ports: "80" })).toEqual({
      body: { action: "deny", network: "192.168.1.1" },
    });
  });

  it("explains unusable port input instead of sending it", () => {
    expect(egressRuleRequest({ ...base, ports: "80" })).toEqual({ error: "指定端口时需要选择协议" });
    expect(egressRuleRequest({ ...base, protocol: "tcp", ports: "http" })).toEqual({
      error: "端口格式应为 80 或 8000-8100",
    });
  });

  it("describes rules and their audit events", () => {
    expect(egressServiceText({ protocol: null, portMin: null, portMax: null })).toBe("全部");
    expect(egressServiceText({ protocol: "udp", portMin: null, portMax: null })).toBe("udp 全部端口");
    expect(egressServiceText({ protocol: "tcp", portMin: 80, portMax: 81 })).toBe("tcp 80-81");
    expect(
      egressRuleText({ action: "allow", network: "10.0.0.0/8", protocol: "tcp", portMin: 443, portMax: 443 }),
    ).toBe("放行 10.0.0.0/8 tcp 443");
    expect(egressRuleText({ action: "deny", network: "100.64.0.0/10", protocol: null })).toBe(
      "拒绝 100.64.0.0/10",
    );
    expect(egressRuleText({ protocol: "LOCAL" })).toBeNull();
  });
});
