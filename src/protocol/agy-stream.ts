export type AgyUsage = {
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
};

export type AgyToolInfo = {
  name: string;
  parameters?: unknown;
  output?: unknown;
  error?: { type?: string; message?: string };
};

export type AgySubagentInfo = {
  subagents?: Array<{
    type_name?: string;
    role?: string;
    conversation_id?: string;
    log_uri?: string;
    workspace_uris?: string[];
  }>;
};

export type AgyDeniedAction = {
  action: string;
  display_name: string;
};

export type AgyInitEvent = {
  event: "init";
  conversation_id: string;
  init: {
    cwd: string;
    tools: string[];
    permission_mode: string;
    model?: string;
    agent?: string;
    json_schema?: unknown;
  };
};

export type AgyStepUpdate = {
  conversation_id: string;
  step_index: number;
  state: "ACTIVE" | "DONE" | "ERROR";
  step_type: string;
  tool_name?: string;
  text_delta?: string;
  duration_seconds?: number;
  usage?: AgyUsage;
  tool_info?: AgyToolInfo;
  subagent_info?: AgySubagentInfo;
};

export type AgyStepUpdateEvent = {
  event: "step_update";
  step_update: AgyStepUpdate;
};

export type AgyResultStatus =
  | "SUCCESS"
  | "ERROR"
  | "CANCELED"
  | "INTERRUPTED"
  | "INVALID"
  | "WAITING"
  | "RUNNING";

export type AgyTerminalResult = {
  conversation_id: string;
  status: AgyResultStatus;
  response: string;
  error?: string;
  duration_seconds: number;
  num_turns: number;
  structured_output?: unknown;
  json_schema?: unknown;
  denied_actions?: AgyDeniedAction[];
  usage: AgyUsage;
};

export type AgyResultEvent = {
  event: "result";
  result: AgyTerminalResult;
};

export type AgyStreamEvent = AgyInitEvent | AgyStepUpdateEvent | AgyResultEvent;

export type AgyStreamSnapshot = {
  conversationId: string;
  init: AgyInitEvent["init"];
  assistantText: string;
  stepUpdates: AgyStepUpdate[];
  toolSteps: AgyStepUpdate[];
  result: AgyTerminalResult;
};

export type AgyStreamProtocolErrorCode =
  | "malformed_json"
  | "malformed_event"
  | "event_before_init"
  | "duplicate_init"
  | "duplicate_terminal"
  | "event_after_terminal"
  | "conversation_mismatch"
  | "nonterminal_eof"
  | "empty_success";

export class AgyStreamProtocolError extends Error {
  readonly code: AgyStreamProtocolErrorCode;

  constructor(code: AgyStreamProtocolErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgyStreamProtocolError";
    this.code = code;
  }
}

const RESULT_STATUSES = new Set<AgyResultStatus>([
  "SUCCESS",
  "ERROR",
  "CANCELED",
  "INTERRUPTED",
  "INVALID",
  "WAITING",
  "RUNNING",
]);

function malformed(message: string): never {
  throw new AgyStreamProtocolError("malformed_event", message);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return malformed(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    return malformed(`${label}.${key} must be a string`);
  }
  return value;
}

function nonEmptyString(record: Record<string, unknown>, key: string, label: string): string {
  const value = requiredString(record, key, label);
  if (!value.trim()) {
    return malformed(`${label}.${key} must not be empty`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, label: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return malformed(`${label}.${key} must be a string when present`);
  }
  return value;
}

function requiredFiniteNumber(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return malformed(`${label}.${key} must be a finite number`);
  }
  return value;
}

function optionalFiniteNumber(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return malformed(`${label}.${key} must be a finite number when present`);
  }
  return value;
}

function parseUsage(value: unknown, label: string): AgyUsage {
  const record = asRecord(value, label);
  const usage: AgyUsage = {
    input_tokens: requiredFiniteNumber(record, "input_tokens", label),
    output_tokens: requiredFiniteNumber(record, "output_tokens", label),
    thinking_tokens: requiredFiniteNumber(record, "thinking_tokens", label),
    cache_read_tokens: requiredFiniteNumber(record, "cache_read_tokens", label),
    total_tokens: requiredFiniteNumber(record, "total_tokens", label),
  };
  for (const [name, count] of Object.entries(usage)) {
    if (!Number.isInteger(count) || count < 0) {
      return malformed(`${label}.${name} must be a non-negative integer`);
    }
  }
  return usage;
}

