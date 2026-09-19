import { hostname, homedir, tmpdir } from 'node:os';
import { readFile, readdir, realpath, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicFiles } from './build-support.mjs';
import { verifyExecutableClosure } from './qualification-trust.mjs';
import { verifyFrozenExport, readExportIdentity, verifyReproducedExports, offlineRecipe, compatibilityCommand, verifyNodeResolution } from './qualification-inputs.mjs';
import { fileDigest, sha256, digestTree, executeBounded, checkObservations, runDependencyGraph, requireValue, exactDigest, exactRevision, inside } from './qualification-core.mjs';

const candidateTree = async root => digestTree(root, [...await publicFiles(root), 'dist']);
const fakeFiles = ['capability-preflight', 'model-catalog', 'inventory', 'provider-discovery', 'p02t005-host-inventory', 'p02t005-execution-inventory'];
const sourceUnits = [
  { id: 'baseline', dependsOn: [], evidenceKind: 'identity and credential-free preconditions' },
  { id: 'offline', dependsOn: ['baseline'], evidenceKind: 'locked build, real-SDK regression, build/export tests, package and reproducible export' },
  { id: 'compatibility', dependsOn: ['offline'], evidenceKind: 'SDK import and simulated registration; installed Gateway behavior unverified' },
  { id: 'fake-catalog', dependsOn: ['offline'], evidenceKind: 'fake AGY and simulated public hooks; native catalog visibility unverified' },
];
const bounded = result => ({ processGroupRetirement: result.processGroupRetirement, exitCode: result.code, signal: result.signal, reason: result.failure, durationMs: result.durationMs, outputSha256: result.outputSha256, outputBytes: result.outputBytes });
const successful = result => result.code === 0 && !result.failure;

