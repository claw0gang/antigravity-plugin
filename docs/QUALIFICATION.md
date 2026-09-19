# ANTIGRAVITY qualification

Qualification proves ANTIGRAVITY. It does not qualify, install, upgrade, downgrade, restart, reconfigure, patch, or otherwise manage OpenClaw.

The OpenClaw installation on a production host is context only. Host checks may read the current OpenClaw package/runtime version and inspect public plugin contracts when that observation is non-mutating. They must not use production OpenClaw as a version-matrix or upgrade test subject.

## Compatibility model

ANTIGRAVITY is built against an exact OpenClaw SDK version for reproducibility, but runtime host admission is not pinned to that exact release or calendar family.

A host is eligible when:

1. its stable OpenClaw runtime version is at or above the declared minimum known-compatible floor;
2. all public registration/session contracts required by ANTIGRAVITY are present; and
3. the ANTIGRAVITY package itself passes its product validation.

A newer stable OpenClaw release is not rejected merely because its version number moved forward. An incompatibility result must identify a real missing/changed required contract or a below-floor/invalid runtime.

The exact SDK build version remains package provenance. It does not mean only that OpenClaw release is supported.

## Product-owned validation

For a frozen candidate source tree, use the repository's locked development inputs and run the product checks against candidate-owned files only:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm test
npm run test:source
npm run test:build-tools
npm run pack:check
```

A qualifying artifact must then be produced from that same source identity with `npm pack` and the public export tooling. Record the source revision, package version, build digest, tarball digest, packed payload tree digest, public source-tree digest, and public export-manifest digest. A product correction changes candidate identity and therefore requires a new freeze.

The package's exact OpenClaw SDK dependency is a build input. Running the checks above does not authorize changing the production OpenClaw installation.

## Read-only OpenClaw compatibility observation

When host evidence is required, bind the exact hostname before any host read. The compatibility observation may read:

- the currently installed OpenClaw package/runtime version;
- the exact installed OpenClaw package root needed for module resolution;
- the public plugin SDK subpaths required by ANTIGRAVITY; and
- the public registration/session contracts exposed to the plugin.

The compatibility driver must not:

- install or remove OpenClaw packages;
- select a historical OpenClaw release;
- run an OpenClaw upgrade or downgrade;
- stop or restart the production Gateway;
- write OpenClaw configuration or session state;
- invoke catalog refresh operations that mutate host state;
- modify OpenClaw source or package files; or
- claim OpenClaw itself was qualified by ANTIGRAVITY.

The evidence boundary is simply: the frozen ANTIGRAVITY artifact can load against the current host's public OpenClaw contracts without changing the host.

## AGY qualification

AGY is a separate external runtime. Qualification may use fake AGY fixtures for deterministic failure, inventory, model-churn, replay, timeout, denial, image-cleanup, and protocol cases.

Real authenticated AGY calls require a separately bound finite native-call/runtime/spend budget and the permitted authentication route. Real calls prove only the named ANTIGRAVITY/AGY behaviors observed. They do not authorize OpenClaw mutation.

Current-host live acceptance should concentrate on the ANTIGRAVITY-sensitive boundaries that cannot be established by source tests alone, such as:

- real AGY capability/preflight behavior;
- current live model discovery;
- fresh native execution;
- exact conversation resume semantics;
- reset/new-conversation behavior where it can be exercised without production OpenClaw mutation; and
- exact model/project/account isolation.

Never use `--continue`; resumed native execution must use the exact bound AGY conversation identity.

## Evidence and failure classification

Keep these failure classes distinct:

- **PRODUCT** — candidate source/package/runtime behavior is wrong;
- **HARNESS** — qualification runner/fixture/transfer assumptions are wrong;
- **HOST_INCOMPATIBLE** — the current production OpenClaw public contracts genuinely do not satisfy ANTIGRAVITY requirements;
- **AUTH/AGY** — the bounded AGY route or native runtime fails independently of OpenClaw;
- **AUTHORITY** — the required observation/action is not authorized.

A harness failure does not become a product defect merely because it happened during qualification. A historical OpenClaw version disappearing is not a failure condition because historical OpenClaw releases are not qualification subjects.

Raw credentials, account identifiers, project identifiers, Gateway tokens, and conversation identifiers must not be copied into public evidence. Use hashes or bounded non-sensitive observations where identity correlation is required.

## Production boundary

On `aphenon-tokyo`, OpenClaw is production. Without separate explicit founder authority, ANTIGRAVITY qualification must not install the candidate into production OpenClaw or alter production OpenClaw/Gateway/config/state in any way.

Candidate installation tests belong in candidate-owned isolated environments. Production compatibility is read-only.

## Completion

A candidate becomes ready for behavioral acceptance only after:

1. product build/test/package/export checks pass on one exact candidate;
2. a new immutable artifact identity is frozen;
3. required read-only current-host OpenClaw compatibility observation passes;
4. required bounded AGY/plugin live checks pass under their explicit authority; and
5. the founder completes the required personal live-agent acceptance.

Independent critic/review follows those acceptance steps. Publication, accepted-main merge, production deployment and production OpenClaw changes require their own authority.
