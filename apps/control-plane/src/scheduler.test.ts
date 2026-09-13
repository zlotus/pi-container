import type {
  WorkerScheduleCandidate,
  WorkerSelectionInput,
} from "@agent-runtime/database";
import { describe, expect, it } from "vitest";

import { selectWorker } from "./scheduler.js";

const NOW = new Date("2026-09-13T08:00:00.000Z");

function candidate(
  overrides: Partial<WorkerScheduleCandidate> = {},
): WorkerScheduleCandidate {
  return {
    id: "worker-a",
    architecture: "arm64",
    status: "ONLINE",
    enabled: true,
    runtimeImage: "agent-runtime:phase3-minimal",
    runtimeVersion: "phase-3",
    capabilities: {
      browser: false,
      office: false,
      ffmpeg: false,
      python: true,
      node: true,
      rust: false,
    },
    maxWorkspaces: 4,
    assignedWorkspaces: 0,
    lastHeartbeatAt: NOW,
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
    ...overrides,
  };
}

describe("Phase 5 Worker selection", () => {
  it("filters disconnected, disabled, stale, offline, and full Workers", () => {
    const candidates = [
      candidate({ id: "disconnected" }),
      candidate({ id: "disabled", enabled: false }),
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

  it("requires exact Runtime image and requested architecture", () => {
    const candidates = [
      candidate({ id: "wrong-runtime", runtimeImage: "agent-runtime:other" }),
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

  it("requires every declared capability value", () => {
    const candidates = [
      candidate({ id: "without-browser" }),
      candidate({
        id: "with-browser",
        capabilities: {
          browser: true,
          office: false,
          ffmpeg: false,
          python: true,
          node: true,
          rust: false,
        },
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
});
