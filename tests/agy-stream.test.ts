import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  AgyStreamAccumulator,
  AgyStreamProtocolError,
  parseAgyStreamLine,
} from "../src/protocol/agy-stream.ts";

const usage = {
  input_tokens: 10,
  output_tokens: 4,
  thinking_tokens: 2,
  cache_read_tokens: 3,
  total_tokens: 14,
};

function initLine(conversationId = "conversation-1") {
  return JSON.stringify({
    event: "init",
    conversation_id: conversationId,
    init: {
      cwd: "/tmp/work",
      tools: ["run_command", "write_to_file"],
      permission_mode: "request-review",
      model: "model/exact-high",
    },
  });
}

function resultLine(params?: {
  conversationId?: string;
  status?: string;
  response?: string;
  structuredOutput?: unknown;
}) {
  return JSON.stringify({
    event: "result",
    result: {
      conversation_id: params?.conversationId ?? "conversation-1",
      status: params?.status ?? "SUCCESS",
      response: params?.response ?? "done\n",
      duration_seconds: 1.25,
      num_turns: 1,
      ...(params?.structuredOutput !== undefined
        ? { structured_output: params.structuredOutput }
        : {}),
      usage,
    },
  });
}

test("strict parser accepts documented init, tool and result events", () => {
  assert.equal(parseAgyStreamLine(initLine()).event, "init");
  const tool = parseAgyStreamLine(
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conversation-1",
        step_index: 2,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: {
          name: "run_command",
          parameters: { CommandLine: "printf ok" },
          output: "ok",
        },
      },
    }),
  );
  assert.equal(tool.event, "step_update");
  assert.equal(parseAgyStreamLine(resultLine()).event, "result");
});

test("assistant deltas preserve ordered repeated content without deduplication", () => {
  const stream = new AgyStreamAccumulator();
  stream.consumeLine(initLine());
  for (const [index, delta] of ["same", "same", "\n"] .entries()) {
    stream.consumeLine(
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conversation-1",
          step_index: 1,
          state: index === 2 ? "DONE" : "ACTIVE",
          step_type: "agent_response",
          text_delta: delta,
          ...(index === 2 ? { usage } : {}),
        },
      }),
    );
  }
  stream.consumeLine(resultLine({ response: "samesame\n" }));

  const snapshot = stream.finalize();
  assert.equal(snapshot.assistantText, "samesame\n");
  assert.equal(snapshot.result.response, "samesame\n");
});

test("terminal response is retained independently from streamed fragments", () => {
  const stream = new AgyStreamAccumulator();
  stream.consumeLine(initLine());
  stream.consumeLine(
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conversation-1",
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "partial",
      },
    }),
  );
  stream.consumeLine(resultLine({ response: "authoritative final\n" }));

  const snapshot = stream.finalize();
  assert.equal(snapshot.assistantText, "partial");
  assert.equal(snapshot.result.response, "authoritative final\n");
});

test("malformed JSON is rejected with a protocol code", () => {
  assert.throws(
    () => parseAgyStreamLine('{"event":"init"'),
    (error: unknown) =>
      error instanceof AgyStreamProtocolError && error.code === "malformed_json",
  );
});

test("conversation changes fail closed", () => {
  const stream = new AgyStreamAccumulator();
  stream.consumeLine(initLine());
  assert.throws(
    () => stream.consumeLine(resultLine({ conversationId: "conversation-2" })),
    (error: unknown) =>
      error instanceof AgyStreamProtocolError && error.code === "conversation_mismatch",
  );
});

test("duplicate terminal events fail closed", () => {
  const stream = new AgyStreamAccumulator();
  stream.consumeLine(initLine());
  stream.consumeLine(resultLine());
  assert.throws(
    () => stream.consumeLine(resultLine()),
    (error: unknown) =>
      error instanceof AgyStreamProtocolError && error.code === "duplicate_terminal",
  );
});

test("nonterminal EOF fails closed", () => {
  const stream = new AgyStreamAccumulator();
  stream.consumeLine(initLine());
  assert.throws(
    () => stream.finalize(),
    (error: unknown) =>
      error instanceof AgyStreamProtocolError && error.code === "nonterminal_eof",
  );
});

test("AGY empty-success regression is not accepted as a successful turn", () => {
  const stream = new AgyStreamAccumulator();
  stream.consumeLine(initLine());
  stream.consumeLine(resultLine({ response: "" }));
  assert.throws(
    () => stream.finalize(),
    (error: unknown) =>
      error instanceof AgyStreamProtocolError && error.code === "empty_success",
  );
});

test("structured output may be the successful payload when response is empty", () => {
  const stream = new AgyStreamAccumulator();
  stream.consumeLine(initLine());
  stream.consumeLine(resultLine({ response: "", structuredOutput: { verdict: "PASS" } }));
  assert.deepEqual(stream.finalize().result.structured_output, { verdict: "PASS" });
});

