import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AntigravityAttemptResult } from "../src/harness/result.ts";
const transcriptHostRoot = new URL("../src/host/", import.meta.url).href;
const transcriptSdkFixture = `data:text/javascript,${encodeURIComponent(`
export function runAgentHarnessBeforeMessageWriteHook(params) {
  const message = params.message;
  const sourceText =
    params.prepareAssistantTranscriptMessage &&
    message?.role === "assistant" &&
    message?.display !== false &&
    Array.isArray(message?.content)
      ? message.content
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\\n")
      : undefined;
  return message?.role === "assistant" &&
    message?.display !== false &&
    sourceText !== undefined &&
    params.prepareAssistantTranscriptMessage
    ? params.prepareAssistantTranscriptMessage(message, sourceText)
    : message;
}
`)}`;

// These are transcript persistence unit tests with a fake append runtime. Keep
// the OpenClaw before-write hook deterministic too; actual SDK compatibility is
// covered by the package/compatibility gates rather than this fixture test.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "openclaw/plugin-sdk/agent-harness-runtime" &&
      context.parentURL?.startsWith(transcriptHostRoot)
    ) {
      return nextResolve(transcriptSdkFixture, context);
    }
    return nextResolve(specifier, context);
  },
});

const { persistAntigravityCompletedAssistant } =
  await import("../src/harness/transcript-result.ts");
import type { OpenClawTranscriptAppendParams } from "../src/host/transcript.ts";

function completedResult(text = "native answer"): AntigravityAttemptResult {
  return {
    terminal: { kind: "ok" },
    antigravityOutcome: {
      kind: "completed",
      availableOutput: true,
      deniedActions: [],
      nativeTimeout: false,
      nativeStatus: "SUCCESS",
    },
    antigravityEvidence: {} as AntigravityAttemptResult["antigravityEvidence"],
    sessionIdUsed: "child-session",
    agentHarnessId: "antigravity",
    assistantTexts: [text],
    runtimeModelSelection: { provider: "antigravity", model: "gemini-3.8-flash-low" },
    messagesSnapshot: [],
    toolMetas: [],
    lastAssistant: undefined,
    currentAttemptAssistant: undefined,
    currentAttemptCompletedAssistant: undefined,
    didSendViaMessagingTool: false,
    didDeliverSourceReplyViaMessageTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSourceReplyPayloads: [],
    toolMediaUrls: [],
    cloudCodeAssistFormatError: false,
    attemptUsage: { contextUsage: { state: "unavailable" } },
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    yieldDetected: false,
  } as AntigravityAttemptResult;
}

function attempt(params: {
  admission?: boolean;
  prepareText?: (text: string) => string;
  assertActive?: () => void;
} = {}): AgentHarnessAttemptParamsV2 {
  const admission = params.admission === false
    ? undefined
    : {
        agentId: "main",
        sessionId: "child-session",
        sessionKey: "agent:main:subagent:child",
        storePath: "/tmp/openclaw-sessions.sqlite",
        generation: "generation-1",
        entryId: "user-entry",
        rawSeq: 1,
        effectiveParentId: null,
        activeMessagePosition: 0,
        logicalTurnId: "turn-1",
        role: "user" as const,
      };
  return {
    runId: "run-123",
    sessionId: "child-session",
    sessionKey: "agent:main:subagent:child",
    agentId: "main",
    modelId: "gemini-3.8-flash-low",
    model: { api: "openai-responses" },
    config: {},
    sessionTarget: {
      agentId: "main",
      sessionId: "child-session",
      sessionKey: "agent:main:subagent:child",
      storePath: "/tmp/openclaw-sessions.sqlite",
      expectedLifecycleRevision: "revision-7",
      expectedWriterRunId: "run-123",
    },
    userTurnTranscriptRecorder: {
      getAdmissionReceipt: () => admission,
    },
    ...(params.prepareText
      ? {
          prepareAssistantTranscriptMessage: (message, sourceText) => ({
            ...message,
            content: [{ type: "text", text: params.prepareText!(sourceText ?? "") }],
          }),
        }
      : {}),
    hostCapabilities: {
      assertActive: params.assertActive ?? (() => {}),
    },
  } as unknown as AgentHarnessAttemptParamsV2;
}

function appended(input: OpenClawTranscriptAppendParams, wasAppended = true) {
  return {
    kind: "result" as const,
    result: {
      appended: wasAppended,
      messageId: "assistant-entry",
      message: input.message,
    },
  };
}

