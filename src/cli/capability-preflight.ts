import { performance } from "node:perf_hooks";
import { runAgyRawProcess } from "./agy-process.js";
import type { InvocationScope } from "./invocation-scope.js";

export const AGY_CAPABILITY_PREFLIGHT_TIMEOUT_MS = 10_000;
export const AGY_CAPABILITY_PREFLIGHT_OUTPUT_BYTES = 128 * 1024;
export const AGY_MINIMUM_SOURCE_TARGET = "1.1.28";
const REQUIRED_FLAGS = ["--input-format", "--output-format", "--model", "--conversation", "--print-timeout"] as const;
const STREAM_TRANSPORT_FLAGS = new Set(["--input-format", "--output-format"]);
const PARSER_PROBE_ARGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "--model": ["--model", "antigravity-capability-probe", "--help"],
  "--conversation": ["--conversation", "00000000-0000-0000-0000-000000000000", "--help"],
  "--print-timeout": ["--print-timeout", "1s", "--help"],
  "--sandbox": ["--sandbox", "--help"],
  "--dangerously-skip-permissions": ["--dangerously-skip-permissions", "--help"],
  "--project": ["--project", "antigravity-capability-probe", "--help"],
  "--new-project": ["--new-project", "--help"],
  "--add-dir": ["--add-dir", ".", "--help"],
  "--agent": ["--agent", "antigravity-capability-probe", "--help"],
  "--mode": ["--mode", "plan", "--help"],
});

type ProbeResult = { exitCode: number; stdout: string; stderr: string };
export type AgyCapabilityProbeExecutor = (params: {
  scope: InvocationScope; args: readonly string[]; timeoutMs: number; maxOutputBytes: number;
}) => Promise<ProbeResult>;

export type AgyCapabilityPreflight = Readonly<{
  version: string;
  /** Backward-compatible field name: required flags proven by help and/or bounded parser probe. */
  advertisedFlags: readonly string[];
  transport: "single-user-line-stdin-eof";
  semanticQualification: "not_executed";
}>;

export class AgyCapabilityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgyCapabilityError";
  }
}

function atLeast(left: readonly [number, number, number], right: readonly [number, number, number]): boolean {
  for (let index = 0; index < 3; index++) {
    if (left[index]! > right[index]!) return true;
    if (left[index]! < right[index]!) return false;
  }
  return true;
}

export function parseAgyVersion(output: string): string {
  const match = /^(?:(?:antigravity(?:\s+cli)?|agy)(?:\s+version)?\s+)?v?(\d+)\.(\d+)\.(\d+)(?:\s*\([^\r\n]*\))?\s*$/iu.exec(output.trim());
  if (!match) throw new AgyCapabilityError("AGY --version did not identify a stable CLI version");
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const version = [major, minor, patch] as const;
  if (!version.every(Number.isSafeInteger) || !atLeast(version, [1, 1, 28])) {
    throw new AgyCapabilityError(`AGY CLI version is below the minimum supported version ${AGY_MINIMUM_SOURCE_TARGET}`);
  }
  return `${major}.${minor}.${patch}`;
}

function normalizeRequiredFlags(requiredFlags: readonly string[]): readonly string[] {
  const required = [...new Set([...REQUIRED_FLAGS, ...requiredFlags])];
  for (const flag of required) {
    if (!/^--[a-z][a-z0-9-]*$/u.test(flag)) throw new AgyCapabilityError("Invalid required AGY capability flag");
  }
  return Object.freeze(required);
}

function findHelpFlagIndex(help: string, flag: string): number {
  return help.split(/\r?\n/u).findIndex((line) => {
    const advertised: readonly string[] = line.match(/--[a-z][a-z0-9-]*/gu) ?? [];
    return advertised.includes(flag);
  });
}

