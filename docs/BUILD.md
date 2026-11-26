# Reproducible build and public export

The public source distribution contains the runtime source, build tools, tests and selected documentation. These commands prepare local artifacts and do not publish, install into a Gateway, mutate OpenClaw, or qualify live AGY behavior.

## Toolchain and clean recipe

Use a Node.js version that satisfies both `package.json#engines.node` and the development SDK's own engine requirement below. npm is supplied by the build environment; the project does not pin one npm release. `build-toolchain.json` records this compatibility contract plus the exact development OpenClaw SDK provenance, while `package-lock.json` fixes dependency versions and registry integrity. Build identity deliberately records the supported Node range and environment-provided npm policy rather than the observed Node/npm versions, so supported newer runtimes do not invalidate otherwise identical source builds. The exact OpenClaw SDK version is reproducible build provenance only; runtime host compatibility is decided by the plugin's declared lower-bound compatibility metadata plus required public contracts, not equality to that SDK version. Runtime support still needs the observations in [the qualification guide](QUALIFICATION.md).

In an isolated development checkout with a supported Node/npm environment:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run pack:check
```

Dependency installation belongs in the isolated development environment. Never run this recipe against a production OpenClaw installation or use it to install, downgrade, upgrade, restart, stop, reconfigure or patch OpenClaw.

The current development SDK is OpenClaw `2026.11.7`. Its own Node requirement is `>=24.16.0 <25 || >=26.1.0`; use a runtime compatible with the dependencies being tested. This records the upstream SDK requirement, without changing the plugin's existing host support floor. The modern session adapter requires public runtime-bound `getSessionEntryAsync`, `listSessionEntriesAsync`, `prepareSessionEntryPatch` and `withSessionEntriesAsync`. Missing any member of a partially present modern surface rejects runtime registration before any provider/catalog/harness/service hook is registered. The selected-entry callback uses the existing runtime member, with no new SDK subpath import.

A capability-selected adapter retains the older public session API path for supported older hosts; it is selected before work and never used to retry a failed modern operation. OpenClaw documents the affected synchronous APIs' final compatibility day as December 31, 2026, with removal in the first January 2027 stable release. The support floor remains separate from qualification of an exact host.

`build` creates the runtime and declarations from `src/`, then records the input and payload digests. `prepack` verifies those bytes; it does not rebuild them. A source, metadata, compiler-input or payload change requires a fresh build and affected qualification. Treat a missing or mismatched build record as a failure, not a reason to bypass scripts when producing the qualification package.

During the explicit build, declared regular package files—including public metadata/documentation and the build manifest—are normalized to mode `0644`. This keeps package payload bytes independent of the checkout/build umask. Prepack rejects later mode changes and does not modify permissions.

Both OpenClaw extension metadata fields point to the shipped `dist/index.js`; lightweight provider discovery points to `dist/provider-discovery.js`. The package contains its declared runtime, declarations, metadata and selected usage documentation. Source tests and release-preparation tools are available in the public source export.

## Export and artifact identity

The explicit public-export manifest selects source, tests, fixtures, build tooling and necessary documentation. It excludes private task state, operational material, historical handoffs, dependencies, generated output and GitHub workflows. Export fails on missing selected files, path escapes or symlinked inputs instead of guessing a replacement.

After a passing build/check, create an archive and export in a new development scratch directory:

```sh
agy_artifacts="$(mktemp -d)"
npm pack --pack-destination "$agy_artifacts"
npm run export:public -- --output "$agy_artifacts/public"
```

`public-export-manifest.json` records the sorted relative-path/content digests. Two exports of unchanged selected files must produce identical manifest bytes. Run the same dependency-locked build/check/pack recipe from the exported directory and compare the package payload and archive produced within that qualification campaign. The exact archive digest is bound to the artifact that is qualified and published; it is not a claim that every compatible npm version must emit byte-identical tar metadata. An archive's digest and its unpacked payload digest have different purposes: preserve both. Qualification reuses the exact archive for ANTIGRAVITY-owned package/import and AGY behavior checks; it does not install or replace OpenClaw. The export command accepts only a new destination outside the source tree, under an existing canonical parent.

Keep build records and generated exports in an isolated development directory. Retain the exact release archive and its digests; remove only disposable build material after verification.

## Evidence boundaries

The registered provider/harness uses AGY-native authentication for fresh turns and exact conversation resume. No independent account adapter, credential inspection or account-switching test is required. Source regressions exercise ordinary registration with a deterministic AGY fixture; they establish plugin behavior without claiming authenticated native execution. Native authentication remains managed by AGY.

`npm test` uses the actual installed development SDK dependency. `test:source` explicitly substitutes the source SDK fixture and cannot establish installed production-host behavior. Compilation alone proves neither of those. Package checks inspect actual archive content; compatibility inspection establishes documented import/registration behavior. Production OpenClaw is observed read-only through its current public contracts; ANTIGRAVITY does not install, upgrade, downgrade, restart, stop, reconfigure or patch it for qualification. Live AGY sessions, catalog behavior and native effects remain separate bounded qualification obligations.

Session evidence must distinguish descriptive full reads, `captureSessionEntryCurrentCheckAsync` and validation inside `withSessionEntriesAsync`. Check foreign-process reset-envelope changes, lifecycle-revision changes, session-ID replacement and deletion independently; record whether each observation detects the changed authority and whether the synchronous callback predicate refuses the dependent effect. The plugin compares the raw authority fields documented in [the session contract](ARCHITECTURE.md#54-awaited-public-session-integration), rejects mismatches without refreshing or retrying, and treats values returned from the callback as descriptive.

Record the exact source and archive identities with any compatibility measurements. Isolated SDK checks do not establish live Gateway ownership, native execution or delivery.
