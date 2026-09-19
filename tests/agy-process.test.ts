import assert from "node:assert/strict";
import test from "node:test";

import { AgyProcessError, runAgyStreamProcess } from "../src/cli/agy-process.ts";

const init = JSON.stringify({
  event: "init",
  conversation_id: "conversation-1",
  init: {
    cwd: "/tmp/work",
    tools: ["run_command"],
    permission_mode: "request-review",
    model: "model-1",
  },
});
const usage = {
  input_tokens: 10,
  output_tokens: 4,
  thinking_tokens: 2,
  cache_read_tokens: 3,
  total_tokens: 14,
};

function terminal(status: string, response: string) {
  return JSON.stringify({
    event: "result",
    result: {
      conversation_id: "conversation-1",
      status,
      response,
      duration_seconds: 0.1,
      num_turns: 1,
      usage,
    },
  });
}

function nodeScript(lines: string[], exitCode = 0, tail?: string): string {
  const body = lines.map((line) => `process.stdout.write(${JSON.stringify(`${line}\n`)});`).join("\n");
  return `${body}\n${tail ?? ""}\nprocess.exitCode = ${exitCode};`;
}

test("successful process returns the canonical terminal snapshot", async () => {
  const result = await runAgyStreamProcess({
    command: process.execPath,
    args: ["-e", nodeScript([init, terminal("SUCCESS", "done\\n")])],
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.snapshot.conversationId, "conversation-1");
  assert.equal(result.snapshot.result.status, "SUCCESS");
  assert.equal(result.snapshot.result.response, "done\\n");
});

test("malformed stream terminates the child and fails as protocol error", async () => {
  const script = nodeScript(
    [init, '{"event":"step_update"'],
    0,
    "setTimeout(() => process.stdout.write('should-not-survive\\n'), 10_000);",
  );

  await assert.rejects(
    runAgyStreamProcess({ command: process.execPath, args: ["-e", script], timeoutMs: 3_000 }),
    (error: unknown) =>
      error instanceof AgyProcessError &&
      error.kind === "protocol" &&
      error.message === "AGY emitted an invalid stream event (malformed_json)",
  );
});

test("structural stream diagnostics expose the parser reason without echoing event content", async () => {
  const malformed = JSON.stringify({
    event: "step_update",
    step_update: {
      conversation_id: "conversation-1",
      step_index: 1,
      state: "DONE",
      step_type: "future_step",
      text_delta: "TOP_SECRET_SHOULD_NOT_APPEAR",
    },
  });

  await assert.rejects(
    runAgyStreamProcess({
      command: process.execPath,
      args: ["-e", nodeScript([init, malformed])],
    }),
    (error: unknown) => {
      assert.ok(error instanceof AgyProcessError);
      assert.equal(error.kind, "protocol");
      assert.equal(
        error.message,
        "AGY emitted an invalid stream event: unsupported step_update.step_type: future_step",
      );
      assert.doesNotMatch(error.message, /TOP_SECRET_SHOULD_NOT_APPEAR/u);
      return true;
    },
  );
});

test("successful terminal with nonzero process exit is rejected as contradiction", async () => {
  await assert.rejects(
    runAgyStreamProcess({
      command: process.execPath,
      args: ["-e", nodeScript([init, terminal("SUCCESS", "done")], 2)],
    }),
    (error: unknown) =>
      error instanceof AgyProcessError && error.kind === "process_terminal_mismatch",
  );
});

test("error terminal with zero process exit remains an observed AGY failure result", async () => {
  const result = await runAgyStreamProcess({
    command: process.execPath,
    args: ["-e", nodeScript([init, terminal("ERROR", "failed")], 0)],
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.snapshot.result.status, "ERROR");
  assert.equal(result.snapshot.result.response, "failed");
});

test("error terminal with nonzero exit remains an observed AGY failure result", async () => {
  const result = await runAgyStreamProcess({
    command: process.execPath,
    args: ["-e", nodeScript([init, terminal("ERROR", "failed")], 1)],
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.snapshot.result.status, "ERROR");
});

test("external abort terminates the process", async () => {
  const controller = new AbortController();
  const promise = runAgyStreamProcess({
    command: process.execPath,
    args: ["-e", nodeScript([init], 0, "setTimeout(() => {}, 10_000);")],
    signal: controller.signal,
    timeoutMs: 3_000,
  });
  controller.abort();

  await assert.rejects(
    promise,
    (error: unknown) => error instanceof AgyProcessError && error.kind === "aborted",
  );
});


test("async stream callbacks are serialized before terminal return", async () => {
  const order: string[] = [];
  const result = await runAgyStreamProcess({
    command: process.execPath,
    args: ["-e", nodeScript([init, terminal("SUCCESS", "done")])],
    async onEvent(event) {
      if (event.event === "init") {
        order.push("init-start");
        await new Promise((resolve) => setTimeout(resolve, 25));
        order.push("init-end");
      } else if (event.event === "result") {
        order.push("result");
      }
    },
  });
  assert.equal(result.snapshot.result.status, "SUCCESS");
  assert.deepEqual(order, ["init-start", "init-end", "result"]);
});

test("fresh init callback completes before a later malformed line in the same stdout chunk is parsed", async () => {
  const order: string[] = [];
  const malformed = '{"event":"step_update"';
  const script = `process.stdout.write(${JSON.stringify(init + "\n" + malformed + "\n")});`;

  await assert.rejects(
    runAgyStreamProcess({
      command: process.execPath,
      args: ["-e", script],
      async onEvent(event) {
        if (event.event === "init") {
          order.push("init-start");
          await new Promise((resolve) => setTimeout(resolve, 25));
          order.push("init-persisted");
        }
      },
    }),
    (error: unknown) => error instanceof AgyProcessError && error.kind === "protocol",
  );

  assert.deepEqual(order, ["init-start", "init-persisted"]);
});
