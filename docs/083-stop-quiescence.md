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

## Qualification still required

Targeted cases cover running/failed stop waits, rejected or uncertain control, known eventual termination, old-target
fencing, descendant coverage, warm/cold recovery, migration/restore, intentional handoff, native wake admission, original-ID
operator recovery and unchanged assessment budgets. An installed private Harness fixture checks the retry boundary against
a real 45-second heartbeat worker, one explicitly ignored original kill, a ten-second wait returning running and at least
twelve more seconds of productive output while replacement and input delivery remain held. Natural termination must precede
one replacement and one original-ID input delivery. PID/start identity, hash history and process-group absence establish the
fixture's cleanup; this fault does not claim a process resisted native SIGKILL. Installed execution remains pending.

Record the exact tested revision, focused results, typecheck/build, full macOS/native Linux and installed-boundary results
before calling this increment qualified. [082](082-supervision-endurance.md) remains the preceding qualified runtime; its
ongoing eight-hour run uses an immutable private snapshot and is not affected by this checkout's subsequent edits.
