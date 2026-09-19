import { assertOpenClawAttemptCapabilities, prepareOpenClawEnvironment } from "../host/attempt.js";
import { agentHarnessAttemptTerminal } from "../host/terminal.js";
import { performance } from "node:perf_hooks";

import {
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessAttemptResult,
} from "../host/types.js";

import { parseAgyPrintTimeoutMs, type AntigravityPluginConfig } from "../config.js";
import { buildAgyHarnessFreshArgs, buildAgyHarnessResumeArgs, encodeAgyPromptInput } from "../cli/args.js";
import { AgyProcessError, runAgyStreamProcess } from "../cli/agy-process.js";
import { createInvocationScope, InvocationScopeError } from "../cli/invocation-scope.js";
import { createAttemptEvidence, type AttemptEvidence } from "../cli/attempt-evidence.js";
import { preflightAgyCapabilities } from "../cli/capability-preflight.js";
import type { AgyStreamEvent, AgyStepUpdate, AgyStreamPartialSnapshot } from "../protocol/agy-stream.js";
import { AgyImageStagingError, materializeAgyImages } from "./image-input.js";
import {
  assertAgyResumeModelConsistency,
  resolveAgyAttemptModel,
} from "./model-capabilities.js";
import { AgyInventoryError, AgyInventoryService } from "../inventory.js";
import { buildAntigravityAttemptResult, buildAntigravityFailureResult, type AntigravityAttemptResult } from "./result.js";
import { AntigravitySessionBindings } from "./session-bindings.js";
import { projectAntigravityHostContext } from "./context-projection.js";
import { antigravitySessionScopeKey, requireAntigravityHostContracts, type AntigravityHostContracts } from "./host-contracts.js";
import { AntigravityPreview } from "./preview.js";

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


