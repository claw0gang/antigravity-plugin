// Explicit opt-in to a simulated SDK boundary for source fixtures only.
// This loader cannot establish actual OpenClaw SDK, packed artifact, or live AGY
// compatibility. Default npm test/build never load it.
// Usage: node --import tsx --import ./tests/source-sdk-loader.mjs --test tests/replay-safety.test.ts
import "./source-loader.mjs";
import { registerHooks } from "node:module";

const fixture = new URL(
  new URL(import.meta.url).searchParams.get("helpers") === "absent"
    ? "./fixtures/source-sdk-absent.mjs" : "./fixtures/source-sdk.mjs",
  import.meta.url,
).href;
const adapterRoot = new URL("../src/host/", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier === "openclaw/plugin-sdk/agent-harness-runtime" || specifier === "openclaw/plugin-sdk/plugin-entry") &&
      context.parentURL?.startsWith(adapterRoot)
    ) {
      return nextResolve(fixture, context);
    }
    return nextResolve(specifier, context);
  },
});
