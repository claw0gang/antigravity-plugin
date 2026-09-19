# Architecture — Phase 2 contract

Status: **Phase 2 contract under the production-read-only OpenClaw boundary, not runtime implementation or qualification.** The accepted p02t001–p02t003 contracts remain in force. OpenClaw owns its runtime/catalog lifecycle; ANTIGRAVITY exposes supported provider/harness hooks and must not install, downgrade, upgrade, restart, stop, reconfigure, patch or replace production OpenClaw, its Gateway, configuration or package selection. A design PASS freezes interfaces and obligations; it does not establish host support or authorize merge, installation or release. [ACCEPTANCE.md](phase2/ACCEPTANCE.md) is the single phase acceptance matrix and probe register.

## 1. Ownership and changes from the accepted baseline

OpenClaw owns orchestration, admitted-run authority, canonical sessions/transcripts, model policy/catalog publication and delivery. AGY owns delegated inference, native tools, permissions, projects and conversations. ANTIGRAVITY translates the boundary; it does not create agents, implement Task Flow, call `sessions_spawn`, run a scheduler framework, proxy model HTTP, or introduce another session database. Preserve plugin/provider/harness `antigravity`, native models `antigravity/*`, and explicit compatibility backend `antigravity-cli/*`. Missing native requirements never select the compatibility backend implicitly.

The [accepted baseline][baseline] already has these ownership boundaries. Phase 2 corrects five interpretations, without claiming their implementation: possible process start is evidence even without tool telemetry; effective model identity must be acknowledged rather than inferred from argv; partial previews must accumulate; native success is distinct from fulfillment/denial/timeout; aggregate usage is not context occupancy. It consolidates discovery and supplies dynamic inventory through OpenClaw's public provider/catalog hooks while leaving OpenClaw's catalog lifecycle entirely host-owned. Existing p01 records and acceptance retain their original meaning.

Responsibilities may share existing small modules. The following are **semantic internal interfaces**, not new OpenClaw API names or a mandate for one class/file per row.

| Contract | Owner and consumers | Meaning |
| --- | --- | --- |
| C01 InvocationScope | t002; t003/t005 consume, t004 maps host inputs | One immutable command, environment, project/owner scope, cancellation and deadline for an operation. |
| C02 AttemptEvidence | t002 produces; t003 projects | Monotonic start/effect/identity/output/native-terminal/termination facts, independent of the final exception. |
| C03 HostProjection | t003; t004 maps public SDK | Instruction mapping, ordered delivery, outcome/accounting and canonical session binding. |
| C04 InventorySnapshot | t005; t002 acquisition and t004 host adapter | Exact-ID inventory with explicit acquisition result, authority scope, freshness and generation. |
| C05 HostCatalogAdapter | t004 supplies; t005 consumes | Public provider/harness catalog hooks, exact inventory outcomes, compatibility diagnostics and host-owned publication boundaries. Runtime qualification remains P01. |

One integration coordinator owns shared contract changes and shared-file conflicts. t002–t006 consume this exact accepted design, not a moving upstream branch. An incompatible interface change is explicitly coordinated, reviewed on affected tasks, and rerun through affected matrix rows; it is not silently accommodated by downstream guesses.

## 2. Capability classification

**R** means required for the applicable request or the Phase 2 release; **O** means optional; **U** means unsupported by this design. Evidence is separately **source** (documented/inspected), **Pnn** (named unresolved probe), or **not executed**. “Required” never means “already verified.” A request requiring an absent carrier is rejected before sending its prompt; a required release capability cannot be removed by marking it optional.

