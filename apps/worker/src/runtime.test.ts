import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type Docker from "dockerode";
import { afterEach, describe, expect, it } from "vitest";

import { loadWorkerConfig } from "./config.js";
import { DockerWorkspaceRuntime } from "./runtime.js";
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
  };
}

class FakeDocker {
  readonly containers = new Map<string, FakeContainer>();
  readonly networks = new Map<string, FakeNetwork>();
  createdOptions: Docker.ContainerCreateOptions | null = null;
  omitDefaultCwdOnCreate = false;
  hostPort = "1";

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
        NetworkSettings: { Ports: {} },
      },
      this,
    );
    this.containers.set(name, container);
    return container;
  }

  async listContainers() {
    return [...this.containers.entries()].map(([name, container]) => ({
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
    const network = new FakeNetwork(
      `network-${this.networks.size}`,
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
    return this.inspection as Docker.ContainerInspectInfo;
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
}

const temporaryRoots: string[] = [];

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
  });
  const docker = new FakeDocker();
  const runtime = new DockerWorkspaceRuntime(
    config,
    docker as unknown as Docker,
    async () => true,
  );
  return { root, config, docker, runtime };
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
      User: "1000:1000",
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
            User: "1000:1000",
            Labels: {},
            WorkingDir: "/workspace",
            Env: ["PI_CODING_AGENT_DIR=/agent/pi"],
          },
          HostConfig: {},
          Mounts: [],
          NetworkSettings: { Ports: {} },
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