function failureTerminal(params: AgentHarnessAttemptParamsV2, error: unknown): ReturnType<typeof agentHarnessAttemptTerminal.normalize> {
  // Acquisition errors retain their own purpose. Only cancellation/timeout
  // attribution is inherited; their read-only process evidence is not inference.
  if (error instanceof Error && error.cause instanceof Error &&
      (error.cause instanceof AgyProcessError || error.cause instanceof InvocationScopeError) &&
      (error.cause.kind === "aborted" || error.cause.kind === "timeout")) {
    return failureTerminal(params, error.cause);
  }
  if (error instanceof AgyProcessError || error instanceof InvocationScopeError || error instanceof AgyInventoryError) {
    if (error.kind === "aborted") {
      try { params.onAttemptAbort?.(); } catch { /* Notifications cannot erase evidence or skip cleanup. */ }
      return agentHarnessAttemptTerminal.normalize({
        aborted: true,
        externalAbort: params.abortSignal?.aborted === true,
      });
    }
    if (error.kind === "timeout" || error.kind === "native_timeout") {
      const timeoutError = error instanceof Error ? error : new Error(String(error));
      try { params.onAttemptTimeout?.(timeoutError); } catch { /* Preserve the original timeout. */ }
      return agentHarnessAttemptTerminal.normalize({
        aborted: true,
        timedOut: true,
        timedOutByRunBudget: error.kind === "timeout",
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
  hostContracts?: AntigravityHostContracts;
  inventory?: AgyInventoryService;
}): Promise<AntigravityAttemptResult> {
  const { attempt, pluginConfig, sessionBindings } = params;
  const requestedModelId = attempt.modelId;
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
  let nativeAssistantOutputObserved = false;
  let nativeToolActivityObserved = false;
  let lastToolError: AgentHarnessAttemptResult["lastToolError"];
  let cleanupImages: (() => Promise<void>) | undefined;
  let evidence: AttemptEvidence = createAttemptEvidence(requestedModelId);
  let nativeProcessEntered = false;
  let completed: AntigravityAttemptResult;
  let partialSnapshot: AgyStreamPartialSnapshot | undefined;
  let lease: Awaited<ReturnType<AntigravitySessionBindings["beginAttempt"]>> | undefined;
  let runtimeScopeKey: string | undefined;
  let runtimeAcknowledged = false;

  try {
    assertOpenClawAttemptCapabilities(attempt);
    attempt.hostCapabilities.assertActive();
    const host = requireAntigravityHostContracts(params.hostContracts);
    const existingBinding = sessionBindings.resolve(sessionIdentity);
    const projection = projectAntigravityHostContext(attempt, {
      ...(pluginConfig.agent ? { nativeAgentName: pluginConfig.agent } : {}),
      phase: existingBinding ? "resume" : "fresh",
      ...(host.context ? { adapter: host.context } : {}),
    });
    recordTrajectory(attempt, "antigravity.context_projection", { dispositions: projection.dispositions });
    if (attempt.images?.length && (!host.images?.evidence?.trim() || !host.images.supportsModel(requestedModelId))) {
      throw new Error("ANTIGRAVITY image request requires a qualified model, native image route and host media policy (P04/P06)");
    }
    // OpenClaw supplies this callback even without an external preview consumer.
    // Its presence does not require preview dispatch or prevent ordinary execution.
    // Until t003/t004 qualify a host mutation fence, retain the native stream
    // internally and return assistantTexts through the host's final-result path.
    // Never start an unfenced callback that could outlive this attempt.
    if (attempt.onPartialReply !== undefined && !host.preview) {
      recordTrajectory(attempt, "antigravity.delivery_mode", {
        mode: "final_result",
        partialReply: "not_dispatched",
        reason: "unqualified_mutation_fence",
      });
    }
    // The deadline includes preflight, discovery and image staging, not just inference.
    const scope = createInvocationScope({
      command: pluginConfig.command,
      cwd: attempt.cwd ?? attempt.workspaceDir,
      env: prepareOpenClawEnvironment(attempt),
      ...(attempt.abortSignal ? { signal: attempt.abortSignal } : {}),
      timeoutMs: Math.min(attempt.timeoutMs ?? Infinity, parseAgyPrintTimeoutMs(pluginConfig.printTimeout)),
      assertActive: () => {
        attempt.hostCapabilities.assertActive();
        host.runtime.assertCurrent();
        projection.assertCurrent();
        lease?.assertActive();
      },
      purpose: "attempt",
      owner: { agentId: attempt.agentId, workspaceDir: attempt.workspaceDir, sessionId: attempt.sessionId },
      projectSelection: { ...(pluginConfig.project ? { project: pluginConfig.project } : {}), newProject: pluginConfig.newProject },
      addDirs: pluginConfig.addDirs,
      ...(pluginConfig.agent ? { nativeAgentSelection: pluginConfig.agent } : {}),
    });
    scope.assertActive();
    runtimeScopeKey = antigravitySessionScopeKey(scope, host.runtime.identity, projection.nativeAgentDefinitionIdentity);
    let claimAllowed = true;
    let claimTimer: ReturnType<typeof setTimeout> | undefined;
    const assertClaimActive = () => {
      if (!claimAllowed) throw new Error("ANTIGRAVITY session claim callback was retired");
      attempt.hostCapabilities.assertActive(); host.runtime.assertCurrent(); projection.assertCurrent();
      if (attempt.abortSignal?.aborted) throw new InvocationScopeError("aborted", "AGY session preparation aborted");
      if (performance.now() >= scope.deadlineMonoMs) throw new InvocationScopeError("timeout", "AGY session preparation deadline expired");
    };
    try {
      lease = await Promise.race([
        sessionBindings.beginAttempt({ ...sessionIdentity, modelId: requestedModelId,
          scopeKey: runtimeScopeKey, assertActive: assertClaimActive }),
        new Promise<never>((_, reject) => { claimTimer = setTimeout(() => {
          claimAllowed = false;
          reject(new InvocationScopeError("timeout", "AGY session preparation exceeded its bounded allowance"));
        }, Math.max(0, Math.min(1_000, scope.deadlineMonoMs - performance.now()))); }),
      ]);
    } finally { if (claimTimer !== undefined) clearTimeout(claimTimer); }
    if (existingBinding?.epoch !== lease.binding?.epoch ||
        existingBinding?.conversationId !== lease.binding?.conversationId) {
      throw new Error("ANTIGRAVITY canonical binding changed during preparation; restart from the current host session");
    }
    scope.assertActive();
    // Preflight checks advertised flags only. Native semantics remain P02/P03 qualification.
    await preflightAgyCapabilities({ scope, requiredFlags: [
      ...(pluginConfig.sandbox ? ["--sandbox"] : []),
      ...(pluginConfig.dangerouslySkipPermissions ? ["--dangerously-skip-permissions"] : []),
      ...(pluginConfig.project ? ["--project"] : []),
      ...(pluginConfig.newProject ? ["--new-project"] : []),
      ...(pluginConfig.addDirs.length ? ["--add-dir"] : []),
      ...(pluginConfig.agent ? ["--agent"] : []),
      ...(pluginConfig.mode ? ["--mode"] : []),
      ...(pluginConfig.logFile ? ["--log-file"] : []),
      ...projection.requiredNativeFlags,
    ] });
    scope.assertActive();
    // Display/readiness snapshots never admit execution. A qualified runtime
    // identity also partitions discovery when login/agent authority changes.
    const inventory = params.inventory ?? new AgyInventoryService();
    let liveModels;
    try {
      liveModels = await inventory.get({
        scope: Object.freeze({ ...scope, scopeKey: runtimeScopeKey }), fresh: true,
      });
    } finally {
      if (!params.inventory) inventory.stop();
    }
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

    scope.assertActive();
    encodeAgyPromptInput(projection.prompt);
    const materialized = await materializeAgyImages({
      prompt: projection.prompt,
      stagingRoot: attempt.workspaceDir,
      ...(attempt.images !== undefined ? { images: attempt.images } : {}),
      ...(host.images ? {
        mediaPolicy: host.images.mediaPolicy,
        readersSettled: () => evidence.invocation === "not_started" ||
          (evidence.termination.cleanupComplete && host.images!.readersSettled(evidence)),
      } : {}),
    });
    if (materialized.paths.length) cleanupImages = materialized.cleanup;
    scope.assertActive();
    const stdin = encodeAgyPromptInput(materialized.prompt);
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
    const preview = new AntigravityPreview();
    nativeProcessEntered = true;
    const result = await runAgyStreamProcess({
      scope, args, stdin,
      expectedModelId: resolvedModel.modelId,
      ...(existingBinding ? { expectedConversationId: existingBinding.conversationId } : {}),
      async onEvent(event, context) {
        context.assertActive();
        if (event.event === "init") {
          const conversationId = event.conversation_id;
          // The parser already checks model/conversation. The adapter must also
          // establish effective runtime/project/agent identity, not argv echoes.
          host.runtime.verifyAcknowledgement({ event, scope,
            ...(existingBinding ? { conversationId: existingBinding.conversationId } : {}),
          });
          context.assertActive();
          runtimeAcknowledged = true;
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
              lease: lease!,
              assertActive: context.assertActive,
            });
            context.assertActive();
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
        if (host.preview) {
          if (!host.preview.evidence.trim()) throw new Error("ANTIGRAVITY preview adapter has no qualification reference");
          const update = preview.accept(event);
          if (update) {
            const assertCommitAllowed = () => { context.assertActive(); lease!.assertActive(); host.runtime.assertCurrent(); };
            await host.preview.publish({ ...update, signal: context.signal, assertCommitAllowed,
              markDelivered: () => { assertCommitAllowed(); context.markOutputDelivered(); },
            });
            assertCommitAllowed();
          }
        }
        if (event.event === "step_update" && event.step_update.step_type === "tool") {
          nativeToolActivityObserved = true;
          const resolution = observeNativeToolTerminal(attempt, event.step_update);
          if (resolution !== undefined) {
            if (resolution.lastToolError !== undefined) lastToolError = resolution.lastToolError;
          }
        }
      },
    });
    evidence = { ...result.evidence, runtimeScope: { key: runtimeScopeKey, acknowledged: runtimeAcknowledged } };
    partialSnapshot = result.snapshot;
    attempt.hostCapabilities.assertActive();
    // Native result counters may be conversation aggregates. Reporting them as
    // a completed model call would double count on resume; C02 preserves them
    // with unknown scope until supported-version evidence qualifies accounting.
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
    completed = buildAntigravityAttemptResult({
      evidence,
      attempt,
      snapshot: result.snapshot,
      runtimeModelId: resolvedModel.modelId,
      nativeAssistantOutputObserved,
      ...(lastToolError ? { lastToolError } : {}),
    });
  } catch (error) {
    if (error instanceof AgyImageStagingError) cleanupImages = error.images.cleanup;
    if (nativeProcessEntered && error instanceof AgyProcessError) {
      evidence = error.evidence;
      partialSnapshot = error.partialSnapshot;
    }
    if (runtimeScopeKey) evidence = { ...evidence, runtimeScope: { key: runtimeScopeKey, acknowledged: runtimeAcknowledged } };
    recordTrajectory(attempt, "antigravity.attempt_failed", {
      kind: error instanceof AgyProcessError ? error.kind : "runtime",
      nativeAssistantOutputObserved,
      nativeToolActivityObserved,
    });
    completed = buildAntigravityFailureResult({
      evidence,
      ...(partialSnapshot ? { partialSnapshot } : {}),
      attempt,
      error,
      terminal: failureTerminal(attempt, error),
      partialReplyObserved: nativeAssistantOutputObserved,
      nativeToolActivityObserved,
      ...(lastToolError ? { lastToolError } : {}),
    });
  }
  // Resource cleanup and diagnostic drainage share the runner's original settlement
  // deadline. A blocked observer cannot extend settlement by another timeout window.
  const cleanupDeadline = Math.min(evidence.termination.settlementDeadlineMonoMs ?? Infinity, performance.now() + 2_000);
  let cleanupFailed = false;
  const boundedCleanup = async (work: () => Promise<void>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remaining = cleanupDeadline - performance.now();
    if (remaining <= 0) throw new Error("AGY cleanup allowance exhausted");
    try {
      await Promise.race([
        Promise.resolve().then(work),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("AGY cleanup timed out")), remaining); }),
      ]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  try { if (cleanupImages) await boundedCleanup(cleanupImages); } catch {
    cleanupFailed = true;
    recordTrajectory(attempt, "antigravity.image_cleanup_failed", { cleanupComplete: false });
  }
  if (cleanupFailed) {
    evidence = { ...evidence, termination: { ...evidence.termination, cleanupComplete: false } };
    completed = buildAntigravityFailureResult({ attempt, evidence,
      error: new Error("AGY image cleanup incomplete; staged resources may remain"),
      ...(completed.terminal.kind !== "ok" ? { terminal: completed.terminal } : {}),
      ...(partialSnapshot ? { partialSnapshot } : {}),
      ...(lastToolError ? { lastToolError } : {}),
    });
  }
  if (lease) {
    let endAllowed = true;
    try {
      if (completed.terminal.kind === "ok") lease.assertActive();
      await boundedCleanup(() => sessionBindings.endAttempt(lease!, {
        terminationConfirmed: evidence.termination.cleanupComplete,
        assertCommitAllowed: () => {
          if (!endAllowed || performance.now() >= cleanupDeadline) throw new Error("ANTIGRAVITY session settlement callback retired");
        },
      }));
    }
    catch (error) {
      completed = buildAntigravityFailureResult({ attempt, evidence, error,
        ...(partialSnapshot ? { partialSnapshot } : {}),
        ...(completed.terminal.kind !== "ok" ? { terminal: completed.terminal } : {}),
        ...(lastToolError ? { lastToolError } : {}),
      });
    } finally { endAllowed = false; }
    const assertDeliveryCurrent = () => {
      attempt.hostCapabilities.assertActive();
      params.hostContracts!.runtime.assertCurrent();
      sessionBindings.assertResultCurrent(lease!);
    };
    if (completed.terminal.kind === "ok") {
      try { assertDeliveryCurrent(); }
      catch (error) {
        completed = buildAntigravityFailureResult({ attempt, evidence, error,
          ...(partialSnapshot ? { partialSnapshot } : {}),
          ...(lastToolError ? { lastToolError } : {}),
        });
      }
    }
    completed.antigravityDeliveryGuard = assertDeliveryCurrent;
  }
  try { await boundedCleanup(async () => { await attempt.hostCapabilities.trajectory?.flush(); }); } catch {
    // Optional diagnostics use only the allowance left after resource/session
    // settlement; a stalled trace cannot steal a critical persistence budget.
  }
  if (completed.terminal.kind === "ok" && completed.antigravityDeliveryGuard) {
    try { completed.antigravityDeliveryGuard(); }
    catch (error) {
      const guard = completed.antigravityDeliveryGuard;
      completed = buildAntigravityFailureResult({ attempt, evidence, error,
        ...(partialSnapshot ? { partialSnapshot } : {}),
        ...(lastToolError ? { lastToolError } : {}),
      });
      completed.antigravityDeliveryGuard = guard;
    }
  }
  return completed;
}
