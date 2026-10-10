import { describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { loadWorkerConfig } from "./config.js";
import {
  buildWorkerHeartbeat,
  buildWorkerHello,
  currentArchitecture,
  type WorkerEgress,
  WorkerDaemon,
  type WorkerStorage,
  type WorkspaceRuntime,
} from "./daemon.js";
import { EgressApplyError } from "./egress/controller.js";
import type { WorkerModelAccess } from "./model-relay/access.js";

const config = loadWorkerConfig({
  CONTROL_PLANE_URL: "wss://control.internal/api/workers/connect",
  WORKER_ID: "worker-01",
  WORKER_TOKEN: "0123456789abcdef0123456789abcdef",
  WORKER_GATEWAY_TOKEN: "gateway0123456789abcdef0123456789abcdef",
  WORKSPACE_BASE_URL: "https://agent.example.internal",
  WORKER_MAX_WORKSPACES: "8",
});

function fakeRuntime(): WorkspaceRuntime {
  return {
    ensure: vi.fn<WorkspaceRuntime["ensure"]>(),
    start: vi.fn<WorkspaceRuntime["start"]>(),
    stop: vi.fn<WorkspaceRuntime["stop"]>(),
    delete: vi.fn<WorkspaceRuntime["delete"]>(),
    inspect: vi.fn<WorkspaceRuntime["inspect"]>(),
    reconcile: vi.fn<WorkspaceRuntime["reconcile"]>(),
    allocatedWorkspaces: vi.fn().mockResolvedValue(0),
    stopRunningWorkspaces: vi.fn().mockResolvedValue([]),
    setDiskLimit: vi.fn<WorkspaceRuntime["setDiskLimit"]>(),
    diskUsage: vi.fn<WorkspaceRuntime["diskUsage"]>().mockResolvedValue([]),
    configureModelProvider: vi.fn<WorkspaceRuntime["configureModelProvider"]>().mockResolvedValue("removed"),
  };
}

const STORAGE_STATUS = { enforced: true, fsType: "xfs", totalBytes: 1_000, freeBytes: 500 };
const HOST_USAGE = { cpuUtilization: null, memoryTotalBytes: 8, memoryAvailableBytes: 4, load1: 0 };

function fakeStorage(enforced = true): WorkerStorage {
  const status = { ...STORAGE_STATUS, enforced };
  return {
    status: vi.fn().mockReturnValue(status),
    check: vi.fn().mockResolvedValue(status),
  };
}

function fakeEgress(enforced = true): WorkerEgress {
  return {
    status: vi.fn().mockReturnValue({ enforced, revision: null }),
    ensure: vi.fn().mockResolvedValue({ enforced, revision: null }),
    apply: vi.fn(),
  };
}

const capabilities = {
  browser: true,
  office: true,
  ffmpeg: true,
  python: true,
  node: true,
  rust: true,
};

async function listen(): Promise<{ server: WebSocketServer; url: string }> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP test server address");
  }
  return { server, url: `ws://127.0.0.1:${address.port}` };
}

