import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadWorkerConfig } from "./config.js";
import { configuredRuntimeImages, DockerRuntimeImageCatalog } from "./runtime-images.js";
import type { WorkerConfig } from "./config.js";
import { DockerRuntimeCapabilityProbe } from "./capabilities.js";
import { currentArchitecture } from "./daemon.js";
import { buildWorkerGateway } from "./gateway.js";
import { workspaceBridgeName } from "./egress/ruleset.js";
import { DockerWorkspaceRuntime, type EgressGate, type StorageGate } from "./runtime.js";
import { OomEventCounter } from "./usage/oom.js";
import { WorkspaceUsageSampler } from "./usage/sampler.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function runScript(
  path: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(path, args, { env: { ...process.env, ...env }, shell: false });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, output }));
  });
}

const runDockerIntegration = process.env.TEST_DOCKER_RUNTIME === "1";
const describeWithDocker = runDockerIntegration ? describe : describe.skip;

// This suite runs without CAP_NET_ADMIN and does not install egress rules; the egress
// gate is satisfied here so the Docker behaviour can be tested. Real enforcement is
// covered by src/egress/egress.netns.test.ts and the Phase 14 manual acceptance.
const ASSUMED_ENFORCED: EgressGate = {
  isEnforced: () => true,
  ensure: async () => ({ enforced: true }),
};

// Likewise this suite runs on any filesystem: quotas are assumed and limits are not
// enforced. Real quota enforcement in containers is covered by src/storage/quota.xfs.test.ts.
const ASSUMED_STORAGE: StorageGate = {
  policy: { projectIdMin: 1_000_000, dataInodeLimit: 1, piLimitBytes: 1, piInodeLimit: 1 },
  isEnforced: () => true,
  status: () => ({ enforced: true, fsType: "assumed", totalBytes: null, freeBytes: null }),
  prepareWorkspace: async () => undefined,
  setDataLimit: async () => ({ usedBytes: 0, limitBytes: 0, usedInodes: 0, limitInodes: 0 }),
  releaseWorkspace: async () => undefined,
  usage: async () => ({ usedBytes: 0, limitBytes: 0, usedInodes: 0, limitInodes: 0 }),
};

const STORAGE = { diskLimitBytes: 20 * 1024 ** 3 };

