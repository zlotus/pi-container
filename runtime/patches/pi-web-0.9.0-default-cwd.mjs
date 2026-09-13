import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const packageRoot = process.argv[2];

if (!packageRoot) {
  throw new Error("Usage: node pi-web-0.9.0-default-cwd.mjs <pi-web-package-root>");
}

const manifestPath = join(packageRoot, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

if (manifest.name !== "@agegr/pi-web" || manifest.version !== "0.9.0") {
  throw new Error(
    `Refusing to patch ${String(manifest.name)}@${String(manifest.version)}; expected @agegr/pi-web@0.9.0`,
  );
}

const routePath = join(
  packageRoot,
  ".next/server/app/api/default-cwd/route.js",
);
const upstream =
  "let a=new Date().toISOString().slice(0,10).replace(/-/g,\"\"),b=(0,h.join)((0,g.homedir)(),`pi-cwd-${a}`);";
const downstream =
  "let a=process.env.PI_WEB_DEFAULT_CWD?.trim(),b=a||(0,h.join)((0,g.homedir)(),`pi-cwd-${new Date().toISOString().slice(0,10).replace(/-/g,\"\")}`);";
const source = await readFile(routePath, "utf8");
const occurrences = source.split(upstream).length - 1;

if (occurrences !== 1) {
  throw new Error(
    `Expected exactly one pi-web 0.9.0 default-cwd implementation, found ${occurrences}`,
  );
}

await writeFile(routePath, source.replace(upstream, downstream), "utf8");
