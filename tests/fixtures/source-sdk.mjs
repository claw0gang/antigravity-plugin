// SIMULATED SDK: intentionally narrow source-test fixture.
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

function assistantSourceText(message) {
  if (!message || message.role !== "assistant" || message.display === false) return undefined;
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  return text || undefined;
}

// Source tests have no registered before_message_write hooks, so the simulated
// helper is identity-preserving except for OpenClaw's prepared-assistant
// projection callback when one is supplied.
export function runAgentHarnessBeforeMessageWriteHook(params) {
  const message = params?.message;
  const sourceText = assistantSourceText(message);
  return (
    message?.role === "assistant" &&
    message?.display !== false &&
    sourceText !== undefined &&
    typeof params?.prepareAssistantTranscriptMessage === "function"
  )
    ? params.prepareAssistantTranscriptMessage(message, sourceText)
    : message;
}

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
