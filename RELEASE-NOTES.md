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

Isolated release qualification passed against OpenClaw `2026.9.5`: the packaged plugin loaded against the required public SDK subpaths, preserved the expected provider/catalog/harness/CLI registrations, matched the exact archive payload to the installed plugin tree, and passed an isolated plugin install/inspect cycle. This does not qualify OpenClaw itself, the production Gateway, or additional live AGY behavior beyond the separately accepted behavioral baseline.

## Packaging/provenance

Canonical private release source is `b16e85f112453f5272248a7629a89787b7a23cd1`. Its only delta from accepted runtime commit `d3cfc24a0eed0ebfd2036879002e15b3350ca467` is the simulated source-SDK test fixture; runtime `src/**` is unchanged. Public package metadata, legal notices, and release-facing documentation are release-only bytes and are included in the final package build/test/export qualification before publication.

No public merge, tag, npm publication, GitHub release, or ClawHub publication is implied by this preparation branch.
