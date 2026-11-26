import { randomUUID } from "node:crypto";
import { guardSessionAuthority, sessionPatchAuthority, type SessionOwnerAssertion,
  type AntigravitySessionRuntime, type RuntimeSessionEntry } from "../host/session-runtime.js";
export type { AntigravitySessionRuntime } from "../host/session-runtime.js";

export const ANTIGRAVITY_SESSION_BINDING_EXTENSION = "antigravity";
const SCHEMA = "antigravity-native-session-binding/v2";

export type AntigravityOpenClawSession = {
  openclawSessionId: string;
  openclawSessionKey?: string;
  agentId?: string;
  /** Exact canonical store selected by the host, never an ambient default. */
  storePath?: string;
};
type CanonicalIdentity = Required<AntigravityOpenClawSession>;
export type AntigravitySessionBinding = CanonicalIdentity & {
  schema: typeof SCHEMA;
  harnessId: "antigravity";
  conversationId: string;
  modelId: string;
  /** Opaque binding/lease continuity key, retained when resuming native v2 rows.
   * It does not identify an AGY account, project or authentication generation. */
  scopeKey: string;
  epoch: string;
  lifecycleRevision: string;
};
type Envelope = CanonicalIdentity & {
  schema: typeof SCHEMA;
  harnessId: "antigravity";
  epoch: string;
  lifecycleRevision: string;
  binding?: AntigravitySessionBinding;
  activeAttempt?: { token: string; modelId: string; scopeKey: string };
  lastSettledAttempt?: { token: string; modelId: string; scopeKey: string; conversationId?: string };
  resetPending?: true;
};

/** Local C03 adapter seam, not an invented OpenClaw SDK capability field.
 * t004/P05 must qualify the selected host's cross-process snapshot check and
 * assertCommitAllowed transaction edge before the production adapter supplies it.
 */
export type AntigravitySessionCapabilities = {
  atomicMutation?: { evidence: string };
};
export type AntigravitySessionLease = Readonly<CanonicalIdentity & {
  epoch: string;
  lifecycleRevision: string;
  token: string;
  modelId: string;
  scopeKey: string;
  binding?: AntigravitySessionBinding;
  assertActive: SessionOwnerAssertion;
  /** Fresh full-entry validation; the synchronous guard owns only local/host authority. */
  assertCurrent: () => Promise<void>;
}>;
export type BeginAntigravitySessionAttempt = AntigravityOpenClawSession & {
  modelId: string;
  scopeKey: string;
  assertActive: SessionOwnerAssertion;
};
export type BindFreshAntigravitySessionParams = AntigravityOpenClawSession & {
  conversationId: string;
  modelId?: string;
  lease?: AntigravitySessionLease;
  /** Storage-free callback liveness, composed with the original lease owner. */
  assertActive?: () => void;
};

