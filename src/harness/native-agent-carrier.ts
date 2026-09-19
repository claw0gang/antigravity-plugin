import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";

import type { AgentHarnessAttemptParamsV2 } from "../host/types.js";
import {
  antigravityInstructionDigest,
  type AntigravityContextAdapter,
  type AntigravityInstructionRequirement,
} from "./context-projection.js";
import {
  deriveAgyCarrierTools,
  deriveAgyDeniedCarrierTools,
  normalizeQualifiedSafeDeniedTools,
} from "./tool-policy.js";

const MAX_CARRIER_BYTES = 256 * 1024;
const AGENT_PREFIX = "openclaw-antigravity-";
const POLICY_PLUGIN_DIR = "openclaw-policy";
const POLICY_PLUGIN_RELATIVE_PATH = `plugins/${POLICY_PLUGIN_DIR}`;
const OWNER_FILE = ".openclaw-antigravity-owner.json";
const LEASE_DIR = ".openclaw-antigravity-leases";
const LOCK_ROOT = ".openclaw-antigravity-locks";
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 10;
const OWNERLESS_LOCK_STALE_MS = 30_000;

type CarrierFile = {
  path: string;
  content: string;
};

type CarrierRecord = {
  agentDir: string;
  bundleDigest: string;
  files: CarrierFile[];
  cleanupDirs: string[];
  ownerPath?: string;
  ownerContent?: string;
  leaseDir?: string;
  leasePath?: string;
  leaseContent?: string;
  lockRoot: string;
  agentName: string;
};