| Capability | Class | Evidence, behavior and matrix |
| --- | --- | --- |
| Public provider registration, AgentHarnessV2 and active-run assertion | R | Public harness surface inspected [S02]; packed build-SDK import and current-production-host public-contract observation remain separate evidence. A01/A02. |
| Exact prepared local environment and owner/session target | R when invoking or discovering | Preparation is optional in the SDK type [S03], not permission to substitute ambient authority. Resolve a safe documented equivalent or reject. A04/A19. |
| Exact canonical session persistence, reset and concurrent-writer fencing | R | Existing plugin-owned session metadata [S01]; P05 qualifies atomic lifecycle behavior. A14. |
| Required delegated instruction/skill semantics | R per request | Plain user task has a documented stdin carrier [S07]. Higher-priority/native-agent mapping is P04; unsupported mandatory carriers reject. A05. |
| Single-turn stdin plus incremental stream output and exact resume | R target | P02 qualifies observed AGY behavior, EOF, cardinality and resumed counters; no persistent process pool. A07/A11/A23. |
| Actual native model/conversation acknowledgement | R | Public init fields [S07] and model-resolution changes [S06]; P03 must exclude mere requested-ID echo. A06. |
| Native tool terminal observation and preserved host error resolution | R for native tools | Existing host observer use [S01]; P03/P06 qualify native event meaning and coverage. A08/A12. |
| Trace/progress adornments, optional SDK convenience helpers | O | May be absent with tested equivalent behavior; a thrown present helper is an error, not absence. A02/A10. |
| Bounded termination within a declared OS containment boundary | R | P06; native headless may leave daemons [S06]. Process-group containment is not arbitrary descendant containment. A09. |
| Live exact-ID inventory, withdrawal, empty/error distinction | R | JSON discovery documented by AGY changelog [S06]; real scoped fixtures P02/P03. A16/A18/A19. |
| Availability through supported provider/catalog hooks under OpenClaw-owned lifecycle | R release | ANTIGRAVITY returns current exact-ID inventory when the host invokes supported hooks; it does not control host refresh/reload/restart behavior. P01 qualifies current-host visibility read-only. A16/A20/A21. |
| User model policy and native execution policy preservation | R | Host remains policy owner; unmirrorable native-tool restrictions reject before launch. A05/A17. |
| Images | O by model, R when accepted | Accept only a positively supported model/transport; otherwise reject image request. Existing private staging preserved; P04/P06. A15. |
| Context occupancy, pricing, modalities, reasoning metadata | O metadata | Unknown stays unknown; structural defaults are explicitly labeled, never measured facts. A13/A16. |
| Generic OpenClaw MCP/tool/approval bridge; role-control stdin messages | U | No bridge introduced. Public stdin does not establish system/developer/control-message transport [S07]. A05/A07. |
| Warm process pooling, remote execution, instant repaint of an open picker | O future, not implemented here | Not prerequisites for core acceptance. New inventory must be available from the plugin on the next supported provider/catalog hook invocation; timing of OpenClaw's own UI/catalog lifecycle is not an ANTIGRAVITY promise. |

## 3. C01 — invocation, authority and bounded execution

Resolve once from the public, currently active host capability and validated plugin configuration:

```text
InvocationScope = {
  purpose: attempt | inventory | capability_probe,
  owner: {hostGeneration, agentId, agentDir, workspaceDir, sessionTarget?},
  command: {resolvedExecutable, observedVersion, identityGeneration},
  cwd, projectSelection, addDirs, nativeAgentSelection?,
  preparedEnv: opaque in-memory process environment,
  scopeKey: non-secret owner/command/project/auth-generation identity,
  abortSignal, deadlineMonoMs, assertActive
}
```

Names above define required information, not an assumed upstream struct. t004 maps exact public inputs; t003 preserves instruction and session provenance. `preparedEnv` is never serialized into metadata, logs, keys or reports. Do not hash secret values as a public fingerprint. Apply the host's credential scrubbing and local identity/process overlays as specified by its public contract [S03]. Never project local-only process facts into a sandbox or remote destination. If an authority boundary cannot be represented, reject that placement rather than widening it.

Execution and its discovery use the same effective command, cwd/project, prepared environment and owner. Preserve sandbox default on, explicit default-off `dangerouslySkipPermissions`, exact `project` versus `newProject` distinction, and explicit additional directories. A dangerous flag does not override host policy. No shell interpolation, global AGY settings writes, installation, or runtime upgrade belongs to discovery.

