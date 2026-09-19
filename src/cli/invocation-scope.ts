import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";

export type InvocationScope = Readonly<{
  purpose: "attempt" | "inventory" | "capability_probe";
  command: string;
  cwd: string;
  env: Readonly<NodeJS.ProcessEnv>;
  signal?: AbortSignal;
  deadlineMonoMs: number;
  assertActive: () => void;
  owner: Readonly<Record<string, string | undefined>>;
  projectSelection?: Readonly<{ project?: string; newProject?: boolean }>;
  addDirs: readonly string[];
  nativeAgentSelection?: string;
  scopeKey?: string;
}>;

export class InvocationScopeError extends Error {
  constructor(readonly kind: "aborted" | "timeout" | "spawn", message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvocationScopeError";
  }
}

export type InvocationScopeOptions = {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  deadlineMonoMs?: number;
  assertActive?: () => void;
  purpose?: InvocationScope["purpose"];
  owner?: Record<string, string | undefined>;
  projectSelection?: { project?: string; newProject?: boolean };
  addDirs?: readonly string[];
  nativeAgentSelection?: string;
  scopeKey?: string;
};

/** Resolve against this environment once. A missing PATH never inherits the ambient PATH. */
function resolveExecutable(command: string, cwd: string, env: Readonly<NodeJS.ProcessEnv>): string {
  if (!command.trim() || command.includes("\0")) {
    throw new InvocationScopeError("spawn", "AGY command must be a nonempty executable name");
  }
  const paths = isAbsolute(command) || command.includes("/") || command.includes("\\")
    ? [resolve(cwd, command)]
    : (env.PATH === undefined ? [] : env.PATH.split(delimiter)).map((path) => resolve(cwd, path, command));
  for (const path of paths) {
    try { accessSync(path, constants.X_OK); return path; } catch { /* Try only this scope's PATH. */ }
  }
  throw new InvocationScopeError("spawn", "AGY executable was not found in the prepared invocation scope");
}

export function createInvocationScope(options: InvocationScopeOptions): InvocationScope {
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      (options.deadlineMonoMs !== undefined && !Number.isFinite(options.deadlineMonoMs))) {
    throw new InvocationScopeError("timeout", "AGY invocation deadline must be finite and positive");
  }
  const deadlineMonoMs = Math.min(options.deadlineMonoMs ?? Infinity, performance.now() + timeoutMs);
  const signal = options.signal;
  const assertOwnerActive = options.assertActive;
  const assertActive = (): void => {
    if (signal?.aborted) throw new InvocationScopeError("aborted", "AGY invocation was aborted");
    if (performance.now() >= deadlineMonoMs) throw new InvocationScopeError("timeout", "AGY invocation deadline expired");
    try { assertOwnerActive?.(); } catch (cause) {
      throw new InvocationScopeError("aborted", "AGY invocation owner is no longer active", { cause });
    }
  };
  assertActive();
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = Object.freeze({ ...(options.env ?? process.env) });
  return Object.freeze({
    purpose: options.purpose ?? "attempt",
    command: resolveExecutable(options.command, cwd, env), cwd, env, deadlineMonoMs, assertActive,
    owner: Object.freeze({ ...(options.owner ?? {}) }),
    addDirs: Object.freeze([...(options.addDirs ?? [])]),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.projectSelection ? { projectSelection: Object.freeze({ ...options.projectSelection }) } : {}),
    ...(options.nativeAgentSelection !== undefined ? { nativeAgentSelection: options.nativeAgentSelection } : {}),
    ...(options.scopeKey !== undefined ? { scopeKey: options.scopeKey } : {}),
  });
}
