/**
 * Actual SDK artifact checks with injected inventory only; never calls AGY or a Gateway.
 * Run each SDK in a separate process. For a source entry, preload tsx (no SDK fixture loader):
 * node --import tsx tests/sdk-native-catalog-observation.mjs <expected-host> <absolute-sdk-root> <absolute-plugin-entry> <absolute-manifest>
 * A built dist/index.js entry needs no tsx preload. The SDK package must already exist.
 * Hashed module names deliberately pin these observations to the inspected artifacts;
 * they are test inputs, not plugin runtime dependencies or support-floor expansion.
 */
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [expectedHost, sdkInput, entryInput, manifestInput] = process.argv.slice(2);
assert.ok(expectedHost, 'Usage: <expected-host> <absolute-sdk-root> <absolute-plugin-entry> <absolute-manifest>');
assert.equal(hostname(), expectedHost, 'HOST: FAIL; artifact checks not run');
for (const value of [sdkInput, entryInput, manifestInput]) assert.ok(value && isAbsolute(value), 'Artifact paths must be absolute');
const sdkRoot = realpathSync(sdkInput);
const pluginEntry = realpathSync(entryInput);
const manifestPath = realpathSync(manifestInput);
const workspaceDir = dirname(manifestPath);
const { version } = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8'));
const artifacts = {
  '2026.9.4': {
    augment: ['model-catalog-COqhv7i5.mjs', 't'],
    view: ['models-list-result-DQISZ5rG.mjs', 'n'],
    discovery: ['provider-discovery-Cez8pC22.mjs', 'o'],
    owners: ['providers-CrvLkWjz.mjs', 'o'],
  },
  '2026.11.7': {
    augment: ['model-catalog--9SYJHcp.mjs', 't'],
    view: ['model-catalog-view-D2uFSNsQ.mjs', 'a'],
    discovery: ['provider-discovery-DEfcBeRy.mjs', 's'],
    owners: ['providers-Dt43jpJR.mjs', 'o'],
  },
}[version];
assert.ok(artifacts, `No frozen SDK artifact observation for ${version}`);

// Resolve the tested plugin's public SDK imports to the explicit artifact root,
// independently of the repository's development node_modules link.
const sdkRequire = createRequire(pathToFileURL(join(sdkRoot, 'package.json')));
const sdkPaths = new Map([
  'openclaw/plugin-sdk/plugin-entry', 'openclaw/plugin-sdk/agent-harness-runtime',
  'openclaw/plugin-sdk/session-store-runtime',
].map((specifier) => [specifier, sdkRequire.resolve(specifier)]));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'openclaw' || specifier.startsWith('openclaw/')) {
      assert.ok(sdkPaths.has(specifier), `Unexpected public SDK import: ${specifier}`);
      return nextResolve(pathToFileURL(sdkPaths.get(specifier)).href, context);
    }
    return nextResolve(specifier, context);
  },
});
const load = async ([file, name]) => (await import(pathToFileURL(join(sdkRoot, 'dist', file)).href))[name];
const plugin = await import(pathToFileURL(pluginEntry).href);
const augment = await load(artifacts.augment);
const makeView = await load(artifacts.view);
const runProviderCatalog = await load(artifacts.discovery);
const discoverOwners = await load(artifacts.owners);
const { planPluginDiscoveryRuntime } = await import(pathToFileURL(join(sdkRoot, 'dist/plugins/provider-discovery.runtime.js')).href);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
assert.deepEqual(manifest.providers, ['antigravity']);
assert.equal(manifest.cliBackends, undefined);
assert.equal(manifest.syntheticAuthRefs, undefined);
assert.equal(manifest.modelCatalog?.providers, undefined);
assert.equal(manifest.modelCatalog?.discovery?.['antigravity-cli'], undefined);
assert.equal(plugin.buildAntigravityCliBackend, undefined);

const model = Object.freeze({ id: 'opaque-native-Model.v1', name: 'Simulated native inventory' });
let inventoryCalls = 0;
const discoverModels = async ({ scope }) => {
  inventoryCalls += 1;
  assert.equal(scope.command, process.execPath);
  return [model];
};
const unexpected = () => { throw new Error('Unexpected credential or session operation in catalog-only artifact check'); };
const pluginConfig = plugin.resolveAntigravityPluginConfig({ command: process.execPath });
const options = { pluginConfig, discoverModels };
const provider = plugin.createAntigravityProvider(options);
const harness = plugin.createAntigravityHarness({
  ...options,
  sessionRuntime: { getSessionEntryAsync: unexpected, prepareSessionEntryPatch: unexpected },
});
assert.equal(provider.id, 'antigravity');
assert.deepEqual(provider.auth, []);
assert.equal(provider.prepareSyntheticAuth, undefined);
assert.equal(provider.resolveSyntheticAuth, undefined);
assert.equal(provider.staticCatalog, undefined);
assert.equal(harness.id, 'antigravity');
assert.equal(harness.authBootstrap, 'harness');
assert.deepEqual(harness.autoSelection?.providerIds, ['antigravity']);

