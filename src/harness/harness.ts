import type { AgentHarnessAttemptParamsV2, AgentHarnessV2 } from "../host/types.js";
import { agentHarnessAttemptTerminal } from "../host/terminal.js";
import type { AntigravityPluginConfig } from "../config.js";
import { deriveAgyNativeModelCapabilities } from "./model-capabilities.js";
import { resolveAgyHostInventoryOwner, type AgyHostInventoryOptions } from "../inventory-scope.js";
import { runAntigravityAttempt } from "./run-attempt.js";
import {
  AntigravitySessionBindings,
  type AntigravitySessionRuntime,
} from "./session-bindings.js";
import type { AntigravityHostContracts } from "./host-contracts.js";
import {
  AntigravityNativeAgentCarrierManager,
  type AntigravityNativeAgentCarrierLease,
} from "./native-agent-carrier.js";
import { ANTIGRAVITY_OPENCLAW_SAFE_DENY_TOOLS } from "./tool-policy.js";
import { persistAntigravityCompletedAssistant } from "./transcript-result.js";

export type CreateAntigravityHarnessOptions = AgyHostInventoryOptions & {
  pluginConfig: AntigravityPluginConfig;
  sessionRuntime: AntigravitySessionRuntime;
  hostContracts?: AntigravityHostContracts;
};

/**
 * OpenClaw's built-in legacy context engine is a host-owned compatibility wrapper:
 * it adds no separate context-engine instruction carrier and OpenClaw itself exempts
 * it from harness context-engine capability requirements. Strip only that exact
 * wrapper before ANTIGRAVITY's generic P04 projection. Non-legacy engines remain
 * visible and therefore fail closed unless separately qualified.
 */
export function normalizeOpenClawLegacyContextEngineAttempt(
  attempt: AgentHarnessAttemptParamsV2,
): AgentHarnessAttemptParamsV2 {
  if (attempt.contextEngine?.info?.id !== "legacy") {
    return attempt;
  }
  const normalized = { ...attempt };
  delete normalized.contextEngine;
  return normalized;
}

export function normalizeCarrierEnforcedSafeDenies(
  attempt: AgentHarnessAttemptParamsV2,
  lease: AntigravityNativeAgentCarrierLease | undefined,
): AgentHarnessAttemptParamsV2 {
  if (!attempt.pluginHarnessToolPolicySafeDeniedTools?.length) return attempt;
  if (!lease) {
    throw new Error("ANTIGRAVITY safe-deny policy reached execution without a native carrier");
  }
  const requested = [...attempt.pluginHarnessToolPolicySafeDeniedTools].sort();
  const enforced = [...lease.safeDeniedTools].sort();
  if (JSON.stringify(requested) !== JSON.stringify(enforced)) {
    throw new Error("ANTIGRAVITY native carrier does not match the exact OpenClaw safe-deny set");
  }
  // OpenClaw has already reduced its restrictive-policy summary to the exact
  // deny names this harness certifies. The generated AGY agent definition
  // enforces those native equivalents. Consume both representations of that
  // same policy before the generic projector evaluates any remaining,
  // independently-authored restrictions.
  const normalized = { ...attempt };
  delete normalized.pluginHarnessToolPolicySafeDeniedTools;
  if (normalized.pluginHarnessToolPolicyRestricted === true) {
    delete normalized.pluginHarnessToolPolicyRestricted;
  }
  return normalized;
}

export function bindCarrierPluginConfig(
  pluginConfig: AntigravityPluginConfig,
  lease: AntigravityNativeAgentCarrierLease | undefined,
): AntigravityPluginConfig {
  if (!lease) return pluginConfig;
  // A generated carrier is the exact native enforcement boundary for OpenClaw
  // conversation policy. Never combine it with AGY's explicit permission bypass,
  // even when the ambient plugin config opts ordinary runs into that bypass.
  return Object.freeze({
    ...pluginConfig,
    agent: lease.agentName,
    dangerouslySkipPermissions: false,
  });
}

