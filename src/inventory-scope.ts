import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";

import { createInvocationScope, type InvocationScope } from "./cli/invocation-scope.js";
import { resolveAntigravityPluginConfig, type AntigravityPluginConfig } from "./config.js";
import { AgyInventoryError, AgyInventoryService } from "./inventory.js";
import { MAX_MODEL_LIST_TIMEOUT_MS, type discoverAgyModels } from "./harness/model-catalog.js";
import { observeAgyCatalogEffort } from "./harness/effort-probe.js";

/** Union of information actually supplied by the frozen public catalog hooks. */
export type AgyHostInventoryContext = {
  config?: unknown;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  agentRuntimeId?: string;
  authProfileId?: string;
  authProfileMode?: string;
  signal?: AbortSignal;
};

export type AgyHostInventoryOptions = {
  pluginConfig: AntigravityPluginConfig;
  inventory?: AgyInventoryService;
  discoverModels?: typeof discoverAgyModels;
  inventoryOwner?: AgyHostInventoryOwner;
  /** Injectable read-only capability observer for credential-free source fixtures. */
  observeEffort?: typeof observeAgyCatalogEffort;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Explicit configuration is a probe selection, not native membership or
 * model authorization. Prioritize primary/host-selected refs over allowlists
 * and fallbacks; the live inventory still decides which exact IDs exist. */
export function configuredAgyModelIds(config: unknown, selected: readonly string[] = []): string[] {
  const ids = new Set(selected.filter(id => typeof id === "string" && id.length > 0 && !id.endsWith("*")));
  const add = (ref: unknown) => {
    if (typeof ref !== "string" || !ref.startsWith("antigravity/")) return;
    const id = ref.slice("antigravity/".length);
    if (id && !id.endsWith("*")) ids.add(id);
  };
  const agents = asRecord(asRecord(config)?.agents);
  const entries = [asRecord(agents?.defaults),
    ...(Array.isArray(agents?.list) ? agents.list.map(asRecord) : [])];
  for (const entry of entries) {
    const model = entry?.model;
    add(typeof model === "string" ? model : asRecord(model)?.primary);
  }
  for (const entry of entries) {
    for (const ref of Object.keys(asRecord(entry?.models) ?? {})) add(ref);
    const fallbacks = asRecord(entry?.model)?.fallbacks;
    if (Array.isArray(fallbacks)) for (const ref of fallbacks) add(ref);
  }
  return [...ids];
}

function configuredPlugin(config: unknown, fallback: AntigravityPluginConfig): AntigravityPluginConfig {
  const projected = config as { plugins?: { entries?: Record<string, { config?: unknown }> } } | undefined;
  const entry = projected?.plugins?.entries?.antigravity;
  return entry ? resolveAntigravityPluginConfig(entry.config) : fallback;
}

/**
 * One host owner, shared by its provider and harness hooks. Config values and
 * environments remain private in memory; their secrets never become cache keys.
 * Hooks without an env/working-directory input use this local process context,
 * not an invented native account identity or an expired attempt capability.
 */
export class AgyHostInventoryOwner {
  readonly inventory: AgyInventoryService;
  private readonly id = randomUUID();
  private configSnapshot: AntigravityPluginConfig | undefined;
  private generation = 0;
  private stopped = false;
  private readonly observedScopes: InvocationScope[] = [];

  constructor(private readonly options: Omit<AgyHostInventoryOptions, "inventoryOwner">) {
    this.inventory = options.inventory ?? new AgyInventoryService({
      ...(options.discoverModels ? { discoverModels: options.discoverModels } : {}),
    });
  }

  scope(ctx: AgyHostInventoryContext, timeoutMs = MAX_MODEL_LIST_TIMEOUT_MS): InvocationScope {
    if (this.stopped) throw new Error("ANTIGRAVITY inventory owner has stopped");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_MODEL_LIST_TIMEOUT_MS) {
      throw new Error("ANTIGRAVITY inventory timeout must be positive and at most 10000ms");
    }
    // Provider discovery may receive a projected host config while the native
    // harness receives the original observation config. Compare the actual
    // AGY invocation configuration, not unrelated host model/auth projections.
    // Host publication/route authority remains in OpenClaw's generation.
    const config = configuredPlugin(ctx.config, this.options.pluginConfig);
    if (!isDeepStrictEqual(this.configSnapshot, config)) {
      if (this.configSnapshot) this.inventory.invalidate();
      this.configSnapshot = structuredClone(config);
      this.generation += 1;
    }
    const generation = this.generation;
    const observedConfig = structuredClone(config);
    const observedEnv = { ...(ctx.env ?? process.env) };
    const scope = createInvocationScope({
      purpose: "inventory", command: config.command,
      ...(ctx.workspaceDir ? { cwd: ctx.workspaceDir } : {}),
      env: observedEnv,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      timeoutMs,
      owner: {
        plugin: "antigravity", inventoryOwner: this.id, configGeneration: String(generation),
        agentDir: ctx.agentDir, agentId: ctx.agentId, agentRuntimeId: ctx.agentRuntimeId,
        authProfileId: ctx.authProfileId, authProfileMode: ctx.authProfileMode,
      },
      projectSelection: { ...(config.project ? { project: config.project } : {}), newProject: config.newProject },
      addDirs: config.addDirs,
      ...(config.agent ? { nativeAgentSelection: config.agent } : {}),
      assertActive: () => {
        if (this.stopped || this.generation !== generation || !isDeepStrictEqual(configuredPlugin(ctx.config, this.options.pluginConfig), observedConfig) ||
            !isDeepStrictEqual({ ...(ctx.env ?? process.env) }, observedEnv)) {
          throw new Error("ANTIGRAVITY catalog owner changed during inventory acquisition");
        }
      },
    });
    // A credential/environment replacement at the same public host coordinate
    // retires the earlier acquisition immediately. Distinct agent/project
    // coordinates remain independently valid.
    for (let i = this.observedScopes.length - 1; i >= 0; i -= 1) {
      const previous = this.observedScopes[i]!;
      const sameCoordinate = previous.command === scope.command && previous.cwd === scope.cwd &&
        isDeepStrictEqual(previous.owner, scope.owner) &&
        isDeepStrictEqual(previous.projectSelection, scope.projectSelection) &&
        isDeepStrictEqual(previous.addDirs, scope.addDirs) && previous.nativeAgentSelection === scope.nativeAgentSelection;
      if (sameCoordinate) {
        if (!isDeepStrictEqual(previous.env, scope.env)) this.inventory.invalidate(previous);
        this.observedScopes.splice(i, 1);
      }
    }
    this.observedScopes.push(scope);
    if (this.observedScopes.length > 64) this.observedScopes.shift();
    return scope;
  }

  async models(ctx: AgyHostInventoryContext, timeoutMs?: number) {
    const scope = this.scope(ctx, timeoutMs);
    // A host refresh always re-acquires. Equivalent concurrent reads coalesce;
    // old catalog rows or readiness can never authorize a native execution.
    return this.inventory.get({ scope, fresh: true, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
  }

  /** Read the same exact explicit native refs before either logical provider
   * or native route publication. Provider discovery does not receive the
   * harness's configuredModelRefs, so use the public agent config as well.
   * No alias, family, wildcard or model slug inference. */
  catalogModels(ctx: AgyHostInventoryContext, selected: readonly string[] = []) {
    const ids = configuredAgyModelIds(ctx.config, selected);
    return ids.length ? this.modelsWithEffort(ctx, ids) : this.models(ctx);
  }

  async modelsWithEffort(ctx: AgyHostInventoryContext, modelIds: readonly string[]) {
    const scope = this.scope(ctx);
    const models = await this.inventory.get({ scope, fresh: true });
    // An injected model discoverer is a source-test dependency, not an
    // authorization to launch an ambient executable for metadata.
    const observe = this.options.observeEffort ?? (this.options.discoverModels ? undefined : observeAgyCatalogEffort);
    if (!observe || !modelIds.length) return models;
    const enriched = await observe(scope, models, modelIds);
    scope.assertActive();
    // Optional enrichment adds awaits. A newer in-flight/settled acquisition
    // or retirement must not publish this earlier list as fresh.
    if (this.inventory.peek(scope) !== models) {
      throw new AgyInventoryError("retired", performance.now(), "AGY catalog acquisition was superseded during capability observation");
    }
    return enriched;
  }

  /** No I/O, discovery, expiry renewal or authentication-mode inference.
   * For published modern catalogs, a pending equivalent refresh does not
   * itself revoke a still-fresh positive observation. Failure, withdrawal,
   * timeout, changed scope and disposal still remove that observation. */
  readiness(ctx: AgyHostInventoryContext & { provider: string; modelId: string }, published = false): { accountType: string } | undefined {
    if (this.stopped || ctx.provider !== "antigravity" || ctx.signal?.aborted || !this.configSnapshot) return undefined;
    const config = configuredPlugin(ctx.config, this.options.pluginConfig);
    if (!isDeepStrictEqual(config, this.configSnapshot)) return undefined;
    const env = { ...(ctx.env ?? process.env) };
    const cwd = resolve(ctx.workspaceDir ?? process.cwd());
    const fields = ["agentDir", "agentId", "agentRuntimeId", "authProfileId", "authProfileMode"] as const;
    for (const scope of [...this.observedScopes].reverse()) {
      if (scope.owner.configGeneration !== String(this.generation) || scope.cwd !== cwd ||
          !isDeepStrictEqual(scope.env, env) || fields.some((key) => scope.owner[key] !== ctx[key])) continue;
      if (this.inventory.peek(scope, published)?.some((model) => model.id === ctx.modelId)) return { accountType: "unreported" };
    }
    return undefined;
  }

  invalidate(): void { this.generation += 1; this.observedScopes.length = 0; this.inventory.invalidate(); }
  stop(): void { this.stopped = true; this.generation += 1; this.observedScopes.length = 0; this.inventory.stop(); }
}

export function resolveAgyHostInventoryOwner(options: AgyHostInventoryOptions): AgyHostInventoryOwner {
  return options.inventoryOwner ?? new AgyHostInventoryOwner(options);
}
