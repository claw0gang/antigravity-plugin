import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { exportPublic } from "../tools/export-public.mjs";
import { archiveEntries } from "../tools/package-contents.mjs";
import { hashFiles, normalizePackageModes, run, snapshot, toolchain, treeSha256, verifyArtifact } from "../tools/build-support.mjs";

async function fixture(t) {
  const parent = await mkdtemp(path.join(tmpdir(), "antigravity-public-export-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "source");
  await mkdir(root);
  await writeFile(path.join(root, "README.md"), "Public source fixture\n");
  await writeFile(path.join(root, "public-export.json"), JSON.stringify({ schemaVersion: 1, files: ["README.md", "public-export.json"] }));
  return { root, parent };
}

test("export reproduces bytes and manifest while unlisted private files stay excluded", async (t) => {
  const { root, parent } = await fixture(t);
  await mkdir(path.join(root, ".state"));
  await writeFile(path.join(root, ".state", "current.json"), "private record");
  const first = await exportPublic(root, path.join(parent, "first"));
  const second = await exportPublic(root, path.join(parent, "second"));
  assert.equal(first.sourceTreeSha256, second.sourceTreeSha256);
  assert.equal(first.manifestSha256, second.manifestSha256);
  assert.deepEqual(await readFile(path.join(parent, "first", "public-export-manifest.json")), await readFile(path.join(parent, "second", "public-export-manifest.json")));
  assert.equal(first.fileCount, 2);
  await assert.rejects(readFile(path.join(parent, "first", ".state", "current.json")), { code: "ENOENT" });
  await assert.rejects(exportPublic(root, path.join(parent, "first")), { code: "EEXIST" });
});

test("explicit private paths and symlinked public paths reject before export creation", async (t) => {
  const { root, parent } = await fixture(t);
  await writeFile(path.join(root, "public-export.json"), JSON.stringify({ schemaVersion: 1, files: [".state/current.json"] }));
  await assert.rejects(exportPublic(root, path.join(parent, "private")), /Private\/generated path/);
  await assert.rejects(readFile(path.join(parent, "private", "public-export-manifest.json")), { code: "ENOENT" });
  await mkdir(path.join(parent, "secrets"));
  await writeFile(path.join(parent, "secrets", "stolen.txt"), "private bytes");
  await symlink(path.join(parent, "secrets"), path.join(root, "src"));
  await writeFile(path.join(root, "public-export.json"), JSON.stringify({ schemaVersion: 1, files: ["src/stolen.txt"] }));
  await assert.rejects(exportPublic(root, path.join(parent, "symlink")), /Symlinks are forbidden/);
});

function packJsonEntries(stdout) {
  const parsed = JSON.parse(stdout);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") return Object.values(parsed);
  throw new TypeError("Unexpected npm pack --json output");
}

async function verifiedFixture(t) {
  const { root, parent } = await fixture(t);
  const identity = JSON.parse(await readFile(new URL("../build-toolchain.json", import.meta.url), "utf8"));
  const sourcePackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  await mkdir(path.join(root, "tools"));
  for (const name of ["verify-artifact.mjs", "build-support.mjs"]) {
    await writeFile(path.join(root, "tools", name), await readFile(new URL(`../tools/${name}`, import.meta.url)));
  }
  await writeFile(path.join(root, "build-toolchain.json"), JSON.stringify(identity));
  await writeFile(path.join(root, ".node-version"), identity.node + "\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "antigravity-verified-pack-test", version: "0.0.0", scripts: { prepack: sourcePackage.scripts.prepack },
    packageManager: `npm@${identity.npm}`, files: ["dist", "README.md"],
    engines: { node: identity.node },
    devDependencies: { openclaw: identity.openclawSdk },
    openclaw: { build: { openclawVersion: identity.openclawSdk, pluginSdkVersion: identity.openclawSdk } },
  }));
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {
    "": { engines: { node: identity.node }, devDependencies: { openclaw: identity.openclawSdk } },
    "node_modules/openclaw": { version: identity.openclawSdk },
  } }));
  await writeFile(path.join(root, "public-export.json"), JSON.stringify({ schemaVersion: 1,
    files: ["README.md", "public-export.json", "build-toolchain.json", ".node-version", "package.json", "package-lock.json", "tools/verify-artifact.mjs", "tools/build-support.mjs"] }));
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist", "index.js"), "export default 1;\n");
  await normalizePackageModes(root);
  const manifest = { schemaVersion: 1, toolchain: await toolchain(root), ...await snapshot(root) };
  await writeFile(path.join(root, "dist", "build-manifest.json"), JSON.stringify({ ...manifest, buildSha256: treeSha256(manifest) }));
  await chmod(path.join(root, "dist", "build-manifest.json"), 0o644);
  return { root, parent, manifest };
}

