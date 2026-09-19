import assert from "node:assert/strict";
import test from "node:test";

import { createAntigravityProviderDiscovery } from "../src/provider-discovery.ts";
import { ANTIGRAVITY_NATIVE_AUTH_MARKER } from "../src/provider.ts";

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

test("lightweight discovery publishes AGY-native synthetic auth only when AGY inventory is available", async () => {
  const seen: Array<{ command?: string; timeoutMs?: number }> = [];
  const provider = createAntigravityProviderDiscovery({
    discoverModels: async (params) => {
      seen.push({ command: params?.scope?.command ?? params?.command, timeoutMs: params?.timeoutMs });
      return liveModels;
    },
  });

  const auth = await provider.prepareSyntheticAuth?.({
    ...configuredContext,
    provider: "antigravity",
  } as never);
  assert.ok(auth?.expiresAt && auth.expiresAt <= Date.now() + 60_000);
  assert.ok(auth.expiresAt > Date.now());
  assert.deepEqual({ ...auth, expiresAt: undefined }, {
    expiresAt: undefined,
    apiKey: ANTIGRAVITY_NATIVE_AUTH_MARKER,
    source: "Google Antigravity CLI native auth",
    mode: "oauth",
  });
  assert.deepEqual(seen, [{ command: process.execPath, timeoutMs: 10000 }]);

  const unrelated = await provider.prepareSyntheticAuth?.({
    ...configuredContext,
    provider: "other",
  } as never);
  assert.equal(unrelated, undefined);
  assert.deepEqual(seen, [{ command: process.execPath, timeoutMs: 10000 }]);
});

test("lightweight discovery with unavailable AGY publishes no synthetic auth fact", async () => {
  const provider = createAntigravityProviderDiscovery({
    discoverModels: async () => {
      throw new Error("agy unavailable");
    },
  });

  const auth = await provider.prepareSyntheticAuth?.({
    ...configuredContext,
    provider: "antigravity",
  } as never);
  assert.equal(auth, undefined);
});