A catalog inventory operation uses the supported provider/harness invocation context, not a retained expired run capability. OpenClaw supplies its owner's scope when it invokes the plugin's public hooks; per-agent/project inventory is keyed separately. No periodic background inventory owner or ambient `process.env` polling is required. Unknown account identity cannot share an indefinite authenticated cache: reacquire within the lifetime bounds below, fence known account changes immediately, and verify native admission independently.

Check abort, active capability and deadline before discovery, staging, spawn and prompt write. The attempt deadline is the earlier of the host budget and validated finite plugin `printTimeout` (existing default 30 minutes [S13]); it is not reset after discovery. Discovery has its own maximum 10 seconds within its caller's remaining budget. A non-inference capability probe has closed stdin, bounded output and no prompt. Do not invoke an authentication workflow or paid inference to discover capabilities.

### 3.1 Process and transport limits

These are initial engineering bounds to implement and qualify, not measured performance:

```json
{"contract":"p02t004-limits-v2","discovery_timeout_s":10,"readiness_ttl_s":60,"shutdown_allowance_s":6,"term_grace_s":2,"kill_drain_s":2,"delivery_cleanup_s":2,"callback_timeout_s":1,"inventory_bytes":2097152,"inventory_rows":5000,"prompt_bytes":1048576,"event_bytes":1048576,"attempt_output_bytes":33554432,"stderr_tail_bytes":65536,"delivery_queue_bytes":2097152}
```

Bound **encoded bytes**, not character count. Enforce the prompt cap after JSON encoding and before launch, including accepted image-path annotations. Inventory caps cover raw bytes and row count. Output cap counts total stdout/stderr received; keep an incremental UTF-8 decoder across chunk boundaries and a separately bounded diagnostic tail. Oversize or invalid required data aborts the operation with evidence retained; it never becomes successful empty inventory or a replay-safe parse error. Redact sensitive diagnostic content before retention.

Use one new direct process for one host turn. The selected transport is a single newline-terminated user event on stdin, then EOF, with `--input-format stream-json --output-format stream-json` and explicit `--model`; do not combine a `-p` prompt with streaming input. Resume uses exact `--conversation`, never `--continue`. P02 must qualify this on the supported AGY behavior before enabling it. Until then the source candidate is not runtime-qualified; do not silently reinstate unbounded argv. A bounded legacy transport may be retained only as a separately tested, behaviorally equivalent adapter without changing request semantics.

The model may start before all telemetry is received. Do not assume waiting for init prevents native effects or invent an upstream pre-start handshake. Unexpected pre-init activity triggers termination and unknown-effect classification. Require one init, legal per-step transitions and exactly one result for the single submitted turn. Repeated ACTIVE updates for a step are legal; duplicate terminal delivery for that step is not. Correlate by conversation plus step/native call identity, not arrival count. Tolerate unknown additive fields and demonstrably non-semantic diagnostic events; unknown critical event types/statuses or missing required identity fail closed. P02 owns version fixtures for this distinction.

### 3.2 Cancellation and containment

Stop prompt writes and new callbacks immediately on abort/deadline/generation retirement. Send termination, allow 2 seconds, escalate and drain for 2 more seconds, then complete callback/resource cleanup within the remaining 2 seconds. All are slices of one 6-second settlement allowance, not independently restartable timeouts. Serialize critical callbacks with a 1-second individual bound; this is also bounded by the shared settlement deadline. Coalesce only superseded previews, never tool terminal outcomes. Queue excess or a failed critical callback aborts without erasing already observed facts. A timed-out callback's late continuation must have no authority to update settled state.

