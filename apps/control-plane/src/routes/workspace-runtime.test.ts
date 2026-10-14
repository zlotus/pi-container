import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildControlPlane } from "../app.js";
import {
  answerEgressApply,
  createTestDependencies,
  emptyReconciliation,
  login,
  NOW,
  ORIGIN,
  USER_A_ID,
  WORKER_1_TOKEN,
  workerHello,
} from "./test-fixtures.js";

const OLD = "agent-runtime:test-unassigned";
const NEW = "agent-runtime:phase18-pi1.1";

type Mode = "ok" | "refuse" | "fail";

interface RuntimeView {
  image: string;
  previousImage: string | null;
  upgradeAvailable: boolean;
  rollbackAvailable: boolean;
  changeIncomplete: boolean;
}

/** A Worker offering OLD and NEW that answers Runtime changes as `mode` says. */
async function setup(defaultRuntimeImage = NEW) {
  const dependencies = await createTestDependencies();
  dependencies.defaultRuntimeImage = defaultRuntimeImage;
  // An existing Workspace on the old image, created before the default changed.
  const workspaceId = randomUUID();
  await dependencies.store.createWorkspace({
    id: workspaceId,
    userId: USER_A_ID,
    name: "runtime-change",
    runtimeImage: OLD,
    diskLimitBytes: 20 * 1024 ** 3,
  });
  const app = buildControlPlane(dependencies);
  await app.ready();
  const worker = await app.injectWS("/api/workers/connect", {
    headers: { authorization: `Bearer ${WORKER_1_TOKEN}` },
  });
  const state = { mode: "ok" as Mode, image: OLD };
  const runtimeSets: Array<{ fromImage: string; toImage: string }> = [];
  /** The persisted state while each Runtime change command was in flight. */
  const statesDuringCommand: string[] = [];
  worker.on("message", async (data) => {
    if (answerEgressApply(worker, data)) return;
    const command = JSON.parse(data.toString()) as {
      requestId: string;
      type: string;
      payload: { workspaceId: string; runtimeImage?: string; fromImage?: string; toImage?: string };
    };
    if (command.type === "worker.reconcile") {
      worker.send(JSON.stringify(emptyReconciliation(command.requestId)));
      return;
    }
    const reply = (workspaceState: string, runtimeImage: string) =>
      worker.send(
        JSON.stringify({
          version: 6,
          type: "response.ok",
          requestId: command.requestId,
          payload: {
            requestType: command.type,
            workspace: {
              workspaceId: command.payload.workspaceId,
              state: workspaceState,
              runtimeImage,
              observedAt: NOW.toISOString(),
            },
          },
        }),
      );
    if (command.type === "workspace.runtime.set") {
      runtimeSets.push({ fromImage: command.payload.fromImage ?? "", toImage: command.payload.toImage ?? "" });
      statesDuringCommand.push((await dependencies.store.findWorkspaceById(command.payload.workspaceId))?.state ?? "");
      if (state.mode === "ok") {
        state.image = command.payload.toImage ?? "";
        reply("STOPPED", state.image);
        return;
      }
      worker.send(
        JSON.stringify({
          version: 6,
          type: "response.error",
          requestId: command.requestId,
          payload: {
            requestType: command.type,
            code: state.mode === "refuse" ? "RUNTIME_IMAGE_UNAVAILABLE" : "RUNTIME_ENGINE_ERROR",
            message: "Runtime change failed",
            retryable: state.mode === "fail",
          },
        }),
      );
      return;
    }
    if (command.type === "workspace.ensure") state.image = command.payload.runtimeImage ?? state.image;
    reply(command.type === "workspace.start" ? "RUNNING" : "STOPPED", state.image);
  });
  const hello = workerHello("worker-01");
  const [current] = hello.payload.runtimeImages;
  if (current === undefined) throw new Error("hello fixture without an image");
  hello.payload.runtimeImages.push({ ...current, image: NEW, runtimeVersion: "phase-18" });
  worker.send(JSON.stringify(hello));
  await new Promise<void>((resolve) => setImmediate(resolve));

  const owner = await login(app, "user-a", "password-for-user-a");
  const headers = (session: { cookie: string; csrfToken: string }) => ({
    cookie: session.cookie,
    origin: ORIGIN,
    "x-csrf-token": session.csrfToken,
  });
  const post = (url: string, session = owner, payload: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url, headers: headers(session), payload });
  const get = async () =>
    (
      await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}`, headers: { cookie: owner.cookie } })
    ).json<{ workspace: { state: string; runtime: RuntimeView } }>().workspace;
  return { app, state, runtimeSets, statesDuringCommand, owner, post, get, workspaceId };
}

describe("Workspace Runtime change routes (Phase 18.4, 18.8)", () => {
  it("upgrades a stopped Workspace to the default image and rolls it back", async () => {
    const { app, runtimeSets, statesDuringCommand, owner, post, get, workspaceId } = await setup();
    expect((await post(`/api/workspaces/${workspaceId}/start`)).statusCode).toBe(200);

    const running = await post(`/api/workspaces/${workspaceId}/runtime/upgrade`);
    expect(running.statusCode).toBe(409);
    expect(running.json()).toMatchObject({ error: { code: "WORKSPACE_NOT_STOPPED" } });
    expect((await get()).runtime).toMatchObject({ image: OLD, upgradeAvailable: false });

    expect((await post(`/api/workspaces/${workspaceId}/stop`)).statusCode).toBe(200);
    expect((await get()).runtime).toMatchObject({ upgradeAvailable: true, rollbackAvailable: false });

    const upgraded = await post(`/api/workspaces/${workspaceId}/runtime/upgrade`);
    expect(upgraded.statusCode).toBe(200);
    expect(upgraded.json()).toMatchObject({
      workspace: {
        state: "STOPPED",
        runtime: { image: NEW, previousImage: OLD, upgradeAvailable: false, rollbackAvailable: true },
      },
    });
    expect(runtimeSets).toEqual([{ fromImage: OLD, toImage: NEW }]);
    // The intent is persisted before the Worker acts on it.
    expect(statesDuringCommand).toEqual(["UPGRADING"]);
    expect((await post(`/api/workspaces/${workspaceId}/runtime/upgrade`)).json()).toMatchObject({
      error: { code: "RUNTIME_ALREADY_CURRENT" },
    });

    const rolledBack = await post(`/api/workspaces/${workspaceId}/runtime/rollback`);
    expect(rolledBack.statusCode).toBe(200);
    expect(rolledBack.json()).toMatchObject({ workspace: { runtime: { image: OLD, previousImage: NEW } } });
    expect(runtimeSets.at(-1)).toEqual({ fromImage: NEW, toImage: OLD });

    const audit = await app.inject({ method: "GET", url: "/api/audit-events", headers: { cookie: owner.cookie } });
    const types = audit.json<{ events: Array<{ eventType: string }> }>().events.map((event) => event.eventType);
    expect(types.filter((type) => type === "workspace.runtime_changed")).toHaveLength(2);
  });

  it("restores the Workspace when the Worker refuses and records an interrupted change", async () => {
    const { state, runtimeSets, post, get, workspaceId } = await setup();
    await post(`/api/workspaces/${workspaceId}/start`);
    await post(`/api/workspaces/${workspaceId}/stop`);

    state.mode = "refuse";
    const refused = await post(`/api/workspaces/${workspaceId}/runtime/upgrade`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: "RUNTIME_IMAGE_UNAVAILABLE" } });
    expect(await get()).toMatchObject({ state: "STOPPED", runtime: { image: OLD, previousImage: null } });

    state.mode = "fail";
    const failed = await post(`/api/workspaces/${workspaceId}/runtime/upgrade`);
    expect(failed.statusCode).toBe(503);
    expect(await get()).toMatchObject({
      state: "ERROR",
      runtime: { image: NEW, previousImage: OLD, changeIncomplete: true, rollbackAvailable: true },
    });
    const blocked = await post(`/api/workspaces/${workspaceId}/start`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: { code: "RUNTIME_CHANGE_INCOMPLETE" } });

    state.mode = "ok";
    const retried = await post(`/api/workspaces/${workspaceId}/runtime/retry`);
    expect(retried.statusCode).toBe(200);
    expect(runtimeSets.at(-1)).toEqual({ fromImage: OLD, toImage: NEW });
    expect(await get()).toMatchObject({
      state: "STOPPED",
      runtime: { image: NEW, previousImage: OLD, changeIncomplete: false },
    });
    expect((await post(`/api/workspaces/${workspaceId}/runtime/retry`)).json()).toMatchObject({
      error: { code: "RUNTIME_NO_INCOMPLETE_CHANGE" },
    });
  });

  it("lets only the owner change their Runtime, never by naming an image", async () => {
    const { app, post, workspaceId } = await setup();
    await post(`/api/workspaces/${workspaceId}/start`);
    await post(`/api/workspaces/${workspaceId}/stop`);
    const other = await login(app, "user-b", "password-for-user-b");

    expect((await post(`/api/workspaces/${workspaceId}/runtime/upgrade`, other)).statusCode).toBe(404);
    const withoutCsrf = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/runtime/upgrade`,
      headers: { cookie: other.cookie, origin: ORIGIN },
    });
    expect(withoutCsrf.statusCode).toBe(403);
    const named = await post(`/api/workspaces/${workspaceId}/runtime/upgrade`, undefined, { image: "agent-runtime:other" });
    expect(named.statusCode).toBe(200);
    expect(named.json()).toMatchObject({ workspace: { runtime: { image: NEW } } });
    // A user cannot reach the admin route that takes an image.
    expect((await post(`/api/admin/workspaces/${workspaceId}/runtime`, undefined, { image: OLD })).statusCode).toBe(403);
  });

  it("lets an admin switch any stopped Workspace to an image its Worker offers", async () => {
    const { app, post, runtimeSets, workspaceId } = await setup(OLD);
    await post(`/api/workspaces/${workspaceId}/start`);
    await post(`/api/workspaces/${workspaceId}/stop`);
    const admin = await login(app, "admin", "password-for-admin");

    const unknown = await post(`/api/admin/workspaces/${workspaceId}/runtime`, admin, { image: "agent-runtime:other" });
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json()).toMatchObject({ error: { code: "RUNTIME_IMAGE_UNAVAILABLE" } });
    const invalid = await post(`/api/admin/workspaces/${workspaceId}/runtime`, admin, { image: "../etc" });
    expect(invalid.statusCode).toBe(400);
    expect(runtimeSets).toEqual([]);

    const changed = await post(`/api/admin/workspaces/${workspaceId}/runtime`, admin, { image: NEW });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ workspace: { runtime: { image: NEW, previousImage: OLD } } });

    const workers = await app.inject({ method: "GET", url: "/api/admin/workers", headers: { cookie: admin.cookie } });
    expect(workers.json()).toMatchObject({
      workers: [
        {
          id: "worker-01",
          runtimeImages: [
            { image: OLD, workspaces: 0 },
            { image: NEW, workspaces: 1, runtimeVersion: "phase-18" },
          ],
        },
        expect.anything(),
      ],
    });
  });
});
