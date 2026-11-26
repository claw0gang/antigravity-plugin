import type {
  ProviderCatalogResult,
  ProviderPlugin,
  ProviderRuntimeModel,
  UnifiedModelCatalogProviderPlugin,
} from "./host/types.js";

import type { AgyDiscoveredModel } from "./harness/model-catalog.js";
import { AgyHostInventoryOwner, resolveAgyHostInventoryOwner, type AgyHostInventoryOptions } from "./inventory-scope.js";
import { agyEffortMetadata, deriveAgyNativeModelCapabilities, resolveAgyThinkingProfile } from "./harness/model-capabilities.js";

export const ANTIGRAVITY_PROVIDER_ID = "antigravity";

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

export type CreateAntigravityProviderOptions = AgyHostInventoryOptions & { nativeCatalogControls?: boolean };

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
      reasoning: { certainty: model.effort ? "native-observation" : "adapter-contract", adjustable: capabilities.adjustableReasoning },
      contextWindow: { certainty: "unknown", structuralPlaceholder: NATIVE_MODEL_CONTEXT_TOKENS },
      maxTokens: { certainty: "unknown", structuralPlaceholder: NATIVE_MODEL_CONTEXT_TOKENS },
      pricing: { certainty: "unknown", structuralZeros: true, free: false },
    }, ...agyEffortMetadata(model) },
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

/** Logical provider rows are published before the native route overlay on
 * current OpenClaw. Put observed effort metadata on those rows directly,
 * rather than hoping a later harness projection will replace them. Shared
 * by the full registration and the lightweight discovery entry. */
export function createAntigravityProviderCatalogHook(
  inventoryOwner: AgyHostInventoryOwner, observeEffort: boolean,
): NonNullable<ProviderPlugin["catalog"]> {
  return {
    order: "simple",
    async run(ctx) {
      const models = observeEffort
        ? await inventoryOwner.catalogModels(ctx)
        : await inventoryOwner.models(ctx);
      return { provider: buildAntigravityProviderCatalog(models) };
    },
  };
}

export function createAntigravityProvider(
  options: CreateAntigravityProviderOptions,
): ProviderPlugin {
  const inventoryOwner = resolveAgyHostInventoryOwner(options);
  return {
    id: ANTIGRAVITY_PROVIDER_ID,
    label: "Google Antigravity native runtime",
    auth: [],

    catalog: createAntigravityProviderCatalogHook(inventoryOwner, options.nativeCatalogControls === true),

    normalizeModelId(ctx) {
      return ctx.modelId;
    },

    // The lightweight entry can project observed metadata on older hosts,
    // but this installed runtime advertises only controls it can execute.
    resolveThinkingProfile: options.nativeCatalogControls === true
      ? resolveAgyThinkingProfile
      : ctx => resolveAgyThinkingProfile({ provider: ctx.provider, modelId: ctx.modelId }),

    async prepareDynamicModel(ctx) {
      if (ctx.provider !== ANTIGRAVITY_PROVIDER_ID) {
        return;
      }
      const requestedId = ctx.modelId;
      const models = options.nativeCatalogControls
        ? await inventoryOwner.modelsWithEffort(ctx, [requestedId])
        : await inventoryOwner.models(ctx);
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
