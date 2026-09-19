import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error JavaScript tooling has no declaration file.
import { verifyExecutableClosure } from '../tools/qualification-trust.mjs';

const root = resolve(import.meta.dirname, '..');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const bootstrap = join(root, 'tools/qualification-adapter.mjs');
const bind = async (path: string) => ({ path, sha256: hash(await readFile(path)) });

async function fixture(files: Record<string, string>, body: (scope: string) => Promise<void>) {
  const scope = await mkdtemp(join(tmpdir(), 'antigravity-trust-'));
  try { for (const [name, text] of Object.entries(files)) await writeFile(join(scope, name), text); await body(scope); }
  finally { await rm(scope, { recursive: true, force: true }); }
}

async function runAdapter(scope: string, closureNames: string[], entry = 'adapter.mjs', alter?: (scope: string) => Promise<void>) {
  const adapter = { ...await bind(join(scope, entry)), closure: await Promise.all(closureNames.map(name => bind(join(scope, name)))) };
  const plan = { expectedHostname: hostname(), runtimeNode: { version: process.version, executable: await bind(process.execPath) }, liveUnits: [{ id: 'live-fixture', adapter, argv: [process.execPath, adapter.path, '--expected-hostname', hostname()] }] };
  const planPath = join(scope, 'plan.json');
  await writeFile(planPath, JSON.stringify(plan));
  const planBinding = await bind(planPath);
  await alter?.(scope);
  return spawnSync(process.execPath, [bootstrap, '--expected-hostname', hostname(), '--plan', planPath, '--plan-sha256', planBinding.sha256, '--unit', 'live-fixture'], { cwd: scope, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 5000 });
}

test('adapter closure verifies all declared bytes before any adapter code runs', async () => {
  await fixture({ 'adapter.mjs': "console.log('ENTRY_EXECUTED'); await import('./helper.mjs');", 'helper.mjs': "console.log('HELPER_EXECUTED');" }, async scope => {
    const result = await runAdapter(scope, ['adapter.mjs', 'helper.mjs'], 'adapter.mjs', scope => writeFile(join(scope, 'helper.mjs'), "console.log('TAMPER_EXECUTED');"));
    assert.notEqual(result.status, 0); assert.match(result.stderr, /digest mismatch/); assert.equal(result.stdout, '');
  });
});

test('adapter closure permits verified transitive static/dynamic ESM and CommonJS/createRequire dependencies', async () => {
  await fixture({
    'adapter.mjs': "import { createRequire } from 'node:module'; import { value } from './static.mjs'; const late = await import('./dynamic.mjs'); const req = createRequire(import.meta.url); console.log(JSON.stringify([value, late.value, req('./middle.cjs')]));",
    'static.mjs': "export const value = 'static';", 'dynamic.mjs': "export const value = 'dynamic';",
    'middle.cjs': "module.exports = require('./leaf.cjs');", 'leaf.cjs': "module.exports = 'commonjs';"
  }, async scope => {
    const result = await runAdapter(scope, ['adapter.mjs', 'static.mjs', 'dynamic.mjs', 'middle.cjs', 'leaf.cjs']);
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), ['static', 'dynamic', 'commonjs']);
  });
});

for (const [name, source, helper] of [
  ['static ESM', "import './helper.mjs';", 'helper.mjs'],
  ['dynamic ESM', "await import('./helper.mjs');", 'helper.mjs'],
  ['CommonJS createRequire', "import { createRequire } from 'node:module'; createRequire(import.meta.url)('./helper.cjs');", 'helper.cjs'],
] as const) test(`adapter loader rejects an omitted ${name} dependency before its code executes`, async () => {
  await fixture({ 'adapter.mjs': source, [helper]: "console.log('UNBOUND_EXECUTED');" }, async scope => {
    const result = await runAdapter(scope, ['adapter.mjs']);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Unbound adapter executable dependency/); assert.equal(result.stdout, '');
  });
});

test('CommonJS transitive requires cannot escape the bound closure', async () => {
  await fixture({ 'adapter.cjs': "require('./middle.cjs');", 'middle.cjs': "require('./leaf.cjs');", 'leaf.cjs': "console.log('UNBOUND_EXECUTED');" }, async scope => {
    const result = await runAdapter(scope, ['adapter.cjs', 'middle.cjs'], 'adapter.cjs');
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Unbound adapter executable dependency/); assert.equal(result.stdout, '');
  });
});

test('module bytes changed after eager verification are rejected at the actual load', async () => {
  await fixture({ 'adapter.mjs': "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./late.mjs', import.meta.url), \"console.log('TAMPER_EXECUTED');\"); await import('./late.mjs');", 'late.mjs': "console.log('ORIGINAL_EXECUTED');" }, async scope => {
    const result = await runAdapter(scope, ['adapter.mjs', 'late.mjs']);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /digest mismatch/); assert.equal(result.stdout, '');
  });
});

test('CommonJS bytes changed after eager verification are rejected before compilation', async () => {
  await fixture({ 'adapter.cjs': "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'late.cjs'), \"console.log('TAMPER_EXECUTED');\"); require('./late.cjs');", 'late.cjs': "console.log('ORIGINAL_EXECUTED');" }, async scope => {
    const result = await runAdapter(scope, ['adapter.cjs', 'late.cjs'], 'adapter.cjs');
    assert.notEqual(result.status, 0); assert.match(result.stderr, /digest mismatch/); assert.equal(result.stdout, '');
  });
});

for (const [source, error] of [["await import('data:text/javascript,console.log(1)');", /explicit file path/], ["await import('some-package');", /package resolution is forbidden/], ["await import('./implicit.js');", /explicit .mjs, .cjs or .json/]] as const) test(`adapter loader rejects unbound resolution form ${source}`, async () => {
  await fixture({ 'adapter.mjs': source, 'implicit.js': 'console.log(1);' }, async scope => {
    const result = await runAdapter(scope, ['adapter.mjs']); assert.notEqual(result.status, 0); assert.match(result.stderr, error); assert.equal(result.stdout, '');
  });
});

test('closure rejects missing entry, duplicate paths and symlinks', async () => {
  await fixture({ 'adapter.mjs': '', 'helper.mjs': '' }, async scope => {
    const entry = await bind(join(scope, 'adapter.mjs')); const helper = await bind(join(scope, 'helper.mjs'));
    await assert.rejects(verifyExecutableClosure({ ...entry, closure: [helper] }), /entry is absent/);
    await assert.rejects(verifyExecutableClosure({ ...entry, closure: [entry, entry] }), /Duplicate/);
    await symlink(join(scope, 'helper.mjs'), join(scope, 'linked.mjs'));
    await assert.rejects(verifyExecutableClosure({ ...entry, closure: [entry, await bind(join(scope, 'linked.mjs'))] }), /canonical regular file/);
  });
});

test('adapter bootstrap refuses hostname mismatch before opening a missing plan', () => {
  const result = spawnSync(process.execPath, [bootstrap, '--expected-hostname', hostname() + '-mismatch', '--plan', '/missing', '--plan-sha256', '0'.repeat(64), '--unit', 'live-fixture'], { cwd: root, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 5000 });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Hostname mismatch; no plan or adapter files read/); assert.doesNotMatch(result.stderr, /ENOENT/);
});
