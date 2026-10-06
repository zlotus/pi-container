import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type Docker from "dockerode";
import { afterEach, describe, expect, it } from "vitest";

import { loadWorkerConfig } from "./config.js";
import { DockerWorkspaceRuntime, type EgressGate } from "./runtime.js";
import type { WorkspaceRuntimeError } from "./runtime.js";

const WORKSPACE_ID = "90b38efc-aa9a-4bc6-8eee-528b4e0c7c60";
const RESOURCES = {
  cpuCount: 2,
  memoryBytes: 4 * 1024 ** 3,
  pidsLimit: 512,
};

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
  NetworkSettings: {
    Ports: Record<string, Array<{ HostIp: string; HostPort: string }>>;
    Networks: Record<string, { NetworkID: string }>;
  };
}

class FakeDocker {
  readonly containers = new Map<string, FakeContainer>();
  readonly networks = new Map<string, FakeNetwork>();
  createdOptions: Docker.ContainerCreateOptions | null = null;
  omitDefaultCwdOnCreate = false;
  hostPort = "1";
  networkSequence = 0;

  async createContainer(options: Docker.ContainerCreateOptions) {
    this.createdOptions = options;
    const name = options.name ?? "";
    const binds = options.HostConfig?.Binds ?? [];
    const container = new FakeContainer(
      `container-${this.containers.size}`,
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
        Mounts: binds.map((bind) => {
          const [source, destination] = bind.split(":");
          return {
            Type: "bind" as const,
            Source: source ?? "",
            Destination: destination ?? "",
            RW: true,
          };
        }),
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
  const runtime = new DockerWorkspaceRuntime(
    config,
    docker as unknown as Docker,
    async () => true,
    egress,
  );
  return { root, config, docker, runtime, egress };
}

describe("Docker Workspace Runtime", () => {
  it("creates one constrained container and preserves both persistent mounts", async () => {
    const { root, config, docker, runtime } = await fixture();
    docker.hostPort = "30199";

    const first = await runtime.ensure(
      WORKSPACE_ID,
      config.RUNTIME_IMAGE,
      RESOURCES,
    );
    const second = await runtime.ensure(
      WORKSPACE_ID,
      config.RUNTIME_IMAGE,
      RESOURCES,
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
      runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES),
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
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES);

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
      runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES),
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
    const { root, config, docker, runtime, egress } = await fixture();
    const historicalImage = "agent-runtime:phase4-legacy";
    const legacyRuntime = new DockerWorkspaceRuntime(
      { ...config, RUNTIME_IMAGE: historicalImage },
      docker as unknown as Docker,
      async () => true,
      egress,
    );
    await legacyRuntime.ensure(WORKSPACE_ID, historicalImage, RESOURCES);
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
    await expect(runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES))
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
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES);
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
      runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES),
    ).rejects.toMatchObject<Partial<WorkspaceRuntimeError>>({
      code: "RUNTIME_CONFIGURATION_MISMATCH",
    });
  });

  it("inventories authoritative assignments without creating or deleting resources", async () => {
    const { config, docker, runtime } = await fixture();
    const missingId = "0c0c7ff9-5679-4543-b561-1eb492719b77";
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES);

    const report = await runtime.reconcile([
      {
        workspaceId: WORKSPACE_ID,
        runtimeImage: config.RUNTIME_IMAGE,
        desiredState: "STOPPED",
      },
      {
        workspaceId: missingId,
        runtimeImage: config.RUNTIME_IMAGE,
        desiredState: "RUNNING",
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
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES);

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
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES);

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
      runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES),
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
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES);
    const legacy = docker.networks.get(networkName);
    if (legacy === undefined) throw new Error("network fixture missing");
    delete legacy.options["com.docker.network.bridge.name"];
    if (running) await docker.containers.get(networkName)?.start();
    return { ...context, legacyNetworkId: legacy.id };
  }

  it("names the Workspace bridge arw-<id> so the egress rules match it, without IPv6", async () => {
    const { config, docker, runtime } = await fixture();
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES);
    const network = await docker.networks.get(networkName)?.inspect();
    expect(network?.Options).toEqual({
      "com.docker.network.bridge.enable_icc": "false",
      "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1",
      "com.docker.network.bridge.name": "arw-90b38efcaa9",
    });
  });

  it("refuses to start a container while the egress rules are not enforced", async () => {
    const { config, docker, runtime, egress } = await fixture();
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES);
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
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES);
    await runtime.start(WORKSPACE_ID);
    egress.enforced = false;

    await expect(runtime.gatewayTarget(WORKSPACE_ID)).rejects.toMatchObject<
      Partial<WorkspaceRuntimeError>
    >({ code: "EGRESS_UNENFORCED" });
  });

  it("migrates a stopped Workspace from a legacy network to the arw- bridge", async () => {
    const { config, docker, runtime, legacyNetworkId } = await legacyNetworkFixture(false);

    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES);
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
      runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES),
    ).rejects.toMatchObject<Partial<WorkspaceRuntimeError>>({ code: "EGRESS_NETWORK_LEGACY" });
    expect(docker.networks.get(networkName)?.id).toBe(legacyNetworkId);
  });

  it("stops a running Workspace found on a legacy network during reconciliation", async () => {
    const { config, docker, runtime } = await legacyNetworkFixture(true);

    const report = await runtime.reconcile([
      { workspaceId: WORKSPACE_ID, runtimeImage: config.RUNTIME_IMAGE, desiredState: "RUNNING" },
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
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES);
    await runtime.start(WORKSPACE_ID);
    egress.enforced = false;

    const report = await runtime.reconcile([
      { workspaceId: WORKSPACE_ID, runtimeImage: config.RUNTIME_IMAGE, desiredState: "RUNNING" },
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
    await runtime.ensure(WORKSPACE_ID, config.RUNTIME_IMAGE, RESOURCES);
    await runtime.start(WORKSPACE_ID);
    const stoppedId = "1f0e0a52-3b55-4f51-9a49-34c9b2f9a0b1";
    await runtime.ensure(stoppedId, config.RUNTIME_IMAGE, RESOURCES);

    await expect(runtime.stopRunningWorkspaces()).resolves.toEqual([WORKSPACE_ID]);
    expect(docker.containers.get(networkName)?.inspection.State.Running).toBe(false);
    await expect(runtime.stopRunningWorkspaces()).resolves.toEqual([]);
  });
});
