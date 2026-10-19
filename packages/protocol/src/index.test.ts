import { describe, expect, it } from "vitest";

import {
  ControlToWorkerMessageSchema,
  WorkerToControlMessageSchema,
} from "./index.js";

const requestId = "0d17d4a0-c25a-43fd-a2eb-3d9ca7c5976c";
const workspaceId = "90b38efc-aa9a-4bc6-8eee-528b4e0c7c60";
const IMAGE_ID = `sha256:${"e".repeat(64)}`;

describe("worker protocol", () => {
  it("accepts a versioned worker hello", () => {
    const parsed = WorkerToControlMessageSchema.parse({
      version: 7,
      type: "worker.hello",
      requestId,
      payload: {
        workerId: "worker-arm64-01",
        workerVersion: "1.0.0-test",
        hostname: "worker-arm64-01.internal",
        architecture: "arm64",
        runtimeImages: [
          {
            image: "registry.internal/agent-runtime:phase-3.1",
            imageId: IMAGE_ID,
            runtimeVersion: "phase-3.1",
            piWebVersion: "0.12.0",
            piVersion: "1.1.0",
            capabilities: {
              browser: false,
              office: false,
              ffmpeg: false,
              python: true,
              node: true,
              rust: false,
            },
          },
        ],
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
        version: 7,
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
        version: 7,
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
        version: 7,
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
      version: 7,
      type: "worker.hello",
      requestId,
      payload: {
        workerId: "worker-01",
        workerVersion: "1.0.0-test",
        hostname: "worker-01.internal",
        architecture: "arm64",
        runtimeImages: [
          {
            image: "agent-runtime:unavailable",
            imageId: IMAGE_ID,
            runtimeVersion: "phase-2",
            piWebVersion: "0.12.0",
            piVersion: "1.1.0",
            capabilities: {
              browser: false,
              office: false,
              ffmpeg: false,
              python: false,
              node: false,
              rust: false,
            },
          },
        ],
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
      version: 7,
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
      version: 7,
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
        version: 7,
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
        version: 7,
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
        version: 7,
        type: "worker.reconcile",
        requestId,
        payload: { assignments: [assignment, assignment] },
      }).success,
    ).toBe(false);
  });

  it("rejects stack traces and arbitrary fields in protocol errors", () => {
    const result = WorkerToControlMessageSchema.safeParse({
      version: 7,
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

  describe("Runtime images (Phase 18.9)", () => {
    const capabilities = { browser: true, office: true, ffmpeg: true, python: true, node: true, rust: true };
    const report = (image: string, runtimeVersion: string) => ({
      image,
      imageId: IMAGE_ID,
      runtimeVersion,
      piWebVersion: null,
      piVersion: null,
      capabilities,
    });
    const hello = (runtimeImages: unknown) => ({
      version: 7,
      type: "worker.hello",
      requestId,
      payload: {
        workerId: "worker-01",
        workerVersion: "1.0.0-test",
        hostname: "worker-01.internal",
        architecture: "arm64",
        runtimeImages,
        maxWorkspaces: 4,
        allocatedWorkspaces: 0,
        systemResources: { logicalCpuCount: 8, memoryBytes: 16_000_000_000 },
        egress: { enforced: true, revision: 1 },
        storage: { enforced: true, fsType: "xfs", totalBytes: 1_000, freeBytes: 500 },
        modelRelay: { enabled: false, port: null, listening: false },
      },
    });

    it("accepts 1 to 4 unique images and rejects duplicates or bad IDs", () => {
      expect(WorkerToControlMessageSchema.safeParse(hello([report("a:1", "v1"), report("a:2", "v2")])).success).toBe(true);
      for (const invalid of [
        [],
        [1, 2, 3, 4, 5].map((n) => report(`a:${n}`, `v${n}`)),
        [report("a:1", "v1"), report("a:1", "v2")],
        [report("a:1", "v1"), report("a:2", "v1")],
        [{ ...report("a:1", "v1"), imageId: "sha256:abc" }],
        [{ ...report("a:1", "v1"), extra: true }],
      ]) {
        expect(WorkerToControlMessageSchema.safeParse(hello(invalid)).success).toBe(false);
      }
    });

    it("rejects a v5 hello", () => {
      const v5 = hello([report("a:1", "v1")]);
      expect(WorkerToControlMessageSchema.safeParse({ ...v5, version: 5 }).success).toBe(false);
    });

    it("requires the Worker's software version in a v7 hello and rejects v6 (Phase 19.8)", () => {
      const v7 = hello([report("a:1", "v1")]);
      expect(WorkerToControlMessageSchema.safeParse({ ...v7, version: 6 }).success).toBe(false);
      for (const workerVersion of ["1.0.0", "1.0.0-rc.1", "0.0.0-1a2b3c4", "dev"]) {
        expect(
          WorkerToControlMessageSchema.safeParse({ ...v7, payload: { ...v7.payload, workerVersion } }).success,
          workerVersion,
        ).toBe(true);
      }
      const withoutVersion: Record<string, unknown> = { ...v7.payload };
      delete withoutVersion.workerVersion;
      expect(WorkerToControlMessageSchema.safeParse({ ...v7, payload: withoutVersion }).success).toBe(false);
      for (const workerVersion of ["", "-1", "1.0 beta", "x".repeat(65), "1.0.0\nforged"]) {
        expect(
          WorkerToControlMessageSchema.safeParse({ ...v7, payload: { ...v7.payload, workerVersion } }).success,
          workerVersion,
        ).toBe(false);
      }
    });

    it("carries workspace.runtime.set between two different image references only", () => {
      const command = (payload: Record<string, unknown>) =>
        ControlToWorkerMessageSchema.safeParse({ version: 7, type: "workspace.runtime.set", requestId, payload });
      expect(command({ workspaceId, fromImage: "a:1", toImage: "a:2" }).success).toBe(true);
      expect(command({ workspaceId, fromImage: "a:1", toImage: "a:1" }).success).toBe(false);
      expect(command({ workspaceId, fromImage: "a:1", toImage: "../../etc" }).success).toBe(false);
      expect(command({ workspaceId, fromImage: "a:1", toImage: "a:2", containerId: "abc" }).success).toBe(false);
    });

    it("never lets a Worker report the Control Plane's UPGRADING state", () => {
      const observed = (state: string) =>
        WorkerToControlMessageSchema.safeParse({
          version: 7,
          type: "response.ok",
          requestId,
          payload: {
            requestType: "workspace.runtime.set",
            workspace: { workspaceId, state, runtimeImage: "a:2", observedAt: "2026-10-12T08:00:00.000Z" },
          },
        }).success;
      expect(observed("STOPPED")).toBe(true);
      expect(observed("UPGRADING")).toBe(false);
    });
  });
});
