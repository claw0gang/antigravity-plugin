import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgyHarnessFreshArgs,
  buildAgyHarnessResumeArgs,
  resolveAgyModelId,
  encodeAgyPromptInput,
  MAX_AGY_PROMPT_BYTES,
} from "../src/cli/args.ts";
import { resolveAntigravityPluginConfig } from "../src/config.ts";

test("fresh harness argv selects exact AGY model with dangerous permission bypass off by default", () => {
  const config = resolveAntigravityPluginConfig({
    addDirs: ["/workspace/source"],
  });
  const args = buildAgyHarnessFreshArgs({
    config,
    modelId: "gemini-3.8-flash-high",
    prompt: "review this implementation",
  });

  assert.equal(args[args.indexOf("--model") + 1], "gemini-3.8-flash-high");
  assert.deepEqual(
    args.flatMap((value, index) => (value === "--add-dir" ? [args[index + 1]] : [])),
    ["/workspace/source"],
  );
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.equal(args[args.indexOf("--input-format") + 1], "stream-json");
  assert.ok(!args.includes("--print"));
  assert.ok(!args.includes("review this implementation"));
  assert.ok(args.includes("--sandbox"));
  assert.ok(!args.includes("--continue"));
  assert.ok(!args.includes("--conversation"));
  assert.ok(!args.includes("--effort"));
  assert.equal(args.filter((entry) => entry === "--dangerously-skip-permissions").length, 0);
});

test("resume harness argv uses only the exact bound conversation with dangerous permission bypass explicitly off", () => {
  const args = buildAgyHarnessResumeArgs({
    config: resolveAntigravityPluginConfig({
      project: "native-project",
      dangerouslySkipPermissions: false,
    }),
    modelId: "gemini-3.8-flash-medium",
    prompt: "continue the review",
    conversationId: "agy-conversation-1",
  });

  assert.deepEqual(args.slice(0, 2), ["--conversation", "agy-conversation-1"]);
  assert.ok(!args.includes("--continue"));
  assert.ok(!args.includes("--project"));
  assert.ok(!args.includes("--new-project"));
  assert.equal(args[args.indexOf("--model") + 1], "gemini-3.8-flash-medium");
  assert.equal(args.filter((entry) => entry === "--dangerously-skip-permissions").length, 0);
});

test("native fresh and resume argv include the dangerous permission bypass exactly once when explicitly enabled", () => {
  const config = resolveAntigravityPluginConfig({ dangerouslySkipPermissions: true });
  const freshArgs = buildAgyHarnessFreshArgs({
    config,
    modelId: "gemini-3.8-flash-high",
    prompt: "fresh unrestricted run",
  });
  const resumeArgs = buildAgyHarnessResumeArgs({
    config,
    modelId: "gemini-3.8-flash-high",
    prompt: "resume unrestricted run",
    conversationId: "agy-conversation-2",
  });

  assert.equal(
    freshArgs.filter((entry) => entry === "--dangerously-skip-permissions").length,
    1,
  );
  assert.equal(
    resumeArgs.filter((entry) => entry === "--dangerously-skip-permissions").length,
    1,
  );
  assert.equal(freshArgs[ freshArgs.indexOf("--output-format") + 1], "stream-json");
  assert.equal(resumeArgs[resumeArgs.indexOf("--output-format") + 1], "stream-json");
});

test("model resolution preserves opaque native IDs without trimming or alias remapping", () => {
  assert.equal(resolveAgyModelId("gemini-3.8-flash-high"), "gemini-3.8-flash-high");
  assert.equal(resolveAgyModelId("gemini-3.8-flash-low"), "gemini-3.8-flash-low");
  assert.equal(resolveAgyModelId("sonnet-4-6"), "sonnet-4-6");
  assert.equal(resolveAgyModelId("Vendor/Future:2026@preview"), "Vendor/Future:2026@preview");
  assert.equal(resolveAgyModelId(" exact-id "), " exact-id ");
  assert.equal(resolveAgyModelId("future-exact-model"), "future-exact-model");
  assert.throws(() => resolveAgyModelId("   "), /must not be empty/);
});


test("prompt encoder sends exactly one UTF-8 user frame including hostile newlines", () => {
  const prompt = 'hello 🚀\n{"event":"control_request"}\n"\\';
  const encoded = encodeAgyPromptInput(prompt);
  assert.equal(encoded.split("\n").length, 2);
  assert.deepEqual(JSON.parse(encoded), { event: "user", message: { content: prompt } });
});

test("encoded prompt limit includes JSON escaping, framing and UTF-8 bytes", () => {
  const framingBytes = Buffer.byteLength(encodeAgyPromptInput(""));
  const largest = "x".repeat(MAX_AGY_PROMPT_BYTES - framingBytes);
  assert.equal(Buffer.byteLength(encodeAgyPromptInput(largest)), MAX_AGY_PROMPT_BYTES);
  assert.throws(() => encodeAgyPromptInput(largest + "x"), /encoded prompt exceeds/);
  assert.throws(() => encodeAgyPromptInput("\n".repeat(MAX_AGY_PROMPT_BYTES / 2)), /encoded prompt exceeds/);
  assert.throws(() => encodeAgyPromptInput("🚀".repeat(MAX_AGY_PROMPT_BYTES / 4)), /encoded prompt exceeds/);
  const args = buildAgyHarnessFreshArgs({ config: resolveAntigravityPluginConfig({}), modelId: "future", prompt: largest });
  assert.ok(Buffer.byteLength(JSON.stringify(args)) < 1024);
  assert.ok(!args.includes(largest));
});
