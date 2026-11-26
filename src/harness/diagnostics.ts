import { AgyProcessError } from "../cli/agy-process.js";
import type { AttemptEvidence } from "../cli/attempt-evidence.js";
import { InvocationScopeError } from "../cli/invocation-scope.js";
import { SessionSnapshotStaleError } from "../host/session-runtime.js";
import type { agentHarnessAttemptTerminal } from "../host/terminal.js";
import { AgyStreamProtocolError } from "../protocol/agy-stream.js";
import { AgyEffortError } from "./model-capabilities.js";

export type DiagnosticStage = "session_prepare" | "preflight" | "discovery" | "before_spawn" |
  "active_stream" | "init_bind" | "native_result" | "settlement" | "delivery" | "cleanup";

// Keep the original sanitized text by identity, not by the mutable Error
// message or a caller-supplied label. Composite diagnostics use the same path.
const safeDiagnostics = new WeakMap<Error, string>();

function safeDiagnostic(message: string): Error {
  const diagnostic = new Error(message);
  safeDiagnostics.set(diagnostic, message);
  return diagnostic;
}

export function terminalDiagnostic(terminal: ReturnType<typeof agentHarnessAttemptTerminal.normalize>): unknown {
  return terminal.kind === "ok" ? undefined : terminal.kind === "failed" ? terminal.error : terminal.failure?.error;
}

export function appendDiagnostic(
  primary: unknown, stage: DiagnosticStage, original: unknown, evidence: AttemptEvidence,
): Error {
  const secondary = diagnosticError(stage, original, evidence);
  const prior = primary instanceof Error ? safeDiagnostics.get(primary) : undefined;
  return prior ? safeDiagnostic(`${prior}; secondary=${secondary.message}`) : secondary;
}

export function nativeResultDiagnostic(reason: "ERROR" | "INVALID" | "error", evidence: AttemptEvidence): Error {
  const disposition = reason === "error" ? "AGY reported finished_reason error" : `AGY returned ${reason}`;
  return safeDiagnostic(`${disposition}; native diagnostic withheld. ${diagnosticError("native_result", undefined, evidence).message}`);
}

/** Report only allowlisted types and structural facts. Native messages, paths,
 * identifiers, stderr and arbitrary cause text can contain credentials or prompts. */
export function diagnosticError(stage: DiagnosticStage, original: unknown, evidence: AttemptEvidence): Error {
  const chain: string[] = [];
  const visited = new Set<unknown>();
  let cursor: unknown = original;
  while (cursor instanceof Error && !visited.has(cursor) && chain.length < 8) {
    visited.add(cursor);
    if (cursor instanceof SessionSnapshotStaleError) {
      chain.push(`SessionSnapshotStaleError(snapshot is stale; fields=${cursor.fields.join(",")})`);
    } else if (cursor instanceof AgyProcessError) {
      chain.push(`AgyProcessError(kind=${cursor.kind})`);
    } else if (cursor instanceof InvocationScopeError) {
      chain.push(`InvocationScopeError(kind=${cursor.kind})`);
    } else if (cursor instanceof AgyEffortError) {
      const kind = ["unverified-report", "unsupported-level", "fixed-or-unobserved", "effective-model-unverified", "resume-variant-change", "probe-unavailable"].includes(cursor.kind) ? cursor.kind : "unverified-report";
      chain.push(`AgyEffortError(${kind}; refresh or select the exact native variant; reset before changing a bound variant)`);
    } else if (cursor instanceof AgyStreamProtocolError) {
      chain.push(`AgyStreamProtocolError(code=${cursor.code})`);
    } else {
      const code = (cursor as NodeJS.ErrnoException).code;
      const knownMessages: ReadonlyArray<readonly [string, string]> = [
        ["ANTIGRAVITY requires host-owned execution tools", "host-owned execution tools required"],
        ["ANTIGRAVITY requires a host canonical session adapter", "host canonical session adapter required"],
        ["ANTIGRAVITY cannot preserve required host context:", "cannot preserve required host context"],
        ["ANTIGRAVITY canonical binding changed during preparation;", "binding changed during preparation"],
      ];
      const known = knownMessages.find(([prefix]) => cursor instanceof Error && cursor.message.startsWith(prefix));
      chain.push(known ? `Error(${known[1]})` : typeof code === "string" && /^E[A-Z0-9]{2,15}$/.test(code) ? `Error(code=${code})` : "Error");
    }
    cursor = cursor.cause;
  }
  if (!chain.length) chain.push("unknown");
  const termination = evidence.termination;
  const safeHostReasons = new Set(["spawn", "protocol", "aborted", "timeout", "native_timeout",
    "process_terminal_mismatch", "output_limit", "callback", "cleanup"]);
  const facts = [
    `stage=${stage}`,
    `cause=${chain.join(" <- ")}`,
    `inferenceChild=${evidence.invocation}`,
    ...(termination.exitCode !== undefined ? [`exit=${termination.exitCode}`] : []),
    ...(termination.signal !== undefined && /^SIG[A-Z0-9]+$/.test(termination.signal) ? [`signal=${termination.signal}`] : []),
    ...(termination.hostReason && safeHostReasons.has(termination.hostReason) ? [`hostReason=${termination.hostReason}`] : []),
    `cleanup=${termination.cleanupComplete ? "confirmed" : "unconfirmed"}`,
    ...(evidence.terminal.nativeStatus === "ERROR" || evidence.terminal.nativeStatus === "INVALID"
      ? [`nativeStatus=${evidence.terminal.nativeStatus}`] : []),
    ...(evidence.terminal.nativeTimeout ? ["nativeTimeout=observed"] : []),
    ...(evidence.terminal.nativeCriticalWarning ? ["nativeCriticalWarning=observed"] : []),
  ];
  // Do not retain the original cause: Gateway formatters traverse Error.cause
  // and would otherwise expose untrusted native messages, paths or credentials.
  return safeDiagnostic(`ANTIGRAVITY execution failed (${facts.join("; ")}); provider dispatch and outcome are not established`);
}