test("AGY tool ERROR is a valid terminal step state", () => {
  const event = parseAgyStreamLine(
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conversation-1",
        step_index: 2,
        state: "ERROR",
        step_type: "tool",
        tool_name: "run_command",
        duration_seconds: 0.2,
        tool_info: {
          name: "run_command",
          parameters: { CommandLine: "printf ok" },
          error: { type: "TOOL_ERROR", message: "permission denied" },
        },
      },
    }),
  );
  assert.equal(event.event, "step_update");
  if (event.event === "step_update") {
    assert.equal(event.step_update.state, "ERROR");
    assert.equal(event.step_update.tool_info?.error?.type, "TOOL_ERROR");
  }
});

function protocolCode(code: string) {
  return (error: unknown) => error instanceof AgyStreamProtocolError && error.code === code;
}

function stepLine(state: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ event: "step_update", step_update: {
    conversation_id: "conversation-1", step_index: 1, state,
    step_type: "agent_response", text_delta: "part", ...extra,
  } });
}

test("native model identity is required and opaque exact IDs are preserved", () => {
  for (const model of [undefined, "", "   ", 3]) {
    const init = JSON.parse(initLine());
    init.init.model = model;
    assert.throws(() => parseAgyStreamLine(JSON.stringify(init)), protocolCode("malformed_event"));
  }
  const exactModel = "future/vendor:variant+effort=ultra.123";
  const init = JSON.parse(initLine());
  init.init.model = exactModel;
  const stream = new AgyStreamAccumulator({ expectedModelId: exactModel });
  stream.consumeLine(JSON.stringify(init));
  stream.consumeLine(resultLine());
  assert.equal(stream.finalize().init.model, exactModel);
});

test("wrong model and resume identity fail and retain actual acknowledgement", () => {
  const wrongModel = new AgyStreamAccumulator({ expectedModelId: "model/exact-medium" });
  assert.throws(() => wrongModel.consumeLine(initLine()), protocolCode("model_mismatch"));
  assert.equal(wrongModel.partialSnapshot().init?.model, "model/exact-high");
  assert.throws(() => wrongModel.consumeLine(resultLine()), protocolCode("model_mismatch"));
  assert.throws(() => wrongModel.finalize(), protocolCode("model_mismatch"));

  const wrongSession = new AgyStreamAccumulator({ expectedConversationId: "bound-conversation" });
  assert.throws(() => wrongSession.consumeLine(initLine()), protocolCode("conversation_mismatch"));
  assert.equal(wrongSession.partialSnapshot().conversationId, "conversation-1");
});

test("one init and terminal ordering are enforced", () => {
  for (const line of [resultLine(), stepLine("ACTIVE")]) {
    assert.throws(() => new AgyStreamAccumulator().consumeLine(line), protocolCode("event_before_init"));
  }
  const duplicate = new AgyStreamAccumulator();
  duplicate.consumeLine(initLine());
  assert.throws(() => duplicate.consumeLine(initLine()), protocolCode("duplicate_init"));

  const late = new AgyStreamAccumulator();
  late.consumeLine(initLine());
  late.consumeLine(resultLine());
  assert.throws(() => late.consumeLine(stepLine("DONE")), protocolCode("event_after_terminal"));
  assert.throws(() => late.finalize(), protocolCode("event_after_terminal"));
  assert.equal(late.partialSnapshot().result?.status, "SUCCESS");
});

test("step identity allows repeated ACTIVE and one terminal, including direct DONE", () => {
  const stream = new AgyStreamAccumulator();
  stream.consumeLine(initLine());
  stream.consumeLine(stepLine("ACTIVE", { text_delta: "a" }));
  stream.consumeLine(stepLine("ACTIVE", { text_delta: "a" }));
  stream.consumeLine(stepLine("DONE", { text_delta: "\n" }));
  stream.consumeLine(stepLine("DONE", { step_index: 5, text_delta: "z" }));
  stream.consumeLine(resultLine({ response: "aa\nz" }));
  assert.equal(stream.finalize().assistantText, "aa\nz");

  for (const first of ["DONE", "ERROR"]) {
    for (const after of ["ACTIVE", "DONE", "ERROR"]) {
      const invalid = new AgyStreamAccumulator();
      invalid.consumeLine(initLine());
      invalid.consumeLine(stepLine(first));
      assert.throws(() => invalid.consumeLine(stepLine(after)), protocolCode("invalid_step_transition"));
      assert.equal(invalid.partialSnapshot().stepUpdates.length, 1);
    }
  }
});

