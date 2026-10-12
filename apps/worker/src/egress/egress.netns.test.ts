/**
 * Real-kernel egress test (specs.md Phase 14.9). It needs CAP_NET_ADMIN in a network
 * namespace, so it only runs through `pnpm --filter @agent-runtime/worker test:egress`,
 * which starts vitest inside `unshare --user --map-root-user --net` (no host changes, no
 * Docker). Every "host" below is a network namespace on veth links with directly
 * connected routes, so Clash TUN or Tailscale on the developer machine cannot interfere.
 *
 *   container (172.30.0.2) --arw-test0000001-- [Worker host] --veth-- LAN host (10.99.0.2)
 *   other     (172.31.0.2) --br-other----------/      |       \-veth-- public host (203.0.113.2)
 *                                         listener :3100 on every host address
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { EgressController } from "./controller.js";
import { ExecNftClient } from "./nft.js";
import { effectiveEgressRules, verifyEgressListing } from "./ruleset.js";

const enabled = process.env.TEST_EGRESS_NETNS === "1";
const BASE_RULESET = new URL("../../../../deploy/egress/agent-runtime-egress.nft", import.meta.url)
  .pathname;
const NFT = process.env.TEST_EGRESS_NFT_PATH ?? "/usr/sbin/nft";

const children: ChildProcess[] = [];
/** Controller warnings, so a failed expectation shows why the rules were not enforced. */
const warnings: string[] = [];

