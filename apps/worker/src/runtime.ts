import { randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import {
  access,
  chmod,
  chown,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  WorkspaceIdSchema,
  type WorkerReconcileAssignment,
  type WorkerReconciliationReport,
  type WorkerRecoveryIssue,
  type WorkerStorageStatus,
  type WorkspaceDiskUsage,
  type WorkspaceResources,
  type WorkspaceState,
} from "@agent-runtime/protocol";
import { parseWorkspaceBaseUrl } from "@agent-runtime/gateway";
import Docker from "dockerode";
import { z } from "zod";

import type { WorkerConfig } from "./config.js";
import { workspaceBridgeName } from "./egress/ruleset.js";
import {
  type ProjectUsage,
  StorageQuotaError,
  type StoragePolicy,
  type WorkspaceQuota,
  type WorkspaceQuotaDirectories,
} from "./storage/controller.js";

const APP_LABEL = "agent-runtime-platform";
const MANAGED_BY_LABEL = "worker";
const PI_WEB_PORT = "30141/tcp";
const PI_WEB_DEFAULT_CWD_ENV = "PI_WEB_DEFAULT_CWD=/workspace";
const RESOURCE_NAME_PREFIX = "agent-runtime-";
const BRIDGE_NAME_OPTION = "com.docker.network.bridge.name";
const CARGO_HOME_ENV = "CARGO_HOME=/home/agent/.cargo";
const HOME_INIT_PREFIX = "agent-runtime-home-init-";

/** Read-only root: these tmpfs mounts are the only writable places outside the binds. */
const WORKSPACE_TMPFS: Record<string, string> = {
  "/run": "rw,nosuid,nodev,noexec,size=16m,mode=755",
  "/run/lock": "rw,nosuid,nodev,noexec,size=1m,mode=1777",
  "/var/tmp": "rw,nosuid,nodev,size=256m,mode=1777",
};

const WORKSPACE_LOG_CONFIG = {
  Type: "json-file",
  Config: { "max-size": "10m", "max-file": "3" },
};

/** The Worker's egress rule state as seen by the Runtime (specs.md Phase 14.5). */
export interface EgressGate {
  /** Last verified state, for hot paths such as the Gateway. */
  isEnforced(): boolean;
  /** Reads the live rules back, repairing drift, before a container may start. */
  ensure(): Promise<{ enforced: boolean }>;
}

/** Used when no gate is wired in: nothing may start without verified egress rules. */
const UNENFORCED_EGRESS: EgressGate = {
  isEnforced: () => false,
  ensure: async () => ({ enforced: false }),
};

/** The Worker's disk quota controller as used by the Runtime (specs.md Phase 15.6). */
export interface StorageGate {
  readonly policy: StoragePolicy;
  isEnforced(): boolean;
  status(): WorkerStorageStatus;
  prepareWorkspace(
    directories: WorkspaceQuotaDirectories,
    quota: WorkspaceQuota,
    dataLimitBytes: number,
  ): Promise<void>;
  setDataLimit(
    directories: WorkspaceQuotaDirectories,
    quota: WorkspaceQuota,
    dataLimitBytes: number,
  ): Promise<ProjectUsage>;
  releaseWorkspace(quota: WorkspaceQuota): Promise<void>;
  usage(directory: string): Promise<ProjectUsage>;
}

/** Used when no controller is wired in: nothing may start without enforced quotas. */
const UNENFORCED_STORAGE: StorageGate = {
  policy: { projectIdMin: 1_000_000, dataInodeLimit: 0, piLimitBytes: 0, piInodeLimit: 0 },
  isEnforced: () => false,
  status: () => ({ enforced: false, fsType: null, totalBytes: null, freeBytes: null }),
  prepareWorkspace: async () => {
    throw new StorageQuotaError("STORAGE_QUOTA_UNENFORCED", "Disk quotas are not enforced");
  },
  setDataLimit: async () => {
    throw new StorageQuotaError("STORAGE_QUOTA_UNENFORCED", "Disk quotas are not enforced");
  },
  releaseWorkspace: async () => undefined,
  usage: async () => {
    throw new StorageQuotaError("STORAGE_QUOTA_UNENFORCED", "Disk quotas are not enforced");
  },
};

/** "legacy" = created before Phase 15 (writable root, two binds); it may not start. */
type ContainerGeneration = "current" | "legacy";

type NetworkGeneration = "current" | "legacy";

const ProjectIdSchema = z.number().int().min(1).max(2 ** 32 - 2);

const MetadataSchema = z
  .object({
    version: z.literal(1),
    workspaceId: WorkspaceIdSchema,
    workerId: z.string(),
    runtimeImage: z.string().min(1),
    /** Added by Phase 15 the first time the Workspace is prepared under quotas. */
    quota: z
      .object({
        dataProjectId: ProjectIdSchema,
        piProjectId: ProjectIdSchema,
        dataLimitBytes: z.number().int().positive(),
      })
      .strict()
      .optional(),
    homeInitialized: z.boolean().optional(),
  })
  .strict();

type WorkspaceMetadata = z.infer<typeof MetadataSchema>;

interface WorkspacePaths {
  root: string;
  workspace: string;
  home: string;
  tmp: string;
  pi: string;
  metadata: string;
  metadataFile: string;
}

interface ManagedWorkspacePaths extends WorkspacePaths {
  runtimeImage: string;
  managed: WorkspaceMetadata;
}

export interface WorkspaceRuntimeObservation {
  workspaceId: string;
  state: WorkspaceState;
  runtimeImage: string;
  observedAt: string;
}

export class WorkspaceRuntimeError extends Error {
  constructor(
    readonly code:
      | "WORKSPACE_NOT_MANAGED"
      | "WORKSPACE_METADATA_MISMATCH"
      | "UNMANAGED_CONTAINER_CONFLICT"
      | "UNMANAGED_NETWORK_CONFLICT"
      | "RUNTIME_CONFIGURATION_MISMATCH"
      | "RUNTIME_START_FAILED"
      | "RUNTIME_NOT_READY"
      | "RUNTIME_ENGINE_ERROR"
      | "EGRESS_UNENFORCED"
      | "EGRESS_NETWORK_LEGACY"
      | "STORAGE_QUOTA_UNENFORCED"
      | "STORAGE_QUOTA_APPLY_FAILED"
      | "STORAGE_LIMIT_EXCEEDED"
      | "STORAGE_MIGRATION_REQUIRED",
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function managedLabels(workerId: string, workspaceId: string) {
  return {
    app: APP_LABEL,
    managed_by: MANAGED_BY_LABEL,
    worker_id: workerId,
    workspace_id: workspaceId,
  };
}

function labelsMatch(
  labels: Record<string, string> | undefined,
  expected: Record<string, string>,
): boolean {
  return Object.entries(expected).every(([key, value]) => labels?.[key] === value);
}

function dockerStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return undefined;
  }
  const statusCode = error.statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

export class DockerWorkspaceRuntime {
  readonly #docker: Docker;
  readonly #managedRoot: string;
  readonly #workspacesRoot: string;
  readonly #runtimeUser: string;
  readonly #runtimeUid: number;
  readonly #runtimeGid: number;
  readonly #startTimeoutMs: number;
  readonly #workerId: string;
  readonly #runtimeImage: string;
  readonly #workspaceResources: WorkspaceResources;
  readonly #workspaceBaseUrl: ReturnType<typeof parseWorkspaceBaseUrl>;
  readonly #readinessProbe: (port: string) => Promise<boolean>;
  readonly #egress: EgressGate;
  readonly #storage: StorageGate;
  readonly #nofileLimit: number;
  /** Serializes project ID allocation across concurrent Workspace commands. */
  #projectAllocation: Promise<unknown> = Promise.resolve();
  #initialized = false;

  constructor(
    config: WorkerConfig,
    docker = new Docker({ socketPath: config.DOCKER_SOCKET_PATH }),
    readinessProbe: (port: string) => Promise<boolean> = async (port) => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(2_000),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
    egress: EgressGate = UNENFORCED_EGRESS,
    storage: StorageGate = UNENFORCED_STORAGE,
  ) {
    this.#docker = docker;
    this.#egress = egress;
    this.#storage = storage;
    this.#nofileLimit = config.WORKSPACE_NOFILE_LIMIT;
    this.#managedRoot = resolve(config.WORKER_MANAGED_ROOT);
    this.#workspacesRoot = join(this.#managedRoot, "workspaces");
    this.#runtimeUser = `${config.WORKSPACE_UID}:${config.WORKSPACE_GID}`;
    this.#runtimeUid = config.WORKSPACE_UID;
    this.#runtimeGid = config.WORKSPACE_GID;
    this.#startTimeoutMs = config.WORKSPACE_START_TIMEOUT_MS;
    this.#workerId = config.WORKER_ID;
    this.#runtimeImage = config.RUNTIME_IMAGE;
    this.#workspaceResources = {
      cpuCount: config.WORKSPACE_CPU_COUNT,
      memoryBytes: config.WORKSPACE_MEMORY_BYTES,
      pidsLimit: config.WORKSPACE_PIDS_LIMIT,
    };
    this.#workspaceBaseUrl = parseWorkspaceBaseUrl(config.WORKSPACE_BASE_URL);
    this.#readinessProbe = readinessProbe;
  }

  async ensure(
    workspaceId: string,
    runtimeImage: string,
    resources: WorkspaceResources,
    storage: { diskLimitBytes: number },
  ): Promise<WorkspaceRuntimeObservation> {
    this.#assertRuntimeImage(runtimeImage);
    this.#assertResources(resources);
    let paths = await this.#ensureWorkspacePaths(workspaceId);
    const networkName = this.#networkName(workspaceId);
    const existing = await this.#findNamedContainer(workspaceId);
    if (existing !== null) {
      this.#assertCurrentGeneration(
        this.#verifyManagedContainerIdentity(await existing.inspect(), workspaceId, paths, networkName),
      );
    }
    // Quotas are in place before a container can see the directories (Phase 15.6).
    paths = await this.#prepareStorage(paths, storage.diskLimitBytes);
    await this.#ensureNetwork(workspaceId, networkName, paths);
    const created = existing === null;
    if (existing === null) {
      paths = await this.#initializeHome(paths);
      try {
        await this.#docker.createContainer({
          name: this.#containerName(workspaceId),
          Image: runtimeImage,
          User: this.#runtimeUser,
          WorkingDir: "/workspace",
          Env: [
            "HOME=/home/agent",
            "PI_CODING_AGENT_DIR=/agent/pi",
            PI_WEB_DEFAULT_CWD_ENV,
            "PI_WEB_HOSTNAME=0.0.0.0",
            "PI_WEB_NO_OPEN=1",
            "PI_WEB_SKIP_VERSION_CHECK=1",
            "PI_WEB_IDLE_TIMEOUT_MS=0",
            `PI_WEB_ALLOWED_HOSTS=${workspaceId}.${this.#workspaceBaseUrl.hostname}`,
            "PORT=30141",
            CARGO_HOME_ENV,
          ],
          ExposedPorts: { [PI_WEB_PORT]: {} },
          Labels: managedLabels(this.#workerId, workspaceId),
          HostConfig: {
            AutoRemove: false,
            // `Mounts`, unlike `Binds`, fails instead of creating a missing source as
            // root: no container starts on bare disk when the quota filesystem is absent.
            Mounts: this.#workspaceMounts(paths).map((mount) => ({
              Type: "bind" as const,
              Source: mount.source,
              Target: mount.target,
              ReadOnly: false,
            })),
            ReadonlyRootfs: true,
            Tmpfs: { ...WORKSPACE_TMPFS },
            Ulimits: [
              { Name: "nofile", Soft: this.#nofileLimit, Hard: this.#nofileLimit },
              { Name: "core", Soft: 0, Hard: 0 },
            ],
            LogConfig: WORKSPACE_LOG_CONFIG,
            CapDrop: ["ALL"],
            Memory: resources.memoryBytes,
            NanoCpus: Math.round(resources.cpuCount * 1_000_000_000),
            NetworkMode: networkName,
            PidsLimit: resources.pidsLimit,
            PortBindings: {
              [PI_WEB_PORT]: [{ HostIp: "127.0.0.1", HostPort: "" }],
            },
            Privileged: false,
            RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
            SecurityOpt: ["no-new-privileges:true"],
          },
        });
      } catch (error) {
        throw this.#engineError(error, "create the managed Workspace container");
      }
    }

    const container = await this.#requireManagedContainer(workspaceId);
    const inspection = await container.inspect();
    this.#assertCurrentGeneration(
      this.#verifyManagedContainerIdentity(inspection, workspaceId, paths, networkName),
    );
    if (created) {
      this.#verifyCurrentRuntimeConfiguration(inspection, resources);
    } else {
      this.#verifyLegacyRuntimeConfiguration(inspection, resources);
    }
    return this.#observation(
      workspaceId,
      inspection.State.Running ? "RUNNING" : "STOPPED",
    );
  }

  async start(workspaceId: string): Promise<WorkspaceRuntimeObservation> {
    const paths = await this.#requireWorkspacePaths(workspaceId);
    this.#assertRuntimeImage(paths.runtimeImage);
    const container = await this.#requireManagedContainer(workspaceId);
    let inspection = await container.inspect();
    this.#assertCurrentGeneration(
      this.#verifyManagedContainerIdentity(
        inspection,
        workspaceId,
        paths,
        this.#networkName(workspaceId),
      ),
    );
    this.#verifyLegacyCompatibleDefaultCwd(inspection);
    await this.#ensureNetwork(workspaceId, this.#networkName(workspaceId), paths);
    if (!inspection.State.Running) {
      await this.#assertEgressEnforced();
      const quota = paths.managed.quota;
      if (quota === undefined) {
        throw new WorkspaceRuntimeError(
          "STORAGE_QUOTA_UNENFORCED",
          "Workspace has no disk quota yet; ensure it before starting",
        );
      }
      // Re-verify (and repair) the projects right before the container starts.
      await this.#prepareStorage(paths, quota.dataLimitBytes);
      await this.#clearTemporaryDirectory(paths);
      try {
        await container.start();
      } catch (error) {
        if (dockerStatus(error) !== 304) {
          throw this.#engineError(error, "start the managed Workspace container");
        }
      }
    }

    const deadline = Date.now() + this.#startTimeoutMs;
    while (Date.now() < deadline) {
      inspection = await container.inspect();
      if (!inspection.State.Running) {
        throw new WorkspaceRuntimeError(
          "RUNTIME_START_FAILED",
          "Workspace Runtime exited before pi-web became ready",
        );
      }
      const binding = inspection.NetworkSettings.Ports[PI_WEB_PORT]?.[0];
      if (
        binding?.HostIp === "127.0.0.1" &&
        binding.HostPort !== undefined &&
        (await this.#readinessProbe(binding.HostPort))
      ) {
        return this.#observation(workspaceId, "RUNNING");
      }
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    throw new WorkspaceRuntimeError(
      "RUNTIME_NOT_READY",
      "pi-web did not become ready before the configured timeout",
      true,
    );
  }

  async stop(workspaceId: string): Promise<WorkspaceRuntimeObservation> {
    const paths = await this.#requireWorkspacePaths(workspaceId);
    const container = await this.#requireManagedContainer(workspaceId);
    const inspection = await container.inspect();
    this.#verifyManagedContainerIdentity(
      inspection,
      workspaceId,
      paths,
      this.#networkName(workspaceId),
    );
    if (inspection.State.Running) {
      try {
        await container.stop({ t: 15 });
      } catch (error) {
        if (dockerStatus(error) !== 304) {
          throw this.#engineError(error, "stop the managed Workspace container");
        }
      }
    }
    return this.#observation(workspaceId, "STOPPED", paths.runtimeImage);
  }

  async inspect(workspaceId: string): Promise<WorkspaceRuntimeObservation> {
    const paths = await this.#requireWorkspacePaths(workspaceId);
    const container = await this.#findNamedContainer(workspaceId);
    if (container === null) {
      return this.#observation(workspaceId, "CREATED", paths.runtimeImage);
    }
    const inspection = await container.inspect();
    this.#verifyManagedContainerIdentity(
      inspection,
      workspaceId,
      paths,
      this.#networkName(workspaceId),
    );
    return this.#observation(
      workspaceId,
      inspection.State.Running ? "RUNNING" : "STOPPED",
      paths.runtimeImage,
    );
  }

  async delete(workspaceId: string): Promise<WorkspaceRuntimeObservation> {
    const paths = await this.#requireWorkspacePaths(workspaceId);
    const container = await this.#findNamedContainer(workspaceId);
    if (container !== null) {
      const inspection = await container.inspect();
      this.#verifyManagedContainerIdentity(
        inspection,
        workspaceId,
        paths,
        this.#networkName(workspaceId),
      );
    }

    const network = await this.#findNamedNetwork(workspaceId);
    if (network !== null) {
      const inspection = await network.inspect();
      if (
        inspection.Name !== this.#networkName(workspaceId) ||
        !labelsMatch(
          inspection.Labels,
          managedLabels(this.#workerId, workspaceId),
        )
      ) {
        throw new WorkspaceRuntimeError(
          "UNMANAGED_NETWORK_CONFLICT",
          "Workspace network is not managed by this Worker",
        );
      }
    }

    if (container !== null) {
      try {
        await container.remove({ force: true, v: false });
      } catch (error) {
        if (dockerStatus(error) !== 404) {
          throw this.#engineError(error, "delete the managed Workspace container");
        }
      }
    }

    if (network !== null) {
      try {
        await network.remove();
      } catch (error) {
        if (dockerStatus(error) !== 404) {
          throw this.#engineError(error, "delete the managed Workspace network");
        }
      }
    }

    await rm(paths.root, { recursive: true, force: false });
    const quota = paths.managed.quota;
    if (quota !== undefined && this.#storage.isEnforced()) {
      // Hygiene only: every later user of these IDs sets its own limits first.
      await this.#storage.releaseWorkspace(quota).catch(() => undefined);
    }
    return this.#observation(workspaceId, "CREATED", paths.runtimeImage);
  }

  async allocatedWorkspaces(): Promise<number> {
    try {
      const containers = await this.#docker.listContainers({
        all: true,
        filters: {
          label: [
            `app=${APP_LABEL}`,
            `managed_by=${MANAGED_BY_LABEL}`,
            `worker_id=${this.#workerId}`,
          ],
        },
      });
      return containers.length;
    } catch (error) {
      throw this.#engineError(error, "count managed Workspace containers");
    }
  }

  /**
   * Changes a Workspace's data limit in place (specs.md Phase 15.7). A Workspace that was
   * never prepared under quotas gets its limit from the next `workspace.ensure` instead.
   */
  async setDiskLimit(
    workspaceId: string,
    dataLimitBytes: number,
  ): Promise<{ dataLimitBytes: number; dataUsedBytes: number }> {
    const paths = await this.#requireWorkspacePaths(workspaceId);
    const quota = paths.managed.quota;
    if (quota === undefined) return { dataLimitBytes, dataUsedBytes: 0 };
    let usage: ProjectUsage;
    try {
      usage = await this.#storage.setDataLimit(paths, quota, dataLimitBytes);
    } catch (error) {
      throw this.#storageError(error);
    }
    await this.#writeMetadata(paths, {
      ...paths.managed,
      quota: { ...quota, dataLimitBytes },
    });
    return { dataLimitBytes, dataUsedBytes: usage.usedBytes };
  }

  /**
   * Samples every prepared Workspace's projects through `statfs` (no privilege needed).
   * Empty while quotas are not enforced, because `statfs` would then describe the disk.
   */
  async diskUsage(): Promise<WorkspaceDiskUsage[]> {
    if (!this.#storage.isEnforced()) return [];
    await this.#initialize();
    const samples: WorkspaceDiskUsage[] = [];
    for (const entry of await readdir(this.#workspacesRoot, { withFileTypes: true })) {
      const workspaceId = WorkspaceIdSchema.safeParse(entry.name);
      if (!workspaceId.success || !entry.isDirectory()) continue;
      try {
        const paths = await this.#requireWorkspacePaths(workspaceId.data);
        const quota = paths.managed.quota;
        if (quota === undefined) continue;
        const [data, pi] = await Promise.all([
          this.#storage.usage(paths.workspace),
          this.#storage.usage(paths.pi),
        ]);
        samples.push({
          workspaceId: workspaceId.data,
          dataUsedBytes: data.usedBytes,
          dataLimitBytes: data.limitBytes,
          dataUsedInodes: data.usedInodes,
          piUsedBytes: pi.usedBytes,
          piLimitBytes: pi.limitBytes,
        });
      } catch {
        // A Workspace being deleted or with damaged metadata is simply not sampled.
      }
      if (samples.length >= 10_000) break;
    }
    return samples;
  }

  async reconcile(
    assignments: readonly WorkerReconcileAssignment[],
  ): Promise<WorkerReconciliationReport> {
    await this.#initialize();
    let containers: Docker.ContainerInfo[];
    let networks: Docker.NetworkInspectInfo[];
    let directories: Dirent[];
    try {
      [containers, networks, directories] = await Promise.all([
        this.#docker.listContainers({ all: true }),
        this.#docker.listNetworks(),
        readdir(this.#workspacesRoot, { withFileTypes: true }),
      ]);
    } catch (error) {
      throw this.#engineError(error, "inventory managed Workspace resources");
    }

    const assignedIds = new Set(
      assignments.map((assignment) => assignment.workspaceId),
    );
    const containerIds = new Set<string>();
    const networkIds = new Set<string>();
    const directoryIds = new Set<string>();
    const issues: WorkerRecoveryIssue[] = [];

    const addIssue = (issue: WorkerRecoveryIssue): void => {
      if (issues.length >= 10_000) {
        throw new WorkspaceRuntimeError(
          "RUNTIME_ENGINE_ERROR",
          "Local Runtime inventory exceeds the supported recovery limit",
        );
      }
      issues.push(issue);
    };

    for (const container of containers) {
      const name = container.Names.find((entry) =>
        entry.startsWith(`/${RESOURCE_NAME_PREFIX}`),
      );
      const platformLabeled =
        container.Labels.app === APP_LABEL &&
        container.Labels.managed_by === MANAGED_BY_LABEL;
      if (name === undefined && !platformLabeled) continue;
      const nameWorkspaceId = this.#workspaceIdFromResourceName(name?.slice(1));
      const labeledWorkspaceId = WorkspaceIdSchema.safeParse(
        container.Labels.workspace_id,
      );
      const inferredWorkspaceId = this.#resourceWorkspaceId(
        name?.slice(1),
        container.Labels.workspace_id,
      );
      if (nameWorkspaceId !== null) containerIds.add(nameWorkspaceId);
      if (labeledWorkspaceId.success) containerIds.add(labeledWorkspaceId.data);
      const resourceIds = [
        ...(nameWorkspaceId === null ? [] : [nameWorkspaceId]),
        ...(labeledWorkspaceId.success ? [labeledWorkspaceId.data] : []),
      ];
      const workspaceId =
        resourceIds.find((candidate) => !assignedIds.has(candidate)) ??
        inferredWorkspaceId;
      if (
        resourceIds.length > 0 &&
        resourceIds.every((candidate) => assignedIds.has(candidate))
      ) {
        continue;
      }
      addIssue({
        classification: this.#resourceClassification(
          container.Labels,
          workspaceId,
          name?.slice(1),
        ),
        resource: "CONTAINER",
        ...(workspaceId === null ? {} : { workspaceId }),
        code: "UNASSIGNED_LOCAL_RESOURCE",
      });
    }

    for (const network of networks) {
      const inNamespace = network.Name.startsWith(RESOURCE_NAME_PREFIX);
      const labels = network.Labels ?? {};
      const platformLabeled =
        labels.app === APP_LABEL && labels.managed_by === MANAGED_BY_LABEL;
      if (!inNamespace && !platformLabeled) continue;
      const nameWorkspaceId = this.#workspaceIdFromResourceName(network.Name);
      const labeledWorkspaceId = WorkspaceIdSchema.safeParse(
        labels.workspace_id,
      );
      const inferredWorkspaceId = this.#resourceWorkspaceId(
        network.Name,
        labels.workspace_id,
      );
      if (nameWorkspaceId !== null) networkIds.add(nameWorkspaceId);
      if (labeledWorkspaceId.success) networkIds.add(labeledWorkspaceId.data);
      const resourceIds = [
        ...(nameWorkspaceId === null ? [] : [nameWorkspaceId]),
        ...(labeledWorkspaceId.success ? [labeledWorkspaceId.data] : []),
      ];
      const workspaceId =
        resourceIds.find((candidate) => !assignedIds.has(candidate)) ??
        inferredWorkspaceId;
      if (
        resourceIds.length > 0 &&
        resourceIds.every((candidate) => assignedIds.has(candidate))
      ) {
        continue;
      }
      addIssue({
        classification: this.#resourceClassification(
          labels,
          workspaceId,
          network.Name,
        ),
        resource: "NETWORK",
        ...(workspaceId === null ? {} : { workspaceId }),
        code: "UNASSIGNED_LOCAL_RESOURCE",
      });
    }

    for (const directory of directories) {
      const parsedId = WorkspaceIdSchema.safeParse(directory.name);
      const workspaceId = parsedId.success ? parsedId.data : null;
      if (workspaceId !== null) directoryIds.add(workspaceId);
      if (workspaceId !== null && assignedIds.has(workspaceId)) continue;
      let classification: WorkerRecoveryIssue["classification"] =
        "UNKNOWN_RESOURCE";
      if (workspaceId !== null && directory.isDirectory()) {
        classification = await this.#directoryClassification(workspaceId);
      }
      addIssue({
        classification,
        resource: "DIRECTORY",
        ...(workspaceId === null ? {} : { workspaceId }),
        code: directory.isDirectory()
          ? "UNASSIGNED_LOCAL_RESOURCE"
          : "INVALID_MANAGED_ROOT_ENTRY",
      });
    }

    const workspaces = [] as WorkerReconciliationReport["workspaces"];
    for (const assignment of assignments) {
      const hasLocalResource =
        containerIds.has(assignment.workspaceId) ||
        networkIds.has(assignment.workspaceId) ||
        directoryIds.has(assignment.workspaceId);
      if (!hasLocalResource) {
        workspaces.push({
          status: "MISSING",
          workspaceId: assignment.workspaceId,
        });
        continue;
      }
      try {
        workspaces.push({
          status: "OBSERVED",
          workspace: await this.#inspectForRecovery(assignment),
        });
      } catch (error) {
        const runtimeError =
          error instanceof WorkspaceRuntimeError
            ? error
            : this.#engineError(error, "inspect a managed Workspace Runtime");
        workspaces.push({
          status: "INVALID",
          workspaceId: assignment.workspaceId,
          code: runtimeError.code,
          retryable: runtimeError.retryable,
        });
      }
    }

    return { workspaces, issues, observedAt: new Date().toISOString() };
  }

  async gatewayTarget(workspaceId: string): Promise<URL> {
    const paths = await this.#requireWorkspacePaths(workspaceId);
    this.#assertRuntimeImage(paths.runtimeImage);
    const container = await this.#requireManagedContainer(workspaceId);
    const inspection = await container.inspect();
    this.#assertCurrentGeneration(
      this.#verifyManagedContainerIdentity(
        inspection,
        workspaceId,
        paths,
        this.#networkName(workspaceId),
      ),
    );
    this.#verifyLegacyCompatibleDefaultCwd(inspection);
    if (!inspection.State.Running) {
      throw new WorkspaceRuntimeError(
        "RUNTIME_NOT_READY",
        "Workspace Runtime is not running",
        true,
      );
    }
    if (!this.#storage.isEnforced()) {
      throw new WorkspaceRuntimeError(
        "STORAGE_QUOTA_UNENFORCED",
        "Disk quotas are not enforced on this Worker",
        true,
      );
    }
    if (!this.#egress.isEnforced()) {
      throw new WorkspaceRuntimeError(
        "EGRESS_UNENFORCED",
        "Workspace egress rules are not enforced on this Worker",
        true,
      );
    }
    const bindings = inspection.NetworkSettings.Ports[PI_WEB_PORT];
    const binding = bindings?.length === 1 ? bindings[0] : undefined;
    if (
      binding?.HostIp !== "127.0.0.1" ||
      binding.HostPort === undefined ||
      !/^\d{1,5}$/.test(binding.HostPort)
    ) {
      throw new WorkspaceRuntimeError(
        "RUNTIME_CONFIGURATION_MISMATCH",
        "Workspace Runtime does not have one managed loopback endpoint",
      );
    }
    const port = Number.parseInt(binding.HostPort, 10);
    if (port < 1 || port > 65_535) {
      throw new WorkspaceRuntimeError(
        "RUNTIME_CONFIGURATION_MISMATCH",
        "Workspace Runtime has an invalid loopback endpoint",
      );
    }
    return new URL(`http://127.0.0.1:${port}`);
  }

  async #initialize(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(this.#workspacesRoot, { recursive: true, mode: 0o700 });
    const root = await realpath(this.#managedRoot);
    const workspaces = await realpath(this.#workspacesRoot);
    if (workspaces !== join(root, "workspaces")) {
      throw new WorkspaceRuntimeError(
        "WORKSPACE_METADATA_MISMATCH",
        "Managed Workspace root resolves outside the configured root",
      );
    }
    this.#initialized = true;
  }

  async #paths(workspaceId: string): Promise<WorkspacePaths> {
    await this.#initialize();
    WorkspaceIdSchema.parse(workspaceId);
    const root = join(this.#workspacesRoot, workspaceId);
    if (dirname(root) !== this.#workspacesRoot) {
      throw new WorkspaceRuntimeError(
        "WORKSPACE_METADATA_MISMATCH",
        "Workspace path is outside the managed root",
      );
    }
    const metadata = join(root, "metadata");
    return {
      root,
      workspace: join(root, "workspace"),
      home: join(root, "home"),
      tmp: join(root, "tmp"),
      pi: join(root, "pi"),
      metadata,
      metadataFile: join(metadata, "managed.json"),
    };
  }

  async #ensureWorkspacePaths(workspaceId: string): Promise<ManagedWorkspacePaths> {
    const paths = await this.#paths(workspaceId);
    let created = false;
    try {
      await mkdir(paths.root, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }

    if (!created) {
      this.#assertRuntimeImage((await this.#verifyMetadata(paths, workspaceId)).runtimeImage);
    }
    for (const directory of [paths.workspace, paths.home, paths.tmp, paths.pi, paths.metadata]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    try {
      for (const directory of [paths.workspace, paths.home, paths.tmp, paths.pi]) {
        await chown(directory, this.#runtimeUid, this.#runtimeGid);
      }
      // The Workspace's /tmp; the parent directory keeps it private on the host.
      await chmod(paths.tmp, 0o1777);
    } catch (error) {
      throw this.#engineError(error, "set managed Workspace directory ownership");
    }
    if (created) {
      await writeFile(
        paths.metadataFile,
        `${JSON.stringify({
          version: 1,
          workspaceId,
          workerId: this.#workerId,
          runtimeImage: this.#runtimeImage,
        })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    }
    await this.#assertRealDirectories(paths, true);
    const managed = await this.#verifyMetadata(paths, workspaceId);
    return { ...paths, runtimeImage: managed.runtimeImage, managed };
  }

  async #requireWorkspacePaths(workspaceId: string): Promise<ManagedWorkspacePaths> {
    const paths = await this.#paths(workspaceId);
    try {
      await access(paths.metadataFile, constants.R_OK);
    } catch {
      throw new WorkspaceRuntimeError(
        "WORKSPACE_NOT_MANAGED",
        "Workspace is not managed by this Worker",
      );
    }
    const managed = await this.#verifyMetadata(paths, workspaceId);
    await this.#assertRealDirectories(paths, false);
    return { ...paths, runtimeImage: managed.runtimeImage, managed };
  }

  async #verifyMetadata(paths: WorkspacePaths, workspaceId: string): Promise<WorkspaceMetadata> {
    let decoded: unknown;
    try {
      const metadataFile = await lstat(paths.metadataFile);
      if (!metadataFile.isFile() || metadataFile.isSymbolicLink()) {
        throw new Error("Workspace metadata is not a regular file");
      }
      decoded = JSON.parse(await readFile(paths.metadataFile, "utf8"));
    } catch {
      throw new WorkspaceRuntimeError(
        "WORKSPACE_METADATA_MISMATCH",
        "Workspace metadata is missing or invalid",
      );
    }
    const metadata = MetadataSchema.safeParse(decoded);
    if (
      !metadata.success ||
      metadata.data.workspaceId !== workspaceId ||
      metadata.data.workerId !== this.#workerId
    ) {
      throw new WorkspaceRuntimeError(
        "WORKSPACE_METADATA_MISMATCH",
        "Workspace metadata does not match this Worker assignment",
      );
    }
    return metadata.data;
  }

  /** Replaces the metadata file atomically (write, then rename over it). */
  async #writeMetadata(paths: WorkspacePaths, metadata: WorkspaceMetadata): Promise<void> {
    const temporary = `${paths.metadataFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(MetadataSchema.parse(metadata))}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, paths.metadataFile);
  }

  /** Pre-Phase-15 Workspaces have no home/tmp yet; those are checked once they exist. */
  async #assertRealDirectories(paths: WorkspacePaths, requireAll: boolean): Promise<void> {
    const optional = new Set([paths.home, paths.tmp]);
    for (const path of [paths.root, paths.workspace, paths.home, paths.tmp, paths.pi, paths.metadata]) {
      let stat;
      try {
        stat = await lstat(path);
      } catch (error) {
        if (!requireAll && optional.has(path) && isNodeError(error, "ENOENT")) continue;
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new WorkspaceRuntimeError(
          "WORKSPACE_METADATA_MISMATCH",
          "Managed Workspace path is not a real directory",
        );
      }
      const actual = await realpath(path);
      if (actual !== path) {
        throw new WorkspaceRuntimeError(
          "WORKSPACE_METADATA_MISMATCH",
          "Managed Workspace path resolves outside its expected location",
        );
      }
    }
  }

  /**
   * Creates the Workspace network, or migrates a pre-Phase-14 network (Docker's default
   * `br-<id>` bridge name, which the egress rules do not match) to the `arw-` bridge name.
   * A legacy network is only replaced while its container is stopped.
   */
  async #ensureNetwork(
    workspaceId: string,
    name: string,
    paths: ManagedWorkspacePaths,
  ): Promise<void> {
    const existing = await this.#findNamedNetwork(workspaceId);
    if (existing !== null) {
      const inspection = await existing.inspect();
      const generation = this.#verifyManagedNetwork(inspection, workspaceId, name);
      if (generation === "current") return;

      const container = await this.#findNamedContainer(workspaceId);
      if (container !== null) {
        const containerInspection = await container.inspect();
        this.#verifyManagedContainerIdentity(containerInspection, workspaceId, paths, name);
        if (containerInspection.State.Running) {
          throw new WorkspaceRuntimeError(
            "EGRESS_NETWORK_LEGACY",
            "Workspace must be stopped before its network can be migrated",
          );
        }
        if (containerInspection.NetworkSettings.Networks?.[name] !== undefined) {
          try {
            await existing.disconnect({ Container: containerInspection.Id, Force: true });
          } catch (error) {
            throw this.#engineError(error, "detach the legacy Workspace network");
          }
        }
      }
      try {
        await existing.remove();
      } catch (error) {
        throw this.#engineError(error, "remove the legacy Workspace network");
      }
      await this.#createNetwork(workspaceId, name);
      if (container !== null) {
        const created = await this.#findNamedNetwork(workspaceId);
        if (created === null) {
          throw new WorkspaceRuntimeError(
            "UNMANAGED_NETWORK_CONFLICT",
            "Migrated Workspace network is missing",
          );
        }
        try {
          const containerInspection = await container.inspect();
          await created.connect({ Container: containerInspection.Id });
        } catch (error) {
          throw this.#engineError(error, "attach the migrated Workspace network");
        }
      }
      return;
    }
    await this.#createNetwork(workspaceId, name);
  }

  async #createNetwork(workspaceId: string, name: string): Promise<void> {
    try {
      await this.#docker.createNetwork({
        Name: name,
        CheckDuplicate: true,
        Driver: "bridge",
        Internal: false,
        Attachable: false,
        EnableIPv6: false,
        Labels: managedLabels(this.#workerId, workspaceId),
        Options: {
          "com.docker.network.bridge.enable_icc": "false",
          "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1",
          [BRIDGE_NAME_OPTION]: workspaceBridgeName(workspaceId),
        },
      });
    } catch (error) {
      throw this.#engineError(error, "create the isolated Workspace network");
    }
  }

  async #assertEgressEnforced(): Promise<void> {
    let enforced: boolean;
    try {
      enforced = (await this.#egress.ensure()).enforced;
    } catch {
      enforced = false;
    }
    if (!enforced) {
      throw new WorkspaceRuntimeError(
        "EGRESS_UNENFORCED",
        "Workspace egress rules are not enforced on this Worker",
      );
    }
  }

  /**
   * Fail-closed response to lost egress rules (specs.md Phase 14.11 Q3): stops every
   * running container of this Worker. Data and Pi Sessions stay in the managed root.
   */
  async stopRunningWorkspaces(): Promise<string[]> {
    let containers: Docker.ContainerInfo[];
    try {
      containers = await this.#docker.listContainers({
        filters: {
          label: [
            `app=${APP_LABEL}`,
            `managed_by=${MANAGED_BY_LABEL}`,
            `worker_id=${this.#workerId}`,
          ],
          status: ["running", "restarting"],
        },
      });
    } catch (error) {
      throw this.#engineError(error, "list running Workspace containers");
    }
    const stopped: string[] = [];
    for (const info of containers) {
      const workspaceId = WorkspaceIdSchema.safeParse(info.Labels.workspace_id);
      if (
        !workspaceId.success ||
        !info.Names.includes(`/${this.#containerName(workspaceId.data)}`) ||
        !labelsMatch(info.Labels, managedLabels(this.#workerId, workspaceId.data))
      ) {
        continue;
      }
      try {
        await this.#docker.getContainer(info.Id).stop({ t: 15 });
      } catch (error) {
        if (dockerStatus(error) !== 304) {
          throw this.#engineError(error, "stop a Workspace container");
        }
      }
      stopped.push(workspaceId.data);
    }
    return stopped;
  }

  #storageError(error: unknown): WorkspaceRuntimeError {
    if (error instanceof WorkspaceRuntimeError) return error;
    if (error instanceof StorageQuotaError) {
      return new WorkspaceRuntimeError(error.code, error.message, error.retryable);
    }
    return new WorkspaceRuntimeError(
      "STORAGE_QUOTA_APPLY_FAILED",
      "Workspace disk quota could not be applied",
      true,
    );
  }

  /**
   * Puts every Workspace directory under its projects with the requested data limit
   * before a container is created or started (specs.md Phase 15.6). The first time, two
   * project IDs are allocated and recorded in the Workspace's metadata.
   */
  async #prepareStorage(
    paths: ManagedWorkspacePaths,
    dataLimitBytes: number,
  ): Promise<ManagedWorkspacePaths> {
    if (!this.#storage.isEnforced()) {
      throw new WorkspaceRuntimeError(
        "STORAGE_QUOTA_UNENFORCED",
        "Disk quotas are not enforced on this Worker",
      );
    }
    let managed = paths.managed;
    if (managed.quota === undefined) {
      managed = await this.#withProjectAllocation(async () => {
        const [dataProjectId, piProjectId] = await this.#unusedProjectIds(2);
        if (dataProjectId === undefined || piProjectId === undefined) {
          throw new WorkspaceRuntimeError(
            "STORAGE_QUOTA_APPLY_FAILED",
            "No free quota project IDs are left",
          );
        }
        const next = {
          ...paths.managed,
          quota: { dataProjectId, piProjectId, dataLimitBytes },
        };
        await this.#writeMetadata(paths, next);
        return next;
      });
    } else if (managed.quota.dataLimitBytes !== dataLimitBytes) {
      managed = { ...managed, quota: { ...managed.quota, dataLimitBytes } };
      await this.#writeMetadata(paths, managed);
    }
    const quota = managed.quota;
    if (quota === undefined) throw new Error("quota metadata was not recorded");
    try {
      await this.#storage.prepareWorkspace(paths, quota, dataLimitBytes);
    } catch (error) {
      throw this.#storageError(error);
    }
    return { ...paths, managed };
  }

  async #withProjectAllocation<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#projectAllocation.then(task, task);
    this.#projectAllocation = run.catch(() => undefined);
    return run;
  }

  /** The lowest IDs above the probe's that no local Workspace metadata records. */
  async #unusedProjectIds(count: number): Promise<number[]> {
    const used = new Set<number>();
    for (const entry of await readdir(this.#workspacesRoot, { withFileTypes: true })) {
      if (!WorkspaceIdSchema.safeParse(entry.name).success || !entry.isDirectory()) continue;
      try {
        const metadata = MetadataSchema.safeParse(
          JSON.parse(await readFile(join(this.#workspacesRoot, entry.name, "metadata", "managed.json"), "utf8")),
        );
        if (metadata.success && metadata.data.quota !== undefined) {
          used.add(metadata.data.quota.dataProjectId);
          used.add(metadata.data.quota.piProjectId);
        }
      } catch {
        // Unreadable metadata cannot hold an allocation this Worker made.
      }
    }
    const ids: number[] = [];
    const first = this.#storage.policy.projectIdMin + 1;
    for (let candidate = first; ids.length < count && candidate < first + 2 ** 20; candidate += 1) {
      if (!used.has(candidate)) ids.push(candidate);
    }
    return ids;
  }

  /** The Workspace's /tmp starts empty whenever the Worker starts the container. */
  async #clearTemporaryDirectory(paths: WorkspacePaths): Promise<void> {
    const stat = await lstat(paths.tmp);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new WorkspaceRuntimeError(
        "WORKSPACE_METADATA_MISMATCH",
        "Managed Workspace path is not a real directory",
      );
    }
    for (const entry of await readdir(paths.tmp)) {
      // rm never follows a symbolic link; it removes the link itself.
      await rm(join(paths.tmp, entry), { recursive: true, force: true });
    }
  }

  /**
   * Seeds a new home with the image's /etc/skel without overwriting anything, inside a
   * short-lived sandbox whose only writable mount is that home (specs.md Phase 15.4).
   */
  async #initializeHome(paths: ManagedWorkspacePaths): Promise<ManagedWorkspacePaths> {
    if (paths.managed.homeInitialized === true) return paths;
    const name = `${HOME_INIT_PREFIX}${randomUUID()}`;
    let container: Docker.Container | null = null;
    try {
      container = await this.#docker.createContainer({
        name,
        Image: paths.runtimeImage,
        User: this.#runtimeUser,
        Entrypoint: ["/bin/sh", "-c"],
        Cmd: [
          'for f in /etc/skel/.[!.]* /etc/skel/*; do [ -e "$f" ] || continue; ' +
            't="/home/agent/$(basename "$f")"; [ -e "$t" ] || [ -L "$t" ] || cp -a "$f" "$t" || exit 1; done',
        ],
        NetworkDisabled: true,
        HostConfig: {
          AutoRemove: false,
          CapDrop: ["ALL"],
          NetworkMode: "none",
          Privileged: false,
          ReadonlyRootfs: true,
          SecurityOpt: ["no-new-privileges:true"],
          Memory: 256 * 1024 ** 2,
          PidsLimit: 32,
          Mounts: [{ Type: "bind", Source: paths.home, Target: "/home/agent", ReadOnly: false }],
        },
      });
      await container.start();
      const result = (await container.wait()) as { StatusCode?: number };
      if (result.StatusCode !== 0) throw new Error("home initialization failed");
    } catch (error) {
      throw this.#engineError(error, "initialize the Workspace home directory");
    } finally {
      await container?.remove({ force: true }).catch(() => undefined);
    }
    const managed = { ...paths.managed, homeInitialized: true };
    await this.#writeMetadata(paths, managed);
    return { ...paths, managed };
  }

  async #findNamedContainer(workspaceId: string) {
    const name = this.#containerName(workspaceId);
    let containers;
    try {
      containers = await this.#docker.listContainers({
        all: true,
        filters: { name: [`^/${name}$`] },
      });
    } catch (error) {
      throw this.#engineError(error, "inspect Workspace containers");
    }
    const exact = containers.filter((container) =>
      container.Names.includes(`/${name}`),
    );
    if (exact.length === 0) return null;
    const candidate = exact[0];
    if (
      exact.length !== 1 ||
      candidate === undefined ||
      !labelsMatch(
        candidate.Labels,
        managedLabels(this.#workerId, workspaceId),
      )
    ) {
      throw new WorkspaceRuntimeError(
        "UNMANAGED_CONTAINER_CONFLICT",
        "Workspace container name conflicts with an unmanaged Docker container",
      );
    }
    return this.#docker.getContainer(candidate.Id);
  }

  async #requireManagedContainer(workspaceId: string) {
    const container = await this.#findNamedContainer(workspaceId);
    if (container === null) {
      throw new WorkspaceRuntimeError(
        "WORKSPACE_NOT_MANAGED",
        "Workspace container is not managed by this Worker",
      );
    }
    return container;
  }

  async #findNamedNetwork(workspaceId: string) {
    const name = this.#networkName(workspaceId);
    let networks;
    try {
      networks = await this.#docker.listNetworks({ filters: { name: [name] } });
    } catch (error) {
      throw this.#engineError(error, "inspect Workspace networks");
    }
    const exact = networks.filter((network) => network.Name === name);
    if (exact.length === 0) return null;
    const candidate = exact[0];
    if (exact.length !== 1 || candidate === undefined) {
      throw new WorkspaceRuntimeError(
        "UNMANAGED_NETWORK_CONFLICT",
        "Workspace network name is ambiguous",
      );
    }
    return this.#docker.getNetwork(candidate.Id);
  }

  #verifyCurrentRuntimeConfiguration(
    inspection: Docker.ContainerInspectInfo,
    resources: WorkspaceResources,
  ): void {
    const defaultCwdEntries = this.#defaultCwdEntries(inspection);
    if (
      defaultCwdEntries.length !== 1 ||
      defaultCwdEntries[0] !== PI_WEB_DEFAULT_CWD_ENV ||
      inspection.HostConfig.RestartPolicy?.Name !== "unless-stopped"
    ) {
      throw new WorkspaceRuntimeError(
        "RUNTIME_CONFIGURATION_MISMATCH",
        "Managed Workspace default cwd does not match the current Runtime configuration",
      );
    }
    this.#verifyResourceConfiguration(inspection, resources);
    this.#verifyStorageConfiguration(inspection);
  }

  #verifyLegacyRuntimeConfiguration(
    inspection: Docker.ContainerInspectInfo,
    resources: WorkspaceResources,
  ): void {
    this.#verifyLegacyCompatibleDefaultCwd(inspection);
    this.#verifyResourceConfiguration(inspection, resources);
  }

  async #inspectForRecovery(
    assignment: WorkerReconcileAssignment,
  ): Promise<WorkspaceRuntimeObservation> {
    this.#assertRuntimeImage(assignment.runtimeImage);
    const paths = await this.#requireWorkspacePaths(assignment.workspaceId);
    this.#assertRuntimeImage(paths.runtimeImage);
    const container = await this.#requireManagedContainer(assignment.workspaceId);
    const networkName = this.#networkName(assignment.workspaceId);
    const network = await this.#findNamedNetwork(assignment.workspaceId);
    if (network === null) {
      throw new WorkspaceRuntimeError(
        "UNMANAGED_NETWORK_CONFLICT",
        "Managed Workspace network is missing",
      );
    }
    const generation = this.#verifyManagedNetwork(
      await network.inspect(),
      assignment.workspaceId,
      networkName,
    );
    let inspection = await container.inspect();
    const containerGeneration = this.#verifyManagedContainerIdentity(
      inspection,
      assignment.workspaceId,
      paths,
      networkName,
    );
    this.#verifyLegacyRuntimeConfiguration(inspection, this.#workspaceResources);
    if (
      inspection.State.Running &&
      (containerGeneration === "legacy" || !this.#storage.isEnforced())
    ) {
      // Fail closed: a Workspace without enforced disk quotas must not keep running.
      try {
        await container.stop({ t: 15 });
      } catch (error) {
        if (dockerStatus(error) !== 304) {
          throw this.#engineError(error, "stop a Workspace without disk quotas");
        }
      }
      throw containerGeneration === "legacy"
        ? new WorkspaceRuntimeError(
            "STORAGE_MIGRATION_REQUIRED",
            "Workspace was created before disk quotas and was stopped",
          )
        : new WorkspaceRuntimeError(
            "STORAGE_QUOTA_UNENFORCED",
            "Disk quotas are not enforced; the Workspace was stopped",
          );
    }
    await this.#recordRecoveredDiskLimit(paths, assignment.diskLimitBytes);
    if (inspection.State.Running && (generation === "legacy" || !this.#egress.isEnforced())) {
      // Fail closed: a Workspace outside the egress rules must not keep running.
      try {
        await container.stop({ t: 15 });
      } catch (error) {
        if (dockerStatus(error) !== 304) {
          throw this.#engineError(error, "stop a Workspace outside the egress rules");
        }
      }
      throw generation === "legacy"
        ? new WorkspaceRuntimeError(
            "EGRESS_NETWORK_LEGACY",
            "Workspace ran on a network without egress rules and was stopped",
          )
        : new WorkspaceRuntimeError(
            "EGRESS_UNENFORCED",
            "Workspace egress rules are not enforced; the Workspace was stopped",
          );
    }
    if (inspection.State.Restarting || inspection.State.Paused || inspection.State.Dead) {
      throw new WorkspaceRuntimeError(
        "RUNTIME_NOT_READY",
        "Workspace Runtime is not in a stable running or stopped state",
        true,
      );
    }
    if (!inspection.State.Running) {
      return this.#observation(assignment.workspaceId, "STOPPED");
    }

    const deadline = Date.now() + this.#startTimeoutMs;
    while (Date.now() < deadline) {
      inspection = await container.inspect();
      if (!inspection.State.Running) {
        throw new WorkspaceRuntimeError(
          "RUNTIME_START_FAILED",
          "Workspace Runtime exited during recovery inspection",
        );
      }
      const binding = inspection.NetworkSettings.Ports[PI_WEB_PORT]?.[0];
      if (
        binding?.HostIp === "127.0.0.1" &&
        binding.HostPort !== undefined &&
        (await this.#readinessProbe(binding.HostPort))
      ) {
        return this.#observation(assignment.workspaceId, "RUNNING");
      }
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    throw new WorkspaceRuntimeError(
      "RUNTIME_NOT_READY",
      "pi-web did not become ready during recovery inspection",
      true,
    );
  }

  /**
   * Brings a stored limit up to date after an offline period; a failure is left to the
   * next ensure, which applies the Control Plane's limit before any start.
   */
  async #recordRecoveredDiskLimit(
    paths: ManagedWorkspacePaths,
    dataLimitBytes: number,
  ): Promise<void> {
    const quota = paths.managed.quota;
    if (quota === undefined || quota.dataLimitBytes === dataLimitBytes) return;
    if (!this.#storage.isEnforced()) return;
    try {
      await this.#storage.setDataLimit(paths, quota, dataLimitBytes);
      await this.#writeMetadata(paths, { ...paths.managed, quota: { ...quota, dataLimitBytes } });
    } catch {
      // Applied again by the next workspace.ensure.
    }
  }

  /** Returns "legacy" for a managed network created before the `arw-` bridge name. */
  #verifyManagedNetwork(
    inspection: Docker.NetworkInspectInfo,
    workspaceId: string,
    name: string,
  ): NetworkGeneration {
    const bridgeName = inspection.Options?.[BRIDGE_NAME_OPTION];
    if (
      inspection.Name !== name ||
      inspection.Driver !== "bridge" ||
      inspection.Internal ||
      inspection.Attachable ||
      inspection.EnableIPv6 ||
      inspection.Options?.["com.docker.network.bridge.enable_icc"] !== "false" ||
      inspection.Options?.["com.docker.network.bridge.host_binding_ipv4"] !==
        "127.0.0.1" ||
      (bridgeName !== undefined && bridgeName !== workspaceBridgeName(workspaceId)) ||
      !labelsMatch(inspection.Labels, managedLabels(this.#workerId, workspaceId))
    ) {
      throw new WorkspaceRuntimeError(
        "UNMANAGED_NETWORK_CONFLICT",
        "Workspace network conflicts with an unmanaged Docker network",
      );
    }
    return bridgeName === undefined ? "legacy" : "current";
  }

  #resourceWorkspaceId(
    resourceName: string | undefined,
    labelWorkspaceId: string | undefined,
  ): string | null {
    const label = WorkspaceIdSchema.safeParse(labelWorkspaceId);
    if (label.success) return label.data;
    return this.#workspaceIdFromResourceName(resourceName);
  }

  #workspaceIdFromResourceName(
    resourceName: string | undefined,
  ): string | null {
    if (
      resourceName === undefined ||
      !resourceName.startsWith(RESOURCE_NAME_PREFIX)
    ) {
      return null;
    }
    const suffix = WorkspaceIdSchema.safeParse(
      resourceName.slice(RESOURCE_NAME_PREFIX.length),
    );
    return suffix.success ? suffix.data : null;
  }

  #resourceClassification(
    labels: Record<string, string>,
    workspaceId: string | null,
    resourceName: string | undefined,
  ): WorkerRecoveryIssue["classification"] {
    if (
      labels.app === APP_LABEL &&
      labels.managed_by === MANAGED_BY_LABEL &&
      labels.worker_id !== undefined &&
      labels.worker_id !== this.#workerId
    ) {
      return "FOREIGN_MANAGED_RESOURCE";
    }
    if (
      workspaceId !== null &&
      resourceName === `${RESOURCE_NAME_PREFIX}${workspaceId}` &&
      labelsMatch(labels, managedLabels(this.#workerId, workspaceId))
    ) {
      return "MANAGED_ORPHAN";
    }
    return "UNKNOWN_RESOURCE";
  }

  async #directoryClassification(
    workspaceId: string,
  ): Promise<WorkerRecoveryIssue["classification"]> {
    const paths = await this.#paths(workspaceId);
    try {
      const parsed = MetadataSchema.safeParse(
        JSON.parse(await readFile(paths.metadataFile, "utf8")),
      );
      if (!parsed.success || parsed.data.workspaceId !== workspaceId) {
        return "UNKNOWN_RESOURCE";
      }
      return parsed.data.workerId === this.#workerId
        ? "MANAGED_ORPHAN"
        : "FOREIGN_MANAGED_RESOURCE";
    } catch {
      return "UNKNOWN_RESOURCE";
    }
  }

  #verifyResourceConfiguration(
    inspection: Docker.ContainerInspectInfo,
    resources: WorkspaceResources,
  ): void {
    if (
      inspection.HostConfig.Memory !== resources.memoryBytes ||
      inspection.HostConfig.NanoCpus !==
        Math.round(resources.cpuCount * 1_000_000_000) ||
      inspection.HostConfig.PidsLimit !== resources.pidsLimit
    ) {
      throw new WorkspaceRuntimeError(
        "RUNTIME_CONFIGURATION_MISMATCH",
        "Managed Workspace resource limits do not match the requested limits",
      );
    }
  }

  /** The Workspace's bind mounts, in the order they are created. */
  #workspaceMounts(paths: WorkspacePaths): Array<{ source: string; target: string }> {
    return [
      { source: paths.workspace, target: "/workspace" },
      { source: paths.home, target: "/home/agent" },
      { source: paths.tmp, target: "/tmp" },
      { source: paths.pi, target: "/agent/pi" },
    ];
  }

  /**
   * Checks ownership and the security baseline of a managed container and tells a
   * current container from one created before Phase 15 (writable root, two `Binds`),
   * which may still be inspected, stopped or deleted, but not started or served.
   */
  #verifyManagedContainerIdentity(
    inspection: Docker.ContainerInspectInfo,
    workspaceId: string,
    paths: WorkspacePaths,
    networkName: string,
  ): ContainerGeneration {
    const portBinding = inspection.HostConfig.PortBindings?.[PI_WEB_PORT]?.[0];
    if (
      inspection.Name !== `/${this.#containerName(workspaceId)}` ||
      inspection.Config.Image !== (paths as Partial<ManagedWorkspacePaths>).runtimeImage ||
      inspection.Config.User !== this.#runtimeUser ||
      inspection.Config.WorkingDir !== "/workspace" ||
      !inspection.Config.Env.includes("PI_CODING_AGENT_DIR=/agent/pi") ||
      inspection.HostConfig.Privileged ||
      inspection.HostConfig.NetworkMode !== networkName ||
      !inspection.HostConfig.CapDrop?.includes("ALL") ||
      !inspection.HostConfig.SecurityOpt?.includes("no-new-privileges:true") ||
      portBinding?.HostIp !== "127.0.0.1" ||
      portBinding.HostPort !== "" ||
      !labelsMatch(
        inspection.Config.Labels,
        managedLabels(this.#workerId, workspaceId),
      )
    ) {
      throw new WorkspaceRuntimeError(
        "RUNTIME_CONFIGURATION_MISMATCH",
        "Managed Workspace container does not match the security baseline",
      );
    }
    const mounts = new Map(inspection.Mounts.map((mount) => [mount.Destination, mount]));
    const matches = (expected: Array<{ source: string; target: string }>) =>
      inspection.Mounts.length === expected.length &&
      expected.every(({ source, target }) => {
        const mount = mounts.get(target);
        return mount?.Type === "bind" && mount.Source === source && mount.RW === true;
      });
    const current = this.#workspaceMounts(paths);
    if (
      matches(current) &&
      inspection.HostConfig.ReadonlyRootfs === true &&
      (inspection.HostConfig.Binds ?? []).length === 0
    ) {
      return "current";
    }
    const legacy = current.filter(
      (mount) => mount.target === "/workspace" || mount.target === "/agent/pi",
    );
    if (matches(legacy) && inspection.HostConfig.ReadonlyRootfs !== true) {
      return "legacy";
    }
    throw new WorkspaceRuntimeError(
      "RUNTIME_CONFIGURATION_MISMATCH",
      "Managed Workspace container does not match the security baseline",
    );
  }

  #assertCurrentGeneration(generation: ContainerGeneration): void {
    if (generation === "legacy") {
      throw new WorkspaceRuntimeError(
        "STORAGE_MIGRATION_REQUIRED",
        "Workspace was created before disk quotas; an administrator must migrate it",
      );
    }
  }

  /** Read-only root, tmpfs, ulimits and log limits of a current container (Phase 15.4/15.5). */
  #verifyStorageConfiguration(inspection: Docker.ContainerInspectInfo): void {
    const ulimits = new Map(
      (inspection.HostConfig.Ulimits ?? []).map((limit) => [limit.Name, limit]),
    );
    const tmpfs = inspection.HostConfig.Tmpfs ?? {};
    const log = inspection.HostConfig.LogConfig;
    if (
      inspection.HostConfig.ReadonlyRootfs !== true ||
      Object.keys(tmpfs).length !== Object.keys(WORKSPACE_TMPFS).length ||
      Object.entries(WORKSPACE_TMPFS).some(([path, options]) => tmpfs[path] !== options) ||
      ulimits.size !== 2 ||
      ulimits.get("nofile")?.Soft !== this.#nofileLimit ||
      ulimits.get("nofile")?.Hard !== this.#nofileLimit ||
      ulimits.get("core")?.Soft !== 0 ||
      ulimits.get("core")?.Hard !== 0 ||
      log?.Type !== WORKSPACE_LOG_CONFIG.Type ||
      log.Config?.["max-size"] !== WORKSPACE_LOG_CONFIG.Config["max-size"] ||
      log.Config["max-file"] !== WORKSPACE_LOG_CONFIG.Config["max-file"] ||
      !inspection.Config.Env.includes(CARGO_HOME_ENV)
    ) {
      throw new WorkspaceRuntimeError(
        "RUNTIME_CONFIGURATION_MISMATCH",
        "Managed Workspace storage limits do not match the current Runtime configuration",
      );
    }
  }

  #verifyLegacyCompatibleDefaultCwd(
    inspection: Docker.ContainerInspectInfo,
  ): void {
    const defaultCwdEntries = this.#defaultCwdEntries(inspection);
    if (
      defaultCwdEntries.length > 1 ||
      (defaultCwdEntries.length === 1 &&
        defaultCwdEntries[0] !== PI_WEB_DEFAULT_CWD_ENV)
    ) {
      throw new WorkspaceRuntimeError(
        "RUNTIME_CONFIGURATION_MISMATCH",
        "Managed Workspace default cwd is neither the legacy nor current Runtime configuration",
      );
    }
  }

  #defaultCwdEntries(inspection: Docker.ContainerInspectInfo): string[] {
    return inspection.Config.Env.filter((entry) =>
      entry.startsWith("PI_WEB_DEFAULT_CWD="),
    );
  }

  #assertRuntimeImage(runtimeImage: string): void {
    if (runtimeImage !== this.#runtimeImage) {
      throw new WorkspaceRuntimeError(
        "RUNTIME_CONFIGURATION_MISMATCH",
        "Requested Runtime image does not match the Worker pin",
      );
    }
  }

  #assertResources(resources: WorkspaceResources): void {
    if (
      resources.cpuCount !== this.#workspaceResources.cpuCount ||
      resources.memoryBytes !== this.#workspaceResources.memoryBytes ||
      resources.pidsLimit !== this.#workspaceResources.pidsLimit
    ) {
      throw new WorkspaceRuntimeError(
        "RUNTIME_CONFIGURATION_MISMATCH",
        "Requested resource limits do not match this Worker policy",
      );
    }
  }

  #containerName(workspaceId: string): string {
    return `agent-runtime-${workspaceId}`;
  }

  #networkName(workspaceId: string): string {
    return `agent-runtime-${workspaceId}`;
  }

  #observation(
    workspaceId: string,
    state: WorkspaceState,
    runtimeImage = this.#runtimeImage,
  ): WorkspaceRuntimeObservation {
    return {
      workspaceId,
      state,
      runtimeImage,
      observedAt: new Date().toISOString(),
    };
  }

  #engineError(error: unknown, operation: string): WorkspaceRuntimeError {
    if (error instanceof WorkspaceRuntimeError) return error;
    const status = dockerStatus(error);
    return new WorkspaceRuntimeError(
      "RUNTIME_ENGINE_ERROR",
      `Docker Engine could not ${operation}`,
      status === undefined || status >= 500,
    );
  }
}
