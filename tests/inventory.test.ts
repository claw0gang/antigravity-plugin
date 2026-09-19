import assert from "node:assert/strict";
import test from "node:test";
import { AgyProcessError } from "../src/cli/agy-process.ts";
import { createInvocationScope, InvocationScopeError, type InvocationScope, type InvocationScopeOptions } from "../src/cli/invocation-scope.ts";
import { AgyInventoryError, AgyInventoryService, MAX_INVENTORY_FRESHNESS_MS } from "../src/inventory.ts";
import { AgyModelDiscoveryError, discoverAgyModels, type AgyDiscoveredModel } from "../src/harness/model-catalog.ts";

function scope(options: Partial<InvocationScopeOptions> = {}): InvocationScope {
  return createInvocationScope({ command: process.execPath, cwd: process.cwd(), env: {}, timeoutMs: 5000,
    owner: { hostGeneration: "fixture-owner", agentId: "agent-a" }, scopeKey: "non-secret-fixture-scope", ...options });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const model = (id: string): AgyDiscoveredModel => ({ id, name: `Name ${id}` });
const turn = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };

test("authoritative additions, withdrawals and successful empty replace cache; admission is always fresh", async () => {
  let rows = [model("Exact/Old:ID")];
  let calls = 0;
  let now = 100;
  const inventory = new AgyInventoryService({ now: () => now, discoverModels: async () => { calls++; return rows; } });
  const authority = scope();
  const first = await inventory.get({ scope: authority });
  assert.deepEqual(first, rows);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first[0]), true);
  rows = [model("Exact/New:ID")];
  assert.deepEqual(await inventory.get({ scope: scope() }), first);
  assert.equal(calls, 1);
  assert.deepEqual(await inventory.get({ scope: authority, fresh: true }), rows);
  rows = [];
  assert.deepEqual(await inventory.get({ scope: authority, fresh: true }), []);
  assert.deepEqual(await inventory.get({ scope: authority }), []);
  rows = [model("AfterTTL")];
  now += MAX_INVENTORY_FRESHNESS_MS;
  assert.deepEqual(await inventory.get({ scope: authority }), rows);
  assert.equal(calls, 4);
  inventory.stop();
});

test("authentication, malformed, conflicting and cap errors never become empty or renewed readiness", async () => {
  for (const failure of [
    { exitCode: 1, stdout: "", stderr: "secret authentication details" },
    { exitCode: 0, stdout: '{"models":', stderr: "" },
    { exitCode: 0, stdout: '[{"id":"a","name":"A"},{"id":"a","name":"B"}]', stderr: "" },
    { exitCode: 0, stdout: JSON.stringify(Array.from({ length: 5001 }, () => ({ id: "same", name: "Same" }))), stderr: "" },
    { exitCode: 0, stdout: "", stderr: "x".repeat(2097153) },
  ]) {
    let calls = 0;
    const inventory = new AgyInventoryService({ discoverModels: async (params) => {
      calls++;
      return discoverAgyModels({ ...params, execute: async () => calls === 1
        ? { exitCode: 0, stdout: '[{"id":"a","name":"A"}]', stderr: "" } : failure });
    } });
    const authority = scope();
    assert.equal((await inventory.get({ scope: authority })).length, 1);
    await assert.rejects(inventory.get({ scope: authority, fresh: true }), (error: Error) => {
      assert.equal(error.message.includes("secret"), false);
      return /acquisition failed/.test(error.message);
    });
    await assert.rejects(inventory.get({ scope: authority }), /acquisition failed/);
    assert.equal(calls, 3);
    inventory.stop();
  }
});

