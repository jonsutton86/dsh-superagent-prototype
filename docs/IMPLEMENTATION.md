# Article implementation tracker

[071 Managed SSH transport](071-managed-ssh-transport.md) adds a separate coordinator-side launcher role with a pinned
host key, dedicated identity, loopback forward, exact endpoint/resource readiness, private enrollment and existing bounded
supervision/service controls. Local native OpenSSH forwarding, host-key rejection, reconnect and macOS service tests pass
against a synthetic HTTP endpoint. The Linux installed-Harness qualification now routes through SSH and checks the
original job after interruption, but remains pending. Cloud/fleet bootstrap, credential transfer/rotation, reverse ownership
transport, physical cross-host/reboot acceptance, disk quotas and the remaining architecture remain open.
Local `pnpm check` passed typechecking, seven builds and 2,039 tests (25 skipped; 129.37 seconds). The combined native
macOS service / pinned Harness / SSH run passed 16 tests (one skipped; 21.72 seconds). The existing app remained ready
and unpaused, and all temporary native services and SSH fixtures were removed.
Runtime/test revision `219d3ae22c553902033e9f13c418099a2f751fd1` is pushed. GitHub returned no workflow runs for the exact
SHA and again rejected explicit dispatch with HTTP 422 (Actions disabled); native Linux acceptance remains pending.

[070 Delegated endpoint service](070-delegated-endpoint-service.md) adds service-budget initialization, pinned user-unit
topology, automatic control/worker subgroups and supervisor-mediated durable Start/Restart. Stop cancels pending startup;
failed/cancelled receipts retain a startup fence through interrupted hold/stop writes. Removal requires kernel drainage.
Local control tests use a simulated kernel; the new native Linux user-manager/Harness qualification is still pending.
Privileged user-manager delegation, actual Linux/boot acceptance, policy migration, cloud/fleet/transport and the remaining
architecture remain open. Existing native macOS service and pinned Harness lifecycle drills passed during this increment.
Final local `pnpm check` passed typechecking, seven builds and 2,032 tests (24 skipped; 129.04 seconds). The combined
control/native macOS service run passed 18 tests (two skipped; 21.56 seconds), and the existing app stayed ready and
unpaused. Stop records a unique durable marker before cancelling auxiliary requests, so a corrupt request cannot prevent
graceful Stop and restoration of an older pending request cannot override a newer stop.
Runtime/test revision `020c6b988e5deb13837deb6074f41da391d96ded` is pushed. GitHub returned no runs for the exact SHA;
explicit workflow dispatch again returned HTTP 422 (Actions disabled). Native Linux acceptance remains pending.

[069 Execution resources](069-execution-resources.md) adds configured Linux cgroup v2 pool/process-tree limits for CPU,
memory/swap and processes/threads, trusted pre-exec entry, whole-tree cancellation and kernel population checks. The endpoint
pins its policy across restart and refuses premature reconciliation. Command/mutation usage receipts reach the operator
UI; launcher health verifies the configured boundary. Focused local integration passed 32 tests with three native/platform
cases skipped. Native kernel qualification is pending; explicit simulated-kernel tests are not Linux enforcement evidence.
Final local `pnpm check` passed TypeScript, seven builds and 2,022 tests (23 skipped; 128.63 seconds). The existing app
remained ready and unpaused. Invalid resource configuration also cannot persist a new ownership binding.
Runtime revision `bb5f3c0d2af61038f5a671dbbaa39371972d51ba` is pushed. GitHub returned no workflow runs for the exact SHA,
and explicit dispatch again returned HTTP 422 (Actions disabled); native acceptance remains pending.
Disk quotas, per-workspace aggregate allocation, automatic service delegation, cloud fleet/transport, supported policy
migration and cross-host recovery remain open.

[068 Service supervision](068-service-supervision.md) adds a foreground supervisor, persistent automatic-start budget and
manual-stop/hold semantics, plus owned per-user launchd/systemd installation, status and removal. It preserves live
unhealthy processes and graceful-stop timeouts rather than forcing a restart. Actual macOS service-manager and pinned-Harness
drills passed, including executor-pause persistence through removal/reinstallation; eight focused checks passed in 22.32
seconds. The existing user app stayed running. Local `pnpm check` passed typechecking, six builds and 2,011 tests
(22 skipped; 145.74 seconds). Linux user-manager/boot qualification,
actual logout/reboot/power-loss acceptance, cross-host deployment, supervised upgrades and packaging remain open.
Runtime revision `017f880a00b7176ad71a6f4bd7917c25b4e3784c` is pushed. GitHub again refused native workflow dispatch
with HTTP 422 (Actions disabled), despite its repository permissions endpoint reporting enabled; the cause is unresolved.

[067 Managed endpoint launch](067-managed-endpoint-launch.md) adds a Linux endpoint role to the persistent launcher:
pinned Harness installation, separated control/workspace directories, native confinement readiness, persisted endpoint and
credential fingerprints, private enrollment metadata and graceful lifecycle control. Existing ownership bindings and
bounded command/output configuration are supported; credentials are never printed. A new native qualification starts
real endpoint and coordinator profiles, enrolls a managed world and checks confined execution and restart receipts.
Local focused checks passed 25 tests with three platform/installed-Harness cases skipped; typechecking passed.
Local `pnpm check` passed typechecking, six builds and 2,005 tests (19 skipped; 136.55 seconds). Native installed-Harness
validation is pending: GitHub reports no checks for runtime revision `8de414a1465ff1cdb38d2d9e9beaed6e16c5e1b8`, and
explicit workflow dispatch returned HTTP 422 because repository Actions is disabled. Earlier Linux runs do not cover
this launcher. Cloud-machine/fleet provisioning, managed network
transport, resource quotas, cross-host recovery and the remaining full architecture stay open.

Browser startup repair: the user observed a real Harness plugin-load failure because persona/reflection schemas imported
the host Policy, which transitively pulled process execution into the browser bundle. Model selection now lives in a pure
shared contract and Zod is bundled explicitly. A regression check builds the production client in a temporary directory
and executes its actual factory with only the three declared React modules available. Focused validation passed 342 tests
and typechecking; the running authenticated app serves the exact repaired bundle, which loads in that constrained factory
check. Earlier served-bundle retrieval alone did not establish successful plugin activation. Existing immutable browser
resource caching requires a hard refresh after this live development rebuild. Local `pnpm check` passed typechecking,
all six builds and 2,004 tests (16 skipped; 129.91 seconds). Exact repair revision
`e889f97871d1cab9ce8f8df8d348ccad03b954dd` passed native Linux / Node 24 typechecking, six builds and 2,012 tests
(10 skipped; 293.71 seconds) in [run 42725936622](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42725936622).
The operator confirmed that the app opens after refresh. That proves startup for the observed installation; complete
browser journeys, layout, microphone behavior and accessibility still need acceptance. On macOS, the cache-bypassing refresh
is Option-Command-R in Safari and Shift-Command-R in Chrome; the running user app was not restarted.

[066 Persistent launcher](066-persistent-launcher.md) adds a private macOS/Linux source-checkout installation with pinned
Harness, resumable profile setup, persistent coordinator/Session/attachment paths, detached start and graceful stop/restart,
current-process ownership, serialized control, intentional-stop markers and authenticated browser shortcuts without token
output. It preserves existing profile credentials and does not adopt or migrate an unrelated running installation.
Process-level launcher/control checks passed 24 tests. A fresh installed-Harness profile passed initialization, duplicate
start, authenticated access, graceful restart with persisted pause and intentional-stop handling. The existing user app
remained running. Local `pnpm check` passed typechecking, six builds and 2,003 tests (16 skipped; 133.16 seconds).
Revision `8a8da447eda816ee530e8c1453a72d9915e31f40` passed native Linux / Node 24 typechecking, six builds and 2,011 tests
(10 skipped; 270.24 seconds) in [run 42724896883](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42724896883).
Login/boot services, supervised upgrades, desktop packaging and the remaining full architecture stay open.

