import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { AntigravityPluginConfig } from "../config.js";
import type { InvocationScope } from "../cli/invocation-scope.js";
import type { AntigravityHostContracts } from "../harness/host-contracts.js";
import type { AntigravitySessionRuntime } from "../harness/session-bindings.js";

const MAX_IDENTITY_FILE_BYTES = 256 * 1024;
const SESSION_MUTATION_EVIDENCE =
  "OpenClaw public session runtime uses snapshot-checked patchSessionEntry with in-transaction assertCommitAllowed";

type RuntimeIdentityOptions = {
  pluginConfig: AntigravityPluginConfig;
  sessionRuntime: Pick<AntigravitySessionRuntime, "getSessionEntry" | "patchSessionEntry">;
  env?: NodeJS.ProcessEnv;
};

type RuntimeIdentitySnapshot = Readonly<{
  accountDigest: string;
  projectId: string;
  projectRoots: readonly string[];
  fingerprint: string;
}>;

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error(`${label} must be a nonempty exact string`);
  }
  return value;
}

function readBoundedJson(path: string, label: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_IDENTITY_FILE_BYTES) {
      throw new Error(`${label} is not a bounded regular file`);
    }
    const raw = readFileSync(fd);
    if (raw.length > MAX_IDENTITY_FILE_BYTES) {
      throw new Error(`${label} exceeds the bounded identity-file limit`);
    }
    return JSON.parse(raw.toString("utf8"));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`${label} is unavailable or invalid`, { cause: error });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function resolveIdentityRoot(env: NodeJS.ProcessEnv): string {
  const explicit = env.GEMINI_HOME?.trim();
  if (explicit) return resolve(explicit);
  const home = env.HOME?.trim();
  if (!home) throw new Error("ANTIGRAVITY strict runtime identity requires HOME or GEMINI_HOME");
  return resolve(home, ".gemini");
}

function normalizeProjectRoot(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (value.startsWith("file:")) {
    let parsed: URL;
    try { parsed = new URL(value); } catch { return undefined; }
    if (parsed.protocol !== "file:") return undefined;
    try { return resolve(fileURLToPath(parsed)); } catch { return undefined; }
  }
  return isAbsolute(value) ? resolve(value) : undefined;
}

function projectRoots(project: Record<string, unknown>): readonly string[] {
  const resourcesContainer = record(project.projectResources, "AGY projectResources");
  const resources = resourcesContainer.resources;
  if (!Array.isArray(resources)) throw new Error("AGY projectResources.resources must be an array");
  const roots = new Set<string>();
  for (const value of resources) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const resource = value as Record<string, unknown>;
    let folderUri = resource.folderUri;
    if (folderUri === undefined && resource.gitFolder !== undefined) {
      const gitFolder = record(resource.gitFolder, "AGY gitFolder resource");
      folderUri = gitFolder.folderUri;
    }
    const root = normalizeProjectRoot(folderUri);
    if (root) roots.add(root);
  }
  if (roots.size === 0) throw new Error("AGY configured project has no supported workspace root");
  return Object.freeze([...roots].sort());
}

function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function loadSnapshot(pluginConfig: AntigravityPluginConfig, env: NodeJS.ProcessEnv): RuntimeIdentitySnapshot {
  const projectId = pluginConfig.project;
  if (!projectId || pluginConfig.newProject) {
    throw new Error(
      "ANTIGRAVITY strict native execution requires config.project with one exact AGY project id; implicit/new project selection cannot establish P03 identity",
    );
  }
  const root = resolveIdentityRoot(env);
  const accountState = record(
    readBoundedJson(join(root, "google_accounts.json"), "AGY active-account state"),
    "AGY active-account state",
  );
  const activeAccount = exactString(accountState.active, "AGY active account selector");
  const projectState = record(
    readBoundedJson(join(root, "config", "projects", `${projectId}.json`), "AGY configured-project state"),
    "AGY configured-project state",
  );
  if (exactString(projectState.id, "AGY configured project id") !== projectId) {
    throw new Error("AGY configured-project state does not match config.project");
  }
  const roots = projectRoots(projectState);
  const accountDigest = hash(activeAccount);
  const fingerprint = hash(JSON.stringify({
    schema: "antigravity-runtime-identity/v1",
    accountDigest,
    projectId,
    roots,
  }));
  return Object.freeze({ accountDigest, projectId, projectRoots: roots, fingerprint });
}

function unavailableContracts(reason: string): AntigravityHostContracts {
  const fail = (): never => { throw new Error(reason); };
  return {
    sessionMutation: { evidence: SESSION_MUTATION_EVIDENCE },
    runtime: {
      evidence: "AGY strict runtime identity unavailable; native execution remains fail-closed",
      identity: `unavailable:${hash(reason)}`,
      assertCurrent: fail,
      verifyAcknowledgement: fail,
    },
  };
}

export function createOpenClawAntigravityHostContracts(
  options: RuntimeIdentityOptions,
): AntigravityHostContracts {
  if (typeof options.sessionRuntime.getSessionEntry !== "function" ||
      typeof options.sessionRuntime.patchSessionEntry !== "function") {
    return unavailableContracts(
      "ANTIGRAVITY native execution requires OpenClaw canonical session get/patch support with commit fencing (P05)",
    );
  }
  const env = { ...(options.env ?? process.env) };
  let initial: RuntimeIdentitySnapshot;
  try {
    initial = loadSnapshot(options.pluginConfig, env);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown identity-state error";
    return unavailableContracts(`ANTIGRAVITY cannot establish strict P03 identity: ${detail}`);
  }

  const assertCurrent = (): void => {
    const current = loadSnapshot(options.pluginConfig, env);
    if (current.fingerprint !== initial.fingerprint) {
      throw new Error("ANTIGRAVITY active account or configured project identity changed; explicit host/session restart required");
    }
  };

  const assertScope = (scope: InvocationScope): void => {
    if (scope.projectSelection?.project !== initial.projectId || scope.projectSelection.newProject === true) {
      throw new Error("ANTIGRAVITY invocation project selection does not match the qualified exact project id");
    }
    if (!initial.projectRoots.some((root) => isInside(root, scope.cwd))) {
      throw new Error("ANTIGRAVITY invocation workspace is outside the qualified configured project roots");
    }
  };

  return {
    sessionMutation: { evidence: SESSION_MUTATION_EVIDENCE },
    runtime: {
      evidence: "AGY non-secret active-account selector plus exact configured project-id record and OpenClaw invocation scope",
      identity: `agy-local-state-v1:${initial.fingerprint}`,
      assertCurrent,
      verifyAcknowledgement({ event, scope, conversationId }) {
        assertCurrent();
        assertScope(scope);
        if (resolve(event.init.cwd) !== resolve(scope.cwd)) {
          throw new Error("AGY init cwd does not acknowledge the qualified invocation workspace");
        }
        // AGY stream-json declares init.agent optional. The exact carrier remains
        // bound by the content-addressed definition, prelaunch assertCurrent,
        // invocation scope and explicit --agent argv. An emitted agent is still
        // authoritative and must match; omission cannot be treated as a mismatch.
        if (scope.nativeAgentSelection !== undefined &&
            event.init.agent !== undefined &&
            event.init.agent !== scope.nativeAgentSelection) {
          throw new Error("AGY init agent does not acknowledge the qualified native-agent selection");
        }
        if (conversationId !== undefined && event.conversation_id !== conversationId) {
          throw new Error("AGY init conversation does not acknowledge the qualified resumed conversation");
        }
      },
    },
  };
}