test("every effective authority dimension isolates acquisition; environment insertion order does not", async () => {
  let calls = 0;
  const inventory = new AgyInventoryService({ discoverModels: async () => [model(String(++calls))] });
  const base = scope({ env: { A: "one", SECRET_TOKEN: "sensitive-value" } });
  assert.deepEqual(await inventory.get({ scope: base }), [model("1")]);
  assert.deepEqual(await inventory.get({ scope: scope({ env: { SECRET_TOKEN: "sensitive-value", A: "one" } }) }), [model("1")]);
  const mutations: InvocationScope[] = [
    Object.freeze({ ...base, command: "/different/resolved/agy" }),
    Object.freeze({ ...base, cwd: "/other/workspace" }),
    scope({ env: { A: "one", SECRET_TOKEN: "different" } }),
    Object.freeze({ ...base, env: Object.freeze({ A: "one" }) }),
    Object.freeze({ ...base, owner: Object.freeze({ ...base.owner, hostGeneration: "other-owner" }) }),
    Object.freeze({ ...base, owner: Object.freeze({ ...base.owner, agentId: "agent-b" }) }),
    Object.freeze({ ...base, projectSelection: Object.freeze({ project: "different-project" }) }),
    Object.freeze({ ...base, projectSelection: Object.freeze({ newProject: true }) }),
    Object.freeze({ ...base, addDirs: Object.freeze(["/other-directory"]) }),
    Object.freeze({ ...base, nativeAgentSelection: "different-native-agent" }),
    Object.freeze({ ...base, scopeKey: "different-auth-generation" }),
  ];
  for (const changed of mutations) {
    const previous = calls;
    assert.deepEqual(await inventory.get({ scope: changed }), [model(String(previous + 1))]);
  }
  assert.equal(calls, 12);
  assert.equal(JSON.stringify(inventory).includes("sensitive"), false);
  inventory.stop();
});

test("equivalent overlapping acquisitions coalesce while separate authorities execute independently", async () => {
  let calls = 0;
  const results = [deferred<AgyDiscoveredModel[]>(), deferred<AgyDiscoveredModel[]>()];
  const inventory = new AgyInventoryService({ discoverModels: async () => results[calls++]!.promise });
  const first = inventory.get({ scope: scope(), fresh: true });
  const same = inventory.get({ scope: scope(), fresh: true });
  const separate = inventory.get({ scope: scope({ nativeAgentSelection: "agent-b" }), fresh: true });
  await turn();
  assert.equal(calls, 2);
  results[0]!.resolve([model("shared")]);
  results[1]!.resolve([model("other")]);
  assert.deepEqual(await first, [model("shared")]);
  assert.equal(await same, await first);
  assert.deepEqual(await separate, [model("other")]);
  inventory.stop();
});

test("one canceled coalesced caller cannot cancel another current authority; all canceled abort native work", async () => {
  const result = deferred<AgyDiscoveredModel[]>();
  let acquisition: InvocationScope | undefined;
  const inventory = new AgyInventoryService({ discoverModels: async (params) => { acquisition = params!.scope; return result.promise; } });
  const controller = new AbortController();
  const canceled = inventory.get({ scope: scope({ signal: controller.signal }), fresh: true });
  const canceledRejection = assert.rejects(canceled, /caller was aborted/);
  const survivor = inventory.get({ scope: scope(), fresh: true });
  await turn();
  controller.abort();
  await canceledRejection;
  assert.equal(acquisition!.signal!.aborted, false);
  acquisition!.assertActive();
  result.resolve([model("survivor")]);
  assert.deepEqual(await survivor, [model("survivor")]);
  inventory.stop();

  const ignored = deferred<AgyDiscoveredModel[]>();
  let calls = 0;
  let abortedSignal: AbortSignal | undefined;
  const blocked = new AgyInventoryService({ discoverModels: async (params) => { calls++; abortedSignal = params!.scope!.signal; return ignored.promise; } });
  const all = new AbortController();
  const request = blocked.get({ scope: scope({ signal: all.signal }), fresh: true });
  const rejection = assert.rejects(request, /caller was aborted/);
  await turn();
  all.abort();
  await rejection;
  assert.equal(abortedSignal!.aborted, true);
  await assert.rejects(blocked.get({ scope: scope(), fresh: true }), /still retiring/);
  assert.equal(calls, 1);
  ignored.resolve([model("late")]);
  await turn();
  blocked.stop();
});

