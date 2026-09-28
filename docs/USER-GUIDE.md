# Antigravity Plugin User Guide

This guide covers the released Antigravity Plugin configuration and user-facing features without requiring knowledge of the implementation.

## 1. What the plugin does

Antigravity Plugin connects OpenClaw to Google Antigravity CLI (`agy`).

- `antigravity/*`: recommended native OpenClaw `AgentHarnessV2` runtime.
- `antigravity-cli/*`: explicit generic CLI-backend compatibility runtime.
- OpenClaw owns orchestration, agents, sessions, subagents and completion delivery.
- AGY owns authentication, projects, conversations, model execution and native tools.

The plugin does not install or authenticate AGY.

## 2. Requirements

You need:

- OpenClaw plugin API / Gateway `>=2026.9.2`;
- Node.js `>=22.12.0`;
- AGY installed and available to the Gateway;
- AGY authentication permitted for the account/organization being used.

Check AGY before configuring OpenClaw:

```bash
agy --version
agy models
```

## 3. Install and enable

Install from ClawHub:

```bash
openclaw plugins install clawhub:@claw0gang/antigravity --accept-capabilities
```

Enable an existing installation:

```bash
openclaw plugins enable antigravity --accept-capabilities
```

Inspect the runtime:

```bash
openclaw plugins inspect antigravity --runtime --json
```

## 4. Recommended configuration

