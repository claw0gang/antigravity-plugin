import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { AgentHarnessAttemptParamsV2 } from "../src/host/types.ts";
import { AntigravityNativeAgentCarrierManager } from "../src/harness/native-agent-carrier.ts";
import {
  deriveAgyCarrierTools,
  deriveAgyDeniedCarrierTools,
  normalizeQualifiedSafeDeniedTools,
} from "../src/harness/tool-policy.ts";

const ORCHESTRATOR_DENIES = [
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
] as const;

const LEAF_DENIES = [
  ...ORCHESTRATOR_DENIES,
  "subagents",
  "sessions_list",
  "sessions_history",
  "sessions_search",
  "sessions_spawn",
] as const;

function attempt(denies: readonly string[], extraSystemPrompt = "SYSTEM-BOUNDARY") {
  return {
    pluginHarnessToolPolicySafeDeniedTools: [...denies],
    extraSystemPrompt,
  } as unknown as AgentHarnessAttemptParamsV2;
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("tool-policy mapping mirrors qualified OpenClaw subagent denies into AGY-native capabilities", () => {
  const orchestratorDenies = normalizeQualifiedSafeDeniedTools(ORCHESTRATOR_DENIES);
  assert.deepEqual(deriveAgyDeniedCarrierTools(orchestratorDenies), ["schedule", "send_message"]);
  const orchestratorTools = deriveAgyCarrierTools(orchestratorDenies);
  assert.equal(orchestratorTools.includes("send_message"), false);
  assert.equal(orchestratorTools.includes("schedule"), false);
  assert.equal(orchestratorTools.includes("invoke_subagent"), true);
  assert.equal(orchestratorTools.includes("define_subagent"), true);
  assert.equal(orchestratorTools.includes("manage_subagents"), true);
  assert.equal(orchestratorTools.includes("view_file"), true);
  assert.equal(orchestratorTools.includes("run_command"), true);
  assert.equal(orchestratorTools.includes("list_permissions"), false);
  assert.equal(orchestratorTools.includes("multi_replace_file_content"), false);

  const leafDenies = normalizeQualifiedSafeDeniedTools(LEAF_DENIES);
  assert.deepEqual(deriveAgyDeniedCarrierTools(leafDenies), [
    "define_subagent",
    "invoke_subagent",
    "manage_subagents",
    "schedule",
    "send_message",
  ]);
  const leafTools = deriveAgyCarrierTools(leafDenies);
  assert.equal(leafTools.includes("send_message"), false);
  assert.equal(leafTools.includes("schedule"), false);
  assert.equal(leafTools.includes("invoke_subagent"), false);
  assert.equal(leafTools.includes("define_subagent"), false);
  assert.equal(leafTools.includes("manage_subagents"), false);
  assert.equal(leafTools.includes("view_file"), true);
});

test("tool-policy mapping rejects unqualified or duplicate deny names", () => {
  assert.throws(
    () => normalizeQualifiedSafeDeniedTools(["message", "exec"]),
    /unqualified OpenClaw tool deny/u,
  );
  assert.throws(
    () => normalizeQualifiedSafeDeniedTools(["message", "message"]),
    /duplicate OpenClaw tool denies/u,
  );
});

test("native carrier binds a relative hard-deny hook plugin and cleans only its exact owned bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-carrier-"));
  try {
    const manager = new AntigravityNativeAgentCarrierManager({ HOME: root });
    const lease = manager.acquire(attempt(ORCHESTRATOR_DENIES, "EXACT SYSTEM\nRULE"));
    assert.ok(lease);
    const agentDir = join(root, ".gemini", "config", "agents", lease.agentName);
    const filePath = join(agentDir, "agent.md");
    const pluginDir = join(agentDir, "plugins", "openclaw-policy");
    const manifestPath = join(pluginDir, "plugin.json");
    const hooksPath = join(pluginDir, "hooks.json");
    const scriptPath = join(pluginDir, "deny-tools.mjs");

    assert.equal(existsSync(filePath), true);
    assert.equal(existsSync(manifestPath), true);
    assert.equal(existsSync(hooksPath), true);
    assert.equal(existsSync(scriptPath), true);

    const content = await readFile(filePath, "utf8");
    assert.match(content, /EXACT SYSTEM\nRULE$/u);
    assert.match(content, /  - view_file\n/u);
    assert.match(content, /  - run_command\n/u);
    assert.doesNotMatch(content, /  - send_message\n/u);
    assert.doesNotMatch(content, /  - schedule\n/u);
    assert.doesNotMatch(content, /  - list_permissions\n/u);
    assert.doesNotMatch(content, /  - multi_replace_file_content\n/u);
    assert.match(content, /plugins:\n  - plugins\/openclaw-policy\n/u);

    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    assert.equal(manifest.name, `${lease.agentName}-policy`);
    const hooks = JSON.parse(await readFile(hooksPath, "utf8")) as {
      "openclaw-policy": { PreToolUse: Array<{ matcher: string }> };
    };
    assert.equal(hooks["openclaw-policy"].PreToolUse[0]?.matcher, "^(?:schedule|send_message)$");

    const hookRun = spawnSync(process.execPath, [scriptPath], {
      input: "{}\n",
      encoding: "utf8",
    });
    assert.equal(hookRun.status, 0);
    assert.deepEqual(JSON.parse(hookRun.stdout), {
      decision: "deny",
      reason: "Blocked by OpenClaw delegated tool policy.",
    });

    assert.ok(lease.definitionIdentity.startsWith("agy-agent-bundle-v2:"));
    assert.deepEqual(lease.safeDeniedTools, [...ORCHESTRATOR_DENIES].sort());
    assert.deepEqual(
      lease.adapter.namedAgentCarrier?.preserved.map((entry) => entry.originRef),
      ["extraSystemPrompt"],
    );
    lease.adapter.namedAgentCarrier?.assertCurrent();

    const hooksContent = await readFile(hooksPath, "utf8");
    writeFileSync(hooksPath, `${hooksContent}\nTAMPER`, "utf8");
    assert.throws(
      () => lease.adapter.namedAgentCarrier?.assertCurrent(),
      /carrier changed before launch/u,
    );
    writeFileSync(hooksPath, hooksContent, "utf8");
    lease.adapter.namedAgentCarrier?.assertCurrent();

    lease.release();
    assert.equal(existsSync(filePath), false);
    assert.equal(existsSync(manifestPath), false);
    assert.equal(existsSync(hooksPath), false);
    assert.equal(existsSync(scriptPath), false);
    assert.equal(existsSync(agentDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("leaf carrier hook covers every translated orchestration deny", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-carrier-leaf-"));
  try {
    const manager = new AntigravityNativeAgentCarrierManager({ HOME: root });
    const lease = manager.acquire(attempt(LEAF_DENIES));
    assert.ok(lease);
    const agentDir = join(root, ".gemini", "config", "agents", lease.agentName);
    const content = await readFile(join(agentDir, "agent.md"), "utf8");
    for (const deniedTool of [
      "define_subagent",
      "invoke_subagent",
      "manage_subagents",
      "schedule",
      "send_message",
    ]) {
      assert.doesNotMatch(content, new RegExp(`  - ${deniedTool}\\n`, "u"));
    }
    const hooks = JSON.parse(
      await readFile(join(agentDir, "plugins", "openclaw-policy", "hooks.json"), "utf8"),
    ) as { "openclaw-policy": { PreToolUse: Array<{ matcher: string }> } };
    assert.equal(
      hooks["openclaw-policy"].PreToolUse[0]?.matcher,
      "^(?:define_subagent|invoke_subagent|manage_subagents|schedule|send_message)$",
    );
    lease.release();
    assert.equal(existsSync(agentDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("independent manager instances share filesystem leases and cannot delete an active carrier", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-carrier-manager-"));
  try {
    const firstManager = new AntigravityNativeAgentCarrierManager({ HOME: root });
    const secondManager = new AntigravityNativeAgentCarrierManager({ HOME: root });
    const first = firstManager.acquire(attempt(ORCHESTRATOR_DENIES));
    const second = secondManager.acquire(attempt(ORCHESTRATOR_DENIES));
    assert.ok(first && second);
    assert.equal(first.agentName, second.agentName);
    assert.equal(first.definitionIdentity, second.definitionIdentity);
    const agentDir = join(root, ".gemini", "config", "agents", first.agentName);
    const hooksPath = join(agentDir, "plugins", "openclaw-policy", "hooks.json");

    first.release();
    assert.equal(existsSync(hooksPath), true);
    second.adapter.namedAgentCarrier?.assertCurrent();

    second.release();
    assert.equal(existsSync(agentDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("separate processes sharing GEMINI_HOME cannot delete another process active carrier lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-carrier-process-"));
  const readyPath = join(root, "child-ready");
  const releasePath = join(root, "child-release");
  const moduleUrl = new URL("../src/harness/native-agent-carrier.ts", import.meta.url).href;
  const childScript = String.raw`
    import { existsSync, writeFileSync } from "node:fs";
    import { AntigravityNativeAgentCarrierManager } from ${JSON.stringify(moduleUrl)};
    const [root, readyPath, releasePath] = process.argv.slice(1);
    const denies = ${JSON.stringify(ORCHESTRATOR_DENIES)};
    const manager = new AntigravityNativeAgentCarrierManager({ HOME: root });
    const lease = manager.acquire({ pluginHarnessToolPolicySafeDeniedTools: denies, extraSystemPrompt: "SYSTEM-BOUNDARY" });
    if (!lease) process.exit(20);
    writeFileSync(readyPath, lease.agentName, "utf8");
    const timer = setInterval(() => {
      if (!existsSync(releasePath)) return;
      clearInterval(timer);
      try {
        lease.adapter.namedAgentCarrier?.assertCurrent();
        lease.release();
        process.exit(0);
      } catch (error) {
        console.error(error);
        process.exit(21);
      }
    }, 20);
  `;

  try {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript, root, readyPath, releasePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    await waitForFile(readyPath);
    const agentName = (await readFile(readyPath, "utf8")).trim();
    assert.ok(agentName.startsWith("openclaw-antigravity-"));

    const manager = new AntigravityNativeAgentCarrierManager({ HOME: root });
    const lease = manager.acquire(attempt(ORCHESTRATOR_DENIES));
    assert.ok(lease);
    assert.equal(lease.agentName, agentName);
    const agentDir = join(root, ".gemini", "config", "agents", agentName);
    const hooksPath = join(agentDir, "plugins", "openclaw-policy", "hooks.json");

    lease.release();
    assert.equal(existsSync(hooksPath), true);

    writeFileSync(releasePath, "release", "utf8");
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(exitCode, 0, stderr);
    assert.equal(existsSync(agentDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-existing exact bundle without ANTIGRAVITY ownership marker is never deleted", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-carrier-external-"));
  try {
    const seedManager = new AntigravityNativeAgentCarrierManager({ HOME: root });
    const seed = seedManager.acquire(attempt(ORCHESTRATOR_DENIES));
    assert.ok(seed);
    const agentDir = join(root, ".gemini", "config", "agents", seed.agentName);
    const artifactPaths = [
      join(agentDir, "agent.md"),
      join(agentDir, "plugins", "openclaw-policy", "plugin.json"),
      join(agentDir, "plugins", "openclaw-policy", "hooks.json"),
      join(agentDir, "plugins", "openclaw-policy", "deny-tools.mjs"),
    ];
    const artifacts = await Promise.all(artifactPaths.map(async (path) => ({ path, content: await readFile(path, "utf8") })));
    seed.release();
    assert.equal(existsSync(agentDir), false);

    for (const artifact of artifacts) {
      mkdirSync(dirname(artifact.path), { recursive: true, mode: 0o700 });
      writeFileSync(artifact.path, artifact.content, { encoding: "utf8", mode: 0o600 });
    }

    const manager = new AntigravityNativeAgentCarrierManager({ HOME: root });
    const lease = manager.acquire(attempt(ORCHESTRATOR_DENIES));
    assert.ok(lease);
    lease.adapter.namedAgentCarrier?.assertCurrent();
    lease.release();

    for (const artifact of artifacts) assert.equal(existsSync(artifact.path), true);
    assert.equal(existsSync(join(agentDir, ".openclaw-antigravity-owner.json")), false);
    assert.equal(existsSync(join(agentDir, ".openclaw-antigravity-leases")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("system-only carrier has no policy plugin", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-carrier-system-"));
  try {
    const manager = new AntigravityNativeAgentCarrierManager({ HOME: root });
    const lease = manager.acquire(attempt([], "SYSTEM ONLY"));
    assert.ok(lease);
    const agentDir = join(root, ".gemini", "config", "agents", lease.agentName);
    const content = await readFile(join(agentDir, "agent.md"), "utf8");
    assert.doesNotMatch(content, /plugins:/u);
    assert.equal(existsSync(join(agentDir, "plugins")), false);
    lease.release();
    assert.equal(existsSync(agentDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("distinct system instructions produce distinct content-addressed carriers", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-carrier-id-"));
  try {
    const manager = new AntigravityNativeAgentCarrierManager({ HOME: root });
    const first = manager.acquire(attempt(ORCHESTRATOR_DENIES, "SYSTEM A"));
    const second = manager.acquire(attempt(ORCHESTRATOR_DENIES, "SYSTEM B"));
    assert.ok(first && second);
    assert.notEqual(first.agentName, second.agentName);
    assert.notEqual(first.definitionIdentity, second.definitionIdentity);
    first.release();
    second.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
