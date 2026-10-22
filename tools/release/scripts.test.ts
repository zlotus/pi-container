// Operator scripts refuse what they must refuse (specs.md Phase 19.12): release.sh and
// agent-runtime-image check checksums before touching anything, agent-runtime-image only
// accepts labelled agent-runtime images, build-runtime-image.sh never rebuilds a tag.
// Needs Docker for the image cases: TEST_DEPLOY=1 pnpm test:deploy
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RELEASE_SH = join(ROOT, "deploy", "production", "scripts", "release.sh");
const IMAGE_TOOL = join(ROOT, "deploy", "production", "bin", "agent-runtime-image");
const BUILD_IMAGE = join(ROOT, "deploy", "production", "scripts", "build-runtime-image.sh");
const NGINX = "nginx:1.30.6-alpine@sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5";
const ARCH = process.arch === "arm64" ? "arm64" : "amd64";

const describeWithDocker = process.env.TEST_DEPLOY === "1" ? describe : describe.skip;

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function run(command: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(command, args, { encoding: "utf8", env: { ...process.env, ...env } });
}

describe("release.sh", () => {
  let work = "";
  let archive = "";
  const version = "9.9.9-test";

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "agent-runtime-release-sh-"));
    const stage = join(work, "stage", `agent-runtime-${version}`);
    await mkdir(join(stage, "bin"), { recursive: true });
    await writeFile(join(stage, "release.json"), JSON.stringify({ version }));
    archive = join(work, `agent-runtime-${version}-linux-${ARCH}.tar.gz`);
    execFileSync("tar", ["-C", join(work, "stage"), "-czf", archive, `agent-runtime-${version}`]);
    await writeFile(
      join(work, `SHA256SUMS-${version}-${ARCH}`),
      `${sha256(await readFile(archive))}  agent-runtime-${version}-linux-${ARCH}.tar.gz\n`,
    );
  });

  afterAll(async () => {
    if (work !== "") await rm(work, { recursive: true, force: true });
  });

  it("refuses an archive that does not match its checksum and installs nothing", async () => {
    const root = join(work, "tampered-root");
    const tamperedDirectory = join(work, "tampered");
    await mkdir(tamperedDirectory);
    const tampered = join(tamperedDirectory, `agent-runtime-${version}-linux-${ARCH}.tar.gz`);
    await writeFile(tampered, Buffer.concat([await readFile(archive), Buffer.from("x")]));
    await writeFile(
      join(tamperedDirectory, `SHA256SUMS-${version}-${ARCH}`),
      await readFile(join(work, `SHA256SUMS-${version}-${ARCH}`)),
    );
    const result = run(RELEASE_SH, ["install", tampered], { AGENT_RUNTIME_ROOT: root });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("checksum mismatch");
    expect(existsSync(join(root, "releases", version))).toBe(false);
  });

  it("installs, activates atomically and protects the active release", () => {
    const root = join(work, "root");
    const env = { AGENT_RUNTIME_ROOT: root };
    expect(run(RELEASE_SH, ["install", archive], env).status).toBe(0);
    expect(run(RELEASE_SH, ["install", archive], env).stderr).toContain("already installed");
    expect(run(RELEASE_SH, ["activate", version], env).status).toBe(0);
    expect(execFileSync("readlink", [join(root, "current")]).toString().trim()).toBe(`releases/${version}`);
    expect(run(RELEASE_SH, ["prune", version], env).stderr).toContain("is active");
    expect(run(RELEASE_SH, ["activate", "../../etc"], env).status).not.toBe(0);
  });
});

describeWithDocker("agent-runtime-image and build-runtime-image.sh", () => {
  let work = "";
  const unlabelled = `agent-runtime:unlabelled-test-${process.pid}`;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "agent-runtime-image-tool-"));
    execFileSync("docker", ["pull", "-q", NGINX], { stdio: "ignore" });
    execFileSync("docker", ["tag", NGINX, unlabelled]);
  }, 120_000);

  afterAll(async () => {
    spawnSync("docker", ["rmi", unlabelled], { stdio: "ignore" });
    if (work !== "") await rm(work, { recursive: true, force: true });
  });

  it("does not load an archive whose checksum does not match", async () => {
    const archive = join(work, "agent-runtime_x_linux-arm64.tar.zst");
    await writeFile(archive, "not an image");
    await writeFile(`${archive}.sha256`, `${"0".repeat(64)}  agent-runtime_x_linux-arm64.tar.zst\n`);
    const result = run(IMAGE_TOOL, ["load", archive]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("checksum mismatch");
  });

  it("does not offer an image without a runtime version label or with another name", () => {
    expect(run(IMAGE_TOOL, ["verify", unlabelled]).stderr).toContain("has no io.agent-runtime.runtime.version label");
    expect(run(IMAGE_TOOL, ["verify", NGINX]).stderr).toContain("expected an image named agent-runtime:<tag>");
  });

  it("never rebuilds an existing tag", () => {
    const result = run(BUILD_IMAGE, [unlabelled.replace("agent-runtime:", ""), work]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already exists on this host");
  });
});