For normal agents that need to read and edit files inside their workspace:

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
          mode: "accept-edits",
          project: "YOUR-AGY-PROJECT-ID",
        },
      },
    },
  },

  agents: {
    defaults: {
      models: {
        "antigravity/*": {
          agentRuntime: { id: "antigravity" },
        },
      },
    },
  },
}
```

Configure the plugin once. Selecting another `antigravity/*` model for a later task or subagent does not require changing plugin configuration.

## 5. Configuration reference

| Key | Default | Use |
| --- | --- | --- |
| `command` | `"agy"` | AGY executable name or path. The Gateway must be able to execute it. |
| `printTimeout` | `"30m"` | Value passed to AGY `--print-timeout`. Accepts positive durations such as `30s`, `10m`, `1h`. |
| `sandbox` | `true` | Passes AGY `--sandbox`. Keep enabled unless the operator intentionally chooses otherwise. |
| `dangerouslySkipPermissions` | `false` | Passes AGY `--dangerously-skip-permissions`. Keep false for normal operation. |
| `mode` | AGY default | `"accept-edits"` for normal write-capable work, or `"plan"` for planning-only work. |
| `agent` | unset | Optional AGY native agent name passed with `--agent`. `antigravity-cli/*` can pass it directly. Native `antigravity/*` requires a current exact qualified native-agent definition carrier; normal plugin registration does not supply that carrier, so leave `agent` unset for normal native use. |
| `project` | unset | Exact AGY project ID. Required by the native `antigravity/*` runtime. |
| `newProject` | `false` | Passes AGY `--new-project`. Do not combine with `project`; it is not a substitute for the native runtime's required project binding. |
| `addDirs` | `[]` | Extra directories passed with AGY `--add-dir`. Add only paths the workload needs. |
| `logFile` | unset | Optional path passed to AGY `--log-file`. The Gateway must be able to write it. |

Unknown configuration keys are rejected.

### Execution modes

Use:

```json5
mode: "accept-edits"
```

when the agent is expected to perform normal file edits. In headless execution, leaving mode unset can leave an edit waiting for AGY review/approval and therefore denied.

Use:

```json5
mode: "plan"
```

when the task should remain in AGY planning mode.

Do not use `dangerouslySkipPermissions: true` as a fix for ordinary write failures.

## 6. AGY project and OpenClaw workspace

The native runtime requires one exact AGY project:

```json5
project: "YOUR-AGY-PROJECT-ID"
```

AGY project records are normally stored at:

```text
~/.gemini/config/projects/<project-id>.json
```

At least one project resource root must contain the OpenClaw attempt workspace/cwd.

Example:

```text
AGY project root:
  /home/user/.openclaw/workspace

OpenClaw agent workspace:
  /home/user/.openclaw/workspace/main
```

This is valid because the agent workspace is inside the AGY project root.

If several OpenClaw agents use different workspaces, the configured AGY project must contain each workspace used by the native runtime.

`addDirs` grants AGY additional directory access; it does not replace the required project/workspace binding.

## 7. Models

Refresh native AGY models through OpenClaw:

```bash
openclaw models list --provider antigravity --refresh
```

For one agent:

```bash
openclaw models list --agent <agent-id> --provider antigravity --refresh
```

Use exact live IDs:

```text
antigravity/gemini-3.8-flash-low
antigravity/gemini-3.8-flash-medium
antigravity/gemini-3.8-flash-high
```

Effort-qualified Gemini IDs are separate models. Selecting `...-low` does not silently become `...-medium` or `...-high`.

The native provider is discovered live from AGY. The compatibility `antigravity-cli/*` namespace uses its compatibility catalog.

## 8. Use as the main model

Set an exact native model as the agent default:

```json5
agents: {
  defaults: {
    model: {
      primary: "antigravity/gemini-3.8-flash-high",
    },
    models: {
      "antigravity/*": {
        agentRuntime: { id: "antigravity" },
      },
    },
  },
}
```

You can also register `antigravity/*` without changing the primary model and select Antigravity only when needed.

## 9. Use with subagents

Antigravity-backed children use OpenClaw's normal subagent lifecycle.

Example intent:

```text
sessions_spawn(
  model="antigravity/gemini-3.8-flash-low",
  task="..."
)
```

The parent should use OpenClaw's normal completion/yield flow. Do not invoke AGY directly to create an OpenClaw subagent.

Different subagents can select different exact `antigravity/*` models without changing plugin configuration.

A child may have a smaller OpenClaw control-plane tool surface than its parent. That is not by itself a plugin failure.

## 10. Native tools and file paths

AGY owns its native tools and permission decisions.

For AGY native file tools such as file read/write operations:

- use absolute paths;
- keep paths inside the caller's authorized OpenClaw workspace / AGY project scope;
- do not broaden `addDirs`, project roots or permissions to make a task succeed;
- report validation, sandbox and permission failures as failures.

Example:

```text
/home/user/.openclaw/workspace/main/report.md
```

Do not assume that a relative path such as `report.md` will be accepted by AGY native file tools.

This path rule does not require per-task plugin reconfiguration.

## 11. Permissions and sandboxing

OpenClaw restrictions and AGY native permissions are separate layers.

The native runtime fails closed rather than silently dropping prevention constraints that it cannot represent through a qualified native carrier. Before AGY execution, it rejects attempts whose required OpenClaw constraints cannot be carried safely, including tool-policy restrictions or safe-denied tools, non-full permission modes, workspace-only or writable-sandbox requirements, and scheduled tool policy. AGY permissions do not replace those OpenClaw constraints; both layers must be representable and satisfied.

Recommended baseline:

```json5
sandbox: true,
dangerouslySkipPermissions: false,
mode: "accept-edits",
```

AGY permission rules still apply. If AGY returns a denied native action, the plugin preserves that denial rather than inventing success.

Use `plan` when edits are not wanted. Use `accept-edits` when normal workspace edits are expected.

`dangerouslySkipPermissions: true` requests AGY always-proceed behavior and materially broadens authority. It is not a normal troubleshooting step.

## 12. Sessions and resume

OpenClaw and AGY keep separate session identities:

```text
OpenClaw session -> AGY conversation_id + exact AGY model
```

A fresh native session establishes the AGY conversation binding. Later turns resume that exact conversation.

A resumed session must keep a compatible runtime identity, including the exact model, AGY project/account scope and OpenClaw session ownership. Start a new session when intentionally changing those identities.

## 13. Images

The native runtime supports OpenClaw image input for supported models.

Supported input types include PNG, JPEG/JPG, WebP and GIF. The plugin stages image files privately inside the selected OpenClaw workspace for the attempt and removes the transport files afterward.

Model capability still determines whether the selected model can use the image.

## 14. Compatibility runtime

Use the native runtime for normal operation:

```text
antigravity/*
```

Use:

```text
antigravity-cli/*
```

only when the generic OpenClaw CLI-backend path is intentionally required.

The compatibility runtime is not an automatic fallback. The plugin does not silently switch between the two namespaces.

## 15. Verify the installation

Run:

```bash
openclaw plugins inspect antigravity --runtime --json
openclaw models list --provider antigravity --refresh
```

Then start a session with one exact `antigravity/*` model.

A minimal subagent check should verify:

- `sessions_spawn` accepts the exact requested model;
- the child completes through OpenClaw's normal lifecycle;
- a read-only task works;
- if write capability is required, a workspace-local absolute-path file write/read-back works under the intended permission mode.

## 16. Troubleshooting

### Plugin not active

Check:

- `plugins.entries.antigravity.enabled`;
- `plugins.allow`, if used;
- the running Gateway has applied the configuration.

### AGY not found

Run:

```bash
agy --version
```

If needed, set `command` to the intended executable path.

### No native models

Run:

```bash
agy models
openclaw models list --provider antigravity --refresh
```

Fix AGY authentication/account/project problems at the AGY layer.

### Native write is denied

Check, in order:

1. the tool arguments use an absolute path;
2. the path is inside the authorized workspace/project scope;
3. `mode` is appropriate for the task;
4. AGY native permission rules allow the action;
5. OpenClaw has not imposed a stricter restriction.

Do not enable `dangerouslySkipPermissions` just to bypass the failure.

### Resume rejected

Start a new session if the model, AGY project/account/runtime scope or OpenClaw ownership intentionally changed.

## 17. Security and account terms

Treat the configured `command`, AGY project roots, `addDirs`, credentials and permission settings as administrator-controlled trust boundaries.

This plugin does not provide Google credentials or bypass AGY authentication/access controls.

Google's current Antigravity Additional Terms and FAQ state that using third-party software, including OpenClaw, to access Antigravity with an individual Antigravity login/OAuth is prohibited and may result in suspension or termination. Do not use an individual/personal Antigravity account with this integration unless Google expressly authorizes that use. Enterprise and Google Cloud routes may be governed by separate terms; verify the agreement that applies to the deployment.

## 18. Reference

- Public repository: https://github.com/claw0gang/antigravity-plugin
- Example configuration: `examples/openclaw.json5`
- Architecture: `docs/ARCHITECTURE.md`
- Build: `docs/BUILD.md`
- Qualification: `docs/QUALIFICATION.md`
