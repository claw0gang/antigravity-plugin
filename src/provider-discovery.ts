import type { ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";

import { resolveAntigravityPluginConfig } from "./config.js";
import {
  discoverAgyModels,
  type AgyDiscoveredModel,
} from "./harness/model-catalog.js";
import {
  ANTIGRAVITY_PROVIDER_ID,
  buildAntigravityProviderCatalog,
  prepareAntigravitySyntheticAuth,
} from "./provider.js";

type AgyModelDiscovery = (params?: {
  command?: string;
  timeoutMs?: number;
}) => Promise<AgyDiscoveredModel[]>;

export type CreateAntigravityProviderDiscoveryOptions = {
  discoverModels?: AgyModelDiscovery;
};

type OpenClawConfigProjection = {
  plugins?: {
    entries?: Record<string, { config?: unknown }>;
  };
};

function resolveDiscoveryPluginConfig(config: unknown) {
  const projected = (config ?? {}) as OpenClawConfigProjection;
  return resolveAntigravityPluginConfig(
    projected.plugins?.entries?.[ANTIGRAVITY_PROVIDER_ID]?.config,
  );
}

/** Lightweight provider descriptor used by OpenClaw catalog discovery before full runtime load. */
export function createAntigravityProviderDiscovery(
  options: CreateAntigravityProviderDiscoveryOptions = {},
): ProviderPlugin {
  const discoverModels = options.discoverModels ?? discoverAgyModels;
  return {
    id: ANTIGRAVITY_PROVIDER_ID,
    label: "Google Antigravity native runtime",
    auth: [],
    async prepareSyntheticAuth(ctx) {
      const pluginConfig = resolveDiscoveryPluginConfig(ctx.config);
      return await prepareAntigravitySyntheticAuth(
        { pluginConfig, discoverModels },
        {
          provider: ctx.provider,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        },
      );
    },
    catalog: {
      order: "simple",
      async run(ctx) {
        const pluginConfig = resolveDiscoveryPluginConfig(ctx.config);
        const models = await discoverModels({ command: pluginConfig.command });
        return { provider: buildAntigravityProviderCatalog(models) };
      },
    },
  };
}

const antigravityProviderDiscovery = createAntigravityProviderDiscovery();

export default antigravityProviderDiscovery;
