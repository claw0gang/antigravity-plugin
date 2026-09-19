import { isDeepStrictEqual } from "node:util";
import type { OpenClawPluginApi, OpenClawPluginConfigSchema, AgentHarnessAttemptResult } from "./types.js";

type PluginEntry = {
  id: string;
  name: string;
  description: string;
  configSchema: OpenClawPluginConfigSchema;
  register: (api: OpenClawPluginApi) => void;
};

/** The exact explicit-schema subset authored by this plugin. No SDK default import. */
export function definePluginEntryWithSdk(input: PluginEntry, sdk: Record<string, unknown>): PluginEntry {
  const helper = sdk.definePluginEntry;
  if (helper === undefined) {
    for (const key of Object.keys(input)) {
      if (!["id", "name", "description", "configSchema", "register"].includes(key)) {
        throw new Error(`ANTIGRAVITY entry compatibility fallback does not support ${key}`);
      }
    }
    return { ...input };
  }
  if (typeof helper !== "function") throw new Error("ANTIGRAVITY malformed optional OpenClaw helper definePluginEntry");
  // Deliberately propagate helper failures; availability fallback must not hide bugs.
  const output: unknown = helper(input);
  if (!output || typeof output !== "object" ||
      !Object.keys(input).every((key) => isDeepStrictEqual(
        (output as Record<string, unknown>)[key], (input as unknown as Record<string, unknown>)[key],
      ))) {
    throw new Error("ANTIGRAVITY malformed OpenClaw definePluginEntry result for the explicit-schema contract");
  }
  return output as PluginEntry;
}

export type TerminalInput = {
  aborted?: boolean;
  externalAbort?: boolean;
  timedOut?: boolean;
  timedOutByRunBudget?: boolean;
  promptError?: unknown;
  promptErrorSource?: "prompt" | "compaction" | "precheck" | "hook:before_agent_run" | null;
};
type Terminal = Extract<AgentHarnessAttemptResult, { terminal: unknown }>["terminal"];
const TERMINAL_FIELDS = new Set([
  "aborted", "externalAbort", "timedOut", "timedOutByRunBudget", "promptError", "promptErrorSource",
]);

/** Matches official 2026.9.4 normalizeAgentRunAttemptTerminal for our six inputs.
 * Reject additions until their semantics have been inspected and implemented.
 */
export function normalizeTerminalFallback(input: TerminalInput): Terminal {
  for (const key of Object.keys(input)) {
    if (!TERMINAL_FIELDS.has(key)) throw new Error(`ANTIGRAVITY terminal compatibility fallback does not support ${key}`);
  }
  let terminal: Terminal = { kind: "ok" };
  if (input.aborted || input.externalAbort) terminal = {
    kind: "aborted", source: input.externalAbort ? "external" : "runtime",
  };
  if (input.timedOut || input.timedOutByRunBudget) terminal = {
    kind: "timeout", phase: "prompt",
    source: input.externalAbort ? "external" : input.timedOutByRunBudget ? "run_budget" : "runtime",
    ...((input.aborted || input.externalAbort) ? { aborted: true as const } : {}),
  };
  if (input.promptError !== undefined && input.promptError !== null) {
    const failure = { source: input.promptErrorSource ?? "prompt", error: input.promptError };
    terminal = terminal.kind === "ok" ? { kind: "failed", ...failure } : { ...terminal, failure };
  }
  return terminal;
}

export function normalizeTerminalWithSdk(input: TerminalInput, sdk: Record<string, unknown>): Terminal {
  const expected = normalizeTerminalFallback(input);
  const helper = sdk.agentHarnessAttemptTerminal;
  if (helper === undefined) return expected;
  if (helper === null || typeof helper !== "object" ||
      typeof (helper as Record<string, unknown>).normalize !== "function") {
    throw new Error("ANTIGRAVITY malformed optional OpenClaw helper agentHarnessAttemptTerminal.normalize");
  }
  const output: unknown = (helper as { normalize: (input: TerminalInput) => unknown }).normalize(input);
  const expectedRecord = expected as unknown as Record<string, unknown>;
  const outputRecord = output as Record<string, unknown> | null | undefined;
  // Preserve the fields used by the closed terminal contract; later hosts may
  // add harmless metadata without invalidating a compatible result.
  if (!outputRecord || typeof outputRecord !== "object" ||
      !["kind", "source", "phase", "aborted", "failure", "error", "timeoutObservation", "settlementWarning"].every(
        (key) => isDeepStrictEqual(outputRecord[key], expectedRecord[key]),
      )) {
    throw new Error("ANTIGRAVITY malformed OpenClaw agentHarnessAttemptTerminal.normalize result or incompatible semantics");
  }
  return output as Terminal;
}
