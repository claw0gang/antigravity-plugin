import assert from "node:assert/strict";
import test from "node:test";

import {
  AntigravitySessionBindings,
} from "../src/harness/session-bindings.ts";
import {
  createAntigravitySessionRuntime,
  guardSessionAuthority,
  inspectSessionRuntime,
  projectOpenClawSessionGeneration,
  SessionSnapshotStaleError,
  sessionPatchAuthority,
  type AntigravitySessionRuntime,
  type OpenClawSessionRuntimeInput,
  type SessionOwnerAssertion,
} from "../src/host/session-runtime.ts";

type Entry = NonNullable<Awaited<ReturnType<AntigravitySessionRuntime["getSessionEntryAsync"]>>>;
type PatchParams = Parameters<AntigravitySessionRuntime["prepareSessionEntryPatch"]>[0];
type PatchContext = Parameters<PatchParams["prepare"]>[1];
type LegacyPatchParams = Parameters<NonNullable<OpenClawSessionRuntimeInput["patchSessionEntry"]>>[0];

const identity = {
  openclawSessionId: "session-1",
  openclawSessionKey: "agent:main:test",
  agentId: "main",
  storePath: "/fixture/canonical.sqlite",
};
const qualified = {
  atomicMutation: {
    evidence: "SIMULATED atomic snapshot/commit fixture; not host P05 qualification",
  },
};

function legacyEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    sessionId: identity.openclawSessionId,
    updatedAt: 1_700_000_000_100,
    sessionStartedAt: 1_700_000_000_000,
    ...overrides,
  } as Entry;
}

