import type { AttemptEvidence } from "../cli/attempt-evidence.js";
import type { AgyImageMediaPolicy } from "./image-input.js";
import type { AntigravityContextAdapter } from "./context-projection.js";

/** Internal host adapters for canonical sessions and optional context/media/
 * delivery. Native authentication and conversation authorization belong to AGY. */
export type AntigravityHostContracts = {
  sessionMutation: { evidence: string };
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
      /** Await before a delayed publication; the synchronous final host effect fence is still required. */
      assertCurrent: () => Promise<void>;
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
};

export function requireAntigravityHostContracts(
  contracts: AntigravityHostContracts | undefined,
): AntigravityHostContracts {
  if (!contracts?.sessionMutation?.evidence?.trim()) {
    throw new Error("ANTIGRAVITY requires a host canonical session adapter before native execution");
  }
  return contracts;
}
