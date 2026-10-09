import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type Docker from "dockerode";
import { afterEach, describe, expect, it } from "vitest";

import { loadWorkerConfig } from "./config.js";
import { DockerWorkspaceRuntime, type EgressGate, type StorageGate } from "./runtime.js";
import type { WorkspaceRuntimeError } from "./runtime.js";
import {
  type ProjectUsage,
  StorageQuotaError,
  type WorkspaceQuota,
  type WorkspaceQuotaDirectories,
} from "./storage/controller.js";

const WORKSPACE_ID = "90b38efc-aa9a-4bc6-8eee-528b4e0c7c60";
const RESOURCES = {
  cpuCount: 2,
  memoryBytes: 4 * 1024 ** 3,
  pidsLimit: 512,
};
const GIB = 1024 ** 3;
const STORAGE = { diskLimitBytes: 20 * GIB };

interface FakeContainerInspection {
  Name: string;
  State: { Running: boolean };
  Config: {
    Image: string;
    User: string;
    Labels: Record<string, string>;
    WorkingDir: string;
    Env: string[];
  };
  HostConfig: Docker.HostConfig;
  Mounts: Array<{
    Type: "bind";
    Source: string;
    Destination: string;
    RW: boolean;
  }>;
  /** Exit status a helper container reports from `wait()`. */
  ExitCode?: number;
  NetworkSettings: {
    Ports: Record<string, Array<{ HostIp: string; HostPort: string }>>;
    Networks: Record<string, { NetworkID: string }>;
  };
}

class FakeDocker {
  readonly containers = new Map<string, FakeContainer>();
  readonly networks = new Map<string, FakeNetwork>();
  createdOptions: Docker.ContainerCreateOptions | null = null;
  readonly allCreated: Docker.ContainerCreateOptions[] = [];
  helperExitCode = 0;
  omitDefaultCwdOnCreate = false;
  hostPort = "1";
  networkSequence = 0;
  containerSequence = 0;

  async createContainer(options: Docker.ContainerCreateOptions) {
    this.allCreated.push(options);
    const name = options.name ?? "";
    const helper = name.startsWith("agent-runtime-home-init-");
    if (!helper) this.createdOptions = options;
    const binds = options.HostConfig?.Binds ?? [];
    this.containerSequence += 1;
    const container = new FakeContainer(
      `container-${this.containerSequence}`,
      {
        Name: `/${name}`,
        State: { Running: false },
        Config: {
          Image: options.Image ?? "",
          User: options.User ?? "",
          Labels: options.Labels ?? {},
          WorkingDir: options.WorkingDir ?? "",
          Env: this.omitDefaultCwdOnCreate
            ? (options.Env ?? []).filter(
                (entry) => entry !== "PI_WEB_DEFAULT_CWD=/workspace",
              )
            : (options.Env ?? []),
        },
        HostConfig: options.HostConfig ?? {},
        Mounts: [
          ...binds.map((bind) => {
            const [source, destination] = bind.split(":");
            return {
              Type: "bind" as const,
              Source: source ?? "",
              Destination: destination ?? "",
              RW: true,
            };
          }),
          ...(options.HostConfig?.Mounts ?? []).map((mount) => ({
            Type: "bind" as const,
            Source: mount.Source,
            Destination: mount.Target,
            RW: mount.ReadOnly !== true,
          })),
        ],
        ExitCode: helper ? this.helperExitCode : 0,
        NetworkSettings: {
          Ports: {},
          Networks: (() => {
            const network = this.networks.get(String(options.HostConfig?.NetworkMode));
            return network === undefined ? {} : { [network.name]: { NetworkID: network.id } };
          })(),
        },
      },
      this,
    );
    this.containers.set(name, container);
    return container;
  }

  async listContainers(options?: { filters?: { status?: string[] } }) {
    return [...this.containers.entries()]
      .filter(
        ([, container]) =>
          options?.filters?.status === undefined || container.inspection.State.Running,
      )
      .map(([name, container]) => ({
        Id: container.id,
        Names: [`/${name}`],
        Labels: container.inspection.Config.Labels,
        NetworkSettings: {
          Networks: Object.fromEntries(
            Object.keys(container.inspection.NetworkSettings.Networks).map((network) => [
              network,
              { IPAddress: "172.22.0.2", Gateway: "172.22.0.1" },
            ]),
          ),
        },
      }));
  }

  getContainer(id: string) {
    const container = [...this.containers.values()].find(
      (candidate) => candidate.id === id,
    );
    if (container === undefined) throw new Error("container fixture missing");
    return container;
  }

  async createNetwork(options: Docker.NetworkCreateOptions) {
    this.networkSequence += 1;
    const network = new FakeNetwork(
      `network-${this.networkSequence}`,
      options.Name,
      options.Labels ?? {},
      options.Options ?? {},
      this,
    );
    this.networks.set(options.Name, network);
    return network;
  }

  async listNetworks() {
    return [...this.networks.values()].map((network) => ({
      Id: network.id,
      Name: network.name,
      Labels: network.labels,
    }));
  }

  getNetwork(id: string) {
    const network = [...this.networks.values()].find(
      (candidate) => candidate.id === id,
    );
    if (network === undefined) throw new Error("network fixture missing");
    return network;
  }
}

class FakeContainer {
  constructor(
    readonly id: string,
    readonly inspection: FakeContainerInspection,
    readonly docker: FakeDocker,
  ) {}

  async inspect() {
    return { Id: this.id, ...this.inspection } as unknown as Docker.ContainerInspectInfo;
  }

  async start() {
    this.inspection.State.Running = true;
    this.inspection.NetworkSettings.Ports["30141/tcp"] = [
      { HostIp: "127.0.0.1", HostPort: this.docker.hostPort },
    ];
  }

  async stop() {
    this.inspection.State.Running = false;
  }

  async wait() {
    this.inspection.State.Running = false;
    return { StatusCode: this.inspection.ExitCode ?? 0 };
  }

  async remove() {
    const entry = [...this.docker.containers.entries()].find(
      ([, candidate]) => candidate === this,
    );
    if (entry !== undefined) this.docker.containers.delete(entry[0]);
  }
}

