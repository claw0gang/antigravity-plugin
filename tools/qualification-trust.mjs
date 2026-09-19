// Reviewed-adapter module integrity, not a sandbox for the reviewed adapter.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import Module, { isBuiltin } from 'node:module';
import { extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const extensions = new Set(['.mjs', '.cjs', '.json']);
const hash = value => createHash('sha256').update(value).digest('hex');
function demand(condition, message) { if (!condition) throw new Error(message); }

export function verifyBoundFile(binding, label = 'Executable closure', maxBytes = 33554432) {
  demand(binding && typeof binding.path === 'string' && isAbsolute(binding.path) && resolve(binding.path) === binding.path && /^[a-f0-9]{64}$/.test(binding.sha256 ?? ''), `${label} needs a canonical path and exact SHA256`);
  const stat = lstatSync(binding.path);
  demand(realpathSync(binding.path) === binding.path && stat.isFile(), `${label} must be a canonical regular file`);
  demand(stat.size <= maxBytes, `${label} file exceeds its byte limit`);
  const bytes = readFileSync(binding.path);
  demand(bytes.length <= maxBytes, `${label} file exceeds its byte limit`);
  demand(hash(bytes) === binding.sha256, `${label} digest mismatch: ${binding.path}`);
  return bytes;
}

export async function verifyExecutableClosure(adapter) {
  demand(adapter && Array.isArray(adapter.closure) && adapter.closure.length > 0 && adapter.closure.length <= 4096, 'Adapter requires an explicit executable closure of 1–4096 files');
  const paths = new Set();
  let total = 0;
  for (const binding of adapter.closure) {
    demand(!paths.has(binding?.path), 'Duplicate adapter executable closure path');
    demand(extensions.has(extname(binding?.path ?? '')), 'Adapter closure files must use explicit .mjs, .cjs or .json extensions');
    paths.add(binding.path);
    total += verifyBoundFile(binding, 'Adapter executable closure').length;
    demand(total <= 134217728, 'Adapter executable closure exceeds 128 MiB');
  }
  demand(adapter.closure.some(binding => binding.path === adapter.path && binding.sha256 === adapter.sha256), 'Adapter entry is absent from its exact executable closure');
  demand(['.mjs', '.cjs'].includes(extname(adapter.path)), 'Adapter entry must be .mjs or .cjs');
  return adapter.closure.map(({ path, sha256 }) => ({ path, sha256 }));
}

export function explicitModulePath(specifier, parentURL, commonjs = false) {
  if (isBuiltin(specifier)) return null;
  demand(typeof specifier === 'string' && (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('file:') || isAbsolute(specifier)), 'Adapter imports require an explicit file path or Node builtin; package resolution is forbidden');
  const url = specifier.startsWith('file:') ? new URL(specifier) : new URL(specifier, parentURL);
  demand(url.protocol === 'file:' && !url.search && !url.hash, 'Adapter imports require plain file URLs');
  const path = fileURLToPath(url);
  demand(extensions.has(extname(path)), 'Adapter import requires an explicit .mjs, .cjs or .json file');
  demand(!commonjs || extname(path) !== '.mjs', 'CommonJS adapters must use dynamic import for .mjs modules');
  return path;
}

export function closureReader(entries) {
  const bindings = new Map(entries.map(binding => [binding.path, binding]));
  return path => {
    demand(bindings.has(path), `Unbound adapter executable dependency: ${path}`);
    return verifyBoundFile(bindings.get(path), 'Adapter dependency');
  };
}

export function installCommonJsGuard(entries) {
  const read = closureReader(entries);
  const originalResolve = Module._resolveFilename;
  const originalCompile = Module.prototype._compile;
  Module._resolveFilename = function (request, parent, isMain, options) {
    const requested = explicitModulePath(request, parent?.filename ? pathToFileURL(parent.filename) : new URL('file:///'), true);
    if (requested === null) return originalResolve.call(this, request, parent, isMain, options);
    read(requested);
    const filename = originalResolve.call(this, request, parent, isMain, options);
    demand(filename === requested, 'Adapter CommonJS resolution changed the bound path');
    return filename;
  };
  Module.prototype._compile = function (content, filename, ...rest) {
    demand(extname(filename) === '.cjs', 'Adapter CommonJS code must use an explicit .cjs file');
    const bytes = read(filename);
    // Compile the verified bytes themselves, avoiding a verify/read race in the
    // ordinary CommonJS extension handler. CJS wrapping remains Node-native.
    return originalCompile.call(this, bytes.toString('utf8'), filename, ...rest);
  };
  Module._extensions['.json'] = function (module, filename) {
    const text = read(filename).toString('utf8').replace(/^\uFEFF/, '');
    module.exports = JSON.parse(text);
  };
  Module._extensions['.node'] = function () { throw new Error('Adapter native addons are outside the executable closure contract'); };
}
