import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import plugin from "../src/index.ts";
import { assertOpenClawCompatibility, inspectOpenClawCompatibility, OPENCLAW_REQUIRED_REGISTRATION_CONTRACTS } from "../src/host/compatibility.ts";
import { definePluginEntryWithSdk, normalizeTerminalFallback, normalizeTerminalWithSdk, type TerminalInput } from "../src/host/helpers.ts";
import { assertOpenClawAttemptCapabilities, prepareOpenClawEnvironment } from "../src/host/attempt.ts";
import type { AgentHarnessAttemptParamsV2, OpenClawPluginApi } from "../src/host/types.ts";

function fixtureApi(version: unknown = "2026.9.4") {
  const calls: string[] = [];
  return {
    calls,
    api: {
      runtime: { version, agent: { session: {
        getSessionEntry() { throw new Error("Registration must not read sessions"); },
        patchSessionEntry() { throw new Error("Registration must not mutate sessions"); },
      } } },
      registerProvider() { calls.push("provider"); },
      registerModelCatalogProvider() { calls.push("catalog"); },
      registerAgentHarness() { calls.push("harness"); },
      registerCliBackend() { calls.push("cli"); },
    },
  };
}

test("minimum stable OpenClaw admission remains forward-compatible and distinct from SDK build provenance", () => {
  for (const version of ["2026.9.2", "2026.9.4", "2026.10.0", "2027.1.0", "2030.12.31", "2027.3.5+build.1"]) {
    const { api } = fixtureApi(version);
    const report = inspectOpenClawCompatibility(api);
    assert.equal(report.status, "eligible");
    assert.equal(report.runtimeVersion, version);
    assert.equal(report.buildSdkVersion, "2026.9.4");
    assert.equal(report.supportRange, ">=2026.9.2");
    assert.equal(report.installedQualification, "pending");
    assert.equal(report.executionQualification.status, "required-before-native-start");
    assertOpenClawCompatibility(api);
  }
  for (const version of ["2026.9.1", "2026.8.99", "2025.12.99", "2026.9.5-beta.1", "2026.09.4", " 2026.9.4", "2026.9.4\n", "unknown", null]) {
    const { api } = fixtureApi(version);
    assert.equal(inspectOpenClawCompatibility(api).status, "unsupported");
    assert.throws(() => assertOpenClawCompatibility(api), /runtime.version/u);
  }
  const { api } = fixtureApi();
  delete (api.runtime as Record<string, unknown>).version;
  assert.match(inspectOpenClawCompatibility(api).diagnostics.join(" "), /Missing.*runtime.version/u);
});

test("missing required contract rejects before every registration and session call", () => {
  for (const path of OPENCLAW_REQUIRED_REGISTRATION_CONTRACTS) {
    const { api, calls } = fixtureApi();
    const parts = path.split(".");
    let target = api as unknown as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
    target[parts.at(-1)!] = undefined;
    const report = inspectOpenClawCompatibility(api);
    assert.equal(report.status, "missing-contracts");
    assert.deepEqual(report.missingContracts, [path]);
    assert.throws(() => plugin.register(api as unknown as OpenClawPluginApi), (error: Error) => error.message.includes(path));
    assert.deepEqual(calls, []);
  }
});

test("eligible registration does not invoke native discovery or session methods", () => {
  const { api, calls } = fixtureApi("2027.1.0");
  plugin.register(api as unknown as OpenClawPluginApi);
  assert.deepEqual(calls, ["provider", "catalog", "harness", "cli"]);
});

test("registration errors propagate without switching to the CLI backend", () => {
  const { api, calls } = fixtureApi();
  const failure = new Error("real registrar failure");
  api.registerAgentHarness = () => { throw failure; };
  assert.throws(() => plugin.register(api as unknown as OpenClawPluginApi), (error) => error === failure);
  assert.deepEqual(calls, ["provider", "catalog"]);
});

test("entry helper absence and presence preserve the exact explicit-schema entry", () => {
  const entry = { id: "fixture", name: "Fixture", description: "SIMULATED", configSchema: {}, register() {} };
  assert.deepEqual(definePluginEntryWithSdk(entry, {}), entry);
  let count = 0;
  const present = definePluginEntryWithSdk(entry, { definePluginEntry(value: typeof entry) {
    count++;
    return { id: value.id, name: value.name, description: value.description,
      get configSchema() { return value.configSchema; }, register: value.register };
  } });
  assert.deepEqual(present, entry);
  assert.equal(count, 1);
  assert.equal(definePluginEntryWithSdk(entry, { definePluginEntry: () => ({ ...entry, hostMetadata: "additive" }) }).id, entry.id);
});

