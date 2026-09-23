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
- live `agy` model discovery
- exact `agy` model selection
- exact `agy` conversation binding and resume
- `agy`-native tool execution
- terminal tool-result observation by OpenClaw
- supported image input
- translation of qualified OpenClaw child restrictions into `agy`-native policy controls
- fail-closed behavior when a requested restriction cannot be represented safely

## Requirements

Before installing the plugin you need:

- OpenClaw `>=2026.9.2`
- Node.js `>=22.12.0`
- Google Antigravity CLI installed separately
- `agy` available on `PATH`, or its executable path configured explicitly
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

If OpenClaw asks you to review and approve the plugin's declared capabilities, review them and rerun the command with:

```bash
openclaw plugins install clawhub:@claw0gang/antigravity --accept-capabilities
```

The plugin ID is:

```text
antigravity
```

If it is installed but not enabled:

```bash
openclaw plugins enable antigravity
```

If capability consent is required:

```bash
openclaw plugins enable antigravity --accept-capabilities
```

### Verify installation

Inspect the installed plugin and its runtime registrations:

```bash
openclaw plugins inspect antigravity --runtime --json
```

The native provider/runtime should register as `antigravity`, with the compatibility CLI backend exposed separately as `antigravity-cli`.

If your running Gateway did not automatically apply the installation, restart it:

```bash
openclaw gateway restart
```


## Bundled OpenClaw skill

Version 0.3.1 includes the lightweight `antigravity-plugin` skill. OpenClaw discovers it from the plugin's declared `./skills` root. It summarizes the exact AGY project binding, explicit ClawHub install source, same-agent/workspace usage, sandbox/permission guidance, and per-spawn model selection.

Inspect it with:

```bash
openclaw skills info antigravity-plugin --agent main --json
```

---

## 2. Configure the native runtime

The recommended configuration uses the native `antigravity/*` runtime.

Add the plugin and bind the complete `antigravity/*` model namespace to its native harness:

