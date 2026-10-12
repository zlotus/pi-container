import { describe, expect, it } from "vitest";

import { WorkerToControlMessageSchema } from "./index.js";

const requestId = "7f3c9b0e-5d1a-4c2b-9e8f-0a1b2c3d4e5f";
const workspaceId = "5b0f3a9e-2c4d-4e6f-8a1b-3c5d7e9f1a2b";

const host = { cpuUtilization: 0.25, memoryTotalBytes: 16, memoryAvailableBytes: 8, load1: 0.5 };
const usage = {
  workspaceId,
  sampledAt: "2026-10-10T08:00:00.000Z",
  cpuUsageNanos: 1_000_000_000,
  cpuCores: 0.5,
  cpuLimitCores: 2,
  memoryBytes: 1024,
  memoryLimitBytes: 4096,
  pids: 21,
  pidsLimit: 512,
  networkRxBytes: 10,
  networkTxBytes: 20,
  oomKills: 0,
};
const relayStats = {
  requests: {
    "2xx": 1, "4xx": 0, "5xx": 0, no_key: 0, gateway_unavailable: 0, rejected_path: 0,
    body_too_large: 0, concurrency_limited: 0,
  },
  rejectedConnections: 0,
  activeRequests: 0,
};

function heartbeat(payload: Record<string, unknown>, version = 6): boolean {
  return WorkerToControlMessageSchema.safeParse({
    version,
    type: "worker.heartbeat",
    requestId,
    payload: {
      workerId: "worker-01",
      allocatedWorkspaces: 1,
      egress: { enforced: true, revision: 0 },
      storage: { enforced: true, fsType: "xfs", totalBytes: 10, freeBytes: 5 },
      modelRelay: { enabled: true, port: 3101, listening: true, stats: relayStats },
      host,
      observedAt: "2026-10-10T08:00:00.000Z",
      ...payload,
    },
  }).success;
}

describe("usage protocol (Phase 17.6)", () => {
  it("accepts host usage, Workspace usage and relay counters", () => {
    expect(heartbeat({})).toBe(true);
    expect(heartbeat({ workspaceUsage: [usage] })).toBe(true);
    expect(heartbeat({ workspaceUsage: [{ ...usage, cpuCores: null }] })).toBe(true);
    expect(heartbeat({ host: { ...host, cpuUtilization: null } })).toBe(true);
    expect(
      heartbeat({ modelRelay: { enabled: false, port: null, listening: false } }),
    ).toBe(true);
  });

  it("requires host usage and rejects v4 heartbeats", () => {
    expect(heartbeat({ host: undefined })).toBe(false);
    expect(heartbeat({}, 4)).toBe(false);
  });

  it("rejects out-of-range, non-finite or unknown usage fields", () => {
    expect(heartbeat({ host: { ...host, cpuUtilization: 1.5 } })).toBe(false);
    expect(heartbeat({ host: { ...host, memoryAvailableBytes: 32 } })).toBe(false);
    expect(heartbeat({ workspaceUsage: [{ ...usage, memoryBytes: -1 }] })).toBe(false);
    expect(heartbeat({ workspaceUsage: [{ ...usage, cpuCores: Number.POSITIVE_INFINITY }] })).toBe(false);
    expect(heartbeat({ workspaceUsage: [{ ...usage, cpuCores: 2_000 }] })).toBe(false);
    expect(heartbeat({ workspaceUsage: [{ ...usage, cpuUsageNanos: 1.5 }] })).toBe(false);
    expect(heartbeat({ workspaceUsage: [{ ...usage, workspaceId: "../x" }] })).toBe(false);
    expect(heartbeat({ workspaceUsage: [{ ...usage, containerId: "abc" }] })).toBe(false);
    expect(heartbeat({ workspaceUsage: Array.from({ length: 10_001 }, () => usage) })).toBe(false);
  });

  it("requires every relay result counter and nothing else", () => {
    const missing: Record<string, number> = { ...relayStats.requests };
    delete missing.no_key;
    const relay = (stats: unknown) =>
      heartbeat({ modelRelay: { enabled: true, port: 3101, listening: true, stats } });
    expect(relay({ ...relayStats, requests: missing })).toBe(false);
    expect(relay({ ...relayStats, requests: { ...relayStats.requests, "/v1/x": 1 } })).toBe(false);
    expect(relay({ ...relayStats, activeRequests: -1 })).toBe(false);
  });
});