function bindCarrierHostContracts(
  hostContracts: AntigravityHostContracts | undefined,
  lease: AntigravityNativeAgentCarrierLease | undefined,
): AntigravityHostContracts | undefined {
  if (!lease) return hostContracts;
  if (!hostContracts) return undefined;
  const existing = hostContracts.context;
  if (existing?.namedAgentCarrier) {
    throw new Error("ANTIGRAVITY cannot layer a generated OpenClaw carrier over another native agent carrier");
  }
  const generatedCarrier = lease.adapter.namedAgentCarrier;
  if (!generatedCarrier) {
    throw new Error("ANTIGRAVITY generated native carrier lease is missing its qualified carrier binding");
  }
  return {
    ...hostContracts,
    context: {
      ...(existing?.requirements ? { requirements: existing.requirements } : {}),
      namedAgentCarrier: generatedCarrier,
    },
  };
}

export function createAntigravityHarness(
  options: CreateAntigravityHarnessOptions,
): AgentHarnessV2 {
  const inventoryOwner = resolveAgyHostInventoryOwner(options);
  const sessionBindings = new AntigravitySessionBindings(options.sessionRuntime, {
    ...(options.hostContracts ? { atomicMutation: options.hostContracts.sessionMutation } : {}),
  });
  const carrierManager = new AntigravityNativeAgentCarrierManager();

  return {
    id: "antigravity",
    label: "Google Antigravity native agent runtime",
    autoSelection: { providerIds: ["antigravity"] },
    authBootstrap: "harness",
    conversationToolPolicySupport: "exact",
    conversationToolPolicySafeDenyTools: ANTIGRAVITY_OPENCLAW_SAFE_DENY_TOOLS,

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
      const legacyNormalized = normalizeOpenClawLegacyContextEngineAttempt(attempt);
      const lease = carrierManager.acquire(legacyNormalized);
      try {
        if (lease && options.pluginConfig.agent) {
          throw new Error(
            "ANTIGRAVITY cannot combine plugin config.agent with the generated OpenClaw policy/system carrier",
          );
        }
        const policyNormalized = normalizeCarrierEnforcedSafeDenies(legacyNormalized, lease);
        const pluginConfig = bindCarrierPluginConfig(options.pluginConfig, lease);
        const hostContracts = bindCarrierHostContracts(options.hostContracts, lease);
        const result = await runAntigravityAttempt({
          attempt: policyNormalized,
          pluginConfig,
          sessionBindings,
          inventory: inventoryOwner.inventory,
          ...(hostContracts ? { hostContracts } : {}),
        });
        try {
          // Keep transcript durability independent from ordinary delivery.
          // Revalidate immediately before the public strict append; the append
          // separately rejects a session-id rebound at its commit boundary.
          result.antigravityDeliveryGuard?.();
          await persistAntigravityCompletedAssistant({
            attempt: policyNormalized,
            result,
          });
          return result;
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          // Native completion already happened. A missing canonical mirror is
          // not safely replayable; fail closed without repeating AGY work.
          return {
            ...result,
            terminal: agentHarnessAttemptTerminal.setFailure(result.terminal, {
              source: "prompt",
              error: failure,
            }),
            antigravityOutcome: Object.freeze({
              ...result.antigravityOutcome,
              kind: result.antigravityOutcome.availableOutput ? "partial" : "failed",
              explanation:
                `ANTIGRAVITY: Native completion transcript persistence failed. ${failure.message}`,
            }),
            replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
            currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
          };
        }
      } finally {
        lease?.release();
      }
    },

    async loadModelCatalog(ctx) {
      const models = await inventoryOwner.models(ctx);
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
      const requested = {
        openclawSessionId: params.sessionId,
        ...(params.sessionKey?.trim() ? { openclawSessionKey: params.sessionKey } : {}),
        ...(params.agentId?.trim() ? { agentId: params.agentId } : {}),
      };
      const host = options.hostContracts;
      if (!host?.resolveResetSession || !host.cancelAndDrain) {
        throw new Error("ANTIGRAVITY reset requires qualified canonical target resolution and host cancellation/drain (P05)");
      }
      const target = host.resolveResetSession(requested);
      if (target.openclawSessionId !== requested.openclawSessionId ||
          (requested.openclawSessionKey !== undefined && target.openclawSessionKey !== requested.openclawSessionKey) ||
          (requested.agentId !== undefined && target.agentId !== requested.agentId)) {
        throw new Error("ANTIGRAVITY reset adapter resolved a different canonical session");
      }
      await sessionBindings.clear({ ...target,
        cancelAndDrain: () => host.cancelAndDrain!(target),
      });
    },
  };
}
