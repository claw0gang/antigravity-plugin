/** Credential-free source hook fixtures. This file does not run OpenClaw's picker or prove installed catalog visibility. */
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import plugin from "../src/index.ts";
import { resolveAntigravityPluginConfig } from "../src/config.ts";
import { AgyHostInventoryOwner } from "../src/inventory-scope.ts";
import { createAntigravityProvider, createAntigravityModelCatalogProvider } from "../src/provider.ts";
import { createAntigravityProviderDiscovery } from "../src/provider-discovery.ts";
import { createAntigravityHarness } from "../src/harness/harness.ts";
import { parseAgyModelsOutput, type AgyDiscoveredModel } from "../src/harness/model-catalog.ts";
import type { InvocationScope } from "../src/cli/invocation-scope.ts";
import { createSourceSessionRuntime } from "./fixtures/host-contracts.ts";

const model = (id: string): AgyDiscoveredModel => ({ id, name: `SIMULATED ${id}` });
const initial = [model("fixture-original")];
const pluginConfig = resolveAntigravityPluginConfig({ command: process.execPath, project: "SIMULATED-project", agent: "SIMULATED-agent", addDirs: ["/tmp"] });
function context() {
  return { config: { plugins: { entries: { antigravity: { config: { ...pluginConfig } } } } },
    env: { PATH: "/deliberately-not-inherited", HOME: "/SIMULATED-home", AGY_ACCOUNT: "SIMULATED-A" },
    agentDir: "/SIMULATED-agent-dir", workspaceDir: process.cwd() };
}
function fixture(discoverModels: ConstructorParameters<typeof AgyHostInventoryOwner>[0]["discoverModels"]) {
  const inventoryOwner = new AgyHostInventoryOwner({ pluginConfig, discoverModels });
  const options = { pluginConfig, inventoryOwner };
  return { inventoryOwner, provider: createAntigravityProvider(options), catalog: createAntigravityModelCatalogProvider(options),
    discovery: createAntigravityProviderDiscovery({ inventoryOwner }),
    harness: createAntigravityHarness({ ...options, sessionRuntime: createSourceSessionRuntime([]).runtime }) };
}
async function providerIds(provider: ReturnType<typeof createAntigravityProvider>, ctx: unknown) {
  const result = await provider.catalog!.run(ctx as never);
  assert.ok(result && "provider" in result);
  return result.provider.models.map((row) => row.id);
}

test("host hooks project addition, withdrawal and successful empty through one service", async () => {
  let inventory = initial;
  const scopes: InvocationScope[] = [];
  const f = fixture(async (params) => { scopes.push(params!.scope!); return inventory; });
  const ctx = context();
  assert.deepEqual(await providerIds(f.discovery, ctx), ["fixture-original"]);
  inventory = [model("fixture-next-exact"), model("sonnet-4-6")];
  assert.deepEqual(await providerIds(f.provider, ctx), inventory.map((row) => row.id));
  assert.deepEqual((await f.catalog.liveCatalog!(ctx as never))?.map((row) => row.model), inventory.map((row) => row.id));
  assert.deepEqual((await f.harness.loadModelCatalog!({ ...ctx, agentId: "main" } as never)).map((row) => row.id), inventory.map((row) => row.id));
  // Opaque AGY IDs remain exact even when their spelling matches an old CLI alias.
  assert.equal(f.provider.normalizeModelId!({ modelId: "sonnet-4-6" } as never), "sonnet-4-6");
  assert.equal((await f.provider.prepareDynamicModel!({ ...ctx, provider: "antigravity", modelId: "sonnet-4-6" } as never))?.id, "sonnet-4-6");
  assert.equal(await f.provider.prepareDynamicModel!({ ...ctx, provider: "antigravity", modelId: "claude-sonnet-4-6" } as never), undefined);
  assert.equal(await f.provider.prepareDynamicModel!({ ...ctx, provider: "antigravity", modelId: "fixture-original" } as never), undefined);
  inventory = [];
  assert.deepEqual(await providerIds(f.provider, ctx), []);
  assert.deepEqual(await f.catalog.liveCatalog!(ctx as never), []);
  assert.deepEqual(await f.harness.loadModelCatalog!({ ...ctx, agentId: "main" } as never), []);
  // Empty discovery is not native account or model readiness.
  assert.equal(f.harness.readModelCatalogReadiness!({ ...ctx, agentId: "main", provider: "antigravity", modelId: "sonnet-4-6" } as never), undefined);
  assert.equal(await f.provider.prepareDynamicModel!({ ...ctx, provider: "antigravity", modelId: "sonnet-4-6" } as never), undefined);
  assert.equal(scopes[0]!.command, process.execPath);
  assert.deepEqual(scopes[0]!.env, ctx.env);
  assert.equal(scopes[0]!.cwd, ctx.workspaceDir);
  assert.equal(scopes[0]!.owner.agentDir, ctx.agentDir);
  assert.equal(scopes[0]!.projectSelection?.project, "SIMULATED-project");
  assert.equal(scopes[0]!.nativeAgentSelection, "SIMULATED-agent");
  assert.deepEqual(scopes[0]!.addDirs, ["/tmp"]);
  f.inventoryOwner.stop();
});

