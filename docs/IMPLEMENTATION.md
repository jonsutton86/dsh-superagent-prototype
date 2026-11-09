# Article implementation tracker

The active product objective also includes the full [Agentic OS workspace](010-agentic-os.md). Its implementation ledger
preserves these article requirements and adds missions, shared memory, artifacts, personas, schedules, usage and voice.

Target: implement the full article architecture in this fork, retaining DeepSeek Harness. Upstream baseline: `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`. Baseline verification: `pnpm check`, 59 test files / 1,197 tests, typecheck and build passed on Node 25.9.0.

Sources: [DeepSeek's article](https://x.com/deepseekharness/status/2116857257245987236),
[reproduction of the article text](https://threadnavigator.com/thread/2116857257245987236/), and the upstream code at the baseline above.
The article includes both implemented ideas and research directions. Decisions below are this fork's implementation design,
not a claim that the prototype already ships every feature or that the article specifies a production protocol.

| Capability | Existing evidence | Remaining implementation |
| --- | --- | --- |
| Two-level coordination | `src/core/engine.ts`, `src/app/sessions.ts`, `src/executor/dsh.ts` | Separate router execution authority from routing; retain worker-local subagents |
| Event admission and routing | `src/policy.ts`, `src/core/intake.ts`, `src/core/evals.ts`, `src/sources/*` | Extend source scope only where required; retain subscription ownership and handback invariants |
| Context and recall | Existing resources plus `src/workspace/library.ts`: immutable scoped records, provenance and FTS recall | Enforced total recall budgets, transitive freshness, measured retrieval and long-horizon validation |
| Speculative work | Inferred mandates, observe/auto, configurable rules | Durable budgets, expiry and promotion/publication gates |
| Full duplex | Harness job/subagent services, `src/executor/background.ts`, `src/app/delivery.ts`, remote receipts, durable assignment/tool ownership, receipt-only restart recovery and operator cancellation | Broader long-running job, process-failure and cross-host acceptance |
| Compute/state separation | SQLite Store; Harness Session checkpoints and held import; independent ownership authority, endpoint handoff fencing, shared Runtime/pool/provider ownership lifecycle and independently fenced artifact publication | Channel-wide publication integration, clean-host activation and failover qualification |
| Remote environments | Paired local/remote providers, authenticated leased grants, durable revocation, mission/Session binding, endpoint-owned versioned credentials, remote profile and artifact/restart qualification, operator enrollment/reconciliation, generated profiles, managed world pool and exact per-action selection | Managed endpoint/machine launch, remote repository workflows, quotas and cross-host acceptance |
| Watchdog | Existing health and bounded transient executor retry; now `src/supervision/*` | Live-provider and process-level acceptance, incident UI/alerts, retention, richer progress evidence and separately authorized recovery policies |
| Delivery | Reports and PR binding/closure; content-addressed artifacts, stale mission-review invalidation and operator-approved GitHub comment delivery with independent receipts | Host-collected check evidence, Git/environment revision binding, Feishu/channel/repository integration and automatic mandate-bound delivery |
| Operator control | Existing web panel, settings, pause/retry/stop and local/remote environment status and revocation, endpoint enrollment/reconciliation and private profile generation | Supervision, budgets and evidence surfaces |

No new runtime, orchestration database, or workflow framework is assumed. Work is implemented in integrated slices and not declared complete until acceptance evidence exists. Local deterministic tests do not establish live-provider or cross-platform acceptance.

## Implemented increment: artifact publication

[026 Artifact publication](026-artifact-publication.md) adds a dedicated Harness publication service with private account
credentials, pinned destinations, final ownership checks and a durable journal. The Runtime and library UI bind review to
exact artifact content and destination hashes. Lost acknowledgements preserve the original request ID; an unknown provider
outcome blocks owner handoff until observation or independent administrator reconciliation. Checkpoints include control
credential file dependencies without copying their contents. The restore hold remains in place.

This path covers operator-approved text artifacts as GitHub issue/PR top-level comments. Source Outbox integration,
Feishu, review-thread replies, git/PR mutations, automatic mandate-bound delivery, host-collected verification evidence
and clean-host activation/failover remain open. The full article and product scope is unchanged.

Local qualification on 2026-11-08: 1,418 tests, typechecking and all four builds passed. Both owned installed-Harness
DeepSeek Flash scenarios also passed, including independent publication plugin loading and restart. Exact code revision
`fd058c95ad6046751fd0429a6046c1bb1e151316` passed 1,420 native Linux tests, typechecking and all four builds in
[run 42540908750](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42540908750).

## Implemented increment: Runtime ownership

[025 Runtime ownership](025-runtime-ownership.md) binds coordinator startup, dedicated providers, managed worlds,
endpoint administration and Session/tool admission to the same independent lease. Loss stops dispatch and background work;
separate-state competing coordinators cannot execute concurrently. Existing profiles remain compatible. Owned general
missions require matching remote endpoints; external account publication requires its own fenced integration. Staged
restore remains held before acquisition. Publication, clean-host activation/failover and the full product ledger stay open.

Verification: code `ba17edd5fe09d9276b8d27168188f7f6d9b83abe` passed 1,406 local tests, typechecking and all builds,
all four installed-Harness model scenarios, and 1,408 native Linux tests in
[run 42537715231](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42537715231).

## Implemented increment: ownership authority and endpoint fencing

[024 Ownership and resource fencing](024-ownership-fencing.md) adds an independent Harness authority, process-instance
leases, all-resource preparation and endpoint cancellation/reconciliation before handoff. Paired worlds retain their grant
identity and original effect generations. Code `7e2a33cc4ff662188eee52417056900b4c21e0c4` passed 1,400 local tests,
both installed-Harness cases, and 1,402 tests with native confinement enabled in
[Linux run 42535557440](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42535557440).
The live authority process restart/handoff was qualified separately from model missions in that increment. Runtime/pool
integration follows above; publication, restored activation and clean-host failover remain open. The staged hold is retained.

## Implemented increment: managed execution worlds

[022 Managed worlds](022-managed-worlds.md) adds independently activated remote worlds under one personal/local coordinator,
exact per-action environment selection, paired Harness preset scopes and world-specific lifecycle and execution receipts.
The coordinator preserves its own providers; an unavailable world cannot fall back to another world or local execution.
Revocation closes only the selected world's admission and keeps original-ID recovery and receipt inspection across restart.
The increment retains DeepSeek Harness and the existing Engine, Store and remote endpoint. Managed machine launch, remote
repository workflows, distributed state ownership/failover, quotas and full product acceptance remain open.

Code commit `cecfde32924209bca220bcf01fd9ac3b28aedabd` passed 1,376 local tests, typechecking and all four builds on
2026-11-08. Both opt-in Harness/DeepSeek Flash cases passed separately: dedicated profile plus managed worlds with
concurrent artifact publication, child-owned effects, independent revocation, revoked receipt recovery and resumed work
after coordinator restart. The same commit passed
[Linux run 42528377954](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42528377954) with 1,378 tests,
typechecking, all four builds and all three native confinement cases. Cross-host deployment and distributed ownership remain open.

## Implemented increment: versioned execution personas

[021 Personas](021-personas.md) adds operator-managed immutable instructions, model preferences, optional tool capabilities
and embedded skills. Mission actions and reviewed plan proposals select exact versions; execution snapshots and resumed
worker descendants retain those versions after later edits or archival. Persona updates do not grant additional environment
authority. The panel supports creation, editing, exact historical reads, restoration as a new version, archival and per-action
selection. The subsequent managed-world increment supplies the registry and paired provider scopes for exact per-action
environment selection; persona policy still does not replace execution-world authority.

Qualification on 2026-11-08: 1,366 local tests, 1,368 Linux tests, typechecking and all four builds passed. Exact code commit
`2610c3e69b3f0b0776c484ec2a133ba4cc2d7674` passed
[Linux run 42524823550](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42524823550), including all three
native confinement cases. The configured DeepSeek Flash/Harness test separately proved persona skill loading, owned remote
execution, artifact publication and unchanged persona/world snapshots after edit/archive and coordinator restart.

## Implemented increment: independent supervision

The code now includes the authenticated observation/recovery API, independently persisted incidents and delivery reservations,
separate Harness watchdog plugin and profile, restricted assessment tools, local operator status and regression tests.
[009 Independent supervision](009-supervision.md) describes deployment, authority, limits and verification boundaries.
This increment is code and tested integration, not an enabled live deployment or completion of the entire article.

Verification on 2026-11-06: `pnpm check` passes typechecking, 62 test files / 1,221 tests (24 added tests), and all bundle
builds, including the separately exported `dsh-superagent/watchdog`. The built entry's import and default/custom model
configuration were also checked directly in Node. A DeepSeek Harness CLI/provider deployment was not available in this
checkout environment, so no live-provider or unattended production acceptance is claimed.

## Target architecture

The [remote transport increment](016-remote-execution.md) adds a separately exported authenticated endpoint, durable command
and file-effect receipts, leased grants, output cursors and paired Harness filesystem/process providers. File RPC and commands
use the same Linux bubblewrap boundary in production. Real local Harness providers exercise the HTTP and recovery tests;
the full suite also passed with native Linux confinement and detached-child cancellation enabled in CI. Remote mission
selection, operator endpoint enrollment/reconciliation and coordinator ownership remain open.
This is an execution foundation, not completion of the distributed architecture.

The remote provider now also persists its exact authority binding and local revocation intent. A changed credential cannot
silently transfer new authority across a restart. Self-revocation needs only the current grant, replays the same request after
disconnects, and reports endpoint acknowledgement separately from process/file quiescence. The
[remote mission increment](017-remote-missions.md) now composes a dedicated whole Harness profile and binds missions, worker
Sessions and children to that exact authority. Remote directory preparation, bounded endpoint searches, typed router tools
and operator revocation are integrated. Actual Harness with the configured DeepSeek Flash provider has created/published a
remote artifact and preserved authority and request idempotency through restart. This local composition test uses a test-only
endpoint on macOS; native confinement and cross-host deployment remain distinct qualification boundaries.

Remote mission verification on 2026-11-08: local `pnpm check` passed 1,326 tests, typechecking and all builds; the real Harness
Flash artifact/restart qualification passed separately. Commit `d8223312706205e2f9cfa352b975cc603b1ab75a` passed
[Linux run 42515787855](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42515787855) with 1,327 tests,
including native mission dispatch and filesystem/process confinement. The full product goal remains open; the next remote
work includes operator enrollment/reconciliation before per-action multi-environment dispatch.

The [execution ownership increment](018-execution-ownership.md) records trusted mission/assignment/Session/tool ownership
before command or file-effect dispatch, compares endpoint fingerprints, and recovers by observing original receipt IDs.
Unresolved and recovered running effects block new work without blindly replaying it. The Environments and task views
expose paginated metadata, read-only observation and same-ID command cancellation while keeping outcome and quiescence
separate. On 2026-11-08, local `pnpm check` passed 1,336 tests, typechecking and all builds. The configured-model qualification
verified ownership through an actual Harness restart on the final build. Code commit
`5ca3cbce579c0a96208ec1276eedefefb2cc11e6` passed
[Linux run 42517702121](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42517702121) with 1,337 tests,
typechecking and all builds, including native confinement, child/tool ownership, receipt APIs and command cancellation.
The full architecture remains in progress; operator enrollment/reconciliation is integrated in the subsequent administration increment.

The [endpoint credential increment](019-endpoint-credentials.md) adds administrator-only private-file import, immutable
credential versions, explicit grant bindings, revocation/rotation fencing and command cancellation. Read-only credential
mounts and a confined POSIX launcher keep injected values out of provider arguments and receipt metadata. The coordinator
displays binding metadata; credentials remain an explicit capability available to code under that grant. The configured-model
Harness qualification has used a synthetic bound credential, produced an artifact and preserved the world through restart.
Endpoint enrollment UI is integrated in the subsequent administration increment. Per-action environment/persona selection and the remaining article/product requirements stay open.

Credential verification on 2026-11-08: local `pnpm check` passed 1,345 tests, typechecking and all builds, followed by a passing
configured-model Harness credential/artifact/restart qualification on the final build. Code commit
`18b2dc8c1f0409c5c6266daf35638590f1ea1a99` passed
[Linux run 42519570124](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42519570124) with 1,347 tests,
typechecking and all four builds. The native credential case exercised read-only mounts and cancellation on revocation.

The [endpoint administration increment](020-endpoint-administration.md) adds pinned private-file administrator registration,
metadata catalogs, durable operator request IDs, explicit retry/reconciliation, grant and credential forms, generation-safe
grant credential publication and complete dedicated Harness profile generation. Lost-response replays cannot adopt later
authority. The opt-in model qualification consumes the generated overlay without modifying it. Managed launch and per-action
world/persona selection follow; the full article/product scope remains open. Local `pnpm check` passed 1,356 tests across
79 files, typechecking and all four builds on 2026-11-08; the generated-profile configured-model qualification passed
separately with credential use, artifact publication, execution attribution and coordinator restart. Code commit
`0c07ac80126d4aa9c0fbefd5047fcc96742eda37` passed
[Linux run 42522276793](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42522276793) with 1,358 tests,
typechecking and all builds, including all three native confinement cases and the large-catalog regression.

The [environment enrollment increment](015-execution-environments.md) implements local root proof, immutable task grant
bindings, revocation, reauthorization, replacement and operator controls. Its generation is local authorization state;
remote endpoint grants and their leases are integrated in the subsequent remote increments; coordinator ownership is still separate.

The [mission planning increment](014-mission-plans.md) adds editable immutable versions, scoped worker proposals, explicit
operator approval, history restoration and transitive result invalidation. Planning uses existing Harness workers and
Engine dispatch; candidate plans never authorize their own execution.

The [Inbox increment](013-inbox.md) adds durable read state, Harness conversation projections, atomic task creation and
idempotent steering through existing mission authorization. Result follow-ups preserve the original mandate, explicit
human stops remain holds, and pending follow-ups prevent acceptance of an outdated result.

The [local execution increment](012-local-execution.md) removes mandatory GitHub setup for general missions, retaining
the same Engine/Harness dispatch and durable results. A real isolated Harness process has passed startup and persisted
mission/artifact state across a restart. With the operator's configured DeepSeek provider, one live Flash mission created
a local JSON file, published it, entered review and completed after independent content/hash checking. Remote enrollment,
OS isolation, broader provider qualification and the remaining article work below are still required.

The [durable library increment](011-library.md) implements worker publication, scoped memory/artifact search, immutable
provenance and the operator library. These are candidate results: host-verified task success and external delivery remain
separate requirements. The library's limits and local process trust boundary are explicit in that document.

The Agentic OS mission workspace increment is implemented and verified in `010-agentic-os.md`. It adds a local operator
source and persistent goals over this same Engine/Harness path; it does not replace the remaining article work below.

```mermaid
flowchart TB
  Channels[GitHub, chat and additional Source adapters] --> Admission[Deterministic gates and semantic admission]
  Admission --> Router[Lightweight Harness router]
  Router --> Engine[Existing Engine, policy, Tickets, subscriptions and durable effects]
  Engine --> State[(Orchestrator state and ownership epoch)]
  Engine --> Workers[Harness worker Sessions and worker-local teams]
  Workers --> Sessions[(Harness Session persistence)]
  Workers --> Environments[Environment providers: subprocess plus matching filesystem]
  Environments --> Local[Local execution]
  Environments --> Remote[Enrolled endpoint daemon and local grants]
  Workers --> Evidence[Artifacts and revision-bound verification evidence]
  Evidence --> Recall[Provenance-linked recall and bounded context retrieval]
  Recall --> Router
  Evidence --> Delivery[Policy-gated channel delivery and publication receipts]
  Delivery --> Channels
  Watchdog[Independent Harness watchdog] --> Engine
  Watchdog --> Incidents[(Independent incident journal)]
  Operator[Work, environment, evidence and supervision views] --> Engine
  Operator --> Watchdog
```

DeepSeek Harness remains responsible for inference, tools, Sessions, compaction, async jobs, subagents, provider selection
and cancellation. The existing Engine remains responsible for authorization, work ownership, routing, follow-up handling,
subscriptions and state transitions. SQLite remains the initial durable store. A separate database framework or workflow
engine is not a prerequisite. State ownership stays single-writer until a measured requirement justifies a different backend.

The final design separates three concerns: agent compute, durable task/Session state, and the filesystem/process environment
where tools act. The current same-host implementation is one deployment of those responsibilities. Remote execution must
replace **both** Harness's subprocess and filesystem world consistently; changing the shell transport alone is insufficient.
Profiles or host scopes bound to an environment provide an initial isolation boundary while preserving the Harness loop.

## Implementation sequence and acceptance

### 1. Supervision and operational visibility — implemented foundation

Current code provides independent observations, semantic assessments and one fenced progress request per assignment.
Complete deployment acceptance with a configured provider, main-process kill/restart, watchdog-process restart, disconnected
transport and a deliberately long but productive job. Add incident UI, explicit operator acknowledgement, retention and
alert routing before calling the operational experience complete. Process restarts or task retries require their own narrow,
audited recovery policies; they must not be inferred from arbitrary worker text.

### 2. Compute/state/environment contracts and remote execution — whole-profile mission integration implemented

Introduce an environment registry in the existing state store. Each environment has a stable ID, endpoint identity,
capabilities, availability, grant revision and lease epoch. Bind a ticket's execution to that environment and grant revision.
Keep the existing local path as the first provider. Add a remote Harness provider paired with its filesystem implementation;
do not replace `DshExecutor` with another inference framework.

The endpoint protocol needs authenticated enrollment and revocation, scoped workspaces, allowed operations, environment-local
credentials, process IDs, durable command IDs, lease epochs, output cursors and completion receipts. Distinguish `accepted`,
`started`, `settled` and `unknown` outcomes. Reconnect reconciles receipts and streams missing output; it must never rerun a
command merely because its acknowledgement was lost. A queued operation revalidates its grant after offline reconnection.
Keep the agent's state and credentials outside the endpoint unless an operation explicitly requires them.

Implemented transport details and exercised versus outstanding acceptance are recorded in `016-remote-execution.md`.
Whole-profile remote dispatch is integrated into the existing registry and `DshExecutor`, with immutable task and Session
world bindings. `017-remote-missions.md` records the profile, real-model qualification and explicit scope. Next, add per-action
environment selection and endpoint enrollment/reconciliation. Endpoint credential bindings are integrated in
`019-endpoint-credentials.md`. Durable command-to-assignment
receipts and operator observation/cancellation are integrated in `018-execution-ownership.md`. Run
`pnpm test:remote-linux` on the intended Linux runtime before deployment claims.

Acceptance: remote shell and file operations see the same workspace; disconnect during execution does not duplicate an
effect; revoke a grant while offline; reconnect with an obsolete lease; cancel descendants; read output without gaps or
duplicates; enforce workspace/symlink boundaries; show unknown outcomes for operator reconciliation.

### 3. Durable restore and state ownership — staged import and endpoint ownership implemented

Use Harness's Session-persistence abstraction alongside the existing orchestration store. Define a consistent checkpoint
manifest covering task state, Session offsets, environment leases and artifact references. A restored coordinator acquires
exclusive ownership before resuming effects. A stale coordinator cannot issue environment or publication commands under its
old epoch. Avoid shared-network SQLite as a substitute for an ownership protocol.

Implemented: `023-checkpoint-recovery.md` defines encrypted offline capture of the Store, logical Harness Sessions and world
journals, full verification, execution-fenced staging and retryable Session import. It does not grant execution ownership.
`024-ownership-fencing.md` adds an independent ownership authority, conservative process leases, all-resource handoff and
real endpoint enforcement, preserving world identities and original effect generations across handoff. The authority is a
single writer, not a replicated consensus service. `025-runtime-ownership.md` connects the Runtime and managed/dedicated
provider lifecycle to that authority. `026-artifact-publication.md` adds independently fenced artifact delivery. Next:
complete channel-wide publication and reconcile original effects before activating a restored coordinator. The maintenance
hold stays in place. Keep clean-host recovery and failover open until that complete path is qualified.

Acceptance: crash after every enqueue/dispatch/receipt boundary; recover a consistent task/Session pair; reject two active
writers; resume pending input once; reconcile already-started work; restore from a documented backup on a clean host.

### 4. Chain of Recall and long-term knowledge

Extend the existing resource interface with immutable context capsules and typed provenance edges: `derived_from`,
`supersedes`, `supports`, `contradicts` and `references`. A capsule includes owner/scope, source IDs and revisions, timestamps,
content hash, retention policy and trust classification. Inline small context; spill large context behind stable resource
references. Retrieval returns bounded text with source links, freshness and access decisions. Start with SQLite metadata
and full-text retrieval; embeddings are an optional measured improvement rather than an architectural dependency.

Workers can submit candidate knowledge with evidence. A model summary never creates authority, overwrites a source, or
widens who may retrieve it. Conflicts and stale knowledge remain visible. Recall budgets bound graph depth, pages, time
and returned context. Cross-agent sharing uses the same scope and provenance checks.

Acceptance: recall across Session compaction and restart; recover a fact through its reference chain; reject inaccessible
nodes; invalidate stale evidence; preserve contradictory sources; resist instructions embedded in retrieved content; compare
retrieval quality on real work, not only the article's synthetic scheduling experiment.

### 5. Speculative work with measurable budgets

Add an explicit speculative lifecycle on top of inferred mandates: proposal, admitted background preparation, evidence-ready,
promoted, expired or cancelled. Allocate per-owner/provider/environment concurrency, time and usage budgets durably before
starting work. Speculation consumes spare capacity and yields to explicit work. Promotion rechecks current authorization;
external publication uses a separate gate. Cancellation releases reservations only after execution quiesces or its outcome
has been reconciled.

Acceptance: competing admissions cannot overspend the same reservation; explicit work can preempt speculation; expired
work cannot publish; a restart preserves spent usage and active reservations; promotion keeps provenance and does not
repeat completed work. Provider usage reporting and enforceable limits must be distinguished from approximate cost estimates.

### 6. Verified artifacts and delivery

Persist artifacts and verification results bound to exact source/workspace revisions: commit/tree IDs, content hashes,
command or check identities, exit outcomes and timestamps. Verification evidence is collected by host integrations;
model assertions alone do not satisfy it. Publication binds the approved artifact revision to its destination and receipt.
After an ambiguous external response, query the destination before retrying publication.

Acceptance: a subsequent edit invalidates prior checks; stale branch evidence cannot approve a new PR head; duplicate
delivery requests do not publish twice; failed/unknown effects remain recoverable; each user-visible result links its actual
artifact and relevant evidence. Keep existing GitHub follow-up/PR ownership and handback invariants.

### 7. Router authority and operator experience

Replace the router's remaining broad shell reads with typed, bounded Source/resource operations before removing those
tools. Keep semantic batching, subscriptions, selective pass-through, many-to-many ownership and worker-local teams. Add
task-centered views for timeline, artifacts, evidence, environments, budgets and incidents while retaining the working panel.
User steering remains asynchronous and reaches workers at safe inference boundaries. Channel adapters tailor the length and
form of replies while decisions and authority remain centralized in the Engine.

Acceptance: the router cannot execute an assigned task or modify files; all prior admission/routing tests pass; users can
inspect, steer, pause, cancel and review outcomes without navigating internal Session IDs; permissions and unknown remote
outcomes are visible at the point of action.

### 8. Whole-system qualification

Run repeatable workload evaluations covering real coding tasks, event bursts, concurrent subscriptions, long-running tools,
context growth, provider outages, prompt injection, revoked access, corrupted/partial receipts and process/host failure.
Record task quality, latency, user interruptions, wasted speculative work, inference usage, recovery time and duplicate
external effects. Document supported OS/environment combinations, backup/restore, upgrades and credential rotation.
Declare complete only when each capability above has executable evidence and a supported operator path. Cross-organization
agent communication remains explicitly scoped work with its own identity/delegation contract; it is not silently assumed
from the article's open research discussion.
