# Antigravity Plugin for OpenClaw

Use Google Antigravity CLI (`agy`) models as OpenClaw agent runtimes.

The recommended runtime is `antigravity/*` through OpenClaw `AgentHarnessV2`. The separate `antigravity-cli/*` namespace is compatibility mode.

> **Upstream-service notice:** this is an independent third-party integration. Google's current Antigravity Additional Terms and FAQ state that using third-party software, including OpenClaw, to access Antigravity with an individual Antigravity login/OAuth is prohibited and may result in suspension or termination. Do not use an individual/personal Antigravity account with this integration unless Google expressly authorizes that use. Enterprise and Google Cloud routes may be governed by separate terms; verify the agreement that applies to your deployment.

## Requirements

- OpenClaw plugin API / Gateway `>=2026.9.2`
- Node.js `>=22.12.0`
- `agy` installed, authenticated and available to the OpenClaw Gateway

Check AGY first:

```bash
agy --version
agy models
```

## Install

From ClawHub:

```bash
openclaw plugins install clawhub:@claw0gang/antigravity --accept-capabilities
```

If already installed but disabled:

```bash
openclaw plugins enable antigravity --accept-capabilities
```

## Recommended configuration

For normal workspace-editing agents:

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

The native runtime requires an exact AGY project ID. Its project resource roots must contain the OpenClaw workspace used by the agent.

AGY project records are normally under:

```text
~/.gemini/config/projects/<project-id>.json
```

This configuration is persistent. You do **not** reconfigure the plugin when selecting a different `antigravity/*` model for a task or subagent.

For planning-only workloads, use `mode: "plan"`. Keep `dangerouslySkipPermissions: false` for normal operation.

## Models

Refresh the live native model inventory:

```bash
openclaw models list --provider antigravity --refresh
```

Use the exact IDs returned, for example:

```text
antigravity/gemini-3.8-flash-low
antigravity/gemini-3.8-flash-medium
antigravity/gemini-3.8-flash-high
```

The plugin preserves exact model selection and does not silently switch to another effort/model.

## Subagents

Use OpenClaw's normal subagent flow:

```text
sessions_spawn(model="antigravity/gemini-3.8-flash-low", ...)
```

OpenClaw owns spawning, lifecycle and completion delivery. AGY owns the child model execution and native tools.

For AGY native file tools, agents should use **absolute paths inside the authorized OpenClaw workspace / AGY project scope**. This is a tool-call rule, not a per-task configuration step.

## Full manual

See **[docs/USER-GUIDE.md](docs/USER-GUIDE.md)** for:

- every plugin configuration field;
- AGY project/workspace binding;
- execution modes and permissions;
- main-agent and subagent usage;
- native tools and file paths;
- sessions, images and compatibility mode;
- verification and troubleshooting.

Also see:

- [examples/openclaw.json5](examples/openclaw.json5)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/BUILD.md](docs/BUILD.md)
- [docs/QUALIFICATION.md](docs/QUALIFICATION.md)

## Runtime boundary

```text
OpenClaw session
  -> antigravity/* AgentHarnessV2
  -> agy
  -> AGY model + native tools
  -> OpenClaw completion
```

OpenClaw owns orchestration, agents, sessions and subagents. AGY owns authentication, projects, conversations, model execution and native tool permissions.

## License and third-party notice

MIT for this plugin's source code. Third-party software and services remain under their own terms.

Public project: https://github.com/claw0gang/antigravity-plugin
