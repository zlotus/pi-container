import type {
  WorkerScheduleCandidate,
  WorkerSelectionInput,
} from "@agent-runtime/database";

function isCompatible(
  candidate: WorkerScheduleCandidate,
  input: WorkerSelectionInput,
  connectedWorkerIds: ReadonlySet<string>,
): boolean {
  const { workspace, heartbeatCutoff } = input;
  // The Workspace's image must be offered, and that image must have the capabilities.
  const image = candidate.runtimeImages.find((entry) => entry.image === workspace.runtimeImage);
  if (
    image === undefined ||
    !connectedWorkerIds.has(candidate.id) ||
    !candidate.enabled ||
    !candidate.schedulable ||
    candidate.status !== "ONLINE" ||
    candidate.lastHeartbeatAt === null ||
    candidate.lastHeartbeatAt <= heartbeatCutoff ||
    candidate.maxWorkspaces === null ||
    candidate.assignedWorkspaces >= candidate.maxWorkspaces ||
    // Only Workers that verifiably enforce the current egress policy (Phase 14).
    !candidate.egressEnforced ||
    candidate.egressRevision !== input.egressRevision ||
    // Only Workers whose disk quotas are enforced (Phase 15.6).
    !candidate.storageEnforced ||
    (workspace.requiredArchitecture !== null &&
      candidate.architecture !== workspace.requiredArchitecture)
  ) {
    return false;
  }

  return Object.entries(workspace.requiredCapabilities).every(
    ([capability, required]) =>
      image.capabilities[capability as keyof typeof image.capabilities] === required,
  );
}

function compareLoad(
  left: WorkerScheduleCandidate,
  right: WorkerScheduleCandidate,
): number {
  if (left.maxWorkspaces === null || right.maxWorkspaces === null) {
    throw new Error("eligible Workers must declare capacity");
  }
  const leftScaled = left.assignedWorkspaces * right.maxWorkspaces;
  const rightScaled = right.assignedWorkspaces * left.maxWorkspaces;
  if (leftScaled !== rightScaled) return leftScaled - rightScaled;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function selectWorker(
  input: WorkerSelectionInput,
): WorkerScheduleCandidate | null {
  const connectedWorkerIds = new Set(input.connectedWorkerIds);
  const eligible = input.candidates.filter((candidate) =>
    isCompatible(candidate, input, connectedWorkerIds),
  );
  eligible.sort(compareLoad);
  return eligible[0] ?? null;
}
