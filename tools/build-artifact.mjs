#!/usr/bin/env node
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashFiles, normalizePackageModes, publicFiles, run, snapshot, toolchain, treeSha256 } from "./build-support.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
try {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--clean")) throw new Error("Usage: node tools/build-artifact.mjs [--clean]");
  const identity = await toolchain(root, process.argv[2] !== "--clean");
  const inputBefore = process.argv[2] === "--clean" ? null : await hashFiles(root, await publicFiles(root));
  await rm(path.join(root, "dist"), { recursive: true, force: true });
  if (process.argv[2] !== "--clean") {
    run(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], { cwd: root, stdio: "inherit" });
    await mkdir(path.join(root, "dist"), { recursive: true });
    // npm's portable tar mode retains 0600 versus 0644. Canonicalize only the
    // declared regular package payload during build so umask cannot alter it.
    await normalizePackageModes(root);
    const manifest = { schemaVersion: 1, toolchain: identity, ...await snapshot(root) };
    if (JSON.stringify(inputBefore) !== JSON.stringify(manifest.inputs)) throw new Error("Source changed during compilation; discard this build and rebuild from stable inputs");
    const buildSha256 = treeSha256(manifest);
    await writeFile(path.join(root, "dist/build-manifest.json"), JSON.stringify({ ...manifest, buildSha256 }, null, 2) + "\n");
    await chmod(path.join(root, "dist/build-manifest.json"), 0o644);
    process.stdout.write(JSON.stringify({ status: "passed", buildSha256, outputFiles: manifest.outputs.length }) + "\n");
  }
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