[065 Guided setup](065-guided-setup.md) adds model and environment guidance, private Harness provider-setup instructions,
optional persona/budget/context navigation, empty inbox draft entry and current mission review status. The guide reads
existing authorities and does not equate catalog presence with inference success or create work while navigating.
Local typechecking, six builds and 1,994 tests passed (16 skipped; 135.12 seconds); 36 focused checks passed. Exact
runtime/test revision `bfebde2ec8fbb85e47f3a1529db142fef36cb43e` passed native Linux / Node 24 typechecking, six builds
and 2,002 tests (10 skipped; 311.70 seconds) in [run 42719686052](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42719686052).
The running installed Harness serves the new client bundle. After private provider setup its catalog advertised DeepSeek
without lookup failures, and the installed-Harness / DeepSeek Flash inbox/attachment/restart/recovery drill passed in
285.90 seconds on that runtime build. Visual browser acceptance and the remaining full architecture stay open.

[064 Inbox execution settings](064-inbox-execution-settings.md) adds reviewed persona versions and default/managed
environment selection to new inbox tasks, exact default-grant preconditions and captured execution details. Ambiguous Send
retries retain their original request even after persona archival or environment revocation. Execution continues through
the existing Workspace, Engine and DeepSeek Harness. Local typechecking, six builds and 1,988 tests passed (16 skipped;
130.32 seconds). Exact runtime/test revision `432f4aeeca76177f32a2944932db48899a8d77db` passed native Linux / Node 24
typechecking, six builds and 1,996 tests (10 skipped; 244.42 seconds) in
[run 42716861135](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42716861135).
Live owned-managed Harness qualification passed with private DeepSeek setup in 285.90 seconds, including the original
persona proof in the selected world, attachments, checked results, Runtime restart and installed checkpoint recovery.
The runtime build was `bfebde2ec8fbb85e47f3a1529db142fef36cb43e`; the test fixture now handles copied JSON-form profile patches.
The new persistent user app remained running. It does not recover the removed temporary instance's history. Broader
browser/provider acceptance and all remaining full architecture and product requirements below remain open.

[063 Conversation attachments](063-attachments.md) adds resumable file uploads, exact task/reply bindings, native Harness image
projection and verified copies through the existing scoped subprocess service. Source bytes reside in the checkpointed Store.
Revision `ba44a813777991f59a9b8e355dd7827b0dc8f949` passed the installed Harness / DeepSeek Flash input-to-checked-artifact,
restart and installed-recovery drill (one passed, four skipped; 253.21 seconds), and native Linux typechecking, six builds
and 1,989 tests (10 skipped; 284.29 seconds) in [run 42707238123](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42707238123).
Local verification passed 1,981 tests; integration fixes passed 26 focused tests, typechecking/builds and execution of the
actual bundled copy helper. Browser/vision-provider acceptance, attachment retention/GC and the remaining full architecture
and product requirements below remain open. The original app was left running.

[062 Voice](062-voice.md) adds optional local/cloud speech adapters, editable inbox dictation, reply playback,
interruption and durable request/restart handling while preserving DeepSeek Harness execution. Qualification revision
`da21f8fb37f891362f9c900f3aae6a1bd25deb8e` passed the installed Harness speech/inference/restart/recovery drill
(one test, 242.08 seconds) and the complete native Linux suite (1,969 passed, 10 skipped), typechecking and six builds in
[run 42696904836](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42696904836).
The local full suite passed 1,962 tests; subsequent lifecycle hardening passed 106 focused tests including actual
macOS speech, and the final UI check passed seven tests. Real browser/microphone acceptance, cloud speech-provider
qualification, realtime streaming, speech fees and receipt maintenance remain open. This does not complete the full
article/product objective or change the other remaining requirements.

The active product objective also includes the full [Agentic OS workspace](010-agentic-os.md). Its implementation ledger
preserves these article requirements and adds missions, shared memory, artifacts, personas, schedules, usage and voice.

Target: implement the full article architecture in this fork, retaining DeepSeek Harness. Upstream baseline: `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`. Baseline verification: `pnpm check`, 59 test files / 1,197 tests, typecheck and build passed on Node 25.9.0.

