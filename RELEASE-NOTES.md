# Antigravity Plugin 0.3.3 release notes

`0.3.3` adds the comprehensive human/agent usage manual and configuration guidance requested for Antigravity Plugin. Runtime implementation behavior is unchanged.

## Changed

- Added `docs/USER-GUIDE.md` covering every supported plugin configuration field and major released feature.
- Simplified the README into a concise installation and quick-start entry point.
- Documented normal `accept-edits` and `plan` usage, AGY project/workspace binding, models, sessions, images, permissions and troubleshooting.
- Documented the current native `agent` carrier limitation and native fail-closed OpenClaw restriction behavior.
- Updated the bundled agent skill to require absolute paths for AGY native file tools inside the authorized workspace/project scope.
- Clarified that plugin configuration is persistent and does not need to be rewritten for each task/model.
- Restored the categorical warning for individual Antigravity OAuth access through third-party software such as OpenClaw.

## Unchanged

No runtime implementation source changed as part of the Round-2 correction.

Accepted private source:

```text
claw0gang/antigravity@d350d8bc5f25f58ae3449b5846698b89c5f012b6
```

Accepted review:

```text
p02t017r01 — Round 2 PASS
state 80df56f70833bbc1ff50b1159ff9c9a29bf15ef4
```

Rollback release:

```text
v0.3.2
claw0gang-antigravity-0.3.2.tgz
SHA-256 e3f931f02e47443da14369fe6fd44b0c3abf0501a9dea86fc8603f7746372b84
```
