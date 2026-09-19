import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";

import { resolveAntigravityPluginConfig } from "../src/config.ts";
import { runAntigravityAttempt } from "../src/harness/run-attempt.ts";
import type { AntigravitySessionBindings } from "../src/harness/session-bindings.ts";
import { AGY_SOURCE_CLI_PRELUDE } from "./fixtures/agy-source-cli.ts";
import { createSourceSessionBindings, sourceHostContracts } from "./fixtures/host-contracts.ts";

// Source-contract simulation, not an installed OpenClaw/AGY integration test.
// Exact OpenClaw 2026.9.4 target: 3a9d69db306cd7f081e06254cb89c4bcc14a7107:
// src/auto-reply/reply/agent-runner-embedded-candidate.ts creates onPartialReply
// unconditionally, even when turn.opts?.onPartialReply is absent.
// src/agents/embedded-agent-runner/run/run-attempt-dispatch.ts forwards it.
// src/agents/embedded-agent-runner/run/terminal-preparation.ts consumes both
// assistantTexts and currentAttemptCompletedAssistant. ANTIGRAVITY therefore
// returns the completed message shape for orchestration while keeping its
// structural zero usage separate from native accounting evidence.
type PartialPayload = { text?: string };
type PartialConsumer = (payload: PartialPayload) => boolean | void | Promise<boolean | void>;

function hostPartialWiring(consumer?: PartialConsumer) {
  let calls = 0;
  return {
    get calls() { return calls; },
    // Model only the unconditional wrapper and optional consumer. Presentation
    // sanitization/typing are inert for these plain-text source fixtures.
    async onPartialReply(payload: PartialPayload) {
      calls++;
      if (!payload.text) return false;
      return consumer ? await consumer({ text: payload.text }) : false;
    },
  };
}

