import assert from "node:assert/strict";
import test from "node:test";
import {
  AntigravitySessionBindings,
  type AntigravitySessionRuntime,
  type AntigravityOpenClawSession,
} from "../src/harness/session-bindings.ts";

type Entry = { sessionId: string; lifecycleRevision: string; pluginExtensions?: Record<string, unknown> };
const identity = { openclawSessionId: "session-1", openclawSessionKey: "agent:main:child:1", agentId: "main", storePath: "/fixture/canonical.sqlite" };
const modelId = "gemini-3.8-flash-high";
const scopeKey = "fixture:account-a:runtime-a:project-a";
const qualifiedFixture = { atomicMutation: { evidence: "SIMULATED atomic snapshot/commit fixture; not host P05 qualification" } };
const noOp = () => {};
const key = (p: { sessionKey: string; agentId?: string; storePath?: string }) => JSON.stringify([p.storePath, p.agentId, p.sessionKey]);
const identityKey = (p: AntigravityOpenClawSession) => key({ sessionKey: p.openclawSessionKey!, agentId: p.agentId, storePath: p.storePath });
function createRuntime() {
  const rows = new Map<string, Entry>();
  let beforeCommit: (() => void | Promise<void>) | undefined;
  const runtime = {
    getSessionEntry(p: { sessionKey: string; agentId?: string; storePath?: string }) {
      const row = rows.get(key(p));
      return row ? structuredClone(row) : undefined;
    },
    listSessionEntries() { throw new Error("must never infer canonical authority by listing/default selection"); },
    async patchSessionEntry(p: { sessionKey: string; agentId?: string; storePath?: string; assertCommitAllowed?: () => void;
      update: (row: Entry) => Partial<Entry> | null | Promise<Partial<Entry> | null> }) {
      const row = rows.get(key(p));
      if (!row) return null;
      const snapshot = JSON.stringify(row);
      const patch = await p.update(structuredClone(row));
      await beforeCommit?.();
      // This fixture models a host transaction; it does not establish real
      // host cross-process behavior. Competing snapshots never overwrite.
      if (JSON.stringify(rows.get(key(p))) !== snapshot) throw new Error("SIMULATED host snapshot conflict");
      p.assertCommitAllowed?.();
      const next = patch ? { ...row, ...structuredClone(patch) } : row;
      rows.set(key(p), next);
      return structuredClone(next);
    },
  } as unknown as AntigravitySessionRuntime;
  const bindings = new AntigravitySessionBindings(runtime, qualifiedFixture);
  const set = (p = identity, entry: Entry = { sessionId: p.openclawSessionId, lifecycleRevision: "host-generation-1" }) => rows.set(identityKey(p), entry);
  const get = (p = identity) => rows.get(identityKey(p))!;
  set();
  return { runtime, rows, bindings, set, get, beforeCommit: (callback?: () => void | Promise<void>) => { beforeCommit = callback; } };
}
async function begin(f: ReturnType<typeof createRuntime>, extra = {}) {
  return f.bindings.beginAttempt({ ...identity, modelId, scopeKey, assertActive: noOp, ...extra });
}
async function bind(f: ReturnType<typeof createRuntime>, lease: Awaited<ReturnType<typeof begin>>, conversationId = "conversation-1") {
  return f.bindings.bindFresh({ ...identity, conversationId, modelId, lease });
}

test("fresh/resume binding survives instance restart in canonical metadata and preserves unrelated slots", async () => {
  const f = createRuntime();
  f.get().pluginExtensions = { other: { keep: true } };
  const first = await begin(f);
  assert.equal(first.binding, undefined);
  const binding = await bind(f, first);
  assert.deepEqual(await bind(f, first), binding);
  await f.bindings.endAttempt(first, { terminationConfirmed: true });
  assert.throws(first.assertActive, /retired/);
  const restarted = new AntigravitySessionBindings(f.runtime, qualifiedFixture);
  assert.deepEqual(restarted.resolve(identity), binding);
  const resumed = await restarted.beginAttempt({ ...identity, modelId, scopeKey, assertActive: noOp });
  assert.deepEqual(resumed.binding, binding);
  assert.equal(resumed.epoch, first.epoch);
  assert.notEqual(resumed.token, first.token);
  assert.deepEqual(f.get().pluginExtensions?.other, { keep: true });
});

test("unknown host atomicity or canonical target blocks before claiming", async () => {
  const f = createRuntime();
  await assert.rejects(new AntigravitySessionBindings(f.runtime).beginAttempt({ ...identity, modelId, scopeKey, assertActive: noOp }), /qualified host cross-process/);
  for (const property of ["storePath", "agentId", "openclawSessionKey"]) {
    await assert.rejects(begin(f, { [property]: undefined }), /nonempty exact string/);
  }
  assert.equal(f.get().pluginExtensions, undefined);
});