function createRawRuntime(initial = legacyEntry(), patchContext?: PatchContext) {
  let row = structuredClone(initial);
  const runtime = {
    getSessionEntry() {
      return structuredClone(row);
    },
    listSessionEntries() {
      return [{ sessionKey: identity.openclawSessionKey, entry: structuredClone(row) }];
    },
    async patchSessionEntry(params: LegacyPatchParams) {
      const patch = await params.update(
        structuredClone(row),
        patchContext ?? { existingEntry: structuredClone(row) },
      );
      params.assertCommitAllowed?.();
      if (patch) row = { ...row, ...structuredClone(patch) };
      return structuredClone(row);
    },
  } satisfies OpenClawSessionRuntimeInput;
  return {
    runtime,
    getRaw: () => row,
    replace(next: Entry) { row = structuredClone(next); },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Simulates the public prepare contract; it is not native SDK execution. */
function createAwaitedRuntime(initial = legacyEntry()) {
  let row = structuredClone(initial);
  let beforeCommit: (() => void | Promise<void>) | undefined;
  const runtime = {
    async getSessionEntryAsync() { return structuredClone(row); },
    async withSessionEntriesAsync<T>(params: { stores: readonly { agentId: string; storePath: string; sessionKeys: readonly string[] }[] },
      consume: (entries: Array<{ agentId: string; storePath: string; sessionKey: string; entry: Entry }>) => T) {
      return consume(params.stores.flatMap((store) => store.sessionKeys.map((sessionKey) => ({
        agentId: store.agentId, storePath: store.storePath, sessionKey, entry: structuredClone(row),
      }))));
    },
    async listSessionEntriesAsync() {
      return [{ sessionKey: identity.openclawSessionKey, entry: structuredClone(row) }];
    },
    async prepareSessionEntryPatch(params: PatchParams) {
      const captured = structuredClone(row);
      const snapshot = JSON.stringify(captured);
      const prepared = params.authority?.kind === "source"
        ? await params.authority.source.prepareSessionSource() : undefined;
      const assertOwner = () => {
        if (params.authority?.kind === "host") params.authority.assertCurrent();
        prepared?.assertCurrent();
      };
      try {
        assertOwner();
        const patch = await params.prepare(captured, { existingEntry: structuredClone(captured) });
        await beforeCommit?.();
        assert.equal(JSON.stringify(row), snapshot, "SIMULATED captured-entry conflict");
        assertOwner();
        if (patch) row = { ...row, ...structuredClone(patch) };
        return structuredClone(row);
      } finally {
        await prepared?.release?.();
      }
    },
  } satisfies OpenClawSessionRuntimeInput;
  return {
    runtime,
    getRaw: () => row,
    replace(next: Entry) { row = structuredClone(next); },
    beforeCommit(callback: () => void | Promise<void>) { beforeCommit = callback; },
  };
}

test("real OpenClaw lifecycle revision remains authoritative", () => {
  const entry = legacyEntry({ lifecycleRevision: "host-generation-1" });
  assert.equal(projectOpenClawSessionGeneration(entry), entry);
  assert.equal(projectOpenClawSessionGeneration(entry).lifecycleRevision, "host-generation-1");
});

test("legacy OpenClaw row receives a stable generation from session id and session start", () => {
  const entry = legacyEntry();
  const first = projectOpenClawSessionGeneration(entry);
  const second = projectOpenClawSessionGeneration(structuredClone(entry));
  assert.equal(entry.lifecycleRevision, undefined);
  assert.match(first.lifecycleRevision ?? "", /^antigravity:openclaw-legacy-session\/v1:[0-9a-f]{64}$/u);
  assert.equal(second.lifecycleRevision, first.lifecycleRevision);

  const reset = projectOpenClawSessionGeneration(legacyEntry({ sessionStartedAt: 1_700_000_000_001 }));
  assert.notEqual(reset.lifecycleRevision, first.lifecycleRevision);
});

test("legacy row without a valid session start remains unstamped and fails closed", async () => {
  for (const sessionStartedAt of [undefined, 0, -1, 1.5, Number.NaN]) {
    const raw = createRawRuntime(legacyEntry({ sessionStartedAt }));
    const projected = createAntigravitySessionRuntime(raw.runtime);
    assert.equal((await projected.getSessionEntryAsync({ sessionKey: identity.openclawSessionKey }))?.lifecycleRevision, undefined);
    const bindings = new AntigravitySessionBindings(projected, qualified);
    await assert.rejects(
      bindings.beginAttempt({
        ...identity,
        modelId: "gemini-3.8-flash-low",
        scopeKey: "fixture-scope",
        assertActive() {},
      }),
      /host lifecycle revision/u,
    );
    assert.equal(raw.getRaw().pluginExtensions, undefined);
  }
});

test("full entries and preparation project legacy generation while metadata listing does not", async () => {
  const raw = createRawRuntime();
  const projected = createAntigravitySessionRuntime(raw.runtime);
  const first = (await projected.getSessionEntryAsync({ sessionKey: identity.openclawSessionKey }))!;
  const listed = (await projected.listSessionEntriesAsync({ agentId: identity.agentId }))[0]!.entry;
  assert.equal(listed.lifecycleRevision, undefined);

  let callbackGeneration: string | undefined;
  const persisted = await projected.prepareSessionEntryPatch({
    sessionKey: identity.openclawSessionKey,
    prepare(entry, context) {
      callbackGeneration = entry.lifecycleRevision;
      assert.equal(context.existingEntry?.lifecycleRevision, callbackGeneration);
      return { pluginExtensions: { fixture: { ok: true } } };
    },
  });

  assert.equal(callbackGeneration, first.lifecycleRevision);
  assert.equal(persisted?.lifecycleRevision, first.lifecycleRevision);
  assert.equal(raw.getRaw().lifecycleRevision, undefined);
});

test("patch context projects its own existing row without mutating host context", async () => {
  for (const existingEntry of [
    legacyEntry({ sessionStartedAt: 1_700_000_000_500 }),
    legacyEntry({ lifecycleRevision: "host-generation-2" }),
    legacyEntry({ sessionStartedAt: 0 }),
  ]) {
    const context = Object.freeze({ existingEntry: Object.freeze(existingEntry), marker: "host-context" });
    const original = structuredClone(context);
    const raw = createRawRuntime(legacyEntry(), context);
    const projected = createAntigravitySessionRuntime(raw.runtime);
    await projected.prepareSessionEntryPatch({
      sessionKey: identity.openclawSessionKey,
      async prepare(entry, received) {
        assert.deepEqual(received, {
          ...context,
          existingEntry: projectOpenClawSessionGeneration(existingEntry),
        });
        assert.notEqual(received.existingEntry?.lifecycleRevision, entry.lifecycleRevision);
        return null;
      },
    });
    assert.deepEqual(context, original);
    assert.equal(raw.getRaw().lifecycleRevision, undefined);
  }
});

test("patch context without an existing row is forwarded without inventing one", async () => {
  const context: PatchContext = Object.freeze({});
  const raw = createRawRuntime(legacyEntry(), context);
  await createAntigravitySessionRuntime(raw.runtime).prepareSessionEntryPatch({
    sessionKey: identity.openclawSessionKey,
    prepare(entry, received) {
      assert.ok(entry.lifecycleRevision);
      assert.equal(received, context);
      assert.equal(Object.hasOwn(received, "existingEntry"), false);
      return null;
    },
  });
  assert.equal(raw.getRaw().lifecycleRevision, undefined);
});

test("simulated legacy session binds and resumes while reset successor cannot inherit its generation", async () => {
  const raw = createRawRuntime();
  const projected = createAntigravitySessionRuntime(raw.runtime);
  const bindings = new AntigravitySessionBindings(projected, qualified);
  const attempt = {
    ...identity,
    modelId: "gemini-3.8-flash-low",
    scopeKey: "fixture-scope",
    assertActive() {},
  };

  const first = await bindings.beginAttempt(attempt);
  const bound = await bindings.bindFresh({
    ...identity,
    conversationId: "conversation-1",
    modelId: attempt.modelId,
    lease: first,
  });
  await bindings.endAttempt(first, { terminationConfirmed: true });

  const restarted = new AntigravitySessionBindings(projected, qualified);
  assert.equal((await restarted.resolve(identity))?.conversationId, bound.conversationId);
  const resumed = await restarted.beginAttempt(attempt);
  assert.equal(resumed.binding?.conversationId, "conversation-1");
  await restarted.endAttempt(resumed, { terminationConfirmed: true });

  const oldGeneration = bound.lifecycleRevision;
  raw.replace(legacyEntry({
    sessionStartedAt: 1_700_000_000_500,
    pluginExtensions: undefined,
  }));
  const successorGeneration = (await projected.getSessionEntryAsync({ sessionKey: identity.openclawSessionKey }))!.lifecycleRevision;
  assert.notEqual(successorGeneration, oldGeneration);
  await assert.rejects(restarted.assertResultCurrent(resumed), /delivery revoked|invalid ANTIGRAVITY/u);

  const successor = await restarted.beginAttempt(attempt);
  assert.equal(successor.binding, undefined);
  assert.notEqual(successor.lifecycleRevision, oldGeneration);
});

test("complete modern surface is selected once and never retries a failed operation through legacy methods", async () => {
  let legacyCalls = 0;
  const failure = new Error("modern operation may already have committed");
  const calls = { read: 0, list: 0, prepare: 0 };
  const raw = {
    receiver: "original",
    async getSessionEntryAsync() {
      assert.equal(this.receiver, "original");
      calls.read++;
      throw failure;
    },
    async listSessionEntriesAsync() { calls.list++; throw failure; },
    async prepareSessionEntryPatch() { calls.prepare++; throw failure; },
    async withSessionEntriesAsync() { throw failure; },
    getSessionEntry() { legacyCalls++; return legacyEntry(); },
    listSessionEntries() { legacyCalls++; return []; },
    async patchSessionEntry() { legacyCalls++; return legacyEntry(); },
  } satisfies OpenClawSessionRuntimeInput & { receiver: string };
  assert.deepEqual(inspectSessionRuntime(raw), { kind: "awaited", missing: [] });
  const projected = createAntigravitySessionRuntime(raw);
  // Mutating the surface after selection must not replace the captured receiver/method.
  raw.getSessionEntryAsync = async () => { throw new Error("replacement must not execute"); };
  await assert.rejects(projected.getSessionEntryAsync({ sessionKey: identity.openclawSessionKey }), (error) => error === failure);
  await assert.rejects(projected.listSessionEntriesAsync({ agentId: identity.agentId }), (error) => error === failure);
  await assert.rejects(projected.prepareSessionEntryPatch({
    sessionKey: identity.openclawSessionKey,
    prepare: () => { throw new Error("unreached preparation"); },
  }), (error) => error === failure);
  assert.deepEqual(calls, { read: 1, list: 1, prepare: 1 });
  assert.equal(legacyCalls, 0);
});

test("partial modern runtime rejects before any host operation even when legacy APIs are complete", () => {
  for (const modernMethod of ["getSessionEntryAsync", "listSessionEntriesAsync", "prepareSessionEntryPatch"] as const) {
    let calls = 0;
    const refuse = () => { calls++; throw new Error("host operation must not start"); };
    const raw: OpenClawSessionRuntimeInput = {
      getSessionEntry: refuse,
      listSessionEntries: refuse,
      patchSessionEntry: refuse,
      [modernMethod]: refuse,
    };
    assert.equal(inspectSessionRuntime(raw).kind, "awaited");
    assert.equal(inspectSessionRuntime(raw).missing.length, 3);
    assert.throws(() => createAntigravitySessionRuntime(raw), /missing required session contracts/u);
    assert.equal(calls, 0);
  }
});

test("listing forwards only metadata options and preserves missing generation without hydration", async () => {
  for (const modern of [true, false]) {
    const captured: unknown[] = [];
    const metadata = legacyEntry();
    const list = (params: unknown) => {
      captured.push(params);
      return [{ sessionKey: identity.openclawSessionKey, entry: metadata }];
    };
    const raw: OpenClawSessionRuntimeInput = modern ? {
      ...createAwaitedRuntime().runtime,
      async listSessionEntriesAsync(params) { return list(params); },
    } : { ...createRawRuntime().runtime, listSessionEntries: list };
    const projected = createAntigravitySessionRuntime(raw);
    const env = { HOME: "/fixture/owner" };
    const request = {
      agentId: identity.agentId,
      storePath: identity.storePath,
      readConsistency: "latest" as const,
      env,
      readOnly: false,
      hydrateSkillPromptRefs: true,
      sessionKeys: ["must-not-be-forwarded"],
      captureSource() { throw new Error("must not capture listing as row authority"); },
    };
    const entries = await projected.listSessionEntriesAsync(request);
    assert.equal(entries[0]!.entry, metadata);
    assert.equal(entries[0]!.entry.lifecycleRevision, undefined);
    assert.deepEqual(captured, [{ agentId: identity.agentId, storePath: identity.storePath,
      readConsistency: "latest", env, ...(!modern ? { readOnly: true } : {}) }]);
    await assert.rejects(projected.listSessionEntriesAsync({ agentId: " " }), /explicit agentId/u);
    assert.equal(captured.length, 1);
  }
});

test("modern prepare rejects a competing write without replaying preparation or overwriting the winner", async () => {
  const raw = createAwaitedRuntime(legacyEntry({ lifecycleRevision: "host-generation-1" }));
  const projected = createAntigravitySessionRuntime(raw.runtime);
  const ready = deferred<void>();
  const proceed = deferred<void>();
  let prepared = 0;
  const pending = projected.prepareSessionEntryPatch({
    agentId: identity.agentId,
    storePath: identity.storePath,
    sessionKey: identity.openclawSessionKey,
    async prepare() {
      prepared++;
      ready.resolve();
      await proceed.promise;
      return { pluginExtensions: { antigravity: { writer: "stale" } } };
    },
  });
  await ready.promise;
  const winner = legacyEntry({ lifecycleRevision: "host-generation-1", pluginExtensions: { other: { writer: "winner" } } });
  raw.replace(winner);
  proceed.resolve();
  await assert.rejects(pending, /captured-entry conflict/u);
  assert.equal(prepared, 1);
  assert.deepEqual(raw.getRaw(), winner);
});

test("synthetic legacy lifecycle fields cannot be persisted by either selected adapter", async () => {
  for (const raw of [createRawRuntime(), createAwaitedRuntime()]) {
    const projected = createAntigravitySessionRuntime(raw.runtime);
    await assert.rejects(projected.prepareSessionEntryPatch({
      sessionKey: identity.openclawSessionKey,
      prepare: (entry) => ({ lifecycleRevision: entry.lifecycleRevision }),
    }), /projected generation cannot be persisted/u);
    assert.equal(raw.getRaw().lifecycleRevision, undefined);
    assert.equal(raw.getRaw().pluginExtensions, undefined);
  }
});

test("modern mutation preserves the exact authority and awaits acknowledgement before exposing projected results", async () => {
  const allow = deferred<void>();
  const entered = deferred<void>();
  const authority = sessionPatchAuthority(() => {});
  const raw = createAwaitedRuntime();
  const prepare = raw.runtime.prepareSessionEntryPatch;
  raw.runtime.prepareSessionEntryPatch = async (params) => {
    assert.equal(params.authority, authority);
    assert.equal(params.preserveActivity, true);
    entered.resolve();
    await allow.promise;
    return prepare(params);
  };
  const projected = createAntigravitySessionRuntime(raw.runtime);
  let settled = false;
  const pending = projected.prepareSessionEntryPatch({
    sessionKey: identity.openclawSessionKey,
    authority,
    preserveActivity: true,
    prepare: () => ({ pluginExtensions: { fixture: { complete: true } } }),
  }).then((entry) => { settled = true; return entry; });
  await entered.promise;
  assert.equal(settled, false);
  assert.equal(raw.getRaw().pluginExtensions, undefined);
  allow.resolve();
  const persisted = await pending;
  assert.equal(settled, true);
  assert.ok(persisted?.lifecycleRevision);
  assert.deepEqual(raw.getRaw().pluginExtensions, { fixture: { complete: true } });
  assert.equal(raw.getRaw().lifecycleRevision, undefined);
});

test("prepared source guarding preserves source facts and release ownership through revocation", async () => {
  let active = true;
  let sourceCalls = 0;
  let scopeCalls = 0;
  let prepares = 0;
  let currentCalls = 0;
  let preparedCalls = 0;
  let releases = 0;
  const prepared = {
    checks: [],
    nativeSource: true,
    assertCurrent() { currentCalls++; },
    assertPreparedCurrent() { preparedCalls++; },
    async release() { releases++; },
  };
  const source: SessionOwnerAssertion = Object.assign(() => { sourceCalls++; }, {
    async prepareSessionSource() { prepares++; return prepared; },
    assertScopeCurrent() { scopeCalls++; },
  });
  const guarded = guardSessionAuthority(source, () => {
    if (!active) throw new Error("local owner retired");
  });
  const authority = sessionPatchAuthority(guarded);
  assert.equal(authority.kind, "source");
  if (authority.kind !== "source") throw new Error("prepared source was discarded");
  assert.equal(authority.source, guarded);
  guarded();
  guarded.assertScopeCurrent!();
  const captured = await authority.source.prepareSessionSource();
  assert.equal(captured.checks, prepared.checks);
  assert.equal(captured.nativeSource, true);
  assert.equal(captured.release, prepared.release);
  captured.assertCurrent();
  captured.assertPreparedCurrent!();
  assert.deepEqual([sourceCalls, scopeCalls, prepares, currentCalls, preparedCalls, releases], [1, 1, 1, 1, 1, 0]);
  active = false;
  assert.throws(() => guarded(), /local owner retired/u);
  assert.throws(() => captured.assertCurrent(), /local owner retired/u);
  assert.throws(() => captured.assertPreparedCurrent!(), /local owner retired/u);
  assert.equal(releases, 0, "caller still owns release after successful acquisition");
  await captured.release!();
  assert.equal(releases, 1);
  assert.deepEqual([sourceCalls, currentCalls, preparedCalls], [1, 1, 1]);
});

test("owner loss while source preparation awaits releases the acquired authority before rejecting", async () => {
  let active = true;
  let releases = 0;
  const prepared = { checks: [], assertCurrent() {}, async release() { releases++; } };
  const gate = deferred<typeof prepared>();
  const source: SessionOwnerAssertion = Object.assign(() => {}, {
    prepareSessionSource: () => gate.promise,
  });
  const guarded = guardSessionAuthority(source, () => {
    if (!active) throw new Error("source owner replaced during preparation");
  });
  const pending = guarded.prepareSessionSource!();
  active = false;
  gate.resolve(prepared);
  await assert.rejects(pending, /source owner replaced/u);
  assert.equal(releases, 1);
});

test("legacy prepared-source mapping retains the exact source at its commit boundary", async () => {
  const raw = createRawRuntime();
  const original = raw.runtime.patchSessionEntry;
  let sourceChecks = 0;
  const source: SessionOwnerAssertion = Object.assign(() => { sourceChecks++; }, {
    async prepareSessionSource() { throw new Error("legacy adapter must preserve the original callable source"); },
  });
  raw.runtime.patchSessionEntry = async (params) => {
    assert.equal(params.assertCommitAllowed, source);
    assert.equal("authority" in params, false);
    assert.equal("prepare" in params, false);
    return original(params);
  };
  await createAntigravitySessionRuntime(raw.runtime).prepareSessionEntryPatch({
    sessionKey: identity.openclawSessionKey,
    authority: sessionPatchAuthority(source),
    prepare: () => ({ pluginExtensions: { fixture: { complete: true } } }),
  });
  assert.equal(sourceChecks, 1);
  assert.deepEqual(raw.getRaw().pluginExtensions, { fixture: { complete: true } });
});


test("optional prepared scope authority cannot bypass local retirement or leak a late acquisition", async () => {
  let active = true;
  let releases = 0;
  const prepared = { checks: [], assertCurrent() {}, release() { releases++; } };
  const gate = deferred<typeof prepared>();
  const source: SessionOwnerAssertion = Object.assign(() => {}, {
    prepareSessionSourceScope: () => gate.promise,
  });
  const guarded = guardSessionAuthority(source, () => {
    if (!active) throw new Error("scope owner retired");
  });
  const pending = guarded.prepareSessionSourceScope!();
  active = false;
  gate.resolve(prepared);
  await assert.rejects(pending, /scope owner retired/);
  assert.equal(releases, 1);
  await assert.rejects(guarded.prepareSessionSourceScope!, /scope owner retired/);
  assert.equal(releases, 1);
});


test("current-entry callbacks preserve full data and run policy inside the selected native boundary", async () => {
  const raw = createAwaitedRuntime(legacyEntry({ skillsSnapshot: { prompt: "full prompt", skills: [] } }));
  const select = raw.runtime.withSessionEntriesAsync;
  let inCallback = false;
  raw.runtime.withSessionEntriesAsync = async (params, consume) => select(params, (rows) => {
    for (const row of rows) delete row.entry.skillsSnapshot;
    inCallback = true;
    try { return consume(rows); } finally { inCallback = false; }
  });
  const adapter = createAntigravitySessionRuntime(raw.runtime);
  const result = await adapter.withCurrentSessionEntry({ agentId: identity.agentId,
    storePath: identity.storePath, sessionKey: identity.openclawSessionKey }, (entry) => {
    assert.equal(inCallback, true);
    assert.equal(entry?.skillsSnapshot?.prompt, "full prompt");
    assert.match(entry?.lifecycleRevision ?? "", /^antigravity:openclaw-legacy-session/);
    return "validated";
  });
  assert.equal(result, "validated");
  assert.equal(inCallback, false);
  assert.equal(raw.getRaw().lifecycleRevision, undefined, "compare raw host fields before projecting legacy generation");
});

test("stale full snapshots never enter current-session consumers for changed authority or absence", async () => {
  const initial = legacyEntry({ lifecycleRevision: "generation-1" });
  const changes: Partial<Entry>[] = [
    { sessionId: "replacement" }, { lifecycleRevision: "generation-2" },
    { sessionStartedAt: initial.sessionStartedAt! + 1 }, { agentHarnessId: "other" },
    { cliSessionIds: { "antigravity-cli": "old-conversation" } },
    { pluginExtensions: { antigravity: { resetPending: true, epoch: "new-epoch" } } },
  ];
  for (const change of [...changes, undefined]) {
    const raw = createAwaitedRuntime(initial);
    let reads = 0, effects = 0;
    raw.runtime.getSessionEntryAsync = async () => { reads++; return structuredClone(initial); };
    if (change) raw.replace({ ...initial, ...change });
    else raw.runtime.withSessionEntriesAsync = async (_params, consume) => consume([]);
    const adapter = createAntigravitySessionRuntime(raw.runtime);
    await assert.rejects(adapter.withCurrentSessionEntry({ agentId: identity.agentId,
      storePath: identity.storePath, sessionKey: identity.openclawSessionKey }, () => { effects++; }), /snapshot is stale/);
    assert.equal(reads, 1, "no refresh or replay after a stale snapshot");
    assert.equal(effects, 0);
  }
  const raw = createAwaitedRuntime(initial);
  raw.runtime.getSessionEntryAsync = async () => undefined!;
  await assert.rejects(createAntigravitySessionRuntime(raw.runtime).withCurrentSessionEntry({
    agentId: identity.agentId, storePath: identity.storePath, sessionKey: identity.openclawSessionKey,
  }, () => { throw new Error("stale absence must not reach consumer"); }), /snapshot is stale/);
});

test("foreign reset or deletion blocks stale active lease and settled result consumers", async () => {
  for (const settled of [false, true]) {
    for (const change of ["reset", "generation", "delete"] as const) {
      const raw = createAwaitedRuntime(legacyEntry({ lifecycleRevision: "generation-1" }));
      const originalRead = raw.runtime.getSessionEntryAsync;
      const originalSelected = raw.runtime.withSessionEntriesAsync;
      let retained: Entry | undefined;
      let deleted = false;
      raw.runtime.getSessionEntryAsync = async () => retained ? structuredClone(retained) : originalRead();
      raw.runtime.withSessionEntriesAsync = async (params, consume) => deleted ? consume([]) : originalSelected(params, consume);
      const adapter = createAntigravitySessionRuntime(raw.runtime);
      const bindings = new AntigravitySessionBindings(adapter, qualified);
      const lease = await bindings.beginAttempt({ ...identity, modelId: "opaque-model", scopeKey: "binding-continuity", assertActive() {} });
      if (settled) await bindings.endAttempt(lease, { terminationConfirmed: true });
      retained = structuredClone(raw.getRaw());
      if (change === "delete") deleted = true;
      else raw.replace({ ...retained, ...(change === "generation" ? { lifecycleRevision: "generation-2" }
        : { pluginExtensions: { antigravity: { resetPending: true, epoch: "foreign-reset" } } }) });
      let disclosed = 0;
      const check = settled ? bindings.assertResultCurrent(lease) : lease.assertCurrent();
      await assert.rejects(check.then(() => { disclosed++; }), /snapshot is stale/);
      assert.equal(disclosed, 0);
    }
  }
});

test("stale authority reports only differing field names, not either value", async () => {
  const raw = createAwaitedRuntime(legacyEntry({ lifecycleRevision: "private-generation-a",
    pluginExtensions: { antigravity: { privateValue: "secret-a" } } }));
  const captured = structuredClone(raw.getRaw());
  raw.runtime.getSessionEntryAsync = async () => captured;
  raw.replace({ ...captured, lifecycleRevision: "private-generation-b",
    pluginExtensions: { antigravity: { privateValue: "secret-b" } } });
  await assert.rejects(createAntigravitySessionRuntime(raw.runtime).withCurrentSessionEntry({
    agentId: identity.agentId, storePath: identity.storePath, sessionKey: identity.openclawSessionKey,
  }, () => { throw new Error("stale consumer must not run"); }), (error: unknown) => {
    assert.ok(error instanceof SessionSnapshotStaleError);
    assert.deepEqual(error.fields, ["lifecycleRevision", "pluginExtensions"]);
    assert.doesNotMatch(error.message, /private-generation|secret-[ab]/);
    return true;
  });
});

test("modern trio without authoritative selected callbacks is rejected before any host operation", () => {
  const raw = createAwaitedRuntime();
  const { withSessionEntriesAsync: _selected, ...incomplete } = raw.runtime;
  assert.deepEqual(inspectSessionRuntime(incomplete).missing, ["withSessionEntriesAsync"]);
  assert.throws(() => createAntigravitySessionRuntime(incomplete), /withSessionEntriesAsync/);
});

test("legacy callback captures its reader once and synchronous consumers cannot leak rejected promises", async () => {
  const raw = createRawRuntime();
  const adapter = createAntigravitySessionRuntime(raw.runtime);
  raw.runtime.getSessionEntry = () => { throw new Error("late replacement must not be used"); };
  const target = { agentId: identity.agentId, storePath: identity.storePath, sessionKey: identity.openclawSessionKey };
  assert.equal(await adapter.withCurrentSessionEntry(target, (entry) => entry?.sessionId), identity.openclawSessionId);
  await assert.rejects(adapter.withCurrentSessionEntry(target, async () => { throw new Error("async consumer rejection"); }), /consumer must be synchronous/);
});
