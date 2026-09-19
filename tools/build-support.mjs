import { createHash } from "node:crypto";
import { chmod, lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const treeSha256 = (entries) => sha256(JSON.stringify(entries));
export const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

export function relativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || path.posix.isAbsolute(value) ||
      value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Expected a plain relative path: ${JSON.stringify(value)}`);
  }
  return value;
}

export async function filesUnder(root, names) {
  const found = new Set();
  async function visit(name) {
    relativePath(name);
    // Refuse symlinked ancestors as well as leaves: an allowlist must not become
    // a way to copy private files from elsewhere on the machine.
    let current = root;
    for (const part of name.split("/")) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symlinks are forbidden: ${name}`);
    }
    const info = await lstat(current);
    if (info.isDirectory()) {
      for (const child of (await readdir(current)).sort()) await visit(`${name}/${child}`);
    } else if (info.isFile()) found.add(name);
    else throw new Error(`Not a regular file: ${name}`);
  }
  for (const name of names) await visit(name);
  return [...found].sort();
}

export async function hashFiles(root, names) {
  const entries = [];
  for (const name of [...names].sort()) entries.push([name, sha256(await readFile(path.join(root, name)))]);
  return entries;
}

export async function publicFiles(root) {
  const config = await readJson(path.join(root, "public-export.json"));
  if (config.schemaVersion !== 1 || !Array.isArray(config.files) || !config.files.length) throw new Error("Invalid public export allowlist");
  if (new Set(config.files).size !== config.files.length) throw new Error("Duplicate public export entry");
  for (const name of config.files) {
    relativePath(name);
    if (name.split("/").some((part) => [".git", ".state", "ops", "operations", "node_modules", "dist"].includes(part)) ||
        name.split("/").some((part) => part === ".env" || part.startsWith(".env.")) ||
        /(?:^|\/)(?:FRESH-SESSION-HANDOVER|P02T\d+-SOURCE)\.md$/.test(name)) throw new Error(`Private/generated path in public export: ${name}`);
    if (!(await lstat(path.join(root, name))).isFile()) throw new Error(`Public allowlist must name individual regular files: ${name}`);
  }
  // These trees are direct compiler/test/tool inputs. An unlisted addition must
  // fail instead of silently creating a different development and public build.
  for (const directory of ["src", "tests", "tools"]) {
    const info = await lstat(path.join(root, directory)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) continue;
    for (const name of await filesUnder(root, [directory])) {
      if (!config.files.includes(name)) throw new Error(`Compiler/test/tool input missing from public allowlist: ${name}`);
    }
  }
  return filesUnder(root, config.files);
}

export function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${program} failed: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`);
  return (result.stdout ?? "").trim();
}

function versionTuple(value, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error(`${label} must be a stable semantic version`);
  return match.slice(1).map(Number);
}

function atLeast(actual, floor) {
  const left = versionTuple(actual, "Observed Node version");
  const right = versionTuple(floor, "Node support floor");
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

export async function toolchain(root, installed = false) {
  const wanted = await readJson(path.join(root, "build-toolchain.json"));
  const pkg = await readJson(path.join(root, "package.json"));
  const lock = await readJson(path.join(root, "package-lock.json"));
  const range = typeof wanted.node === "string" ? /^>=(\d+\.\d+\.\d+)$/.exec(wanted.node) : null;
  if (wanted.schemaVersion !== 2 || !range || wanted.npm !== "environment") {
    throw new Error("Invalid build compatibility contract");
  }
  if (pkg.engines?.node !== wanted.node || lock.packages?.[""]?.engines?.node !== wanted.node) {
    throw new Error("Node support range differs between build contract, package and lockfile");
  }
  if (!atLeast(process.versions.node, range[1])) {
    throw new Error(`Node ${process.versions.node} is outside supported range ${wanted.node}`);
  }
  if (lock.lockfileVersion !== 3) throw new Error("Unsupported lockfile format");
  if (pkg.devDependencies.openclaw !== wanted.openclawSdk || pkg.openclaw.build.pluginSdkVersion !== wanted.openclawSdk || pkg.openclaw.build.openclawVersion !== wanted.openclawSdk) throw new Error("OpenClaw SDK provenance mismatch");
  for (const [name, version] of Object.entries(pkg.devDependencies)) {
    if (!/^\d+\.\d+\.\d+$/.test(version) || lock.packages[""]?.devDependencies?.[name] !== version || lock.packages[`node_modules/${name}`]?.version !== version) throw new Error(`Dependency is not exactly locked: ${name}`);
    if (installed && (await readJson(path.join(root, "node_modules", name, "package.json"))).version !== version) throw new Error(`Installed dependency differs from lock: ${name}`);
  }
  return { node: wanted.node, npm: wanted.npm, openclawSdk: wanted.openclawSdk, devDependencies: pkg.devDependencies };
}

export async function packageFiles(root) {
  const pkg = await readJson(path.join(root, "package.json"));
  return filesUnder(root, ["package.json", ...pkg.files]);
}

export async function normalizePackageModes(root) {
  for (const name of await packageFiles(root)) await chmod(path.join(root, name), 0o644);
}

export async function snapshot(root) {
  const inputs = await hashFiles(root, await publicFiles(root));
  const outputNames = (await filesUnder(root, ["dist"])).filter((name) => name !== "dist/build-manifest.json");
  const outputs = await hashFiles(root, outputNames);
  const packed = await hashFiles(root, (await packageFiles(root)).filter((name) => name !== "dist/build-manifest.json"));
  return { inputs, outputs, packed };
}

export async function verifyArtifact(root) {
  const manifest = await readJson(path.join(root, "dist/build-manifest.json"));
  const observed = { schemaVersion: 1, toolchain: await toolchain(root), ...await snapshot(root) };
  const buildSha256 = treeSha256(observed);
  if (manifest.buildSha256 !== buildSha256 || JSON.stringify(manifest) !== JSON.stringify({ ...observed, buildSha256 })) {
    throw new Error("Qualified build inputs or packed bytes changed; run the complete build/check/qualification path again before packing");
  }
  for (const name of await packageFiles(root)) {
    if (((await lstat(path.join(root, name))).mode & 0o7777) !== 0o644) {
      throw new Error(`Noncanonical package mode: ${name}; require 0644, rebuild before packing`);
    }
  }
  return manifest;
}
