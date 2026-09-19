import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAntigravityPluginConfig } from "../src/config.ts";
import { antigravityInstructionDigest, type AntigravityInstructionRequirement } from "../src/harness/context-projection.ts";
import type { AntigravityHostContracts } from "../src/harness/host-contracts.ts";
import { runAntigravityAttempt } from "../src/harness/run-attempt.ts";
import { AntigravitySessionBindings } from "../src/harness/session-bindings.ts";
import { AGY_SOURCE_CLI_PRELUDE } from "./fixtures/agy-source-cli.ts";
import { createSourceSessionRuntime, sourceHostContracts, sourceSessionMutation } from "./fixtures/host-contracts.ts";

// Actual credential-free child processes exercise the local integration. Host
// contracts, native protocol and identity acknowledgement are SIMULATED; these
// fixtures establish neither installed OpenClaw compatibility nor AGY qualification.
async function fixture(options: { response?: string; hold?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "agy-p02t003-host-context-"));
  const command = join(root, "fake-agy.cjs");
  const callsPath = join(root, "calls.jsonl");
  const inputsPath = join(root, "inputs.jsonl");
  await writeFile(callsPath, "");
  await writeFile(inputsPath, "");
  await writeFile(command, `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
${AGY_SOURCE_CLI_PRELUDE}
fs.appendFileSync(${JSON.stringify(inputsPath)}, JSON.stringify({ args, frame }) + "\\n");
const id = args.includes("--conversation") ? args[args.indexOf("--conversation") + 1] : "native-fixture-conversation";
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
emit({event:"init",conversation_id:id,init:{cwd:process.cwd(),tools:[],permission_mode:"request-review",
  model:args[args.indexOf("--model")+1],...(args.includes("--agent") ? {agent:args[args.indexOf("--agent")+1]} : {})}});
for (const [state,text_delta] of [["ACTIVE","one "],["ACTIVE","two "],["DONE","three"]]) {
  emit({event:"step_update",step_update:{conversation_id:id,step_index:1,state,step_type:"agent_response",text_delta}});
}
emit({event:"result",result:{conversation_id:id,status:"SUCCESS",response:${JSON.stringify(options.response ?? "one two three")},
  duration_seconds:0.01,num_turns:1,usage:{input_tokens:4,output_tokens:3,thinking_tokens:0,cache_read_tokens:0,total_tokens:7}}});
if (${options.hold === true}) setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const session = { sessionKey: "agent:main:p02t003", sessionId: "host-p02t003" };
  const { runtime, rows } = createSourceSessionRuntime([session]);
  const bindings = new AntigravitySessionBindings(runtime, { atomicMutation: sourceSessionMutation });
  const identity = {
    openclawSessionId: session.sessionId, openclawSessionKey: session.sessionKey,
    agentId: "main", storePath: join(root, "SIMULATED-sessions.json"),
  };
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
  const attempt = {
    sessionId: session.sessionId, sessionKey: session.sessionKey, agentId: "main",
    sessionTarget: { sessionKey: session.sessionKey, agentId: "main", storePath: identity.storePath },
    workspaceDir: root, cwd: root, prompt: "Exact delegated user message", timeoutMs: 8_000,
    modelId: "gemini-3.8-flash-low", model: { contextWindow: 200_000 },
    hostCapabilities: {
      assertActive() {},
      preparedEnvironment() { return { credentialScrubEnv: {}, localIdentityEnv: {}, managedLocalIdentity: false }; },
      trajectory: {
        recordEvent(type: string, data?: Record<string, unknown>) { events.push({ type, data }); },
        async flush() {},
      },
    },
  } as unknown as AgentHarnessAttemptParamsV2;
  const readJsonLines = async <T>(path: string): Promise<T[]> => (await readFile(path, "utf8"))
    .split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
  return {
    root, runtime, rows, bindings, identity, attempt, events,
    config: resolveAntigravityPluginConfig({ command, project: "source-project" }),
    calls: () => readJsonLines<string[]>(callsPath),
    inputs: () => readJsonLines<{ args: string[]; frame: { event: string; message: { content: string } } }>(inputsPath),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function run(f: Fixture, hostContracts: AntigravityHostContracts = sourceHostContracts(), overrides: Record<string, unknown> = {}) {
  return runAntigravityAttempt({
    attempt: { ...f.attempt, ...overrides } as AgentHarnessAttemptParamsV2,
    pluginConfig: f.config, sessionBindings: f.bindings, hostContracts,
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("cumulative ACTIVE/ACTIVE/DONE previews are ordered, and identical terminal text is not duplicated", async () => {
  const f = await fixture();
  const commits: Array<{ text: string; delta?: string }> = [];
  let inCallback = false;
  try {
    const result = await run(f, sourceHostContracts({ preview: {
      evidence: "SIMULATED: synchronous exposure with a final commit fence",
      async publish(preview) {
        assert.equal(inCallback, false, "preview callbacks must serialize");
        inCallback = true;
        await new Promise<void>((resolve) => setImmediate(resolve));
        preview.assertCommitAllowed();
        commits.push({ text: preview.text, ...(preview.delta !== undefined ? { delta: preview.delta } : {}) });
        preview.markDelivered();
        inCallback = false;
      },
    } }));
    assert.equal(result.terminal.kind, "ok");
    assert.deepEqual(commits, [
      { text: "one ", delta: "one " }, { text: "one two ", delta: "two " },
      { text: "one two three", delta: "three" },
    ]);
    assert.deepEqual(result.assistantTexts, ["one two three"]);
    assert.equal(result.antigravityEvidence.deliveredOutput, true);
    assert.equal(result.antigravityEvidence.runtimeScope?.acknowledged, true);
    assert.equal(typeof result.antigravityDeliveryGuard, "function");
    assert.doesNotThrow(result.antigravityDeliveryGuard!);
    assert.equal((await f.inputs()).length, 1);
  } finally { await f.cleanup(); }
});

test("terminal replacement preview has no invented delta and final text contains one answer", async () => {
  const f = await fixture({ response: "Reconciled terminal answer" });
  const commits: Array<{ text: string; delta?: string }> = [];
  try {
    const result = await run(f, sourceHostContracts({ preview: {
      evidence: "SIMULATED: cumulative replacement consumer",
      publish(preview) {
        preview.assertCommitAllowed();
        commits.push({ text: preview.text, ...(preview.delta !== undefined ? { delta: preview.delta } : {}) });
        preview.markDelivered();
      },
    } }));
    assert.equal(result.terminal.kind, "ok");
    assert.equal(commits.length, 4);
    assert.deepEqual(commits[3], { text: "Reconciled terminal answer" });
    assert.deepEqual(result.assistantTexts, ["Reconciled terminal answer"]);
  } finally { await f.cleanup(); }
});

test("delivery marked at mutation survives timeout during a later asynchronous wait", async () => {
  const f = await fixture({ hold: true });
  const gate = deferred();
  const finished = deferred();
  const commits: string[] = [];
  let lateError: unknown;
  try {
    const result = await run(f, sourceHostContracts({ preview: {
      evidence: "SIMULATED: commit first, deferred acknowledgment afterward",
      async publish(preview) {
        preview.assertCommitAllowed();
        commits.push(preview.text);
        preview.markDelivered();
        try {
          await gate.promise;
          preview.assertCommitAllowed();
          commits.push("forbidden late write");
        } catch (error) { lateError = error; }
        finally { finished.resolve(); }
      },
    } }), { timeoutMs: 700 });
    assert.equal(result.terminal.kind, "timeout");
    assert.equal(result.antigravityEvidence.deliveredOutput, true);
    assert.equal(result.antigravityEvidence.outputObserved, true);
    assert.equal(result.replayMetadata?.replaySafe, false);
    gate.resolve();
    await finished.promise;
    assert.ok(lateError instanceof Error);
    assert.deepEqual(commits, ["one "]);
    assert.equal(result.antigravityEvidence.deliveredOutput, true, "late failure must not erase prior exposure");
  } finally { gate.resolve(); await f.cleanup(); }
});

test("a deferred preview cannot mutate or claim delivery after the callback deadline", async () => {
  const f = await fixture({ hold: true });
  const gate = deferred();
  const finished = deferred();
  const commits: string[] = [];
  let lateError: unknown;
  try {
    const result = await run(f, sourceHostContracts({ preview: {
      evidence: "SIMULATED: deferred sink checks its fence immediately before exposure",
      async publish(preview) {
        try {
          await gate.promise;
          preview.assertCommitAllowed();
          commits.push(preview.text);
          preview.markDelivered();
        } catch (error) { lateError = error; }
        finally { finished.resolve(); }
      },
    } }));
    assert.notEqual(result.terminal.kind, "ok");
    assert.equal(result.antigravityEvidence.termination.hostReason, "callback");
    assert.equal(result.antigravityEvidence.deliveredOutput, false);
    gate.resolve();
    await finished.promise;
    assert.ok(lateError instanceof Error);
    assert.deepEqual(commits, []);
    assert.equal(result.antigravityEvidence.deliveredOutput, false);
  } finally { gate.resolve(); await f.cleanup(); }
});

test("effective runtime acknowledgement rejection is unsafe and never creates a conversation binding", async () => {
  const f = await fixture();
  const host = sourceHostContracts();
  host.runtime.verifyAcknowledgement = () => { throw new Error("SIMULATED effective account/project identity mismatch"); };
  try {
    const result = await run(f, host);
    assert.notEqual(result.terminal.kind, "ok");
    assert.equal(result.antigravityEvidence.invocation, "started");
    assert.equal(result.antigravityEvidence.nativeIdentityVerified, true, "parser model match remains a separate fact");
    assert.equal(result.antigravityEvidence.runtimeScope?.acknowledged, false);
    assert.equal(result.replayMetadata?.replaySafe, false);
    assert.equal(f.bindings.resolve(f.identity), undefined);
    assert.equal((await f.inputs()).length, 1);
  } finally { await f.cleanup(); }
});

test("missing host contracts and unsupported required context reject before any subprocess", async () => {
  const f = await fixture();
  try {
    const missing = await runAntigravityAttempt({ attempt: f.attempt, pluginConfig: f.config, sessionBindings: f.bindings });
    assert.equal(missing.antigravityOutcome.kind, "blocked");
    assert.match(missing.assistantTexts.join("\n"), /qualified host session\/runtime adapter/);
    for (const overrides of [
      { extraSystemPrompt: "PRIVATE SYSTEM REQUIREMENT" },
      { pluginHarnessToolPolicyRestricted: true },
      { toolsAllow: [] },
    ]) {
      const result = await run(f, sourceHostContracts(), overrides);
      assert.equal(result.antigravityOutcome.kind, "blocked");
      assert.match(result.assistantTexts.join("\n"), /cannot preserve required host context/);
      assert.equal(result.antigravityEvidence.invocation, "not_started");
      assert.equal(result.replayMetadata?.replaySafe, true);
    }
    assert.deepEqual(await f.calls(), []);
    assert.deepEqual(await f.inputs(), []);
    assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE SYSTEM REQUIREMENT/);
  } finally { await f.cleanup(); }
});

test("f01: unsupported provenance and inbound context reject before subprocess or session metadata mutation", async () => {
  const f = await fixture();
  const privateValue = "PRIVATE PROVENANCE OR INBOUND CONTENT";
  const originalPatch = f.runtime.patchSessionEntry.bind(f.runtime);
  let patches = 0;
  f.runtime.patchSessionEntry = async (params) => {
    patches += 1;
    return originalPatch(params);
  };
  try {
    const before = structuredClone([...f.rows]);
    for (const overrides of [
      { inputProvenance: { kind: "inter_session", sourceSessionKey: privateValue, sourceTool: "sessions_send" } },
      { inputProvenance: { kind: "internal_system", sourceTool: privateValue } },
      { inputProvenance: { kind: "external_user", sourceChannel: null } },
      { inputProvenance: { kind: privateValue } },
      { currentInboundContext: { text: privateValue } },
      { currentInboundContext: { text: "", fragments: [{ kind: "conversation-data", text: privateValue }] } },
      { currentInboundContext: { text: "", resumableText: privateValue } },
      { currentInboundContext: { text: "", injectedGoalContexts: [privateValue] } },
      { currentInboundContext: { text: "", unexpected: privateValue } },
    ]) {
      const result = await run(f, sourceHostContracts(), { prompt: privateValue, ...overrides });
      assert.equal(result.antigravityOutcome.kind, "blocked");
      assert.equal(result.antigravityEvidence.invocation, "not_started");
      assert.equal(result.replayMetadata?.replaySafe, true);
      assert.match(result.assistantTexts.join("\n"), /cannot preserve required host context/);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE PROVENANCE OR INBOUND CONTENT/);
    }
    assert.equal(patches, 0);
    assert.deepEqual([...f.rows], before);
    assert.equal(f.bindings.resolve(f.identity), undefined);
    assert.deepEqual(await f.calls(), []);
    assert.deepEqual(await f.inputs(), []);
    assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE PROVENANCE OR INBOUND CONTENT/);
  } finally { await f.cleanup(); }
});

test("f01: external-user provenance and empty inbound context execute the exact delegated prompt", async () => {
  const f = await fixture();
  try {
    const result = await run(f, sourceHostContracts(), {
      inputProvenance: {
        kind: "external_user", originSessionId: f.identity.openclawSessionId,
        sourceSessionKey: f.identity.openclawSessionKey, sourceChannel: "webchat", sourceTool: "channel-input",
      },
      currentInboundContext: {
        text: " \n", fragments: [], resumableText: "\t", injectedGoalContexts: [], promptJoiner: "\n\n",
      },
    });
    assert.equal(result.terminal.kind, "ok");
    assert.equal(result.antigravityEvidence.invocation, "started");
    const inputs = await f.inputs();
    assert.equal(inputs.length, 1);
    assert.deepEqual(inputs[0]?.frame, { event: "user", message: { content: f.attempt.prompt } });
    assert.ok(f.bindings.resolve(f.identity));
  } finally { await f.cleanup(); }
});

test("an exact simulated instruction carrier keeps the delegated user frame unchanged", async () => {
  const f = await fixture();
  const content = "PRIVATE SYSTEM REQUIREMENT";
  const requirement: AntigravityInstructionRequirement = {
    originRef: "extraSystemPrompt", trust: "host", scope: "delegated", priority: "system", required: true,
    contentOrResource: { content }, requiredTools: [],
  };
  try {
    f.config = { ...f.config, agent: "SIMULATED-native-agent" };
    const result = await run(f, sourceHostContracts({ context: { namedAgentCarrier: {
      agentName: f.config.agent, definitionIdentity: "SIMULATED-qualified-definition-v1",
      supportedPhases: ["fresh", "resume"], assertCurrent() {},
      preserved: [{ originRef: requirement.originRef, requirementDigest: antigravityInstructionDigest(requirement) }],
    } } }), { extraSystemPrompt: content });
    assert.equal(result.terminal.kind, "ok");
    const [input] = await f.inputs();
    assert.deepEqual(input?.frame, { event: "user", message: { content: f.attempt.prompt } });
    assert.equal(input?.args[input.args.indexOf("--agent") + 1], "SIMULATED-native-agent");
    assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE SYSTEM REQUIREMENT/);
  } finally { await f.cleanup(); }
});

test("restarting the binding owner resumes the exact persisted conversation without inventing a new one", async () => {
  const f = await fixture();
  try {
    const first = await run(f);
    assert.equal(first.terminal.kind, "ok");
    assert.equal(typeof first.antigravityDeliveryGuard, "function");
    assert.doesNotThrow(first.antigravityDeliveryGuard!);
    const binding = f.bindings.resolve(f.identity);
    assert.ok(binding);
    const restarted = new AntigravitySessionBindings(f.runtime, { atomicMutation: sourceSessionMutation });
    const result = await runAntigravityAttempt({
      attempt: f.attempt, pluginConfig: f.config, sessionBindings: restarted, hostContracts: sourceHostContracts(),
    });
    assert.equal(result.terminal.kind, "ok");
    const inputs = await f.inputs();
    assert.equal(inputs.length, 2);
    assert.equal(inputs[0]!.args.includes("--conversation"), false);
    assert.equal(inputs[1]!.args[inputs[1]!.args.indexOf("--conversation") + 1], binding.conversationId);
    assert.equal(restarted.resolve(f.identity)?.epoch, binding.epoch);
    assert.equal(restarted.resolve(f.identity)?.scopeKey, binding.scopeKey);
    assert.throws(first.antigravityDeliveryGuard!, /stale or not settled/);
    assert.doesNotThrow(result.antigravityDeliveryGuard!);
    await restarted.clear({ ...f.identity, cancelAndDrain: async () => {} });
    assert.throws(result.antigravityDeliveryGuard!, /stale or not settled/);
  } finally { await f.cleanup(); }
});

test("changed project or runtime account identity cannot silently resume an existing conversation", async () => {
  const f = await fixture();
  try {
    assert.equal((await run(f)).terminal.kind, "ok");
    const before = f.bindings.resolve(f.identity);
    const callsBefore = await f.calls();
    const changedProject = await runAntigravityAttempt({
      attempt: f.attempt, pluginConfig: { ...f.config, project: "other-project" },
      sessionBindings: f.bindings, hostContracts: sourceHostContracts(),
    });
    const changedRuntime = sourceHostContracts();
    changedRuntime.runtime.identity = "SIMULATED: other account/runtime";
    const changedAccount = await run(f, changedRuntime);
    for (const result of [changedProject, changedAccount]) {
      assert.equal(result.antigravityOutcome.kind, "blocked");
      assert.match(result.assistantTexts.join("\n"), /scope changed.*explicit host reset/);
      assert.equal(result.antigravityEvidence.invocation, "not_started");
    }
    assert.deepEqual(await f.calls(), callsBefore);
    assert.deepEqual(f.bindings.resolve(f.identity), before);
  } finally { await f.cleanup(); }
});

test("reset between binding resolution and attempt claim never resurrects the pre-reset conversation", async () => {
  const f = await fixture();
  try {
    assert.equal((await run(f)).terminal.kind, "ok");
    const old = f.bindings.resolve(f.identity);
    assert.ok(old);
    const callsBefore = await f.calls();
    const originalBegin = f.bindings.beginAttempt.bind(f.bindings);
    let resetDone = false;
    f.bindings.beginAttempt = async (params) => {
      if (!resetDone) {
        resetDone = true;
        await f.bindings.clear({ ...f.identity, cancelAndDrain: async () => {} });
      }
      return originalBegin(params);
    };
    const result = await run(f);
    assert.equal(result.antigravityOutcome.kind, "blocked");
    assert.match(result.assistantTexts.join("\n"), /binding changed during preparation/);
    assert.deepEqual(await f.calls(), callsBefore);
    assert.equal(f.bindings.resolve(f.identity), undefined);
    const row = f.rows.get(f.identity.openclawSessionKey)!;
    assert.notEqual(row.pluginExtensions?.antigravity?.epoch, old.epoch);
  } finally { await f.cleanup(); }
});

test("bounded initial session claim retires a delayed commit before any subprocess starts", async () => {
  const f = await fixture();
  const gate = deferred();
  const finished = deferred();
  const originalPatch = f.runtime.patchSessionEntry.bind(f.runtime);
  let delayed = false;
  let lateError: unknown;
  f.runtime.patchSessionEntry = async (params) => {
    if (delayed) return originalPatch(params);
    delayed = true;
    await gate.promise;
    try { return await originalPatch(params); }
    catch (error) { lateError = error; throw error; }
    finally { finished.resolve(); }
  };
  try {
    const result = await run(f);
    assert.equal(result.terminal.kind, "timeout");
    assert.equal(result.antigravityEvidence.invocation, "not_started");
    assert.equal(result.replayMetadata?.replaySafe, true);
    assert.deepEqual(await f.calls(), []);
    gate.resolve();
    await finished.promise;
    assert.ok(lateError instanceof Error);
    assert.match(lateError.message, /claim callback was retired/);
    assert.equal(f.rows.get(f.identity.openclawSessionKey)?.pluginExtensions, undefined);
    assert.deepEqual(await f.calls(), []);
  } finally { gate.resolve(); await f.cleanup(); }
});
