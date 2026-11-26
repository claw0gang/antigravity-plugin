import type { AntigravityHostContracts } from "../harness/host-contracts.js";
import type { AntigravitySessionRuntime } from "./session-runtime.js";

/** AGY owns authentication. The plugin needs only the public canonical session
 * adapter; optional context, media and delivery adapters remain host-owned. */
export function createOpenClawAntigravityHostContracts(options: {
  sessionRuntime: Pick<AntigravitySessionRuntime,
    "getSessionEntryAsync" | "withCurrentSessionEntry" | "prepareSessionEntryPatch">;
}): AntigravityHostContracts {
  if (typeof options.sessionRuntime.getSessionEntryAsync !== "function" ||
      typeof options.sessionRuntime.withCurrentSessionEntry !== "function" ||
      typeof options.sessionRuntime.prepareSessionEntryPatch !== "function") {
    throw new Error("ANTIGRAVITY native execution requires OpenClaw canonical session support");
  }
  return {
    sessionMutation: {
      evidence: "OpenClaw public session runtime uses captured-entry CAS with prepared authority and current-entry callbacks (or the selected legacy adapter)",
    },
  };
}