function run(command: string, args: readonly string[]): string {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function ip(...args: string[]): void {
  run("ip", args);
}

/** A network namespace kept alive by a sleeping child process. */
function namespace(): number {
  const child = spawn("unshare", ["--net", "sleep", "3600"], { stdio: "ignore" });
  children.push(child);
  if (child.pid === undefined) throw new Error("could not create a network namespace");
  return child.pid;
}

function inNamespace(pid: number, command: string, args: readonly string[]): string {
  return run("nsenter", ["-t", String(pid), "-n", command, ...args]);
}

/** Answers every TCP connection with `name\n`, then echoes; listens on all addresses. */
const SERVER = `
const net = require("node:net");
const [name, ...ports] = process.argv.slice(1);
for (const port of ports) {
  for (const host of ["0.0.0.0", "::"]) {
    net.createServer((socket) => {
      socket.write(name + "\\n");
      socket.on("data", (data) => socket.write(data));
      socket.on("error", () => {});
    }).listen({ port: Number(port), host, ipv6Only: host === "::" });
  }
}
`;

function server(pid: number | null, name: string, ports: number[]): void {
  const args = ["-e", SERVER, name, ...ports.map(String)];
  const child =
    pid === null
      ? spawn(process.execPath, args, { stdio: "ignore" })
      : spawn("nsenter", ["-t", String(pid), "-n", process.execPath, ...args], { stdio: "ignore" });
  children.push(child);
}

/** Returns the greeting of a TCP service, or null on timeout/refusal. */
const CLIENT = `
const net = require("node:net");
const [host, port] = process.argv.slice(1);
const socket = net.connect({ host, port: Number(port) });
socket.setTimeout(1500, () => { process.stdout.write("TIMEOUT"); process.exit(0); });
socket.once("data", (data) => { process.stdout.write(data.toString().trim()); process.exit(0); });
socket.on("error", () => { process.stdout.write("ERROR"); process.exit(0); });
`;

function greeting(pid: number | null, host: string, port: number): string | null {
  const args = ["-e", CLIENT, host, String(port)];
  const output =
    pid === null
      ? run(process.execPath, args)
      : inNamespace(pid, process.execPath, args);
  return output === "TIMEOUT" || output === "ERROR" ? null : output;
}

async function waitForListeners(): Promise<void> {
  await vi.waitFor(() => expect(greeting(null, "10.99.0.2", 80)).toBe("lan"), {
    timeout: 5_000,
    interval: 100,
  });
  await vi.waitFor(() => expect(greeting(null, "127.0.0.1", 3100)).toBe("worker-host"), {
    timeout: 5_000,
    interval: 100,
  });
}

describe.skipIf(!enabled)("egress rules on a real kernel", { timeout: 30_000 }, () => {
  let container = 0;
  let other = 0;
  let stateRoot = "";
  let controller: EgressController;
  const nft = new ExecNftClient(NFT);

  beforeAll(async () => {
    run("sysctl", ["-qw", "net.ipv4.ip_forward=1"]);
    ip("link", "set", "lo", "up");
    container = namespace();
    other = namespace();
    const lan = namespace();
    const pub = namespace();

    const bridge = (name: string, cidr: string, v6?: string) => {
      ip("link", "add", name, "type", "bridge");
      ip("addr", "add", cidr, "dev", name);
      if (v6 !== undefined) ip("-6", "addr", "add", v6, "dev", name, "nodad");
      ip("link", "set", name, "up");
    };
    const attach = (pid: number, hostSide: string, bridgeName: string | null, cidr: string, gateway: string, hostCidr?: string) => {
      ip("link", "add", hostSide, "type", "veth", "peer", "name", "eth0", "netns", String(pid));
      if (bridgeName !== null) ip("link", "set", hostSide, "master", bridgeName);
      if (hostCidr !== undefined) ip("addr", "add", hostCidr, "dev", hostSide);
      ip("link", "set", hostSide, "up");
      inNamespace(pid, "ip", ["link", "set", "lo", "up"]);
      inNamespace(pid, "ip", ["addr", "add", cidr, "dev", "eth0"]);
      inNamespace(pid, "ip", ["link", "set", "eth0", "up"]);
      inNamespace(pid, "ip", ["route", "add", "default", "via", gateway]);
    };

    bridge("arw-test0000001", "172.30.0.1/24", "fd00:30::1/64");
    bridge("br-other", "172.31.0.1/24");
    attach(container, "vc-arw", "arw-test0000001", "172.30.0.2/24", "172.30.0.1");
    inNamespace(container, "ip", ["-6", "addr", "add", "fd00:30::2/64", "dev", "eth0", "nodad"]);
    attach(other, "vc-other", "br-other", "172.31.0.2/24", "172.31.0.1");
    attach(lan, "vc-lan", null, "10.99.0.2/24", "10.99.0.1", "10.99.0.1/24");
    attach(pub, "vc-pub", null, "203.0.113.2/24", "203.0.113.1", "203.0.113.1/24");

    server(lan, "lan", [80, 8080]);
    server(pub, "public", [80]);
    server(null, "worker-host", [3100]);
    server(null, "relay", [3101]);
    // Control Plane metrics, Prometheus and Grafana on a Worker host (Phase 17.8).
    server(null, "observability", [9464, 9090, 3300]);
    server(container, "pi-web", [30141]);
    await waitForListeners();

    stateRoot = await mkdtemp(join(tmpdir(), "agent-runtime-egress-netns-"));
    controller = new EgressController({
      nft,
      stateDirectory: join(stateRoot, "egress"),
      resolveLocalProtected: async () => [],
      log: {
        info: () => undefined,
        warn: (fields: object, message?: string) => {
          warnings.push(`${message ?? ""} ${JSON.stringify(fields)}`);
        },
      },
    });
  });

  afterAll(async () => {
    for (const child of children) child.kill("SIGKILL");
    if (stateRoot !== "") await rm(stateRoot, { recursive: true, force: true });
  });

  it("reaches everything before the egress table exists (topology sanity check)", () => {
    expect(greeting(container, "10.99.0.2", 80)).toBe("lan");
    expect(greeting(container, "172.30.0.1", 3100)).toBe("worker-host");
    expect(greeting(container, "fd00:30::1", 3100)).toBe("worker-host");
  });

  it("enforces the base rules: public allowed, internal and Worker host denied", async () => {
    const status = await controller.initialize();
    expect(status, warnings.join("\n")).toEqual({ enforced: true, revision: null });

    expect(greeting(container, "203.0.113.2", 80)).toBe("public");
    expect(greeting(container, "10.99.0.2", 80)).toBeNull();
    // Every Worker host address: the bridge gateway, other interfaces, the public side.
    expect(greeting(container, "172.30.0.1", 3100)).toBeNull();
    expect(greeting(container, "10.99.0.1", 3100)).toBeNull();
    expect(greeting(container, "203.0.113.1", 3100)).toBeNull();
    expect(greeting(container, "fd00:30::1", 3100)).toBeNull();
  });

  it("leaves non-Workspace bridges and inbound pi-web connections working", () => {
    expect(greeting(other, "10.99.0.2", 80)).toBe("lan");
    // The Worker Gateway's path to pi-web: replies from the container must pass.
    expect(greeting(null, "172.30.0.2", 30141)).toBe("pi-web");
  });

  it("opens only the whitelisted service, and protected addresses override the whitelist", async () => {
    await controller.apply({
      revision: 1,
      allow: [{ network: "10.99.0.2/32", protocol: "tcp", portMin: 80, portMax: 80 }],
      denyExtra: [],
      protected: [],
    });
    expect(greeting(container, "10.99.0.2", 80)).toBe("lan");
    expect(greeting(container, "10.99.0.2", 8080)).toBeNull();

    await controller.apply({
      revision: 2,
      allow: [{ network: "10.99.0.0/24" }],
      denyExtra: [],
      protected: ["10.99.0.2/32"],
    });
    expect(greeting(container, "10.99.0.2", 80)).toBeNull();
    expect(greeting(container, "10.99.0.1", 3100)).toBeNull();
  });

  it("cuts an established connection when its whitelist entry is removed", async () => {
    await controller.apply({
      revision: 3,
      allow: [{ network: "10.99.0.2/32", protocol: "tcp", portMin: 80, portMax: 80 }],
      denyExtra: [],
      protected: [],
    });
    // Sends one probe every 100 ms for 3 s and prints the time of every echo received.
    const client = spawn(
      "nsenter",
      [
        "-t",
        String(container),
        "-n",
        process.execPath,
        "-e",
        `
        const net = require("node:net");
        const started = Date.now();
        const socket = net.connect({ host: "10.99.0.2", port: 80 });
        socket.on("data", () => process.stdout.write((Date.now() - started) + "\\n"));
        socket.on("error", () => {});
        const timer = setInterval(() => socket.write("x"), 100);
        setTimeout(() => { clearInterval(timer); process.exit(0); }, 3000);
        `,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    children.push(client);
    let output = "";
    client.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const exited = new Promise<void>((resolve) => client.once("exit", () => resolve()));
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await controller.apply({ revision: 4, allow: [], denyExtra: [], protected: [] });
    const revokedAfterMs = Date.now() - startedAt;
    await exited;

    const echoes = output.trim().split("\n").filter((line) => line !== "").map(Number);
    expect(echoes.some((at) => at < revokedAfterMs - 200)).toBe(true);
    expect(echoes.filter((at) => at > revokedAfterMs + 300)).toEqual([]);
  });

  it("denies administrator-added ranges outside RFC1918", async () => {
    await controller.apply({ revision: 5, allow: [], denyExtra: ["203.0.113.0/24"], protected: [] });
    expect(greeting(container, "203.0.113.2", 80)).toBeNull();
    await controller.apply({ revision: 6, allow: [], denyExtra: [], protected: [] });
    expect(greeting(container, "203.0.113.2", 80)).toBe("public");
  });

  it("restores a deleted table and reports the drift", async () => {
    run(NFT, ["delete", "table", "inet", "agent_runtime"]);
    expect(greeting(container, "10.99.0.2", 80)).toBe("lan");
    await expect(controller.ensure()).resolves.toEqual({ enforced: true, revision: 6 });
    expect(greeting(container, "10.99.0.2", 80)).toBeNull();
  });

  it("loads the boot-time files, which match what the Worker verifies", async () => {
    // agent-runtime-egress.service fallback: the base file shipped in deploy/egress.
    run(NFT, ["-f", BASE_RULESET]);
    run(NFT, ["-f", BASE_RULESET]); // idempotent replace
    expect(verifyEgressListing(await nft.listTable(), effectiveEgressRules(null, []))).toEqual({
      ok: true,
    });
    expect(greeting(container, "10.99.0.2", 80)).toBeNull();

    // Primary path: the snapshot the Worker wrote after its last verified apply.
    await controller.apply({
      revision: 7,
      allow: [{ network: "10.99.0.2/32", protocol: "tcp", portMin: 80, portMax: 80 }],
      denyExtra: [],
      protected: [],
    });
    run(NFT, ["delete", "table", "inet", "agent_runtime"]);
    run(NFT, ["-j", "-f", join(stateRoot, "egress", "ruleset.json")]);
    expect(greeting(container, "10.99.0.2", 80)).toBe("lan");
    expect(greeting(container, "10.99.0.2", 8080)).toBeNull();
    await expect(controller.ensure()).resolves.toEqual({ enforced: true, revision: 7 });
  });
  it("opens only the model relay port to Workspace bridges (Phase 16.4)", async () => {
    const relayController = new EgressController({
      nft,
      stateDirectory: join(stateRoot, "egress-relay"),
      resolveLocalProtected: async () => [],
      relayPort: 3101,
      log: { info: () => undefined, warn: (fields: object, message?: string) => warnings.push(`${message ?? ""} ${JSON.stringify(fields)}`) },
    });
    const status = await relayController.initialize();
    expect(status, warnings.join("\n")).toEqual({ enforced: true, revision: null });
    expect(verifyEgressListing(await nft.listTable(), effectiveEgressRules(null, [], 3101))).toEqual({ ok: true });

    expect(greeting(container, "172.30.0.1", 3101)).toBe("relay");
    expect(greeting(container, "172.30.0.1", 3100)).toBeNull();
    expect(greeting(container, "10.99.0.1", 3100)).toBeNull();
    expect(greeting(container, "10.99.0.2", 80)).toBeNull();
    expect(greeting(container, "fd00:30::1", 3101)).toBeNull();
    // Not a Workspace bridge: the relay port is dropped on input.
    expect(greeting(other, "172.31.0.1", 3101)).toBeNull();
    expect(greeting(other, "172.31.0.1", 3100)).toBe("worker-host");
    expect(greeting(null, "127.0.0.1", 3101)).toBeNull();
    expect(greeting(null, "127.0.0.1", 3100)).toBe("worker-host");

    // Without the relay the port is closed again and the table is the Phase 14 one.
    await controller.ensure();
    expect(greeting(container, "172.30.0.1", 3101)).toBeNull();
    expect(greeting(other, "172.31.0.1", 3101)).toBe("relay");
  });

  it("keeps metrics, Prometheus and Grafana on the Worker host unreachable (Phase 17.8)", async () => {
    for (const relayPort of [null, 3101]) {
      const observed = new EgressController({
        nft,
        stateDirectory: join(stateRoot, `egress-observability-${relayPort ?? "none"}`),
        resolveLocalProtected: async () => [],
        relayPort,
        log: { info: () => undefined, warn: () => undefined },
      });
      expect((await observed.initialize()).enforced).toBe(true);
      for (const port of [9464, 9090, 3300]) {
        for (const address of ["172.30.0.1", "10.99.0.1", "203.0.113.1"]) {
          expect(greeting(container, address, port), `${address}:${port}`).toBeNull();
        }
        // A non-Workspace bridge and the host itself are unaffected.
        expect(greeting(other, "172.31.0.1", port)).toBe("observability");
        expect(greeting(null, "127.0.0.1", port)).toBe("observability");
      }
    }
    await controller.ensure();
  });
});
