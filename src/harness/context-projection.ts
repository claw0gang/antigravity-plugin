import { createHash } from "node:crypto";
import type { AgentHarnessAttemptParamsV2 } from "../host/types.js";

/** Internal C03 semantics, not additional fields in the OpenClaw SDK. */
export interface AntigravityInstructionRequirement {
  originRef: string;
  trust: "host" | "user" | "untrusted";
  scope: "delegated" | "host-only";
  priority: "system" | "developer" | "user" | "data";
  required: boolean;
  contentOrResource: { content: string } | { resource: string };
  requiredTools: readonly string[];
}

export interface AntigravityInstructionDisposition {
  originRef: string;
  disposition: "preserved" | "host-only" | "optional-unsupported" | "rejected-required";
  reason: string;
}

/**
 * A t004 adapter may supply this only after qualifying the named native agent,
 * exact instruction priority, all resource/tool dependencies and fresh/resume
 * semantics. It is never populated from user prompts or plugin configuration.
 * assertCurrent must check the qualified definition/resource identities and
 * owner fence again immediately before native launch. A name alone is no proof.
 */
export interface AntigravityQualifiedInstructionCarrier {
  agentName: string;
  definitionIdentity: string;
  supportedPhases: readonly ("fresh" | "resume")[];
  preserved: readonly { originRef: string; requirementDigest: string }[];
  assertCurrent: () => void;
}

export interface AntigravityContextAdapter {
  /** Adds host-prepared requirements; cannot remove/reclassify SDK requirements. */
  requirements?: readonly AntigravityInstructionRequirement[];
  namedAgentCarrier?: AntigravityQualifiedInstructionCarrier;
}

export interface AntigravityHostProjection {
  prompt: string;
  dispositions: AntigravityInstructionDisposition[];
  requiredNativeFlags: string[];
  nativeAgentDefinitionIdentity?: string;
  /** Caller invokes this at the last prelaunch boundary and on resume. */
  assertCurrent: () => void;
}

export class AntigravityContextProjectionError extends Error {
  constructor(readonly dispositions: readonly AntigravityInstructionDisposition[]) {
    super(`ANTIGRAVITY cannot preserve required host context: ${dispositions
      .filter((entry) => entry.disposition === "rejected-required")
      .map((entry) => `${entry.originRef} (${entry.reason})`).join("; ")}. ` +
      "Use a host runtime that enforces these requirements or qualify the exact native carrier under P04 before submission.");
    this.name = "AntigravityContextProjectionError";
  }
}

function rejectMalformed(originRef: string): never {
  throw new AntigravityContextProjectionError([{
    originRef, disposition: "rejected-required", reason: "Malformed host context or carrier input",
  }]);
}

/** The one-user-frame transport cannot preserve non-user origin or a separate
 * inbound data carrier. A named-agent instruction mapping does not fix either:
 * the forwarded prompt would still have user-role authority. Reject those
 * requests until a qualified projection of the complete input exists (P04).
 */
function projectPromptContextBoundary(
  attempt: AgentHarnessAttemptParamsV2,
  dispositions: AntigravityInstructionDisposition[],
): void {
  const provenance: unknown = attempt.inputProvenance;
  if (provenance !== undefined) {
    if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) rejectMalformed("inputProvenance");
    const value = provenance as Record<string, unknown>;
    const metadataKeys = ["originSessionId", "sourceSessionKey", "sourceChannel", "sourceTool"];
    if (!["external_user", "inter_session", "internal_system"].includes(value.kind as string) ||
        Object.keys(value).some((key) => key !== "kind" && !metadataKeys.includes(key)) ||
        metadataKeys.some((key) => value[key] !== undefined && typeof value[key] !== "string")) {
      rejectMalformed("inputProvenance");
    }
    dispositions.push(value.kind === "external_user" ? {
      originRef: "inputProvenance", disposition: "preserved",
      reason: "External-user priority is preserved by the user carrier; source metadata remains host-owned",
    } : {
      originRef: "inputProvenance", disposition: "rejected-required",
      reason: "Non-user provenance cannot be preserved by forwarding the prompt as a native user message",
    });
  }

  const inbound: unknown = attempt.currentInboundContext;
  if (inbound !== undefined) {
    if (!inbound || typeof inbound !== "object" || Array.isArray(inbound)) rejectMalformed("currentInboundContext");
    const value = inbound as Record<string, unknown>;
    const keys = ["text", "fragments", "resumableText", "promptJoiner", "injectedGoalContexts"];
    if (Object.keys(value).some((key) => !keys.includes(key)) || typeof value.text !== "string" ||
        (value.resumableText !== undefined && typeof value.resumableText !== "string") ||
        (value.promptJoiner !== undefined && !["\n\n", "\n", " "].includes(value.promptJoiner as string)) ||
        (value.fragments !== undefined && !Array.isArray(value.fragments)) ||
        (value.injectedGoalContexts !== undefined && (!Array.isArray(value.injectedGoalContexts) ||
          value.injectedGoalContexts.some((goal) => typeof goal !== "string")))) {
      rejectMalformed("currentInboundContext");
    }
    // Empty legacy text does not imply empty context: producer fragments,
    // resumable text and injected goals can still carry applicable semantics.
    const hasContent = Boolean(value.text.trim() || (value.resumableText as string | undefined)?.trim() ||
      (value.fragments as unknown[] | undefined)?.length || (value.injectedGoalContexts as string[] | undefined)?.length);
    dispositions.push(hasContent ? {
      originRef: "currentInboundContext", disposition: "rejected-required",
      reason: "Separate inbound context has no qualified native data/priority carrier",
    } : {
      originRef: "currentInboundContext", disposition: "host-only",
      reason: "Validated empty inbound envelope has no delegated content",
    });
  }
}

