import assert from "node:assert/strict";
import test from "node:test";
import { createSourceSessionRuntime, sourceHostContracts, sourceSessionMutation } from "./fixtures/host-contracts.ts";

import { resolveAntigravityPluginConfig } from "../src/config.ts";
import {
  bindCarrierPluginConfig,
  createAntigravityHarness,
  normalizeCarrierEnforcedSafeDenies,
  normalizeOpenClawLegacyContextEngineAttempt,
} from "../src/harness/harness.ts";
import type { AntigravityNativeAgentCarrierLease } from "../src/harness/native-agent-carrier.ts";
import { ANTIGRAVITY_OPENCLAW_SAFE_DENY_TOOLS } from "../src/harness/tool-policy.ts";
import { AntigravitySessionBindings } from "../src/harness/session-bindings.ts";

function createRuntime() { return createSourceSessionRuntime([]); }

function createHarness() {
  return createAntigravityHarness({ hostContracts: sourceHostContracts(), pluginConfig: resolveAntigravityPluginConfig(undefined), sessionRuntime: createRuntime().runtime });
}

test("harness owns antigravity provider and declares exact qualified safe-deny parity", () => {
  const harness = createHarness();
  assert.equal(harness.id, "antigravity");
  assert.equal(harness.authBootstrap, "harness");
  assert.equal(harness.executionEnvironment, "host-only");
  assert.equal(harness.nativeModelPolicySupport, undefined);
  assert.deepEqual(harness.autoSelection, { providerIds: ["antigravity"] });
  assert.equal(harness.conversationToolPolicySupport, "exact");
  assert.deepEqual(harness.conversationToolPolicySafeDenyTools, ANTIGRAVITY_OPENCLAW_SAFE_DENY_TOOLS);
  assert.deepEqual(harness.supports({ provider: "antigravity", modelId: "gemini-3.8-flash-high", requestedRuntime: "auto", providerOwnerStatus: "owned", providerOwnerPluginIds: ["antigravity"], modelProvider: { requestTransportOverrides: "none" } }), { supported: true, priority: 100 });
});

test("qualified safe-deny carrier consumes the matching restrictive-policy summary only", () => {
  const attempt = {
    pluginHarnessToolPolicyRestricted: true,
    pluginHarnessToolPolicySafeDeniedTools: ["sessions_spawn", "message"],
    disableTools: true,
  } as unknown as Parameters<typeof normalizeCarrierEnforcedSafeDenies>[0];
  const lease = {
    safeDeniedTools: ["message", "sessions_spawn"],
  } as unknown as AntigravityNativeAgentCarrierLease;

  const normalized = normalizeCarrierEnforcedSafeDenies(attempt, lease);
  assert.notEqual(normalized, attempt);
  assert.equal(normalized.pluginHarnessToolPolicyRestricted, undefined);
  assert.equal(normalized.pluginHarnessToolPolicySafeDeniedTools, undefined);
  assert.equal(normalized.disableTools, true);
  assert.equal(attempt.pluginHarnessToolPolicyRestricted, true);
  assert.deepEqual(attempt.pluginHarnessToolPolicySafeDeniedTools, ["sessions_spawn", "message"]);

  const bareRestricted = {
    pluginHarnessToolPolicyRestricted: true,
  } as unknown as Parameters<typeof normalizeCarrierEnforcedSafeDenies>[0];
  assert.equal(normalizeCarrierEnforcedSafeDenies(bareRestricted, undefined), bareRestricted);
  assert.equal(bareRestricted.pluginHarnessToolPolicyRestricted, true);
});

test("native carrier disables dangerous permission bypass only for the carried attempt", () => {
  const configured = resolveAntigravityPluginConfig({
    sandbox: false,
    dangerouslySkipPermissions: true,
  });
  const lease = {
    agentName: "openclaw-antigravity-test-carrier",
  } as unknown as AntigravityNativeAgentCarrierLease;

  assert.equal(bindCarrierPluginConfig(configured, undefined), configured);
  assert.equal(configured.dangerouslySkipPermissions, true);

  const carried = bindCarrierPluginConfig(configured, lease);
  assert.notEqual(carried, configured);
  assert.equal(carried.agent, "openclaw-antigravity-test-carrier");
  assert.equal(carried.dangerouslySkipPermissions, false);
  assert.equal(carried.sandbox, false);
  assert.equal(configured.dangerouslySkipPermissions, true);
  assert.equal(configured.agent, undefined);
});

test("OpenClaw legacy context engine remains host-owned while non-legacy engines remain visible to P04", () => {
  const legacy = {
    contextEngine: { info: { id: "legacy" } },
  } as unknown as Parameters<typeof normalizeOpenClawLegacyContextEngineAttempt>[0];
  const normalized = normalizeOpenClawLegacyContextEngineAttempt(legacy);
  assert.notEqual(normalized, legacy);
  assert.equal(normalized.contextEngine, undefined);
  assert.equal(legacy.contextEngine?.info.id, "legacy");

  const nonLegacy = {
    contextEngine: { info: { id: "custom-context" } },
  } as unknown as Parameters<typeof normalizeOpenClawLegacyContextEngineAttempt>[0];
  assert.equal(normalizeOpenClawLegacyContextEngineAttempt(nonLegacy), nonLegacy);
});

