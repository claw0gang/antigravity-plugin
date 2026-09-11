export const ANTIGRAVITY_MODEL_ALIASES = Object.freeze({
  "sonnet-4-6": "claude-sonnet-4-6",
  "opus-4-6": "claude-opus-4-6-thinking",
  "gpt-oss": "gpt-oss-120b-medium",
} as const);

export function normalizeAntigravityModelId(modelId: string): string {
  return (
    ANTIGRAVITY_MODEL_ALIASES[
      modelId as keyof typeof ANTIGRAVITY_MODEL_ALIASES
    ] ?? modelId
  );
}

export const ANTIGRAVITY_CONFIRMED_MODEL_IDS = Object.freeze([
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "gemini-3.7-flash-high",
  "gemini-3.7-flash-medium",
  "gemini-3.7-flash-low",
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-low",
  "gemini-3.5-flash-high",
  "gemini-3.5-flash-medium",
  "gemini-3.5-flash-low",
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
] as const);
