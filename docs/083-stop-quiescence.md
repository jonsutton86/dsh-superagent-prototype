# 083 Original-worker stop holds

**Implementation in progress.** This increment addresses a confirmed normal-task retry boundary. It has not yet completed
focused or full qualification, and it is not deployed to the running user app.

## Observed problem

[080](080-worker-recovery.md) retained uncertain launch identities and bounded automatic replacement. That launch evidence
does not establish that an earlier worker stopped. A controlled Runtime fixture at the prior baseline reproduced an explicit
retry with one worker slot: a bounded stop wait returned `running`, the stopping Promise settled, and the replacement
assignment and saved input were dispatched while the original Session job remained running.

The source explains the gap: background stop waits discarded terminal status and wait errors; the in-memory stopping
barrier swallowed failures and removed itself. Launch and delivery waited for that barrier but did not require a retained
stop receipt. A native job-completion notice can also wake the Session without passing through either dispatch queue.
The reproduction used fake jobs and establishes a dispatch defect, not an observed native-process overlap.

The [source contract](evidence/083-stop-contract.json) records the inspected lifecycle, job, queue, restore, ownership and
operator boundaries. Codegraph and selected REA analysis informed the source review; their static coverage does not replace
runtime evidence. The existing independent supervision, original-operation records, DeepSeek Harness runtime and optional
Abliteration route remain the architecture to extend.

## Authority and proof

One canonical stop record in the existing main Store owns the original assignment boundary, Session, execution binding,
scoped targets, control-dispatch evidence and material stop revision. Effects holds only a pointer for scheduling. No copy
of those authoritative facts belongs in Assignment JSON or the watchdog journal. Separate operator attestation receipts
record a distinct authorization; they are not duplicate stop outcomes.

A stop intent must commit before cancellation. Replacement launch, queued delivery, native completion wakeups and tool/model
admission must all consult the same unresolved hold. Bounded waits, accepted cancellation and missing registry entries do not
prove that prior work stopped. A delayed stop for an old assignment must not target a replacement now occupying the shared
Session. Existing job handoff to a person retains its scope; stopping descendants must not silently kill handed-off jobs.

Same-process proof is scoped to known Harness agents, jobs and observed descendants, plus original remote effect receipts
where required. It does not claim arbitrary native-process containment. Cold local registry absence remains unknown and
requires original-scope operator evidence where that control is supported. New ownership or a different world cannot replace
missing original evidence. Legacy state migration records unproven coverage without fabricating historical stop success.

Admission provenance belongs to the exact live Agent, Session and job/descendant services that accepted the original
assignment. Loading another Agent with the same Session ID cannot recreate that provenance. A full settled stop can cover
a graceful cold restart; before later work under that same assignment, the canonical record marks that coverage consumed.
The historical quiet receipt remains readable, but it cannot prove termination of subsequently admitted work.

The database schema must prevent an older binary from ignoring these holds. Restore validation must check original identity,
execution references, effect pointers and control receipts, including unresolved work whose domain task already ended.
Bounded record/target sizes and paginated reads avoid an artificial per-assignment execution quota. Unresolved or referenced
receipts must not be pruned to make a later operation look new.

## Operator behavior

Task detail, Inbox, missions and independent supervision should distinguish a pending replacement from the original work
whose stop is unresolved. Ended and single-assignment tasks still need visible stop evidence. Routine observations and
operator receipt bookkeeping must not renew watchdog assessment budgets; material evidence still invalidates stale actions.

Recheck observes the immutable original scope only. It does not dispatch cancellation, create a replacement or promise a
separate durable acknowledgement for each observation request. GET reads the saved original state without probing.

A local operator confirmation is different: it carries the original stop identity, reviewed revision and scope/binding,
with a stable request ID and durable receipt. Exact replay checks the existing receipt before stale-revision checks. The UI
must preserve that original request through response loss and remount, and never substitute a fresh ID after an uncertain
response. Operator evidence must remain visibly distinct from observed process termination and from task success.

## Preparation command recovery

Local preparation now commits an original assignment-bound intent in `executor_stop` before Harness receives the command.
The same canonical record carries a command hash and typed observation, rather than a second preparation journal. A direct
command exit and a confirmed empty Harness-managed range are separate facts. Only both together permit a `preparation`
quiet proof. A failed command with this proof remains failed, but an explicit retry can reuse its original stop coverage
after the failed launch effect is retired. Standard output/error text is not termination authority.

