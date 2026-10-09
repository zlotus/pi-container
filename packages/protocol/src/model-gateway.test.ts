import { describe, expect, it } from "vitest";

import {
  ControlToWorkerMessageSchema,
  ModelGatewayConfigSchema,
  WorkerToControlMessageSchema,
} from "./index.js";

const requestId = "0d17d4a0-c25a-43fd-a2eb-3d9ca7c5976c";
const workspaceId = "90b38efc-aa9a-4bc6-8eee-528b4e0c7c60";
const otherWorkspaceId = "a1b2c3d4-aa9a-4bc6-8eee-528b4e0c7c60";

const model = {
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  api: "openai-completions",
  reasoning: true,
  input: ["text"],
  contextWindow: 1_000_000,
  maxTokens: 384_000,
  cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
  compat: { thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true },
  thinkingLevelMap: { minimal: null, low: "low", high: "high" },
};
const catalog = { providerId: "platform", defaultModel: model.id, models: [model] };

describe("model gateway protocol (Phase 16)", () => {
  it("accepts a platform catalog and rejects unsafe or inconsistent ones", () => {
    expect(ModelGatewayConfigSchema.safeParse(catalog).success).toBe(true);
    const invalid = [
      { ...catalog, providerId: "deepseek" },
      { ...catalog, providerId: "../x" },
      { ...catalog, defaultModel: "missing" },
      { ...catalog, models: [model, model] },
      { ...catalog, models: [] },
      { ...catalog, models: [{ ...model, api: "google-generative-ai" }] },
      { ...catalog, models: [{ ...model, apiKey: "sk-x" }] },
      { ...catalog, models: [{ ...model, baseUrl: "http://evil" }] },
      { ...catalog, models: [{ ...model, input: ["text", "text"] }] },
      { ...catalog, models: [{ ...model, compat: { blob: "x".repeat(9_000) } }] },
      { ...catalog, models: [{ ...model, cost: { input: -1 } }] },
      { ...catalog, models: [model, { ...model, id: "claude", api: "anthropic-messages" }] },
    ];
    for (const value of invalid) {
      expect(ModelGatewayConfigSchema.safeParse(value).success).toBe(false);
    }
  });

  it("carries the model gateway config in workspace.ensure", () => {
    const ensure = (modelGateway: unknown) =>
      ControlToWorkerMessageSchema.safeParse({
        version: 4,
        type: "workspace.ensure",
        requestId,
        payload: {
          workspaceId,
          runtimeImage: "agent-runtime:test",
          resources: { cpuCount: 2, memoryBytes: 1024, pidsLimit: 64 },
          storage: { diskLimitBytes: 20 * 1024 ** 3 },
          modelGateway,
        },
      }).success;
    expect(ensure(catalog)).toBe(true);
    expect(ensure(null)).toBe(true);
    expect(ensure(undefined)).toBe(false);
  });

  it("binds a virtual key to its own Workspace and bounds the secret", () => {
    const set = (payload: Record<string, unknown>) =>
      ControlToWorkerMessageSchema.safeParse({
        version: 4,
        type: "workspace.model_key.set",
        requestId,
        payload: { workspaceId, keyAlias: `arw-${workspaceId}-1`, secret: "sk-abcdefghijklmnop", ...payload },
      }).success;
    expect(set({})).toBe(true);
    expect(set({ keyAlias: `arw-${otherWorkspaceId}-1` })).toBe(false);
    expect(set({ keyAlias: `arw-${workspaceId}-0` })).toBe(false);
    expect(set({ secret: "short" })).toBe(false);
    expect(set({ secret: "sk-has space inside" })).toBe(false);
    expect(set({ secret: "sk-abcdefghijklmnop\n" })).toBe(false);
    expect(set({ hostPath: "/var/lib" })).toBe(false);
    expect(
      ControlToWorkerMessageSchema.safeParse({
        version: 4,
        type: "workspace.model_key.clear",
        requestId,
        payload: { workspaceId, keyAlias: `arw-${workspaceId}-1` },
      }).success,
    ).toBe(true);
    expect(
      ControlToWorkerMessageSchema.safeParse({
        version: 4,
        type: "workspace.model_key.clear",
        requestId,
        payload: { workspaceId },
      }).success,
    ).toBe(false);
  });

  it("requires the relay status in heartbeats and reports held key aliases", () => {
    const heartbeat = (modelRelay: unknown) =>
      WorkerToControlMessageSchema.safeParse({
        version: 4,
        type: "worker.heartbeat",
        requestId,
        payload: {
          workerId: "worker-01",
          allocatedWorkspaces: 0,
          egress: { enforced: true, revision: 0 },
          storage: { enforced: true, fsType: "xfs", totalBytes: 10, freeBytes: 5 },
          modelRelay,
          observedAt: "2026-10-08T08:00:00.000Z",
        },
      }).success;
    expect(heartbeat({ enabled: true, port: 3101, listening: true })).toBe(true);
    expect(heartbeat(undefined)).toBe(false);
    expect(heartbeat({ enabled: true, port: 70_000, listening: true })).toBe(false);

    const report = (modelKeys: unknown) =>
      WorkerToControlMessageSchema.safeParse({
        version: 4,
        type: "response.ok",
        requestId,
        payload: {
          requestType: "worker.reconcile",
          reconciliation: { workspaces: [], issues: [], modelKeys, observedAt: "2026-10-08T08:00:00.000Z" },
        },
      }).success;
    expect(report([{ workspaceId, keyAlias: `arw-${workspaceId}-3` }])).toBe(true);
    expect(report([{ workspaceId, keyAlias: "sk-leaked" }])).toBe(false);
    expect(report([{ workspaceId, keyAlias: `arw-${workspaceId}-3`, secret: "sk-abcdefghijklmnop" }])).toBe(false);

    const keyResponse = (modelKey: unknown) =>
      WorkerToControlMessageSchema.safeParse({
        version: 4,
        type: "response.ok",
        requestId,
        payload: { requestType: "workspace.model_key.set", modelKey },
      }).success;
    expect(keyResponse({ workspaceId, keyAlias: `arw-${workspaceId}-3` })).toBe(true);
    expect(keyResponse({ workspaceId, keyAlias: null })).toBe(true);
    expect(keyResponse({ workspaceId, keyAlias: `arw-${workspaceId}-3`, secret: "sk-x" })).toBe(false);
  });

  it("rejects v3 Workers that cannot run the model relay", () => {
    expect(
      WorkerToControlMessageSchema.safeParse({
        version: 3,
        type: "worker.heartbeat",
        requestId,
        payload: {
          workerId: "worker-01",
          allocatedWorkspaces: 0,
          egress: { enforced: true, revision: 0 },
          storage: { enforced: true, fsType: "xfs", totalBytes: 10, freeBytes: 5 },
          observedAt: "2026-10-08T08:00:00.000Z",
        },
      }).success,
    ).toBe(false);
  });
});
