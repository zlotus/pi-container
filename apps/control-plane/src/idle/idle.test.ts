import type { IdleStopCandidate } from "@agent-runtime/database";
import { describe, expect, it, vi } from "vitest";

import { ACCESS_PERSIST_INTERVAL_MS, WorkspaceAccessTracker } from "./access-tracker.js";
import { ComputeActivityTracker } from "./compute-activity.js";
import { IdleStopper, type IdleStopperDependencies } from "./idle-stopper.js";
import { idleView } from "./idle-status.js";

const WS = "90b38efc-aa9a-4bc6-8eee-528b4e0c7c60";
const T0 = Date.parse("2026-10-12T00:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const GIGA = 1_000_000_000;

describe("WorkspaceAccessTracker (Phase 18.5)", () => {
  it("persists at most once a minute while used, and right away when a connection ends", async () => {
    let now = T0;
    const tracker = new WorkspaceAccessTracker(() => new Date(now));
    const writes: Array<Array<{ workspaceId: string; at: Date }>> = [];
    const write = async (entries: Array<{ workspaceId: string; at: Date }>) => {
      writes.push(entries);
    };

    tracker.touch(WS);
    await tracker.flush(write);
    now += 10_000;
    tracker.touch(WS);
    await tracker.flush(write);
    expect(writes).toHaveLength(1);
    expect(tracker.latest(WS)).toEqual(new Date(T0 + 10_000));

    now += 5_000;
    tracker.touch(WS, true);
    await tracker.flush(write);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual([{ workspaceId: WS, at: new Date(T0 + 15_000) }]);

    now += ACCESS_PERSIST_INTERVAL_MS + 15_000;
    tracker.touch(WS);
    await tracker.flush(write);
    expect(writes).toHaveLength(3);
  });

  it("keeps an access pending when the write fails", async () => {
    const tracker = new WorkspaceAccessTracker(() => new Date(T0));
    tracker.touch(WS);
    await expect(tracker.flush(async () => Promise.reject(new Error("db down")))).rejects.toThrow();
    const write = vi.fn(async () => undefined);
    await tracker.flush(write);
    expect(write).toHaveBeenCalledOnce();
  });
});

describe("ComputeActivityTracker (Phase 18.5)", () => {
  const sample = (at: number, nanos: number) => ({
    workspaceId: WS,
    sampledAt: new Date(at).toISOString(),
    cpuUsageNanos: nanos,
  });

  /** Feeds 10-second samples at `cores` from `from` for `minutes`, continuing `nanos`. */
  function feed(tracker: ComputeActivityTracker, from: number, minutes: number, cores: number, nanos = 0) {
    let current = nanos;
    for (let at = from; at <= from + minutes * MINUTE; at += 10_000) {
      tracker.record("worker-a", [sample(at, Math.round(current))]);
      current += cores * 10 * GIGA;
    }
    return current;
  }

  it("treats an unknown history as active and idle CPU as idle", () => {
    const tracker = new ComputeActivityTracker(0.05);
    expect(tracker.lastActiveAt(WS, new Date(T0))).toEqual(new Date(T0));
    feed(tracker, T0, 60, 0.0003);
    const now = new Date(T0 + 60 * MINUTE);
    expect(tracker.lastActiveAt(WS, now)).toEqual(new Date(T0));
  });

  it("marks sustained low work as activity but ignores a short spike", () => {
    const busy = new ComputeActivityTracker(0.05);
    const nanos = feed(busy, T0, 30, 0.0003);
    feed(busy, T0 + 30 * MINUTE + 10_000, 30, 0.08, nanos);
    expect(busy.lastActiveAt(WS, new Date(T0 + 60 * MINUTE)).getTime()).toBeGreaterThan(T0 + 55 * MINUTE);

    const spiky = new ComputeActivityTracker(0.05);
    let current = feed(spiky, T0, 10, 0.0003);
    // One 10-second burst of a full core in an otherwise idle hour.
    current += 1 * 10 * GIGA;
    feed(spiky, T0 + 10 * MINUTE + 10_000, 50, 0.0003, current);
    expect(spiky.lastActiveAt(WS, new Date(T0 + 60 * MINUTE))).toEqual(new Date(T0));
  });

  it("counts work in the bucket being filled", () => {
    const tracker = new ComputeActivityTracker(0.05);
    const nanos = feed(tracker, T0, 30, 0);
    feed(tracker, T0 + 30 * MINUTE + 10_000, 2, 1, nanos);
    expect(tracker.lastActiveAt(WS, new Date(T0 + 32 * MINUTE + 10_000)).getTime()).toBeGreaterThan(T0 + 30 * MINUTE);
  });

  it("treats gaps, counter resets and Worker disconnects as activity", () => {
    const gap = new ComputeActivityTracker(0.05);
    const nanos = feed(gap, T0, 20, 0);
    gap.record("worker-a", [sample(T0 + 25 * MINUTE, nanos)]);
    expect(gap.lastActiveAt(WS, new Date(T0 + 25 * MINUTE))).toEqual(new Date(T0 + 25 * MINUTE));
    expect(gap.lastActiveAt(WS, new Date(T0 + 30 * MINUTE))).toEqual(new Date(T0 + 30 * MINUTE));

    const reset = new ComputeActivityTracker(0.05);
    feed(reset, T0, 20, 0, 5 * GIGA);
    reset.record("worker-a", [sample(T0 + 20 * MINUTE + 10_000, 0)]);
    expect(reset.lastActiveAt(WS, new Date(T0 + 20 * MINUTE + 10_000))).toEqual(new Date(T0 + 20 * MINUTE + 10_000));

    const gone = new ComputeActivityTracker(0.05);
    feed(gone, T0, 20, 0);
    gone.forgetWorker("worker-a");
    expect(gone.lastActiveAt(WS, new Date(T0 + 20 * MINUTE))).toEqual(new Date(T0 + 20 * MINUTE));
  });
});

describe("IdleStopper (Phase 18.5)", () => {
  const candidate: IdleStopCandidate = {
    workspaceId: WS,
    userId: "u",
    workerId: "worker-a",
    runtimeImage: "img",
    lastAccessAt: null,
  };

  /** An idle Workspace 26 hours into a 24-hour policy, with every condition met. */
  function setup(overrides: Partial<IdleStopperDependencies> = {}) {
    const now = new Date(T0 + 26 * HOUR);
    const compute = new ComputeActivityTracker(0.05);
    for (let at = T0 + HOUR; at <= now.getTime(); at += 10_000) {
      compute.record("worker-a", [{ workspaceId: WS, sampledAt: new Date(at).toISOString(), cpuUsageNanos: 0 }]);
    }
    const store = {
      listIdleStopCandidates: vi.fn(async () => [candidate]),
      beginIdleStop: vi.fn(async () => true),
    };
    const stop = vi.fn(async () => true);
    const recordStop = vi.fn();
    const dependencies: IdleStopperDependencies = {
      policy: { stopAfterHours: 24, cpuThresholdCores: 0.05 },
      store,
      stop,
      workerConnected: () => true,
      activeConnections: () => 0,
      access: new WorkspaceAccessTracker(() => new Date(T0)),
      compute,
      startedAt: new Date(T0),
      now: () => now,
      recordStop,
      ...overrides,
    };
    return { stopper: new IdleStopper(dependencies), store, stop, recordStop, now };
  }

  it("stops a Workspace idle on every count, with the cutoff re-checked in SQL", async () => {
    const { stopper, store, stop, recordStop, now } = setup();
    await expect(stopper.sweep()).resolves.toEqual({ stopped: 1, skipped: 0 });
    expect(store.beginIdleStop).toHaveBeenCalledWith({
      workspaceId: WS,
      workerId: "worker-a",
      cutoff: new Date(now.getTime() - 24 * HOUR),
      idleAfterHours: 24,
      cpuThresholdCores: 0.05,
    });
    expect(stop).toHaveBeenCalledWith(candidate);
    expect(recordStop).toHaveBeenCalledWith("stopped");
  });

  it("does not stop while connected, recently accessed, computing or the Worker is gone", async () => {
    const accessed = new WorkspaceAccessTracker(() => new Date(T0 + 25 * HOUR));
    accessed.touch(WS);
    for (const overrides of [
      { activeConnections: () => 1 },
      { access: accessed },
      { compute: new ComputeActivityTracker(0.05) },
      { workerConnected: () => false },
    ] satisfies Array<Partial<IdleStopperDependencies>>) {
      const { stopper, store, stop } = setup(overrides);
      await expect(stopper.sweep()).resolves.toEqual({ stopped: 0, skipped: 0 });
      expect(store.beginIdleStop).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
    }
  });

  it("waits a full window after the Control Plane starts", async () => {
    const { stopper, store } = setup({ startedAt: new Date(T0 + 3 * HOUR) });
    await expect(stopper.sweep()).resolves.toEqual({ stopped: 0, skipped: 0 });
    expect(store.listIdleStopCandidates).not.toHaveBeenCalled();
  });

  it("lets a racing access win and reports failed stops", async () => {
    const raced = setup({
      store: { listIdleStopCandidates: async () => [candidate], beginIdleStop: async () => false },
    });
    await expect(raced.stopper.sweep()).resolves.toEqual({ stopped: 0, skipped: 1 });
    expect(raced.stop).not.toHaveBeenCalled();
    expect(raced.recordStop).toHaveBeenCalledWith("skipped_race");

    const failing = setup({ stop: async () => false });
    await expect(failing.stopper.sweep()).resolves.toEqual({ stopped: 0, skipped: 0 });
    expect(failing.recordStop).toHaveBeenCalledWith("failed");
  });

  it("stops at most ten Workspaces per sweep", async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      ...candidate,
      workspaceId: `${WS.slice(0, -2)}${String(index).padStart(2, "0")}`,
    }));
    const compute = { lastActiveAt: () => new Date(T0) } as unknown as ComputeActivityTracker;
    const { stopper, stop } = setup({
      compute,
      store: { listIdleStopCandidates: async () => many, beginIdleStop: async () => true },
    });
    await expect(stopper.sweep()).resolves.toEqual({ stopped: 10, skipped: 0 });
    expect(stop).toHaveBeenCalledTimes(10);
  });
});

