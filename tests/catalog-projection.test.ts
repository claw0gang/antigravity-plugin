import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { AgyHostInventoryOwner, configuredAgyModelIds } from "../src/inventory-scope.ts";
import { createAntigravityProvider } from "../src/provider.ts";
import { createAntigravityProviderDiscovery } from "../src/provider-discovery.ts";
import { resolveAntigravityPluginConfig } from "../src/config.ts";
import type { AgyDiscoveredModel } from "../src/harness/model-catalog.ts";

const pluginConfig = resolveAntigravityPluginConfig({ command: process.execPath });
const firstRows = [{ id: "first", name: "First" }];
const nextRows = [{ id: "next", name: "Next" }];
const ctx = { agentId: "main", agentDir: "/SIMULATED-agent", workspaceDir: process.cwd(), env: { AGY_ACCOUNT: "SIMULATED" }, config: {} };
const ready = (owner: AgyHostInventoryOwner, id: string) => owner.readiness({ ...ctx, provider: "antigravity", modelId: id });

test("equal effective AGY projections share one acquisition without revoking readiness", async () => {
  const pending: Array<(rows: AgyDiscoveredModel[]) => void> = [];
  const owner = new AgyHostInventoryOwner({ pluginConfig, discoverModels: async () => new Promise(resolve => pending.push(resolve)) });
  try {
    const projected = { ...ctx, config: { models: { providers: { other: {} } } } };
    const first = owner.models(ctx);
    const firstResult = first.then(value => ({ value }), error => ({ error }));
    await tick();
    const second = owner.models(projected);
    const secondResult = second.then(value => ({ value }), error => ({ error }));
    await tick();
    for (const finish of pending) finish(firstRows);
    const [a, b] = await Promise.all([firstResult, secondResult]);
    assert.equal(pending.length, 1);
    assert.deepEqual(a, { value: firstRows });
    assert.deepEqual(b, { value: firstRows });
    assert.deepEqual(ready(owner, "first"), { accountType: "unreported" });
    assert.deepEqual(owner.readiness({ ...projected, provider: "antigravity", modelId: "first" }), { accountType: "unreported" });
    assert.equal(owner.readiness({ ...ctx, agentId: "other", provider: "antigravity", modelId: "first" }), undefined);
    assert.equal(owner.readiness({ ...ctx, env: { AGY_ACCOUNT: "OTHER" }, provider: "antigravity", modelId: "first" }), undefined);
  } finally { owner.stop(); }
});

test("ordinary refresh withdraws old rows and failed refresh invalidates readiness", async () => {
  let rows = firstRows;
  let failed = false;
  const owner = new AgyHostInventoryOwner({ pluginConfig, discoverModels: async () => {
    if (failed) throw new Error("SIMULATED credential diagnostic");
    return rows;
  } });
  try {
    assert.equal(ready(owner, "first"), undefined);
    assert.deepEqual(await owner.models(ctx), firstRows);
    assert.ok(ready(owner, "first"));
    rows = nextRows;
    assert.deepEqual(await owner.models(ctx), nextRows);
    assert.equal(ready(owner, "first"), undefined);
    assert.ok(ready(owner, "next"));
    failed = true;
    await assert.rejects(owner.models(ctx), (error: Error) => !error.message.includes("credential diagnostic"));
    assert.equal(ready(owner, "next"), undefined);
    failed = false;
    rows = [];
    assert.deepEqual(await owner.models(ctx), []);
    assert.equal(ready(owner, "first"), undefined);
  } finally { owner.stop(); }
});

test("late capability observation cannot publish against a newer inventory snapshot", async () => {
  let rows = firstRows;
  let finish!: (rows: readonly AgyDiscoveredModel[]) => void;
  const owner = new AgyHostInventoryOwner({ pluginConfig, discoverModels: async () => rows,
    observeEffort: async () => new Promise(resolve => { finish = resolve; }) });
  try {
    const pending = owner.modelsWithEffort(ctx, ["first"]);
    const rejected = assert.rejects(pending, /superseded/u);
    await tick();
    rows = nextRows;
    assert.deepEqual(await owner.models(ctx), nextRows);
    finish(firstRows);
    await rejected;
    assert.ok(ready(owner, "next"));
    assert.equal(ready(owner, "first"), undefined);
  } finally { owner.stop(); }
});

