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
      version: 1,
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
      },
    });

    expect(parsed.type).toBe("worker.hello");
  });

  it("rejects unsupported protocol versions", () => {
    const result = ControlToWorkerMessageSchema.safeParse({
      version: 2,
      type: "workspace.start",
      requestId,
      payload: { workspaceId },
    });

    expect(result.success).toBe(false);
  });

  it("rejects a Worker claiming more allocations than its capacity", () => {
    const result = WorkerToControlMessageSchema.safeParse({
      version: 1,
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
      },
    });

    expect(result.success).toBe(false);
  });

  it("does not accept host paths or container ids in infrastructure commands", () => {
    const result = ControlToWorkerMessageSchema.safeParse({
      version: 1,
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
      version: 1,
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

  it("rejects stack traces and arbitrary fields in protocol errors", () => {
    const result = WorkerToControlMessageSchema.safeParse({
      version: 1,
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
