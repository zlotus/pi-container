import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { loadModelCatalog } from "./key-manager.js";

const catalogPath = new URL("../../../../deploy/model-gateway/catalog.example.json", import.meta.url);
const configPath = new URL("../../../../deploy/model-gateway/config.yaml", import.meta.url);

describe("deployed model catalog (Phase 16.5, 18.7)", () => {
  it("loads with the Control Plane loader and matches the gateway's models one to one", async () => {
    const catalog = await loadModelCatalog(catalogPath.pathname);
    const config = await readFile(configPath, "utf8");
    const gatewayModels = [...config.matchAll(/^ {2}- model_name: (\S+)$/gm)].map((match) => match[1]);
    expect(catalog.models.map((model) => model.id).sort()).toEqual([...gatewayModels].sort());
    expect(gatewayModels).toContain(catalog.defaultModel);
  });

  it("routes MiMo through the pass-through route with Xiaomi's key and prices", async () => {
    const catalog = await loadModelCatalog(catalogPath.pathname);
    const config = await readFile(configPath, "utf8");
    for (const id of ["mimo-v2.6-flash", "mimo-v2.6-pro"]) {
      const entry = config.split("  - model_name: ").find((block) => block.startsWith(`${id}\n`)) ?? "";
      expect(entry).toContain(`model: litellm_proxy/${id}`);
      expect(entry).toContain("api_base: https://api.xiaomimimo.com/v1");
      expect(entry).toContain("api_key: os.environ/XIAOMI_API_KEY");
      expect(entry).toMatch(/input_cost_per_token: \S+/);
      const model = catalog.models.find((candidate) => candidate.id === id);
      // MiMo accepts only low/medium/high as reasoning_effort (16.17).
      expect(model?.thinkingLevelMap).toMatchObject({ minimal: null, xhigh: null, max: null, low: "low", high: "high" });
      expect(model?.compat).toEqual({
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "deepseek",
      });
    }
    expect(config).not.toMatch(/mimo-v2\.5/);
  });
});
