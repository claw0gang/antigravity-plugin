import {
  agentHarnessAttemptTerminal,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessAttemptResult,
  type AgentMessage,
  type NormalizedUsage,
} from "openclaw/plugin-sdk/agent-harness-runtime";

import type { AgyStreamSnapshot, AgyUsage } from "../protocol/agy-stream.js";

type AgentHarnessAttemptTerminal = Extract<
  AgentHarnessAttemptResult,
  { terminal: unknown }
>["terminal"];

function uncachedInputTokens(usage: AgyUsage): number {
  return Math.max(0, usage.input_tokens - usage.cache_read_tokens);
}

function toNormalizedUsage(usage: AgyUsage): NormalizedUsage {
  return {
    input: uncachedInputTokens(usage),
    output: usage.output_tokens,
    cacheRead: usage.cache_read_tokens,
    cacheWrite: 0,
    reasoningTokens: usage.thinking_tokens,
    total: usage.total_tokens,
    contextUsage: {
      state: "available",
      promptTokens: usage.input_tokens,
      totalTokens: usage.total_tokens,
    },
  };
}

function toAssistantUsage(usage: AgyUsage) {
  return {
    input: uncachedInputTokens(usage),
    output: usage.output_tokens,
    cacheRead: usage.cache_read_tokens,
    cacheWrite: 0,
    totalTokens: usage.total_tokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
    contextUsage: {
      state: "available" as const,
      promptTokens: usage.input_tokens,
      totalTokens: usage.total_tokens,
    },
  };
}

function visibleSuccessText(snapshot: AgyStreamSnapshot): string {
  if (snapshot.result.response.trim()) {
    return snapshot.result.response;
  }
  if (snapshot.result.structured_output !== undefined) {
    return JSON.stringify(snapshot.result.structured_output);
  }
  return "";
}

function terminalFromSnapshot(snapshot: AgyStreamSnapshot) {
  switch (snapshot.result.status) {
    case "SUCCESS":
      return agentHarnessAttemptTerminal.normalize({});
    case "CANCELED":
    case "INTERRUPTED":
      return agentHarnessAttemptTerminal.normalize({ aborted: true });
    case "WAITING":
    case "RUNNING":
      return agentHarnessAttemptTerminal.normalize({
        promptError: new Error(`AGY returned nonterminal result status ${snapshot.result.status}`),
        promptErrorSource: "prompt",
      });
    case "ERROR":
    case "INVALID":
      return agentHarnessAttemptTerminal.normalize({
        promptError: new Error(
          snapshot.result.error?.trim() ||
            snapshot.result.response.trim() ||
            `AGY returned ${snapshot.result.status}`,
        ),
        promptErrorSource: "prompt",
      });
  }
}

function toolMetasFromSnapshot(snapshot: AgyStreamSnapshot) {
  return snapshot.toolSteps
    .filter((step) => step.state !== "ACTIVE")
    .map((step) => ({
      toolName: step.tool_name ?? step.tool_info?.name ?? "native_tool",
      ...(step.tool_info?.error ? { isError: true } : {}),
      replaySafe: false,
    }));
}

function itemLifecycleFromSnapshot(snapshot: AgyStreamSnapshot) {
  const stateByIndex = new Map<number, "ACTIVE" | "DONE" | "ERROR">();
  for (const step of snapshot.stepUpdates) {
    const prior = stateByIndex.get(step.step_index);
    if (prior === undefined || prior === "ACTIVE") {
      stateByIndex.set(step.step_index, step.state);
    }
  }
  const startedCount = stateByIndex.size;
  const completedCount = [...stateByIndex.values()].filter((state) => state !== "ACTIVE").length;
  return {
    startedCount,
    completedCount,
    activeCount: Math.max(startedCount - completedCount, 0),
  };
}

