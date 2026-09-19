export const ANTIGRAVITY_OPENCLAW_SAFE_DENY_TOOLS = Object.freeze([
  "gateway",
  "agents_list",
  "openclaw",
  "session_status",
  "progress_card",
  "automations",
  "message",
  "sessions_send",
  "conversations_list",
  "conversations_send",
  "conversations_turn",
  "subagents",
  "sessions_list",
  "sessions_history",
  "sessions_search",
  "sessions_spawn",
] as const);

const SAFE_DENY_SET = new Set<string>(ANTIGRAVITY_OPENCLAW_SAFE_DENY_TOOLS);

/**
 * AGY-native custom-agent tools qualified against the live 1.2.3 runtime.
 * Deliberately excludes deprecated/no-op multi_replace_file_content and the
 * removed list_permissions registry entry; unknown future tools are never
 * invented into an exact policy carrier.
 */
export const ANTIGRAVITY_AGY_CARRIER_TOOLS = Object.freeze([
  "view_file",
  "write_to_file",
  "replace_file_content",
  "list_dir",
  "find_by_name",
  "grep_search",
  "search_web",
  "read_url_content",
  "run_command",
  "manage_task",
  "ask_question",
  "generate_image",
  "invoke_subagent",
  "define_subagent",
  "send_message",
  "manage_subagents",
  "schedule",
] as const);

export function normalizeQualifiedSafeDeniedTools(value: readonly string[] | undefined): string[] {
  if (!value?.length) return [];
  const normalized = value.map((name) => name.trim());
  if (normalized.some((name) => !name || !SAFE_DENY_SET.has(name))) {
    throw new Error("ANTIGRAVITY received an unqualified OpenClaw tool deny");
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("ANTIGRAVITY received duplicate OpenClaw tool denies");
  }
  return normalized.sort();
}

/**
 * Translate only qualified OpenClaw deny semantics that have AGY-native
 * equivalents. OpenClaw-only control-plane tools require no AGY denial.
 */
export function deriveAgyDeniedCarrierTools(safeDeniedTools: readonly string[]): string[] {
  const denied = new Set(safeDeniedTools);
  const blockedAgy = new Set<string>();

  if (
    denied.has("message") ||
    denied.has("sessions_send") ||
    denied.has("conversations_send") ||
    denied.has("conversations_turn")
  ) {
    blockedAgy.add("send_message");
  }
  if (denied.has("automations")) blockedAgy.add("schedule");
  if (denied.has("sessions_spawn")) {
    blockedAgy.add("invoke_subagent");
    blockedAgy.add("define_subagent");
  }
  if (denied.has("subagents")) blockedAgy.add("manage_subagents");

  return [...blockedAgy].sort();
}

export function deriveAgyCarrierTools(safeDeniedTools: readonly string[]): string[] {
  const blockedAgy = new Set(deriveAgyDeniedCarrierTools(safeDeniedTools));
  return ANTIGRAVITY_AGY_CARRIER_TOOLS.filter((tool) => !blockedAgy.has(tool));
}
