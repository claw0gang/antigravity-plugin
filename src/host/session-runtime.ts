import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawPluginApi, SessionEntryPatchAuthority, SessionEntrySourceAuthority } from "./types.js";

type SessionRuntime = OpenClawPluginApi["runtime"]["agent"]["session"];
type AwaitedSessionMethods = "getSessionEntryAsync" | "listSessionEntriesAsync" | "prepareSessionEntryPatch";
export type RuntimeSessionEntry = NonNullable<Awaited<ReturnType<SessionRuntime["getSessionEntryAsync"]>>>;
type SessionReadParams = Parameters<SessionRuntime["getSessionEntryAsync"]>[0];
export type AntigravitySessionRuntime = Pick<SessionRuntime, AwaitedSessionMethods> & {
  /** Validate binding policy inside a fresh public selected-entry callback.
   * Returned data is descriptive; final host effect ownership remains separate. */
  withCurrentSessionEntry<T>(params: SessionReadParams,
    consume: (entry: RuntimeSessionEntry | undefined) => T): Promise<T>;
};
export type OpenClawSessionRuntimeInput = Partial<Pick<SessionRuntime,
  AwaitedSessionMethods | "withSessionEntriesAsync" | "getSessionEntry" | "listSessionEntries" | "patchSessionEntry">>;
export type SessionOwnerAssertion = (() => void) & Partial<SessionEntrySourceAuthority>;

const MODERN = ["getSessionEntryAsync", "listSessionEntriesAsync", "prepareSessionEntryPatch"] as const;
const MODERN_REQUIRED = [...MODERN, "withSessionEntriesAsync"] as const;
// Full reads may be retained process-local snapshots in OpenClaw 2026.11.7.
// These are exactly the fields consumed by binding, generation and owner policy.
const AUTHORITY_FIELDS = ["sessionId", "lifecycleRevision", "sessionStartedAt",
  "agentHarnessId", "cliSessionIds", "pluginExtensions"] as const;
export type SessionAuthorityField = typeof AUTHORITY_FIELDS[number] | "selection";

/** Field names are safe to report; neither snapshot nor field values are retained. */
export class SessionSnapshotStaleError extends Error {
  readonly fields: readonly SessionAuthorityField[];
  constructor(fields: readonly SessionAuthorityField[]) {
    super(`ANTIGRAVITY canonical session snapshot is stale; execution and delivery revoked (fields: ${fields.join(", ")})`);
    this.name = "SessionSnapshotStaleError";
    this.fields = Object.freeze([...fields]);
  }
}
const LEGACY = ["getSessionEntry", "listSessionEntries", "patchSessionEntry"] as const;
const LEGACY_GENERATION_PREFIX = "antigravity:openclaw-legacy-session/v1:";

/** Select once, before any host operation. Partial modern surfaces never retry through legacy APIs. */
export function inspectSessionRuntime(runtime: OpenClawSessionRuntimeInput | undefined) {
  const modern = MODERN.some((key) => runtime?.[key] !== undefined);
  const keys = modern ? MODERN_REQUIRED : LEGACY;
  return { kind: modern ? "awaited" as const : "legacy" as const,
    missing: keys.filter((key) => typeof runtime?.[key] !== "function") };
}

function legacyGeneration(entry: RuntimeSessionEntry): string | undefined {
  const { sessionId, sessionStartedAt } = entry;
  if (typeof sessionId !== "string" || !sessionId.trim() || sessionId !== sessionId.trim() ||
      typeof sessionStartedAt !== "number" || !Number.isSafeInteger(sessionStartedAt) || sessionStartedAt <= 0) return undefined;
  return `${LEGACY_GENERATION_PREFIX}${createHash("sha256").update(sessionId).update("\0").update(String(sessionStartedAt)).digest("hex")}`;
}

/** Compatibility bookkeeping only; a real host lifecycle revision always wins. */
export function projectOpenClawSessionGeneration(entry: RuntimeSessionEntry): RuntimeSessionEntry {
  if (entry.lifecycleRevision !== undefined) return entry;
  const generation = legacyGeneration(entry);
  return generation === undefined ? entry : { ...entry, lifecycleRevision: generation };
}

/** Add a storage-free local guard without discarding the host's prepared source or release ownership. */
export function guardSessionAuthority(source: SessionOwnerAssertion, guard: () => void): SessionOwnerAssertion {
  type Prepared = Awaited<ReturnType<SessionEntrySourceAuthority["prepareSessionSource"]>>;
  const preparedWithGuard = (prepared: Prepared): Prepared => ({ ...prepared,
    assertCurrent: () => { guard(); prepared.assertCurrent(); guard(); },
    ...(prepared.assertPreparedCurrent ? {
      assertPreparedCurrent: () => { guard(); prepared.assertPreparedCurrent!(); guard(); },
    } : {}),
  });
  const acquire = async (prepare: () => Promise<Prepared | undefined>): Promise<Prepared | undefined> => {
    guard();
    const prepared = await prepare();
    try { guard(); } catch (error) { await prepared?.release?.(); throw error; }
    return prepared === undefined ? undefined : preparedWithGuard(prepared);
  };
  const assertion: SessionOwnerAssertion = Object.assign(() => { guard(); source(); guard(); }, source);
  if (source.assertScopeCurrent) assertion.assertScopeCurrent = () => { guard(); source.assertScopeCurrent!(); guard(); };
  if (source.prepareSessionSource) {
    assertion.prepareSessionSource = async () => (await acquire(() => source.prepareSessionSource!()))!;
  }
  if (source.prepareSessionSourceScope) {
    assertion.prepareSessionSourceScope = () => acquire(() => source.prepareSessionSourceScope!());
  }
  return assertion;
}

