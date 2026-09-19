import assert from "node:assert/strict";
import fs, { access, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";

import { AgyImageStagingError, materializeAgyImages } from "../src/harness/image-input.ts";

// Signature fixtures test staging validation, not full image decoding or AGY vision support.
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const png = { type: "image" as const, data: pngBytes.toString("base64"), mimeType: "image/png" };
const mediaPolicy = { maxImages: 8, maxEncodedBytes: 4096, maxDecodedBytes: 3072, maxTotalDecodedBytes: 4096 };
const settled = () => true;
const stage = (params: Parameters<typeof materializeAgyImages>[0]) => materializeAgyImages({
  stagingRoot: tmpdir(), mediaPolicy, readersSettled: settled, ...params,
});

test("image input materializes private ordered attempt files and cleans idempotently", async () => {
  const materialized = await stage({
    prompt: "inspect both images",
    images: [png, { type: "image", data: jpegBytes.toString("base64"), mimeType: "image/jpeg" }],
  });
  try {
    assert.equal(materialized.paths.length, 2);
    assert.match(materialized.paths[0]!, /antigravity-images-.+\/image-1\.png$/u);
    assert.match(materialized.paths[1]!, /antigravity-images-.+\/image-2\.jpg$/u);
    assert.equal(materialized.prompt, `inspect both images\n\n${materialized.paths[0]}\n${materialized.paths[1]}`);
    assert.deepEqual(await readFile(materialized.paths[0]!), pngBytes);
    assert.deepEqual(await readFile(materialized.paths[1]!), jpegBytes);
    assert.equal((await stat(dirname(materialized.paths[0]!))).mode & 0o777, 0o700);
    assert.equal((await stat(materialized.paths[0]!)).mode & 0o777, 0o600);
    assert.equal((await stat(materialized.paths[1]!)).mode & 0o777, 0o600);
    assert.ok(Object.isFrozen(materialized.paths));
    assert.equal(materialized.cleanupState, "pending");
  } finally {
    await materialized.cleanup();
  }
  assert.equal(materialized.cleanupState, "complete");
  await assert.rejects(access(materialized.paths[0]!));
  await assert.rejects(access(materialized.paths[1]!));
  await materialized.cleanup();
});

test("image staging stays inside the explicit OpenClaw workspace boundary", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "antigravity-image-workspace-"));
  try {
    const materialized = await stage({ prompt: "inspect", images: [png], stagingRoot: workspace });
    try {
      const staged = materialized.paths[0]!;
      const rel = relative(workspace, staged);
      assert.ok(rel && !rel.startsWith("..") && !rel.startsWith("/"));
      assert.equal(dirname(staged).startsWith(join(workspace, ".antigravity-images-")), true);
    } finally {
      await materialized.cleanup();
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("supported image MIME types map to deterministic filename extensions", async () => {
  const cases = [
    ["image/png", ".png", pngBytes],
    ["image/jpeg", ".jpg", jpegBytes],
    ["image/jpg", ".jpg", jpegBytes],
    ["image/webp", ".webp", Buffer.from("RIFF\x04\x00\x00\x00WEBP")],
    ["image/gif", ".gif", Buffer.from("GIF89a")],
    [" IMAGE/PNG ", ".png", pngBytes],
  ] as const;
  for (const [mimeType, extension, bytes] of cases) {
    const materialized = await stage({ prompt: "inspect", images: [{ type: "image", data: bytes.toString("base64"), mimeType }] });
    try { assert.ok(materialized.paths[0]?.endsWith(`image-1${extension}`)); }
    finally { await materialized.cleanup(); }
  }
});

test("no-image input is a no-op without media-policy or reader support", async () => {
  const materialized = await materializeAgyImages({ prompt: "text only" });
  assert.equal(materialized.prompt, "text only");
  assert.deepEqual(materialized.paths, []);
  assert.equal(materialized.cleanupState, "complete");
  await materialized.cleanup();
});

test("image requests require explicit bounded media policy, reader lifecycle and workspace staging", async () => {
  await assert.rejects(materializeAgyImages({ prompt: "inspect", images: [png] }), /media-policy limits/);
  await assert.rejects(materializeAgyImages({ prompt: "inspect", images: [png], mediaPolicy }), /reader-settlement gate/);
  await assert.rejects(materializeAgyImages({ prompt: "inspect", images: [png], mediaPolicy, readersSettled: settled }), /workspace directory/);
  await assert.rejects(stage({ prompt: "inspect", images: [png], stagingRoot: "relative/workspace" }), /absolute OpenClaw workspace directory/);
  for (const invalid of [0, -1, 0.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(stage({ prompt: "inspect", images: [png], mediaPolicy: { ...mediaPolicy, maxDecodedBytes: invalid } }), /media-policy limits/);
  }
});

test("malformed image lists and entries reject deterministically", async () => {
  for (const images of [null, {}, "image", [null], Array(1), [{ ...png, type: "text" }], [{ ...png, mimeType: null }]]) {
    await assert.rejects(stage({ prompt: "inspect", images: images as never }), /ordered image list|malformed|unsupported MIME/);
  }
});

test("image transport rejects unsupported MIME, mismatched headers and malformed base64", async () => {
  for (const mimeType of ["image/svg+xml", "__proto__", "constructor", ""]) {
    await assert.rejects(stage({ prompt: "inspect", images: [{ ...png, mimeType }] }), /unsupported MIME type/);
  }
  for (const mimeType of ["image/jpeg", "image/webp", "image/gif"]) {
    await assert.rejects(stage({ prompt: "inspect", images: [{ ...png, mimeType }] }), /does not match its MIME/);
  }
  for (const data of ["not base64!", "", "====", "A===", "A=AA", "AB==", "AAB=", `${png.data}\n`, null]) {
    await assert.rejects(stage({ prompt: "inspect", images: [{ ...png, data: data as never }] }), /invalid base64 data/);
  }
  // ASCII decoding must not strip high bits and accidentally accept a signature.
  const highBitGif = Buffer.from("GIF89a").map((value) => value | 0x80);
  await assert.rejects(stage({ prompt: "inspect", images: [{ ...png, mimeType: "image/gif", data: highBitGif.toString("base64") }] }), /does not match its MIME/);
});

test("image policy checks per-image encoded and decoded bytes plus batch bounds", async () => {
  const requests = [
    { policy: { maxEncodedBytes: png.data.length - 1 }, images: [png], error: /encoded media-policy limit/ },
    { policy: { maxDecodedBytes: pngBytes.length - 1 }, images: [png], error: /decoded media-policy limit/ },
    { policy: { maxTotalDecodedBytes: 15 }, images: [png, png], error: /total decoded host media-policy limit/ },
    { policy: { maxImages: 1 }, images: [png, png], error: /count limit/ },
  ];
  for (const request of requests) {
    await assert.rejects(stage({ prompt: "inspect", images: request.images, mediaPolicy: { ...mediaPolicy, ...request.policy } }), request.error);
  }
  const exact = await stage({ prompt: "inspect", images: [png, png], mediaPolicy: {
    maxImages: 2, maxEncodedBytes: png.data.length, maxDecodedBytes: pngBytes.length, maxTotalDecodedBytes: 16,
  } });
  await exact.cleanup();
});

test("validation completes before staging any part of the batch", async (t) => {
  let created = 0;
  t.mock.method(fs, "mkdtemp", async () => { created++; throw new Error("unexpected staging"); });
  await assert.rejects(stage({ prompt: "inspect", images: [png, { ...png, data: "bad" }] }), /invalid base64/);
  assert.equal(created, 0);
});

test("concurrent attempts have isolated image paths and cleanup ownership", async () => {
  const [one, two] = await Promise.all([stage({ prompt: "a", images: [png] }), stage({ prompt: "b", images: [png] })]);
  try {
    assert.notEqual(dirname(one.paths[0]!), dirname(two.paths[0]!));
    await one.cleanup();
    assert.deepEqual(await readFile(two.paths[0]!), pngBytes);
  } finally { await Promise.all([one.cleanup(), two.cleanup()]); }
});

test("cleanup retains files until reader settlement and permits a later retry", async () => {
  let readersSettled = false;
  const materialized = await stage({ prompt: "inspect", images: [png], readersSettled: () => readersSettled });
  try {
    await assert.rejects(materialized.cleanup(), /readers have not settled/);
    assert.equal(materialized.cleanupState, "blocked");
    assert.deepEqual(await readFile(materialized.paths[0]!), pngBytes);
  } finally {
    readersSettled = true;
    await materialized.cleanup();
  }
  assert.equal(materialized.cleanupState, "complete");
});

test("reader-settlement exceptions retain files and report blocked cleanup", async () => {
  let fail = true;
  const materialized = await stage({ prompt: "inspect", images: [png], readersSettled: () => {
    if (fail) throw new Error("reader state unavailable");
    return true;
  } });
  try {
    await assert.rejects(materialized.cleanup(), /reader state unavailable/);
    assert.equal(materialized.cleanupState, "blocked");
    await access(materialized.paths[0]!);
  } finally { fail = false; await materialized.cleanup(); }
});

test("cleanup failure is truthful, retryable, and becomes idempotent only after success", async (t) => {
  const materialized = await stage({ prompt: "inspect", images: [png] });
  const originalRm = fs.rm;
  let calls = 0;
  t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    calls++;
    if (calls === 1) throw new Error("simulated unlink failure");
    await originalRm(...args);
  });
  try {
    await assert.rejects(materialized.cleanup(), /simulated unlink failure/);
    assert.equal(materialized.cleanupState, "failed");
    await access(materialized.paths[0]!);
    await materialized.cleanup();
    assert.equal(materialized.cleanupState, "complete");
    await materialized.cleanup();
    assert.equal(calls, 2);
  } finally { await originalRm(dirname(materialized.paths[0]!), { recursive: true, force: true }); }
});

test("concurrent cleanup joins one outstanding removal and cannot claim completion early", async (t) => {
  const materialized = await stage({ prompt: "inspect", images: [png] });
  const originalRm = fs.rm;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    calls++;
    await barrier;
    await originalRm(...args);
  });
  const first = materialized.cleanup();
  const second = materialized.cleanup();
  assert.equal(first, second);
  assert.equal(materialized.cleanupState, "in_progress");
  await access(materialized.paths[0]!);
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(materialized.cleanupState, "complete");
});

