# Antigravity Plugin for OpenClaw

Use models available through Google Antigravity CLI (`agy`) as native OpenClaw agent runtimes.

Antigravity Plugin 0.3.1 connects OpenClaw to an existing `agy` installation while keeping OpenClaw responsible for orchestration, sessions, agents and subagents. `agy` remains responsible for its native model execution, tools, authentication, projects and conversations.

## What you get

Antigravity Plugin provides two runtime surfaces:

| Surface | Purpose |
| --- | --- |
| `antigravity/*` | Recommended native OpenClaw `AgentHarnessV2` runtime |
| `antigravity-cli/*` | Generic CLI-backend compatibility mode |

The native `antigravity/*` runtime supports:

- OpenClaw main-agent model execution
- ordinary OpenClaw subagents through `sessions_spawn`
- live `agy` model discovery and exact model selection
- exact `agy` conversation binding and resume
- `agy`-native tool execution
- terminal tool-result observation by OpenClaw
- supported image input
- translation of qualified OpenClaw child restrictions into `agy`-native policy controls
- fail-closed behavior when a requested restriction cannot be represented safely

## Requirements

Before installing the plugin you need:

- OpenClaw `>=2026.9.2`
- `agy` installed and available on `PATH`, or configured with an explicit executable path
- `agy` already authenticated through an access route permitted for your account

Antigravity Plugin does not install, configure or authenticate `agy` for you.

### Check `agy` first

Make sure the CLI works outside OpenClaw:

```bash
agy --version
agy models
```

If those commands do not work, fix the `agy` installation or authentication before configuring the plugin.

---

## 1. Install the plugin

Install from ClawHub:

```bash
openclaw plugins install clawhub:@claw0gang/antigravity
```

If capability approval is required:

```bash
openclaw plugins install clawhub:@claw0gang/antigravity --accept-capabilities
```

The plugin ID is `antigravity`.

If installed but not enabled:

```bash
openclaw plugins enable antigravity
```

If capability consent is required:

```bash
openclaw plugins enable antigravity --accept-capabilities
```

### Verify installation

```bash
openclaw plugins inspect antigravity --runtime --json
```

The native runtime registers as `antigravity`; the compatibility CLI backend is exposed separately as `antigravity-cli`.

If the running Gateway did not apply the installation automatically:

```bash
openclaw gateway restart
```

## Bundled OpenClaw skill

Version 0.3.1 includes the `antigravity-plugin` skill with configuration and usage guidance.

Inspect it with:

```bash
openclaw skills info antigravity-plugin --agent main --json
```

---

## 2. Configure the native runtime

The recommended configuration uses `antigravity/*`:

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
          project: "YOUR-AGY-PROJECT-ID",
        },
      },
    },
  },

  agents: {
    defaults: {
      models: {
        "antigravity/*": {
          agentRuntime: {
            id: "antigravity",
          },
        },
      },
    },
  },
}
```

The native runtime requires one exact AGY project ID. AGY project records are normally stored at:

```text
~/.gemini/config/projects/<id>.json
```

The filename without `.json` is the project ID. Use a project whose resource root contains the OpenClaw workspace used by the agent.

Do **not** use `newProject: true` as a substitute for this binding.

---

## 3. See which models are available

Refresh the live `agy` model inventory:

```bash
openclaw models list --provider antigravity --refresh
```

For a specific OpenClaw agent:

```bash
openclaw models list --agent <agent-id> --provider antigravity --refresh
```

Use the exact `antigravity/...` model IDs returned by the live inventory. The plugin does not silently substitute missing models.

---

# Using Antigravity Plugin in OpenClaw

The plugin can be your primary runtime, an additional provider, a dedicated agent runtime, or a subagent runtime.

## Make an `agy` model your default

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "antigravity/gemini-3.8-flash-high",
      },

      models: {
        "antigravity/*": {
          agentRuntime: {
            id: "antigravity",
          },
        },
      },
    },
  },
}
```

Use an exact model returned by the live inventory.

---

## Keep your existing default model

You can register `antigravity/*` without changing `agents.defaults.model.primary`, then select an Antigravity model only for sessions that need it.

---

## Create a dedicated `agy`-backed agent