class FakeNetwork {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly labels: Record<string, string>,
    readonly options: Record<string, string>,
    readonly docker: FakeDocker,
  ) {}

  async inspect() {
    return {
      Id: this.id,
      Name: this.name,
      Driver: "bridge",
      Internal: false,
      Attachable: false,
      Labels: this.labels,
      Options: this.options,
      IPAM: { Config: [{ Subnet: "172.22.0.0/16", Gateway: "172.22.0.1" }] },
    } as Docker.NetworkInspectInfo;
  }

  async remove() {
    this.docker.networks.delete(this.name);
  }

  async disconnect(options: { Container: string }) {
    const container = this.docker.getContainer(options.Container);
    const networks = container.inspection.NetworkSettings.Networks;
    container.inspection.NetworkSettings.Networks = Object.fromEntries(
      Object.entries(networks).filter(([name]) => name !== this.name),
    );
  }

  async connect(options: { Container: string }) {
    const container = this.docker.getContainer(options.Container);
    container.inspection.NetworkSettings.Networks[this.name] = { NetworkID: this.id };
  }
}

class FakeEgress implements EgressGate {
  enforced = true;
  ensureCalls = 0;

  isEnforced(): boolean {
    return this.enforced;
  }

  async ensure(): Promise<{ enforced: boolean }> {
    this.ensureCalls += 1;
    return { enforced: this.enforced };
  }
}

class FakeStorage implements StorageGate {
  readonly policy = {
    projectIdMin: 1_000_000,
    dataInodeLimit: 2_000_000,
    piLimitBytes: 2 * GIB,
    piInodeLimit: 200_000,
  };
  enforced = true;
  failApply = false;
  readonly prepared: Array<{
    directories: WorkspaceQuotaDirectories;
    quota: WorkspaceQuota;
    dataLimitBytes: number;
  }> = [];
  readonly released: WorkspaceQuota[] = [];

  isEnforced(): boolean {
    return this.enforced;
  }

  status() {
    return { enforced: this.enforced, fsType: "xfs", totalBytes: 100 * GIB, freeBytes: 50 * GIB };
  }

  async prepareWorkspace(
    directories: WorkspaceQuotaDirectories,
    quota: WorkspaceQuota,
    dataLimitBytes: number,
  ): Promise<void> {
    if (!this.enforced) {
      throw new StorageQuotaError("STORAGE_QUOTA_UNENFORCED", "not enforced");
    }
    if (this.failApply) {
      throw new StorageQuotaError("STORAGE_QUOTA_APPLY_FAILED", "apply failed", true);
    }
    this.prepared.push({ directories, quota, dataLimitBytes });
  }

  async setDataLimit(
    directories: WorkspaceQuotaDirectories,
    quota: WorkspaceQuota,
    dataLimitBytes: number,
  ): Promise<ProjectUsage> {
    await this.prepareWorkspace(directories, quota, dataLimitBytes);
    return { usedBytes: GIB, limitBytes: dataLimitBytes, usedInodes: 10, limitInodes: 2_000_000 };
  }

  async releaseWorkspace(quota: WorkspaceQuota): Promise<void> {
    this.released.push(quota);
  }

  async usage(directory: string): Promise<ProjectUsage> {
    const pi = directory.endsWith("/pi");
    return {
      usedBytes: pi ? 1024 : 3 * GIB,
      limitBytes: pi ? 2 * GIB : 20 * GIB,
      usedInodes: 42,
      limitInodes: 2_000_000,
    };
  }
}

/** Turns a current container into the pre-Phase-15 shape: writable root, two binds. */
function makeLegacyContainer(container: FakeContainer | undefined): void {
  if (container === undefined) throw new Error("container fixture missing");
  container.inspection.Mounts = container.inspection.Mounts.filter(
    (mount) => mount.Destination === "/workspace" || mount.Destination === "/agent/pi",
  );
  container.inspection.HostConfig = {
    ...container.inspection.HostConfig,
    ReadonlyRootfs: false,
    Mounts: [],
    Binds: container.inspection.Mounts.map((mount) => `${mount.Source}:${mount.Destination}:rw`),
  };
}

const temporaryRoots: string[] = [];

// The fake-Docker tests exercise real chown calls on a temporary root. A non-root test
// process can only chown to itself, so use its own IDs; root (UID 0 is not a valid
// Workspace UID) keeps the production default.
const TEST_UID = process.getuid?.() || 1_000;
const TEST_GID = process.getgid?.() || 1_000;
const TEST_USER = `${TEST_UID}:${TEST_GID}`;

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-worker-"));
  temporaryRoots.push(root);
  const config = loadWorkerConfig({
    CONTROL_PLANE_URL: "wss://control.internal/api/workers/connect",
    WORKER_ID: "worker-01",
    WORKER_TOKEN: "0123456789abcdef0123456789abcdef",
    WORKER_GATEWAY_TOKEN: "gateway0123456789abcdef0123456789abcdef",
    WORKSPACE_BASE_URL: "https://agent.example.internal",
    WORKER_MAX_WORKSPACES: "8",
    WORKER_MANAGED_ROOT: root,
    WORKSPACE_UID: String(TEST_UID),
    WORKSPACE_GID: String(TEST_GID),
  });
  const docker = new FakeDocker();
  const egress = new FakeEgress();
  const storage = new FakeStorage();
  const runtime = new DockerWorkspaceRuntime(
    config,
    docker as unknown as Docker,
    async () => true,
    egress,
    storage,
  );
  return { root, config, docker, runtime, egress, storage };
}

