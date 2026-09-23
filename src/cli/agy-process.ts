import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";

import {
  AgyStreamAccumulator,
  AgyStreamProtocolError,
  type AgyStreamEvent,
  type AgyStreamPartialSnapshot,
  type AgyStreamSnapshot,
} from "../protocol/agy-stream.js";
import {
  createAttemptEvidence, recordAgyUsage, recordSnapshotAccounting, snapshotAttemptEvidence, type AttemptEvidence,
} from "./attempt-evidence.js";
import {
  createInvocationScope, InvocationScopeError, type InvocationScope,
} from "./invocation-scope.js";

export const AGY_PROCESS_LIMITS = Object.freeze({
  termGraceMs: 2_000, killDrainMs: 2_000, cleanupMs: 2_000, settlementMs: 6_000,
  callbackMs: 1_000, promptBytes: 1_048_576, eventBytes: 1_048_576,
  outputBytes: 33_554_432, stderrBytes: 65_536, queueBytes: 2_097_152,
});

export type AgyProcessFailureKind = "spawn" | "protocol" | "aborted" | "timeout" |
  "native_timeout" | "process_terminal_mismatch" | "output_limit" | "callback" | "cleanup";

export class AgyProcessError extends Error {
  readonly kind: AgyProcessFailureKind;
  readonly stderr: string;
  readonly evidence: AttemptEvidence;
  readonly partialSnapshot?: AgyStreamPartialSnapshot;
  constructor(kind: AgyProcessFailureKind, message: string, options?: {
    cause?: unknown; stderr?: string; evidence?: AttemptEvidence;
    partialSnapshot?: AgyStreamPartialSnapshot;
  }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AgyProcessError";
    this.kind = kind;
    this.stderr = options?.stderr ?? "";
    this.evidence = snapshotAttemptEvidence(options?.evidence ?? createAttemptEvidence());
    if (options?.partialSnapshot !== undefined) this.partialSnapshot = options.partialSnapshot;
  }
}

/** Consumers must check assertActive immediately before mutations, including after awaits. */
export type AgyCallbackContext = Readonly<{ signal: AbortSignal; assertActive: () => void; markOutputDelivered: () => void }>;

type BaseOptions = {
  scope?: InvocationScope;
  command?: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  stdin?: string;
  onStderr?: (chunk: string, context: AgyCallbackContext) => void | Promise<void>;
};

