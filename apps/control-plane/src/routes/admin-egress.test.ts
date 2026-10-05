import { describe, expect, it } from "vitest";

import { buildControlPlane } from "../app.js";
import {
  answerEgressApply,
  createTestDependencies,
  emptyReconciliation,
  login,
  ORIGIN,
  WORKER_1_TOKEN,
  workerHello,
} from "./test-fixtures.js";

async function setup() {
  const dependencies = await createTestDependencies();
  dependencies.egressProtected = async () => ["192.168.1.10/32"];
  const app = buildControlPlane(dependencies);
  await app.ready();
  const user = await login(app, "user-a", "password-for-user-a");
  const admin = await login(app, "admin", "password-for-admin");
  const send = (
    method: "POST" | "DELETE",
    session: { cookie: string; csrfToken: string },
    url: string,
    payload?: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      headers: {
        cookie: session.cookie,
        origin: ORIGIN,
        "x-csrf-token": session.csrfToken,
        ...headers,
      },
      ...(payload === undefined ? {} : { payload }),
    });
  return { app, dependencies, user, admin, send };
}

describe("admin egress policy", () => {
  it("is admin-only and requires Origin and CSRF for changes", async () => {
    const { app, user, admin, send } = await setup();
    const allow = { action: "allow", network: "192.168.1.1" };

    expect((await app.inject({ method: "GET", url: "/api/admin/egress" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/egress", headers: { cookie: user.cookie } }))
        .statusCode,
    ).toBe(403);
    expect((await send("POST", user, "/api/admin/egress/rules", allow)).statusCode).toBe(403);
    expect(
      (await send("POST", admin, "/api/admin/egress/rules", allow, { "x-csrf-token": "wrong" }))
        .statusCode,
    ).toBe(403);
    expect(
      (await send("POST", admin, "/api/admin/egress/rules", allow, { origin: "https://evil.test" }))
        .statusCode,
    ).toBe(403);
    await app.close();
  });

  it("creates and deletes rules with revisions and audit, and shows the policy", async () => {
    const { app, dependencies, admin, send } = await setup();

    const created = await send("POST", admin, "/api/admin/egress/rules", {
      action: "allow",
      network: "192.168.1.1",
      protocol: "tcp",
      portMin: 80,
      description: "router admin page",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      revision: 1,
      rule: {
        action: "allow",
        network: "192.168.1.1/32",
        protocol: "tcp",
        portMin: 80,
        portMax: 80,
        description: "router admin page",
      },
    });

    const policy = await app.inject({
      method: "GET",
      url: "/api/admin/egress",
      headers: { cookie: admin.cookie },
    });
    expect(policy.json()).toMatchObject({
      revision: 1,
      defaultDeny: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
      protected: ["192.168.1.10/32"],
      rules: [{ network: "192.168.1.1/32" }],
      workers: [
        { id: "worker-01", enforced: false, revision: null },
        { id: "worker-02", enforced: false, revision: null },
      ],
    });

    const ruleId = created.json<{ rule: { id: string } }>().rule.id;
    const deleted = await send("DELETE", admin, `/api/admin/egress/rules/${ruleId}`);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ revision: 2 });
    expect((await send("DELETE", admin, `/api/admin/egress/rules/${ruleId}`)).statusCode).toBe(404);

    const audit = await app.inject({
      method: "GET",
      url: "/api/audit-events?category=egress",
      headers: { cookie: admin.cookie },
    });
    expect(
      audit.json<{ events: Array<{ eventType: string }> }>().events.map((event) => event.eventType),
    ).toEqual(["egress.rule_deleted", "egress.rule_created"]);
    expect(dependencies.testState.workers.every((worker) => !worker.egress.enforced)).toBe(true);
    await app.close();
  });

  it("rejects rules that are malformed, pointless, overlap protected addresses or duplicate", async () => {
    const { app, admin, send } = await setup();
    const post = (payload: Record<string, unknown>) =>
      send("POST", admin, "/api/admin/egress/rules", payload);

    for (const invalid of [
      { action: "allow", network: "192.168.1.1/24" }, // host bits
      { action: "allow", network: "fd00::/8" },
      { action: "allow", network: "10.0.0.0/7" }, // shorter than /8
      { action: "allow", network: "10.0.0.0/8", portMin: 80 }, // ports without protocol
      { action: "allow", network: "10.0.0.0/8", protocol: "tcp", portMin: 90, portMax: 80 },
      { action: "deny", network: "100.64.0.0/10", protocol: "tcp" },
      { action: "block", network: "10.0.0.0/8" },
      { action: "allow", network: "10.0.0.0/8", extra: true },
    ]) {
      expect((await post(invalid)).statusCode, JSON.stringify(invalid)).toBe(400);
    }
    expect((await post({ action: "allow", network: "8.8.8.8" })).json()).toMatchObject({
      error: { code: "EGRESS_ALLOW_OUTSIDE_DENY" },
    });
    expect((await post({ action: "allow", network: "192.168.1.0/24" })).json()).toMatchObject({
      error: { code: "EGRESS_ALLOW_OVERLAPS_PROTECTED" },
    });
    expect((await post({ action: "allow", network: "10.1.0.0/16" })).statusCode).toBe(201);
    expect((await post({ action: "allow", network: "10.1.0.0/16" })).json()).toMatchObject({
      error: { code: "EGRESS_RULE_EXISTS" },
    });
    await app.close();
  });

  it("refuses to delete a deny range that an allow rule depends on", async () => {
    const { app, admin, send } = await setup();
    const deny = await send("POST", admin, "/api/admin/egress/rules", {
      action: "deny",
      network: "100.64.0.0/10",
    });
    expect(deny.statusCode).toBe(201);
    const allow = await send("POST", admin, "/api/admin/egress/rules", {
      action: "allow",
      network: "100.100.100.100",
      protocol: "udp",
      portMin: 53,
    });
    expect(allow.statusCode).toBe(201);

    const denyId = deny.json<{ rule: { id: string } }>().rule.id;
    expect((await send("DELETE", admin, `/api/admin/egress/rules/${denyId}`)).json()).toMatchObject({
      error: { code: "EGRESS_RULE_IN_USE" },
    });
    const allowId = allow.json<{ rule: { id: string } }>().rule.id;
    expect((await send("DELETE", admin, `/api/admin/egress/rules/${allowId}`)).statusCode).toBe(200);
    expect((await send("DELETE", admin, `/api/admin/egress/rules/${denyId}`)).statusCode).toBe(200);
    await app.close();
  });

  it("pushes a changed policy to connected Workers and records what they enforce", async () => {
    const { app, dependencies, admin, send } = await setup();
    const worker = await app.injectWS("/api/workers/connect", {
      headers: { authorization: `Bearer ${WORKER_1_TOKEN}` },
    });
    const applied: Array<{ revision: number; allow: unknown[]; protected: string[] }> = [];
    const order: string[] = [];
    worker.on("message", (data) => {
      const command = JSON.parse(data.toString()) as {
        type: string;
        requestId: string;
        payload: { revision: number; allow: unknown[]; protected: string[] };
      };
      order.push(command.type);
      if (command.type === "worker.egress.apply") applied.push(command.payload);
      if (answerEgressApply(worker, data)) return;
      if (command.type === "worker.reconcile") {
        worker.send(JSON.stringify(emptyReconciliation(command.requestId)));
      }
    });
    worker.send(JSON.stringify(workerHello("worker-01")));
    await expect.poll(() => order).toEqual(["worker.egress.apply", "worker.reconcile"]);
    expect(applied[0]).toMatchObject({ revision: 0, allow: [], protected: ["192.168.1.10/32"] });

    await send("POST", admin, "/api/admin/egress/rules", { action: "allow", network: "10.5.0.0/16" });
    await expect.poll(() => applied.length).toBe(2);
    expect(applied[1]).toMatchObject({ revision: 1, allow: [{ network: "10.5.0.0/16" }] });
    await expect
      .poll(() => dependencies.testState.workers[0]?.egress)
      .toMatchObject({ enforced: true, revision: 1 });
    worker.terminate();
    await app.close();
  });
});