describe("Docker Workspace Runtime", () => {
  it("creates one constrained container and preserves both persistent mounts", async () => {
    const { root, config, docker, runtime } = await fixture();
    docker.hostPort = "30199";

    const first = await runtime.ensure(
      WORKSPACE_ID,
      config.RUNTIME_IMAGE,
      RESOURCES, STORAGE,
    );
    const second = await runtime.ensure(
      WORKSPACE_ID,
      config.RUNTIME_IMAGE,
      RESOURCES, STORAGE,
    );
    expect(first.state).toBe("STOPPED");
    expect(second.state).toBe("STOPPED");
    expect(docker.containers.size).toBe(1);
    expect(docker.networks.size).toBe(1);
    expect(docker.createdOptions).toMatchObject({
      User: TEST_USER,
      WorkingDir: "/workspace",
      HostConfig: {
        Privileged: false,
        NetworkMode: `agent-runtime-${WORKSPACE_ID}`,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Memory: RESOURCES.memoryBytes,
        NanoCpus: 2_000_000_000,
        PidsLimit: RESOURCES.pidsLimit,
        RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
        PortBindings: {
          "30141/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
        },
      },
    });
    expect(docker.createdOptions?.Env).toContain(
      `PI_WEB_ALLOWED_HOSTS=${WORKSPACE_ID}.agent.example.internal`,
    );
    expect(docker.createdOptions?.Env).toContain(
      "PI_WEB_DEFAULT_CWD=/workspace",
    );
    const serializedRuntimeConfiguration = JSON.stringify(docker.createdOptions);
    expect(serializedRuntimeConfiguration).not.toContain("AUTH_OIDC_");
    expect(serializedRuntimeConfiguration).not.toContain("access_token");
    expect(serializedRuntimeConfiguration).not.toContain("refresh_token");
    expect(serializedRuntimeConfiguration).not.toContain("id_token");
    expect(serializedRuntimeConfiguration).not.toContain("client_secret");
    const managedMetadata = await readFile(
      join(root, "workspaces", WORKSPACE_ID, "metadata", "managed.json"),
      "utf8",
    );
    expect(managedMetadata).not.toContain("AUTH_OIDC_");
    expect(managedMetadata).not.toContain("access_token");
    expect(managedMetadata).not.toContain("refresh_token");
    expect(managedMetadata).not.toContain("id_token");
    expect(managedMetadata).not.toContain("client_secret");
    const workspaceFile = join(
      root,
      "workspaces",
      WORKSPACE_ID,
      "workspace",
      "artifact.txt",
    );
    const sessionFile = join(
      root,
      "workspaces",
      WORKSPACE_ID,
      "pi",
      "session.jsonl",
    );
    await writeFile(workspaceFile, "artifact", "utf8");
    await writeFile(sessionFile, "session", "utf8");

    expect((await runtime.start(WORKSPACE_ID)).state).toBe("RUNNING");
    await expect(runtime.gatewayTarget(WORKSPACE_ID)).resolves.toEqual(
      new URL("http://127.0.0.1:30199"),
    );
    expect((await runtime.stop(WORKSPACE_ID)).state).toBe("STOPPED");
    await expect(runtime.gatewayTarget(WORKSPACE_ID)).rejects.toMatchObject<
      Partial<WorkspaceRuntimeError>
    >({ code: "RUNTIME_NOT_READY" });
    expect((await runtime.start(WORKSPACE_ID)).state).toBe("RUNNING");
    expect(existsSync(workspaceFile)).toBe(true);
    expect(existsSync(sessionFile)).toBe(true);

    await runtime.delete(WORKSPACE_ID);
    expect(existsSync(join(root, "workspaces", WORKSPACE_ID))).toBe(false);
    expect(docker.containers.size).toBe(0);
    expect(docker.networks.size).toBe(0);
  });

  it("refuses a same-name container without the exact managed labels", async () => {
    const { config, docker, runtime } = await fixture();
    const name = `agent-runtime-${WORKSPACE_ID}`;
    docker.containers.set(
      name,
      new FakeContainer(
        "unmanaged",
        {
          Name: `/${name}`,
          State: { Running: false },
          Config: {
            Image: config.RUNTIME_IMAGE,
            User: TEST_USER,
            Labels: {},
            WorkingDir: "/workspace",
            Env: ["PI_CODING_AGENT_DIR=/agent/pi"],
          },
          HostConfig: {},
          Mounts: [],
          NetworkSettings: { Ports: {}, Networks: {} },
        },
        docker,
      ),
    );

    await expect(
      runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE),
    ).rejects.toMatchObject<Partial<WorkspaceRuntimeError>>({
      code: "UNMANAGED_CONTAINER_CONFLICT",
    });
    await expect(runtime.reconcile([])).resolves.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          classification: "UNKNOWN_RESOURCE",
          resource: "CONTAINER",
          workspaceId: WORKSPACE_ID,
        }),
      ]),
    });
    await expect(
      runtime.reconcile([
        {
          workspaceId: WORKSPACE_ID,
          runtimeImage: config.RUNTIME_IMAGE,
          desiredState: "DELETED",
          diskLimitBytes: STORAGE.diskLimitBytes,
        },
      ]),
    ).resolves.toMatchObject({
      workspaces: [
        {
          status: "INVALID",
          workspaceId: WORKSPACE_ID,
          code: "UNMANAGED_CONTAINER_CONFLICT",
          retryable: false,
        },
      ],
    });
    expect(docker.containers.get(name)?.id).toBe("unmanaged");
  });

  it("keeps a pre-default-cwd managed container inspectable, stoppable, startable, and deletable", async () => {
    const { root, config, docker, runtime } = await fixture();
    docker.hostPort = "30200";
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);

    const name = `agent-runtime-${WORKSPACE_ID}`;
    const legacyContainer = docker.containers.get(name);
    if (legacyContainer === undefined) throw new Error("container fixture missing");
    legacyContainer.inspection.Config.Env =
      legacyContainer.inspection.Config.Env.filter(
        (entry) => entry !== "PI_WEB_DEFAULT_CWD=/workspace",
      );

    const workspaceRoot = join(root, "workspaces", WORKSPACE_ID);
    const workspaceFile = join(workspaceRoot, "workspace", "legacy.txt");
    await writeFile(workspaceFile, "legacy", "utf8");

    await expect(
      runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE),
    ).resolves.toMatchObject({ state: "STOPPED" });
    await expect(runtime.start(WORKSPACE_ID)).resolves.toMatchObject({
      state: "RUNNING",
    });
    await expect(runtime.gatewayTarget(WORKSPACE_ID)).resolves.toEqual(
      new URL("http://127.0.0.1:30200"),
    );
    await expect(runtime.inspect(WORKSPACE_ID)).resolves.toMatchObject({
      state: "RUNNING",
    });
    await expect(runtime.stop(WORKSPACE_ID)).resolves.toMatchObject({
      state: "STOPPED",
    });
    expect(existsSync(workspaceFile)).toBe(true);

    await expect(runtime.delete(WORKSPACE_ID)).resolves.toMatchObject({
      state: "CREATED",
    });
    expect(docker.containers.has(name)).toBe(false);
    expect(docker.networks.has(name)).toBe(false);
    expect(existsSync(workspaceRoot)).toBe(false);
  });

  it("safely stops and deletes a Workspace whose recorded image predates the Worker image upgrade", async () => {
    const { root, config, docker, runtime, egress, storage } = await fixture();
    const historicalImage = "agent-runtime:phase4-legacy";
    const legacyRuntime = new DockerWorkspaceRuntime(
      { ...config, RUNTIME_IMAGE: historicalImage },
      docker as unknown as Docker,
      async () => true,
      egress,
      storage,
    );
    await legacyRuntime.ensure(WORKSPACE_ID, historicalImage, RESOURCES, STORAGE);
    await legacyRuntime.start(WORKSPACE_ID);

    const workspaceRoot = join(root, "workspaces", WORKSPACE_ID);
    const metadataPath = join(workspaceRoot, "metadata", "managed.json");
    const originalMetadata = await readFile(metadataPath, "utf8");
    const persistentFile = join(workspaceRoot, "workspace", "legacy.txt");
    await writeFile(persistentFile, "legacy data", "utf8");
    expect(JSON.parse(originalMetadata)).toMatchObject({
      workspaceId: WORKSPACE_ID,
      workerId: config.WORKER_ID,
      runtimeImage: historicalImage,
    });

    await expect(runtime.inspect(WORKSPACE_ID)).resolves.toMatchObject({
      state: "RUNNING",
      runtimeImage: historicalImage,
    });
    await expect(runtime.stop(WORKSPACE_ID)).resolves.toMatchObject({
      state: "STOPPED",
      runtimeImage: historicalImage,
    });
    await expect(runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE))
      .rejects.toMatchObject<Partial<WorkspaceRuntimeError>>({
        code: "RUNTIME_CONFIGURATION_MISMATCH",
      });
    await expect(runtime.start(WORKSPACE_ID)).rejects.toMatchObject<
      Partial<WorkspaceRuntimeError>
    >({ code: "RUNTIME_CONFIGURATION_MISMATCH" });
    await expect(runtime.gatewayTarget(WORKSPACE_ID)).rejects.toMatchObject<
      Partial<WorkspaceRuntimeError>
    >({ code: "RUNTIME_CONFIGURATION_MISMATCH" });
    await expect(runtime.reconcile([{
      workspaceId: WORKSPACE_ID,
      runtimeImage: config.RUNTIME_IMAGE,
      desiredState: "STOPPED",
      diskLimitBytes: STORAGE.diskLimitBytes,
    }])).resolves.toMatchObject({
      workspaces: [{
        status: "INVALID",
        code: "RUNTIME_CONFIGURATION_MISMATCH",
      }],
    });
    expect(await readFile(metadataPath, "utf8")).toBe(originalMetadata);

    const containerName = `agent-runtime-${WORKSPACE_ID}`;
    const container = docker.containers.get(containerName);
    const network = docker.networks.get(containerName);
    if (container === undefined || network === undefined) {
      throw new Error("managed Runtime fixture missing");
    }

    container.inspection.Config.Image = config.RUNTIME_IMAGE;
    await expect(runtime.delete(WORKSPACE_ID)).rejects.toMatchObject<
      Partial<WorkspaceRuntimeError>
    >({ code: "RUNTIME_CONFIGURATION_MISMATCH" });
    expect(docker.containers.has(containerName)).toBe(true);
    container.inspection.Config.Image = historicalImage;

    network.labels.worker_id = "foreign-worker";
    await expect(runtime.delete(WORKSPACE_ID)).rejects.toMatchObject<
      Partial<WorkspaceRuntimeError>
    >({ code: "UNMANAGED_NETWORK_CONFLICT" });
    expect(docker.containers.has(containerName)).toBe(true);
    expect(existsSync(persistentFile)).toBe(true);
    network.labels.worker_id = config.WORKER_ID;

    await writeFile(metadataPath, JSON.stringify({
      ...JSON.parse(originalMetadata) as Record<string, unknown>,
      workerId: "foreign-worker",
    }));
    await expect(runtime.delete(WORKSPACE_ID)).rejects.toMatchObject<
      Partial<WorkspaceRuntimeError>
    >({ code: "WORKSPACE_METADATA_MISMATCH" });
    expect(docker.containers.has(containerName)).toBe(true);
    await writeFile(metadataPath, originalMetadata);

    await expect(runtime.delete(WORKSPACE_ID)).resolves.toMatchObject({
      state: "CREATED",
      runtimeImage: historicalImage,
    });
    expect(docker.containers.has(containerName)).toBe(false);
    expect(docker.networks.has(containerName)).toBe(false);
    expect(existsSync(workspaceRoot)).toBe(false);
  });

  it("rejects a symlinked metadata file before destructive cleanup", async () => {
    const { root, config, docker, runtime } = await fixture();
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    const metadataPath = join(root, "workspaces", WORKSPACE_ID, "metadata", "managed.json");
    const contents = await readFile(metadataPath, "utf8");
    await rm(metadataPath);
    const otherFile = join(root, "other-managed.json");
    await writeFile(otherFile, contents);
    await symlink(otherFile, metadataPath);

    await expect(runtime.delete(WORKSPACE_ID)).rejects.toMatchObject<
      Partial<WorkspaceRuntimeError>
    >({ code: "WORKSPACE_METADATA_MISMATCH" });
    expect(docker.containers.size).toBe(1);
    expect(docker.networks.size).toBe(1);
  });

  it("strictly verifies the default cwd on a newly created container", async () => {
    const { config, docker, runtime } = await fixture();
    docker.omitDefaultCwdOnCreate = true;

    await expect(
      runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE),
    ).rejects.toMatchObject<Partial<WorkspaceRuntimeError>>({
      code: "RUNTIME_CONFIGURATION_MISMATCH",
    });
  });

  it("inventories authoritative assignments without creating or deleting resources", async () => {
    const { config, docker, runtime } = await fixture();
    const missingId = "0c0c7ff9-5679-4543-b561-1eb492719b77";
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);

    const report = await runtime.reconcile([
      {
        workspaceId: WORKSPACE_ID,
        runtimeImage: config.RUNTIME_IMAGE,
        desiredState: "STOPPED",
        diskLimitBytes: STORAGE.diskLimitBytes,
      },
      {
        workspaceId: missingId,
        runtimeImage: config.RUNTIME_IMAGE,
        desiredState: "RUNNING",
        diskLimitBytes: STORAGE.diskLimitBytes,
      },
    ]);

    expect(report.workspaces).toEqual([
      expect.objectContaining({
        status: "OBSERVED",
        workspace: expect.objectContaining({
          workspaceId: WORKSPACE_ID,
          state: "STOPPED",
        }),
      }),
      { status: "MISSING", workspaceId: missingId },
    ]);
    expect(report.issues).toEqual([]);
    expect(docker.containers.size).toBe(1);
    expect(docker.networks.size).toBe(1);
  });

  it("classifies unassigned managed resources as orphans and leaves them intact", async () => {
    const { config, docker, runtime } = await fixture();
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);

    const report = await runtime.reconcile([]);

    expect(report.workspaces).toEqual([]);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          classification: "MANAGED_ORPHAN",
          resource: "CONTAINER",
          workspaceId: WORKSPACE_ID,
        }),
        expect.objectContaining({
          classification: "MANAGED_ORPHAN",
          resource: "NETWORK",
          workspaceId: WORKSPACE_ID,
        }),
        expect.objectContaining({
          classification: "MANAGED_ORPHAN",
          resource: "DIRECTORY",
          workspaceId: WORKSPACE_ID,
        }),
      ]),
    );
    expect(docker.containers.size).toBe(1);
    expect(docker.networks.size).toBe(1);
  });

  it("blocks an explicitly conflicting default cwd from start but still permits safe deletion", async () => {
    const { root, config, docker, runtime } = await fixture();
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);

    const name = `agent-runtime-${WORKSPACE_ID}`;
    const container = docker.containers.get(name);
    if (container === undefined) throw new Error("container fixture missing");
    container.inspection.Config.Env = container.inspection.Config.Env.map(
      (entry) =>
        entry === "PI_WEB_DEFAULT_CWD=/workspace"
          ? "PI_WEB_DEFAULT_CWD=/tmp"
          : entry,
    );

    await expect(
      runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE),
    ).rejects.toMatchObject<Partial<WorkspaceRuntimeError>>({
      code: "RUNTIME_CONFIGURATION_MISMATCH",
    });
    await expect(runtime.start(WORKSPACE_ID)).rejects.toMatchObject<
      Partial<WorkspaceRuntimeError>
    >({ code: "RUNTIME_CONFIGURATION_MISMATCH" });
    await expect(runtime.inspect(WORKSPACE_ID)).resolves.toMatchObject({
      state: "STOPPED",
    });
    await expect(runtime.delete(WORKSPACE_ID)).resolves.toMatchObject({
      state: "CREATED",
    });
    expect(existsSync(join(root, "workspaces", WORKSPACE_ID))).toBe(false);
  });
});