function parseToolInfo(value: unknown): AgyToolInfo {
  const record = asRecord(value, "step_update.tool_info");
  const errorValue = record.error;
  let error: AgyToolInfo["error"];
  if (errorValue !== undefined) {
    const errorRecord = asRecord(errorValue, "step_update.tool_info.error");
    const type = optionalString(errorRecord, "type", "step_update.tool_info.error");
    const message = optionalString(errorRecord, "message", "step_update.tool_info.error");
    error = {
      ...(type !== undefined ? { type } : {}),
      ...(message !== undefined ? { message } : {}),
    };
  }
  return {
    name: nonEmptyString(record, "name", "step_update.tool_info"),
    ...(record.parameters !== undefined ? { parameters: record.parameters } : {}),
    ...(record.output !== undefined ? { output: record.output } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

function parseSubagentInfo(value: unknown): AgySubagentInfo {
  const record = asRecord(value, "step_update.subagent_info");
  const raw = record.subagents;
  if (raw === undefined) {
    return {};
  }
  if (!Array.isArray(raw)) {
    return malformed("step_update.subagent_info.subagents must be an array");
  }
  return {
    subagents: raw.map((entry, index) => {
      const item = asRecord(entry, `step_update.subagent_info.subagents[${index}]`);
      const workspaceUris = item.workspace_uris;
      if (
        workspaceUris !== undefined &&
        (!Array.isArray(workspaceUris) || workspaceUris.some((uri) => typeof uri !== "string"))
      ) {
        return malformed(
          `step_update.subagent_info.subagents[${index}].workspace_uris must be a string array`,
        );
      }
      const typeName = optionalString(
        item,
        "type_name",
        `step_update.subagent_info.subagents[${index}]`,
      );
      const role = optionalString(item, "role", `step_update.subagent_info.subagents[${index}]`);
      const conversationId = optionalString(
        item,
        "conversation_id",
        `step_update.subagent_info.subagents[${index}]`,
      );
      const logUri = optionalString(
        item,
        "log_uri",
        `step_update.subagent_info.subagents[${index}]`,
      );
      return {
        ...(typeName !== undefined ? { type_name: typeName } : {}),
        ...(role !== undefined ? { role } : {}),
        ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
        ...(logUri !== undefined ? { log_uri: logUri } : {}),
        ...(workspaceUris !== undefined ? { workspace_uris: [...workspaceUris] as string[] } : {}),
      };
    }),
  };
}

function parseDeniedActions(value: unknown): AgyDeniedAction[] {
  if (!Array.isArray(value)) {
    return malformed("result.denied_actions must be an array");
  }
  return value.map((entry, index) => {
    const item = asRecord(entry, `result.denied_actions[${index}]`);
    return {
      action: nonEmptyString(item, "action", `result.denied_actions[${index}]`),
      display_name: nonEmptyString(item, "display_name", `result.denied_actions[${index}]`),
    };
  });
}

function parseInit(root: Record<string, unknown>): AgyInitEvent {
  const init = asRecord(root.init, "init");
  const tools = init.tools;
  if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string")) {
    return malformed("init.tools must be a string array");
  }
  const model = optionalString(init, "model", "init");
  const agent = optionalString(init, "agent", "init");
  return {
    event: "init",
    conversation_id: nonEmptyString(root, "conversation_id", "event"),
    init: {
      cwd: nonEmptyString(init, "cwd", "init"),
      tools: [...tools] as string[],
      permission_mode: nonEmptyString(init, "permission_mode", "init"),
      ...(model !== undefined ? { model } : {}),
      ...(agent !== undefined ? { agent } : {}),
      ...(init.json_schema !== undefined ? { json_schema: init.json_schema } : {}),
    },
  };
}

function parseStepUpdate(root: Record<string, unknown>): AgyStepUpdateEvent {
  const step = asRecord(root.step_update, "step_update");
  const state = nonEmptyString(step, "state", "step_update");
  if (state !== "ACTIVE" && state !== "DONE" && state !== "ERROR") {
    return malformed("step_update.state must be ACTIVE, DONE or ERROR");
  }
  const stepIndex = requiredFiniteNumber(step, "step_index", "step_update");
  if (!Number.isInteger(stepIndex) || stepIndex < 0) {
    return malformed("step_update.step_index must be a non-negative integer");
  }
  const toolName = optionalString(step, "tool_name", "step_update");
  const textDelta = optionalString(step, "text_delta", "step_update");
  const durationSeconds = optionalFiniteNumber(step, "duration_seconds", "step_update");
  return {
    event: "step_update",
    step_update: {
      conversation_id: nonEmptyString(step, "conversation_id", "step_update"),
      step_index: stepIndex,
      state,
      step_type: nonEmptyString(step, "step_type", "step_update"),
      ...(toolName !== undefined ? { tool_name: toolName } : {}),
      ...(textDelta !== undefined ? { text_delta: textDelta } : {}),
      ...(durationSeconds !== undefined ? { duration_seconds: durationSeconds } : {}),
      ...(step.usage !== undefined ? { usage: parseUsage(step.usage, "step_update.usage") } : {}),
      ...(step.tool_info !== undefined ? { tool_info: parseToolInfo(step.tool_info) } : {}),
      ...(step.subagent_info !== undefined
        ? { subagent_info: parseSubagentInfo(step.subagent_info) }
        : {}),
    },
  };
}

function parseResult(root: Record<string, unknown>): AgyResultEvent {
  const result = asRecord(root.result, "result");
  const status = nonEmptyString(result, "status", "result");
  if (!RESULT_STATUSES.has(status as AgyResultStatus)) {
    return malformed(`result.status is unsupported: ${status}`);
  }
  const numTurns = requiredFiniteNumber(result, "num_turns", "result");
  if (!Number.isInteger(numTurns) || numTurns < 0) {
    return malformed("result.num_turns must be a non-negative integer");
  }
  const error = optionalString(result, "error", "result");
  return {
    event: "result",
    result: {
      conversation_id: nonEmptyString(result, "conversation_id", "result"),
      status: status as AgyResultStatus,
      response: requiredString(result, "response", "result"),
      ...(error !== undefined ? { error } : {}),
      duration_seconds: requiredFiniteNumber(result, "duration_seconds", "result"),
      num_turns: numTurns,
      ...(result.structured_output !== undefined
        ? { structured_output: result.structured_output }
        : {}),
      ...(result.json_schema !== undefined ? { json_schema: result.json_schema } : {}),
      ...(result.denied_actions !== undefined
        ? { denied_actions: parseDeniedActions(result.denied_actions) }
        : {}),
      usage: parseUsage(result.usage, "result.usage"),
    },
  };
}

export function parseAgyStreamLine(line: string): AgyStreamEvent {
  const trimmed = line.trim();
  if (!trimmed) {
    throw new AgyStreamProtocolError("malformed_json", "AGY stream line must not be blank");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new AgyStreamProtocolError("malformed_json", "AGY stream line is not valid JSON", {
      cause: error,
    });
  }
  const root = asRecord(parsed, "event");
  const event = nonEmptyString(root, "event", "event");
  switch (event) {
    case "init":
      return parseInit(root);
    case "step_update":
      return parseStepUpdate(root);
    case "result":
      return parseResult(root);
    default:
      return malformed(`unsupported AGY stream event: ${event}`);
  }
}

export class AgyStreamAccumulator {
  #conversationId: string | undefined;
  #init: AgyInitEvent["init"] | undefined;
  #result: AgyTerminalResult | undefined;
  #assistantTextParts: string[] = [];
  #stepUpdates: AgyStepUpdate[] = [];
  #toolSteps: AgyStepUpdate[] = [];

  consumeLine(line: string): AgyStreamEvent {
    const event = parseAgyStreamLine(line);
    this.consume(event);
    return event;
  }

  consume(event: AgyStreamEvent): void {
    if (this.#result) {
      throw new AgyStreamProtocolError(
        event.event === "result" ? "duplicate_terminal" : "event_after_terminal",
        event.event === "result"
          ? "AGY emitted more than one terminal result"
          : `AGY emitted ${event.event} after terminal result`,
      );
    }

    if (event.event === "init") {
      if (this.#init) {
        throw new AgyStreamProtocolError("duplicate_init", "AGY emitted more than one init event");
      }
      this.#conversationId = event.conversation_id;
      this.#init = event.init;
      return;
    }

    if (!this.#init || !this.#conversationId) {
      throw new AgyStreamProtocolError(
        "event_before_init",
        `AGY emitted ${event.event} before init`,
      );
    }

    const eventConversationId =
      event.event === "step_update"
        ? event.step_update.conversation_id
        : event.result.conversation_id;
    if (eventConversationId !== this.#conversationId) {
      throw new AgyStreamProtocolError(
        "conversation_mismatch",
        `AGY conversation id changed from ${this.#conversationId} to ${eventConversationId}`,
      );
    }

    if (event.event === "step_update") {
      const update = event.step_update;
      this.#stepUpdates.push(update);
      if (update.step_type === "agent_response" && update.text_delta !== undefined) {
        // Deltas are ordered transport fragments. Never content-deduplicate them:
        // repeated text can be intentional and the terminal response remains authoritative.
        this.#assistantTextParts.push(update.text_delta);
      }
      if (update.step_type === "tool") {
        this.#toolSteps.push(update);
      }
      return;
    }

    this.#result = event.result;
  }

  finalize(): AgyStreamSnapshot {
    if (!this.#init || !this.#conversationId || !this.#result) {
      throw new AgyStreamProtocolError(
        "nonterminal_eof",
        "AGY stream ended before init and exactly one terminal result were observed",
      );
    }
    if (
      this.#result.status === "SUCCESS" &&
      this.#result.response.trim().length === 0 &&
      this.#result.structured_output === undefined &&
      (this.#result.denied_actions?.length ?? 0) === 0
    ) {
      throw new AgyStreamProtocolError(
        "empty_success",
        "AGY reported SUCCESS with an empty response, no structured output, and no denial metadata",
      );
    }
    return {
      conversationId: this.#conversationId,
      init: this.#init,
      assistantText: this.#assistantTextParts.join(""),
      stepUpdates: [...this.#stepUpdates],
      toolSteps: [...this.#toolSteps],
      result: this.#result,
    };
  }
}
