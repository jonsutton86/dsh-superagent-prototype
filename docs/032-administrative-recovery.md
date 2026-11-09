# 032 Administrative recovery and credential bindings

The [receipt audit](030-recovery-receipt-audit.md) and [held preparation](031-recovery-receipt-preparation.md) now include
the coordinator's original endpoint-administration commands. Recovery can confirm a command whose acknowledgement was lost,
without resending that command, creating a grant, changing a credential or obtaining a grant token. Active execution worlds
also require their original credential bindings to remain enabled at the independently stored versions.

## Independent observation

Execution endpoints expose administrator-only `recovery.administration`. The request supplies the exact inventory revision,
original command ID, action and original endpoint request fingerprint. The endpoint checks that revision and reads the
existing `remote_receipt` row. A missing row is reported as absent; a changed fingerprint is refused. The response contains
the resource identity, quiescence, historical result and safe current resource metadata. It never returns grant tokens,
credential values, private credential digests, process arguments/environment/output or file-edit content. It does not require
an active coordinator lease because it cannot dispatch an operation.

The action selects the expected result type; it does not grant execution authority. Existing historical grant receipts
identify the original grant, credential receipts retain the original public catalog record, and cancellation/reconciliation
receipts identify their original command or file mutation. Current metadata is checked separately from that historical
receipt. Normal administrator RPC retries can return current metadata; recovery must not treat a later resource generation
as the result originally authorized by an earlier request.

Every mutation of `remote_receipt` now changes the endpoint's inventory revision. This includes lifecycle receipts that are
not emitted as inventory items, so frequent lease-renewal receipts do not consume inventory-page capacity. Recovery looks up
only the original administrative intents present in the authenticated coordinator state. Existing stored receipt rows work
without migration or reconstructed history. A source command is bounded by the same 100,000-item checkpoint audit limit.

## Reconciliation outcomes

| Original action | Required evidence | Prepared coordinator behavior |
| --- | --- | --- |
| `grant.create`, `grant.change` | Exact request fingerprint, original grant ID, authorized epoch, owner/workspace, root identity, operations and credential references | A confirmed historical result is preserved. A pending command whose grant is still at the authorized generation becomes `recovered`; private credential validation remains required. A later generation makes the old command `superseded`, without copying that replacement into the original result. |
| `credential.import`, `credential.revoke` | Original public credential record, requested ID/revision and import variable/mode or revocation status | The historical result becomes `done` if it still matches the current catalog, otherwise `superseded`. A newer version is never substituted for the original result. |
| `job.cancel` | Original job ID, recorded cancellation and confirmed quiescence | The original command becomes `done` using safe job metadata. |
| `job.reconcile`, `operation.reconcile` | Original target ID and matching independent reconciliation evidence; command quiescence where applicable | The original command becomes `done`; no reconciliation is submitted again. |
| Definite original refusal | No independent receipt under that original request | The refusal remains. A contradictory committed receipt is a mismatch. |

Missing uncertain receipts produce `administration_missing`; conflicting requests, results or reconciliation evidence produce
`administration_mismatch`. Either blocks a matched audit and therefore blocks preparation. Transport/protocol failures fail
the whole audit. Observations also check the exact resource identity/revision and quiescence. Final revision/authority checks
still run after all observations, both in audit and immediately before prepared-image publication.

Prepared rows retain the original request, enrollment binding, previous grant and ownership metadata. A small recovery record
records the observation time, inventory revision, request fingerprint and original phase. Only the separate prepared copy
changes; the staged source remains available for comparison and original-request retries. Source commands already marked
`superseded` are never revived. The `recovered` phase is visible in the endpoint panel, has no resend action and cannot compose
a profile or activate a world. It requires a later private-credential recovery step; it does not imply usable authority.

## Active-world credential configuration

Endpoint inventories now include credential catalog IDs, enabled/disabled status and hashes of public version bindings
(`id`, `version`, `variable`, `mode`). The private value and its digest are excluded. Credential catalog writes also invalidate
the inventory revision. For every world not durably revoked, audit compares each original binding against an enabled matching
catalog entry. Rotation or revocation after capture blocks the audit even when the grant record itself is unchanged.

A durably revoked world can retain historical bindings without requiring their continued availability. It remains revoked
and cannot be activated by receipt preparation. This check verifies catalog versions and status. Actual private-vault file
integrity, account permissions, replacement coordinator files and runtime configuration still require validation before an
activation transition; receipt comparison does not claim that those checks have happened.

## Operator workflow and compatibility

The existing `audit-receipts` and `prepare-receipts` maintenance operations perform these checks automatically. Supply the
same original checkpoint, held destination, full resource catalog and reviewed original IDs as before. There is no new
approval that implicitly authorizes resending an administration command. Resolve a missing/conflicting original receipt
through investigation or a newer complete checkpoint; do not manufacture a receipt or replay uncertain administration
to make an audit pass.

New prepared-image manifests authenticate an `administration` summary with `verified`, `recovered` and `superseded` counts.
Older signed images remain verifiable without that optional field, but their absence of administrative evidence is not
clearance for future activation. An original-ID retry returns its original authenticated image, not an upgraded result.
Use a separately staged and audited recovery when a new preparation is required. Endpoint restart invalidates older resource
revisions, as before. The complete source and prepared execution holds remain in place.

## Acceptance and remaining work

Tests use real endpoint HTTP and synthetic private credentials. They lose acknowledgements after actual commits for all seven
administrative actions, then verify historical reconciliation, later grant/credential replacement, definite refusal,
source preservation, no additional administrative effects, administrator scope and private-payload exclusion. They also
exercise missing/changed receipts, changed reconciliation evidence, receipt-only revision invalidation and active-world
credential rotation/revocation. The installed-Harness managed recovery verifies its original administrative command count
and prepared records alongside command, publication, world and Session coverage.

The full article and Agentic OS ledgers remain active. Private credential/runtime configuration validation, authoritative
input/state recovery, pending world-revocation acknowledgement recovery, actual Session-backend validation, world/workspace remapping, restored activation and clean-host
crash/failover qualification remain required. This step reconciles administrative history and public credential bindings;
it does not prove that no later operator input or in-memory decision was lost.

Local verification on 2026-11-08 passed 1,504 tests, typechecking and all four builds, with seven opt-in/platform cases
skipped. The recovery audit/preparation suite covers 36 cases. Final installed-Harness and native Linux qualification
results are recorded after those checks finish.
