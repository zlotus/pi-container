import { constants } from "node:fs";
import {
  access,
  chown,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  WorkspaceIdSchema,
  type WorkspaceResources,
  type WorkspaceState,
} from "@agent-runtime/protocol";
import { parseWorkspaceBaseUrl } from "@agent-runtime/gateway";
import Docker from "dockerode";
import { z } from "zod";

import type { WorkerConfig } from "./config.js";

const APP_LABEL = "agent-runtime-platform";
const MANAGED_BY_LABEL = "worker";
const PI_WEB_PORT = "30141/tcp";
const PI_WEB_DEFAULT_CWD_ENV = "PI_WEB_DEFAULT_CWD=/workspace";

const MetadataSchema = z
  .object({
    version: z.literal(1),
    workspaceId: WorkspaceIdSchema,
    workerId: z.string(),
    runtimeImage: z.string(),
  })
  .strict();

interface WorkspacePaths {
  root: string;
  workspace: string;
  pi: string;
  metadata: string;
  metadataFile: string;
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
      | "RUNTIME_ENGINE_ERROR",
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
  ) {
    this.#docker = docker;
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
  ): Promise<WorkspaceRuntimeObservation> {
    this.#assertRuntimeImage(runtimeImage);
    this.#assertResources(resources);
    const paths = await this.#ensureWorkspacePaths(workspaceId);
    const networkName = this.#networkName(workspaceId);
    await this.#ensureNetwork(workspaceId, networkName);
    const existing = await this.#findNamedContainer(workspaceId);
    const created = existing === null;
    if (existing === null) {
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
          ],
          ExposedPorts: { [PI_WEB_PORT]: {} },
          Labels: managedLabels(this.#workerId, workspaceId),
          HostConfig: {
            AutoRemove: false,
            Binds: [
              `${paths.workspace}:/workspace:rw`,
              `${paths.pi}:/agent/pi:rw`,
            ],
            CapDrop: ["ALL"],
            Memory: resources.memoryBytes,
            NanoCpus: Math.round(resources.cpuCount * 1_000_000_000),
            NetworkMode: networkName,
            PidsLimit: resources.pidsLimit,
            PortBindings: {
              [PI_WEB_PORT]: [{ HostIp: "127.0.0.1", HostPort: "" }],
            },
            Privileged: false,
            SecurityOpt: ["no-new-privileges:true"],
          },
        });
      } catch (error) {
        throw this.#engineError(error, "create the managed Workspace container");
      }
    }

    const container = await this.#requireManagedContainer(workspaceId);
    const inspection = await container.inspect();
    this.#verifyManagedContainerIdentity(
      inspection,
      workspaceId,
      paths,
      networkName,
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
    const container = await this.#requireManagedContainer(workspaceId);
    let inspection = await container.inspect();
    this.#verifyManagedContainerIdentity(
      inspection,
      workspaceId,
      paths,
      this.#networkName(workspaceId),
    );
    this.#verifyLegacyCompatibleDefaultCwd(inspection);
    if (!inspection.State.Running) {
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
    await this.#requireWorkspacePaths(workspaceId);
    const container = await this.#requireManagedContainer(workspaceId);
    const inspection = await container.inspect();
    this.#verifyManagedContainerIdentity(
      inspection,
      workspaceId,
      await this.#paths(workspaceId),
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
    return this.#observation(workspaceId, "STOPPED");
  }

  async inspect(workspaceId: string): Promise<WorkspaceRuntimeObservation> {
    const paths = await this.#requireWorkspacePaths(workspaceId);
    const container = await this.#findNamedContainer(workspaceId);
    if (container === null) return this.#observation(workspaceId, "CREATED");
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
      try {
        await container.remove({ force: true, v: false });
      } catch (error) {
        if (dockerStatus(error) !== 404) {
          throw this.#engineError(error, "delete the managed Workspace container");
        }
      }
    }

    const network = await this.#findNamedNetwork(workspaceId);
    if (network !== null) {
      const inspection = await network.inspect();
      if (
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
      try {
        await network.remove();
      } catch (error) {
        if (dockerStatus(error) !== 404) {
          throw this.#engineError(error, "delete the managed Workspace network");
        }
      }
    }

    await rm(paths.root, { recursive: true, force: false });
    return this.#observation(workspaceId, "CREATED");
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

  async gatewayTarget(workspaceId: string): Promise<URL> {
    const paths = await this.#requireWorkspacePaths(workspaceId);
    const container = await this.#requireManagedContainer(workspaceId);
    const inspection = await container.inspect();
    this.#verifyManagedContainerIdentity(
      inspection,
      workspaceId,
      paths,
      this.#networkName(workspaceId),
    );
    this.#verifyLegacyCompatibleDefaultCwd(inspection);
    if (!inspection.State.Running) {
      throw new WorkspaceRuntimeError(
        "RUNTIME_NOT_READY",
        "Workspace Runtime is not running",
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
      pi: join(root, "pi"),
      metadata,
      metadataFile: join(metadata, "managed.json"),
    };
  }

  async #ensureWorkspacePaths(workspaceId: string): Promise<WorkspacePaths> {
    const paths = await this.#paths(workspaceId);
    let created = false;
    try {
      await mkdir(paths.root, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }

    if (!created) {
      await this.#verifyMetadata(paths, workspaceId);
    }
    await mkdir(paths.workspace, { recursive: true, mode: 0o700 });
    await mkdir(paths.pi, { recursive: true, mode: 0o700 });
    await mkdir(paths.metadata, { recursive: true, mode: 0o700 });
    try {
      await chown(paths.workspace, this.#runtimeUid, this.#runtimeGid);
      await chown(paths.pi, this.#runtimeUid, this.#runtimeGid);
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
    await this.#assertRealDirectories(paths);
    return paths;
  }

  async #requireWorkspacePaths(workspaceId: string): Promise<WorkspacePaths> {
    const paths = await this.#paths(workspaceId);
    try {
      await access(paths.metadataFile, constants.R_OK);
    } catch {
      throw new WorkspaceRuntimeError(
        "WORKSPACE_NOT_MANAGED",
        "Workspace is not managed by this Worker",
      );
    }
    await this.#verifyMetadata(paths, workspaceId);
    await this.#assertRealDirectories(paths);
    return paths;
  }

  async #verifyMetadata(paths: WorkspacePaths, workspaceId: string): Promise<void> {
    let decoded: unknown;
    try {
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
      metadata.data.workerId !== this.#workerId ||
      metadata.data.runtimeImage !== this.#runtimeImage
    ) {
      throw new WorkspaceRuntimeError(
        "WORKSPACE_METADATA_MISMATCH",
        "Workspace metadata does not match this Worker assignment",
      );
    }
  }

  async #assertRealDirectories(paths: WorkspacePaths): Promise<void> {
    for (const path of [paths.root, paths.workspace, paths.pi, paths.metadata]) {
      const stat = await lstat(path);
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

  async #ensureNetwork(workspaceId: string, name: string): Promise<void> {
    const existing = await this.#findNamedNetwork(workspaceId);
    if (existing !== null) {
      const inspection = await existing.inspect();
      if (
        inspection.Name !== name ||
        inspection.Driver !== "bridge" ||
        inspection.Internal ||
        inspection.Attachable ||
        inspection.Options?.["com.docker.network.bridge.enable_icc"] !== "false" ||
        inspection.Options?.[
          "com.docker.network.bridge.host_binding_ipv4"
        ] !== "127.0.0.1" ||
        !labelsMatch(inspection.Labels, managedLabels(this.#workerId, workspaceId))
      ) {
        throw new WorkspaceRuntimeError(
          "UNMANAGED_NETWORK_CONFLICT",
          "Workspace network conflicts with an unmanaged Docker network",
        );
      }
      return;
    }
    try {
      await this.#docker.createNetwork({
        Name: name,
        CheckDuplicate: true,
        Driver: "bridge",
        Internal: false,
        Attachable: false,
        Labels: managedLabels(this.#workerId, workspaceId),
        Options: {
          "com.docker.network.bridge.enable_icc": "false",
          "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1",
        },
      });
    } catch (error) {
      throw this.#engineError(error, "create the isolated Workspace network");
    }
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
      defaultCwdEntries[0] !== PI_WEB_DEFAULT_CWD_ENV
    ) {
      throw new WorkspaceRuntimeError(
        "RUNTIME_CONFIGURATION_MISMATCH",
        "Managed Workspace default cwd does not match the current Runtime configuration",
      );
    }
    this.#verifyResourceConfiguration(inspection, resources);
  }

  #verifyLegacyRuntimeConfiguration(
    inspection: Docker.ContainerInspectInfo,
    resources: WorkspaceResources,
  ): void {
    this.#verifyLegacyCompatibleDefaultCwd(inspection);
    this.#verifyResourceConfiguration(inspection, resources);
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

  #verifyManagedContainerIdentity(
    inspection: Docker.ContainerInspectInfo,
    workspaceId: string,
    paths: WorkspacePaths,
    networkName: string,
  ): void {
    const mounts = new Map(
      inspection.Mounts.map((mount) => [mount.Destination, mount]),
    );
    const portBinding = inspection.HostConfig.PortBindings?.[PI_WEB_PORT]?.[0];
    if (
      inspection.Name !== `/${this.#containerName(workspaceId)}` ||
      inspection.Config.Image !== this.#runtimeImage ||
      inspection.Config.User !== this.#runtimeUser ||
      inspection.Config.WorkingDir !== "/workspace" ||
      !inspection.Config.Env.includes("PI_CODING_AGENT_DIR=/agent/pi") ||
      inspection.Mounts.length !== 2 ||
      inspection.HostConfig.Privileged ||
      inspection.HostConfig.NetworkMode !== networkName ||
      !inspection.HostConfig.CapDrop?.includes("ALL") ||
      !inspection.HostConfig.SecurityOpt?.includes("no-new-privileges:true") ||
      portBinding?.HostIp !== "127.0.0.1" ||
      portBinding.HostPort !== "" ||
      !labelsMatch(
        inspection.Config.Labels,
        managedLabels(this.#workerId, workspaceId),
      ) ||
      mounts.get("/workspace")?.Type !== "bind" ||
      mounts.get("/workspace")?.Source !== paths.workspace ||
      mounts.get("/workspace")?.RW !== true ||
      mounts.get("/agent/pi")?.Type !== "bind" ||
      mounts.get("/agent/pi")?.Source !== paths.pi ||
      mounts.get("/agent/pi")?.RW !== true
    ) {
      throw new WorkspaceRuntimeError(
        "RUNTIME_CONFIGURATION_MISMATCH",
        "Managed Workspace container does not match the security baseline",
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
  ): WorkspaceRuntimeObservation {
    return {
      workspaceId,
      state,
      runtimeImage: this.#runtimeImage,
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