The baseline target is a POSIX process group containing the launcher and non-detached descendants. On normal completion as well as cancellation, settle the owned group and streams; a native terminal response alone does not prove cleanup. AGY may deliberately detach daemon tasks [S06]. No claim of sandbox-wide or arbitrary-descendant termination follows from process-group signals. P06 must demonstrate the supported boundary, detect/report escaped work where observable, and keep replay unsafe if containment is uncertain. Windows and any stronger containment claim remain unqualified until native tests establish an equivalent adapter. If required product safety needs stronger isolation than the permitted host supplies, return a concrete containment/support decision; do not grant host-wide privileges or silently omit tests. Hard guarantees against a blocked event loop, kernel stall or detached daemon require an external enforcing owner and are not claimed here.

## 4. C02 — evidence, identity, replay and result truth

```text
AttemptEvidence = {
  invocation: not_started | possible | started,
  requestedModelId, acknowledgedModelId?, conversationId?,
  nativeIdentityVerified: boolean,
  effects: none_proven | observed_possible | unknown,
  outputObserved: boolean, deliveredOutput: boolean,
  terminal: {nativeStatus?, deniedActions?, nativeTimeout?, protocolComplete},
  termination: {exitCode?, signal?, hostReason?, containment, cleanupComplete},
  accounting: {raw?, scope: step | turn | conversation | unknown},
  contextOccupancy?: {tokens, source}, lastHostToolResolution?
}
```

Facts accumulate monotonically and survive exceptions. A successful spawn or ambiguous launch marks possible start before parsing any output. Absence of tool events does not prove absence of effects. A known pre-launch failure can establish `not_started`; missing telemetry after possible start establishes `unknown`. Any observed tool may mutate unless a trusted native/host classification proves otherwise. A parser or callback failure cannot reset that fact.

**Replay rule:** automatic retry/fallback is allowed only when invocation is positively not started, no output was exposed, and no effect is possible. Every other case is unsafe by default. A future stronger proof requires a separately reviewed native guarantee; tool-name allowlists, exit codes or `num_turns` are not such a guarantee. AGY's internal provider retries are its own behavior, not authorization for ANTIGRAVITY to spawn another attempt. Acknowledged failure after launch does not undo effects. A08 exercises real marker effects before corrupted telemetry.

Treat model IDs as opaque exact identifiers from live discovery, including effort-qualified IDs; no new regex branch or static executable row is required for a new ID. Do not trim/remap an accepted ID beyond the existing explicit namespace boundary. Always send the exact selected ID; never translate host think defaults into `--effort`, substitute a sibling or silently accept deprecated alias resolution. Match acknowledged effective model and conversation to the requested model and stored binding. Public init reports a model when explicitly selected [S07], but P03 must verify that it is effective identity rather than an echo. If that proof needs native audit evidence not available to a running plugin, the affected support claim remains blocked rather than fabricated. Identity mismatch terminates and is replay-unsafe once launch was possible. Readiness/catalog display never substitutes for this check.

Project two independent facts: native terminal status and host-visible result classification. `SUCCESS` plus denied required actions is **blocked** when no useful fulfillment exists, or **partial** when some requested work completed. Preserve the answer and denial explanation. Native timeout/truncation warning is timeout/partial even with exit zero [S06]; host timeout/cancel remains separately attributed. Missing terminal, exit/terminal contradiction or unrecognized critical warning prevents completed-success classification. Acknowledged native success with unknown model identity is not accepted success. Do not infer semantic fulfillment by inventing a new model call: classify from explicit native/host evidence and preserve uncertainty.

Forward canonical native tool name, available arguments, started/outcome facts and conservative mutation evidence through the public host terminal observer. Retain its resolution, including `lastToolError`. Failure of this critical bridge is a real attempt failure, not an observational trace loss. Optional tracing may fail without redefining terminal/effect truth.

## 5. C03 — host instructions, delivery, accounting and sessions

### 5.1 Instruction projection

Represent host inputs as `InstructionRequirement {originRef, trust, scope, priority, required, contentOrResource, requiredTools}`. These are semantic mapping fields; t003 must bind them to actual supported host inputs rather than invent a higher-priority API. Produce a mapping disposition for every applicable requirement: preserved with a qualified carrier, intentionally host-only, optional unsupported, or rejected-required. Retain concise reasons where they matter to delivery/debugging, not full prompts in telemetry.

