import assert from "node:assert/strict";
import test from "node:test";

import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createAttemptEvidence } from "../src/cli/attempt-evidence.ts";
import { buildAntigravityAttemptResult, buildAntigravityFailureResult } from "../src/harness/result.ts";
import type { AgyStreamSnapshot } from "../src/protocol/agy-stream.ts";

const attempt = {
  sessionId: "host-session", modelId: "opaque/exact-model", model: { contextWindow: 200_000 },
} as unknown as AgentHarnessAttemptParamsV2;

function native(response = "native answer"): AgyStreamSnapshot {
  return {
    conversationId: "native-conversation",
    init: { cwd: "/workspace", tools: [], permission_mode: "request-review", model: attempt.modelId },
    assistantText: "earlier cumulative preview", stepUpdates: [], toolSteps: [],
    result: {
      conversation_id: "native-conversation", status: "SUCCESS", response,
      duration_seconds: 1, num_turns: 1,
      usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 10, cache_read_tokens: 40, total_tokens: 120 },
    },
  };
}

test("terminal reconciliation delivers exactly one native answer and an attributed denial notice", () => {
  const snapshot = native();
  snapshot.result.denied_actions = [{ action: "write", display_name: "WriteFile" }];
  const result = buildAntigravityAttemptResult({ attempt, snapshot });
  assert.deepEqual(result.assistantTexts, [
    "native answer",
    "ANTIGRAVITY: Partial result. Native actions were denied: WriteFile. Available output is partial; full completion is not established.",
  ]);
  assert.equal(result.assistantTexts.join("\n").includes("earlier cumulative preview"), false);
  assert.equal(result.assistantTexts.join("\n").split("native answer").length - 1, 1);
  assert.equal(result.antigravityOutcome.availableOutput, true);
  assert.deepEqual(result.messagesSnapshot, []);
});

test("an empty or whitespace denial carries a visible explanation without changing native evidence", () => {
  for (const response of ["", " \n\t "]) {
    const snapshot = native(response);
    snapshot.assistantText = response;
    snapshot.result.denied_actions = [{ action: "command", display_name: "RunCommand" }];
    const result = buildAntigravityAttemptResult({ attempt, snapshot });
    assert.equal(result.antigravityOutcome.kind, "blocked");
    assert.equal(result.antigravityOutcome.availableOutput, false);
    assert.equal(result.assistantTexts.length, 1);
    assert.match(result.assistantTexts[0]!, /^ANTIGRAVITY: Blocked result\./);
    assert.equal(result.antigravityEvidence.deliveredOutput, false);
    assert.deepEqual(result.attemptUsage, { contextUsage: { state: "unavailable" } });
    assert.equal(result.currentAttemptCompletedAssistant, undefined);
  }
});

test("partial structured output remains intact and separate from its adapter explanation", () => {
  const snapshot = native("");
  snapshot.result.structured_output = { answer: 42, observations: ["available"] };
  snapshot.result.denied_actions = [{ action: "command", display_name: "RunCommand" }];
  const result = buildAntigravityAttemptResult({ attempt, snapshot });
  assert.equal(result.assistantTexts[0], '{"answer":42,"observations":["available"]}');
  assert.equal(result.antigravityOutcome.kind, "partial");
  assert.match(result.assistantTexts[1]!, /RunCommand/);
});

test("post-start failure, cancellation and host timeout preserve text and never claim completion", () => {
  for (const stop of ["failure", "aborted", "timeout"] as const) {
    const evidence = createAttemptEvidence(attempt.modelId);
    evidence.invocation = "started";
    evidence.effects = "unknown";
    if (stop !== "failure") evidence.termination.hostReason = stop;
    const result = buildAntigravityFailureResult({ attempt, evidence, partialSnapshot: native(), error: new Error("native settlement failed") });
    assert.equal(result.antigravityOutcome.kind, stop === "failure" ? "partial" : stop === "aborted" ? "canceled" : "timeout");
    assert.equal(result.assistantTexts[0], "native answer");
    assert.match(result.assistantTexts[1]!, /full completion is not established/);
    assert.equal(result.antigravityOutcome.nativeStatus, "SUCCESS");
    assert.equal(result.antigravityOutcome.nativeTimeout, false);
    assert.equal(result.replayMetadata?.replaySafe, false);
    assert.notEqual(result.terminal.kind, "ok");
  }
});

