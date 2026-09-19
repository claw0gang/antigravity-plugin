import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createOpenClawAntigravityHostContracts } from "../src/host/runtime-identity.ts";
import { resolveAntigravityPluginConfig } from "../src/config.ts";
import type { InvocationScope } from "../src/cli/invocation-scope.ts";
import type { AntigravitySessionRuntime } from "../src/harness/session-bindings.ts";
import type { AgyInitEvent } from "../src/protocol/agy-stream.ts";

const runtime = {
  getSessionEntry() { return undefined; },
  listSessionEntries() { return []; },
  async patchSessionEntry() { return null; },
} as unknown as AntigravitySessionRuntime;

function scope(cwd: string, project: string, agent?: string): InvocationScope {
  return Object.freeze({
    purpose: "attempt",
    command: process.execPath,
    cwd,
    env: Object.freeze({}),
    deadlineMonoMs: Number.MAX_SAFE_INTEGER,
    assertActive() {},
    owner: Object.freeze({}),
    projectSelection: Object.freeze({ project, newProject: false }),
    addDirs: Object.freeze([]),
    ...(agent ? { nativeAgentSelection: agent } : {}),
  });
}

function initEvent(cwd: string, agent?: string): AgyInitEvent {
  return {
    event: "init",
    conversation_id: "conversation-1",
    init: {
      cwd,
      tools: [],
      permission_mode: "request-review",
      model: "model-1",
      ...(agent ? { agent } : {}),
    },
  };
}

function fixture(options: { legacyResource?: boolean; projectRoot?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "antigravity-runtime-identity-"));
  const home = join(root, "home");
  const gemini = join(home, ".gemini");
  const projectDir = join(gemini, "config", "projects");
  const workspace = join(root, "workspace", "main");
  const projectRoot = options.projectRoot ?? join(root, "workspace");
  const projectId = "project-123";
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(gemini, "google_accounts.json"), JSON.stringify({ active: "account@example.test" }));
  const resource = options.legacyResource
    ? { folderUri: pathToFileURL(projectRoot).href }
    : { gitFolder: { folderUri: pathToFileURL(projectRoot).href } };
  writeFileSync(join(projectDir, `${projectId}.json`), JSON.stringify({
    id: projectId,
    name: "Project",
    projectResources: { resources: [resource] },
  }));
  return {
    root,
    home,
    gemini,
    projectDir,
    workspace,
    projectRoot,
    projectId,
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

test("production runtime identity binds active account, exact project id and workspace", () => {
  const f = fixture();
  try {
    const config = resolveAntigravityPluginConfig({ project: f.projectId });
    const contracts = createOpenClawAntigravityHostContracts({
      pluginConfig: config,
      sessionRuntime: runtime,
      env: { HOME: f.home },
    });
    assert.doesNotThrow(() => contracts.runtime.assertCurrent());
    assert.match(contracts.runtime.identity, /^agy-local-state-v1:[0-9a-f]{64}$/u);
    assert.doesNotThrow(() => contracts.runtime.verifyAcknowledgement({
      event: initEvent(f.workspace),
      scope: scope(f.workspace, f.projectId),
    }));
  } finally {
    f.cleanup();
  }
});

test("legacy direct folderUri project records remain readable", () => {
  const f = fixture({ legacyResource: true });
  try {
    const contracts = createOpenClawAntigravityHostContracts({
      pluginConfig: resolveAntigravityPluginConfig({ project: f.projectId }),
      sessionRuntime: runtime,
      env: { HOME: f.home },
    });
    assert.doesNotThrow(() => contracts.runtime.verifyAcknowledgement({
      event: initEvent(f.workspace),
      scope: scope(f.workspace, f.projectId),
    }));
  } finally {
    f.cleanup();
  }
});

test("missing exact project selection remains fail closed without blocking registration", () => {
  const contracts = createOpenClawAntigravityHostContracts({
    pluginConfig: resolveAntigravityPluginConfig({}),
    sessionRuntime: runtime,
    env: {},
  });
  assert.throws(
    () => contracts.runtime.assertCurrent(),
    /requires config\.project with one exact AGY project id/u,
  );
});

test("active account changes revoke the runtime identity", () => {
  const f = fixture();
  try {
    const contracts = createOpenClawAntigravityHostContracts({
      pluginConfig: resolveAntigravityPluginConfig({ project: f.projectId }),
      sessionRuntime: runtime,
      env: { HOME: f.home },
    });
    writeFileSync(join(f.gemini, "google_accounts.json"), JSON.stringify({ active: "other@example.test" }));
    assert.throws(
      () => contracts.runtime.assertCurrent(),
      /active account or configured project identity changed/u,
    );
  } finally {
    f.cleanup();
  }
});

test("configured project must own the invocation workspace", () => {
  const f = fixture();
  try {
    const outside = join(f.root, "outside");
    mkdirSync(outside, { recursive: true });
    const contracts = createOpenClawAntigravityHostContracts({
      pluginConfig: resolveAntigravityPluginConfig({ project: f.projectId }),
      sessionRuntime: runtime,
      env: { HOME: f.home },
    });
    assert.throws(
      () => contracts.runtime.verifyAcknowledgement({
        event: initEvent(outside),
        scope: scope(outside, f.projectId),
      }),
      /outside the qualified configured project roots/u,
    );
  } finally {
    f.cleanup();
  }
});

test("configured project id and native agent must match the qualified invocation", () => {
  const f = fixture();
  try {
    const contracts = createOpenClawAntigravityHostContracts({
      pluginConfig: resolveAntigravityPluginConfig({ project: f.projectId, agent: "agent-a" }),
      sessionRuntime: runtime,
      env: { HOME: f.home },
    });
    assert.throws(
      () => contracts.runtime.verifyAcknowledgement({
        event: initEvent(f.workspace, "agent-a"),
        scope: scope(f.workspace, "other-project", "agent-a"),
      }),
      /project selection does not match/u,
    );
    assert.throws(
      () => contracts.runtime.verifyAcknowledgement({
        event: initEvent(f.workspace, "agent-b"),
        scope: scope(f.workspace, f.projectId, "agent-a"),
      }),
      /init agent does not acknowledge/u,
    );
    assert.doesNotThrow(
      () => contracts.runtime.verifyAcknowledgement({
        event: initEvent(f.workspace),
        scope: scope(f.workspace, f.projectId, "agent-a"),
      }),
      "AGY may omit optional init.agent while the exact --agent carrier remains invocation-bound",
    );
  } finally {
    f.cleanup();
  }
});

test("project config rejects path-like project ids before identity-file access", () => {
  assert.throws(
    () => resolveAntigravityPluginConfig({ project: "../project" }),
    /project must be an exact AGY project id/u,
  );
});
