# Antigravity Plugin 0.3.1 release notes

`0.3.1` is a compatibility/usability patch on the accepted 0.3.0 native-harness release.

## Highlights

- Fixes OpenClaw metadata/setup registration so `cli-metadata` and setup-only registration do not access runtime services unavailable in those phases; normal runtime registration remains unchanged.
- Adds the bundled lightweight `antigravity-plugin` OpenClaw skill with installation, exact AGY project-binding, model-selection, sandbox and permission guidance.
- Clarifies that native `antigravity/*` execution requires one exact AGY project whose resource root contains the OpenClaw attempt workspace/cwd; `newProject: true` is not a substitute for that strict identity binding.
- Preserves the 0.3.0 runtime architecture: native `AgentHarnessV2`, disjoint `antigravity-cli/*` compatibility backend, live AGY model discovery, exact model/conversation identity, ordinary OpenClaw subagents, image input and fail-closed policy translation.

## Compatibility and acceptance

| Component | Release contract / accepted baseline |
| --- | --- |
| OpenClaw plugin API | `>=2026.9.2` |
| OpenClaw Gateway | `>=2026.9.2` |
| Reproducible SDK build provenance | `2026.9.4` |
| Pre-publication Tokyo acceptance | OpenClaw `2026.9.4`, AGY `1.2.8` |
| Node.js | `>=22.12.0` |

The exact private subject `3b4801039fce4cb49780726839247b31f713aa36` passed independent product review and production-Tokyo pre-publication acceptance. The retained accepted private archive has SHA-256 `89bf841f0218d46f6be3b547a9f3cd0b8553ef8361b319bfc17387d037718795`. Tokyo inspection reported Antigravity 0.3.1 loaded with provider `antigravity`, CLI backend `antigravity-cli`, harness `antigravity`, clean doctor, eligible/model-visible bundled skill, healthy model discovery, and a real `antigravity/gemini-3.8-flash-low` run completing without fallback.

## Rollback

The preserved known-good prior release is `v0.3.0`. The retained verified 0.3.0 archive SHA-256 is `4c1d3a5521dbd6c35142e3eeff02905f92c3c8c8db62434f0402b729738c23d8`.

## Packaging/provenance

Canonical private release source is `3b4801039fce4cb49780726839247b31f713aa36`. Runtime/source export files in this public preparation are copied from that exact subject. Public package metadata, legal notices, release notes and release-facing README text are distribution-only bytes and must be package-qualified before publication.

No GitHub release or ClawHub publication is implied by the preparation branch alone.