function exactString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error(`${label} must be a nonempty exact string`);
  }
  return value;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("unknown binding schema field");
}
const IDENTITY_KEYS = ["openclawSessionId", "openclawSessionKey", "agentId", "storePath"];
const BINDING_KEYS = [...IDENTITY_KEYS, "schema", "harnessId", "epoch", "lifecycleRevision", "conversationId", "modelId", "scopeKey"];
function canonicalIdentity(params: AntigravityOpenClawSession): CanonicalIdentity {
  return {
    openclawSessionId: exactString(params.openclawSessionId, "OpenClaw session id"),
    openclawSessionKey: exactString(params.openclawSessionKey, "OpenClaw canonical session key"),
    agentId: exactString(params.agentId, "OpenClaw agent id"),
    storePath: exactString(params.storePath, "OpenClaw canonical store"),
  };
}
function sameIdentity(a: CanonicalIdentity, b: CanonicalIdentity): boolean {
  return a.openclawSessionId === b.openclawSessionId && a.openclawSessionKey === b.openclawSessionKey
    && a.agentId === b.agentId && a.storePath === b.storePath;
}
function invalid(sessionId: string): Error {
  return new Error(`invalid ANTIGRAVITY native session binding for ${sessionId}; explicit host reset or validated migration required`);
}
function generation(entry: RuntimeSessionEntry): string {
  return exactString(entry.lifecycleRevision, "OpenClaw host lifecycle revision");
}
function assertNativeSessionOwner(entry: RuntimeSessionEntry): void {
  if (Object.hasOwn(entry.cliSessionIds ?? {}, "antigravity-cli")) {
    throw new Error("ANTIGRAVITY cannot convert an antigravity-cli session; explicitly reset the host session or start a new session");
  }
  if (entry.agentHarnessId !== undefined && entry.agentHarnessId !== "antigravity") {
    throw new Error("ANTIGRAVITY canonical session belongs to another harness; explicit host reset or a new session is required");
  }
}
function parseEnvelope(entry: RuntimeSessionEntry, identity: CanonicalIdentity): Envelope | undefined {
  identity = canonicalIdentity(identity);
  if (entry.sessionId !== identity.openclawSessionId) throw invalid(identity.openclawSessionId);
  assertNativeSessionOwner(entry);
  const extensions = entry.pluginExtensions;
  if (extensions === undefined) return undefined;
  const slots = record(extensions);
  if (!slots) throw invalid(identity.openclawSessionId);
  if (!Object.hasOwn(slots, ANTIGRAVITY_SESSION_BINDING_EXTENSION)) return undefined;
  const raw = record(slots[ANTIGRAVITY_SESSION_BINDING_EXTENSION]);
  try {
    if (!raw) throw invalid(identity.openclawSessionId);
    // v1 cannot establish canonical lifecycle provenance. It is not
    // truthfully migratable from its bytes alone, even when structurally valid.
    if (raw.schema === "antigravity-native-session-binding/v1") {
      throw invalid(identity.openclawSessionId);
    }
    onlyKeys(raw, [...IDENTITY_KEYS, "schema", "harnessId", "epoch", "lifecycleRevision", "binding", "activeAttempt", "lastSettledAttempt", "resetPending"]);
    if (raw.schema !== SCHEMA || raw.harnessId !== "antigravity"
      || !sameIdentity(canonicalIdentity(raw as CanonicalIdentity), identity)) throw invalid(identity.openclawSessionId);
    const epoch = exactString(raw.epoch, "binding epoch");
    const lifecycleRevision = exactString(raw.lifecycleRevision, "binding lifecycle revision");
    if (lifecycleRevision !== generation(entry)) throw invalid(identity.openclawSessionId);
    if (raw.resetPending !== undefined && raw.resetPending !== true) throw invalid(identity.openclawSessionId);
    let binding: AntigravitySessionBinding | undefined;
    if (Object.hasOwn(raw, "binding")) {
      const b = record(raw.binding);
      if (!b || b.schema !== SCHEMA || b.harnessId !== "antigravity"
        || !sameIdentity(canonicalIdentity(b as CanonicalIdentity), identity)
        || b.epoch !== epoch || b.lifecycleRevision !== lifecycleRevision) throw invalid(identity.openclawSessionId);
      onlyKeys(b, BINDING_KEYS);
      binding = { ...identity, schema: SCHEMA, harnessId: "antigravity", epoch, lifecycleRevision,
        conversationId: exactString(b.conversationId, "AGY conversation id"),
        modelId: exactString(b.modelId, "AGY exact model id"), scopeKey: exactString(b.scopeKey, "native binding scope") };
    }
    let activeAttempt: Envelope["activeAttempt"];
    if (Object.hasOwn(raw, "activeAttempt")) {
      const a = record(raw.activeAttempt);
      if (!a) throw invalid(identity.openclawSessionId);
      onlyKeys(a, ["token", "modelId", "scopeKey"]);
      activeAttempt = { token: exactString(a.token, "attempt token"), modelId: exactString(a.modelId, "AGY exact model id"),
        scopeKey: exactString(a.scopeKey, "native binding scope") };
      if (raw.resetPending || (binding && (binding.modelId !== activeAttempt.modelId || binding.scopeKey !== activeAttempt.scopeKey))) {
        throw invalid(identity.openclawSessionId);
      }
    }
    let lastSettledAttempt: Envelope["lastSettledAttempt"];
    if (Object.hasOwn(raw, "lastSettledAttempt")) {
      const settled = record(raw.lastSettledAttempt);
      if (!settled || activeAttempt || raw.resetPending) throw invalid(identity.openclawSessionId);
      onlyKeys(settled, ["token", "modelId", "scopeKey", "conversationId"]);
      lastSettledAttempt = { token: exactString(settled.token, "settled token"), modelId: exactString(settled.modelId, "settled model"),
        scopeKey: exactString(settled.scopeKey, "settled scope"),
        ...(Object.hasOwn(settled, "conversationId") ? { conversationId: exactString(settled.conversationId, "settled conversation") } : {}) };
      if (lastSettledAttempt.conversationId !== binding?.conversationId
        || (binding && (lastSettledAttempt.modelId !== binding.modelId || lastSettledAttempt.scopeKey !== binding.scopeKey))) {
        throw invalid(identity.openclawSessionId);
      }
    }
    return { ...identity, schema: SCHEMA, harnessId: "antigravity", epoch, lifecycleRevision,
      ...(binding ? { binding } : {}), ...(activeAttempt ? { activeAttempt } : {}),
      ...(lastSettledAttempt ? { lastSettledAttempt } : {}), ...(raw.resetPending ? { resetPending: true } : {}) };
  } catch { throw invalid(identity.openclawSessionId); }
}
function patchEnvelope(entry: RuntimeSessionEntry, envelope: Envelope): Partial<RuntimeSessionEntry> {
  return { pluginExtensions: { ...(entry.pluginExtensions ?? {}), antigravity: envelope } };
}