```json5
{
  agents: {
    defaults: {
      models: {
        "antigravity/*": {
          agentRuntime: {
            id: "antigravity",
          },
        },
      },
    },

    entries: {
      main: {
        name: "Main",
        model: "anthropic/claude-opus-4-6",
      },

      agy: {
        name: "Antigravity",
        workspace: "~/.openclaw/workspace-agy",
        model: "antigravity/gemini-3.8-flash-high",
      },
    },
  },
}
```

This lets you isolate Antigravity workloads, workspace and sessions from your main OpenClaw agent.

---

## Use an `agy`-backed OpenClaw subagent

The native harness is qualified for ordinary OpenClaw `sessions_spawn` execution.

```json5
{
  agents: {
    defaults: {
      models: {
        "antigravity/*": {
          agentRuntime: {
            id: "antigravity",
          },
        },
      },
    },

    entries: {
      main: {
        subagents: {
          allowAgents: ["agy-worker"],
        },
      },

      "agy-worker": {
        workspace: "~/.openclaw/workspace-agy-worker",
        model: "antigravity/gemini-3.8-flash-low",
      },
    },
  },
}
```

The plugin preserves the selected `agy` model and conversation binding and returns the completed child result through OpenClaw's normal completion path.

For qualified policy shapes, OpenClaw child restrictions are translated into `agy`-native controls. If a required restriction cannot be represented safely, the plugin fails closed.

---

# Configure `agy` behavior

## Execution mode

Supported configured values are:

```text
plan
accept-edits
```

Example:

```json5
config: {
  command: "agy",
  mode: "plan",
  sandbox: true,
  dangerouslySkipPermissions: false,
}
```

## Additional directories

```json5
config: {
  sandbox: true,

  addDirs: [
    "/srv/shared/reference",
  ],
}
```

Only add directories the workload actually needs.

## Custom `agy` executable

```json5
config: {
  command: "/absolute/path/to/agy",
}
```

The OpenClaw Gateway process must be able to execute that file.

---

# Native runtime vs compatibility CLI backend

For normal installations, use:

```text
antigravity/*
```

This is the native `AgentHarnessV2` runtime.

The separate compatibility namespace is:

```text
antigravity-cli/*
```

It exists for deployments that intentionally need OpenClaw's generic CLI-backend mechanism.

It is not an automatic fallback. The plugin never silently switches between the native and compatibility runtimes.

---

# Comparison with `claude-cli` and Codex

| Capability | Antigravity Plugin | `claude-cli` | Codex |
| --- | --- | --- | --- |
| Primary OpenClaw integration | Native `AgentHarnessV2` | CLI backend | Native Codex app-server harness |
| External runtime | Google Antigravity CLI (`agy`) | Claude Code CLI | Codex app-server |
| External session identity | `agy` conversation binding | CLI session support | Native |
| Live model discovery | From `agy` | Backend/provider-defined | OpenAI/Codex-owned |
| Native external tools | `agy` tools | Claude Code tools | Codex tools |
| OpenClaw subagents | Ordinary `sessions_spawn` qualified | CLI-backend orchestration | Native harness integration |
| Policy integration | Translated where safely representable; otherwise fail closed | CLI-backend controls | Deep native integration |
| Generic CLI mode | Separate `antigravity-cli/*` backend | Primary integration | No bundled `codex-cli` backend |

---



# Permissions and filesystem access

OpenClaw workspace policy and `agy` native tool permissions are separate security layers.

A conservative configuration is:

```json5
config: {
  sandbox: true,
  dangerouslySkipPermissions: false,
}
```

You can use **separate AGY projects for different purposes**. For example, keep one project dedicated to the OpenClaw Antigravity harness with access limited to OpenClaw workspaces, while using another project for direct `agy` work with different resource roots and permissions.

This makes it easier to separate filesystem scope, workspace access and permission boundaries between OpenClaw-driven execution and direct CLI use.

Review:

- OpenClaw workspace and tool policy
- the AGY project resource roots
- `agy` sandbox and permissions
- `addDirs`
- credentials available to `agy`
- optional `logFile` destinations

## `dangerouslySkipPermissions`

Keep this disabled for normal operation:

