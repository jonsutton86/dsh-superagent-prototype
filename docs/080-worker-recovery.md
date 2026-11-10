# 080 Bounded worker recovery

This increment continues supervision and operational visibility in the implementation tracker. It retains DeepSeek Harness
as the runtime and removes a second layer of provider retries that could start extra worker turns after Harness had already
ended its retry chain. The optional Abliteration route and existing default model are unchanged.

## Source evidence and decision

Codegraph indexed the checkout at `0db02c586b82872d1dcdbc7a37460e132da605a7` before investigation. REA analyzed six selected
shipped Harness rc.3 JavaScript sources; direct source inspection covered the surrounding event and persistence contracts.
The installed package bytes were compared with the pinned alpha.2 development SDK. The compact source manifest, hashes,
observations and limits are in [the evidence record](evidence/080-worker-recovery.json). Fabric's pinned `review_design` and
`review_code` operations use the existing evidence wrapper. Static source analysis is not process-failure qualification.

Harness already owns request retry policy and emits native retry events. Its default policy permits up to five retries,
but the actual configured policy may differ. Native retry events persist in the Session, while the live timer and retry
projection reset at step/turn boundaries and cold resume. An attempt ID is not an assignment identity or a durable budget.
The previous executor added three fresh continuation turns after terminal errors. Persisting that outer loop would preserve
duplicated authority rather than solve it. The implementation therefore consolidates provider retry ownership in Harness.
No Harness retry configuration or model default is changed.

`agent/error` identifies an Agent, turn and step, but not a task assignment. `turn/start` can precede the delivery acceptance
callback, and request assembly can fail before `agent/request`. The executor now captures the original live Agent, Session,
assignment, turn and step, then checks current registry identity and the same turn's cancellation signal. Step-zero and
committed pre-request failures can produce a hold, without granting retry authority. Duplicate, retired, cancelled, closed,
old-turn and reassigned callbacks cannot be relabelled as the current assignment's failure. The request hook preserves the
Harness waterfall by calling `next()`.

Terminal failures produce fixed summaries; provider messages, causes, request IDs and response bodies do not enter the
coordinator report. Typed classifications read only validated own data fields. Separate launch-transport classification
accepts specific HTTP/transport facts; arbitrary error text never authorizes a retry.

## Existing state, bounded retries and unknown outcomes

| Boundary | Authority and retained state | Result |
| --- | --- | --- |
| Model request retry | Existing native Harness retry policy and Session events | Terminal failure holds the worker; zero extra executor continuation turns |
| Definite failed launch | Existing effect row, original assignment/payload/sequence, completed failure count and due time | Three retries after the initial known failed launch, with existing queue backoff |
| Interrupted or unconfirmed launch | Dispatch marker in that same effect row, written before launch I/O | Original assignment and uncertain record held; no automatic redispatch |
| Host restart replacement | Existing consecutive assignment history ending `hostRestarted` | At most three automatic replacement assignments; exhaustion records a failed hold |
| Explicit retry | Existing operator retry command and new assignment | Starts a new authorized chain; old unknown launch evidence remains retained |

Startup uses `Effects.ensure` to preserve a pending intent's payload, identity, generation, spent attempts and backoff.
Known transient launch failure clears its dispatch marker in the same SQLite update that increments the failure count and
sets its next due time. Terminal launch failure records its failed report and closes the marker in one transaction. A
failed pending assignment cannot be dispatched merely because its effect row survived a crash before cleanup.

A launch accepted by Harness whose acknowledgement fails remains unknown. The executor cancels the loaded turn and holds
automatic inbox messages; this is not proof that every descendant or external side effect has stopped. A process loss before
known settlement also retains the original marker. Held rows are excluded from dispatch, cannot be overwritten or removed by
ordinary cancellation, and survive graph reconciliation after a task ends or receives an explicit retry. They do not block
new launch rows. The source does not infer success or resolve an unknown operation from a missing response. No automatic
retention cleanup or new operator reconciliation action is introduced for those unknown rows.

A live launch handler is distinguished from a recovered marker so normal acceptance can deliver its already-authorized
inputs. Once its outcome is unknown, a human follow-up is saved but does not silently replay the launch; the failed hold and
explicit retry control remain visible. Retrying remains an operator action requiring review of the original assignment and
execution receipts, not an acknowledgement button in the supervision console.

Host-restart allowance comes from the existing assignment history, not another retry ledger. Ordinary progress, clock
changes and process restarts do not reset it. An explicit retry or a new human resumption of an ended ticket starts a new
chain. Exhausted and failed recovery notes remain in history but are held from the pending inbox, including across another
restart. Exact legacy executor continuation IDs are removed only from pending inboxes; consumed Session history is preserved.
This admission cap limits the existing restart behavior; it does not establish cross-host isolation or prior-work quiescence.

## Migration and operator view

Coordinator schema 12 adds `launch_started` to the existing effect table. Migration from schema 10/11 marks existing launch
rows unknown because their older records cannot prove dispatch had not begun. Original payloads and scheduling metadata
remain intact. A schema-12 database missing the marker column is refused. Older binaries refuse schema 12; rollback needs
the matching offline state backup. This increment adds no parallel persistence tier and does not migrate the user's app.

The independent console now distinguishes process-local activity from durable launch-failure counts. It shows Harness as
provider retry owner, zero additional worker-turn retries and the used/remaining host-restart allowance. Historical
observations from the previous schema remain readable. Acknowledging evidence neither retries a task nor resets an allowance.
This extends [079 execution observations](079-execution-observations.md); task-centered main-workspace navigation remains open.

## Qualification and remaining scope

Focused tests exercise launch retry continuity, atomic failure settlement, unknown acknowledgement recovery, retained
retired intents, graph validation, schema migration, host-restart exhaustion, legacy inbox cleanup and stale failure fences.
An opt-in installed-Harness test creates a fresh HOME, profile and workspace with a loopback-only scripted provider. Its
fixture-only policy allows two native retries: three identical requests in one Session/turn/step, followed by a sanitized
failed report and blocked inbox. It waits beyond the former 15-second continuation timer and verifies no extra turn or
assignment. No real provider credentials or user profile are loaded.

Pre-commit installed qualification passed in 19.00 seconds before the final launch-journal review fixes. It is preliminary,
not validation of those later changes. The final focused pass covered 262 tests in ten files, with typecheck and seven builds passing. Chrome loaded the actual
served console and displayed Harness ownership, zero extra turn retries and the exhausted host-restart allowance. The
synthetic server was stopped and its temporary state removed. Exact committed-source macOS/Linux qualification follows.

Real-model diagnosis quality, long unattended endurance, live operator alert acceptance, further narrow recovery policies,
physical cross-host failover and the remaining full architecture remain open. This is an implemented recovery increment,
not full-project completion or deployment. No paid provider inference, hosting purchase or main-branch merge is performed.