test("caller deadlines and lifecycle retirement reject promptly even when discovery ignores cancellation", async () => {
  for (const retire of ["timeout", "invalidate", "stop"] as const) {
    const late = deferred<AgyDiscoveredModel[]>();
    let calls = 0;
    let discoverySignal: AbortSignal | undefined;
    const inventory = new AgyInventoryService({ discoverModels: async (params) => {
      discoverySignal = params!.scope!.signal;
      return ++calls === 1 ? late.promise : [model("new-generation")];
    } });
    const authority = scope();
    const pending = inventory.get({ scope: authority, timeoutMs: retire === "timeout" ? 20 : 500 });
    const rejection = assert.rejects(pending, /deadline expired|generation was retired/);
    await turn();
    if (retire === "invalidate") inventory.invalidate();
    if (retire === "stop") inventory.stop();
    await rejection;
    assert.equal(discoverySignal!.aborted, true);
    late.resolve([model("stale-generation")]);
    await turn();
    if (retire === "stop") await assert.rejects(inventory.get({ scope: authority }), /owner has stopped/);
    else assert.deepEqual(await inventory.get({ scope: authority }), [model("new-generation")]);
    assert.equal(calls, retire === "stop" ? 1 : 2);
    inventory.stop();
  }
});

test("retired owner capability cannot populate readiness after acquisition completes", async () => {
  let active = true;
  const late = deferred<AgyDiscoveredModel[]>();
  const inventory = new AgyInventoryService({ discoverModels: async () => late.promise });
  const authority = scope({ assertActive: () => { if (!active) throw new Error("host owner retired"); } });
  const pending = inventory.get({ scope: authority });
  const rejection = assert.rejects(pending, /caller is no longer active/);
  await turn();
  active = false;
  late.resolve([model("too-late")]);
  await rejection;
  await assert.rejects(inventory.get({ scope: authority }), /caller is no longer active/);
  inventory.stop();
});

test("scope-specific invalidation preserves unrelated acquisitions and cache", async () => {
  const waits = [deferred<AgyDiscoveredModel[]>(), deferred<AgyDiscoveredModel[]>()];
  let calls = 0;
  const inventory = new AgyInventoryService({ discoverModels: async () => waits[calls++]!.promise });
  const one = scope();
  const two = scope({ nativeAgentSelection: "separate" });
  const retired = inventory.get({ scope: one });
  const rejection = assert.rejects(retired, /generation was retired/);
  const kept = inventory.get({ scope: two });
  await turn();
  inventory.invalidate(one);
  waits[0]!.resolve([model("late")]);
  waits[1]!.resolve([model("kept")]);
  await rejection;
  assert.deepEqual(await kept, [model("kept")]);
  assert.deepEqual(await inventory.get({ scope: two }), [model("kept")]);
  assert.equal(calls, 2);
  inventory.stop();
});

test("bounded capacity evicts settled LRU entries and never overlaps unsettled retiring acquisitions", async () => {
  let calls = 0;
  const inventory = new AgyInventoryService({ maxScopes: 2, discoverModels: async () => [model(String(++calls))] });
  await inventory.get({ scope: scope({ scopeKey: "one" }) });
  await inventory.get({ scope: scope({ scopeKey: "two" }) });
  await inventory.get({ scope: scope({ scopeKey: "three" }) });
  assert.deepEqual(await inventory.get({ scope: scope({ scopeKey: "one" }) }), [model("4")]);
  inventory.stop();
  const late = deferred<AgyDiscoveredModel[]>();
  const blocked = new AgyInventoryService({ maxScopes: 1, discoverModels: async () => late.promise });
  const pending = blocked.get({ scope: scope({ scopeKey: "one" }), timeoutMs: 20 });
  const rejection = assert.rejects(pending, /deadline expired/);
  await turn();
  await assert.rejects(blocked.get({ scope: scope({ scopeKey: "two" }) }), /capacity/);
  await rejection;
  await assert.rejects(blocked.get({ scope: scope({ scopeKey: "two" }) }), /capacity/);
  late.resolve([]);
  await turn();
  blocked.stop();
});

test("acquisition reentry fails without a callback cycle, repeated discovery, or an operation timeout", async () => {
  let calls = 0;
  const authority = scope();
  const inventory = new AgyInventoryService({ discoverModels: async () => {
    calls++;
    return [...await inventory.get({ scope: authority, fresh: true })];
  } });
  await assert.rejects(inventory.get({ scope: authority }), /acquisition failed/);
  assert.equal(calls, 1);
  inventory.stop();
});

