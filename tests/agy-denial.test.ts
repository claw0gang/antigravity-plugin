import assert from "node:assert/strict";
import test from "node:test";

import {
  AgyStreamAccumulator,
  AgyStreamProtocolError,
  parseAgyStreamLine,
} from "../src/protocol/agy-stream.ts";

const usage = {
  input_tokens: 10,
  output_tokens: 0,
  thinking_tokens: 2,
  cache_read_tokens: 0,
  total_tokens: 12,
};

function initLine() {
  return JSON.stringify({
    event: "init",
    conversation_id: "conversation-1",
    init: {
      cwd: "/tmp/work",
      tools: ["run_command"],
      permission_mode: "request-review",
      model: "model/exact-high",
    },
  });
}

function denialLine(deniedActions: unknown) {
  return JSON.stringify({
    event: "result",
    result: {
      conversation_id: "conversation-1",
      status: "SUCCESS",
      response: "",
      duration_seconds: 0.2,
      num_turns: 1,
      denied_actions: deniedActions,
      usage,
    },
  });
}

test("native SUCCESS denial preserves native status without claiming host fulfillment", () => {
  const stream = new AgyStreamAccumulator();
  stream.consumeLine(initLine());
  stream.consumeLine(
    denialLine([{ action: "command", display_name: "RunCommand" }]),
  );

  const snapshot = stream.finalize();
  assert.equal(snapshot.result.status, "SUCCESS");
  assert.equal(snapshot.result.response, "");
  assert.deepEqual(snapshot.result.denied_actions, [
    { action: "command", display_name: "RunCommand" },
  ]);
});

test("denied_actions is parsed strictly", () => {
  assert.throws(
    () => parseAgyStreamLine(denialLine({ action: "command" })),
    (error: unknown) =>
      error instanceof AgyStreamProtocolError && error.code === "malformed_event",
  );
  assert.throws(
    () => parseAgyStreamLine(denialLine([{ action: "command" }])),
    (error: unknown) =>
      error instanceof AgyStreamProtocolError && error.code === "malformed_event",
  );
  assert.throws(
    () => parseAgyStreamLine(denialLine([{ action: "", display_name: "RunCommand" }])),
    (error: unknown) =>
      error instanceof AgyStreamProtocolError && error.code === "malformed_event",
  );
});
