# Antigravity Plugin 0.3.2 release notes

`0.3.2` corrects the bundled OpenClaw skill while leaving runtime implementation behavior unchanged.

## Changed

- The bundled `antigravity-plugin` skill now briefly explains how an OpenClaw agent uses Antigravity-backed subagents through the normal `sessions_spawn` flow.
- It tells the agent to use an exact configured `antigravity/*` model, preserve caller restrictions, and avoid silent runtime/model substitution.
- It keeps `antigravity-cli/*` as explicitly selected compatibility mode rather than an automatic fallback.
- Detailed installation, configuration, model discovery, AGY project binding, permissions, examples and troubleshooting remain in the public repository documentation instead of being duplicated into the runtime skill.

## Unchanged

No runtime implementation source is changed relative to the accepted 0.3.2 runtime baseline.

Private correction source:

```text
claw0gang/antigravity@8d20082d3cb175f521b1e78e234d7553e9bb8598
```

Rollback release:

```text
v0.3.1
claw0gang-antigravity-0.3.1.tgz
SHA-256 1fd4e07ffa5ac91b0202e7f5a6aa65cc86971b4a7ded13e00b9ea8c31a78105d
```