describeWithDocker("Phase 3 through 7 Docker Runtime integration", () => {
  const runtimeImage =
    process.env.TEST_RUNTIME_IMAGE ?? "agent-runtime:phase7-toolchain";
  const workspaceId = randomUUID();
  const legacyWorkspaceId = randomUUID();
  const upgradedWorkspaceId = randomUUID();
  const isolationWorkspaceIds = [randomUUID(), randomUUID()] as const;
  const limitsWorkspaceId = randomUUID();
  const preQuotaWorkspaceId = randomUUID();
  const usageWorkspaceId = randomUUID();
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
  let config!: WorkerConfig;
  let runtime!: DockerWorkspaceRuntime;
  let workerGateway: Server | undefined;

  beforeAll(async () => {
    managedRoot = await mkdtemp(join(tmpdir(), "agent-runtime-integration-"));
    config = loadWorkerConfig({
      CONTROL_PLANE_URL: "ws://127.0.0.1:3000/api/workers/connect",
      WORKER_ID: "integration-worker",
      WORKER_TOKEN: "0123456789abcdef0123456789abcdef",
      WORKER_GATEWAY_TOKEN: "gateway0123456789abcdef0123456789abcdef",
      WORKSPACE_BASE_URL: "https://agent.example.internal",
      WORKER_MAX_WORKSPACES: "2",
      WORKER_MANAGED_ROOT: managedRoot,
      RUNTIME_IMAGE: runtimeImage,
      WORKSPACE_CPU_COUNT: String(resources.cpuCount),
      WORKSPACE_MEMORY_BYTES: String(resources.memoryBytes),
      WORKSPACE_PIDS_LIMIT: String(resources.pidsLimit),
      WORKSPACE_START_TIMEOUT_MS: "60000",
    });
    docker = new Docker({ socketPath: config.DOCKER_SOCKET_PATH });
    runtime = new DockerWorkspaceRuntime(
      config,
      docker,
      undefined,
      ASSUMED_ENFORCED,
      ASSUMED_STORAGE,
    );
  });

  it("passes the full Runtime toolchain and browser smoke tests", async () => {
    const image = await docker.getImage(runtimeImage).inspect();
    const architecture = currentArchitecture(process.arch);
    expect(image).toMatchObject({ Architecture: architecture, Os: "linux" });

    const smoke = await docker.createContainer({
      Image: runtimeImage,
      Entrypoint: ["/usr/local/bin/runtime-smoke"],
      User: "1000:1000",
      WorkingDir: "/tmp",
      Tty: true,
      HostConfig: {
        AutoRemove: false,
        CapDrop: ["ALL"],
        Memory: resources.memoryBytes,
        NetworkMode: "none",
        PidsLimit: resources.pidsLimit,
        Privileged: false,
        SecurityOpt: ["no-new-privileges:true"],
      },
    });
    try {
      await smoke.start();
      const result = (await smoke.wait()) as { StatusCode?: unknown };
      if (result.StatusCode !== 0) {
        const output = await smoke.logs({ stdout: true, stderr: true });
        throw new Error(`Runtime smoke failed:\n${output.toString("utf8")}`);
      }
    } finally {
      await smoke.remove({ force: true });
    }

    const log = { error: () => undefined, warn: () => undefined };
    const catalog = new DockerRuntimeImageCatalog(configuredRuntimeImages(config), docker, log);
    const reports = await new DockerRuntimeCapabilityProbe(config, catalog, log, docker).probe(architecture);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      image: runtimeImage,
      imageId: (await docker.getImage(runtimeImage).inspect()).Id,
      capabilities: {
        browser: true,
        office: true,
        ffmpeg: true,
        python: true,
        node: true,
        rust: true,
      },
    });
  }, 180_000);

  afterAll(async () => {
    if (workerGateway !== undefined) {
      await new Promise<void>((resolve) => workerGateway?.close(() => resolve()));
    }
    if (runtime !== undefined) {
      for (const cleanupWorkspaceId of [
        workspaceId,
        legacyWorkspaceId,
        upgradedWorkspaceId,
        ...isolationWorkspaceIds,
        limitsWorkspaceId,
        preQuotaWorkspaceId,
        usageWorkspaceId,
      ]) {
        try {
          await runtime.delete(cleanupWorkspaceId);
        } catch {
          // The tests report the original failure; cleanup below remains scoped
          // to random container/network names and the temporary managed root.
        }
      }
    }
    for (const cleanupWorkspaceId of [
      workspaceId,
      legacyWorkspaceId,
      upgradedWorkspaceId,
      ...isolationWorkspaceIds,
      limitsWorkspaceId,
      preQuotaWorkspaceId,
      usageWorkspaceId,
    ]) {
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
      runtimeImage,
      resources,
      STORAGE,
    );
    expect((await runtime.start(workspaceId)).state).toBe("RUNNING");

    const inspection = await docker.getContainer(containerName).inspect();
    expect(inspection.Config.User).toBe("1000:1000");
    expect(inspection.Config.WorkingDir).toBe("/workspace");
    expect(inspection.Config.Env).toContain("PI_WEB_DEFAULT_CWD=/workspace");
    expect(inspection.HostConfig.Privileged).toBe(false);
    expect(inspection.HostConfig.NetworkMode).toBe(networkName);
    const network = await docker.getNetwork(networkName).inspect();
    expect(network.Options?.["com.docker.network.bridge.name"]).toBe(
      workspaceBridgeName(workspaceId),
    );
    expect(network.EnableIPv6).toBe(false);
    expect(inspection.HostConfig.CapDrop).toContain("ALL");
    expect(inspection.HostConfig.SecurityOpt).toContain(
      "no-new-privileges:true",
    );
    expect(inspection.HostConfig.Memory).toBe(resources.memoryBytes);
    expect(inspection.HostConfig.NanoCpus).toBe(1_000_000_000);
    expect(inspection.HostConfig.PidsLimit).toBe(resources.pidsLimit);
    expect(inspection.HostConfig.RestartPolicy?.Name).toBe("unless-stopped");
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
    await docker.getContainer(containerName).restart({ t: 5 });
    runtime = new DockerWorkspaceRuntime(
      config,
      docker,
      undefined,
      ASSUMED_ENFORCED,
      ASSUMED_STORAGE,
    );
    const recovery = await runtime.reconcile([
      {
        workspaceId,
        runtimeImage,
        desiredState: "RUNNING",
        diskLimitBytes: STORAGE.diskLimitBytes,
      },
    ]);
    expect(recovery).toMatchObject({
      workspaces: [
        {
          status: "OBSERVED",
          workspace: { workspaceId, state: "RUNNING" },
        },
      ],
    });
    expect(
      recovery.issues.every((issue) => issue.workspaceId !== workspaceId),
    ).toBe(true);
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
      Image: runtimeImage,
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

  it("runs the Workspace on a read-only root with writable home, /tmp and bounded limits", async () => {
    await runtime.ensure(limitsWorkspaceId, runtimeImage, resources, STORAGE);
    await runtime.start(limitsWorkspaceId);
    const container = docker.getContainer(`agent-runtime-${limitsWorkspaceId}`);
    const run = (script: string) => execExitCode(container, ["sh", "-c", script]);

    // Only the binds and the bounded tmpfs are writable.
    for (const path of ["/usr/local/probe", "/opt/probe", "/etc/probe", "/usr/local/rustup/probe"]) {
      expect(await run(`touch ${path}`)).not.toBe(0);
    }
    for (const path of ["/workspace", "/home/agent", "/tmp", "/var/tmp", "/agent/pi", "/run/lock"]) {
      expect(await run(`touch ${path}/probe && rm ${path}/probe`)).toBe(0);
    }
    expect(await run('test "$(ulimit -n)" = 65536')).toBe(0);
    expect(await run('test "$(ulimit -c)" = 0')).toBe(0);
    expect(await run('test "$CARGO_HOME" = /home/agent/.cargo')).toBe(0);
    // The new home was seeded from /etc/skel.
    expect(await run("test -f /home/agent/.bashrc && test -f /home/agent/.profile")).toBe(0);

    const inspection = await container.inspect();
    expect(inspection.HostConfig.LogConfig).toEqual({
      Type: "json-file",
      Config: { "max-size": "10m", "max-file": "3" },
    });
    expect(inspection.HostConfig.Binds ?? []).toEqual([]);

    // A missing bind source (e.g. the quota filesystem is not mounted) fails the start
    // instead of Docker creating an empty directory on the root filesystem.
    await runtime.stop(limitsWorkspaceId);
    const home = join(managedRoot, "workspaces", limitsWorkspaceId, "home");
    await rename(home, `${home}.away`);
    await expect(runtime.start(limitsWorkspaceId)).rejects.toThrow();
    expect(existsSync(home)).toBe(false);
    await rename(`${home}.away`, home);
    await runtime.start(limitsWorkspaceId);

    // /tmp starts empty on the next Worker-initiated start.
    expect(await run("echo old > /tmp/left-over")).toBe(0);
    await runtime.stop(limitsWorkspaceId);
    await runtime.start(limitsWorkspaceId);
    expect(await run("test ! -e /tmp/left-over")).toBe(0);
    await runtime.stop(limitsWorkspaceId);
  }, 180_000);

  it("samples real container usage like docker stats and counts OOM events (Phase 17.5)", async () => {
    await runtime.ensure(usageWorkspaceId, runtimeImage, resources, STORAGE);
    await runtime.start(usageWorkspaceId);
    const name = `agent-runtime-${usageWorkspaceId}`;
    const container = docker.getContainer(name);
    const oom = new OomEventCounter({ source: runtime, log: { warn: () => undefined, debug: () => undefined } });
    oom.start();
    const sampler = new WorkspaceUsageSampler({ source: runtime, oom, cpuLimitCores: resources.cpuCount });
    const detached = async (script: string) => {
      const execution = await container.exec({ Cmd: ["sh", "-c", script] });
      await execution.start({ Detach: true });
    };
    try {
      // Two busy loops against a 1-core limit: about one core in use.
      await detached("yes > /dev/null & yes > /dev/null & sleep 40; kill %1 %2");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await sampler.sample();
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      const [busy] = (await sampler.sample()).filter((sample) => sample.workspaceId === usageWorkspaceId);
      expect(busy?.cpuCores).toBeGreaterThan(0.8);
      expect(busy?.cpuCores).toBeLessThan(1.1);
      expect(busy?.cpuLimitCores).toBe(1);
      expect(busy?.pidsLimit).toBe(resources.pidsLimit);

      // 300 MiB held in memory: the same figure `docker stats` prints.
      // Filled, not zero pages: zero-filled allocations may stay unbacked on some kernels.
      await detached(`python3 -c "import time; b = b'x' * (300 * 1024 * 1024); time.sleep(60)"`);
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      const [sample] = (await sampler.sample()).filter((entry) => entry.workspaceId === usageWorkspaceId);
      const cli = JSON.parse(
        execFileSync("docker", ["stats", "--no-stream", "--format", "{{json .}}", name], { encoding: "utf8" }),
      ) as { MemUsage: string };
      const [used] = cli.MemUsage.split(" / ");
      const cliBytes = Number.parseFloat(used ?? "0") * (used?.endsWith("GiB") ? 1024 ** 3 : 1024 ** 2);
      expect(sample?.memoryBytes).toBeGreaterThan(300 * 1024 ** 2);
      expect(Math.abs((sample?.memoryBytes ?? 0) - cliBytes)).toBeLessThan(Math.max(20 * 1024 ** 2, cliBytes * 0.05));
      expect(sample?.memoryLimitBytes).toBe(resources.memoryBytes);

      // Beyond the 1 GiB limit: the kernel kills the process and Docker reports an OOM event.
      // The allocation above is released first so the new one is the only large process.
      await execExitCode(container, ["sh", "-c", "pkill -f 'time.sleep\\(60\\)' || true"]);
      // 3 GiB of written memory exceeds the 1 GiB limit plus its swap allowance.
      expect(await execExitCode(container, ["python3", "-c", "b = b'x' * (3 * 1024 ** 3)"])).not.toBe(0);
      await expect.poll(() => oom.count(usageWorkspaceId), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
      const [afterOom] = (await sampler.sample()).filter((entry) => entry.workspaceId === usageWorkspaceId);
      expect(afterOom?.oomKills).toBeGreaterThanOrEqual(1);
    } finally {
      oom.stop();
      await runtime.stop(usageWorkspaceId);
    }
  }, 180_000);

  it("never starts a pre-Phase-15 container, but stops and deletes it", async () => {
    const name = `agent-runtime-${preQuotaWorkspaceId}`;
    await runtime.ensure(preQuotaWorkspaceId, runtimeImage, resources, STORAGE);
    const current = await docker.getContainer(name).inspect();
    await docker.getContainer(name).remove({ force: true });
    const legacyMounts = current.Mounts.filter(
      (mount) => mount.Destination === "/workspace" || mount.Destination === "/agent/pi",
    );
    await docker.createContainer({
      name,
      Image: current.Config.Image,
      User: current.Config.User,
      WorkingDir: current.Config.WorkingDir,
      Env: current.Config.Env,
      ExposedPorts: { "30141/tcp": {} },
      Labels: current.Config.Labels,
      HostConfig: {
        AutoRemove: false,
        Binds: legacyMounts.map((mount) => `${mount.Source}:${mount.Destination}:rw`),
        CapDrop: ["ALL"],
        Memory: resources.memoryBytes,
        NanoCpus: 1_000_000_000,
        NetworkMode: name,
        PidsLimit: resources.pidsLimit,
        PortBindings: { "30141/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
        Privileged: false,
        SecurityOpt: ["no-new-privileges:true"],
      },
    });
    for (const attempt of [
      () => runtime.ensure(preQuotaWorkspaceId, runtimeImage, resources, STORAGE),
      () => runtime.start(preQuotaWorkspaceId),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: "STORAGE_MIGRATION_REQUIRED" });
    }
    expect((await docker.getContainer(name).inspect()).State.Running).toBe(false);
    await expect(runtime.stop(preQuotaWorkspaceId)).resolves.toMatchObject({ state: "STOPPED" });

    // A pre-Phase-15 Workspace has no managed home yet (the ensure above made one).
    await rm(join(managedRoot, "workspaces", preQuotaWorkspaceId, "home"), {
      recursive: true,
      force: true,
    });

    // Data that only lives in the old container's writable layer.
    const legacy = docker.getContainer(name);
    await legacy.start();
    expect(
      await execExitCode(legacy, ["sh", "-c", "echo kept > /home/agent/marker && echo dropped > /tmp/scratch"]),
    ).toBe(0);
    await legacy.stop({ t: 5 });

    const migrate = (env: Record<string, string>) =>
      runScript(join(repositoryRoot, "tools/dev/migrate-legacy-workspace.sh"), [preQuotaWorkspaceId], {
        WORKER_MANAGED_ROOT: managedRoot,
        ...env,
      });
    // Wrong Worker: refused, nothing changed.
    expect((await migrate({ WORKER_ID: "someone-else" })).code).not.toBe(0);
    const migrated = await migrate({ WORKER_ID: "integration-worker" });
    expect(migrated.code, migrated.output).toBe(0);
    await expect(docker.getContainer(name).inspect()).rejects.toThrow();

    await runtime.ensure(preQuotaWorkspaceId, runtimeImage, resources, STORAGE);
    await runtime.start(preQuotaWorkspaceId);
    const recreated = docker.getContainer(name);
    expect(await execExitCode(recreated, ["sh", "-c", 'test "$(cat /home/agent/marker)" = kept'])).toBe(0);
    expect(await execExitCode(recreated, ["sh", "-c", "test ! -e /tmp/scratch && test -f /home/agent/.bashrc"])).toBe(0);
    // A second run finds nothing to migrate.
    expect((await migrate({ WORKER_ID: "integration-worker" })).code).not.toBe(0);
    await expect(runtime.stop(preQuotaWorkspaceId)).resolves.toMatchObject({ state: "STOPPED" });
    await expect(runtime.delete(preQuotaWorkspaceId)).resolves.toMatchObject({ state: "CREATED" });
  }, 180_000);

  it("manages and destructively deletes a pre-default-cwd container", async () => {
    const legacyName = `agent-runtime-${legacyWorkspaceId}`;
    await runtime.ensure(
      legacyWorkspaceId,
      runtimeImage,
      resources,
      STORAGE,
    );
    const currentContainer = docker.getContainer(legacyName);
    const current = await currentContainer.inspect();
    await currentContainer.remove({ force: true });

    await docker.createContainer({
      name: legacyName,
      Image: current.Config.Image,
      User: current.Config.User,
      WorkingDir: current.Config.WorkingDir,
      Env: current.Config.Env.filter(
        (entry) => entry !== "PI_WEB_DEFAULT_CWD=/workspace",
      ),
      ExposedPorts: { "30141/tcp": {} },
      Labels: current.Config.Labels,
      HostConfig: {
        AutoRemove: false,
        Mounts: current.HostConfig.Mounts ?? [],
        ReadonlyRootfs: true,
        Tmpfs: current.HostConfig.Tmpfs ?? {},
        Ulimits: current.HostConfig.Ulimits ?? [],
        LogConfig: current.HostConfig.LogConfig ?? { Type: "json-file", Config: {} },
        CapDrop: ["ALL"],
        Memory: resources.memoryBytes,
        NanoCpus: 1_000_000_000,
        NetworkMode: legacyName,
        PidsLimit: resources.pidsLimit,
        PortBindings: {
          "30141/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
        },
        Privileged: false,
        SecurityOpt: ["no-new-privileges:true"],
      },
    });

    const legacyRoot = join(managedRoot, "workspaces", legacyWorkspaceId);
    const persistentFile = join(legacyRoot, "workspace", "legacy.txt");
    await writeFile(persistentFile, "legacy persists", "utf8");

    await expect(
      runtime.ensure(
        legacyWorkspaceId,
        runtimeImage,
        resources,
        STORAGE,
      ),
    ).resolves.toMatchObject({ state: "STOPPED" });
    await expect(runtime.start(legacyWorkspaceId)).resolves.toMatchObject({
      state: "RUNNING",
    });
    await expect(runtime.inspect(legacyWorkspaceId)).resolves.toMatchObject({
      state: "RUNNING",
    });
    await expect(runtime.stop(legacyWorkspaceId)).resolves.toMatchObject({
      state: "STOPPED",
    });
    expect(await readFile(persistentFile, "utf8")).toBe("legacy persists");

    await expect(runtime.delete(legacyWorkspaceId)).resolves.toMatchObject({
      state: "CREATED",
    });
    await expect(docker.getContainer(legacyName).inspect()).rejects.toThrow();
    expect(
      (await docker.listNetworks({ filters: { name: [legacyName] } })).filter(
        (network) => network.Name === legacyName,
      ),
    ).toHaveLength(0);
    expect(existsSync(legacyRoot)).toBe(false);
  }, 120_000);

  it("deletes a same-Worker Runtime after its configured image changes without rewriting metadata", async () => {
    await runtime.ensure(upgradedWorkspaceId, runtimeImage, resources, STORAGE);
    const name = `agent-runtime-${upgradedWorkspaceId}`;
    const workspaceRoot = join(managedRoot, "workspaces", upgradedWorkspaceId);
    const metadataPath = join(workspaceRoot, "metadata", "managed.json");
    const originalMetadata = await readFile(metadataPath, "utf8");
    const artifactPath = join(workspaceRoot, "workspace", "legacy-artifact.txt");
    await writeFile(artifactPath, "historical image data", "utf8");

    const upgradedRuntime = new DockerWorkspaceRuntime(
      { ...config, RUNTIME_IMAGE: "agent-runtime:future-toolchain" },
      docker,
      undefined,
      ASSUMED_ENFORCED,
    );
    await expect(upgradedRuntime.inspect(upgradedWorkspaceId)).resolves.toMatchObject({
      state: "STOPPED",
      runtimeImage,
    });
    // The image is no longer offered: it can be inspected and deleted, not started (18.4).
    await expect(upgradedRuntime.start(upgradedWorkspaceId)).rejects.toMatchObject({
      code: "RUNTIME_IMAGE_UNAVAILABLE",
    });
    expect(await readFile(metadataPath, "utf8")).toBe(originalMetadata);

    await expect(upgradedRuntime.delete(upgradedWorkspaceId)).resolves.toMatchObject({
      state: "CREATED",
      runtimeImage,
    });
    await expect(docker.getContainer(name).inspect()).rejects.toThrow();
    expect(
      (await docker.listNetworks({ filters: { name: [name] } })).filter(
        (network) => network.Name === name,
      ),
    ).toHaveLength(0);
    expect(existsSync(workspaceRoot)).toBe(false);
  }, 120_000);

  it("switches a stopped Workspace to another image and back, keeping its data (Phase 18.4)", async () => {
    const changedWorkspaceId = randomUUID();
    const repository = runtimeImage.split(":")[0] ?? "agent-runtime";
    const tag = `phase18-integration-${changedWorkspaceId.slice(0, 8)}`;
    const secondImage = `${repository}:${tag}`;
    const imageId = (await docker.getImage(runtimeImage).inspect()).Id;
    await docker.getImage(runtimeImage).tag({ repo: repository, tag });
    const offered = new Map(
      [runtimeImage, secondImage].map((image, index) => [
        image,
        { image, imageId, runtimeVersion: `v${index}`, piWebVersion: null, piVersion: null },
      ]),
    );
    const multiRuntime = new DockerWorkspaceRuntime(
      config,
      docker,
      undefined,
      ASSUMED_ENFORCED,
      ASSUMED_STORAGE,
      { find: (image) => offered.get(image) ?? null },
    );
    const name = `agent-runtime-${changedWorkspaceId}`;
    const workspaceRoot = join(managedRoot, "workspaces", changedWorkspaceId);
    try {
      await multiRuntime.ensure(changedWorkspaceId, runtimeImage, resources, STORAGE);
      await multiRuntime.start(changedWorkspaceId);
      const before = await docker.getContainer(name).inspect();
      await writeFile(join(workspaceRoot, "workspace", "kept.txt"), "kept across images", "utf8");
      await writeFile(join(workspaceRoot, "pi", "kept.json"), "{}", "utf8");
      await multiRuntime.stop(changedWorkspaceId);

      await expect(
        multiRuntime.setRuntime(changedWorkspaceId, runtimeImage, secondImage),
      ).resolves.toMatchObject({ state: "STOPPED", runtimeImage: secondImage });
      const after = await docker.getContainer(name).inspect();
      expect(after.Id).not.toBe(before.Id);
      expect(after.Config.Image).toBe(secondImage);
      expect(after.Image).toBe(imageId);
      expect(after.State.Running).toBe(false);
      // Same container configuration apart from the image reference.
      expect(after.HostConfig).toMatchObject({
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        Privileged: false,
        NetworkMode: before.HostConfig.NetworkMode,
        Memory: before.HostConfig.Memory,
        NanoCpus: before.HostConfig.NanoCpus,
        PidsLimit: before.HostConfig.PidsLimit,
      });
      expect(after.Mounts.map((mount) => [mount.Source, mount.Destination]).sort()).toEqual(
        before.Mounts.map((mount) => [mount.Source, mount.Destination]).sort(),
      );
      expect(after.Config.Env.sort()).toEqual(before.Config.Env.sort());

      await expect(multiRuntime.start(changedWorkspaceId)).resolves.toMatchObject({
        state: "RUNNING",
        runtimeImage: secondImage,
      });
      expect(await readFile(join(workspaceRoot, "workspace", "kept.txt"), "utf8")).toBe("kept across images");
      expect(await readFile(join(workspaceRoot, "pi", "kept.json"), "utf8")).toBe("{}");
      await multiRuntime.stop(changedWorkspaceId);

      await expect(
        multiRuntime.setRuntime(changedWorkspaceId, secondImage, runtimeImage),
      ).resolves.toMatchObject({ runtimeImage });
      await expect(multiRuntime.start(changedWorkspaceId)).resolves.toMatchObject({ state: "RUNNING" });
      expect(await readFile(join(workspaceRoot, "workspace", "kept.txt"), "utf8")).toBe("kept across images");
    } finally {
      await multiRuntime.delete(changedWorkspaceId).catch(() => undefined);
      await docker.getImage(secondImage).remove({ noprune: true }).catch(() => undefined);
    }
    expect(existsSync(workspaceRoot)).toBe(false);
  }, 240_000);

  it("keeps Workspace bridges isolated from each other and host loopback", async () => {
    const [workspaceA, workspaceB] = isolationWorkspaceIds;
    await runtime.ensure(workspaceA, runtimeImage, resources, STORAGE);
    await runtime.ensure(workspaceB, runtimeImage, resources, STORAGE);
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

  it("migrates a stopped Workspace from a legacy br- network to the arw- bridge", async () => {
    const migratedId = randomUUID();
    const name = `agent-runtime-${migratedId}`;
    try {
      await runtime.ensure(migratedId, runtimeImage, resources, STORAGE);
      await writeFile(
        join(managedRoot, "workspaces", migratedId, "workspace", "kept.txt"),
        "kept",
        "utf8",
      );
      // Recreate the pre-Phase-14 network: same identity, Docker's default bridge name.
      const current = await docker.getNetwork(name).inspect();
      const container = await docker.getContainer(name).inspect();
      await docker.getNetwork(name).disconnect({ Container: container.Id, Force: true });
      await docker.getNetwork(name).remove();
      const legacy = await docker.createNetwork({
        Name: name,
        Driver: "bridge",
        Labels: current.Labels,
        Options: {
          "com.docker.network.bridge.enable_icc": "false",
          "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1",
        },
      });
      await legacy.connect({ Container: container.Id });
      const legacyId = (await legacy.inspect()).Id;

      await expect(runtime.ensure(migratedId, runtimeImage, resources, STORAGE)).resolves.toMatchObject({
        state: "STOPPED",
      });
      const migrated = await docker.getNetwork(name).inspect();
      expect(migrated.Id).not.toBe(legacyId);
      expect(migrated.Options?.["com.docker.network.bridge.name"]).toBe(
        workspaceBridgeName(migratedId),
      );
      await expect(runtime.start(migratedId)).resolves.toMatchObject({ state: "RUNNING" });
      const running = await docker.getContainer(name).inspect();
      expect(Object.keys(running.NetworkSettings.Networks)).toEqual([name]);
      await expect(
        readFile(join(managedRoot, "workspaces", migratedId, "workspace", "kept.txt"), "utf8"),
      ).resolves.toBe("kept");
    } finally {
      await runtime.delete(migratedId).catch(() => undefined);
    }
  });
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
  // Drain output; an unread stream never ends.
  stream.resume();
  await once(stream, "end");
  return (await execution.inspect()).ExitCode ?? -1;
}
