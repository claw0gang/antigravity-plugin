import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { AgyProcessError, runAgyRawProcess, runAgyStreamProcess } from "../src/cli/agy-process.ts";
import { createInvocationScope } from "../src/cli/invocation-scope.ts";
import { isReplaySafe } from "../src/cli/attempt-evidence.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const init = { event: "init", conversation_id: "c1", init: {
  cwd: "/fixture", tools: ["run_command"], permission_mode: "request-review", model: "opaque/new-model+effort",
} };
const usage = { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 };
const terminal = { event: "result", result: {
  conversation_id: "c1", status: "SUCCESS", response: "done", duration_seconds: 0.1, num_turns: 1, usage,
} };
const lines = (...events: unknown[]) => events.map((event) => JSON.stringify(event) + "\n").join("");
const write = (value: string) => `process.stdout.write(${JSON.stringify(value)});`;
const markerScript = (marker: string) => `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'effect');`;
async function failure(promise: Promise<unknown>): Promise<AgyProcessError> {
  try { await promise; assert.fail("expected runner failure"); }
  catch (error) { assert.ok(error instanceof AgyProcessError); return error; }
}
async function fixture(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "antigravity-process-fixture-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("pre-abort and elapsed deadline produce no process marker and positive no-start evidence", async () => {
  await fixture(async (dir) => {
    const marker = join(dir, "marker");
    const controller = new AbortController(); controller.abort();
    const aborted = await failure(runAgyStreamProcess({ command: process.execPath,
      args: ["-e", markerScript(marker)], signal: controller.signal }));
    assert.equal(aborted.kind, "aborted"); assert.equal(isReplaySafe(aborted.evidence), true);
    const scope = createInvocationScope({ command: process.execPath, timeoutMs: 10 });
    await wait(25);
    const expired = await failure(runAgyRawProcess({ scope, args: ["-e", markerScript(marker)] }));
    assert.equal(expired.kind, "timeout"); assert.equal(isReplaySafe(expired.evidence), true);
    await assert.rejects(access(marker));
  });
});

test("expired local deadline after argument setup cannot launch within a live broader scope", async (t) => {
  await fixture(async (dir) => {
    // A real child first proves this executable and directory can create a marker.
    const marker = join(dir, "local-deadline-marker");
    await runAgyRawProcess({ command: process.execPath, args: ["-e", markerScript(marker)] });
    assert.equal(await readFile(marker, "utf8"), "effect");
    await rm(marker);

    let now = 1_000;
    t.mock.method(performance, "now", () => now);
    const scope = createInvocationScope({ command: process.execPath, timeoutMs: 10_000 });
    let argumentReads = 0;
    const error = await failure(runAgyRawProcess({
      scope, timeoutMs: 100,
      get args() {
        argumentReads++;
        // Deterministic synchronous setup consumes only the local budget.
        now += 101;
        return ["-e", markerScript(marker)];
      },
    }));
    scope.assertActive();
    assert.equal(argumentReads, 1);
    assert.equal(error.kind, "timeout");
    assert.equal(error.evidence.invocation, "not_started");
    assert.equal(error.evidence.effects, "none_proven");
    assert.equal(error.evidence.termination.containment, "not_started");
    assert.equal(error.evidence.termination.cleanupComplete, true);
    assert.equal(error.evidence.termination.hostReason, "timeout");
    assert.equal(isReplaySafe(error.evidence), true);
    await assert.rejects(access(marker));
  });
});

test("stdin is captured once before the deadline fence and the encoded size check", async () => {
  let reads = 0;
  const input = "one validated frame\n";
  const result = await runAgyRawProcess({ command: process.execPath,
    args: ["-e", "process.stdin.pipe(process.stdout);"],
    get stdin() { reads++; return reads === 1 ? input : "unvalidated replacement"; },
  });
  assert.equal(reads, 1);
  assert.equal(result.stdout, input);
});

test("prepared cwd/environment are immutable and raw discovery consumes the same scope", async () => {
  await fixture(async (dir) => {
    const env = { PREPARED: "one", PATH: "/deliberately-absent" };
    const scope = createInvocationScope({ command: process.execPath, cwd: dir, env });
    env.PREPARED = "mutated";
    assert.ok(Object.isFrozen(scope)); assert.ok(Object.isFrozen(scope.env));
    const script = "process.stdout.write(JSON.stringify({cwd:process.cwd(), prepared:process.env.PREPARED,home:process.env.HOME}));";
    const a = await runAgyRawProcess({ scope, args: ["-e", script], timeoutMs: 1_000 });
    const b = await runAgyRawProcess({ scope, args: ["-e", script], timeoutMs: 1_000 });
    assert.deepEqual(JSON.parse(a.stdout), { cwd: dir, prepared: "one" }); assert.equal(a.stdout, b.stdout);
  });
});

