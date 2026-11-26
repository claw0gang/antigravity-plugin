import type { AgentHarnessAttemptParamsV2 } from "../host/types.js";
import type { AgyDiscoveredModel } from "./model-catalog.js";

export const AGY_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgyEffortBucket = typeof AGY_EFFORT_LEVELS[number];
type OpenClawThinkLevel = AgentHarnessAttemptParamsV2["thinkLevel"];

export type AgyEffortObservation =
  | Readonly<{ adjustable: false }>
  | Readonly<{ adjustable: true; current: AgyEffortBucket; available: readonly AgyEffortBucket[] }>;

/** Exact native /model record, not a synthesized model slug. */
export type AgySelectedModel = Readonly<{
  id: string;
  label: string;
  effort: AgyEffortBucket;
  is_default: boolean;
}>;

export type AgyNativeModelCapabilities = {
  adjustableReasoning: boolean;
  reasoning: boolean;
};

export type ResolvedAgyAttemptModel = {
  requestedModelId: string;
  modelId: string;
  adjustableReasoning: boolean;
  requestedThinkLevel: OpenClawThinkLevel;
  selectedEffort?: AgySelectedModel;
};

export type AgyEffortFailure = "unverified-report" | "unsupported-level" |
  "fixed-or-unobserved" | "effective-model-unverified" | "resume-variant-change" |
  "probe-unavailable";

export class AgyEffortError extends Error {
  readonly kind: AgyEffortFailure;
  constructor(kind: AgyEffortFailure, options?: ErrorOptions) {
    super(`ANTIGRAVITY native effort: ${kind}; select an exact advertised model or refresh native effort metadata`, options);
    this.name = "AgyEffortError";
    this.kind = kind;
  }
}

