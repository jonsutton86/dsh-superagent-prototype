# 079 Execution observations for independent supervision

The first implementation-tracker item includes richer progress evidence. This increment extends the independent watchdog's
observations with host-collected execution metadata, preserving DeepSeek Harness and the existing three watchdog tools.
Activity is evidence for assessment, not proof of useful progress, task completion or permission to recover a worker.
It builds on [078's fault qualification](078-supervision-failures.md) and [077's receipt-aware alerting](077-supervision-alerts.md).

## Evidence and attribution

Source inspection found that worker Sessions survive assignment changes. Harness job views name an owning Session, but do
not expose an assignment ID or the original Agent object. The public job list also includes unowned jobs. Some job lifecycle
Session events contain tool call IDs, but Harness can continue when writing those events fails. Missing lifecycle records
therefore cannot establish that a job never ran or identify its assignment.

Remote operations have a stronger existing source: `ExecutionEffects` persists the trusted ticket, assignment, Session,
tool call and world before dispatch, and refuses mismatched endpoint receipts. The new projection reads that same journal;
it does not create another ownership ledger, fetch endpoint status or repeat operations. Harness jobs and remote receipts
are separate views and are not added together as independent executions.

| Observation | Source and coverage | Attribution limit |
| --- | --- | --- |
| Worker activity | Already loaded Agent and live registry identity | Session activity; assignment ownership unknown |
| Jobs | At most 256 registry entries examined; unowned/foreign jobs excluded | Session ownership; assignment and exact Agent lifecycle unknown |
| Handed-off jobs | Executor's existing process-local handoff set | Kept separate from active job counts and output bytes |
| Output activity | Metadata byte totals; no output read or cursor consumption | Bytes are activity, not verified results; missing totals stay unknown |
| Subagents | At most 256 loaded Session records examined for observed lineage | Loaded records only; no claim about the durable child catalog or assignment ownership |
| Retry/preparation state | Executor's existing in-memory state | Current coordinator process only; restart does not reconstruct an authoritative history |
| Remote operations | Bounded saved receipts for the exact ticket, assignment and original execution world | Phase, quiescence and available outcome evidence remain separate |

Missing, throwing, malformed or stale sources are explicitly unavailable. An unavailable source is not a zero-work claim.
Remote world replacement/rotation cannot make older work appear as an empty current-world receipt set. Partial projections
remain partial. Filesystem mutation outcomes without sufficient saved outcome evidence remain unknown even when their
phase or quiescence is known. No command, job label, output content, provider exception, credential or host path is included.

Bounded identity digests distinguish replacement jobs, children and receipts with otherwise identical counts. Material
digests exclude polling timestamps and presentation clocks. Known handed-off output bytes do not create active-task evidence
churn. The collector never restores a Session, starts inference, consumes job output, discovers remote state or changes authority.

## Coherent transport and fresh action checks

The first authenticated observation request captures an immutable in-memory frame. It has an opaque version, exact total,
15-second lifetime and at most 10,000 tickets. The process retains at most two frames, each limited to 64 MiB; every page
must fit the client's 1 MiB response limit. The next page supplies both its offset and the original version. Expired, evicted,
unknown, oversized or incomplete frames fail explicitly. The client checks totals, contiguous offsets, process identity and
frame identity before reconciliation. A partial read cannot silently resolve unseen incidents.

These frames are transport caches, not durable authority. A progress request re-reads the current task and material
execution evidence inside the existing transactional request path. Changed evidence is refused even if the earlier frame
still exists. Original request receipts continue to deduplicate an action whose response was lost.

The coordinator and watchdog client must be upgraded together for multi-page observations: older clients do not supply
the frame version. Their incomplete reads fail rather than mixing evidence. This source change does not deploy either process.

## Evidence changes and bounded assessment

The observation carries a task/assignment episode identity separately from its material-evidence revision. Within the same
task, process and timed review cycle, changing job state, output activity or receipt metadata updates the evidence without
resetting assessment attempts or the cycle start. The existing maximum of three deliveries and explicit timed review renewal
remain in force. Activity changes alone neither close an incident nor classify it as progressing.

An assessment is current only when its incident ID and revision match the latest evidence. Earlier assessments stay visible
as historical, and cannot authorize a new progress request or classify a current alert. Operator acknowledgements and prior
intervention receipts retain their original evidence basis and request identity. New evidence requires a new review; it does
not rewrite a previously accepted acknowledgement receipt.

Each assessment delivery freezes its original incident revision, structured observation and exact message text before first
dispatch. A retry of an unconfirmed delivery retains that same ID and body even when newer evidence arrives. A stale response
is refused; it does not become a current diagnosis. This preserves the response-loss boundary established by the earlier journal.

## Storage and operator view

Watchdog schema four adds these fields to the existing incident documents. Migration freezes known schema-three delivery
bodies using the original format, preserves acknowledgement view revisions and retains alert receipts and deduplication
state. It creates no parallel persistence tier. Earlier binaries refuse schema four; a rollback requires the corresponding
offline state backup rather than opening the migrated database with an older binary.

The independent console displays availability, coverage, attribution and unknown outcomes alongside the current evidence.
Historical diagnoses and intervention receipts are labelled as such. This remains the independent console; task-centered
navigation in the main workspace is still tracked separately. No new recovery action or operator permission is introduced.

## Qualification and remaining scope

Focused collector, journal, transport and rendered-console checks passed: 101 tests across ten files. The installed-process
fixture passed in 66.46 seconds, including actual Harness job evidence and its Session-only attribution while a real worker
was active. That run preceded the standalone UI bundling correction described below.

An actual Chrome check found an unresolved `zod` import in the served console. The standalone build now includes that
dependency. A regression builds and mounts the real entry without an import map or package resolver; both browser-bundle
tests pass. Chrome then displayed current metadata, explicit unavailable evidence, historical assessments and the unchanged
acknowledgement boundary. The temporary synthetic server was stopped and its state removed. Rendered-component tests alone
did not expose this startup fault.

The compact source, method and browser evidence is in [the evidence record](evidence/079-execution-observations.json).
Runtime/test revision `418bb6de16e546058557191e4068e77f2b6e7174` passed full macOS qualification (2,200 passed,
25 skipped; 257.96 seconds) and hosted native Linux qualification (2,213 passed, 14 skipped; 303.17 seconds), with typecheck
and seven builds on both. Native service/SSH checks passed 16 with one skip on macOS, and all 30 on Linux. Installed
watchdog, repository publisher and provider-adapter fixtures were enabled on both; Linux logs confirm each ran and passed.
The built standalone browser regression ran after the dependency fix. [The qualification receipt](evidence/079-qualification.json)
records source/archive identity, platform versions, log digests and the successful automatic push workflow.
Linux jsdom tests emitted nonfatal React scheduling warnings; this is not a warning-free-log claim.

Representative real-model diagnosis quality, unattended-duration evaluation, live alert destination acceptance and narrow
audited recovery policies remain open in supervision. The rest of the full architecture remains in the implementation tracker.
The optional Abliteration provider and existing model defaults are unchanged. No live provider inference, live operator
notification, user-app deployment, hosting purchase or main-branch merge is performed by this increment.
