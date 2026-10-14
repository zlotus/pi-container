import type {
  WorkerRuntimeImage,
  WorkerScheduleCandidate,
  WorkerSelectionInput,
} from "@agent-runtime/database";
import { describe, expect, it } from "vitest";

import { selectWorker } from "./scheduler.js";

const NOW = new Date("2026-09-13T08:00:00.000Z");

function image(
  name: string,
  capabilities: Partial<WorkerRuntimeImage["capabilities"]> = {},
): WorkerRuntimeImage {
  return {
    image: name,
    imageId: null,
    runtimeVersion: name,
    piWebVersion: null,
    piVersion: null,
    capabilities: {
      browser: false,
      office: false,
      ffmpeg: false,
      python: true,
      node: true,
      rust: false,
      ...capabilities,
    },
  };
}

function candidate(
  overrides: Partial<WorkerScheduleCandidate> = {},
): WorkerScheduleCandidate {
  return {
    id: "worker-a",
    architecture: "arm64",
    status: "ONLINE",
    enabled: true,
    schedulable: true,
    runtimeImages: [image("agent-runtime:phase3-minimal")],
    maxWorkspaces: 4,
    assignedWorkspaces: 0,
    lastHeartbeatAt: NOW,
    egressEnforced: true,
    egressRevision: 3,
    storageEnforced: true,
    ...overrides,
  };
}

function selectionInput(
  candidates: WorkerScheduleCandidate[],
  overrides: Partial<WorkerSelectionInput> = {},
): WorkerSelectionInput {
  return {
    workspace: {
      runtimeImage: "agent-runtime:phase3-minimal",
      requiredArchitecture: null,
      requiredCapabilities: {},
    },
    candidates,
    connectedWorkerIds: candidates.map((worker) => worker.id),
    heartbeatCutoff: new Date(NOW.getTime() - 35_000),
    egressRevision: 3,
    ...overrides,
  };
}

describe("Phase 5 Worker selection", () => {
  it("filters disconnected, disabled, stale, offline, and full Workers", () => {
    const candidates = [
      candidate({ id: "disconnected" }),
      candidate({ id: "disabled", enabled: false }),
      // Sorts ahead of "eligible", so only the schedulable filter can exclude it.
      candidate({ id: "a-paused", schedulable: false }),
      candidate({ id: "stale", lastHeartbeatAt: new Date(NOW.getTime() - 35_000) }),
      candidate({ id: "offline", status: "OFFLINE" }),
      candidate({ id: "full", assignedWorkspaces: 4 }),
      candidate({ id: "eligible" }),
    ];
    const input = selectionInput(candidates, {
      connectedWorkerIds: candidates
        .map((worker) => worker.id)
        .filter((workerId) => workerId !== "disconnected"),
    });

    expect(selectWorker(input)?.id).toBe("eligible");
  });

  it("skips an admin-paused Worker even when it has the lowest load", () => {
    const candidates = [
      candidate({ id: "worker-a", schedulable: false, assignedWorkspaces: 0 }),
      candidate({ id: "worker-b", assignedWorkspaces: 3 }),
    ];

    expect(selectWorker(selectionInput(candidates))?.id).toBe("worker-b");
    expect(
      selectWorker(selectionInput([candidate({ schedulable: false })])),
    ).toBeNull();
  });

  it("requires exact Runtime image and requested architecture", () => {
    const candidates = [
      candidate({ id: "wrong-runtime", runtimeImages: [image("agent-runtime:other")] }),
      candidate({ id: "wrong-architecture", architecture: "amd64" }),
      candidate({ id: "compatible" }),
    ];

    expect(
      selectWorker(
        selectionInput(candidates, {
          workspace: {
            runtimeImage: "agent-runtime:phase3-minimal",
            requiredArchitecture: "arm64",
            requiredCapabilities: {},
          },
        }),
      )?.id,
    ).toBe("compatible");
  });

  it("takes capabilities from the Workspace's own image on a multi-image Worker (Phase 18.4)", () => {
    const candidates = [
      candidate({
        id: "browser-only-on-other-image",
        runtimeImages: [
          image("agent-runtime:phase3-minimal"),
          image("agent-runtime:phase18", { browser: true }),
        ],
      }),
      candidate({
        id: "browser-on-this-image",
        runtimeImages: [
          image("agent-runtime:phase18"),
          image("agent-runtime:phase3-minimal", { browser: true }),
        ],
      }),
    ];

    expect(
      selectWorker(
        selectionInput(candidates, {
          workspace: {
            runtimeImage: "agent-runtime:phase3-minimal",
            requiredArchitecture: null,
            requiredCapabilities: { browser: true },
          },
        }),
      )?.id,
    ).toBe("browser-on-this-image");
  });

  it("requires every declared capability value", () => {
    const candidates = [
      candidate({ id: "without-browser" }),
      candidate({
        id: "with-browser",
        runtimeImages: [image("agent-runtime:phase3-minimal", { browser: true })],
      }),
    ];

    expect(
      selectWorker(
        selectionInput(candidates, {
          workspace: {
            runtimeImage: "agent-runtime:phase3-minimal",
            requiredArchitecture: null,
            requiredCapabilities: { browser: true, python: true },
          },
        }),
      )?.id,
    ).toBe("with-browser");
  });

  it("chooses the lowest authoritative assignment ratio", () => {
    const selected = selectWorker(
      selectionInput([
        candidate({ id: "worker-a", assignedWorkspaces: 2, maxWorkspaces: 4 }),
        candidate({ id: "worker-b", assignedWorkspaces: 3, maxWorkspaces: 8 }),
        candidate({ id: "worker-c", assignedWorkspaces: 1, maxWorkspaces: 2 }),
      ]),
    );

    expect(selected?.id).toBe("worker-b");
  });

  it("breaks equal-score ties by Worker ID", () => {
    const selected = selectWorker(
      selectionInput([
        candidate({ id: "worker-z", assignedWorkspaces: 1, maxWorkspaces: 4 }),
        candidate({ id: "worker-a", assignedWorkspaces: 2, maxWorkspaces: 8 }),
      ]),
    );

    expect(selected?.id).toBe("worker-a");
  });

  it("returns no selection when compatibility filtering removes every Worker", () => {
    expect(
      selectWorker(
        selectionInput([candidate({ architecture: "amd64" })], {
          workspace: {
            runtimeImage: "agent-runtime:phase3-minimal",
            requiredArchitecture: "arm64",
            requiredCapabilities: { browser: true },
          },
        }),
      ),
    ).toBeNull();
  });

  it("places only on Workers that enforce the current egress policy revision", () => {
    const candidates = [
      candidate({ id: "a-unenforced", egressEnforced: false }),
      candidate({ id: "b-stale-revision", egressRevision: 2 }),
      candidate({ id: "c-never-reported", egressRevision: null }),
      candidate({ id: "d-current" }),
    ];
    expect(selectWorker(selectionInput(candidates))?.id).toBe("d-current");
    expect(selectWorker(selectionInput(candidates.slice(0, 3)))).toBeNull();
  });

  it("places only on Workers that enforce disk quotas", () => {
    const candidates = [
      candidate({ id: "a-no-quota", storageEnforced: false }),
      candidate({ id: "b-quota" }),
    ];
    expect(selectWorker(selectionInput(candidates))?.id).toBe("b-quota");
    expect(selectWorker(selectionInput(candidates.slice(0, 1)))).toBeNull();
  });
});
