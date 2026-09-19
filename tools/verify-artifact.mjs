#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { verifyArtifact } from "./build-support.mjs";
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--quiet")) throw new Error("Usage: node tools/verify-artifact.mjs [--quiet]");
  const manifest = await verifyArtifact(fileURLToPath(new URL("../", import.meta.url)));
  if (args[0] !== "--quiet") process.stdout.write(JSON.stringify({ status: "passed", buildSha256: manifest.buildSha256, rebuild: false }) + "\n");
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
