# Reproducible build and public export

The development repository is the only implementation source. A public export is a deterministic projection of an exact source candidate; it is never an independently edited implementation. These commands prepare local artifacts and do not publish, install into a Gateway, mutate OpenClaw, or qualify live AGY behavior.

## Toolchain and clean recipe

Use any Node.js version that satisfies `package.json#engines.node`. npm is supplied by the build environment; the project does not pin one npm release. `build-toolchain.json` records this compatibility contract plus the exact development OpenClaw SDK provenance, while `package-lock.json` fixes dependency versions and registry integrity. Build identity deliberately records the supported Node range and environment-provided npm policy rather than the observed Node/npm versions, so supported newer runtimes do not invalidate otherwise identical source builds. The exact OpenClaw SDK version is reproducible build provenance only; runtime host compatibility is decided by the plugin's declared lower-bound compatibility metadata plus required public contracts, not equality to that SDK version. Runtime support still needs the observations in [the qualification guide](QUALIFICATION.md).

In an isolated development checkout with a supported Node/npm environment:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run pack:check
```

Dependency installation belongs in the isolated development environment. Never run this recipe against a production OpenClaw installation or use it to install, downgrade, upgrade, restart, stop, reconfigure or patch OpenClaw.

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

Keep build records and generated exports in the task's disposable build area until an exact immutable package has a declared later consumer. Host retention follows the bound workspace rules. Required evidence must be secured in the owning task before removing disposable output. Transient build/test trees are deleted after final use rather than accumulated on a production host.

## Evidence boundaries

`npm test` uses the actual installed development SDK dependency. `test:source` explicitly substitutes the source SDK fixture and cannot establish installed production-host behavior. Compilation alone proves neither of those. Package checks inspect actual archive content; compatibility inspection establishes documented import/registration behavior. Production OpenClaw is observed read-only through its current public contracts; ANTIGRAVITY does not install, upgrade, downgrade, restart, stop, reconfigure or patch it for qualification. Live AGY sessions, catalog behavior and native effects remain separate bounded qualification obligations.