The delegated user's task is carried as one user message. Applicable task constraints, required host safety rules and selected skills retain their original priority and dependency/resource meaning. User-text concatenation does not preserve a system/developer priority and is not an acceptable replacement when that priority matters. Named AGY agents provide native instruction/tool configuration [S08], but arbitrary per-turn priority injection, isolated temporary agent loading and safe changes during resume are not established. P04 qualifies a supported native carrier; there is no invented `--system-prompt` or arbitrary-path `--agent` contract here. Until qualified, reject a request requiring that carrier **before prompt submission** and name the missing requirement/remediation. This rejection branch is permitted by the reviewed plan; it is not permission to claim support for the rejected workload.

Leave orchestration-only personas, routing, scheduling and nonexistent OpenClaw tool instructions with OpenClaw. Do not blindly copy its whole persona or silently drop required constraints. Treat retrieved source, quoted instructions and native output as data, not delegated authority. Skills requiring unavailable native tools/resources are not equivalent merely because their Markdown was included. No rewrite of user/global instruction files, persistent permission changes, ambient plugin installation or bridge installation is part of projection. Preserve AGY's native delegated engine; using `excludeDefaultComponents` to replace it is not assumed.

Host-native policy restrictions must be enforced before launch or through an actually qualified prevention mechanism. Post-action observation cannot enforce a before-tool policy. Unsupported exact tool restrictions, approval requirements or isolation constraints reject the request; `dangerouslySkipPermissions` never waives them. P04 records which ordinary delegated workloads remain usable, so blanket rejection cannot masquerade as product acceptance.

### 5.2 Delivery and accounting

Accumulate `text_delta` fragments, including the final DONE fragment, into complete ordered previews; do not replace a full preview with the last delta. t004 maps cumulative preview versus delta callbacks explicitly to the actual host contract. Reconcile the terminal response without appending a duplicated answer. Delivery callbacks are ordered, bounded and generation-fenced under section 3.2. An observation of output and its actual delivery are separate facts.

Keep raw native usage with its documented scope. Streaming-session totals may be cumulative [S07]. Never sum a cumulative total with its per-step components or count cached tokens twice. If a prior comparable counter baseline is unavailable on resume, do not label a conversation total as the current turn's bill. Emit an unknown per-turn value plus supported aggregate metadata. Context occupancy is provided only from qualified occupancy evidence, not aggregate input counts or subtraction guesses. Unknown pricing is not “free”; required structural zero/default values must remain labeled non-pricing assumptions. A13 validates what downstream host consumers actually display and use.

### 5.3 Canonical session binding

Only OpenClaw's existing plugin-owned session metadata persists the binding:

```text
SessionBinding = {schemaVersion, conversationId, exactModelId,
                  scopeKey, nativeAgentDefinitionIdentity?, epoch}
key = {agentId, canonicalStore, sessionId, sessionKey}
```

Fresh means no native resume ID; verified init supplies the binding. Resume requires the exact conversation, model and authority/project scope. Account/command/native-agent changes trigger explicit incompatibility/re-baseline handling, not silent continuation or a new conversation disguised as resume. A malformed or incompatible binding rejects before launch with an explicit reset/migration remedy; no “parse failed, start fresh” fallback. Preserve compatible legacy bindings only through validated, truthful conversion within plugin metadata, tested by A14.

Reset/deletion first advances the host-owned lifecycle generation, revokes old writers/callbacks and cancels/drains the old attempt, then removes the conversation binding. Retain a host generation or plugin-metadata epoch/tombstone sufficient to prevent ABA resurrection; merely deleting the entire epoch and recreating zero is unsafe. No AGY database deletion follows. Writes use a qualified host atomic compare/generation primitive or host-owned serialized mutation. P05 must establish cross-process behavior: an in-memory mutex alone is insufficient. If the public host cannot exclude competing writers, reject unsupported concurrent resume/reset, rather than last-write-wins state loss. Persistence failure after native start retains unsafe/uncertain outcome; it never retries the native turn.

