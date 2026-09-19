// Credential-free source checks use the pinned tsx loader on supported Node.
// The loader does not type-check or build the package. Only source .js imports are remapped.
// Usage: node --import tsx --import ./tests/source-loader.mjs --test tests/agy-process.test.ts
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const sourceRoot = new URL("../src/", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.startsWith(sourceRoot) &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      specifier.endsWith(".js")
    ) {
      const source = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (source.href.startsWith(sourceRoot) && existsSync(fileURLToPath(source))) {
        return nextResolve(source.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
