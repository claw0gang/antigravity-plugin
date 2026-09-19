import { createHash } from "node:crypto";

import type { AntigravitySessionRuntime } from "../harness/session-bindings.js";

type RuntimeSessionEntry = NonNullable<
  ReturnType<AntigravitySessionRuntime["getSessionEntry"]>
>;

const LEGACY_GENERATION_PREFIX = "antigravity:openclaw-legacy-session/v1:";

function legacyGeneration(entry: RuntimeSessionEntry): string | undefined {
  const sessionId = entry.sessionId;
  const sessionStartedAt = entry.sessionStartedAt;
  if (
    typeof sessionId !== "string" ||
    !sessionId.trim() ||
    sessionId !== sessionId.trim() ||
    typeof sessionStartedAt !== "number" ||
    !Number.isSafeInteger(sessionStartedAt) ||
    sessionStartedAt <= 0
  ) {
    return undefined;
  }
  const digest = createHash("sha256")
    .update(sessionId)
    .update("\0")
    .update(String(sessionStartedAt))
    .digest("hex");
  return `${LEGACY_GENERATION_PREFIX}${digest}`;
}

/**
 * OpenClaw 2026.9.2 direct `agent --session-key` rows may legitimately omit
 * lifecycleRevision while retaining a stable sessionStartedAt. Project only that
 * legacy shape into the stronger P05 generation contract. A real host revision
 * always wins; malformed legacy rows remain unstamped and fail closed downstream.
 *
 * OpenClaw reset rotates sessionStartedAt and reconstructs the row without plugin
 * extension state, so this compatibility generation cannot preserve a stale native
 * binding across a reset boundary.
 */
export function projectOpenClawSessionGeneration(
  entry: RuntimeSessionEntry,
): RuntimeSessionEntry {
  if (entry.lifecycleRevision !== undefined) {
    return entry;
  }
  const generation = legacyGeneration(entry);
  return generation === undefined ? entry : { ...entry, lifecycleRevision: generation };
}

/**
 * Read/write projection over the public OpenClaw session runtime. Synthetic legacy
 * generations are never written into OpenClaw-owned lifecycle fields; only plugin
 * metadata produced by ANTIGRAVITY observes the projected generation.
 */
export function createAntigravitySessionRuntime(
  sessionRuntime: AntigravitySessionRuntime,
): AntigravitySessionRuntime {
  return {
    getSessionEntry(params) {
      const entry = sessionRuntime.getSessionEntry(params);
      return entry === undefined ? undefined : projectOpenClawSessionGeneration(entry);
    },
    listSessionEntries(params) {
      return sessionRuntime.listSessionEntries(params).map((summary) => ({
        ...summary,
        entry: projectOpenClawSessionGeneration(summary.entry),
      }));
    },
    async patchSessionEntry(params) {
      const persisted = await sessionRuntime.patchSessionEntry({
        ...params,
        update: async (entry, context) => await params.update(
          projectOpenClawSessionGeneration(entry),
          context.existingEntry === undefined ? context : {
            ...context,
            existingEntry: projectOpenClawSessionGeneration(context.existingEntry),
          },
        ),
      });
      return persisted === null ? null : projectOpenClawSessionGeneration(persisted);
    },
  };
}
