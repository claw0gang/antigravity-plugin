#!/usr/bin/env node
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { packageFiles, readJson, run, verifyArtifact } from "./build-support.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
try {
  const manifest = await verifyArtifact(root);
  const packed = JSON.parse(run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { cwd: root }));
  const entries = Array.isArray(packed) ? packed : (packed && typeof packed === "object" ? Object.values(packed) : []);
  assert.equal(entries.length, 1, "npm pack --json must describe exactly one package");
  const pack = entries[0];
  const actual = pack.files.map((item) => item.path).sort();
  assert.deepEqual(actual, await packageFiles(root), "npm packed file list differs from explicit runtime package inputs");
  const pkg = await readJson(new URL("../package.json", import.meta.url));
  const plugin = await readJson(new URL("../openclaw.plugin.json", import.meta.url));
  for (const entry of [pkg.main, pkg.types, ...pkg.openclaw.extensions, ...pkg.openclaw.runtimeExtensions, plugin.providerCatalogEntry]) {
    assert.ok(actual.includes(entry.replace(/^\.\//, "")), `Missing package entry: ${entry}`);
  }
  process.stdout.write(JSON.stringify({ status: "passed", buildSha256: manifest.buildSha256, filename: pack.filename, fileCount: actual.length, packageIntegrity: pack.integrity, packageShasum: pack.shasum }) + "\n");
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
