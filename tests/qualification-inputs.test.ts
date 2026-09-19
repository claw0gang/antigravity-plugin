import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256, treeSha256 } from '../tools/build-support.mjs';
import { readExportIdentity, verifyFrozenExport, verifyReproducedExports, verifyNodeResolution } from '../tools/qualification-inputs.mjs';
import { runDependencyGraph } from '../tools/qualification-core.mjs';

test('PATH cannot substitute a sibling node for the bound runtime or build executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qualification-node-resolution-'));
  try {
    await writeFile(join(root, 'node'), 'another Node');
    await writeFile(join(root, 'node22'), 'bound Node');
    await assert.rejects(verifyNodeResolution(join(root, 'node22')), /PATH node differs/);
    await verifyNodeResolution(join(root, 'node'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'qualification-export-binding-'));
  await writeFile(join(root, 'public-export.json'), JSON.stringify({ schemaVersion: 1, files: ['public-export.json', 'source.txt'] }));
  await writeFile(join(root, 'source.txt'), 'frozen source');
  const files = await Promise.all(['public-export.json', 'source.txt'].map(async name => [name, sha256(await readFile(join(root, name)))]));
  const manifest = { schemaVersion: 1, sourceTreeSha256: treeSha256(files), files };
  const bytes = JSON.stringify(manifest, null, 2) + '\n';
  const path = join(root, 'public-export-manifest.json');
  await writeFile(path, bytes);
  return { root, path, manifest, binding: { path, sha256: sha256(bytes) } };
}

test('frozen export binds exact manifest bytes and its source inventory to the candidate', async () => {
  const f = await fixture();
  try {
    const frozen = await verifyFrozenExport(f.binding, f.root);
    assert.equal(frozen.sourceTreeSha256, f.manifest.sourceTreeSha256);
    assert.deepEqual(verifyReproducedExports(frozen, await readExportIdentity(f.path), frozen), { manifestSha256: f.binding.sha256, sourceTreeSha256: f.manifest.sourceTreeSha256, fileCount: 2 });
    await writeFile(join(f.root, 'source.txt'), 'different candidate');
    await assert.rejects(verifyFrozenExport(f.binding, f.root), /does not describe the candidate/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('two reproducible exports cannot pass against another frozen manifest or run dependents', async () => {
  const f = await fixture();
  try {
    const frozen = await verifyFrozenExport(f.binding, f.root);
    const reproduced = { ...frozen, manifestSha256: sha256('different but self-consistent export') };
    let runtimeExecuted = false;
    const results = await runDependencyGraph([{ id: 'offline', dependsOn: [] }, { id: 'compatibility', dependsOn: ['offline'] }], ['compatibility'], async (unit: { id: string }) => {
      if (unit.id === 'offline') verifyReproducedExports(reproduced, reproduced, frozen);
      else runtimeExecuted = true;
      return { executed: true, status: 'passed' };
    });
    assert.equal(results[0].status, 'failed');
    assert.match(results[0].reason, /frozen plan-bound manifest/);
    assert.equal(results[1].status, 'unverified');
    assert.equal(runtimeExecuted, false);
    assert.throws(() => verifyReproducedExports({ ...frozen, sourceTreeSha256: sha256('wrong source') }, { ...frozen, sourceTreeSha256: sha256('wrong source') }, frozen), /frozen plan-bound manifest/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('manifest byte tampering and inconsistent internal tree identity both fail', async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, JSON.stringify(f.manifest) + '\n');
    await assert.rejects(verifyFrozenExport(f.binding, f.root), /manifest digest mismatch/);
    await writeFile(f.path, JSON.stringify({ ...f.manifest, sourceTreeSha256: sha256('unrelated inventory') }));
    await assert.rejects(readExportIdentity(f.path), /internal source tree mismatch/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
