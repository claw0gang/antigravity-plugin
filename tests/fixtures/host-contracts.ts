import assert from "node:assert/strict";

import {
  AntigravitySessionBindings,
  type AntigravitySessionRuntime,
} from "../../src/harness/session-bindings.ts";
import type { AntigravityHostContracts } from "../../src/harness/host-contracts.ts";

// SIMULATED source contracts only. These fixtures prove local ownership and
// callback behavior; they do not qualify an installed OpenClaw host or AGY.
export const sourceSessionMutation = Object.freeze({
  evidence: "SIMULATED: captured row checked after awaited preparation before one event-loop commit",
});

export function sourceHostContracts(
  overrides: Partial<AntigravityHostContracts> = {},
): AntigravityHostContracts {
  return {
    sessionMutation: sourceSessionMutation,
    ...overrides,
  };
}

type SourceEntry = {
  sessionId: string;
  lifecycleRevision: string;
  pluginExtensions?: Record<string, Record<string, unknown>>;
};

export function createSourceSessionRuntime(
  sessions: Array<{ sessionKey: string; sessionId: string }>,
  onBinding: () => void = () => {},
) {
  const rows = new Map<string, SourceEntry>(
    sessions.map(({ sessionKey, sessionId }) => [sessionKey, { sessionId, lifecycleRevision: "SIMULATED:lifecycle-v1" }]),
  );
  const runtime = {
    async getSessionEntryAsync({ sessionKey }: { sessionKey: string }) {
      const entry = rows.get(sessionKey);
      return entry ? structuredClone(entry) : undefined;
    },
    async withCurrentSessionEntry<T>(params: { sessionKey: string }, consume: (entry: SourceEntry | undefined) => T) {
      const entry = await this.getSessionEntryAsync(params);
      assert.deepEqual(entry, rows.get(params.sessionKey), "SIMULATED current-session snapshot is stale");
      return consume(entry as SourceEntry | undefined);
    },
    async listSessionEntriesAsync() {
      return [...rows].map(([sessionKey, entry]) => ({ sessionKey, entry: structuredClone(entry) }));
    },
    async prepareSessionEntryPatch({ sessionKey, prepare, authority }: {
      sessionKey: string;
      prepare: (entry: SourceEntry, context: { existingEntry: SourceEntry }) => Partial<SourceEntry> | null | Promise<Partial<SourceEntry> | null>;
      authority?: { kind: "host"; assertCurrent: () => void } | { kind: "source"; source: () => void };
    }) {
      const entry = rows.get(sessionKey);
      if (!entry) return null;
      const snapshot = JSON.stringify(entry);
      const patch = await prepare(structuredClone(entry), { existingEntry: structuredClone(entry) });
      assert.equal(JSON.stringify(rows.get(sessionKey)), snapshot, "SIMULATED host snapshot conflict");
      if (authority?.kind === "source") authority.source();
      else authority?.assertCurrent();
      if (!patch) return structuredClone(entry);
      const next = { ...entry, ...structuredClone(patch) };
      rows.set(sessionKey, next);
      const nextBinding = next.pluginExtensions?.antigravity?.binding as Record<string, unknown> | undefined;
      const previousBinding = entry.pluginExtensions?.antigravity?.binding as Record<string, unknown> | undefined;
      if (nextBinding?.conversationId !== previousBinding?.conversationId) onBinding();
      return structuredClone(next);
    },
  } as unknown as AntigravitySessionRuntime;
  return { rows, runtime };
}

export function createSourceSessionBindings(
  session: { sessionKey: string; sessionId: string },
  onBinding: () => void = () => {},
): AntigravitySessionBindings {
  const { runtime } = createSourceSessionRuntime([session], onBinding);
  return new AntigravitySessionBindings(runtime, { atomicMutation: sourceSessionMutation });
}
