import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type CliBackendPlugin = Parameters<OpenClawPluginApi["registerCliBackend"]>[0];

const CLI_FRESH_WATCHDOG_DEFAULTS = {
  noOutputTimeoutRatio: 0.8,
  minMs: 180_000,
  maxMs: 600_000,
} as const;

const CLI_RESUME_WATCHDOG_DEFAULTS = {
  noOutputTimeoutRatio: 0.3,
  minMs: 60_000,
  maxMs: 180_000,
} as const;

import type { AntigravityPluginConfig } from "./config.js";
import { ANTIGRAVITY_MODEL_ALIASES } from "./model-aliases.js";

export const ANTIGRAVITY_HARNESS_ID = "antigravity";
export const ANTIGRAVITY_CLI_BACKEND_ID = "antigravity-cli";
export const ANTIGRAVITY_CLI_DEFAULT_MODEL_REF = "antigravity-cli/gemini-3.8-flash-high";

function buildCommonArgs(config: AntigravityPluginConfig): string[] {
  const args: string[] = [];

  if (config.agent) {
    args.push("--agent", config.agent);
  }
  if (config.mode) {
    args.push("--mode", config.mode);
  }
  for (const directory of config.addDirs) {
    args.push("--add-dir", directory);
  }
  if (config.logFile) {
    args.push("--log-file", config.logFile);
  }
  if (config.sandbox) {
    args.push("--sandbox");
  }
  if (config.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  args.push(
    "--print-timeout",
    config.printTimeout,
    "--output-format",
    "json",
    "--print",
    "{prompt}",
  );
  return args;
}

export function buildFreshArgs(config: AntigravityPluginConfig): string[] {
  const args: string[] = [];
  if (config.project) {
    args.push("--project", config.project);
  } else if (config.newProject) {
    args.push("--new-project");
  }
  args.push(...buildCommonArgs(config));
  return args;
}

export function buildResumeArgs(config: AntigravityPluginConfig): string[] {
  return ["--conversation", "{sessionId}", ...buildCommonArgs(config)];
}

/**
 * Legacy/direct compatibility backend for the existing `agy` executable.
 * Normal `antigravity/*` execution is owned by AgentHarnessV2; this backend
 * intentionally lives under the disjoint `antigravity-cli/*` namespace.
 */
export function buildAntigravityCliBackend(
  config: AntigravityPluginConfig,
): CliBackendPlugin {
  return {
    id: ANTIGRAVITY_CLI_BACKEND_ID,
    liveTest: {
      defaultModelRef: ANTIGRAVITY_CLI_DEFAULT_MODEL_REF,
      defaultImageProbe: false,
      defaultMcpProbe: false,
    },
    config: {
      command: config.command,
      args: buildFreshArgs(config),
      resumeArgs: buildResumeArgs(config),
      output: "json",
      resumeOutput: "json",
      input: "arg",
      modelArg: "--model",
      modelAliases: { ...ANTIGRAVITY_MODEL_ALIASES },
      sessionMode: "existing",
      sessionIdFields: ["conversation_id", "conversationId"],
      systemPromptWhen: "first",
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      serialize: true,
    },
  };
}