Images remain private, validated, attempt-scoped attachments, not transcript authority. Validate MIME and encoded/decoded size against host media policy, preserve order, pass paths only to a qualified native image-reading route, and keep files until all authorized readers within the supported containment boundary finish. Unknown model modality rejects images rather than assuming vision. Cleanup failure is reported and cannot become “all resources removed”; detached-reader ambiguity is P06. No production agents/configuration are created for tests.

## 6. C04/C05 — inventory and automatic host availability

### 6.1 Acquisition and admission

```text
InventoryResult = Success(InventorySnapshot) | Failure(reason, attemptedAt)
InventorySnapshot = {scopeKey, ownerGeneration, inventoryGeneration,
                     acquiredAtMono, models: Map<exactId, MetadataWithEvidence>}
HostCatalogAdapter = {publicProviderHooks, publicHarnessHooks,
                      hostOwnedCatalogLifecycle, compatibilityDiagnostics}
```

The result names are internal interfaces, not invented SDK return values. Metadata carries certainty/source for modalities, reasoning, limits and pricing. New IDs use only SDK-required conservative structural defaults; never resurrect static native executable rows. An inventory is acquisition truth, not user authorization or proof of inference entitlement.

Use one shared acquisition/projection implementation across lightweight provider discovery, provider/live catalogs, dynamic model admission, harness listing and readiness. In a live host owner, a single inventory service owns one in-flight acquisition per scope. Separate lightweight loader processes have their own explicit execution-owner scope and bounded one-shot acquisition; do not claim that independent process caches form a global singleton or introduce IPC/storage machinery merely to share them. Each public host hook supplies an owner scope; a different host process/generation may create a fresh owner and cache without ANTIGRAVITY controlling that lifecycle.

Timeout, auth denial, malformed JSON, conflicting duplicate IDs or cap excess are Failure. A successfully parsed empty inventory is Success and replaces the previous live rows. Conflicting duplicates fail; do not choose a random row. Failed acquisition may retain clearly stale display data only under the supported host catalog outcome contract. It does not renew readiness. Withdrawn live models remain unavailable to execution even when a deliberate manual host entry remains visible.

Native attempt admission performs fresh bounded discovery in its exact current scope, sharing only a concurrently in-flight equivalent acquisition; it does not trust a display cache. Positive cached readiness expires after 60 seconds even during failures. Known credential/project/config changes fence immediately; silent login changes are observed on the next fresh acquisition and cannot reuse cached positive readiness indefinitely. No credentials or secret-derived cache keys are persisted. Native acknowledgement still checks execution identity because the account/model can change after discovery.

### 6.2 Host-owned catalog publication

New AGY IDs become available from ANTIGRAVITY through supported OpenClaw provider/catalog hooks. ANTIGRAVITY does not prescribe or execute an OpenClaw CLI refresh, Web UI reload, Gateway lifecycle action, package operation or configuration write. OpenClaw owns when those hooks are invoked and how returned inventory is published to its catalog/picker. There is no plugin timer, automatic polling interval, restart requirement or version-specific host command in this contract.

Qualification therefore separates two facts:

| Surface | Required proof |
| --- | --- |
| Plugin hook behavior | Given A, then A+B, then B/empty/error inventory in one exact owner scope, supported hooks return the exact current rows and preserve failure/withdrawal truth. New opaque IDs require no plugin/config byte changes or static table update. |
| Production host observation | On the already-running current production OpenClaw, read-only observation confirms the plugin registers through supported public contracts and that ordinary host use can consume the provider/model rows OpenClaw has published. No ANTIGRAVITY qualification step changes OpenClaw lifecycle or configuration to force publication. |
| Policy | Host policy remains final authority; plugin inventory never bypasses exact allowlists, per-agent restrictions, manual rows or host defaults. |
| Re-entry/retirement | Repeated host calls into provider/catalog hooks see current inventory; retired plugin generations cannot publish late results into retired state. |