async function fixture(malformed = false) {
  const root = await mkdtemp(join(tmpdir(), "agy-host-delivery-contract-"));
  const command = join(root, "fake-agy.cjs");
  const calls = join(root, "calls.jsonl");
  const script = `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
${AGY_SOURCE_CLI_PRELUDE}
const id = "conversation-host-delivery";
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
emit({event:"init",conversation_id:id,init:{cwd:process.cwd(),tools:[],permission_mode:"request-review",model:"gemini-3.8-flash-low"}});
for (const [state, text_delta] of [["ACTIVE", "native "], ["DONE", "answer"]]) {
  emit({event:"step_update",step_update:{conversation_id:id,step_index:1,state,step_type:"agent_response",text_delta}});
}
if (${JSON.stringify(malformed)}) {
  process.stdout.write("{malformed\\n");
} else {
  emit({event:"result",result:{conversation_id:id,status:"SUCCESS",response:"native answer",duration_seconds:0.01,num_turns:1,usage:{input_tokens:4,output_tokens:2,thinking_tokens:0,cache_read_tokens:0,total_tokens:6}}});
}
`;
  await writeFile(command, script, { mode: 0o700 });
  return { root, command, calls, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function attempt(root: string, wiring: ReturnType<typeof hostPartialWiring>) {
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
  const params = {
    sessionId: "host-session", sessionKey: "agent:main:delivery", agentId: "main",
    sessionTarget: { sessionKey: "agent:main:delivery", agentId: "main", storePath: join(root, "SIMULATED-session-store.json") },
    modelId: "gemini-3.8-flash-low", model: { contextWindow: 200_000 },
    thinkLevel: "low", prompt: "produce a plain-text answer",
    workspaceDir: root, cwd: root, timeoutMs: 8_000,
    onPartialReply: wiring.onPartialReply,
    hostCapabilities: {
      assertActive() {},
      preparedEnvironment() {
        return { credentialScrubEnv: {}, localIdentityEnv: {}, managedLocalIdentity: false };
      },
      trajectory: {
        recordEvent(type: string, data?: Record<string, unknown>) { events.push({ type, data }); },
        async flush() {},
      },
    },
  } as unknown as AgentHarnessAttemptParamsV2;
  return { params, events };
}

function bindings(): AntigravitySessionBindings {
  return createSourceSessionBindings({ sessionId: "host-session", sessionKey: "agent:main:delivery" });
}

async function assertNativePhasesRan(path: string) {
  const calls: string[][] = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.slice(0, 2).map((args) => args[0]), ["--version", "--help"]);
  const discovery = calls[2]!;
  const modelsIndex = discovery.indexOf("models");
  const outputFormatIndex = discovery.indexOf("--output-format");
  assert.ok(modelsIndex > 0);
  assert.ok(outputFormatIndex >= 0 && outputFormatIndex < modelsIndex);
  assert.equal(discovery[outputFormatIndex + 1], "json");
  const inference = calls[3]!;
  assert.equal(inference[inference.indexOf("--input-format") + 1], "stream-json");
  assert.equal(inference[inference.indexOf("--output-format") + 1], "stream-json");
}

function assertFinalResultDiagnostic(events: Array<{ type: string; data?: Record<string, unknown> }>) {
  assert.deepEqual(events.filter((event) => event.type === "antigravity.delivery_mode"), [{
    type: "antigravity.delivery_mode",
    data: { mode: "final_result", partialReply: "not_dispatched", reason: "unqualified_mutation_fence" },
  }]);
}

test("ordinary frozen host wrapper without external preview consumer reaches inference and returns final text", async () => {
  const mock = await fixture();
  const wiring = hostPartialWiring();
  const host = attempt(mock.root, wiring);
  try {
    const result = await runAntigravityAttempt({ hostContracts: sourceHostContracts(), attempt: host.params, pluginConfig: resolveAntigravityPluginConfig({ command: mock.command }), sessionBindings: bindings() });
    assert.equal(result.terminal.kind, "ok");
    await assertNativePhasesRan(mock.calls);
    assert.deepEqual(result.assistantTexts, ["native answer"]);
    assert.equal(result.lastAssistant?.provider, "antigravity");
    assert.equal(result.currentAttemptCompletedAssistant, result.lastAssistant);
    assert.deepEqual(result.currentAttemptCompletedAssistant?.content, [
      { type: "text", text: "native answer" },
    ]);
    assert.equal(result.currentAttemptCompletedAssistant?.usage.totalTokens, 0);
    assert.deepEqual(result.attemptUsage, { contextUsage: { state: "unavailable" } });
    assert.equal(result.antigravityEvidence.invocation, "started");
    assert.equal(result.antigravityEvidence.outputObserved, true);
    assert.equal(result.antigravityEvidence.deliveredOutput, false);
    assert.equal(wiring.calls, 0);
    assertFinalResultDiagnostic(host.events);
  } finally { await mock.cleanup(); }
});

test("explicit unfenced consumer remains undispatched while the final answer completes", async () => {
  const mock = await fixture();
  const mutations: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const wiring = hostPartialWiring(async () => {
    mutations.push("before suspension");
    await gate;
    mutations.push("after suspension");
  });
  const host = attempt(mock.root, wiring);
  try {
    const result = await runAntigravityAttempt({ hostContracts: sourceHostContracts(), attempt: host.params, pluginConfig: resolveAntigravityPluginConfig({ command: mock.command }), sessionBindings: bindings() });
    assert.equal(result.terminal.kind, "ok");
    await assertNativePhasesRan(mock.calls);
    assert.deepEqual(result.assistantTexts, ["native answer"]);
    assert.equal(result.antigravityEvidence.deliveredOutput, false);
    assert.equal(result.currentAttemptReplayMetadata?.replaySafe, false);
    assertFinalResultDiagnostic(host.events);
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(wiring.calls, 0);
    assert.deepEqual(mutations, [], "no authority was granted before or after settlement");
  } finally { release(); await mock.cleanup(); }
});

test("bad telemetry with the ordinary host callback retains partial text and remains replay-unsafe", async () => {
  const mock = await fixture(true);
  const wiring = hostPartialWiring();
  const host = attempt(mock.root, wiring);
  try {
    const result = await runAntigravityAttempt({ hostContracts: sourceHostContracts(), attempt: host.params, pluginConfig: resolveAntigravityPluginConfig({ command: mock.command }), sessionBindings: bindings() });
    await assertNativePhasesRan(mock.calls);
    assert.equal(result.terminal.kind, "failed");
    assert.deepEqual(result.assistantTexts, ["native answer", result.antigravityOutcome.explanation]);
    assert.equal(result.antigravityOutcome.kind, "partial");
    assert.match(result.antigravityOutcome.explanation!, /ANTIGRAVITY: Partial result/u);
    assert.equal(result.currentAttemptCompletedAssistant, undefined);
    assert.equal(result.antigravityEvidence.outputObserved, true);
    assert.equal(result.antigravityEvidence.deliveredOutput, false);
    assert.equal(result.antigravityEvidence.terminal.protocolComplete, false);
    assert.equal(result.currentAttemptReplayMetadata?.replaySafe, false);
    assert.equal(wiring.calls, 0);
    assertFinalResultDiagnostic(host.events);
  } finally { await mock.cleanup(); }
});
