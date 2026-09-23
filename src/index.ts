import { definePluginEntry } from "./host/entry.js";
import { assertOpenClawCompatibility } from "./host/compatibility.js";
import { createOpenClawAntigravityHostContracts } from "./host/runtime-identity.js";
import { createAntigravitySessionRuntime } from "./host/session-runtime.js";
import type { OpenClawPluginApi } from "./host/types.js";

import { buildAntigravityCliBackend } from "./backend.js";
import {
  antigravityConfigSchema,
  resolveAntigravityPluginConfig,
} from "./config.js";
import { createAntigravityHarness } from "./harness/harness.js";
import { AgyHostInventoryOwner } from "./inventory-scope.js";
import {
  createAntigravityModelCatalogProvider,
  createAntigravityProvider,
} from "./provider.js";

const antigravityPlugin = definePluginEntry({
  id: "antigravity",
  name: "Antigravity",
  description: "Run Google Antigravity CLI as an OpenClaw native agent runtime",
  configSchema: antigravityConfigSchema,
  register(api: OpenClawPluginApi) {
    // OpenClaw intentionally withholds api.runtime from metadata/setup-only loads.
    if (api.registrationMode === "cli-metadata" || api.registrationMode === "setup-only") return;
    assertOpenClawCompatibility(api);
    const config = resolveAntigravityPluginConfig(api.pluginConfig);
    const inventoryOwner = new AgyHostInventoryOwner({ pluginConfig: config });
    const providerOptions = { pluginConfig: config, inventoryOwner };
    const sessionRuntime = createAntigravitySessionRuntime(api.runtime.agent.session);
    const hostContracts = createOpenClawAntigravityHostContracts({
      pluginConfig: config,
      sessionRuntime,
    });
    // Public cleanup only; no timer, native restart or background discovery.
    // Hosts without this optional lifecycle hook retain bounded one-shot reads.
    api.registerService?.({
      id: "antigravity-inventory",
      start() {},
      stop() { inventoryOwner.stop(); },
    });
    api.registerProvider(createAntigravityProvider(providerOptions));
    api.registerModelCatalogProvider(createAntigravityModelCatalogProvider(providerOptions));
    api.registerAgentHarness(
      createAntigravityHarness({
        pluginConfig: config,
        inventoryOwner,
        sessionRuntime,
        hostContracts,
      }),
    );
    api.registerCliBackend(buildAntigravityCliBackend(config));
  },
});

export default antigravityPlugin;

export {
  ANTIGRAVITY_CLI_BACKEND_ID,
  ANTIGRAVITY_CLI_DEFAULT_MODEL_REF,
  ANTIGRAVITY_HARNESS_ID,
  buildAntigravityCliBackend,
  buildFreshArgs,
  buildResumeArgs,
} from "./backend.js";
export {
  antigravityConfigSchema,
  resolveAntigravityPluginConfig,
  type AntigravityMode,
  type AntigravityPluginConfig,
} from "./config.js";
export {
  createAntigravityHarness,
  type CreateAntigravityHarnessOptions,
} from "./harness/harness.js";
export {
  ANTIGRAVITY_CONFIRMED_MODEL_IDS,
  ANTIGRAVITY_MODEL_ALIASES,
} from "./model-aliases.js";
export {
  ANTIGRAVITY_PROVIDER_ID,
  buildAntigravityNativeRuntimeModel,
  createAntigravityModelCatalogProvider,
  createAntigravityProvider,
  normalizeAntigravityModelId,
  type CreateAntigravityProviderOptions,
} from "./provider.js";