describe("idleView (Phase 18.5)", () => {
  const policy = { stopAfterHours: 1, cpuThresholdCores: 0.05 };
  const base = (overrides: { state?: string; lastAccessAt?: Date | null } = {}) => ({
    id: WS,
    state: overrides.state ?? "RUNNING",
    lastActivityAt: new Date(T0),
    lastAccessAt: overrides.lastAccessAt ?? null,
  });

  function computeIdleSince(from: number, to: number): ComputeActivityTracker {
    const compute = new ComputeActivityTracker(0.05);
    for (let at = from; at <= to; at += 10_000) {
      compute.record("worker-a", [{ workspaceId: WS, sampledAt: new Date(at).toISOString(), cpuUsageNanos: 0 }]);
    }
    return compute;
  }

  it("is the latest of run start, Control Plane start, access and CPU activity", () => {
    const now = new Date(T0 + 50 * MINUTE);
    const access = new WorkspaceAccessTracker(() => new Date(T0 + 20 * MINUTE));
    access.touch(WS);
    const view = idleView({
      workspace: base({ lastAccessAt: new Date(T0 + 10 * MINUTE) }),
      policy,
      access,
      compute: computeIdleSince(T0 + 5 * MINUTE, now.getTime()),
      startedAt: new Date(T0 - HOUR),
      activeConnections: 0,
      now,
    });
    expect(view).toEqual({
      connected: false,
      idleSince: new Date(T0 + 20 * MINUTE).toISOString(),
      stopAt: new Date(T0 + 80 * MINUTE).toISOString(),
    });
  });

  it("restarts at now while connected and is absent unless running", () => {
    const now = new Date(T0 + 50 * MINUTE);
    const common = {
      policy,
      access: new WorkspaceAccessTracker(() => now),
      compute: computeIdleSince(T0, now.getTime()),
      startedAt: new Date(T0 - HOUR),
      now,
    };
    expect(idleView({ ...common, workspace: base(), activeConnections: 2 })).toMatchObject({
      connected: true,
      idleSince: now.toISOString(),
    });
    expect(idleView({ ...common, workspace: base({ state: "STOPPED" }), activeConnections: 0 })).toBeNull();
  });
});
