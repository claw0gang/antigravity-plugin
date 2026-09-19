import {
  loadOpenClawTranscriptRuntime,
  prepareOpenClawAssistantTranscriptMessage,
  type OpenClawTranscriptRuntime,
} from "../host/transcript.js";
import type { AgentHarnessAttemptParamsV2, AgentMessage } from "../host/types.js";
import type { AntigravityAttemptResult } from "./result.js";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

export type AntigravityTranscriptPersistence = Readonly<{
  owned: boolean;
  idempotencyKey?: string;
  completedAssistant?: AssistantMessage;
}>;

function zeroUsage(): AssistantMessage["usage"] {
  // This message is a transcript/display projection, not AGY billing evidence.
  // OpenClaw's own external-CLI transcript bridge uses structural zero usage when
  // native per-turn accounting is not safely attributable. attemptUsage remains
  // independently unavailable and is never derived from this projection.
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function completedNativeText(result: AntigravityAttemptResult): string | undefined {
  if (result.terminal.kind !== "ok" || result.antigravityOutcome.kind !== "completed") {
    return undefined;
  }
  for (let index = result.assistantTexts.length - 1; index >= 0; index -= 1) {
    const text = result.assistantTexts[index];
    if (text?.trim()) return text;
  }
  return undefined;
}

function assistantVisibleText(message: AssistantMessage): string {
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

/**
 * Persist one successful native final answer through OpenClaw's admitted
 * transcript target as a durability mirror. Delivery remains owned by the
 * AgentHarness result path; transcript branch placement must not control or
 * suppress ordinary subagent completion/announcement.
 */
export async function persistAntigravityCompletedAssistant(params: {
  attempt: AgentHarnessAttemptParamsV2;
  result: AntigravityAttemptResult;
  runtime?: OpenClawTranscriptRuntime;
  now?: () => number;
}): Promise<AntigravityTranscriptPersistence> {
  const text = completedNativeText(params.result);
  if (!text) return { owned: false };

  const admission = params.attempt.userTurnTranscriptRecorder?.getAdmissionReceipt();
  if (!admission) {
    // Synthetic, detached, or otherwise non-admitted attempts keep the existing
    // assistantTexts-only result path. Never invent transcript authority.
    return { owned: false };
  }

  params.attempt.hostCapabilities.assertActive();
  const idempotencyKey = `antigravity-assistant:${params.attempt.runId}`;
  const runtimeModel = params.result.runtimeModelSelection?.model ?? params.attempt.modelId;
  const sourceMessage: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: params.attempt.model.api ?? "openai-responses",
    provider: "antigravity",
    model: runtimeModel,
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: (params.now ?? Date.now)(),
  };
  const prepared = prepareOpenClawAssistantTranscriptMessage({
    message: sourceMessage,
    agentId: admission.agentId,
    sessionKey: admission.sessionKey,
    ...(params.attempt.prepareAssistantTranscriptMessage
      ? { prepareAssistantTranscriptMessage: params.attempt.prepareAssistantTranscriptMessage }
      : {}),
  });
  if (!prepared) {
    // A host transcript hook made the authoritative decision to suppress this row.
    return { owned: true };
  }
  if (prepared.role !== "assistant") {
    throw new Error("ANTIGRAVITY assistant transcript hook returned a non-assistant message");
  }
  if (!assistantVisibleText(prepared).trim() && !(prepared.openclawDelivery?.mediaUrls?.length)) {
    return { owned: true };
  }

  const runtime = params.runtime ?? (await loadOpenClawTranscriptRuntime());
  const message = { ...prepared, idempotencyKey } as AssistantMessage & { idempotencyKey: string };
  params.attempt.hostCapabilities.assertActive();
  const append = await runtime.appendAssistant({
    agentId: admission.agentId,
    sessionId: admission.sessionId,
    sessionKey: admission.sessionKey,
    storePath: admission.storePath,
    config: params.attempt.config,
    idempotencyLookup: "scan",
    message,
    // Bind this native answer to the exact admitted user turn rather than the
    // mutable transcript leaf. Session replacement is separately rejected by
    // the strict public append operation.
    parentId: admission.entryId,
  });
  if (append.kind === "rejected") {
    throw new Error("ANTIGRAVITY completed assistant transcript target changed before persistence");
  }
  if (append.kind !== "result") {
    throw new Error("ANTIGRAVITY completed assistant transcript was unexpectedly suppressed");
  }
  if (append.result.message.role !== "assistant") {
    throw new Error("ANTIGRAVITY strict transcript append returned a non-assistant message");
  }
  const completedAssistant = append.result.message;

  if (append.result.appended) {
    try {
      // The strict append is the commit boundary. If attempt authority changes
      // while that awaited commit is in flight, the committed row remains
      // canonical and owned; only the optional notification is suppressed.
      params.attempt.hostCapabilities.assertActive();
      await runtime.publishUpdate({
        agentId: admission.agentId,
        sessionId: admission.sessionId,
        sessionKey: admission.sessionKey,
        storePath: admission.storePath,
      });
    } catch {
      // A post-commit authority change or notification failure cannot invalidate
      // the canonical assistant row or trigger duplicate native inference/tool work.
    }
  }
  return { owned: true, idempotencyKey, completedAssistant };
}
