import type {
  AgyStreamEvent, AgyStreamPartialSnapshot, AgyStepUpdate, AgyUsage,
} from "../protocol/agy-stream.js";

export type AccountingScope = "step" | "turn" | "conversation" | "unknown";

export type AgyAccountingEvidence = {
  /** Exact native result counters. No current-turn or occupancy interpretation. */
  raw?: AgyUsage;
  scope: AccountingScope;
  /** Preserve overlapping step observations separately; never add them to raw. */
  steps: Array<{
    stepIndex: number;
    state: AgyStepUpdate["state"];
    raw: AgyUsage;
    scope: AccountingScope;
  }>;
  /** AGY's stream contains token counters, not a qualified price or billed cost. */
  pricing: "unknown";
};

export type AttemptEvidence = {
  invocation: "not_started" | "possible" | "started";
  requestedModelId?: string;
  acknowledgedModelId?: string;
  conversationId?: string;
  nativeIdentityVerified: boolean;
  /** C03 adapter acknowledgement, distinct from the parser's model-ID match. */
  runtimeScope?: { key: string; acknowledged: boolean };
  effects: "none_proven" | "observed_possible" | "unknown";
  outputObserved: boolean;
  deliveredOutput: boolean;
  accounting: AgyAccountingEvidence;
  /** Set only by a producer with qualified occupancy evidence and provenance. */
  contextOccupancy?: { tokens: number; source: string };
  terminal: {
    nativeStatus?: string;
    nativeTimeout?: boolean;
    nativeCriticalWarning?: boolean;
    deniedActions?: number;
    protocolComplete: boolean;
  };
  termination: {
    exitCode?: number;
    signal?: string;
    hostReason?: string;
    containment: "not_started" | "posix_process_group" | "unqualified";
    cleanupComplete: boolean;
    settlementDeadlineMonoMs?: number;
  };
};

export function createAttemptEvidence(requestedModelId?: string): AttemptEvidence {
  return {
    invocation: "not_started", effects: "none_proven", nativeIdentityVerified: false,
    outputObserved: false, deliveredOutput: false,
    accounting: { scope: "unknown", steps: [], pricing: "unknown" },
    ...(requestedModelId !== undefined ? { requestedModelId } : {}),
    terminal: { protocolComplete: false },
    termination: { containment: "not_started", cleanupComplete: true },
  };
}

/** Event location alone does not qualify whether native counters reset on resume. */
export function recordAgyUsage(evidence: AttemptEvidence, event: AgyStreamEvent): void {
  if (event.event === "result") {
    evidence.accounting.raw = { ...event.result.usage };
    evidence.accounting.scope = "unknown";
  } else if (event.event === "step_update" && event.step_update.usage) {
    evidence.accounting.steps.push({
      stepIndex: event.step_update.step_index,
      state: event.step_update.state,
      raw: { ...event.step_update.usage },
      scope: "unknown",
    });
  }
}

/** Recover accepted observations after parse/terminal/callback failure, without summing. */
export function recordSnapshotAccounting(
  evidence: AttemptEvidence,
  snapshot: AgyStreamPartialSnapshot,
): void {
  if (snapshot.result) {
    const incoming = snapshot.result.usage;
    const prior = evidence.accounting.raw;
    if (!prior || (Object.keys(incoming) as Array<keyof AgyUsage>)
      .some((key) => incoming[key] !== prior[key])) {
      recordAgyUsage(evidence, { event: "result", result: snapshot.result });
    }
  }
  const steps = snapshot.stepUpdates.filter((step) => step.usage !== undefined);
  // The accumulator retains the ordered prefix consumed by recordAgyUsage.
  // Append only the unseen suffix, so catch recovery does not duplicate it.
  for (const step of steps.slice(evidence.accounting.steps.length)) {
    recordAgyUsage(evidence, { event: "step_update", step_update: step });
  }
}

export function isReplaySafe(evidence: AttemptEvidence): boolean {
  return evidence.invocation === "not_started" && evidence.effects === "none_proven" &&
    !evidence.outputObserved && !evidence.deliveredOutput;
}

export function snapshotAttemptEvidence(evidence: AttemptEvidence): AttemptEvidence {
  const steps = evidence.accounting.steps.map((step) => Object.freeze({
    ...step, raw: Object.freeze({ ...step.raw }),
  }));
  Object.freeze(steps);
  return Object.freeze({ ...evidence,
    ...(evidence.runtimeScope ? { runtimeScope: Object.freeze({ ...evidence.runtimeScope }) } : {}),
    accounting: Object.freeze({ ...evidence.accounting,
      ...(evidence.accounting.raw ? { raw: Object.freeze({ ...evidence.accounting.raw }) } : {}),
      steps,
    }),
    ...(evidence.contextOccupancy
      ? { contextOccupancy: Object.freeze({ ...evidence.contextOccupancy }) } : {}),
    terminal: Object.freeze({ ...evidence.terminal }),
    termination: Object.freeze({ ...evidence.termination }) });
}
