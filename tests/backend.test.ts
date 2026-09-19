import assert from "node:assert/strict";
import test from "node:test";

import {
  ANTIGRAVITY_CLI_BACKEND_ID,
  ANTIGRAVITY_CLI_DEFAULT_MODEL_REF,
  ANTIGRAVITY_HARNESS_ID,
  buildAntigravityCliBackend,
  buildFreshArgs,
  buildResumeArgs,
} from "../src/backend.ts";
import { resolveAntigravityPluginConfig } from "../src/config.ts";
import {
  ANTIGRAVITY_CONFIRMED_MODEL_IDS,
  ANTIGRAVITY_MODEL_ALIASES,
} from "../src/model-aliases.ts";

test("runtime identities are disjoint", () => {
  assert.equal(ANTIGRAVITY_HARNESS_ID, "antigravity");
  assert.equal(ANTIGRAVITY_CLI_BACKEND_ID, "antigravity-cli");
  assert.notEqual(ANTIGRAVITY_HARNESS_ID, ANTIGRAVITY_CLI_BACKEND_ID);
  assert.equal(
    ANTIGRAVITY_CLI_DEFAULT_MODEL_REF,
    "antigravity-cli/gemini-3.8-flash-high",
  );
});

test("default plugin config invokes agy only through the compatibility backend", () => {
  const config = resolveAntigravityPluginConfig(undefined);
  const backend = buildAntigravityCliBackend(config);

  assert.equal(backend.id, "antigravity-cli");
  assert.equal(backend.config.command, "agy");
  assert.equal(backend.config.input, "arg");
  assert.equal(backend.config.output, "json");
  assert.equal(backend.config.resumeOutput, "json");
  assert.equal(backend.config.sessionMode, "existing");
  assert.deepEqual(backend.config.sessionIdFields, ["conversation_id", "conversationId"]);
});

test("dangerous permission bypass remains default-off and explicit-only", () => {
  assert.equal(resolveAntigravityPluginConfig(undefined).dangerouslySkipPermissions, false);
  assert.equal(
    resolveAntigravityPluginConfig({ dangerouslySkipPermissions: false }).dangerouslySkipPermissions,
    false,
  );
  assert.equal(
    resolveAntigravityPluginConfig({ dangerouslySkipPermissions: true }).dangerouslySkipPermissions,
    true,
  );
});

test("fresh args force native JSON and do not bypass permissions by default", () => {
  const args = buildFreshArgs(resolveAntigravityPluginConfig(undefined));

  assert.deepEqual(args.slice(-6), [
    "--print-timeout",
    "30m",
    "--output-format",
    "json",
    "--print",
    "{prompt}",
  ]);
  assert.ok(args.includes("--sandbox"));
  assert.ok(!args.includes("--dangerously-skip-permissions"));
});

test("resume uses the exact OpenClaw session id without bypassing permissions by default", () => {
  const config = resolveAntigravityPluginConfig({ project: "project-a" });
  const args = buildResumeArgs(config);

  assert.deepEqual(args.slice(0, 2), ["--conversation", "{sessionId}"]);
  assert.ok(!args.includes("--project"));
  assert.ok(!args.includes("--continue"));
  assert.ok(!args.includes("--dangerously-skip-permissions"));
});

test("explicit plugin controls map to agy arguments for fresh and resume compatibility CLI runs", () => {
  const config = resolveAntigravityPluginConfig({
    command: "/home/ubuntu/.local/bin/agy",
    printTimeout: "15m",
    sandbox: false,
    dangerouslySkipPermissions: true,
    mode: "plan",
    agent: "critic",
    newProject: true,
    addDirs: ["/workspace/a", "/workspace/b"],
    logFile: "/home/ubuntu/tmp/antigravity/agy.log",
  });
  const backend = buildAntigravityCliBackend(config);
  const args = backend.config.args ?? [];
  const resumeArgs = backend.config.resumeArgs ?? [];

  assert.equal(backend.config.command, "/home/ubuntu/.local/bin/agy");
  assert.ok(args.includes("--new-project"));
  assert.equal(args.filter((entry) => entry === "--dangerously-skip-permissions").length, 1);
  assert.equal(
    resumeArgs.filter((entry) => entry === "--dangerously-skip-permissions").length,
    1,
  );
  assert.ok(!args.includes("--sandbox"));
  assert.equal(args.filter((entry) => entry === "--add-dir").length, 2);
  assert.equal(args[args.indexOf("--mode") + 1], "plan");
  assert.equal(args[args.indexOf("--agent") + 1], "critic");
});

test("agy model slugs own reasoning effort", () => {
  const backend = buildAntigravityCliBackend(resolveAntigravityPluginConfig(undefined));
  const freshArgs = backend.config.args ?? [];
  const resumeArgs = backend.config.resumeArgs ?? [];

  assert.equal(backend.resolveExecutionArgs, undefined);
  assert.ok(!freshArgs.includes("--effort"));
  assert.ok(!resumeArgs.includes("--effort"));
});

test("Gemini models use exact AGY ids while non-Gemini aliases stay explicit", () => {
  assert.deepEqual(
    Object.keys(ANTIGRAVITY_MODEL_ALIASES).filter((id) => id.startsWith("gemini")),
    [],
  );
  assert.ok(ANTIGRAVITY_CONFIRMED_MODEL_IDS.includes("gemini-3.8-flash-high"));
  assert.ok(ANTIGRAVITY_CONFIRMED_MODEL_IDS.includes("gemini-3.8-flash-medium"));
  assert.ok(ANTIGRAVITY_CONFIRMED_MODEL_IDS.includes("gemini-3.8-flash-low"));
  assert.equal(ANTIGRAVITY_MODEL_ALIASES["sonnet-4-6"], "claude-sonnet-4-6");
  assert.equal(ANTIGRAVITY_MODEL_ALIASES["opus-4-6"], "claude-opus-4-6-thinking");
  assert.equal(ANTIGRAVITY_MODEL_ALIASES["gpt-oss"], "gpt-oss-120b-medium");
  assert.equal(ANTIGRAVITY_CONFIRMED_MODEL_IDS.length, 17);
  for (const id of Object.values(ANTIGRAVITY_MODEL_ALIASES)) {
    assert.ok(ANTIGRAVITY_CONFIRMED_MODEL_IDS.includes(id));
    assert.ok(!id.includes("("));
  }
});

test("configuration fails closed on unknown or contradictory values", () => {
  assert.throws(
    () => resolveAntigravityPluginConfig({ unknown: true }),
    /unknown antigravity config key/,
  );
  assert.throws(
    () => resolveAntigravityPluginConfig({ project: "one", newProject: true }),
    /mutually exclusive/,
  );
  assert.throws(
    () => resolveAntigravityPluginConfig({ mode: "dangerous" }),
    /accept-edits or plan/,
  );
  assert.throws(
    () => resolveAntigravityPluginConfig({ addDirs: ["/one", "/one"] }),
    /must not contain duplicates/,
  );
});
