import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import {
  AgyStreamAccumulator,
  AgyStreamProtocolError,
  type AgyStreamEvent,
  type AgyStreamSnapshot,
} from "../protocol/agy-stream.js";

const STDERR_LIMIT_BYTES = 64 * 1024;
const FORCE_KILL_DELAY_MS = 500;

export type AgyProcessFailureKind =
  | "spawn"
  | "protocol"
  | "aborted"
  | "timeout"
  | "process_terminal_mismatch";

export class AgyProcessError extends Error {
  readonly kind: AgyProcessFailureKind;
  readonly stderr: string;

  constructor(
    kind: AgyProcessFailureKind,
    message: string,
    options?: { cause?: unknown; stderr?: string },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AgyProcessError";
    this.kind = kind;
    this.stderr = options?.stderr ?? "";
  }
}

export type RunAgyStreamProcessOptions = {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  onEvent?: (event: AgyStreamEvent) => void | Promise<void>;
  onStderr?: (chunk: string) => void;
};

export type RunAgyStreamProcessResult = {
  exitCode: number;
  snapshot: AgyStreamSnapshot;
  stderr: string;
};

function appendBoundedUtf8(current: string, chunk: string): string {
  const combined = current + chunk;
  const bytes = Buffer.byteLength(combined, "utf8");
  if (bytes <= STDERR_LIMIT_BYTES) {
    return combined;
  }
  const buffer = Buffer.from(combined, "utf8");
  return buffer.subarray(buffer.length - STDERR_LIMIT_BYTES).toString("utf8");
}

export async function runAgyStreamProcess(
  options: RunAgyStreamProcessOptions,
): Promise<RunAgyStreamProcessResult> {
  if (!options.command.trim()) {
    throw new AgyProcessError("spawn", "AGY command must not be empty");
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new AgyProcessError("timeout", "AGY timeoutMs must be a finite positive number");
  }

  const accumulator = new AgyStreamAccumulator();
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let stdoutBuffer = "";
  let stderr = "";
  let fatalError: AgyProcessError | undefined;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const terminate = (error: AgyProcessError): void => {
    if (fatalError) {
      return;
    }
    fatalError = error;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, FORCE_KILL_DELAY_MS);
      forceKillTimer.unref();
    }
  };

  const consumeLine = async (line: string): Promise<void> => {
    if (fatalError || !line.trim()) {
      return;
    }
    let event: AgyStreamEvent;
    try {
      event = accumulator.consumeLine(line);
    } catch (error) {
      terminate(
        new AgyProcessError("protocol", "AGY emitted an invalid stream event", {
          cause: error,
          stderr,
        }),
      );
      return;
    }
    if (!options.onEvent) {
      return;
    }
    try {
      await options.onEvent(event);
    } catch (error) {
      terminate(
        new AgyProcessError("protocol", "AGY event callback failed", {
          cause: error,
          stderr,
        }),
      );
    }
  };

  const stdoutTask = (async (): Promise<void> => {
    for await (const chunk of child.stdout) {
      stdoutBuffer += stdoutDecoder.write(chunk as Buffer);
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        await consumeLine(line);
        if (fatalError) {
          return;
        }
      }
    }
    stdoutBuffer += stdoutDecoder.end();
    if (stdoutBuffer.trim()) {
      await consumeLine(stdoutBuffer.replace(/\r$/, ""));
      stdoutBuffer = "";
    }
  })();
  child.stderr.on("data", (chunk: Buffer) => {
    const text = stderrDecoder.write(chunk);
    stderr = appendBoundedUtf8(stderr, text);
    options.onStderr?.(text);
  });

  const abort = (): void =>
    terminate(new AgyProcessError("aborted", "AGY process was aborted", { stderr }));
  if (options.signal?.aborted) {
    abort();
  } else {
    options.signal?.addEventListener("abort", abort, { once: true });
  }
  if (options.timeoutMs !== undefined) {
    timeoutTimer = setTimeout(() => {
      terminate(new AgyProcessError("timeout", "AGY process exceeded its timeout", { stderr }));
    }, options.timeoutMs);
    timeoutTimer.unref();
  }

  const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("error", (error) => {
        terminate(
          new AgyProcessError("spawn", "failed to start AGY process", { cause: error, stderr }),
        );
      });
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  const [close] = await Promise.all([closePromise, stdoutTask]);

  if (timeoutTimer !== undefined) {
    clearTimeout(timeoutTimer);
  }
  if (forceKillTimer !== undefined) {
    clearTimeout(forceKillTimer);
  }
  options.signal?.removeEventListener("abort", abort);

  const stderrTail = stderrDecoder.end();
  if (stderrTail) {
    stderr = appendBoundedUtf8(stderr, stderrTail);
    options.onStderr?.(stderrTail);
  }

  if (fatalError) {
    throw new AgyProcessError(fatalError.kind, fatalError.message, {
      cause: fatalError.cause,
      stderr,
    });
  }

  let snapshot: AgyStreamSnapshot;
  try {
    snapshot = accumulator.finalize();
  } catch (error) {
    if (error instanceof AgyStreamProtocolError) {
      throw new AgyProcessError("protocol", error.message, { cause: error, stderr });
    }
    throw error;
  }

  const exitCode = close.code;
  if (exitCode === null) {
    throw new AgyProcessError(
      close.signal ? "aborted" : "process_terminal_mismatch",
      `AGY process exited without a numeric status${close.signal ? ` (${close.signal})` : ""}`,
      { stderr },
    );
  }
  const terminalSuccess = snapshot.result.status === "SUCCESS";
  if ((terminalSuccess && exitCode !== 0) || (!terminalSuccess && exitCode === 0)) {
    throw new AgyProcessError(
      "process_terminal_mismatch",
      `AGY process exit ${exitCode} contradicts terminal status ${snapshot.result.status}`,
      { stderr },
    );
  }

  return { exitCode, snapshot, stderr };
}
