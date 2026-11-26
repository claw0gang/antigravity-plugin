import assert from "node:assert/strict";
import test from "node:test";
import { createAttemptEvidence } from "../src/cli/attempt-evidence.ts";
import { AgyProcessError, runAgyStreamProcess } from "../src/cli/agy-process.ts";
import { SessionSnapshotStaleError } from "../src/host/session-runtime.ts";
import { appendDiagnostic, diagnosticError, nativeResultDiagnostic } from "../src/harness/diagnostics.ts";

test("only original sanitized text survives successive diagnostic composition", () => {
  const evidence = createAttemptEvidence();
  const native = nativeResultDiagnostic("INVALID", evidence);
  const raw = new Error(`${native.message}; synthetic-secret`);
  assert.doesNotMatch(appendDiagnostic(raw, "cleanup", raw, evidence).message, /native_result|synthetic-secret/u);

  native.message = "synthetic-secret";
  const cleanup = appendDiagnostic(native, "cleanup", raw, evidence);
  const settlement = appendDiagnostic(cleanup, "settlement", raw, evidence);
  const delivery = appendDiagnostic(settlement, "delivery", raw, evidence);
  assert.deepEqual([...delivery.message.matchAll(/stage=(\w+)/gu)].map(match => match[1]),
    ["native_result", "cleanup", "settlement", "delivery"]);
  assert.match(delivery.message, /^AGY returned INVALID;/u);
  assert.doesNotMatch(delivery.message, /synthetic-secret/u);
  assert.equal(delivery.cause, undefined);
});

test("safe diagnostics identify the primary callback cause without retaining authority values", async () => {
  const init = JSON.stringify({ event: "init", conversation_id: "private-conversation", init: {
    cwd: "/private/project", tools: [], permission_mode: "request-review", model: "fixture-model",
  } });
  let failure: AgyProcessError | undefined;
  try {
    await runAgyStreamProcess({ command: process.execPath, args: ["-e",
      `console.log(${JSON.stringify(init)});setInterval(()=>{},1000)`], timeoutMs: 5000,
      expectedModelId: "fixture-model", onEvent() {
        throw new SessionSnapshotStaleError(["pluginExtensions", "sessionId"]);
      } });
  } catch (error) {
    assert.ok(error instanceof AgyProcessError);
    failure = error;
  }
  assert.ok(failure);
  const message = diagnosticError("init_bind", failure, failure.evidence).message;
  assert.match(message, /stage=init_bind/);
  assert.match(message, /AgyProcessError\(kind=callback\)/);
  assert.match(message, /SessionSnapshotStaleError\(snapshot is stale; fields=pluginExtensions,sessionId\)/);
  assert.match(message, /inferenceChild=started/);
  assert.match(message, /provider dispatch and outcome are not established/);
  assert.doesNotMatch(message, /private-conversation|private\/project/);
});

test("unknown causes and stderr are never interpolated into safe diagnostics", () => {
  const evidence = createAttemptEvidence();
  evidence.invocation = "started";
  evidence.termination = { containment: "posix_process_group", cleanupComplete: true,
    exitCode: 4, signal: "SIGTERM", hostReason: "protocol" };
  const failure = new AgyProcessError("protocol", "private prompt", {
    cause: new Error("Bearer synthetic-secret /private/path project-id"),
    stderr: "synthetic-secret", evidence,
  });
  const diagnostic = diagnosticError("active_stream", failure, evidence);
  assert.equal(diagnostic.cause, undefined, "Gateway must not serialize the unsanitized cause chain");
  const message = diagnostic.message;
  assert.match(message, /AgyProcessError\(kind=protocol\) <- Error/);
  assert.match(message, /exit=4; signal=SIGTERM; hostReason=protocol; cleanup=confirmed/);
  assert.doesNotMatch(message, /private prompt|Bearer|synthetic-secret|private\/path|project-id/);
});
