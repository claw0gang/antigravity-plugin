import type {
  ProviderCatalogResult,
  ProviderPlugin,
  ProviderRuntimeModel,
  UnifiedModelCatalogProviderPlugin,
} from "./host/types.js";

import type { AgyDiscoveredModel } from "./harness/model-catalog.js";
import { resolveAgyHostInventoryOwner, type AgyHostInventoryContext, type AgyHostInventoryOptions } from "./inventory-scope.js";
import { deriveAgyNativeModelCapabilities } from "./harness/model-capabilities.js";
import { normalizeAntigravityModelId } from "./model-aliases.js";

export const ANTIGRAVITY_PROVIDER_ID = "antigravity";
export const ANTIGRAVITY_NATIVE_AUTH_MARKER = "openclaw:antigravity-native-auth";

// Required runtime fields use structural placeholders, never measured native
// limits or pricing. Optional catalog limits are omitted; provenance is carried
// in params. Installed-host interpretation remains a separate qualification.
const NATIVE_MODEL_CONTEXT_TOKENS = 200_000;

// OpenClaw 2026.9.x persists provider-catalog rows only when their provider
// config has a non-empty baseUrl. This non-network scheme satisfies that
// structural catalog contract while remaining fail-closed if the native harness
// were ever bypassed; it is never used for ANTIGRAVITY execution.
const NATIVE_CATALOG_BASE_URL = "antigravity://native";

type ProviderCatalogProviderConfig = Extract<
  ProviderCatalogResult,
  { provider: unknown }
>["provider"];

type AntigravitySyntheticAuth = {
  apiKey: string;
  source: string;
  mode: "oauth";
  expiresAt: number;
};

export type CreateAntigravityProviderOptions = AgyHostInventoryOptions;

/**
 * OpenClaw 2026.9.4 can probe plugin-owned synthetic auth during cold discovery
 * for provider ids already in the active discovery scope. AGY owns its own native
 * authentication, so successful bounded model discovery is the readiness proof.
 * The returned marker is control-plane only: ANTIGRAVITY has no OpenClaw network
 * transport and never sends it to AGY.
 */
export async function prepareAntigravitySyntheticAuth(
  options: CreateAntigravityProviderOptions,
  params: AgyHostInventoryContext & { provider: string },
): Promise<AntigravitySyntheticAuth | undefined> {
  params.signal?.throwIfAborted();
  if (params.provider !== ANTIGRAVITY_PROVIDER_ID) {
    return undefined;
  }
  try {
    await resolveAgyHostInventoryOwner(options).models(params);
    params.signal?.throwIfAborted();
    return {
      apiKey: ANTIGRAVITY_NATIVE_AUTH_MARKER,
      source: "Google Antigravity CLI native auth",
      mode: "oauth",
      expiresAt: Date.now() + 60_000,
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
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: NATIVE_MODEL_CONTEXT_TOKENS,
    maxTokens: NATIVE_MODEL_CONTEXT_TOKENS,
    params: { antigravityInventoryMetadata: {
      source: "agy models --output-format json",
      modalities: { certainty: "unknown", structuralInput: ["text"] },
      reasoning: { certainty: "adapter-contract", adjustable: false },
      contextWindow: { certainty: "unknown", structuralPlaceholder: NATIVE_MODEL_CONTEXT_TOKENS },
      maxTokens: { certainty: "unknown", structuralPlaceholder: NATIVE_MODEL_CONTEXT_TOKENS },
      pricing: { certainty: "unknown", structuralZeros: true, free: false },
    } },
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
        maxTokens: runtimeModel.maxTokens,
        ...(runtimeModel.params ? { params: runtimeModel.params } : {}),
      };
    }),
  };
}

export function createAntigravityProvider(
  options: CreateAntigravityProviderOptions,
): ProviderPlugin {
  const inventoryOwner = resolveAgyHostInventoryOwner(options);
  const sharedOptions = { ...options, inventoryOwner };
  return {
    id: ANTIGRAVITY_PROVIDER_ID,
    label: "Google Antigravity native runtime",
    auth: [],

    prepareSyntheticAuth(ctx) {
      return prepareAntigravitySyntheticAuth(sharedOptions, ctx);
    },

    catalog: {
      order: "simple",
      async run(ctx) {
        const models = await inventoryOwner.models(ctx);
        return { provider: buildAntigravityProviderCatalog(models) };
      },
    },

    normalizeModelId(ctx) {
      return ctx.modelId;
    },

    async prepareDynamicModel(ctx) {
      if (ctx.provider !== ANTIGRAVITY_PROVIDER_ID) {
        return;
      }
      const requestedId = ctx.modelId;
      const models = await inventoryOwner.models(ctx);
      const liveModel = models.find((model) => model.id === requestedId);
      return liveModel ? buildAntigravityNativeRuntimeModel(liveModel, models) : undefined;
    },
  };
}

/** Read-only list/help/picker projection. Runtime admission remains prepareDynamicModel(). */
export function createAntigravityModelCatalogProvider(
  options: CreateAntigravityProviderOptions,
): UnifiedModelCatalogProviderPlugin {
  const inventoryOwner = resolveAgyHostInventoryOwner(options);
  return {
    provider: ANTIGRAVITY_PROVIDER_ID,
    kinds: ["text"],
    async liveCatalog(ctx) {
      const models = await inventoryOwner.models(ctx, ctx.timeoutMs);
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

