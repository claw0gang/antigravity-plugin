# ANTIGRAVITY 0.2.6 release notes

ANTIGRAVITY `0.2.6` updates the public OpenClaw plugin contract for the current `2026.9.x` release line while preserving the existing native Google Antigravity CLI (`agy`) execution architecture.

> **Independent project and upstream service notice:** This is an independent third-party integration and is not affiliated with, sponsored by, or endorsed by Google or OpenClaw. Google's current individual Antigravity terms and FAQ state that third-party access through OpenClaw with an Antigravity login/OAuth is prohibited and may result in suspension or termination. Enterprise/Google Cloud routes may be governed by separate terms. See [`NOTICE.md`](./NOTICE.md) and verify the terms applicable to your access route before use.

## Compatibility

| Component | 0.2.6 |
| --- | --- |
| OpenClaw plugin API | `>=2026.9.2 <2027.0.0` |
| Minimum OpenClaw Gateway | `>=2026.9.2` |
| Exact build baseline | OpenClaw `2026.9.4` |
| Runtime validation baseline | OpenClaw `2026.9.4`, AGY `1.2.1` |
| Node.js | `>=22.12.0` |

The AGY version above is the validated baseline, not a declared minimum AGY version.

## Highlights

- Provider-scoped live model discovery for the native `antigravity/*` runtime.
- No executable static native model rows; native admission is based on live AGY discovery.
- Exact preservation of effort-qualified AGY model identities such as `gemini-3.8-flash-low`.
- Per-attempt live model validation before native execution.
- Exact model/conversation binding for native session resume, with mismatch conditions failing closed.
- Cold-discovery synthetic-auth readiness support for AGY-native authentication; the marker is control-plane metadata only and is never sent to AGY.
- Portable public SDK type declarations without generated references to internal OpenClaw `dist/types-*` modules.
- `dangerouslySkipPermissions` remains explicit, default-off, and maps to one AGY `--dangerously-skip-permissions` flag when enabled.
- Native-tool terminal outcomes continue through OpenClaw's host-owned observation contract and are conservatively treated as replay-unsafe after completion.
- Native image input supports PNG, JPEG/JPG, WebP, and GIF through private attempt-scoped temporary files.

## Validation evidence

The frozen canonical `0.2.6` candidate passed deterministic build/test/package validation and isolated runtime acceptance covering:

- provider-scoped discovery of `antigravity/gemini-3.8-flash-low`;
- successful AGY-native `view_file` execution;
- exact model attribution without fallback or reroute;
- same-session exact-model resume;
- restricted/default permission behavior failing closed without unsafe success;
- unchanged production OpenClaw configuration, Gateway state, and AGY global settings.

## Public source provenance

[`EXPORT-MANIFEST.json`](./EXPORT-MANIFEST.json) records the canonical source commit, runtime source-tree identity, validation baseline, public export contents, and artifact state for this source snapshot.

This repository snapshot does not by itself assert current ClawHub publication, tag, or registry status. Publication remains a separate release action.
