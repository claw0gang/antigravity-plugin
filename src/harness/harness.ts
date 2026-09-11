import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness-runtime";

import type { AntigravityPluginConfig } from "../config.js";
import { deriveAgyNativeModelCapabilities } from "./model-capabilities.js";
import { discoverAgyModels } from "./model-catalog.js";
import { runAntigravityAttempt } from "./run-attempt.js";
import {
  AntigravitySessionBindings,
  type AntigravitySessionRuntime,
} from "./session-bindings.js";

export type CreateAntigravityHarnessOptions = {
  pluginConfig: AntigravityPluginConfig;
  sessionRuntime: AntigravitySessionRuntime;
};

export function createAntigravityHarness(
  options: CreateAntigravityHarnessOptions,
): AgentHarnessV2 {
  const sessionBindings = new AntigravitySessionBindings(options.sessionRuntime);

  return {
    id: "antigravity",
    label: "Google Antigravity native agent runtime",
    autoSelection: { providerIds: ["antigravity"] },
    authBootstrap: "harness",

    supports(ctx) {
      if (ctx.provider !== "antigravity") {
        return { supported: false, reason: "provider is not owned by ANTIGRAVITY" };
      }
      if (
        ctx.providerOwnerStatus !== undefined &&
        (ctx.providerOwnerStatus !== "owned" ||
          !ctx.providerOwnerPluginIds?.includes("antigravity"))
      ) {
        return {
          supported: false,
          reason: "effective antigravity provider route is not exclusively owned by this plugin",
        };
      }
      if (ctx.modelProvider?.requestTransportOverrides === "present") {
        return {
          supported: false,
          reason: "ANTIGRAVITY native runtime cannot reproduce authored provider transport overrides",
        };
      }
      return { supported: true, priority: 100 };
    },

    async runAttempt(attempt) {
      return await runAntigravityAttempt({
        attempt,
        pluginConfig: options.pluginConfig,
        sessionBindings,
      });
    },

    async loadModelCatalog() {
      const models = await discoverAgyModels({ command: options.pluginConfig.command });
      return models.map((model) => ({
        id: model.id,
        name: model.name,
        provider: "antigravity",
        nativeRuntime: "antigravity",
        reasoning: deriveAgyNativeModelCapabilities(model.id, models).reasoning,
      }));
    },

    async reset(params) {
      if (!params.sessionId?.trim()) return;
      await sessionBindings.clear({
        openclawSessionId: params.sessionId,
        ...(params.sessionKey?.trim() ? { openclawSessionKey: params.sessionKey } : {}),
        ...(params.agentId?.trim() ? { agentId: params.agentId } : {}),
      });
    },
  };
}
