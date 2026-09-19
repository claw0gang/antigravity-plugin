import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { executeBounded, runDependencyGraph, checkObservations, sha256 } from '../tools/qualification-core.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const runner = fileURLToPath(new URL('../tools/qualification.mjs', import.meta.url));

test('host target gate rejects before invalid candidate and plan filesystem reads', () => {
  const result = spawnSync(process.execPath, [runner, '--mode', 'host', '--expected-hostname', hostname() + '-wrong', '--candidate-root', '/unread-candidate', '--plan', '/unread-plan'], { encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Hostname mismatch.*no candidate or plan files read/);
  assert.doesNotMatch(result.stderr, /ENOENT/);
});

test('source plan distinguishes authored units from unexecuted host acceptance', () => {
  const result = spawnSync(process.execPath, [runner, '--mode', 'source', '--unit', 'plan', '--candidate-root', root], { encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'authored');
  assert.equal(report.executed, false);
  assert.ok(report.units.every((unit: { authored: boolean; executed: boolean; status: string }) => unit.authored && !unit.executed && unit.status === 'unverified'));
  assert.match(report.installedHostAcceptance, /unverified.*t007.*t008/);
});

test('source mode cannot accept live adapter plans', () => {
  const result = spawnSync(process.execPath, [runner, '--mode', 'source', '--unit', 'plan', '--candidate-root', root, '--plan', '/not-read'], { encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Source mode cannot execute host adapters/);
});

test('independent selected units re-execute their prerequisite closure and block after failure', async () => {
  const units = [{ id: 'baseline', dependsOn: [] }, { id: 'offline', dependsOn: ['baseline'] }, { id: 'live', dependsOn: ['offline'] }];
  const calls: string[] = [];
  const result = await runDependencyGraph(units, ['live'], async (unit: { id: string }) => { calls.push(unit.id); return { executed: true, status: unit.id === 'offline' ? 'failed' : 'passed' }; });
  assert.deepEqual(calls, ['baseline', 'offline']);
  assert.deepEqual(result.map((unit: { status: string }) => unit.status), ['passed', 'failed', 'unverified']);
  assert.equal(result[2].executed, false);
  calls.length = 0;
  await runDependencyGraph(units, ['live'], async (unit: { id: string }) => { calls.push(unit.id); return { executed: true, status: 'passed' }; });
  assert.deepEqual(calls, ['baseline', 'offline', 'live']);
  await assert.rejects(runDependencyGraph([{ id: 'a', dependsOn: ['a'] }], ['a'], () => {}), /cycle/);
});

test('failed post-execution assertions retain executed truth', async () => {
  const results = await runDependencyGraph([{ id: 'live', dependsOn: [] }], ['live'], () => { throw Object.assign(new Error('observed mismatch'), { executed: true }); });
  assert.equal(results[0].executed, true);
  assert.equal(results[0].status, 'failed');
});

test('offline post-command parse failure preserves completed steps without raw output', async () => {
  const steps = [
    { name: 'check', status: 'passed', exitCode: 0, outputSha256: sha256('suite summary'), outputBytes: 123 },
    { name: 'pack-check', status: 'passed', exitCode: 0, outputSha256: sha256('package summary'), outputBytes: 456 },
    { name: 'pack', status: 'passed', exitCode: 0, outputSha256: sha256('invalid JSON'), outputBytes: 789 },
  ];
  const results = await runDependencyGraph([{ id: 'offline', dependsOn: [] }, { id: 'compatibility', dependsOn: ['offline'] }], ['compatibility'], () => {
    throw Object.assign(new Error('pack produced invalid JSON evidence; raw output omitted'), { executed: true, boundedEvidence: { steps, failedAt: 'pack' }, stdout: 'sensitive raw output' });
  });
  assert.equal(results[0].executed, true);
  assert.equal(results[0].status, 'failed');
  assert.deepEqual(results[0].observations, { steps, failedAt: 'pack' });
  assert.equal(results[1].status, 'unverified');
  assert.equal(results[1].executed, false);
  assert.doesNotMatch(JSON.stringify(results), /sensitive raw output/);
});

test('bounded child preserves split multibyte observations and isolates environment', async () => {
  const result = await executeBounded([process.execPath, '-e', "const b=Buffer.from('€');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),30);process.stderr.write(String(process.env.ANTIGRAVITY_TEST_SECRET));"], { cwd: root, env: {}, timeoutMs: 2000 });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '€');
  assert.equal(result.stderr, 'undefined');
  assert.equal(result.outputBytes, Buffer.byteLength('€undefined'));
  assert.match(result.outputSha256, /^[a-f0-9]{64}$/);
});

test('output ceiling settles promptly even with a much larger command deadline', async () => {
  const result = await executeBounded([process.execPath, '-e', "process.stdout.write('x'.repeat(2048));setInterval(()=>{},1000)"], { cwd: root, env: {}, timeoutMs: 60000, maxOutputBytes: 1024 });
  assert.equal(result.failure, 'output-limit');
  assert.ok(result.durationMs < 2500, String(result.durationMs));
  assert.ok(result.stdout.length <= 1024);
});

test('timeout kills the bounded process group without a success result', async () => {
  const result = await executeBounded([process.execPath, '-e', 'setInterval(()=>{},1000)'], { cwd: root, env: {}, timeoutMs: 100 });
  assert.equal(result.failure, 'timeout');
  assert.notEqual(result.code, 0);
  assert.ok(result.durationMs < 1500);
});

test('exact adapter observations cannot pass on absence, truthy coercion or invented nested fields', () => {
  const checks = checkObservations({ catalog: { ids: ['opaque-A', 'opaque-B'] }, preserved: true }, [
    { path: 'catalog.ids', equals: ['opaque-A', 'opaque-B'] },
    { path: 'preserved', equals: 'true' },
    { path: 'missing', equals: true },
  ]);
  assert.deepEqual(checks.map((check: { passed: boolean }) => check.passed), [true, false, false]);
  assert.throws(() => checkObservations({}, []), /explicit assertions/);
  assert.equal(sha256('fixture'), 'f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d');
});


test('normal parent exit retires ordinary unref children before late mutation', async () => {
  if (process.platform === 'win32') return;
  const temp = await mkdtemp(join(tmpdir(), 'qualification-descendant-'));
  const marker = join(temp, 'marker');
  try {
    const childCode = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'late'),500)`;
    const parentCode = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'}).unref()`;
    const result = await executeBounded([process.execPath, '-e', parentCode], { cwd: root, env: {}, timeoutMs: 2000 });
    assert.equal(result.code, 0);
    assert.match(result.processGroupRetirement, /unverified|owned-group-absent/);
    if (result.processGroupRetirement === 'unverified') assert.equal(result.failure, 'group-retirement-unverified');
    await delay(700);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally { await rm(temp, { recursive: true, force: true }); }
});