describe("worker daemon messages", () => {
  it("logs the probe root cause and closes without sending hello", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a TCP test server address");
    }
    let closed: { code: number; reason: string } | undefined;
    const message = vi.fn();
    server.on("connection", (socket) => {
      socket.on("message", message);
      socket.on("close", (code, reason) => {
        closed = { code, reason: reason.toString() };
      });
    });
    const runtime = fakeRuntime();
    const rootCause = new Error("Docker image not found");
    const error = new Error("Capability probe failed", { cause: rootCause });
    const log = { info: vi.fn(), warn: vi.fn() };
    const daemon = new WorkerDaemon(
      { ...config, CONTROL_PLANE_URL: `ws://127.0.0.1:${address.port}` },
      runtime,
      { probe: vi.fn().mockRejectedValue(error) },
      fakeEgress(),
      fakeStorage(),
      log,
    );
    try {
      daemon.start();
      await vi.waitFor(() => {
        expect(closed).toEqual({
          code: 1011,
          reason: "Configured Runtime image unavailable or unverified",
        });
      });
      expect(log.warn).toHaveBeenCalledWith(
        { workerId: "worker-01", err: error },
        "could not verify the configured Runtime image",
      );
      expect(message).not.toHaveBeenCalled();
    } finally {
      daemon.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports probed Runtime capabilities, egress state and bounded host capacity", () => {
    const message = buildWorkerHello(config, {
      hostname: "worker-01.internal",
      architecture: "arm64",
      logicalCpuCount: 8,
      memoryBytes: 16 * 1024 ** 3,
    }, capabilities, { enforced: true, revision: 4 }, STORAGE_STATUS);

    expect(message).toMatchObject({
      version: 5,
      type: "worker.hello",
      payload: {
        workerId: "worker-01",
        capabilities: {
          browser: true,
          office: true,
          ffmpeg: true,
          python: true,
          node: true,
          rust: true,
        },
        maxWorkspaces: 8,
        allocatedWorkspaces: 0,
        egress: { enforced: true, revision: 4 },
        storage: STORAGE_STATUS,
      },
    });
  });

  it("uses a fresh request id and timestamp for each heartbeat", () => {
    const first = buildWorkerHeartbeat(
      "worker-01",
      new Date("2026-09-10T08:00:00.000Z"),
      { enforced: false, revision: null },
      STORAGE_STATUS,
      HOST_USAGE,
    );
    const second = buildWorkerHeartbeat(
      "worker-01",
      new Date("2026-09-10T08:00:10.000Z"),
      { enforced: true, revision: 1 },
      STORAGE_STATUS,
      HOST_USAGE,
    );

    expect(first.requestId).not.toBe(second.requestId);
    expect(first.payload).toMatchObject({
      workerId: "worker-01",
      egress: { enforced: false, revision: null },
      observedAt: "2026-09-10T08:00:00.000Z",
    });
  });

  it("maps only supported MVP architectures", () => {
    expect(currentArchitecture("x64")).toBe("amd64");
    expect(currentArchitecture("arm64")).toBe("arm64");
    expect(() => currentArchitecture("riscv64")).toThrow(
      "Unsupported Worker architecture",
    );
  });

});

