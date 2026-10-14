import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";

import { DockerRuntimeCapabilityProbe, PROBE_LABEL } from "./capabilities.js";
import { loadWorkerConfig } from "./config.js";
import {
  configuredRuntimeImages,
  DockerRuntimeImageCatalog,
  parseRuntimeImages,
  RUNTIME_VERSION_LABEL,
} from "./runtime-images.js";

const ID_A = `sha256:${"a".repeat(64)}`;
const ID_B = `sha256:${"b".repeat(64)}`;
const ID_C = `sha256:${"c".repeat(64)}`;

const BASE = {
  CONTROL_PLANE_URL: "wss://control.internal/api/workers/connect",
  WORKER_ID: "worker-01",
  WORKER_TOKEN: "0123456789abcdef0123456789abcdef",
  WORKER_GATEWAY_TOKEN: "gateway0123456789abcdef0123456789abcdef",
  WORKSPACE_BASE_URL: "https://agent.example.internal",
  WORKER_MAX_WORKSPACES: "8",
};

interface FakeImage {
  Id: string;
  RepoDigests?: string[];
  Os?: string;
  Architecture?: string;
  labels?: Record<string, string>;
}

function fakeDocker(images: Record<string, FakeImage>) {
  return {
    getImage: (reference: string) => ({
      inspect: async () => {
        const image = images[reference];
        if (image === undefined) throw Object.assign(new Error("no such image"), { statusCode: 404 });
        return {
          Id: image.Id,
          RepoDigests: image.RepoDigests ?? [],
          Os: image.Os ?? "linux",
          Architecture: image.Architecture ?? "arm64",
          Config: { Labels: image.labels ?? {} },
        };
      },
    }),
  } as unknown as Docker;
}

const log = () => ({ error: vi.fn(), warn: vi.fn() });

describe("RUNTIME_IMAGES configuration (Phase 18.4)", () => {
  it("parses digest-pinned references", () => {
    expect(parseRuntimeImages(`agent-runtime:phase7-toolchain@${ID_A}, registry.internal:5000/agent-runtime:R2@${ID_B}`)).toEqual([
      { image: "agent-runtime:phase7-toolchain", digest: ID_A, fallbackVersion: null },
      { image: "registry.internal:5000/agent-runtime:R2", digest: ID_B, fallbackVersion: null },
    ]);
  });

  it("rejects unpinned, malformed, repeated or too many entries", () => {
    for (const invalid of [
      "",
      "agent-runtime:phase7-toolchain",
      `agent-runtime:phase7-toolchain@sha256:${"a".repeat(63)}`,
      `@${ID_A}`,
      `Agent-Runtime:x@${ID_A}`,
      `a:1@${ID_A},a:1@${ID_B}`,
      [1, 2, 3, 4, 5].map((n) => `a:${n}@${ID_A}`).join(","),
    ]) {
      expect(() => parseRuntimeImages(invalid), invalid).toThrow();
    }
  });

  it("refuses to start with an invalid list or with both variables set", () => {
    expect(() => loadWorkerConfig({ ...BASE, RUNTIME_IMAGES: "agent-runtime:phase7-toolchain" })).toThrow();
    expect(() =>
      loadWorkerConfig({ ...BASE, RUNTIME_IMAGES: `a:1@${ID_A}`, RUNTIME_IMAGE: "a:1" }),
    ).toThrow("not both");
    expect(configuredRuntimeImages(loadWorkerConfig({ ...BASE, RUNTIME_IMAGES: `a:1@${ID_A}` }))).toEqual([
      { image: "a:1", digest: ID_A, fallbackVersion: null },
    ]);
  });

  it("keeps the transitional single RUNTIME_IMAGE unpinned with its configured version", () => {
    expect(configuredRuntimeImages(loadWorkerConfig(BASE))).toEqual([
      { image: "agent-runtime:phase7-toolchain", digest: null, fallbackVersion: "phase-7" },
    ]);
  });
});