test("missing host generation cannot create an invented baseline", async () => {
  const f = createRuntime();
  delete (f.get() as Partial<Entry>).lifecycleRevision;
  await assert.rejects(begin(f), /host lifecycle revision/);
  assert.equal(f.get().pluginExtensions, undefined);
});

test("model, project/account/runtime scope changes reject resume without altering metadata", async () => {
  const f = createRuntime();
  const lease = await begin(f); await bind(f, lease); await f.bindings.endAttempt(lease, { terminationConfirmed: true });
  const before = structuredClone(f.get());
  for (const extra of [{ modelId: "gemini-3.8-flash-low" }, { scopeKey: "fixture:account-b:runtime-a:project-a" }, { scopeKey: "fixture:account-a:runtime-a:project-b" }]) {
    await assert.rejects(begin(f, extra), /scope changed/);
    assert.deepEqual(f.get(), before);
  }
});

test("cross-project/session/store metadata cannot be copied into another canonical owner", async () => {
  const f = createRuntime(); const lease = await begin(f); await bind(f, lease);
  for (const alternate of [{ ...identity, storePath: "/other/canonical.sqlite" }, { ...identity, agentId: "other" }, { ...identity, openclawSessionKey: "agent:main:child:2" }, { ...identity, openclawSessionId: "session-2" }]) {
    f.set(alternate, { ...structuredClone(f.get()), sessionId: alternate.openclawSessionId });
    assert.throws(() => f.bindings.resolve(alternate), /invalid ANTIGRAVITY/);
  }
});

