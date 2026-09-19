#!/usr/bin/env node
import { chmod, copyFile, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashFiles, publicFiles, sha256, treeSha256 } from "./build-support.mjs";

export async function exportPublic(root, destination) {
  root = await realpath(root);
  destination = path.resolve(destination);
  if (destination === root || destination.startsWith(`${root}${path.sep}`)) throw new Error("Export destination must be outside the development source");
  const parent = path.dirname(destination);
  if ((await realpath(parent)) !== parent || !(await lstat(parent)).isDirectory()) throw new Error("Export parent must be an existing canonical directory without symlinks");
  const files = await publicFiles(root);
  const entries = await hashFiles(root, files);
  const manifest = { schemaVersion: 1, sourceTreeSha256: treeSha256(entries), files: entries };
  const bytes = JSON.stringify(manifest, null, 2) + "\n";
  // Exclusive creation: never merge with or overwrite an existing export.
  await mkdir(destination);
  for (const name of files) {
    await mkdir(path.dirname(path.join(destination, name)), { recursive: true });
    await copyFile(path.join(root, name), path.join(destination, name));
    await chmod(path.join(destination, name), 0o644);
  }
  if (JSON.stringify(await hashFiles(destination, files)) !== JSON.stringify(entries)) throw new Error("Source changed while exporting; discard the incomplete destination");
  await writeFile(path.join(destination, "public-export-manifest.json"), bytes, { flag: "wx" });
  return { status: "passed", sourceTreeSha256: manifest.sourceTreeSha256, manifestSha256: sha256(bytes), fileCount: files.length, destination };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--output") throw new Error("Usage: npm run export:public -- --output /absolute/new-export-directory");
    process.stdout.write(JSON.stringify(await exportPublic(fileURLToPath(new URL("../", import.meta.url)), process.argv[3])) + "\n");
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