test("step type and canonical tool identity cannot change within one step", () => {
  const stream = new AgyStreamAccumulator();
  stream.consumeLine(initLine());
  stream.consumeLine(stepLine("ACTIVE"));
  assert.throws(() => stream.consumeLine(stepLine("DONE", {
    step_type: "tool", tool_name: "run_command",
  })), protocolCode("invalid_step_transition"));
  const tool = new AgyStreamAccumulator();
  tool.consumeLine(initLine());
  tool.consumeLine(stepLine("ACTIVE", { step_type: "tool", tool_name: "run_command" }));
  assert.throws(() => tool.consumeLine(stepLine("DONE", {
    step_type: "tool", tool_name: "write_to_file",
  })), protocolCode("invalid_step_transition"));
  assert.throws(() => parseAgyStreamLine(stepLine("DONE", {
    step_type: "tool", tool_name: "run_command", tool_info: { name: "write_to_file" },
  })), protocolCode("malformed_event"));
});

test("unfinished success and nonterminal status retain partial observations", () => {
  const incomplete = new AgyStreamAccumulator();
  incomplete.consumeLine(initLine());
  incomplete.consumeLine(stepLine("ACTIVE"));
  assert.throws(() => incomplete.consumeLine(resultLine()), protocolCode("incomplete_step"));
  assert.equal(incomplete.partialSnapshot().assistantText, "part");
  assert.equal(incomplete.partialSnapshot().result?.status, "SUCCESS");
  for (const status of ["WAITING", "RUNNING"]) {
    const stream = new AgyStreamAccumulator();
    stream.consumeLine(initLine());
    assert.throws(() => stream.consumeLine(resultLine({ status })), protocolCode("nonterminal_result"));
    assert.equal(stream.partialSnapshot().result?.status, status);
  }
  const failed = new AgyStreamAccumulator();
  failed.consumeLine(initLine());
  failed.consumeLine(stepLine("ACTIVE"));
  failed.consumeLine(resultLine({ status: "ERROR", response: "partial" }));
  assert.equal(failed.finalize().result.status, "ERROR");
});

test("harmless additive fields are accepted while critical unknowns fail", () => {
  const stream = new AgyStreamAccumulator();
  const init = JSON.parse(initLine());
  init.future_root = { trace: 1 };
  init.init.future_config = true;
  stream.consumeLine(JSON.stringify(init));
  const result = JSON.parse(resultLine());
  result.result.future_metadata = { opaque: true };
  result.result.usage.future_counter = 9;
  stream.consumeLine(JSON.stringify(result));
  assert.equal(stream.finalize().result.response, "done\n");

  for (const line of [
    JSON.stringify({ event: "future_critical", result: {} }),
    stepLine("PAUSED"),
    stepLine("DONE", { step_type: "unknown_effect" }),
    resultLine({ status: "FUTURE_SUCCESS" }),
  ]) assert.throws(() => parseAgyStreamLine(line), protocolCode("malformed_event"));
});

test("malformed stream is sticky and snapshots cannot rewrite retained evidence", () => {
  const stream = new AgyStreamAccumulator();
  const init = parseAgyStreamLine(initLine());
  stream.consume(init);
  if (init.event === "init") init.init.model = "changed";
  const event = stream.consumeLine(stepLine("ACTIVE"));
  if (event.event === "step_update") event.step_update.text_delta = "changed";
  assert.throws(() => stream.consumeLine("{broken"), protocolCode("malformed_json"));
  const partial = stream.partialSnapshot();
  assert.equal(partial.assistantText, "part");
  assert.equal(partial.init?.model, "model/exact-high");
  partial.stepUpdates[0]!.text_delta = "changed";
  assert.equal(stream.partialSnapshot().stepUpdates[0]?.text_delta, "part");
  assert.throws(() => stream.finalize(), protocolCode("malformed_json"));
});

test("negative durations, imprecise counters and success/error contradiction fail", () => {
  for (const fields of [
    { duration_seconds: -1 },
    { num_turns: Number.MAX_SAFE_INTEGER + 1 },
    { error: "native failure" },
    { usage: { ...usage, input_tokens: Number.MAX_SAFE_INTEGER + 1 } },
  ]) {
    const result = JSON.parse(resultLine());
    Object.assign(result.result, fields);
    assert.throws(() => parseAgyStreamLine(JSON.stringify(result)), protocolCode("malformed_event"));
  }
});

for (const version of ["1.1.28", "1.2.2"]) {
  test(`documentation-derived synthetic ${version} headless contract fixture`, async () => {
    const contents = await readFile(new URL(`./fixtures/agy/${version}/headless.ndjson`, import.meta.url), "utf8");
    const stream = new AgyStreamAccumulator({ expectedModelId: "fixture/vendor:future-model+high" });
    for (const line of contents.trim().split("\n")) stream.consumeLine(line);
    const snapshot = stream.finalize();
    assert.equal(snapshot.assistantText, "fixture ✓\n");
    assert.equal(snapshot.result.response, snapshot.assistantText);
    assert.equal(snapshot.toolSteps.length, 2);
    assert.equal(snapshot.toolSteps[1]?.tool_info?.output, "marker observed");
  });
}