test("partial staging failures clean unpublished files without consulting admitted readers", async (t) => {
  const originalWrite = fs.writeFile;
  const originalMkdtemp = fs.mkdtemp;
  let directory = "";
  let writes = 0;
  t.mock.method(fs, "mkdtemp", async (...args: Parameters<typeof fs.mkdtemp>) => {
    directory = await originalMkdtemp(...args) as string;
    return directory;
  });
  t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    if (++writes === 2) throw new Error("simulated write failure");
    await originalWrite(...args);
  });
  await assert.rejects(stage({ prompt: "inspect", images: [png, png], readersSettled: () => false }), /simulated write failure/);
  assert.ok(directory);
  await assert.rejects(access(directory));
});

test("staging plus cleanup failure preserves both errors and a retryable cleanup handle", async (t) => {
  const originalWrite = fs.writeFile;
  const originalRm = fs.rm;
  let writes = 0;
  let removes = 0;
  t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    if (++writes === 2) throw new Error("simulated write failure");
    await originalWrite(...args);
  });
  t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    if (++removes === 1) throw new Error("simulated removal failure");
    await originalRm(...args);
  });
  try {
    await stage({ prompt: "inspect", images: [png, png], readersSettled: () => false });
    assert.fail("expected staging rejection");
  } catch (error) {
    assert.ok(error instanceof AgyImageStagingError);
    assert.equal(error.errors.length, 2);
    assert.equal(error.images.cleanupState, "failed");
    await access(error.images.paths[0]!);
    await error.images.cleanup();
    assert.equal(error.images.cleanupState, "complete");
    await assert.rejects(access(error.images.paths[0]!));
  }
});
