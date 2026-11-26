import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type ModelRow = { id: string; reasoning?: boolean };
type ConfigProperty = { type?: string; description?: string };

const manifest = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as {
  providers?: string[];
  providerCatalogEntry?: string;
  syntheticAuthRefs?: string[];
  nonSecretAuthMarkers?: string[];
  activation?: {
    onStartup?: boolean;
    onProviders?: string[];
    onAgentHarnesses?: string[];
  };
  cliBackends?: string[];
  skills?: string[];
  setup?: { cliBackends?: string[] };
  configSchema?: { properties?: Record<string, ConfigProperty> };
  configContracts?: {
    dangerousFlags?: Array<{ path?: string; equals?: unknown }>;
  };
  modelCatalog?: {
    providers?: {
      antigravity?: { models?: ModelRow[] };
      "antigravity-cli"?: { models?: ModelRow[] };
    };
    discovery?: { antigravity?: string; "antigravity-cli"?: string };
    runtimeAugment?: boolean;
  };
};

test("manifest exposes one native provider with no generic backend or setup alias", () => {
  assert.deepEqual(manifest.providers, ["antigravity"]);
  assert.equal(manifest.providerCatalogEntry, "./dist/provider-discovery.js");
  assert.equal(manifest.activation?.onStartup, true);
  assert.deepEqual(manifest.activation?.onProviders, ["antigravity"]);
  assert.deepEqual(manifest.activation?.onAgentHarnesses, ["antigravity"]);
  assert.equal(manifest.cliBackends, undefined);
  assert.equal(manifest.setup, undefined);
  assert.deepEqual(manifest.skills, ["./skills"]);
  assert.ok(!manifest.cliBackends?.includes("antigravity"));
  assert.ok(!manifest.setup?.cliBackends?.includes("antigravity"));
});

test("manifest keeps the dangerous permission bypass explicit, default-off, and accurately scoped", () => {
  assert.deepEqual(manifest.configContracts?.dangerousFlags, [
    { path: "dangerouslySkipPermissions", equals: true },
  ]);
  const property = manifest.configSchema?.properties?.dangerouslySkipPermissions;
  assert.equal(property?.type, "boolean");
  assert.match(property?.description ?? "", /native harness/i);
  assert.doesNotMatch(property?.description ?? "", /compatibility CLI/i);
  assert.match(property?.description ?? "", /always-proceed/i);
  assert.match(property?.description ?? "", /disabled by default/i);
});

test("native antigravity declares refreshable scoped discovery without static executable rows", () => {
  assert.equal(manifest.providerCatalogEntry, "./dist/provider-discovery.js");
  assert.equal(manifest.syntheticAuthRefs, undefined);
  assert.equal(manifest.nonSecretAuthMarkers, undefined);
  assert.equal(manifest.modelCatalog?.providers?.antigravity, undefined);
  assert.equal(manifest.modelCatalog?.discovery?.antigravity, "refreshable");
  assert.equal(manifest.modelCatalog?.runtimeAugment, true);
  assert.deepEqual(manifest.modelCatalog?.discovery, { antigravity: "refreshable" });
  assert.equal(manifest.modelCatalog?.providers, undefined);
});

test("every supported config key has operator-facing help text", () => {
  const properties = manifest.configSchema?.properties ?? {};
  for (const key of [
    "command", "printTimeout", "sandbox", "dangerouslySkipPermissions", "mode",
    "agent", "project", "newProject", "addDirs", "logFile",
  ]) {
    assert.ok(properties[key]?.description?.trim(), `missing description for ${key}`);
  }
  assert.match(properties.mode?.description ?? "", /accept-edits/);
  assert.match(properties.mode?.description ?? "", /plan/);
  assert.match(properties.project?.description ?? "", /workspace\/cwd/i);
});
