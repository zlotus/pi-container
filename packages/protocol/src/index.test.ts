import { describe, expect, it } from "vitest";

import {
  ControlToWorkerMessageSchema,
  WorkerToControlMessageSchema,
} from "./index.js";

const requestId = "0d17d4a0-c25a-43fd-a2eb-3d9ca7c5976c";
const workspaceId = "90b38efc-aa9a-4bc6-8eee-528b4e0c7c60";

describe("worker protocol", () => {
  it("accepts a versioned worker hello", () => {
    const parsed = WorkerToControlMessageSchema.parse({
      version: 5,
      type: "worker.hello",
      requestId,
      payload: {
        workerId: "worker-arm64-01",
        hostname: "worker-arm64-01.internal",
        architecture: "arm64",
        runtimeImage: "registry.internal/agent-runtime",
        runtimeVersion: "phase-3.1",
        capabilities: {
          browser: false,
          office: false,
          ffmpeg: false,
          python: true,
          node: true,
          rust: false,
        },
        maxWorkspaces: 4,
        allocatedWorkspaces: 0,
        systemResources: {
          logicalCpuCount: 8,
          memoryBytes: 17_179_869_184,
        },
        egress: { enforced: true, revision: null },
        storage: { enforced: true, fsType: "xfs", totalBytes: 1_000, freeBytes: 500 },
        modelRelay: { enabled: false, port: null, listening: false },
      },
    });

    expect(parsed.type).toBe("worker.hello");
  });

  it("rejects v2 Workers that cannot report disk quotas", () => {
    const result = WorkerToControlMessageSchema.safeParse({
      version: 2,
      type: "worker.heartbeat",
      requestId,
      payload: {
        workerId: "worker-01",
        allocatedWorkspaces: 0,
        egress: { enforced: true, revision: 0 },
        observedAt: "2026-10-06T08:00:00.000Z",
      },
    });
    expect(result.success).toBe(false);
  });

  it("validates storage status, disk usage samples and disk limits", () => {
    const heartbeat = (payload: Record<string, unknown>) =>
      WorkerToControlMessageSchema.safeParse({
        version: 5,
        type: "worker.heartbeat",
        requestId,
        payload: {
          host: { cpuUtilization: null, memoryTotalBytes: 8, memoryAvailableBytes: 4, load1: 0 },
          workerId: "worker-01",
          allocatedWorkspaces: 0,
          egress: { enforced: true, revision: 0 },
          storage: { enforced: true, fsType: "xfs", totalBytes: 10, freeBytes: 5 },
          modelRelay: { enabled: false, port: null, listening: false },
          observedAt: "2026-10-06T08:00:00.000Z",
          ...payload,
        },
      }).success;
    const sample = {
      workspaceId,
      dataUsedBytes: 1,
      dataLimitBytes: 2,
      dataUsedInodes: 3,
      piUsedBytes: 4,
      piLimitBytes: 5,
    };
    expect(heartbeat({ workspaceDisk: [sample] })).toBe(true);
    expect(heartbeat({ storage: undefined })).toBe(false);
    expect(heartbeat({ storage: { enforced: true, fsType: "../xfs", totalBytes: 1, freeBytes: 1 } })).toBe(false);
    expect(heartbeat({ workspaceDisk: [{ ...sample, dataUsedBytes: -1 }] })).toBe(false);
    expect(heartbeat({ workspaceDisk: [{ ...sample, hostPath: "/var/lib" }] })).toBe(false);

    const storageSet = (diskLimitBytes: unknown) =>
      ControlToWorkerMessageSchema.safeParse({
        version: 5,
        type: "workspace.storage.set",
        requestId,
        payload: { workspaceId, diskLimitBytes },
      }).success;
    expect(storageSet(20 * 1024 ** 3)).toBe(true);
    for (const invalid of [1024 ** 3 - 1, 2 ** 51, 1.5, "20G"]) {
      expect(storageSet(invalid)).toBe(false);
    }
    const ensure = (storage: unknown) =>
      ControlToWorkerMessageSchema.safeParse({
        version: 5,
        type: "workspace.ensure",
        requestId,
        payload: {
          workspaceId,
          runtimeImage: "agent-runtime:test",
          resources: { cpuCount: 2, memoryBytes: 1024, pidsLimit: 64 },
          storage,
          modelGateway: null,
        },
      }).success;
    expect(ensure({ diskLimitBytes: 20 * 1024 ** 3 })).toBe(true);
    expect(ensure(undefined)).toBe(false);
    expect(ensure({ diskLimitBytes: 20 * 1024 ** 3, path: "/tmp" })).toBe(false);
  });

  it("rejects unsupported protocol versions, including v1 Workers without egress control", () => {
    const result = ControlToWorkerMessageSchema.safeParse({
      version: 1,
      type: "workspace.start",
      requestId,
      payload: { workspaceId },
    });

    expect(result.success).toBe(false);
  });

  it("rejects a Worker claiming more allocations than its capacity", () => {
    const result = WorkerToControlMessageSchema.safeParse({
      version: 5,
      type: "worker.hello",
      requestId,
      payload: {
        workerId: "worker-01",
        hostname: "worker-01.internal",
        architecture: "arm64",
        runtimeImage: "unavailable",
        runtimeVersion: "phase-2",
        capabilities: {
          browser: false,
          office: false,
          ffmpeg: false,
          python: false,
          node: false,
          rust: false,
        },
        maxWorkspaces: 1,
        allocatedWorkspaces: 2,
        systemResources: { logicalCpuCount: 8, memoryBytes: 16_000_000_000 },
        egress: { enforced: true, revision: 1 },
      },
    });

    expect(result.success).toBe(false);
  });

  it("does not accept host paths or container ids in infrastructure commands", () => {
    const result = ControlToWorkerMessageSchema.safeParse({
      version: 5,
      type: "workspace.delete",
      requestId,
      payload: {
        workspaceId,
        hostPath: "/",
        containerId: "unrelated-container",
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts a correlated response without exposing infrastructure details", () => {
    const parsed = WorkerToControlMessageSchema.parse({
      version: 5,
      type: "response.ok",
      requestId,
      payload: {
        requestType: "workspace.inspect",
        workspace: {
          workspaceId,
          state: "RUNNING",
          runtimeImage: "registry.internal/agent-runtime:phase-3.1",
          observedAt: "2026-09-10T08:00:00.000Z",
        },
      },
    });

    expect(parsed.type).toBe("response.ok");
  });

  it("accepts a bounded authoritative recovery command and typed inventory", () => {
    expect(
      ControlToWorkerMessageSchema.parse({
        version: 5,
        type: "worker.reconcile",
        requestId,
        payload: {
          assignments: [
            {
              workspaceId,
              runtimeImage: "agent-runtime:phase3-minimal",
              desiredState: "RUNNING",
              diskLimitBytes: 20 * 1024 ** 3,
            },
          ],
        },
      }),
    ).toMatchObject({ type: "worker.reconcile" });

    expect(
      WorkerToControlMessageSchema.parse({
        version: 5,
        type: "response.ok",
        requestId,
        payload: {
          requestType: "worker.reconcile",
          reconciliation: {
            workspaces: [
              {
                status: "OBSERVED",
                workspace: {
                  workspaceId,
                  state: "RUNNING",
                  runtimeImage: "agent-runtime:phase3-minimal",
                  observedAt: "2026-09-10T08:00:00.000Z",
                },
              },
            ],
            issues: [],
            modelKeys: [],
            observedAt: "2026-09-10T08:00:00.000Z",
          },
        },
      }),
    ).toMatchObject({ type: "response.ok" });
  });

  it("rejects duplicate authoritative assignments", () => {
    const assignment = {
      workspaceId,
      runtimeImage: "agent-runtime:phase3-minimal",
      desiredState: "STOPPED",
    };
    expect(
      ControlToWorkerMessageSchema.safeParse({
        version: 5,
        type: "worker.reconcile",
        requestId,
        payload: { assignments: [assignment, assignment] },
      }).success,
    ).toBe(false);
  });

  it("rejects stack traces and arbitrary fields in protocol errors", () => {
    const result = WorkerToControlMessageSchema.safeParse({
      version: 5,
      type: "response.error",
      requestId,
      payload: {
        requestType: "workspace.start",
        code: "WORKSPACE_NOT_FOUND",
        message: "Workspace is not managed by this worker",
        retryable: false,
        stack: "sensitive worker path",
      },
    });

    expect(result.success).toBe(false);
  });
});
