#!/usr/bin/env node
// Direct, credential-free SDK import and simulated registration. This never
// qualifies the installed gateway, native AGY execution, or host P03/P05 behavior.
import { hostname } from "node:os";
import { spawn } from "node:child_process";

function fail(message) {
  process.stderr.write(`${JSON.stringify({ status: "failed", error: message })}\n`);
  process.exitCode = 1;
}

function optionsFrom(argv) {
  const allowed = new Set(["expected-hostname", "plugin-root", "openclaw-root", "source-identity", "timeout-ms"]);
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (!argv[i]?.startsWith("--") || !allowed.has(key) || result[key] !== undefined || !argv[i + 1]) {
      throw new Error("Usage: --expected-hostname NAME --plugin-root PATH --openclaw-root PATH [--source-identity REVISION] [--timeout-ms 10000]");
    }
    result[key] = argv[i + 1];
  }
  if (!result["expected-hostname"]) throw new Error("--expected-hostname is required");
  // This gate deliberately precedes imports that inspect files, path resolution,
  // candidate imports, subprocess creation, or any host interaction.
  if (hostname() !== result["expected-hostname"]) {
    throw new Error(`Hostname mismatch: expected ${JSON.stringify(result["expected-hostname"])}, observed ${JSON.stringify(hostname())}; no candidate files read`);
  }
  if (!result["plugin-root"] || !result["openclaw-root"]) throw new Error("--plugin-root and --openclaw-root are required");
  const timeout = result["timeout-ms"] === undefined ? 10_000 : Number(result["timeout-ms"]);
  if (!Number.isInteger(timeout) || timeout < 50 || timeout > 60_000) throw new Error("--timeout-ms must be an integer from 50 through 60000");
  return { ...result, timeout };
}

