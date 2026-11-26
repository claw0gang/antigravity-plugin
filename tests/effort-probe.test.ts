import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createInvocationScope } from "../src/cli/invocation-scope.ts";
import { AGY_EFFORT_FLAGS, buildAgyEffortProbeArgs, resolveAgyEffortAttempt } from "../src/harness/effort-probe.ts";
import { buildAgyHarnessFreshArgs, buildAgyHarnessResumeArgs } from "../src/cli/args.ts";
import { resolveAntigravityPluginConfig } from "../src/config.ts";
import { parseAgyEffortOutput, parseAgySelectedModelOutput } from "../src/harness/model-capabilities.ts";

type Capture = { case: string; requestedModel: string; command: string; effortFlag: string | null;
  exitCode: number; status: string; emptyConversationId: boolean; turns: number;
  usage: Record<string, number>; report?: Record<string, unknown>; diagnostic?: string };
const captures = JSON.parse(readFileSync(new URL("./fixtures/agy/1.5.17/effort-probes.json", import.meta.url), "utf8")).probes as Capture[];
const capture = (name: string) => {
  const found = captures.find(row => row.case === name);
  assert.ok(found, name);
  return found;
};
const high = capture("model-default");
const low = capture("model-matching-low");
const models = [high, low].map(row => ({ id: row.requestedModel, name: String(row.report!.label) }));
const config = resolveAntigravityPluginConfig({ command: process.execPath });
function stdout(row: Capture) {
  // Pi retains structured observations, not raw stdout bytes. Reconstruct only
  // the observed fields; explicit control responses below are simulated.
  return JSON.stringify({
    conversation_id: row.emptyConversationId ? "" : "unexpected",
    status: row.status, num_turns: row.turns, usage: row.usage,
    ...(row.report ? { command: { name: row.command.slice(1), data: row.report } } : {}),
    ...(row.diagnostic ? { error: row.diagnostic } : {}),
    ...(row.command === "/model" && row.report ? { response: row.report.id + "\t" + row.report.label + "\n" } : {}),
  });
}
function setup(rows: readonly Capture[]) {
  const calls: Array<{ command: string; model: string; effort: string | null }> = [];
  const scope = createInvocationScope({ command: process.execPath, timeoutMs: 10_000, purpose: "inventory" });
  const preflight = { version: "1.5.17", advertisedFlags: AGY_EFFORT_FLAGS,
    transport: "single-user-line-stdin-eof" as const, semanticQualification: "not_executed" as const };
  const execute = async ({ args }: { args: readonly string[] }) => {
    const call = { command: args[args.indexOf("--print") + 1]!, model: args[args.indexOf("--model") + 1]!,
      effort: args.includes("--effort") ? args[args.indexOf("--effort") + 1]! : null };
    const row = rows[calls.length];
    calls.push(call);
    assert.ok(row, "unexpected additional native probe");
    assert.deepEqual(call, { command: row.command, model: row.requestedModel, effort: row.effortFlag });
    assert.equal(args.includes("--conversation") || args.includes("--continue") || args.includes("--new-project"), false);
    // The exact read-only executor result shape is simulated; no subprocess or inference.
    return { exitCode: row.exitCode, stdout: stdout(row), stderr: "", evidence: {} as never };
  };
  return { scope, preflight, execute, calls };
}
const request = (f: ReturnType<typeof setup>) => ({
  ...f, modelId: high.requestedModel, liveModels: models, thinkLevel: "low" as const,
});
// These two model-only low observations were not executed by Pi. Supply
// explicitly simulated controls derived from its matching low /model record
// and high effort capability. The final matching low response is recorded.
const lowModelOnly = { ...low, effortFlag: null };
const lowEffortOnly = { ...capture("adjustable"), requestedModel: low.requestedModel,
  report: { ...capture("adjustable").report, current: "low" } };
const lowSequence = [capture("adjustable"), high, lowModelOnly, lowEffortOnly, low];

