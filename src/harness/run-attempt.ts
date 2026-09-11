import {
  agentHarnessAttemptTerminal,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";

import type { AntigravityPluginConfig } from "../config.js";
import { buildAgyHarnessFreshArgs, buildAgyHarnessResumeArgs } from "../cli/args.js";
import { AgyProcessError, runAgyStreamProcess } from "../cli/agy-process.js";
import { normalizeAntigravityModelId } from "../model-aliases.js";
import type { AgyStreamEvent, AgyStepUpdate } from "../protocol/agy-stream.js";
import { materializeAgyImages } from "./image-input.js";
import {
  assertAgyResumeModelConsistency,
  resolveAgyAttemptModel,
} from "./model-capabilities.js";
import { discoverAgyModels } from "./model-catalog.js";
import { buildAntigravityAttemptResult, buildAntigravityFailureResult } from "./result.js";
import { AntigravitySessionBindings } from "./session-bindings.js";

function recordTrajectory(
  params: AgentHarnessAttemptParamsV2,
  type: string,
  data?: Record<string, unknown>,
): void {
  try {
    params.hostCapabilities.trajectory?.recordEvent(type, data);
  } catch {
    // Trajectory is observational. Host authority and terminal result remain canonical.
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nativeToolErrorMessage(step: AgyStepUpdate): string | undefined {
  const error = step.tool_info?.error;
  if (!error) return undefined;
  const message = error.message?.trim();
  if (message) return message;
  const type = error.type?.trim();
  return type || "AGY native tool failed";
}

type ToolTerminalResolution = ReturnType<
  NonNullable<AgentHarnessAttemptParamsV2["observeToolTerminal"]>
>;

export function observeNativeToolTerminal(
  params: AgentHarnessAttemptParamsV2,
  step: AgyStepUpdate,
): ToolTerminalResolution | undefined {
  if (step.step_type !== "tool" || step.state === "ACTIVE") {
    return undefined;
  }
  const toolName = step.tool_name ?? step.tool_info?.name ?? "native_tool";
  const argumentsValue = asRecord(step.tool_info?.parameters);
  const outcome = step.state === "ERROR" || step.tool_info?.error ? "failure" : "success";
  const errorMessage = nativeToolErrorMessage(step);
  const resolution = params.observeToolTerminal?.({
    toolName,
    ...(argumentsValue ? { arguments: argumentsValue } : {}),
    executionStarted: true,
    outcome,
    ...(outcome === "failure" && errorMessage ? { failure: { error: errorMessage } } : {}),
    nativeMutation: {
      // Until AGY exposes a trusted per-tool mutation classification, replay after
      // any completed native tool would risk duplicating an external side effect.
      mutatingAction: true,
      replaySafe: false,
    },
  });
  recordTrajectory(params, "antigravity.native_tool_terminal", {
    toolName,
    stepIndex: step.step_index,
    outcome,
    ...(resolution
      ? {
          executionStarted: resolution.executionStarted,
          sideEffectEvidence: resolution.sideEffectEvidence,
          effectReceipt: resolution.effectReceipt,
        }
      : {}),
  });
  return resolution;
}

function hasNativeAssistantOutput(event: AgyStreamEvent): boolean {
  return (
    event.event === "step_update" &&
    event.step_update.step_type === "agent_response" &&
    event.step_update.text_delta !== undefined &&
    event.step_update.text_delta.length > 0
  );
}

function emitPartialReply(params: AgentHarnessAttemptParamsV2, event: AgyStreamEvent): void {
  if (
    event.event !== "step_update" ||
    event.step_update.step_type !== "agent_response" ||
    event.step_update.text_delta === undefined ||
    !event.step_update.text_delta ||
    !params.onPartialReply
  ) {
    return;
  }
  void Promise.resolve(params.onPartialReply({ text: event.step_update.text_delta })).catch(
    () => undefined,
  );
}

function mergeHarnessEnvironment(params: AgentHarnessAttemptParamsV2) {
  const prepared = params.hostCapabilities.preparedEnvironment?.();
  return {
    ...process.env,
    ...(prepared?.credentialScrubEnv ?? {}),
    ...(prepared?.localIdentityEnv ?? {}),
    ...(prepared?.localProcessEnv ?? {}),
  };
}

function failureTerminal(params: AgentHarnessAttemptParamsV2, error: unknown) {
  if (error instanceof AgyProcessError) {
    if (error.kind === "aborted") {
      params.onAttemptAbort?.();
      return agentHarnessAttemptTerminal.normalize({
        aborted: true,
        externalAbort: params.abortSignal?.aborted === true,
      });
    }
    if (error.kind === "timeout") {
      const timeoutError = error instanceof Error ? error : new Error(String(error));
      params.onAttemptTimeout?.(timeoutError);
      return agentHarnessAttemptTerminal.normalize({
        aborted: true,
        timedOut: true,
        timedOutByRunBudget: true,
        promptError: timeoutError,
        promptErrorSource: "prompt",
      });
    }
    return agentHarnessAttemptTerminal.normalize({
      promptError: error,
      promptErrorSource: error.kind === "spawn" ? "precheck" : "prompt",
    });
  }
  return agentHarnessAttemptTerminal.normalize({
    promptError: error,
    promptErrorSource: "prompt",
  });
}

export async function runAntigravityAttempt(params: {
  attempt: AgentHarnessAttemptParamsV2;
  pluginConfig: AntigravityPluginConfig;
  sessionBindings: AntigravitySessionBindings;
}): Promise<AgentHarnessAttemptResult> {
  const { attempt, pluginConfig, sessionBindings } = params;
  attempt.hostCapabilities.assertActive();
  const requestedModelId = normalizeAntigravityModelId(attempt.modelId);
  const sessionIdentity = {
    openclawSessionId: attempt.sessionId,
    ...(attempt.sessionTarget?.sessionKey?.trim()
      ? { openclawSessionKey: attempt.sessionTarget.sessionKey }
      : attempt.sessionKey?.trim()
        ? { openclawSessionKey: attempt.sessionKey }
        : {}),
    ...(attempt.sessionTarget?.agentId?.trim()
      ? { agentId: attempt.sessionTarget.agentId }
      : attempt.agentId?.trim()
        ? { agentId: attempt.agentId }
        : {}),
    ...(attempt.sessionTarget?.storePath?.trim()
      ? { storePath: attempt.sessionTarget.storePath }
      : {}),
  };
  const existingBinding = sessionBindings.resolve(sessionIdentity);
  let nativeAssistantOutputObserved = false;
  let nativeToolActivityObserved = false;
  let lastToolError: AgentHarnessAttemptResult["lastToolError"];
  let cleanupImages: () => Promise<void> = async () => undefined;

  try {
    const liveModels = await discoverAgyModels({ command: pluginConfig.command });
    const resolvedModel = resolveAgyAttemptModel({
      modelId: requestedModelId,
      thinkLevel: attempt.thinkLevel,
      liveModels,
    });
    if (existingBinding) {
      assertAgyResumeModelConsistency({
        ...(existingBinding.modelId !== undefined
          ? { boundModelId: existingBinding.modelId }
          : {}),
        resolvedModelId: resolvedModel.modelId,
        conversationId: existingBinding.conversationId,
      });
    }

    const materialized = await materializeAgyImages({
      prompt: attempt.prompt,
      ...(attempt.images !== undefined ? { images: attempt.images } : {}),
    });
    cleanupImages = materialized.cleanup;
    const args = existingBinding
      ? buildAgyHarnessResumeArgs({
          config: pluginConfig,
          modelId: resolvedModel.modelId,
          prompt: materialized.prompt,
          conversationId: existingBinding.conversationId,
        })
      : buildAgyHarnessFreshArgs({
          config: pluginConfig,
          modelId: resolvedModel.modelId,
          prompt: materialized.prompt,
        });
    attempt.onAttemptTimeoutArmed?.();
    recordTrajectory(attempt, "antigravity.attempt_started", {
      resumed: Boolean(existingBinding),
      requestedModelId,
      modelId: resolvedModel.modelId,
      thinkLevel: attempt.thinkLevel,
      imageCount: materialized.paths.length,
    });
    let conversationBound = false;
    const result = await runAgyStreamProcess({
      command: pluginConfig.command,
      args,
      cwd: attempt.cwd ?? attempt.workspaceDir,
      env: mergeHarnessEnvironment(attempt),
      ...(attempt.abortSignal ? { signal: attempt.abortSignal } : {}),
      ...(typeof attempt.timeoutMs === "number" && attempt.timeoutMs > 0
        ? { timeoutMs: attempt.timeoutMs }
        : {}),
      async onEvent(event) {
        if (event.event === "init") {
          const conversationId = event.conversation_id;
          if (existingBinding && conversationId !== existingBinding.conversationId) {
            throw new Error(
              `AGY resumed unexpected conversation ${conversationId}; expected ${existingBinding.conversationId}`,
            );
          }
          if (!existingBinding) {
            await sessionBindings.bindFresh({
              ...sessionIdentity,
              conversationId,
              modelId: resolvedModel.modelId,
            });
          }
          conversationBound = true;
          recordTrajectory(attempt, "antigravity.conversation_bound", {
            resumed: Boolean(existingBinding),
            modelId: resolvedModel.modelId,
          });
          return;
        }
        if (!conversationBound) {
          throw new Error("AGY emitted runtime activity before its conversation was bound");
        }
        if (hasNativeAssistantOutput(event)) {
          nativeAssistantOutputObserved = true;
        }
        emitPartialReply(attempt, event);
        if (event.event === "step_update" && event.step_update.step_type === "tool") {
          nativeToolActivityObserved = true;
          const resolution = observeNativeToolTerminal(attempt, event.step_update);
          if (resolution !== undefined) {
            lastToolError = resolution.lastToolError;
          }
        }
      },
    });
    attempt.hostCapabilities.assertActive();
    attempt.hostCapabilities.reportOutputTokens?.(result.snapshot.result.usage.output_tokens);
    if (result.snapshot.result.denied_actions?.length) {
      recordTrajectory(attempt, "antigravity.permission_denied", {
        deniedActions: result.snapshot.result.denied_actions.map((entry) => ({
          action: entry.action,
          displayName: entry.display_name,
        })),
      });
    }
    recordTrajectory(attempt, "antigravity.attempt_terminal", {
      status: result.snapshot.result.status,
      nativeToolCount: result.snapshot.toolSteps.filter((step) => step.state !== "ACTIVE").length,
      deniedActionCount: result.snapshot.result.denied_actions?.length ?? 0,
    });
    return buildAntigravityAttemptResult({
      attempt,
      snapshot: result.snapshot,
      runtimeModelId: resolvedModel.modelId,
      nativeAssistantOutputObserved,
      ...(lastToolError ? { lastToolError } : {}),
    });
  } catch (error) {
    recordTrajectory(attempt, "antigravity.attempt_failed", {
      kind: error instanceof AgyProcessError ? error.kind : "runtime",
      nativeAssistantOutputObserved,
      nativeToolActivityObserved,
    });
    return buildAntigravityFailureResult({
      attempt,
      error,
      terminal: failureTerminal(attempt, error),
      partialReplyObserved: nativeAssistantOutputObserved,
      nativeToolActivityObserved,
      ...(lastToolError ? { lastToolError } : {}),
    });
  } finally {
    try {
      await cleanupImages();
    } catch (error) {
      recordTrajectory(attempt, "antigravity.image_cleanup_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    await attempt.hostCapabilities.trajectory?.flush().catch(() => undefined);
  }
}