// Serialized into a child with no inherited credentials or NODE_OPTIONS. Its
// entire filesystem/import/registration operation is bounded by the parent.
async function inspectCandidate(options) {
  const os = await import("node:os");
  if (os.hostname() !== options["expected-hostname"]) throw new Error("Hostname changed before inspection; no candidate files read");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { pathToFileURL, fileURLToPath } = await import("node:url");
  const { createHash } = await import("node:crypto");
  const { isDeepStrictEqual } = await import("node:util");
  const pluginRoot = await fs.realpath(options["plugin-root"]);
  const hostRoot = await fs.realpath(options["openclaw-root"]);
  const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);
  const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
  const pkg = await readJson(path.join(pluginRoot, "package.json"));
  const host = await readJson(path.join(hostRoot, "package.json"));
  if (pkg.name !== "@claw0gang/antigravity" || host.name !== "openclaw") {
    throw new Error("Explicit roots must contain @claw0gang/antigravity and openclaw packages respectively");
  }
  const entry = pathToFileURL(path.join(pluginRoot, "dist/index.js")).href;
  const sdkPaths = ["openclaw/plugin-sdk/plugin-entry", "openclaw/plugin-sdk/agent-harness-runtime"];
  const resolvedSdk = [];
  for (const specifier of sdkPaths) {
    let url;
    try { url = import.meta.resolve(specifier, entry); }
    catch (error) { throw new Error(`Required SDK subpath ${specifier} cannot resolve from ${entry}: ${error.message}`, { cause: error }); }
    if (!url.startsWith("file:")) throw new Error(`Required SDK subpath ${specifier} resolved to non-file URL ${url}`);
    const actual = await fs.realpath(fileURLToPath(url));
    if (!inside(hostRoot, actual)) {
      throw new Error(`SDK root mismatch for ${specifier}: resolved ${actual}; expected under exact host root ${hostRoot}`);
    }
    resolvedSdk.push({ specifier, path: actual, url });
  }

  // Hash shipped artifact paths, not dependency trees or mutable repository state.
  // The digest identifies the exact candidate inspected against the current host.
  const names = new Set(["package.json", "openclaw.plugin.json", "README.md", ...(pkg.files ?? [])]);
  const artifactFiles = new Map();
  async function addArtifact(relative) {
    if (typeof relative !== "string" || path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => part === "..") || /[*?\[\]{}!]/.test(relative)) {
      throw new Error(`Artifact files must be explicit relative paths: ${JSON.stringify(relative)}`);
    }
    const full = path.join(pluginRoot, relative);
    const info = await fs.lstat(full);
    if (info.isSymbolicLink()) throw new Error(`Artifact symlinks are not supported: ${relative}`);
    if (info.isDirectory()) {
      for (const child of (await fs.readdir(full)).sort()) await addArtifact(path.join(relative, child));
    } else if (info.isFile()) {
      artifactFiles.set(relative.split(path.sep).join("/"), createHash("sha256").update(await fs.readFile(full)).digest("hex"));
    } else throw new Error(`Artifact entry is not a regular file or directory: ${relative}`);
  }
  for (const name of names) await addArtifact(name);
  const artifactEntries = [...artifactFiles].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const treeSha256 = createHash("sha256").update(JSON.stringify(artifactEntries)).digest("hex");
  const manifest = await readJson(path.join(pluginRoot, "openclaw.plugin.json"));
  let compatibilityModule, pluginModule, discoveryModule, sdk;
  try {
    compatibilityModule = await import(pathToFileURL(path.join(pluginRoot, "dist/host/compatibility.js")).href);
    if (!isDeepStrictEqual([...compatibilityModule.OPENCLAW_REQUIRED_SDK_SUBPATHS], sdkPaths)) {
      throw new Error("Driver required SDK subpaths disagree with built adapter; update the driver for this artifact");
    }
    sdk = await Promise.all(resolvedSdk.map(({ url }) => import(url)));
    pluginModule = await import(entry);
    discoveryModule = await import(pathToFileURL(path.join(pluginRoot, "dist/provider-discovery.js")).href);
    const terminalModule = await import(pathToFileURL(path.join(pluginRoot, "dist/host/terminal.js")).href);
    terminalModule.agentHarnessAttemptTerminal.normalize({});
    terminalModule.agentHarnessAttemptTerminal.normalize({ timedOut: true });
    terminalModule.agentHarnessAttemptTerminal.normalize({ promptError: new Error("compatibility driver pure terminal probe") });
  } catch (error) {
    throw new Error(`Built plugin / required SDK module load failed: ${error.message}; inspect the exact installed SDK exports and its transitive dependencies`, { cause: error });
  }
  const captured = { providers: [], catalogs: [], harnesses: [], cliBackends: [] };
  const noRuntime = () => { throw new Error("Driver forbids host session services during simulated registration"); };
  const api = {
    pluginConfig: {},
    runtime: { version: host.version, agent: { session: { getSessionEntry: noRuntime, patchSessionEntry: noRuntime } } },
    registerProvider: (value) => captured.providers.push(value),
    registerModelCatalogProvider: (value) => captured.catalogs.push(value),
    registerAgentHarness: (value) => captured.harnesses.push(value),
    registerCliBackend: (value) => captured.cliBackends.push(value),
  };
  const compatibility = compatibilityModule.inspectOpenClawCompatibility(api);
  if (compatibility.status !== "eligible") throw new Error(`Runtime compatibility rejected: ${compatibility.diagnostics.join(" ")}`);
  if (pkg.openclaw?.build?.pluginSdkVersion !== compatibility.buildSdkVersion ||
      pkg.openclaw?.build?.openclawVersion !== compatibility.buildSdkVersion) {
    throw new Error("Built adapter SDK provenance disagrees with package openclaw.build metadata");
  }
  if (compatibility.hostObservation !== "read-only-public-contract") {
    throw new Error("Built adapter does not declare the required read-only host observation boundary");
  }
  const plugin = pluginModule.default;
  if (plugin?.id !== "antigravity" || typeof plugin.register !== "function") throw new Error("Built plugin has no expected public registration entry");
  await plugin.register(api);
  const registrations = {
    providers: captured.providers.map((value) => value.id),
    modelCatalogProviders: captured.catalogs.map((value) => value.provider),
    agentHarnesses: captured.harnesses.map((value) => value.id),
    cliBackends: captured.cliBackends.map((value) => value.id),
    nativeAutoSelection: captured.harnesses.map((value) => value.autoSelection?.providerIds),
    discoveryProvider: discoveryModule.default?.id,
  };
  const expected = {
    providers: ["antigravity"], modelCatalogProviders: ["antigravity"],
    agentHarnesses: ["antigravity"], cliBackends: ["antigravity-cli"],
    nativeAutoSelection: [["antigravity"]], discoveryProvider: "antigravity",
  };
  if (!isDeepStrictEqual(registrations, expected)) throw new Error(`Unexpected public registration identities or native auto-selection: ${JSON.stringify(registrations)}`);
  if (manifest.providerCatalogEntry !== "./dist/provider-discovery.js" ||
      !isDeepStrictEqual(manifest.providers, ["antigravity"]) ||
      !isDeepStrictEqual(manifest.cliBackends, ["antigravity-cli"])) {
    throw new Error("Plugin manifest does not preserve native provider and explicit, disjoint CLI registration");
  }
  const harness = captured.harnesses[0];
  if (typeof harness.supports !== "function" ||
      harness.supports({ provider: "antigravity", providerOwnerStatus: "owned", providerOwnerPluginIds: ["antigravity"] })?.supported !== true ||
      harness.supports({ provider: "antigravity-cli" })?.supported !== false) {
    throw new Error("Native harness must select antigravity and reject the explicit CLI namespace");
  }
  return {
    status: "passed", evidenceKind: "SDK import with simulated registration",
    hostname: os.hostname(), pluginRoot, openclawRoot: hostRoot,
    artifact: { algorithm: "sha256(JSON.stringify(sorted [relative-path,file-sha256] pairs))", treeSha256, fileCount: artifactEntries.length,
      sourceIdentity: options["source-identity"] ?? null, sourceIdentityBasis: "caller-declared; artifact bytes measured separately" },
    runtimeNode: { version: process.version, executable: process.execPath, executableSha256: createHash("sha256").update(await fs.readFile(process.execPath)).digest("hex") },
    runtimePackageVersion: host.version, buildSdkVersion: compatibility.buildSdkVersion,
    requiredSdk: resolvedSdk.map(({ specifier, path }) => ({ specifier, path })),
    optionalHelpers: {
      definePluginEntry: sdk[0].definePluginEntry === undefined ? "local-equivalent-fallback" : "host-export-present",
      "agentHarnessAttemptTerminal.normalize": sdk[1].agentHarnessAttemptTerminal === undefined ? "local-equivalent-fallback" : "host-export-present",
    },
    compatibility, registrations,
    cliFallback: "No implicit CLI selection in the checked registration: antigravity-cli is a disjoint explicit namespace; runtime routing remains unqualified",
    installedHostQualification: "pending", nativeExecutionQualification: "pending",
    P03: "pending", P05: "pending", hostCompatibilityObservation: "read-only-current-host",
  };
}

