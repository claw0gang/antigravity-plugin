import { definePluginEntry } from "./host/entry.js";
import { assertOpenClawCompatibility, supportsNativeCatalogControls } from "./host/compatibility.js";
import { createOpenClawAntigravityHostContracts } from "./host/contracts.js";
import { createAntigravitySessionRuntime } from "./host/session-runtime.js";
import type { OpenClawPluginApi } from "./host/types.js";

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
    const nativeCatalogControls = supportsNativeCatalogControls(api.runtime.version);
    const providerOptions = { pluginConfig: config, inventoryOwner, nativeCatalogControls };
    const sessionRuntime = createAntigravitySessionRuntime(api.runtime.agent.session);
    const hostContracts = createOpenClawAntigravityHostContracts({ sessionRuntime });
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
        nativeCatalogControls,
        sessionRuntime,
        hostContracts,
      }),
    );
  },
});

export default antigravityPlugin;

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
  ANTIGRAVITY_PROVIDER_ID,
  buildAntigravityNativeRuntimeModel,
  createAntigravityModelCatalogProvider,
  createAntigravityProvider,
  type CreateAntigravityProviderOptions,
} from "./provider.js";