```json5
dangerouslySkipPermissions: false
```

Enabling it requests unrestricted native permission behavior and materially changes the security boundary.

---

# Images

Supported `antigravity/*` models can receive OpenClaw image input.

Images are staged privately for the individual attempt inside the selected OpenClaw workspace and cleaned up afterward.

Image support remains model-dependent.

---

# Verify everything is working

```bash
openclaw plugins inspect antigravity --runtime --json
openclaw models list --provider antigravity --refresh
```

Then start a normal OpenClaw session using an exact `antigravity/...` model.

---

# Troubleshooting

## Plugin is installed but not active

Verify:

- `plugins.entries.antigravity.enabled` is `true`
- `antigravity` is permitted by `plugins.allow`, if used
- the Gateway has applied the installation and configuration

If necessary:

```bash
openclaw gateway restart
```

## `agy` cannot be found

```bash
agy --version
```

If needed, configure an absolute executable path with `config.command`.

## No `antigravity/*` models appear

Check:

```bash
agy models
openclaw models list --provider antigravity --refresh
```

Authentication, account, project or `agy` runtime problems must be fixed at the `agy` layer.

## A resumed conversation is rejected

Resume can be rejected when execution identity changes, including the model, AGY project, account, runtime scope or OpenClaw session ownership.

Start a new conversation instead of forcing an incompatible binding.

## Native tool access is denied

Check OpenClaw restrictions, AGY project scope, sandbox configuration and `agy`-native permissions before considering broader authority.

---

# Compatibility

Antigravity Plugin `0.3.1` declares:

| Component | Requirement |
| --- | --- |
| OpenClaw plugin API | `>=2026.9.2` |
| OpenClaw Gateway | `>=2026.9.2` |
| Node.js | `>=22.12.0` |
| Reproducible build SDK | OpenClaw `2026.9.4` |

The package has also passed isolated package/runtime compatibility qualification against OpenClaw `2026.9.5`.

The build SDK version is provenance, not a requirement to run exactly that OpenClaw release.

---

# Rollback

The previous known-good public release is:

```text
v0.3.0
```

Canonical artifact:

```text
claw0gang-antigravity-0.3.0.tgz
```

SHA-256:

```text
4c1d3a5521dbd6c35142e3eeff02905f92c3c8c8db62434f0402b729738c23d8
```

Verify it before reinstalling:

```bash
sha256sum claw0gang-antigravity-0.3.0.tgz
```

Then:

```bash
openclaw plugins install ./claw0gang-antigravity-0.3.0.tgz --force --accept-capabilities
```

---

# Release provenance

Antigravity Plugin `0.3.1` is based on the accepted private release source:

```text
claw0gang/antigravity@3b4801039fce4cb49780726839247b31f713aa36
```

Qualified public shipped-byte commit:

```text
97ff4e483785fcf1f7e5187bd00b0dec2888a79f
```

Detailed release evidence is recorded in:

- `EXPORT-MANIFEST.json`
- `RELEASE-NOTES.md`
- `docs/BUILD.md`
- `docs/QUALIFICATION.md`

---

# License

MIT. See `LICENSE`.

The MIT license applies to this plugin's source code. It does not grant rights to third-party software, services, trademarks or accounts.

---

# Independent project and upstream-service notice

Antigravity Plugin is an independent third-party OpenClaw integration.

It is not developed by, affiliated with, sponsored by, endorsed by, or an official product of Google, OpenClaw / OpenClaw Foundation, Anthropic or OpenAI.

Google Antigravity CLI (`agy`) is a separate external dependency and owns its own authentication, services, native tools and upstream execution.

Antigravity Plugin does not provide Google credentials, bypass authentication, circumvent upstream access controls or grant permission to use any Google service.

Google's current Antigravity Terms and FAQ state that using an individual Antigravity login/OAuth through third-party software such as OpenClaw is a breach/violation and may result in suspension or termination.

Do not use an individual Antigravity account through this integration unless Google expressly authorizes that access route.

Enterprise, organizational and Google Cloud access routes may be governed by different agreements.

Verify the current terms that apply to your account and deployment.

See `NOTICE.md` for the full third-party and trademark notice.

