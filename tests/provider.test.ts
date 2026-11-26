import assert from "node:assert/strict";
import test from "node:test";

import { resolveAntigravityPluginConfig } from "../src/config.ts";
import {
  buildAntigravityNativeRuntimeModel,
  createAntigravityModelCatalogProvider,
  createAntigravityProvider,
} from "../src/provider.ts";

const liveModels = [
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash High" },
  { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash Medium" },
  { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash Low" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
];

function createContext(modelId: string) {
  return {
    provider: "antigravity",
    modelId,
    modelRegistry: { find: () => undefined },
  } as never;
}

test("live catalog discovery never invents native authentication mode or credentials", async () => {
  let calls = 0;
  const provider = createAntigravityProvider({
    pluginConfig: resolveAntigravityPluginConfig({ command: process.execPath }),
    discoverModels: async () => { calls++; return liveModels; },
  });
  assert.equal(provider.prepareSyntheticAuth, undefined);
  assert.deepEqual(provider.auth, []);
  const result = await provider.catalog!.run({} as never);
  assert.ok(result && "provider" in result);
  assert.equal(calls, 1);
  assert.equal(result.provider.apiKey, undefined);
});

test("provider admits an exact model only when live AGY inventory advertises it", async () => {
  const seen: Array<{ command?: string }> = [];
  const provider = createAntigravityProvider({
    pluginConfig: resolveAntigravityPluginConfig({ command: process.execPath }),
    discoverModels: async (params) => {
      seen.push({ command: params?.scope?.command ?? params?.command, timeoutMs: params?.timeoutMs });
      return liveModels;
    },
  });

  const high = await provider.prepareDynamicModel?.(
    createContext("gemini-3.8-flash-high"),
  );
  assert.equal(high?.id, "gemini-3.8-flash-high");
  assert.equal(high?.name, "Gemini 3.8 Flash High");
  assert.equal(high?.provider, "antigravity");
  assert.equal(high?.baseUrl, "");
  assert.equal(high?.api, "openai-responses");
  assert.equal(high?.reasoning, false);
  assert.equal(high?.thinkingLevelMap, undefined);
  assert.deepEqual(seen, [{ command: process.execPath, timeoutMs: 10000 }]);

  const absent = await provider.prepareDynamicModel?.(
    createContext("gemini-9.9-does-not-exist"),
  );
  assert.equal(absent, undefined);
});

test("all live native model ids expose exact execution identity without host-adjustable reasoning", async () => {
  const provider = createAntigravityProvider({
    pluginConfig: resolveAntigravityPluginConfig({ command: process.execPath }),
    discoverModels: async () => liveModels,
  });

  for (const row of liveModels) {
    const model = await provider.prepareDynamicModel?.(createContext(row.id));
    assert.equal(model?.id, row.id);
    assert.equal(model?.reasoning, false);
    assert.equal(model?.thinkingLevelMap, undefined);
    assert.deepEqual(model?.input, ["text"]);
  }
});

test("provider catalog publishes live AGY rows for OpenClaw prepared model discovery", async () => {
  const seen: Array<{ command?: string }> = [];
  const provider = createAntigravityProvider({
    pluginConfig: resolveAntigravityPluginConfig({ command: process.execPath }),
    discoverModels: async (params) => {
      seen.push({ command: params?.scope?.command ?? params?.command, timeoutMs: params?.timeoutMs });
      return liveModels;
    },
  });

  assert.equal(provider.catalog?.order, "simple");
  assert.equal(provider.staticCatalog, undefined);
  const result = await provider.catalog?.run({} as never);
  assert.ok(result && "provider" in result);
  assert.deepEqual(seen, [{ command: process.execPath, timeoutMs: 10000 }]);
  assert.equal(result.provider.baseUrl, "antigravity://native");
  assert.equal(result.provider.api, "openai-responses");
  assert.deepEqual(
    result.provider.models.map((model) => model.id),
    liveModels.map((model) => model.id),
  );
  assert.ok(result.provider.models.every((model) => model.reasoning === false));
  assert.ok(
    result.provider.models.every(
      (model) => model.contextWindow === undefined && model.maxTokens === 200_000,
    ),
  );
});

test("live-only exact model is admitted without a static native fallback", async () => {
  const provider = createAntigravityProvider({
    pluginConfig: resolveAntigravityPluginConfig({ command: process.execPath }),
    discoverModels: async () => liveModels,
  });

  const low = await provider.prepareDynamicModel?.(
    createContext("gemini-3.8-flash-low"),
  );
  assert.equal(low?.id, "gemini-3.8-flash-low");
  assert.equal(provider.staticCatalog, undefined);
  assert.equal(provider.preferRuntimeResolvedModel, undefined);
});

test("live catalog projects exact AGY rows separately from runtime admission", async () => {
  const seen: Array<{ command?: string; timeoutMs?: number }> = [];
  const catalog = createAntigravityModelCatalogProvider({
    pluginConfig: resolveAntigravityPluginConfig({ command: process.execPath }),
    discoverModels: async (params) => {
      seen.push({ command: params?.scope?.command ?? params?.command, timeoutMs: params?.timeoutMs });
      return liveModels;
    },
  });

  const rows = await catalog.liveCatalog?.({ timeoutMs: 3210 } as never);
  assert.deepEqual(seen, [{ command: process.execPath, timeoutMs: 10000 }]);
  assert.deepEqual(rows, [
    {
      kind: "text",
      provider: "antigravity",
      model: "gemini-3.8-flash-high",
      label: "Gemini 3.8 Flash High",
      source: "live",
    },
    {
      kind: "text",
      provider: "antigravity",
      model: "gemini-3.8-flash-medium",
      label: "Gemini 3.8 Flash Medium",
      source: "live",
    },
    {
      kind: "text",
      provider: "antigravity",
      model: "gemini-3.8-flash-low",
      label: "Gemini 3.8 Flash Low",
      source: "live",
    },
    {
      kind: "text",
      provider: "antigravity",
      model: "claude-sonnet-4-6",
      label: "Claude Sonnet 4.6",
      source: "live",
    },
  ]);
});

test("provider companion exposes no provider transport implementation", () => {
  const provider = createAntigravityProvider({
    pluginConfig: resolveAntigravityPluginConfig({ command: process.execPath }),
    discoverModels: async () => liveModels,
  });
  assert.deepEqual(provider.auth, []);
  assert.equal("createStreamFn" in provider, false);
  assert.equal("wrapStreamFn" in provider, false);
  assert.equal("prepareRuntimeAuth" in provider, false);
});

test("native model descriptor carries exact identity and explicitly unknown structural metadata", () => {
  const model = buildAntigravityNativeRuntimeModel(liveModels[0]!, liveModels);
  assert.deepEqual(model, {
    provider: "antigravity",
    id: "gemini-3.8-flash-high",
    name: "Gemini 3.8 Flash High",
    baseUrl: "",
    api: "openai-responses",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 200_000,
    params: { antigravityInventoryMetadata: {
      source: "agy models --output-format json",
      modalities: { certainty: "unknown", structuralInput: ["text"] },
      reasoning: { certainty: "adapter-contract", adjustable: false },
      contextWindow: { certainty: "unknown", structuralPlaceholder: 200_000 },
      maxTokens: { certainty: "unknown", structuralPlaceholder: 200_000 },
      pricing: { certainty: "unknown", structuralZeros: true, free: false },
    } },
  });
});