test("invalid budgets and pre-aborted authority never invoke discovery", async () => {
  let calls = 0;
  const inventory = new AgyInventoryService({ discoverModels: async () => { calls++; return []; } });
  for (const timeoutMs of [0, -1, Infinity, NaN, 10001]) {
    await assert.rejects(inventory.get({ scope: scope(), timeoutMs }), /at most 10000ms/);
  }
  const controller = new AbortController();
  const authority = scope({ signal: controller.signal });
  controller.abort();
  await assert.rejects(inventory.get({ scope: authority }), /caller is no longer active/);
  assert.equal(calls, 0);
  assert.throws(() => new AgyInventoryService({ freshnessMs: 60001 }), /at most 60s/);
  assert.throws(() => new AgyInventoryService({ maxScopes: 65 }), /1–64/);
  inventory.stop();
});

test("retired acquisition cleanup cannot evict or overlap a replacement in settlement microtasks", async () => {
  const old = deferred<AgyDiscoveredModel[]>();
  const replacement = deferred<AgyDiscoveredModel[]>();
  let calls = 0;
  const inventory = new AgyInventoryService({ discoverModels: async () => ++calls === 1 ? old.promise : replacement.promise });
  const controller = new AbortController();
  const first = inventory.get({ scope: scope({ signal: controller.signal }), fresh: true });
  const rejection = assert.rejects(first, /caller was aborted/);
  await turn();
  controller.abort();
  await rejection;
  old.resolve([model("retired")]);
  const joins: Array<Promise<readonly AgyDiscoveredModel[] | null>> = [];
  for (let i = 0; i < 30; i++) {
    joins.push(inventory.get({ scope: scope(), fresh: true }).catch(() => null));
    await Promise.resolve();
  }
  assert.equal(calls, 2);
  replacement.resolve([model("current")]);
  const outcomes = await Promise.all(joins);
  assert.ok(outcomes.some((rows) => rows?.[0]?.id === "current"));
  assert.ok(outcomes.every((rows) => rows === null || rows[0]?.id === "current"));
  assert.deepEqual(await inventory.get({ scope: scope() }), [model("current")]);
  assert.equal(calls, 2);
  inventory.stop();
});

test("recognized scoped and native timeout/cancellation retain terminal meaning without diagnostic leakage", async () => {
  for (const [cause, kind] of [
    [new InvocationScopeError("timeout", "secret scope diagnostic"), "timeout"],
    [new InvocationScopeError("aborted", "secret scope diagnostic"), "aborted"],
    [new AgyModelDiscoveryError("secret discovery diagnostic", { cause: new AgyProcessError("timeout", "secret native diagnostic") }), "timeout"],
    [new AgyModelDiscoveryError("secret discovery diagnostic", { cause: new AgyProcessError("native_timeout", "secret native diagnostic") }), "timeout"],
    [new AgyModelDiscoveryError("secret discovery diagnostic", { cause: new AgyProcessError("aborted", "secret native diagnostic") }), "aborted"],
    [new Error("unknown timeout-shaped secret diagnostic"), "unavailable"],
  ] as const) {
    const inventory = new AgyInventoryService({ discoverModels: async () => { throw cause; } });
    await assert.rejects(inventory.get({ scope: scope() }), (error: unknown) => {
      assert.ok(error instanceof AgyInventoryError);
      assert.equal(error.kind, kind);
      assert.equal(error.message.includes("secret"), false);
      assert.equal(error.cause, undefined);
      return true;
    });
    inventory.stop();
  }

  const inventory = new AgyInventoryService({ discoverModels: async () => [] });
  const expired = Object.freeze({ ...scope(), assertActive: () => { throw new InvocationScopeError("timeout", "private deadline"); } });
  await assert.rejects(inventory.get({ scope: expired }), (error: unknown) => error instanceof AgyInventoryError && error.kind === "timeout");
  inventory.stop();
});

test("scope deadline detected at settlement retains timeout even before its waiter timer runs", async () => {
  let expired = false;
  const delayed = deferred<AgyDiscoveredModel[]>();
  const inventory = new AgyInventoryService({ discoverModels: async () => delayed.promise });
  const authority = Object.freeze({ ...scope(), assertActive: () => { if (expired) throw new InvocationScopeError("timeout", "private deadline"); } });
  const pending = inventory.get({ scope: authority });
  const rejection = assert.rejects(pending, (error: unknown) => error instanceof AgyInventoryError && error.kind === "timeout");
  await turn();
  expired = true;
  delayed.resolve([model("too-late")]);
  await rejection;
  inventory.stop();
});
