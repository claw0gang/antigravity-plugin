import { guardSessionAuthority } from "../host/session-runtime.js";
import { assertOpenClawAttemptCapabilities, prepareOpenClawEnvironment } from "../host/attempt.js";
import { agentHarnessAttemptTerminal } from "../host/terminal.js";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

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
  AgyEffortError,
  assertAgyResumeModelConsistency,
  resolveAgyAttemptModel,
  type ResolvedAgyAttemptModel,
} from "./model-capabilities.js";
import { AgyInventoryError, AgyInventoryService } from "../inventory.js";
import { AGY_EFFORT_FLAGS, resolveAgyEffortAttempt } from "./effort-probe.js";
import { buildAntigravityAttemptResult, buildAntigravityFailureResult, type AntigravityAttemptResult } from "./result.js";
import { AntigravitySessionBindings } from "./session-bindings.js";
import { projectAntigravityHostContext } from "./context-projection.js";
import { requireAntigravityHostContracts, type AntigravityHostContracts } from "./host-contracts.js";
import { AntigravityPreview } from "./preview.js";
import { appendDiagnostic, diagnosticError, terminalDiagnostic, type DiagnosticStage } from "./diagnostics.js";

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


function failureTerminal(params: AgentHarnessAttemptParamsV2, error: unknown, diagnostic: Error): ReturnType<typeof agentHarnessAttemptTerminal.normalize> {
  // Acquisition errors retain their own purpose. Only cancellation/timeout
  // attribution is inherited; their read-only process evidence is not inference.
  if (error instanceof Error && error.cause instanceof Error &&
      (error.cause instanceof AgyProcessError || error.cause instanceof InvocationScopeError) &&
      (error.cause.kind === "aborted" || error.cause.kind === "timeout")) {
    return failureTerminal(params, error.cause, diagnostic);
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
      const timeoutError = diagnostic;
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
      promptError: diagnostic,
      promptErrorSource: error.kind === "spawn" ? "precheck" : "prompt",
    });
  }
  return agentHarnessAttemptTerminal.normalize({
    promptError: diagnostic,
    promptErrorSource: "prompt",
  });
}

