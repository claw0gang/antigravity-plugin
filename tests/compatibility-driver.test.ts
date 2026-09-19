import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const driver = join(root, "tools/check-openclaw-compatibility.mjs");

function makeFixture(t: test.TestContext, options: {
  version?: string; entrySource?: string; terminalSource?: string;
} = {}) {
  const temp = mkdtempSync(join(tmpdir(), "antigravity-compat-driver-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const plugin = join(temp, "plugin");
  const host = join(temp, "host");
  mkdirSync(join(plugin, "node_modules"), { recursive: true });
  mkdirSync(host);
  cpSync(join(root, "dist"), join(plugin, "dist"), { recursive: true });
  cpSync(join(root, "openclaw.plugin.json"), join(plugin, "openclaw.plugin.json"));
  writeFileSync(join(plugin, "README.md"), "Driver test fixture; no installed host qualification.\n");
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  packageJson.files = ["dist", "openclaw.plugin.json", "README.md"];
  writeFileSync(join(plugin, "package.json"), JSON.stringify(packageJson));
  writeFileSync(join(host, "package.json"), JSON.stringify({
    name: "openclaw", version: options.version ?? "2026.9.4", type: "module",
    exports: {
      "./plugin-sdk/plugin-entry": { import: "./entry.js", require: "./wrong-require.js" },
      "./plugin-sdk/agent-harness-runtime": "./terminal.js",
    },
  }));
  writeFileSync(join(host, "entry.js"), options.entrySource ?? "export const definePluginEntry = input => input;\n");
  writeFileSync(join(host, "terminal.js"), options.terminalSource ?? `export const agentHarnessAttemptTerminal = { normalize: input => {
    if (input.promptError) return { kind: 'failed', source: 'prompt', error: input.promptError };
    if (input.timedOut) return { kind: 'timeout', phase: 'prompt', source: 'runtime' };
    return { kind: 'ok' };
  } };\n`);
  writeFileSync(join(host, "wrong-require.js"), "throw new Error('require condition must not be used for ESM plugin');\n");
  symlinkSync(host, join(plugin, "node_modules/openclaw"), "dir");
  return { temp, plugin, host };
}

function check(fixture: { plugin: string; host: string }, extra: string[] = []) {
  return spawnSync(process.execPath, [driver,
    "--expected-hostname", hostname(), "--plugin-root", fixture.plugin,
    "--openclaw-root", fixture.host, ...extra,
  ], { encoding: "utf8", timeout: 8_000, maxBuffer: 1_048_576 });
}

test("driver inspects built plugin with real ESM SDK resolution and records honest evidence", (t) => {
  const fixture = makeFixture(t);
  const result = check(fixture, ["--source-identity", "fixture-source"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.evidenceKind, "SDK import with simulated registration");
  assert.equal(report.runtimePackageVersion, "2026.9.4");
  assert.equal(report.buildSdkVersion, "2026.9.4");
  assert.equal(report.requiredSdk[0].path, join(fixture.host, "entry.js"));
  assert.deepEqual(report.registrations, {
    providers: ["antigravity"], modelCatalogProviders: ["antigravity"],
    agentHarnesses: ["antigravity"], cliBackends: ["antigravity-cli"],
    nativeAutoSelection: [["antigravity"]], discoveryProvider: "antigravity",
  });
  assert.equal(report.installedHostQualification, "pending");
  assert.equal(report.nativeExecutionQualification, "pending");
  assert.equal(report.hostCompatibilityObservation, "read-only-current-host");
  assert.equal(report.P03, "pending");
  assert.equal(report.P05, "pending");
  assert.match(report.artifact.treeSha256, /^[a-f0-9]{64}$/);
  assert.equal(report.artifact.sourceIdentity, "fixture-source");
  assert.match(report.artifact.sourceIdentityBasis, /caller-declared/);
});

test("same built artifact remains eligible across floor and newer stable runtime versions", (t) => {
  const fixture = makeFixture(t, { version: "2026.9.2", entrySource: "export {};\n", terminalSource: "export {};\n" });
  const before = check(fixture);
  assert.equal(before.status, 0, before.stderr);
  const first = JSON.parse(before.stdout);
  assert.equal(first.runtimePackageVersion, "2026.9.2");
  assert.equal(first.buildSdkVersion, "2026.9.4");
  assert.deepEqual(first.optionalHelpers, {
    definePluginEntry: "local-equivalent-fallback",
    "agentHarnessAttemptTerminal.normalize": "local-equivalent-fallback",
  });
  const hostPackage = JSON.parse(readFileSync(join(fixture.host, "package.json"), "utf8"));
  hostPackage.version = "2026.10.0";
  writeFileSync(join(fixture.host, "package.json"), JSON.stringify(hostPackage));
  const after = check(fixture);
  assert.equal(after.status, 0, after.stderr);
  const second = JSON.parse(after.stdout);
  assert.equal(second.artifact.treeSha256, first.artifact.treeSha256);
  assert.equal(second.runtimePackageVersion, "2026.10.0");
  assert.equal(second.compatibility.status, "eligible");
  assert.equal(second.hostCompatibilityObservation, "read-only-current-host");
  writeFileSync(join(fixture.plugin, "README.md"), "A different shipped artifact.\n");
  const changed = check(fixture);
  assert.equal(changed.status, 0, changed.stderr);
  assert.notEqual(JSON.parse(changed.stdout).artifact.treeSha256, first.artifact.treeSha256);
});

test("hostname mismatch wins before invalid filesystem roots are touched", () => {
  const result = spawnSync(process.execPath, [driver,
    "--expected-hostname", `${hostname()}-different`,
    "--plugin-root", "/does-not-exist-antigravity-driver",
    "--openclaw-root", "/does-not-exist-openclaw-driver",
  ], { encoding: "utf8", timeout: 3_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Hostname mismatch.*no candidate files read/);
  assert.doesNotMatch(result.stderr, /ENOENT|realpath/);
});

for (const version of ["2026.9.1", "2026.9.4-beta.1"]) {
  test(`driver rejects host version ${version}`, (t) => {
    const result = check(makeFixture(t, { version }));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unsupported OpenClaw runtime.version/);
    assert.equal(result.stdout, "");
  });
}

for (const version of ["2026.10.0", "2027.1.0", "2030.12.31"]) {
  test(`driver accepts newer stable host version ${version} when required public contracts remain present`, (t) => {
    const result = check(makeFixture(t, { version }));
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.runtimePackageVersion, version);
    assert.equal(report.compatibility.status, "eligible");
  });
}

test("driver detects actual SDK root mismatch despite identical host metadata", (t) => {
  const fixture = makeFixture(t);
  const wrongRoot = join(fixture.temp, "other-openclaw");
  mkdirSync(wrongRoot);
  cpSync(join(fixture.host, "package.json"), join(wrongRoot, "package.json"));
  const result = check({ ...fixture, host: wrongRoot });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SDK root mismatch/);
});

test("missing required module is not mistaken for an absent optional helper", (t) => {
  const fixture = makeFixture(t);
  const hostPackage = JSON.parse(readFileSync(join(fixture.host, "package.json"), "utf8"));
  delete hostPackage.exports["./plugin-sdk/plugin-entry"];
  writeFileSync(join(fixture.host, "package.json"), JSON.stringify(hostPackage));
  const result = check(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Required SDK subpath.*cannot resolve/);
});

test("transitive SDK dependency failure remains actionable", (t) => {
  const fixture = makeFixture(t, { entrySource: "import 'antigravity-deliberately-missing-sdk-dependency'; export {};\n" });
  const result = check(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /module load failed.*antigravity-deliberately-missing-sdk-dependency.*transitive dependencies/);
});

test("throwing helper remains a real error and cannot silently fall back", (t) => {
  const fixture = makeFixture(t, { entrySource: "export const definePluginEntry = () => { throw new Error('host helper defect'); };\n" });
  const result = check(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /host helper defect/);
});

test("malformed optional terminal helper cannot obtain a successful report", (t) => {
  const fixture = makeFixture(t, { terminalSource: "export const agentHarnessAttemptTerminal = { normalize: () => ({ kind: 'made-up' }) };\n" });
  const result = check(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /malformed OpenClaw agentHarnessAttemptTerminal.normalize result/);
});

test("registration that attempts a host session service fails without native work", (t) => {
  const fixture = makeFixture(t);
  writeFileSync(join(fixture.plugin, "dist/index.js"), "export default { id: 'antigravity', register(api) { api.runtime.agent.session.getSessionEntry(); } };\n");
  const result = check(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /forbids host session services/);
});

for (const hang of ["import", "registration"]) {
  test(`driver kills a hanging ${hang} within its bounded deadline`, (t) => {
    const fixture = makeFixture(t);
    writeFileSync(join(fixture.plugin, "dist/index.js"), hang === "import"
      ? "while (true) {}\n"
      : "export default { id: 'antigravity', register() { while (true) {} } };\n");
    const result = check(fixture, ["--timeout-ms", "500"]);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /exceeded 500ms.*killed/);
  });
}

test("driver rejects a candidate that registers CLI as the native provider", (t) => {
  const fixture = makeFixture(t);
  const indexPath = join(fixture.plugin, "dist/index.js");
  const entry = readFileSync(indexPath, "utf8");
  writeFileSync(indexPath, entry.replace("api.registerCliBackend(buildAntigravityCliBackend(config));", "api.registerCliBackend({ ...buildAntigravityCliBackend(config), id: 'antigravity' });"));
  const result = check(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unexpected public registration identities/);
});
