import assert from "node:assert/strict";
import test from "node:test";
import { resolveAntigravityPluginConfig } from "../src/config.ts";

test("dangerous permission bypass remains default-off and explicit-only", () => {
  assert.equal(resolveAntigravityPluginConfig(undefined).dangerouslySkipPermissions, false);
  assert.equal(
    resolveAntigravityPluginConfig({ dangerouslySkipPermissions: false }).dangerouslySkipPermissions,
    false,
  );
  assert.equal(
    resolveAntigravityPluginConfig({ dangerouslySkipPermissions: true }).dangerouslySkipPermissions,
    true,
  );
});

test("configuration fails closed on unknown or contradictory values", () => {
  assert.throws(
    () => resolveAntigravityPluginConfig({ unknown: true }),
    /unknown antigravity config key/,
  );
  assert.throws(
    () => resolveAntigravityPluginConfig({ project: "one", newProject: true }),
    /mutually exclusive/,
  );
  assert.throws(
    () => resolveAntigravityPluginConfig({ mode: "dangerous" }),
    /accept-edits or plan/,
  );
  assert.throws(
    () => resolveAntigravityPluginConfig({ addDirs: ["/one", "/one"] }),
    /must not contain duplicates/,
  );
});

test("default execution mode stays explicit and never inherits AGY auto or orchestrator", () => {
  assert.equal(resolveAntigravityPluginConfig({}).mode, "accept-edits");
  assert.equal(resolveAntigravityPluginConfig({ mode: "plan" }).mode, "plan");
  for (const mode of ["auto", "orchestrator"]) assert.throws(() => resolveAntigravityPluginConfig({ mode }), /accept-edits or plan/);
});