test("SIMULATED host allowlist remains host-owned when AGY adds a model", async () => {
  const raw = [model("allowed"), model("new-restricted")];
  const f = fixture(async () => raw);
  const ctx = context();
  const config = { ...ctx.config, agents: { defaults: { model: { primary: "other/keep" }, models: { "antigravity/allowed": {}, "other/keep": {} } } } };
  const before = structuredClone(config);
  const rows = await f.catalog.liveCatalog!({ ...ctx, config } as never);
  assert.deepEqual(rows?.map((row) => row.model), ["allowed", "new-restricted"]);
  // Source-only consumer fixture, not a reproduction of OpenClaw policy code.
  const visible = rows!.filter((row) => Object.hasOwn(config.agents.defaults.models, `${row.provider}/${row.model}`));
  assert.deepEqual(visible.map((row) => row.model), ["allowed"]);
  assert.deepEqual(config, before);
  assert.equal(f.provider.preferRuntimeResolvedModel, undefined);
  f.inventoryOwner.stop();
});

test("provider/live catalog concurrent equivalent reads coalesce; distinct agents remain separate", async () => {
  let acquisitions = 0;
  let finish!: (models: AgyDiscoveredModel[]) => void;
  const f = fixture(async () => { acquisitions++; return new Promise((resolve) => { finish = resolve; }); });
  const ctx = context();
  const provider = providerIds(f.provider, ctx);
  const catalog = f.catalog.liveCatalog!(ctx as never);
  await setImmediate();
  assert.equal(acquisitions, 1);
  finish(initial);
  await Promise.all([provider, catalog]);
  const a = providerIds(f.provider, ctx);
  await setImmediate();
  const finishA = finish;
  const b = providerIds(f.provider, { ...ctx, agentDir: "/SIMULATED-second-agent" });
  await setImmediate();
  assert.equal(acquisitions, 3);
  finish(initial); finishA(initial);
  await Promise.all([a, b]);
  f.inventoryOwner.stop();
});

test("auth failure and malformed refresh fail without stale rows or readiness renewal", async () => {
  let failure: "auth" | "malformed" | undefined;
  const f = fixture(async () => {
    if (failure === "auth") throw new Error("SIMULATED credential diagnostic must not leak");
    if (failure === "malformed") return parseAgyModelsOutput('{"models":');
    return initial;
  });
  const ctx = context();
  assert.deepEqual(await providerIds(f.provider, ctx), ["fixture-original"]);
  for (failure of ["auth", "malformed"] as const) {
    await assert.rejects(providerIds(f.provider, ctx), (error: Error) => !error.message.includes("credential diagnostic"));
    assert.equal(f.harness.readModelCatalogReadiness!({ ...ctx, provider: "antigravity", modelId: "fixture-original" } as never), undefined);
    await assert.rejects(f.provider.prepareDynamicModel!({ ...ctx, provider: "antigravity", modelId: "fixture-original" } as never));
  }
  f.inventoryOwner.stop();
});