export function buildAntigravityAttemptResult(params: {
  attempt: AgentHarnessAttemptParamsV2;
  snapshot: AgyStreamSnapshot;
  runtimeModelId?: string;
  nativeAssistantOutputObserved?: boolean;
  lastToolError?: AgentHarnessAttemptResult["lastToolError"];
}): AgentHarnessAttemptResult {
  const { attempt, snapshot } = params;
  const runtimeModelId = params.runtimeModelId?.trim() || attempt.modelId;
  const success = snapshot.result.status === "SUCCESS";
  const text = success ? visibleSuccessText(snapshot) : "";
  const assistant =
    success && text
      ? ({
          role: "assistant",
          content: [{ type: "text", text }],
          api: "antigravity-native",
          provider: "antigravity",
          model: runtimeModelId,
          usage: toAssistantUsage(snapshot.result.usage),
          stopReason: "stop",
          timestamp: Date.now(),
        } satisfies Extract<AgentMessage, { role: "assistant" }>)
      : undefined;
  const hadPotentialSideEffects = snapshot.toolSteps.length > 0;
  const attemptUsage = toNormalizedUsage(snapshot.result.usage);
  const replaySafe =
    !hadPotentialSideEffects && (success || params.nativeAssistantOutputObserved !== true);
  const replayMetadata = {
    hadPotentialSideEffects,
    replaySafe,
  };

  return {
    terminal: terminalFromSnapshot(snapshot),
    sessionIdUsed: attempt.sessionId,
    agentHarnessId: "antigravity",
    ...(params.runtimeModelId
      ? { runtimeModelSelection: { provider: "antigravity", model: runtimeModelId } }
      : {}),
    messagesSnapshot: assistant ? [assistant] : [],
    assistantTexts: assistant ? [text] : [],
    toolMetas: toolMetasFromSnapshot(snapshot),
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptCompletedAssistant: assistant,
    ...(params.lastToolError ? { lastToolError: params.lastToolError } : {}),
    didSendViaMessagingTool: false,
    didDeliverSourceReplyViaMessageTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSourceReplyPayloads: [],
    toolMediaUrls: [],
    cloudCodeAssistFormatError: false,
    ...(attempt.contextTokenBudget ?? attempt.model.contextWindow
      ? {
          contextTokens: attempt.contextTokenBudget ?? attempt.model.contextWindow,
          contextTokensSource: "resolved" as const,
        }
      : {}),
    attemptUsage,
    replayMetadata,
    currentAttemptReplayMetadata: replayMetadata,
    itemLifecycle: itemLifecycleFromSnapshot(snapshot),
    yieldDetected: false,
  };
}

export function buildAntigravityFailureResult(params: {
  attempt: AgentHarnessAttemptParamsV2;
  error: unknown;
  terminal?: AgentHarnessAttemptTerminal;
  partialReplyObserved?: boolean;
  nativeToolActivityObserved?: boolean;
  lastToolError?: AgentHarnessAttemptResult["lastToolError"];
}): AgentHarnessAttemptResult {
  const error = params.error instanceof Error ? params.error : new Error(String(params.error));
  const hadPotentialSideEffects = params.nativeToolActivityObserved === true;
  const replaySafe = !hadPotentialSideEffects && params.partialReplyObserved !== true;
  return {
    terminal:
      params.terminal ??
      agentHarnessAttemptTerminal.normalize({ promptError: error, promptErrorSource: "prompt" }),
    sessionIdUsed: params.attempt.sessionId,
    agentHarnessId: "antigravity",
    messagesSnapshot: [],
    assistantTexts: [],
    toolMetas: [],
    lastAssistant: undefined,
    currentAttemptAssistant: undefined,
    currentAttemptCompletedAssistant: undefined,
    ...(params.lastToolError ? { lastToolError: params.lastToolError } : {}),
    didSendViaMessagingTool: false,
    didDeliverSourceReplyViaMessageTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSourceReplyPayloads: [],
    toolMediaUrls: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects, replaySafe },
    currentAttemptReplayMetadata: { hadPotentialSideEffects, replaySafe },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    yieldDetected: false,
  };
}
