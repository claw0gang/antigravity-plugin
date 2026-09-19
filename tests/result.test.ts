import assert from "node:assert/strict";
import test from "node:test";

import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";

import {
  buildAntigravityAttemptResult,
  buildAntigravityFailureResult,
} from "../src/harness/result.ts";
import { createAttemptEvidence } from "../src/cli/attempt-evidence.ts";
import type { AgyStreamSnapshot } from "../src/protocol/agy-stream.ts";

function attempt(): AgentHarnessAttemptParamsV2 {
  return {
    sessionId: "openclaw-session-1",
    sessionKey: "agent:main:child:1",
    modelId: "gemini-3.8-flash-high",
    model: { contextWindow: 131_072 },
    contextTokenBudget: 131_072,
  } as unknown as AgentHarnessAttemptParamsV2;
}

function snapshot(overrides?: Partial<AgyStreamSnapshot>): AgyStreamSnapshot {
  return {
    conversationId: "agy-conversation-1",
    init: {
      cwd: "/workspace",
      tools: ["run_command", "view_file"],
      permission_mode: "request-review",
      model: "gemini-3.8-flash-high",
    },
    assistantText: "done",
    stepUpdates: [],
    toolSteps: [],
    result: {
      conversation_id: "agy-conversation-1",
      status: "SUCCESS",
      response: "done",
      duration_seconds: 1,
      num_turns: 1,
      usage: {
        input_tokens: 10_522,
        output_tokens: 354,
        thinking_tokens: 120,
        cache_read_tokens: 8_112,
        total_tokens: 10_876,
      },
    },
    ...overrides,
  };
}

