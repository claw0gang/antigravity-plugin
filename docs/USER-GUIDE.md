# Antigravity Plugin User Guide

This guide covers Antigravity Plugin 0.3.4 configuration and user-facing behavior.

The registered harness runs AGY with its existing native authentication, the prepared OpenClaw environment and the selected CLI configuration. It starts fresh conversations and resumes exact stored conversation IDs. The plugin does not independently identify accounts, inspect credentials or provide another authentication flow.

## 1. What the plugin does

Antigravity Plugin connects OpenClaw to Google Antigravity CLI (`agy`).

- `antigravity`: the single plugin, provider and native `AgentHarnessV2` harness.
- `antigravity/<exact-native-model-id>`: models discovered from the current AGY scope.
- OpenClaw owns orchestration, agents, sessions, subagents and completion delivery.
- AGY owns authentication, projects, conversations, model execution and native tools.

The plugin does not install or authenticate AGY.

## 2. Requirements

You need:

- OpenClaw plugin API / Gateway `>=2026.9.2`;
- Node.js `>=22.12.0`;
- AGY installed and available to the Gateway; the existing minimum is 1.1.28;
- AGY authentication permitted for the account/organization being used.

The build uses OpenClaw SDK **2026.11.7**. Native operation was observed on OpenClaw **2026.11.8** with AGY **1.5.17**. These observations do not change the declared support floors. Use a current compatible AGY release; the `/projects` local project manager requires AGY 1.5.0 or later.

Modern hosts require awaited get/list/prepare and `withSessionEntriesAsync`; missing capabilities block registration. Legacy support is selected before work, never after a modern failure.

Check AGY before configuring OpenClaw:

```bash
agy --version
agy models --output-format json
```

## 3. Installation

Install from ClawHub:

