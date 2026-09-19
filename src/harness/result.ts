import { agentHarnessAttemptTerminal } from "../host/terminal.js";
import {
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessAttemptResult,
  type AgentMessage,
  type NormalizedUsage,
} from "../host/types.js";

import {
  createAttemptEvidence,
  isReplaySafe,
  recordSnapshotAccounting,
  snapshotAttemptEvidence,
  type AttemptEvidence,
} from "../cli/attempt-evidence.js";
import type {
  AgyDeniedAction,
  AgyStreamPartialSnapshot,
  AgyStreamSnapshot,
} from "../protocol/agy-stream.js";

/** Local projection for t004; these are not additional OpenClaw SDK fields. */
export type AntigravityOutcome = Readonly<{
  kind: "completed" | "partial" | "blocked" | "timeout" | "canceled" | "failed";
  /** Native text availability is not proof that every requested action completed. */
  availableOutput: boolean;
  nativeStatus?: string;
  deniedActions: ReadonlyArray<Readonly<AgyDeniedAction>>;
  nativeTimeout: boolean;
  hostReason?: string;
  /** Explicit adapter attribution; never counted as native output or usage. */
  explanation?: string;
}>;

/** Local evidence and outcome; the SDK's terminal/result contract is unchanged. */
export type AntigravityAttemptResult = Extract<AgentHarnessAttemptResult, { terminal: unknown }> & {
  antigravityEvidence: AttemptEvidence;
  /** Internal t004 final-consumer fence. Invoke at the actual host commit edge;
   * this is not an upstream SDK field and pre-return checks do not replace it. */
  antigravityDeliveryGuard?: () => void;
  antigravityOutcome: AntigravityOutcome;
};

type AgentHarnessAttemptTerminal = Extract<
  AgentHarnessAttemptResult,
  { terminal: unknown }
>["terminal"];

function unknownAttemptUsage(): NormalizedUsage {
  // Aggregate AGY counters cannot qualify a current-turn bill or the final
  // context snapshot. Optional numeric fields (including cost) remain absent.
  return {
    contextUsage: { state: "unavailable" },
  };
}

