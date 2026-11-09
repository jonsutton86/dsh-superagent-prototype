# Checked artifact approval and mission acceptance

This increment connects [artifact checks](047-artifact-checks.md) to mission result acceptance and independently journaled
artifact publication. DeepSeek Harness remains the executor. A model-authored artifact needs operator-selected successful
host checks before a new external publication. An agent action with current artifacts needs at least one selected check
for every current artifact from its latest assignment before acceptance. Selecting a check does not rerun its command.

## Evidence and source binding

The host derives each selectable evidence hash from the original artifact, immutable check version, assignment/Session,
environment and canonical source, captured manifest, execution outcome, complete output digests and completion times.
Clients supply only original run IDs and these hashes. The host revalidates check authority, current artifact revision and
hash, original execution availability, successful outcome and quiescence. A model claim or capture-only result cannot pass.

Before a new approval commits, a durable review records the selected checks, approval target and original capture IDs.
Checks sharing the same backend and snapshot use one source capture. Each capture compares the original source against
the selected successful manifest without executing the check command. The resulting seal binds artifact/check versions,
assignment/Session, actual confinement, snapshot hash, recorded Git commit/tree when available, original check time and
capture receipt. Different approval content cannot reuse a review ID.

Freshness lasts at most 60 seconds from source capture, with at most five seconds of future clock skew accepted. The
coordinator rechecks the seals at commit. The independent publisher validates artifact identity and expiry at admission
and again after asynchronous provider preparation, immediately before a new provider send. The publisher trusts its
authenticated coordinator to attest check evidence; it does not independently read the coordinator's check database.
Publication source capture and the external provider transaction are separate operations. They do not prevent an
unobserved edit between capture and send and do not provide atomic filesystem/publication semantics. Clock synchronization
and a sufficiently short capture/preparation interval are operational requirements.

Historical acceptance does not expire every minute. The workspace revalidates original check authority, artifact and
environment bindings, current required artifacts and the latest known source observation. A subsequently captured source
change invalidates the accepted result. Closing a mission uses these historical acceptances; it does not launch a fresh
filesystem scan. Continuous source watching and a fresh final whole-mission closure gate remain separate work.

## Review and publication recovery

Publication retries first observe the original independently journaled receipt. Only an authenticated, identity-pinned
`receipt_missing` response, with no previously observed receipt, permits preparing a new source capture and dispatch.
Unavailable observation, a disappearing known receipt or a lost response never proves non-delivery. Existing receipts
remain recoverable after artifact archival, source changes, check revocation or freshness expiry. They are never replaced
by a new send. Only actual known absence can lead to another capture for the same approval ID.

Before dispatch, invalid or changed evidence leaves the publication held with no provider send. A new reviewed approval
may supersede such a held attempt; final duplicate guards prevent the old attempt from duplicating a newer pending or sent
publication. Ambiguous delivery retains the original intent and is observed without reauthorizing a different payload.
The independent publisher returns an existing exact receipt before applying new-dispatch freshness requirements.

Capture attempts are persisted before scanning. Timed-out or unknown captures retain their original IDs across retries
and restart. An observer timeout is not termination evidence and cannot cause a replacement capture while the original
is unquiet. Observation, cancellation and original local-quiescence reconciliation remain available through the existing
check evidence controls. A finished explicit retry can create a new capture, never replay the check command.

Mission acceptance rechecks mission revision, action/dependency status, ticket revision, required artifacts and selected
seals inside its synchronous transaction after the asynchronous capture. Concurrent mission edits refuse acceptance.
An identical committed request returns its original receipt without another capture. A result with no current file
artifacts requires explicit human-review acknowledgment, stored and displayed as human review without a host verification
claim. Person-owned actions require the existing result note. Operator-authored publication artifacts retain exact-content
approval and do not claim host checks. Legacy accepted publication receipts remain readable.

## Operator controls and bounds

The bilingual mission and publication forms show selectable original successful checks, check version, snapshot/Git
identity, completion time and actual confinement. Each required artifact needs a selection; changing selections clears
publication consent. Exact request IDs survive ambiguous client responses. Publication evidence exposes durable review
attempts and original capture receipts. The worker cannot supply check commands or fabricate approval seals.

Each approval supports 32 selected checks and eight distinct source snapshots, with 20 retained capture attempts per
review. The review journal holds at most 10,000 entries and 256 MiB of metadata. Mission discovery inspects at most 512
unarchived assignment artifacts and requires consolidation when there are more than 32 current outputs. Superseded and
archived outputs are excluded; stale/conflicting/expired current outputs remain required and cannot be approved with
invalid checks. The existing check execution, reservation and retention bounds still apply.

## Qualification and remaining scope

Tests exercise real local Harness subprocesses, exact check selection, all-artifact coverage, grouped captures, source
changes, concurrent mission edits, authority withdrawal, expiry, unknown-capture restart and duplicate-free publication
recovery against local HTTP provider contract servers. Rendered UI tests use actual management routes and real check
execution. Native Linux qualification covers confined checks, mission acceptance, publication and original receipts after
endpoint restart. The installed-Harness scenarios are extended to accept actual DeepSeek-produced artifacts using these
checks and to publish selected evidence through the independent service. Qualification results are recorded below after
execution; these scenario definitions alone do not establish a pass.

Exact remote PR-head binding, PR approval/merge, repository workflows, continuous freshness, whole-mission final capture,
retention/scaling and the remaining article implementation (`IMPLEMENTATION.md`) and [Agentic OS](010-agentic-os.md) scope
remain open. No new runtime or replacement for DeepSeek Harness is introduced.