test("real marker before malformed telemetry retains possible effects without a parsed tool", async () => {
  await fixture(async (dir) => {
    const marker = join(dir, "effect");
    const error = await failure(runAgyStreamProcess({ command: process.execPath,
      args: ["-e", markerScript(marker) + write(lines(init) + "{bad\n")], expectedModelId: init.init.model }));
    assert.equal(await readFile(marker, "utf8"), "effect");
    assert.equal(error.kind, "protocol"); assert.equal(error.evidence.invocation, "started");
    assert.equal(error.evidence.effects, "unknown"); assert.equal(isReplaySafe(error.evidence), false);
    assert.equal(error.partialSnapshot?.toolSteps.length, 0);
    assert.equal(error.partialSnapshot?.conversationId, "c1");
  });
});

test("missing terminal retains observed assistant text; duplicate terminal cannot become success", async () => {
  const delta = { event: "step_update", step_update: { conversation_id: "c1", step_index: 0,
    step_type: "agent_response", state: "ACTIVE", text_delta: "partial 🦋" } };
  const missing = await failure(runAgyStreamProcess({ command: process.execPath,
    args: ["-e", write(lines(init, delta))] }));
  assert.equal(missing.kind, "protocol"); assert.equal(missing.partialSnapshot?.assistantText, "partial 🦋");
  assert.equal(isReplaySafe(missing.evidence), false);
  const duplicate = await failure(runAgyStreamProcess({ command: process.execPath,
    args: ["-e", write(lines(init, terminal, terminal))] }));
  assert.equal(duplicate.kind, "protocol"); assert.equal(duplicate.evidence.terminal.nativeStatus, "SUCCESS");
  assert.equal(duplicate.evidence.terminal.protocolComplete, false);
});

test("wrong acknowledged opaque model fails with its actual identity and unsafe evidence", async () => {
  const error = await failure(runAgyStreamProcess({ command: process.execPath,
    args: ["-e", write(lines(init, terminal))], expectedModelId: "different/model" }));
  assert.equal(error.kind, "protocol"); assert.equal(error.evidence.acknowledgedModelId, init.init.model);
  assert.equal(error.evidence.nativeIdentityVerified, false); assert.equal(isReplaySafe(error.evidence), false);
});

test("split UTF-8 across every byte preserves stream and bounded diagnostic tail", async () => {
  const answer = { ...terminal, result: { ...terminal.result, response: "é 🦋 中文" } };
  const script = `const bytes=Buffer.from(${JSON.stringify(lines(init, answer))});
    let i=0; const t=setInterval(()=>{if(i===bytes.length){clearInterval(t);return;}process.stdout.write(bytes.subarray(i,i+1));i++;},1);
    const err=Buffer.from('é 🦋 中文'); for(let k=0;k<err.length;k++) process.stderr.write(err.subarray(k,k+1));`;
  const result = await runAgyStreamProcess({ command: process.execPath, args: ["-e", script], timeoutMs: 3_000 });
  assert.equal(result.snapshot.result.response, "é 🦋 中文"); assert.equal(result.stderr, "é 🦋 中文");
});

test("encoded large stdin is delivered once then EOF with no prompt argv", async () => {
  const input = JSON.stringify({ role: "user", content: "🦋".repeat(200_000) }) + "\n";
  const script = "let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({bytes:Buffer.byteLength(data),frames:data.split('\\n').filter(Boolean).length,argv:process.argv.slice(1),len:JSON.parse(data).content.length})));";
  const result = await runAgyRawProcess({ command: process.execPath, args: ["-e", script], stdin: input, timeoutMs: 2_000 });
  assert.deepEqual(JSON.parse(result.stdout), { bytes: Buffer.byteLength(input), frames: 1, argv: [], len: 400_000 });
  const tooBig = await failure(runAgyRawProcess({ command: process.execPath, args: ["-e", "throw Error('must not launch')"], stdin: "x".repeat(1_048_577) }));
  assert.equal(tooBig.kind, "output_limit"); assert.equal(isReplaySafe(tooBig.evidence), true);
});

