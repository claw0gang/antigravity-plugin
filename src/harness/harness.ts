import type { AgentHarnessAttemptParamsV2, AgentHarnessV2 } from "../host/types.js";
import { agentHarnessAttemptTerminal } from "../host/terminal.js";
import type { AntigravityPluginConfig } from "../config.js";
import { agyEffortMetadata, deriveAgyNativeModelCapabilities } from "./model-capabilities.js";
import { AgyInventoryError } from "../inventory.js";
import { InvocationScopeError } from "../cli/invocation-scope.js";
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
import { appendDiagnostic, terminalDiagnostic } from "./diagnostics.js";
import { buildAntigravityFailureResult } from "./result.js";

export type CreateAntigravityHarnessOptions = AgyHostInventoryOptions & {
  pluginConfig: AntigravityPluginConfig;
  sessionRuntime: AntigravitySessionRuntime;
  hostContracts?: AntigravityHostContracts;
  nativeCatalogControls?: boolean;
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
    executionEnvironment: "host-only",
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
      if (ctx.modelProvider?.requestTransportOverrides === "present" ||
          ctx.modelProvider?.endpointOverrides === "present") {
        return {
          supported: false,
          reason: "ANTIGRAVITY native runtime cannot reproduce authored provider transport overrides",
        };
      }
      if (ctx.modelProvider?.runtimePolicy &&
          !ctx.modelProvider.runtimePolicy.compatibleIds.includes("antigravity")) {
        return {
          supported: false,
          reason: "prepared provider route does not permit the ANTIGRAVITY native runtime",
        };
      }
      const auth = ctx.modelProvider?.preparedAuth;
      if (auth?.source === "profile" ||
          auth?.source === "direct" ||
          auth?.requirement === "api-key") {
        return {
          supported: false,
          reason: "ANTIGRAVITY uses its native login and cannot forward an OpenClaw credential",
        };
      }
      // Native readiness does not invent an OpenClaw credential or authentication mode.
      // Older hosts omit these route facts; the exact attempt binding is checked below.
      return { supported: true, priority: 100 };
    },

    async runAttempt(attempt) {
      if (attempt.authProfileId || attempt.runtimePlan?.auth.forwardedAuthProfileId ||
          attempt.resolvedApiKey) {
        throw new Error("ANTIGRAVITY uses its native login and cannot forward the selected OpenClaw credential");
      }
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
          nativeEffortControls: options.nativeCatalogControls === true,
          ...(hostContracts ? { hostContracts } : {}),
        });
        try {
          // Keep transcript durability independent from ordinary delivery.
          // Revalidate immediately before the public strict append; the append
          // separately rejects a session-id rebound at its commit boundary.
          await result.antigravityDeliveryGuard?.();
          await persistAntigravityCompletedAssistant({
            attempt: policyNormalized,
            result,
          });
          await result.antigravityDeliveryGuard?.();
          return result;
        } catch (error) {
          const diagnostic = appendDiagnostic(terminalDiagnostic(result.terminal), "delivery", error, result.antigravityEvidence);
          // No assistant payload (even a synthetic explanation) is authorized
          // by a failed fence. Let the host project the terminal diagnostic.
          return {
            ...buildAntigravityFailureResult({
              attempt: policyNormalized,
              evidence: result.antigravityEvidence,
              error: diagnostic,
              suppressNativeOutput: true,
              terminal: agentHarnessAttemptTerminal.setFailure(result.terminal, {
                source: "prompt",
                error: diagnostic,
              }),
            }),
            replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
            currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
          };
        }
      } finally {
        lease?.release();
      }
    },

    readModelCatalogReadiness(ctx) {
      return inventoryOwner.readiness(ctx, options.nativeCatalogControls === true);
    },

    async loadModelCatalog(ctx) {
      try {
        const models = options.nativeCatalogControls
          ? await inventoryOwner.catalogModels(ctx, (ctx.configuredModelRefs ?? [])
              .filter(ref => ref.provider === "antigravity").map(ref => ref.model))
          : await inventoryOwner.models(ctx);
        const entries = models.map(model => {
          const params = agyEffortMetadata(model);
          return {
            id: model.id, name: model.name, provider: "antigravity", nativeRuntime: "antigravity",
            reasoning: deriveAgyNativeModelCapabilities(model.id, models).reasoning,
            ...(params === undefined ? {} : { params }),
          };
        });
        return options.nativeCatalogControls
          ? { entries, outcomes: [{ provider: "antigravity", status: "ready" as const }] }
          : entries;
      } catch (error) {
        // Generation/cancellation remain terminal to this publication. A
        // classified acquisition failure is not evidence of AGY login failure.
        if (options.nativeCatalogControls && (
          (error instanceof AgyInventoryError && !["retired", "aborted"].includes(error.kind)) ||
          (error instanceof InvocationScopeError && error.kind !== "aborted")
        )) return { entries: [], outcomes: [{ provider: "antigravity", status: "unavailable" }] };
        throw error;
      }
    },

    // Retire the physical observation owner with its native runtime generation.
    // Service shutdown is retained for hosts using the service lifecycle.
    dispose() { inventoryOwner.stop(); },

    // No reset hook: OpenClaw owns reset admission, abort/drain and replacement
    // of its canonical entry, including this plugin's binding extension. A
    // second plugin reset would run for unrelated harnesses and cannot safely
    // resolve a store from AgentHarnessResetParams. Attempt and delivery guards
    // still reject an old lifecycle revision or a missing/replaced entry.
  };
}
