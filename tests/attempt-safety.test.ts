import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSourceSessionBindings, sourceHostContracts, sourceSessionMutation } from "./fixtures/host-contracts.ts";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { parseAgyPrintTimeoutMs, resolveAntigravityPluginConfig } from "../src/config.ts";
import { runAntigravityAttempt } from "../src/harness/run-attempt.ts";
import { AntigravitySessionBindings, type AntigravitySessionRuntime } from "../src/harness/session-bindings.ts";

// These subprocesses simulate AGY. No native AGY binary, credentials or inference.
const help = "--input-format stream-json\n--output-format stream-json\n--model ID\n--conversation ID\n--print-timeout DURATION\n--sandbox\n--project NAME\n--new-project\n--add-dir DIR\n--agent NAME\n--mode MODE\n--log-file PATH\n--dangerously-skip-permissions";
const model = "new-opaque-model/effort.v7";

async function fixture(mode = "success") {
  const root = await mkdtemp(join(tmpdir(), "agy-p02t002-attempt-"));
  const command = join(root, "fake-agy.cjs");
  const calls = join(root, "calls.jsonl");
  const effect = join(root, "effect");
  const discovery = join(root, "discovery");
  const prompt = join(root, "prompt");
  await writeFile(command, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args,cwd:process.cwd(),prepared:process.env.AGY_TEST_PREPARED,scrub:process.env.AGY_TEST_SCRUB})+'\n');
