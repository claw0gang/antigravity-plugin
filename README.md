# Antigravity Plugin for OpenClaw

Use Google Antigravity CLI (`agy`) models as OpenClaw agent runtimes.

The plugin exposes one provider and native harness, `antigravity`, through OpenClaw `AgentHarnessV2`. Models use `antigravity/<exact-native-model-id>` and come from live AGY discovery.

The registered harness runs fresh turns and resumes the exact stored AGY conversation using AGY's own authentication. The plugin does not identify accounts, inspect credentials or add a separate login flow. Source validation and native AGY/Gateway execution remain separate evidence.

> **Upstream-service notice:** this is an independent third-party integration. Google's [Antigravity Additional Terms](https://antigravity.google/terms) and [FAQ](https://antigravity.google/docs/faq), checked November 26, 2026, state that using third-party software, including OpenClaw, to access Antigravity with an individual Antigravity login/OAuth is prohibited and may result in suspension or termination. Do not use an individual/personal Antigravity account with this integration unless Google expressly authorizes that use. Enterprise and Google Cloud routes may be governed by separate terms; verify the agreement that applies to your deployment. Official ACP editor support does not establish authorization for this OpenClaw integration.

## Requirements

- OpenClaw plugin API / Gateway `>=2026.9.2`
- Node.js `>=22.12.0`
- `agy` installed, authenticated and available to the OpenClaw Gateway; the existing minimum is 1.1.28

Built against OpenClaw SDK **2026.11.7**. Ordinary operation and native fresh, resume and reset were observed on OpenClaw **2026.11.8** with AGY **1.5.17**. The support floors remain unchanged.

## Prepare AGY

Install AGY using the [official instructions](https://antigravity.google/docs/getting-started/) and authenticate with a permitted account in the environment used by the OpenClaw Gateway.

Create a dedicated local AGY project for OpenClaw. In AGY 1.5.0 or later, launch `agy`, open `/projects`, create a project named OpenClaw, and select its folders. Alternatively, `agy --new-project` creates a new project on startup. Use AGY's project interface to configure the resource roots to contain each intended OpenClaw agent workspace. Add only the folders needed. See [AGY projects](https://antigravity.google/docs/cli/projects/).

Obtain the exact local AGY project ID, not its display name or a Google Cloud billing project ID. Use the native project details where the installed CLI exposes the ID. On standard local installations, project metadata has historically been stored at `~/.gemini/config/projects/<project-id>.json`; if necessary, check only the newly created project's own metadata and match its name and resource roots to the filename ID. If the layout differs, use the installed CLI's help rather than guessing. Confirm the selection with `agy --project=YOUR-AGY-PROJECT-ID`. Keep the actual project ID and metadata private.

For example, a resource root of `/home/user/.openclaw/workspace` contains an agent workspace at `/home/user/.openclaw/workspace/main`. Replace these synthetic paths with your intended workspace paths. Set the exact ID in `plugins.entries.antigravity.config.project` in `openclaw.json`. Neither `newProject: true` nor `addDirs` replaces the required project binding. Keep the configuration persistent.

Check AGY first:

```bash
agy --version
agy models --output-format json
```

## Install

From ClawHub:

```bash
openclaw plugins install clawhub:@claw0gang/antigravity@0.3.4 --accept-capabilities
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

The exact `project` ID is required for native execution. Merge the configuration into your existing `openclaw.json`. AGY owns authentication and project access; resume uses the exact bound native conversation and model.

This configuration is persistent. You do **not** reconfigure the plugin when selecting a different `antigravity/*` model for a task or subagent.

The plugin defaults to explicit `mode: "accept-edits"`; it does not inherit AGY auto or orchestrator selection. For planning-only workloads, use `mode: "plan"`. Keep `dangerouslySkipPermissions: false` for normal operation.

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

The examples are illustrative, not a static catalog. Select an ID actually returned for the current native account. The plugin preserves exact model selection and does not silently switch to another effort/model.

On supported modern hosts the native thinking selector exposes verified model-specific levels. Native selection (`off`) preserves the selected model, not zero reasoning. Supported overrides use invocation-level `--effort`; unsupported overrides are rejected. Reset or start a new session before changing a bound model variant.

A successful inventory establishes current native discovery, not whether AGY authenticated with OAuth, an API key or another native method. Authentication remains owned by AGY; the plugin does not import or rewrite its credentials.

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
- sessions, image limitations and older configuration handling;
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

The native harness uses AGY's own authentication and endpoint. Authored OpenClaw endpoint overrides, selected OpenClaw credential profiles and host-owned execution requirements are rejected when this runtime cannot preserve them.

When upgrading, remove obsolete generic CLI backend configuration, select a live `antigravity/*` model, and start a new session or use a supported reset for incompatible old bindings. There is no automatic fallback or prefix-based session migration.

The native harness uses bounded, text-only stream-json transport.

## License and third-party notice

MIT for this plugin's source code. Third-party software and services remain under their own terms.

Public project: https://github.com/claw0gang/antigravity-plugin
