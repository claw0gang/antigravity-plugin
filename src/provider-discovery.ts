import type { ProviderPlugin } from "./host/types.js";

import { resolveAntigravityPluginConfig } from "./config.js";
import { AgyHostInventoryOwner, type AgyHostInventoryOptions } from "./inventory-scope.js";
import {
  ANTIGRAVITY_PROVIDER_ID,
  buildAntigravityProviderCatalog,
  prepareAntigravitySyntheticAuth,
} from "./provider.js";

export type CreateAntigravityProviderDiscoveryOptions = Pick<
  AgyHostInventoryOptions, "discoverModels" | "inventory" | "inventoryOwner"
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
  const sharedOptions = { ...options, pluginConfig, inventoryOwner };
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
  };
}

export default createAntigravityProviderDiscovery();