test("changed config fences old acquisition; changed credentials fence the same host coordinate immediately", async () => {
  const pending: Array<{ scope: InvocationScope; finish: (models: AgyDiscoveredModel[]) => void }> = [];
  const f = fixture(async (params) => new Promise((finish) => pending.push({ scope: params!.scope!, finish })));
  const ctx = context();
  const first = providerIds(f.provider, ctx);
  const firstRejected = assert.rejects(first, /retired|active/u);
  await setImmediate();
  ctx.env.AGY_ACCOUNT = "SIMULATED-B";
  const second = providerIds(f.provider, ctx);
  await setImmediate();
  assert.equal(pending[0]!.scope.signal!.aborted, true);
  pending[1]!.finish([model("fresh-model")]);
  assert.deepEqual(await second, ["fresh-model"]);
  pending[0]!.finish([model("stale-model")]);
  await firstRejected;
  const third = providerIds(f.provider, ctx);
  const thirdRejected = assert.rejects(third, /retired|active/u);
  await setImmediate();
  ctx.config.plugins.entries.antigravity.config.project = "SIMULATED-project-2";
  const fourth = providerIds(f.provider, ctx);
  await setImmediate();
  assert.equal(pending[2]!.scope.signal!.aborted, true);
  pending[3]!.finish([model("project-2")]);
  assert.deepEqual(await fourth, ["project-2"]);
  pending[2]!.finish(initial);
  await thirdRejected;
  f.inventoryOwner.stop();
});

test("host timeout and owner stop reject late completion; a new owner can acquire", async () => {
  const pending: Array<{ scope: InvocationScope; finish: (models: AgyDiscoveredModel[]) => void }> = [];
  const f = fixture(async (params) => new Promise((finish) => pending.push({ scope: params!.scope!, finish })));
  const ctx = context();
  await assert.rejects(f.catalog.liveCatalog!({ ...ctx, timeoutMs: 10 } as never), /deadline|timeout/u);
  assert.equal(pending[0]!.scope.signal!.aborted, true);
  pending[0]!.finish(initial);
  await setImmediate();
  const next = providerIds(f.provider, ctx);
  const rejected = assert.rejects(next, /retired|stopped/u);
  await setImmediate();
  f.inventoryOwner.stop();
  assert.equal(pending[1]!.scope.signal!.aborted, true);
  pending[1]!.finish(initial);
  await rejected;
  await assert.rejects(providerIds(f.provider, ctx), /stopped/u);
  const restarted = fixture(async () => [model("fresh-owner")]);
  assert.deepEqual(await providerIds(restarted.provider, ctx), ["fresh-owner"]);
  restarted.inventoryOwner.stop();
});


test("public optional service stop revokes provider and harness catalog owners without native work", async () => {
  let service: { start(ctx: unknown): unknown; stop?(ctx: unknown): unknown } | undefined;
  let provider: ReturnType<typeof createAntigravityProvider> | undefined;
  let harness: ReturnType<typeof createAntigravityHarness> | undefined;
  const calls: string[] = [];
  plugin.register({
    pluginConfig: { command: process.execPath },
    runtime: { version: "2026.9.4", agent: { session: {
      getSessionEntry() { throw new Error("no registration session reads"); },
      listSessionEntries() { throw new Error("no registration session reads"); },
      patchSessionEntry() { throw new Error("no registration session writes"); },
    } } },
    registerService(value: typeof service) { service = value; calls.push("service"); },
    registerProvider(value: typeof provider) { provider = value; },
    registerModelCatalogProvider() {},
    registerAgentHarness(value: typeof harness) { harness = value; },
    registerCliBackend() {},
  } as never);
  assert.deepEqual(calls, ["service"]);
  assert.ok(service && provider && harness);
  await service.start({});
  await service.stop!({});
  await assert.rejects(providerIds(provider, context()), /stopped/u);
  await assert.rejects(harness.loadModelCatalog!({ ...context(), agentId: "main" } as never), /stopped/u);
});

test("readiness is exact scoped live metadata with unknown auth mode and no discovery side effects", async () => {
  let acquisitions = 0;
  const f = fixture(async () => { acquisitions++; return initial; });
  const ctx = { ...context(), agentId: "main" };
  const query = { ...ctx, provider: "antigravity", modelId: "fixture-original" };
  assert.equal(f.harness.readModelCatalogReadiness!(query as never), undefined);
  assert.equal(acquisitions, 0);
  await f.harness.loadModelCatalog!(ctx as never);
  assert.deepEqual(f.harness.readModelCatalogReadiness!(query as never), { accountType: "unreported" });
  for (const change of [{ agentId: "other" }, { provider: "other" }, { modelId: "withdrawn" },
    { workspaceDir: "/different" }, { env: { ...ctx.env, GEMINI_API_KEY: "SIMULATED-KEY" } }]) {
    assert.equal(f.harness.readModelCatalogReadiness!({ ...query, ...change } as never), undefined);
  }
  assert.equal(acquisitions, 1);
  ctx.env.AGY_ACCOUNT = "SIMULATED-B";
  assert.equal(f.harness.readModelCatalogReadiness!(query as never), undefined);
  await f.harness.loadModelCatalog!(ctx as never);
  assert.deepEqual(f.harness.readModelCatalogReadiness!(query as never), { accountType: "unreported" });
  f.inventoryOwner.stop();
  assert.equal(f.harness.readModelCatalogReadiness!(query as never), undefined);
});