```json5
{
  plugins: {
    allow: [
      "antigravity",
    ],

    entries: {
      antigravity: {
        enabled: true,

        config: {
          command: "agy",
          printTimeout: "30m",
          sandbox: true,
          dangerouslySkipPermissions: false,
          project: "EXACT-AGY-PROJECT-ID",
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

This tells OpenClaw to:

1. load Antigravity Plugin;
2. use `agy` as the external runtime;
3. keep `agy` sandboxing enabled;
4. bind discovered `antigravity/*` models to the plugin's native harness.

It does **not** hard-code the actual `agy` model inventory. Native model availability is discovered from `agy`.

The native `antigravity/*` runtime requires one exact AGY project id. That AGY project's configured resource root must contain the OpenClaw agent workspace/cwd used for the attempt. This project binding is a runtime identity fence, not a default-model setting.

---

## 3. See which models are available

After configuration, refresh and inspect the `antigravity` provider catalog:

```bash
openclaw models list --provider antigravity --refresh
```

For multi-agent installations, inspect a specific agent:

```bash
openclaw models list --agent <agent-id> --provider antigravity --refresh
```

Use the exact model IDs reported by the live inventory.

Examples may include:

```text
antigravity/gemini-3.8-flash-high
antigravity/gemini-3.8-flash-medium
antigravity/gemini-3.8-flash-low

antigravity/sonnet-4-6
antigravity/opus-4-6
antigravity/gpt-oss
```

The exact list depends on the models currently exposed by your `agy` installation and account.

Antigravity Plugin does not silently replace a missing model with another model.

---

# Using Antigravity Plugin in OpenClaw

The plugin can be used as your primary model runtime, as an additional model provider, through a dedicated agent, or as a subagent runtime.

## Make an `agy` model your default OpenClaw model

If most of your normal OpenClaw work should run through `agy`, set an exact `antigravity/*` model as the default:

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

Replace the example model with an exact model returned by your live inventory.

---

## Keep your existing default model and use `agy` when needed

Antigravity Plugin does not need to become your default model provider.

Register its native runtime:

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
  },
}
```

Keep your existing `agents.defaults.model.primary`.

You can then select an `antigravity/*` model for individual sessions using OpenClaw's normal model-selection controls.

This is useful when you want `agy` models available alongside your existing OpenClaw providers.

---

## Create a dedicated `agy`-backed OpenClaw agent

You can create a separate OpenClaw agent whose default model uses Antigravity Plugin while leaving your main agent unchanged.

Example:

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

This is useful when you want:

- a dedicated coding or research agent;
- a separate workspace for `agy` workloads;
- separate sessions and conversation history;
- explicit routing of selected work to `agy`.

Use an exact model available to your account.

---

## Use an `agy`-backed agent as an OpenClaw subagent

The native harness is qualified for ordinary OpenClaw `sessions_spawn` child execution.

A parent agent can therefore spawn a configured `antigravity/*` agent as a child:

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
        model: "anthropic/claude-opus-4-6",

        subagents: {
          allowAgents: [
            "agy-worker",
          ],
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

The parent can then target `agy-worker` through OpenClaw's normal subagent mechanism.

Antigravity Plugin preserves the exact `agy` model and conversation binding for the child run and returns the completed child result through OpenClaw's normal completion path.

### Child restrictions

For qualified policy shapes, Antigravity Plugin translates OpenClaw child restrictions into `agy`-native controls.

If a required restriction cannot be represented safely by `agy`, the plugin fails closed rather than silently running the child with broader authority.

---

# Configure `agy` behavior

The following options change how the plugin invokes `agy`. They are configuration choices, not separate OpenClaw usage patterns.

## Select the required `agy` project

The native `antigravity/*` harness requires one exact AGY project id:

```json5
{
  plugins: {
    entries: {
      antigravity: {
        enabled: true,
        config: {
          command: "agy",
          sandbox: true,
          dangerouslySkipPermissions: false,
          project: "EXACT-AGY-PROJECT-ID",
        },
      },
    },
  },
}
```

The matching AGY project must exist under the active Gemini home, and one of its configured resource roots must contain the OpenClaw attempt workspace/cwd. For a shared OpenClaw workspace, use an AGY project rooted at that workspace.

This binding does not pin the model. Different sessions and subagents may still choose different exact `antigravity/*` model IDs.

Do **not** use `newProject: true` as a substitute for this native strict identity binding.
---

## Set the `agy` execution mode

The plugin can request a supported `agy` execution mode:

```json5
{
  plugins: {
    entries: {
      antigravity: {
        enabled: true,

        config: {
          command: "agy",
          sandbox: true,
          dangerouslySkipPermissions: false,

          mode: "plan",
        },
      },
    },
  },
}
```

Supported configured values are:

```text
plan
accept-edits
```

This is plugin-level `agy` configuration. If different workloads require different execution behavior, account for that when designing your OpenClaw agent configuration.

---

## Allow specific additional directories

`agy` can be given explicitly configured additional directories:

```json5
{
  plugins: {
    entries: {
      antigravity: {
        enabled: true,

        config: {
          sandbox: true,

          addDirs: [
            "/srv/shared/reference",
          ],
        },
      },
    },
  },
}
```

Only add directories that the workload actually needs.

Do not use broad paths such as your entire home directory as a substitute for proper workspace or project configuration.

---

## Use a custom `agy` executable

If `agy` is not on the Gateway's `PATH`:

```json5
{
  plugins: {
    entries: {
      antigravity: {
        enabled: true,

        config: {
          command: "/absolute/path/to/agy",
        },
      },
    },
  },
}
```

The OpenClaw Gateway process must be able to execute that file.

---

# Native runtime vs compatibility CLI backend

For normal installations, use:

```text
antigravity/*
```

This is the native Antigravity Plugin `AgentHarnessV2` path.

A separate compatibility namespace exists:

```text
antigravity-cli/*
```

For example:

```text
antigravity-cli/gemini-3.8-flash-high
```

The compatibility backend exists for deployments that intentionally need OpenClaw's generic CLI-backend mechanism.

It is not an automatic fallback from the native runtime.

Antigravity Plugin never silently switches an `antigravity/*` request to `antigravity-cli/*`.

---

# Comparison with `claude-cli` and Codex

| Capability | Antigravity Plugin | `claude-cli` | Codex |
| --- | --- | --- | --- |
| Primary OpenClaw integration | Native `AgentHarnessV2` | CLI backend | Native Codex app-server harness |
| External runtime | Google Antigravity CLI (`agy`) | Claude Code CLI (`claude`) | Codex app-server |
| Native external session identity | Yes — `agy` `conversation_id` | CLI session support | Yes |
| Live model discovery | Yes, from `agy` | Backend/provider-defined | OpenAI/Codex-owned |
| Native external tools | `agy` tools | Claude Code tools | Codex tools |
| OpenClaw subagents | Qualified for ordinary `sessions_spawn` | Via CLI-backend orchestration | Native harness integration |
| OpenClaw policy integration | Translated where safely representable; otherwise fail closed | CLI-backend policy/tool configuration | Deep native integration |
| Generic CLI compatibility mode | Yes, separately as `antigravity-cli/*` | Primary integration type | No bundled `codex-cli` backend |
| External runtime owns agent loop | Yes | Yes | Yes |
| OpenClaw-native control-plane integration | Native harness; some controls require translation | CLI-oriented | Deepest integration |

---

# Gemini model effort levels

`agy` may expose Gemini models as separate effort-qualified model IDs, for example:

```text
gemini-3.8-flash-high
gemini-3.8-flash-medium
gemini-3.8-flash-low
```

Antigravity Plugin treats these as concrete model identities.

Use the exact discovered model:

```text
antigravity/gemini-3.8-flash-high
```

The plugin does not silently switch between high, medium and low siblings.

---

# Permissions and filesystem access

OpenClaw's workspace/filesystem policy and `agy`'s native tool authority are **different security layers**.

For example, configuring an OpenClaw agent as workspace-only does not automatically turn the external `agy` process into an operating-system sandbox.

A conservative setup is:

```json5
{
  plugins: {
    entries: {
      antigravity: {
        config: {
          sandbox: true,
          dangerouslySkipPermissions: false,
        },
      },
    },
  },
}
```

Also review:

- the OpenClaw agent workspace;
- OpenClaw sandbox and tool policy;
- `agy` sandbox and permission settings;
- configured `project`;
- `addDirs`;
- `agy`-native shell and filesystem permissions;
- credentials visible to `agy`;
- optional `logFile` destinations.

## `dangerouslySkipPermissions`

Keep this disabled:

```json5
dangerouslySkipPermissions: false
```

Do not enable it for normal operation.

It requests unrestricted/always-proceed native permission behavior and materially changes the security boundary.

The native `antigravity/*` harness is designed to remain fail-closed rather than requiring this bypass.

---

# Images

Supported `antigravity/*` models can receive OpenClaw image input.

Image files are staged privately for the individual attempt inside the selected OpenClaw workspace and cleaned up after the attempt.

Image capability is model-dependent. An unsupported model should not be assumed to accept images merely because another model exposed through `agy` does.

---

# Verify everything is working

## Plugin

```bash
openclaw plugins inspect antigravity --runtime --json
```

## Models

```bash
openclaw models list --provider antigravity --refresh
```

## Specific agent

```bash
openclaw models status --agent <agent-id>
openclaw models list --agent <agent-id> --provider antigravity --refresh
```

Then start a normal OpenClaw session with an exact `antigravity/...` model.

---

# Troubleshooting

## Plugin is installed but not active

Check:

```bash
openclaw plugins inspect antigravity --runtime --json
```

Then verify:

- `plugins.entries.antigravity.enabled` is `true`;
- `antigravity` is permitted by `plugins.allow` if you use an allowlist;
- the Gateway has applied the installation and configuration.

If necessary:

```bash
openclaw gateway restart
```

---

## `agy` cannot be found

Test it from the same operating-system environment used by the OpenClaw Gateway:

```bash
agy --version
```

If necessary, configure:

```json5
command: "/absolute/path/to/agy"
```

---

## No `antigravity/*` models appear

First confirm `agy` itself exposes models:

```bash
agy models
```

Then refresh OpenClaw's provider inventory:

```bash
openclaw models list --provider antigravity --refresh
```

Authentication, account, project or `agy` runtime problems must be fixed at the `agy` layer.

---

## A configured model disappeared

Antigravity Plugin intentionally does not substitute another model silently.

Refresh the inventory:

```bash
openclaw models list --provider antigravity --refresh
```

Then select one of the exact currently available model IDs.

---

## A resumed conversation is rejected

Antigravity Plugin binds an `agy` conversation to its concrete execution identity.

Resume may be rejected if important identity changes occurred, including incompatible:

- model;
- `agy` project;
- account;
- runtime scope;
- OpenClaw session ownership.

This is intentional fail-closed behavior.

Start a new conversation instead of forcing reuse of an incompatible binding.

---

## Native tool access is denied

Do not immediately enable `dangerouslySkipPermissions`.

Check:

1. OpenClaw tool and subagent restrictions;
2. Antigravity Plugin policy translation;
3. `agy` sandbox configuration;
4. `agy`-native permissions;
5. workspace, project and additional-directory configuration.

A denied operation may be the correct result of the configured security policy.

---

# Compatibility

Antigravity Plugin `0.3.0` declares:

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

The preserved known-good public release before `0.3.0` is:

```text
v0.2.6
```

Canonical artifact:

```text
claw0gang-antigravity-0.2.6.tgz
```

SHA-256:

```text
2a0da789656b0b43b2c0eff9bd3fea338805b88cf96684969f94a74a5605f658
```

Verify the artifact before reinstalling it:

```bash
sha256sum claw0gang-antigravity-0.2.6.tgz
```

Then:

```bash
openclaw plugins install ./claw0gang-antigravity-0.2.6.tgz --force --accept-capabilities
```

---

# Release provenance

Antigravity Plugin `0.3.0` was built and qualified from the accepted private release source:

```text
claw0gang/antigravity@b16e85f112453f5272248a7629a89787b7a23cd1
```

Its runtime `src/**` remains byte-for-byte identical to accepted Phase 2 runtime commit:

```text
d3cfc24a0eed0ebfd2036879002e15b3350ca467
```

The private correction changes only the simulated source-SDK test fixture.

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

It is not developed by, affiliated with, sponsored by, endorsed by, or an official product of:

- Google
- OpenClaw / OpenClaw Foundation
- Anthropic
- OpenAI

Google Antigravity CLI (`agy`) is a separate external dependency. `agy` owns its own authentication, services, native tools and upstream execution.

Antigravity Plugin does not provide Google credentials, bypass authentication, circumvent upstream access controls or grant permission to use any Google service.

Google's published Antigravity terms and related documentation currently state that third-party access through software including OpenClaw using an individual Antigravity login/OAuth may be prohibited and may result in suspension or termination.

Do not use a personal/individual Antigravity account through this integration unless Google expressly authorizes that access route.

Enterprise, organizational and Google Cloud access routes may be governed by different agreements.

Before using this plugin, verify the current terms that apply to your own Antigravity account and deployment.

See `NOTICE.md` for the project's full third-party and trademark notice.
