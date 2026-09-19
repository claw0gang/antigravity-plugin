#!/usr/bin/env node
// Its launcher verifies this bootstrap and both imported helper files.
// Match hostname before importing filesystem or executable-loading machinery.
import { hostname } from 'node:os';

let adapterStarted = false;
try {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!process.argv[i]?.startsWith('--')) throw new Error('Invalid adapter bootstrap arguments');
    const key = process.argv[i]?.replace(/^--/, '');
    if (!['expected-hostname', 'plan', 'plan-sha256', 'unit'].includes(key) || options[key] !== undefined || !process.argv[i + 1]) throw new Error('Invalid adapter bootstrap arguments');
    options[key] = process.argv[i + 1];
  }
  if (!options['expected-hostname'] || hostname() !== options['expected-hostname']) throw new Error('Hostname mismatch; no plan or adapter files read');
  const { verifyBoundFile, verifyExecutableClosure, installCommonJsGuard } = await import('./qualification-trust.mjs');
  const { register } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const plan = JSON.parse(verifyBoundFile({ path: options.plan, sha256: options['plan-sha256'] }, 'Adapter plan'));
  if (plan.expectedHostname !== options['expected-hostname']) throw new Error('Adapter plan hostname mismatch');
  const unit = plan.liveUnits?.find(item => item.id === options.unit);
  if (!unit || !Array.isArray(unit.argv) || unit.argv[0] !== plan.runtimeNode?.executable?.path || unit.argv[1] !== unit.adapter?.path) throw new Error('Adapter argv must match the exact runtime Node and adapter entry');
  verifyBoundFile(plan.runtimeNode.executable, 'Adapter runtime Node', 268435456);
  if (process.execPath !== plan.runtimeNode.executable.path || process.version !== plan.runtimeNode.version) throw new Error('Adapter runtime Node identity mismatch');
  const entries = await verifyExecutableClosure(unit.adapter);
  register('./qualification-imports.mjs', import.meta.url, { data: { entries } });
  installCommonJsGuard(entries);
  process.argv = [...unit.argv];
  adapterStarted = true;
  await import(pathToFileURL(unit.adapter.path).href);
} catch (error) {
  process.stderr.write(JSON.stringify({ status: 'failed', executed: adapterStarted, error: error.message }) + '\n');
  process.exitCode = 1;
}
