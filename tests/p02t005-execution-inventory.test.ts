import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyInventoryService } from "../src/inventory.ts";
import { resolveAntigravityPluginConfig } from "../src/config.ts";
import { runAntigravityAttempt } from "../src/harness/run-attempt.ts";
import { AntigravitySessionBindings } from "../src/harness/session-bindings.ts";
import { AGY_SOURCE_CLI_PRELUDE } from "./fixtures/agy-source-cli.ts";
import { createSourceSessionRuntime, sourceHostContracts, sourceSessionMutation } from "./fixtures/host-contracts.ts";

// A real child process with synthetic inventory/protocol. No AGY binary,
// credentials, model call or installed OpenClaw behavior is exercised here.
test("unseen opaque ID executes exactly, then withdrawal/empty/auth/malformed inventory cannot reuse readiness", async () => {
  const root = await mkdtemp(join(tmpdir(), "agy-inventory-execution-"));
  const inventory = new AgyInventoryService();
  try {
    const command = join(root, "agy-fixture");
    const inventoryPath = join(root, "inventory.json");
    const callsPath = join(root, "calls.jsonl");
    const modelId = "Vendor/Future:2027@preview-HIGH";
    await writeFile(command, `#!${process.execPath}
const fixtureFs = require('node:fs');
const fixtureArgs = process.argv.slice(2);
const fixtureModelsIndex = fixtureArgs.indexOf('models');
if (fixtureModelsIndex >= 0) {
  const outputFormatIndex = fixtureArgs.indexOf('--output-format');
  if (outputFormatIndex < 0 || outputFormatIndex >= fixtureModelsIndex || fixtureArgs[outputFormatIndex + 1] !== 'json') {
    throw new Error('SIMULATED inventory fixture requires global JSON output selection before models');
  }
  const value = fixtureFs.readFileSync(${JSON.stringify(inventoryPath)}, 'utf8');
  fixtureFs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({discovery:true})+'\\n');
  if(value === 'AUTH') { process.stderr.write('SIMULATED auth rejection'); process.exit(1); }
  process.stdout.write(value); process.exit(0);
}
${AGY_SOURCE_CLI_PRELUDE}
const model = args[args.indexOf('--model') + 1];
const conversation = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : 'inventory-conversation';
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({args, model, prompt})+'\\n');
process.stdout.write(JSON.stringify({event:'init',conversation_id:conversation,init:{cwd:process.cwd(),tools:[],permission_mode:'request-review',model}})+'\\n');
process.stdout.write(JSON.stringify({event:'result',result:{conversation_id:conversation,status:'SUCCESS',response:'done',duration_seconds:0.01,num_turns:1}})+'\\n');
`, { mode: 0o700 });
    const sessionKey = "agent:main:inventory";
    const sessionId = "inventory-session";
    const { runtime } = createSourceSessionRuntime([{ sessionKey, sessionId }]);
    const sessionBindings = new AntigravitySessionBindings(runtime, { atomicMutation: sourceSessionMutation });
    const attempt = {
      sessionId, sessionKey, agentId: "main", modelId,
      sessionTarget: { sessionKey, agentId: "main", storePath: join(root, "SIMULATED-store.json") },
      model: { contextWindow: 200_000 }, thinkLevel: "low",
      prompt: "credential-free fixture", workspaceDir: root, cwd: root, timeoutMs: 5000,
      hostCapabilities: {
        assertActive() {},
        preparedEnvironment() { return { credentialScrubEnv: {}, localIdentityEnv: {}, managedLocalIdentity: false }; },
      },
    } as never;
    const execute = () => runAntigravityAttempt({ attempt,
      pluginConfig: resolveAntigravityPluginConfig({ command }), sessionBindings,
      hostContracts: sourceHostContracts(), inventory });
    await writeFile(inventoryPath, JSON.stringify({ models: [{ id: modelId, name: "Future model" }] }));
    const first = await execute();
    assert.equal(first.antigravityEvidence.invocation, "started");
    assert.equal(first.antigravityEvidence.nativeIdentityVerified, true);
    const rows = () => readFile(callsPath, "utf8").then(text => text.trim().split("\n").map(row => JSON.parse(row)));
    const sent = (await rows()).filter(row => row.args);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].model, modelId);
    assert.equal(sent[0].args.includes("--effort"), false);
    assert.equal(sessionBindings.resolve({ agentId: "main", storePath: join(root, "SIMULATED-store.json"), openclawSessionId: sessionId, openclawSessionKey: sessionKey })?.modelId, modelId);

    // Same exact host owner/session/config and still-visible host model input:
    // every next attempt must discover, including after a prior positive result.
    for (const output of [JSON.stringify({ models: [{ id: "replacement", name: "Replacement" }] }), '{"models":[]}', "AUTH", '{"models":']) {
      await writeFile(inventoryPath, output);
      const rejected = await execute();
      assert.equal(rejected.antigravityEvidence.invocation, "not_started");
      assert.equal((await rows()).filter(row => row.args).length, 1);
    }
    assert.equal((await rows()).filter(row => row.discovery).length, 5);
    assert.equal(sessionBindings.resolve({ agentId: "main", storePath: join(root, "SIMULATED-store.json"), openclawSessionId: sessionId, openclawSessionKey: sessionKey })?.conversationId, "inventory-conversation");
  } finally {
    inventory.stop();
    await rm(root, { recursive: true, force: true });
  }
});