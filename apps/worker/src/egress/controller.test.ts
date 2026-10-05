import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EgressApplyError, EgressController, localProtectedResolver } from "./controller.js";
import { FakeNft } from "./test-support.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(nft = new FakeNft()) {
  const stateDirectory = join(await mkdtemp(join(tmpdir(), "agent-runtime-egress-")), "egress");
  directories.push(join(stateDirectory, ".."));
  const log = { info: vi.fn(), warn: vi.fn() };
  const resolveLocalProtected = vi.fn().mockResolvedValue(["10.0.0.5/32"]);
  const options = { nft, stateDirectory, resolveLocalProtected, log };
  return { nft, log, stateDirectory, options, controller: new EgressController(options) };
}

const POLICY = {
  revision: 5,
  allow: [{ network: "192.168.1.1/32", protocol: "tcp" as const, portMin: 80, portMax: 80 }],
  denyExtra: ["100.64.0.0/10"],
  protected: ["192.168.1.10/32"],
};

describe("egress controller", () => {
  it("installs the base rules on first start and persists the boot-time ruleset", async () => {
    const { nft, controller, stateDirectory } = await fixture();
    await expect(controller.initialize()).resolves.toEqual({ enforced: true, revision: null });
    expect(nft.applied).toHaveLength(1);
    const ruleset = JSON.parse(await readFile(join(stateDirectory, "ruleset.json"), "utf8"));
    expect(ruleset).toEqual(nft.applied[0]);
  });

  it("applies a policy, persists it and restores it after a Worker restart", async () => {
    const { nft, controller, options } = await fixture();
    await controller.initialize();
    await expect(controller.apply(POLICY)).resolves.toEqual({ enforced: true, revision: 5 });
    expect(JSON.stringify(nft.listing)).toContain("192.168.1.10");
    expect(JSON.stringify(nft.listing)).toContain("10.0.0.5");

    const restarted = new EgressController(options);
    await expect(restarted.initialize()).resolves.toEqual({ enforced: true, revision: 5 });
  });

  it("ignores a policy older than the applied revision", async () => {
    const { nft, controller } = await fixture();
    await controller.initialize();
    await controller.apply(POLICY);
    const applied = nft.applied.length;
    await expect(controller.apply({ ...POLICY, revision: 4, allow: [] })).resolves.toEqual({
      enforced: true,
      revision: 5,
    });
    expect(nft.applied).toHaveLength(applied);
  });

  it("re-applies drifted rules and reports it", async () => {
    const { nft, controller, log } = await fixture();
    await controller.initialize();
    await controller.apply(POLICY);
    nft.listing = null; // e.g. `nft flush ruleset`

    await expect(controller.ensure()).resolves.toEqual({ enforced: true, revision: 5 });
    expect(JSON.stringify(nft.listing)).toContain("192.168.1.10");
    expect(log.warn).toHaveBeenCalledWith(
      { revision: 5 },
      "egress rules were missing or changed and have been re-applied",
    );
  });

  it("is not enforced without permission to manage netfilter", async () => {
    const nft = new FakeNft();
    nft.denyPermission = true;
    const { controller, log } = await fixture(nft);

    await expect(controller.initialize()).resolves.toEqual({ enforced: false, revision: null });
    expect(controller.isEnforced()).toBe(false);
    await expect(controller.apply(POLICY)).rejects.toBeInstanceOf(EgressApplyError);
    expect(controller.status()).toEqual({ enforced: false, revision: null });
    expect(log.warn).toHaveBeenCalledWith(
      { reason: expect.stringContaining("Operation not permitted") as unknown },
      "egress rules are not enforced",
    );
  });

  it("keeps enforcing the previous policy when a new one fails to apply", async () => {
    const { nft, controller } = await fixture();
    await controller.initialize();
    await controller.apply(POLICY);
    nft.failNextApply = true;

    await expect(controller.apply({ ...POLICY, revision: 6, allow: [] })).rejects.toBeInstanceOf(
      EgressApplyError,
    );
    expect(controller.status()).toEqual({ enforced: true, revision: 5 });
    expect(JSON.stringify(nft.listing)).toContain("192.168.1.1");
  });

  it("ignores an invalid policy snapshot and enforces the base rules", async () => {
    const { controller, stateDirectory, nft } = await fixture();
    await controller.initialize();
    await writeFile(join(stateDirectory, "policy.json"), '{"revision":"x"}', "utf8");
    const restarted = new EgressController({
      nft,
      stateDirectory,
      resolveLocalProtected: async () => [],
      log: { info: vi.fn(), warn: vi.fn() },
    });
    await expect(restarted.initialize()).resolves.toEqual({ enforced: true, revision: null });
  });
});

describe("local protected addresses", () => {
  it("protects an address-literal Control Plane host and explicit entries", async () => {
    const resolve = localProtectedResolver("wss://10.1.2.3:3000/api/workers/connect", ["192.168.9.0/24"]);
    await expect(resolve()).resolves.toEqual(["10.1.2.3/32", "192.168.9.0/24"]);
  });

  it("protects every IPv4 address a Control Plane name resolves to", async () => {
    const lookup = vi.fn().mockResolvedValue(["100.70.1.2", "10.9.9.9"]);
    const resolve = localProtectedResolver("wss://cp.tailnet.ts.net/api/workers/connect", [], lookup);
    await expect(resolve()).resolves.toEqual(["10.9.9.9/32", "100.70.1.2/32"]);
    expect(lookup).toHaveBeenCalledWith("cp.tailnet.ts.net");
  });

  it("ignores an IPv6 Control Plane address (Workspace networks have no IPv6)", async () => {
    const resolve = localProtectedResolver("wss://[fd7a:115c::1]:3000/x", []);
    await expect(resolve()).resolves.toEqual([]);
  });
});