export function isAgyEffort(value: unknown): value is AgyEffortBucket {
  return AGY_EFFORT_LEVELS.some(level => level === value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Only the native zero-turn slash-command envelope is capability evidence.
 * Do not trust human diagnostic text, guessed families, or an inference result. */
function readOnlyReport(stdout: string, name: "effort" | "model") {
  let envelope: Record<string, unknown> | undefined;
  try { envelope = record(JSON.parse(stdout)); } catch { /* reject below */ }
  const command = record(envelope?.command);
  const usage = record(envelope?.usage);
  if (envelope?.status !== "SUCCESS" || envelope.conversation_id !== "" ||
      envelope.num_turns !== 0 || usage?.total_tokens !== 0 ||
      ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens"].some(key => usage[key] !== undefined && usage[key] !== 0) ||
      command?.name !== name || !record(command.data)) {
    throw new AgyEffortError("unverified-report");
  }
  return { data: record(command.data)!, response: envelope.response };
}

function effortObservation(value: unknown): AgyEffortObservation | undefined {
  const data = record(value);
  if (data?.adjustable === false) return Object.freeze({ adjustable: false });
  if (data?.adjustable !== true || !isAgyEffort(data.current) ||
      !Array.isArray(data.available) || !data.available.every(isAgyEffort) ||
      !data.available.includes(data.current) || new Set(data.available).size !== data.available.length) return undefined;
  return Object.freeze({ adjustable: true, current: data.current,
    available: Object.freeze([...data.available]) });
}

export function parseAgyEffortOutput(stdout: string): AgyEffortObservation {
  const observation = effortObservation(readOnlyReport(stdout, "effort").data);
  if (!observation) throw new AgyEffortError("unverified-report");
  return observation;
}

/** Require the observed structured /model record and exact TSV response.
 * The caller separately checks exit zero. A label alone is not identity. */
export function parseAgySelectedModelOutput(
  stdout: string, liveModels: readonly AgyDiscoveredModel[], expectedId: string,
): AgySelectedModel {
  const { data, response } = readOnlyReport(stdout, "model");
  if (data.id !== expectedId || typeof data.label !== "string" ||
      !isAgyEffort(data.effort) || typeof data.is_default !== "boolean") {
    throw new AgyEffortError("effective-model-unverified");
  }
  const matches = liveModels.filter(row => row.id === expectedId && row.name === data.label);
  if (matches.length !== 1 || typeof response !== "string" ||
      response.replace(/\r?\n$/u, "") !== `${expectedId}\t${data.label}`) {
    throw new AgyEffortError("effective-model-unverified");
  }
  return Object.freeze({ id: expectedId, label: data.label, effort: data.effort, is_default: data.is_default });
}

/** Both argv values must come from the same checked native record. */
export function assertAgyEffortPair(modelId: string, selected: AgySelectedModel): AgyEffortBucket {
  if (selected.id !== modelId || !isAgyEffort(selected.effort)) {
    throw new AgyEffortError("effective-model-unverified");
  }
  return selected.effort;
}

/** Secret-free display metadata only. Runtime admission always re-observes AGY. */
export function agyEffortMetadata(model: AgyDiscoveredModel): Record<string, unknown> | undefined {
  return model.effort ? { antigravityEffort: { modelId: model.id, observation: model.effort } } : undefined;
}

/** The host does not expose thinkingExplicit to AgentHarnessV2. Off means
 * retain the exact native selection, NOT turn native reasoning off. Explicit
 * or configured effective levels are sent only after fresh native validation. */
export function resolveAgyThinkingProfile(ctx: { provider: string; modelId: string; params?: Record<string, unknown> }) {
  if (ctx.provider !== "antigravity") return undefined;
  const metadata = record(ctx.params?.antigravityEffort);
  const observation = metadata?.modelId === ctx.modelId ? effortObservation(metadata.observation) : undefined;
  return {
    levels: [{ id: "off" as const, label: "Native selection" },
      ...(observation?.adjustable ? observation.available.map(id => ({ id })) : [])],
    defaultLevel: "off" as const,
  };
}

export function deriveAgyNativeModelCapabilities(
  modelId: string,
  liveModels: readonly AgyDiscoveredModel[],
): AgyNativeModelCapabilities {
  const adjustable = liveModels.find(row => row.id === modelId)?.effort?.adjustable === true;
  return { adjustableReasoning: adjustable, reasoning: adjustable };
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
  if (!params.liveModels.some(model => model.id === requestedModelId)) {
    throw new Error(`AGY live model inventory no longer advertises ${requestedModelId}`);
  }
  return {
    requestedModelId, modelId: requestedModelId, adjustableReasoning: false,
    requestedThinkLevel: params.thinkLevel,
  };
}

/** AGY's documented catalog labels end in a parenthesized effort. Use that
 * format only to locate candidates; structured native reports must verify
 * both endpoints. No slug rewriting, static family list or fuzzy matching. */
function effortLabel(label: string): { name: string; effort: AgyEffortBucket } | undefined {
  const match = /^(.+) \((low|medium|high|xhigh|max)\)$/iu.exec(label);
  if (!match) return undefined;
  const effort = match[2]!.toLowerCase();
  return isAgyEffort(effort) ? { name: match[1]!, effort } : undefined;
}

type AgyEffortRequest = {
  modelId: string;
  thinkLevel: OpenClawThinkLevel;
  liveModels: readonly AgyDiscoveredModel[];
  observation: AgyEffortObservation;
};

export function requireAgyEffort(params: AgyEffortRequest): AgyEffortBucket {
  if (!params.observation.adjustable) throw new AgyEffortError("fixed-or-unobserved");
  if (!isAgyEffort(params.thinkLevel) || !params.observation.available.includes(params.thinkLevel)) {
    throw new AgyEffortError("unsupported-level");
  }
  return params.thinkLevel;
}

export function selectAgyEffortCandidate(params: AgyEffortRequest & {
  requestedModel: AgySelectedModel;
}): string {
  resolveAgyAttemptModel(params);
  const effort = requireAgyEffort(params);
  const { requestedModel, observation, liveModels, modelId } = params;
  if (!observation.adjustable || requestedModel.id !== modelId ||
      requestedModel.effort !== observation.current ||
      liveModels.filter(row => row.id === modelId && row.name === requestedModel.label).length !== 1) {
    throw new AgyEffortError("effective-model-unverified");
  }
  if (effort === observation.current) return modelId;
  const origin = effortLabel(requestedModel.label);
  if (!origin || origin.effort !== observation.current) {
    throw new AgyEffortError("effective-model-unverified");
  }
  const matches = (level: AgyEffortBucket) => liveModels.filter(row => {
    const label = effortLabel(row.name);
    return label?.name === origin.name && label.effort === level;
  });
  const current = matches(observation.current);
  const target = matches(effort);
  if (current.length !== 1 || current[0]!.id !== modelId || target.length !== 1) {
    throw new AgyEffortError("effective-model-unverified");
  }
  return target[0]!.id;
}

export function resolveAgyEffortSelection(params: AgyEffortRequest & {
  requestedModel?: AgySelectedModel;
  effectiveModel?: AgySelectedModel;
  effectiveObservation?: AgyEffortObservation;
  boundModelId?: string;
}): ResolvedAgyAttemptModel {
  const base = resolveAgyAttemptModel(params);
  if (params.thinkLevel === "off") return base;
  const effort = requireAgyEffort(params);
  if (!params.requestedModel || !params.observation.adjustable) {
    throw new AgyEffortError("effective-model-unverified");
  }
  const modelId = selectAgyEffortCandidate({ ...params, requestedModel: params.requestedModel });
  const selected = params.effectiveModel ?? params.requestedModel;
  if (selected.id !== modelId || selected.effort !== effort ||
      params.liveModels.filter(row => row.id === modelId && row.name === selected.label).length !== 1) {
    throw new AgyEffortError("effective-model-unverified");
  }
  if (modelId !== base.modelId) {
    const observation = params.effectiveObservation;
    // Corroborate the native effort relationship, not just similar labels.
    if (!observation?.adjustable || observation.current !== effort ||
        observation.available.length !== params.observation.available.length ||
        !params.observation.available.every(level => observation.available.includes(level))) {
      throw new AgyEffortError("effective-model-unverified");
    }
  }
  if (params.boundModelId !== undefined && params.boundModelId !== modelId) {
    throw new AgyEffortError("resume-variant-change");
  }
  return { ...base, modelId, adjustableReasoning: true, selectedEffort: selected };
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