Successful preparation consumes this limited coverage before later launch commands or worker admission. A crash, rejected
provider response, spawn uncertainty, observation timeout, or unavailable/busy managed range stays unknown under the original
intent. Missing Agents and empty replacement registries do not release it. Ordinary stop rechecks cannot upgrade that
preparation uncertainty. An actively observed preparation refuses operator attestation; after observation ends, the existing
original-bound operator evidence flow remains available. No command is blindly repeated to resolve uncertainty.

This proof requires an untouched first local launch and no already-loaded worker Session. Reused loaded Sessions or
world-bound assignments cannot mint local preparation-only proof. Remote preparation continues through its existing
endpoint-owned receipt path. This conservative local refusal does not claim that deleting or unloading a Session proves
its earlier work stopped. Native provider containment still bounds the evidence: an empty managed range does not prove
that arbitrary escaped processes do not exist.

Schema 14 provides the older-reader barrier. Schema 13 records retain their identities on upgrade; missing canonical stop
tables are rejected. Restore verifies original execution bindings and rejects unconsumed preparation-only coverage after
worker dispatch. Observed outcomes, command identity and consumed coverage cannot be rewritten to authorize a new action.
Focused synthetic/runtime and restore checks are recorded in [preparation recovery evidence](evidence/083-preparation-recovery.json).
A native preparation subprocess check now verifies nonzero command exit with an empty range, and command exit with a
live descendant whose bounded observation remains unknown until the original range empties.
`docs/evidence/083-native-preparation.json` records the installed Harness version and tested scope. This is the actual
subprocess/observer boundary. A second check reopens the canonical Store while a real descendant remains active,
then recreates the stop coordinator without the original handle. The same intent stays held both before and after native
termination; a foreign-instance completion cannot settle it. This is database reopen and handle-authority loss, not an
abrupt host/process kill or complete Runtime crash/restore acceptance. Native coordinator preparation fault injection
and the final platform matrix remain unqualified.

## Preparation evidence in the workspace

The original-stop detail response includes bounded preparation outcome fields (phase, command exit, exit code and
managed-range observation), plus whether later work consumed the receipt's coverage. It does not expose the preparation
command or its digest. The recovery panel shows command exit separately from process termination, preserves zero exit
codes, and explicitly labels historical coverage as insufficient for later execution. These are read-only facts; they do
not alter recheck or operator-confirmation admission. Rendered UI and API/authority checks are recorded in
`docs/evidence/083-preparation-view.json`. Browser deployment acceptance remains separate.

## Qualification still required

Targeted cases cover running/failed stop waits, rejected or uncertain control, known eventual termination, old-target
fencing, descendant coverage, warm/cold recovery, migration/restore, intentional handoff, native wake admission, original-ID
operator recovery and unchanged assessment budgets. An installed private Harness fixture checks the retry boundary against
a real 45-second heartbeat worker, one explicitly ignored original kill, a ten-second wait returning running and at least
twelve more seconds of productive output while replacement and input delivery remain held. Natural termination must precede
one replacement and one original-ID input delivery. PID/start identity, hash history and process-group absence establish the
fixture's cleanup; this fault does not claim a process resisted native SIGKILL.

The macOS installed-Harness boundary passed on November 15 with runtime `3f5fc4a` and the test digest recorded in
[evidence](evidence/083-installed-stop.json). After the ten-second running wait, the original job produced another
12.055 seconds of verified output while replacement and input remained held. Natural termination released one replacement
and one retained input; original and replacement process groups were confirmed absent. The observed native completion
message arrived while the hold still existed, without admitting tool/model work. Build and typecheck passed. The first
installation attempt exposed pnpm 9's workspace-root refusal; the successful isolated run used pnpm 11.25.0. The first
runtime attempt exposed an outdated test expectation that a ready local assignment stays running; the domain correctly
ends it. Neither attempt is counted as a pass. Linux and native preparation fault injection remain pending.

Record the exact tested revision, focused results, typecheck/build, full macOS/native Linux and installed-boundary results
before calling this increment qualified. [082](082-supervision-endurance.md) remains the preceding qualified runtime; its
interrupted eight-hour run retains an immutable private snapshot and an unknown outcome. Later checkout edits do not
change that evidence.
