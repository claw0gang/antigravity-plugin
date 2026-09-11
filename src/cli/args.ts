import type { AntigravityPluginConfig } from "../config.js";
import { ANTIGRAVITY_MODEL_ALIASES } from "../model-aliases.js";

export function resolveAgyModelId(modelId: string): string {
  const normalized = modelId.trim();
  if (!normalized) {
    throw new Error("ANTIGRAVITY model id must not be empty");
  }
  return ANTIGRAVITY_MODEL_ALIASES[normalized as keyof typeof ANTIGRAVITY_MODEL_ALIASES] ?? normalized;
}

function buildHarnessCommonArgs(params: {
  config: AntigravityPluginConfig;
  modelId: string;
  prompt: string;
}): string[] {
  const { config } = params;
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
    "--model",
    resolveAgyModelId(params.modelId),
    "--print-timeout",
    config.printTimeout,
    "--output-format",
    "stream-json",
    "--print",
    params.prompt,
  );
  return args;
}

export function buildAgyHarnessFreshArgs(params: {
  config: AntigravityPluginConfig;
  modelId: string;
  prompt: string;
}): string[] {
  const args: string[] = [];
  if (params.config.project) {
    args.push("--project", params.config.project);
  } else if (params.config.newProject) {
    args.push("--new-project");
  }
  args.push(...buildHarnessCommonArgs(params));
  return args;
}

export function buildAgyHarnessResumeArgs(params: {
  config: AntigravityPluginConfig;
  modelId: string;
  prompt: string;
  conversationId: string;
}): string[] {
  const conversationId = params.conversationId.trim();
  if (!conversationId) {
    throw new Error("AGY conversation id must not be empty");
  }
  return ["--conversation", conversationId, ...buildHarnessCommonArgs(params)];
}