async function main() {
  if(args[0]==='--version') { console.log('1.2.2'); return; }
  if(args[0]==='--help') { console.log(${JSON.stringify(help)}); return; }
  if(args.includes('models')) {
    fs.writeFileSync(${JSON.stringify(discovery)},'started');
    if(${JSON.stringify(mode)}==='slow-discovery') { setInterval(()=>{},1000); return; }
    console.log(JSON.stringify({models:[{id:${JSON.stringify(model)},name:'New model',future_field:true}]})); return;
  }
  process.stdin.setEncoding('utf8'); let input=''; for await(const chunk of process.stdin) input+=chunk;
  fs.writeFileSync(${JSON.stringify(prompt)},input);
  fs.writeFileSync(${JSON.stringify(effect)},'native side effect');
  if(${JSON.stringify(mode)}==='effect-malformed') { console.log('{malformed'); return; }
  const id='native-conversation';
  console.log(JSON.stringify({event:'init',conversation_id:id,init:{cwd:process.cwd(),tools:[],permission_mode:'request-review',model:${JSON.stringify(mode)}==='wrong-model'?'wrong':${JSON.stringify(model)}}}));
  if(${JSON.stringify(mode)}==='slow-init') { setInterval(()=>{},1000); return; }
  if(${JSON.stringify(mode)}==='fragments' || ${JSON.stringify(mode)}==='partial-malformed') {
    for(const [state,text_delta] of [['ACTIVE','alpha '],['ACTIVE','beta '],['DONE','gamma']]) console.log(JSON.stringify({event:'step_update',step_update:{conversation_id:id,step_index:1,state,step_type:'agent_response',text_delta}}));
  }
  if(${JSON.stringify(mode)}==='partial-malformed') { console.log('{malformed'); return; }
  if(${JSON.stringify(mode)}==='native-timeout') process.stderr.write('Warning: print timeout reached; response truncated\n');
  console.log(JSON.stringify({event:'result',result:{conversation_id:id,status:'SUCCESS',response:${JSON.stringify(mode)}==='fragments'?'alpha beta gamma':'done',duration_seconds:0.1,num_turns:1,usage:{input_tokens:1,output_tokens:1,thinking_tokens:0,cache_read_tokens:0,total_tokens:2}}}));
}
main().catch(()=>{process.exitCode=1;});
`.replaceAll("+'\n'", "+'\\n'").replace("truncated\n'", "truncated\\n'"), { mode: 0o700 });
  return { root, command, calls, effect, discovery, prompt, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function attempt(root: string, extra: Record<string, unknown> = {}): AgentHarnessAttemptParamsV2 {
  return {
    sessionId: "host-session", sessionKey: "agent:test:source", agentId: "test",
    sessionTarget: { sessionKey: "agent:test:source", agentId: "test", storePath: join(root, "SIMULATED-session-store.json") },
    modelId: model, model: { contextWindow: 32_768 }, thinkLevel: "high",
    prompt: "task", workspaceDir: root, cwd: root, timeoutMs: 8_000,
    // Frozen OpenClaw supplies the wrapper even without a preview consumer.
    onPartialReply: async () => false,
    hostCapabilities: {
      assertActive() {},
      preparedEnvironment() { return { credentialScrubEnv: { AGY_TEST_SCRUB: "" }, localIdentityEnv: { AGY_TEST_PREPARED: "prepared" }, managedLocalIdentity: false }; },
    },
    ...extra,
  } as unknown as AgentHarnessAttemptParamsV2;
}

function bindings(onBind: () => Promise<void> = async () => {}): AntigravitySessionBindings {
  return createSourceSessionBindings({ sessionId: "host-session", sessionKey: "agent:test:source" }, onBind);
}

async function exists(path: string) { return access(path).then(() => true, () => false); }
async function waitFor(path: string) {
  for (let i = 0; i < 300; i++) { if (await exists(path)) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("fixture marker never appeared");
}

test("pre-abort and expired budget launch no preflight, discovery or inference", async () => {
  const mock = await fixture();
  try {
    const controller = new AbortController(); controller.abort();
    for (const extra of [{ abortSignal: controller.signal }, { timeoutMs: 0 }]) {
      const result = await runAntigravityAttempt({ hostContracts: sourceHostContracts(), attempt: attempt(mock.root, extra), pluginConfig: resolveAntigravityPluginConfig({ command: mock.command }), sessionBindings: bindings() });
      assert.equal(await exists(mock.calls), false);
      assert.equal(result.antigravityEvidence.invocation, "not_started");
      assert.equal(result.currentAttemptReplayMetadata?.replaySafe, true);
    }
  } finally { await mock.cleanup(); }
});

test("missing prepared host environment fails before any subprocess", async () => {
  const mock = await fixture();
  try {
    const result = await runAntigravityAttempt({ hostContracts: sourceHostContracts(), attempt: attempt(mock.root, { hostCapabilities: { assertActive() {} } }), pluginConfig: resolveAntigravityPluginConfig({ command: mock.command }), sessionBindings: bindings() });
    assert.equal(await exists(mock.calls), false);
    assert.equal(result.terminal.kind, "failed");
    assert.equal(result.antigravityEvidence.invocation, "not_started");
  } finally { await mock.cleanup(); }
});

test("native timeout config gives one finite shared budget", () => {
  assert.equal(parseAgyPrintTimeoutMs("30m"), 1_800_000);
  assert.equal(parseAgyPrintTimeoutMs("0.5s"), 500);
  for (const printTimeout of ["0s", "-1s", "Infinity", "1e9h", "999999999999999h", "30"]) {
    assert.throws(() => resolveAntigravityPluginConfig({ printTimeout }));
  }
});

test("discovery and execution preserve cwd, prepared environment, project and exact ID; large prompt is stdin only", async () => {
  const mock = await fixture();
  const prior = process.env.AGY_TEST_SCRUB;
  process.env.AGY_TEST_SCRUB = "ambient-test-secret";
  try {
    const prompt = 'large " task\n🚀'.repeat(18_000);
    const result = await runAntigravityAttempt({ hostContracts: sourceHostContracts(), attempt: attempt(mock.root, { prompt }), pluginConfig: resolveAntigravityPluginConfig({ command: mock.command, project: "task-project" }), sessionBindings: bindings() });
    assert.equal(result.terminal.kind, "ok", result.assistantTexts?.join("\n"));
    const calls = (await readFile(mock.calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.length, 4);
    for (const call of calls) { assert.equal(call.cwd, mock.root); assert.equal(call.prepared, "prepared"); assert.equal(call.scrub, ""); assert.ok(!call.args.includes(prompt)); }
    const runtime = calls[3].args;
    assert.equal(runtime[runtime.indexOf("--model") + 1], model);
    assert.equal(runtime[runtime.indexOf("--project") + 1], "task-project");
    assert.equal(runtime.includes("--effort"), false);
    const input = await readFile(mock.prompt, "utf8");
    assert.equal(input.split("\n").length, 2);
    assert.equal(JSON.parse(input).message.content === prompt, true, "single stdin frame must retain every prompt character");
    assert.equal(result.currentAttemptReplayMetadata?.replaySafe, false);
  } finally { if (prior === undefined) delete process.env.AGY_TEST_SCRUB; else process.env.AGY_TEST_SCRUB = prior; await mock.cleanup(); }
});

test("cancel during scoped discovery prevents inference and prompt submission", async () => {
  const mock = await fixture("slow-discovery");
  try {
    const controller = new AbortController();
    let notified = 0;
    const pending = runAntigravityAttempt({ hostContracts: sourceHostContracts(), attempt: attempt(mock.root, { abortSignal: controller.signal, onAttemptAbort() { notified++; } }), pluginConfig: resolveAntigravityPluginConfig({ command: mock.command }), sessionBindings: bindings() });
    await waitFor(mock.discovery); controller.abort();
    const result = await pending;
    assert.equal(await exists(mock.effect), false); assert.equal(await exists(mock.prompt), false);
    assert.equal(result.antigravityEvidence.invocation, "not_started");
    assert.equal(result.currentAttemptReplayMetadata?.replaySafe, true);
    assert.equal(result.terminal.kind, "aborted");
    assert.equal(notified, 1);
  } finally { await mock.cleanup(); }
});

test("inventory deadline retains timeout attribution and notification without inference", async () => {
  const mock = await fixture("slow-discovery");
  try {
    let notified = 0;
    const result = await runAntigravityAttempt({ hostContracts: sourceHostContracts(),
      attempt: attempt(mock.root, { timeoutMs: 1500, onAttemptTimeout() { notified++; } }),
      pluginConfig: resolveAntigravityPluginConfig({ command: mock.command }), sessionBindings: bindings() });
    assert.equal(await exists(mock.discovery), true);
    assert.equal(await exists(mock.effect), false);
    assert.equal(await exists(mock.prompt), false);
    assert.equal(result.antigravityEvidence.invocation, "not_started");
    assert.equal(result.terminal.kind, "timeout");
    assert.equal(notified, 1);
    assert.equal(result.currentAttemptReplayMetadata?.replaySafe, true);
  } finally { await mock.cleanup(); }
});

test("marker effect before corrupt telemetry is unsafe with zero parsed tool events", async () => {
  const mock = await fixture("effect-malformed");
  try {
    const result = await runAntigravityAttempt({ hostContracts: sourceHostContracts(), attempt: attempt(mock.root), pluginConfig: resolveAntigravityPluginConfig({ command: mock.command }), sessionBindings: bindings() });
    assert.equal(await readFile(mock.effect, "utf8"), "native side effect");
    assert.equal(result.terminal.kind, "failed"); assert.equal(result.toolMetas?.length, 0);
    assert.notEqual(result.antigravityEvidence.invocation, "not_started");
    assert.equal(result.antigravityEvidence.effects, "unknown");
    assert.equal(result.currentAttemptReplayMetadata?.replaySafe, false);
  } finally { await mock.cleanup(); }
});

test("wrong model acknowledgement cannot bind a native conversation", async () => {
  const mock = await fixture("wrong-model"); let writes = 0;
  try {
    const result = await runAntigravityAttempt({ hostContracts: sourceHostContracts(), attempt: attempt(mock.root), pluginConfig: resolveAntigravityPluginConfig({ command: mock.command }), sessionBindings: bindings(async () => { writes++; }) });
    assert.equal(await exists(mock.effect), true); assert.equal(writes, 0);
    assert.equal(result.antigravityEvidence.nativeIdentityVerified, false);
    assert.equal(result.currentAttemptReplayMetadata?.replaySafe, false);
    assert.equal(result.terminal.kind, "failed");
  } finally { await mock.cleanup(); }
});

test("ordinary execution returns final text without granting unfenced preview mutation authority", async () => {
  const mock = await fixture("fragments");
  const before = join(mock.root, "callback-before");
  const after = join(mock.root, "callback-after");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  // Deliberately uncooperative: it never checks a signal or callback context.
  // Its actual sink mutates both before and after an asynchronous suspension.
  const onPartialReply = async () => {
    await writeFile(before, "delivered");
    await gate;
    await writeFile(after, "late mutation");
  };
  try {
    const result = await runAntigravityAttempt({ hostContracts: sourceHostContracts(), attempt: attempt(mock.root, { onPartialReply }), pluginConfig: resolveAntigravityPluginConfig({ command: mock.command }), sessionBindings: bindings() });
    assert.equal(result.terminal.kind, "ok", result.assistantTexts?.join("\n"));
    assert.deepEqual(result.assistantTexts, ["alpha beta gamma"]);
    assert.equal(result.antigravityEvidence.invocation, "started");
    assert.equal(result.antigravityEvidence.deliveredOutput, false);
    assert.equal(result.currentAttemptReplayMetadata?.replaySafe, false);
    assert.equal(await exists(mock.calls), true);
    assert.equal(await readFile(mock.effect, "utf8"), "native side effect");
    assert.equal(await exists(before), false);
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(await exists(after), false, "no host sink can resume after settlement");
    // Positive control proves the same unguarded callback really can mutate.
    await onPartialReply();
    assert.equal(await readFile(before, "utf8"), "delivered");
    assert.equal(await readFile(after, "utf8"), "late mutation");
  } finally { release(); await mock.cleanup(); }
});

test("with the ordinary host callback, ACTIVE and DONE fragments reconcile once in the final response", async () => {
  const mock = await fixture("fragments");
  try {
    const result = await runAntigravityAttempt({ hostContracts: sourceHostContracts(), attempt: attempt(mock.root), pluginConfig: resolveAntigravityPluginConfig({ command: mock.command }), sessionBindings: bindings() });
    assert.deepEqual(result.assistantTexts, ["alpha beta gamma"]);
    assert.equal(result.antigravityEvidence.outputObserved, true);
    assert.equal(result.antigravityEvidence.deliveredOutput, false);
  } finally { await mock.cleanup(); }
});

test("partial output survives malformed telemetry without completed success", async () => {
  const mock = await fixture("partial-malformed");
  try {
    const result = await runAntigravityAttempt({ hostContracts: sourceHostContracts(), attempt: attempt(mock.root), pluginConfig: resolveAntigravityPluginConfig({ command: mock.command }), sessionBindings: bindings() });
    assert.deepEqual(result.assistantTexts, ["alpha beta gamma", result.antigravityOutcome.explanation]);
    assert.equal(result.antigravityOutcome.kind, "partial");
    assert.match(result.antigravityOutcome.explanation!, /ANTIGRAVITY:.*(?:Partial|Timeout).*partial/su);
    assert.equal(result.currentAttemptCompletedAssistant, undefined);
    assert.equal(result.terminal.kind, "failed");
  } finally { await mock.cleanup(); }
});

test("native timeout warning survives exit zero and SUCCESS without completed success", async () => {
  const mock = await fixture("native-timeout");
  try {
    const result = await runAntigravityAttempt({ hostContracts: sourceHostContracts(), attempt: attempt(mock.root), pluginConfig: resolveAntigravityPluginConfig({ command: mock.command }), sessionBindings: bindings() });
    assert.equal(result.antigravityEvidence.terminal.nativeStatus, "SUCCESS");
    assert.equal(result.antigravityEvidence.terminal.nativeTimeout, true);
    assert.notEqual(result.terminal.kind, "ok");
    assert.deepEqual(result.assistantTexts, ["done", result.antigravityOutcome.explanation]);
    assert.equal(result.antigravityOutcome.kind, "timeout");
    assert.match(result.antigravityOutcome.explanation!, /ANTIGRAVITY:.*(?:Partial|Timeout).*partial/su);
    assert.equal(result.currentAttemptCompletedAssistant, undefined);
  } finally { await mock.cleanup(); }
});

test("native aggregate counters never enter the host per-call token reporter", async () => {
  const mock = await fixture();
  try {
    const request = attempt(mock.root);
    let reports = 0;
    const hostCapabilities = { ...request.hostCapabilities, reportOutputTokens() { reports++; } };
    const result = await runAntigravityAttempt({ hostContracts: sourceHostContracts(), attempt: { ...request, hostCapabilities }, pluginConfig: resolveAntigravityPluginConfig({ command: mock.command }), sessionBindings: bindings() });
    assert.equal(reports, 0);
    assert.equal(result.terminal.kind, "ok", result.assistantTexts?.join("\n"));
    assert.equal(result.antigravityEvidence.accounting.scope, "unknown");
    assert.equal(result.antigravityEvidence.accounting.raw?.output_tokens, 1);
    assert.deepEqual(result.assistantTexts, ["done"]);
    assert.equal(result.antigravityEvidence.terminal.nativeStatus, "SUCCESS");
    assert.equal(result.currentAttemptReplayMetadata?.replaySafe, false);
    assert.deepEqual(result.attemptUsage, { contextUsage: { state: "unavailable" } });
    assert.equal(result.currentAttemptCompletedAssistant?.provider, "antigravity");
    assert.equal(result.currentAttemptCompletedAssistant?.model, "new-opaque-model/effort.v7");
    assert.deepEqual(result.currentAttemptCompletedAssistant?.usage, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  } finally { await mock.cleanup(); }
});

test("throwing timeout notification cannot skip returned evidence or bounded cleanup", async () => {
  const mock = await fixture("native-timeout");
  try {
    const result = await runAntigravityAttempt({ hostContracts: sourceHostContracts(), attempt: attempt(mock.root, { onAttemptTimeout() { throw new Error("notification failed"); } }), pluginConfig: resolveAntigravityPluginConfig({ command: mock.command }), sessionBindings: bindings() });
    assert.equal(result.antigravityEvidence.terminal.nativeTimeout, true);
    assert.equal(result.antigravityEvidence.termination.cleanupComplete, true);
    assert.deepEqual(result.assistantTexts, ["done", result.antigravityOutcome.explanation]);
    assert.equal(result.antigravityOutcome.kind, "timeout");
    assert.match(result.antigravityOutcome.explanation!, /ANTIGRAVITY:.*(?:Partial|Timeout).*partial/su);
  } finally { await mock.cleanup(); }
});

test("a delayed host update checks the retired callback before mutating session state", async () => {
  const mock = await fixture("slow-init");
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  let lateError: unknown; let writes = 0;
  let entry: { sessionId: string; lifecycleRevision: string; pluginExtensions?: Record<string, Record<string, unknown>> } = {
    sessionId: "host-session", lifecycleRevision: "SIMULATED:lifecycle-v1",
  };
  const runtime = {
    getSessionEntry() { return structuredClone(entry); }, listSessionEntries() { return []; },
    async patchSessionEntry({ update, assertCommitAllowed }: {
      update: (value: typeof entry) => Partial<typeof entry> | null;
      assertCommitAllowed?: () => void;
    }) {
      const patch = update(structuredClone(entry));
      const bindingCommit = Boolean(patch?.pluginExtensions?.antigravity?.binding);
      if (bindingCommit) { entered(); await gate; }
      try {
        assertCommitAllowed?.();
        if (patch) { entry = { ...entry, ...patch }; if (bindingCommit) writes++; }
        return structuredClone(entry);
      } catch (error) { lateError = error; throw error; }
    },
  } as unknown as AntigravitySessionRuntime;
  try {
    const pending = runAntigravityAttempt({ hostContracts: sourceHostContracts(), attempt: attempt(mock.root, { timeoutMs: 1_000 }), pluginConfig: resolveAntigravityPluginConfig({ command: mock.command }), sessionBindings: new AntigravitySessionBindings(runtime, { atomicMutation: sourceSessionMutation }) });
    await started;
    const result = await pending;
    assert.notEqual(result.terminal.kind, "ok"); assert.equal(writes, 0);
    release(); await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(writes, 0); assert.ok(lateError instanceof Error);
    assert.equal(result.currentAttemptReplayMetadata?.replaySafe, false);
  } finally { release(); await mock.cleanup(); }
});
