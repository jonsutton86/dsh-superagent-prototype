# 029 Recovery ownership reservations

A held checkpoint can now reserve replacement acquisition authority through the independent ownership service. Reservation
invalidates the original installation's reusable claimant credential, including after later process leases end. It binds the
replacement to one authenticated checkpoint ID and manifest digest. It retains the execution hold from
[023 Checkpoint recovery](023-checkpoint-recovery.md); this is a prerequisite for activation, not a running restore.

## Ownership contract

Process lease epochs and recovery claimant generations serve different purposes. Lease epochs increase each time a process
acquires ownership. A recovery generation changes the credential allowed to acquire those leases. Ordinary expiry or release
cannot permanently exclude an old installation that still holds its original claimant credential.

The authority adds two administrator-only operations:

| Operation | Contract |
| --- | --- |
| `coordinator.inspect` | Read current lease epoch, phase, resources and optional recovery selection without a claimant credential |
| `coordinator.recover` | Stable `requestId`, coordinator `id`, reviewed vacant `epoch`, current claimant `generation`, and `selection: { checkpoint, digest }` |

The first recovery generation is 1; a coordinator that has never been reserved has generation 0. Reservation requires vacant
ownership at exactly the reviewed epoch and claimant generation. It cannot interrupt an active or preparing owner. Its
transaction replaces the claimant nonce, persists the exact selection and original request receipt, and clears old owner and
resource acknowledgements. The response derives a replacement credential in memory; authority receipts store no credential.

The original claimant immediately loses acquisition and inspection access. An administrator can still inspect the coordinator.
Existing resource credentials remain valid, and a future owner must pass the full resource drain/acknowledgement barrier in
[024 Ownership fencing](024-ownership-fencing.md). Reservation itself grants no process lease or execution proof. A current
process client also compares the authority's selection against its persisted recovery metadata before accepting a lease.
An unreserved installation given a replacement credential cannot silently adopt the authority's selected checkpoint.

The authority trusts its administrator's checkpoint assertion. Authentication and database comparison happen in the trusted
maintenance host; this protocol is not remote attestation of arbitrary host code. Keep administrator and replacement files
outside execution workspaces. The authority remains a single independent writer, not a replicated consensus service. Its
state and signing key must not be rolled back or cloned into competing servers.

## Maintenance workflow

Use the existing offline maintenance profile with the same compatible Harness Session-event catalog. Disable coordinator,
watchdog, source writers and execution-world providers. Upgrade the authority, coordinator and enrolled resource software
before using reservations: older strict protocol readers may refuse the new selection field.

1. Stop the source installation and capture, verify, stage and import Sessions as documented in
   [023 Checkpoint recovery](023-checkpoint-recovery.md). Keep the staged directory private and held.
2. Use `OwnershipClient` from the host-only `dsh-superagent/ownership` entry with the independent authority's private
   administrator credential to call `coordinator.inspect`. Review vacant ownership, its epoch and recovery generation.
   A live owner must stop or expire; do not remove resources to bypass their later acknowledgement barrier.
3. Generate and retain one request UUID. Run `reserve-ownership` with the same authority/coordinator identity recorded in
   the source checkpoint and the exact inspected counters. Credential paths below are illustrative and must be private.

```yaml
- insert:
    - id: recovery
      name: dsh-superagent/recovery
      config:
        mode: reserve-ownership
        checkpoint: /private/backups/<checkpoint-uuid>
        keyFile: /private/recovery-keys/coordinator.key
        destination: /private/restores/selected
        receiptFile: /private/receipts/reservation-first.json
        reservation:
          requestId: <stable-request-uuid>
          epoch: 7
          generation: 0
          authority:
            url: http://127.0.0.1:61000
            authorityId: <original-authority-uuid>
            coordinatorId: personal-agent
            credentialFile: /private/authority/admin.token
            timeoutMs: 5000
```

Run `dsh --profile maintenance --patch recovery.yml --no-open`, then stop that maintenance host after completion. For a retry,
preserve all reservation parameters; use a new receipt path or omit `receiptFile`. The completion receipt includes safe
reservation metadata and `executionOwnership: false`. It contains no replacement token. This mode exposes no agent tool or
management HTTP mutation. Invoking it deliberately revokes the old installation's acquisition authority; there is no automatic
rollback to that credential.

Under the staged writer lock, maintenance fully authenticates the encrypted checkpoint and compares every logical SQLite
table, schema definition and row ordering against the staged database. Only the restore hold and reservation metadata are
excluded. Extra inputs, changed tasks, queued effects and altered bindings are refused before authority mutation. The hold
must still identify this checkpoint, and the recorded independent authority/coordinator identity must match. Comparison reads
rows incrementally and includes SQLite full-text shadow tables; it does not depend on WAL file byte layout. Large stores
still need their own performance qualification.

Before the remote call, maintenance persists the complete immutable request with phase `requested`. After the committed
response it verifies the authority's current selection, publishes `recovery-claimant.token` as a private, synced file in the
staged directory, and records phase `reserved`. The record contains only the file path, counters, identities and digest.
This credential must remain with the selected recovery installation. No runtime profile is rewritten and no hold is cleared.
Moving a staged directory after recording its reservation is refused; credential-path remapping needs an explicit later workflow.

## Failure and retry behavior

- A transport timeout, cancellation, authentication problem or failed credential-file publication leaves the original intent
  retryable. Retry that same request even if its original counters are now behind the authority. A committed receipt replays
  before checking present counters, returning the original credential and selection without another rotation.
- Only an explicit `recovery_changed` or `generation_exhausted` refusal permits replacing the local intent with a newly reviewed
  request ID. Authentication failure cannot prove an earlier ambiguous request did not commit. Changed payloads under the
  same ID are always refused.
- Competing staged copies at the same reviewed counters cannot both reserve. A later explicit administrator reservation
  supersedes the prior credential. Replaying an earlier request still returns its original generation; maintenance refuses
  to publish or adopt it when inspection shows a newer selection. It never substitutes the newest credential silently.
- A pre-existing replacement file is refused before a first reservation. After an ambiguous committed request, a conflicting
  file keeps the restore held; establish the file's origin before resolving the conflict and retrying the original request.
- Authority restart preserves the reservation and invalidates any live process leases. Current selection checks and all
  resource barriers still apply. Every failure leaves the staged execution hold intact.

## Acceptance and remaining architecture

Deterministic tests exercise real ownership HTTP, administrator scope, occupied/stale counter refusal, old claimant
invalidation, original receipts across restart and supersession, competing restores, database tampering, credential-write
failure, ambiguous response followed by authentication failure, cancellation and selection-aware process acquisition behind
the unchanged resource barrier. The installed-Harness scenarios also reserve and retry their real model-generated checkpoints
through the maintenance plugin, preserving imported Sessions and the hold while rejecting the source claimant.

Qualification results are recorded after the local, actual-model and native Linux checks complete.

Activation still requires reconciling independent execution and publication inventories, detecting effects or inputs newer
than the checkpoint, validating imported Session/world state, explicit configuration and credential remapping, endpoint and
workspace recovery, and a durable activation transition followed by clean-host failure drills. A reservation proves neither
that all external receipts are known nor that an older checkpoint is safe to resume. Do not remove the hold manually.
All remaining article and product requirements in the implementation ledger remain active.
