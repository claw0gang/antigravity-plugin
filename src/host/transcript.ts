import * as harnessSdk from "openclaw/plugin-sdk/agent-harness-runtime";

import type { AgentHarnessAttemptParamsV2, AgentMessage } from "./types.js";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

export type OpenClawTranscriptAppendParams = Readonly<{
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  config?: unknown;
  idempotencyLookup: "scan";
  message: AgentMessage & { idempotencyKey?: string };
  parentId?: string;
}>;

export type OpenClawTranscriptAppendResult =
  | Readonly<{
      kind: "result";
      result: Readonly<{
        appended: boolean;
        messageId: string;
        message: AgentMessage;
      }>;
    }>
  | Readonly<{ kind: "suppressed" }>
  | Readonly<{ kind: "rejected"; reason: "session-rebound" }>;

export type OpenClawTranscriptPublishParams = Readonly<{
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}>;

export type OpenClawTranscriptRuntime = Readonly<{
  appendAssistant: (
    params: OpenClawTranscriptAppendParams,
  ) => Promise<OpenClawTranscriptAppendResult>;
  publishUpdate: (params: OpenClawTranscriptPublishParams) => Promise<void>;
}>;

const transcriptRuntimeSpecifier: string = "openclaw/plugin-sdk/session-transcript-runtime";
let transcriptRuntimePromise: Promise<OpenClawTranscriptRuntime> | undefined;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Run the host's canonical before-message-write projection without making the
 * harness layer import OpenClaw directly. Namespace lookup keeps module linking
 * compatible with source fixtures while a genuinely missing attempt-time helper
 * still fails closed when transcript persistence is required.
 */
export function prepareOpenClawAssistantTranscriptMessage(params: {
  message: AssistantMessage;
  agentId?: string;
  sessionKey?: string;
  prepareAssistantTranscriptMessage?: AgentHarnessAttemptParamsV2["prepareAssistantTranscriptMessage"];
}): AgentMessage | null {
  const sdk = harnessSdk as unknown as Record<string, unknown>;
  const helper = sdk.runAgentHarnessBeforeMessageWriteHook;
  if (typeof helper !== "function") {
    throw new Error(
      "ANTIGRAVITY requires OpenClaw runAgentHarnessBeforeMessageWriteHook for completed assistant transcript persistence",
    );
  }
  const output = Reflect.apply(helper, sdk, [{
    message: params.message,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.prepareAssistantTranscriptMessage
      ? { prepareAssistantTranscriptMessage: params.prepareAssistantTranscriptMessage }
      : {}),
  }]) as unknown;
  if (output === null) return null;
  if (!asRecord(output)) {
    throw new Error("ANTIGRAVITY OpenClaw before-message-write helper returned an invalid message");
  }
  return output as AgentMessage;
}

export async function loadOpenClawTranscriptRuntime(): Promise<OpenClawTranscriptRuntime> {
  transcriptRuntimePromise ??= (async () => {
    // OpenClaw 2026.9.x exposes this public JS runtime subpath without shipping
    // its declaration file. Keep compile-time knowledge structural and validate
    // exactly the runtime functions/results ANTIGRAVITY consumes.
    const loaded = asRecord((await import(transcriptRuntimeSpecifier)) as unknown);
    const append = loaded?.appendSessionTranscriptMessageByIdentityStrict;
    const publish = loaded?.publishSessionTranscriptUpdateByIdentity;
    if (typeof append !== "function" || typeof publish !== "function") {
      throw new Error("ANTIGRAVITY OpenClaw session transcript runtime is missing required functions");
    }
    return Object.freeze({
      async appendAssistant(input: OpenClawTranscriptAppendParams) {
        const output = asRecord((await Reflect.apply(append, loaded, [input])) as unknown);
        if (output?.kind === "suppressed") return { kind: "suppressed" as const };
        if (output?.kind === "rejected" && output.reason === "session-rebound") {
          return { kind: "rejected" as const, reason: "session-rebound" as const };
        }
        if (output?.kind === "result") {
          const result = asRecord(output.result);
          if (
            typeof result?.appended === "boolean" &&
            typeof result.messageId === "string" &&
            asRecord(result.message)
          ) {
            return {
              kind: "result" as const,
              result: {
                appended: result.appended,
                messageId: result.messageId,
                message: result.message as AgentMessage,
              },
            };
          }
        }
        throw new Error("ANTIGRAVITY OpenClaw session transcript runtime returned an invalid strict append result");
      },
      async publishUpdate(input: OpenClawTranscriptPublishParams) {
        await Reflect.apply(publish, loaded, [input]);
      },
    });
  })();
  return transcriptRuntimePromise;
}
