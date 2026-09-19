import type { AgentHarnessAttemptParamsV2 } from "./types.js";

export function assertOpenClawAttemptCapabilities(attempt: AgentHarnessAttemptParamsV2): void {
  const host = attempt.hostCapabilities;
  const missing = ["assertActive", "preparedEnvironment"].filter(
    (key) => typeof (host as unknown as Record<string, unknown> | undefined)?.[key] !== "function",
  );
  if (missing.length) {
    throw new Error(`ANTIGRAVITY missing required OpenClaw attempt contract: ${missing.map((key) => `hostCapabilities.${key}`).join(", ")}; native discovery/execution cannot start`);
  }
}

function isEnvironment(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.entries(value).every(([key, item]) => key.length > 0 && !/[=\0]/u.test(key) &&
      typeof item === "string" && !item.includes("\0"));
}

export function prepareOpenClawEnvironment(attempt: AgentHarnessAttemptParamsV2) {
  assertOpenClawAttemptCapabilities(attempt);
  attempt.hostCapabilities.assertActive();
  const prepared = attempt.hostCapabilities.preparedEnvironment!();
  if (!prepared || !isEnvironment(prepared.credentialScrubEnv) ||
      !isEnvironment(prepared.localIdentityEnv) || typeof prepared.managedLocalIdentity !== "boolean" ||
      (prepared.localProcessEnv !== undefined && !isEnvironment(prepared.localProcessEnv))) {
    throw new Error("ANTIGRAVITY malformed required OpenClaw hostCapabilities.preparedEnvironment result; native discovery/execution cannot start");
  }
  return {
    ...process.env, ...prepared.credentialScrubEnv, ...prepared.localIdentityEnv,
    ...(prepared.localProcessEnv ?? {}),
  };
}
