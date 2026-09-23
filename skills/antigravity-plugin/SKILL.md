---
name: antigravity-plugin
description: Configure and use the Antigravity Plugin for OpenClaw, including its required AGY project binding and per-subagent model selection.
user-invocable: false
---

# Antigravity Plugin

Use this skill only when configuring or operating `@claw0gang/antigravity`.

- Install the published package with `openclaw plugins install clawhub:@claw0gang/antigravity`. A bare `@claw0gang/antigravity` spec resolves as npm, not ClawHub.
- AGY must already be installed, authenticated, and available as `agy` or through the plugin's explicit `command` setting.
- Native `antigravity/*` execution requires `plugins.entries.antigravity.config.project` to contain one exact AGY project id. The corresponding project record (normally `~/.gemini/config/projects/<id>.json`) must have a resource root containing the OpenClaw attempt workspace/cwd. Do not use `newProject: true` for the native strict-identity path.
- Route the model namespace with `agents.defaults.models["antigravity/*"].agentRuntime.id = "antigravity"`. This chooses the runtime, not a model.
- Choose the concrete model per child spawn when different subagents need different models. Do not set a global subagent model merely to use this plugin.
- Omitting `agentId` on `sessions_spawn` keeps the child under the requester agent. Omitting `cwd` uses that agent's normal workspace; an explicit `cwd` must remain inside the configured AGY project root.
- Keep `sandbox: true` and `dangerouslySkipPermissions: false` unless the operator explicitly requests different AGY-native authority. OpenClaw workspace/tool policy and AGY-native permissions are separate enforcement layers.
- `addDirs` broadens AGY-native filesystem scope; add directories only when deliberately required.
- If execution reports that strict native execution requires `config.project`, inspect the configured AGY projects and set the exact project id whose resource root contains the intended OpenClaw workspace.

Security note: this plugin intentionally launches the configured `agy` executable. Its process bridge uses structured argv with shell execution disabled, and sends prompt content over stdin. The subprocess capability is required for the CLI-backed harness.
