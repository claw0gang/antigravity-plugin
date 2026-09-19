import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { InvocationScopeError, type InvocationScope } from "./cli/invocation-scope.js";
import { AgyProcessError } from "./cli/agy-process.js";
import { AgyModelDiscoveryError, discoverAgyModels, MAX_MODEL_LIST_TIMEOUT_MS, type AgyDiscoveredModel } from "./harness/model-catalog.js";

export const MAX_INVENTORY_FRESHNESS_MS = 60_000;
export const MAX_INVENTORY_SCOPES = 64;

type Acquire = typeof discoverAgyModels;
type Waiter = { scope: InvocationScope; expiresAt: number; resolve: (models: readonly AgyDiscoveredModel[]) => void;
  reject: (error: Error) => void; cleanup: () => void };
type Acquisition = { controller: AbortController; waiters: Set<Waiter>; deadline: number; generation: number;
  retired: boolean; timer?: ReturnType<typeof setTimeout> };
type Snapshot = { ownerGeneration: number; inventoryGeneration: number; acquiredAtMono: number;
  models: readonly AgyDiscoveredModel[] };
type Entry = { authority: InvocationScope; snapshot?: Snapshot; inflight?: Acquisition };

/** No native diagnostics, environment values or authority fingerprints leave this service. */
export class AgyInventoryError extends Error {
  constructor(readonly kind: "unavailable" | "aborted" | "timeout" | "retired" | "capacity" | "reentrant",
    readonly attemptedAtMono: number, message: string) {
    super(message);
    this.name = "AgyInventoryError";
  }
}

/** Preserve terminal meaning only from known local wrappers, without exposing their causes. */
function failureKind(error: unknown, remainingDepth = 4): AgyInventoryError["kind"] {
  if (error instanceof AgyInventoryError) return error.kind;
  if (error instanceof InvocationScopeError) {
    return error.kind === "timeout" || error.kind === "aborted" ? error.kind : "unavailable";
  }
  if (error instanceof AgyProcessError) {
    if (error.kind === "timeout" || error.kind === "native_timeout") return "timeout";
    if (error.kind === "aborted") return "aborted";
    return "unavailable";
  }
  if (remainingDepth > 0 && error instanceof AgyModelDiscoveryError) return failureKind(error.cause, remainingDepth - 1);
  return "unavailable";
}

function sameRecord(left: Readonly<Record<string, string | undefined>>, right: Readonly<Record<string, string | undefined>>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && left[key] === right[key]);
}

/** Compare private effective values directly. Never serialize or hash prepared credentials into a cache key. */
function sameAuthority(left: InvocationScope, right: InvocationScope): boolean {
  return left.command === right.command && left.cwd === right.cwd && left.scopeKey === right.scopeKey
    && left.nativeAgentSelection === right.nativeAgentSelection
    && left.projectSelection?.project === right.projectSelection?.project
    && left.projectSelection?.newProject === right.projectSelection?.newProject
    && left.addDirs.length === right.addDirs.length && left.addDirs.every((dir, i) => dir === right.addDirs[i])
    && sameRecord(left.owner, right.owner) && sameRecord(left.env, right.env);
}

const acquisitionContext = new AsyncLocalStorage<ReadonlySet<AgyInventoryService>>();

/** One in-memory execution owner; independent loader processes own independent instances. */
export class AgyInventoryService {
  readonly #discover: Acquire;
  readonly #now: () => number;
  readonly #freshnessMs: number;
  readonly #maxScopes: number;
  readonly #entries = new Set<Entry>();
  #ownerGeneration = 0;
  #inventoryGeneration = 0;
  #stopped = false;