export type RunAgyRawProcessOptions = BaseOptions & {
  maxOutputBytes?: number;
  onStdout?: (chunk: string, context: AgyCallbackContext) => void | Promise<void>;
};
export type RunAgyRawProcessResult = {
  exitCode: number; stdout: string; stderr: string; evidence: AttemptEvidence;
};
export type RunAgyStreamProcessOptions = BaseOptions & {
  expectedModelId?: string;
  expectedConversationId?: string;
  onEvent?: (event: AgyStreamEvent, context: AgyCallbackContext) => void | Promise<void>;
};
export type RunAgyStreamProcessResult = {
  exitCode: number; snapshot: AgyStreamSnapshot; stderr: string; evidence: AttemptEvidence;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function boundedTail(text: string, limit: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  let start = bytes.length - limit;
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

function diagnosticRedactor(env: Readonly<NodeJS.ProcessEnv>): (value: string) => string {
  const sensitiveValues = Object.entries(env)
    .filter(([key, value]) => /token|password|secret|credential|api.?key|authorization/i.test(key) &&
      typeof value === "string" && value.length >= 4)
    .map(([, value]) => value as string).sort((a, b) => b.length - a.length);
  return (value) => {
    let redacted = value.replace(/\bBearer\s+[^\s]+/gi, "Bearer [redacted]");
    for (const secret of sensitiveValues) redacted = redacted.split(secret).join("[redacted]");
    return redacted;
  };
}

function processError(error: unknown, fallback: AgyProcessFailureKind = "protocol"): AgyProcessError {
  if (error instanceof AgyProcessError) return error;
  if (error instanceof InvocationScopeError) return new AgyProcessError(error.kind, error.message, { cause: error });
  return new AgyProcessError(fallback, fallback === "callback" ? "AGY callback failed" : "AGY process operation failed", { cause: error });
}

function streamProtocolDiagnostic(error: unknown): string {
  if (!(error instanceof AgyStreamProtocolError)) return "AGY emitted an invalid stream event";
  if (error.code === "malformed_event") {
    return `AGY emitted an invalid stream event: ${error.message}`;
  }
  return `AGY emitted an invalid stream event (${error.code})`;
}

async function boundedCallback(
  callback: (context: AgyCallbackContext) => void | Promise<void>,
  parent: AgyCallbackContext,
): Promise<void> {
  parent.assertActive();
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  parent.signal.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const context: AgyCallbackContext = Object.freeze({
    signal: controller.signal,
    markOutputDelivered() { context.assertActive(); parent.markOutputDelivered(); },
    assertActive() {
      if (controller.signal.aborted) throw new AgyProcessError("callback", "AGY callback authority expired");
      parent.assertActive();
    },
  });
  try {
    await Promise.race([
      Promise.resolve().then(() => { context.assertActive(); return callback(context); }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new AgyProcessError("callback", "AGY callback exceeded its 1 second allowance"));
        }, AGY_PROCESS_LIMITS.callbackMs);
        controller.signal.addEventListener("abort", () => {
          reject(new AgyProcessError("callback", "AGY callback authority expired"));
        }, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    parent.signal.removeEventListener("abort", abort);
  }
}

type StreamConsumer = {
  consume: (chunk: string, context: AgyCallbackContext) => Promise<void>;
  finish: (context: AgyCallbackContext) => Promise<void>;
};

async function runBoundedProcess(
  options: RunAgyRawProcessOptions,
  evidence: AttemptEvidence,
  stream?: StreamConsumer,
): Promise<RunAgyRawProcessResult> {
  const operationStartedMonoMs = performance.now();
  let scope: InvocationScope;
  let deadline: number;
  let stdin: string | undefined;
  try {
    const timeoutMs = options.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new AgyProcessError("timeout", "AGY process timeout must be finite and positive");
    }
    scope = options.scope ?? createInvocationScope({
      command: options.command ?? "", ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    deadline = Math.min(scope.deadlineMonoMs, operationStartedMonoMs + (timeoutMs ?? Infinity));
    scope.assertActive();
    stdin = options.stdin;
    if (stdin !== undefined && Buffer.byteLength(stdin) > AGY_PROCESS_LIMITS.promptBytes) {
      throw new AgyProcessError("output_limit", "AGY encoded stdin exceeds the 1 MiB prompt limit");
    }
    if (process.platform === "win32") {
      throw new AgyProcessError("spawn", "AGY process containment is not qualified on Windows");
    }
    if (options.maxOutputBytes !== undefined && (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0)) {
      throw new AgyProcessError("output_limit", "AGY output limit must be a positive safe integer");
    }
  } catch (error) {
    const failure = processError(error);
    throw new AgyProcessError(failure.kind, failure.message, { cause: failure.cause, evidence });
  }
  const redact = diagnosticRedactor(scope.env);
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  const lifecycle = new AbortController();
  let settled = false;
  let fatal: AgyProcessError | undefined;
  let stderrRaw = "";
  let stdout = "";
  let warningWindow = "";
  let stderrDeliveryBuffer = "";
  let totalBytes = 0;
  let queuedBytes = 0;
  let streamsClosed = false;
  let forcedPipeClose = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let cleanupPromise: Promise<boolean> | undefined;
  let stopResolve!: () => void;
  const stopped = new Promise<void>((resolve) => { stopResolve = resolve; });
  const queue: Array<{ channel: "stdout" | "stderr"; text: string; bytes: number }> = [];
  let pumping: Promise<void> | undefined;
  const context: AgyCallbackContext = Object.freeze({
    signal: lifecycle.signal,
    markOutputDelivered() { context.assertActive(); evidence.deliveredOutput = true; },
    assertActive() {
      if (settled || lifecycle.signal.aborted) throw new AgyProcessError("aborted", "AGY callback owner was retired");
      scope.assertActive();
      if (performance.now() >= deadline) throw new AgyProcessError("timeout", "AGY invocation deadline expired");
    },
  });
  // This fact is set before spawn. Only a definite OS rejection may establish no-start.
  evidence.invocation = "possible";
  evidence.effects = "unknown";
  evidence.termination = { containment: "posix_process_group", cleanupComplete: false };
  let child: ReturnType<typeof spawn>;
  try {
    // Materialize caller inputs before the final fence. Their getters/iteration
    // may consume the narrower operation allowance while its scope stays live.
    const command = scope.command;
    const args = [...options.args];
    const spawnOptions = {
      cwd: scope.cwd, env: { ...scope.env }, shell: false, detached: true,
      stdio: "pipe" as const,
    };
    context.assertActive();
    // Intentional CLI-bridge capability: command is a resolved executable, argv is structured,
    // shell execution is disabled, and model/user prompt content is delivered only over stdin.
    child = spawn(command, args, spawnOptions);
  } catch (error) {
    evidence.invocation = "not_started";
    evidence.effects = "none_proven";
    const failure = processError(error, "spawn");
    evidence.termination = { containment: "not_started", cleanupComplete: true, hostReason: failure.kind };
    throw new AgyProcessError(failure.kind, failure.message, { cause: failure.cause, evidence });
  }
  const ownedGroupExists = (): boolean => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  };
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch { /* Existence/drain check decides cleanup truth. */ }
  };
  const beginCleanup = (): Promise<boolean> => {
    if (cleanupPromise) return cleanupPromise;
    const start = performance.now();
    evidence.termination.settlementDeadlineMonoMs = start + AGY_PROCESS_LIMITS.settlementMs;
    cleanupPromise = (async () => {
      signalGroup("SIGTERM");
      while (ownedGroupExists() && performance.now() < start + AGY_PROCESS_LIMITS.termGraceMs) await delay(20);
      if (ownedGroupExists()) signalGroup("SIGKILL");
      while (ownedGroupExists() && performance.now() < start + AGY_PROCESS_LIMITS.termGraceMs + AGY_PROCESS_LIMITS.killDrainMs) await delay(20);
      return !ownedGroupExists();
    })();
    stopResolve();
    return cleanupPromise;
  };
  const fail = (error: unknown, kind?: AgyProcessFailureKind): void => {
    if (!fatal) {
      fatal = processError(error, kind);
      evidence.termination.hostReason = fatal.kind;
      lifecycle.abort();
      queue.length = 0;
      queuedBytes = 0;
    }
    void beginCleanup();
  };
  const pump = (): void => {
    if (pumping) return;
    pumping = (async () => {
      while (!fatal && queue.length) {
        const entry = queue.shift()!;
        queuedBytes -= entry.bytes;
        context.assertActive();
        if (entry.channel === "stdout") {
          if (stream) await stream.consume(entry.text, context);
          else if (options.onStdout) await boundedCallback((ctx) => options.onStdout!(entry.text, ctx), context);
        } else if (options.onStderr) {
          await boundedCallback((ctx) => options.onStderr!(redact(entry.text), ctx), context);
        }
      }
    })().catch((error) => fail(error, "callback")).finally(() => {
      pumping = undefined;
      if (!fatal && queue.length) pump();
    });
  };
  const enqueue = (channel: "stdout" | "stderr", text: string): void => {
    if (!text || fatal) return;
    const bytes = Buffer.byteLength(text);
    if (queuedBytes + bytes > AGY_PROCESS_LIMITS.queueBytes) {
      fail(new AgyProcessError("output_limit", "AGY delivery queue exceeds 2 MiB"));
      return;
    }
    queue.push({ channel, text, bytes });
    queuedBytes += bytes;
    pump();
  };
  const receive = (channel: "stdout" | "stderr", buffer: Buffer): void => {
    try {
      totalBytes += buffer.length;
      evidence.outputObserved = true;
      if (totalBytes > (options.maxOutputBytes ?? AGY_PROCESS_LIMITS.outputBytes)) {
        fail(new AgyProcessError("output_limit", "AGY process exceeded its combined output byte limit"));
        return;
      }
      const text = (channel === "stdout" ? stdoutDecoder : stderrDecoder).write(buffer);
      if (channel === "stderr") {
        stderrRaw = boundedTail(stderrRaw + text, AGY_PROCESS_LIMITS.stderrBytes);
        warningWindow = boundedTail(warningWindow + text, 4_096);
        if (/\b(?:timed[ -]?out|timeout\s+(?:reached|exceeded)|deadline\s+exceeded|execution\s+timeout)\b/i.test(warningWindow)) {
          evidence.terminal.nativeTimeout = true;
        }
        if (/\b(?:warning|warn|error|fatal|truncated|truncation)\b[: ]/i.test(warningWindow)) {
          evidence.terminal.nativeCriticalWarning = true;
        }
        // Deliver complete diagnostic lines so split credential values are redacted together.
        stderrDeliveryBuffer = boundedTail(stderrDeliveryBuffer + text, AGY_PROCESS_LIMITS.stderrBytes);
        const lineEnd = stderrDeliveryBuffer.lastIndexOf("\n");
        if (lineEnd >= 0) {
          enqueue("stderr", redact(stderrDeliveryBuffer.slice(0, lineEnd + 1)));
          stderrDeliveryBuffer = stderrDeliveryBuffer.slice(lineEnd + 1);
        }
      } else if (!stream) stdout += text;
      if (channel === "stdout") enqueue(channel, text);
    } catch (error) { fail(error); }
  };
  child.stdout!.on("data", (buffer: Buffer) => receive("stdout", buffer));
  child.stderr!.on("data", (buffer: Buffer) => receive("stderr", buffer));
  child.stdout!.on("error", (error) => fail(error));
  child.stderr!.on("error", (error) => fail(error));
  child.stdin!.on("error", (error: NodeJS.ErrnoException) => {
    if (stdin !== undefined) fail(new AgyProcessError("protocol", "AGY stdin delivery failed", { cause: error }));
  });
  child.once("spawn", () => {
    evidence.invocation = "started";
    try {
      context.assertActive();
      if (stdin !== undefined) child.stdin!.end(stdin, "utf8");
      else child.stdin!.end();
    } catch (error) { fail(error); }
  });
  child.once("error", (error) => {
    if (child.pid === undefined && evidence.invocation === "possible") {
      evidence.invocation = "not_started";
      evidence.effects = "none_proven";
      evidence.termination.containment = "not_started";
    }
    fail(new AgyProcessError("spawn", "failed to start AGY process", { cause: error }));
  });
  child.once("exit", (code, signal) => {
    exitCode = code;
    exitSignal = signal;
    if (code !== null) evidence.termination.exitCode = code;
    if (signal !== null) evidence.termination.signal = signal;
    void beginCleanup();
  });
  child.once("close", () => {
    streamsClosed = true;
    const outTail = stdoutDecoder.end();
    if (!stream) stdout += outTail;
    enqueue("stdout", outTail);
    const errTail = stderrDecoder.end();
    stderrRaw = boundedTail(stderrRaw + errTail, AGY_PROCESS_LIMITS.stderrBytes);
    enqueue("stderr", redact(stderrDeliveryBuffer + errTail));
    stderrDeliveryBuffer = "";
  });
  const abort = (): void => fail(new AgyProcessError("aborted", "AGY process was aborted"));
  scope.signal?.addEventListener("abort", abort, { once: true });
  if (scope.signal?.aborted) abort();
  const deadlineTimer = setTimeout(() => fail(new AgyProcessError("timeout", "AGY process exceeded its invocation deadline")), Math.max(0, deadline - performance.now()));
  const ownerTimer = setInterval(() => { if (!fatal) { try { context.assertActive(); } catch (error) { fail(error); } } }, 100);
  try {
    await stopped;
    const groupClean = await beginCleanup();
    const settlementDeadline = evidence.termination.settlementDeadlineMonoMs!;
    const pipeDeadline = settlementDeadline - AGY_PROCESS_LIMITS.cleanupMs;
    while (!streamsClosed && performance.now() < pipeDeadline) await delay(10);
    if (!streamsClosed) {
      forcedPipeClose = true;
      fail(new AgyProcessError("cleanup", "AGY inherited pipes did not close within the process cleanup allowance"));
      child.stdout!.destroy(); child.stderr!.destroy(); child.stdin!.destroy();
    }
    while ((pumping || queue.length) && performance.now() < settlementDeadline) await delay(5);
    if (pumping || queue.length) fail(new AgyProcessError("cleanup", "AGY callbacks did not drain before settlement"));
    if (!fatal && stream) {
      let finishTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          stream.finish(context),
          new Promise<never>((_, reject) => {
            finishTimer = setTimeout(() => reject(new AgyProcessError("cleanup", "AGY final callback missed settlement deadline")), Math.max(0, settlementDeadline - performance.now()));
          }),
        ]).catch((error) => fail(error));
      } finally { if (finishTimer !== undefined) clearTimeout(finishTimer); }
    }
    evidence.termination.cleanupComplete = groupClean && streamsClosed && !forcedPipeClose && !pumping && queue.length === 0;
    if (!groupClean) fail(new AgyProcessError("cleanup", "AGY process group termination could not be established"));
    if (fatal) throw new AgyProcessError(fatal.kind, fatal.message, { cause: fatal.cause, stderr: redact(stderrRaw), evidence });
    if (exitCode === null) throw new AgyProcessError("process_terminal_mismatch", `AGY process ended without numeric exit${exitSignal ? ` (${exitSignal})` : ""}`, { stderr: redact(stderrRaw), evidence });
    return { exitCode, stdout, stderr: redact(stderrRaw), evidence: snapshotAttemptEvidence(evidence) };
  } finally {
    settled = true;
    lifecycle.abort();
    clearTimeout(deadlineTimer); clearInterval(ownerTimer);
    scope.signal?.removeEventListener("abort", abort);
    child.stdin!.destroy(); child.stdout!.destroy(); child.stderr!.destroy();
  }
}

