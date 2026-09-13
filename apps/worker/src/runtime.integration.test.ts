import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadWorkerConfig } from "./config.js";
import { buildWorkerGateway } from "./gateway.js";
import { DockerWorkspaceRuntime } from "./runtime.js";

const runDockerIntegration = process.env.TEST_DOCKER_RUNTIME === "1";
const describeWithDocker = runDockerIntegration ? describe : describe.skip;

describeWithDocker("Phase 3 Docker Runtime integration", () => {
  const workspaceId = randomUUID();
  const isolationWorkspaceIds = [randomUUID(), randomUUID()] as const;
  const containerName = `agent-runtime-${workspaceId}`;
  const networkName = containerName;
  const fallbackContainerName = `pi-web-default-cwd-fallback-${randomUUID()}`;
  const resources = {
    cpuCount: 1,
    memoryBytes: 1024 ** 3,
    pidsLimit: 256,
  };
  let managedRoot = "";
  let docker!: Docker;
  let runtime!: DockerWorkspaceRuntime;
  let workerGateway: Server | undefined;

  beforeAll(async () => {
    managedRoot = await mkdtemp(join(tmpdir(), "agent-runtime-integration-"));
    const config = loadWorkerConfig({
      CONTROL_PLANE_URL: "ws://127.0.0.1:3000/api/workers/connect",
      WORKER_ID: "integration-worker",
      WORKER_TOKEN: "0123456789abcdef0123456789abcdef",
      WORKER_GATEWAY_TOKEN: "gateway0123456789abcdef0123456789abcdef",
      WORKSPACE_BASE_URL: "https://agent.example.internal",
      WORKER_MAX_WORKSPACES: "2",
      WORKER_MANAGED_ROOT: managedRoot,
      RUNTIME_IMAGE: "agent-runtime:phase3-minimal",
      WORKSPACE_CPU_COUNT: String(resources.cpuCount),
      WORKSPACE_MEMORY_BYTES: String(resources.memoryBytes),
      WORKSPACE_PIDS_LIMIT: String(resources.pidsLimit),
      WORKSPACE_START_TIMEOUT_MS: "60000",
    });
    docker = new Docker({ socketPath: config.DOCKER_SOCKET_PATH });
    runtime = new DockerWorkspaceRuntime(config, docker);
  });

  afterAll(async () => {
    if (workerGateway !== undefined) {
      await new Promise<void>((resolve) => workerGateway?.close(() => resolve()));
    }
    if (runtime !== undefined) {
      for (const cleanupWorkspaceId of [workspaceId, ...isolationWorkspaceIds]) {
        try {
          await runtime.delete(cleanupWorkspaceId);
        } catch {
          // The tests report the original failure; cleanup below remains scoped
          // to random container/network names and the temporary managed root.
        }
      }
    }
    for (const cleanupWorkspaceId of [workspaceId, ...isolationWorkspaceIds]) {
      const cleanupName = `agent-runtime-${cleanupWorkspaceId}`;
      try {
        await docker?.getContainer(cleanupName).remove({ force: true });
      } catch {
        // Already removed or never created.
      }
      try {
        await docker?.getNetwork(cleanupName).remove();
      } catch {
        // Already removed or never created.
      }
    }
    try {
      await docker?.getContainer(fallbackContainerName).remove({ force: true });
    } catch {
      // Already removed or never created.
    }
    if (managedRoot !== "") {
      await rm(managedRoot, { recursive: true, force: true });
    }
  });

  it("starts pi-web with the security baseline and keeps both mounts on restart", async () => {
    await runtime.ensure(
      workspaceId,
      "agent-runtime:phase3-minimal",
      resources,
    );
    expect((await runtime.start(workspaceId)).state).toBe("RUNNING");

    const inspection = await docker.getContainer(containerName).inspect();
    expect(inspection.Config.User).toBe("1000:1000");
    expect(inspection.Config.WorkingDir).toBe("/workspace");
    expect(inspection.Config.Env).toContain("PI_WEB_DEFAULT_CWD=/workspace");
    expect(inspection.HostConfig.Privileged).toBe(false);
    expect(inspection.HostConfig.NetworkMode).toBe(networkName);
    expect(inspection.HostConfig.CapDrop).toContain("ALL");
    expect(inspection.HostConfig.SecurityOpt).toContain(
      "no-new-privileges:true",
    );
    expect(inspection.HostConfig.Memory).toBe(resources.memoryBytes);
    expect(inspection.HostConfig.NanoCpus).toBe(1_000_000_000);
    expect(inspection.HostConfig.PidsLimit).toBe(resources.pidsLimit);
    expect(inspection.NetworkSettings.Ports["30141/tcp"]?.[0]?.HostIp).toBe(
      "127.0.0.1",
    );
    expect(
      inspection.Mounts.some(
        (mount) => mount.Source === "/var/run/docker.sock",
      ),
    ).toBe(false);

    workerGateway = buildWorkerGateway({
      gatewayToken: "gateway0123456789abcdef0123456789abcdef",
      workspaceBaseUrl: "https://agent.example.internal",
      resolveWorkspaceTarget: (id) => runtime.gatewayTarget(id),
    });
    workerGateway.listen(0, "127.0.0.1");
    await once(workerGateway, "listening");
    const gatewayPort = (workerGateway.address() as AddressInfo).port;

    const defaultCwdResponse = await requestWorkerGateway(
      gatewayPort,
      workspaceId,
      { method: "POST", path: "/api/default-cwd" },
    );
    expect(defaultCwdResponse.statusCode).toBe(200);
    const defaultCwdPayload = JSON.parse(defaultCwdResponse.body) as {
      cwd?: unknown;
    };
    expect(defaultCwdPayload).toEqual({ cwd: "/workspace" });
    if (typeof defaultCwdPayload.cwd !== "string") {
      throw new Error("pi-web did not return its configured default cwd");
    }

    const createSessionBody = JSON.stringify({
      cwd: defaultCwdPayload.cwd,
      type: "ensure_session",
      toolNames: [],
    });
    const createSessionResponse = await requestWorkerGateway(
      gatewayPort,
      workspaceId,
      {
        method: "POST",
        path: "/api/agent/new",
        body: createSessionBody,
      },
    );
    expect(createSessionResponse.statusCode).toBe(200);
    const createSessionPayload = JSON.parse(createSessionResponse.body) as {
      sessionId?: unknown;
      success?: unknown;
    };
    expect(createSessionPayload.success).toBe(true);
    expect(typeof createSessionPayload.sessionId).toBe("string");
    if (typeof createSessionPayload.sessionId !== "string") {
      throw new Error("pi-web did not return a session ID");
    }

    const bashResponse = await requestWorkerGateway(gatewayPort, workspaceId, {
      method: "POST",
      path: `/api/agent/${createSessionPayload.sessionId}`,
      body: JSON.stringify({
        type: "bash",
        command: "printf 'artifact persists' > /workspace/artifact.txt",
        excludeFromContext: false,
      }),
    });
    expect(bashResponse.statusCode).toBe(200);
    expect(JSON.parse(bashResponse.body)).toMatchObject({ success: true });

    const fileListResponse = await requestWorkerGateway(
      gatewayPort,
      workspaceId,
      { path: "/api/files/workspace?type=list" },
    );
    expect(fileListResponse.statusCode).toBe(200);
    expect(JSON.parse(fileListResponse.body)).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ name: "artifact.txt", isDir: false }),
      ]),
    });

    const workspaceFile = join(
      managedRoot,
      "workspaces",
      workspaceId,
      "workspace",
      "artifact.txt",
    );
    const piSessionsRoot = join(
      managedRoot,
      "workspaces",
      workspaceId,
      "pi",
      "sessions",
    );
    expect(await readFile(workspaceFile, "utf8")).toBe("artifact persists");
    const sessionFiles = await findJsonlFiles(piSessionsRoot);
    expect(sessionFiles).toHaveLength(1);
    const [sessionFile] = sessionFiles;
    if (sessionFile === undefined) {
      throw new Error("pi-web did not persist the new Session JSONL");
    }
    const [sessionHeaderLine] = (await readFile(sessionFile, "utf8")).split(
      "\n",
      1,
    );
    if (sessionHeaderLine === undefined) {
      throw new Error("pi-web Session JSONL did not contain a header");
    }
    const sessionHeader = JSON.parse(
      sessionHeaderLine,
    ) as { cwd?: unknown; id?: unknown; type?: unknown };
    expect(sessionHeader).toMatchObject({
      type: "session",
      id: createSessionPayload.sessionId,
      cwd: "/workspace",
    });

    expect((await runtime.stop(workspaceId)).state).toBe("STOPPED");
    expect((await runtime.start(workspaceId)).state).toBe("RUNNING");
    expect(await readFile(workspaceFile, "utf8")).toBe("artifact persists");
    expect(await readFile(sessionFile, "utf8")).toContain(
      `"cwd":"/workspace"`,
    );

    const gatewayResponse = await requestWorkerGateway(gatewayPort, workspaceId);
    expect(gatewayResponse.statusCode).toBe(200);
    expect(gatewayResponse.contentType).toContain("text/html");
    expect(gatewayResponse.body).toContain("<!DOCTYPE html");
    await new Promise<void>((resolve) => workerGateway?.close(() => resolve()));
    workerGateway = undefined;

    await runtime.delete(workspaceId);
    expect(existsSync(join(managedRoot, "workspaces", workspaceId))).toBe(false);
  }, 120_000);

  it("preserves pi-web's upstream default cwd when the platform override is unset", async () => {
    const container = await docker.createContainer({
      name: fallbackContainerName,
      Image: "agent-runtime:phase3-minimal",
      User: "1000:1000",
      WorkingDir: "/workspace",
      Cmd: [
        "sh",
        "-lc",
        "unset PI_WEB_DEFAULT_CWD; exec pi-web --hostname 0.0.0.0 --port 30141 --no-open",
      ],
      ExposedPorts: { "30141/tcp": {} },
      HostConfig: {
        PortBindings: {
          "30141/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
        },
      },
    });

    try {
      await container.start();
      const inspection = await container.inspect();
      const hostPort = Number(
        inspection.NetworkSettings.Ports["30141/tcp"]?.[0]?.HostPort,
      );
      expect(hostPort).toBeGreaterThan(0);
      await waitForHttp(hostPort);

      const response = await requestHttp({
        port: hostPort,
        method: "POST",
        path: "/api/default-cwd",
      });
      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.body) as { cwd?: unknown };
      expect(payload.cwd).toMatch(/^\/home\/agent\/pi-cwd-\d{8}$/);
      if (typeof payload.cwd !== "string") {
        throw new Error("pi-web did not return its fallback cwd");
      }
      expect(await execExitCode(container, ["test", "-d", payload.cwd])).toBe(0);
    } finally {
      try {
        await container.remove({ force: true });
      } catch {
        // The suite-level cleanup retries the same random container name.
      }
    }
  }, 120_000);

  it("keeps Workspace bridges isolated from each other and host loopback", async () => {
    const [workspaceA, workspaceB] = isolationWorkspaceIds;
    await runtime.ensure(workspaceA, "agent-runtime:phase3-minimal", resources);
    await runtime.ensure(workspaceB, "agent-runtime:phase3-minimal", resources);
    await runtime.start(workspaceA);
    await runtime.start(workspaceB);

    const containerA = docker.getContainer(`agent-runtime-${workspaceA}`);
    const inspectionB = await docker
      .getContainer(`agent-runtime-${workspaceB}`)
      .inspect();
    const networkB = `agent-runtime-${workspaceB}`;
    const addressB = inspectionB.NetworkSettings.Networks[networkB]?.IPAddress;
    const hostPortB =
      inspectionB.NetworkSettings.Ports["30141/tcp"]?.[0]?.HostPort;
    if (addressB === undefined || hostPortB === undefined) {
      throw new Error("Workspace B network fixture is incomplete");
    }

    expect(await curlExitCode(containerA, `http://${addressB}:30141/`)).not.toBe(0);
    expect(
      await curlExitCode(containerA, `http://127.0.0.1:${hostPortB}/`),
    ).not.toBe(0);

    await runtime.delete(workspaceA);
    await runtime.delete(workspaceB);
  }, 120_000);
});

