import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ANTIGRAVITY_CONFIRMED_MODEL_IDS,
  ANTIGRAVITY_MODEL_ALIASES,
} from "../src/model-aliases.ts";

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

const expectedCliIds = [
  ...new Set([
    ...Object.keys(ANTIGRAVITY_MODEL_ALIASES),
    ...ANTIGRAVITY_CONFIRMED_MODEL_IDS,
  ]),
].sort();

const removedGeminiAliases = [
  "gemini-high",
  "gemini-medium",
  "gemini-low",
  "gemini-3.5-high",
  "gemini-3.5-medium",
  "gemini-3.5-low",
  "gemini-pro-high",
  "gemini-pro-low",
] as const;

function assertStaticRows(rows: ModelRow[], label: string): void {
  assert.deepEqual(
    rows.map((row) => row.id).sort(),
    expectedCliIds,
    `${label} model ids drifted`,
  );
  for (const row of rows) {
    assert.equal(
      row.reasoning,
      false,
      `${label}/${row.id} must not advertise host-adjustable reasoning controls`,
    );
  }
}

test("manifest reserves antigravity for the harness and exposes only antigravity-cli as CLI", () => {
  assert.deepEqual(manifest.providers, ["antigravity"]);
  assert.equal(manifest.providerCatalogEntry, "./dist/provider-discovery.js");
  assert.equal(manifest.activation?.onStartup, true);
  assert.deepEqual(manifest.activation?.onProviders, ["antigravity"]);
  assert.deepEqual(manifest.activation?.onAgentHarnesses, ["antigravity"]);
  assert.deepEqual(manifest.cliBackends, ["antigravity-cli"]);
  assert.deepEqual(manifest.setup?.cliBackends, ["antigravity-cli"]);
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
  assert.match(property?.description ?? "", /compatibility CLI/i);
  assert.match(property?.description ?? "", /always-proceed/i);
  assert.match(property?.description ?? "", /disabled by default/i);
});

test("native antigravity declares refreshable scoped discovery without static executable rows", () => {
  assert.equal(manifest.providerCatalogEntry, "./dist/provider-discovery.js");
  assert.deepEqual(manifest.syntheticAuthRefs, ["antigravity"]);
  assert.equal(manifest.nonSecretAuthMarkers, undefined);
  assert.equal(manifest.modelCatalog?.providers?.antigravity, undefined);
  assert.equal(manifest.modelCatalog?.discovery?.antigravity, "refreshable");
  assert.equal(manifest.modelCatalog?.runtimeAugment, true);
  assert.equal(manifest.modelCatalog?.discovery?.["antigravity-cli"], "static");
  assertStaticRows(
    manifest.modelCatalog?.providers?.["antigravity-cli"]?.models ?? [],
    "antigravity-cli",
  );
});

test("compatibility manifest exposes exact Gemini 3.8 ids and no Gemini aliases", () => {
  const rows = manifest.modelCatalog?.providers?.["antigravity-cli"]?.models ?? [];
  const ids = new Set(rows.map((row) => row.id));
  assert.ok(ids.has("gemini-3.8-flash-high"));
  assert.ok(ids.has("gemini-3.8-flash-medium"));
  assert.ok(ids.has("gemini-3.8-flash-low"));
  for (const alias of removedGeminiAliases) {
    assert.ok(!ids.has(alias), `removed Gemini alias still present: ${alias}`);
  }
});
