import { performance } from "node:perf_hooks";
import { AGY_PROCESS_LIMITS, runAgyRawProcess } from "../cli/agy-process.js";
import { preflightAgyCapabilities, type AgyCapabilityPreflight } from "../cli/capability-preflight.js";
import type { InvocationScope } from "../cli/invocation-scope.js";
import { buildAgyDiscoveryArgs, type AgyDiscoveredModel } from "./model-catalog.js";
import {
  AgyEffortError, assertAgyEffortPair, parseAgyEffortOutput, parseAgySelectedModelOutput,
  requireAgyEffort, resolveAgyAttemptModel, resolveAgyEffortSelection, selectAgyEffortCandidate,
  type AgySelectedModel, type ResolvedAgyAttemptModel,
} from "./model-capabilities.js";
import type { AgentHarnessAttemptParamsV2 } from "../host/types.js";

export const AGY_EFFORT_FLAGS = ["--settings", "--print", "--effort"] as const;
const MAX_REPORT_BYTES = 128 * 1024;

type ReportExecutor = typeof runAgyRawProcess;

/** AGY documents these two no-argument print-mode commands as zero-turn
 * reads since 1.1.26. The existing version preflight is >=1.1.28. Require
 * the session-only settings flag and explicitly enable slash commands:
 * a user's disabled slash-command setting must not turn this into a prompt.
 * Never use --new-project, --conversation, --continue or user text here. */
export function buildAgyEffortProbeArgs(scope: InvocationScope, modelId: string,
  command: "effort" | "model", selected?: AgySelectedModel): string[] {
  if (command !== "effort" && command !== "model") throw new AgyEffortError("unverified-report");
  // Only a /model confirmation of an already observed matching pair may
  // include --effort. All discovery of candidate identities is model-only.
  if (selected !== undefined && command !== "model") throw new AgyEffortError("unverified-report");
  return [...buildAgyDiscoveryArgs(scope).slice(0, -1),
    "--settings", JSON.stringify({ disableSlashCommands: false }),
    "--model", modelId, ...(selected === undefined ? [] : ["--effort", assertAgyEffortPair(modelId, selected)]),
    "--print", command === "effort" ? "/effort" : "/model"];
}

async function report(params: {
  scope: InvocationScope; preflight: AgyCapabilityPreflight; modelId: string;
  command: "effort" | "model"; selected?: AgySelectedModel; execute?: ReportExecutor;
}): Promise<string> {
  if (!AGY_EFFORT_FLAGS.every(flag => params.preflight.advertisedFlags.includes(flag))) {
    throw new AgyEffortError("probe-unavailable");
  }
  const { scope } = params;
  scope.assertActive();
  await scope.assertCurrent?.();
  const remaining = Math.min(10_000, scope.deadlineMonoMs - performance.now());
  if (remaining <= 0) throw new AgyEffortError("probe-unavailable");
  const result = await (params.execute ?? runAgyRawProcess)({
    scope, args: buildAgyEffortProbeArgs(scope, params.modelId, params.command, params.selected),
    timeoutMs: remaining, maxOutputBytes: MAX_REPORT_BYTES,
  });
  scope.assertActive();
  await scope.assertCurrent?.();
  if (result.exitCode !== 0 ||
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_REPORT_BYTES) {
    throw new AgyEffortError("probe-unavailable");
  }
  return result.stdout;
}

/** Optional enrichment never guesses levels for unprobed rows. Only configured
 * refs and the exact prepared model are queried, with one shared short budget
 * inside catalog acquisition. Keep sufficient time for bounded child cleanup.
 * A failed optional read leaves inventory intact; an obsolete owner does not. */
export async function observeAgyCatalogEffort(scope: InvocationScope,
  models: readonly AgyDiscoveredModel[], modelIds: readonly string[]): Promise<readonly AgyDiscoveredModel[]> {
  const selected = [...new Set(modelIds)].filter(id => models.some(row => row.id === id));
  if (!selected.length) return models;
  const deadline = Math.min(scope.deadlineMonoMs - AGY_PROCESS_LIMITS.settlementMs - 250, performance.now() + 3_000);
  if (deadline <= performance.now()) return models;
  const probeScope = Object.freeze({ ...scope, deadlineMonoMs: deadline });
  const observed = new Map<string, ReturnType<typeof parseAgyEffortOutput>>();
  try {
    const preflight = await preflightAgyCapabilities({ scope: probeScope, requiredFlags: AGY_EFFORT_FLAGS });
    for (const modelId of selected) {
      if (performance.now() >= deadline) break;
      observed.set(modelId, parseAgyEffortOutput(await report({
        scope: probeScope, preflight, modelId, command: "effort",
      })));
    }
  } catch {
    // Optional capabilities are unknown after an unavailable probe. Do not
    // emit native output or infer auth; the original owner must remain current.
    scope.assertActive();
  }
  scope.assertActive();
  return models.map(row => observed.has(row.id) ? { ...row, effort: observed.get(row.id)! } : row);
}

/** Resolve before claiming the exact model lease. AGY rejects an explicit
 * effort-qualified model slug combined with a different --effort. Never send
 * that combination, including in metadata probes. Verify the requested
 * record, locate a unique candidate from native labels, independently verify
 * its exact record and effort capability, then confirm the matching pair.
 * Every subprocess must exit zero; a SUCCESS envelope with nonzero exit fails. */
export async function resolveAgyEffortAttempt(params: {
  scope: InvocationScope; preflight: AgyCapabilityPreflight; modelId: string;
  thinkLevel: AgentHarnessAttemptParamsV2["thinkLevel"]; liveModels: readonly AgyDiscoveredModel[];
  boundModelId?: string; execute?: ReportExecutor;
}): Promise<ResolvedAgyAttemptModel> {
  const base = resolveAgyAttemptModel(params);
  if (params.thinkLevel === "off") return base;
  const observation = parseAgyEffortOutput(await report({ ...params, command: "effort" }));
  requireAgyEffort({ ...params, observation });
  const requestedModel = parseAgySelectedModelOutput(await report({
    ...params, command: "model",
  }), params.liveModels, params.modelId);
  const effectiveModelId = selectAgyEffortCandidate({ ...params, observation, requestedModel });
  if (params.boundModelId !== undefined && params.boundModelId !== effectiveModelId) {
    throw new AgyEffortError("resume-variant-change");
  }
  const effectiveModel = effectiveModelId === params.modelId ? requestedModel
    : parseAgySelectedModelOutput(await report({
      ...params, modelId: effectiveModelId, command: "model",
    }), params.liveModels, effectiveModelId);
  const effectiveObservation = effectiveModelId === params.modelId ? observation
    : parseAgyEffortOutput(await report({
      ...params, modelId: effectiveModelId, command: "effort",
    }));
  const resolved = resolveAgyEffortSelection({
    ...params, observation, requestedModel, effectiveModel, effectiveObservation,
  });
  // Selection and the two capability observations establish a matching pair.
  // Confirm actual parser precedence before handing that pair to inference.
  const selected = resolved.selectedEffort!;
  const confirmed = parseAgySelectedModelOutput(await report({
    ...params, modelId: resolved.modelId, command: "model", selected,
  }), params.liveModels, resolved.modelId);
  if (confirmed.effort !== selected.effort || confirmed.label !== selected.label) {
    throw new AgyEffortError("effective-model-unverified");
  }
  return { ...resolved, selectedEffort: confirmed };
}