export class AntigravitySessionBindings {
  readonly #runtime: AntigravitySessionRuntime;
  readonly #capabilities: AntigravitySessionCapabilities;
  constructor(runtime: AntigravitySessionRuntime, capabilities: AntigravitySessionCapabilities = {}) {
    this.#runtime = runtime;
    this.#capabilities = capabilities;
  }
  #assertAtomic(): void {
    if (!this.#capabilities.atomicMutation?.evidence?.trim()
      || typeof this.#runtime.getSessionEntryAsync !== "function" || typeof this.#runtime.prepareSessionEntryPatch !== "function"
      || typeof this.#runtime.withCurrentSessionEntry !== "function") {
      throw new Error("ANTIGRAVITY canonical session mutation requires qualified host cross-process snapshot CAS and prepared commit authority; t004/P05 qualification required before launch or reset");
    }
  }
  async #withCurrentEntry<T>(identity: CanonicalIdentity, consume: (entry: RuntimeSessionEntry) => T): Promise<T> {
    if (typeof this.#runtime.withCurrentSessionEntry !== "function") {
      throw new Error("ANTIGRAVITY requires a public current-session callback before execution or delivery");
    }
    return await this.#runtime.withCurrentSessionEntry({ sessionKey: identity.openclawSessionKey,
      agentId: identity.agentId, storePath: identity.storePath, readConsistency: "latest" }, (entry) => {
      if (!entry || entry.sessionId !== identity.openclawSessionId) {
        throw new Error(`OpenClaw canonical session ${identity.openclawSessionId} is missing or changed identity; explicit host reset required`);
      }
      return consume(entry);
    });
  }
  async #patch(identity: CanonicalIdentity, assertActive: SessionOwnerAssertion,
    update: (entry: RuntimeSessionEntry) => Partial<RuntimeSessionEntry> | null): Promise<RuntimeSessionEntry> {
    this.#assertAtomic();
    assertActive();
    const persisted = await this.#runtime.prepareSessionEntryPatch({ sessionKey: identity.openclawSessionKey,
      agentId: identity.agentId, storePath: identity.storePath, readConsistency: "latest", preserveActivity: true,
      // Preparation executes once outside SQLite; the host compares the full
      // captured entry and checks the original owner again at its commit edge.
      authority: sessionPatchAuthority(assertActive),
      prepare: (entry) => {
        assertActive();
        if (entry.sessionId !== identity.openclawSessionId) throw invalid(identity.openclawSessionId);
        assertNativeSessionOwner(entry);
        return update(entry);
      },
    });
    assertActive();
    if (!persisted) throw new Error(`failed to persist ANTIGRAVITY canonical session ${identity.openclawSessionId}; do not retry native inference`);
    return persisted;
  }
  async resolve(params: AntigravityOpenClawSession): Promise<AntigravitySessionBinding | undefined> {
    const identity = canonicalIdentity(params);
    return await this.#withCurrentEntry(identity, (entry) => {
      const envelope = parseEnvelope(entry, identity);
      if (envelope?.resetPending) throw new Error("ANTIGRAVITY session reset is pending cancellation/drain; resume is blocked");
      return envelope?.binding;
    });
  }
  async beginAttempt(params: BeginAntigravitySessionAttempt): Promise<AntigravitySessionLease> {
    this.#assertAtomic();
    const identity = canonicalIdentity(params);
    const modelId = exactString(params.modelId, "AGY exact model id");
    const scopeKey = exactString(params.scopeKey, "native binding scope");
    const token = randomUUID();
    const persisted = await this.#patch(identity, params.assertActive, (entry) => {
      const previous = parseEnvelope(entry, identity);
      if (previous?.resetPending) throw new Error("ANTIGRAVITY reset is pending; explicit host cancellation/drain required");
      if (previous?.activeAttempt) throw new Error("ANTIGRAVITY session has an active or interrupted attempt; concurrent resume is unsupported until explicit host reset/reconciliation");
      if (previous?.binding && (previous.binding.modelId !== modelId || previous.binding.scopeKey !== scopeKey)) {
        throw new Error("ANTIGRAVITY resume model or binding scope changed; explicit host reset or validated migration required");
      }
      const envelope: Envelope = previous ?? { ...identity, schema: SCHEMA, harnessId: "antigravity",
        epoch: randomUUID(), lifecycleRevision: generation(entry) };
      const { lastSettledAttempt: _previousResult, ...current } = envelope;
      return patchEnvelope(entry, { ...current, activeAttempt: { token, modelId, scopeKey } });
    });
    const envelope = parseEnvelope(persisted, identity)!;
    if (envelope.activeAttempt?.token !== token) throw new Error("ANTIGRAVITY canonical attempt claim was not persisted");
    let ended = false;
    const lease: AntigravitySessionLease = Object.freeze({ ...identity, token, epoch: envelope.epoch,
      lifecycleRevision: envelope.lifecycleRevision, modelId, scopeKey, ...(envelope.binding ? { binding: Object.freeze(envelope.binding) } : {}),
      assertActive: guardSessionAuthority(params.assertActive, () => {
        if (ended) throw new Error("ANTIGRAVITY session attempt is retired");
      }),
      assertCurrent: async () => {
        lease.assertActive();
        await this.#withCurrentEntry(lease, (entry) => {
          lease.assertActive();
          this.#assertLease(lease, entry);
        });
        lease.assertActive();
      },
    });
    this.#retire.set(lease, () => { ended = true; });
    await lease.assertCurrent(); // Keep persisted claim when ownership is lost.
    return lease;
  }
  readonly #retire = new WeakMap<AntigravitySessionLease, () => void>();
  #assertLease(lease: AntigravitySessionLease, entry: RuntimeSessionEntry): Envelope {
    const envelope = parseEnvelope(entry, lease);
    if (!envelope || envelope.resetPending || envelope.epoch !== lease.epoch
      || envelope.lifecycleRevision !== lease.lifecycleRevision || envelope.activeAttempt?.token !== lease.token
      || envelope.activeAttempt.modelId !== lease.modelId || envelope.activeAttempt.scopeKey !== lease.scopeKey) {
      throw new Error("ANTIGRAVITY session attempt generation is stale; callback and persistence revoked");
    }
    return envelope;
  }
  async bindFresh(params: BindFreshAntigravitySessionParams): Promise<AntigravitySessionBinding> {
    const identity = canonicalIdentity(params);
    const lease = params.lease;
    if (!lease || !sameIdentity(identity, lease)) throw new Error("ANTIGRAVITY fresh binding requires its exact canonical session attempt lease");
    const modelId = exactString(params.modelId, "AGY exact model id");
    const conversationId = exactString(params.conversationId, "AGY conversation id");
    if (modelId !== lease.modelId) throw new Error("AGY init model does not match the session attempt lease");
    const assertActive = guardSessionAuthority(lease.assertActive, params.assertActive ?? (() => {}));
    await lease.assertCurrent();
    const persisted = await this.#patch(identity, assertActive, (entry) => {
      const envelope = this.#assertLease(lease, entry);
      if (envelope.binding) {
        if (envelope.binding.conversationId !== conversationId) throw new Error("OpenClaw session is already bound to a different AGY conversation");
        return null;
      }
      const binding: AntigravitySessionBinding = { ...identity, schema: SCHEMA, harnessId: "antigravity",
        conversationId, modelId, scopeKey: lease.scopeKey, epoch: lease.epoch, lifecycleRevision: lease.lifecycleRevision };
      return patchEnvelope(entry, { ...envelope, binding });
    });
    assertActive();
    await lease.assertCurrent();
    const binding = parseEnvelope(persisted, identity)?.binding;
    if (!binding || binding.conversationId !== conversationId) throw new Error("AGY binding persistence was not confirmed; do not retry native inference");
    return binding;
  }
  /** Call only after all native readers/processes and callbacks are drained.
   * Uncertain termination retains the durable claim and blocks future resume.
   */
  async endAttempt(lease: AntigravitySessionLease, options: {
    terminationConfirmed: boolean;
    /** Revocable cleanup ownership/deadline guard, checked at the host commit edge. */
    assertCommitAllowed?: () => void;
  }): Promise<void> {
    this.#retire.get(lease)?.();
    if (!options.terminationConfirmed) return;
    await this.#patch(lease, options.assertCommitAllowed ?? (() => {}), (entry) => {
      const envelope = parseEnvelope(entry, lease);
      if (!envelope || envelope.epoch !== lease.epoch || envelope.activeAttempt?.token !== lease.token) return null;
      const { activeAttempt: _retired, ...rest } = envelope;
      return patchEnvelope(entry, { ...rest, lastSettledAttempt: { token: lease.token, modelId: lease.modelId, scopeKey: lease.scopeKey,
        ...(envelope.binding ? { conversationId: envelope.binding.conversationId } : {}) } });
    });
  }
  /** Retired native callbacks cannot act, but this separate generation fence
   * remains usable by t004's final-result sink. The actual host commit must
   * invoke it atomically with that mutation and check its own current owner.
   */
  async assertResultCurrent(lease: AntigravitySessionLease): Promise<void> {
    await this.#withCurrentEntry(lease, (entry) => {
      const envelope = parseEnvelope(entry, lease);
      if (!envelope || envelope.resetPending || envelope.activeAttempt || envelope.epoch !== lease.epoch
        || envelope.lifecycleRevision !== lease.lifecycleRevision || envelope.lastSettledAttempt?.token !== lease.token
        || envelope.lastSettledAttempt.modelId !== lease.modelId || envelope.lastSettledAttempt.scopeKey !== lease.scopeKey) {
        throw new Error("ANTIGRAVITY final result generation is stale or not settled; delivery revoked");
      }
    });
  }
  /** The caller supplies qualified host cancellation/drain, including other
   * processes. Metadata retirement precedes drain; failure leaves a tombstone.
   */
  async clear(params: AntigravityOpenClawSession & {
    cancelAndDrain?: () => Promise<void>;
    /** One shared reset budget, including both host commits and cancellation/drain. */
    timeoutMs?: number;
  }): Promise<boolean> {
    this.#assertAtomic();
    const identity = canonicalIdentity(params);
    const cancelAndDrain = params.cancelAndDrain;
    if (!cancelAndDrain) throw new Error("ANTIGRAVITY reset requires qualified host cancellation/drain before clearing its native binding");
    const timeoutMs = params.timeoutMs ?? 6_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 6_000) {
      throw new Error("ANTIGRAVITY reset timeout must be finite, positive and at most 6000 ms");
    }
    const deadline = performance.now() + timeoutMs;
    let active = true;
    const timedOut = () => new Error("ANTIGRAVITY reset timed out; host cancellation/drain is unconfirmed and late metadata commits are revoked");
    const assertCommitAllowed = () => {
      if (!active || performance.now() >= deadline) throw timedOut();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { active = false; reject(timedOut()); }, timeoutMs);
    });
    const work = async (): Promise<boolean> => {
      const resetEpoch = randomUUID();
      let removed = false;
      await this.#patch(identity, assertCommitAllowed, (entry) => {
        if (entry.pluginExtensions !== undefined && !record(entry.pluginExtensions)) throw invalid(identity.openclawSessionId);
        let previous: Envelope | undefined;
        try { previous = parseEnvelope(entry, identity); }
        catch { /* Explicit qualified reset is also the remedy for malformed/legacy metadata. */ }
        if (previous?.resetPending) throw new Error("ANTIGRAVITY reset already pending; explicit host reconciliation required");
        removed = Boolean(previous?.binding) || (!previous && Object.hasOwn(entry.pluginExtensions ?? {}, ANTIGRAVITY_SESSION_BINDING_EXTENSION));
        // Re-epoch the retained binding while pending reset; old leases are now
        // irrevocably stale even when this same logical session is recreated.
        return patchEnvelope(entry, { ...identity, schema: SCHEMA, harnessId: "antigravity", epoch: resetEpoch,
          lifecycleRevision: generation(entry), resetPending: true,
          ...(previous?.binding ? { binding: { ...previous.binding, epoch: resetEpoch } } : {}) });
      });
      assertCommitAllowed();
      await cancelAndDrain();
      assertCommitAllowed();
      await this.#patch(identity, assertCommitAllowed, (entry) => {
        const envelope = parseEnvelope(entry, identity);
        if (!envelope || envelope.epoch !== resetEpoch || !envelope.resetPending) throw new Error("ANTIGRAVITY reset generation changed while draining");
        const { binding: _removed, resetPending: _pending, ...tombstone } = envelope;
        return patchEnvelope(entry, tombstone);
      });
      assertCommitAllowed();
      return removed;
    };
    try { return await Promise.race([work(), timeout]); }
    finally {
      // The external cancellation callback may still run. This revokes only
      // our metadata authority; it never claims that external work was stopped.
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