test("replay recorded 1.5.17 metadata: high-to-low uses model-only discovery and a matching low pair", async () => {
  const f = setup(lowSequence);
  const resolved = await resolveAgyEffortAttempt(request(f));
  assert.equal(resolved.modelId, low.requestedModel);
  assert.equal(resolved.selectedEffort?.effort, "low");
  assert.equal(f.calls.length, 5);
  assert.deepEqual(f.calls.filter(call => call.effort !== null), [{ command: "/model", model: low.requestedModel, effort: "low" }]);
  const argv = { config, modelId: resolved.modelId, prompt: "fixture", effort: resolved.selectedEffort! };
  for (const args of [buildAgyHarnessFreshArgs(argv), buildAgyHarnessResumeArgs({ ...argv, conversationId: "exact-conversation" })]) {
    assert.equal(args[args.indexOf("--model") + 1], low.requestedModel);
    assert.equal(args[args.indexOf("--effort") + 1], "low");
  }
  assert.throws(() => buildAgyEffortProbeArgs(f.scope, high.requestedModel, "model", resolved.selectedEffort!), /effective-model-unverified/);
});

test("recorded matching high SUCCESS with exit 2 is not accepted", async () => {
  const f = setup([capture("adjustable"), high, capture("model-matching-high")]);
  await assert.rejects(resolveAgyEffortAttempt({ ...request(f), thinkLevel: "high" }), /probe-unavailable/);
  assert.equal(f.calls.length, 3);
});

test("recorded conflicting model and effort failures are not usable metadata", () => {
  for (const name of ["model-low", "effort-low"]) {
    const row = capture(name);
    assert.equal(row.exitCode, 1);
    assert.throws(() => row.command === "/model"
      ? parseAgySelectedModelOutput(stdout(row), models, high.requestedModel)
      : parseAgyEffortOutput(stdout(row)), /unverified-report/);
  }
});

test("recorded fixed and limited models refuse unsupported effective overrides", async () => {
  for (const name of ["fixed", "limited"]) {
    const row = capture(name);
    const f = setup([row]);
    await assert.rejects(resolveAgyEffortAttempt({ ...request(f), modelId: row.requestedModel,
      liveModels: [{ id: row.requestedModel, name: "fixture" }], thinkLevel: "xhigh" }),
      name === "fixed" ? /fixed-or-unobserved/ : /unsupported-level/);
    assert.equal(f.calls.length, 1);
  }
  const f = setup([]);
  const resolved = await resolveAgyEffortAttempt({ ...request(f), thinkLevel: "off" });
  assert.equal(resolved.modelId, high.requestedModel);
  assert.equal(resolved.selectedEffort, undefined);
  assert.equal(f.calls.length, 0);
});

test("resume rejects a different effective variant before a paired probe; same bound variant is retained", async () => {
  const blocked = setup([capture("adjustable"), high]);
  await assert.rejects(resolveAgyEffortAttempt({ ...request(blocked), boundModelId: high.requestedModel }), /resume-variant-change/);
  assert.equal(blocked.calls.length, 2);
  const allowed = setup(lowSequence);
  assert.equal((await resolveAgyEffortAttempt({ ...request(allowed), boundModelId: low.requestedModel })).modelId, low.requestedModel);
});

test("native metadata must corroborate the candidate; no paired probe on mismatch, ambiguity or withdrawal", async () => {
  const mismatched = setup([capture("adjustable"), high, { ...lowModelOnly, report: { ...low.report, effort: "high" } }, lowEffortOnly]);
  await assert.rejects(resolveAgyEffortAttempt(request(mismatched)), /effective-model-unverified/);
  assert.ok(mismatched.calls.every(call => call.effort === null));
  const differentCapabilities = setup([capture("adjustable"), high, lowModelOnly,
    { ...lowEffortOnly, report: { adjustable: true, current: "low", available: ["low", "high"] } }]);
  await assert.rejects(resolveAgyEffortAttempt(request(differentCapabilities)), /effective-model-unverified/);
  for (const liveModels of [models.slice(0, 1), [...models, { id: "ambiguous", name: models[1]!.name }]]) {
    const f = setup([capture("adjustable"), high]);
    await assert.rejects(resolveAgyEffortAttempt({ ...request(f), liveModels }), /effective-model-unverified/);
    assert.equal(f.calls.length, 2);
  }
});

test("owner cancellation between metadata reads prevents subsequent probes", async () => {
  const f = setup([capture("adjustable")]);
  const controller = new AbortController();
  const scope = createInvocationScope({ command: process.execPath, signal: controller.signal, timeoutMs: 10_000 });
  await assert.rejects(resolveAgyEffortAttempt({ ...request(f), scope, execute: async args => {
    const result = await f.execute(args);
    controller.abort();
    return result;
  } }), /aborted/);
  assert.equal(f.calls.length, 1);
});
