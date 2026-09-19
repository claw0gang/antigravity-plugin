import assert from "node:assert/strict";
import test from "node:test";

import {
  AntigravitySessionBindings,
  type AntigravitySessionRuntime,
} from "../src/harness/session-bindings.ts";
import {
  createAntigravitySessionRuntime,
  projectOpenClawSessionGeneration,
} from "../src/host/session-runtime.ts";

type Entry = NonNullable<ReturnType<AntigravitySessionRuntime["getSessionEntry"]>>;
type PatchParams = Parameters<AntigravitySessionRuntime["patchSessionEntry"]>[0];
type PatchContext = Parameters<PatchParams["update"]>[1];

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
    async patchSessionEntry(params: PatchParams) {
      const patch = await params.update(
        structuredClone(row),
        patchContext ?? { existingEntry: structuredClone(row) },
      );
      params.assertCommitAllowed?.();
      if (patch) row = { ...row, ...structuredClone(patch) };
      return structuredClone(row);
    },
  } as unknown as AntigravitySessionRuntime;
  return {
    runtime,
    getRaw: () => row,
    replace(next: Entry) { row = structuredClone(next); },
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
    assert.equal(projected.getSessionEntry({ sessionKey: identity.openclawSessionKey })?.lifecycleRevision, undefined);
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

test("projected legacy generation is visible to get/list/patch but never persisted as host lifecycle state", async () => {
  const raw = createRawRuntime();
  const projected = createAntigravitySessionRuntime(raw.runtime);
  const first = projected.getSessionEntry({ sessionKey: identity.openclawSessionKey })!;
  const listed = projected.listSessionEntries()[0]!.entry;
  assert.equal(listed.lifecycleRevision, first.lifecycleRevision);

  let callbackGeneration: string | undefined;
  const persisted = await projected.patchSessionEntry({
    sessionKey: identity.openclawSessionKey,
    update(entry, context) {
      callbackGeneration = entry.lifecycleRevision;
      assert.equal(context.existingEntry?.lifecycleRevision, callbackGeneration);
      return { pluginExtensions: { fixture: { ok: true } } };
    },
  } as Parameters<AntigravitySessionRuntime["patchSessionEntry"]>[0]);

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
    await projected.patchSessionEntry({
      sessionKey: identity.openclawSessionKey,
      async update(entry, received) {
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
  await createAntigravitySessionRuntime(raw.runtime).patchSessionEntry({
    sessionKey: identity.openclawSessionKey,
    update(entry, received) {
      assert.ok(entry.lifecycleRevision);
      assert.equal(received, context);
      assert.equal(Object.hasOwn(received, "existingEntry"), false);
      return null;
    },
  });
  assert.equal(raw.getRaw().lifecycleRevision, undefined);
});

test("legacy 9.2 session binds and resumes while reset successor cannot inherit its generation", async () => {
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
  assert.equal(restarted.resolve(identity)?.conversationId, bound.conversationId);
  const resumed = await restarted.beginAttempt(attempt);
  assert.equal(resumed.binding?.conversationId, "conversation-1");
  await restarted.endAttempt(resumed, { terminationConfirmed: true });

  const oldGeneration = bound.lifecycleRevision;
  raw.replace(legacyEntry({
    sessionStartedAt: 1_700_000_000_500,
    pluginExtensions: undefined,
  }));
  const successorGeneration = projected.getSessionEntry({ sessionKey: identity.openclawSessionKey })!.lifecycleRevision;
  assert.notEqual(successorGeneration, oldGeneration);
  assert.throws(() => restarted.assertResultCurrent(resumed), /delivery revoked|invalid ANTIGRAVITY/u);

  const successor = await restarted.beginAttempt(attempt);
  assert.equal(successor.binding, undefined);
  assert.notEqual(successor.lifecycleRevision, oldGeneration);
});