const legacy = version === '2026.9.4';
const config = {
  plugins: { entries: { antigravity: { enabled: true, config: { command: process.execPath } } } },
  agents: { defaults: { workspace: workspaceDir, ...(legacy ? { model: { primary: `antigravity/${model.id}` } } : {}) } },
  ...(legacy ? { models: { providers: { antigravity: { agentRuntime: { id: 'antigravity' } } } } } : {}),
};
// Manifest owner selection and runtime planning require neither credentials nor
// syntheticAuthRefs. No full plugin loader or Gateway lifecycle is started here.
const index = { plugins: [{ pluginId: 'antigravity', origin: 'global' }] };
const manifestRegistry = { plugins: [{ ...manifest, origin: 'global' }], diagnostics: [] };
const owners = discoverOwners({ config, env: {}, registry: index, manifestRegistry });
assert.deepEqual(owners, ['antigravity']);
const plan = planPluginDiscoveryRuntime({ config, env: {}, pluginMetadataSnapshot: { index, manifestRegistry } });
assert.equal(plan.kind, 'runtime');
assert.deepEqual(plan.pluginIds, ['antigravity']);

const catalog = await runProviderCatalog({
  provider, config, agentDir: '/SIMULATED-agent', workspaceDir, env: {},
  resolveProviderApiKey: unexpected, resolveProviderAuth: unexpected,
});
assert.deepEqual(catalog.provider.models.map(({ id }) => id), [model.id]);
assert.equal(provider.normalizeModelId({ modelId: model.id }), model.id);
assert.equal(provider.normalizeModelId({ modelId: 'unadvertised-alias' }), 'unadvertised-alias');
assert.equal((await provider.prepareDynamicModel({ provider: 'antigravity', modelId: model.id, config, workspaceDir }))?.id, model.id);
assert.equal(await provider.prepareDynamicModel({ provider: 'antigravity', modelId: 'unadvertised-alias', config, workspaceDir }), undefined);

const registration = { pluginId: 'antigravity', source: 'runtime', harness };
const pluginRegistry = { agentHarnesses: [registration], plugins: [], ...(legacy ? { providers: [] } : {}) };
const scope = { config, agentId: 'main', agentDir: '/SIMULATED-agent', workspaceDir };
const readinessScope = { ...scope, provider: 'antigravity', modelId: model.id };
assert.equal(harness.readModelCatalogReadiness(readinessScope), undefined);
const snapshot = await augment({
  cfg: config, agentId: scope.agentId, agentDir: scope.agentDir, workspaceDir, pluginRegistry,
  snapshot: { entries: [], routeVariants: [] }, defaultProvider: 'antigravity',
  ...(legacy ? { defaultModel: model.id } : {}), includePickerRuntimes: true,
});
assert.equal(snapshot.entries.length, 1);
assert.equal(snapshot.entries[0].id, model.id);
assert.equal(snapshot.entries[0].nativeRuntime, 'antigravity');
assert.deepEqual(harness.readModelCatalogReadiness(readinessScope), { accountType: 'unreported' });
const metadataSnapshot = legacy ? {
  plugins: [], index: { plugins: [] },
  owners: { providers: new Map(), cliBackends: new Map(), agentHarnesses: new Map() },
  manifestRegistry: { plugins: [], diagnostics: [] },
} : { plugins: [] };
const facts = { cfg: config, agentId: scope.agentId, agentDir: scope.agentDir, workspaceDir, snapshot, metadataSnapshot, pluginRegistry,
  ...(legacy ? { preparedAuthStore: { version: 1, profiles: {} } } : {}) };
const host = { availability: false, routeResolution: null };
const evaluate = (overrides = {}) => makeView({ ...facts, ...overrides }).evaluateNative(snapshot.entries[0], host);
const native = evaluate();
assert.equal(native.availability, true);
assert.equal(native.routeResolution, null);
assert.equal(native.selectedAuthMode, undefined);
if (!legacy) {
  assert.deepEqual(native.runtimeAuth, { id: 'antigravity', source: 'native' });
  assert.deepEqual(native.selectedCredential, { source: 'harness' });
}
const withReadiness = (callback) => ({ ...pluginRegistry, agentHarnesses: [{ ...registration, harness: { ...harness, readModelCatalogReadiness: callback } }] });
assert.equal(evaluate({ pluginRegistry: withReadiness(undefined) }).availability, !legacy);
assert.equal(evaluate({ pluginRegistry: withReadiness(() => undefined) }).availability, false);
const authored = { ...config, models: { providers: { antigravity: { agentRuntime: { id: 'antigravity' }, baseUrl: 'https://unreachable.invalid', api: 'openai-responses', models: [] } } } };
assert.equal(evaluate({ cfg: authored }), host);
assert.equal(inventoryCalls, 4);
console.log(JSON.stringify({
  result: 'PASS', sdk: version, pluginEntry, manifestPath,
  evidence: 'actual SDK pure functions and plugin factory hooks; simulated inventory, no native AGY or Gateway execution',
  inventoryCalls, ownerPlan: plan.kind, exactModelId: model.id,
  syntheticAuth: 'absent', aliasFallback: 'absent', native,
  readinessRequired: legacy, missingObservationUnavailable: true, authoredRoutePreserved: true,
  artifactModules: Object.fromEntries(Object.entries(artifacts).map(([name, [file]]) => [name, file])),
}, null, 2));
