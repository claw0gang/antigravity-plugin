#!/usr/bin/env node
// Host invocation must gate before importing filesystem/child-process machinery.
import { hostname } from 'node:os';
const options = {};
try {
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]?.replace(/^--/, '');
    if (!['mode', 'unit', 'candidate-root', 'source-identity', 'expected-hostname', 'plan', 'plan-sha256', 'timeout-ms', 'runtime-node', 'runtime-node-version', 'runtime-node-sha256'].includes(key) || options[key] !== undefined || !process.argv[i + 1]) throw new Error('Invalid runner arguments; see docs/QUALIFICATION.md');
    options[key] = process.argv[i + 1];
  }
  if (!['source', 'host'].includes(options.mode)) throw new Error('--mode source|host is required');
  if (options.mode === 'host' && (!options['expected-hostname'] || hostname() !== options['expected-hostname'])) throw new Error('Hostname mismatch or missing --expected-hostname; no candidate or plan files read');
  const { run } = await import('./qualification-run.mjs');
  await run(options);
} catch (error) {
  process.stderr.write(JSON.stringify({ status: 'failed', executed: false, error: error.message }) + '\n');
  process.exitCode = 1;
}