function requestWorkerGateway(
  port: number,
  workspaceId: string,
  input: { body?: string; method?: string; path?: string } = {},
) {
  const host = `${workspaceId}.agent.example.internal`;
  return requestHttp({
    port,
    path: input.path ?? "/",
    ...(input.method === undefined ? {} : { method: input.method }),
    ...(input.body === undefined ? {} : { body: input.body }),
    headers: {
      authorization: "Bearer gateway0123456789abcdef0123456789abcdef",
      host,
      origin: `https://${host}`,
      "sec-fetch-site": "same-origin",
      "x-forwarded-host": host,
      "x-forwarded-proto": "https",
      "x-platform-workspace-id": workspaceId,
    },
  });
}

function requestHttp(input: {
  body?: string;
  headers?: Record<string, string>;
  method?: string;
  path: string;
  port: number;
}) {
  const bodyHeaders =
    input.body === undefined
      ? {}
      : {
          "content-length": String(Buffer.byteLength(input.body)),
          "content-type": "application/json",
        };
  return new Promise<{
    statusCode: number;
    contentType: string;
    body: string;
  }>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: input.port,
        method: input.method ?? "GET",
        path: input.path,
        headers: { ...input.headers, ...bodyHeaders },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode ?? 0,
            contentType: response.headers["content-type"] ?? "",
            body,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(input.body);
  });
}

async function waitForHttp(port: number): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await requestHttp({ port, path: "/" });
      if (response.statusCode === 200) return;
    } catch {
      // pi-web has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("pi-web did not become ready");
}

async function findJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await findJsonlFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

async function curlExitCode(
  container: Docker.Container,
  url: string,
): Promise<number> {
  const command = await container.exec({
    AttachStderr: true,
    AttachStdout: true,
    Cmd: ["curl", "--fail", "--silent", "--max-time", "2", url],
  });
  const stream = await command.start({ hijack: true, stdin: false });
  await once(stream, "end");
  const inspection = await command.inspect();
  return inspection.ExitCode ?? -1;
}

async function execExitCode(
  container: Docker.Container,
  command: string[],
): Promise<number> {
  const execution = await container.exec({
    AttachStderr: true,
    AttachStdout: true,
    Cmd: command,
  });
  const stream = await execution.start({ hijack: true, stdin: false });
  await once(stream, "end");
  return (await execution.inspect()).ExitCode ?? -1;
}
