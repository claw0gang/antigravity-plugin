// Shared bounded runner primitives. No host authority is conferred by this module.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, lstat, readdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const fileDigest = async path => sha256(await readFile(path));
export const inside = (root, target) => target === root || target.startsWith(root + sep);
export function requireValue(condition, message) { if (!condition) throw new Error(message); }
export function exactDigest(value, name) { requireValue(/^[a-f0-9]{64}$/.test(value ?? ''), `${name} must be an exact SHA256`); }
export function exactRevision(value, name) { requireValue(/^[a-f0-9]{40}$/.test(value ?? ''), `${name} must be an exact Git revision`); }

export async function digestTree(root, paths) {
  const entries = [];
  async function add(relative) {
    requireValue(typeof relative === 'string' && relative && !relative.split(/[\\/]/).includes('..'), 'Invalid manifest path');
    const full = resolve(root, relative);
    requireValue(inside(root, full), 'Manifest path escapes candidate');
    const stat = await lstat(full);
    requireValue(!stat.isSymbolicLink(), `Candidate symlink is forbidden: ${relative}`);
    if (stat.isDirectory()) for (const child of (await readdir(full)).sort()) await add(relative + '/' + child);
    else { requireValue(stat.isFile(), `Non-regular candidate path: ${relative}`); entries.push([relative, await fileDigest(full)]); }
  }
  for (const path of paths) await add(path);
  entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  requireValue(new Set(entries.map(([path]) => path)).size === entries.length, 'Duplicate manifest paths');
  return { sha256: sha256(JSON.stringify(entries)), fileCount: entries.length, entries };
}

// Buffered output is never returned in the public report; only digests and bounded
// observations chosen by an approved adapter survive. Descendant containment is
// limited to a POSIX process group; escaped descendants remain an A09 obligation.
export async function executeBounded(argv, { cwd, env, timeoutMs, maxOutputBytes = 1048576 }) {
  requireValue(Array.isArray(argv) && argv.length > 0 && argv.length <= 64 && argv.every(x => typeof x === 'string' && x.length <= 16384), 'Invalid bounded argv');
  requireValue(Number.isInteger(timeoutMs) && timeoutMs >= 50 && timeoutMs <= 1800000, 'Invalid command timeout');
  const started = Date.now();
  return await new Promise(resolveResult => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', shell: false });
    let bytes = 0, failure = null, settled = false, drainTimer;
    const stdoutChunks = [], stderrChunks = [];
    const outputHash = createHash('sha256');
    const terminate = reason => {
      failure ??= reason;
      if (!drainTimer) drainTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(null, 'unverified-descendants'); }, 1000);
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const finish = async (code, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(hardStop); clearTimeout(drainTimer);
      // A normal parent exit can leave ordinary unref'd children. Request group
      // retirement and require observed absence before permitting cleanup.
      let processGroupRetirement = 'not-supported-on-windows';
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); processGroupRetirement = 'unverified'; }
        catch (error) { processGroupRetirement = error.code === 'ESRCH' ? 'owned-group-absent' : 'unverified'; }
        const deadline = Date.now() + 500;
        while (processGroupRetirement === 'unverified' && Date.now() < deadline) {
          try { process.kill(-child.pid, 0); }
          catch (error) { if (error.code === 'ESRCH') { processGroupRetirement = 'owned-group-absent'; break; } }
          await new Promise(done => setTimeout(done, 20));
        }
        if (processGroupRetirement !== 'owned-group-absent') failure ??= 'group-retirement-unverified';
      }
      resolveResult({ code, signal, failure, processGroupRetirement, durationMs: Date.now() - started, stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr: Buffer.concat(stderrChunks).toString('utf8'), outputSha256: outputHash.digest('hex'), outputBytes: bytes });
    };
    const timer = setTimeout(() => terminate('timeout'), timeoutMs);
    // Escaped children holding inherited pipes cannot make this promise unbounded.
    const hardStop = setTimeout(() => { terminate('settlement-timeout'); child.stdout.destroy(); child.stderr.destroy(); finish(null, 'unverified-descendants'); }, timeoutMs + 1000);
    for (const [stream, channel] of [[child.stdout, 'out'], [child.stderr, 'err']]) stream.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      outputHash.update(chunk);
      if (bytes > maxOutputBytes) { terminate('output-limit'); return; }
      if (channel === 'out') stdoutChunks.push(chunk); else stderrChunks.push(chunk);
    });
    child.once('error', () => { failure = 'spawn-error'; finish(null, null); });
    child.once('close', finish);
  });
}

export function checkObservations(observed, assertions) {
  requireValue(observed && typeof observed === 'object' && !Array.isArray(observed), 'Adapter observations must be an object');
  requireValue(Array.isArray(assertions) && assertions.length > 0 && assertions.length <= 128, 'Adapter needs 1–128 explicit assertions');
  const checks = [];
  for (const assertion of assertions) {
    requireValue(typeof assertion.path === 'string' && /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(assertion.path), 'Invalid observation path');
    let actual = observed;
    for (const key of assertion.path.split('.')) actual = actual && Object.hasOwn(actual, key) ? actual[key] : undefined;
    requireValue(Object.hasOwn(assertion, 'equals'), 'Only exact observable equality assertions are supported');
    checks.push({ path: assertion.path, passed: isDeepStrictEqual(actual, assertion.equals) });
  }
  return checks;
}

export async function runDependencyGraph(units, selected, execute) {
  const names = new Set(units.map(unit => unit.id));
  requireValue(names.size === units.length, 'Duplicate unit ID');
  const byId = new Map(units.map(unit => [unit.id, unit]));
  const needed = new Set(), visiting = new Set();
  function visit(id) {
    requireValue(names.has(id), `Unknown unit ${id}`);
    requireValue(!visiting.has(id), 'Unit dependency cycle');
    if (needed.has(id)) return;
    visiting.add(id); for (const dependency of byId.get(id).dependsOn) visit(dependency); visiting.delete(id); needed.add(id);
  }
  selected.forEach(visit);
  const results = new Map();
  for (const id of needed) {
    const unit = byId.get(id);
    if (unit.dependsOn.some(dep => results.get(dep).status !== 'passed')) { results.set(id, { id, authored: true, executed: false, status: 'unverified', reason: 'prerequisite-did-not-pass' }); continue; }
    try { const result = await execute(unit); results.set(id, { id, authored: true, ...result }); }
    catch (error) { results.set(id, { id, authored: true, executed: error.executed === true, status: 'failed', reason: error.message, ...(error.boundedEvidence ? { observations: error.boundedEvidence } : {}) }); }
  }
  return [...results.values()];
}
