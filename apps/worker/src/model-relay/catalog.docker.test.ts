import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelGatewayConfigSchema } from "@agent-runtime/protocol";
import Docker from "dockerode";
import { afterAll, describe, expect, it } from "vitest";

import { writePlatformProvider } from "./pi-config.js";

const describeWithDocker = process.env.TEST_DOCKER_RUNTIME === "1" ? describe : describe.skip;

/**
 * Old and new Runtimes share one platform catalog during an upgrade, so the rendered
 * models.json must load in every Pi version in use (specs.md Phase 18.7). Images that are
 * not present locally are skipped (CI builds only the current one).
 */
const IMAGES = [
  process.env.TEST_PREVIOUS_RUNTIME_IMAGE ?? "agent-runtime:phase7-toolchain",
  process.env.TEST_RUNTIME_IMAGE ?? "agent-runtime:2026.10-pi1.1",
];

describeWithDocker("platform model catalog in every Pi version (Phase 18.7)", () => {
  const docker = new Docker();
  const directories: string[] = [];

  afterAll(async () => {
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
  });

  for (const image of IMAGES) {
    it(`lists every platform model in ${image}`, async () => {
      const present = await docker.getImage(image).inspect().then(() => true, () => false);
      if (!present) return;
      const catalog = ModelGatewayConfigSchema.parse(
        JSON.parse(
          await readFile(new URL("../../../../deploy/model-gateway/catalog.example.json", import.meta.url), "utf8"),
        ),
      );
      const piDirectory = await mkdtemp(join(tmpdir(), "agent-runtime-catalog-"));
      directories.push(piDirectory);
      const write = await writePlatformProvider({
        piDirectory,
        config: catalog,
        relayOrigin: "http://172.30.0.1:3101",
        previousProviderId: null,
        uid: process.getuid?.() ?? 1000,
        gid: process.getgid?.() ?? 1000,
      });
      expect(write.result).toBe("applied");

      const container = await docker.createContainer({
        Image: image,
        Entrypoint: ["pi"],
        Cmd: ["--list-models", catalog.providerId],
        User: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        Env: ["PI_CODING_AGENT_DIR=/agent/pi", "PI_OFFLINE=1", "PI_SKIP_VERSION_CHECK=1", "PI_TELEMETRY=0"],
        HostConfig: {
          NetworkMode: "none",
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          Mounts: [{ Type: "bind", Source: piDirectory, Target: "/agent/pi", ReadOnly: false }],
        },
      });
      try {
        await container.start();
        const result = (await container.wait()) as { StatusCode?: number };
        const output = (await container.logs({ stdout: true, stderr: true })).toString("utf8");
        expect(result.StatusCode, output).toBe(0);
        for (const model of catalog.models) {
          expect(output, `${model.id} in ${image}`).toContain(model.id);
        }
        expect(output).not.toMatch(/error|invalid/i);
      } finally {
        await container.remove({ force: true });
      }
    }, 120_000);
  }
});
