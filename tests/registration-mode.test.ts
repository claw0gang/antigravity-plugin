import assert from "node:assert/strict";
import test from "node:test";

import antigravityPlugin from "../src/index.ts";

function unavailableRuntime(mode: string): object {
  return new Proxy(Object.create(null), {
    get() {
      throw new Error(`runtime touched during ${mode}`);
    },
  });
}

test("cli-metadata and setup-only registration do not touch runtime", () => {
  for (const registrationMode of ["cli-metadata", "setup-only"] as const) {
    assert.doesNotThrow(() => antigravityPlugin.register({
      registrationMode,
      runtime: unavailableRuntime(registrationMode),
    } as never));
  }
});

test("runtime-capable registration modes still enter compatibility/runtime setup", () => {
  for (const registrationMode of ["full", "discovery"] as const) {
    assert.throws(
      () => antigravityPlugin.register({
        registrationMode,
        runtime: unavailableRuntime(registrationMode),
      } as never),
      new RegExp(`runtime touched during ${registrationMode}`),
    );
  }
});
