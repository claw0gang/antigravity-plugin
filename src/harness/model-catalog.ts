import { spawn } from "node:child_process";

const DEFAULT_MODEL_LIST_TIMEOUT_MS = 5_000;
const MAX_MODEL_LIST_OUTPUT_BYTES = 256 * 1024;
const FORCE_KILL_DELAY_MS = 500;
const MODEL_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

export type AgyDiscoveredModel = {
  id: string;
  name: string;
};

export type AgyModelListCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type AgyModelListExecutor = (params: {
  command: string;
  args: readonly string[];
  timeoutMs: number;
}) => Promise<AgyModelListCommandResult>;

function appendBounded(current: string, chunk: Buffer): string {
  const next = Buffer.concat([Buffer.from(current, "utf8"), chunk]);
  if (next.byteLength > MAX_MODEL_LIST_OUTPUT_BYTES) {
    throw new Error(`AGY models output exceeds ${MAX_MODEL_LIST_OUTPUT_BYTES} bytes`);
  }
  return next.toString("utf8");
}

export async function executeAgyModelListCommand(params: {
  command: string;
  args: readonly string[];
  timeoutMs: number;
}): Promise<AgyModelListCommandResult> {
  return await new Promise<AgyModelListCommandResult>((resolve, reject) => {
    const child = spawn(params.command, [...params.args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = () => {
      clearTimeout(timeout);
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
      }
    };

    const terminate = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, FORCE_KILL_DELAY_MS);
      forceKillTimer.unref();
      reject(error);
    };

    const timeout = setTimeout(() => {
      terminate(new Error(`agy models exceeded ${params.timeoutMs}ms timeout`));
    }, params.timeoutMs);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        stdout = appendBounded(stdout, chunk);
      } catch (error) {
        terminate(error);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      try {
        stderr = appendBounded(stderr, chunk);
      } catch (error) {
        terminate(error);
      }
    });
    child.once("error", terminate);
    child.once("close", (code) => {
      if (settled) {
        clearTimers();
        return;
      }
      settled = true;
      clearTimers();
      if (code === null) {
        reject(new Error("agy models exited without a numeric status"));
        return;
      }
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

export function parseAgyModelsOutput(stdout: string): AgyDiscoveredModel[] {
  const byId = new Map<string, AgyDiscoveredModel>();
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = /^(\S+)\s+(.+)$/u.exec(line);
    if (!match) {
      throw new Error(`unrecognized agy models line: ${line}`);
    }
    const id = match[1]?.trim() ?? "";
    const name = match[2]?.trim() ?? "";
    if (!MODEL_SLUG_PATTERN.test(id) || !name) {
      throw new Error(`invalid agy model row: ${line}`);
    }
    const existing = byId.get(id);
    if (existing && existing.name !== name) {
      throw new Error(`agy models returned conflicting names for ${id}`);
    }
    byId.set(id, { id, name });
  }
  const models = [...byId.values()];
  if (models.length === 0) {
    throw new Error("agy models returned no models");
  }
  return models;
}

export async function discoverAgyModels(params?: {
  command?: string;
  timeoutMs?: number;
  execute?: AgyModelListExecutor;
}): Promise<AgyDiscoveredModel[]> {
  const command = params?.command?.trim() || "agy";
  const timeoutMs = params?.timeoutMs ?? DEFAULT_MODEL_LIST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("AGY model discovery timeout must be a finite positive number");
  }
  const execute = params?.execute ?? executeAgyModelListCommand;
  // Intentionally use the documented plain `agy models` surface. Older 1.1.x
  // builds advertised --output-format for this subcommand before implementing it.
  const result = await execute({ command, args: ["models"], timeoutMs });
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    throw new Error(`agy models failed: ${detail}`);
  }
  return parseAgyModelsOutput(result.stdout);
}
