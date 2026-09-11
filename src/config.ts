export type AntigravityMode = "accept-edits" | "plan";

export type AntigravityPluginConfig = {
  command: string;
  printTimeout: string;
  sandbox: boolean;
  dangerouslySkipPermissions: boolean;
  newProject: boolean;
  addDirs: readonly string[];
  mode?: AntigravityMode;
  agent?: string;
  project?: string;
  logFile?: string;
};

const ALLOWED_KEYS = new Set([
  "command",
  "printTimeout",
  "sandbox",
  "dangerouslySkipPermissions",
  "mode",
  "agent",
  "project",
  "newProject",
  "addDirs",
  "logFile",
]);

function asRecord(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("antigravity plugin config must be an object");
  }
  return value as Record<string, unknown>;
}

function optionalString(
  raw: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = raw[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`antigravity config ${key} must be a non-empty string`);
  }
  return value.trim();
}

function booleanValue(
  raw: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = raw[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error(`antigravity config ${key} must be boolean`);
  }
  return value;
}

function stringArray(raw: Record<string, unknown>, key: string): readonly string[] {
  const value = raw[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`antigravity config ${key} must be an array of paths`);
  }
  const normalized = value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`antigravity config ${key}[${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`antigravity config ${key} must not contain duplicates`);
  }
  return Object.freeze(normalized);
}

export function resolveAntigravityPluginConfig(value: unknown): AntigravityPluginConfig {
  const raw = asRecord(value);
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`unknown antigravity config key: ${key}`);
    }
  }

  const command = optionalString(raw, "command") ?? "agy";
  const printTimeout = optionalString(raw, "printTimeout") ?? "30m";
  const mode = optionalString(raw, "mode");
  const agent = optionalString(raw, "agent");
  const project = optionalString(raw, "project");
  const logFile = optionalString(raw, "logFile");

  if (mode !== undefined && mode !== "accept-edits" && mode !== "plan") {
    throw new Error("antigravity config mode must be accept-edits or plan");
  }

  const newProject = booleanValue(raw, "newProject", false);
  if (project && newProject) {
    throw new Error("antigravity config project and newProject are mutually exclusive");
  }

  return Object.freeze({
    command,
    printTimeout,
    sandbox: booleanValue(raw, "sandbox", true),
    dangerouslySkipPermissions: booleanValue(raw, "dangerouslySkipPermissions", false),
    newProject,
    addDirs: stringArray(raw, "addDirs"),
    ...(mode ? { mode } : {}),
    ...(agent ? { agent } : {}),
    ...(project ? { project } : {}),
    ...(logFile ? { logFile } : {}),
  });
}

export const antigravityConfigSchema = {
  parse: resolveAntigravityPluginConfig,
};