describe("Runtime image catalog (Phase 18.4)", () => {
  const label = (version: string, extra: Record<string, string> = {}) => ({
    [RUNTIME_VERSION_LABEL]: version,
    ...extra,
  });

  it("offers only images that resolve to their pin on this platform with a version label", async () => {
    const docker = fakeDocker({
      "a:pinned": { Id: ID_A, labels: label("phase-7") },
      "b:repo-digest": {
        Id: ID_C,
        RepoDigests: [`registry/b@${ID_B}`],
        labels: label("phase-18", {
          "io.agent-runtime.pi-web.version": "0.12.0",
          "io.agent-runtime.pi.version": "1.1.0",
        }),
      },
      "c:moved": { Id: ID_C, labels: label("phase-19") },
      "d:amd64": { Id: ID_A, Architecture: "amd64", labels: label("phase-20") },
      "e:unlabelled": { Id: ID_B },
    });
    const errors = log();
    const catalog = new DockerRuntimeImageCatalog(
      [
        { image: "a:pinned", digest: ID_A, fallbackVersion: null },
        { image: "b:repo-digest", digest: ID_B, fallbackVersion: null },
        { image: "c:moved", digest: ID_A, fallbackVersion: null },
        { image: "d:amd64", digest: ID_A, fallbackVersion: null },
        { image: "e:unlabelled", digest: ID_B, fallbackVersion: null },
        { image: "f:missing", digest: ID_A, fallbackVersion: null },
      ],
      docker,
      errors,
    );

    await expect(catalog.refresh("arm64")).resolves.toEqual([
      { image: "a:pinned", imageId: ID_A, runtimeVersion: "phase-7", piWebVersion: null, piVersion: null },
      { image: "b:repo-digest", imageId: ID_C, runtimeVersion: "phase-18", piWebVersion: "0.12.0", piVersion: "1.1.0" },
    ]);
    expect(catalog.find("c:moved")).toBeNull();
    expect(catalog.find("f:missing")).toBeNull();
    expect(errors.error).toHaveBeenCalledTimes(4);
  });

  it("does not offer two images with the same runtime version", async () => {
    const catalog = new DockerRuntimeImageCatalog(
      [
        { image: "a:1", digest: ID_A, fallbackVersion: null },
        { image: "a:2", digest: ID_B, fallbackVersion: null },
      ],
      fakeDocker({
        "a:1": { Id: ID_A, labels: label("same") },
        "a:2": { Id: ID_B, labels: label("same") },
      }),
      log(),
    );
    expect((await catalog.refresh("arm64")).map((image) => image.image)).toEqual(["a:1"]);
  });

  it("stops offering an image once its reference is re-tagged to other content", async () => {
    const images: Record<string, FakeImage> = { "a:1": { Id: ID_A, labels: label("v1") } };
    const catalog = new DockerRuntimeImageCatalog(
      [{ image: "a:1", digest: ID_A, fallbackVersion: null }],
      fakeDocker(images),
      log(),
    );
    await catalog.refresh("arm64");
    expect(catalog.find("a:1")).not.toBeNull();
    images["a:1"] = { Id: ID_B, labels: label("v1") };
    await catalog.refresh("arm64");
    expect(catalog.find("a:1")).toBeNull();
  });

  it("uses the configured version for an unpinned transitional image without a label", async () => {
    const warnings = log();
    const catalog = new DockerRuntimeImageCatalog(
      [{ image: "legacy:1", digest: null, fallbackVersion: "phase-7" }],
      fakeDocker({ "legacy:1": { Id: ID_A } }),
      warnings,
    );
    await expect(catalog.refresh("arm64")).resolves.toMatchObject([
      { image: "legacy:1", imageId: ID_A, runtimeVersion: "phase-7" },
    ]);
    expect(warnings.warn).toHaveBeenCalledOnce();
  });
});

describe("multi-image capability probe (Phase 18.4)", () => {
  const capabilities = { browser: true, office: true, ffmpeg: true, python: true, node: true, rust: false };

  function probeDocker(failing: Set<string>) {
    const created: Array<{ Image?: string; Labels?: Record<string, string> }> = [];
    const removed: string[] = [];
    const docker = {
      ...(fakeDocker({
        "a:1": { Id: ID_A, labels: { [RUNTIME_VERSION_LABEL]: "v1" } },
        "b:1": { Id: ID_B, labels: { [RUNTIME_VERSION_LABEL]: "v2" } },
      }) as unknown as Record<string, unknown>),
      createContainer: async (options: { Image?: string; Labels?: Record<string, string> }) => {
        created.push(options);
        return {
          start: async () => undefined,
          wait: async () => ({ StatusCode: failing.has(options.Image ?? "") ? 1 : 0 }),
          logs: async () => Buffer.from(`${JSON.stringify(capabilities)}\n`),
          remove: async () => undefined,
        };
      },
      listContainers: async () => [
        { Id: "probe-1", Names: ["/agent-runtime-capability-probe-1"] },
        { Id: "other-1", Names: ["/agent-runtime-90b38efc"] },
      ],
      getContainer: (id: string) => ({
        remove: async () => {
          removed.push(id);
        },
      }),
    } as unknown as Docker;
    return { docker, created, removed };
  }

  function probe(docker: Docker) {
    const config = loadWorkerConfig({ ...BASE, RUNTIME_IMAGES: `a:1@${ID_A},b:1@${ID_B}` });
    const errors = log();
    const catalog = new DockerRuntimeImageCatalog(configuredRuntimeImages(config), docker, errors);
    return { probe: new DockerRuntimeCapabilityProbe(config, catalog, errors, docker), errors };
  }

  it("probes every offered image in labelled containers and reports each", async () => {
    const { docker, created } = probeDocker(new Set());
    await expect(probe(docker).probe.probe("arm64")).resolves.toEqual([
      { image: "a:1", imageId: ID_A, runtimeVersion: "v1", piWebVersion: null, piVersion: null, capabilities },
      { image: "b:1", imageId: ID_B, runtimeVersion: "v2", piWebVersion: null, piVersion: null, capabilities },
    ]);
    expect(created.map((options) => options.Image)).toEqual(["a:1", "b:1"]);
    expect(created.every((options) => options.Labels?.[PROBE_LABEL] === "worker-01")).toBe(true);
  });

  it("leaves out an image whose probe fails and refuses when none is left", async () => {
    const partial = probeDocker(new Set(["b:1"]));
    const { probe: partialProbe, errors } = probe(partial.docker);
    await expect(partialProbe.probe("arm64")).resolves.toMatchObject([{ image: "a:1" }]);
    expect(errors.error).toHaveBeenCalledOnce();

    const none = probeDocker(new Set(["a:1", "b:1"]));
    await expect(probe(none.docker).probe.probe("arm64")).rejects.toThrow("No configured Runtime image");
  });

  it("removes only leftover probe containers", async () => {
    const { docker, removed } = probeDocker(new Set());
    await expect(probe(docker).probe.removeLeftovers()).resolves.toBe(1);
    expect(removed).toEqual(["probe-1"]);
  });
});