```bash
openclaw plugins install clawhub:@claw0gang/antigravity@0.3.4 --accept-capabilities
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

Install and authenticate AGY and create the dedicated project described in [section 6](#6-agy-project-and-openclaw-workspace) before configuring the plugin. Merge the following into your existing `openclaw.json`:

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
| `mode` | `"accept-edits"` | `"accept-edits"` for normal write-capable work, or `"plan"` for planning-only work. |
| `agent` | unset | Optional AGY native agent name passed with `--agent`. Native `antigravity/*` requires a current exact qualified native-agent definition carrier; normal plugin registration does not supply that carrier, so leave `agent` unset for normal native use. |
| `project` | unset (required for native execution) | Exact existing AGY project ID. Its resource roots must contain the intended OpenClaw workspaces. |
| `newProject` | `false` | Keep false for native execution; it cannot replace the required exact project ID. Do not combine with `project`. |
| `addDirs` | `[]` | Extra directories passed with AGY `--add-dir`. Add only paths the workload needs. |
| `logFile` | unset | Optional path passed to AGY `--log-file`. The Gateway must be able to write it. |

Unknown configuration keys are rejected.

### Execution modes

Use:

```json5
mode: "accept-edits"
```

when the agent is expected to perform normal file edits. This is also the plugin default when `mode` is omitted. The plugin sends it explicitly, so a native default change does not silently select AGY auto or orchestrator mode. AGY permission rules still decide whether an individual action is allowed.

Use:

```json5
mode: "plan"
```

when the task should remain in AGY planning mode.

Do not use `dangerouslySkipPermissions: true` as a fix for ordinary write failures.

## 6. AGY project and OpenClaw workspace

Install AGY using the [official instructions](https://antigravity.google/docs/getting-started/) and authenticate with a permitted account in the environment used by the OpenClaw Gateway.

Create a dedicated local AGY project for OpenClaw. In AGY 1.5.0 or later, launch `agy`, open `/projects`, create a project named OpenClaw, and select its folders. Alternatively, `agy --new-project` creates a new project on startup. Use AGY's project interface to configure the resource roots to contain each intended OpenClaw agent workspace. Add only the folders needed. See [AGY projects](https://antigravity.google/docs/cli/projects/).

Obtain the exact local AGY project ID, not its display name or a Google Cloud billing project ID. Use the native project details where the installed CLI exposes the ID. On standard local installations, project metadata has historically been stored at `~/.gemini/config/projects/<project-id>.json`; if necessary, check only the newly created project's own metadata and match its name and resource roots to the filename ID. If the layout differs, use the installed CLI's help rather than guessing. Confirm the selection with `agy --project=YOUR-AGY-PROJECT-ID`. Keep the actual project ID and metadata private.

For example, a resource root of `/home/user/.openclaw/workspace` contains an agent workspace at `/home/user/.openclaw/workspace/main`. Replace these synthetic paths with your intended workspace paths. Set the exact ID in `plugins.entries.antigravity.config.project` in `openclaw.json`. Neither `newProject: true` nor `addDirs` replaces the required project binding. Keep the configuration persistent.

AGY owns project and conversation access. Resume uses the bound conversation's associated project. The plugin does not inspect private account or project stores.

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

On supported OpenClaw 2026.11.7+ hosts, the thinking selector exposes model-specific levels from read-only AGY metadata. **Native selection** (`off`) keeps the exact selected model; it does not disable reasoning. Supported overrides use AGY's invocation-level `--effort` without changing AGY's saved default. The plugin verifies the effective native model and effort before execution. Fixed or unverified models retain native selection; unsupported overrides are rejected. A resumed conversation must keep its exact bound model; reset before changing variants. See [AGY effort](https://antigravity.google/docs/cli/commands/effort/).

The provider is discovered live from AGY. These examples do not constitute a static catalog. New, withdrawn and empty inventories are handled through current native discovery; the plugin does not remap retired shorthand aliases to another model.

A successful model listing establishes discovery in that native scope. It does not prove an OAuth, API-key or ADC authentication method, nor does it establish inference entitlement. AGY owns authentication. Its own provider setting, such as `modelProvider: "gemini"`, is distinct from OpenClaw's `antigravity` provider name. The plugin does not configure or rotate native credentials.

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

Antigravity-backed children use OpenClaw's normal subagent lifecycle and the registered native harness.

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

Resume passes `--conversation` with the exact stored ID, never `--continue`. The returned conversation and model must match the binding. The plugin preserves OpenClaw session ownership and generation. An incompatible model or canonical session binding requires an explicit reset or new session. AGY owns authentication and conversation access.

Stale session state rejects the operation without refreshing or retrying AGY. Host delivery checks remain separate. Reset must cancel and drain the attempt before clearing its binding; unconfirmed cancellation blocks resume. See the [awaited session contract](ARCHITECTURE.md#54-awaited-public-session-integration).

## 13. Images

The selected stream-json input is text-only. Image input is accepted only when the host supplies a separately qualified model, media policy and native image route; ordinary live model discovery does not establish those capabilities. Unsupported image requests are rejected before native execution.

The existing staging adapter validates PNG, JPEG/JPG, WebP and GIF and keeps accepted files private to the attempt. It may remove those files only after the qualified native readers have settled. The adapter does not establish that an ordinary live model supports images.

## 14. Older configuration and sessions

The former `antigravity-cli/*` backend is no longer supported. Remove obsolete backend/model configuration, refresh the inventory and select an exact `antigravity/<native-id>`. Start a new session or use a supported reset for incompatible old bindings. A prefix change does not migrate a conversation; there is no automatic fallback.

## 15. Verify the installation

Run:

```bash
openclaw plugins inspect antigravity --runtime --json
openclaw models list --provider antigravity --refresh
```

The model listing verifies inventory visibility. A native session with an exact `antigravity/*` model checks execution separately.

A minimal subagent check should verify:

- `sessions_spawn` accepts the exact requested model;
- the child completes through OpenClaw's normal lifecycle;
- a read-only task works;
- if write capability is required, a workspace-local absolute-path file write/read-back works under the intended permission mode.

## 16. Troubleshooting

### AGY authentication or project access fails

Use AGY's own login and project commands to resolve the native error in the environment used by the Gateway. OpenClaw does not provide an AGY login screen, and the plugin does not inspect or rewrite native credentials. A failed or potentially started native turn is not automatically replayed.

### OpenClaw route or execution requirements are rejected

The native `antigravity/*` runtime uses AGY's own authentication and service endpoint. It cannot apply an authored OpenClaw endpoint override, forward an OpenClaw credential profile, or replace host-owned execution tools with an environment overlay. Select a runtime that can satisfy that route, or configure the intended native AGY route explicitly; the plugin exposes no alternate generic CLI backend.

Current OpenClaw can also require exact native model-policy enforcement for a restricted operator. This plugin does not declare that newer capability merely from its exact requested-model checks. Such restrictions remain enforced by OpenClaw's admission decision.

### A partial answer is reported as incomplete

AGY's `finished_reason` reports early termination independently of its status text or process exit code. `print_timeout` is a timeout, `interrupted` is cancellation, and `error` is failure. The plugin retains available text and native status while withholding a successful completed-assistant result. An unknown reason is a protocol error. Do not treat an exit code of zero or a `SUCCESS` string alone as completed work.

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
agy models --output-format json
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

For an incompatible model or OpenClaw session owner, explicitly reset or start a new session. If AGY rejects the exact stored conversation, resolve the native error; the plugin does not silently start a replacement conversation.

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
