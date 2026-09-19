import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createInvocationScope } from "../src/cli/invocation-scope.ts";
import { preflightAgyCapabilities, inspectAgyHelp, parseAgyVersion } from "../src/cli/capability-preflight.ts";
import { parseAgyModelsOutput } from "../src/harness/model-catalog.ts";

const STREAM_PROBE = ["--input-format", "stream-json", "--output-format", "stream-json", "--help"];
const MODEL_PROBE = ["--model", "antigravity-capability-probe", "--help"];
const CONVERSATION_PROBE = ["--conversation", "00000000-0000-0000-0000-000000000000", "--help"];
const TIMEOUT_PROBE = ["--print-timeout", "1s", "--help"];

for (const target of ["1.1.28", "1.2.2"]) {
  test(`synthetic ${target} fixtures exercise source flags/discovery without claiming native qualification`, async () => {
    const fixture = new URL(`./fixtures/agy/${target}/`, import.meta.url);
    const [version, help, models] = await Promise.all(["version.txt", "help.txt", "models.json"].map((file) => readFile(new URL(file, fixture), "utf8")));
    const scope = createInvocationScope({ command: process.execPath, cwd: process.cwd(), env: {}, timeoutMs: 1000 });
    const seen: string[][] = [];
    const result = await preflightAgyCapabilities({ scope, requiredFlags: ["--sandbox", "--project"], execute: async (params) => {
      assert.equal(params.scope, scope);
      assert.ok(params.timeoutMs > 0 && params.timeoutMs <= 1000);
      assert.ok(!("stdin" in params));
      seen.push([...params.args]);
      return { exitCode: 0, stdout: params.args[0] === "--version" ? version! : help!, stderr: "" };
    }});
    assert.equal(result.version, target);
    assert.equal(result.semanticQualification, "not_executed");
    assert.deepEqual(seen, [["--version"], ["--help"]]);
    assert.ok(parseAgyModelsOutput(models!).length > 0);
  });
}

test("newer stable AGY versions remain eligible syntax while capability checks govern behavior", () => {
  for (const version of ["agy version 1.2.9", "2.0.0", "10.4.7"]) {
    const normalized = version.replace(/^agy version /u, "");
    assert.equal(parseAgyVersion(version), normalized);
  }
  for (const version of ["1.1.27", "1.2.2-beta", "not a version", "1.2.2\n1.2.3"]) {
    assert.throws(() => parseAgyVersion(version), /version|minimum supported/);
  }
});

test("missing critical flags or stream-json option fail without accepting prefix collisions", async () => {
  const help = await readFile(new URL("./fixtures/agy/1.2.2/help.txt", import.meta.url), "utf8");
  assert.throws(() => inspectAgyHelp(help.replace("--conversation", "--conversation-future")), /missing: --conversation/);
  assert.throws(() => inspectAgyHelp(help.replace("Input: text, stream-json", "Input: text")), /--input-format stream-json/);
  assert.throws(() => inspectAgyHelp(help, ["--unknown-required"]), /missing: --unknown-required/);
});

test("preflight parser-probes documented stream transport when root help omits print-mode stream flags", async () => {
  const fixture = new URL("./fixtures/agy/1.2.2/", import.meta.url);
  const version = await readFile(new URL("version.txt", fixture), "utf8");
  const fixtureHelp = await readFile(new URL("help.txt", fixture), "utf8");
  const help = fixtureHelp
    .split(/\r?\n/u)
    .filter((line) => !line.includes("--input-format") && !line.includes("--output-format"))
    .join("\n");
  const scope = createInvocationScope({ command: process.execPath, cwd: process.cwd(), env: {}, timeoutMs: 1000 });
  const seen: string[][] = [];
  const result = await preflightAgyCapabilities({ scope, execute: async (params) => {
    seen.push([...params.args]);
    if (params.args[0] === "--version") return { exitCode: 0, stdout: version, stderr: "" };
    if (params.args.length === 1 && params.args[0] === "--help") return { exitCode: 0, stdout: help, stderr: "" };
    assert.deepEqual(params.args, STREAM_PROBE);
    return { exitCode: 0, stdout: "", stderr: "" };
  }});
  assert.equal(result.version, "1.2.2");
  assert.ok(result.advertisedFlags.includes("--input-format"));
  assert.ok(result.advertisedFlags.includes("--output-format"));
  assert.deepEqual(seen, [["--version"], ["--help"], STREAM_PROBE]);
});

