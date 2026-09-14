#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";

function succeeds(command, args) {
  return spawnSync(command, args, {
    stdio: "ignore",
    timeout: 60_000,
  }).status === 0;
}

const capabilities = {
  browser: succeeds("node", [
    "/usr/local/lib/agent-runtime/browser-smoke.mjs",
  ]),
  office:
    succeeds("libreoffice", ["--headless", "--version"]) &&
    succeeds("pdftotext", ["-v"]) &&
    succeeds("pandoc", ["--version"]),
  ffmpeg:
    succeeds("ffmpeg", ["-version"]) && succeeds("ffprobe", ["-version"]),
  python:
    succeeds("python", ["--version"]) &&
    succeeds("python3", ["--version"]) &&
    succeeds("uv", ["--version"]),
  node:
    succeeds("node", ["--version"]) && succeeds("pnpm", ["--version"]),
  rust:
    succeeds("rustc", ["--version"]) &&
    succeeds("cargo", ["--version"]) &&
    succeeds("rustup", ["--version"]),
};

process.stdout.write(`${JSON.stringify(capabilities)}\n`);
