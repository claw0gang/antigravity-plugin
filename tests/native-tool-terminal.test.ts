import assert from "node:assert/strict";
import test from "node:test";

import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";

import { observeNativeToolTerminal } from "../src/harness/run-attempt.ts";
import {
  buildAntigravityAttemptResult,
  buildAntigravityFailureResult,
} from "../src/harness/result.ts";
import type { AgyStepUpdate, AgyStreamSnapshot } from "../src/protocol/agy-stream.ts";

function attemptWithObserver(params: {
  resolution: {
    lastToolError?: {
      toolName: string;
      error?: string;
      executionStarted?: boolean;
      mutatingAction?: boolean;
    };
  };
  observations: unknown[];
  trajectories: Array<{ type: string; data?: Record<string, unknown> }>;
}): AgentHarnessAttemptParamsV2 {
  return {
    sessionId: "session-1",
    modelId: "gemini-3.8-flash-low",
    model: { contextWindow: 200_000 },
    hostCapabilities: {
      trajectory: {
        recordEvent(type: string, data?: Record<string, unknown>) {
          params.trajectories.push({ type, ...(data ? { data } : {}) });
        },
        async flush() {},
      },
    },
    observeToolTerminal(observation: unknown) {
      params.observations.push(observation);
      return {
        ...params.resolution,
        executionStarted: true,
        executedArguments: { command: "printf ok" },
        sideEffectEvidence: true,
        effectReceipt: {} as never,
      };
    },
  } as unknown as AgentHarnessAttemptParamsV2;
}

function usage() {
  return {
    input_tokens: 1,
    output_tokens: 1,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 2,
  };
}

function successSnapshot(tool: AgyStepUpdate): AgyStreamSnapshot {
  return {
    conversationId: "conversation-1",
    init: {
      cwd: "/tmp",
      tools: ["run_command"],
      permission_mode: "always-proceed",
      model: "gemini-3.8-flash-low",
    },
    assistantText: "OK",
    stepUpdates: [tool],
    toolSteps: [tool],
    result: {
      conversation_id: "conversation-1",
      status: "SUCCESS",
      response: "OK",
      duration_seconds: 1,
      num_turns: 1,
      usage: usage(),
    },
  };
}

test("terminal native tool success is reported to the host-owned observer and returns canonical resolution", () => {
  const observations: unknown[] = [];
  const trajectories: Array<{ type: string; data?: Record<string, unknown> }> = [];
  const attempt = attemptWithObserver({ resolution: {}, observations, trajectories });
  const step: AgyStepUpdate = {
    conversation_id: "conversation-1",
    step_index: 2,
    state: "DONE",
    step_type: "tool",
    tool_name: "run_command",
    tool_info: {
      name: "run_command",
      parameters: { command: "printf ok" },
      output: "ok",
    },
  };

  const resolution = observeNativeToolTerminal(attempt, step);

  assert.equal(resolution?.executionStarted, true);
  assert.equal(resolution?.sideEffectEvidence, true);
  assert.equal(resolution?.lastToolError, undefined);
  assert.deepEqual(observations, [
    {
      toolName: "run_command",
      arguments: { command: "printf ok" },
      executionStarted: true,
      outcome: "success",
      nativeMutation: { mutatingAction: true, replaySafe: false },
    },
  ]);
  assert.equal(trajectories[0]?.type, "antigravity.native_tool_terminal");
  assert.equal(trajectories[0]?.data?.outcome, "success");
  assert.equal(trajectories[0]?.data?.sideEffectEvidence, true);
});

test("terminal native tool failure preserves the host-owned lastToolError", () => {
  const observations: unknown[] = [];
  const trajectories: Array<{ type: string; data?: Record<string, unknown> }> = [];
  const lastToolError = {
    toolName: "run_command",
    error: "permission denied",
    executionStarted: true,
    mutatingAction: true,
  };
  const attempt = attemptWithObserver({
    resolution: { lastToolError },
    observations,
    trajectories,
  });
  const step: AgyStepUpdate = {
    conversation_id: "conversation-1",
    step_index: 2,
    state: "ERROR",
    step_type: "tool",
    tool_name: "run_command",
    tool_info: {
      name: "run_command",
      parameters: { command: "printf ok" },
      error: { type: "tool_error", message: "permission denied" },
    },
  };

  const resolution = observeNativeToolTerminal(attempt, step);

  assert.deepEqual(resolution?.lastToolError, lastToolError);
  assert.deepEqual(observations, [
    {
      toolName: "run_command",
      arguments: { command: "printf ok" },
      executionStarted: true,
      outcome: "failure",
      failure: { error: "permission denied" },
      nativeMutation: { mutatingAction: true, replaySafe: false },
    },
  ]);
  assert.equal(trajectories[0]?.data?.outcome, "failure");
});

test("attempt results carry canonical host-owned lastToolError without changing replay classification", () => {
  const observations: unknown[] = [];
  const trajectories: Array<{ type: string; data?: Record<string, unknown> }> = [];
  const lastToolError = {
    toolName: "run_command",
    error: "permission denied",
    executionStarted: true,
    mutatingAction: true,
  };
  const attempt = attemptWithObserver({ resolution: {}, observations, trajectories });
  const tool: AgyStepUpdate = {
    conversation_id: "conversation-1",
    step_index: 2,
    state: "DONE",
    step_type: "tool",
    tool_name: "run_command",
    tool_info: { name: "run_command", parameters: { command: "printf ok" }, output: "ok" },
  };

  const success = buildAntigravityAttemptResult({
    attempt,
    snapshot: successSnapshot(tool),
    runtimeModelId: "gemini-3.8-flash-low",
    lastToolError,
  });
  assert.deepEqual(success.lastToolError, lastToolError);
  assert.deepEqual(success.replayMetadata, { hadPotentialSideEffects: true, replaySafe: false });

  const failure = buildAntigravityFailureResult({
    attempt,
    error: new Error("later failure"),
    nativeToolActivityObserved: true,
    lastToolError,
  });
  assert.deepEqual(failure.lastToolError, lastToolError);
  assert.deepEqual(failure.replayMetadata, { hadPotentialSideEffects: true, replaySafe: false });
});
