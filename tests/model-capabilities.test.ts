import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAgyResumeModelConsistency,
  deriveAgyNativeModelCapabilities,
  resolveAgyAttemptModel,
  parseAgyEffortOutput, parseAgySelectedModelOutput, resolveAgyThinkingProfile, resolveAgyEffortSelection,
} from "../src/harness/model-capabilities.ts";

const liveModels = [
  { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
  { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
  { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 Thinking" },
  { id: "gpt-oss-120b-medium", name: "GPT OSS 120B Medium" },
];

test("native AGY models do not advertise host-adjustable reasoning controls", () => {
  for (const model of liveModels) {
    assert.deepEqual(deriveAgyNativeModelCapabilities(model.id, liveModels), {
      adjustableReasoning: false,
      reasoning: false,
    });
  }
});

test("explicit effort-qualified Gemini model ids remain exact across OpenClaw think levels", () => {
  for (const thinkLevel of ["minimal", "low", "medium", "high", "xhigh", "adaptive", "max", "ultra"] as const) {
    const low = resolveAgyAttemptModel({
      modelId: "gemini-3.8-flash-low",
      thinkLevel,
      liveModels,
    });
    assert.equal(low.modelId, "gemini-3.8-flash-low");
    assert.equal(low.selectedEffort, undefined);
    assert.equal(low.adjustableReasoning, false);

    const high = resolveAgyAttemptModel({
      modelId: "gemini-3.8-flash-high",
      thinkLevel,
      liveModels,
    });
    assert.equal(high.modelId, "gemini-3.8-flash-high");
    assert.equal(high.selectedEffort, undefined);
  }
});

test("sparse Gemini effort families remain exact rather than clamping to siblings", () => {
  const sparseFamily = [
    { id: "gemini-sparse-medium", name: "Sparse Medium" },
    { id: "gemini-sparse-high", name: "Sparse High" },
  ];
  assert.equal(
    resolveAgyAttemptModel({
      modelId: "gemini-sparse-high",
      thinkLevel: "low",
      liveModels: sparseFamily,
    }).modelId,
    "gemini-sparse-high",
  );
  assert.equal(
    resolveAgyAttemptModel({
      modelId: "gemini-sparse-medium",
      thinkLevel: "max",
      liveModels: sparseFamily,
    }).modelId,
    "gemini-sparse-medium",
  );
});

test("non-Gemini model ids also remain exact regardless of unrelated host think defaults", () => {
  for (const modelId of [
    "claude-sonnet-4-6",
    "claude-opus-4-6-thinking",
    "gpt-oss-120b-medium",
  ]) {
    for (const thinkLevel of ["off", "medium", "high"] as const) {
      const resolved = resolveAgyAttemptModel({ modelId, thinkLevel, liveModels });
      assert.equal(resolved.modelId, modelId);
      assert.equal(resolved.adjustableReasoning, false);
      assert.equal(resolved.selectedEffort, undefined);
    }
  }
});

test("attempt resolution remains strictly bound to the current live inventory", () => {
  assert.throws(
    () =>
      resolveAgyAttemptModel({
        modelId: "gemini-9.9-does-not-exist-high",
        thinkLevel: "high",
        liveModels,
      }),
    /no longer advertises/,
  );
});

test("resume requires the same concrete AGY model that owns the bound conversation", () => {
  assert.doesNotThrow(() =>
    assertAgyResumeModelConsistency({
      boundModelId: "gemini-3.8-flash-low",
      resolvedModelId: "gemini-3.8-flash-low",
      conversationId: "conversation-1",
    }),
  );
  assert.throws(
    () =>
      assertAgyResumeModelConsistency({
        boundModelId: "gemini-3.8-flash-medium",
        resolvedModelId: "gemini-3.8-flash-low",
        conversationId: "conversation-1",
      }),
    /bound to model gemini-3\.8-flash-medium, not gemini-3\.8-flash-low/,
  );
  assert.throws(
    () =>
      assertAgyResumeModelConsistency({
        resolvedModelId: "gemini-3.8-flash-low",
        conversationId: "legacy-conversation",
      }),
    /no canonical bound model id/,
  );
});

function nativeReport(name: string, data: unknown, response = "", extra: Record<string, unknown> = {}) {
  return JSON.stringify({ status: "SUCCESS", conversation_id: "", num_turns: 0,
    usage: { total_tokens: 0 }, command: { name, data }, response, ...extra });
}

test("AGY effort capability is zero-turn model metadata, never inferred from suffixes", () => {
  const observation = parseAgyEffortOutput(nativeReport("effort", { adjustable: true, current: "high", available: ["low", "high", "xhigh"] }));
  assert.deepEqual(observation, { adjustable: true, current: "high", available: ["low", "high", "xhigh"] });
  assert.deepEqual(parseAgyEffortOutput(nativeReport("effort", { adjustable: false })), { adjustable: false });
  for (const report of [
    nativeReport("effort", { adjustable: true, current: "high", available: ["low"] }),
    nativeReport("effort", { adjustable: true, current: "high", available: ["high", "turbo"] }),
    nativeReport("effort", { adjustable: true, current: "high", available: ["high", "high"] }),
    nativeReport("effort", { adjustable: true, current: "high", available: ["high"] }, "", { num_turns: 1 }),
    nativeReport("effort", { adjustable: true, current: "high", available: ["high"] }, "", { usage: { total_tokens: 1 } }),
  ]) assert.throws(() => parseAgyEffortOutput(report), /unverified-report/);
  const modelId = "opaque";
  const profile = resolveAgyThinkingProfile({ provider: "antigravity", modelId, params: { antigravityEffort: { modelId, observation } } });
  assert.equal(profile?.defaultLevel, "off");
  assert.deepEqual(profile?.levels.map(level => level.id), ["off", "low", "high", "xhigh"]);
  assert.deepEqual(resolveAgyThinkingProfile({ provider: "antigravity", modelId: "other", params: { antigravityEffort: { modelId, observation } } })?.levels.map(level => level.id), ["off"]);
});

test("structured native model identity and exact TSV must agree with the selected live row", () => {
  const rows = [{ id: "opaque-a", name: "Alpha (Low)" }, { id: "opaque-b", name: "Alpha (High)" }];
  const model = { id: "opaque-b", label: "Alpha (High)", effort: "high", is_default: false };
  const response = "opaque-b\tAlpha (High)\n";
  assert.deepEqual(parseAgySelectedModelOutput(nativeReport("model", model, response), rows, "opaque-b"), model);
  for (const [data, text] of [
    [{}, response],
    [model, "opaque-b"],
    [model, "Alpha (High)"],
    [model, "opaque-a\tAlpha (Low)\n"],
    [{ ...model, effort: "turbo" }, response],
    [{ ...model, label: "Beta (High)" }, "opaque-b\tBeta (High)\n"],
  ] as const) {
    assert.throws(() => parseAgySelectedModelOutput(nativeReport("model", data, text), rows, "opaque-b"), /effective-model-unverified/);
  }
  assert.throws(() => parseAgySelectedModelOutput(nativeReport("model", model, response), rows, "opaque-a"), /effective-model-unverified/);
});

test("verified effort resolves opaque IDs from corroborated native labels and preserves exact resume identity", () => {
  const rows = [{ id: "opaque-a", name: "Alpha (Low)" }, { id: "opaque-b", name: "Alpha (High)" }];
  const observation = parseAgyEffortOutput(nativeReport("effort", { adjustable: true, current: "low", available: ["low", "high"] }));
  const effectiveObservation = parseAgyEffortOutput(nativeReport("effort", { adjustable: true, current: "high", available: ["low", "high"] }));
  const requestedModel = parseAgySelectedModelOutput(nativeReport("model",
    { id: "opaque-a", label: "Alpha (Low)", effort: "low", is_default: false }, "opaque-a\tAlpha (Low)\n"), rows, "opaque-a");
  const effectiveModel = parseAgySelectedModelOutput(nativeReport("model",
    { id: "opaque-b", label: "Alpha (High)", effort: "high", is_default: false }, "opaque-b\tAlpha (High)\n"), rows, "opaque-b");
  const request = { modelId: "opaque-a", thinkLevel: "high" as const, liveModels: rows, observation, requestedModel };
  assert.throws(() => resolveAgyEffortSelection(request), /effective-model-unverified/);
  const proven = { ...request, effectiveModel, effectiveObservation };
  assert.equal(resolveAgyEffortSelection(proven).modelId, "opaque-b");
  assert.equal(resolveAgyEffortSelection({ ...proven, boundModelId: "opaque-b" }).selectedEffort?.effort, "high");
  assert.throws(() => resolveAgyEffortSelection({ ...proven, boundModelId: "opaque-a" }), /resume-variant-change/);
  assert.equal(resolveAgyEffortSelection({ ...request, thinkLevel: "off" }).selectedEffort, undefined);
  assert.equal(resolveAgyEffortSelection({ ...request, thinkLevel: "low" }).selectedEffort?.effort, "low");
  for (const thinkLevel of ["minimal", "medium", "adaptive", "ultra", "max", "xhigh"] as const) {
    assert.throws(() => resolveAgyEffortSelection({ ...request, thinkLevel }), /unsupported-level/);
  }
  assert.throws(() => resolveAgyEffortSelection({ ...request, observation: { adjustable: false } }), /fixed-or-unobserved/);
  assert.throws(() => resolveAgyEffortSelection({ ...proven, liveModels: [...rows, { id: "ambiguous", name: "Alpha (High)" }] }), /effective-model-unverified/);
  assert.throws(() => resolveAgyEffortSelection({ ...proven, effectiveObservation: { adjustable: true, current: "high", available: ["high"] } }), /effective-model-unverified/);
  assert.throws(() => resolveAgyEffortSelection({ ...proven, effectiveModel: { ...effectiveModel, effort: "low" } }), /effective-model-unverified/);
  // A matching slug suffix cannot authorize crossing a differently named family.
  assert.throws(() => resolveAgyEffortSelection({ ...proven, liveModels: [rows[0]!, { id: "opaque-b", name: "Beta (High)" }] }), /effective-model-unverified/);
});
