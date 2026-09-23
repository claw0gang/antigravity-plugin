---
name: antigravity-plugin
description: Use the Antigravity OpenClaw runtime for delegated subagents.
user-invocable: false
---

# Antigravity subagents

Use Antigravity through OpenClaw's normal subagent flow.

- Delegate with `sessions_spawn` to an OpenClaw subagent configured with an exact `antigravity/*` model.
- Keep the requested Antigravity model and runtime exact. If they are unavailable, report the failure instead of silently substituting another model or runtime.
- Prefer the native `antigravity/*` runtime. Use `antigravity-cli/*` only when the operator explicitly selected compatibility mode.
- Preserve the caller's workspace and access restrictions. Do not broaden permissions to make a spawn succeed.
- Let OpenClaw manage orchestration, sessions, and subagent lifecycle; do not invoke `agy` directly to create or manage OpenClaw subagents.

For installation, model discovery, AGY project binding, permissions, configuration examples, and troubleshooting, see:

https://github.com/claw0gang/antigravity-plugin
