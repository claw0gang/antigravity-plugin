import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { createInvocationScope, type InvocationScope } from "./cli/invocation-scope.js";
import { resolveAntigravityPluginConfig, type AntigravityPluginConfig } from "./config.js";
import { AgyInventoryService } from "./inventory.js";
import { MAX_MODEL_LIST_TIMEOUT_MS, type discoverAgyModels } from "./harness/model-catalog.js";

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
};

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
  private configSnapshot: unknown;
  private hasConfigSnapshot = false;
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
    // Actual config changes revoke prior pending reads, including replacement
    // objects and in-place changes. Never derive public identities from secrets.
    const effectiveHostConfig = ctx.config === undefined && this.hasConfigSnapshot ? this.configSnapshot : ctx.config;
    if (!this.hasConfigSnapshot || !isDeepStrictEqual(this.configSnapshot, effectiveHostConfig)) {
      if (this.hasConfigSnapshot) this.inventory.invalidate();
      this.configSnapshot = structuredClone(effectiveHostConfig);
      this.hasConfigSnapshot = true;
      this.generation += 1;
    }
    const generation = this.generation;
    const observedConfig = structuredClone(ctx.config);
    const observedEnv = { ...(ctx.env ?? process.env) };
    const config = configuredPlugin(effectiveHostConfig, this.options.pluginConfig);
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
        if (this.stopped || this.generation !== generation || !isDeepStrictEqual(ctx.config, observedConfig) ||
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

  invalidate(): void { this.generation += 1; this.observedScopes.length = 0; this.inventory.invalidate(); }
  stop(): void { this.stopped = true; this.generation += 1; this.observedScopes.length = 0; this.inventory.stop(); }
}

export function resolveAgyHostInventoryOwner(options: AgyHostInventoryOptions): AgyHostInventoryOwner {
  return options.inventoryOwner ?? new AgyHostInventoryOwner(options);
}
