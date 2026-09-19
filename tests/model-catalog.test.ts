import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInvocationScope } from "../src/cli/invocation-scope.ts";
import { runAgyRawProcess } from "../src/cli/agy-process.ts";
import { preflightAgyCapabilities } from "../src/cli/capability-preflight.ts";
import { buildAgyHarnessFreshArgs, encodeAgyPromptInput } from "../src/cli/args.ts";
import { resolveAntigravityPluginConfig } from "../src/config.ts";

import {
  discoverAgyModels,
  parseAgyModelsOutput,
  type AgyModelListExecutor,
} from "../src/harness/model-catalog.ts";

test("parses exact JSON IDs and display names without normalization", () => {
  const rows = [
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
    { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
    { id: "Vendor/Future:2026@preview", name: "Future opaque ID" },
  ];
  assert.deepEqual(parseAgyModelsOutput(JSON.stringify(rows)), rows);
});

test("parses the native AGY command envelope and label field", () => {
  const payload = {
    conversation_id: "",
    status: "SUCCESS",
    response: "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n",
    command: {
      name: "models",
      data: {
        models: [
          { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", additive: true },
          { id: "Vendor/Future:2026@preview", label: "Future opaque ID" },
        ],
      },
    },
  };
  assert.deepEqual(parseAgyModelsOutput(JSON.stringify(payload)), [
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
    { id: "Vendor/Future:2026@preview", name: "Future opaque ID" },
  ]);
  assert.throws(
    () => parseAgyModelsOutput(JSON.stringify({ command: { name: "models", data: { models: [{ id: "a", name: "A", label: "B" }] } } })),
    /invalid agy model row/,
  );
});

test("identical JSON duplicates collapse but conflicting names fail closed", () => {
  const row = { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" };
  assert.deepEqual(parseAgyModelsOutput(JSON.stringify([row, row])), [row]);
  assert.throws(() => parseAgyModelsOutput(JSON.stringify([row, { ...row, name: "Different Name" }])), /conflicting duplicate IDs/);
});

test("only successfully parsed empty inventory withdraws rows; blank and legacy output fail", () => {
  for (const invalid of ["", "\n\n", "missing-name\n", "model Model Name\n", "authentication required", "null", "false", '"not models"']) {
    assert.throws(() => parseAgyModelsOutput(invalid), /malformed.*JSON|lacks a models array/);
  }
  assert.deepEqual(parseAgyModelsOutput("[]"), []);
  assert.deepEqual(parseAgyModelsOutput('{"models":[]}'), []);
  assert.deepEqual(parseAgyModelsOutput('{"status":"SUCCESS","command":{"name":"models","data":{"models":[]}}}'), []);
});

test("discovery requests the documented read-only machine-readable agy models command", async () => {
  const calls: Array<{ command: string; args: readonly string[]; timeoutMs: number }> = [];
  const execute: AgyModelListExecutor = async (params) => {
    calls.push(params);
    return {
      exitCode: 0,
      stdout: '{"status":"SUCCESS","command":{"name":"models","data":{"models":[{"id":"gemini-3.8-flash-high","label":"Gemini 3.8 Flash (High)"}]}}}',
      stderr: "",
    };
  };

  const models = await discoverAgyModels({ command: "/opt/agy", timeoutMs: 2500, execute });
  assert.deepEqual(calls, [{ command: "/opt/agy", args: ["--output-format", "json", "models"], timeoutMs: 2500 }]);
  assert.deepEqual(models, [
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  ]);
});

test("nonzero model-list command withholds native diagnostics", async () => {
  await assert.rejects(
    discoverAgyModels({
      execute: async () => ({ exitCode: 1, stdout: "", stderr: "authentication required" }),
    }),
    /agy models failed \(exit 1\)/,
  );
});

test("JSON acquisition tolerates additive data and unseen opaque IDs", () => {
  const id = "Vendor/Future:2026@preview";
  assert.deepEqual(parseAgyModelsOutput(JSON.stringify({ models: [{ id, name: "New ID", extra: { x: 1 } }], extra: true })), [{ id, name: "New ID" }]);
  assert.deepEqual(parseAgyModelsOutput(JSON.stringify({ status: "SUCCESS", extra: true, command: { name: "models", data: { extra: true, models: [{ id, label: "Native New ID", extra: { x: 1 } }] } } })), [{ id, name: "Native New ID" }]);
  assert.deepEqual(parseAgyModelsOutput("[]"), []);
  assert.deepEqual(parseAgyModelsOutput('{"models":[]}'), []);
  assert.throws(() => parseAgyModelsOutput('{"models":'), /malformed.*JSON/);
  assert.throws(() => parseAgyModelsOutput('{"rows":[]}'), /lacks a models array/);
  assert.throws(() => parseAgyModelsOutput('[{"id":"a","name":"A"},{"id":"a","name":"A","capability":true}]'), /conflicting duplicate/);
  assert.throws(() => parseAgyModelsOutput('[{"id":"a","name":"A"},{"id":"b"}]'), /invalid agy model row/);
});

test("inventory caps count raw rows, UTF-8 bytes and stderr even for duplicate/empty results", async () => {
  assert.throws(() => parseAgyModelsOutput(JSON.stringify(Array.from({ length: 5001 }, () => ({ id: "same", name: "Same" })))), /exceeds 5000 rows/);
  assert.throws(() => parseAgyModelsOutput(`model ${"🚀".repeat(524288)}`), /exceeds 2097152 bytes/);
  await assert.rejects(discoverAgyModels({ execute: async () => ({ exitCode: 0, stdout: "[]", stderr: "x".repeat(2097152) }) }), /exceeds 2097152 bytes/);
  await assert.rejects(discoverAgyModels({ timeoutMs: 10001 }), /at most 10000ms/);
});

test("real fake process observes one prepared scope for preflight, discovery and large stdin EOF", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agy-discovery-scope-"));
  try {
    const executable = join(directory, "fake-agy");
    const marker = join(directory, "observed.jsonl");
    const help = await readFile(new URL("./fixtures/agy/1.2.2/help.txt", import.meta.url), "utf8");
    await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.TEST_MARKER, JSON.stringify({args, cwd:process.cwd(), owner:process.env.TEST_OWNER, ambient:process.env.AGY_TEST_AMBIENT_ONLY, inputBytes:Buffer.byteLength(input), inputFrames:input ? input.split('\\n').length - 1 : 0, contentLength:input ? JSON.parse(input).message.content.length : 0, eof:true})+'\\n');
  if(args[0] === '--version') process.stdout.write('Antigravity CLI version 1.2.2\\n');
  else if(args[0] === '--help') process.stdout.write(${JSON.stringify(help)});
  else if(args.includes('models')) process.stdout.write(JSON.stringify({status:'SUCCESS',command:{name:'models',data:{models:[{id:'Vendor/Future:2026@preview',label:'Future Model'}]}}}));
  else process.stdout.write('stdin accepted');
});
`, { mode: 0o700 });
    process.env.AGY_TEST_AMBIENT_ONLY = "must-not-leak";
    const scope = createInvocationScope({ command: executable, cwd: directory, env: { TEST_MARKER: marker, TEST_OWNER: "owner-a" }, timeoutMs: 5000, projectSelection: { project: "scope-project" }, addDirs: [directory], nativeAgentSelection: "fixture-agent" });
    await preflightAgyCapabilities({ scope, requiredFlags: ["--project", "--add-dir", "--agent", "--sandbox"] });
    assert.deepEqual(await discoverAgyModels({ scope }), [{ id: "Vendor/Future:2026@preview", name: "Future Model" }]);
    const config = resolveAntigravityPluginConfig({ project: "scope-project", addDirs: [directory], agent: "fixture-agent" });
    const prompt = "🚀".repeat(150_000);
    const args = buildAgyHarnessFreshArgs({ config, modelId: "Vendor/Future:2026@preview", prompt });
    const input = encodeAgyPromptInput(prompt);
    await runAgyRawProcess({ scope, args, stdin: input, maxOutputBytes: 1024 });
    const rows = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.slice(0, 3).map((row) => row.inputBytes), [0, 0, 0]);
    for (const row of rows) {
      assert.equal(row.cwd, directory);
      assert.equal(row.owner, "owner-a");
      assert.equal(row.ambient, undefined);
      assert.equal(row.eof, true);
    }
    const discoveryArgs = rows[2].args as string[];
    const modelsIndex = discoveryArgs.indexOf("models");
    assert.ok(modelsIndex > 0);
    for (const flag of ["--output-format", "--project", "--add-dir", "--agent"]) {
      const index = discoveryArgs.indexOf(flag);
      assert.ok(index >= 0 && index < modelsIndex, `${flag} must precede models`);
    }
    for (const row of rows.slice(2)) {
      assert.equal(row.args[row.args.indexOf("--project") + 1], "scope-project");
      assert.equal(row.args[row.args.indexOf("--agent") + 1], "fixture-agent");
      assert.equal(row.args[row.args.indexOf("--add-dir") + 1], directory);
    }
    assert.equal(rows[3].inputBytes, Buffer.byteLength(input));
    assert.equal(rows[3].contentLength, prompt.length);
    assert.equal(rows[3].inputFrames, 1);
    assert.ok(JSON.stringify(rows[3].args).length < 1024);
  } finally {
    delete process.env.AGY_TEST_AMBIENT_ONLY;
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancel during scoped discovery terminates observed process without submitting inference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agy-discovery-cancel-"));
  try {
    const executable = join(directory, "fake-agy");
    const marker = join(directory, "marker");
    await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_MARKER, args.includes('models') ? 'discovery-started\\n' : 'INFERENCE\\n');
process.on('SIGTERM', () => { fs.appendFileSync(process.env.TEST_MARKER, 'terminated\\n'); process.exit(0); });
setInterval(() => {}, 100);
`, { mode: 0o700 });
    const controller = new AbortController();
    const scope = createInvocationScope({ command: executable, cwd: directory, env: { TEST_MARKER: marker }, signal: controller.signal, timeoutMs: 5000 });
    const result = discoverAgyModels({ scope });
    const rejection = assert.rejects(result, /discovery failed before inference admission/);
    const until = Date.now() + 2000;
    let started = false;
    while (Date.now() < until) {
      try { started = (await readFile(marker, "utf8")).includes("discovery-started"); } catch { /* Await the actual marker. */ }
      if (started) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(started, true);
    controller.abort();
    await rejection;
    assert.equal(await readFile(marker, "utf8"), "discovery-started\nterminated\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pre-aborted discovery calls no executor and cannot override scope command", async () => {
  const controller = new AbortController();
  const scope = createInvocationScope({ command: process.execPath, env: {}, signal: controller.signal });
  controller.abort();
  let calls = 0;
  await assert.rejects(discoverAgyModels({ scope, execute: async () => { calls++; return { exitCode: 0, stdout: "[]", stderr: "" }; } }), /before inference admission/);
  assert.equal(calls, 0);
  await assert.rejects(discoverAgyModels({ scope, command: "/other/agy" }), /cannot override/);
});