describe("Docker Workspace Runtime egress", () => {
  const networkName = `agent-runtime-${WORKSPACE_ID}`;

  /** A managed Workspace whose network predates Phase 14 (Docker's default bridge name). */
  async function legacyNetworkFixture(running: boolean) {
    const context = await fixture();
    const { config, docker, runtime } = context;
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    const legacy = docker.networks.get(networkName);
    if (legacy === undefined) throw new Error("network fixture missing");
    delete legacy.options["com.docker.network.bridge.name"];
    if (running) await docker.containers.get(networkName)?.start();
    return { ...context, legacyNetworkId: legacy.id };
  }

  it("names the Workspace bridge arw-<id> so the egress rules match it, without IPv6", async () => {
    const { config, docker, runtime } = await fixture();
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    const network = await docker.networks.get(networkName)?.inspect();
    expect(network?.Options).toEqual({
      "com.docker.network.bridge.enable_icc": "false",
      "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1",
      "com.docker.network.bridge.name": "arw-90b38efcaa9",
    });
  });

  it("refuses to start a container while the egress rules are not enforced", async () => {
    const { config, docker, runtime, egress } = await fixture();
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    egress.enforced = false;

    await expect(runtime.start(WORKSPACE_ID)).rejects.toMatchObject<
      Partial<WorkspaceRuntimeError>
    >({ code: "EGRESS_UNENFORCED" });
    expect(docker.containers.get(networkName)?.inspection.State.Running).toBe(false);
    expect(egress.ensureCalls).toBe(1);

    egress.enforced = true;
    await expect(runtime.start(WORKSPACE_ID)).resolves.toMatchObject({ state: "RUNNING" });
  });

  it("closes the Gateway path while the egress rules are not enforced", async () => {
    const { config, runtime, egress } = await fixture();
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    await runtime.start(WORKSPACE_ID);
    egress.enforced = false;

    await expect(runtime.gatewayTarget(WORKSPACE_ID)).rejects.toMatchObject<
      Partial<WorkspaceRuntimeError>
    >({ code: "EGRESS_UNENFORCED" });
  });

  it("migrates a stopped Workspace from a legacy network to the arw- bridge", async () => {
    const { config, docker, runtime, legacyNetworkId } = await legacyNetworkFixture(false);

    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    const network = docker.networks.get(networkName);
    expect(network?.id).not.toBe(legacyNetworkId);
    expect(network?.options["com.docker.network.bridge.name"]).toBe("arw-90b38efcaa9");
    expect(docker.containers.get(networkName)?.inspection.NetworkSettings.Networks).toEqual({
      [networkName]: { NetworkID: network?.id },
    });
    await expect(runtime.start(WORKSPACE_ID)).resolves.toMatchObject({ state: "RUNNING" });
  });

  it("does not replace the network under a running legacy Workspace", async () => {
    const { config, docker, runtime, legacyNetworkId } = await legacyNetworkFixture(true);

    await expect(
      runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE),
    ).rejects.toMatchObject<Partial<WorkspaceRuntimeError>>({ code: "EGRESS_NETWORK_LEGACY" });
    expect(docker.networks.get(networkName)?.id).toBe(legacyNetworkId);
  });

  it("stops a running Workspace found on a legacy network during reconciliation", async () => {
    const { config, docker, runtime } = await legacyNetworkFixture(true);

    const report = await runtime.reconcile([
      { workspaceId: WORKSPACE_ID, runtimeImage: config.RUNTIME_IMAGE, desiredState: "RUNNING", diskLimitBytes: STORAGE.diskLimitBytes },
    ]);
    expect(report.workspaces).toEqual([
      {
        status: "INVALID",
        workspaceId: WORKSPACE_ID,
        code: "EGRESS_NETWORK_LEGACY",
        retryable: false,
      },
    ]);
    expect(docker.containers.get(networkName)?.inspection.State.Running).toBe(false);
  });

  it("stops a running Workspace during reconciliation while the egress rules are not enforced", async () => {
    const { config, docker, runtime, egress } = await fixture();
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    await runtime.start(WORKSPACE_ID);
    egress.enforced = false;

    const report = await runtime.reconcile([
      { workspaceId: WORKSPACE_ID, runtimeImage: config.RUNTIME_IMAGE, desiredState: "RUNNING", diskLimitBytes: STORAGE.diskLimitBytes },
    ]);
    expect(report.workspaces).toEqual([
      {
        status: "INVALID",
        workspaceId: WORKSPACE_ID,
        code: "EGRESS_UNENFORCED",
        retryable: false,
      },
    ]);
    expect(docker.containers.get(networkName)?.inspection.State.Running).toBe(false);
  });

  it("stops only running managed containers when enforcement is lost", async () => {
    const { config, docker, runtime } = await fixture();
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    await runtime.start(WORKSPACE_ID);
    const stoppedId = "1f0e0a52-3b55-4f51-9a49-34c9b2f9a0b1";
    await runtime.ensure(stoppedId, config.RUNTIME_IMAGE, RESOURCES, STORAGE);

    await expect(runtime.stopRunningWorkspaces()).resolves.toEqual([WORKSPACE_ID]);
    expect(docker.containers.get(networkName)?.inspection.State.Running).toBe(false);
    await expect(runtime.stopRunningWorkspaces()).resolves.toEqual([]);
  });
});