test("source prelaunch rejection remains blocked and replay-safe despite a visible adapter explanation", () => {
  const evidence = createAttemptEvidence(attempt.modelId);
  const result = buildAntigravityFailureResult({
    attempt, evidence, error: new Error("Required host policy has no qualified native carrier; remove the unsupported requirement or qualify a carrier"),
  });
  assert.equal(result.antigravityOutcome.kind, "blocked");
  assert.match(result.assistantTexts[0]!, /Required host policy.*qualified native carrier/);
  assert.equal(result.antigravityEvidence.outputObserved, false);
  assert.equal(result.antigravityEvidence.deliveredOutput, false);
  assert.equal(result.replayMetadata?.replaySafe, true);
});

test("failed native tool state is preserved without an optional native error payload", () => {
  const snapshot = native();
  const tool = { conversation_id: snapshot.conversationId, step_index: 1, state: "ERROR" as const, step_type: "tool", tool_name: "WriteFile" };
  snapshot.stepUpdates = [tool];
  snapshot.toolSteps = [tool];
  const result = buildAntigravityAttemptResult({ attempt, snapshot });
  assert.deepEqual(result.toolMetas, [{ toolName: "WriteFile", isError: true, replaySafe: false }]);
  assert.equal(result.antigravityEvidence.effects, "observed_possible");
});

test("projection freezes denial metadata and never changes qualified occupancy into billing or capacity", () => {
  const snapshot = native();
  snapshot.result.denied_actions = [{ action: "write", display_name: "WriteFile" }];
  const evidence = createAttemptEvidence(attempt.modelId);
  evidence.contextOccupancy = { tokens: 1234, source: "fixture-only-qualified-occupancy" };
  const result = buildAntigravityAttemptResult({ attempt, snapshot, evidence });
  snapshot.result.denied_actions[0]!.display_name = "ChangedLater";
  evidence.contextOccupancy.tokens = 9999;
  assert.equal(result.antigravityOutcome.deniedActions[0]?.display_name, "WriteFile");
  assert.ok(Object.isFrozen(result.antigravityOutcome));
  assert.ok(Object.isFrozen(result.antigravityOutcome.deniedActions));
  assert.ok(Object.isFrozen(result.antigravityOutcome.deniedActions[0]));
  assert.deepEqual(result.antigravityEvidence.contextOccupancy, { tokens: 1234, source: "fixture-only-qualified-occupancy" });
  assert.equal(result.contextTokens, 200_000);
  assert.deepEqual(result.attemptUsage, { contextUsage: { state: "unavailable" } });
  assert.equal(result.attemptUsage?.cost, undefined);
});

test("critical native diagnostic prevents completed classification even with native SUCCESS", () => {
  const evidence = createAttemptEvidence(attempt.modelId);
  evidence.terminal.nativeCriticalWarning = true;
  const result = buildAntigravityAttemptResult({ attempt, snapshot: native(), evidence });
  assert.notEqual(result.terminal.kind, "ok");
  assert.equal(result.antigravityOutcome.kind, "partial");
  assert.equal(result.antigravityOutcome.nativeStatus, "SUCCESS");
  assert.match(result.assistantTexts[1]!, /unrecognized critical warning/);
});

test("failure builder cannot accept a caller-supplied success marker", () => {
  const result = buildAntigravityFailureResult({
    attempt, partialSnapshot: native(), error: new Error("cleanup incomplete"), terminal: { kind: "ok" },
  });
  assert.notEqual(result.terminal.kind, "ok");
  assert.equal(result.antigravityOutcome.kind, "partial");
  assert.equal(result.assistantTexts[0], "native answer");
  assert.match(result.assistantTexts[1]!, /cleanup incomplete/);
});