test("harness rejects foreign, ambiguous, or transport-overridden routes", () => {
  const harness = createHarness();
  assert.equal(harness.supports({ provider: "other", requestedRuntime: "auto" }).supported, false);
  assert.equal(harness.supports({ provider: "antigravity", requestedRuntime: "auto", providerOwnerStatus: "ambiguous", providerOwnerPluginIds: ["antigravity", "other"] }).supported, false);
  assert.equal(harness.supports({ provider: "antigravity", requestedRuntime: "auto", providerOwnerStatus: "owned", providerOwnerPluginIds: ["antigravity"], modelProvider: { requestTransportOverrides: "present" } }).supported, false);
});

test("harness preserves prepared endpoint, runtime and authentication restrictions", () => {
  const harness = createHarness();
  const route = {
    provider: "antigravity", requestedRuntime: "auto",
    providerOwnerStatus: "owned", providerOwnerPluginIds: ["antigravity"],
  } as const;
  const rejected = [
    { endpointOverrides: "present" },
    { runtimePolicy: { compatibleIds: [] } },
    { runtimePolicy: { compatibleIds: ["antigravity-cli", "openclaw"] } },
    { preparedAuth: { source: "profile", mode: "oauth" } },
    { preparedAuth: { source: "direct", mode: "api-key" } },
    { preparedAuth: { source: "direct", mode: "api_key" } },
    { preparedAuth: { source: "direct", mode: "token" } },
    { preparedAuth: { source: "direct", mode: "oauth", requirement: "subscription" } },
    { preparedAuth: { source: "harness", requirement: "api-key" } },
  ] as const;
  for (const modelProvider of rejected) {
    const result = harness.supports({ ...route, modelProvider });
    assert.equal(result.supported, false, JSON.stringify(modelProvider));
    assert.equal("fallbackRuntime" in result, false, "native route must not fall back to an HTTP runtime");
  }
  for (const modelProvider of [
    undefined,
    { endpointOverrides: "none", requestTransportOverrides: "none" },
    { runtimePolicy: { compatibleIds: ["antigravity"] }, preparedAuth: { source: "harness" } },
  ] as const) {
    assert.equal(harness.supports({ ...route, ...(modelProvider ? { modelProvider } : {}) }).supported, true);
  }
});

test("native attempt rejects a host credential before preparing a carrier or native work", async () => {
  const harness = createHarness();
  for (const auth of [
    { authProfileId: "selected-profile" },
    { runtimePlan: { auth: { forwardedAuthProfileId: "forwarded-profile" } } },
    { resolvedApiKey: "SIMULATED-direct-oauth-credential" },
    { resolvedApiKey: "openclaw:antigravity-native-auth" },
  ]) {
    let carrierPreparationReached = false;
    const attempt = {
      ...auth,
      get contextEngine() { carrierPreparationReached = true; throw new Error("carrier must not start"); },
    } as unknown as Parameters<typeof harness.runAttempt>[0];
    await assert.rejects(harness.runAttempt(attempt), /cannot forward the selected OpenClaw credential/u);
    assert.equal(carrierPreparationReached, false);
  }
});

test("native login without an invented host credential reaches ordinary attempt preparation", async () => {
  const harness = createHarness();
  for (const auth of [{}]) {
    const reached = new Error("SIMULATED: ordinary attempt preparation reached");
    const attempt = {
      ...auth,
      get contextEngine() { throw reached; },
    } as unknown as Parameters<typeof harness.runAttempt>[0];
    await assert.rejects(harness.runAttempt(attempt), (error) => error === reached);
  }
});

test("reset removes only the canonical native binding and retains a generation tombstone", async () => {
  const { rows, runtime } = createRuntime();
  const identity = { openclawSessionId: "session-1", openclawSessionKey: "agent:main:child:1", agentId: "main", storePath: "/SIMULATED-session-store.json" };
  rows.set(identity.openclawSessionKey, {
    sessionId: identity.openclawSessionId,
    lifecycleRevision: "SIMULATED:lifecycle-v1",
    pluginExtensions: { other: { keep: true } },
  });
  rows.set("agent:main:child:other", { sessionId: "other", lifecycleRevision: "SIMULATED:other-v1" });
  const beforeOther = structuredClone(rows.get("agent:main:child:other"));
  const bindings = new AntigravitySessionBindings(runtime, { atomicMutation: sourceSessionMutation });
  const lease = await bindings.beginAttempt({ ...identity, modelId: "fixture-model", scopeKey: "SIMULATED:scope", assertActive() {} });
  await bindings.bindFresh({ ...identity, modelId: "fixture-model", conversationId: "conversation-1", lease });
  await bindings.endAttempt(lease, { terminationConfirmed: true });
  let drained = false;
  await bindings.clear({ ...identity, async cancelAndDrain() {
    await assert.rejects(() => bindings.resolve(identity), /reset.*pending/u);
    drained = true;
  } });
  assert.equal(drained, true);
  assert.equal(await bindings.resolve(identity), undefined);
  const extensions = rows.get(identity.openclawSessionKey)?.pluginExtensions;
  assert.deepEqual(extensions?.other, { keep: true });
  assert.equal(extensions?.antigravity?.schema, "antigravity-native-session-binding/v2");
  assert.notEqual(extensions?.antigravity?.epoch, lease.epoch);
  assert.equal(extensions?.antigravity?.binding, undefined);
  assert.equal(extensions?.antigravity?.activeAttempt, undefined);
  assert.deepEqual(rows.get("agent:main:child:other"), beforeOther);
});

test("OpenClaw owns reset; Antigravity has no hook invoked for unrelated sessions", () => {
  assert.equal(createHarness().reset, undefined);
});

test("canonical session deletion owns binding deletion without a side-store hook", () => {
  const harness = createHarness();
  assert.equal(harness.withSessionDeletion, undefined);
});
