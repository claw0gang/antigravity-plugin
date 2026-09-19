import type { OpenClawPluginApi } from "./types.js";

export const OPENCLAW_SUPPORT_FLOOR = "2026.9.2";
export const OPENCLAW_SUPPORT_RANGE = ">=2026.9.2";
export const OPENCLAW_BUILD_SDK_VERSION = "2026.9.4";
export const OPENCLAW_REQUIRED_SDK_SUBPATHS = Object.freeze([
  "openclaw/plugin-sdk/plugin-entry", "openclaw/plugin-sdk/agent-harness-runtime",
] as const);

export const OPENCLAW_REQUIRED_REGISTRATION_CONTRACTS = Object.freeze([
  "registerProvider", "registerModelCatalogProvider", "registerAgentHarness", "registerCliBackend",
  "runtime.agent.session.getSessionEntry", "runtime.agent.session.patchSessionEntry",
] as const);

function valueAt(value: unknown, path: string): unknown {
  for (const key of path.split(".")) {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function stableVersion(value: unknown): readonly [number, number, number] | null {
  if (typeof value !== "string") return null;
  const parsed = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!parsed) return null;
  const tuple = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])] as const;
  return tuple.every(Number.isSafeInteger) ? tuple : null;
}

function atLeast(left: readonly [number, number, number], right: readonly [number, number, number]): boolean {
  for (let index = 0; index < 3; index++) {
    if (left[index]! > right[index]!) return true;
    if (left[index]! < right[index]!) return false;
  }
  return true;
}

/** Presence checks admit a source interface, never its unobserved runtime semantics. */
export function inspectOpenClawCompatibility(api: unknown) {
  const version = valueAt(api, "runtime.version");
  const runtimeVersion = typeof version === "string" ? version : null;
  const parsed = stableVersion(version);
  const floor = stableVersion(OPENCLAW_SUPPORT_FLOOR)!;
  const versionEligible = parsed !== null && atLeast(parsed, floor);
  const missingContracts = OPENCLAW_REQUIRED_REGISTRATION_CONTRACTS.filter(
    (path) => typeof valueAt(api, path) !== "function",
  );
  const diagnostics: string[] = [];
  if (!versionEligible) diagnostics.push(runtimeVersion === null
    ? "Missing required OpenClaw contract runtime.version; use a host exposing its public runtime version."
    : `Unsupported OpenClaw runtime.version ${JSON.stringify(runtimeVersion)}; required stable ${OPENCLAW_SUPPORT_RANGE}.`);
  for (const path of missingContracts) diagnostics.push(`Missing required OpenClaw contract ${path}; the installed host API is not compatible with this plugin build.`);
  return {
    runtimeVersion,
    buildSdkVersion: OPENCLAW_BUILD_SDK_VERSION,
    supportFloor: OPENCLAW_SUPPORT_FLOOR,
    supportRange: OPENCLAW_SUPPORT_RANGE,
    status: !versionEligible ? "unsupported" as const
      : missingContracts.length ? "missing-contracts" as const : "eligible" as const,
    missingContracts,
    diagnostics,
    requiredAtAttempt: ["hostCapabilities.assertActive", "hostCapabilities.preparedEnvironment"],
    optionalHelpers: {
      definePluginEntry: "optional-equivalent-local-fallback" as const,
      "agentHarnessAttemptTerminal.normalize": "optional-equivalent-local-fallback" as const,
    },
    installedQualification: "pending" as const,
    executionQualification: {
      status: "required-before-native-start" as const,
      evidence: ["P03 native runtime/account identity", "P05 atomic session mutation and final-result consumer"],
    },
    hostObservation: "read-only-public-contract" as const,
  };
}

/** Check every required registration function before invoking any registrar. */
export function assertOpenClawCompatibility(api: unknown): asserts api is OpenClawPluginApi {
  const report = inspectOpenClawCompatibility(api);
  if (report.status !== "eligible") {
    throw new Error(`ANTIGRAVITY OpenClaw compatibility rejected: ${report.diagnostics.join(" ")}`);
  }
}