test("module linking succeeds with both optional exports absent", () => {
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "--import", "./tests/source-sdk-loader.mjs?helpers=absent",
    "--input-type=module", "--eval",
    'import plugin from "./src/index.ts"; import { agentHarnessAttemptTerminal } from "./src/host/terminal.ts"; if (plugin.id !== "antigravity" || agentHarnessAttemptTerminal.normalize({aborted:true}).kind !== "aborted") throw new Error("fallback mismatch");',
  ], { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 10_000, maxBuffer: 100_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test("malformed or throwing entry helpers cannot select the absent-helper fallback", () => {
  const entry = { id: "fixture", name: "Fixture", description: "SIMULATED", configSchema: {}, register() {} };
  const failure = new Error("real helper failure");
  assert.throws(() => definePluginEntryWithSdk(entry, { definePluginEntry() { throw failure; } }), (error) => error === failure);
  for (const helper of [null, 1, () => undefined, () => ({ ...entry, id: "changed" })]) {
    assert.throws(() => definePluginEntryWithSdk(entry, { definePluginEntry: helper }), /malformed/u);
  }
});

test("terminal fallback preserves official precedence, attribution and failure identity", () => {
  const failure = new Error("native failure");
  const cases: [TerminalInput, unknown][] = [
    [{}, { kind: "ok" }],
    [{ aborted: true }, { kind: "aborted", source: "runtime" }],
    [{ externalAbort: true }, { kind: "aborted", source: "external" }],
    [{ timedOut: true }, { kind: "timeout", phase: "prompt", source: "runtime" }],
    [{ timedOutByRunBudget: true, aborted: true }, { kind: "timeout", phase: "prompt", source: "run_budget", aborted: true }],
    [{ timedOutByRunBudget: true, externalAbort: true }, { kind: "timeout", phase: "prompt", source: "external", aborted: true }],
    [{ promptError: failure }, { kind: "failed", source: "prompt", error: failure }],
    [{ promptError: failure, promptErrorSource: "precheck", aborted: true }, { kind: "aborted", source: "runtime", failure: { source: "precheck", error: failure } }],
    [{ timedOut: true, promptError: failure }, { kind: "timeout", phase: "prompt", source: "runtime", failure: { source: "prompt", error: failure } }],
    [{ promptError: null }, { kind: "ok" }],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(normalizeTerminalWithSdk(input, {}), expected);
    let calls = 0;
    assert.deepEqual(normalizeTerminalWithSdk(input, { agentHarnessAttemptTerminal: { normalize() { calls++; return expected; } } }), expected);
    assert.equal(calls, 1);
  }
  assert.equal(normalizeTerminalWithSdk({}, { agentHarnessAttemptTerminal: { normalize: () => ({ kind: "ok", hostMetadata: "additive" }) } }).kind, "ok");
});

test("malformed or throwing terminal helpers cannot mask their failure", () => {
  const failure = new Error("terminal helper fault");
  assert.throws(() => normalizeTerminalWithSdk({}, { agentHarnessAttemptTerminal: { normalize() { throw failure; } } }), (error) => error === failure);
  for (const helper of [null, {}, { normalize: 1 }, { normalize: () => undefined }, { normalize: () => ({ kind: "ok" }) }]) {
    assert.throws(() => normalizeTerminalWithSdk({ aborted: true }, { agentHarnessAttemptTerminal: helper }), /malformed/u);
  }
  assert.throws(() => normalizeTerminalFallback({ idleTimedOut: true } as TerminalInput), /does not support idleTimedOut/u);
});

function fixtureAttempt() {
  const calls: string[] = [];
  const attempt = { hostCapabilities: {
    assertActive() { calls.push("active"); },
    preparedEnvironment() { calls.push("environment"); return { credentialScrubEnv: { AGY_FIXTURE_SECRET: "" }, localIdentityEnv: { AGY_FIXTURE_ID: "owner" }, managedLocalIdentity: false }; },
  } } as unknown as AgentHarnessAttemptParamsV2;
  return { attempt, calls };
}

test("attempt capability preflight checks all contracts before calling host code", () => {
  for (const key of ["assertActive", "preparedEnvironment"]) {
    const { attempt, calls } = fixtureAttempt();
    delete (attempt.hostCapabilities as unknown as Record<string, unknown>)[key];
    assert.throws(() => assertOpenClawAttemptCapabilities(attempt), (error: Error) => error.message.includes(key));
    assert.deepEqual(calls, []);
  }
  const { attempt, calls } = fixtureAttempt();
  const env = prepareOpenClawEnvironment(attempt);
  assert.deepEqual(calls, ["active", "environment"]);
  assert.equal(env.AGY_FIXTURE_SECRET, "");
  assert.equal(env.AGY_FIXTURE_ID, "owner");
});

test("prepared environment errors and malformed contracts never fall back to ambient identity", () => {
  const failure = new Error("retired prepared environment");
  const { attempt } = fixtureAttempt();
  (attempt.hostCapabilities as unknown as Record<string, unknown>).preparedEnvironment = () => { throw failure; };
  assert.throws(() => prepareOpenClawEnvironment(attempt), (error) => error === failure);
  for (const value of [undefined, {}, { credentialScrubEnv: {}, localIdentityEnv: { TOKEN: 1 }, managedLocalIdentity: false }, { credentialScrubEnv: {}, localIdentityEnv: {}, managedLocalIdentity: false, localProcessEnv: { "BAD=KEY": "value" } }]) {
    (attempt.hostCapabilities as unknown as Record<string, unknown>).preparedEnvironment = () => value;
    assert.throws(() => prepareOpenClawEnvironment(attempt), /malformed.*preparedEnvironment/u);
  }
});

test("every production OpenClaw import is isolated inside the host adapter", () => {
  const source = new URL("../src/", import.meta.url);
  function walk(path: string): void {
    for (const item of readdirSync(new URL(path, source), { withFileTypes: true })) {
      if (path === "./" && item.name === "host") continue;
      const relative = join(path, item.name);
      if (item.isDirectory()) walk(relative + "/");
      else if (item.name.endsWith(".ts")) assert.doesNotMatch(readFileSync(new URL(relative, source), "utf8"), /from\s+["']openclaw\//u, relative);
    }
  }
  walk("./");
});
