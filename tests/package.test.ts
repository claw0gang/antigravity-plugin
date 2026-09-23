import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  version?: string;
  main?: string;
  types?: string;
  files?: string[];
  scripts?: Record<string, string>;
  openclaw?: {
    extensions?: string[];
    runtimeExtensions?: string[];
    compat?: { pluginApi?: string; minGatewayVersion?: string };
    build?: { openclawVersion?: string; pluginSdkVersion?: string };
  };
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

test("minimum OpenClaw runtime range stays distinct from exact SDK build provenance", () => {
  assert.equal(pkg.version, "0.3.2");
  assert.equal(pkg.openclaw?.compat?.pluginApi, ">=2026.9.2");
  assert.equal(pkg.openclaw?.compat?.minGatewayVersion, ">=2026.9.2");
  assert.equal(pkg.openclaw?.build?.openclawVersion, "2026.9.4");
  assert.equal(pkg.openclaw?.build?.pluginSdkVersion, "2026.9.4");
  assert.equal(pkg.peerDependencies?.openclaw, ">=2026.9.2");
  assert.equal(pkg.devDependencies?.openclaw, "2026.9.4");
  assert.notEqual(pkg.openclaw?.compat?.pluginApi, pkg.openclaw?.build?.pluginSdkVersion);
});

test("package ships built runtime and lightweight provider discovery before packing", () => {
  assert.equal(pkg.main, "./dist/index.js");
  assert.equal(pkg.types, "./dist/index.d.ts");
  assert.deepEqual(pkg.openclaw?.extensions, ["./dist/index.js"]);
  assert.deepEqual(pkg.openclaw?.runtimeExtensions, ["./dist/index.js"]);
  assert.ok(pkg.files?.includes("dist"));
  assert.ok(pkg.files?.includes("skills"));
  assert.ok(pkg.files?.includes("openclaw.plugin.json"));
  assert.ok(pkg.files?.includes("README.md"));
  assert.ok(pkg.files?.includes("docs/BUILD.md"));
  assert.ok(pkg.files?.includes("docs/QUALIFICATION.md"));
  assert.ok(!pkg.files?.includes("docs"));
  assert.ok(!pkg.files?.includes("tools"));
  assert.equal(pkg.scripts?.prepack, "node tools/verify-artifact.mjs --quiet");
  assert.ok(existsSync(new URL("../dist/provider-discovery.js", import.meta.url)));
});
