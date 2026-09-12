# ANTIGRAVITY for OpenClaw

ANTIGRAVITY lets OpenClaw delegate agent turns to the Google Antigravity CLI (`agy`) through a native `AgentHarnessV2` runtime.

This repository is the **public release mirror** for the ClawHub package `@claw0gang/antigravity`. Development and release governance happen in a separate canonical repository; this mirror contains only the source and documentation needed to build and inspect the public plugin.

## Requirements

- OpenClaw plugin API `>=2026.9.2 <2027.0.0`
- OpenClaw Gateway `>=2026.9.2`
- Node.js `>=22.12.0`
- Google Antigravity CLI installed, authenticated, and available as `agy` on `PATH` unless `command` is configured explicitly

The package is built against OpenClaw `2026.9.4` as exact build provenance. Runtime compatibility is governed by the compatibility range above rather than exact host patch equality. The current release-validation baseline is OpenClaw `2026.9.4` with AGY `1.2.1`.

## Install from ClawHub

After the package is published on ClawHub:

```bash
openclaw plugins install clawhub:@claw0gang/antigravity
```

ANTIGRAVITY is disabled by default. Enable it explicitly in your OpenClaw configuration.

## Basic configuration

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

`newProject: true` is recommended when you want each fresh OpenClaw session to start in a fresh AGY project. If it is omitted or `false`, AGY uses its normal default project behavior. Instead of `newProject`, you may set `project` to an explicit AGY project. `project` and `newProject: true` are mutually exclusive.

## Available configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `command` | `agy` | AGY executable or command path |
| `printTimeout` | `30m` | Value passed to `agy --print-timeout` |
| `sandbox` | `true` | Pass `--sandbox` to AGY |
| `dangerouslySkipPermissions` | `false` | Explicitly pass AGY `--dangerously-skip-permissions` |
| `newProject` | `false` | Create a new AGY project for a fresh conversation |
| `project` | unset | Use a specific AGY project |
| `mode` | unset | Optional AGY mode: `accept-edits` or `plan` |
| `agent` | unset | Optional AGY agent selector |
| `addDirs` | `[]` | Additional directories exposed to AGY with `--add-dir` |
| `logFile` | unset | Optional AGY log file path |

## Models

The native `antigravity/*` provider has no executable static model rows. It discovers the currently available AGY models through OpenClaw's provider-scoped live catalog path and validates the requested concrete model again before execution.

To inspect the currently published/cached OpenClaw catalog for the provider, use:

```bash
openclaw models list --all --provider antigravity
```

On OpenClaw `2026.9.4`, `models list --provider ... --refresh` performs global provider acquisition and filters the published result afterward; it does not by itself force live discovery for an installed native provider that is not already in OpenClaw's configured discovery scope. Provider-scoped model-catalog surfaces can request live ANTIGRAVITY discovery directly. If a model is unexpectedly absent, also run `agy models` under the same user to confirm the upstream AGY inventory.

Effort-qualified AGY model IDs are exact executable identities. For example, selecting:

```text
antigravity/gemini-3.8-flash-low
```

executes `gemini-3.8-flash-low`; ANTIGRAVITY does not silently replace it with another effort sibling because of an OpenClaw thinking default.

A separate `antigravity-cli/*` namespace remains available for the generic CLI-backend compatibility path.

## Sessions and resume

OpenClaw session identity and AGY conversation identity remain separate. On a fresh native turn, ANTIGRAVITY starts AGY without `--conversation`, records the conversation ID emitted by AGY, and binds it to the OpenClaw session together with the exact model ID.

Later turns resume only that exact AGY conversation with:

```text
--conversation <bound-conversation-id>
```

ANTIGRAVITY does not use AGY `--continue` for native session resume. Changing the concrete model requires a new compatible OpenClaw session lifecycle.

## Native tools and permissions

AGY keeps ownership of its native tools. ANTIGRAVITY reports terminal native-tool outcomes back through OpenClaw's host-owned terminal observation contract and treats completed native tools conservatively as potentially side-effecting and replay-unsafe unless stronger upstream evidence exists.

`dangerouslySkipPermissions` is deliberately off by default. Setting it to `true` requests AGY's unrestricted/always-proceed behavior by passing exactly one `--dangerously-skip-permissions` flag. ANTIGRAVITY does not persist that choice into AGY global settings.

Use unrestricted mode only when you explicitly intend AGY native tools to execute without normal permission review.

## Image input

The native harness accepts supported base64 image inputs for PNG, JPEG/JPG, WebP, and GIF. Images are materialized into private attempt-scoped files, passed to AGY by path, and removed after the attempt.

Malformed base64 and unsupported MIME types fail before AGY execution.

## Security and data boundaries

ANTIGRAVITY launches the configured AGY executable directly with `shell: false`. It does not ship credentials, API keys, account data, host-specific configuration, or AGY authentication material.

The OpenClaw synthetic-auth value used for cold discovery is a control-plane readiness marker only. It is not an HTTP credential and is never sent to AGY.

Your AGY installation and account remain responsible for upstream authentication and for any data handled by AGY itself. Review `addDirs`, `project`, `logFile`, and especially `dangerouslySkipPermissions` before enabling them in a shared or sensitive environment.

## Troubleshooting

If the plugin does not load, confirm your OpenClaw version satisfies the declared plugin API and Gateway compatibility range. If no `antigravity/*` models appear, run `agy models` directly and confirm AGY is installed and authenticated under the same user that runs OpenClaw.

If a new session unexpectedly sees context from an existing AGY project, use `newProject: true` for fresh project isolation or set `project` explicitly. Session resume itself remains bound to the exact AGY conversation created for that OpenClaw session.

For exact runtime attribution, inspect OpenClaw's reported provider/model and terminal receipt. The plugin attributes assistant output to the exact AGY model used for the turn and fails closed on model/session inconsistencies.

## Update or remove

Use OpenClaw's normal ClawHub plugin update flow for later published versions. To remove the plugin, use OpenClaw's plugin management commands and remove any corresponding configuration entry if it is no longer needed.

## Package identity

- ClawHub package: `@claw0gang/antigravity`
- OpenClaw plugin ID: `antigravity`
- Native provider/runtime: `antigravity/*`
- Compatibility CLI backend: `antigravity-cli/*`
- External executable: `agy`

The release artifact is built from this public mirror and is separately tied to an immutable canonical source commit through release provenance metadata.
