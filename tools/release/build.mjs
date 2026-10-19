#!/usr/bin/env node
// Builds the platform release archive for this host's architecture (specs.md Phase 19.4.1):
// bundled Control Plane, Worker and operator CLIs, their production node_modules, the
// migrations, the Portal, the deployment templates and a pinned, checksum-verified Node.
//
//   pnpm release:build [--version <semver>] [--out <directory>]
//
// The version defaults to the exact git tag at HEAD (v1.0.0-rc.1 -> 1.0.0-rc.1), otherwise
// 0.0.0-<short commit> (acceptance builds). Writes
//   <out>/agent-runtime-<version>-linux-<arch>.tar.gz and <out>/SHA256SUMS-<version>-<arch>.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import console from "node:console";
import { arch } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Node.js runtime shipped in the release (Q9: 24 LTS). Checksums from the official
// https://nodejs.org/dist/v24.22.0/SHASUMS256.txt; change version and both sums together.
const NODE_VERSION = "24.22.0";
const NODE_SHA256 = {
  arm64: "fef00bb4d36e1c50104a9775a10359beee98f162b4104dd12472c75065c6a143",
  x64: "cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008",
};

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function run(command, args, options = {}) {
  const output = execFileSync(command, args, { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"], ...options });
  return (output ?? "").toString().trim();
}

function releaseVersion() {
  const explicit = argument("--version");
  if (explicit !== undefined) return explicit;
  try {
    return run("git", ["describe", "--tags", "--exact-match", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] })
      .replace(/^v/, "");
  } catch {
    return `0.0.0-${run("git", ["rev-parse", "--short=12", "HEAD"])}`;
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Downloads (once, cached) and verifies the official Node.js tarball; returns its bin/node. */
async function nodeBinary(nodeArch, cacheDirectory) {
  const name = `node-v${NODE_VERSION}-linux-${nodeArch}`;
  const archive = join(cacheDirectory, `${name}.tar.xz`);
  await mkdir(cacheDirectory, { recursive: true });
  if (!existsSync(archive)) {
    run("curl", ["-fsSL", "--retry", "3", "-o", archive, `https://nodejs.org/dist/v${NODE_VERSION}/${name}.tar.xz`]);
  }
  const actual = await sha256(archive);
  if (actual !== NODE_SHA256[nodeArch]) {
    await rm(archive, { force: true });
    throw new Error(`Node.js archive checksum mismatch for ${name}: ${actual}`);
  }
  const extracted = join(cacheDirectory, name);
  if (!existsSync(join(extracted, "bin", "node"))) {
    run("tar", ["-xJf", archive, "-C", cacheDirectory, `${name}/bin/node`, `${name}/LICENSE`]);
  }
  return extracted;
}

/** npm packages each app needs at run time: its own and those of the workspace packages. */
async function externalDependencies(appDirectory) {
  const seen = new Set();
  const external = new Set();
  async function visit(directory) {
    if (seen.has(directory)) return;
    seen.add(directory);
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (String(version).startsWith("workspace:")) {
        await visit(join(ROOT, "packages", name.replace("@agent-runtime/", "")));
      } else {
        external.add(name);
      }
    }
  }
  await visit(appDirectory);
  return [...external].sort();
}

async function bundleApp({ app, entries, outDirectory, version, commit }) {
  const appDirectory = join(ROOT, "apps", app);
  const external = await externalDependencies(appDirectory);
  await build({
    entryPoints: Object.fromEntries(entries.map(([out, source]) => [out, join(ROOT, source)])),
    outdir: outDirectory,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    // npm dependencies stay external and come from `pnpm deploy`; workspace packages
    // (@agent-runtime/*) are TypeScript sources and are bundled.
    external,
    define: {
      __AGENT_RUNTIME_VERSION__: JSON.stringify(version),
      __AGENT_RUNTIME_COMMIT__: JSON.stringify(commit),
    },
    legalComments: "none",
    logLevel: "warning",
  });
  // Production dependencies exactly as the lockfile resolves them, flat (no symlinks into
  // a store), then drop the workspace packages the bundle already contains.
  const deployDirectory = join(outDirectory, ".deploy");
  // `pnpm deploy` records its own (production, hoisted) settings as the workspace's install
  // state, after which every pnpm command in the checkout wants to reinstall; keep ours.
  const stateFile = join(ROOT, "node_modules", ".pnpm-workspace-state-v1.json");
  const state = existsSync(stateFile) ? await readFile(stateFile) : null;
  run("pnpm", [
    "--filter", `@agent-runtime/${app}`, "deploy", "--legacy", "--prod", "--frozen-lockfile",
    "--config.node-linker=hoisted", deployDirectory,
  ], { stdio: ["ignore", "ignore", "inherit"] });
  if (state !== null) await writeFile(stateFile, state);
  await rm(join(deployDirectory, "node_modules", "@agent-runtime"), { recursive: true, force: true });
  await cp(join(deployDirectory, "node_modules"), join(outDirectory, "node_modules"), { recursive: true, verbatimSymlinks: true });
  await rm(deployDirectory, { recursive: true, force: true });
  await rm(join(outDirectory, "node_modules", ".bin"), { recursive: true, force: true });
}

const nodeArch = arch() === "arm64" ? "arm64" : arch() === "x64" ? "x64" : null;
if (nodeArch === null) throw new Error(`Unsupported architecture ${arch()}`);
const platformArch = nodeArch === "x64" ? "amd64" : "arm64";
const version = releaseVersion();
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Release version must be semver, got ${version}`);
}
const commit = run("git", ["rev-parse", "HEAD"]);
const dirty = run("git", ["status", "--porcelain", "--untracked-files=no"]) !== "";
if (dirty && !process.argv.includes("--allow-dirty")) {
  throw new Error("The working tree has uncommitted changes; commit them or pass --allow-dirty (never for a release)");
}
const out = resolve(argument("--out") ?? join(ROOT, "dist", "release"));
const name = `agent-runtime-${version}`;
const stage = join(out, ".stage", name);
await rm(join(out, ".stage"), { recursive: true, force: true });
await mkdir(stage, { recursive: true });

console.log(`Building ${name} for linux/${platformArch} (${commit.slice(0, 12)}${dirty ? ", dirty" : ""})`);

// Portal
run("pnpm", ["--filter", "@agent-runtime/web", "build"], { stdio: ["ignore", "ignore", "inherit"] });
await cp(join(ROOT, "apps", "web", "dist"), join(stage, "portal"), { recursive: true });

// Applications. Migrations sit next to the app directories: the bundles find them at
// ../migrations relative to themselves, as the sources do.
await cp(join(ROOT, "packages", "database", "migrations"), join(stage, "app", "migrations"), { recursive: true });
await bundleApp({
  app: "control-plane",
  entries: [
    ["server", "apps/control-plane/src/server.ts"],
    ["create-user", "apps/control-plane/src/create-user.ts"],
    ["provision-worker", "apps/control-plane/src/provision-worker.ts"],
    ["unlock-auth", "apps/control-plane/src/unlock-auth.ts"],
    ["migrate", "packages/database/src/migrate-cli.ts"],
  ],
  outDirectory: join(stage, "app", "control-plane"),
  version,
  commit,
});
await bundleApp({
  app: "worker",
  entries: [["server", "apps/worker/src/server.ts"]],
  outDirectory: join(stage, "app", "worker"),
  version,
  commit,
});

// Node.js runtime
const node = await nodeBinary(nodeArch, join(ROOT, "dist", "cache"));
await mkdir(join(stage, "bin"), { recursive: true });
await copyFile(join(node, "bin", "node"), join(stage, "bin", "node"));
await chmod(join(stage, "bin", "node"), 0o755);
await mkdir(join(stage, "licenses"), { recursive: true });
await copyFile(join(node, "LICENSE"), join(stage, "licenses", "node.LICENSE"));

// Operator commands and deployment templates
const production = join(ROOT, "deploy", "production");
for (const entry of await readdir(join(production, "bin"))) {
  await copyFile(join(production, "bin", entry), join(stage, "bin", entry));
  await chmod(join(stage, "bin", entry), 0o755);
}
await cp(production, join(stage, "deploy"), {
  recursive: true,
  filter: (source) => !source.startsWith(join(production, "bin")),
});
await cp(join(ROOT, "deploy", "egress"), join(stage, "deploy", "egress"), { recursive: true });
await cp(join(ROOT, "deploy", "model-gateway", "config.yaml"), join(stage, "deploy", "model-gateway", "config.yaml"));
await cp(join(ROOT, "deploy", "model-gateway", "catalog.example.json"), join(stage, "deploy", "model-gateway", "catalog.example.json"));
await cp(join(ROOT, "deploy", "observability", "rules"), join(stage, "deploy", "observability", "rules"), { recursive: true });
await cp(join(ROOT, "deploy", "observability", "grafana"), join(stage, "deploy", "observability", "grafana"), { recursive: true });

const protocol = await readFile(join(ROOT, "packages", "protocol", "src", "index.ts"), "utf8");
const protocolVersion = Number(/WORKER_PROTOCOL_VERSION = (\d+)/.exec(protocol)?.[1]);
const migrations = (await readdir(join(stage, "app", "migrations")))
  .filter((file) => file.endsWith(".sql"))
  .map((file) => file.replace(/\.sql$/, ""))
  .sort();
const config = await readFile(join(ROOT, "apps", "control-plane", "src", "config.ts"), "utf8");
const defaultRuntimeImage = /DEFAULT_RUNTIME_IMAGE:[\s\S]*?\.default\("([^"]+)"\)/.exec(config)?.[1] ?? null;
const release = {
  version,
  commit,
  architecture: `linux/${platformArch}`,
  protocolVersion,
  migrations,
  defaultRuntimeImage,
  node: NODE_VERSION,
  builtAt: new Date().toISOString(),
};
await writeFile(join(stage, "release.json"), `${JSON.stringify(release, null, 2)}\n`);

// Archive and checksum
const archiveName = `${name}-linux-${platformArch}.tar.gz`;
const archive = join(out, archiveName);
run("tar", [
  "--sort=name", "--owner=0", "--group=0", "--numeric-owner",
  "-C", join(out, ".stage"), "-czf", archive, name,
]);
await rm(join(out, ".stage"), { recursive: true, force: true });
const sumsName = `SHA256SUMS-${version}-${platformArch}`;
await writeFile(join(out, sumsName), `${await sha256(archive)}  ${archiveName}\n`);
console.log(`Wrote ${archive}\n      ${join(out, sumsName)}`);