  constructor(options: { discoverModels?: Acquire; now?: () => number; freshnessMs?: number; maxScopes?: number } = {}) {
    this.#discover = options.discoverModels ?? discoverAgyModels;
    this.#now = options.now ?? (() => performance.now());
    this.#freshnessMs = options.freshnessMs ?? MAX_INVENTORY_FRESHNESS_MS;
    this.#maxScopes = options.maxScopes ?? MAX_INVENTORY_SCOPES;
    if (!Number.isFinite(this.#freshnessMs) || this.#freshnessMs < 0 || this.#freshnessMs > MAX_INVENTORY_FRESHNESS_MS
      || !Number.isInteger(this.#maxScopes) || this.#maxScopes < 1 || this.#maxScopes > MAX_INVENTORY_SCOPES) {
      throw new Error("AGY inventory requires at most 60s freshness and 1–64 scope entries");
    }
  }

  async get(params: { scope: InvocationScope; fresh?: boolean; timeoutMs?: number }): Promise<readonly AgyDiscoveredModel[]> {
    const { scope } = params;
    const timeoutMs = params.timeoutMs ?? MAX_MODEL_LIST_TIMEOUT_MS;
    const attemptedAtMono = this.#now();
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_MODEL_LIST_TIMEOUT_MS) {
      throw this.#error("timeout", "AGY inventory acquisition requires a positive timeout of at most 10000ms");
    }
    if (this.#stopped) throw this.#error("retired", "AGY inventory owner has stopped");
    if (acquisitionContext.getStore()?.has(this)) throw this.#error("reentrant", "AGY inventory acquisition cannot reenter its service");
    this.#assertCaller(scope);
    let entry = [...this.#entries].find((candidate) => sameAuthority(candidate.authority, scope));
    if (!entry) {
      // LRU eviction is limited to settled entries. Aborted but unsettled native
      // operations still occupy capacity; timeout does not prove process exit.
      if (this.#entries.size >= this.#maxScopes) {
        const evictable = [...this.#entries].find((candidate) => !candidate.inflight);
        if (!evictable) throw this.#error("capacity", "AGY inventory scope capacity is occupied by acquisitions");
        this.#entries.delete(evictable);
      }
      entry = { authority: scope };
      this.#entries.add(entry);
    } else {
      this.#entries.delete(entry);
      this.#entries.add(entry);
    }
    if (entry.inflight?.retired) throw this.#error("retired", "AGY inventory acquisition is still retiring");
    // A refresh already in progress outranks cached readiness; a failure clears
    // readiness, and successful empty inventory replaces earlier live rows.
    if (!entry.inflight && !params.fresh && entry.snapshot
      && attemptedAtMono - entry.snapshot.acquiredAtMono < this.#freshnessMs) return entry.snapshot.models;
    const operation = entry.inflight ?? {
      controller: new AbortController(), waiters: new Set<Waiter>(),
      deadline: performance.now() + MAX_MODEL_LIST_TIMEOUT_MS, generation: this.#ownerGeneration, retired: false,
    };
    const shouldStart = !entry.inflight;
    entry.inflight = operation;
    const result = new Promise<readonly AgyDiscoveredModel[]>((resolve, reject) => {
      const expiresAt = Math.min(scope.deadlineMonoMs, performance.now() + timeoutMs);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = (): void => this.#removeWaiter(entry!, operation, waiter, this.#error("aborted", "AGY inventory caller was aborted"));
      const waiter: Waiter = { scope, expiresAt, resolve, reject, cleanup: () => {
        if (timer) clearTimeout(timer);
        scope.signal?.removeEventListener("abort", abort);
      } };
      operation.waiters.add(waiter);
      scope.signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => this.#removeWaiter(entry!, operation, waiter,
        this.#error("timeout", "AGY inventory caller deadline expired")), Math.max(0, expiresAt - performance.now()));
      // Catch an abort between the initial activity check and listener setup.
      if (scope.signal?.aborted) abort();
    });
    if (shouldStart) this.#start(entry, operation);
    return result;
  }

  /** Retire applicable acquisitions immediately. Late completion cannot renew any snapshot. */
  invalidate(scope?: InvocationScope): void {
    if (!scope) this.#ownerGeneration++;
    for (const entry of this.#entries) {
      if (scope && !sameAuthority(entry.authority, scope)) continue;
      delete entry.snapshot;
      if (entry.inflight) this.#retire(entry, entry.inflight, this.#error("retired", "AGY inventory generation was retired"));
      else this.#entries.delete(entry);
    }
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.invalidate();
  }

  #error(kind: AgyInventoryError["kind"], message: string): AgyInventoryError {
    return new AgyInventoryError(kind, this.#now(), message);
  }

  #assertCaller(scope: InvocationScope): void {
    try { scope.assertActive(); } catch (cause) {
      throw this.#error(scope.signal?.aborted ? "aborted" : failureKind(cause), "AGY inventory caller is no longer active");
    }
  }

  #removeWaiter(entry: Entry, operation: Acquisition, waiter: Waiter, error: Error): void {
    if (!operation.waiters.delete(waiter)) return;
    waiter.cleanup();
    waiter.reject(error);
    if (operation.waiters.size === 0) this.#retire(entry, operation, error);
  }

  #retire(entry: Entry, operation: Acquisition, error: Error): void {
    operation.retired = true;
    delete entry.snapshot;
    if (operation.timer) clearTimeout(operation.timer);
    for (const waiter of operation.waiters) { waiter.cleanup(); waiter.reject(error); }
    operation.waiters.clear();
    operation.controller.abort();
  }

  #start(entry: Entry, operation: Acquisition): void {
    const assertActive = (): void => {
      if (this.#stopped || operation.retired || operation.generation !== this.#ownerGeneration || operation.controller.signal.aborted) {
        throw this.#error("retired", "AGY inventory acquisition is no longer active");
      }
      for (const waiter of [...operation.waiters]) {
        try {
          this.#assertCaller(waiter.scope);
          if (performance.now() >= waiter.expiresAt) throw this.#error("timeout", "AGY inventory caller deadline expired");
        } catch (error) { this.#removeWaiter(entry, operation, waiter, error as Error); }
      }
      if (operation.retired || operation.waiters.size === 0 || performance.now() >= operation.deadline) {
        throw this.#error("timeout", "AGY inventory acquisition deadline expired");
      }
    };
    operation.timer = setTimeout(() => this.#retire(entry, operation,
      this.#error("timeout", "AGY inventory acquisition deadline expired")), Math.max(0, operation.deadline - performance.now()));
    const scope: InvocationScope = Object.freeze({ ...entry.authority, purpose: "inventory",
      signal: operation.controller.signal, deadlineMonoMs: operation.deadline, assertActive });
    const ancestors = new Set(acquisitionContext.getStore() ?? []);
    ancestors.add(this);
    // Starting in a microtask installs all concurrent waiters before discovery
    // and catches injected synchronous throws as ordinary acquisition failures.
    void Promise.resolve().then(() => acquisitionContext.run(ancestors, async () => {
      assertActive();
      return await this.#discover({ scope, timeoutMs: MAX_MODEL_LIST_TIMEOUT_MS });
    })).then((models) => {
      assertActive();
      const immutable = Object.freeze(models.map((model) => Object.freeze({ ...model })));
      entry.snapshot = { ownerGeneration: operation.generation, inventoryGeneration: ++this.#inventoryGeneration,
        acquiredAtMono: this.#now(), models: immutable };
      if (entry.inflight === operation) delete entry.inflight;
      for (const waiter of operation.waiters) { waiter.cleanup(); waiter.resolve(immutable); }
      operation.waiters.clear();
    }).catch((cause: unknown) => {
      delete entry.snapshot;
      if (entry.inflight === operation) {
        delete entry.inflight;
        // Remove a retired entry atomically with releasing its acquisition.
        // A later finally must never evict a replacement acquisition.
        if (operation.retired || this.#stopped) this.#entries.delete(entry);
      }
      for (const waiter of operation.waiters) {
        waiter.cleanup();
        waiter.reject(this.#error(failureKind(cause), "AGY inventory acquisition failed; readiness is unavailable"));
      }
      operation.waiters.clear();
    }).finally(() => {
      if (operation.timer) clearTimeout(operation.timer);
      if (entry.inflight === operation) {
        delete entry.inflight;
        if (operation.retired || this.#stopped) this.#entries.delete(entry);
      }
    });
  }
}
