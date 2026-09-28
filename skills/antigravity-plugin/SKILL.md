---
name: antigravity-plugin
description: Use the Antigravity OpenClaw runtime for delegated subagents.
user-invocable: false
---

# Antigravity subagents

Use Antigravity through OpenClaw's normal subagent lifecycle.

- Delegate with `sessions_spawn` using the exact requested `antigravity/*` model. Do not silently substitute another model or runtime.
- Prefer native `antigravity/*`. Use `antigravity-cli/*` only when the operator explicitly selected compatibility mode.
- Let OpenClaw own spawn, yield/completion, sessions and routing. Do not invoke `agy` directly to create or manage OpenClaw subagents.
- Preserve the caller's workspace and access restrictions. Do not change project roots, `addDirs`, sandbox settings or permissions to make a task succeed.
- For AGY native file tools, use absolute paths inside the authorized OpenClaw workspace / AGY project scope. Do not assume relative paths will be accepted.
- If AGY reports a validation, sandbox, permission or runtime failure, report it. Do not broaden authority or enable `dangerouslySkipPermissions` as a workaround.
- Model selection is per task/spawn; plugin configuration is persistent and does not need to be rewritten for each model.

Human setup and full configuration reference:

https://github.com/claw0gang/antigravity-plugin/blob/main/docs/USER-GUIDE.md
