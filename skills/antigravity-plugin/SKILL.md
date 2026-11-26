---
name: antigravity-plugin
description: Use the Antigravity OpenClaw runtime for delegated subagents.
user-invocable: false
---

# Antigravity subagents

Use Antigravity through OpenClaw's normal subagent lifecycle. Native turns in the current source candidate require a separately qualified host runtime adapter; ordinary registration provides live discovery but rejects execution before launch. Report the missing identity capability instead of trying a configuration or direct-CLI workaround.

- Delegate with `sessions_spawn` using the exact requested `antigravity/*` model. Do not silently substitute another model or runtime.
- Use the single native `antigravity` provider/harness and exact live model IDs. The former `antigravity-cli/*` backend is removed; never silently convert its sessions or select it as a fallback.
- Let OpenClaw own spawn, yield/completion, sessions and routing. Do not invoke `agy` directly to create or manage OpenClaw subagents.
- Preserve the caller's workspace and access restrictions. Do not change project roots, `addDirs`, sandbox settings or permissions to make a task succeed.
- For AGY native file tools, use absolute paths inside the authorized OpenClaw workspace / AGY project scope. Do not assume relative paths will be accepted.
- If AGY reports a validation, sandbox, permission or runtime failure, report it. Do not broaden authority or enable `dangerouslySkipPermissions` as a workaround.
- Model selection is per task/spawn; plugin configuration is persistent and does not need to be rewritten for each model.

Human setup and full configuration reference:

https://github.com/claw0gang/antigravity-plugin/blob/main/docs/USER-GUIDE.md