test("logical provider rows carry the observed profile before any native harness catalog call", async () => {
  const models = [{ id: "opaque-high", name: "Fixture (High)" }, { id: "opaque-low", name: "Fixture (Low)" }];
  const config = { ...ctx.config, agents: { defaults: { model: { primary: "antigravity/opaque-high" } } } };
  let observed: string[][] = [];
  const owner = new AgyHostInventoryOwner({ pluginConfig, discoverModels: async () => models,
    observeEffort: async (_scope, rows, ids) => {
      observed.push([...ids]);
      return rows.map(row => row.id === "opaque-high" ? {
        ...row, effort: { adjustable: true as const, current: "high" as const, available: ["low", "high"] as const },
      } : row);
    } });
  try {
    const full = createAntigravityProvider({ pluginConfig, inventoryOwner: owner, nativeCatalogControls: true });
    const lightweight = createAntigravityProviderDiscovery({ inventoryOwner: owner });
    for (const provider of [full, lightweight]) {
      const result = await provider.catalog!.run({ ...ctx, config } as never);
      assert.ok(result && "provider" in result);
      const row = result.provider.models.find(model => model.id === "opaque-high")!;
      assert.equal(row.reasoning, true);
      assert.deepEqual(row.params?.antigravityEffort, { modelId: row.id, observation: {
        adjustable: true, current: "high", available: ["low", "high"],
      } });
      const profile = provider.resolveThinkingProfile!({ provider: "antigravity", modelId: row.id, reasoning: row.reasoning, params: row.params } as never);
      assert.deepEqual(profile?.levels.map(level => level.id), ["off", "low", "high"]);
      assert.equal(result.provider.models.find(model => model.id === "opaque-low")?.reasoning, false);
      assert.equal(result.provider.apiKey, undefined);
    }
    assert.deepEqual(observed, [["opaque-high"], ["opaque-high"]]);
  } finally { owner.stop(); }
});

test("probe selection uses only explicit native refs, not generated inventory or wildcard aliases", () => {
  const config = { agents: { defaults: { model: { primary: "antigravity/a", fallbacks: ["other/b", "antigravity/fallback"] },
    models: { "antigravity/*": {}, "antigravity/allowed": {}, "alias": {} } },
    list: [{ model: "antigravity/agent" }] }, models: { providers: { antigravity: { models: [{ id: "generated" }] } } } };
  assert.deepEqual(configuredAgyModelIds(config, ["selected", "a"]), ["selected", "a", "agent", "allowed", "fallback"]);
});

test("published native observation remains current during equivalent refresh, not after failure or retirement", async () => {
  let pending: ((rows: AgyDiscoveredModel[]) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  let initial = true;
  const discoverModels = async () => initial ? (initial = false, firstRows) : new Promise<AgyDiscoveredModel[]>((resolve, fail) => { pending = resolve; reject = fail; });
  const owner = new AgyHostInventoryOwner({ pluginConfig, discoverModels });
  const query = { ...ctx, provider: "antigravity", modelId: "first" };
  try {
    assert.equal(owner.readiness(query, true), undefined);
    await owner.models(ctx);
    assert.ok(owner.readiness(query, true));
    const refresh = owner.models(ctx);
    const rejected = assert.rejects(refresh, /failed/);
    await tick();
    assert.ok(pending && reject);
    assert.equal(owner.readiness(query), undefined); // existing strict fence
    assert.deepEqual(owner.readiness(query, true), { accountType: "unreported" });
    assert.equal(owner.readiness({ ...query, agentId: "other" }, true), undefined);
    assert.equal(owner.readiness({ ...query, env: { AGY_ACCOUNT: "other" } }, true), undefined);
    reject(new Error("SIMULATED unavailable"));
    await rejected;
    assert.equal(owner.readiness(query, true), undefined);
    const recovered = owner.models(ctx);
    await tick(); pending!(nextRows); await recovered;
    assert.equal(owner.readiness(query, true), undefined);
    assert.ok(owner.readiness({ ...query, modelId: "next" }, true));
    owner.stop();
    assert.equal(owner.readiness({ ...query, modelId: "next" }, true), undefined);
  } finally { owner.stop(); }
});
