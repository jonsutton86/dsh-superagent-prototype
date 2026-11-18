# 055 Mission, plan and schedule authority in held recovery

Prepared recovery images now verify persisted mission, plan and scheduling authority after the core Engine and connector
checks, before signing the private image. Verification is read-only: it neither dispatches work nor reviews a proposal,
advances a cursor, grants ownership or removes the restore hold.

## Original plan authority

Each mission must retain contiguous plan history and a current definition matching its latest snapshot. Approved proposals
must link reciprocally to the applied version. The original proposed instructions and dependencies must match the applied
plan after the host's action-ID remapping; existing action IDs remain stable. Pending and rejected proposals remain
candidates. Worker authors retain their original mission ticket and stable Harness Session identity, even when a later
approved plan removes the original action.

New plan snapshots record every action's definition revision, and new workspace dispatch/follow-up Triggers record their
plan version. Recovery checks the exact recorded version, action revision, persona, environment and PR binding. This is
necessary because removing an already-absent PR binding can invalidate an action without changing its logical plan text.
Unrelated plan edits still do not revoke unchanged running actions: normal runtime authorization retains its existing
definition-revision checks. Historical snapshots without the new stamps remain unchanged and are counted as legacy
evidence; the validator does not invent the missing exact historical revision proof.

Accepted workspace tickets must retain explicit operator authority, their original Trigger metadata and approved direct-run
instructions. Current action run lists must reference the correct original tickets. Removed actions remain represented by
their historical plans and core tickets. Explicit human follow-ups may be handed back and routed to separate tasks; these
retain their original workspace thread and are counted separately from direct action runs and scheduled dispatches.
Filtered or unauthorized observations cannot become accepted workspace execution authority.

## Schedule preservation

Schedules and their immutable configuration snapshots must have contiguous revisions. Each occurrence retains its original
enabled snapshot, cadence point, deterministic identity, mission origin and exact first mission plan after action-ID
remapping. Skip ranges and run reservations form an unbroken sequence from that revision's original cursor. The checker
rejects gaps, overlaps, changed run counters, exceeded original run limits and substituted next-run cursors. It handles
one-time exhaustion, interval schedules, named-zone calendars, missed-run policies and pause/resume without consulting the
current wall clock or dispatching missed work.

Old occurrences continue to use their original configuration after a schedule edit. Reflection plans retain the saved
operator-authorized template instead of being regenerated from today's code. Configuration command receipts retain their
original referenced mission, schedule or proposal and bounded request fingerprint. These receipts are checked for recorded
consistency; their original request bodies cannot be reconstructed from a fingerprint alone.

## Signed evidence and limits

The optional `workspaceState` version 1 records inspected records, mission/action/plan/proposal counts, schedule/version/
occurrence counts, total/routed/scheduled execution counts, legacy evidence counts and a SHA-256 digest of inspected rows.
It contains no instructions, message bodies or credentials. Older image manifests remain authenticatable without acquiring
verification evidence they never contained. Original-ID preparation retries return the same authenticated held image.

The scan yields to cancellation and refuses more than 250,000 inspected records, 128 MiB of serialized values, 8 MiB per
JSON record or two million checked relations. These are validation limits, not demonstrated deployment capacity. Failure
removes the unpublished private image; source/staged product state and the execution hold remain unchanged apart from the
existing preparation-intent bookkeeping.

This check covers recorded mission/plan/schedule authority. Artifact/check evidence, completion records, reflection results,
library/persona/environment graphs and other product extensions retain their existing runtime checks but are not fully
reconciled here. It does not establish deployment binding/remapping, restored activation, ownership handoff or clean-host
failover. Those and the remaining full architecture/product requirements stay open.

## Qualification

Focused tests use actual Workspace, Planning, Schedules and Engine transactions. They cover worker-authored plan
replacement, historical removed actions, definition invalidation without text changes, pending/rejected proposals, human
follow-up routing, all missed-run policies, pause/resume, configuration edits, one-time and DST calendar cursors, missing
reservations, substituted approvals/mandates, legacy stamps, cancellation and bounded failures without state mutation.
Checkpoint pipeline tests require signed nonempty mission/schedule evidence, original-ID retry and cleanup after an
authentic checkpoint contains contradictory product authority. The installed-Harness recovery fixture requires nonempty
mission/schedule/execution evidence and zero legacy stamps from its actual managed workload.

Local verification passed 1,884 tests (14 conditional skips), typechecking and all six builds. Runtime/test revision
`4079a49df726133256143adbafc4fe7ad4973418` passed 1,891 tests (eight conditional skips), typechecking and all six builds on
Linux / Node 24 with native confinement in
[run 42664952945](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42664952945).
The same revision passed the installed-Harness / DeepSeek Flash owned-managed recovery scenario in 195.68 seconds. Its
signed prepared image contained nonempty mission, schedule and scheduled-execution evidence, with zero legacy plan or
Trigger stamps. Original-ID retry retrieved the same authenticated held image. Inference used the configured real API;
external provider operations stayed on local contract servers. The original app remained running. These results qualify
held product-authority verification, not restored activation or completion of the full architecture/product objective.