test("simultaneous process-like claim snapshots admit exactly one writer; interrupted claims survive restart", async () => {
  const f = createRuntime();
  const independent = new AntigravitySessionBindings(f.runtime, qualifiedFixture);
  const results = await Promise.allSettled([begin(f), independent.beginAttempt({ ...identity, modelId, scopeKey, assertActive: noOp })]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  await assert.rejects(independent.beginAttempt({ ...identity, modelId, scopeKey, assertActive: noOp }), /active or interrupted attempt/);
});

test("uncertain termination retains durable claim and revokes callbacks", async () => {
  const f = createRuntime(); const lease = await begin(f); await bind(f, lease);
  await f.bindings.endAttempt(lease, { terminationConfirmed: false });
  assert.throws(lease.assertActive, /retired/);
  await assert.rejects(begin(f), /active or interrupted attempt/);
});

test("stale init cannot write after reset and reset keeps epoch tombstone", async () => {
  const f = createRuntime(); const lease = await begin(f); await bind(f, lease);
  let observedRevocation = false;
  assert.equal(await f.bindings.clear({ ...identity, cancelAndDrain: async () => {
    assert.throws(lease.assertActive, /stale/);
    assert.throws(() => f.bindings.resolve(identity), /reset is pending/);
    observedRevocation = true;
  } }), true);
  assert.equal(observedRevocation, true);
  assert.equal(f.bindings.resolve(identity), undefined);
  const envelope = f.get().pluginExtensions?.antigravity as Record<string, unknown>;
  assert.notEqual(envelope.epoch, lease.epoch);
  assert.equal(envelope.binding, undefined);
  await assert.rejects(bind(f, lease, "stale-conversation"), /stale/);
  const successor = await begin(f);
  assert.notEqual(successor.epoch, lease.epoch);
  assert.equal(successor.binding, undefined);
});

test("physical delete/recreate never resurrects old callback even with reused host generation", async () => {
  const f = createRuntime(); const old = await begin(f);
  f.set();
  const next = await begin(f);
  assert.notEqual(next.epoch, old.epoch);
  await assert.rejects(bind(f, old), /stale/);
});

test("failed host drain keeps reset pending and blocks fresh/resume", async () => {
  const f = createRuntime(); const lease = await begin(f); await bind(f, lease);
  await assert.rejects(f.bindings.clear({ ...identity, cancelAndDrain: async () => { throw new Error("drain failed"); } }), /drain failed/);
  await assert.rejects(begin(f), /reset is pending/);
  assert.throws(lease.assertActive, /stale/);
  await assert.rejects(f.bindings.clear({ ...identity, cancelAndDrain: async () => {} }), /reset already pending/);
});

test("reset requires host cancellation/drain and preserves other sessions/extensions", async () => {
  const f = createRuntime(); f.get().pluginExtensions = { other: { keep: true } };
  const lease = await begin(f); await bind(f, lease);
  const otherIdentity = { ...identity, openclawSessionKey: "agent:main:child:2", openclawSessionId: "session-2" };
  f.set(otherIdentity); const other = structuredClone(f.get(otherIdentity));
  await assert.rejects(f.bindings.clear(identity), /qualified host cancellation\/drain/);
  await f.bindings.clear({ ...identity, cancelAndDrain: async () => {} });
  assert.deepEqual(f.get(otherIdentity), other);
  assert.deepEqual(f.get().pluginExtensions?.other, { keep: true });
});

test("ownership lost after async update but before commit cannot persist stale init", async () => {
  const f = createRuntime(); let active = true;
  const lease = await begin(f, { assertActive: () => { if (!active) throw new Error("host owner retired"); } });
  const before = structuredClone(f.get());
  f.beforeCommit(() => { active = false; });
  await assert.rejects(bind(f, lease), /host owner retired/);
  assert.deepEqual(f.get(), before);
});

test("host lifecycle revision change fences existing callbacks and rejects stored resume", async () => {
  const f = createRuntime(); const lease = await begin(f); await bind(f, lease);
  f.get().lifecycleRevision = "host-generation-2";
  assert.throws(lease.assertActive, /invalid ANTIGRAVITY/);
  assert.throws(() => f.bindings.resolve(identity), /explicit host reset/);
});

test("fresh bind validates exact init model/conversation and cannot switch an existing conversation", async () => {
  const f = createRuntime(); const lease = await begin(f);
  await assert.rejects(f.bindings.bindFresh({ ...identity, modelId: "other-model", conversationId: "conversation-1", lease }), /init model/);
  await assert.rejects(bind(f, lease, " conversation-1 "), /nonempty exact string/);
  await bind(f, lease);
  await assert.rejects(bind(f, lease, "conversation-2"), /different AGY conversation/);
});

test("present malformed and legacy metadata rejects unchanged until explicitly reset", async () => {
  const baseline = createRuntime(); const lease = await begin(baseline); await bind(baseline, lease);
  const good = structuredClone(baseline.get().pluginExtensions?.antigravity) as Record<string, unknown>;
  const b = good.binding as Record<string, unknown>;
  const malformed = [null, [], "corrupt", 42, true, undefined,
    { schema: "antigravity-native-session-binding/v1", harnessId: "antigravity", openclawSessionId: "session-1", conversationId: "legacy", modelId },
    { ...good, epoch: "" }, { ...good, resetPending: false }, { ...good, binding: null },
    { ...good, activeAttempt: [] }, { ...good, binding: { ...b, modelId: 3 } },
    { ...good, binding: { ...b, conversationId: " " } }, { ...good, binding: { ...b, epoch: "wrong-epoch" } },
    { ...good, binding: { ...b, openclawSessionKey: "wrong-key" } }, { ...good, extraneousScope: "unexpected" },
    { ...good, binding: { ...b, modelID: modelId } }];
  for (const bad of malformed) {
    const f = createRuntime(); f.get().pluginExtensions = { other: { keep: true }, antigravity: bad };
    const before = structuredClone(f.get());
    assert.throws(() => f.bindings.resolve(identity), /invalid ANTIGRAVITY/);
    await assert.rejects(begin(f), /invalid ANTIGRAVITY/);
    assert.deepEqual(f.get(), before);
    assert.equal(await f.bindings.clear({ ...identity, cancelAndDrain: async () => {} }), true);
    assert.equal(f.bindings.resolve(identity), undefined);
    assert.deepEqual(f.get().pluginExtensions?.other, { keep: true });
  }
});


test("failed persistence never fabricates a successful binding from the attempted value", async () => {
  const f = createRuntime(); const lease = await begin(f);
  const original = f.runtime.patchSessionEntry;
  f.runtime.patchSessionEntry = async () => null;
  await assert.rejects(bind(f, lease), /failed to persist.*do not retry native inference/);
  assert.equal(f.bindings.resolve(identity), undefined);
  f.runtime.patchSessionEntry = original;
});

test("a competing canonical write between preparation and commit cannot be overwritten", async () => {
  const f = createRuntime(); const lease = await begin(f);
  f.beforeCommit(() => { f.get().pluginExtensions = { ...f.get().pluginExtensions, other: { concurrent: true } }; });
  await assert.rejects(bind(f, lease), /snapshot conflict/);
  assert.equal(f.bindings.resolve(identity), undefined);
  assert.deepEqual(f.get().pluginExtensions?.other, { concurrent: true });
});


test("settled final-result fence survives callback retirement and is revoked by another attempt", async () => {
  const f = createRuntime(); const lease = await begin(f); await bind(f, lease);
  assert.throws(() => f.bindings.assertResultCurrent(lease), /not settled/);
  await f.bindings.endAttempt(lease, { terminationConfirmed: true });
  assert.throws(lease.assertActive, /retired/);
  f.bindings.assertResultCurrent(lease);
  const next = await begin(f);
  assert.throws(() => f.bindings.assertResultCurrent(lease), /delivery revoked/);
  await f.bindings.endAttempt(next, { terminationConfirmed: true });
  assert.throws(() => f.bindings.assertResultCurrent(lease), /delivery revoked/);
  f.bindings.assertResultCurrent(next);
});

test("reset and binding mismatch revoke delayed final-result delivery", async () => {
  const f = createRuntime(); const lease = await begin(f); await bind(f, lease);
  await f.bindings.endAttempt(lease, { terminationConfirmed: true });
  const envelope = f.get().pluginExtensions?.antigravity as { binding: { conversationId: string } };
  envelope.binding.conversationId = "another-conversation";
  assert.throws(() => f.bindings.assertResultCurrent(lease), /invalid ANTIGRAVITY/);
  envelope.binding.conversationId = "conversation-1";
  await f.bindings.clear({ ...identity, cancelAndDrain: async () => { assert.throws(() => f.bindings.assertResultCurrent(lease), /delivery revoked/); } });
  assert.throws(() => f.bindings.assertResultCurrent(lease), /delivery revoked/);
});


test("retired cleanup cannot publish a delayed settled-attempt commit", async () => {
  const f = createRuntime(); const lease = await begin(f); await bind(f, lease);
  const before = structuredClone(f.get());
  let releaseCommit!: () => void;
  let markPrepared!: () => void;
  const commitReleased = new Promise<void>((resolve) => { releaseCommit = resolve; });
  const prepared = new Promise<void>((resolve) => { markPrepared = resolve; });
  f.beforeCommit(async () => { markPrepared(); await commitReleased; });
  let cleanupActive = true;
  const settling = f.bindings.endAttempt(lease, { terminationConfirmed: true, assertCommitAllowed: () => {
    if (!cleanupActive) throw new Error("cleanup ownership retired");
  } });
  await prepared;
  cleanupActive = false;
  releaseCommit();
  await assert.rejects(settling, /cleanup ownership retired/);
  assert.deepEqual(f.get(), before);
  assert.throws(() => f.bindings.assertResultCurrent(lease), /not settled/);
  assert.throws(lease.assertActive, /retired/);
});


test("reset deadline retains pending tombstone and late drain cannot clear it", async () => {
  const f = createRuntime(); const lease = await begin(f); await bind(f, lease);
  let releaseDrain!: () => void;
  let markDrainStarted!: () => void;
  let drainFinished = false;
  const drainReleased = new Promise<void>((resolve) => { releaseDrain = resolve; });
  const drainStarted = new Promise<void>((resolve) => { markDrainStarted = resolve; });
  const reset = f.bindings.clear({ ...identity, timeoutMs: 30, cancelAndDrain: async () => {
    markDrainStarted(); await drainReleased; drainFinished = true;
  } });
  const rejection = assert.rejects(reset, /reset timed out.*late metadata commits are revoked/);
  await drainStarted;
  await rejection;
  const pending = structuredClone(f.get());
  assert.throws(() => f.bindings.resolve(identity), /reset is pending/);
  await assert.rejects(begin(f), /reset is pending/);
  releaseDrain();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drainFinished, true, "timeout does not pretend the external callback stopped");
  assert.deepEqual(f.get(), pending);
  assert.throws(() => f.bindings.resolve(identity), /reset is pending/);
  assert.throws(lease.assertActive, /stale/);
});

