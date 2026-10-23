// deploy/production/scripts/audit-host.sh flags every Workspace-container baseline
// violation (specs.md Phase 19.12). Creates (never starts) labelled containers that each
// break one rule. Needs Docker: TEST_DEPLOY=1 pnpm test:deploy
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AUDIT = join(ROOT, "deploy", "production", "scripts", "audit-host.sh");
const IMAGE = "nginx:1.30.6-alpine@sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5";
const MANAGED_ROOT = "/var/lib/agent-runtime-audit-test";
const SUFFIX = String(process.pid);

const describeWithDocker = process.env.TEST_DEPLOY === "1" ? describe : describe.skip;

/** A container that satisfies the baseline, plus one deliberate change. */
function baseline(name: string, extra: string[]): string[] {
  return [
    "create", "--name", `audit-${name}-${SUFFIX}`,
    "--label", "app=agent-runtime-platform",
    "--user", "1000:1000",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--read-only",
    "--memory", "256m", "--cpus", "1", "--pids-limit", "64",
    "-p", "127.0.0.1::80",
    "--mount", `type=bind,source=/tmp,destination=/workspace,bind-propagation=rprivate`,
    ...extra,
    IMAGE,
  ];
}

const CASES: Array<[string, string[], string]> = [
  ["privileged", ["--privileged"], "privileged"],
  ["capadd", ["--cap-add", "NET_ADMIN"], "capabilities added"],
  ["hostnet", ["--network", "host"], "shares a host or container network"],
  ["root", ["--user", "0"], "runs as root"],
  ["socket", ["-v", "/var/run/docker.sock:/var/run/docker.sock"], "Docker socket mounted"],
  ["publicport", ["-p", "0.0.0.0::81"], "port published on 0.0.0.0"],
];

describeWithDocker("audit-host.sh container baseline", () => {
  let output = "";

  beforeAll(() => {
    // nginx.docker.test.ts may still be pulling the same image in parallel.
    if (spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status !== 0) {
      execFileSync("docker", ["pull", IMAGE], { stdio: "ignore" });
    }
    for (const [name, extra] of CASES) execFileSync("docker", baseline(name, extra), { stdio: "ignore" });
    // Writable root and no limits: drop the hardening flags entirely.
    execFileSync("docker", [
      "create", "--name", `audit-bare-${SUFFIX}`, "--label", "app=agent-runtime-platform", IMAGE,
    ], { stdio: "ignore" });
    const result = spawnSync(AUDIT, ["--containers-only"], {
      env: { ...process.env, WORKER_MANAGED_ROOT: MANAGED_ROOT },
      encoding: "utf8",
    });
    output = result.stdout;
    expect(result.status).toBe(1);
  }, 60_000);

  afterAll(() => {
    for (const name of [...CASES.map(([case_]) => case_), "bare"]) {
      spawnSync("docker", ["rm", "-f", `audit-${name}-${SUFFIX}`], { stdio: "ignore" });
    }
  });

  it.each(CASES)("flags %s", (name, _extra, problem) => {
    expect(output).toContain(`FAIL  container audit-${name}-${SUFFIX}: ${problem}`);
  });

  it("flags a bind mount outside the managed root", () => {
    expect(output).toContain(`FAIL  container audit-privileged-${SUFFIX}: bind mount outside the managed root: /tmp -> /workspace`);
  });

  it("flags a container without any hardening", () => {
    for (const problem of [
      "capabilities not dropped",
      "no-new-privileges missing",
      "writable root filesystem",
      "runs as root",
      "no memory limit",
      "no CPU limit",
      "no PID limit",
    ]) {
      expect(output).toContain(`FAIL  container audit-bare-${SUFFIX}: ${problem}`);
    }
  });
});
