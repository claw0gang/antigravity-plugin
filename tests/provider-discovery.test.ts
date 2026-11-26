import assert from "node:assert/strict";
import test from "node:test";

import { createAntigravityProviderDiscovery } from "../src/provider-discovery.ts";

const liveModels = [
  { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash Low" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
];

const configuredContext = {
  config: {
    plugins: {
      entries: {
        antigravity: {
          config: { command: process.execPath },
        },
      },
    },
  },
};

test("lightweight provider catalog entry discovers live AGY rows using plugin command config", async () => {
  const seen: Array<{ command?: string; timeoutMs?: number }> = [];
  const provider = createAntigravityProviderDiscovery({
    discoverModels: async (params) => {
      seen.push({ command: params?.scope?.command ?? params?.command, timeoutMs: params?.timeoutMs });
      return liveModels;
    },
  });

  const result = await provider.catalog?.run(configuredContext as never);

  assert.ok(result && "provider" in result);
  assert.deepEqual(seen, [{ command: process.execPath, timeoutMs: 10000 }]);
  assert.equal(result.provider.baseUrl, "antigravity://native");
  assert.equal(result.provider.api, "openai-responses");
  assert.deepEqual(
    result.provider.models.map((model) => model.id),
    liveModels.map((model) => model.id),
  );
  assert.ok(
    result.provider.models.every(
      (model) => model.contextWindow === undefined && model.maxTokens === 200_000,
    ),
  );
});

test("cold discovery needs no synthetic credential or guessed authentication mode", async () => {
  const provider = createAntigravityProviderDiscovery({ discoverModels: async () => liveModels });
  assert.equal(provider.prepareSyntheticAuth, undefined);
  assert.deepEqual(provider.auth, []);
  const result = await provider.catalog!.run(configuredContext as never);
  assert.ok(result && "provider" in result);
  assert.equal(result.provider.apiKey, undefined);
  assert.deepEqual(result.provider.models.map((model) => model.id), liveModels.map((model) => model.id));
});

test("unavailable cold discovery fails without a static catalog or credential fallback", async () => {
  const provider = createAntigravityProviderDiscovery({ discoverModels: async () => { throw new Error("unavailable"); } });
  assert.equal(provider.prepareSyntheticAuth, undefined);
  await assert.rejects(provider.catalog!.run(configuredContext as never));
  assert.equal(provider.staticCatalog, undefined);
});
