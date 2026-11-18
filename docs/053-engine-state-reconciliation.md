# 053 Engine state reconciliation in held recovery

Receipt preparation now validates the core Engine graph in its private prepared Store after authenticated input and
external receipt reconciliation. A checkpoint can have intact files and valid remote receipts while still containing
conflicting task authority, broken references or stale query indexes. The new check verifies those relations before the
prepared image is signed and published. It never starts the Runtime or executes an effect.

## Recorded authority

The validator reads triggers, dispositions, threads, evaluations, decisions, tickets, assignments, inputs, Outbox receipts
and the six existing effect kinds. It checks physical record identities, bounded shapes and references between them.
Thread keys agree with their source references; pending and active evaluation batches belong to their primary thread and
cannot overlap. An evaluation's recorded primary actor agrees with the original trigger. Current evaluations cannot also
have a completed decision, and decision evaluation identities remain unique.

Every ticket is bound reciprocally to its original acceptance decision, original trigger batch and mandate. Strength,
policy version, scope, actor and basis cannot be replaced during recovery. The executor's recorded environment enrichment
is retained; an environment already present on the decision must agree, and current execution/assignment locations must
agree with the ticket. This checks recorded consistency, not whether current deployment credentials authorize execution;
the separate execution-configuration checks still apply.

Assignment IDs are globally unique, only the final assignment can remain active, and an ended ticket cannot have an active
assignment. Input delivery references stay within their ticket's assignment history. Trigger-backed inputs retain their
original source references; a human/resume claim requires a human trigger. Directed input remains restricted to its
original recipient and cannot authorize a second ticket. Followed threads, subscriptions, question references and receipt
owners must exist. Consumed-input proof remains the separate authenticated Session check described in
[038](038-consumed-input-recovery.md) and [040](040-pending-input-recovery.md).

The Engine deliberately retains some historical metadata. Expiration removes an evaluation without recording a decision,
so an unknown historical disposition `evalId` is counted and preserved without granting it current authority. A known
evaluation/decision tag must still reference its trigger. A prior disposition decision can differ from a later evaluation.
Context metadata can outlive fanout after handback. Filtered triggers need not have aggregate threads. Legacy inputs without
modern consumption fields and unknown fields on otherwise valid records are preserved; recovery does not manufacture their
missing history.

## Permitted repairs

Only derived SQL projections and demonstrably obsolete queue rows change:

- Rebuild trigger/thread membership and its time/human projections from original trigger JSON; repair `trigger.at` and
  `decision.thread` query columns. Aggregate JSON is not rewritten.
- Remove a launch for an ended ticket or an assignment already running/ended; remove a delivery with no running assignment,
  no waiting inputs or an ended ticket. These are the existing handlers' no-op cases.
- Remove an assessment whose trigger is no longer held by that exact current evaluation, including expired evaluations.
- Remove a reply only when its original Outbox receipt is already sent/dropped, including receipts reconciled against the
  independent publisher earlier in preparation. A pending receipt missing its original effect fails preparation.

Live queue payloads, keys, sequence, retry generation, attempts, due time and errors remain unchanged. Relay and notice rows
retain their bounded payloads. Missing legacy launch rows are not invented: the normal executor already owns pending-launch
resumption, which remains unavailable while recovery is held. No new decision, ticket, assignment, publication or credential
is produced by graph reconciliation.

All graph checks and repairs run in one SQLite savepoint with cancellation checks and cooperative yields. Any conflict,
limit breach or cancellation rolls back repairs; the surrounding preparation discards its unpublished temporary image.
The source checkpoint and staged core records remain unchanged; the existing preparation-intent journal still records the
request. Bounds are 250,000 aggregate/effect records, 512 MiB of serialized
record values, 16 MiB per record and two million checked links/index entries, with smaller field/array limits. These bounds
are explicit refusal thresholds, not a demonstrated deployment capacity.

## Proof and remaining work

The signed image adds optional `stateGraph` version 1: record counts, retained historical evaluation count, projection repair
counts, retired-effect count and SHA-256 of the reconciled core tables in deterministic order. The effect count records rows
inspected before retirement. File hashes and the existing
manifest HMAC authenticate the complete prepared image. Repeating reconciliation is idempotent; retrying the original
preparation ID returns its authenticated image. Older signed images remain readable without acquiring a graph proof they
never had. Every image still has `executionOwnership: false` and retains its recovery hold.

This increment covers the core Engine relations. Connector cursors, product-extension graphs, deployment remapping,
activation, ownership handoff and clean-host failover remain separate work. A graph digest is not a permit to clear a hold,
replay external effects or start workers. The full architecture and Agentic OS objective remain active.

## Qualification

The new tests exercise the actual Engine with the SQLite Store and durable Effects queue, including many-to-many fanout,
directed human inputs, filtered sources, expired evaluations, completed/resumed assignments, obsolete effects, stable live
queue scheduling, index repair, conflicting authority, oversized records and rollback after cancellation during repair.
Integration fixtures now contain the causal trigger/thread/decision history their tickets previously omitted. Receipt
preparation tests cover signed graph proof, unchanged source/staged authority, historical image compatibility, original-ID
retry and rejection without a published image. Installed-Harness managed recovery now requires a nonempty graph proof from
the actual worker workload.

Runtime/test revision `2606671c2b624da8eef117d250226e1977ce1022` passed 1,860 local tests (14 conditional skips),
typechecking and all six builds. The same revision passed 1,867 tests (eight conditional skips), typechecking and all six
builds on Linux / Node 24 with native confinement in
[run 42654443599](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42654443599).
The installed-Harness / DeepSeek Flash owned-managed scenario passed in 203.36 seconds. It exercised real worker inference,
authenticated Session/input recovery, independent effect receipt reconciliation, nonempty graph proof, retained execution
holds and retrieval of the same original prepared image on retry. External provider traffic stayed on local contract
servers; inference used the configured real API. The original app remained running. This qualifies held preparation, not
restored activation or the unfinished full architecture/product scope.
