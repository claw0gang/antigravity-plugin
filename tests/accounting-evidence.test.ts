import assert from "node:assert/strict";
import test from "node:test";

import {
  createAttemptEvidence, recordAgyUsage, recordSnapshotAccounting, snapshotAttemptEvidence,
} from "../src/cli/attempt-evidence.ts";
import { AgyProcessError, runAgyStreamProcess } from "../src/cli/agy-process.ts";
import type { AgyStepUpdate, AgyTerminalResult, AgyUsage } from "../src/protocol/agy-stream.ts";

const usage: AgyUsage = {
  input_tokens: 100_000, output_tokens: 5_000, thinking_tokens: 400,
  cache_read_tokens: 80_000, total_tokens: 105_000,
};

function step(): AgyStepUpdate {
  return {
    conversation_id: "resumed-conversation", step_index: 45, state: "DONE",
    step_type: "agent_response", text_delta: "latest response", usage: { ...usage },
  };
}

function result(): AgyTerminalResult {
  return {
    conversation_id: "resumed-conversation", status: "SUCCESS", response: "latest response",
    duration_seconds: 1, num_turns: 1, usage: { ...usage },
  };
}

test("native counters retain unknown scope and pricing without guessing occupancy or summing steps", () => {
  const evidence = createAttemptEvidence("opaque-model");
  recordAgyUsage(evidence, { event: "step_update", step_update: step() });
  recordAgyUsage(evidence, { event: "result", result: result() });
  assert.deepEqual(evidence.accounting.raw, usage);
  assert.equal(evidence.accounting.raw?.total_tokens, 105_000);
  assert.equal(evidence.accounting.scope, "unknown");
  assert.equal(evidence.accounting.steps[0]?.scope, "unknown");
  assert.equal(evidence.accounting.pricing, "unknown");
  assert.equal(evidence.contextOccupancy, undefined);
});

test("snapshot recovery retains a terminal observed before protocol failure and does not duplicate steps", () => {
  const evidence = createAttemptEvidence();
  recordAgyUsage(evidence, { event: "step_update", step_update: step() });
  const partial = {
    assistantText: "latest response", stepUpdates: [step()], toolSteps: [], result: result(),
  };
  recordSnapshotAccounting(evidence, partial);
  recordSnapshotAccounting(evidence, partial);
  assert.equal(evidence.accounting.steps.length, 1);
  assert.deepEqual(evidence.accounting.raw, usage);
  assert.equal(evidence.accounting.scope, "unknown");
});

test("partial step accounting survives absent terminal without becoming current turn usage", () => {
  const evidence = createAttemptEvidence();
  recordSnapshotAccounting(evidence, {
    assistantText: "partial", stepUpdates: [step()], toolSteps: [],
  });
  assert.equal(evidence.accounting.raw, undefined);
  assert.equal(evidence.accounting.scope, "unknown");
  assert.deepEqual(evidence.accounting.steps[0]?.raw, usage);
});

test("native objects and later evidence updates cannot change a settled accounting snapshot", () => {
  const evidence = createAttemptEvidence();
  const nativeStep = step();
  const nativeResult = result();
  recordAgyUsage(evidence, { event: "step_update", step_update: nativeStep });
  recordAgyUsage(evidence, { event: "result", result: nativeResult });
  evidence.contextOccupancy = { tokens: 800, source: "qualified-fixture-occupancy" };
  const frozen = snapshotAttemptEvidence(evidence);
  nativeStep.usage!.total_tokens = 999;
  nativeResult.usage.total_tokens = 999;
  evidence.accounting.raw!.input_tokens = 3;
  evidence.accounting.steps[0]!.raw.output_tokens = 4;
  evidence.contextOccupancy.tokens = 5;
  assert.deepEqual(frozen.accounting.raw, usage);
  assert.deepEqual(frozen.accounting.steps[0]?.raw, usage);
  assert.equal(frozen.contextOccupancy?.tokens, 800);
  assert.ok(Object.isFrozen(frozen.accounting));
  assert.ok(Object.isFrozen(frozen.accounting.raw));
  assert.ok(Object.isFrozen(frozen.accounting.steps));
  assert.ok(Object.isFrozen(frozen.accounting.steps[0]?.raw));
  assert.ok(Object.isFrozen(frozen.contextOccupancy));
});

test("real stream failure preserves native accounting observed before malformed output", async () => {
  const init = {
    event: "init", conversation_id: "resumed-conversation",
    init: { cwd: "/fixture", tools: [], permission_mode: "request-review", model: "opaque-model" },
  };
  const data = [init, { event: "step_update", step_update: step() }, { event: "result", result: result() }]
    .map((event) => JSON.stringify(event) + "\n").join("") + "{malformed\n";
  await assert.rejects(runAgyStreamProcess({
    command: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(data)});`],
    env: {}, timeoutMs: 3_000, expectedModelId: "opaque-model",
  }), (error: unknown) => {
    assert.ok(error instanceof AgyProcessError);
    assert.equal(error.kind, "protocol");
    assert.equal(error.evidence.invocation, "started");
    assert.equal(error.partialSnapshot?.assistantText, "latest response");
    assert.deepEqual(error.evidence.accounting.raw, usage);
    assert.equal(error.evidence.accounting.steps.length, 1);
    assert.equal(error.evidence.accounting.steps[0]?.raw.total_tokens, 105_000);
    assert.equal(error.evidence.accounting.scope, "unknown");
    assert.equal(error.evidence.accounting.pricing, "unknown");
    assert.equal(error.evidence.contextOccupancy, undefined);
    assert.equal(error.evidence.termination.cleanupComplete, true);
    return true;
  });
});

test("accounting from a rejected native terminal is recovered at the parser failure boundary", async () => {
  const init = {
    event: "init", conversation_id: "resumed-conversation",
    init: { cwd: "/fixture", tools: [], permission_mode: "request-review", model: "opaque-model" },
  };
  const terminal = { ...result(), status: "WAITING" };
  const data = [init, { event: "result", result: terminal }]
    .map((event) => JSON.stringify(event) + "\n").join("");
  await assert.rejects(runAgyStreamProcess({
    command: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(data)});`],
    env: {}, timeoutMs: 3_000, expectedModelId: "opaque-model",
  }), (error: unknown) => {
    assert.ok(error instanceof AgyProcessError);
    assert.equal(error.kind, "protocol");
    assert.equal(error.evidence.terminal.protocolComplete, false);
    assert.equal(error.evidence.terminal.nativeStatus, "WAITING");
    assert.deepEqual(error.evidence.accounting.raw, usage);
    return true;
  });
});