export type AntigravityNativeAgentCarrierLease = {
  agentName: string;
  definitionIdentity: string;
  safeDeniedTools: readonly string[];
  adapter: AntigravityContextAdapter;
  release: () => void;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveGeminiHome(env: NodeJS.ProcessEnv): string {
  const explicit = env.GEMINI_HOME?.trim();
  if (explicit) return resolve(explicit);
  const home = env.HOME?.trim();
  if (!home) throw new Error("ANTIGRAVITY native carrier requires HOME or GEMINI_HOME");
  return resolve(home, ".gemini");
}

function assertDirectoryNoSymlink(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
}

function ensureDirectory(path: string, label: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertDirectoryNoSymlink(path, label);
}

function readExactRegularFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const raw = readFileSync(fd);
    if (raw.length > MAX_CARRIER_BYTES) throw new Error("ANTIGRAVITY native carrier file is oversized");
    return raw.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function installExactFile(path: string, content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_CARRIER_BYTES) {
    throw new Error("ANTIGRAVITY native carrier definition exceeds the bounded size limit");
  }
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const data = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function validateExactFiles(files: readonly CarrierFile[]): void {
  for (const file of files) {
    if (readExactRegularFile(file.path) !== file.content) {
      throw new Error("ANTIGRAVITY native policy carrier changed before launch");
    }
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function sleepSync(ms: number): void {
  const view = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(view, 0, 0, ms);
}

function tryReclaimStaleLock(lockDir: string, ownerPath: string): void {
  assertDirectoryNoSymlink(lockDir, "ANTIGRAVITY carrier lock directory");
  let owner: { pid?: unknown } | undefined;
  try {
    owner = JSON.parse(readExactRegularFile(ownerPath)) as { pid?: unknown };
  } catch {
    const ageMs = Date.now() - lstatSync(lockDir).mtimeMs;
    if (ageMs >= OWNERLESS_LOCK_STALE_MS) {
      try { rmdirSync(lockDir); } catch {}
    }
    return;
  }
  if (typeof owner.pid !== "number" || processIsAlive(owner.pid)) return;
  try { unlinkSync(ownerPath); } catch {}
  try { rmdirSync(lockDir); } catch {}
}

function withCarrierLock<T>(lockRoot: string, agentName: string, action: () => T): T {
  ensureDirectory(lockRoot, "ANTIGRAVITY carrier lock root");
  const lockDir = join(lockRoot, `${agentName}.lock`);
  const ownerPath = join(lockDir, "owner.json");
  const token = randomUUID();
  const ownerContent = `${JSON.stringify({ pid: process.pid, token })}\n`;
  const deadline = Date.now() + LOCK_WAIT_MS;

  while (true) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      tryReclaimStaleLock(lockDir, ownerPath);
      if (Date.now() >= deadline) {
        throw new Error("ANTIGRAVITY timed out acquiring native carrier filesystem lock");
      }
      sleepSync(LOCK_POLL_MS);
      continue;
    }

    try {
      installExactFile(ownerPath, ownerContent);
    } catch (error) {
      try { rmdirSync(lockDir); } catch {}
      throw error;
    }
    break;
  }

  try {
    return action();
  } finally {
    try {
      if (readExactRegularFile(ownerPath) === ownerContent) unlinkSync(ownerPath);
    } catch {}
    try { rmdirSync(lockDir); } catch {}
  }
}

function yamlToolList(tools: readonly string[]): string {
  return tools.map((tool) => `  - ${tool}`).join("\n");
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function buildPolicyPluginArtifacts(agentName: string, deniedAgyTools: readonly string[]): Array<{
  relativePath: string;
  content: string;
}> {
  if (deniedAgyTools.length === 0) return [];

  const pluginName = `${agentName}-policy`;
  const matcher = `^(?:${deniedAgyTools.map(regexEscape).join("|")})$`;
  const manifest = `${JSON.stringify({
    $schema: "https://antigravity.google/schemas/v1/plugin.json",
    name: pluginName,
    description: "Ephemeral OpenClaw delegated tool-policy deny carrier managed by ANTIGRAVITY.",
  }, null, 2)}\n`;
  const hooks = `${JSON.stringify({
    "openclaw-policy": {
      PreToolUse: [{
        matcher,
        hooks: [{
          type: "command",
          command: 'node "${extensionPath}/deny-tools.mjs"',
          timeout: 5,
        }],
      }],
    },
  }, null, 2)}\n`;
  const script = [
    'process.stdin.setEncoding("utf8");',
    "process.stdin.resume();",
    'process.stdin.on("end", () => {',
    '  process.stdout.write(`${JSON.stringify({ decision: "deny", reason: "Blocked by OpenClaw delegated tool policy." })}\\n`);',
    "});",
    "",
  ].join("\n");

  return [
    { relativePath: `${POLICY_PLUGIN_RELATIVE_PATH}/plugin.json`, content: manifest },
    { relativePath: `${POLICY_PLUGIN_RELATIVE_PATH}/hooks.json`, content: hooks },
    { relativePath: `${POLICY_PLUGIN_RELATIVE_PATH}/deny-tools.mjs`, content: script },
  ];
}

function buildCarrierDefinition(params: {
  agentName: string;
  safeDeniedTools: readonly string[];
  deniedAgyTools: readonly string[];
  systemPrompt?: string;
}): string {
  const tools = deriveAgyCarrierTools(params.safeDeniedTools);
  const body = params.systemPrompt ?? "";
  return [
    "---",
    `name: ${params.agentName}`,
    "description: Ephemeral OpenClaw policy and system-instruction carrier managed by ANTIGRAVITY.",
    "mainAgent: true",
    "subagent: false",
    "hidden: true",
    "inheritMcp: false",
    "model: inherit",
    "commandExecutionPolicy: sandbox",
    "tools:",
    yamlToolList(tools),
    ...(params.deniedAgyTools.length > 0
      ? ["plugins:", `  - ${POLICY_PLUGIN_RELATIVE_PATH}`]
      : []),
    "---",
    body,
  ].join("\n");
}

function extraSystemRequirement(content: string): AntigravityInstructionRequirement {
  return {
    originRef: "extraSystemPrompt",
    trust: "host",
    scope: "delegated",
    priority: "system",
    required: true,
    contentOrResource: { content },
    requiredTools: [],
  };
}

function parseOwnershipMarker(path: string, bundleDigest: string): string | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: { schema?: unknown; bundleDigest?: unknown; ownerToken?: unknown };
  try {
    parsed = JSON.parse(readExactRegularFile(path)) as typeof parsed;
  } catch {
    throw new Error("ANTIGRAVITY native carrier ownership marker is invalid");
  }
  if (
    parsed.schema !== "antigravity-native-carrier-owner/v1" ||
    parsed.bundleDigest !== bundleDigest ||
    typeof parsed.ownerToken !== "string" ||
    !parsed.ownerToken
  ) {
    throw new Error("ANTIGRAVITY native carrier ownership marker is invalid");
  }
  return `${JSON.stringify(parsed)}\n`;
}

function pruneDeadLeases(leaseDir: string): void {
  for (const name of readdirSync(leaseDir)) {
    const path = join(leaseDir, name);
    let parsed: { pid?: unknown } | undefined;
    try {
      parsed = JSON.parse(readExactRegularFile(path)) as { pid?: unknown };
    } catch {
      continue;
    }
    if (typeof parsed.pid === "number" && !processIsAlive(parsed.pid)) {
      try { unlinkSync(path); } catch {}
    }
  }
}

function cleanupOwnedBundle(record: CarrierRecord): void {
  try {
    if (!record.ownerPath || !record.ownerContent || !record.leaseDir) return;
    if (readExactRegularFile(record.ownerPath) !== record.ownerContent) return;
    validateExactFiles(record.files);
    if (readdirSync(record.leaseDir).length !== 0) return;

    for (const file of [...record.files].reverse()) unlinkSync(file.path);
    unlinkSync(record.ownerPath);
    rmdirSync(record.leaseDir);
    for (const directory of record.cleanupDirs) rmdirSync(directory);
  } catch {
    // Cleanup is best-effort. Never mask the native attempt result; any surviving
    // lease/bundle remains fail-closed and can be reconciled by a later owner.
  }
}

export class AntigravityNativeAgentCarrierManager {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = { ...env };
  }

  acquire(attempt: AgentHarnessAttemptParamsV2): AntigravityNativeAgentCarrierLease | undefined {
    const safeDeniedTools = normalizeQualifiedSafeDeniedTools(
      attempt.pluginHarnessToolPolicySafeDeniedTools,
    );
    const systemPrompt = attempt.extraSystemPrompt?.trim() ? attempt.extraSystemPrompt : undefined;
    if (safeDeniedTools.length === 0 && systemPrompt === undefined) return undefined;

    const deniedAgyTools = deriveAgyDeniedCarrierTools(safeDeniedTools);
    const identitySeed = JSON.stringify({
      schema: "antigravity-openclaw-native-carrier/v2",
      safeDeniedTools,
      deniedAgyTools,
      systemPrompt: systemPrompt ?? null,
      tools: deriveAgyCarrierTools(safeDeniedTools),
      policyPlugin: deniedAgyTools.length > 0 ? POLICY_PLUGIN_RELATIVE_PATH : null,
    });
    const digest = sha256(identitySeed);
    const agentName = `${AGENT_PREFIX}${digest.slice(0, 32)}`;
    const agentContent = buildCarrierDefinition({
      agentName,
      safeDeniedTools,
      deniedAgyTools,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    });
    const artifactSpecs = [
      { relativePath: "agent.md", content: agentContent },
      ...buildPolicyPluginArtifacts(agentName, deniedAgyTools),
    ];
    const bundleDigest = sha256(JSON.stringify(artifactSpecs));
    const definitionIdentity = `agy-agent-bundle-v2:${bundleDigest}`;

    const geminiHome = resolveGeminiHome(this.env);
    ensureDirectory(geminiHome, "AGY customization root");
    const configDir = join(geminiHome, "config");
    ensureDirectory(configDir, "AGY config root");
    const agentsDir = join(configDir, "agents");
    ensureDirectory(agentsDir, "AGY agent root");
    const lockRoot = join(configDir, LOCK_ROOT);
    const agentDir = join(agentsDir, agentName);
    const files = artifactSpecs.map((artifact) => ({
      path: join(agentDir, ...artifact.relativePath.split("/")),
      content: artifact.content,
    }));
    const cleanupDirs: string[] = [];
    if (deniedAgyTools.length > 0) {
      cleanupDirs.push(join(agentDir, "plugins", POLICY_PLUGIN_DIR), join(agentDir, "plugins"));
    }
    cleanupDirs.push(agentDir);

    const record = withCarrierLock(lockRoot, agentName, () => {
      if (existsSync(agentDir)) {
        assertDirectoryNoSymlink(agentDir, "ANTIGRAVITY generated agent directory");
        validateExactFiles(files);
        const ownerPath = join(agentDir, OWNER_FILE);
        const ownerContent = parseOwnershipMarker(ownerPath, bundleDigest);
        if (!ownerContent) {
          return { agentDir, bundleDigest, files, cleanupDirs, lockRoot, agentName } satisfies CarrierRecord;
        }
        const leaseDir = join(agentDir, LEASE_DIR);
        assertDirectoryNoSymlink(leaseDir, "ANTIGRAVITY native carrier lease directory");
        pruneDeadLeases(leaseDir);
        const leaseToken = randomUUID();
        const leasePath = join(leaseDir, `${process.pid}-${leaseToken}.json`);
        const leaseContent = `${JSON.stringify({ pid: process.pid, token: leaseToken, bundleDigest })}\n`;
        installExactFile(leasePath, leaseContent);
        return {
          agentDir,
          bundleDigest,
          files,
          cleanupDirs,
          ownerPath,
          ownerContent,
          leaseDir,
          leasePath,
          leaseContent,
          lockRoot,
          agentName,
        } satisfies CarrierRecord;
      }

      mkdirSync(agentDir, { mode: 0o700 });
      try {
        if (deniedAgyTools.length > 0) {
          const pluginsDir = join(agentDir, "plugins");
          mkdirSync(pluginsDir, { mode: 0o700 });
          mkdirSync(join(pluginsDir, POLICY_PLUGIN_DIR), { mode: 0o700 });
        }
        for (const file of files) installExactFile(file.path, file.content);

        const ownerPath = join(agentDir, OWNER_FILE);
        const ownerContent = `${JSON.stringify({
          schema: "antigravity-native-carrier-owner/v1",
          bundleDigest,
          ownerToken: randomUUID(),
        })}\n`;
        installExactFile(ownerPath, ownerContent);

        const leaseDir = join(agentDir, LEASE_DIR);
        mkdirSync(leaseDir, { mode: 0o700 });
        const leaseToken = randomUUID();
        const leasePath = join(leaseDir, `${process.pid}-${leaseToken}.json`);
        const leaseContent = `${JSON.stringify({ pid: process.pid, token: leaseToken, bundleDigest })}\n`;
        installExactFile(leasePath, leaseContent);

        return {
          agentDir,
          bundleDigest,
          files,
          cleanupDirs,
          ownerPath,
          ownerContent,
          leaseDir,
          leasePath,
          leaseContent,
          lockRoot,
          agentName,
        } satisfies CarrierRecord;
      } catch (error) {
        for (const file of [...files].reverse()) {
          try { if (existsSync(file.path)) unlinkSync(file.path); } catch {}
        }
        try { unlinkSync(join(agentDir, OWNER_FILE)); } catch {}
        try {
          const leaseDir = join(agentDir, LEASE_DIR);
          for (const entry of existsSync(leaseDir) ? readdirSync(leaseDir) : []) {
            try { unlinkSync(join(leaseDir, entry)); } catch {}
          }
          rmdirSync(leaseDir);
        } catch {}
        for (const directory of cleanupDirs) {
          try { rmdirSync(directory); } catch {}
        }
        throw error;
      }
    });

    const assertCurrent = () => {
      validateExactFiles(record.files);
      if (record.ownerPath && record.ownerContent && record.leasePath && record.leaseContent) {
        if (readExactRegularFile(record.ownerPath) !== record.ownerContent) {
          throw new Error("ANTIGRAVITY native policy carrier changed before launch");
        }
        if (readExactRegularFile(record.leasePath) !== record.leaseContent) {
          throw new Error("ANTIGRAVITY native policy carrier lease changed before launch");
        }
      }
    };
    assertCurrent();

    const preserved = systemPrompt === undefined
      ? []
      : [{
          originRef: "extraSystemPrompt",
          requirementDigest: antigravityInstructionDigest(extraSystemRequirement(systemPrompt)),
        }];

    let released = false;
    return {
      agentName,
      definitionIdentity,
      safeDeniedTools,
      adapter: {
        namedAgentCarrier: {
          agentName,
          definitionIdentity,
          supportedPhases: ["fresh", "resume"],
          preserved,
          assertCurrent,
        },
      },
      release: () => {
        if (released) return;
        released = true;
        if (!record.leasePath || !record.leaseContent || !record.leaseDir) return;
        try {
          withCarrierLock(record.lockRoot, record.agentName, () => {
            try {
              if (readExactRegularFile(record.leasePath!) === record.leaseContent) unlinkSync(record.leasePath!);
            } catch {}
            try { pruneDeadLeases(record.leaseDir!); } catch {}
            cleanupOwnedBundle(record);
          });
        } catch {
          // Release is best-effort and must not replace the attempt terminal result.
        }
      },
    };
  }
}
