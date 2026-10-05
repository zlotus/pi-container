import { Writable } from "node:stream";

import { createJsonLogger } from "@agent-runtime/logging";
import { describe, expect, it } from "vitest";

import { buildControlPlane } from "../app.js";
import {
  beginOAuth2Login,
  beginOidcLogin,
  configureTestOAuth2,
  configureTestOidc,
  createTestDependencies,
  NOW,
  ORIGIN,
  USER_A_ID,
  WORKER_1_TOKEN,
  workerHello,
} from "./test-fixtures.js";

const WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  return { lines, stream };
}

describe("Control Plane request logging", () => {
  it("logs route templates and request IDs but never credentials or callback codes", async () => {
    const { lines, stream } = capture();
    const dependencies = await createTestDependencies([
      {
        id: WORKSPACE_ID,
        userId: USER_A_ID,
        name: "logged-workspace",
        workerId: "worker-01",
        state: "RUNNING",
        runtimeImage: "agent-runtime:test-unassigned",
        createdAt: NOW,
        updatedAt: NOW,
        lastActivityAt: NOW,
      },
    ]);
    dependencies.log = createJsonLogger(
      "control-plane",
      { LOG_LEVEL: "trace", LOG_FORMAT: "json" },
      stream,
    );
    configureTestOidc(dependencies);
    configureTestOAuth2(dependencies);
    const app = buildControlPlane(dependencies);
    await app.ready();

    const failedLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { login: "user-a", password: "wrong-password-in-body" },
    });
    expect(failedLogin.statusCode).toBe(401);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { login: "user-a", password: "password-for-user-a" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
    const rawSession = cookie.split("=")[1] ?? "";
    const csrfToken = login.json<{ csrfToken: string }>().csrfToken;
    const open = await app.inject({
      method: "POST",
      url: `/api/workspaces/${WORKSPACE_ID}/open`,
      headers: { cookie, origin: ORIGIN, "x-csrf-token": csrfToken },
      payload: {},
    });
    expect(open.statusCode).toBe(200);
    const exchangeCode = open.json<{ code: string }>().code;

    const oidcTransaction = await beginOidcLogin(app);
    await app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=oidc-code-must-not-be-logged&state=expected-state",
      headers: { cookie: oidcTransaction },
    });
    const oauth2Transaction = await beginOAuth2Login(app);
    await app.inject({
      method: "GET",
      url: "/auth/oauth2/callback?code=oauth-code-must-not-be-logged&state=oauth-expected-state",
      headers: { cookie: oauth2Transaction },
    });
    const worker = await app.injectWS("/api/workers/connect", {
      headers: { authorization: `Bearer ${WORKER_1_TOKEN}` },
    });
    worker.send(JSON.stringify(workerHello("worker-01")));
    await new Promise<void>((resolve) => setImmediate(resolve));
    worker.close();
    await app.close();

    const output = lines.join("");
    for (const secret of [
      "wrong-password-in-body",
      "password-for-user-a",
      rawSession,
      csrfToken,
      exchangeCode,
      "oidc-code-must-not-be-logged",
      "oauth-code-must-not-be-logged",
      "expected-state",
      WORKER_1_TOKEN,
    ]) {
      expect(secret.length).toBeGreaterThan(8);
      expect(output).not.toContain(secret);
    }

    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const completed = records.filter((record) => record.msg === "request completed");
    const openLog = completed.find(
      (record) => (record.req as { route?: string } | undefined)?.route === "/api/workspaces/:id/open",
    );
    expect(openLog).toMatchObject({
      service: "control-plane",
      userId: USER_A_ID,
      req: { method: "POST", route: "/api/workspaces/:id/open" },
      res: { statusCode: 200 },
    });
    expect(openLog?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(completed.map((record) => (record.req as { route?: string }).route)).toEqual(
      expect.arrayContaining(["/api/auth/login", "/auth/oidc/callback", "/auth/oauth2/callback"]),
    );
  });
});