test("completed native answer is persisted as canonical assistant under the admitted user turn", async () => {
  const appends: OpenClawTranscriptAppendParams[] = [];
  const publishes: Array<Record<string, unknown>> = [];
  let activeChecks = 0;

  const persisted = await persistAntigravityCompletedAssistant({
    attempt: attempt({
      assertActive: () => { activeChecks += 1; },
      prepareText: (text) => `prepared:${text}`,
    }),
    result: completedResult("tool result 7709826d"),
    now: () => 1234,
    runtime: {
      appendAssistant: async (input) => {
        appends.push(input);
        return appended(input);
      },
      publishUpdate: async (input) => {
        publishes.push(input as unknown as Record<string, unknown>);
      },
    },
  });

  assert.equal(persisted.owned, true);
  assert.equal(persisted.idempotencyKey, "antigravity-assistant:run-123");
  assert.equal(activeChecks, 3);
  assert.equal(appends.length, 1);
  assert.deepEqual(appends[0], {
    agentId: "main",
    sessionId: "child-session",
    sessionKey: "agent:main:subagent:child",
    storePath: "/tmp/openclaw-sessions.sqlite",
    config: {},
    idempotencyLookup: "scan",
    parentId: "user-entry",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "prepared:tool result 7709826d" }],
      api: "openai-responses",
      provider: "antigravity",
      model: "gemini-3.8-flash-low",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1234,
      idempotencyKey: "antigravity-assistant:run-123",
    },
  });
  assert.deepEqual(persisted.completedAssistant, appends[0]?.message);
  assert.deepEqual(publishes, [{
    agentId: "main",
    sessionId: "child-session",
    sessionKey: "agent:main:subagent:child",
    storePath: "/tmp/openclaw-sessions.sqlite",
  }]);
});

test("non-admitted attempts preserve the existing assistantTexts-only result path", async () => {
  let appendCalled = false;
  const persisted = await persistAntigravityCompletedAssistant({
    attempt: attempt({ admission: false }),
    result: completedResult(),
    runtime: {
      appendAssistant: async (input) => {
        appendCalled = true;
        return appended(input);
      },
      publishUpdate: async () => {},
    },
  });
  assert.deepEqual(persisted, { owned: false });
  assert.equal(appendCalled, false);
});

test("failed or partial native results are never persisted as completed child answers", async () => {
  for (const result of [
    { ...completedResult(), terminal: { kind: "failed", error: new Error("nope") } },
    {
      ...completedResult(),
      antigravityOutcome: {
        kind: "partial",
        availableOutput: true,
        deniedActions: [],
        nativeTimeout: false,
      },
    },
  ] as AntigravityAttemptResult[]) {
    let appendCalled = false;
    const persisted = await persistAntigravityCompletedAssistant({
      attempt: attempt(),
      result,
      runtime: {
        appendAssistant: async (input) => {
          appendCalled = true;
          return appended(input);
        },
        publishUpdate: async () => {},
      },
    });
    assert.deepEqual(persisted, { owned: false });
    assert.equal(appendCalled, false);
  }
});

test("session rebound rejects persistence instead of claiming transcript ownership", async () => {
  await assert.rejects(
    persistAntigravityCompletedAssistant({
      attempt: attempt(),
      result: completedResult(),
      runtime: {
        appendAssistant: async () => ({ kind: "rejected", reason: "session-rebound" }),
        publishUpdate: async () => {},
      },
    }),
    /transcript target changed before persistence/u,
  );
});

test("unexpected strict suppression fails closed", async () => {
  await assert.rejects(
    persistAntigravityCompletedAssistant({
      attempt: attempt(),
      result: completedResult(),
      runtime: {
        appendAssistant: async () => ({ kind: "suppressed" }),
        publishUpdate: async () => {},
      },
    }),
    /unexpectedly suppressed/u,
  );
});

test("idempotent existing assistant is owned without duplicate publication", async () => {
  let publishes = 0;
  const persisted = await persistAntigravityCompletedAssistant({
    attempt: attempt(),
    result: completedResult(),
    runtime: {
      appendAssistant: async (input) => appended(input, false),
      publishUpdate: async () => { publishes += 1; },
    },
  });
  assert.equal(persisted.owned, true);
  assert.equal(persisted.idempotencyKey, "antigravity-assistant:run-123");
  assert.equal(persisted.completedAssistant?.role, "assistant");
  assert.equal(publishes, 0);
});

test("authority loss after transcript commit preserves canonical ownership", async () => {
  let activeChecks = 0;
  let publishes = 0;
  const persisted = await persistAntigravityCompletedAssistant({
    attempt: attempt({
      assertActive: () => {
        activeChecks += 1;
        if (activeChecks === 3) {
          throw new Error("attempt authority revoked after commit");
        }
      },
    }),
    result: completedResult(),
    runtime: {
      appendAssistant: async (input) => appended(input),
      publishUpdate: async () => { publishes += 1; },
    },
  });
  assert.equal(persisted.owned, true);
  assert.equal(persisted.idempotencyKey, "antigravity-assistant:run-123");
  assert.equal(persisted.completedAssistant?.role, "assistant");
  assert.equal(activeChecks, 3);
  assert.equal(publishes, 0);
});

test("notification failure cannot invalidate an already committed assistant row", async () => {
  const persisted = await persistAntigravityCompletedAssistant({
    attempt: attempt(),
    result: completedResult(),
    runtime: {
      appendAssistant: async (input) => appended(input),
      publishUpdate: async () => { throw new Error("notification unavailable"); },
    },
  });
  assert.equal(persisted.owned, true);
  assert.equal(persisted.idempotencyKey, "antigravity-assistant:run-123");
  assert.equal(persisted.completedAssistant?.role, "assistant");
});
