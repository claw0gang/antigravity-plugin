#!/usr/bin/env node
// Actual public SDK calls in a disposable, explicitly selected store. This is
// neither a Gateway run nor proof of registry-bound plugin/session ownership.
import { hostname } from "node:os";
import { spawn } from "node:child_process";

function optionsFrom(argv) {
  const allowed = new Set(["expected-hostname", "openclaw-root", "scratch-root", "plugin-root", "timeout-ms"]);
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (!argv[i]?.startsWith("--") || !allowed.has(key) || options[key] !== undefined || !argv[i + 1]) {
      throw new Error("Use --expected-hostname NAME --openclaw-root PATH --scratch-root PATH [--plugin-root PACKED-PATH] [--timeout-ms 30000]");
    }
    options[key] = argv[i + 1];
  }
  if (!options["expected-hostname"] || hostname() !== options["expected-hostname"]) {
    throw new Error(`HOST: FAIL expected=${options["expected-hostname"] ?? "missing"} actual=${hostname()}; no files read`);
  }
  if (!options["openclaw-root"] || !options["scratch-root"]) throw new Error("Explicit SDK and scratch roots are required");
  const timeout = Number(options["timeout-ms"] ?? 30_000);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 60_000) throw new Error("timeout-ms must be 1000 through 60000");
  return { ...options, timeout };
}