test("combined raw output and unterminated event caps stop a running producer", async () => {
  const raw = await failure(runAgyRawProcess({ command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(4096));setInterval(()=>{},1000);"], maxOutputBytes: 1_024, timeoutMs: 2_000 }));
  assert.equal(raw.kind, "output_limit"); assert.equal(raw.evidence.termination.cleanupComplete, true);
  const event = await failure(runAgyStreamProcess({ command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(1048577));setInterval(()=>{},1000);"], timeoutMs: 2_000 }));
  assert.equal(event.kind, "output_limit"); assert.equal(isReplaySafe(event.evidence), false);
});

test("delayed callbacks lose authority before continuation; ordered delivery never resumes", async () => {
  const order: string[] = [];
  const start = performance.now();
  const error = await failure(runAgyStreamProcess({ command: process.execPath,
    args: ["-e", write(lines(init, terminal))], async onEvent(event, context) {
      order.push(event.event + "-start");
      if (event.event === "init") {
        await wait(1_150);
        try { context.assertActive(); order.push("late-mutation"); }
        catch { order.push("retired"); }
      }
    } }));
  assert.equal(error.kind, "callback"); assert.ok(performance.now() - start < 2_000);
  await wait(200);
  assert.deepEqual(order, ["init-start", "retired"]);
  assert.equal(error.evidence.terminal.protocolComplete, false);
});

test("throwing stderr callback is contained and sensitive diagnostics are redacted", async () => {
  const error = await failure(runAgyRawProcess({ command: process.execPath,
    env: { DEMO_API_KEY: "not-a-real-secret" },
    args: ["-e", "process.stderr.write('token not-a-real-secret\\n');setInterval(()=>{},1000);"],
    onStderr() { throw new Error("observer failed"); } }));
  assert.equal(error.kind, "callback"); assert.ok(!error.stderr.includes("not-a-real-secret"));
  assert.equal(error.evidence.termination.cleanupComplete, true);
});

test("native timeout warning preserves SUCCESS as native fact and fails completion", async () => {
  const error = await failure(runAgyStreamProcess({ command: process.execPath,
    args: ["-e", write(lines(init, terminal)) + "process.stderr.write('Warning: execution timed out; response truncated');"] }));
  assert.equal(error.kind, "native_timeout"); assert.equal(error.evidence.terminal.nativeStatus, "SUCCESS");
  assert.equal(error.evidence.terminal.nativeTimeout, true); assert.match(error.stderr, /timed out/); assert.equal(isReplaySafe(error.evidence), false);
});

test("normal parent exit terminates an owned descendant retaining pipes", async () => {
  await fixture(async (dir) => {
    const marker = join(dir, "survivor");
    const pidPath = join(dir, "pid");
    const descendant = markerScript(pidPath).replace("'effect'", "String(process.pid)") +
      `process.on('SIGTERM',()=>{});setTimeout(()=>{${markerScript(marker)}},2500);setInterval(()=>{},1000);`;
    const script = `const cp=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',process.stdout,process.stderr]});
      setTimeout(()=>{${write(lines(init, terminal))}process.exit(0)},100);`;
    const started = performance.now();
    let descendantPid: number | undefined;
    try {
      const result = await runAgyStreamProcess({ command: process.execPath, args: ["-e", script], timeoutMs: 5_000 });
      descendantPid = Number(await readFile(pidPath, "utf8"));
      assert.equal(result.evidence.termination.cleanupComplete, true);
      assert.ok(performance.now() - started < 6_000);
      await wait(500); await assert.rejects(access(marker));
    } finally {
      if (!descendantPid) { try { descendantPid = Number(await readFile(pidPath, "utf8")); } catch {} }
      if (descendantPid) { try { process.kill(descendantPid, "SIGKILL"); } catch {} }
    }
  });
});

test("abort and deadline kill a marker-producing process before its scheduled effect", async () => {
  await fixture(async (dir) => {
    for (const mode of ["abort", "timeout"] as const) {
      const ready = join(dir, `${mode}-ready`);
      const late = join(dir, `${mode}-late`);
      const controller = new AbortController();
      const script = markerScript(ready) + `setTimeout(()=>{${markerScript(late)}},700);setInterval(()=>{},1000);`;
      const pending = runAgyRawProcess({ command: process.execPath, args: ["-e", script],
        signal: controller.signal, timeoutMs: mode === "timeout" ? 150 : 2_000 });
      if (mode === "abort") {
        for (let i = 0; i < 50; i++) { try { await access(ready); break; } catch { await wait(10); } }
        controller.abort();
      }
      const error = await failure(pending);
      assert.equal(error.kind, mode === "abort" ? "aborted" : "timeout");
      assert.equal(await readFile(ready, "utf8"), "effect");
      assert.equal(error.evidence.termination.cleanupComplete, true);
      await wait(750);
      await assert.rejects(access(late));
    }
  });
});

test("explicit detached daemon escapes the owned group; observable survival is not hidden", async () => {
  await fixture(async (dir) => {
    const escapedMarker = join(dir, "escaped");
    const pidPath = join(dir, "detached-pid");
    const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));` +
      `setTimeout(()=>{${markerScript(escapedMarker)}},500);setInterval(()=>{},1000);`;
    const script = `const cp=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'});cp.unref();setTimeout(()=>{${write(lines(init, terminal))}},100);`;
    let pid: number | undefined;
    try {
      const result = await runAgyStreamProcess({ command: process.execPath, args: ["-e", script], timeoutMs: 2_000 });
      pid = Number(await readFile(pidPath, "utf8"));
      assert.equal(result.evidence.termination.containment, "posix_process_group");
      assert.equal(isReplaySafe(result.evidence), false);
      await wait(600);
      assert.equal(await readFile(escapedMarker, "utf8"), "effect");
      // This deliberately surviving fixture is stopped by its test owner, not credited to the runner.
    } finally {
      if (!pid) { try { pid = Number(await readFile(pidPath, "utf8")); } catch {} }
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  });
});

test("unrecognized critical stderr prevents successful completion; ordinary debug diagnostics pass", async () => {
  const warning = await failure(runAgyStreamProcess({ command: process.execPath,
    args: ["-e", write(lines(init, terminal)) + "process.stderr.write('WARNING: required native feature failed');"] }));
  assert.equal(warning.kind, "protocol"); assert.equal(warning.evidence.terminal.nativeStatus, "SUCCESS");
  assert.equal(warning.evidence.terminal.nativeCriticalWarning, true);
  const debug = await runAgyStreamProcess({ command: process.execPath,
    args: ["-e", write(lines(init, terminal)) + "process.stderr.write('debug: cache warm');"] });
  assert.equal(debug.snapshot.result.status, "SUCCESS");
});

test("delivery evidence requires an explicit live callback acknowledgement", async () => {
  const noDelivery = await runAgyStreamProcess({ command: process.execPath,
    args: ["-e", write(lines(init, terminal))], onEvent() {} });
  assert.equal(noDelivery.evidence.deliveredOutput, false);
  const delivery = await runAgyStreamProcess({ command: process.execPath,
    args: ["-e", write(lines(init, terminal))], onEvent(event, context) {
      if (event.event === "result") context.markOutputDelivered();
    } });
  assert.equal(delivery.evidence.deliveredOutput, true);
});

test("stderr credentials split across chunks are redacted before callback retention", async () => {
  const observed: string[] = [];
  const result = await runAgyRawProcess({ command: process.execPath, env: { DEMO_API_KEY: "split-credential" },
    args: ["-e", "process.stderr.write('split-');setTimeout(()=>process.stderr.write('credential\\n'),30);"],
    onStderr(chunk) { observed.push(chunk); } });
  assert.deepEqual(observed, ["[redacted]\n"]); assert.equal(result.stderr, "[redacted]\n");
});

test("delivery queue saturation stops producer without dispatching later critical events", async () => {
  const delivered: string[] = [];
  const event = { event: "step_update", step_update: { conversation_id: "c1", step_index: 0,
    step_type: "agent_response", state: "ACTIVE", text_delta: "x".repeat(60_000) } };
  const script = write(lines(init)) + `for(let i=0;i<80;i++){${write(lines(event))}}setInterval(()=>{},1000);`;
  const error = await failure(runAgyStreamProcess({ command: process.execPath,
    args: ["-e", script], timeoutMs: 3_000, async onEvent(event, context) {
      delivered.push(event.event);
      await wait(500); context.assertActive();
    } }));
  assert.equal(error.kind, "output_limit"); assert.deepEqual(delivered, ["init"]);
  assert.equal(error.evidence.termination.cleanupComplete, true);
});

test("detached descendant retaining inherited pipes cannot block settlement or claim cleanup", async () => {
  await fixture(async (dir) => {
    const pidPath = join(dir, "escaped-pipe-pid");
    const marker = join(dir, "escaped-pipe-marker");
    const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));` +
      `setTimeout(()=>{${markerScript(marker)}},500);setInterval(()=>{},1000);`;
    const script = `const cp=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:['ignore',process.stdout,process.stderr]});cp.unref();setTimeout(()=>{${write(lines(init, terminal))}process.exit(0)},100);`;
    let pid: number | undefined;
    const start = performance.now();
    try {
      const error = await failure(runAgyStreamProcess({ command: process.execPath, args: ["-e", script], timeoutMs: 5_500 }));
      pid = Number(await readFile(pidPath, "utf8"));
      assert.equal(error.kind, "cleanup"); assert.ok(performance.now() - start < 6_000);
      assert.equal(error.evidence.termination.cleanupComplete, false);
      assert.equal(await readFile(marker, "utf8"), "effect");
      assert.equal(isReplaySafe(error.evidence), false);
    } finally {
      if (!pid) { try { pid = Number(await readFile(pidPath, "utf8")); } catch {} }
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  });
});
