import {
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";

import { buildAntigravityCliBackend } from "./backend.js";
import {
  antigravityConfigSchema,
  resolveAntigravityPluginConfig,
} from "./config.js";
import { createAntigravityHarness } from "./harness/harness.js";
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
    const config = resolveAntigravityPluginConfig(api.pluginConfig);
    const providerOptions = { pluginConfig: config };
    api.registerProvider(createAntigravityProvider(providerOptions));
    api.registerModelCatalogProvider(createAntigravityModelCatalogProvider(providerOptions));
    api.registerAgentHarness(
      createAntigravityHarness({
        pluginConfig: config,
        sessionRuntime: api.runtime.agent.session,
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