test("preflight parser-probes known print-mode flags omitted from root help", async () => {
  const fixture = new URL("./fixtures/agy/1.2.2/", import.meta.url);
  const version = await readFile(new URL("version.txt", fixture), "utf8");
  const fixtureHelp = await readFile(new URL("help.txt", fixture), "utf8");
  const help = fixtureHelp
    .split(/\r?\n/u)
    .filter((line) => !line.includes("--model") && !line.includes("--conversation") && !line.includes("--print-timeout"))
    .join("\n");
  const scope = createInvocationScope({ command: process.execPath, cwd: process.cwd(), env: {}, timeoutMs: 1000 });
  const seen: string[][] = [];
  const allowedProbes = [MODEL_PROBE, CONVERSATION_PROBE, TIMEOUT_PROBE].map((probe) => JSON.stringify(probe));
  const result = await preflightAgyCapabilities({ scope, execute: async (params) => {
    seen.push([...params.args]);
    if (params.args[0] === "--version") return { exitCode: 0, stdout: version, stderr: "" };
    if (params.args.length === 1 && params.args[0] === "--help") return { exitCode: 0, stdout: help, stderr: "" };
    assert.ok(allowedProbes.includes(JSON.stringify([...params.args])));
    return { exitCode: 0, stdout: "", stderr: "" };
  }});
  assert.equal(result.version, "1.2.2");
  assert.deepEqual(seen, [["--version"], ["--help"], MODEL_PROBE, CONVERSATION_PROBE, TIMEOUT_PROBE]);
});

test("failed hidden model parser probe blocks admission and withholds diagnostics", async () => {
  const fixture = new URL("./fixtures/agy/1.2.2/", import.meta.url);
  const version = await readFile(new URL("version.txt", fixture), "utf8");
  const fixtureHelp = await readFile(new URL("help.txt", fixture), "utf8");
  const help = fixtureHelp.split(/\r?\n/u).filter((line) => !line.includes("--model")).join("\n");
  const scope = createInvocationScope({ command: process.execPath, env: {} });
  let calls = 0;
  await assert.rejects(preflightAgyCapabilities({ scope, execute: async (params) => {
    calls += 1;
    if (params.args[0] === "--version") return { exitCode: 0, stdout: version, stderr: "" };
    if (params.args.length === 1 && params.args[0] === "--help") return { exitCode: 0, stdout: help, stderr: "" };
    assert.deepEqual(params.args, MODEL_PROBE);
    return { exitCode: 2, stdout: "secret=fixture", stderr: "credentials=fixture" };
  }}), (error: Error) => {
    assert.match(error.message, /--model parser probe failed/);
    assert.match(error.message, /diagnostics withheld/);
    assert.doesNotMatch(error.message, /secret=|credentials=/);
    return true;
  });
  assert.equal(calls, 3);
});

test("failed stream parser probe blocks admission and withholds native diagnostics", async () => {
  const fixture = new URL("./fixtures/agy/1.2.2/", import.meta.url);
  const version = await readFile(new URL("version.txt", fixture), "utf8");
  const fixtureHelp = await readFile(new URL("help.txt", fixture), "utf8");
  const help = fixtureHelp
    .split(/\r?\n/u)
    .filter((line) => !line.includes("--input-format") && !line.includes("--output-format"))
    .join("\n");
  const scope = createInvocationScope({ command: process.execPath, env: {} });
  let calls = 0;
  await assert.rejects(preflightAgyCapabilities({ scope, execute: async (params) => {
    calls += 1;
    if (params.args[0] === "--version") return { exitCode: 0, stdout: version, stderr: "" };
    if (params.args.length === 1 && params.args[0] === "--help") return { exitCode: 0, stdout: help, stderr: "" };
    assert.deepEqual(params.args, STREAM_PROBE);
    return { exitCode: 2, stdout: "secret=fixture", stderr: "credentials=fixture" };
  }}), (error: Error) => {
    assert.match(error.message, /stream-json parser probe failed/);
    assert.match(error.message, /diagnostics withheld/);
    assert.doesNotMatch(error.message, /secret=|credentials=/);
    return true;
  });
  assert.equal(calls, 3);
});

test("preflight shares pre-abort and retirement fence and suppresses untrusted diagnostics", async () => {
  const controller = new AbortController();
  const scope = createInvocationScope({ command: process.execPath, env: {}, signal: controller.signal });
  controller.abort();
  let calls = 0;
  await assert.rejects(preflightAgyCapabilities({ scope, execute: async () => { calls++; throw new Error("must not call"); } }), /before inference admission/);
  assert.equal(calls, 0);
  const active = createInvocationScope({ command: process.execPath, env: {} });
  await assert.rejects(preflightAgyCapabilities({ scope: active, execute: async () => ({ exitCode: 1, stdout: "secret=fixture", stderr: "credentials=fixture" }) }), (error: Error) => {
    assert.match(error.message, /diagnostics withheld/);
    assert.doesNotMatch(error.message, /secret=|credentials=/);
    return true;
  });
});
