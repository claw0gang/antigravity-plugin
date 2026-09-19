import assert from "node:assert/strict";

import {
  AntigravitySessionBindings,
  type AntigravitySessionRuntime,
} from "../../src/harness/session-bindings.ts";
import type { AntigravityHostContracts } from "../../src/harness/host-contracts.ts";

// SIMULATED source contracts only. These fixtures prove local ownership and
// callback behavior; they do not qualify an installed OpenClaw host or AGY.
export const sourceSessionMutation = Object.freeze({
  evidence: "SIMULATED: synchronous canonical entry updater and commit share one event-loop turn",
});

export function sourceHostContracts(
  overrides: Partial<AntigravityHostContracts> = {},
): AntigravityHostContracts {
  return {
    sessionMutation: sourceSessionMutation,
    runtime: {
      evidence: "SIMULATED: fixture-owned runtime and acknowledgement verifier; no live identity qualification",
      identity: "SIMULATED: credential-free-source-cli-runtime-v1",
      assertCurrent() {},
      verifyAcknowledgement({ event, scope, conversationId }) {
        assert.equal(event.init.cwd, scope.cwd, "SIMULATED native cwd acknowledgement");
        if (scope.nativeAgentSelection !== undefined) {
          assert.equal(event.init.agent, scope.nativeAgentSelection, "SIMULATED native agent acknowledgement");
        }
        if (conversationId !== undefined) {
          assert.equal(event.conversation_id, conversationId, "SIMULATED resumed conversation acknowledgement");
        }
        // Frozen protocol does not expose project/account acknowledgement. This
        // fixture adapter supplies only synthetic route identity, never P03/P05 proof.
      },
    },
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
    getSessionEntry({ sessionKey }: { sessionKey: string }) {
      const entry = rows.get(sessionKey);
      return entry ? structuredClone(entry) : undefined;
    },
    listSessionEntries() {
      return [...rows].map(([sessionKey, entry]) => ({ sessionKey, entry: structuredClone(entry) }));
    },
    async patchSessionEntry({ sessionKey, update, assertCommitAllowed }: {
      sessionKey: string;
      update: (entry: SourceEntry) => Partial<SourceEntry> | null;
      assertCommitAllowed?: () => void;
    }) {
      const entry = rows.get(sessionKey);
      if (!entry) return null;
      const patch = update(structuredClone(entry));
      assert.ok(!(patch instanceof Promise), "SIMULATED atomic host updater must remain synchronous");
      if (!patch) return structuredClone(entry);
      const next = { ...entry, ...structuredClone(patch) };
      assertCommitAllowed?.();
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
