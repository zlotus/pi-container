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
          Env: options.Env ?? [],
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
        PortBindings: {
          "30141/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
        },
      },
    });
    expect(docker.createdOptions?.Env).toContain(
      `PI_WEB_ALLOWED_HOSTS=${WORKSPACE_ID}.agent.example.internal`,
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
    expect(docker.containers.get(name)?.id).toBe("unmanaged");
  });
});