export function sessionPatchAuthority(assertion: SessionOwnerAssertion): SessionEntryPatchAuthority {
  return typeof assertion.prepareSessionSource === "function"
    ? { kind: "source", source: assertion as SessionEntrySourceAuthority }
    : { kind: "host", assertCurrent: assertion };
}

/** Awaited adapter over the public runtime-bound APIs, including the supported older-host path. */
export function createAntigravitySessionRuntime(runtime: OpenClawSessionRuntimeInput): AntigravitySessionRuntime {
  const selected = inspectSessionRuntime(runtime);
  if (selected.missing.length) throw new Error(`ANTIGRAVITY missing required session contracts: ${selected.missing.join(", ")}`);
  const modern = selected.kind === "awaited";
  // Capture the selected methods and their receiver once. Failure is final, never a fallback signal.
  const legacyRead = modern ? undefined : runtime.getSessionEntry!.bind(runtime);
  const read = modern ? runtime.getSessionEntryAsync!.bind(runtime) : legacyRead!;
  const list = modern ? runtime.listSessionEntriesAsync!.bind(runtime) : runtime.listSessionEntries!.bind(runtime);
  const prepare = modern ? runtime.prepareSessionEntryPatch!.bind(runtime) : undefined;
  const patch = modern ? undefined : runtime.patchSessionEntry!.bind(runtime);
  const selectedEntries = modern ? runtime.withSessionEntriesAsync!.bind(runtime) : undefined;
  const consumeSynchronously = <T>(entry: RuntimeSessionEntry | undefined,
    consume: (entry: RuntimeSessionEntry | undefined) => T): T => {
    const result = consume(entry === undefined ? undefined : projectOpenClawSessionGeneration(entry));
    if (result !== null && (typeof result === "object" || typeof result === "function") &&
        typeof (result as { then?: unknown }).then === "function") {
      void Promise.resolve(result).catch(() => {});
      throw new Error("ANTIGRAVITY current-session consumer must be synchronous");
    }
    return result;
  };
  return {
    async getSessionEntryAsync(params) {
      // Descriptive full entry only. Binding policy must use the callback below.
      const entry = await read(params);
      return entry === undefined ? undefined : projectOpenClawSessionGeneration(entry);
    },
    async withCurrentSessionEntry(params, consume) {
      if (!params.agentId?.trim() || !params.storePath?.trim() || !params.sessionKey?.trim()) {
        throw new Error("ANTIGRAVITY current-session checks require explicit agent, store and session key");
      }
      if (!modern) {
        // The preselected legacy reader and consumer share one synchronous edge.
        // A modern failure never reaches this path.
        return consumeSynchronously(legacyRead!(params), consume);
      }
      const entry = await read(params);
      return await selectedEntries!({
        stores: [{ agentId: params.agentId, storePath: params.storePath, sessionKeys: [params.sessionKey] }],
        ...(params.env ? { env: params.env } : {}),
      }, (entries) => {
        const selected = entries.filter((row) => row.agentId === params.agentId &&
          row.storePath === params.storePath && row.sessionKey === params.sessionKey);
        const current = selected[0]?.entry;
        const differing: SessionAuthorityField[] = AUTHORITY_FIELDS.filter(
          (field) => !isDeepStrictEqual(entry?.[field], current?.[field]),
        );
        if (selected.length > 1 || (entry === undefined) !== (current === undefined)) differing.unshift("selection");
        if (differing.length) throw new SessionSnapshotStaleError(differing);
        // Metadata is never substituted for a complete entry. Reject a changed
        // selection without refreshing, repeating preparation or retrying work.
        return consumeSynchronously(entry, consume);
      });
    },
    async listSessionEntriesAsync(params) {
      // Listing remains metadata. Never hydrate it or invent a lifecycle generation from it.
      if (!params.agentId?.trim()) throw new Error("ANTIGRAVITY session metadata listing requires an explicit agentId");
      return await list({ agentId: params.agentId, ...(params.env ? { env: params.env } : {}),
        ...(params.storePath ? { storePath: params.storePath } : {}),
        ...(params.readConsistency ? { readConsistency: params.readConsistency } : {}),
        ...(!modern ? { readOnly: true } : {}) });
    },
    async prepareSessionEntryPatch(params) {
      const projectPrepare: typeof params.prepare = async (entry, context) => {
        const prepared = await params.prepare(projectOpenClawSessionGeneration(entry),
          context.existingEntry === undefined ? context : {
            ...context, existingEntry: projectOpenClawSessionGeneration(context.existingEntry),
          });
        if (entry.lifecycleRevision === undefined && prepared?.lifecycleRevision?.startsWith(LEGACY_GENERATION_PREFIX)) {
          throw new Error("ANTIGRAVITY projected generation cannot be persisted as host lifecycle state");
        }
        return prepared;
      };
      const persisted = modern ? await prepare!({ ...params, prepare: projectPrepare }) : await (() => {
        const { prepare: _prepare, authority, ...rest } = params;
        const assertCommitAllowed = authority?.kind === "source" ? authority.source : authority?.assertCurrent;
        return patch!({ ...rest, update: projectPrepare, ...(assertCommitAllowed ? { assertCommitAllowed } : {}) });
      })();
      return persisted === null ? null : projectOpenClawSessionGeneration(persisted);
    },
  };
}
