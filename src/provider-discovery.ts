import type { ProviderPlugin } from "./host/types.js";

import { resolveAntigravityPluginConfig } from "./config.js";
import { resolveAgyThinkingProfile } from "./harness/model-capabilities.js";
import { AgyHostInventoryOwner, type AgyHostInventoryOptions } from "./inventory-scope.js";
import {
  ANTIGRAVITY_PROVIDER_ID,
  createAntigravityProviderCatalogHook,
} from "./provider.js";

export type CreateAntigravityProviderDiscoveryOptions = Pick<
  AgyHostInventoryOptions, "discoverModels" | "inventory" | "inventoryOwner" | "observeEffort"
>;

/**
 * Lightweight loaders have their own bounded process owner. They use the same
 * acquisition/projection service as full registration, without cross-process
 * cache claims or any independent background refresh.
 */
export function createAntigravityProviderDiscovery(
  options: CreateAntigravityProviderDiscoveryOptions = {},
): ProviderPlugin {
  const pluginConfig = resolveAntigravityPluginConfig(undefined);
  const inventoryOwner = options.inventoryOwner ?? new AgyHostInventoryOwner({ ...options, pluginConfig });
  return {
    id: ANTIGRAVITY_PROVIDER_ID,
    label: "Google Antigravity native runtime",
    auth: [],
    resolveThinkingProfile: resolveAgyThinkingProfile,
    catalog: createAntigravityProviderCatalogHook(inventoryOwner, true),
  };
}

export default createAntigravityProviderDiscovery();