test("prepack verification rejects modified bytes and extra output without rebuilding", async (t) => {
  const { root, manifest } = await verifiedFixture(t);
  assert.equal((await verifyArtifact(root)).buildSha256, treeSha256(manifest));
  await writeFile(path.join(root, "dist", "index.js"), "export default 2;\n");
  await assert.rejects(verifyArtifact(root), /packed bytes changed/);
  assert.equal(await readFile(path.join(root, "dist", "index.js"), "utf8"), "export default 2;\n");
  await writeFile(path.join(root, "dist", "index.js"), "export default 1;\n");
  assert.equal((await verifyArtifact(root)).buildSha256, treeSha256(manifest));
  await writeFile(path.join(root, "dist", "extra.js"), "unqualified code\n");
  await assert.rejects(verifyArtifact(root), /packed bytes changed/);
});

test("npm pack --json runs prepack verification with one JSON document and rejects changed inputs", async (t) => {
  const { root, parent } = await verifiedFixture(t);
  const args = ["pack", "--json", "--ignore-scripts=false", "--pack-destination", parent];
  const packed = packJsonEntries(run("npm", args, { cwd: root }));
  assert.equal(packed.length, 1);
  assert.equal(packed[0].filename, "antigravity-verified-pack-test-0.0.0.tgz");
  assert.deepEqual(await archiveEntries(path.join(parent, packed[0].filename)), await hashFiles(root,
    ["README.md", "dist/index.js", "dist/build-manifest.json", "package.json"]));
  await writeFile(path.join(root, "README.md"), "Unqualified changed input\n");
  assert.throws(() => run("npm", args, { cwd: root }), /packed bytes changed/);
  assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "Unqualified changed input\n");
});

test("prepack rejects mode-only payload and manifest drift despite identical content hashes", async (t) => {
  const { root, parent } = await verifiedFixture(t);
  const original = await snapshot(root);
  for (const name of ["dist/index.js", "dist/build-manifest.json"]) {
    await chmod(path.join(root, name), 0o600);
    assert.deepEqual(await snapshot(root), original);
    await assert.rejects(verifyArtifact(root), /Noncanonical package mode/);
    assert.throws(() => run("npm", ["pack", "--json", "--ignore-scripts=false", "--pack-destination", parent], { cwd: root }), /Noncanonical package mode/);
    await chmod(path.join(root, name), 0o644);
  }
  await verifyArtifact(root);
});

test("unlisted compiler input fails instead of diverging from public source", async (t) => {
  const { root, parent } = await fixture(t);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "unlisted.ts"), "export const missing = true;\n");
  await assert.rejects(exportPublic(root, path.join(parent, "incomplete")), /input missing from public allowlist: src\/unlisted\.ts/);
});

function tarEntry(name, bytes, type = "0") {
  bytes = Buffer.from(bytes);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}

test("archive measurement hashes the exact regular file payloads", async (t) => {
  const { parent } = await fixture(t);
  const archive = path.join(parent, "candidate.tgz");
  const payload = Buffer.from("export default 1;\n");
  await writeFile(archive, gzipSync(Buffer.concat([
    tarEntry("package/dist/index.js", payload), tarEntry("package/package.json", "{}\n"), Buffer.alloc(1024),
  ])));
  const measured = await archiveEntries(archive);
  assert.deepEqual(measured, [
    ["dist/index.js", createHash("sha256").update(payload).digest("hex")],
    ["package.json", createHash("sha256").update("{}\n").digest("hex")],
  ]);
  assert.notEqual(measured[0][1], createHash("sha256").update("export default 2;\n").digest("hex"));
});

test("actual npm archive entries match the source payload and expose changed installed bytes", async (t) => {
  const { root, parent } = await fixture(t);
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist", "index.js"), "export default 1;\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "antigravity-archive-test", version: "0.0.0", files: ["dist", "README.md"],
  }));
  const [packed] = packJsonEntries(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", parent], { cwd: root }));
  const measured = await archiveEntries(path.join(parent, packed.filename));
  const expected = ["README.md", "dist/index.js", "package.json"];
  assert.deepEqual(measured, await hashFiles(root, expected));
  await writeFile(path.join(root, "dist", "index.js"), "export default 2;\n");
  assert.notDeepEqual(measured, await hashFiles(root, expected));
});

test("archive links, traversal, duplicate paths and truncation fail before extraction", async (t) => {
  const { parent } = await fixture(t);
  const archive = path.join(parent, "rejected.tgz");
  const cases = [
    [Buffer.concat([tarEntry("package/link", "", "2"), Buffer.alloc(1024)]), /entry type/],
    [Buffer.concat([tarEntry("package/../escape", "bad"), Buffer.alloc(1024)]), /Unsafe archive path/],
    [Buffer.concat([tarEntry("package/a", "1"), tarEntry("package/a", "2"), Buffer.alloc(1024)]), /Duplicate archive path/],
    [tarEntry("package/a", "1"), /missing tar end blocks/],
    [Buffer.concat([tarEntry("package/a", "1"), Buffer.alloc(1024)]).subarray(0, 900), /Truncated tar block/],
  ];
  for (const [bytes, error] of cases) {
    await writeFile(archive, gzipSync(bytes));
    await assert.rejects(archiveEntries(archive), error);
  }
});