test("reset deadline fences a delayed host final commit", async () => {
  const f = createRuntime(); const lease = await begin(f); await bind(f, lease);
  let releaseCommit!: () => void;
  let markFinalPrepared!: () => void;
  const commitReleased = new Promise<void>((resolve) => { releaseCommit = resolve; });
  const finalPrepared = new Promise<void>((resolve) => { markFinalPrepared = resolve; });
  let commits = 0;
  f.beforeCommit(async () => { if (++commits === 2) { markFinalPrepared(); await commitReleased; } });
  const reset = f.bindings.clear({ ...identity, timeoutMs: 30, cancelAndDrain: async () => {} });
  const rejection = assert.rejects(reset, /reset timed out/);
  await finalPrepared;
  await rejection;
  const pending = structuredClone(f.get());
  releaseCommit();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(f.get(), pending);
  assert.throws(() => f.bindings.resolve(identity), /reset is pending/);
});

test("reset budget cannot be disabled or widened past the shared maximum", async () => {
  const f = createRuntime(); const before = structuredClone(f.get());
  for (const timeoutMs of [0, -1, Infinity, NaN, 6_001]) {
    await assert.rejects(f.bindings.clear({ ...identity, timeoutMs, cancelAndDrain: async () => {} }), /finite, positive and at most 6000/);
  }
  assert.deepEqual(f.get(), before);
});
