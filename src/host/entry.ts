// Namespace import permits the optional helper export to be absent. A missing
// public module or transitive dependency remains a real load error, not fallback.
import * as pluginEntrySdk from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntryWithSdk } from "./helpers.js";

export function definePluginEntry(input: Parameters<typeof definePluginEntryWithSdk>[0]) {
  return definePluginEntryWithSdk(input, pluginEntrySdk);
}