describe("worker daemon egress", () => {
  it("stops running Workspaces when the egress rules cannot be enforced", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.stopRunningWorkspaces).mockResolvedValue([
      "8d6f5c43-0d3a-4f53-9d84-3f8c0f3e7a10",
    ]);
    const log = { info: vi.fn(), warn: vi.fn() };
    const daemon = new WorkerDaemon(
      config,
      runtime,
      { probe: vi.fn() },
      fakeEgress(false),
      fakeStorage(),
      log,
    );

    await expect(daemon.checkEgress()).resolves.toEqual({
      enforced: false,
      revision: null,
    });
    expect(runtime.stopRunningWorkspaces).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(
      {
        workerId: "worker-01",
        workspaceIds: ["8d6f5c43-0d3a-4f53-9d84-3f8c0f3e7a10"],
        reason: "egress rules are not enforced",
      },
      "stopped running Workspaces to fail closed",
    );
  });

  it("leaves running Workspaces alone while the egress rules are enforced", async () => {
    const runtime = fakeRuntime();
    const daemon = new WorkerDaemon(
      config,
      runtime,
      { probe: vi.fn() },
      fakeEgress(true),
      fakeStorage(),
      { info: vi.fn(), warn: vi.fn() },
    );

    await daemon.checkEgress();
    expect(runtime.stopRunningWorkspaces).not.toHaveBeenCalled();
  });

  it("answers worker.egress.apply with the applied status or a typed error", async () => {
    const { server, url } = await listen();
    const egress = fakeEgress(true);
    vi.mocked(egress.apply)
      .mockResolvedValueOnce({ enforced: true, revision: 7 })
      .mockRejectedValueOnce(new EgressApplyError("nft could not apply"));
    const received: unknown[] = [];
    let workerSocket: WebSocket | undefined;
    server.on("connection", (socket) => {
      workerSocket = socket;
      socket.on("message", (data) => received.push(JSON.parse(data.toString())));
    });
    const daemon = new WorkerDaemon(
      { ...config, CONTROL_PLANE_URL: url },
      fakeRuntime(),
      { probe: vi.fn().mockResolvedValue(capabilities) },
      egress,
      fakeStorage(),
      { info: vi.fn(), warn: vi.fn() },
    );
    const policy = {
      revision: 7,
      allow: [{ network: "192.168.1.1/32", protocol: "tcp", portMin: 80, portMax: 80 }],
      denyExtra: [],
      protected: ["10.0.0.5/32"],
    };
    try {
      daemon.start();
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]).toMatchObject({
        type: "worker.hello",
        payload: { egress: { enforced: true, revision: null } },
      });
      for (const requestId of [
        "6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d01",
        "6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d02",
      ]) {
        workerSocket?.send(
          JSON.stringify({
            version: 5,
            type: "worker.egress.apply",
            requestId,
            payload: policy,
          }),
        );
      }
      await vi.waitFor(() => expect(received).toHaveLength(3));
      expect(egress.apply).toHaveBeenCalledWith(policy);
      expect(received[1]).toEqual({
        version: 5,
        type: "response.ok",
        requestId: "6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d01",
        payload: {
          requestType: "worker.egress.apply",
          egress: { enforced: true, revision: 7 },
        },
      });
      expect(received[2]).toEqual({
        version: 5,
        type: "response.error",
        requestId: "6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d02",
        payload: {
          requestType: "worker.egress.apply",
          code: "EGRESS_APPLY_FAILED",
          message: "Egress rules could not be applied",
          retryable: true,
        },
      });
    } finally {
      daemon.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("worker daemon disk quotas", () => {
  it("stops running Workspaces when quotas are not enforced, and only then", async () => {
    for (const enforced of [false, true]) {
      const runtime = fakeRuntime();
      const daemon = new WorkerDaemon(
        config,
        runtime,
        { probe: vi.fn() },
        fakeEgress(true),
        fakeStorage(enforced),
        { info: vi.fn(), warn: vi.fn() },
      );
      await daemon.checkStorage();
      expect(vi.mocked(runtime.stopRunningWorkspaces).mock.calls.length).toBe(enforced ? 0 : 1);
    }
  });

  it("reports storage in hello and heartbeats and sends each usage sample once", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { server, url } = await listen();
    const runtime = fakeRuntime();
    const sample = {
      workspaceId: "8d6f5c43-0d3a-4f53-9d84-3f8c0f3e7a10",
      dataUsedBytes: 1,
      dataLimitBytes: 2,
      dataUsedInodes: 3,
      piUsedBytes: 4,
      piLimitBytes: 5,
    };
    vi.mocked(runtime.diskUsage).mockResolvedValue([sample]);
    vi.mocked(runtime.setDiskLimit).mockResolvedValue({ dataLimitBytes: 5 * 1024 ** 3, dataUsedBytes: 7 });
    const received: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let workerSocket: WebSocket | undefined;
    server.on("connection", (socket) => {
      workerSocket = socket;
      socket.on("message", (data) => received.push(JSON.parse(data.toString())));
    });
    const daemon = new WorkerDaemon(
      { ...config, CONTROL_PLANE_URL: url },
      runtime,
      { probe: vi.fn().mockResolvedValue(capabilities) },
      fakeEgress(true),
      fakeStorage(true),
      { info: vi.fn(), warn: vi.fn() },
    );
    try {
      daemon.start();
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]?.payload.storage).toEqual(STORAGE_STATUS);
      await daemon.sampleDiskUsage();
      await vi.advanceTimersByTimeAsync(config.WORKER_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(received).toHaveLength(2));
      expect(received[1]?.payload).toMatchObject({ storage: STORAGE_STATUS, workspaceDisk: [sample] });
      await vi.advanceTimersByTimeAsync(config.WORKER_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(received).toHaveLength(3));
      expect(received[2]?.payload.workspaceDisk).toBeUndefined();

      workerSocket?.send(
        JSON.stringify({
          version: 5,
          type: "workspace.storage.set",
          requestId: "6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d03",
          payload: { workspaceId: sample.workspaceId, diskLimitBytes: 5 * 1024 ** 3 },
        }),
      );
      await vi.waitFor(() => expect(received.some((entry) => entry.type === "response.ok")).toBe(true));
      expect(runtime.setDiskLimit).toHaveBeenCalledWith(sample.workspaceId, 5 * 1024 ** 3);
      expect(received.find((entry) => entry.type === "response.ok")?.payload).toEqual({
        requestType: "workspace.storage.set",
        storage: { workspaceId: sample.workspaceId, dataLimitBytes: 5 * 1024 ** 3, dataUsedBytes: 7 },
      });
    } finally {
      daemon.stop();
      vi.useRealTimers();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("worker daemon model access (Phase 16.9)", () => {
  const workspaceId = "8d6f5c43-0d3a-4f53-9d84-3f8c0f3e7a10";
  const keyAlias = `arw-${workspaceId}-2`;
  const SECRET = "sk-virtual-key-from-gateway";
  const catalog = {
    providerId: "platform",
    defaultModel: "deepseek-v4-flash",
    models: [{ id: "deepseek-v4-flash", api: "openai-completions" as const }],
  };

  function fakeModelAccess(): WorkerModelAccess {
    const held = new Map<string, string>();
    return {
      status: () => ({ enabled: true, port: 3101, listening: true }),
      relayPort: () => 3101,
      holdings: () => [...held].map(([id, alias]) => ({ workspaceId: id, keyAlias: alias })),
      setKey: vi.fn(async (id: string, alias: string) => {
        held.set(id, alias);
      }),
      clearKey: vi.fn(async (id: string, alias: string) => {
        if (held.get(id) === alias) held.delete(id);
        return held.get(id) ?? null;
      }),
      forget: vi.fn((id: string) => {
        held.delete(id);
      }),
      refresh: vi.fn(async () => undefined),
    };
  }

  it("reports the relay, stores and clears keys, and writes the provider on ensure", async () => {
    const { server, url } = await listen();
    const runtime = fakeRuntime();
    const observation = {
      workspaceId,
      state: "STOPPED" as const,
      runtimeImage: config.RUNTIME_IMAGE,
      observedAt: "2026-10-08T08:00:00.000Z",
    };
    vi.mocked(runtime.ensure).mockResolvedValue(observation);
    vi.mocked(runtime.configureModelProvider).mockResolvedValue("applied");
    vi.mocked(runtime.reconcile).mockResolvedValue({ workspaces: [], issues: [], observedAt: observation.observedAt });
    vi.mocked(runtime.delete).mockResolvedValue({ ...observation, state: "CREATED" });
    const modelAccess = fakeModelAccess();
    const warn = vi.fn();
    const received: Array<{ type: string; requestId?: string; payload: Record<string, unknown> }> = [];
    const raw: string[] = [];
    let workerSocket: WebSocket | undefined;
    server.on("connection", (socket) => {
      workerSocket = socket;
      socket.on("message", (data) => {
        raw.push(data.toString());
        received.push(JSON.parse(data.toString()));
      });
    });
    const daemon = new WorkerDaemon(
      { ...config, CONTROL_PLANE_URL: url },
      runtime,
      { probe: vi.fn().mockResolvedValue(capabilities) },
      fakeEgress(true),
      fakeStorage(true),
      { info: vi.fn(), warn },
      modelAccess,
    );
    const command = (type: string, requestId: string, payload: Record<string, unknown>) =>
      workerSocket?.send(JSON.stringify({ version: 5, type, requestId, payload }));
    const response = (requestId: string) => received.find((entry) => entry.requestId === requestId);
    try {
      daemon.start();
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]?.payload.modelRelay).toEqual({ enabled: true, port: 3101, listening: true });

      command("workspace.ensure", "6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d11", {
        workspaceId,
        runtimeImage: config.RUNTIME_IMAGE,
        resources: { cpuCount: 2, memoryBytes: 4 * 1024 ** 3, pidsLimit: 512 },
        storage: { diskLimitBytes: 20 * 1024 ** 3 },
        modelGateway: catalog,
      });
      await vi.waitFor(() => expect(response("6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d11")).toBeDefined());
      expect(runtime.configureModelProvider).toHaveBeenCalledWith(workspaceId, catalog, 3101);
      expect(response("6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d11")?.payload).toEqual({
        requestType: "workspace.ensure",
        workspace: observation,
        modelConfig: "applied",
      });

      command("workspace.model_key.set", "6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d12", { workspaceId, keyAlias, secret: SECRET });
      await vi.waitFor(() => expect(response("6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d12")).toBeDefined());
      expect(modelAccess.setKey).toHaveBeenCalledWith(workspaceId, keyAlias, SECRET);
      expect(response("6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d12")?.payload).toEqual({
        requestType: "workspace.model_key.set",
        modelKey: { workspaceId, keyAlias },
      });

      command("worker.reconcile", "6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d13", { assignments: [] });
      await vi.waitFor(() => expect(response("6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d13")).toBeDefined());
      expect(response("6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d13")?.payload).toMatchObject({
        reconciliation: { modelKeys: [{ workspaceId, keyAlias }] },
      });

      // A late clear of an older key keeps the current one.
      command("workspace.model_key.clear", "6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d17", {
        workspaceId,
        keyAlias: `arw-${workspaceId}-1`,
      });
      await vi.waitFor(() => expect(response("6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d17")).toBeDefined());
      expect(response("6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d17")?.payload).toEqual({
        requestType: "workspace.model_key.clear",
        modelKey: { workspaceId, keyAlias },
      });
      command("workspace.model_key.clear", "6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d14", { workspaceId, keyAlias });
      await vi.waitFor(() => expect(response("6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d14")).toBeDefined());
      expect(response("6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d14")?.payload).toEqual({
        requestType: "workspace.model_key.clear",
        modelKey: { workspaceId, keyAlias: null },
      });

      command("workspace.delete", "6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d15", { workspaceId });
      await vi.waitFor(() => expect(response("6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d15")).toBeDefined());
      expect(modelAccess.forget).toHaveBeenCalledWith(workspaceId);

      // A failing provider write never fails the ensure (model access is not isolation).
      vi.mocked(runtime.configureModelProvider).mockRejectedValueOnce(new Error("disk full"));
      command("workspace.ensure", "6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d16", {
        workspaceId,
        runtimeImage: config.RUNTIME_IMAGE,
        resources: { cpuCount: 2, memoryBytes: 4 * 1024 ** 3, pidsLimit: 512 },
        storage: { diskLimitBytes: 20 * 1024 ** 3 },
        modelGateway: null,
      });
      await vi.waitFor(() => expect(response("6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d16")).toBeDefined());
      expect(response("6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d16")).toMatchObject({
        type: "response.ok",
        payload: { modelConfig: "write_failed" },
      });

      // The secret is never echoed back to the Control Plane.
      expect(raw.join("\n")).not.toContain(SECRET);
    } finally {
      daemon.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("answers a key for a Worker without the relay with a typed error", async () => {
    const { server, url } = await listen();
    const received: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let workerSocket: WebSocket | undefined;
    server.on("connection", (socket) => {
      workerSocket = socket;
      socket.on("message", (data) => received.push(JSON.parse(data.toString())));
    });
    const daemon = new WorkerDaemon(
      { ...config, CONTROL_PLANE_URL: url },
      fakeRuntime(),
      { probe: vi.fn().mockResolvedValue(capabilities) },
      fakeEgress(true),
      fakeStorage(true),
      { info: vi.fn(), warn: vi.fn() },
    );
    try {
      daemon.start();
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]?.payload.modelRelay).toEqual({ enabled: false, port: null, listening: false });
      workerSocket?.send(
        JSON.stringify({
          version: 5,
          type: "workspace.model_key.set",
          requestId: "6a1c49ea-1f53-4c55-8a38-9a0f8f2f0d21",
          payload: { workspaceId, keyAlias, secret: SECRET },
        }),
      );
      await vi.waitFor(() => expect(received).toHaveLength(2));
      expect(received[1]).toMatchObject({
        type: "response.error",
        payload: { requestType: "workspace.model_key.set", code: "MODEL_RELAY_DISABLED", retryable: false },
      });
    } finally {
      daemon.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
