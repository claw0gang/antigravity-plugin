import * as harnessSdk from "openclaw/plugin-sdk/agent-harness-runtime";
import { normalizeTerminalWithSdk, type TerminalInput } from "./helpers.js";

export const agentHarnessAttemptTerminal = Object.freeze({
  normalize(input: TerminalInput) {
    return normalizeTerminalWithSdk(input, harnessSdk);
  },
  setFailure(
    terminal: Parameters<typeof harnessSdk.agentHarnessAttemptTerminal.setFailure>[0],
    failure: Parameters<typeof harnessSdk.agentHarnessAttemptTerminal.setFailure>[1],
  ) {
    return harnessSdk.agentHarnessAttemptTerminal.setFailure(terminal, failure);
  },
});
