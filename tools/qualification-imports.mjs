// Node 22.12-compatible asynchronous hooks cover static and dynamic ESM loads.
// CommonJS/createRequire use the companion guard installed in the main thread.
import { fileURLToPath } from 'node:url';
import { closureReader, explicitModulePath } from './qualification-trust.mjs';

let read;
export function initialize({ entries }) { read = closureReader(entries); }
export async function resolve(specifier, context, nextResolve) {
  const path = explicitModulePath(specifier, context.parentURL ?? 'file:///');
  if (path !== null) read(path);
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url.startsWith('node:')) return nextLoad(url, context);
  if (!url.startsWith('file:')) throw new Error('Adapter executable URLs must be bound files');
  const bytes = read(fileURLToPath(url));
  if (url.endsWith('.mjs')) return { format: 'module', source: bytes, shortCircuit: true };
  if (url.endsWith('.json')) return { format: 'json', source: bytes, shortCircuit: true };
  // Preserve native CommonJS interop; the main-thread guard verifies and compiles
  // the actual bytes for .cjs rather than assuming ESM hooks cover require().
  if (url.endsWith('.cjs')) return nextLoad(url, context);
  throw new Error('Adapter executable file type is unsupported');
}
