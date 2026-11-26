import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import plugin from "../src/index.ts";
import type { AgentHarnessAttemptParamsV2, AgentHarnessV2, OpenClawPluginApi } from "../src/host/types.ts";
import type { AntigravityAttemptResult } from "../src/harness/result.ts";
import { AGY_SOURCE_CLI_PRELUDE } from "./fixtures/agy-source-cli.ts";
import { createSourceSessionRuntime } from "./fixtures/host-contracts.ts";

// Real local child processes and the ordinary plugin registration path, with a
// SIMULATED public session API and credential-free CLI protocol. These tests do
// not execute AGY, qualify its version, or supply an injected identity adapter.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agy-registered-native-"));
  const command = join(root, "fake-agy.cjs");
  const inputsPath = join(root, "inputs.jsonl");
  const behaviorPath = join(root, "behavior.json");
  await writeFile(inputsPath, "");
  await writeFile(behaviorPath, "{}");
  await writeFile(command, `#!${process.execPath}
${AGY_SOURCE_CLI_PRELUDE}
fs.appendFileSync(${JSON.stringify(inputsPath)}, JSON.stringify({ args, frame,
  marker:process.env.AGY_SOURCE_PREPARED_MARKER }) + "\\n");
const behavior = JSON.parse(fs.readFileSync(${JSON.stringify(behaviorPath)}, "utf8"));
if (behavior.fail) {
  process.stderr.write("SIMULATED native execution failure\\n");
  process.exit(7);
}
const id = behavior.conversation ?? (args.includes("--conversation")
  ? args[args.indexOf("--conversation") + 1] : "native-registered-conversation");
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
emit({event:"init",conversation_id:id,init:{cwd:process.cwd(),tools:[],
  permission_mode:"request-review",model:behavior.model ?? args[args.indexOf("--model") + 1]}});
if (behavior.status === "ERROR") {
  emit({event:"step_update",step_update:{conversation_id:id,step_index:1,state:"DONE",step_type:"agent_response",
    text_delta:"revoked fixture partial"}});
}
emit({event:"result",result:{conversation_id:id,status:behavior.status ?? "SUCCESS",
  response:behavior.response ?? "Native fixture answer",error:behavior.error,
  duration_seconds:0.01,num_turns:1,usage:{input_tokens:4,output_tokens:3,
    thinking_tokens:0,cache_read_tokens:0,total_tokens:7}}});
`, { mode: 0o700 });

  const session = { sessionKey: "agent:main:registered", sessionId: "SIMULATED-registered-session" };
  const { runtime, rows } = createSourceSessionRuntime([session]);
  const storePath = join(root, "SIMULATED-session-store");
  const sdkSession = {
    getSessionEntryAsync: runtime.getSessionEntryAsync.bind(runtime),
    listSessionEntriesAsync: runtime.listSessionEntriesAsync.bind(runtime),
    prepareSessionEntryPatch: runtime.prepareSessionEntryPatch.bind(runtime),
    async withSessionEntriesAsync<T>(params: {
      stores: Array<{ agentId: string; storePath: string; sessionKeys: string[] }>;
    }, consume: (entries: Array<Record<string, unknown>>) => T): Promise<T> {
      return consume(params.stores.flatMap(store => store.sessionKeys.flatMap(sessionKey => {
        const entry = rows.get(sessionKey);
        return entry ? [{ agentId: store.agentId, storePath: store.storePath,
          sessionKey, entry: structuredClone(entry) }] : [];
      })));
    },
  };
  const services: Array<{ stop: () => unknown }> = [];
  function register(): AgentHarnessV2 {
    let harness: AgentHarnessV2 | undefined;
    const registrations: string[] = [];
    plugin.register({
      pluginConfig: { command, project: "configured-native-project" },
      runtime: { version: "2026.11.7", agent: { session: sdkSession } },
      registerProvider() { registrations.push("provider"); },
      registerModelCatalogProvider() { registrations.push("catalog"); },
      registerAgentHarness(value: AgentHarnessV2) { registrations.push("harness"); harness = value; },
      registerService(service: { stop: () => unknown }) { services.push(service); },
    } as unknown as OpenClawPluginApi);
    assert.deepEqual(registrations, ["provider", "catalog", "harness"]);
    assert.ok(harness);
    return harness;
  }
  const attempt = {
    ...session, agentId: "main", runId: "SIMULATED-registered-run",
    sessionTarget: { sessionKey: session.sessionKey, agentId: "main", storePath },
    modelId: "gemini-3.8-flash-low", model: { contextWindow: 200_000 },
    prompt: "First delegated turn", workspaceDir: root, cwd: root, timeoutMs: 8_000,
    hostCapabilities: {
      assertActive() {},
      preparedEnvironment() {
        return { credentialScrubEnv: {}, localIdentityEnv: {}, managedLocalIdentity: false,
          localProcessEnv: { AGY_SOURCE_PREPARED_MARKER: "prepared-by-host" } };
      },
    },
  } as unknown as AgentHarnessAttemptParamsV2;
  return {
    register, attempt, rows, session,
    setBehavior: (behavior: Record<string, unknown>) => writeFile(behaviorPath, JSON.stringify(behavior)),
    async inputs(): Promise<Array<{ args: string[]; frame: { event: string; message: { content: string } }; marker: string }>> {
      return (await readFile(inputsPath, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
    },
    binding() { return rows.get(session.sessionKey)?.pluginExtensions?.antigravity?.binding as Record<string, unknown> | undefined; },
    async cleanup() {
      for (const service of services) await service.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function run(harness: AgentHarnessV2, attempt: AgentHarnessAttemptParamsV2) {
  return await harness.runAttempt(attempt) as AntigravityAttemptResult;
}

test("ordinary registration executes a fresh turn and resumes its exact persisted conversation after registration restarts", async () => {
  const f = await fixture();
  try {
    const first = await run(f.register(), f.attempt);
    assert.equal(first.terminal.kind, "ok", first.assistantTexts.join("\n"));
    assert.deepEqual(first.assistantTexts, ["Native fixture answer"]);
    assert.equal(first.antigravityEvidence.nativeIdentityVerified, true);
    const binding = structuredClone(f.binding());
    assert.equal(binding?.conversationId, "native-registered-conversation");
    assert.equal(binding?.modelId, f.attempt.modelId);

    const resumed = await run(f.register(), { ...f.attempt, prompt: "Second delegated turn" });
    assert.equal(resumed.terminal.kind, "ok", resumed.assistantTexts.join("\n"));
    assert.equal(resumed.antigravityEvidence.conversationId, binding!.conversationId);
    assert.deepEqual(f.binding(), binding);
    const inputs = await f.inputs();
    assert.equal(inputs.length, 2);
    assert.equal(inputs[0]!.args.includes("--conversation"), false);
    assert.equal(inputs[0]!.args[inputs[0]!.args.indexOf("--project") + 1], "configured-native-project");
    assert.equal(inputs[1]!.args[inputs[1]!.args.indexOf("--conversation") + 1], binding!.conversationId);
    assert.equal(inputs[1]!.args.includes("--project"), false, "AGY resumes the conversation's existing project");
    assert.equal(inputs[1]!.args.includes("--new-project"), false);
    for (const input of inputs) {
      assert.equal(input.args[input.args.indexOf("--model") + 1], f.attempt.modelId);
      assert.equal(input.marker, "prepared-by-host");
    }
    assert.deepEqual(inputs.map(input => input.frame), [
      { event: "user", message: { content: "First delegated turn" } },
      { event: "user", message: { content: "Second delegated turn" } },
    ]);
    await assert.doesNotReject(resumed.antigravityDeliveryGuard!);
  } finally { await f.cleanup(); }
});

test("an existing native binding resumes with its retained opaque scope key without an identity adapter", async () => {
  const f = await fixture();
  try {
    assert.equal((await run(f.register(), f.attempt)).terminal.kind, "ok");
    const envelope = f.rows.get(f.session.sessionKey)!.pluginExtensions!.antigravity!;
    const legacyScope = "opaque-native-scope:retained-from-earlier-release";
    (envelope.binding as Record<string, unknown>).scopeKey = legacyScope;
    (envelope.lastSettledAttempt as Record<string, unknown>).scopeKey = legacyScope;
    const before = structuredClone(f.binding());
    const resumed = await run(f.register(), f.attempt);
    assert.equal(resumed.terminal.kind, "ok", resumed.assistantTexts.join("\n"));
    assert.deepEqual(f.binding(), before);
    const inputs = await f.inputs();
    assert.equal(inputs.length, 2);
    assert.equal(inputs[1]!.args[inputs[1]!.args.indexOf("--conversation") + 1], before!.conversationId);
    assert.equal(f.binding()!.scopeKey, legacyScope);
  } finally { await f.cleanup(); }
});

test("ordinary registration rejects a different returned model without binding or retrying the native turn", async () => {
  const f = await fixture();
  try {
    await f.setBehavior({ model: "different-native-model" });
    const result = await run(f.register(), f.attempt);
    assert.equal(result.terminal.kind, "failed");
    assert.match(result.assistantTexts.join("\n"), /model_mismatch/);
    assert.equal(f.binding(), undefined);
    assert.equal(result.replayMetadata?.replaySafe, false);
    assert.equal((await f.inputs()).length, 1);
  } finally { await f.cleanup(); }
});

test("ordinary registration rejects a different returned conversation and retains the original resume binding", async () => {
  const f = await fixture();
  try {
    assert.equal((await run(f.register(), f.attempt)).terminal.kind, "ok");
    const before = structuredClone(f.binding());
    await f.setBehavior({ conversation: "different-native-conversation" });
    const result = await run(f.register(), f.attempt);
    assert.equal(result.terminal.kind, "failed");
    assert.match(result.assistantTexts.join("\n"), /conversation_mismatch/);
    assert.deepEqual(f.binding(), before);
    assert.equal(result.replayMetadata?.replaySafe, false);
    const inputs = await f.inputs();
    assert.equal(inputs.length, 2);
    assert.equal(inputs[1]!.args[inputs[1]!.args.indexOf("--conversation") + 1], before!.conversationId);
  } finally { await f.cleanup(); }
});

test("structured native failure survives subsequent settlement and delivery refusals without exposing output", async () => {
  const f = await fixture();
  try {
    await f.setBehavior({ status: "ERROR", response: "synthetic-secret-response", error: "synthetic-secret-error" });
    let replacements = 0;
    const result = await run(f.register(), {
      ...f.attempt,
      hostCapabilities: {
        ...f.attempt.hostCapabilities,
        trajectory: {
          recordEvent(type) {
            // Deterministic handoff after terminal consumption/EOF and before
            // the real binding settlement and result-delivery checks.
            if (type === "antigravity.attempt_terminal") {
              f.rows.get(f.session.sessionKey)!.lifecycleRevision = "synthetic-secret-foreign-generation";
              replacements++;
            }
          },
          async flush() {},
        },
      },
    });
    assert.equal(replacements, 1);
    assert.equal(f.rows.get(f.session.sessionKey)!.lifecycleRevision, "synthetic-secret-foreign-generation");
    assert.equal(result.antigravityEvidence.terminal.protocolComplete, true);
    assert.equal(result.antigravityEvidence.termination.exitCode, 0);
    assert.equal(result.antigravityEvidence.termination.cleanupComplete, true);
    assert.equal(result.antigravityEvidence.outputObserved, true);
    assert.deepEqual(result.assistantTexts, []);
    assert.deepEqual(result.messagesSnapshot, []);
    assert.equal(result.lastAssistant, undefined);
    assert.equal(result.currentAttemptAssistant, undefined);
    assert.equal(result.currentAttemptCompletedAssistant, undefined);
    assert.equal(result.antigravityOutcome.availableOutput, false);
    assert.equal(result.replayMetadata?.replaySafe, false);
    assert.equal(result.currentAttemptReplayMetadata?.replaySafe, false);
    assert.equal((await f.inputs()).length, 1);
    assert.equal(result.terminal.kind, "failed");
    assert.ok(result.terminal.error instanceof Error);
    const diagnostic = result.terminal.error;
    assert.equal(diagnostic.cause, undefined);
    assert.doesNotMatch(`${diagnostic.message}\n${JSON.stringify(result)}`, /synthetic-secret|revoked fixture partial/u);
    assert.deepEqual([...diagnostic.message.matchAll(/stage=(\w+)/gu)].map(match => match[1]),
      ["native_result", "settlement", "delivery"]);
    assert.match(diagnostic.message, /^AGY returned ERROR; native diagnostic withheld\./u);
    assert.match(diagnostic.message, /nativeStatus=ERROR/u);
  } finally { await f.cleanup(); }
});

test("ordinary registration reports native failure after one process attempt without automatic replay", async () => {
  const f = await fixture();
  try {
    await f.setBehavior({ fail: true });
    const result = await run(f.register(), f.attempt);
    assert.equal(result.terminal.kind, "failed");
    assert.equal(result.antigravityEvidence.invocation, "started");
    assert.equal(result.antigravityEvidence.termination.cleanupComplete, true);
    assert.equal(result.replayMetadata?.replaySafe, false);
    assert.equal(f.binding(), undefined);
    assert.equal((await f.inputs()).length, 1);
  } finally { await f.cleanup(); }
});

test("registered effort override binds native-resolved exact ID; same variant resumes, changed variant refuses before inference", async () => {
  const f = await fixture();
  try {
    const request = { ...f.attempt, model: { ...f.attempt.model, reasoning: true }, thinkLevel: "high" as const };
    const first = await run(f.register(), request);
    assert.equal(first.terminal.kind, "ok", first.assistantTexts.join("\n"));
    assert.equal(f.binding()?.modelId, "gemini-3.8-flash-high");
    const before = structuredClone(f.binding());
    const resumed = await run(f.register(), request);
    assert.equal(resumed.terminal.kind, "ok", resumed.assistantTexts.join("\n"));
    assert.deepEqual(f.binding(), before);
    const changed = await run(f.register(), { ...request, thinkLevel: "medium" });
    assert.equal(changed.terminal.kind, "failed");
    assert.match(changed.assistantTexts.join("\n"), /resume-variant-change/);
    assert.equal(changed.antigravityEvidence.invocation, "not_started");
    assert.deepEqual(f.binding(), before);
    const inputs = await f.inputs();
    assert.equal(inputs.length, 2);
    for (const { args } of inputs) {
      assert.equal(args[args.indexOf("--effort") + 1], "high");
      assert.equal(args[args.indexOf("--model") + 1], "gemini-3.8-flash-high");
    }
    assert.equal(inputs[1]!.args[inputs[1]!.args.indexOf("--conversation") + 1], before!.conversationId);
  } finally { await f.cleanup(); }
});