describe("Docker Workspace Runtime disk quotas and container limits (Phase 15)", () => {
  const metadataOf = async (root: string, workspaceId = WORKSPACE_ID) =>
    JSON.parse(
      await readFile(join(root, "workspaces", workspaceId, "metadata", "managed.json"), "utf8"),
    ) as { quota?: { dataProjectId: number; piProjectId: number; dataLimitBytes: number } };

  it("creates a read-only-root container whose writable places are quota'd binds and bounded tmpfs", async () => {
    const { root, config, docker, runtime, storage } = await fixture();
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    const base = join(root, "workspaces", WORKSPACE_ID);
    const host = docker.createdOptions?.HostConfig;
    expect(host?.Binds).toBeUndefined();
    expect(host?.ReadonlyRootfs).toBe(true);
    expect(host?.Mounts).toEqual([
      { Type: "bind", Source: join(base, "workspace"), Target: "/workspace", ReadOnly: false },
      { Type: "bind", Source: join(base, "home"), Target: "/home/agent", ReadOnly: false },
      { Type: "bind", Source: join(base, "tmp"), Target: "/tmp", ReadOnly: false },
      { Type: "bind", Source: join(base, "pi"), Target: "/agent/pi", ReadOnly: false },
    ]);
    expect(Object.keys(host?.Tmpfs ?? {}).sort()).toEqual(["/run", "/run/lock", "/var/tmp"]);
    expect(host?.Tmpfs?.["/var/tmp"]).toContain("size=256m");
    expect(host?.Ulimits).toEqual([
      { Name: "nofile", Soft: 65_536, Hard: 65_536 },
      { Name: "core", Soft: 0, Hard: 0 },
    ]);
    expect(host?.LogConfig).toEqual({
      Type: "json-file",
      Config: { "max-size": "10m", "max-file": "3" },
    });
    expect(docker.createdOptions?.Env).toContain("CARGO_HOME=/home/agent/.cargo");

    // Quotas were in place before the container existed, on all four directories.
    const metadata = await metadataOf(root);
    expect(metadata.quota).toEqual({
      dataProjectId: 1_000_001,
      piProjectId: 1_000_002,
      dataLimitBytes: 20 * GIB,
    });
    expect(storage.prepared[0]).toMatchObject({
      directories: {
        workspace: join(base, "workspace"),
        home: join(base, "home"),
        tmp: join(base, "tmp"),
        pi: join(base, "pi"),
      },
      quota: { dataProjectId: 1_000_001, piProjectId: 1_000_002 },
      dataLimitBytes: 20 * GIB,
    });
  });

  it("seeds a new home from /etc/skel inside a network-less sandbox, once", async () => {
    const { root, config, docker, runtime } = await fixture();
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    const helpers = docker.allCreated.filter((options) =>
      options.name?.startsWith("agent-runtime-home-init-"),
    );
    expect(helpers).toHaveLength(1);
    expect(helpers[0]).toMatchObject({
      Image: config.RUNTIME_IMAGE,
      User: TEST_USER,
      NetworkDisabled: true,
      HostConfig: {
        NetworkMode: "none",
        CapDrop: ["ALL"],
        Privileged: false,
        ReadonlyRootfs: true,
        SecurityOpt: ["no-new-privileges:true"],
        Mounts: [
          {
            Type: "bind",
            Source: join(root, "workspaces", WORKSPACE_ID, "home"),
            Target: "/home/agent",
            ReadOnly: false,
          },
        ],
      },
    });
    // Never overwrites what is already there.
    expect(String(helpers[0]?.Cmd?.[0])).toContain('[ -e "$t" ] || [ -L "$t" ] ||');
    expect([...docker.containers.keys()]).toEqual([`agent-runtime-${WORKSPACE_ID}`]);
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    expect(docker.allCreated.filter((options) => options.name?.startsWith("agent-runtime-home-init-"))).toHaveLength(1);
  });

  it("does not create the Workspace container when home seeding fails", async () => {
    const { config, docker, runtime } = await fixture();
    docker.helperExitCode = 1;
    await expect(
      runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE),
    ).rejects.toMatchObject<Partial<WorkspaceRuntimeError>>({ code: "RUNTIME_ENGINE_ERROR" });
    expect(docker.containers.size).toBe(0);
    docker.helperExitCode = 0;
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    expect(docker.containers.size).toBe(1);
  });

  it("gives every Workspace its own project IDs and releases them on delete", async () => {
    const { root, config, runtime, storage } = await fixture();
    const otherId = "90b38efc-aa9a-4bc6-8eee-528b4e0c7c61";
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    await runtime.ensure(otherId, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    const first = (await metadataOf(root)).quota;
    const second = (await metadataOf(root, otherId)).quota;
    const ids = [first?.dataProjectId, first?.piProjectId, second?.dataProjectId, second?.piProjectId];
    expect(new Set(ids).size).toBe(4);
    expect(ids.every((id) => id !== undefined && id > 1_000_000)).toBe(true);

    await runtime.delete(WORKSPACE_ID);
    expect(storage.released).toEqual([first]);
    const third = "90b38efc-aa9a-4bc6-8eee-528b4e0c7c62";
    await runtime.ensure(third, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    // Freed IDs are reused only after their Workspace's metadata is gone.
    const reused = (await metadataOf(root, third)).quota;
    expect([reused?.dataProjectId, reused?.piProjectId].sort()).toEqual(
      [first?.dataProjectId, first?.piProjectId].sort(),
    );
  });

  it("refuses to create or start anything while quotas are not enforced", async () => {
    const { config, docker, runtime, storage } = await fixture();
    storage.enforced = false;
    await expect(
      runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE),
    ).rejects.toMatchObject<Partial<WorkspaceRuntimeError>>({ code: "STORAGE_QUOTA_UNENFORCED" });
    expect(docker.containers.size).toBe(0);

    storage.enforced = true;
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    storage.enforced = false;
    await expect(runtime.start(WORKSPACE_ID)).rejects.toMatchObject<
      Partial<WorkspaceRuntimeError>
    >({ code: "STORAGE_QUOTA_UNENFORCED" });
    expect(docker.containers.get(`agent-runtime-${WORKSPACE_ID}`)?.inspection.State.Running).toBe(false);
  });

  it("re-applies quotas and empties /tmp, without following links, before each start", async () => {
    const { root, config, runtime, storage } = await fixture();
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    const tmp = join(root, "workspaces", WORKSPACE_ID, "tmp");
    const outside = join(root, "outside.txt");
    await writeFile(outside, "keep", "utf8");
    await writeFile(join(tmp, "scratch.txt"), "old", "utf8");
    await symlink(outside, join(tmp, "link"));
    const preparedBefore = storage.prepared.length;

    await runtime.start(WORKSPACE_ID);
    expect(storage.prepared.length).toBe(preparedBefore + 1);
    expect(existsSync(join(tmp, "scratch.txt"))).toBe(false);
    expect(existsSync(join(tmp, "link"))).toBe(false);
    expect(await readFile(outside, "utf8")).toBe("keep");

    storage.failApply = true;
    await runtime.stop(WORKSPACE_ID);
    await expect(runtime.start(WORKSPACE_ID)).rejects.toMatchObject<
      Partial<WorkspaceRuntimeError>
    >({ code: "STORAGE_QUOTA_APPLY_FAILED", retryable: true });
  });

  it("keeps a pre-Phase-15 container manageable but never starts or serves it", async () => {
    const { config, docker, runtime } = await fixture();
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    const name = `agent-runtime-${WORKSPACE_ID}`;
    makeLegacyContainer(docker.containers.get(name));

    for (const attempt of [
      () => runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE),
      () => runtime.start(WORKSPACE_ID),
    ]) {
      await expect(attempt()).rejects.toMatchObject<Partial<WorkspaceRuntimeError>>({
        code: "STORAGE_MIGRATION_REQUIRED",
      });
    }
    expect(docker.containers.get(name)?.inspection.State.Running).toBe(false);
    await expect(runtime.inspect(WORKSPACE_ID)).resolves.toMatchObject({ state: "STOPPED" });

    // A legacy container that is somehow running is not served and is stopped on recovery.
    await docker.containers.get(name)?.start();
    await expect(runtime.gatewayTarget(WORKSPACE_ID)).rejects.toMatchObject<
      Partial<WorkspaceRuntimeError>
    >({ code: "STORAGE_MIGRATION_REQUIRED" });
    await expect(
      runtime.reconcile([
        {
          workspaceId: WORKSPACE_ID,
          runtimeImage: config.RUNTIME_IMAGE,
          desiredState: "RUNNING",
          diskLimitBytes: STORAGE.diskLimitBytes,
        },
      ]),
    ).resolves.toMatchObject({
      workspaces: [{ status: "INVALID", code: "STORAGE_MIGRATION_REQUIRED" }],
    });
    expect(docker.containers.get(name)?.inspection.State.Running).toBe(false);
    await expect(runtime.stop(WORKSPACE_ID)).resolves.toMatchObject({ state: "STOPPED" });
    await runtime.delete(WORKSPACE_ID);
    expect(docker.containers.size).toBe(0);
  });

  it("rejects a container that mixes the new mounts with a writable root", async () => {
    const { config, docker, runtime } = await fixture();
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    const container = docker.containers.get(`agent-runtime-${WORKSPACE_ID}`);
    if (container === undefined) throw new Error("container fixture missing");
    container.inspection.HostConfig = { ...container.inspection.HostConfig, ReadonlyRootfs: false };
    await expect(runtime.start(WORKSPACE_ID)).rejects.toMatchObject<
      Partial<WorkspaceRuntimeError>
    >({ code: "RUNTIME_CONFIGURATION_MISMATCH" });
  });

  it("detects drift in tmpfs, ulimits and log limits of a newly created container", async () => {
    const { config } = await fixture();
    for (const drift of [
      (host: Docker.HostConfig) => ({ ...host, Tmpfs: { "/run": "rw,size=1g" } }),
      (host: Docker.HostConfig) => ({ ...host, Ulimits: [{ Name: "nofile", Soft: 1024, Hard: 1024 }] }),
      (host: Docker.HostConfig) => ({ ...host, LogConfig: { Type: "json-file", Config: {} } }),
    ]) {
      const fresh = await fixture();
      fresh.docker.createContainer = async (options: Docker.ContainerCreateOptions) =>
        FakeDocker.prototype.createContainer.call(fresh.docker, {
          ...options,
          HostConfig: options.name?.startsWith("agent-runtime-home-init-")
            ? options.HostConfig
            : drift(options.HostConfig ?? {}),
        });
      await expect(
        fresh.runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE),
      ).rejects.toMatchObject<Partial<WorkspaceRuntimeError>>({
        code: "RUNTIME_CONFIGURATION_MISMATCH",
      });
    }
  });

  it("closes the Gateway path while quotas are not enforced", async () => {
    const { config, runtime, storage } = await fixture();
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    await runtime.start(WORKSPACE_ID);
    await expect(runtime.gatewayTarget(WORKSPACE_ID)).resolves.toBeInstanceOf(URL);
    storage.enforced = false;
    await expect(runtime.gatewayTarget(WORKSPACE_ID)).rejects.toMatchObject<
      Partial<WorkspaceRuntimeError>
    >({ code: "STORAGE_QUOTA_UNENFORCED" });
  });

  it("stops a running Workspace during recovery while quotas are not enforced", async () => {
    const { config, docker, runtime, storage } = await fixture();
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    await runtime.start(WORKSPACE_ID);
    storage.enforced = false;
    await expect(
      runtime.reconcile([
        {
          workspaceId: WORKSPACE_ID,
          runtimeImage: config.RUNTIME_IMAGE,
          desiredState: "RUNNING",
          diskLimitBytes: STORAGE.diskLimitBytes,
        },
      ]),
    ).resolves.toMatchObject({
      workspaces: [{ status: "INVALID", code: "STORAGE_QUOTA_UNENFORCED" }],
    });
    expect(docker.containers.get(`agent-runtime-${WORKSPACE_ID}`)?.inspection.State.Running).toBe(false);
    await expect(runtime.gatewayTarget(WORKSPACE_ID)).rejects.toMatchObject<
      Partial<WorkspaceRuntimeError>
    >({ code: "RUNTIME_NOT_READY" });
  });

  it("closes the Gateway path while quotas are not enforced", async () => {
    const { config, runtime, storage } = await fixture();
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    await runtime.start(WORKSPACE_ID);
    await expect(runtime.gatewayTarget(WORKSPACE_ID)).resolves.toBeInstanceOf(URL);
    storage.enforced = false;
    await expect(runtime.gatewayTarget(WORKSPACE_ID)).rejects.toMatchObject<
      Partial<WorkspaceRuntimeError>
    >({ code: "STORAGE_QUOTA_UNENFORCED" });
  });

  it("changes a disk limit in place and samples usage only under enforced quotas", async () => {
    const { root, config, runtime, storage } = await fixture();
    const unprepared = "90b38efc-aa9a-4bc6-8eee-528b4e0c7c63";
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    await expect(runtime.setDiskLimit(WORKSPACE_ID, 5 * GIB)).resolves.toEqual({
      dataLimitBytes: 5 * GIB,
      dataUsedBytes: GIB,
    });
    expect((await metadataOf(root)).quota?.dataLimitBytes).toBe(5 * GIB);
    expect(storage.prepared.at(-1)?.dataLimitBytes).toBe(5 * GIB);

    await expect(runtime.diskUsage()).resolves.toEqual([
      {
        workspaceId: WORKSPACE_ID,
        dataUsedBytes: 3 * GIB,
        dataLimitBytes: 20 * GIB,
        dataUsedInodes: 42,
        piUsedBytes: 1024,
        piLimitBytes: 2 * GIB,
      },
    ]);
    await expect(runtime.setDiskLimit(unprepared, 5 * GIB)).rejects.toMatchObject<
      Partial<WorkspaceRuntimeError>
    >({ code: "WORKSPACE_NOT_MANAGED" });
    storage.enforced = false;
    await expect(runtime.diskUsage()).resolves.toEqual([]);
    await expect(runtime.setDiskLimit(WORKSPACE_ID, 6 * GIB)).rejects.toMatchObject<
      Partial<WorkspaceRuntimeError>
    >({ code: "STORAGE_QUOTA_UNENFORCED" });
  });
});