function validateRequirement(requirement: AntigravityInstructionRequirement): void {
  if (!requirement || typeof requirement !== "object" || typeof requirement.originRef !== "string" ||
      !requirement.originRef.trim() || !["host", "user", "untrusted"].includes(requirement.trust) ||
      !["delegated", "host-only"].includes(requirement.scope) ||
      !["system", "developer", "user", "data"].includes(requirement.priority) ||
      typeof requirement.required !== "boolean" || !Array.isArray(requirement.requiredTools) ||
      requirement.requiredTools.some((tool) => typeof tool !== "string" || !tool.trim())) {
    rejectMalformed("instruction requirement");
  }
  const value = requirement.contentOrResource;
  if (!value || typeof value !== "object" ||
      ("content" in value) === ("resource" in value) ||
      ("content" in value ? typeof value.content !== "string" : typeof value.resource !== "string" || !value.resource.trim())) {
    rejectMalformed(requirement.originRef);
  }
}

/** Exact semantic identity; no prompt/resource content is included in telemetry. */
export function antigravityInstructionDigest(requirement: AntigravityInstructionRequirement): string {
  validateRequirement(requirement);
  return createHash("sha256").update(JSON.stringify([
    requirement.originRef, requirement.trust, requirement.scope, requirement.priority,
    requirement.required, "content" in requirement.contentOrResource ? "content" : "resource",
    "content" in requirement.contentOrResource ? requirement.contentOrResource.content : requirement.contentOrResource.resource,
    [...requirement.requiredTools].sort(),
  ])).digest("hex");
}

/**
 * Public inputs inspected at OpenClaw 8bec206f3c1f787e1e9c45cfd34d3de2a78c7b8e:
 * src/agents/harness/types.ts -> embedded-agent-runner/run/{params,types}.ts;
 * skills/types.ts, sessions/input-provenance.ts, attempt-prompt-build.ts and
 * config/sessions/session-tool-overrides.ts.
 * No internal host import or invented --system-prompt/agent-file carrier is used.
 */
