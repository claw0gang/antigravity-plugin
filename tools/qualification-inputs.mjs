import { readFile, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, dirname } from 'node:path';
import { hashFiles, publicFiles, relativePath, sha256, treeSha256 } from './build-support.mjs';

const requireValue = (condition, message) => { if (!condition) throw new Error(message); };

export async function verifyNodeResolution(executable) {
  requireValue(await realpath(join(dirname(executable), 'node')) === await realpath(executable), 'PATH node differs from the bound Node executable; use a toolchain directory with its own node');
}

export async function readExportIdentity(path) {
  requireValue(isAbsolute(path) && await realpath(path) === path && (await lstat(path)).isFile(), 'Export manifest requires a canonical regular file');
  const bytes = await readFile(path);
  const manifest = JSON.parse(bytes);
  requireValue(manifest.schemaVersion === 1 && Array.isArray(manifest.files) && manifest.files.length > 0, 'Invalid public export manifest');
  let previous = '';
  for (const entry of manifest.files) {
    requireValue(Array.isArray(entry) && entry.length === 2, 'Invalid export manifest entry');
    const [name, digest] = entry;
    relativePath(name);
    requireValue(name > previous && /^[a-f0-9]{64}$/.test(digest), 'Export manifest entries must be sorted, unique file digests');
    previous = name;
  }
  requireValue(manifest.sourceTreeSha256 === treeSha256(manifest.files), 'Export manifest internal source tree mismatch');
  return { manifestSha256: sha256(bytes), sourceTreeSha256: manifest.sourceTreeSha256, fileCount: manifest.files.length, files: manifest.files };
}

export async function verifyFrozenExport(binding, root) {
  const identity = await readExportIdentity(binding.path);
  requireValue(identity.manifestSha256 === binding.sha256, 'Frozen public export manifest digest mismatch');
  const actual = await hashFiles(root, await publicFiles(root));
  requireValue(JSON.stringify(identity.files) === JSON.stringify(actual), 'Frozen public export does not describe the candidate public source');
  return identity;
}

export function verifyReproducedExports(a, b, frozen = null) {
  requireValue(a.manifestSha256 === b.manifestSha256 && a.sourceTreeSha256 === b.sourceTreeSha256, 'Public export reproduction mismatch');
  if (frozen) requireValue(a.manifestSha256 === frozen.manifestSha256 && a.sourceTreeSha256 === frozen.sourceTreeSha256, 'Reproduced public export differs from frozen plan-bound manifest');
  return { manifestSha256: a.manifestSha256, sourceTreeSha256: a.sourceTreeSha256, fileCount: a.fileCount };
}

// Build tools always run under the pinned build Node, independently of the
// runtime selected for importing/operating the already-built package.
export function offlineRecipe(root, temp, buildNode, npmCli) {
  return [
    ['check', [buildNode, npmCli, 'run', 'check']],
    ['pack-check', [buildNode, npmCli, 'run', 'pack:check']],
    ['pack', [buildNode, npmCli, 'pack', '--json', '--pack-destination', temp]],
    ['export-a', [buildNode, join(root, 'tools/export-public.mjs'), '--output', join(temp, 'export-a')]],
    ['export-b', [buildNode, join(root, 'tools/export-public.mjs'), '--output', join(temp, 'export-b')]],
  ];
}

export function compatibilityCommand(root, runtimeNode, expectedHostname, pluginRoot, openclawRoot, sourceRevision) {
  return [runtimeNode, join(root, 'tools/check-openclaw-compatibility.mjs'), '--expected-hostname', expectedHostname, '--plugin-root', pluginRoot, '--openclaw-root', openclawRoot, '--source-identity', sourceRevision, '--timeout-ms', '60000'];
}
