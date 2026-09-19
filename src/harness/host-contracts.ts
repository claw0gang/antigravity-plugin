import { createHash } from "node:crypto";
import type { InvocationScope } from "../cli/invocation-scope.js";
import type { AttemptEvidence } from "../cli/attempt-evidence.js";
import type { AgyInitEvent } from "../protocol/agy-stream.js";
import type { AgyImageMediaPolicy } from "./image-input.js";
import type { AntigravityContextAdapter } from "./context-projection.js";
import type { AntigravityOpenClawSession } from "./session-bindings.js";

/** Internal adapter inputs, NOT upstream OpenClaw capabilities. t004 maps these
 * to supported host/native contracts; t007/P03–P06 must qualify their evidence.
 * Source tests inject explicitly simulated implementations. No default grants.
 */
export type AntigravityHostContracts = {
  sessionMutation: { evidence: string };
  runtime: {
    evidence: string;
    /** Stable non-secret account/command identity; never an environment digest. */
    identity: string;
    assertCurrent: () => void;
    /** Establish effective project/account/agent identity beyond request echoes. */
    verifyAcknowledgement: (params: {
      event: AgyInitEvent;
      scope: InvocationScope;
      conversationId?: string;
    }) => void;
  };
  context?: AntigravityContextAdapter;
  preview?: {
    evidence: string;
    /** Check assertCommitAllowed inside the final host mutation, then call
     * markDelivered synchronously when exposure occurs, before any later await. */
    publish: (preview: {
      text: string;
      delta?: string;
      signal: AbortSignal;
      assertCommitAllowed: () => void;
      markDelivered: () => void;
    }) => void | Promise<void>;
  };
  images?: {
    evidence: string;
    mediaPolicy: AgyImageMediaPolicy;
    supportsModel: (modelId: string) => boolean;
    /** Qualifies reader containment for this route; group cleanup alone cannot
     * establish that a detached native reader has stopped. */
    readersSettled: (evidence: AttemptEvidence) => boolean;
  };
  /** Host lifecycle revocation plus cancellation/drain, used by explicit reset. */
  cancelAndDrain?: (session: AntigravityOpenClawSession) => Promise<void>;
  /** Public reset inputs omit canonical storePath; t004 resolves it through the
   * supported host session target contract, never through an ambient default. */
  resolveResetSession?: (session: AntigravityOpenClawSession) => AntigravityOpenClawSession;
};

export function requireAntigravityHostContracts(
  contracts: AntigravityHostContracts | undefined,
): AntigravityHostContracts {
  if (!contracts?.sessionMutation?.evidence?.trim() ||
      !contracts.runtime?.evidence?.trim() || !contracts.runtime.identity?.trim() ||
      typeof contracts.runtime.assertCurrent !== "function" ||
      typeof contracts.runtime.verifyAcknowledgement !== "function") {
    throw new Error("ANTIGRAVITY requires a qualified host session/runtime adapter before native execution (P03/P05)");
  }
  contracts.runtime.assertCurrent();
  return contracts;
}

/** Persist only public placement and opaque non-secret runtime generations. */
export function antigravitySessionScopeKey(
  scope: InvocationScope,
  runtimeIdentity: string,
  nativeAgentDefinitionIdentity?: string,
): string {
  const material = JSON.stringify({
    schema: "antigravity-authority-scope/v1", runtimeIdentity,
    command: scope.command, cwd: scope.cwd,
    owner: Object.fromEntries(Object.entries(scope.owner).sort(([a], [b]) => a.localeCompare(b))),
    project: scope.projectSelection?.project ?? null,
    newProject: scope.projectSelection?.newProject === true,
    addDirs: scope.addDirs,
    agent: scope.nativeAgentSelection ?? null,
    agentDefinition: nativeAgentDefinitionIdentity ?? null,
  });
  return createHash("sha256").update(material).digest("hex");
}
