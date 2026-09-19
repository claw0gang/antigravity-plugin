import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");

test("qualification documentation enforces the production OpenClaw read-only boundary", async () => {
  const doc = await readFile(join(root, "docs/QUALIFICATION.md"), "utf8");

  assert.match(doc, /Qualification proves ANTIGRAVITY\. It does not qualify, install, upgrade, downgrade, restart, reconfigure, patch, or otherwise manage OpenClaw\./);
  assert.match(doc, /production host is context only/);
  assert.match(doc, /must not use production OpenClaw as a version-matrix or upgrade test subject/);
  assert.match(doc, /runtime host admission is not pinned to that exact release or calendar family/);
  assert.match(doc, /newer stable OpenClaw release is not rejected merely because its version number moved forward/);
  assert.match(doc, /Production compatibility is read-only\./);

  for (const command of [
    "npm ci --ignore-scripts --no-audit --no-fund",
    "npm run build",
    "npm test",
    "npm run test:source",
    "npm run test:build-tools",
    "npm run pack:check",
  ]) {
    assert.match(doc, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.doesNotMatch(doc, /<<['\"]?PY['\"]?/);
  assert.doesNotMatch(doc, /same-artifact host upgrade/i);
  assert.doesNotMatch(doc, /2026\.9\.2\s*(?:→|->)\s*2026\.9\.4/);
  assert.doesNotMatch(doc, /OpenClaw Gateway restart/);
});