export async function runAgyRawProcess(options: RunAgyRawProcessOptions): Promise<RunAgyRawProcessResult> {
  return runBoundedProcess(options, createAttemptEvidence());
}

export async function runAgyStreamProcess(options: RunAgyStreamProcessOptions): Promise<RunAgyStreamProcessResult> {
  const evidence = createAttemptEvidence(options.expectedModelId);
  const accumulator = new AgyStreamAccumulator({
    ...(options.expectedModelId !== undefined ? { expectedModelId: options.expectedModelId } : {}),
    ...(options.expectedConversationId !== undefined ? { expectedConversationId: options.expectedConversationId } : {}),
  });
  let lineBuffer = "";
  let retainedStderr = "";
  const consumeLine = async (line: string, context: AgyCallbackContext): Promise<void> => {
    if (!line.trim()) return;
    context.assertActive();
    if (Buffer.byteLength(line) > AGY_PROCESS_LIMITS.eventBytes) throw new AgyProcessError("output_limit", "AGY stream event exceeds 1 MiB");
    let event: AgyStreamEvent;
    try { event = accumulator.consumeLine(line.replace(/\r$/, "")); }
    catch (error) { throw new AgyProcessError("protocol", streamProtocolDiagnostic(error), { cause: error }); }
    recordAgyUsage(evidence, event);
    if (event.event === "init") {
      evidence.acknowledgedModelId = event.init.model;
      evidence.conversationId = event.conversation_id;
      evidence.nativeIdentityVerified = options.expectedModelId !== undefined && event.init.model === options.expectedModelId;
    } else if (event.event === "step_update" && event.step_update.step_type === "tool") {
      evidence.effects = "observed_possible";
    } else if (event.event === "result") {
      evidence.terminal.nativeStatus = event.result.status;
      evidence.terminal.deniedActions = event.result.denied_actions?.length ?? 0;
    }
    if (options.onEvent) {
      await boundedCallback((ctx) => options.onEvent!(event, ctx), context);
    }
  };
  try {
    const result = await runBoundedProcess(options, evidence, {
      async consume(chunk, context) {
        lineBuffer += chunk;
        for (;;) {
          const index = lineBuffer.indexOf("\n");
          if (index < 0) break;
          const line = lineBuffer.slice(0, index);
          lineBuffer = lineBuffer.slice(index + 1);
          await consumeLine(line, context);
        }
        if (Buffer.byteLength(lineBuffer) > AGY_PROCESS_LIMITS.eventBytes) throw new AgyProcessError("output_limit", "AGY unterminated stream event exceeds 1 MiB");
      },
      async finish(context) {
        if (lineBuffer.trim()) await consumeLine(lineBuffer, context);
        lineBuffer = "";
      },
    });
    retainedStderr = result.stderr;
    let snapshot: AgyStreamSnapshot;
    try { snapshot = accumulator.finalize(); }
    catch (cause) { throw new AgyProcessError("protocol", "AGY stream did not complete its required terminal contract", { cause }); }
    evidence.terminal.protocolComplete = true;
    const terminalSuccess = snapshot.result.status === "SUCCESS";
    if (terminalSuccess && result.exitCode !== 0) {
      throw new AgyProcessError(
        "process_terminal_mismatch",
        `AGY process exit ${result.exitCode} contradicts terminal status ${snapshot.result.status}`,
      );
    }
    // Current AGY can report a structured ERROR/INVALID result while exiting
    // zero. Preserve the native terminal status as authoritative failure
    // evidence; exit zero must never promote it to success.
    if (evidence.terminal.nativeTimeout) throw new AgyProcessError("native_timeout", "AGY reported native timeout or truncation despite its terminal status");
    if (evidence.terminal.nativeCriticalWarning) throw new AgyProcessError("protocol", "AGY reported an unrecognized critical diagnostic; completed success is unproven");
    return { exitCode: result.exitCode, snapshot, stderr: result.stderr, evidence: snapshotAttemptEvidence(evidence) };
  } catch (error) {
    const partialSnapshot = accumulator.partialSnapshot();
    recordSnapshotAccounting(evidence, partialSnapshot);
    if (partialSnapshot.init?.model !== undefined) evidence.acknowledgedModelId = partialSnapshot.init.model;
    if (partialSnapshot.conversationId !== undefined) evidence.conversationId = partialSnapshot.conversationId;
    if (partialSnapshot.result !== undefined) {
      evidence.terminal.nativeStatus = partialSnapshot.result.status;
      evidence.terminal.deniedActions = partialSnapshot.result.denied_actions?.length ?? 0;
    }
    const failure = processError(error);
    throw new AgyProcessError(failure.kind, failure.message, {
      cause: failure.cause, stderr: failure.stderr || retainedStderr, evidence, partialSnapshot,
    });
  }
}