function inspectHelpFlags(help: string, required: readonly string[]): readonly string[] {
  const lines = help.split(/\r?\n/u);
  for (const flag of required) {
    const index = findHelpFlagIndex(help, flag);
    if (index < 0) throw new AgyCapabilityError(`AGY required capability missing: ${flag}`);
    if (flag === "--input-format" || flag === "--output-format") {
      let description = lines[index] ?? "";
      for (let next = index + 1; next < lines.length && !/--[a-z]/u.test(lines[next] ?? ""); next += 1) {
        description += ` ${lines[next]}`;
      }
      if (!/(?:^|[^a-z0-9-])stream-json(?:$|[^a-z0-9-])/u.test(description)) {
        throw new AgyCapabilityError(`AGY required capability missing: ${flag} stream-json`);
      }
    }
  }
  return Object.freeze([...required]);
}

function rootHelpProvesStreamTransport(help: string): boolean {
  try {
    inspectHelpFlags(help, [...STREAM_TRANSPORT_FLAGS]);
    return true;
  } catch (error) {
    if (error instanceof AgyCapabilityError) return false;
    throw error;
  }
}

export function inspectAgyHelp(help: string, requiredFlags: readonly string[] = []): readonly string[] {
  return inspectHelpFlags(help, normalizeRequiredFlags(requiredFlags));
}

/**
 * Bounded, closed-stdin parser checks only: never a prompt, auth workflow or model
 * turn. Root help is accepted when it advertises a required capability, but AGY
 * may omit valid print-mode flags from that surface. Known omitted flags are then
 * parser-probed with --help so help-format churn is not mistaken for capability
 * removal. This proves parser admission only; P02/P03/P06 still own semantics.
 */
export async function preflightAgyCapabilities(params: {
  scope: InvocationScope;
  requiredFlags?: readonly string[];
  execute?: AgyCapabilityProbeExecutor;
}): Promise<AgyCapabilityPreflight> {
  const deadline = Math.min(params.scope.deadlineMonoMs, performance.now() + AGY_CAPABILITY_PREFLIGHT_TIMEOUT_MS);
  const execute = params.execute ?? runAgyRawProcess;
  const required = normalizeRequiredFlags(params.requiredFlags ?? []);
  let outputBytes = 0;

  const query = async (args: readonly string[], label: string): Promise<ProbeResult> => {
    params.scope.assertActive();
    const timeoutMs = deadline - performance.now();
    if (timeoutMs <= 0) throw new AgyCapabilityError("AGY capability preflight deadline expired");
    const remainingBytes = AGY_CAPABILITY_PREFLIGHT_OUTPUT_BYTES - outputBytes;
    if (remainingBytes <= 0) throw new AgyCapabilityError("AGY capability preflight output limit exceeded");
    const result = await execute({ scope: params.scope, args, timeoutMs, maxOutputBytes: remainingBytes });
    params.scope.assertActive();
    if (performance.now() >= deadline) throw new AgyCapabilityError("AGY capability preflight deadline expired");
    outputBytes += Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8");
    if (outputBytes > AGY_CAPABILITY_PREFLIGHT_OUTPUT_BYTES) throw new AgyCapabilityError("AGY capability preflight output limit exceeded");
    if (result.exitCode !== 0) throw new AgyCapabilityError(`AGY ${label} failed (exit ${result.exitCode}); native diagnostics withheld`);
    return result;
  };

  try {
    const version = parseAgyVersion((await query(["--version"], "--version")).stdout);
    const help = (await query(["--help"], "--help")).stdout;

    for (const flag of required.filter((value) => !STREAM_TRANSPORT_FLAGS.has(value))) {
      if (findHelpFlagIndex(help, flag) >= 0) continue;
      const probe = PARSER_PROBE_ARGS[flag];
      if (!probe) throw new AgyCapabilityError(`AGY required capability missing: ${flag}`);
      await query(probe, `${flag} parser probe`);
    }

    if (!rootHelpProvesStreamTransport(help)) {
      await query(
        ["--input-format", "stream-json", "--output-format", "stream-json", "--help"],
        "stream-json parser probe",
      );
    }
    return Object.freeze({
      version,
      advertisedFlags: required,
      transport: "single-user-line-stdin-eof",
      semanticQualification: "not_executed",
    });
  } catch (cause) {
    if (cause instanceof AgyCapabilityError) throw cause;
    throw new AgyCapabilityError("AGY capability preflight failed before inference admission", { cause });
  }
}