describe("Docker Workspace Runtime model access (Phase 16.4, 16.5)", () => {
  const catalog = {
    providerId: "platform",
    defaultModel: "deepseek-v4-flash",
    models: [{ id: "deepseek-v4-flash", api: "openai-completions" as const }],
  };

  it("writes the provider with the bridge gateway address only while stopped", async () => {
    const { root, config, docker, runtime } = await fixture();
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    await expect(runtime.configureModelProvider(WORKSPACE_ID, catalog, 3101)).resolves.toBe("applied");
    const pi = join(root, "workspaces", WORKSPACE_ID, "pi");
    const models = JSON.parse(await readFile(join(pi, "models.json"), "utf8"));
    expect(models.providers.platform.baseUrl).toBe("http://172.22.0.1:3101/v1");
    const metadataFile = join(root, "workspaces", WORKSPACE_ID, "metadata", "managed.json");
    expect(JSON.parse(await readFile(metadataFile, "utf8")).modelProviderId).toBe("platform");

    await runtime.start(WORKSPACE_ID);
    await expect(runtime.configureModelProvider(WORKSPACE_ID, null, 3101)).resolves.toBe("unchanged_running");
    expect(JSON.parse(await readFile(join(pi, "models.json"), "utf8")).providers.platform).toBeDefined();

    await runtime.stop(WORKSPACE_ID);
    // The gateway was switched off: the remembered entry is removed.
    await expect(runtime.configureModelProvider(WORKSPACE_ID, null, 3101)).resolves.toBe("removed");
    expect(JSON.parse(await readFile(join(pi, "models.json"), "utf8")).providers.platform).toBeUndefined();
    expect(JSON.parse(await readFile(metadataFile, "utf8")).modelProviderId).toBeUndefined();
    void docker;
  });

  it("lists only running managed Workspaces on their own network as relay endpoints", async () => {
    const { config, docker, runtime } = await fixture();
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    await expect(runtime.relayEndpoints()).resolves.toEqual([]);
    await runtime.start(WORKSPACE_ID);
    await expect(runtime.relayEndpoints()).resolves.toEqual([
      { workspaceId: WORKSPACE_ID, gatewayAddress: "172.22.0.1", containerAddress: "172.22.0.2" },
    ]);

    // A container that claims the Workspace label under another name is not an endpoint.
    const container = docker.containers.get(`agent-runtime-${WORKSPACE_ID}`);
    if (container === undefined) throw new Error("container fixture missing");
    docker.containers.delete(`agent-runtime-${WORKSPACE_ID}`);
    docker.containers.set("impostor", container);
    await expect(runtime.relayEndpoints()).resolves.toEqual([]);
    docker.containers.delete("impostor");
    docker.containers.set(`agent-runtime-${WORKSPACE_ID}`, container);

    // Labels from another Worker are not endpoints either.
    container.inspection.Config.Labels = { ...container.inspection.Config.Labels, worker_id: "worker-02" };
    await expect(runtime.relayEndpoints()).resolves.toEqual([]);
  });

  it("returns the private metadata directory only for managed Workspaces", async () => {
    const { root, config, runtime } = await fixture();
    await expect(runtime.modelKeyDirectory(WORKSPACE_ID)).rejects.toMatchObject({ code: "WORKSPACE_NOT_MANAGED" });
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES, STORAGE);
    await expect(runtime.modelKeyDirectory(WORKSPACE_ID)).resolves.toBe(
      join(root, "workspaces", WORKSPACE_ID, "metadata"),
    );
  });
});