async function safeScope(task) {
  // Check every ancestor; never adopt a symlink or a pre-existing run leaf.
  const home = await realpath(homedir());
  let path = home;
  for (const part of ['tmp', 'local-exec', 'transient', 'antigravity', 'p02', task]) {
    path = join(path, part);
    try { await mkdir(path); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(path);
    requireValue(info.isDirectory() && !info.isSymbolicLink(), 'Transient scope must contain only real directories');
  }
  return await mkdtemp(join(path, 'qualification-'));
}
async function verifyFile(binding, name) {
  requireValue(binding && isAbsolute(binding.path ?? ''), `${name} requires an absolute path`);
  exactDigest(binding.sha256, name);
  const info = await lstat(binding.path);
  requireValue(info.isFile() && !info.isSymbolicLink(), `${name} must be a regular file`);
  requireValue(await fileDigest(binding.path) === binding.sha256, `${name} digest mismatch`);
  return { path: binding.path, sha256: binding.sha256 };
}
function validateHostPlan(plan, options) {
  requireValue(plan.schema === 'antigravity-qualification/v1', 'Unknown qualification plan schema');
  requireValue(['p02t007', 'p02t008'].includes(plan.task), 'Host campaign belongs to p02t007 or p02t008');
  requireValue(plan.expectedHostname === options['expected-hostname'], 'Plan hostname mismatch');
  exactRevision(plan.governanceRevision, 'governanceRevision'); exactRevision(plan.hostGovernance?.revision, 'host governance revision');
  requireValue(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(plan.hostGovernance.repository ?? ''), 'Exact host governance repository owner/name required');
  exactRevision(plan.candidate?.sourceRevision, 'candidate source revision'); exactDigest(plan.candidate?.treeSha256, 'candidate tree');
  requireValue(isAbsolute(plan.pluginRoot ?? '') && isAbsolute(plan.openclawRoot ?? ''), 'Explicit package and OpenClaw roots are required');
  requireValue(typeof plan.openclawVersion === 'string' && plan.openclawVersion, 'Exact OpenClaw version required');
  for (const [name, binding] of [['build Node', plan.buildNode], ['runtime Node', plan.runtimeNode]]) {
    requireValue(/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(binding?.version ?? '') && isAbsolute(binding?.executable?.path ?? ''), `Exact ${name} version and executable required`);
    exactDigest(binding.executable.sha256, name);
  }
  requireValue(typeof plan.buildNpm?.version === 'string' && isAbsolute(plan.buildNpm?.cli?.path ?? ''), 'Exact build npm version and CLI required');
  exactDigest(plan.buildNpm.cli.sha256, 'build npm CLI');
  requireValue(plan.node === undefined, 'Ambiguous single Node binding is unsupported; bind buildNode and runtimeNode separately');
  requireValue(typeof plan.agy?.version === 'string' && plan.agy.version, 'Exact AGY version required');
  requireValue(JSON.stringify(plan.agy.versionArgv) === JSON.stringify([plan.agy.executable?.path, '--version']) && JSON.stringify(plan.agy.helpArgv) === JSON.stringify([plan.agy.executable?.path, '--help']), 'Baseline supports only exact AGY --version and --help commands');
  requireValue(Array.isArray(plan.configFiles) && plan.configFiles.length > 0, 'Isolated configuration digest bindings required');
  requireValue(Array.isArray(plan.fixtureFiles) && plan.fixtureFiles.length > 0, 'Exact native input fixture versions and digests required');
  requireValue(plan.authentication?.route && plan.authentication.enforcement && Array.isArray(plan.authentication.envNames), 'Explicit authentication route, ceiling enforcement and env allowlist required');
  requireValue(plan.authentication.envNames.every(name => /^[A-Z_][A-Z0-9_]*$/.test(name) && !/^(NODE_|LD_|DYLD_)/.test(name) && !['BASH_ENV', 'ENV', 'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP'].includes(name)), 'Unsafe authentication environment key');
  const budget = plan.budget;
  requireValue(Number.isInteger(budget?.maxCommands) && budget.maxCommands > 0 && budget.maxCommands <= 64, 'Finite command budget 1–64 required');
  requireValue(Number.isInteger(budget.maxElapsedMs) && budget.maxElapsedMs >= 1000 && budget.maxElapsedMs <= 3600000, 'Finite total elapsed budget required');
  requireValue(Number.isInteger(budget.maxNativeCalls) && budget.maxNativeCalls >= 0 && Number.isFinite(budget.maxSpend) && budget.maxSpend >= 0 && budget.currency, 'Native call/spend ceilings required');
  requireValue(Array.isArray(plan.liveUnits) && plan.liveUnits.length <= 32, 'At most 32 live units');
  let calls = 0, spend = 0;
  for (const unit of plan.liveUnits) {
    requireValue(/^live-[a-z0-9-]+$/.test(unit.id) && Array.isArray(unit.dependsOn), 'Invalid live unit identity/dependencies');
    requireValue(Array.isArray(unit.rows) && unit.rows.length && unit.rows.every(row => /^A(?:0[1-9]|1[0-9]|2[0-4])$/.test(row)), 'Live unit must name existing acceptance rows');
    requireValue(typeof unit.scenario === 'string' && unit.scenario.length <= 512, 'Bounded concrete scenario required');
    requireValue(typeof unit.authenticated === 'boolean', 'Every adapter declares whether it authenticates');
    requireValue(Number.isInteger(unit.maxNativeCalls) && unit.maxNativeCalls >= 0 && Number.isFinite(unit.maxSpend) && unit.maxSpend >= 0, 'Each adapter needs finite native call/spend bounds');
    requireValue(unit.authenticated || (unit.maxNativeCalls === 0 && unit.maxSpend === 0), 'Credential-free unit cannot declare paid/native inference');
    requireValue(Number.isInteger(unit.timeoutMs) && unit.timeoutMs >= 50 && unit.timeoutMs <= 1800000, 'Bounded adapter timeout required');
    requireValue(Array.isArray(unit.argv) && unit.argv.length >= 2 && unit.argv[0] === plan.runtimeNode.executable.path && unit.argv[1] === unit.adapter?.path, 'Adapters use the bound Node executable and digest-pinned JavaScript file');
    exactDigest(unit.adapter.sha256, 'live adapter');
    checkObservations({}, unit.assertions);
    calls += unit.maxNativeCalls; spend += unit.maxSpend;
  }
  requireValue(calls <= budget.maxNativeCalls && spend <= budget.maxSpend, 'Declared adapter totals exceed campaign ceiling');
  requireValue(plan.liveUnits.length + 11 <= budget.maxCommands, 'Command budget must cover runtime/npm version, AGY version/help, five offline commands, compatibility, fake catalog and live units');
}

export async function run(options) {
  const isHost = options.mode === 'host';
  const gate = () => { if (isHost) requireValue(hostname() === options['expected-hostname'], 'Hostname changed; dependent unit stopped'); };
  gate();
  const root = await realpath(options['candidate-root'] ?? process.cwd());
  requireValue(root === await realpath(fileURLToPath(new URL('..', import.meta.url))), 'Execute the runner belonging to the selected candidate root');
  requireValue(!root.split(/[\\/]/).includes('transfers'), 'Execute from a verified materialized candidate, never a transfer checkout');
  let plan = null, planSha256 = null;
  if (isHost) {
    requireValue(options.plan && options['plan-sha256'], 'Host execution requires --plan and externally verified --plan-sha256');
    exactDigest(options['plan-sha256'], 'plan');
    const bytes = await readFile(options.plan); planSha256 = sha256(bytes);
    requireValue(planSha256 === options['plan-sha256'], 'Plan digest mismatch');
    plan = JSON.parse(bytes); validateHostPlan(plan, options);
  } else requireValue(!options.plan && !options['plan-sha256'], 'Source mode cannot execute host adapters');
  const units = [...sourceUnits, ...(plan?.liveUnits ?? []).map(unit => ({ ...unit, dependsOn: [...new Set(['offline', 'compatibility', 'fake-catalog', ...unit.dependsOn])], evidenceKind: 'approved adapter observations; scope remains the named scenario' }))];
  const requested = options.unit ?? 'all';
  const selected = requested === 'all' ? units.map(unit => unit.id) : requested === 'live' ? units.filter(unit => unit.id.startsWith('live-')).map(unit => unit.id) : [requested];
  if (requested === 'plan') {
    process.stdout.write(JSON.stringify({ schema: 'antigravity-qualification-result/v1', mode: options.mode, planSha256, status: 'authored', executed: false, units: units.map(unit => ({ id: unit.id, dependsOn: unit.dependsOn, authored: true, executed: false, status: 'unverified' })), installedHostAcceptance: 'unverified; t007 executes and t008 independently checks docs/phase2/ACCEPTANCE.md' }, null, 2) + '\n'); return;
  }
  if (!isHost) exactRevision(options['source-identity'], 'source identity');
  requireValue(selected.length > 0, 'No live adapters are bound; live acceptance remains unverified');
  const timeoutMs = Number(options['timeout-ms'] ?? 600000);
  requireValue(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 1800000, 'Source command timeout must be 1000–1800000ms');
  let temp = null, commands = 0, identities = null, frozenExport = null;
  const sourceRuntimeFlags = ['runtime-node', 'runtime-node-version', 'runtime-node-sha256'];
  const explicitRuntime = sourceRuntimeFlags.some(key => options[key] !== undefined);
  requireValue(!isHost || !explicitRuntime, 'Host runtime comes only from the frozen plan');
  requireValue(!explicitRuntime || sourceRuntimeFlags.every(key => options[key]), 'Source runtime requires executable, exact version and digest');
  const runtimeNode = isHost ? plan.runtimeNode : { version: options['runtime-node-version'] ?? process.version, executable: { path: options['runtime-node'] ?? process.execPath, sha256: options['runtime-node-sha256'] ?? await fileDigest(process.execPath) } };
  const buildNode = isHost ? plan.buildNode.executable.path : process.execPath;
  const npmCli = isHost ? plan.buildNpm.cli.path : await realpath(join(dirname(buildNode), 'npm'));
  const verifyRuntime = async () => { await verifyFile(runtimeNode.executable, 'Runtime Node executable'); await verifyNodeResolution(runtimeNode.executable.path); };
  const started = Date.now();
  const baseEnv = node => ({ PATH: dirname(node) + ':/usr/bin:/bin', HOME: temp, TMPDIR: temp, TMP: temp, TEMP: temp, NODE_NO_WARNINGS: '1' });
  const invoke = async (argv, limit = timeoutMs, extraEnv = {}) => {
    gate(); commands++;
    if (isHost) {
      requireValue(commands <= plan.budget.maxCommands, 'Campaign command count exhausted');
      const remaining = plan.budget.maxElapsedMs - (Date.now() - started);
      requireValue(remaining >= 50, 'Campaign elapsed budget exhausted'); limit = Math.min(limit, remaining);
    }
    return await executeBounded(argv, { cwd: root, env: { ...baseEnv(argv[0] === runtimeNode.executable.path ? runtimeNode.executable.path : buildNode), ...extraEnv }, timeoutMs: limit });
  };
  const verifyHostBindings = async () => {
    gate();
    requireValue(process.version === plan.buildNode.version, 'Build Node version mismatch');
    requireValue(await realpath(process.execPath) === await realpath(plan.buildNode.executable.path), 'Runner must use the bound build Node executable');
    await verifyFile(plan.buildNode.executable, 'Build Node executable');
    await verifyNodeResolution(buildNode);
    await verifyFile(plan.buildNpm.cli, 'Build npm CLI');
    await verifyRuntime();
    const wanted = JSON.parse(await readFile(join(root, 'build-toolchain.json'), 'utf8'));
    requireValue(plan.buildNode.version === `v${wanted.node}` && plan.buildNpm.version === wanted.npm, 'Build bindings differ from pinned toolchain');
    requireValue(await realpath(join(dirname(buildNode), 'npm')) === await realpath(npmCli), 'Build PATH npm differs from bound CLI');
    for (const unit of plan.liveUnits) await verifyExecutableClosure(unit.adapter);
    await verifyFile(plan.agy.executable, 'AGY executable');
    await verifyFile(plan.hostGovernance.file, 'host governance');
    await verifyFile(plan.candidate.tarball, 'qualified tarball');
    frozenExport = await verifyFrozenExport(plan.candidate.export, root);
    await verifyFile(plan.openclawPackage, 'OpenClaw package metadata');
    requireValue(await realpath(plan.openclawPackage.path) === join(await realpath(plan.openclawRoot), 'package.json'), 'OpenClaw metadata root mismatch');
    requireValue(JSON.parse(await readFile(plan.openclawPackage.path, 'utf8')).version === plan.openclawVersion, 'OpenClaw version mismatch');
    for (const item of plan.configFiles) await verifyFile(item, 'isolated configuration');
    for (const item of plan.fixtureFiles) { requireValue(typeof item.version === 'string' && item.version, 'Fixture version required'); await verifyFile(item, 'native fixture'); }
    const measured = await candidateTree(root);
    requireValue(measured.sha256 === plan.candidate.treeSha256, 'Candidate tree mismatch');
    const pluginRoot = await realpath(plan.pluginRoot);
    const pkg = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'));
    requireValue(pkg.name === '@claw0gang/antigravity', 'Installed plugin identity mismatch');
    const packed = await digestTree(pluginRoot, [...new Set(['package.json', 'openclaw.plugin.json', 'README.md', ...(pkg.files ?? [])])]);
    exactDigest(plan.candidate.packedTreeSha256, 'packed tree');
    requireValue(packed.sha256 === plan.candidate.packedTreeSha256, 'Installed packed plugin tree mismatch');
    const { archiveEntries } = await import('./package-contents.mjs');
    requireValue(sha256(JSON.stringify(await archiveEntries(plan.candidate.tarball.path))) === packed.sha256, 'Installed plugin bytes do not match the frozen package archive');
    return measured;
  };
  const results = await runDependencyGraph(units, selected, async unit => {
    const commandsBefore = commands;
    let offlineEvidence;
    try {
    gate();
    if (unit.id === 'baseline') {
      const tree = isHost ? await verifyHostBindings() : await candidateTree(root);
      await verifyRuntime();
      const fixtureTree = await digestTree(root, ['tests/fixtures']);
      identities = { candidate: { sourceRevision: plan?.candidate.sourceRevision ?? options['source-identity'] ?? null, sourceRevisionBasis: isHost ? 'reviewed plan bound to measured tree/export/tarball' : 'caller-declared; source tree independently measured', treeSha256: tree.sha256, fileCount: tree.fileCount }, hostname: hostname(), governance: plan ? { revision: plan.governanceRevision, host: { repository: plan.hostGovernance.repository, revision: plan.hostGovernance.revision, file: plan.hostGovernance.file } } : null, platform: process.platform, arch: process.arch, buildToolchain: { node: { version: process.version, executable: process.execPath, sha256: await fileDigest(process.execPath) }, npm: { cli: npmCli, ...(isHost ? { version: plan.buildNpm.version, sha256: plan.buildNpm.cli.sha256 } : {}) } }, runtimeNode: { version: runtimeNode.version, executable: runtimeNode.executable.path, sha256: runtimeNode.executable.sha256 }, fixtures: { treeSha256: fixtureTree.sha256, versions: ['AGY 1.1.28 simulated', 'AGY 1.2.2 simulated'], native: plan?.fixtureFiles ?? [] }, openclaw: isHost ? { version: plan.openclawVersion, metadataSha256: plan.openclawPackage.sha256 } : { version: JSON.parse(await readFile(join(root, 'node_modules/openclaw/package.json'), 'utf8')).version, metadataSha256: await fileDigest(join(root, 'node_modules/openclaw/package.json')), status: 'actual SDK dependency; installed Gateway unverified' }, agy: isHost ? { version: plan.agy.version, executableSha256: plan.agy.executable.sha256 } : { status: 'fake child only; native binary unverified' } };
      gate(); temp = isHost ? await safeScope(plan.task) : await mkdtemp(join(tmpdir(), 'antigravity-source-qualification-'));
      const runtimeVersion = await invoke([runtimeNode.executable.path, '--version'], 10000);
      requireValue(successful(runtimeVersion) && runtimeVersion.stdout.trim() === runtimeNode.version, 'Runtime Node version differs from exact binding');
      if (isHost) {
        const npmVersion = await invoke([buildNode, npmCli, '--version'], 10000);
        requireValue(successful(npmVersion) && npmVersion.stdout.trim() === plan.buildNpm.version, 'Build npm version differs from exact binding');
        for (const [name, argv] of [['version', plan.agy.versionArgv], ['help', plan.agy.helpArgv]]) {
          requireValue(argv[0] === plan.agy.executable.path, 'AGY precondition command must use the bound executable');
          const result = await invoke(argv, 10000);
          requireValue(successful(result), `Credential-free AGY ${name} precondition failed`);
          if (name === 'version') requireValue(result.stdout.trim() === plan.agy.version, 'Observed AGY version differs from exact plan');
          if (name === 'help') { exactDigest(plan.agy.helpSha256, 'AGY help output'); requireValue(sha256(result.stdout) === plan.agy.helpSha256, 'Observed AGY help digest differs from frozen fixture'); }
        }
      }
      return { executed: true, status: 'passed', evidenceKind: unit.evidenceKind };
    }
    if (isHost) await verifyHostBindings();
    let result, observations;
    if (unit.id === 'offline') {
      offlineEvidence = { steps: [], failedAt: null };
      const steps = offlineEvidence.steps;
      const recipe = offlineRecipe(root, temp, buildNode, npmCli);
      const outputs = {};
      for (const [name, argv] of recipe) {
        offlineEvidence.failedAt = name;
        result = await invoke(argv);
        steps.push({ name, status: successful(result) ? 'passed' : 'failed', ...bounded(result) });
        if (!successful(result)) break;
        if (['pack', 'export-a', 'export-b'].includes(name)) {
          try { outputs[name] = JSON.parse(result.stdout); }
          catch { throw new Error(`${name} produced invalid JSON evidence; raw output omitted`); }
        }
      }
      observations = { steps };
      if (successful(result)) {
        offlineEvidence.failedAt = 'archive-export-identity-verification';
        const exportA = await readExportIdentity(join(temp, 'export-a/public-export-manifest.json'));
        const exportB = await readExportIdentity(join(temp, 'export-b/public-export-manifest.json'));
        observations.publicExport = verifyReproducedExports(exportA, exportB, frozenExport);
        const filename = outputs.pack[0]?.filename;
        requireValue(typeof filename === 'string' && !filename.includes('/') && !filename.includes('..'), 'Invalid package filename');
        const tarballSha256 = await fileDigest(join(temp, filename));
        if (isHost) requireValue(tarballSha256 === plan.candidate.tarball.sha256, 'Reproduced tarball differs from frozen qualified input');
        requireValue((await candidateTree(root)).sha256 === identities.candidate.treeSha256, 'Build changed frozen candidate bytes; freeze new identity before qualification');
        observations.tarballSha256 = tarballSha256;
      }
    } else if (unit.id === 'fake-catalog') {
      const names = fakeFiles.map(name => name + '.test.ts');
      result = await invoke([process.execPath, '--import', 'tsx', '--import', join(root, 'tests/source-sdk-loader.mjs'), '--test', '--test-concurrency=1', ...names.map(name => join(root, 'tests', name))]);
    } else if (unit.id === 'compatibility') {
      await verifyRuntime();
      result = await invoke(compatibilityCommand(root, runtimeNode.executable.path, hostname(), isHost ? plan.pluginRoot : root, isHost ? plan.openclawRoot : join(root, 'node_modules/openclaw'), isHost ? plan.candidate.sourceRevision : options['source-identity']), 61000);
      if (successful(result)) {
        observations = JSON.parse(result.stdout);
        requireValue(observations.runtimeNode?.version === runtimeNode.version && observations.runtimeNode?.executableSha256 === runtimeNode.executable.sha256, 'Compatibility evidence runtime Node mismatch');
        if (isHost) { exactDigest(plan.candidate.packedTreeSha256, 'packed tree'); requireValue(observations.artifact.treeSha256 === plan.candidate.packedTreeSha256, 'Packed plugin tree mismatch'); }
      }
    } else {
      await verifyExecutableClosure(unit.adapter);
      const env = {};
      if (unit.authenticated) for (const name of plan.authentication.envNames) { requireValue(process.env[name] !== undefined, `Required authentication environment ${name} is absent`); env[name] = process.env[name]; }
      env.ANTIGRAVITY_QUALIFICATION_PLAN_SHA256 = planSha256;
      env.ANTIGRAVITY_QUALIFICATION_EXPECTED_HOSTNAME = options['expected-hostname'];
      env.ANTIGRAVITY_QUALIFICATION_MAX_NATIVE_CALLS = String(unit.maxNativeCalls);
      env.ANTIGRAVITY_QUALIFICATION_MAX_SPEND = String(unit.maxSpend);
      const adapterCommand = [runtimeNode.executable.path, join(root, 'tools/qualification-adapter.mjs'), '--expected-hostname', options['expected-hostname'], '--plan', options.plan, '--plan-sha256', planSha256, '--unit', unit.id];
      result = await invoke(adapterCommand, unit.timeoutMs, env);
      if (successful(result)) {
        const evidence = JSON.parse(result.stdout);
        requireValue(evidence.schema === 'antigravity-observations/v1' && evidence.planSha256 === planSha256 && evidence.unit === unit.id && evidence.sourceTreeSha256 === identities.candidate.treeSha256, 'Adapter evidence identity mismatch');
        requireValue(Array.isArray(evidence.evidence) && evidence.evidence.length > 0 && evidence.evidence.length <= 64, 'Adapter must identify retained non-sensitive evidence');
        for (const item of evidence.evidence) { exactDigest(item.sha256, 'evidence'); requireValue(typeof item.reference === 'string' && item.reference.length <= 256 && !item.reference.startsWith(temp), 'Evidence must identify a durable task-owned artifact, not transient bytes'); }
        const checks = checkObservations(evidence.observations, unit.assertions);
        const allPass = checks.every(check => check.passed);
        observations = { checks, evidence: evidence.evidence, nativeCalls: evidence.nativeCalls, spend: evidence.spend, meteringBasis: 'approved adapter reports and enforces native call/spend bounds; runner enforces time and process count' };
        requireValue(Number.isInteger(evidence.nativeCalls) && evidence.nativeCalls >= 0 && evidence.nativeCalls <= unit.maxNativeCalls && Number.isFinite(evidence.spend) && evidence.spend >= 0 && evidence.spend <= unit.maxSpend, 'Adapter reported exceeding or missing its native call/spend bounds');
        if (!allPass) result.failure = 'observable-assertion-failed';
      }
    }
    await verifyRuntime();
    if (isHost) await verifyHostBindings();
    return { executed: true, status: successful(result) ? 'passed' : 'failed', evidenceKind: unit.evidenceKind, ...(unit.rows ? { rows: unit.rows, scenario: unit.scenario } : {}), ...bounded(result), ...(observations ? { observations } : {}) };
    } catch (error) { error.executed = commands > commandsBefore; if (offlineEvidence) error.boundedEvidence = offlineEvidence; throw error; }
  });
  let passed = results.every(result => result.status === 'passed');
  let cleanup = { status: 'not-allocated', path: null };
  if (temp) {
    if (passed) {
      try { gate(); await rm(temp, { recursive: true }); try { await lstat(temp); throw new Error('Owned transient cleanup did not remove path'); } catch (error) { if (error.code !== 'ENOENT') throw error; } cleanup = { status: 'removed-and-verified', path: temp }; }
      catch { passed = false; cleanup = { status: 'failed; disposition remains pending', path: temp }; }
    }
    else cleanup = { status: 'disposable-diagnostics-left; not durable evidence', path: temp };
  }
  process.stdout.write(JSON.stringify({ schema: 'antigravity-qualification-result/v1', mode: options.mode, planSha256, identities, status: passed ? 'passed' : 'failed', durationMs: Date.now() - started, commands, units: results, cleanup, installedHostAcceptance: 'unverified beyond explicitly executed adapter scenarios; t007 owns matrix results and t008 independent acceptance', acceptanceMatrix: 'docs/phase2/ACCEPTANCE.md', limitations: ['Source SDK and fake-AGY tests do not qualify installed Gateway or native AGY behavior.', 'No arbitrary escaped-descendant cleanup claim.', 'No release, merge, host upgrade or paid inference authority is created by this runner.'] }, null, 2) + '\n');
  if (!passed) process.exitCode = 1;
}
