import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

type ModelEntry = {
  alias?: string;
  agentRuntime?: { id?: string };
};

type ExampleConfig = {
  agents?: {
    defaults?: {
      models?: Record<string, ModelEntry>;
    };
  };
  models?: {
    providers?: Record<string, unknown>;
  };
};

function loadExampleConfig(): ExampleConfig {
  const source = readFileSync(new URL("../examples/openclaw.json5", import.meta.url), "utf8");
  return vm.runInNewContext(`(${source})`, Object.create(null), {
    timeout: 1_000,
  }) as ExampleConfig;
}

test("example binds antigravity/* to the native harness and exposes no Gemini aliases", () => {
  const models = loadExampleConfig().agents?.defaults?.models;
  assert.equal(models?.["antigravity/*"]?.agentRuntime?.id, "antigravity");
  for (const id of [
    "gemini-high",
    "gemini-medium",
    "gemini-low",
    "gemini-3.5-high",
    "gemini-3.5-medium",
    "gemini-3.5-low",
    "gemini-pro-high",
    "gemini-pro-low",
  ]) {
    assert.equal(models?.[`antigravity/${id}`], undefined);
  }
});

test("native harness example does not synthesize an HTTP provider transport", () => {
  const config = loadExampleConfig();
  assert.equal(config.models?.providers?.antigravity, undefined);
});
