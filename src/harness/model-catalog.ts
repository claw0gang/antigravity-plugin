import { runAgyRawProcess } from "../cli/agy-process.js";
import { createInvocationScope, type InvocationScope } from "../cli/invocation-scope.js";

export const MAX_MODEL_LIST_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_MODEL_LIST_ROWS = 5000;
export const MAX_MODEL_LIST_TIMEOUT_MS = 10_000;

export type AgyDiscoveredModel = { id: string; name: string };
export type AgyModelListCommandResult = { exitCode: number; stdout: string; stderr: string };
export type AgyModelListExecutor = (params: {
  command: string;
  args: readonly string[];
  timeoutMs: number;
  scope?: InvocationScope;
}) => Promise<AgyModelListCommandResult>;

/** Discovery never establishes that an inference attempt started. */
export class AgyModelDiscoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgyModelDiscoveryError";
  }
}

export async function executeAgyModelListCommand(params: Parameters<AgyModelListExecutor>[0]): Promise<AgyModelListCommandResult> {
  const scope = params.scope ?? createInvocationScope({
    command: params.command, timeoutMs: params.timeoutMs, purpose: "inventory",
  });
  return await runAgyRawProcess({
    scope, args: params.args, timeoutMs: params.timeoutMs,
    maxOutputBytes: MAX_MODEL_LIST_OUTPUT_BYTES,
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function validateRows(rows: unknown[]): AgyDiscoveredModel[] {
  if (rows.length > MAX_MODEL_LIST_ROWS) throw new AgyModelDiscoveryError(`AGY inventory exceeds ${MAX_MODEL_LIST_ROWS} rows`);
  const byId = new Map<string, { model: AgyDiscoveredModel; identity: string }>();
  for (const row of rows) {
    if (!record(row) || typeof row.id !== "string" || !row.id || /[\s\u0000-\u001f\u007f]/u.test(row.id)) {
      throw new AgyModelDiscoveryError("invalid agy model row");
    }
    const name = typeof row.name === "string" ? row.name : undefined;
    const label = typeof row.label === "string" ? row.label : undefined;
    if (name !== undefined && label !== undefined && name !== label) {
      throw new AgyModelDiscoveryError("invalid agy model row");
    }
    const displayName = name ?? label;
    if (displayName === undefined || !displayName.trim() || /[\u0000-\u001f\u007f]/u.test(displayName)) {
      // Do not retain untrusted rows, account details or diagnostics in errors.
      throw new AgyModelDiscoveryError("invalid agy model row");
    }
    const identity = canonical(row);
    const prior = byId.get(row.id);
    if (prior && prior.identity !== identity) {
      throw new AgyModelDiscoveryError("agy models returned conflicting duplicate IDs");
    }
    byId.set(row.id, { model: { id: row.id, name: displayName }, identity });
  }
  return [...byId.values()].map(({ model }) => model);
}

function modelRows(parsed: unknown): unknown[] | undefined {
  if (Array.isArray(parsed)) return parsed;
  if (!record(parsed)) return undefined;
  if (Array.isArray(parsed.models)) return parsed.models;
  const command = parsed.command;
  if (!record(command) || command.name !== "models" || !record(command.data)) return undefined;
  return Array.isArray(command.data.models) ? command.data.models : undefined;
}

/**
 * AGY documents JSON output since 1.1.12, below the supported 1.1.28 floor.
 * Global flags precede the `models` subcommand; native command output is wrapped
 * under command.data.models and uses `label` for the display name. Direct arrays
 * and top-level `models` remain accepted for bounded compatibility fixtures.
 */
export function parseAgyModelsOutput(stdout: string): AgyDiscoveredModel[] {
  if (Buffer.byteLength(stdout, "utf8") > MAX_MODEL_LIST_OUTPUT_BYTES) {
    throw new AgyModelDiscoveryError(`AGY inventory exceeds ${MAX_MODEL_LIST_OUTPUT_BYTES} bytes`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch {
    throw new AgyModelDiscoveryError("malformed AGY inventory JSON");
  }
  const rows = modelRows(parsed);
  if (!Array.isArray(rows)) throw new AgyModelDiscoveryError("AGY inventory JSON lacks a models array");
  // A valid empty array withdraws live rows. Blank/legacy output is a failure.
  return validateRows(rows);
}

/** Global flags affecting output/project/agent selection precede the AGY subcommand. */
export function buildAgyDiscoveryArgs(scope?: InvocationScope): string[] {
  const args = ["--output-format", "json"];
  if (scope?.projectSelection?.project !== undefined) args.push("--project", scope.projectSelection.project);
  // A future new-project selection remains in the shared scope. Inventory must
  // not allocate that project merely to inspect available model IDs.
  for (const directory of scope?.addDirs ?? []) args.push("--add-dir", directory);
  if (scope?.nativeAgentSelection !== undefined) args.push("--agent", scope.nativeAgentSelection);
  args.push("models");
  return args;
}

export async function discoverAgyModels(params?: {
  scope?: InvocationScope;
  command?: string;
  timeoutMs?: number;
  execute?: AgyModelListExecutor;
}): Promise<AgyDiscoveredModel[]> {
  const timeoutMs = params?.timeoutMs ?? MAX_MODEL_LIST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_MODEL_LIST_TIMEOUT_MS) {
    throw new AgyModelDiscoveryError(`AGY model discovery timeout must be positive and at most ${MAX_MODEL_LIST_TIMEOUT_MS}ms`);
  }
  if (params?.scope && params.command !== undefined && params.command !== params.scope.command) {
    throw new AgyModelDiscoveryError("AGY discovery command cannot override its invocation scope");
  }
  try {
    params?.scope?.assertActive();
    const command = params?.scope?.command ?? params?.command ?? "agy";
    const result = await (params?.execute ?? executeAgyModelListCommand)({
      command, args: buildAgyDiscoveryArgs(params?.scope), timeoutMs,
      ...(params?.scope ? { scope: params.scope } : {}),
    });
    params?.scope?.assertActive();
    if (Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8") > MAX_MODEL_LIST_OUTPUT_BYTES) {
      throw new AgyModelDiscoveryError(`AGY inventory exceeds ${MAX_MODEL_LIST_OUTPUT_BYTES} bytes`);
    }
    if (result.exitCode !== 0) throw new AgyModelDiscoveryError(`agy models failed (exit ${result.exitCode}); native diagnostics withheld`);
    return parseAgyModelsOutput(result.stdout);
  } catch (cause) {
    if (cause instanceof AgyModelDiscoveryError) throw cause;
    throw new AgyModelDiscoveryError("AGY model discovery failed before inference admission", { cause });
  }
}
