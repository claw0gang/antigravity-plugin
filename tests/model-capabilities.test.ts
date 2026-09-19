import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAgyResumeModelConsistency,
  deriveAgyNativeModelCapabilities,
  resolveAgyAttemptModel,
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
    assert.equal(low.selectedEffort, "low");
    assert.equal(low.adjustableReasoning, false);

    const high = resolveAgyAttemptModel({
      modelId: "gemini-3.8-flash-high",
      thinkLevel,
      liveModels,
    });
    assert.equal(high.modelId, "gemini-3.8-flash-high");
    assert.equal(high.selectedEffort, "high");
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