Sources: [DeepSeek's article](https://x.com/deepseekharness/status/2116857257245987236),
[reproduction of the article text](https://threadnavigator.com/thread/2116857257245987236/), and the upstream code at the baseline above.
The article includes both implemented ideas and research directions. Decisions below are this fork's implementation design,
not a claim that the prototype already ships every feature or that the article specifies a production protocol.

| Capability | Existing evidence | Remaining implementation |
| --- | --- | --- |
| Two-level coordination | Engine admission/routing; identity-based coordinator tool guards, typed context readers and legacy execution retirement; authorized worker execution and worker-local subagents | Broader worker/provider credential separation, untracked-process isolation and clean-host role-boundary qualification |
| Event admission and routing | `src/policy.ts`, `src/core/intake.ts`, `src/core/evals.ts`, `src/sources/*` | Extend source scope only where required; retain subscription ownership and handback invariants |
| Context and recall | Immutable scoped records, provenance/FTS search, host-enforced cumulative retrieval allowances, bounded chain context/transitive freshness and complete review dependency closure | Measured retrieval and long-horizon validation, external-source freshness/imports, model-token-aware context selection and retention/scaling |
| Speculative work | Inferred mandates, observe/auto and rules; durable owner/provider/environment/workspace allocations, measured model usage, preemption, expiry, quiescence/recovery holds and separate promotion/publication approval | Long-horizon quality/waste measurements, multi-workspace/retention/scaling and stronger confinement |
| Full duplex | Harness job/subagent services, `src/executor/background.ts`, `src/app/delivery.ts`, remote receipts, durable assignment/tool ownership, receipt-only restart recovery and operator cancellation | Broader long-running job, process-failure and cross-host acceptance |
| Compute/state separation | SQLite Store; Harness Session checkpoints, held import, checkpoint-bound claimant replacement, revision-bound receipt audits, authenticated held receipt application, consumed-input proof, core Engine graph reconciliation, built-in cursor/inbound receipts, mission/plan/schedule authority and artifact/check/review/completion evidence verification; authenticated private installation, relocated bindings, Session-prefix-preserving Runtime activation/restart, generated managed/dedicated launch profiles and repeated recovery cycles; ownership authority, endpoint handoff fencing, shared Runtime/pool/provider lifecycle and independently fenced artifact/mission delivery with directed inbound replies | Other product-extension state, broader inbound discovery/admission and repository integration, clean-host and cross-machine failover qualification |
| Remote environments | Paired local/remote providers, authenticated leased grants, durable revocation, mission/Session binding, endpoint-owned versioned credentials, remote profile and artifact/restart qualification, operator enrollment/reconciliation, generated profiles, managed world pool, exact per-action selection, prepared-host endpoint launcher, configured cgroup limits/usage receipts, owned delegated services and pinned managed SSH transport | Native installed-launcher/resource/user-service and Harness-over-SSH qualification, privileged host-user setup, managed machine/fleet provisioning and broader/reverse transport, remote repository workflows, disk quotas, per-workspace aggregate allocation and cross-host acceptance |
| Watchdog | Independent Harness assessor and journal, standalone incident console, evidence-bound operator review/replay, bounded retention and actual-model main/watchdog process-failure recovery | Alert routing, broader diagnosis/productive-job quality, cross-host/process-failure acceptance, richer progress evidence and separately authorized recovery policies |
| Delivery | Reports and PR binding/closure; content-addressed artifacts, stale mission-review invalidation, reviewed artifacts and plan-authorized mission replies with independent receipts; exact participant/task inbound listeners; versioned checks, original assignment/environment bindings, host-captured file/Git snapshots, original-job evidence, selected-check acceptance/publication, explicit-commit PR reviews, plan-bound PR result targets and fresh all-action mission completion | CI/branch-policy and merge integration, continuous freshness, broader inbound discovery/admission, remote Git provisioning and broader speculative quality evaluation |
| Operator control | Existing web panel, settings, pause/retry/stop, scoped usage/limits/prices and reconciliation, local/remote environment status and revocation, endpoint enrollment/reconciliation and private profile generation | Supervision, broader workload budgets and evidence surfaces |

No new runtime, orchestration database, or workflow framework is assumed. Work is implemented in integrated slices and not declared complete until acceptance evidence exists. Local deterministic tests do not establish live-provider or cross-platform acceptance.

## Implemented increment: generated recovery launch profiles

[061 Recovery launch profiles](061-recovery-launch-profile.md) emits the complete managed or dedicated Harness patch from
authenticated installation bindings, with explicit imported JSONL backend and loopback port selection when requested.
Startup checks the exact patch hash; provider credentials stay in the configured base profile. Destination locking and a
single rename avoid an empty target reservation. Qualification launches the generated patch unchanged after retiring
the old coordinator Store, Session files and world journals. Full local verification passed 1,942 tests, typechecking and
all builds; the final compatibility guard passed 23 focused tests and repeated typechecking/builds. Runtime/test revision
`26718d6` passed 1,949 native Linux / Node 24 tests with bubblewrap, typechecking and all builds in
[run 42690711226](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42690711226).
The exact revision passed both installed-Harness / DeepSeek Flash owned-managed and owned-dedicated-restore qualification
in 339.36 seconds combined, including new missions/artifacts and continued-history restart with old state files retired.
The original app remained running.
Cross-machine failover and all remaining complete architecture/product requirements remain open.

## Implemented increment: installed recovery and Runtime handoff

[060 Installed recovery](060-installed-recovery.md) binds the prepared Store, original Session backend, relocated private
credentials and world journals to an authenticated deployment. Startup checks the held state and independent resources,
acquires the recovery lease, and transfers its exclusive Store lock and ownership into the actual Harness Runtime.
Restart permits legitimate Session continuation while retaining the original prefix. Operational bindings also support a
second complete checkpoint/recovery cycle without rewriting historical approvals or commands. Full local verification passed
1,938 tests, typechecking and all builds; the terminal-revocation fix passed 27 focused tests and repeated typechecking/builds.
Revision `a1c22a3` passed installed-Harness / DeepSeek Flash qualification in 203.47 seconds, including a restored mission,
artifact, restart and no completed-revocation replay. The same revision passed 1,945 native Linux / Node 24 tests with
bubblewrap, typechecking and all builds in [run 42688097294](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42688097294).
Cross-machine failover, dedicated-profile live startup and the remaining full
product/architecture requirements remain open.

## Implemented increment: held publication authority

[059 Publication authority recovery](059-publication-authority-recovery.md) links independent outcomes to original artifact
approvals, destination snapshots, selected check/capture evidence, mission delivery grants and exact Outbox subjects. It checks
local authority before applying receipts and requires settled matching outcomes afterward. New requests/destination snapshots
are retained; historical changes and legacy gaps remain explicit. Full local verification passed 1,925 tests, typechecking
and all six builds; the final bounded-review guard passed 22 focused tests and repeated typechecking/builds. Runtime/test
revision `ae4732a` passed 1,932 Linux / Node 24 tests with native confinement, typechecking and all builds in
[run 42681324239](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42681324239).
The exact revision passed installed-Harness / DeepSeek Flash owned-managed recovery in 192.90 seconds with nonempty signed
checked-publication and delivery evidence, no unresolved/legacy publication gaps and original-ID held-image retrieval.
Provider traffic stayed on local contract servers; the original app remained running. Deployment binding/remapping,
restored activation, handoff, clean-host failover and the remaining full product/architecture scope remain open.

## Implemented increment: held context and budget state

[058 Context and budget recovery](058-context-budget-recovery.md) verifies original reflection evidence and read charges,
cumulative recall reservations, model accounting/lineage and speculative holds, policies and approvals. New commands retain
their request bodies and new captures/allocations retain exact timing/policy references; older evidence gaps remain visible.
Pending and unknown work retains its charges. Runtime/test revision `77a7aa0` passed 1,915 local tests and 1,922 Linux /
Node 24 tests with native confinement, typechecking and all six builds. Native evidence is
[run 42677535071](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42677535071).
The exact revision passed installed-Harness / DeepSeek Flash owned-managed recovery in 200.27 seconds with nonempty signed
recall/model/reflection evidence, zero legacy accounting gaps and original-ID held-image retrieval. Live speculative
preparation, separate publication approval and restart without duplicate delivery also passed in 21.43 seconds. Provider
operations stayed on local contract servers or a synthetic sink; the original app remained running. Remaining
publication/registry cross-references, deployment binding/remapping, restored activation, handoff and clean-host failover
stay open under the full architecture objective.

## Implemented increment: held registry authority

[057 Registry authority recovery](057-registry-authority-recovery.md) verifies persona definitions and command history,
environment generations, managed-world journals, original worker snapshots and immutable Session ancestry. Historical
archive/revocation remains historical; missing legacy bindings and opaque command payloads are counted explicitly. Persona
authority is checked before inference. Local verification passed 1,904 tests, typechecking and all six builds; the final
directory-name/bounded-scan regression passed all nine focused registry tests and repeated typechecking/builds. Runtime/test
revision `e1741bf` passed 1,911 Linux / Node 24 tests with native confinement, typechecking and all builds in
[run 42673277799](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42673277799).
The exact revision passed installed-Harness / DeepSeek Flash owned-managed recovery in 194.21 seconds with nonempty signed
persona/version/worker/world history, historical revoked grants, zero legacy task-grant gaps and original-ID image retrieval.
Provider operations stayed on local contract servers and the original app remained running. Remaining product graphs,
registry/publication cross-references, deployment binding/remapping, restored activation and clean-host failover stay open
under the full architecture objective.

## Implemented increment: held artifact and result evidence

[056 Result evidence recovery](056-result-evidence-recovery.md) verifies library bytes/provenance, original host check
requests/receipts, immutable check versions, review captures/seals and mission-completion evidence before signing a held
image. Successful review attempts now retain their original seals across later explicit captures. Reflection-approved plans
use their correct proposal journal. Old, revoked and expired evidence remains historical without renewing authority.
Local verification passed 1,893 tests, typechecking and all six builds, plus 18 focused result/reflection tests after the
final normalization guard. Runtime/test revision `3731d18` passed 1,900 Linux / Node 24 tests with native confinement,
typechecking and all six builds in
[run 42669190774](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42669190774).
The exact revision passed installed-Harness / DeepSeek Flash owned-managed recovery in 206.85 seconds with nonempty signed
artifact/check/review/completion evidence, zero legacy review seals and original-ID image retrieval. Provider operations
stayed on local contract servers; the original app remained running. Other product graphs, deployment binding/remapping,
restored activation and clean-host failover remain open with the full architecture/product scope.

## Implemented increment: held mission and schedule authority

[055 Workspace authority recovery](055-workspace-authority-recovery.md) checks original mission plans, proposal approvals,
action/Trigger revision bindings, human follow-up routing and schedule occurrence/cursor continuity before signing a held
image. New snapshots and Triggers preserve exact host-captured revision stamps; historical records without them remain
explicit legacy evidence. Recovery does not dispatch, approve, reset cursors or remove the hold. Local verification passed
1,884 tests, typechecking and all six builds. Runtime/test revision `4079a49` passed 1,891 Linux / Node 24 tests with native
confinement, typechecking and all builds in
[run 42664952945](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42664952945).
The exact revision passed installed-Harness / DeepSeek Flash owned-managed recovery in 195.68 seconds with nonempty signed
mission/schedule/execution evidence, zero legacy stamps and original-ID image retrieval. Provider operations stayed on
local contract servers; the original app remained running. Other product-extension graphs, deployment binding/remapping,
activation/handoff and clean-host failover remain open with the full architecture/product scope.

## Implemented increment: held connector state verification

[054 Connector state recovery](054-connector-state-recovery.md) checks retained built-in cursor families and owned inbound
listener permissions, pagination and deduplication history before signing a held image. It binds received messages to their
original participants, task, channel and directed Engine input, and detects substituted grants/destinations or missing
receipts. New receipts retain native provider IDs so their message identity and supported content hashes can be checked;
older receipts are reported separately. It never polls, resets a cursor, discards a receipt or activates work. Provider retention and future connectivity
are not inferred from a saved cursor. Local verification passed 1,869 tests, typechecking and all six builds, plus the final
legacy-cursor regression. Runtime/test revision `5383677` passed 1,876 Linux / Node 24 tests with native confinement,
typechecking and all six builds in
[run 42659022305](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42659022305).
The exact revision passed installed-Harness / DeepSeek Flash owned-managed recovery in 207.46 seconds, including native
evidence for all captured inbound messages, original-ID image retrieval and the retained hold. Provider operations stayed
on local contract servers; the original app remained running.
Product-extension authority graphs, deployment binding/remapping, activation/handoff and clean-host failover remain open,
alongside the full architecture/product requirements below.

## Implemented increment: held Engine state reconciliation

[053 Engine state reconciliation](053-engine-state-reconciliation.md) verifies the recorded core authority chain from
triggers through decisions, tickets, assignments, inputs, receipts and queued effects before publishing a prepared recovery
image. It repairs only derived query indexes and removes effects whose existing handlers can no longer act; live queue
metadata and aggregate authority remain unchanged. Directed input cannot move to another ticket, and conflicting mandates
keep preparation held. Historical expired evaluation tags remain metadata, never execution authority. The signed image
records graph counts, repairs and a deterministic digest. Source/staged core records and the execution hold remain unchanged.
Runtime/test revision `2606671` passed 1,860 local tests and 1,867 Linux / Node 24 tests with native confinement,
typechecking and all six builds. Native evidence is
[run 42654443599](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42654443599).
The installed-Harness / DeepSeek Flash owned-managed recovery scenario passed in 203.36 seconds, including a nonempty graph
proof and the original held image on retry. Provider-message traffic stayed on local contract servers; the original app
remained running. Connector cursors, product-extension graphs, deployment remapping, activation/handoff and clean-host
failover remain open, alongside the full product scope below.

## Implemented increment: independent supervision console

[052 Independent supervision console](052-supervision-console.md) adds an independent operator page, incident/evidence
review, durable evidence-bound acknowledgement, paginated history and bounded retention to the existing Harness watchdog.
The page remains available when the main Runtime is down. Acknowledgement never resolves work or suppresses monitoring;
new evidence requires fresh review. Final runtime `59ccd4b` passed 1,837 local tests, typechecking and all six builds. The
same runtime passed 1,844 Linux / Node 24 tests with native confinement, typechecking and all builds in
[run 42647851217](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42647851217).
The final installed-Harness / DeepSeek Flash drill passed in 53.23 seconds, including the actual served console bundle
rendered against real APIs, UI acknowledgement, separate worker/assessor inference, abrupt main/watchdog termination,
durable original receipt recovery and closure after human input. The drill exposed and fixed missing human-answer
incidents; acknowledgement expiry also resists clock rollback after retention. The original app remains running.
Alert routing, broader diagnosis/productive-job evaluation, cross-host and real-browser acceptance, and the remaining
full architecture stay open.

## Implemented increment: coordinator routing authority

[051 Coordinator routing authority](051-router-authority.md) removes the remaining local coordinator shell/file/job surface
and applies an identity-based Harness guard to inherited and late scoped tools. Bounded typed repository reads preserve
routing context. Legacy coordinator turns, jobs and descendants must quiesce before routing resumes; persistent lineage
anchors deny their resumed descendants. Worker execution and worker-local teams retain their existing task authorization.
Corrected runtime revision `249ba5b` passed 1,826 local tests, typechecking and all five builds. The same revision passed
1,833 Linux / Node 24 tests with native confinement, typechecking and all builds in
[run 42642436513](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42642436513).
All three installed-Harness / DeepSeek Flash scenarios passed: dedicated in 73.50 seconds and both owned variants in
315.85 seconds. They verify denial of a late coordinator tool, absence of its canary and successful typed reads before
and after restart while authorized workers complete their existing tasks. The first live run exposed an own-agent idle
wait inside Harness's creation barrier; 051 records the runtime correction and regression. The original app remains
running. This is a model-tool boundary, not an OS sandbox or a claim that every worker/provider credential boundary is
complete. All remaining full architecture requirements stay active.

## Implemented increment: PR-bound results and fresh mission completion

[050 Mission PR targets and fresh completion](050-mission-pull-completion.md) binds operator-inspected PR identities into
approved plans and worker mandates. Acceptance requires checks of the current observed head. Whole-mission completion
freshly captures every accepted checked result in its original world and rereads required PR heads before the final
transaction. Durable completion attempts preserve original per-action review/capture IDs through interruption and restart.
The UI supports binding, head inspection, completion receipts and original-attempt recovery. Runtime revision `4e41442`
passed 1,821 local tests, typechecking and all five builds. Final test revision `b10dcbe` passed 1,828 Linux / Node 24 tests
with native confinement, typechecking and all builds in
[run 42636176258](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42636176258).
All three installed-Harness / DeepSeek Flash scenarios passed across the runtime revision and the test-only native-helper
and accepted-state corrections documented in 050. The original app remains running.
This point-in-time completion decision does not implement remote Git provisioning, branch policy, CI, merging or continuous
freshness. Every remaining full architecture requirement stays active.

## Implemented increment: checked PR review submission

[049 PR review approvals](049-pull-review-approvals.md) adds provider-observed PR identities and head/tree binding to
checked artifact review submission. Captured bytes reconstruct the commit tree; Git status alone is insufficient.
The operator inspects the head and selects matching checks; the independent publisher rereads the target and sends an
explicit-commit review. Historical receipt recovery precedes fresh-source/head gates. Runtime revision `94f41c6` passed
1,806 local tests, typechecking and all five builds; final test revision `ca58691` passed 1,812 Linux / Node 24 tests with
native confinement, typechecking and all builds in [run 42627757241](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42627757241).
All three installed-Harness / DeepSeek Flash scenarios passed across the runtime qualification and test-only recovery
fixture correction `ca58691` described in 049. The original app remains running.
GitHub review submission cannot atomically assert the current head; a concurrent push can leave the
review on the explicitly approved older commit. Mission repository/PR closure, merge policies/receipts, remote Git
provisioning, continuous freshness, fresh whole-mission closure and all other full architecture requirements remain open.

## Implemented increment: checked approval and mission acceptance

[048 Checked approvals](048-checked-approvals.md) binds selected successful host checks and fresh original-source captures
to worker artifact publication and all-current-artifact mission acceptance. Human review remains explicitly labelled.
Publication recovery observes original receipts before considering any new capture or send; the independent publisher
enforces the short freshness window immediately before dispatch. Historical acceptance detects known subsequent source
changes but does not continuously rescan files. Exact PR-head integration, fresh whole-mission closure, continuous source
freshness and every other remaining full architecture requirement remain open. Final runtime/test revision
`77142e7c8a5373fbf59a29f3900449a4e16a8bbb` passed 1,782 local tests, typechecking and all five builds (109.03 seconds).
Linux / Node 24 passed 1,787 tests with native confinement, typechecking and all builds in
[run 42621744787](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42621744787), in 152.84 seconds.
The dedicated installed-Harness / DeepSeek Flash scenario passed in 65.52 seconds; both owned scenarios passed in 306.30
seconds. Qualification includes actual model-authored outputs, check-bound acceptance/publication, lease renewal,
original-receipt restart, schedules/reflection, usage refusal/retry and held recovery. The original app remained running.
Code and qualification receipts are pushed on the feature branch. The full product objective remains active.

## Implemented increment: artifact check definitions and evidence

[047 Artifact checks](047-artifact-checks.md) connects immutable operator definitions, original artifact execution bindings,
worker requests, local/remote Harness jobs and operator evidence controls. Explicit host-process execution is labelled as
unconfined; Linux-required checks refuse unavailable isolation. Freshness captures do not rerun commands or become passes.
This provided the foundation for selected-check/freshness approval in increment 048; exact PR-head binding and
all other remaining full architecture requirements stay open. Code `6685cb6fea83401b3489392bd83fd40fa7d1ce8b` passed 1,768 local
tests, typechecking and all five builds. The installed-Harness / DeepSeek Flash dedicated scenario passed in 58.27 seconds,
with an actual model-created artifact, host check and capture-only freshness evidence retaining their original receipts
across restart. The same revision passed 1,772 Linux / Node 24 tests with native confinement, typechecking and all builds in
[run 42613515022](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42613515022), in 174.42 seconds.
Both owned installed-Harness / DeepSeek Flash scenarios passed in 278.79 seconds, retaining scheduled reflection, usage
refusal/retry, artifact delivery and held-recovery behavior. The original app process remained running. Code and
qualification receipts are pushed on the feature branch; the full product goal remains active.

## Implemented increment: host-captured verification execution

[046 Host verification](046-host-verification.md) adds bounded file/Git manifests, private copied inputs, artifact and
source-revision preconditions, read-only credential-free/network-isolated checks on Linux, output digests and durable
original-job recovery. It uses the existing endpoint and Harness process provider. Capture-only and unknown/reconciled
receipts cannot become successful check results. Admission and cleanup retain snapshot reservations until quiescence.
Operator definitions, coordinator APIs/evidence UI, local support, library/publication freshness gates and exact PR-head
binding remain required; this execution layer does not itself mark artifacts verified or authorize publication.
Runtime code `7b1ff77ea24d7f26bcff85b20c88e031fc883f39`, with final test revision
`59a5183c167e95e68cb090952574461d3ae05651`, passed 1,753 local tests, typechecking and all five builds in the final
`pnpm check` (108.06 seconds). The installed-Harness / DeepSeek Flash dedicated scenario passed in 55.54 seconds,
checking an actual worker-created file and library artifact with the built helper, excluding service credentials and
retaining the original receipt after restart. The exact final test revision passed 1,757 Linux / Node 24 tests with native
confinement, typechecking and all five builds in
[run 42606804140](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42606804140), in 171.87 seconds.
The added ownership-loss case and stabilized expired-grant recovery fixture passed. The original app remains running,
and the full architecture/product objective remains active. The implementation and qualification receipts are pushed
on the feature branch; this does not close the remaining verification integration or other full-scope requirements.

## Implemented increment: speculative preparation and review

[045 Speculative preparation](045-speculative-preparation.md) adds assignment-bound durable owner/provider/environment
and workspace reservations, spare-capacity admission, explicit-work preemption, expiry, model usage integration,
quiescence/recovery holds and operator promotion. Exact-message approval is separate from promotion; artifact publication
also requires current promotion. API and bilingual review controls expose the lifecycle and reconciliation path.
The executor remains DeepSeek Harness. Code `6f27667b1d6f6ca4572fbad02e4aa06e830ffdbb` passed the final local
`pnpm check`: 1,738 tests, typechecking and all four builds. Linux / Node 24 with native confinement passed 1,740 tests,
typechecking and all builds in [run 42599700832](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42599700832).
The final installed-Harness / DeepSeek Flash speculative scenario passed in 21.98 seconds: actual file/artifact creation
and token usage, held publication, promotion plus separate exact-message approval, then unchanged evidence/usage and one
execution/delivery across restart and repeated original requests. Both final owned installed-Harness scenarios passed
in 262.56 seconds, retaining scheduled reflection, usage refusal/retry, artifact and held-recovery behavior. The original
app process remained running. The completed code and qualification receipts are pushed on the feature branch.
This does not close long-horizon evaluation, stronger confinement, managed machine launch, host-collected verification,
recovery activation/failover, supervision, voice, packaging, onboarding or any remaining full-scope requirement below.

## Implemented increment: scheduled reflection and reviewed proposals

[044 Scheduled reflection](044-scheduled-reflection.md) adds bounded automatic selection of recent mission/activity/library
context, immutable pre-dispatch snapshots, assignment-bound reads, durable memory/plan/new-mission candidates and operator
review. Promotion rechecks cited evidence, preserves provenance and uses existing Workspace and Library transactions;
approval never dispatches the candidate work. The Reflections UI creates schedules and displays captured context,
omission bounds, review notes and promoted results.
Code `b53a3fd2d268a23175f85bb024660f4ae5567ec1` passed 1,718 local tests, typechecking and all builds, and 1,720 Linux
tests in [run 42591703174](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42591703174).
Both owned installed-Harness / DeepSeek Flash scenarios passed in 289.10 seconds, including the managed reflection
candidate, explicit approval and unchanged evidence/receipts/dispatch after restart. The original app remained running.
Reflection quality and long-horizon evaluation, external freshness/imports, retention/scaling, multi-workspace ownership,
speculative budgets/promotion, managed machine launch, host-collected checks, recovery activation/failover, supervision,
voice, packaging, onboarding and the remaining full article/product requirements stay open.

## Implemented increment: bounded Chain of Recall

[043 Chain of Recall](043-chain-recall.md) adds persisted per-execution/router-day retrieval allowances, atomic reservations,
bounded source/revision traversal, exact returned UTF-8 byte ceilings, scope checks at each node and operator limits/history.
Library freshness now follows source chains with explicit unknown results at inspection limits. Review fingerprints use the
complete accessible dependency closure so distant changes invalidate acceptance even when the display traversal is bounded.
Model token budgets remain in the inference ledger; retrieval bytes are not presented as exact model token counts.
Automatic reflection,
retrieval quality/long-horizon evaluation, external-source imports/freshness, speculative admission, retention, multi-workspace,
recovery activation/failover, voice and the remaining full architecture/product requirements stay open.

Code `1aaa87cc87f577345bfb2fd5bc51d7d6f62b48ca` passed 1,708 Linux tests, typechecking and all builds in
[run 42587579793](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42587579793).
The full local check passed 1,704 tests; the final focused run passed 56. Both owned installed-Harness / DeepSeek Flash
scenarios passed in 254.46 seconds, including an exact fact retrieved from a three-record source chain, persisted retrieval
charges across restart, usage refusal/retry, scheduled execution and held recovery. Stale or unknown source chains were
refused by the artifact publication gate in independent service tests. The original app remained running.

## Implemented increment: managed model usage and budgets

[042 Usage and budgets](042-usage-budgets.md) adds managed Harness call/token accounting, immutable price snapshots,
workspace/mission/schedule/persona limits, atomic admission reservations, uncertain-outcome reconciliation and operator UI.
Missing reports retain reservations across restart. Prices are explicit operator inputs and displayed costs are estimates;
provider invoices, exact prepared-generation metadata and non-token fees remain outside this increment. Speculative admission integration,
retention, multi-workspace ownership, reflection, recovery activation/failover, voice and all other full-scope requirements
remain open.

Accounting code `fd6b18542dea7df48a5ff1d67b1f50e9c7424118` passed 1,693 tests with native Linux confinement,
typechecking and all builds in [run 42582670631](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42582670631).
The full local check passed 1,690 tests; the final shutdown-guard focused run passed 27. Both owned installed-Harness /
DeepSeek Flash scenarios passed in 249.58 seconds, including scheduled usage/restart persistence, pre-inference budget
refusal and explicit retry after allowance changes. The original app remained running. UI follow-up
`f9eeb684c73da00cdbff86a170a57c1666affc0c` fixes switching between providers sharing a model name; eight focused
checks, typechecking and all builds passed with the live-qualified runtime unchanged.
The final UI code also passed all 1,693 Linux tests, typechecking and builds in
[run 42583242628](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42583242628).

## Implemented increment: persistent mission schedules

[041 Schedules](041-schedules.md) adds versioned complete-plan snapshots, timezone-aware calendar/interval/one-off
occurrences, missed-run policies, durable run and open-mission limits, transactional mission dispatch and operator controls.
Every occurrence uses Engine authorization with recorded standing authority, retains human dependencies and result review,
and resumes from its original reservation after restart. The Schedules page exposes timing, limits, pause/resume, history,
blocked dispatch retry and mission links. Reflection proposals, provider spend budgets, retention, multi-workspace ownership,
restored activation and the remaining full architecture/product requirements remain open.

Schedule code `a9371423fb5b12c63a430fb7e42aef7829e60128` passed 1,679 local tests, typechecking and all four builds.
The same code passed 1,681 tests with native Linux confinement, typechecking and all builds in
[run 42578515463](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42578515463).
Both owned installed-Harness / DeepSeek Flash scenarios passed in 235.73 seconds, including an actual scheduled worker,
independent file/artifact checks and restart deduplication before and after execution. The focused run passed 40 tests.
The existing app stayed running. Reflection proposals, provider usage/spend budgets, retention, multi-workspace ownership,
restored activation, voice and the rest of the full architecture/product ledger remain open.

## Implemented increment: pending input recovery across all current kinds

[040 Pending inputs](040-pending-input-recovery.md) extends accepted/read acknowledgement tracking to policy changes,
resume notices, notes and text inputs. Restart/retry preserves accepted unread inputs with assignment provenance; settled
reports recover eligible inputs while keeping automation held for a person. Delivery deduplication now returns consumed
evidence after flush so the executor can repair a lost Store read acknowledgement without another send. Held recovery
reconciles read markers for every current kind and keeps historical reopen records and ended outcomes unchanged.

Legacy inputs without delivery provenance, broader authoritative state, connector cursors, deployment binding, supported
activation and clean-host failover remain open with all other architecture/product requirements below.

Pending-input code `bc50b29cd3eccbf41c667e25d5cb62a3e75f9943` passed 1,665 local tests, typechecking and all four
builds; the focused run passed 224 tests. The same code passed 1,667 tests with native Linux confinement, typechecking
and all builds in [run 42575419242](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42575419242).
Both owned installed-Harness / DeepSeek Flash scenarios passed in 213.61 seconds. Managed recovery confirmed original
Store non-trigger read acknowledgements against authenticated worker history and preserved original-ID image retries.
The dedicated case retained its expected unrecorded-publication refusal. Channel traffic stayed on fixture servers and
the original app remained running. Full activation, failover and the remaining architecture/product scope remain open.

## Implemented increment: passive source contracts and settings recovery

[039 Source contracts](039-source-contract-recovery.md) separates loaded source schemas from polling and Runtime startup.
GitHub/Feishu register passively, while listeners still require the coordinator. Built-in adapters and recovery share schemas
and eligibility rules. Held preparation validates authenticated source/policy settings against the actual catalog, pins its
lifetime and registration revision, and checks for changes before final publication. Invalid settings or missing required
contracts fail held; explicitly disabled unknown settings remain opaque. Signed summaries, older image authentication and
original-ID retries are supported without treating catalog membership as provider authentication or activation authority.

Deployment binding, private legacy connector credentials, authoritative pending work and broader state relationships,
cursor reconciliation, runtime remapping, supported activation and clean-host failover remain open with every other full
architecture/product requirement below.

Source-contract code `24fe27f7e172d40e2f47e03c618ced6e2e0c9bca` passed 1,656 local tests, typechecking and all four
builds. The same code passed 1,658 tests with native Linux confinement, typechecking and all builds in
[run 42572760163](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42572760163).
Both owned installed-Harness / DeepSeek Flash scenarios passed in 202.70 seconds. Managed recovery loaded the bundle's
passive source catalog with the coordinator disabled, verified its signed source summary, and retrieved the same held image
on retry. The dedicated case retained its expected refusal for unrecorded publication probes. Focused source/recovery tests
passed 184 cases; bundle tests passed all three cases after their expected plugin list was updated. Provider-message traffic
stayed local and the original app remained running. Deployment binding, authoritative pending-work/cursor reconciliation,
supported activation, clean-host failover and the remaining architecture/product scope remain open.

## Implemented increment: consumed input acknowledgement recovery

[038 Consumed inputs](038-consumed-input-recovery.md) reconciles missing live input acknowledgements against authenticated
worker `user/message` history. It repairs read markers and undelivered queues only in the private held image, preserving
authority, assignments, original timestamps and ended outcomes. Queued/claimed/canceled inbox entries and inherited or
foreign messages cannot supply consumption evidence. Contradictions or cancellation roll back the entire batch; signed
counts record the result. Original-ID retries and older image authentication remain supported.

This does not complete authoritative-state recovery or activation. Source configuration, pending-work and broader state
relationships, runtime remapping, coordinated ownership handoff and clean-host failover remain open alongside every other
article/product requirement below.

Consumed-input recovery code `679a97ad8f290f060c07a332ba4de3a0bad690f7` passed 1,640 local tests, typechecking and all
four builds. The same code passed 1,642 tests with native Linux confinement, typechecking and all builds in
[run 42570416549](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42570416549).
Both owned installed-Harness / DeepSeek Flash scenarios passed in 197.68 seconds. Managed recovery verified the signed
consumption summary against actual worker inputs and returned the same held image on retry; the dedicated case retained
its expected refusal for unrecorded publication probes. The focused recovery/delivery run passed 133 tests. Provider-message
traffic stayed local and the original app remained running. Source configuration, broader authoritative-state reconciliation,
supported activation and the remaining full architecture/product requirements remain open.

## Implemented increment: recovery inference verification

`037-inference-configuration-recovery.md` adds required Harness inference checks to new held receipt preparation.
Authenticated settings and Session history select effective current routes through the public cold model-selection projection;
queued persona and current role defaults are included. A bounded history-free, tool-free probe runs through the actual
Harness provider path twice, with safe failure codes and signed count/configuration-digest evidence. Missing inference,
changed defaults, unusable streams and failed final probes preserve the hold. Original-ID retries remain historical and
older signed images remain readable without claiming new evidence.

This verifies the selected restore host, including its middleware. It does not establish an uncaptured source default or
private adapter endpoint/account identity. Source configuration, authoritative-state reconciliation, remapping, coordinated
activation and clean-host failover remain open, alongside every other article/product requirement below.

Inference-recovery code `891a31394a55825ab5d24c8eff2e8f858344f4ca` passed 1,616 local tests, typechecking and all four builds.
The same code passed 1,618 tests with native Linux confinement, typechecking and all builds in
[run 42567837206](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42567837206).
Both owned installed-Harness / DeepSeek Flash scenarios passed in 206.52 seconds. Managed recovery used the real
Session Controller projection and provider path, verified the signed inference summary, and retrieved its original held
image on retry. The dedicated case retained its expected refusal for unrecorded publication probes. Provider-message
traffic stayed local; the original app remained running. Source configuration, authoritative state and restored activation
remain open.

## Implemented increment: control credentials and publisher configuration

[036 Control configuration](036-control-configuration-recovery.md) verifies the reserved ownership claimant and the
coordinator's publication credential during audit and held preparation. Publisher checks use the exact inventory revision
and read-only provider preflight for every configured account/destination. Wrong roles, missing private files, changed
accounts and mismatched targets block recovery. Checks repeat before final publication; no lease or message is created.
Signed images contain only successful control-check counts. Historical retries do not reauthorize execution.

Inference/source configuration, authoritative input/state reconciliation, explicit remapping, coordinated restored activation
and clean-host failure qualification remain open alongside the full architecture and product ledger.

Code `56adf6dc2243fe40e41b8491a885623293a77762` passed 1,591 local tests, typechecking and all four builds. Focused
runs passed 92 recovery tests and 43 ownership/publication tests.
The same code passed 1,593 tests with native Linux confinement, typechecking and all builds in
[run 42564344905](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42564344905).
Both owned installed-Harness / DeepSeek Flash scenarios passed in 224.07 seconds. Managed recovery verified its actual
reserved claimant and coordinator publication credentials and the provider account/target, then authenticated the held
control summary and original-ID retry. The dedicated case retained its expected refusal for unrecorded publication probes.
Provider-message traffic stayed local; the original app remained running. Restored activation remains unqualified.

## Implemented increment: destination Session verification

[035 Destination Sessions](035-session-backend-recovery.md) verifies the actual imported Harness backend during held
preparation. It claims all selected Session writers, checks immutable metadata, inherited boundaries and exact logical
events, and rejects missing, shorter, divergent, newer or extra related history. It rechecks the catalog before publishing
and records only verified Session/event counts. No history is created, appended or truncated. Original-ID retries retain
their historical meaning; the per-Session writer API supplies no global catalog lock or future activation permit.

Broader private runtime/account configuration, authoritative input/state reconciliation, remapping, coordinated activation,
clean-host failure qualification and the full article/product ledger remain open.

Code `915cfc28f6b2ca10425a185376f85ae3d3c6b4e0` passed 1,562 local tests, typechecking and all four builds. The focused
recovery run passed 108 tests; the complete suite also covers authentication of older manifests without Session evidence.
Both owned installed-Harness / DeepSeek Flash scenarios passed in 192.86 seconds. Managed preparation used the separately
imported backend and authenticated its Session/event counts and original-ID retry; the dedicated case retained the expected
refusal for unrecorded publication probes. Linux passed 1,564 tests with native confinement, typechecking and all builds in
[run 42562981301](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42562981301).
Provider-message traffic stayed local; the original app remained running. Restored activation remains unqualified.

## Implemented increment: execution configuration during recovery

[034 Execution configuration](034-execution-configuration-recovery.md) checks original active-world grant credentials,
managed private pins, root identity and endpoint-private credential integrity during audit and preparation. It repeats private
file checks before final publication because those changes need not alter database revisions. Confirmed revoked worlds retain
their non-executable history without requiring retired credential files. Reports/manifests exclude private values and digests.
Inference, connector, publication and ownership-claimant configuration, external account permissions, authoritative state,
Session-backend validation, remapping and activation remain required alongside the full architecture ledger.

Qualified code `ea66ba2384e1a82da2f24401ab3f3e93f13368b0` passed 1,544 local tests, typechecking and all four builds.
Both owned installed-Harness / DeepSeek Flash scenarios passed in 193.93 seconds, including an active credential-bound
world alongside two revoked worlds in authenticated held preparation. Linux passed 1,546 tests with native confinement,
typechecking and all builds in [run 42561413655](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42561413655).
Provider-message traffic remained local; the original app stayed running. Restored activation remains unqualified.

## Implemented increment: original world-revocation recovery

[033 Revocation recovery](033-revocation-recovery.md) confirms the original grant-principal receipt when its acknowledgement
was lost or its process range quiesced later. It validates the exact disabled successor generation and original authority
binding, applies only the held world copy, and preserves the original request and source bytes. No revocation, cancellation,
lease or credential operation is sent during recovery. Missing/conflicting proof keeps preparation blocked. Private
configuration, authoritative input/state recovery, Session/backend validation, remapping and activation remain required.

Qualified code `8c1a66445b89b328ebcbdad61260b147505a10a2` passed 1,521 local tests, typechecking and all four builds.
Both owned installed-Harness / DeepSeek Flash scenarios passed in 195.07 seconds, including lost revocation acknowledgements
and confirmation that recovery did not resend them. The same code passed 1,523 tests with native confinement, typechecking
and all four builds in [Linux run 42559418182](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42559418182).
Provider-message traffic stayed on local contract servers; the original app stayed running. Restored activation remains open.

## Implemented increment: administrative recovery

[032 Administrative recovery](032-administrative-recovery.md) reconciles the coordinator's original endpoint commands
against historical independent receipts, without resending administration or issuing credentials. Pending grant records
remain unusable until private credential validation; replaced generations are superseded without becoming old-request results.
Active-world credential versions/status are included in the resource audit. Prepared images authenticate administrative
counts and preserve source state. Private credential/runtime configuration validation, authoritative input/state recovery,
actual Session validation, remapping and activation remain required, alongside the complete article and Agentic OS ledgers.
Original world-revocation acknowledgement recovery is implemented in the subsequent increment above.

Qualified code `3f2d4ba2ee7058fc8f037fb4c666e074b8ac3ca3` also corrects false abandoned-command refusals across sibling
providers and delayed catalog observations, with shared uncertainty fencing and preserved restart reconciliation. The final
local suite passed 1,508 tests; typechecking and all four builds passed. Both owned installed-Harness / DeepSeek Flash cases
passed in 201.96 seconds, including actual managed subagent work and repeated authenticated administrative receipt preparation.
Linux passed 1,510 tests with native confinement, typechecking and all builds in
[run 42558234881](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42558234881).
Provider-message traffic used local contract servers. The original app remained running; no restored activation was performed.

## Implemented increment: held receipt preparation

[031 Receipt preparation](031-recovery-receipt-preparation.md) applies revision-bound original command/file/publication
observations to a separate authenticated recovery image. It preserves source state, original ownership and request IDs,
settles original channel Outbox receipts, verifies every image member and supports retry after interrupted publication.
Both copies retain execution holds. Original administrative receipts are reconciled by the subsequent increment. Private credential/runtime configuration validation, authoritative input/state recovery,
Session-backend validation, remapping, activation, clean-host drills and the remaining article/product ledger stay open.
Local verification passed 1,495 tests, typechecking and four builds. Code `66b28a49f5a81dc08c6c5f19b0d31a5cfb66ba1e`
passed both owned installed-Harness/DeepSeek Flash cases in 201.43 seconds, including repeated authenticated preparation
and refusal of the checkpoint with unrecorded publication probes. The same code passed 1,497 native Linux tests,
typechecking and all builds in [run 42554537411](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42554537411).
Provider-message traffic used local contract servers; restored activation remains unqualified.

## Implemented increment: recovery receipt audit

[030 Receipt audit](030-recovery-receipt-audit.md) adds administrator-only revision-bound endpoint/publisher inventories,
complete enrolled-resource coverage, original command/file/publication intent comparison and durable held reports. It detects
unrecorded effects, missing receipts, changed identities/results and unsettled work; it observes completed original effects
without replay. Every staged world/Session member is verified, and changed pages or authority invalidate the audit.

Receipt application is now implemented by the held preparation increment. Administrative-command/configuration reconciliation, authoritative input/state recovery, actual
Session-backend validation, world remapping, activation and clean-host drills remain required. No audit removes the hold.
The full article and product architecture remain in progress. Code `44b3fa54685ee4cf471c5b26db1ccc4c918337ba` passed
1,482 local tests, typechecking and all four builds. Both owned installed-Harness/DeepSeek Flash scenarios passed in
215.31 seconds, including repeated audits, every original receipt, full resource coverage and exact identification of four
unrecorded publication probes. The held state stayed non-executable. It also passed 1,484 native Linux tests, typechecking
and all builds in [run 42552272631](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42552272631).
Provider-message traffic stayed on local contract servers; live-account acceptance and restored activation remain open.

## Implemented increment: recovery ownership reservations

[029 Recovery reservations](029-recovery-reservations.md) authenticates the selected held checkpoint, compares its logical
database with staged state, and reserves a replacement claimant generation through independent administration. The source
claimant becomes invalid. Durable original requests survive lost responses, authority restart and credential-write failure;
superseded retries never adopt the newest credential. Resource drain barriers and the staged execution hold remain intact.

Receipt inventory/reconciliation, post-checkpoint divergence, Session/world validation for activation, explicit path and
credential remapping, clean-host activation/failover and every remaining article/product capability still require work.
This increment does not make a staged restore executable. Code revision `6d2ef214431d030c82ba2174f5e52ecc10b5acef`
passed local `pnpm check` on 2026-11-08: 1,468 tests, typechecking and all four builds. Both owned installed-Harness/DeepSeek
Flash scenarios passed on the final build in 199.31 seconds, including capture, repeated Session import, original reservation
retries, retained holds and source claimant rejection. It also passed 1,470 tests, typechecking and all builds with native
Linux confinement in [run 42549125311](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42549125311).
Provider message traffic stayed on local contract servers; this does not qualify live-account permissions or clean-host failover.

## Implemented increment: inbound task conversations

[028 Inbound conversations](028-inbound-conversations.md) adds explicit participant/task listeners to the independently owned
publisher. GitHub issue/review and Feishu/Lark root replies can steer the original task; cursor and receipt state survive
restarts, native IDs prevent replay, and the Engine enforces the recipient through fanout, routing, evaluation and worker
reads. The mission panel exposes consent, lost-save recovery, polling/rescans, pause and unsupported-message records.

This covers incoming replies to operator-selected existing tasks. Repository-wide discovery, source-originated admission,
rich content, Git/PR mutations, retention and restore activation/failover still require implementation. The full article and
Agentic OS ledger remain active. Local `pnpm check` on 2026-11-08 passed 1,457 tests, typechecking and all four builds.
Both owned installed-Harness/DeepSeek Flash scenarios passed on the final build (191.45 seconds), including an external
reply resuming the same task, an actual worker acknowledgement, unchanged artifact content and retained receipts/deduplication
after coordinator restart. Provider traffic stayed on local contract servers. Code revision
`a558cdd5f6bf2de59512afb60373cff2465fb74b` passed 1,459 tests with native Linux confinement, typechecking and all four builds
in [run 42546908912](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42546908912).

## Implemented increment: mission reply delivery

[027 Mission delivery](027-mission-delivery.md) attaches an operator-authorized publication Channel to new workspace
tickets for an exact plan/destination grant. Existing worker acknowledgement and router reply tools use the Outbox and
independent publisher. Revocation stops new sends while preserving unknown original outcomes; withdrawal keeps receipt
history and unresolved messages retain conversation ordering. The mission UI supports standing consent and recovery after
lost configuration replies. Providers now include pinned GitHub review threads and self-built Feishu/Lark bot replies.

This increment established outbound mission delivery. Inbound task conversations are added above. Owned profiles still
disable old CLI-backed inbound sources and repository workflows. Broader source admission, Git/PR mutations, host
verification, restore activation/failover and the full product ledger remain open.

Local qualification on 2026-11-08: `pnpm check` passed 1,437 tests, typechecking and all four builds. Both owned
installed-Harness/DeepSeek Flash scenarios passed, including actual acknowledgements and retained delivery receipts.
Exact code revision `3bf6a280f992c2e8621f6ec388879785f7827598` also passed 1,439 tests with native Linux confinement,
typechecking and all four builds in
[run 42543761724](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42543761724).

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
Increment 052 adds independent incident UI, explicit evidence-bound acknowledgement, paginated history and bounded retention.
It qualifies real configured-model worker/assessor inference, the served console bundle and abrupt main/watchdog restart
with durable evidence through an outage. Broader provider/process-failure coverage and deliberately long productive jobs
still need evaluation. Add alert routing before calling the operational experience complete.
Process restarts or task retries require their own narrow,
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
provider lifecycle to that authority. `026-artifact-publication.md` adds independently fenced artifact delivery;
`027-mission-delivery.md` routes plan-authorized mission replies through the Outbox and publisher. `028-inbound-conversations.md`
adds directed replies from authorized participants through that service. Next: complete broader source discovery/admission
and repository integration. Receipt audits, configuration/Session checks, consumed-input reconciliation and the core Engine
graph and built-in connector cursor/receipt checks are implemented in held preparation. Complete product-extension state, actual deployment binding and
remapping before activating a restored coordinator. The maintenance
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

Implemented in 045: an explicit speculative lifecycle on top of inferred mandates: proposal, admitted background preparation, evidence-ready,
promoted, expired or cancelled. Allocate per-owner/provider/environment concurrency, time and usage budgets durably before
starting work. Speculation consumes spare capacity and yields to explicit work. Promotion rechecks current authorization;
external publication uses a separate gate. Cancellation releases reservations only after execution quiesces or its outcome
has been reconciled.

Acceptance: competing admissions cannot overspend the same reservation; explicit work can preempt speculation; expired
work cannot publish; a restart preserves spent usage and active reservations; promotion keeps provenance and does not
repeat completed work. Provider usage reporting and enforceable limits remain distinguished from approximate cost estimates. Long-horizon
quality/waste measurement, scaling, multi-workspace ownership and stronger confinement still require acceptance evidence.

### 6. Verified artifacts and delivery

Implemented through 050: host-captured bounded file/Git inputs, copied-source checks through endpoint/Harness jobs,
revision preconditions, durable outcomes and unknown-aware cleanup; coordinator definitions, local/remote checks,
evidence UI, checked acceptance/publication and explicit-commit PR reviews bound to provider-observed heads and actual
captured Git trees; plan-bound PR results and fresh whole-mission completion with original-attempt recovery.
CI/branch-policy and merge integration, remote Git provisioning and continuous freshness remain open.

Persist artifacts and verification results bound to exact source/workspace revisions: commit/tree IDs, content hashes,
command or check identities, exit outcomes and timestamps. Verification evidence is collected by host integrations;
model assertions alone do not satisfy it. Publication binds the approved artifact revision to its destination and receipt.
After an ambiguous external response, query the destination before retrying publication.

Acceptance: a subsequent edit invalidates prior checks; stale branch evidence cannot approve a new PR head; duplicate
delivery requests do not publish twice; failed/unknown effects remain recoverable; each user-visible result links its actual
artifact and relevant evidence. Keep existing GitHub follow-up/PR ownership and handback invariants.

### 7. Router authority and operator experience

Implemented in 051: the router uses typed, bounded Source/resource operations with identity-based tool guards and no
generic execution tools. Keep semantic batching, subscriptions, selective pass-through, many-to-many ownership and worker-local teams.
The independent incident/evidence console is implemented in 052. Continue integrating task-centered timeline, artifact,
environment, budget and incident navigation while retaining the working panel.
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
