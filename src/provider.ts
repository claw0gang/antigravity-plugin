import type {
  ProviderCatalogResult,
  ProviderPlugin,
  ProviderRuntimeModel,
  UnifiedModelCatalogProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";

import type { AntigravityPluginConfig } from "./config.js";
import {
  discoverAgyModels,
  type AgyDiscoveredModel,
} from "./harness/model-catalog.js";
import { deriveAgyNativeModelCapabilities } from "./harness/model-capabilities.js";
import { normalizeAntigravityModelId } from "./model-aliases.js";

export const ANTIGRAVITY_PROVIDER_ID = "antigravity";
export const ANTIGRAVITY_NATIVE_AUTH_MARKER = "openclaw:antigravity-native-auth";

// OpenClaw uses the same 200k structural fallback for models whose real
// selection/runtime metadata is owned by a native harness. These fields satisfy
// model admission only; ANTIGRAVITY never sends them to an HTTP route.
const NATIVE_MODEL_CONTEXT_TOKENS = 200_000;

// OpenClaw 2026.9.x persists provider-catalog rows only when their provider
// config has a non-empty baseUrl. This non-network scheme satisfies that
// structural catalog contract while remaining fail-closed if the native harness
// were ever bypassed; it is never used for ANTIGRAVITY execution.
const NATIVE_CATALOG_BASE_URL = "antigravity://native";

type AgyModelDiscovery = (params?: {
  command?: string;
  timeoutMs?: number;
}) => Promise<AgyDiscoveredModel[]>;

type ProviderCatalogProviderConfig = Extract<
  ProviderCatalogResult,
  { provider: unknown }
>["provider"];

type AntigravitySyntheticAuth = {
  apiKey: string;
  source: string;
  mode: "oauth";
};

export type CreateAntigravityProviderOptions = {
  pluginConfig: AntigravityPluginConfig;
  discoverModels?: AgyModelDiscovery;
};

function discoverConfiguredModels(
  options: CreateAntigravityProviderOptions,
  timeoutMs?: number,
): Promise<AgyDiscoveredModel[]> {
  const discoverModels = options.discoverModels ?? discoverAgyModels;
  return discoverModels({
    command: options.pluginConfig.command,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

/**
 * OpenClaw 2026.9.4 can probe plugin-owned synthetic auth during cold discovery
 * for provider ids already in the active discovery scope. AGY owns its own native
 * authentication, so successful bounded model discovery is the readiness proof.
 * The returned marker is control-plane only: ANTIGRAVITY has no OpenClaw network
 * transport and never sends it to AGY.
 */
export async function prepareAntigravitySyntheticAuth(
  options: CreateAntigravityProviderOptions,
  params: { provider: string; signal?: AbortSignal },
): Promise<AntigravitySyntheticAuth | undefined> {
  params.signal?.throwIfAborted();
  if (params.provider !== ANTIGRAVITY_PROVIDER_ID) {
    return undefined;
  }
  try {
    await discoverConfiguredModels(options);
    params.signal?.throwIfAborted();
    return {
      apiKey: ANTIGRAVITY_NATIVE_AUTH_MARKER,
      source: "Google Antigravity CLI native auth",
      mode: "oauth",
    };
  } catch {
    params.signal?.throwIfAborted();
    return undefined;
  }
}

/**
 * Structural model metadata for OpenClaw admission when AGY confirms the exact
 * model is currently available. The AgentHarnessV2 runtime owns execution,
 * authentication, context handling, and the native protocol.
 */
export function buildAntigravityNativeRuntimeModel(
  model: AgyDiscoveredModel,
  liveModels: readonly AgyDiscoveredModel[] = [model],
): ProviderRuntimeModel {
  const capabilities = deriveAgyNativeModelCapabilities(model.id, liveModels);
  return {
    provider: ANTIGRAVITY_PROVIDER_ID,
    id: model.id,
    name: model.name,
    baseUrl: "",
    api: "openai-responses",
    reasoning: capabilities.reasoning,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: NATIVE_MODEL_CONTEXT_TOKENS,
    maxTokens: NATIVE_MODEL_CONTEXT_TOKENS,
  };
}

export function buildAntigravityProviderCatalog(
  models: readonly AgyDiscoveredModel[],
): ProviderCatalogProviderConfig {
  return {
    baseUrl: NATIVE_CATALOG_BASE_URL,
    api: "openai-responses",
    models: models.map((model) => {
      const runtimeModel = buildAntigravityNativeRuntimeModel(model, models);
      return {
        id: runtimeModel.id,
        name: runtimeModel.name,
        reasoning: runtimeModel.reasoning,
        input: runtimeModel.input,
        cost: runtimeModel.cost,
        contextWindow: NATIVE_MODEL_CONTEXT_TOKENS,
        maxTokens: NATIVE_MODEL_CONTEXT_TOKENS,
      };
    }),
  };
}

export function createAntigravityProvider(
  options: CreateAntigravityProviderOptions,
): ProviderPlugin {
  return {
    id: ANTIGRAVITY_PROVIDER_ID,
    label: "Google Antigravity native runtime",
    auth: [],

    prepareSyntheticAuth(ctx) {
      return prepareAntigravitySyntheticAuth(options, {
        provider: ctx.provider,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      });
    },

    catalog: {
      order: "simple",
      async run() {
        const models = await discoverConfiguredModels(options);
        return { provider: buildAntigravityProviderCatalog(models) };
      },
    },

    normalizeModelId(ctx) {
      return normalizeAntigravityModelId(ctx.modelId);
    },

    async prepareDynamicModel(ctx) {
      if (ctx.provider !== ANTIGRAVITY_PROVIDER_ID) {
        return;
      }
      const requestedId = normalizeAntigravityModelId(ctx.modelId);
      const models = await discoverConfiguredModels(options);
      const liveModel = models.find((model) => model.id === requestedId);
      return liveModel ? buildAntigravityNativeRuntimeModel(liveModel, models) : undefined;
    },
  };
}

/** Read-only list/help/picker projection. Runtime admission remains prepareDynamicModel(). */
export function createAntigravityModelCatalogProvider(
  options: CreateAntigravityProviderOptions,
): UnifiedModelCatalogProviderPlugin {
  return {
    provider: ANTIGRAVITY_PROVIDER_ID,
    kinds: ["text"],
    async liveCatalog(ctx) {
      const models = await discoverConfiguredModels(options, ctx.timeoutMs);
      return models.map((model) => ({
        kind: "text" as const,
        provider: ANTIGRAVITY_PROVIDER_ID,
        model: model.id,
        label: model.name,
        source: "live" as const,
      }));
    },
  };
}

export { normalizeAntigravityModelId } from "./model-aliases.js";
