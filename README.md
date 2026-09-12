# ANTIGRAVITY for OpenClaw

ANTIGRAVITY connects [OpenClaw](https://github.com/openclaw/openclaw) to the Google Antigravity CLI (`agy`) as a native agent runtime.

It lets OpenClaw select AGY models, run agent turns through AGY's native stream protocol, observe AGY-native tool execution, and resume the exact AGY conversation associated with an OpenClaw session. A separate compatibility CLI backend is also included for legacy/direct CLI routing.

> ⭐ **One tiny request:** use it, change it, fork it, or ask your agent to break it — just give the repo a star first. *(The star is appreciated, not required by the MIT license.)*

> **Public release mirror**
>
> This repository contains the public plugin source and release-facing documentation for `@claw0gang/antigravity`. Development, validation, and release governance are maintained separately. Runtime source provenance is recorded in [`EXPORT-MANIFEST.json`](./EXPORT-MANIFEST.json).

## At a glance

| Surface | Identity |
| --- | --- |
| Package | `@claw0gang/antigravity` |
| OpenClaw plugin | `antigravity` |
| Native provider / harness | `antigravity/*` |
| Compatibility CLI backend | `antigravity-cli/*` |
| External runtime | Google Antigravity CLI (`agy`) |
| Current source version | `0.2.6` |

ANTIGRAVITY does **not** implement its own model API transport. OpenClaw launches the configured `agy` executable locally, and AGY remains responsible for its own authentication, upstream service access, model availability, and native tools.

## Requirements and compatibility

| Requirement | Current expectation |
| --- | --- |
| OpenClaw plugin API | `>=2026.9.2 <2027.0.0` |
| OpenClaw Gateway | `>=2026.9.2` |
| Node.js | `>=22.12.0` |
| Google Antigravity CLI | Installed and authenticated; `agy` on `PATH` unless `command` is configured |
| Release-validation baseline | OpenClaw `2026.9.4`, AGY `1.2.1` |

OpenClaw `2026.9.4` is the exact build and current validation baseline for `0.2.6`; it is **not** an exact-host requirement. AGY `1.2.1` is the validated baseline, not a declared minimum version. Compatibility outside the validated baseline is constrained by the OpenClaw ranges above and by the AGY CLI/protocol behavior the plugin consumes.

## Installation

When the package is available on ClawHub, install it explicitly from that source:

```bash
openclaw plugins install clawhub:@claw0gang/antigravity
```

ANTIGRAVITY is disabled by default. Enable the plugin explicitly and configure an `antigravity/*` model to use the native harness.

To check whether a public package is currently available, use OpenClaw's normal plugin search:

```bash
openclaw plugins search "antigravity"
```

## Configuration

A safe baseline configuration is:

```json5
{
  plugins: {
    allow: ["antigravity"],
    entries: {
      antigravity: {
        enabled: true,
        config: {
          command: "agy",
          printTimeout: "30m",
          sandbox: true,
          dangerouslySkipPermissions: false,
          newProject: true
        }
      }
    }
  },
  agents: {
    defaults: {
      models: {
        "antigravity/*": {
          agentRuntime: { id: "antigravity" }
        }
      }
    }
  }
}
```

`newProject: true` gives each fresh OpenClaw session a fresh AGY project. If it is omitted or `false`, AGY uses its normal project behavior. You can instead set `project` to a specific AGY project; `project` and `newProject: true` are mutually exclusive.

Unknown configuration keys are rejected rather than ignored.

### Configuration reference

| Setting | Default | Behavior |
| --- | --- | --- |
| `command` | `agy` | AGY executable name or path |
| `printTimeout` | `30m` | Value passed to AGY as `--print-timeout` |
| `sandbox` | `true` | Adds `--sandbox` to AGY execution |
| `dangerouslySkipPermissions` | `false` | Explicitly adds AGY `--dangerously-skip-permissions`; see [Permission model](#permission-model) |
| `newProject` | `false` | Adds `--new-project` for a fresh native conversation |
| `project` | unset | Adds `--project <value>` for fresh native conversations |
| `mode` | unset | Optional AGY mode: `accept-edits` or `plan` |
| `agent` | unset | Optional AGY agent selector |
| `addDirs` | `[]` | Additional directories passed with repeated `--add-dir` arguments |
| `logFile` | unset | Optional AGY log path passed with `--log-file` |

## How execution works

For the native `antigravity/*` path:

1. OpenClaw selects an ANTIGRAVITY model and invokes the `antigravity` AgentHarnessV2 runtime.
2. ANTIGRAVITY runs `agy models` and requires the requested concrete model to exist in the live AGY inventory.
3. The plugin starts `agy` directly with `shell: false`, `--output-format stream-json`, the selected model, and the configured execution options.
4. AGY emits its conversation identity and stream events. ANTIGRAVITY binds that AGY conversation to the current OpenClaw session before accepting runtime activity.
5. Assistant output, usage, native-tool terminal observations, and the exact runtime model identity are returned through OpenClaw's native harness contract.

The compatibility namespace `antigravity-cli/*` uses OpenClaw's generic CLI-backend contract instead. It is retained for compatibility; the native `antigravity/*` path is the primary integration.

## Models and model discovery

### Native provider: `antigravity/*`

The native provider does not depend on executable static model rows. It discovers the currently available AGY inventory with the documented plain `agy models` command and exposes that inventory through OpenClaw's provider-scoped live catalog path.

Every native execution validates the concrete model against the live AGY inventory again. If AGY no longer advertises the selected model, the attempt fails instead of silently routing to another model.

Inspect what OpenClaw currently has for the provider with:

```bash
openclaw models list --all --provider antigravity
```

If the expected model is absent, compare it with AGY directly:

```bash
agy models
```

On the `2026.9.4` validation baseline, OpenClaw's global `models list --provider ... --refresh` behavior does not necessarily force provider-scoped live discovery for an installed native provider that is outside the configured discovery scope. Provider-scoped catalog surfaces can request ANTIGRAVITY's live catalog directly.

### Effort-qualified model IDs

AGY publishes effort-qualified Gemini siblings as distinct executable model IDs, for example:

```text
antigravity/gemini-3.8-flash-low
antigravity/gemini-3.8-flash-medium
antigravity/gemini-3.8-flash-high
```

ANTIGRAVITY treats each concrete ID as an exact selection. OpenClaw thinking defaults do not silently replace one effort-qualified AGY model with a sibling.

The plugin also normalizes these convenience aliases to canonical AGY IDs:

| Alias | Canonical AGY model |
| --- | --- |
| `sonnet-4-6` | `claude-sonnet-4-6` |
| `opus-4-6` | `claude-opus-4-6-thinking` |
| `gpt-oss` | `gpt-oss-120b-medium` |

The `antigravity-cli/*` compatibility backend carries a static compatibility catalog. Native model availability remains authoritative from live `agy models` discovery.

## Sessions and resume

OpenClaw session identity and AGY conversation identity are intentionally separate.

On the first native turn, ANTIGRAVITY starts AGY without `--conversation`. After AGY emits its conversation ID, the plugin stores a session binding containing the OpenClaw session identity, AGY conversation ID, and exact resolved model ID.

Later turns resume only that bound conversation:

```text
--conversation <bound-conversation-id>
```

ANTIGRAVITY does not use AGY `--continue` for native resume.

Resume is fail-closed: a missing canonical model binding, a model mismatch, an unexpected AGY conversation ID, an ambiguous OpenClaw session entry, or a conflicting existing binding is treated as an error. To switch the concrete model, start a new compatible OpenClaw session lifecycle rather than reusing a conversation bound to another model.

## Native tools

AGY owns and executes its native tools. ANTIGRAVITY forwards completed native-tool outcomes into OpenClaw's host-owned terminal observation contract.

Until AGY provides trusted per-tool mutation classification, every completed native tool is treated conservatively as potentially mutating and replay-unsafe. This prevents OpenClaw from assuming that a completed tool can safely be replayed after an interruption.

## Permission model

The plugin's default posture is restricted:

- `sandbox` defaults to `true`.
- `dangerouslySkipPermissions` defaults to `false`.
- Unrestricted execution is never inferred from another setting.
- The plugin does not persist permission changes into AGY global configuration.

Setting:

```json5
dangerouslySkipPermissions: true
```

adds exactly one AGY `--dangerously-skip-permissions` flag to native and compatibility execution. This is an explicit opt-in to AGY's unrestricted/always-proceed permission mode for native tools.

Use it only when you intentionally want AGY native tools to proceed without the normal permission review.

## Fail-closed behavior

ANTIGRAVITY is designed to reject inconsistent or unsafe execution state rather than recover by guessing. In particular, native execution fails on conditions such as:

- requested model absent from the live AGY inventory;
- invalid or conflicting session bindings;
- resumed AGY conversation identity not matching the bound conversation;
- AGY stream protocol errors;
- AGY process exit status contradicting its terminal protocol status;
- malformed base64 image input or an unsupported image MIME type;
- invalid plugin configuration.

The plugin does not silently substitute a different model or resume an unrelated AGY conversation.

## Image input

The native harness accepts base64 image input for:

- PNG
- JPEG/JPG
- WebP
- GIF

Images are written to private (`0600`) attempt-scoped temporary files, passed to AGY by path, and removed after the attempt. Invalid base64 and unsupported MIME types fail before AGY execution.

## Security and data boundaries

ANTIGRAVITY launches the configured AGY executable directly with `shell: false`.

The plugin does not ship Google credentials, API keys, account data, host-specific configuration, or AGY authentication material. AGY remains responsible for its own authentication and for upstream data handling.

OpenClaw may ask the provider for a synthetic authentication marker during cold discovery. For ANTIGRAVITY, successful bounded AGY model discovery is the readiness proof; the returned marker is control-plane metadata only. It is not an HTTP credential and is never sent to AGY.

Review `addDirs`, `project`, `logFile`, and especially `dangerouslySkipPermissions` before enabling the plugin in a shared or sensitive environment.

## Intentional limitations

ANTIGRAVITY intentionally does not provide:

- a direct Google or model-provider HTTP client;
- bundled AGY credentials or account provisioning;
- automatic enablement of unrestricted permissions;
- automatic project isolation unless `newProject: true` or an explicit `project` is configured;
- silent model fallback when a requested model disappears;
- model switching inside an already-bound native AGY conversation;
- a trusted fine-grained mutation classification for AGY-native tools;
- a guarantee that AGY model availability, quotas, or upstream behavior remain stable outside the validated environment.

The compatibility `antigravity-cli/*` backend exists for generic CLI integration and should not be treated as equivalent to the native harness contract.

## Verification and troubleshooting

After installation and configuration, these checks isolate the most common problems:

| Check | Command / action |
| --- | --- |
| AGY is installed and authenticated | `agy models` |
| Plugin runtime registrations loaded | `openclaw plugins inspect antigravity --runtime --json` |
| OpenClaw catalog contains ANTIGRAVITY models | `openclaw models list --all --provider antigravity` |
| Plugin API compatibility | Confirm OpenClaw satisfies `>=2026.9.2 <2027.0.0` |
| Gateway compatibility | Confirm the Gateway satisfies `>=2026.9.2` |
| Fresh project isolation | Set `newProject: true` |
| Reuse a specific AGY project | Set `project` and leave `newProject` false/unset |

If the plugin does not load, first check the OpenClaw/Gateway versions and plugin configuration. If no native models appear, run `agy models` under the same OS user that runs OpenClaw. If a new session unexpectedly inherits AGY project context, enable `newProject` or configure an explicit `project`.

For runtime attribution problems, inspect OpenClaw's reported provider/model and terminal result. ANTIGRAVITY reports the exact resolved AGY model used for the native turn.

## Comparison with Claude CLI and Codex

The table below is a high-level OpenClaw integration comparison for the current `2026.9.x` generation. Bundled integration surfaces can evolve independently of ANTIGRAVITY releases.

| Capability | ANTIGRAVITY | `claude-cli` | Codex |
| --- | --- | --- | --- |
| Runtime type | **Native plugin harness** + compatibility CLI backend | Bundled **CLI backend** | Full native app-server harness |
| External agent owns loop | AGY | Claude Code | Codex app-server |
| Native session resume | Yes, exact AGY conversation binding | Yes, Claude session IDs / warm subprocess | Yes, full native thread lifecycle |
| Live model discovery | **Yes, from AGY** | Mostly provider/backend-defined | OpenAI/Codex-owned routing |
| Native tools | **Yes, AGY tools** | Yes, Claude Code tools | Yes, Codex shell/patch/MCP/apps |
| Tool observation | Terminal outcomes into OpenClaw | Mature CLI/tool integration | Deep hook/trajectory integration |
| OpenClaw dynamic tools | Not Codex-style integrated | Can expose selected tools through MCP/grants | **Fully supported** |
| Fine-grained approval bridge | Limited; AGY permission mode | Strong Bash/exec allowlist integration | **Strongest**: native approvals + OpenClaw approval routing |
| Session supervision/catalog | No dedicated AGY catalog | Claude session catalog/adoption exists | **Very advanced**: catalog, supervision, branch/resume/steer |
| Native plugins/apps | No | Claude ecosystem behavior | Codex native plugins/apps |
| Computer Use integration | No dedicated integration | Not equivalent | Dedicated Codex integration |

ANTIGRAVITY's current strength is the native runtime foundation: authoritative live AGY models, exact model identity, session-safe resume, AGY-native tools, image input, and fail-closed execution. Its remaining gap versus the deeper bundled integrations is primarily OpenClaw↔AGY control-plane integration: dynamic-tool projection, fine-grained approvals, richer supervision/steering, and specialized host integrations.

## Release and provenance

Version-specific changes are summarized in [`RELEASE-NOTES.md`](./RELEASE-NOTES.md). [`EXPORT-MANIFEST.json`](./EXPORT-MANIFEST.json) records the canonical source commit, runtime source-tree identity, validation baseline, export contents, and artifact state for this public source snapshot.

The public mirror deliberately excludes internal governance records, development-only evidence, tests, and production operational material. Absence of those files from this repository should not be interpreted as absence of upstream validation.

## License

ANTIGRAVITY is released under the [MIT License](./LICENSE). You may use, copy, modify, merge, publish, distribute, sublicense, and sell the software subject to the license notice and disclaimer.

> ⭐ **Made it this far?** You can use it, change it, ship it, or let your agent spectacularly break it. If it survives, giving the repo a star is considered excellent incident-response etiquette. *(Still optional. MIT remains MIT.)*
