import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { OomEventCounter, type OomEventSource } from "./oom.js";

const A = "5b0f3a9e-2c4d-4e6f-8a1b-3c5d7e9f1a2b";
const LABELS = { app: "agent-runtime-platform", managed_by: "worker", worker_id: "worker-01" };

function event(attributes: Record<string, string>, action = "oom", type = "container") {
  return `${JSON.stringify({ Type: type, Action: action, Actor: { ID: "c", Attributes: attributes } })}\n`;
}

function source(streams: Array<PassThrough | Error>): OomEventSource & { opened: number } {
  const result = {
    opened: 0,
    async oomEvents() {
      const next = streams[result.opened++];
      if (next === undefined) return new PassThrough();
      if (next instanceof Error) throw next;
      return next;
    },
    managedWorkspaceId(labels: Record<string, string>) {
      return labels.worker_id === "worker-01" && labels.app === LABELS.app ? (labels.workspace_id ?? null) : null;
    },
  };
  return result;
}

const silent = { warn: () => undefined, debug: () => undefined };

describe("OOM event counter (Phase 17.5)", () => {
  it("counts OOM events of managed Workspace containers only", async () => {
    const stream = new PassThrough();
    const counter = new OomEventCounter({ source: source([stream]), log: silent });
    counter.start();
    await vi.waitFor(() => expect(stream.listenerCount("data")).toBe(1));
    stream.write(event({ ...LABELS, workspace_id: A }));
    // Split across chunks, like a real HTTP event stream may deliver it.
    const split = event({ ...LABELS, workspace_id: A });
    stream.write(split.slice(0, 10));
    stream.write(split.slice(10));
    stream.write(event({ ...LABELS, worker_id: "worker-02", workspace_id: A }));
    stream.write(event({ ...LABELS, workspace_id: A }, "die"));
    stream.write(event({ ...LABELS, workspace_id: A }, "oom", "network"));
    stream.write("not json\n");
    await vi.waitFor(() => expect(counter.count(A)).toBe(2));
    expect(counter.count("6c1f3a9e-2c4d-4e6f-8a1b-3c5d7e9f1a2b")).toBe(0);
    counter.stop();
  });

  it("reconnects with backoff after the stream ends or cannot be opened", async () => {
    vi.useFakeTimers();
    try {
      const first = new PassThrough();
      const second = new PassThrough();
      const events = source([first, new Error("docker down"), second]);
      const counter = new OomEventCounter({ source: events, log: silent, initialBackoffMs: 100 });
      counter.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(events.opened).toBe(1);
      first.end();
      await vi.advanceTimersByTimeAsync(99);
      expect(events.opened).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(events.opened).toBe(2);
      await vi.advanceTimersByTimeAsync(200);
      expect(events.opened).toBe(3);
      second.write(event({ ...LABELS, workspace_id: A }));
      await vi.advanceTimersByTimeAsync(0);
      expect(counter.count(A)).toBe(1);
      counter.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(events.opened).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
