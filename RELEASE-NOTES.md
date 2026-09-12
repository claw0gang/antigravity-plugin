# ANTIGRAVITY 0.2.6 release notes

ANTIGRAVITY 0.2.6 refreshes the external-plugin contract for the current OpenClaw release line while preserving the existing native AGY execution architecture.

## Highlights

- Built and validated against OpenClaw `2026.9.4` with compatibility declared for plugin API `>=2026.9.2 <2027.0.0`.
- Current release-validation baseline: OpenClaw `2026.9.4` and AGY `1.2.1`.
- Provider-scoped live model discovery for the native `antigravity/*` runtime, with no executable static native model rows.
- Exact preservation of effort-qualified AGY model identities such as `gemini-3.8-flash-low` across selection, execution, attribution, binding, and resume.
- Cold-discovery synthetic-auth readiness marker for AGY-native authentication; the marker is control-plane only and is never sent to AGY.
- Portable public SDK type declarations; no generated references to internal OpenClaw `dist/types-*` modules.
- Explicit `dangerouslySkipPermissions` behavior remains default-off and maps to one AGY `--dangerously-skip-permissions` flag when intentionally enabled.
- Native-tool terminal results continue through OpenClaw's host-owned terminal observation contract.

## Acceptance evidence

The frozen canonical 0.2.6 candidate passed deterministic build/test/package validation and isolated current-runtime acceptance with:

- provider-scoped discovery of `antigravity/gemini-3.8-flash-low`;
- successful AGY-native `view_file` execution;
- exact model attribution with no fallback or reroute;
- same-session exact-model resume;
- restricted/default mode failing closed without unsafe success;
- unchanged production OpenClaw configuration, Gateway state, and AGY global settings.

This candidate is prepared for ClawHub package verification and independent release audit. Publication is a separate manual action.
