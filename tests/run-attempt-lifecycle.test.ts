import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGY_SOURCE_CLI_PRELUDE } from "./fixtures/agy-source-cli.ts";
import { createSourceSessionRuntime, sourceHostContracts, sourceSessionMutation } from "./fixtures/host-contracts.ts";

import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";

import { resolveAntigravityPluginConfig } from "../src/config.ts";
import { runAntigravityAttempt } from "../src/harness/run-attempt.ts";
import {
  AntigravitySessionBindings,
  type AntigravitySessionRuntime,
} from "../src/harness/session-bindings.ts";

type MockMode = "success" | "failure" | "hang" | "mismatch";

const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString(
  "base64",
);

const createRuntime = createSourceSessionRuntime;

function fixtureHostContracts() {
  return sourceHostContracts({
    images: {
      evidence: "SIMULATED: fixture CLI opens only direct image paths and creates no detached readers",
      mediaPolicy: { maxImages: 4, maxEncodedBytes: 4_096, maxDecodedBytes: 3_072, maxTotalDecodedBytes: 12_288 },
      supportsModel: (modelId) => modelId === "gemini-3.8-flash-low",
      readersSettled: (evidence) => evidence.invocation === "not_started" || evidence.termination.cleanupComplete,
    },
  });
}

async function createMockAgy(mode: MockMode) {
  const root = await mkdtemp(join(tmpdir(), "antigravity-run-attempt-test-"));
  const command = join(root, "agy-mock");
  const imageLog = join(root, "image-path.txt");
  const argvLog = join(root, "argv.json");
  const script = `#!/usr/bin/env node
${AGY_SOURCE_CLI_PRELUDE}
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args));
const imagePath = prompt.split("\\n").find((line) => line.includes("antigravity-images-"));
if (imagePath) fs.writeFileSync(${JSON.stringify(imageLog)}, imagePath);
const conversationIndex = args.indexOf("--conversation");
const conversationId = conversationIndex >= 0
  ? args[conversationIndex + 1]
  : prompt.includes("session-two") ? "conversation-2" : "conversation-1";
const init = {
  event: "init",
  conversation_id: conversationId,
  init: { cwd: ${JSON.stringify(root)}, tools: [], permission_mode: "request-review", model: "gemini-3.8-flash-low" },
};
process.stdout.write(JSON.stringify(init) + "\\n");
if (${JSON.stringify(mode)} === "hang") {
  setInterval(() => {}, 1000);
} else {
  const status = ${JSON.stringify(mode)} === "failure" ? "ERROR" : "SUCCESS";
  const result = {
    event: "result",
    result: {
      conversation_id: conversationId,
      status,
      response: status === "SUCCESS" ? "done" : "failed",
      error: status === "ERROR" ? "failed" : undefined,
      duration_seconds: 0.01,
      num_turns: 1,
      usage: { input_tokens: 4, output_tokens: 1, thinking_tokens: 1, cache_read_tokens: 0, total_tokens: 5 },
    },
  };
  process.stdout.write(JSON.stringify(result) + "\\n");
  process.exitCode = ${JSON.stringify(mode)} === "failure" ? 1 : ${JSON.stringify(mode)} === "mismatch" ? 2 : 0;
}
`;
  await writeFile(command, script, { mode: 0o700 });
  await chmod(command, 0o700);
  return {
    root,
    command,
    imageLog,
    argvLog,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function createAttempt(params: {
  sessionId: string;
  sessionKey: string;
  prompt: string;
  workspaceDir: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  image?: boolean;
}): AgentHarnessAttemptParamsV2 {
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: "main",
    sessionTarget: { sessionKey: params.sessionKey, agentId: "main", storePath: join(params.workspaceDir, "SIMULATED-session-store.json") },
    modelId: "gemini-3.8-flash-low",
    model: { contextWindow: 200_000 },
    thinkLevel: "low",
    prompt: params.prompt,
    workspaceDir: params.workspaceDir,
    cwd: params.workspaceDir,
    ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    ...(params.image
      ? { images: [{ type: "image", data: pngData, mimeType: "image/png" }] }
      : {}),
    hostCapabilities: {
      assertActive() {},
      preparedEnvironment() { return { credentialScrubEnv: {}, localIdentityEnv: {}, managedLocalIdentity: false }; },
      trajectory: {
        recordEvent() {},
        async flush() {},
      },
    },
  } as unknown as AgentHarnessAttemptParamsV2;
}

async function assertMaterializedImageWasCleaned(imageLog: string) {
  const path = (await readFile(imageLog, "utf8")).trim();
  assert.match(path, /antigravity-images-.+\/image-1\.png$/u);
  await assert.rejects(access(path));
}

async function waitForFile(path: string) {
  for (let index = 0; index < 100; index += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

test("fresh then resume uses the exact persisted AGY conversation and concrete model", async () => {
  const mock = await createMockAgy("success");
  try {
    const sessionKey = "agent:main:child:resume";
    const sessionId = "openclaw-resume";
    const { runtime } = createRuntime([{ sessionKey, sessionId }]);
    const bindings = new AntigravitySessionBindings(runtime, { atomicMutation: sourceSessionMutation });
    const pluginConfig = resolveAntigravityPluginConfig({ command: mock.command });

    await runAntigravityAttempt({
      hostContracts: fixtureHostContracts(),
      attempt: createAttempt({
        sessionId,
        sessionKey,
        prompt: "fresh session-one",
        workspaceDir: mock.root,
      }),
      pluginConfig,
      sessionBindings: bindings,
    });
    assert.equal(bindings.resolve({ agentId: "main", storePath: join(mock.root, "SIMULATED-session-store.json"), openclawSessionId: sessionId, openclawSessionKey: sessionKey })?.conversationId, "conversation-1");
    assert.equal(bindings.resolve({ agentId: "main", storePath: join(mock.root, "SIMULATED-session-store.json"), openclawSessionId: sessionId, openclawSessionKey: sessionKey })?.modelId, "gemini-3.8-flash-low");

    await runAntigravityAttempt({
      hostContracts: fixtureHostContracts(),
      attempt: createAttempt({
        sessionId,
        sessionKey,
        prompt: "resume session-one",
        workspaceDir: mock.root,
      }),
      pluginConfig,
      sessionBindings: bindings,
    });
    const resumeArgs = JSON.parse(await readFile(mock.argvLog, "utf8")) as string[];
    assert.deepEqual(resumeArgs.slice(0, 2), ["--conversation", "conversation-1"]);
    assert.equal(resumeArgs[resumeArgs.indexOf("--model") + 1], "gemini-3.8-flash-low");
  } finally {
    await mock.cleanup();
  }
});

test("two concurrent OpenClaw sessions bind to distinct AGY conversations", async () => {
  const mock = await createMockAgy("success");
  try {
    const first = { sessionKey: "agent:main:child:one", sessionId: "openclaw-one" };
    const second = { sessionKey: "agent:main:child:two", sessionId: "openclaw-two" };
    const { runtime } = createRuntime([first, second]);
    const bindings = new AntigravitySessionBindings(runtime, { atomicMutation: sourceSessionMutation });
    const pluginConfig = resolveAntigravityPluginConfig({ command: mock.command });

    await Promise.all([
      runAntigravityAttempt({
      hostContracts: fixtureHostContracts(),
        attempt: createAttempt({ ...first, prompt: "session-one", workspaceDir: mock.root }),
        pluginConfig,
        sessionBindings: bindings,
      }),
      runAntigravityAttempt({
      hostContracts: fixtureHostContracts(),
        attempt: createAttempt({ ...second, prompt: "session-two", workspaceDir: mock.root }),
        pluginConfig,
        sessionBindings: bindings,
      }),
    ]);

    assert.equal(bindings.resolve({ agentId: "main", storePath: join(mock.root, "SIMULATED-session-store.json"), openclawSessionId: first.sessionId, openclawSessionKey: first.sessionKey })?.conversationId, "conversation-1");
    assert.equal(bindings.resolve({ agentId: "main", storePath: join(mock.root, "SIMULATED-session-store.json"), openclawSessionId: second.sessionId, openclawSessionKey: second.sessionKey })?.conversationId, "conversation-2");
  } finally {
    await mock.cleanup();
  }
});

for (const mode of ["success", "failure", "mismatch"] as const) {
  test(`attempt-scoped image files are cleaned after ${mode}`, async () => {
    const mock = await createMockAgy(mode);
    try {
      const sessionKey = `agent:main:child:${mode}`;
      const sessionId = `openclaw-${mode}`;
      const { runtime } = createRuntime([{ sessionKey, sessionId }]);
      await runAntigravityAttempt({
      hostContracts: fixtureHostContracts(),
        attempt: createAttempt({
          sessionId,
          sessionKey,
          prompt: `inspect image ${mode}`,
          workspaceDir: mock.root,
          image: true,
        }),
        pluginConfig: resolveAntigravityPluginConfig({ command: mock.command }),
        sessionBindings: new AntigravitySessionBindings(runtime, { atomicMutation: sourceSessionMutation }),
      });
      await assertMaterializedImageWasCleaned(mock.imageLog);
    } finally {
      await mock.cleanup();
    }
  });
}

test("attempt-scoped image files are cleaned after timeout", async () => {
  const mock = await createMockAgy("hang");
  try {
    const sessionKey = "agent:main:child:timeout";
    const sessionId = "openclaw-timeout";
    const { runtime } = createRuntime([{ sessionKey, sessionId }]);
    await runAntigravityAttempt({
      hostContracts: fixtureHostContracts(),
      attempt: createAttempt({
        sessionId,
        sessionKey,
        prompt: "inspect image timeout",
        workspaceDir: mock.root,
        timeoutMs: 1_000,
        image: true,
      }),
      pluginConfig: resolveAntigravityPluginConfig({ command: mock.command }),
      sessionBindings: new AntigravitySessionBindings(runtime, { atomicMutation: sourceSessionMutation }),
    });
    await assertMaterializedImageWasCleaned(mock.imageLog);
  } finally {
    await mock.cleanup();
  }
});

test("attempt-scoped image files are cleaned after cancellation", async () => {
  const mock = await createMockAgy("hang");
  try {
    const sessionKey = "agent:main:child:cancel";
    const sessionId = "openclaw-cancel";
    const { runtime } = createRuntime([{ sessionKey, sessionId }]);
    const controller = new AbortController();
    const attempt = runAntigravityAttempt({
      hostContracts: fixtureHostContracts(),
      attempt: createAttempt({
        sessionId,
        sessionKey,
        prompt: "inspect image cancellation",
        workspaceDir: mock.root,
        timeoutMs: 5_000,
        abortSignal: controller.signal,
        image: true,
      }),
      pluginConfig: resolveAntigravityPluginConfig({ command: mock.command }),
      sessionBindings: new AntigravitySessionBindings(runtime, { atomicMutation: sourceSessionMutation }),
    });
    await waitForFile(mock.imageLog);
    controller.abort();
    await attempt;
    await assertMaterializedImageWasCleaned(mock.imageLog);
  } finally {
    await mock.cleanup();
  }
});