export function projectAntigravityHostContext(
  attempt: AgentHarnessAttemptParamsV2,
  options: {
    phase: "fresh" | "resume";
    nativeAgentName?: string;
    adapter?: AntigravityContextAdapter;
  },
): AntigravityHostProjection {
  attempt.hostCapabilities.assertActive();
  for (const field of ["prompt", "extraSystemPrompt", "gitCoauthorPrompt"] as const) {
    if (attempt[field] !== undefined && typeof attempt[field] !== "string") rejectMalformed(field);
  }
  if (typeof attempt.prompt !== "string") rejectMalformed("prompt");
  for (const field of ["pluginHarnessToolPolicyRestricted", "disableTools", "requireWorkspaceOnly", "requireWritableSandbox"] as const) {
    if (attempt[field] !== undefined && typeof attempt[field] !== "boolean") rejectMalformed(field);
  }
  for (const field of ["runtimeContextFragments", "explicitSkillSelections", "pluginHarnessToolPolicySafeDeniedTools", "toolsAllow", "toolExecutionAllow", "clientTools", "internalEvents"] as const) {
    if (attempt[field] !== undefined && !Array.isArray(attempt[field])) rejectMalformed(field);
  }
  for (const field of ["toolOverrides", "conversationToolPolicy", "skillsSnapshot"] as const) {
    if (attempt[field] !== undefined && (typeof attempt[field] !== "object" || attempt[field] === null || Array.isArray(attempt[field]))) rejectMalformed(field);
  }
  if (attempt.sandbox !== undefined && attempt.sandbox !== null &&
      (typeof attempt.sandbox !== "object" || typeof attempt.sandbox.enabled !== "boolean" ||
       (attempt.sandbox.required !== undefined && attempt.sandbox.required !== true))) rejectMalformed("sandbox");
  if (attempt.permissionMode !== undefined && !["full", "read-only", "guarded", "workspace"].includes(attempt.permissionMode)) rejectMalformed("permissionMode");
  const requirements: AntigravityInstructionRequirement[] = [];
  const dispositions: AntigravityInstructionDisposition[] = [];
  projectPromptContextBoundary(attempt, dispositions);
  const addText = (originRef: string, content: string | undefined, priority: "system" | "developer") => {
    if (content?.trim()) requirements.push({
      originRef, trust: "host", scope: "delegated", priority, required: true,
      contentOrResource: { content }, requiredTools: [],
    });
  };
  addText("extraSystemPrompt", attempt.extraSystemPrompt, "system");
  addText("gitCoauthorPrompt", attempt.gitCoauthorPrompt, "system");
  for (const [index, fragment] of (attempt.runtimeContextFragments ?? []).entries()) {
    if (!fragment || typeof fragment.text !== "string" ||
        !["runtime-instruction", "conversation-data", "heartbeat-outcome"].includes(fragment.kind)) {
      rejectMalformed(`runtimeContextFragments[${index}]`);
    }
    requirements.push({
      originRef: `runtimeContextFragments[${index}]`,
      trust: fragment.kind === "runtime-instruction" ? "host" : "untrusted",
      scope: "delegated", priority: fragment.kind === "runtime-instruction" ? "developer" : "data",
      required: true, contentOrResource: { content: fragment.text }, requiredTools: [],
    });
  }
  for (const [index, skill] of (attempt.explicitSkillSelections ?? []).entries()) {
    if (!skill || typeof skill.name !== "string" || !skill.name.trim() || typeof skill.path !== "string" || !skill.path.trim()) {
      rejectMalformed(`explicitSkillSelections[${index}]`);
    }
    requirements.push({
      originRef: `explicitSkillSelections[${index}]`, trust: "user", scope: "delegated",
      priority: "user", required: true, contentOrResource: { resource: skill.path }, requiredTools: [],
    });
  }
  // An available-skills catalog is host discovery, not proof a skill is selected
  // or that its tools/resources are available natively. Explicit selections above
  // must still be preserved, and a t004 adapter may add required resolved skills.
  if (attempt.skillsSnapshot) dispositions.push({
    originRef: "skillsSnapshot", disposition: "host-only",
    reason: "Available skill discovery remains with OpenClaw; no native skill availability is inferred",
  });
  if (attempt.contextEngine) dispositions.push({
    originRef: "contextEngine", disposition: "rejected-required",
    reason: "Native projection of host context-engine assembly is not qualified",
  });
  if (attempt.finalizePromptForResolvedTools) dispositions.push({
    originRef: "finalizePromptForResolvedTools", disposition: "rejected-required",
    reason: "The exact native tool surface required to finalize guidance is unavailable",
  });
  if (attempt.internalEvents?.length) dispositions.push({
    originRef: "internalEvents", disposition: "rejected-required",
    reason: "Internal-event provenance requires a qualified context adapter",
  });

  // These public fields express prevention requirements. Native post-tool
  // observation and --dangerously-skip-permissions cannot enforce them. A named
  // instruction carrier cannot turn prose into a tool/approval/isolation fence.
  const restrictions: [string, boolean][] = [
    ["pluginHarnessToolPolicyRestricted", attempt.pluginHarnessToolPolicyRestricted === true],
    ["pluginHarnessToolPolicySafeDeniedTools", Boolean(attempt.pluginHarnessToolPolicySafeDeniedTools?.length)],
    ["disableTools", attempt.disableTools === true],
    ["toolsAllow", attempt.toolsAllow !== undefined],
    ["toolExecutionAllow", attempt.toolExecutionAllow !== undefined],
    ["conversationToolPolicy", attempt.conversationToolPolicy !== undefined],
    ["toolOverrides", attempt.toolOverrides !== undefined && Object.keys(attempt.toolOverrides).length > 0],
    // Public modes are read-only/guarded/workspace/full. Only full adds no
    // prevention constraint here; it does not disable AGY's own permissions.
    ["permissionMode", attempt.permissionMode !== undefined && attempt.permissionMode !== "full"],
    ["requireWorkspaceOnly", attempt.requireWorkspaceOnly === true],
    ["requireWritableSandbox", attempt.requireWritableSandbox === true],
    ["sandbox", attempt.sandbox?.enabled === true || attempt.sandbox?.required === true],
    ["clientTools", Boolean(attempt.clientTools?.length)],
    ["scheduledToolPolicy", attempt.scheduledToolPolicy !== undefined],
  ];
  for (const [originRef, restricted] of restrictions) if (restricted) dispositions.push({
    originRef, disposition: "rejected-required",
    reason: "Native prevention/tool-policy carrier is not qualified",
  });
  if (options.adapter?.requirements !== undefined && !Array.isArray(options.adapter.requirements)) rejectMalformed("adapter.requirements");
  requirements.push(...(options.adapter?.requirements ?? []));
  const seen = new Set<string>(dispositions.map((entry) => entry.originRef));
  const carrier = options.adapter?.namedAgentCarrier;
  if (carrier && (typeof carrier.agentName !== "string" || typeof carrier.definitionIdentity !== "string" ||
      !Array.isArray(carrier.supportedPhases) || !Array.isArray(carrier.preserved) || typeof carrier.assertCurrent !== "function")) {
    rejectMalformed("namedAgentCarrier");
  }
  const carrierMatches = carrier !== undefined && Boolean(carrier.agentName.trim()) &&
    carrier.agentName === options.nativeAgentName && Boolean(carrier.definitionIdentity.trim()) &&
    carrier.supportedPhases.includes(options.phase);
  const preserved = new Map<string, string>();
  for (const mapping of carrier?.preserved ?? []) {
    if (!mapping || typeof mapping.originRef !== "string" || !mapping.originRef.trim() ||
        typeof mapping.requirementDigest !== "string" || !/^[a-f0-9]{64}$/u.test(mapping.requirementDigest)) {
      rejectMalformed("namedAgentCarrier.preserved");
    }
    if (preserved.has(mapping.originRef)) throw new Error("Duplicate qualified instruction mapping");
    preserved.set(mapping.originRef, mapping.requirementDigest);
  }
  // A configured agent can change native instructions/tools even without an
  // extra host instruction. Its exact definition still belongs to session scope.
  let nativeCarrierUsed = options.nativeAgentName !== undefined;
  if (nativeCarrierUsed && !carrierMatches) dispositions.push({
    originRef: "nativeAgentDefinitionIdentity", disposition: "rejected-required",
    reason: "Configured native agent lacks a current exact qualified definition identity",
  });
  for (const requirement of requirements) {
    validateRequirement(requirement);
    if (!requirement.originRef.trim() || seen.has(requirement.originRef)) {
      throw new Error("Duplicate or empty host instruction origin; an adapter cannot replace host requirements");
    }
    seen.add(requirement.originRef);
    if (requirement.scope === "host-only") {
      dispositions.push({ originRef: requirement.originRef, disposition: "host-only", reason: "Host-owned orchestration requirement" });
    } else if (carrierMatches && preserved.get(requirement.originRef) === antigravityInstructionDigest(requirement)) {
      nativeCarrierUsed = true;
      dispositions.push({ originRef: requirement.originRef, disposition: "preserved", reason: "Exact qualified named-agent instruction/resource mapping" });
    } else {
      dispositions.push({
        originRef: requirement.originRef,
        disposition: requirement.required ? "rejected-required" : "optional-unsupported",
        reason: "No exact qualified carrier preserves priority and resource/tool dependencies",
      });
    }
  }
  if (dispositions.some((entry) => entry.disposition === "rejected-required")) {
    throw new AntigravityContextProjectionError(dispositions);
  }
  const assertCarrierCurrent = carrier?.assertCurrent;
  const assertCurrent = () => {
    attempt.hostCapabilities.assertActive();
    if (nativeCarrierUsed) assertCarrierCurrent!();
  };
  assertCurrent();
  return {
    // Only direct-user input reaches this carrier. Non-user provenance and
    // separate inbound payloads were rejected above, never stripped or demoted.
    prompt: attempt.prompt,
    dispositions: [{ originRef: "prompt", disposition: "preserved", reason: "One unchanged native stdin user message" }, ...dispositions],
    requiredNativeFlags: nativeCarrierUsed ? ["--agent"] : [],
    ...(nativeCarrierUsed ? { nativeAgentDefinitionIdentity: carrier!.definitionIdentity } : {}),
    assertCurrent,
  };
}