export async function runAntigravityAttempt(params: {
  attempt: AgentHarnessAttemptParamsV2;
  pluginConfig: AntigravityPluginConfig;
  sessionBindings: AntigravitySessionBindings;
  hostContracts?: AntigravityHostContracts;
  inventory?: AgyInventoryService;
  nativeEffortControls?: boolean;
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
  let stage: DiagnosticStage = "session_prepare";
  let primaryDiagnostic: Error | undefined;

  const startedMonoMs = performance.now();
  let runDeadlineMonoMs = Infinity;
  // A pending read has no mutation authority. Bound its consumer and recheck
  // cancellation after settlement; never use a late read to launch native work.
  const readSession = async <T>(read: () => Promise<T>): Promise<T> => {
    if (attempt.abortSignal?.aborted) throw new InvocationScopeError("aborted", "ANTIGRAVITY session operation aborted");
    attempt.hostCapabilities.assertActive();
    const remaining = Math.min(1_000, runDeadlineMonoMs - performance.now());
    if (remaining <= 0) throw new InvocationScopeError("timeout", "ANTIGRAVITY session read deadline expired");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const result = await Promise.race([read(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new InvocationScopeError("timeout", "ANTIGRAVITY session read exceeded its allowance")), remaining);
        abort = () => reject(new InvocationScopeError("aborted", "ANTIGRAVITY session read aborted"));
        attempt.abortSignal?.addEventListener("abort", abort, { once: true });
        if (attempt.abortSignal?.aborted) abort();
      })]);
      if (attempt.abortSignal?.aborted) throw new InvocationScopeError("aborted", "ANTIGRAVITY session operation aborted");
      attempt.hostCapabilities.assertActive();
      if (performance.now() >= runDeadlineMonoMs) throw new InvocationScopeError("timeout", "ANTIGRAVITY session read deadline expired");
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abort) attempt.abortSignal?.removeEventListener("abort", abort);
    }
  };

  try {
    runDeadlineMonoMs = startedMonoMs + Math.min(attempt.timeoutMs ?? Infinity, parseAgyPrintTimeoutMs(pluginConfig.printTimeout));
    assertOpenClawAttemptCapabilities(attempt);
    attempt.hostCapabilities.assertActive();
    const host = requireAntigravityHostContracts(params.hostContracts);
    const existingBinding = await readSession(() => sessionBindings.resolve(sessionIdentity));
    attempt.hostCapabilities.assertActive();
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
      deadlineMonoMs: runDeadlineMonoMs,
      assertActive: () => {
        attempt.hostCapabilities.assertActive();
        projection.assertCurrent();
        lease?.assertActive();
      },
      assertCurrent: async () => { if (lease) await readSession(() => lease!.assertCurrent()); },
      purpose: "attempt",
      owner: { agentId: attempt.agentId, workspaceDir: attempt.workspaceDir, sessionId: attempt.sessionId },
      projectSelection: { ...(pluginConfig.project ? { project: pluginConfig.project } : {}), newProject: pluginConfig.newProject },
      addDirs: pluginConfig.addDirs,
      ...(pluginConfig.agent ? { nativeAgentSelection: pluginConfig.agent } : {}),
    });
    scope.assertActive();
    // A host-projected off level is the native-selection default, not an AGY
    // effort name. Modern host profiles expose adjustable controls only on
    // observed models; the public attempt deliberately omits thinkingExplicit.
    const nonDefaultThink = attempt.thinkLevel !== undefined && attempt.thinkLevel !== "off";
    const requestedEffort = params.nativeEffortControls && nonDefaultThink && attempt.model.reasoning === true;
    if (params.nativeEffortControls && nonDefaultThink && attempt.model.reasoning === false) {
      throw new AgyEffortError("fixed-or-unobserved");
    }
    const preflight = async (withEffort: boolean) => {
      stage = "preflight";
      return preflightAgyCapabilities({ scope, requiredFlags: [
        ...(pluginConfig.sandbox ? ["--sandbox"] : []),
        ...(pluginConfig.dangerouslySkipPermissions ? ["--dangerously-skip-permissions"] : []),
        ...(pluginConfig.project ? ["--project"] : []),
        ...(pluginConfig.newProject ? ["--new-project"] : []),
        ...(pluginConfig.addDirs.length ? ["--add-dir"] : []),
        ...(pluginConfig.agent ? ["--agent"] : []),
        ...(pluginConfig.mode ? ["--mode"] : []),
        ...(pluginConfig.logFile ? ["--log-file"] : []),
        ...projection.requiredNativeFlags,
        ...(withEffort ? AGY_EFFORT_FLAGS : []),
      ] });
    };
    const acquireInventory = async () => {
      stage = "discovery";
      const inventory = params.inventory ?? new AgyInventoryService();
      try { return await inventory.get({ scope, fresh: true }); }
      finally { if (!params.inventory) inventory.stop(); }
    };
    let resolvedModel: ResolvedAgyAttemptModel | undefined;
    // Only an effective override needs read-only resolution before claiming
    // the exact model lease. No inference, binding or mutation is allowed by
    // these probes. Re-read the original canonical binding after the awaits.
    if (requestedEffort) {
      const capabilities = await preflight(true);
      const liveModels = await acquireInventory();
      resolvedModel = await resolveAgyEffortAttempt({
        scope, preflight: capabilities, modelId: requestedModelId,
        thinkLevel: attempt.thinkLevel, liveModels,
        ...(existingBinding ? { boundModelId: existingBinding.modelId } : {}),
      });
      if (!isDeepStrictEqual(existingBinding, await readSession(() => sessionBindings.resolve(sessionIdentity)))) {
        throw new Error("ANTIGRAVITY canonical binding changed during preparation; restart from the current host session");
      }
      scope.assertActive();
    }
    stage = "session_prepare";
    // Preserve native v2 bindings across plugin upgrades. This opaque key ties
    // the lease to its binding; it does not identify an AGY account or project.
    const bindingScopeKey = existingBinding?.scopeKey ?? randomUUID();
    let claimAllowed = true;
    let claimTimer: ReturnType<typeof setTimeout> | undefined;
    const assertClaimActive = guardSessionAuthority(attempt.hostCapabilities.assertActive, () => {
      if (!claimAllowed) throw new Error("ANTIGRAVITY session claim callback was retired");
      projection.assertCurrent();
      if (attempt.abortSignal?.aborted) throw new InvocationScopeError("aborted", "AGY session preparation aborted");
      if (performance.now() >= scope.deadlineMonoMs) throw new InvocationScopeError("timeout", "AGY session preparation deadline expired");
    });
    try {
      lease = await Promise.race([
        sessionBindings.beginAttempt({ ...sessionIdentity, modelId: resolvedModel?.modelId ?? requestedModelId,
          scopeKey: bindingScopeKey, assertActive: assertClaimActive }),
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
    await readSession(() => lease!.assertCurrent());
    scope.assertActive();
    // The default exact-model path retains the existing lease-before-probe
    // ordering. An effort-selected lease already owns the native-resolved ID;
    // confirm that both IDs remain advertised under the current lease.
    if (!resolvedModel) {
      await preflight(false);
      await readSession(() => lease!.assertCurrent());
      scope.assertActive();
      const liveModels = await acquireInventory();
      await readSession(() => lease!.assertCurrent());
      resolvedModel = resolveAgyAttemptModel({
        modelId: requestedModelId, thinkLevel: attempt.thinkLevel, liveModels,
      });
    } else {
      const currentModels = await acquireInventory();
      await readSession(() => lease!.assertCurrent());
      if (!currentModels.some(row => row.id === resolvedModel!.modelId &&
          row.name === resolvedModel!.selectedEffort?.label) ||
          !currentModels.some(row => row.id === requestedModelId)) {
        throw new AgyEffortError("effective-model-unverified");
      }
    }
    if (existingBinding) {
      assertAgyResumeModelConsistency({
        ...(existingBinding.modelId !== undefined
          ? { boundModelId: existingBinding.modelId }
          : {}),
        resolvedModelId: resolvedModel.modelId,
        conversationId: existingBinding.conversationId,
      });
    }

    stage = "before_spawn";
    if (attempt.images?.length && !host.images?.supportsModel(resolvedModel.modelId)) {
      throw new Error("ANTIGRAVITY image request requires a qualified effective model");
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
    await readSession(() => lease!.assertCurrent());
    scope.assertActive();
    const stdin = encodeAgyPromptInput(materialized.prompt);
    const args = existingBinding
      ? buildAgyHarnessResumeArgs({
          config: pluginConfig,
          modelId: resolvedModel.modelId,
          ...(resolvedModel.selectedEffort === undefined ? {} : { effort: resolvedModel.selectedEffort }),
          prompt: materialized.prompt,
          conversationId: existingBinding.conversationId,
        })
      : buildAgyHarnessFreshArgs({
          config: pluginConfig,
          modelId: resolvedModel.modelId,
          ...(resolvedModel.selectedEffort === undefined ? {} : { effort: resolvedModel.selectedEffort }),
          prompt: materialized.prompt,
        });
    attempt.onAttemptTimeoutArmed?.();
    recordTrajectory(attempt, "antigravity.attempt_started", {
      resumed: Boolean(existingBinding),
      requestedModelId,
      modelId: resolvedModel.modelId,
      thinkLevel: attempt.thinkLevel,
      ...(resolvedModel.selectedEffort === undefined ? {} : { nativeEffort: resolvedModel.selectedEffort.effort }),
      imageCount: materialized.paths.length,
    });
    let conversationBound = false;
    const preview = new AntigravityPreview();
    nativeProcessEntered = true;
    stage = "active_stream";
    const result = await runAgyStreamProcess({
      scope, args, stdin,
      expectedModelId: resolvedModel.modelId,
      ...(existingBinding ? { expectedConversationId: existingBinding.conversationId } : {}),
      async onEvent(event, context) {
        context.assertActive();
        await readSession(() => lease!.assertCurrent());
        context.assertActive();
        if (event.event === "init") {
          stage = "init_bind";
          const conversationId = event.conversation_id;
          // The parser checks the requested model and exact resumed conversation.
          // AGY owns authentication and the conversation's associated project.
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
              assertActive: () => context.signal.throwIfAborted(),
            });
            context.assertActive();
          }
          conversationBound = true;
          stage = "active_stream";
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
            await readSession(() => lease!.assertCurrent());
            const assertCommitAllowed = () => { context.assertActive(); lease!.assertActive(); };
            await host.preview.publish({ ...update, signal: context.signal, assertCommitAllowed,
              assertCurrent: async () => { await readSession(() => lease!.assertCurrent()); assertCommitAllowed(); },
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
    evidence = result.evidence;
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
    recordTrajectory(attempt, "antigravity.attempt_failed", {
      kind: error instanceof AgyProcessError ? error.kind : "runtime",
      nativeAssistantOutputObserved,
      nativeToolActivityObserved,
    });
    primaryDiagnostic = diagnosticError(stage, error, evidence);
    completed = buildAntigravityFailureResult({
      evidence,
      ...(partialSnapshot ? { partialSnapshot } : {}),
      attempt,
      error: primaryDiagnostic,
      terminal: failureTerminal(attempt, error, primaryDiagnostic),
      partialReplyObserved: nativeAssistantOutputObserved,
      nativeToolActivityObserved,
      ...(lastToolError ? { lastToolError } : {}),
    });
  }
  // Resource cleanup and diagnostic drainage share the runner's original settlement
  // deadline. A blocked observer cannot extend settlement by another timeout window.
  const cleanupDeadline = Math.min(evidence.termination.settlementDeadlineMonoMs ?? Infinity, performance.now() + 2_000);
  const priorDiagnostic = () => terminalDiagnostic(completed.terminal) ?? primaryDiagnostic;
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
  try { if (cleanupImages) await boundedCleanup(cleanupImages); } catch (cleanupError) {
    recordTrajectory(attempt, "antigravity.image_cleanup_failed", { cleanupComplete: false });
    evidence = { ...evidence, termination: { ...evidence.termination, cleanupComplete: false } };
    const error = appendDiagnostic(priorDiagnostic(), "cleanup", cleanupError, evidence);
    completed = buildAntigravityFailureResult({ attempt, evidence,
      error,
      ...(completed.terminal.kind !== "ok" ? {
        terminal: agentHarnessAttemptTerminal.setFailure(completed.terminal, {
          source: completed.terminal.kind === "failed" ? completed.terminal.source : "prompt",
          error,
        }),
      } : {}),
      ...(partialSnapshot ? { partialSnapshot } : {}),
      ...(lastToolError ? { lastToolError } : {}),
    });
  }
  if (lease) {
    let endAllowed = true;
    try {
      if (completed.terminal.kind === "ok") await readSession(() => lease!.assertCurrent());
      await boundedCleanup(() => sessionBindings.endAttempt(lease!, {
        terminationConfirmed: evidence.termination.cleanupComplete,
        assertCommitAllowed: () => {
          if (!endAllowed || performance.now() >= cleanupDeadline) throw new Error("ANTIGRAVITY session settlement callback retired");
        },
      }));
    }
    catch (error) {
      const diagnostic = appendDiagnostic(priorDiagnostic(), "settlement", error, evidence);
      completed = buildAntigravityFailureResult({ attempt, evidence, error: diagnostic,
        suppressNativeOutput: true,
        ...(partialSnapshot ? { partialSnapshot } : {}),
        ...(completed.terminal.kind === "timeout" || completed.terminal.kind === "aborted"
          ? { terminal: agentHarnessAttemptTerminal.setFailure(completed.terminal, { source: "prompt", error: diagnostic }) }
          : {}),
      });
    } finally { endAllowed = false; }
    const assertDeliveryCurrent = async () => {
      attempt.hostCapabilities.assertActive();
      await readSession(() => sessionBindings.assertResultCurrent(lease!));
      attempt.hostCapabilities.assertActive();
    };
    if (completed.terminal.kind === "ok") {
      try { await assertDeliveryCurrent(); }
      catch (error) {
        completed = buildAntigravityFailureResult({ attempt, evidence, error: diagnosticError("delivery", error, evidence),
          suppressNativeOutput: true,
          ...(partialSnapshot ? { partialSnapshot } : {}),
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
    try { await completed.antigravityDeliveryGuard(); }
    catch (error) {
      const guard = completed.antigravityDeliveryGuard;
      completed = buildAntigravityFailureResult({ attempt, evidence, error: diagnosticError("delivery", error, evidence),
        suppressNativeOutput: true,
        ...(partialSnapshot ? { partialSnapshot } : {}),
      });
      completed.antigravityDeliveryGuard = guard;
    }
  }
  return completed;
}
