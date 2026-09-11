import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export const ANTIGRAVITY_SESSION_BINDING_EXTENSION = "antigravity";

export type AntigravitySessionBinding = {
  schema: "antigravity-native-session-binding/v1";
  harnessId: "antigravity";
  openclawSessionId: string;
  openclawSessionKey?: string;
  conversationId: string;
  modelId?: string;
};

type SessionRuntime = OpenClawPluginApi["runtime"]["agent"]["session"];
export type AntigravitySessionRuntime = Pick<
  SessionRuntime,
  "getSessionEntry" | "listSessionEntries" | "patchSessionEntry"
>;
type RuntimeSessionEntry = NonNullable<ReturnType<AntigravitySessionRuntime["getSessionEntry"]>>;

export type AntigravityOpenClawSession = {
  openclawSessionId: string;
  openclawSessionKey?: string;
  agentId?: string;
  storePath?: string;
};

export type BindFreshAntigravitySessionParams = AntigravityOpenClawSession & {
  conversationId: string;
  modelId?: string;
};

function requireNonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}

function optionalNonBlank(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sameBinding(left: AntigravitySessionBinding, right: AntigravitySessionBinding): boolean {
  return (
    left.schema === right.schema &&
    left.harnessId === right.harnessId &&
    left.openclawSessionId === right.openclawSessionId &&
    left.openclawSessionKey === right.openclawSessionKey &&
    left.conversationId === right.conversationId &&
    left.modelId === right.modelId
  );
}

function parseBinding(entry: RuntimeSessionEntry, expectedSessionId: string): AntigravitySessionBinding | undefined {
  const extensions = entry.pluginExtensions;
  if (extensions === undefined || !(ANTIGRAVITY_SESSION_BINDING_EXTENSION in extensions)) {
    return undefined;
  }
  const value = extensions[ANTIGRAVITY_SESSION_BINDING_EXTENSION];
  const raw = asRecord(value);
  if (!raw) {
    throw new Error(`invalid ANTIGRAVITY native session binding for ${expectedSessionId}`);
  }
  const openclawSessionId = typeof raw.openclawSessionId === "string" ? raw.openclawSessionId : "";
  const conversationId = typeof raw.conversationId === "string" ? raw.conversationId : "";
  const openclawSessionKey =
    typeof raw.openclawSessionKey === "string" ? optionalNonBlank(raw.openclawSessionKey) : undefined;
  const modelId = typeof raw.modelId === "string" ? optionalNonBlank(raw.modelId) : undefined;
  if (
    raw.schema !== "antigravity-native-session-binding/v1" ||
    raw.harnessId !== "antigravity" ||
    openclawSessionId !== expectedSessionId ||
    !conversationId.trim()
  ) {
    throw new Error(`invalid ANTIGRAVITY native session binding for ${expectedSessionId}`);
  }
  return {
    schema: "antigravity-native-session-binding/v1",
    harnessId: "antigravity",
    openclawSessionId,
    ...(openclawSessionKey ? { openclawSessionKey } : {}),
    conversationId: conversationId.trim(),
    ...(modelId ? { modelId } : {}),
  };
}

type ResolvedTarget = {
  sessionKey: string;
  agentId?: string;
  storePath?: string;
  entry: RuntimeSessionEntry;
};

export class AntigravitySessionBindings {
  readonly #runtime: AntigravitySessionRuntime;

  constructor(runtime: AntigravitySessionRuntime) {
    this.#runtime = runtime;
  }

  #resolveTarget(params: AntigravityOpenClawSession, required: boolean): ResolvedTarget | undefined {
    const sessionId = requireNonBlank(params.openclawSessionId, "OpenClaw session id");
    const sessionKey = optionalNonBlank(params.openclawSessionKey);
    const agentId = optionalNonBlank(params.agentId);
    const storePath = optionalNonBlank(params.storePath);
    if (sessionKey) {
      const entry = this.#runtime.getSessionEntry({
        sessionKey,
        ...(agentId ? { agentId } : {}),
        ...(storePath ? { storePath } : {}),
        readConsistency: "latest",
      });
      if (!entry) {
        if (!required) return undefined;
        throw new Error(`OpenClaw session ${sessionId} has no canonical session entry`);
      }
      if (entry.sessionId !== sessionId) {
        throw new Error(`OpenClaw session key ${sessionKey} does not belong to ${sessionId}`);
      }
      return { sessionKey, ...(agentId ? { agentId } : {}), ...(storePath ? { storePath } : {}), entry };
    }

    const matches = this.#runtime
      .listSessionEntries({
        ...(agentId ? { agentId } : {}),
        ...(storePath ? { storePath } : {}),
        readOnly: true,
      })
      .filter(({ entry }) => entry.sessionId === sessionId);
    if (matches.length === 0) {
      if (!required) return undefined;
      throw new Error(`OpenClaw session ${sessionId} has no canonical session entry`);
    }
    if (matches.length !== 1) {
      throw new Error(`OpenClaw session ${sessionId} has ambiguous canonical session entries`);
    }
    return {
      sessionKey: matches[0]!.sessionKey,
      ...(agentId ? { agentId } : {}),
      ...(storePath ? { storePath } : {}),
      entry: matches[0]!.entry,
    };
  }

  resolve(params: AntigravityOpenClawSession): AntigravitySessionBinding | undefined {
    const sessionId = requireNonBlank(params.openclawSessionId, "OpenClaw session id");
    const target = this.#resolveTarget(params, false);
    return target ? parseBinding(target.entry, sessionId) : undefined;
  }

  async bindFresh(params: BindFreshAntigravitySessionParams): Promise<AntigravitySessionBinding> {
    const sessionId = requireNonBlank(params.openclawSessionId, "OpenClaw session id");
    const conversationId = requireNonBlank(params.conversationId, "AGY conversation id");
    const sessionKey = optionalNonBlank(params.openclawSessionKey);
    const modelId = optionalNonBlank(params.modelId);
    const binding: AntigravitySessionBinding = {
      schema: "antigravity-native-session-binding/v1",
      harnessId: "antigravity",
      openclawSessionId: sessionId,
      ...(sessionKey ? { openclawSessionKey: sessionKey } : {}),
      conversationId,
      ...(modelId ? { modelId } : {}),
    };
    const target = this.#resolveTarget(params, true)!;
    const persisted = await this.#runtime.patchSessionEntry({
      sessionKey: target.sessionKey,
      ...(target.agentId ? { agentId: target.agentId } : {}),
      ...(target.storePath ? { storePath: target.storePath } : {}),
      readConsistency: "latest",
      preserveActivity: true,
      update: (entry) => {
        if (entry.sessionId !== sessionId) {
          throw new Error(`OpenClaw session ${sessionId} changed identity while binding AGY conversation`);
        }
        const existing = parseBinding(entry, sessionId);
        if (existing) {
          if (sameBinding(existing, binding)) return null;
          throw new Error(`OpenClaw session ${sessionId} is already bound to a different AGY conversation`);
        }
        return {
          pluginExtensions: {
            ...(entry.pluginExtensions ?? {}),
            [ANTIGRAVITY_SESSION_BINDING_EXTENSION]: binding,
          },
        };
      },
    });
    if (!persisted) {
      throw new Error(`failed to persist ANTIGRAVITY native session binding for ${sessionId}`);
    }
    return parseBinding(persisted, sessionId) ?? binding;
  }

  async clear(params: AntigravityOpenClawSession): Promise<boolean> {
    const sessionId = requireNonBlank(params.openclawSessionId, "OpenClaw session id");
    const target = this.#resolveTarget(params, false);
    if (!target || !parseBinding(target.entry, sessionId)) return false;
    let removed = false;
    const persisted = await this.#runtime.patchSessionEntry({
      sessionKey: target.sessionKey,
      ...(target.agentId ? { agentId: target.agentId } : {}),
      ...(target.storePath ? { storePath: target.storePath } : {}),
      readConsistency: "latest",
      preserveActivity: true,
      update: (entry) => {
        if (entry.sessionId !== sessionId) return null;
        if (!parseBinding(entry, sessionId)) return null;
        const extensions = { ...(entry.pluginExtensions ?? {}) };
        delete extensions[ANTIGRAVITY_SESSION_BINDING_EXTENSION];
        removed = true;
        return { pluginExtensions: extensions };
      },
    });
    if (removed && !persisted) {
      throw new Error(`failed to clear ANTIGRAVITY native session binding for ${sessionId}`);
    }
    return removed;
  }
}
