# Antigravity Plugin 0.3.2 release notes

`0.3.2` is a narrow correction to the bundled OpenClaw skill introduced in 0.3.1. Runtime implementation behavior is unchanged.

## Changed

- Replaces the oversized bundled skill with four runtime-only guardrails.
- Removes installation, AGY authentication, project discovery/binding, local config-path, filesystem-expansion, permission-bypass, subprocess-implementation and troubleshooting guidance from the agent-facing skill.
- Keeps human installation/configuration/security guidance in the README rather than the runtime skill.

## Unchanged

No runtime implementation source is changed relative to accepted private 0.3.1 baseline `3b4801039fce4cb49780726839247b31f713aa36`.

Private correction source:

```text
claw0gang/antigravity@41f9080d6f82894bdfd44ac95ed437665304c768
```

Rollback release:

```text
v0.3.1
claw0gang-antigravity-0.3.1.tgz
SHA-256 1fd4e07ffa5ac91b0202e7f5a6aa65cc86971b4a7ded13e00b9ea8c31a78105d
```