The plugin supplies current inventory through supported provider/harness hooks; OpenClaw owns rebuilding and publishing its catalog. ANTIGRAVITY does not directly rewrite `models.json`, configuration, defaults, manual model rows or credentials, and does not attempt to drive host catalog lifecycle. Plugin-cache-only success does not establish host visibility, while absence of a plugin-controlled publication API is not a defect: the public contract is to return correct inventory whenever the host invokes the supported hooks.

Host policy performs final filtering using its own precedence for unrestricted/provider-wide policy, exact allowlists, per-agent replacement, legacy restrictions, manual entries and `models.mode: replace`. The plugin must not duplicate a guessed precedence order or weaken restrictions. A provider wildcard is an optional one-time policy choice, not a per-model configuration requirement. New IDs do not change plugin/config bytes, model defaults or user restrictions.

Catalog hooks must not recursively request a host rebuild or wait on a host lifecycle action that invoked them. Equivalent in-flight acquisitions may coalesce; separate scopes remain separate. Plugin retirement advances plugin-owned generations and aborts applicable work so late plugin results cannot repopulate retired caches or alter settled attempts. Host publication timing/state remains OpenClaw-owned. An acquisition timeout is not success or proof of cancellation, and real discovery errors are never converted to successful empty inventory.

P01 remains a required **runtime qualification** of the plugin's supported hook behavior plus read-only current-host visibility, including successful empty/withdrawn inventory, errors, user policy and hook re-entry/retirement. t004 provides the adapter/fixtures, t005 the shared inventory hooks, and t007 records current production-host observations without changing OpenClaw.

## 7. Support and update contract

| Dimension | Design target | Evidence and release condition |
| --- | --- | --- |
| OpenClaw packaging compatibility | `package.json` declares a known-compatible lower bound with no upper release-family ceiling. | The lower bound prevents claiming older unqualified contracts; newer stable releases remain eligible when required public plugin contracts are present. No historical release pair is a runtime target. |
| OpenClaw build provenance | Exact development SDK/lockfile versions recorded in package/build metadata. | Reproducible compilation/declaration evidence only. The build SDK version is not required to equal the production host version. |
| Production OpenClaw | Current installed production host, observed read-only. | Required public registration/session/catalog contracts must be present. Qualification must not install, downgrade, upgrade, restart, stop, reconfigure, patch or replace OpenClaw to make the plugin pass. |
| AGY minimum qualification target | 1.1.28 | Rationale: known denial/flush and headless timeout/daemon changes [S06]. Earlier JSON availability alone does not qualify a runtime. Exact binaries/capabilities are P02/P03/P06. |
| AGY current documented target | 1.2.2 | Changelog source [S06]; live qualification records the actually observed permitted AGY binary instead of assuming this document stays current. |
| Node, SDK, OS/architecture | Package Node engine contract; exact SDK build provenance; declared OS containment boundary | t006 resolves lock/toolchain, t007 records exact observed binaries/platforms. POSIX group target is not universal Windows/Linux/macOS support. |

There is **no OpenClaw calendar-family support ceiling**. Separate exact development SDK/lockfile pins from runtime capability admission. Do not equate runtime host version to build SDK version and do not reject a newer stable host merely because its release number changed. A newer host is eligible when it satisfies package compatibility metadata and exposes the required public contracts; behavioral qualification is evidence about observed compatibility, not a permanent pin to that version.

Test optional helper present/absent paths, compiled package imports against the exact development SDK, forward-version compatibility fixtures, and errors thrown by present helpers. A missing required harness/session/catalog capability prevents dependent launch with a named diagnostic; no less-safe execution fallback. Prefer focused public SDK subpaths; isolate any unavoidable deprecated public compatibility import. Inspection of internal source can explain a public contract, never authorize importing internals.