test("successful AGY result restores the completed assistant without inventing native accounting", () => {
  const result = buildAntigravityAttemptResult({ attempt: attempt(), snapshot: snapshot() });

  assert.equal(result.terminal.kind, "ok");
  assert.equal(result.antigravityOutcome.kind, "completed");
  assert.equal(result.antigravityOutcome.explanation, undefined);
  assert.deepEqual(result.assistantTexts, ["done"]);
  assert.equal(result.messagesSnapshot.length, 1);
  assert.equal(result.lastAssistant?.provider, "antigravity");
  assert.equal(result.lastAssistant?.model, "gemini-3.8-flash-high");
  assert.equal(result.currentAttemptAssistant, result.lastAssistant);
  assert.equal(result.currentAttemptCompletedAssistant, result.lastAssistant);
  assert.deepEqual(result.lastAssistant?.usage, {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  assert.equal(result.contextTokens, 131_072);
  assert.equal(result.contextTokensSource, "resolved");
  assert.deepEqual(result.replayMetadata, {
    hadPotentialSideEffects: true,
    replaySafe: false,
  });
  assert.equal(result.antigravityEvidence.invocation, "started");
  assert.equal(result.antigravityEvidence.effects, "unknown");
});

test("AGY cumulative counters remain raw and never become turn usage, occupancy, or a free bill", () => {
  const native = snapshot();
  const result = buildAntigravityAttemptResult({ attempt: attempt(), snapshot: native });

  assert.deepEqual(result.attemptUsage, {
    contextUsage: { state: "unavailable" },
  });
  assert.equal(result.attemptUsage?.cost, undefined);
  assert.equal(result.lastAssistant?.usage.totalTokens, 0);
  assert.equal(result.currentAttemptCompletedAssistant, result.lastAssistant);
  assert.equal(result.antigravityEvidence.contextOccupancy, undefined);
  assert.equal(result.antigravityEvidence.accounting.scope, "unknown");
  assert.equal(result.antigravityEvidence.accounting.pricing, "unknown");
  assert.deepEqual(result.antigravityEvidence.accounting.raw, native.result.usage);
});

test("resumed native totals and overlapping step counters do not become a current-turn bill", () => {
  const native = snapshot();
  native.result.usage = {
    input_tokens: 100_000, output_tokens: 5_000, thinking_tokens: 400,
    cache_read_tokens: 80_000, total_tokens: 105_000,
  };
  native.stepUpdates = [{
    conversation_id: native.conversationId, step_index: 80, state: "DONE",
    step_type: "agent_response", text_delta: "done", usage: { ...native.result.usage },
  }];
  const evidence = createAttemptEvidence(attempt().modelId);
  evidence.accounting.raw = { ...native.result.usage };
  evidence.accounting.scope = "conversation";
  const result = buildAntigravityAttemptResult({ attempt: attempt(), snapshot: native, evidence });
  assert.deepEqual(result.assistantTexts, ["done"]);
  assert.equal(result.antigravityEvidence.accounting.scope, "conversation");
  assert.equal(result.antigravityEvidence.accounting.raw?.total_tokens, 105_000);
  assert.equal(result.antigravityEvidence.accounting.steps[0]?.raw.total_tokens, 105_000);
  assert.equal(result.attemptUsage?.total, undefined);
  assert.equal(result.attemptUsage?.input, undefined);
  assert.equal(result.attemptUsage?.output, undefined);
  assert.equal(result.attemptUsage?.cost, undefined);
  assert.deepEqual(result.attemptUsage?.contextUsage, { state: "unavailable" });
  assert.equal(result.lastAssistant?.usage.totalTokens, 0);
  assert.equal(result.currentAttemptCompletedAssistant, result.lastAssistant);
});

test("native accounting remains available after post-terminal failure without a billed turn", () => {
  const native = snapshot();
  const result = buildAntigravityFailureResult({
    attempt: attempt(), partialSnapshot: native, error: new Error("callback settlement failed"),
  });
  assert.deepEqual(result.assistantTexts, ["done", result.antigravityOutcome.explanation]);
  assert.match(result.assistantTexts[1]!, /ANTIGRAVITY: Partial result.*callback settlement failed/);
  assert.deepEqual(result.antigravityEvidence.accounting.raw, native.result.usage);
  assert.equal(result.antigravityEvidence.accounting.scope, "unknown");
  assert.equal(result.antigravityEvidence.accounting.pricing, "unknown");
  assert.deepEqual(result.attemptUsage, { contextUsage: { state: "unavailable" } });
  assert.equal(result.lastAssistant, undefined);
});

test("any native tool activity makes a successful attempt non-replayable", () => {
  const activeTool = {
    conversation_id: "agy-conversation-1",
    step_index: 2,
    state: "ACTIVE" as const,
    step_type: "tool",
    tool_name: "run_command",
    tool_info: {
      name: "run_command",
      parameters: { CommandLine: "touch marker" },
    },
  };
  const result = buildAntigravityAttemptResult({
    attempt: attempt(),
    snapshot: snapshot({
      stepUpdates: [activeTool],
      toolSteps: [activeTool],
    }),
  });

  assert.deepEqual(result.replayMetadata, {
    hadPotentialSideEffects: true,
    replaySafe: false,
  });
  assert.deepEqual(result.toolMetas, []);
  assert.deepEqual(result.itemLifecycle, {
    startedCount: 1,
    completedCount: 0,
    activeCount: 1,
  });
});

test("item lifecycle counts unique AGY step indices rather than raw updates", () => {
  const steps = [
    {
      conversation_id: "agy-conversation-1",
      step_index: 1,
      state: "ACTIVE" as const,
      step_type: "agent_response",
      text_delta: "a",
    },
    {
      conversation_id: "agy-conversation-1",
      step_index: 1,
      state: "DONE" as const,
      step_type: "agent_response",
      text_delta: "b",
    },
    {
      conversation_id: "agy-conversation-1",
      step_index: 2,
      state: "DONE" as const,
      step_type: "tool",
      tool_name: "view_file",
      tool_info: { name: "view_file", parameters: { path: "README.md" } },
    },
  ];
  const result = buildAntigravityAttemptResult({
    attempt: attempt(),
    snapshot: snapshot({ stepUpdates: steps, toolSteps: [steps[2]!] }),
  });

  assert.deepEqual(result.itemLifecycle, {
    startedCount: 2,
    completedCount: 2,
    activeCount: 0,
  });
  assert.equal(result.toolMetas.length, 1);
  assert.equal(result.toolMetas[0]?.toolName, "view_file");
});

test("partial output before failure retains unknown effects and prevents replay", () => {
  const result = buildAntigravityFailureResult({
    attempt: attempt(),
    error: new Error("stream failed"),
    partialReplyObserved: true,
  });

  assert.deepEqual(result.replayMetadata, {
    hadPotentialSideEffects: true,
    replaySafe: false,
  });
  assert.equal(result.antigravityEvidence.effects, "unknown");
  assert.deepEqual(result.toolMetas, []);
});

test("native tool activity before failure is treated as potential side effect", () => {
  const result = buildAntigravityFailureResult({
    attempt: attempt(),
    error: new Error("transport failed"),
    nativeToolActivityObserved: true,
  });

  assert.deepEqual(result.replayMetadata, {
    hadPotentialSideEffects: true,
    replaySafe: false,
  });
  assert.deepEqual(result.toolMetas, []);
});

test("clean pre-dispatch failure remains replay-safe", () => {
  const result = buildAntigravityFailureResult({
    attempt: attempt(),
    error: new Error("spawn failed"),
    evidence: createAttemptEvidence(attempt().modelId),
  });

  assert.deepEqual(result.replayMetadata, {
    hadPotentialSideEffects: false,
    replaySafe: true,
  });
});

test("failed native tool terminal is observable and lifecycle-complete", () => {
  const failedTool = {
    conversation_id: "agy-conversation-1",
    step_index: 2,
    state: "ERROR" as const,
    step_type: "tool",
    tool_name: "run_command",
    tool_info: {
      name: "run_command",
      parameters: { CommandLine: "printf denied" },
      error: { type: "TOOL_ERROR", message: "permission denied" },
    },
  };
  const result = buildAntigravityAttemptResult({
    attempt: attempt(),
    snapshot: snapshot({ stepUpdates: [failedTool], toolSteps: [failedTool] }),
  });

  assert.deepEqual(result.itemLifecycle, {
    startedCount: 1,
    completedCount: 1,
    activeCount: 0,
  });
  assert.equal(result.toolMetas.length, 1);
  assert.equal(result.toolMetas[0]?.toolName, "run_command");
  assert.equal(result.toolMetas[0]?.isError, true);
});


test("a generic failure without positive no-start evidence is unsafe", () => {
  const result = buildAntigravityFailureResult({ attempt: attempt(), error: new Error("failed") });
  assert.deepEqual(result.replayMetadata, { hadPotentialSideEffects: true, replaySafe: false });
  assert.equal(result.antigravityEvidence.invocation, "possible");
  assert.equal(result.antigravityEvidence.effects, "unknown");
});

test("stream observations override stale positive no-start evidence without mutating it", () => {
  const evidence = createAttemptEvidence(attempt().modelId);
  const result = buildAntigravityAttemptResult({ attempt: attempt(), snapshot: snapshot(), evidence });
  assert.equal(result.replayMetadata?.replaySafe, false);
  assert.equal(result.antigravityEvidence.invocation, "started");
  assert.equal(result.antigravityEvidence.effects, "unknown");
  assert.equal(result.antigravityEvidence.termination.containment, "unqualified");
  assert.equal(result.antigravityEvidence.termination.cleanupComplete, false);
  assert.equal(evidence.invocation, "not_started");
  assert.equal(evidence.terminal.protocolComplete, false);
  assert.equal(result.antigravityEvidence.terminal.protocolComplete, true);
  evidence.terminal.nativeStatus = "ERROR";
  assert.equal(result.antigravityEvidence.terminal.nativeStatus, "SUCCESS");
  assert.ok(Object.isFrozen(result.antigravityEvidence));
  assert.ok(Object.isFrozen(result.antigravityEvidence.termination));
});

test("partial stream failure preserves text, tool outcome, lifecycle, and canonical tool error", () => {
  const tool = {
    conversation_id: "agy-conversation-1", step_index: 1, state: "ERROR" as const,
    step_type: "tool", tool_name: "run_command",
    tool_info: { name: "run_command", error: { message: "permission denied" } },
  };
  const lastToolError = {
    toolName: "run_command", error: "permission denied", executionStarted: true,
    mutatingAction: true,
  };
  const result = buildAntigravityFailureResult({
    attempt: attempt(), error: new Error("malformed later output"), lastToolError,
    partialSnapshot: {
      conversationId: "agy-conversation-1", assistantText: "available partial answer",
      stepUpdates: [tool], toolSteps: [tool],
    },
  });
  assert.deepEqual(result.assistantTexts, ["available partial answer", result.antigravityOutcome.explanation]);
  assert.match(result.assistantTexts[1]!, /ANTIGRAVITY: Partial result.*malformed later output/);
  assert.equal(result.currentAttemptCompletedAssistant, undefined);
  assert.equal(result.currentAttemptAssistant, undefined);
  assert.deepEqual(result.toolMetas, [{ toolName: "run_command", isError: true, replaySafe: false }]);
  assert.deepEqual(result.itemLifecycle, { startedCount: 1, completedCount: 1, activeCount: 0 });
  assert.deepEqual(result.lastToolError, lastToolError);
  assert.equal(result.antigravityEvidence.effects, "observed_possible");
  assert.equal(result.antigravityEvidence.terminal.protocolComplete, false);
  assert.equal(result.antigravityEvidence.outputObserved, true);
});

test("an empty accumulator does not negate explicit positive no-start evidence", () => {
  const result = buildAntigravityFailureResult({
    attempt: attempt(), error: new Error("pre-aborted"),
    evidence: createAttemptEvidence(attempt().modelId),
    partialSnapshot: { assistantText: "", stepUpdates: [], toolSteps: [] },
  });
  assert.equal(result.replayMetadata?.replaySafe, true);
  assert.equal(result.antigravityEvidence.invocation, "not_started");
});

test("delivered output cannot become safe through a subsequent failure", () => {
  const evidence = createAttemptEvidence(attempt().modelId);
  evidence.deliveredOutput = true;
  const result = buildAntigravityFailureResult({ attempt: attempt(), error: "failed", evidence });
  assert.equal(result.replayMetadata?.replaySafe, false);
  assert.equal(result.antigravityEvidence.deliveredOutput, true);
});
