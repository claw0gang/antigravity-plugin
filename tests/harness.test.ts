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
  const harness = createAntigravityHarness({
    hostContracts: sourceHostContracts({
      resolveResetSession: () => identity,
      async cancelAndDrain(target) {
        assert.deepEqual(target, identity);
        assert.throws(() => bindings.resolve(identity), /reset.*pending/u);
        drained = true;
      },
    }),
    pluginConfig: resolveAntigravityPluginConfig(undefined), sessionRuntime: runtime,
  });
  await harness.reset?.({ agentId: "main", sessionKey: identity.openclawSessionKey, sessionId: identity.openclawSessionId, reason: "reset" });
  assert.equal(drained, true);
  assert.equal(bindings.resolve(identity), undefined);
  const extensions = rows.get(identity.openclawSessionKey)?.pluginExtensions;
  assert.deepEqual(extensions?.other, { keep: true });
  assert.equal(extensions?.antigravity?.schema, "antigravity-native-session-binding/v2");
  assert.notEqual(extensions?.antigravity?.epoch, lease.epoch);
  assert.equal(extensions?.antigravity?.binding, undefined);
  assert.equal(extensions?.antigravity?.activeAttempt, undefined);
  assert.deepEqual(rows.get("agent:main:child:other"), beforeOther);
});

test("reset requires qualified canonical target resolution and drain", async () => {
  const harness = createHarness();
  await assert.rejects(harness.reset!({ agentId: "main", sessionKey: "agent:main:child:1", sessionId: "session-1", reason: "reset" }), /canonical target resolution.*cancellation\/drain/u);
});

test("canonical session deletion owns binding deletion without a side-store hook", () => {
  const harness = createHarness();
  assert.equal(harness.withSessionDeletion, undefined);
});
