# antigravity-plugin 0.3.0 release notes

`0.3.0` is the Phase 2 native-harness release of the independent ANTIGRAVITY OpenClaw plugin.

## Highlights

- Primary `antigravity/*` execution uses OpenClaw `AgentHarnessV2`; `antigravity-cli/*` remains a disjoint generic CLI-backend compatibility path.
- Ordinary OpenClaw subagent spawning on exact ANTIGRAVITY models is supported for representable child policies.
- Completed AGY child output is delivered through OpenClaw's supported assistant-result contract and independently mirrored into the canonical transcript.
- Qualified OpenClaw restrictions are translated into deterministic AGY-native policy carriers; unsupported or ambiguous policy shapes remain fail-closed.
- Live AGY model discovery, exact model identity, exact conversation resume, image input, terminal tool evidence, and conservative replay fencing remain part of the native runtime.
- `dangerouslySkipPermissions` remains explicit and default-off.

## Compatibility

| Component | Release contract |
| --- | --- |
| OpenClaw plugin API | `>=2026.9.2` |
| OpenClaw Gateway | `>=2026.9.2` |
| Reproducible SDK build provenance | `2026.9.4` |
| Corrected Phase 2 behavioral baseline | OpenClaw `2026.9.4`, AGY `1.2.6` |
| Node.js | `>=22.12.0` |

### OpenClaw 2026.9.5 status

A source/API compatibility review found no blocker: ANTIGRAVITY's required plugin-entry, harness, session mutation, and terminal-helper surfaces remain available, and the 2026.9.5 Gateway/node transport V2 migration does not apply to ANTIGRAVITY's current integration. The release preparation still requires isolated package/runtime qualification against 2026.9.5 before the final public compatibility statement is frozen.

## Packaging/provenance

Runtime source is exported from the accepted private development commit `d3cfc24a0eed0ebfd2036879002e15b3350ca467`. Public package metadata, legal notices, and release-facing documentation are release-only bytes and therefore trigger a fresh package build/test/export qualification before publication.

No public merge, tag, npm publication, GitHub release, or ClawHub publication is implied by this preparation branch.