async function observe(options) {
  const { hostname } = await import("node:os");
  if (hostname() !== options["expected-hostname"]) throw new Error("Host changed before child inspection");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const { createHash } = await import("node:crypto");
  const assert = (await import("node:assert/strict")).default;
  const { isDeepStrictEqual } = await import("node:util");
  const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);
  const sdkRoot = await fs.realpath(options["openclaw-root"]);
  const fixtureRoot = await fs.realpath(options.fixtureRoot);
  for (const key of ["HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) {
    assert.ok(inside(fixtureRoot, process.env[key] ?? ""), `${key} must stay within the explicit fixture`);
  }
  const pkg = JSON.parse(await fs.readFile(path.join(sdkRoot, "package.json"), "utf8"));
  assert.equal(pkg.name, "openclaw");
  const require = createRequire(path.join(sdkRoot, "package.json"));
  const specifier = "openclaw/plugin-sdk/session-store-runtime";
  const entryPath = await fs.realpath(require.resolve(specifier));
  assert.ok(inside(sdkRoot, entryPath), "Public SDK export must resolve within the selected package");
  process.send?.({ kind: "stage", stage: "public SDK import" });
  const sdk = await import(pathToFileURL(entryPath).href);
  const modernNames = ["getSessionEntryAsync", "listSessionEntriesAsync", "prepareSessionEntryPatch", "withSessionEntriesAsync"];
  const legacyNames = ["getSessionEntry", "listSessionEntries", "patchSessionEntry"];
  const capabilities = Object.fromEntries([...modernNames, ...legacyNames].map((name) => [name, typeof sdk[name] === "function"]));
  const report = {
    status: "passed",
    evidenceKind: "actual public SDK artifact with isolated session-store calls",
    hostname: hostname(), nodeVersion: process.version, sdkVersion: pkg.version,
    sdkRoot, sdkExport: { specifier, path: entryPath, sha256: createHash("sha256").update(await fs.readFile(entryPath)).digest("hex") },
    capabilities, checks: [], fixtureRoot,
    limitations: [
      "Standalone public exports do not establish registry-bound plugin lifetime, reserved/locked session ownership, admitted-run authority or final delivery behavior.",
      "No Gateway startup, AGY binary, authentication, inference, install or production store is used.",
      "The conflict fixture uses two isolated Node processes and does not qualify a live Gateway or AGY host.",
    ],
  };
  let api = sdk;
  let candidateBindings;
  if (options["plugin-root"]) {
    const pluginRoot = await fs.realpath(options["plugin-root"]);
    const adapterPath = await fs.realpath(path.join(pluginRoot, "dist/host/session-runtime.js"));
    assert.ok(inside(pluginRoot, adapterPath), "Packed adapter must stay within its selected package");
    const candidate = JSON.parse(await fs.readFile(path.join(pluginRoot, "package.json"), "utf8"));
    assert.equal(candidate.name, "@claw0gang/antigravity");
    const adapter = await import(pathToFileURL(adapterPath).href);
    report.candidate = { pluginRoot, version: candidate.version,
      adapterSha256: createHash("sha256").update(await fs.readFile(adapterPath)).digest("hex"),
      selected: adapter.inspectSessionRuntime(sdk) };
    api = adapter.createAntigravitySessionRuntime(sdk);
    if (modernNames.every((name) => capabilities[name])) {
      assert.equal(typeof api.withCurrentSessionEntry, "function", "Candidate requires the public selected-entry callback fence");
      const bindingsPath = await fs.realpath(path.join(pluginRoot, "dist/harness/session-bindings.js"));
      assert.ok(inside(pluginRoot, bindingsPath), "Candidate binding implementation must stay in its package");
      const bindings = await import(pathToFileURL(bindingsPath).href);
      report.candidate.bindingsSha256 = createHash("sha256").update(await fs.readFile(bindingsPath)).digest("hex");
      candidateBindings = new bindings.AntigravitySessionBindings(api, {
        atomicMutation: { evidence: "Isolated actual-SDK fixture only; no native execution or live host qualification" },
      });
    }
  }
  if (!modernNames.every((name) => capabilities[name])) {
    assert.ok(legacyNames.every((name) => capabilities[name]), "Expected complete legacy capability surface");
    assert.ok(modernNames.every((name) => !capabilities[name]), "Partial modern surface is not a legacy adapter result");
    report.evidenceKind = "actual public SDK artifact capability observation";
    report.checks.push({ name: "legacy public capabilities", status: "passed", storeExecution: false });
    report.limitations.push("Legacy session mutations were not executed; this observation confirms imports and capability selection only.");
    return report;
  }
  assert.equal(typeof sdk.applySessionEntryPatch, "function");
  report.checks.push({ name: "modern public asynchronous exports", status: "passed" });
  const storePath = path.join(fixtureRoot, "store", "sessions.json");
  await fs.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
  const target = { agentId: "main", sessionKey: "agent:main:sdk-session-observation", storePath,
    env: { ...process.env }, readConsistency: "latest" };
  const initial = { sessionId: "sdk-session-observation-1", lifecycleRevision: "sdk-observation-generation-1",
    updatedAt: Date.now(), sessionStartedAt: Date.now(), displayName: "initial",
    skillsSnapshot: { prompt: "isolated SDK snapshot", skills: [] } };
  process.send?.({ kind: "stage", stage: "missing-store read", observed: report });
  const before = await api.getSessionEntryAsync(target);
  assert.equal(before, undefined);
  let seedPreparations = 0;
  process.send?.({ kind: "stage", stage: "isolated session seed", observed: report });
  await api.prepareSessionEntryPatch({ ...target, fallbackEntry: initial, replaceEntry: true,
    skipMaintenance: true, requireWriteSuccess: true, prepare: () => { seedPreparations++; return initial; } });
  assert.equal(seedPreparations, 1);
  process.send?.({ kind: "stage", stage: "full-entry and metadata reads", observed: report });
  const full = await api.getSessionEntryAsync(target);
  assert.equal(full?.sessionId, initial.sessionId);
  assert.equal(full?.skillsSnapshot?.prompt, initial.skillsSnapshot.prompt);
  const listed = await api.listSessionEntriesAsync({ agentId: target.agentId, storePath, env: target.env, readConsistency: "latest" });
  const metadata = listed.find((row) => row.sessionKey === target.sessionKey)?.entry;
  assert.equal(metadata?.sessionId, initial.sessionId);
  assert.equal(metadata?.skillsSnapshot, undefined);
  full.displayName = "detached local edit";
  assert.equal((await api.getSessionEntryAsync(target))?.displayName, initial.displayName);
  report.checks.push({ name: "awaited seed and full-entry/metadata distinction", status: "passed",
    seedPreparations, fullSnapshotPresent: true, listedSnapshotOmitted: true, detachedRead: true });

  let resume, entered;
  const released = new Promise((resolve) => { resume = resolve; });
  const preparationEntered = new Promise((resolve) => { entered = resolve; });
  let preparations = 0;
  const stale = api.prepareSessionEntryPatch({ ...target, skipMaintenance: true, preserveActivity: true,
    prepare: async (entry) => {
      preparations++;
      assert.equal(entry.displayName, initial.displayName);
      entered();
      await released;
      return { displayName: "stale writer" };
    } });
  // Observe rejection immediately, including if the actual SDK refuses before preparation.
  const staleResult = stale.then((value) => ({ status: "fulfilled", value }), (error) => ({ status: "rejected", error }));
  process.send?.({ kind: "stage", stage: "capturing stale preparation", observed: report });
  await Promise.race([preparationEntered, staleResult.then(() => { throw new Error("Stale preparation did not begin"); })]);
  // The SDK reserves its own process-local writer queue across preparation.
  // A separate process supplies a real conflicting commit without private SQL.
  async function inFreshProcess(operation, overrides = {}) {
    async function executePublicOperation(request) {
      const { hostname } = await import("node:os");
      if (hostname() !== request.expectedHostname) throw new Error("Fresh-process SDK host mismatch");
      const { pathToFileURL } = await import("node:url");
      const sdk = await import(pathToFileURL(request.sdkEntry).href);
      if (request.operation === "read") return await sdk.getSessionEntryAsync(request.target);
      if (request.operation === "delete") {
        const deleted = await sdk.deleteSessionEntry({ ...request.target, expectedSessionId: request.expected.sessionId });
        return { deleted, entry: await sdk.getSessionEntryAsync(request.target) };
      }
      const entry = await sdk.applySessionEntryPatch({ ...request.target, skipMaintenance: true, preserveActivity: true,
        expected: request.expected, patch: request.patch ?? { displayName: "competing writer" } });
      return request.operation === "patch-and-read" ? { entry, read: await sdk.getSessionEntryAsync(request.target) } : entry;
    }
    const { spawn } = await import("node:child_process");
    const request = { expectedHostname: options["expected-hostname"], sdkEntry: entryPath, target, operation,
      expected: { sessionId: initial.sessionId, lifecycleRevision: full.lifecycleRevision }, ...overrides };
    const code = `const keepAlive = setInterval(() => {}, 1000); (${executePublicOperation.toString()})(${JSON.stringify(request)}).then(value => { process.send({ status: "passed", value }, () => { clearInterval(keepAlive); process.exit(0); }); }, error => { process.send({ status: "failed", error: error.message }, () => { clearInterval(keepAlive); process.exit(1); }); });`;
    const competing = spawn(process.execPath, ["--input-type=module", "--eval", code], {
      cwd: fixtureRoot, env: { ...process.env }, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let response, errors = "";
    competing.on("message", (message) => { response = message; });
    competing.stderr.on("data", (data) => { errors += data; if (errors.length > 64 * 1024) competing.kill("SIGKILL"); });
    const competingExit = await new Promise((resolve, reject) => {
      competing.once("error", reject); competing.once("close", resolve);
    });
    assert.equal(competingExit, 0, response?.error ?? (errors || "Competing SDK writer did not complete"));
    assert.equal(response?.status, "passed");
    return response.value;
  }
  try {
    process.send?.({ kind: "stage", stage: "committing competing mutation", observed: report });
    const winner = await inFreshProcess("write");
    process.send?.({ kind: "stage", stage: "verifying competing commit", observed: { ...report,
      competingWrite: { displayName: winner?.displayName, lifecycleRevision: winner?.lifecycleRevision } } });
    assert.equal(winner?.displayName, "competing writer");
  } finally { resume(); }
  const conflict = await staleResult;
  assert.equal(conflict.status, "rejected", "Captured-entry writer must refuse a competing commit");
  assert.match(conflict.error.message, /conflict|changed|snapshot/i);
  assert.equal(preparations, 1);
  const observedWinner = await api.getSessionEntryAsync(target);
  process.send?.({ kind: "stage", stage: "verifying post-conflict read", observed: { ...report,
    conflict: { preparations, error: conflict.error.message, postConflictDisplayName: observedWinner?.displayName } } });
  const persistedWinner = await inFreshProcess("read");
  assert.equal(persistedWinner?.displayName, "competing writer");
  report.checks.push({ name: "single preparation and actual captured-entry conflict", status: "passed",
    preparations, competingProcess: true, staleWriteRejected: true, winningWritePreserved: true, error: conflict.error.message });
  // Descriptive full reads are diagnostic facts, never the candidate's effect fence.
  report.checks.push({ name: "post-conflict descriptive latest-read visibility", status: "diagnostic",
    observation: observedWinner?.displayName === "competing writer" ? "current" : "observed-stale",
    originalProcess: observedWinner?.displayName, freshProcess: persistedWinner?.displayName });

  const authorityFields = ["sessionId", "lifecycleRevision", "sessionStartedAt", "agentHarnessId", "cliSessionIds", "pluginExtensions"];
  const authority = (entry) => entry === undefined ? null : Object.fromEntries(authorityFields.map((key) => [key, entry[key]]));
  let captureCurrent;
  try {
    const bindingExportPath = await fs.realpath(require.resolve("openclaw/plugin-sdk/session-binding-runtime"));
    assert.ok(inside(sdkRoot, bindingExportPath));
    const bindingSdk = await import(pathToFileURL(bindingExportPath).href);
    captureCurrent = bindingSdk.captureSessionEntryCurrentCheckAsync;
    report.currentCheckDiagnostic = { path: bindingExportPath,
      sha256: createHash("sha256").update(await fs.readFile(bindingExportPath)).digest("hex"),
      available: typeof captureCurrent === "function", productionDependency: false };
  } catch (error) {
    report.currentCheckDiagnostic = { available: false, productionDependency: false, error: error.message };
  }
  const freshnessCases = [];
  for (const change of ["reset-envelope", "generation-replaced", "session-id-replaced", "deleted"]) {
    process.send?.({ kind: "stage", stage: `foreign session authority: ${change}`, observed: report });
    const caseTarget = { ...target, sessionKey: `agent:main:sdk-freshness-${change}` };
    const seed = { ...initial, sessionId: `sdk-freshness-${change}`, lifecycleRevision: `sdk-freshness-${change}-1`,
      sessionStartedAt: Date.now(), updatedAt: Date.now(), agentHarnessId: "antigravity",
      cliSessionIds: { fixture: "unrelated-native-session" } };
    await api.prepareSessionEntryPatch({ ...caseTarget, fallbackEntry: seed, replaceEntry: true,
      skipMaintenance: true, requireWriteSuccess: true, prepare: () => seed });
    const identity = { openclawSessionId: seed.sessionId, openclawSessionKey: caseTarget.sessionKey,
      agentId: caseTarget.agentId, storePath };
    // Exercise active launch guards for reset/generation and settled delivery
    // guards for replacement/deletion using the candidate's actual binding class.
    const settled = change === "session-id-replaced" || change === "deleted";
    let lease;
    if (candidateBindings) {
      lease = await candidateBindings.beginAttempt({ ...identity, modelId: "isolated-fixture-model",
        scopeKey: "isolated-fixture-scope", assertActive: () => {} });
      if (settled) {
        await candidateBindings.endAttempt(lease, { terminationConfirmed: true });
        await candidateBindings.assertResultCurrent(lease);
      } else await lease.assertCurrent();
      await candidateBindings.resolve(identity);
    }
    const warmed = await api.getSessionEntryAsync(caseTarget);
    assert.equal(warmed?.sessionId, seed.sessionId);
    let baseline;
    await sdk.withSessionEntriesAsync({ stores: [{ agentId: caseTarget.agentId, storePath, sessionKeys: [caseTarget.sessionKey] }],
      env: caseTarget.env }, (rows) => { baseline = rows.find((row) => row.sessionKey === caseTarget.sessionKey)?.entry; });
    assert.deepEqual(authority(baseline), authority(warmed));
    assert.equal(baseline.skillsSnapshot, undefined);
    if (candidateBindings) await api.withCurrentSessionEntry(caseTarget, (entry) => {
      assert.equal(entry?.skillsSnapshot?.prompt, initial.skillsSnapshot.prompt);
    });
    const captured = typeof captureCurrent === "function" ? await captureCurrent({ ...caseTarget,
      expected: warmed, fields: authorityFields, isActive: () => true }) : undefined;
    try {
      if (captured) assert.equal(await captured.isCurrent(), true);
      const previous = warmed.pluginExtensions?.antigravity;
      const patch = change === "reset-envelope" ? { pluginExtensions: { ...warmed.pluginExtensions, antigravity: {
        ...previous, epoch: "foreign-reset-epoch", resetPending: true, activeAttempt: undefined, lastSettledAttempt: undefined,
      } } } : change === "generation-replaced" ? { lifecycleRevision: "foreign-generation" }
        : { sessionId: "foreign-replacement-session", lifecycleRevision: "foreign-generation" };
      const committed = await inFreshProcess(change === "deleted" ? "delete" : "patch-and-read", {
        target: caseTarget, expected: { sessionId: warmed.sessionId, lifecycleRevision: warmed.lifecycleRevision }, patch,
      });
      const durable = committed.entry;
      if (change === "deleted") { assert.equal(committed.deleted, true); assert.equal(durable, undefined); }
      else assert.deepEqual(authority(committed.read), authority(durable));
      const descriptive = await api.getSessionEntryAsync(caseTarget);
      let capturedAssertion = "unavailable", capturedIsCurrent;
      if (captured) {
        capturedIsCurrent = await captured.isCurrent();
        try { await captured.assertCurrent(); capturedAssertion = "accepted"; }
        catch (error) { capturedAssertion = error.message; }
      }
      let selected, selectedEffects = 0;
      await assert.rejects(sdk.withSessionEntriesAsync({
        stores: [{ agentId: caseTarget.agentId, storePath, sessionKeys: [caseTarget.sessionKey] }], env: caseTarget.env,
      }, (rows) => {
        selected = rows.find((row) => row.sessionKey === caseTarget.sessionKey)?.entry;
        if (!isDeepStrictEqual(authority(selected), authority(warmed))) throw new Error("Original session authority changed; effect refused");
        selectedEffects++;
      }), /authority changed/);
      assert.deepEqual(authority(selected), authority(durable));
      assert.equal(selectedEffects, 0);
      const detail = { change, phase: candidateBindings ? (settled ? "settled result" : "active attempt") : "public selected-entry fixture",
        descriptiveObservation: isDeepStrictEqual(authority(descriptive), authority(durable)) ? "current" : "observed-stale",
        capturedCurrentDiagnostic: { isCurrent: capturedIsCurrent, assertCurrent: capturedAssertion },
        selectedMetadataMatchesCommitted: true, selectedSnapshotOmitted: selected?.skillsSnapshot === undefined, selectedEffects };
      if (candidateBindings) {
        let consumerCalls = 0, candidateEffects = 0;
        await assert.rejects(api.withCurrentSessionEntry(caseTarget, (entry) => {
          consumerCalls++;
          if (!isDeepStrictEqual(authority(entry), authority(warmed))) throw new Error("Original session authority changed; effect refused");
          candidateEffects++;
        }), /stale|authority changed|missing|identity/i);
        assert.equal(candidateEffects, 0);
        if (detail.descriptiveObservation === "observed-stale") assert.equal(consumerCalls, 0, "Stale full entry must be rejected before policy consumer");
        await assert.rejects(candidateBindings.resolve(identity), /stale|missing|identity|invalid/i);
        await assert.rejects(settled ? candidateBindings.assertResultCurrent(lease) : lease.assertCurrent(), /stale|missing|identity|invalid/i);
        detail.candidate = { status: "passed", consumerCalls, effects: candidateEffects, resolveRefused: true,
          guard: settled ? "assertResultCurrent" : "lease.assertCurrent", guardRefused: true };
      }
      freshnessCases.push(detail);
    } finally { captured?.release(); }
  }
  report.checks.push({ name: "public selected-entry callback observes foreign session authority", status: "passed",
    fields: authorityFields, cases: freshnessCases });
  if (candidateBindings) report.checks.push({ name: "candidate rejects stale launch and final-result authority", status: "passed",
    activeAttemptRefusals: 2, settledResultRefusals: 2, staleConsumerEffects: 0, fullEntryShapePreserved: true });
  if (observedWinner?.displayName !== "competing writer") {
    report.limitations.push("Raw getSessionEntryAsync latest reads retained stale original-process data; no synchronous fallback, cache invalidation or mutation retry was used.");
    if (!candidateBindings) {
      report.status = "partial";
      report.error = "Raw descriptive reads are stale; rerun with --plugin-root to verify the corrected candidate's callback fence";
    }
  }
  if (freshnessCases.some((entry) => entry.capturedCurrentDiagnostic.isCurrent === true)) {
    report.limitations.push("The diagnostic captureSessionEntryCurrentCheckAsync helper accepted foreign mutations in this artifact; it is not used as the candidate's freshness fence.");
  }
  report.limitations.push("Selected-entry callback observations do not qualify authority after callback return, final host effect ownership, or native/Gateway P05 execution.");
  return report;
}

async function run(options) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const scratchRoot = await fs.realpath(options["scratch-root"]);
  const sdkRoot = await fs.realpath(options["openclaw-root"]);
  const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);
  if (inside(sdkRoot, scratchRoot) || inside(scratchRoot, sdkRoot)) throw new Error("Scratch and SDK package roots must be separate");
  const fixtureRoot = await fs.mkdtemp(path.join(scratchRoot, "sdk-session-contract-"));
  await fs.chmod(fixtureRoot, 0o700);
  const environment = {
    HOME: path.join(fixtureRoot, "home"), OPENCLAW_STATE_DIR: path.join(fixtureRoot, "state"),
    OPENCLAW_CONFIG_PATH: path.join(fixtureRoot, "state", "openclaw.json"), TMPDIR: path.join(fixtureRoot, "tmp"),
    XDG_CONFIG_HOME: path.join(fixtureRoot, "config"), XDG_CACHE_HOME: path.join(fixtureRoot, "cache"),
    XDG_DATA_HOME: path.join(fixtureRoot, "data"), PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    LANG: "C.UTF-8",
  };
  for (const directory of Object.values(environment).filter((value) => inside(fixtureRoot, value) && value !== environment.OPENCLAW_CONFIG_PATH)) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }
  // SDK readers may deliberately unref idle worker handles. Retain this bounded
  // observer process until its awaited work reports; the parent owns its limit.
  const code = `const keepAlive = setInterval(() => {}, 1000); (${observe.toString()})(${JSON.stringify({ ...options, fixtureRoot })}).then(report => { process.send(report, () => { clearInterval(keepAlive); process.exit(0); }); }, error => { process.send({ status: "failed", error: error.message, fixtureRoot: ${JSON.stringify(fixtureRoot)} }, () => { clearInterval(keepAlive); process.exit(1); }); });`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", code], {
    cwd: fixtureRoot, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"], detached: process.platform !== "win32",
  });
  let report, lastStage, observed, stdout = "", stderr = "", timeout = false;
  const kill = () => {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  };
  const timer = setTimeout(() => { timeout = true; kill(); }, options.timeout);
  child.on("message", (message) => {
    if (message.kind === "stage") { lastStage = message.stage; observed = message.observed ?? observed; }
    else report = message;
  });
  child.stdout.on("data", (data) => { stdout += data; if (stdout.length > 128 * 1024) kill(); });
  child.stderr.on("data", (data) => { stderr += data; if (stderr.length > 128 * 1024) kill(); });
  const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }).finally(() => clearTimeout(timer));
  report ??= { ...observed, status: "failed", error: timeout ? `SDK observation exceeded ${options.timeout}ms` : `Child exited ${exit} without a report`, fixtureRoot };
  if (report.status === "failed" && observed) report = { ...observed, ...report };
  if (lastStage) report.lastStage = lastStage;
  report.childExit = exit;
  report.output = { stdout: stdout.trim(), stderr: stderr.trim() };
  if (report.status === "passed" && exit === 0) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    report.fixtureDisposition = "removed after child exit";
  } else {
    if (report.status !== "partial") report.status = "failed";
    report.fixtureDisposition = "retained for diagnosis; no further operation launched";
    process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

try { await run(optionsFrom(process.argv.slice(2))); }
catch (error) { process.stderr.write(`${JSON.stringify({ status: "failed", error: error.message })}\n`); process.exitCode = 1; }
