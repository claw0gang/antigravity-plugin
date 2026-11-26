# Architecture

Antigravity Plugin exposes one OpenClaw provider and AgentHarnessV2 runtime, both named `antigravity`. It delegates native inference and tools to the installed Google Antigravity CLI (`agy`).

## Runtime ownership

OpenClaw owns orchestration, session lifecycle, admission, transcripts and result delivery. AGY owns authentication, project access, native conversations, model execution and tool permissions. No replacement CLI, alternate provider, credential reader or separate session database is shipped.

```text
OpenClaw -> antigravity/* -> native harness -> agy
         <- canonical result/transcript <- stream-json
```

The native runtime rejects unsupported host-owned requirements instead of silently changing routing, credentials, permissions or model identity.

## Model discovery and effort

Live model inventory is scoped to the invocation environment, AGY configuration and OpenClaw owner. Exact native IDs remain opaque. Equivalent concurrent acquisitions may share their bounded result; genuine owner/configuration changes, failures, withdrawals and expiry are not hidden. OpenClaw owns catalog publication and retirement.

Supported host thinking controls use native read-only capability information. Native selection (`off`) retains the exact requested model. An effective override requires an unambiguous live variant and a verified matching model/effort invocation; unsupported or contradictory results fail closed.

## Execution and safety

The harness starts a bounded AGY process with a structured text stream and validates native terminal status, model and conversation identity. It preserves partial results and denial/error classification without converting incomplete work to success. Potentially started work is not replayed automatically.

Native execution requires an exact AGY project whose resource root contains the OpenClaw attempt workspace. The default is sandbox enabled, permission bypass disabled and explicit `accept-edits` mode. Unsupported required OpenClaw restrictions reject execution before native admission. AGY controls its own tool permissions.

## Session continuity

### Awaited public session integration

<a id="54-awaited-public-session-integration"></a>

Modern hosts supply awaited public session read/prepare methods and runtime-bound `withSessionEntriesAsync`. A partial modern capability set rejects registration. The older public adapter is selected before work, never after a failed or uncertain modern operation.

Fresh sessions establish an exact native conversation/model binding. Resume validates the current OpenClaw session owner and generation and passes the exact stored conversation with `--conversation`. Model identity must remain compatible with the binding. A supported reset cancels and drains active work before clearing the binding. Revoked/stale attempts cannot publish an unauthorized final result or transcript; failed or ambiguous settlement is not silently retried.

See the [user guide](USER-GUIDE.md) for configuration and operational behavior, and [build instructions](BUILD.md) for the source and packaging workflow.
