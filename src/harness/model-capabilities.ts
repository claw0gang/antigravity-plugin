import type { AgentHarnessAttemptParamsV2 } from "../host/types.js";

import type { AgyDiscoveredModel } from "./model-catalog.js";

export type AgyEffortBucket = "low" | "medium" | "high";

type OpenClawThinkLevel = AgentHarnessAttemptParamsV2["thinkLevel"];

export type AgyNativeModelCapabilities = {
  adjustableReasoning: false;
  reasoning: false;
};

export type ResolvedAgyAttemptModel = {
  requestedModelId: string;
  modelId: string;
  adjustableReasoning: false;
  requestedThinkLevel: OpenClawThinkLevel;
  selectedEffort?: AgyEffortBucket;
};

const GEMINI_EFFORT_MODEL = /^(gemini-.+)-(low|medium|high)$/u;

function parseGeminiEffortModel(modelId: string):
  | { familyId: string; effort: AgyEffortBucket }
  | undefined {
  const match = GEMINI_EFFORT_MODEL.exec(modelId);
  if (!match) return undefined;
  return {
    familyId: match[1]!,
    effort: match[2]! as AgyEffortBucket,
  };
}

/**
 * AGY publishes effort-qualified Gemini siblings as distinct executable model
 * ids. ANTIGRAVITY therefore exposes each live id as an exact model selection,
 * not as an OpenClaw-adjustable reasoning facade. A host/default think level
 * must never silently replace an explicitly selected AGY model with a sibling.
 */
export function deriveAgyNativeModelCapabilities(
  _modelId: string,
  _liveModels: readonly AgyDiscoveredModel[],
): AgyNativeModelCapabilities {
  return { adjustableReasoning: false, reasoning: false };
}

export function resolveAgyAttemptModel(params: {
  modelId: string;
  thinkLevel: OpenClawThinkLevel;
  liveModels: readonly AgyDiscoveredModel[];
}): ResolvedAgyAttemptModel {
  const requestedModelId = params.modelId;
  if (!requestedModelId || requestedModelId !== requestedModelId.trim()) {
    throw new Error("ANTIGRAVITY model id must not be empty");
  }
  if (!params.liveModels.some((model) => model.id === requestedModelId)) {
    throw new Error(`AGY live model inventory no longer advertises ${requestedModelId}`);
  }

  const effort = parseGeminiEffortModel(requestedModelId)?.effort;
  return {
    requestedModelId,
    modelId: requestedModelId,
    adjustableReasoning: false,
    requestedThinkLevel: params.thinkLevel,
    ...(effort ? { selectedEffort: effort } : {}),
  };
}

export function assertAgyResumeModelConsistency(params: {
  boundModelId?: string;
  resolvedModelId: string;
  conversationId: string;
}): void {
  const boundModelId = params.boundModelId;
  if (!boundModelId) {
    throw new Error(
      `AGY conversation ${params.conversationId} has no canonical bound model id; reset the OpenClaw session before resuming`,
    );
  }
  if (boundModelId !== params.resolvedModelId) {
    throw new Error(
      `AGY conversation ${params.conversationId} is bound to model ${boundModelId}, not ${params.resolvedModelId}`,
    );
  }
}