function completedAssistantMessage(params: {
  attempt: AgentHarnessAttemptParamsV2;
  text: string;
  runtimeModelId: string;
}): Extract<AgentMessage, { role: "assistant" }> {
  // OpenClaw's AssistantMessage schema requires numeric usage. This all-zero
  // snapshot is structural transcript/delivery metadata only: attemptUsage
  // remains explicitly unavailable and raw AGY counters remain in
  // antigravityEvidence, so host accounting never treats aggregate native
  // counters as a current-turn bill.
  return {
    role: "assistant",
    content: [{ type: "text", text: params.text }],
    api: params.attempt.model.api ?? "openai-responses",
    provider: "antigravity",
    model: params.runtimeModelId,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function visibleText(snapshot: AgyStreamPartialSnapshot): string {
  if (snapshot.result?.response.trim()) {
    return snapshot.result.response;
  }
  if (snapshot.result?.structured_output !== undefined) {
    return JSON.stringify(snapshot.result.structured_output);
  }
  return snapshot.assistantText;
}

function evidenceForResult(params: {
  modelId: string;
  evidence?: AttemptEvidence;
  snapshot?: AgyStreamPartialSnapshot;
  completeProtocol?: boolean;
  outputObserved?: boolean;
  toolActivityObserved?: boolean;
}): AttemptEvidence {
  const source = params.evidence;
  const evidence: AttemptEvidence = source
    ? {
        ...source, terminal: { ...source.terminal }, termination: { ...source.termination },
        accounting: {
          ...source.accounting,
          ...(source.accounting.raw ? { raw: { ...source.accounting.raw } } : {}),
          steps: source.accounting.steps.map((step) => ({ ...step, raw: { ...step.raw } })),
        },
      }
    : {
        ...createAttemptEvidence(params.modelId),
        invocation: "possible",
        effects: "unknown",
        termination: { containment: "unqualified", cleanupComplete: false },
      };
  const snapshot = params.snapshot;
  if (snapshot) recordSnapshotAccounting(evidence, snapshot);
  const hasSnapshotFacts = snapshot !== undefined && Boolean(
    snapshot.init || snapshot.result || snapshot.conversationId || snapshot.assistantText ||
    snapshot.stepUpdates.length || snapshot.toolSteps.length,
  );
  const toolActivity = params.toolActivityObserved === true || (snapshot?.toolSteps.length ?? 0) > 0;
  const outputObserved = params.outputObserved === true ||
    (snapshot !== undefined && visibleText(snapshot).length > 0);
  if (hasSnapshotFacts || toolActivity || outputObserved) {
    if (evidence.invocation === "not_started" && evidence.effects === "none_proven") {
      // A stale pre-launch object cannot contradict observations of this invocation.
      evidence.effects = "unknown";
    }
    evidence.invocation = "started";
    if (evidence.termination.containment === "not_started") {
      evidence.termination.containment = "unqualified";
      evidence.termination.cleanupComplete = false;
    }
  }
  if (toolActivity) evidence.effects = "observed_possible";
  evidence.outputObserved ||= outputObserved;
  if (evidence.requestedModelId === undefined) evidence.requestedModelId = params.modelId;
  if (snapshot?.init) evidence.acknowledgedModelId = snapshot.init.model;
  if (snapshot?.conversationId) evidence.conversationId = snapshot.conversationId;
  if (snapshot?.result) {
    evidence.terminal.nativeStatus = snapshot.result.status;
    evidence.terminal.deniedActions = Math.max(
      evidence.terminal.deniedActions ?? 0,
      snapshot.result.denied_actions?.length ?? 0,
    );
  }
  if (params.completeProtocol) evidence.terminal.protocolComplete = true;
  return snapshotAttemptEvidence(evidence);
}

function replayMetadataFromEvidence(evidence: AttemptEvidence) {
  return {
    hadPotentialSideEffects: evidence.effects !== "none_proven",
    replaySafe: isReplaySafe(evidence),
  };
}

function terminalFromSnapshot(snapshot: AgyStreamSnapshot, evidence: AttemptEvidence) {
  if (evidence.terminal.nativeTimeout || evidence.termination.hostReason === "timeout") {
    return agentHarnessAttemptTerminal.normalize({
      aborted: true,
      timedOut: true,
      timedOutByRunBudget: evidence.termination.hostReason === "timeout",
      promptError: new Error("AGY attempt timed out or was truncated; available output is partial"),
      promptErrorSource: "prompt",
    });
  }
  if (evidence.terminal.nativeCriticalWarning) {
    return agentHarnessAttemptTerminal.normalize({
      promptError: new Error("AGY emitted an unrecognized critical warning; completion is not established"),
      promptErrorSource: "prompt",
    });
  }
  if (snapshot.result.status === "SUCCESS" && (snapshot.result.denied_actions?.length ?? 0) > 0) {
    const disposition = visibleText(snapshot).trim() ? "partial" : "blocked";
    const denied = snapshot.result.denied_actions!.map((action) => action.display_name).join(", ");
    return agentHarnessAttemptTerminal.normalize({
      promptError: new Error(`AGY result is ${disposition}; denied actions: ${denied}`),
      promptErrorSource: "prompt",
    });
  }
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

function toolMetasFromSnapshot(snapshot: AgyStreamPartialSnapshot) {
  return snapshot.toolSteps
    .filter((step) => step.state !== "ACTIVE")
    .map((step) => ({
      toolName: step.tool_name ?? step.tool_info?.name ?? "native_tool",
      ...(step.state === "ERROR" || step.tool_info?.error ? { isError: true } : {}),
      replaySafe: false,
    }));
}

function outcomeProjection(params: {
  terminal: AgentHarnessAttemptTerminal;
  evidence: AttemptEvidence;
  snapshot?: AgyStreamPartialSnapshot;
  error?: Error;
}): { outcome: AntigravityOutcome; assistantTexts: string[] } {
  const { terminal, evidence, snapshot } = params;
  const text = snapshot ? visibleText(snapshot) : "";
  const availableOutput = text.trim().length > 0;
  const deniedActions = Object.freeze((snapshot?.result?.denied_actions ?? [])
    .map((action) => Object.freeze({ ...action })));
  const denied = Math.max(deniedActions.length, evidence.terminal.deniedActions ?? 0);
  const timeout = terminal.kind === "timeout" || evidence.terminal.nativeTimeout === true ||
    evidence.termination.hostReason === "timeout";
  const canceled = terminal.kind === "aborted" || evidence.termination.hostReason === "aborted" ||
    evidence.terminal.nativeStatus === "CANCELED" || evidence.terminal.nativeStatus === "INTERRUPTED";
  const kind: AntigravityOutcome["kind"] = timeout ? "timeout"
    : canceled ? "canceled"
      : denied > 0 ? (availableOutput ? "partial" : "blocked")
        : terminal.kind === "ok" ? "completed"
          : availableOutput ? "partial"
            : evidence.invocation === "not_started" ? "blocked" : "failed";
  const reasons: string[] = [];
  if (timeout) {
    if (evidence.terminal.nativeTimeout) reasons.push("AGY reported native timeout or truncation.");
    if (evidence.termination.hostReason === "timeout") reasons.push("The host attempt deadline expired.");
    if (!reasons.length) reasons.push("The attempt timed out.");
  } else if (canceled) reasons.push("The attempt was canceled or interrupted.");
  if (denied > 0) {
    const names = deniedActions.map((action) => action.display_name).join(", ");
    reasons.push(names ? `Native actions were denied: ${names}.` : `${denied} native action(s) were denied.`);
  }
  if (kind !== "completed") {
    reasons.push(availableOutput
      ? "Available output is partial; full completion is not established."
      : "No completed response is available.");
    if (!timeout && !canceled && denied === 0) {
      // Timeout/abort variants were excluded above; only canonical failure
      // carries an error on this branch of the public SDK terminal union.
      const terminalError = terminal.kind === "failed" ? terminal.error : undefined;
      const error = params.error ?? (terminalError instanceof Error ? terminalError : undefined);
      if (error?.message.trim()) reasons.push(error.message);
    }
  }
  const explanation = kind === "completed" ? undefined
    : `ANTIGRAVITY: ${kind[0]!.toUpperCase()}${kind.slice(1)} result. ${reasons.join(" ")}`;
  const outcome: AntigravityOutcome = Object.freeze({
    kind, availableOutput, deniedActions, nativeTimeout: evidence.terminal.nativeTimeout === true,
    ...(evidence.terminal.nativeStatus !== undefined ? { nativeStatus: evidence.terminal.nativeStatus } : {}),
    ...(evidence.termination.hostReason !== undefined ? { hostReason: evidence.termination.hostReason } : {}),
    ...(explanation !== undefined ? { explanation } : {}),
  });
  // The native answer stays byte-for-byte first. A separate labeled explanation
  // reaches the supported final-text path even when the host suppresses a
  // terminal error because some assistant text already exists. Synthetic text
  // never changes native output evidence, pricing, occupancy or replay safety.
  return {
    outcome,
    assistantTexts: [...(availableOutput ? [text] : []), ...(explanation ? [explanation] : [])],
  };
}

function itemLifecycleFromSnapshot(snapshot: AgyStreamPartialSnapshot) {
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
  evidence?: AttemptEvidence;
  lastToolError?: AgentHarnessAttemptResult["lastToolError"];
}): AntigravityAttemptResult {
  const { attempt, snapshot } = params;
  const evidence = evidenceForResult({
    modelId: attempt.modelId,
    snapshot,
    completeProtocol: true,
    ...(params.evidence ? { evidence: params.evidence } : {}),
    ...(params.nativeAssistantOutputObserved !== undefined
      ? { outputObserved: params.nativeAssistantOutputObserved } : {}),
  });
  const terminal = terminalFromSnapshot(snapshot, evidence);
  const projection = outcomeProjection({ terminal, evidence, snapshot });
  const runtimeModelId = params.runtimeModelId?.trim() || attempt.modelId;
  const completedText =
    terminal.kind === "ok" && projection.outcome.kind === "completed"
      ? projection.assistantTexts[0]
      : undefined;
  const assistant = completedText?.trim()
    ? completedAssistantMessage({ attempt, text: completedText, runtimeModelId })
    : undefined;
  // Keep model-message structure separate from accounting truth. OpenClaw
  // ignores all-zero message usage when selecting current-attempt usage; the
  // authoritative ANTIGRAVITY accounting projection remains unavailable until
  // AGY supplies a qualified per-turn scope.
  const attemptUsage = unknownAttemptUsage();
  const replayMetadata = replayMetadataFromEvidence(evidence);

  return {
    terminal,
    antigravityEvidence: evidence,
    antigravityOutcome: projection.outcome,
    sessionIdUsed: attempt.sessionId,
    agentHarnessId: "antigravity",
    ...(params.runtimeModelId
      ? { runtimeModelSelection: { provider: "antigravity", model: params.runtimeModelId } }
      : {}),
    messagesSnapshot: assistant ? [assistant] : [],
    assistantTexts: projection.assistantTexts,
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
  evidence?: AttemptEvidence;
  partialSnapshot?: AgyStreamPartialSnapshot;
  lastToolError?: AgentHarnessAttemptResult["lastToolError"];
}): AntigravityAttemptResult {
  const error = params.error instanceof Error ? params.error : new Error(String(params.error));
  const snapshot = params.partialSnapshot;
  const evidence = evidenceForResult({
    modelId: params.attempt.modelId,
    ...(params.evidence ? { evidence: params.evidence } : {}),
    ...(snapshot ? { snapshot } : {}),
    ...(params.partialReplyObserved !== undefined
      ? { outputObserved: params.partialReplyObserved } : {}),
    ...(params.nativeToolActivityObserved !== undefined
      ? { toolActivityObserved: params.nativeToolActivityObserved } : {}),
  });
  const replayMetadata = replayMetadataFromEvidence(evidence);
  // A supplied terminal can preserve timeout/abort attribution, but this API
  // represents a failure and must never accept a contradictory success marker.
  const terminal = params.terminal?.kind !== "ok" && params.terminal !== undefined
    ? params.terminal : agentHarnessAttemptTerminal.normalize({
    promptError: error, promptErrorSource: "prompt",
    ...(evidence.terminal.nativeTimeout || evidence.termination.hostReason === "timeout"
      ? { aborted: true, timedOut: true, timedOutByRunBudget: evidence.termination.hostReason === "timeout" }
      : {}),
  });
  const projection = outcomeProjection({ terminal, evidence, ...(snapshot ? { snapshot } : {}), error });
  return {
    antigravityEvidence: evidence,
    antigravityOutcome: projection.outcome,
    terminal,
    sessionIdUsed: params.attempt.sessionId,
    agentHarnessId: "antigravity",
    messagesSnapshot: [],
    assistantTexts: projection.assistantTexts,
    toolMetas: snapshot ? toolMetasFromSnapshot(snapshot) : [],
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
    attemptUsage: unknownAttemptUsage(),
    replayMetadata,
    currentAttemptReplayMetadata: replayMetadata,
    itemLifecycle: snapshot
      ? itemLifecycleFromSnapshot(snapshot)
      : { startedCount: 0, completedCount: 0, activeCount: 0 },
    yieldDetected: false,
  };
}
