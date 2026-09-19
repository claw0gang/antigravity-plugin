# Roadmap

## Historical baseline

The [accepted pre-Phase-2 roadmap](https://github.com/claw0gang/antigravity/blob/bf6ddab1222ac5b93de9f0576c8ff6e0cec5c17c/docs/ROADMAP.md) records v0.1.4 completion and v0.2.6 hardening. Its p01 acceptance, review and effect semantics are historical and are not relabeled by this revision. The explicit `antigravity-cli/*` compatibility surface remains separate from the `antigravity/*` native HarnessV2 path. Nothing here creates a new release or changes installed software.

## Phase 2 — reliable delegated runtime

Status: **Phase 2 implementation/qualification roadmap under the production-read-only OpenClaw boundary.** The [reviewed plan](https://github.com/claw0gang/antigravity/blob/3c9c8262b09438d77ff94c29463ee142652be1d2/docs/PHASE2.md) owns the agreed product scope. [Architecture](ARCHITECTURE.md) freezes the design; [the acceptance matrix](phase2/ACCEPTANCE.md) is the only phase matrix. Admitted task definitions live on the state branch, not in duplicated product task files. All p02 tasks retain exact governance `72fb154bf4f375c3ddcca2031896151d19b275b2`.

The phase targets a coherent 0.3.0 candidate, not version-number-based acceptance. Preserve OpenClaw orchestration/canonical sessions and AGY native inference/tools/permissions. Required results are truthful instruction handling, identity, replay, bounded settlement, host results and inventory. OpenClaw is a fast-moving external runtime: ANTIGRAVITY declares a compatibility lower bound for packaging and admits newer stable hosts when its required public contracts remain present. Exact build-SDK provenance is not a production-host pin. New AGY model IDs require no plugin replacement or per-model plugin table; OpenClaw owns when and how it invokes provider/catalog hooks and publishes its own catalog.

| Task | Deliverable and dependency | Acceptance boundary |
| --- | --- | --- |
| p02t001 | Architecture, C01–C05 interfaces, support policy, P01–P06 probes, A01–A24 matrix | One standard design critic; no runtime qualification. |
| p02t002 | Process/protocol/evidence; needs accepted t001 interfaces | Reviewed source/fixtures; P02/P03/P06 real behavior remains with t007. |
| p02t003 | Host instruction/result/accounting/session projection; t001 plus t002 interfaces | Reviewed source/fixtures; P03/P04/P05/P06 host/native proof remains with t007. |
| p02t004 | Public OpenClaw compatibility adapter; needs t001 | Public import/capability contract and C05 feasibility; no OpenClaw lifecycle control. |
| p02t005 | Scoped inventory and lifecycle reconciliation; t001 plus t002/t004 contracts | Source fixtures and safe gating; actual provider-hook behavior, isolation and execution fencing remain P01/t007. |
| p02t006 | Locked build, deterministic export/package and bounded runner; t001 initially, joins t002–t005 | Reviewed preparation and actual available credential-free checks, not production installation/publication. |
| p02t007 | Frozen integrated source/package and one coordinated finite host campaign; t002–t006 candidates | Required A01–A23 observations under production-read-only OpenClaw boundary, probe dispositions and correction/rerun identity; standard evidence critic. |
| p02t008 | Integrated release readiness; exact t007 candidate/evidence | Standard_qa: integrated independent critic plus distinct behavioral QA, no universal third ratification. |
| p02t009 | Qualified export to public repository/npm/ClawHub; t008 plus separate target-specific authority | Published bytes must match qualification; production deployment is separate. |

Use a phase integration branch beginning at accepted main `bf6ddab1222ac5b93de9f0576c8ff6e0cec5c17c`; p02t001's design may be its first coherent commit. Compatible task branches/commits join there after the declared reviews. One coordinator owns shared-file changes. Parallel work is allowed after t001 interface acceptance, not merely because all tasks exist. State routes only work whose prerequisites are met; this task routes its critic and does not activate t002–t006 prematurely. No mandatory new session or review for each checkpoint.

P01 (supported provider/catalog publication contract) and P04 (instruction/policy carriers) are the earliest feasibility priorities. Useful design/source work continues while these are investigated, but required impossible contracts trigger the existing task's founder decision boundary before support claims or dependent activation. Do not change the agreed requirement, silently raise the host floor, replace AGY's native engine or manufacture a generic bridge to make a test green.

## Qualification and maintenance

Production OpenClaw is read-only to ANTIGRAVITY qualification. The campaign may observe the currently installed OpenClaw package/version and public contracts, but it must not install, downgrade, upgrade, restart, stop, reconfigure, patch or replace production OpenClaw, its Gateway, configuration or package selection. There is no historical OpenClaw version-pair or same-artifact host-upgrade campaign. Exact build SDK and lockfile pins remain reproducible development provenance; current-host acceptance is based on the plugin's public contract behavior, not equality to those pins.

Host choice, permitted native authentication, finite budget, exact ANTIGRAVITY/AGY binaries and isolated plugin test state are bound when t007 executes host work. First run product-owned offline/build/package/adversarial checks, then authorized AGY/provider/session tests. Current production OpenClaw observations are read-only. Native effects, historical cleanup outside ANTIGRAVITY-owned transient material, production configuration changes, merge and release require their own exact authority. No GitHub Actions are needed or authorized by this roadmap.

Requalify affected rows after a source or package change. The built candidate's digest, not a mutable branch or older PASS, determines the release subject. t008 cannot infer real behavior from fixtures or reuse stale acceptance. The public release repository is an export destination, never a second implementation source.

After release, dynamic model inventory is plugin behavior exposed through provider/catalog hooks; OpenClaw owns the host catalog lifecycle. Routine upstream-version maintenance checks current public contracts and affected behavior without pinning ANTIGRAVITY to a daily OpenClaw release number. Compatible newer OpenClaw releases or new AGY model IDs do not inherently require a plugin release or another whole phase. Optional MCP/host-tool integration, warm processes, remote execution, richer session inspection and instant picker repaint stay future proposals unless separately approved. Hermes/PicoClaw/Pi adapters remain separate products; extract common libraries only after real duplicated stable contracts justify them.