function run(options) {
  const code = `(${inspectCandidate.toString()})(${JSON.stringify(options)}).then(report => { process.stdout.write(JSON.stringify(report) + "\\n"); }, error => { process.stderr.write(JSON.stringify({status:"failed",error:error.message}) + "\\n"); process.exitCode = 1; });`;
  const child = spawn(process.execPath, ["--experimental-import-meta-resolve", "--input-type=module", "--eval", code], {
    env: { NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
  });
  let stdout = "", stderr = "", failed = false;
  const kill = (message) => {
    if (failed) return;
    failed = true;
    try { if (process.platform === "win32") child.kill("SIGKILL"); else process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    fail(message);
  };
  const timer = setTimeout(() => kill(`Compatibility inspection exceeded ${options.timeout}ms; import/registration process was killed`), options.timeout);
  child.stdout.on("data", (data) => { stdout += data; if (stdout.length > 256 * 1024) kill("Compatibility child exceeded output limit"); });
  child.stderr.on("data", (data) => { stderr += data; if (stderr.length > 256 * 1024) kill("Compatibility child exceeded error output limit"); });
  child.once("error", (error) => { clearTimeout(timer); if (!failed) { failed = true; fail(`Cannot launch bounded inspection: ${error.message}`); } });
  child.once("close", (code) => {
    clearTimeout(timer);
    if (failed) return;
    if (code !== 0) return fail(`Compatibility inspection failed: ${stderr.trim() || `exit ${code}`}`);
    try {
      const report = JSON.parse(stdout);
      if (report.status !== "passed" || report.evidenceKind !== "SDK import with simulated registration") throw new Error("Invalid child evidence record");
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } catch (error) { fail(`Cannot parse bounded inspection evidence: ${error.message}`); }
  });
}

try { run(optionsFrom(process.argv.slice(2))); } catch (error) { fail(error.message); }
