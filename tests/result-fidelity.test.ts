import assert from "node:assert/strict";
import test from "node:test";

import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";

import { createAttemptEvidence } from "../src/cli/attempt-evidence.ts";
import { buildAntigravityAttemptResult, buildAntigravityFailureResult } from "../src/harness/result.ts";
import type { AgyStreamSnapshot } from "../src/protocol/agy-stream.ts";

function attempt(): AgentHarnessAttemptParamsV2 {
  return {
    sessionId: "openclaw-session-1",
    modelId: "gemini-3.8-flash-high",
    model: { contextWindow: 200_000 },
  } as unknown as AgentHarnessAttemptParamsV2;
}

function denialSnapshot(): AgyStreamSnapshot {
  return {
    conversationId: "agy-conversation-1",
    init: {
      cwd: "/workspace",
      tools: ["run_command"],
      permission_mode: "request-review",
      model: "gemini-3.8-flash-low",
    },
    assistantText: "",
    stepUpdates: [],
    toolSteps: [],
    result: {
      conversation_id: "agy-conversation-1",
      status: "SUCCESS",
      response: "",
      duration_seconds: 1,
      num_turns: 1,
      denied_actions: [{ action: "command", display_name: "RunCommand" }],
      usage: {
        input_tokens: 10,
        output_tokens: 0,
        thinking_tokens: 1,
        cache_read_tokens: 0,
        total_tokens: 11,
      },
    },
  };
}

test("native SUCCESS denial has a host-visible blocked explanation without inventing native output", () => {
  const result = buildAntigravityAttemptResult({
    attempt: attempt(),
    snapshot: denialSnapshot(),
    runtimeModelId: "gemini-3.8-flash-low",
  });

  assert.notEqual(result.terminal.kind, "ok");
  assert.equal(result.antigravityEvidence.terminal.nativeStatus, "SUCCESS");
  assert.equal(result.antigravityEvidence.terminal.deniedActions, 1);
  assert.deepEqual(result.assistantTexts, [
    "ANTIGRAVITY: Blocked result. Native actions were denied: RunCommand. No completed response is available.",
  ]);
  assert.equal(result.antigravityEvidence.outputObserved, false);
  assert.equal(result.antigravityEvidence.deliveredOutput, false);
  assert.equal(result.antigravityOutcome.kind, "blocked");
  assert.equal(result.antigravityOutcome.availableOutput, false);
  assert.equal(result.antigravityOutcome.nativeStatus, "SUCCESS");
  assert.equal(result.currentAttemptAssistant, undefined);
  assert.deepEqual(result.runtimeModelSelection, {
    provider: "antigravity",
    model: "gemini-3.8-flash-low",
  });
});


test("native denial preserves useful response as partial rather than completed success", () => {
  const snapshot = denialSnapshot();
  snapshot.result.response = "Completed the read; the write was denied.";
  const result = buildAntigravityAttemptResult({ attempt: attempt(), snapshot });
  assert.notEqual(result.terminal.kind, "ok");
  assert.deepEqual(result.assistantTexts, [snapshot.result.response, result.antigravityOutcome.explanation]);
  assert.match(result.assistantTexts[1]!, /ANTIGRAVITY: Partial result.*denied: RunCommand/);
  assert.equal(result.antigravityOutcome.kind, "partial");
  assert.equal(result.antigravityOutcome.availableOutput, true);
  assert.equal(result.currentAttemptAssistant, undefined);
  assert.equal(result.currentAttemptCompletedAssistant, undefined);
  assert.equal(result.antigravityEvidence.terminal.nativeStatus, "SUCCESS");
  assert.equal(result.antigravityEvidence.terminal.deniedActions, 1);
  assert.equal(result.replayMetadata?.replaySafe, false);
});

test("native timeout retains native SUCCESS separately from host timeout attribution", () => {
  const snapshot = denialSnapshot();
  snapshot.result.denied_actions = [];
  snapshot.result.response = "Partial work before timeout.";
  const evidence = createAttemptEvidence(attempt().modelId);
  evidence.invocation = "started";
  evidence.effects = "unknown";
  evidence.terminal.nativeTimeout = true;
  evidence.termination.exitCode = 0;
  const result = buildAntigravityAttemptResult({ attempt: attempt(), snapshot, evidence });
  assert.equal(result.terminal.kind, "timeout");
  assert.equal(result.terminal.source, "runtime");
  assert.equal(result.antigravityEvidence.terminal.nativeStatus, "SUCCESS");
  assert.equal(result.antigravityEvidence.terminal.nativeTimeout, true);
  assert.equal(result.antigravityEvidence.termination.hostReason, undefined);
  assert.equal(result.antigravityEvidence.termination.exitCode, 0);
  assert.deepEqual(result.assistantTexts, [snapshot.result.response, result.antigravityOutcome.explanation]);
  assert.match(result.assistantTexts[1]!, /ANTIGRAVITY: Timeout result.*native timeout or truncation.*partial/);
  assert.equal(result.antigravityOutcome.kind, "timeout");
  assert.equal(result.antigravityOutcome.nativeTimeout, true);
  assert.equal(result.antigravityOutcome.hostReason, undefined);
  assert.equal(result.currentAttemptCompletedAssistant, undefined);
});

test("host failure after native terminal preserves response and each timeout fact", () => {
  const snapshot = denialSnapshot();
  snapshot.result.response = "Available native response.";
  const evidence = createAttemptEvidence(attempt().modelId);
  evidence.invocation = "started";
  evidence.effects = "unknown";
  evidence.terminal.nativeTimeout = true;
  evidence.termination.hostReason = "timeout";
  const result = buildAntigravityFailureResult({
    attempt: attempt(), partialSnapshot: snapshot, evidence, error: new Error("settlement failed"),
  });
  assert.deepEqual(result.assistantTexts, [snapshot.result.response, result.antigravityOutcome.explanation]);
  assert.match(result.assistantTexts[1]!, /native timeout or truncation.*host attempt deadline.*denied: RunCommand/);
  assert.equal(result.antigravityOutcome.kind, "timeout");
  assert.equal(result.antigravityOutcome.nativeTimeout, true);
  assert.equal(result.antigravityOutcome.hostReason, "timeout");
  assert.equal(result.terminal.kind, "timeout");
  assert.equal(result.terminal.source, "run_budget");
  assert.equal(result.currentAttemptCompletedAssistant, undefined);
  assert.equal(result.antigravityEvidence.terminal.nativeStatus, "SUCCESS");
  assert.equal(result.antigravityEvidence.terminal.nativeTimeout, true);
  assert.equal(result.antigravityEvidence.termination.hostReason, "timeout");
  assert.equal(result.antigravityEvidence.terminal.deniedActions, 1);
  assert.equal(result.replayMetadata?.replaySafe, false);
});
