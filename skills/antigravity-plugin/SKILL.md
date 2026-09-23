---
name: antigravity-plugin
description: Runtime guidance for OpenClaw agents using the Antigravity plugin.
user-invocable: false
---

# Antigravity Plugin

When using the Antigravity runtime:

- Use the requested `antigravity/*` model exactly; do not silently substitute another model or runtime.
- Preserve the caller's workspace and configured permissions; do not broaden access or change project configuration.
- Treat runtime or configuration errors as failures and report them instead of working around them by increasing authority.
- Use `antigravity-cli/*` compatibility mode only when the operator explicitly selected it.
