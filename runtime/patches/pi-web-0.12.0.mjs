// Version-pinned downstream patches for @agegr/pi-web 0.12.0 (specs.md Phase 18.3). Each
// replacement must match exactly once, so a different pi-web build fails the image build
// instead of shipping an unpatched behavior.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const VERSION = "0.12.0";
const packageRoot = process.argv[2];

if (!packageRoot) {
  throw new Error(`Usage: node pi-web-${VERSION}.mjs <pi-web-package-root>`);
}

const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
if (manifest.name !== "@agegr/pi-web" || manifest.version !== VERSION) {
  throw new Error(
    `Refusing to patch ${String(manifest.name)}@${String(manifest.version)}; expected @agegr/pi-web@${VERSION}`,
  );
}

async function replaceOnce(relativePath, upstream, downstream, purpose) {
  const path = join(packageRoot, relativePath);
  const source = await readFile(path, "utf8");
  const occurrences = source.split(upstream).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Expected exactly one ${purpose} fragment in ${relativePath}, found ${occurrences}`);
  }
  await writeFile(path, source.replace(upstream, downstream), "utf8");
}

// 1. New sessions and the Files view start in the platform's /workspace: the default-cwd
//    route honors PI_WEB_DEFAULT_CWD, else keeps upstream's ~/pi-cwd/<date>.
await replaceOnce(
  ".next/server/app/api/default-cwd/route.js",
  'let a=function(a=new Date,b=(0,f.homedir)()){return h().join(b,"pi-cwd",',
  'let a=process.env.PI_WEB_DEFAULT_CWD?.trim()||function(a=new Date,b=(0,f.homedir)()){return h().join(b,"pi-cwd",',
  "default-cwd",
);

// 2. Preview-mode secrets (pi-web 0.11.0 security fix): the install is read-only, so
//    .next/prerender-manifest.json is a symlink into the container's tmpfs, seeded at
//    every start by pi-web-launch. Rotation writes next to the link target instead of
//    into the read-only .next directory, and replaces the target, not the link.
await replaceOnce(
  "bin/rotate-preview-secrets.js",
  "  const tempPath = path.join(nextDir, `${PRERENDER_MANIFEST}.${process.pid}.tmp`);\n" +
    "  try {\n" +
    "    fs.writeFileSync(tempPath, JSON.stringify(manifest));\n" +
    "    fs.renameSync(tempPath, manifestPath);",
  "  let target;\n" +
    "  try {\n" +
    "    target = fs.realpathSync(manifestPath);\n" +
    "  } catch (error) {\n" +
    '    return { ok: false, reason: "unwritable", error };\n' +
    "  }\n" +
    "  const tempPath = path.join(path.dirname(target), `${PRERENDER_MANIFEST}.${process.pid}.tmp`);\n" +
    "  try {\n" +
    "    fs.writeFileSync(tempPath, JSON.stringify(manifest), { mode: 0o600 });\n" +
    "    fs.renameSync(tempPath, target);",
  "preview-secret rotation",
);