A03 qualifies **production-host non-interference and forward-compatible admission**, not an OpenClaw upgrade. The exact ANTIGRAVITY package/config identity remains fixed while qualification observes the already-running current production host read-only. Source fixtures prove newer stable version strings do not fail solely because the release number moved forward when required contracts are present; read-only host evidence proves the current host exposes those contracts. AGY updates follow capability/fixture discipline; no binary/model-list auto-update is part of the plugin.

## 8. Exact sources and evidence boundary

The original design sources were inspected on 2026-09-12; historical catalog-lifecycle sources [S14]–[S19] were inspected for the p02t004 clarification on 2026-09-13. They remain research history only and are not qualification instructions or authority to operate production OpenClaw. Git links are immutable version locators; public web documentation is a dated observation, not a production binary pin. Research is not native runtime evidence. Only the credential-free design checks in the matrix have been executed in p02t001. Each unresolved source-to-runtime claim has a P01–P06 owner and decisive later test.

[S01]: https://github.com/claw0gang/antigravity/blob/bf6ddab1222ac5b93de9f0576c8ff6e0cec5c17c/src/harness/run-attempt.ts
[S02]: https://github.com/openclaw/openclaw/blob/8bec206f3c1f787e1e9c45cfd34d3de2a78c7b8e/src/plugin-sdk/agent-harness-runtime.ts
[S03]: https://github.com/openclaw/openclaw/blob/8bec206f3c1f787e1e9c45cfd34d3de2a78c7b8e/src/agents/harness/host-capability-types.ts
[S04]: https://github.com/openclaw/openclaw/blob/8bec206f3c1f787e1e9c45cfd34d3de2a78c7b8e/src/agents/prepared-model-catalog.ts
[S05]: https://github.com/openclaw/openclaw/blob/945f0a669811ab6ede1b4f66c5a7fd3b5358dde7/src/agents/prepared-model-catalog.ts
[S06]: https://github.com/google-antigravity/antigravity-cli/blob/ba985e6b5de2ac8aa09860a154a102831eb7722b/CHANGELOG.md
[S07]: https://antigravity.google/docs/cli/headless/
[S08]: https://antigravity.google/docs/cli/commands/agents/
[S09]: https://github.com/openclaw/openclaw/blob/8bec206f3c1f787e1e9c45cfd34d3de2a78c7b8e/docs/plugins/sdk-runtime/gateway-and-nodes.md
[S10]: https://github.com/openclaw/openclaw/blob/3928bad9badfcb6c7d140530435e806fb8092190/src/plugin-sdk/agent-runtime.ts
[S11]: https://github.com/openclaw/openclaw/releases/tag/v2026.9.4
[plan]: https://github.com/claw0gang/antigravity/blob/3c9c8262b09438d77ff94c29463ee142652be1d2/docs/PHASE2.md
[task]: https://github.com/claw0gang/antigravity/blob/b712e3a6ee093cacc9f7b869b282ceb694e2bdd1/.state/phases/p02/tasks/t001/task.md
[baseline]: https://github.com/claw0gang/antigravity/blob/bf6ddab1222ac5b93de9f0576c8ff6e0cec5c17c/docs/ARCHITECTURE.md

[S12]: https://github.com/openclaw/openclaw/blob/8bec206f3c1f787e1e9c45cfd34d3de2a78c7b8e/src/plugin-sdk/agent-runtime.ts
[S13]: https://github.com/claw0gang/antigravity/blob/bf6ddab1222ac5b93de9f0576c8ff6e0cec5c17c/src/config.ts
[S14]: https://github.com/openclaw/openclaw/blob/3928bad9badfcb6c7d140530435e806fb8092190/docs/cli/gateway.md
[S15]: https://github.com/openclaw/openclaw/blob/3928bad9badfcb6c7d140530435e806fb8092190/docs/cli/models.md
[S16]: https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/docs/cli/models.md
[S17]: https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/docs/cli/gateway/restart-and-supervision.md
[S18]: https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/cli/models-cli.ts
[S19]: https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/gateway/server-methods/models-list-result.ts
