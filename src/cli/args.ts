import type { AntigravityPluginConfig } from "../config.js";

export const MAX_AGY_PROMPT_BYTES = 1024 * 1024;

/** The sole allowed input frame. Closing stdin after this frame ends one turn. */
export function encodeAgyPromptInput(prompt: string): string {
  // Bound before encoding too: JSON encoding cannot reduce the UTF-8 size.
  if (Buffer.byteLength(prompt, "utf8") > MAX_AGY_PROMPT_BYTES) {
    throw new Error(`AGY encoded prompt exceeds ${MAX_AGY_PROMPT_BYTES} bytes`);
  }
  const encoded = `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`;
  if (Buffer.byteLength(encoded, "utf8") > MAX_AGY_PROMPT_BYTES) {
    throw new Error(`AGY encoded prompt exceeds ${MAX_AGY_PROMPT_BYTES} bytes`);
  }
  return encoded;
}

export function resolveAgyModelId(modelId: string): string {
  if (!modelId.trim()) {
    throw new Error("ANTIGRAVITY model id must not be empty");
  }
  if (modelId.includes("\0")) throw new Error("ANTIGRAVITY model id contains NUL");
  return modelId;
}

function buildHarnessCommonArgs(params: {
  config: AntigravityPluginConfig;
  modelId: string;
  prompt: string;
}): string[] {
  const { config } = params;
  // Validation happens before launch; the payload is deliberately never argv.
  encodeAgyPromptInput(params.prompt);
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
    "--input-format",
    "stream-json",
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
  const conversationId = params.conversationId;
  if (!conversationId.trim()) {
    throw new Error("AGY conversation id must not be empty");
  }
  if (conversationId.includes("\0")) throw new Error("AGY conversation id contains NUL");
  return ["--conversation", conversationId, ...buildHarnessCommonArgs(params)];
}
