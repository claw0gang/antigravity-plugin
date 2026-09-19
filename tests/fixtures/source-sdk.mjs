// SIMULATED SDK: intentionally narrow terminal normalization fixture.
// Only the input fields currently emitted by the source harness are supported.
// It permits credential-free source behavior checks when OpenClaw is absent;
// it is not evidence for the actual SDK contract or a substitute for packed tests.
const supportedFields = new Set([
  "aborted",
  "externalAbort",
  "timedOut",
  "timedOutByRunBudget",
  "promptError",
  "promptErrorSource",
]);

export const agentHarnessAttemptTerminal = Object.freeze({
  normalize(input) {
    for (const key of Object.keys(input)) {
      if (!supportedFields.has(key)) {
        throw new Error(`Source SDK fixture does not support terminal field ${key}`);
      }
    }
    let terminal = { kind: "ok" };
    if (input.aborted || input.externalAbort) {
      terminal = { kind: "aborted", source: input.externalAbort ? "external" : "runtime" };
    }
    if (input.timedOut || input.timedOutByRunBudget) {
      terminal = {
        kind: "timeout",
        phase: "prompt",
        source: input.externalAbort ? "external" : input.timedOutByRunBudget ? "run_budget" : "runtime",
        ...((input.aborted || input.externalAbort) ? { aborted: true } : {}),
      };
    }
    if (input.promptError !== undefined && input.promptError !== null) {
      const failure = { source: input.promptErrorSource ?? "prompt", error: input.promptError };
      terminal = terminal.kind === "ok"
        ? { kind: "failed", ...failure }
        : { ...terminal, failure };
    }
    return terminal;
  },
});