test("readiness cannot survive a failed or in-flight refresh of its exact prepared environment", async () => {
  let rejectRefresh!: (reason: Error) => void;
  let first = true;
  const f = fixture(async () => first ? (first = false, initial) : new Promise((_resolve, reject) => { rejectRefresh = reject; }));
  const ctx = { ...context(), agentId: "main" };
  const query = { ...ctx, provider: "antigravity", modelId: "fixture-original" };
  await f.harness.loadModelCatalog!(ctx as never);
  assert.ok(f.harness.readModelCatalogReadiness!(query as never));
  const refresh = f.harness.loadModelCatalog!(ctx as never);
  await setImmediate();
  assert.equal(f.harness.readModelCatalogReadiness!(query as never), undefined);
  rejectRefresh(new Error("SIMULATED auth changed"));
  await assert.rejects(refresh);
  assert.equal(f.harness.readModelCatalogReadiness!(query as never), undefined);
  f.inventoryOwner.stop();
});

test("equivalent AGY config projections do not retire the native catalog or cross scope boundaries", async () => {
  let acquisitions = 0;
  let finish!: (models: AgyDiscoveredModel[]) => void;
  const f = fixture(async () => { acquisitions++; return new Promise(resolve => { finish = resolve; }); });
  const ctx = { ...context(), agentId: "main" };
  const a = f.harness.loadModelCatalog!(ctx as never);
  await setImmediate();
  // Host-owned catalog/auth metadata differs, but the exact AGY invocation
  // config, environment, agent and workspace are identical.
  const projected = { ...ctx, config: { ...ctx.config, models: { providers: { other: { baseUrl: "https://fixture.invalid" } } } } };
  const b = providerIds(f.provider, projected);
  await setImmediate();
  assert.equal(acquisitions, 1);
  finish(initial);
  await Promise.all([a, b]);
  const query = { ...ctx, provider: "antigravity", modelId: "fixture-original" };
  assert.deepEqual(f.harness.readModelCatalogReadiness!(query as never), { accountType: "unreported" });
  assert.deepEqual(f.harness.readModelCatalogReadiness!({ ...query, config: projected.config } as never), { accountType: "unreported" });
  f.harness.dispose?.();
  assert.equal(f.harness.readModelCatalogReadiness!(query as never), undefined);
  await assert.rejects(providerIds(f.provider, ctx), /stopped/);
});

test("modern native catalog reports ready, withdrawal and unavailable without claiming auth rejection", async () => {
  let rows = initial, failed = false;
  const owner = new AgyHostInventoryOwner({ pluginConfig, discoverModels: async () => {
    if (failed) throw new Error("SIMULATED private credential details");
    return rows;
  } });
  const harness = createAntigravityHarness({ pluginConfig, inventoryOwner: owner, nativeCatalogControls: true,
    sessionRuntime: createSourceSessionRuntime([]).runtime });
  const ctx = { ...context(), agentId: "main" };
  const query = { ...ctx, provider: "antigravity", modelId: initial[0]!.id };
  const ready = await harness.loadModelCatalog!(ctx as never);
  assert.deepEqual(ready, { entries: [{ ...initial[0], provider: "antigravity", nativeRuntime: "antigravity", reasoning: false }],
    outcomes: [{ provider: "antigravity", status: "ready" }] });
  assert.ok(harness.readModelCatalogReadiness!(query as never));
  failed = true;
  assert.deepEqual(await harness.loadModelCatalog!(ctx as never), { entries: [], outcomes: [{ provider: "antigravity", status: "unavailable" }] });
  assert.equal(harness.readModelCatalogReadiness!(query as never), undefined);
  failed = false; rows = [];
  assert.deepEqual(await harness.loadModelCatalog!(ctx as never), { entries: [], outcomes: [{ provider: "antigravity", status: "ready" }] });
  harness.dispose?.();
  await assert.rejects(harness.loadModelCatalog!(ctx as never), /stopped/);
});
