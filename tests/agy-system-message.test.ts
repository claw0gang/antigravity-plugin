import assert from "node:assert/strict";
import test from "node:test";

import {
  AgyStreamAccumulator,
  AgyStreamProtocolError,
  parseAgyStreamLine,
} from "../src/protocol/agy-stream.ts";

const conversationId = "conversation-system-message";
const usage = {
  input_tokens: 1,
  output_tokens: 1,
  thinking_tokens: 0,
  cache_read_tokens: 0,
  total_tokens: 2,
};

function initLine(): string {
  return JSON.stringify({
    event: "init",
    conversation_id: conversationId,
    init: {
      cwd: "/tmp/work",
      tools: [],
      permission_mode: "request-review",
      model: "gemini-3.6-flash-low",
    },
  });
}

function informationalLine(stepType: "system_message" | "error_message", state: "DONE" | "ERROR" = "DONE"): string {
  return JSON.stringify({
    event: "step_update",
    step_update: {
      conversation_id: conversationId,
      step_index: 2,
      state,
      step_type: stepType,
      text_delta: stepType === "system_message"
        ? "native informational message"
        : "native transient error message",
    },
  });
}

function resultLine(): string {
  return JSON.stringify({
    event: "result",
    result: {
      conversation_id: conversationId,
      status: "SUCCESS",
      response: "ok",
      duration_seconds: 0.1,
      num_turns: 1,
      usage,
    },
  });
}

test("system_message is retained as informational evidence without becoming assistant or tool output", () => {
  const parsed = parseAgyStreamLine(informationalLine("system_message"));
  assert.equal(parsed.event, "step_update");
  if (parsed.event === "step_update") {
    assert.equal(parsed.step_update.step_type, "system_message");
  }

  const stream = new AgyStreamAccumulator({ expectedModelId: "gemini-3.6-flash-low" });
  stream.consumeLine(initLine());
  stream.consumeLine(informationalLine("system_message"));
  stream.consumeLine(resultLine());

  const snapshot = stream.finalize();
  assert.equal(snapshot.assistantText, "");
  assert.equal(snapshot.toolSteps.length, 0);
  assert.equal(snapshot.stepUpdates.length, 1);
  assert.equal(snapshot.stepUpdates[0]?.step_type, "system_message");
  assert.equal(snapshot.result.response, "ok");
});

test("error_message is retained as informational evidence and terminal result remains authoritative", () => {
  const parsed = parseAgyStreamLine(informationalLine("error_message", "ERROR"));
  assert.equal(parsed.event, "step_update");
  if (parsed.event === "step_update") {
    assert.equal(parsed.step_update.step_type, "error_message");
    assert.equal(parsed.step_update.state, "ERROR");
  }

  const stream = new AgyStreamAccumulator({ expectedModelId: "gemini-3.6-flash-low" });
  stream.consumeLine(initLine());
  stream.consumeLine(informationalLine("error_message", "ERROR"));
  stream.consumeLine(resultLine());

  const snapshot = stream.finalize();
  assert.equal(snapshot.assistantText, "");
  assert.equal(snapshot.toolSteps.length, 0);
  assert.equal(snapshot.stepUpdates.length, 1);
  assert.equal(snapshot.stepUpdates[0]?.step_type, "error_message");
  assert.equal(snapshot.stepUpdates[0]?.state, "ERROR");
  assert.equal(snapshot.result.status, "SUCCESS");
  assert.equal(snapshot.result.response, "ok");
});

test("unrecognized future step categories still fail closed", () => {
  const line = JSON.stringify({
    event: "step_update",
    step_update: {
      conversation_id: conversationId,
      step_index: 2,
      state: "DONE",
      step_type: "future_unknown_effect",
    },
  });
  assert.throws(
    () => parseAgyStreamLine(line),
    (error: unknown) =>
      error instanceof AgyStreamProtocolError && error.code === "malformed_event",
  );
});
