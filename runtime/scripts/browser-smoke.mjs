#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import playwright from "/opt/agent-runtime/lib/node_modules/playwright/index.js";

const { chromium } = playwright;

const root = await mkdtemp(join(tmpdir(), "agent-runtime-browser-smoke-"));
const pagePath = join(root, "index.html");
let browser;

try {
  await writeFile(
    pagePath,
    "<!doctype html><title>runtime-browser-smoke</title><body><script>document.body.dataset.answer = String(6 * 7)</script>",
    "utf8",
  );
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`file://${pagePath}`);
  const result = await page.evaluate(() => {
    const currentDocument = globalThis.document;
    return {
      answer: currentDocument.body.dataset.answer,
      title: currentDocument.title,
    };
  });
  if (result.title !== "runtime-browser-smoke" || result.answer !== "42") {
    throw new Error("Chromium returned an unexpected local-page result");
  }
  process.stdout.write("Playwright/Chromium local-page smoke passed\n");
} finally {
  await browser?.close();
  await rm(root, { recursive: true, force: true });
}
