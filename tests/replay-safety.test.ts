import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGY_SOURCE_CLI_PRELUDE } from "./fixtures/agy-source-cli.ts";
import { createSourceSessionBindings, sourceHostContracts } from "./fixtures/host-contracts.ts";

import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";

import { resolveAntigravityPluginConfig } from "../src/config.ts";
import { runAntigravityAttempt } from "../src/harness/run-attempt.ts";
import type { AntigravitySessionBindings } from "../src/harness/session-bindings.ts";

async function createPartialThenFailureMock() {
  const root = await mkdtemp(join(tmpdir(), "antigravity-replay-safety-test-"));
  const command = join(root, "agy-mock");
  const script = `#!/usr/bin/env node
${AGY_SOURCE_CLI_PRELUDE}
const conversationId = "conversation-replay-safety";
process.stdout.write(JSON.stringify({
  event: "init",
  conversation_id: conversationId,
  init: {
    cwd: ${JSON.stringify(root)},
    tools: [],
    permission_mode: "request-review",
    model: "gemini-3.8-flash-low",
  },
}) + "\\n");
process.stdout.write(JSON.stringify({
  event: "step_update",
  step_update: {
    conversation_id: conversationId,
    step_index: 1,
    state: "ACTIVE",
    step_type: "agent_response",
    text_delta: "partial assistant output",
  },
}) + "\\n");
process.stdout.write("{invalid-json\\n");
`;
  await writeFile(command, script, { mode: 0o700 });
  await chmod(command, 0o700);
  return {
    root,
    command,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function createTerminalErrorMock(includePartialOutput: boolean) {
  const root = await mkdtemp(join(tmpdir(), "antigravity-replay-terminal-test-"));
  const command = join(root, "agy-mock");
  const script = `#!/usr/bin/env node
${AGY_SOURCE_CLI_PRELUDE}
const conversationId = "conversation-terminal-error";
process.stdout.write(JSON.stringify({
  event: "init",
  conversation_id: conversationId,
  init: {
    cwd: ${JSON.stringify(root)},
    tools: [],
    permission_mode: "request-review",
    model: "gemini-3.8-flash-low",
  },
}) + "\\n");
if (${JSON.stringify(includePartialOutput)}) {
  process.stdout.write(JSON.stringify({
    event: "step_update",
    step_update: {
      conversation_id: conversationId,
      step_index: 1,
      state: "ACTIVE",
      step_type: "agent_response",
      text_delta: "partial before terminal error",
    },
  }) + "\\n");
}
process.stdout.write(JSON.stringify({
  event: "result",
  result: {
    conversation_id: conversationId,
    status: "ERROR",
    response: "failed",
    error: "failed",
    duration_seconds: 0.01,
    num_turns: 1,
    usage: {
      input_tokens: 4,
      output_tokens: 1,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 5,
    },
  },
}) + "\\n");
process.exitCode = 1;
`;
  await writeFile(command, script, { mode: 0o700 });
  await chmod(command, 0o700);
  return {
    root,
    command,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function createAttempt(params: {
  workspaceDir: string;
  onPartialReply?: (reply: { text: string }) => void | Promise<void>;
}): AgentHarnessAttemptParamsV2 {
  return {
    sessionId: "openclaw-replay-safety",
    sessionKey: "agent:main:child:replay-safety",
    agentId: "main",
    sessionTarget: { sessionKey: "agent:main:child:replay-safety", agentId: "main", storePath: join(params.workspaceDir, "SIMULATED-session-store.json") },
    modelId: "gemini-3.8-flash-low",
    model: { contextWindow: 200_000 },
    thinkLevel: "low",
    prompt: "exercise replay safety",
    workspaceDir: params.workspaceDir,
    cwd: params.workspaceDir,
    onPartialReply: async () => false,
    ...(params.onPartialReply ? { onPartialReply: params.onPartialReply } : {}),
    hostCapabilities: {
      assertActive() {},
      preparedEnvironment() { return { credentialScrubEnv: {}, localIdentityEnv: {}, managedLocalIdentity: false }; },
      trajectory: {
        recordEvent() {},
        async flush() {},
      },
    },
  } as unknown as AgentHarnessAttemptParamsV2;
}

function sessionBindings(): AntigravitySessionBindings {
  return createSourceSessionBindings({ sessionId: "openclaw-replay-safety", sessionKey: "agent:main:child:replay-safety" });
}

async function runPartialThenFailure(
  onPartialReply?: (reply: { text: string }) => void | Promise<void>,
) {
  const mock = await createPartialThenFailureMock();
  try {
    return await runAntigravityAttempt({
      hostContracts: sourceHostContracts(),
      attempt: createAttempt({
        workspaceDir: mock.root,
        ...(onPartialReply ? { onPartialReply } : {}),
      }),
      pluginConfig: resolveAntigravityPluginConfig({ command: mock.command }),
      sessionBindings: sessionBindings(),
    });
  } finally {
    await mock.cleanup();
  }
}

async function runTerminalError(params: {
  includePartialOutput: boolean;
  onPartialReply?: (reply: { text: string }) => void | Promise<void>;
}) {
  const mock = await createTerminalErrorMock(params.includePartialOutput);
  try {
    return await runAntigravityAttempt({
      hostContracts: sourceHostContracts(),
      attempt: createAttempt({
        workspaceDir: mock.root,
        ...(params.onPartialReply ? { onPartialReply: params.onPartialReply } : {}),
      }),
      pluginConfig: resolveAntigravityPluginConfig({ command: mock.command }),
      sessionBindings: sessionBindings(),
    });
  } finally {
    await mock.cleanup();
  }
}

function assertNotReplaySafeWithoutNativeToolActivity(
  result: Awaited<ReturnType<typeof runPartialThenFailure>>,
) {
  assert.equal(result.currentAttemptReplayMetadata?.hadPotentialSideEffects, true);
  assert.equal(result.currentAttemptReplayMetadata?.replaySafe, false);
}

test("partial assistant output followed by failure is not replay-safe without an external preview consumer", async () => {
  const result = await runPartialThenFailure();
  assertNotReplaySafeWithoutNativeToolActivity(result);
});

test("an unused synchronous preview callback does not block inference or hide partial failure text", async () => {
  const replies: string[] = [];
  const result = await runPartialThenFailure((reply) => {
    replies.push(reply.text);
  });

  assert.deepEqual(replies, []);
  assert.equal(result.antigravityEvidence.invocation, "started");
  assertNotReplaySafeWithoutNativeToolActivity(result);
  assert.deepEqual(result.assistantTexts, ["partial assistant output", result.antigravityOutcome.explanation]);
  assert.equal(result.antigravityOutcome.kind, "partial");
  assert.match(result.antigravityOutcome.explanation!, /ANTIGRAVITY: Partial result/u);
});

test("an asynchronous failing preview callback is never dispatched", async () => {
  let calls = 0;
  const result = await runPartialThenFailure(() => { calls++; return Promise.reject(new Error("delivery failed")); });
  assert.equal(calls, 0);
  assert.equal(result.antigravityEvidence.invocation, "started");
  assertNotReplaySafeWithoutNativeToolActivity(result);
  assert.deepEqual(result.assistantTexts, ["partial assistant output", result.antigravityOutcome.explanation]);
  assert.equal(result.antigravityOutcome.kind, "partial");
  assert.match(result.antigravityOutcome.explanation!, /ANTIGRAVITY: Partial result/u);
});

test("partial assistant output followed by matching AGY ERROR terminal is not replay-safe without an external preview consumer", async () => {
  const result = await runTerminalError({ includePartialOutput: true });
  assertNotReplaySafeWithoutNativeToolActivity(result);
});

test("the host callback does not block or redefine an acknowledged native error", async () => {
  const replies: string[] = [];
  const result = await runTerminalError({
    includePartialOutput: true,
    onPartialReply(reply) {
      replies.push(reply.text);
    },
  });

  assert.deepEqual(replies, []);
  assert.equal(result.antigravityEvidence.invocation, "started");
  assert.equal(result.antigravityEvidence.terminal.nativeStatus, "ERROR");
  assertNotReplaySafeWithoutNativeToolActivity(result);
});

test("matching AGY ERROR after inference starts is not replay-safe without output or tool activity", async () => {
  const result = await runTerminalError({ includePartialOutput: false });
  assert.equal(result.currentAttemptReplayMetadata?.hadPotentialSideEffects, true);
  assert.equal(result.currentAttemptReplayMetadata?.replaySafe, false);
});
