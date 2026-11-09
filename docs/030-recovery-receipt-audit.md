# 030 Recovery receipt audit

The held recovery workflow now compares authenticated checkpoint state with revision-bound inventories from every enrolled
execution endpoint and publication service. It finds original receipts, detects unknown or changed outcomes, and reports
effects absent from the checkpoint. It runs after [029 Recovery reservations](029-recovery-reservations.md), preserves the
execution hold and does not dispatch, resend, grant a lease or rewrite task/Session history.

## Consistent inventory contract

Both independent resource services expose an administrator-only `recovery.inventory` RPC. Its request contains `offset`
(initially zero) and an optional opaque `revision`. The first response supplies that revision. Every later page must use it,
including a final empty page at the reported total. Missing or changed revisions refuse continuation. The endpoint and
publisher each rotate the revision on restart and use SQLite triggers to change it atomically with every insert, update or
delete in their inventoried tables. Lease renewal changes endpoint grant rows, so it also invalidates an old inventory.

Pages contain at most 50 items, the total, exact next offset, resource identity/binding and a quiescence observation.
Items carry only kind, ID, original request hash, phase, settled status and applicable grant/ownership/result hashes.
They exclude command arguments, environment, process output, file-edit payloads, publication text and credential values.
The resources retain their existing read-only receipt APIs and explicit independent reconciliation commands.

| Resource | Inventoried records | Comparison |
| --- | --- | --- |
| Execution endpoint | Grants, commands and file mutations | Immutable world binding, original request fingerprint, grant/epoch, owner, known terminal phase and recorded command outcome |
| Publication service | Destinations and publication receipts | Normalized original publication intent, destination hash, recorded ownership attempts, known terminal phase and external receipt hash |

The source checkpoint includes both reviewed artifact publications and mission-channel replies. Publication intents and
external receipts pass through their shared schemas before hashing, so equivalent JSON field ordering does not create a false mismatch. World journals
are read directly through read-only SQLite connections; constructing a live world would change recovery state and is avoided.
A settled remote receipt can be observed even when its original acknowledgement was absent from the checkpoint. This is
recorded in the audit's observation count; the checkpoint's original effect history is retained.

The authority must remain vacant at the reservation's exact epoch and checkpoint selection throughout the audit. Any
acquisition attempt, changed reservation or resource enrollment invalidates the cut. All resources are collected first,
then each revision is revalidated, followed by the authority. Resource quiescence includes in-flight host calls and unknown
effects, not only process exit. A report describes that observed cut; future activation must revalidate it under its own
ownership and resource barriers.

## Held maintenance workflow

Use the offline maintenance profile from [023 Checkpoint recovery](023-checkpoint-recovery.md). Capture, verify, stage,
import Sessions and reserve the selected checkpoint before auditing. Keep the source coordinator, watchdog, sources and
execution-world providers stopped. The independent authority, endpoints and publisher must remain available. Their
administrator credentials must be private owned files outside every execution workspace recorded in the manifest.

```yaml
- insert:
    - id: recovery
      name: dsh-superagent/recovery
      config:
        mode: audit-receipts
        checkpoint: /private/backups/<checkpoint-uuid>
        keyFile: /private/recovery-keys/coordinator.key
        destination: /private/restores/selected
        receiptFile: /private/receipts/audit-first.json
        audit:
          authority:
            url: http://127.0.0.1:61000
            authorityId: <original-authority-uuid>
            coordinatorId: personal-agent
            credentialFile: /private/authority/admin.token
          endpoints:
            - url: http://127.0.0.1:62000
              endpointId: <original-endpoint-uuid>
              credentialFile: /private/endpoint/admin.token
          publication:
            url: http://127.0.0.1:63000
            serviceId: <original-publication-uuid>
            credentialFile: /private/publication/admin.token
```

Example loopback origins assume authenticated tunnels for other hosts. Supply every resource enrolled with the independent
authority, including unused resources. Include the original publisher whenever the checkpoint records it; omit it only if
the checkpoint has no publisher. Endpoint identities referenced by checkpoint worlds must be covered. Duplicate service or
resource identities and substitution of another authority/coordinator are refused. Existing grants and destinations without
checkpoint references are inventoried but are not themselves treated as unrecorded execution effects.

Run `dsh --profile maintenance --patch audit.yml --no-open`, then stop the maintenance host. The exported
`auditCheckpointReceipts` host helper exposes the same operation. No model tool or management HTTP mutation is added.
Use a new completion receipt path on each run or omit `receiptFile`. Read the report at `audit` in that receipt or through
`KV.recovery.audit` in the held Store. It includes the checkpoint digest, selection/generation, authority epoch, inventory
identities/revisions, comparison counts and bounded findings. The credential contents and original payloads never enter it.

Before network inspection, maintenance reauthenticates the encrypted checkpoint and compares the entire staged logical
database. Only the hold, reservation and audit metadata may differ. It also streams and checks every staged world and Session
member against its authenticated size/hash. The coordinator state lock stays held throughout. Once checkpoint validation
succeeds, a new audit writes `running` before contacting resources; a failed or cancelled collection replaces any older
matched report with the failed attempt. Validation failures do not modify the held database. Successful reruns replace the
latest report with a new audit ID and a new observed cut.

## Findings and recovery decisions

| Finding | Meaning |
| --- | --- |
| `unrecorded_effect` | Independent command, file mutation or publication absent from the checkpoint's original intents; this may be work after capture or work never journaled by the coordinator |
| `receipt_missing` | A checkpoint intent or required grant/destination lacks its independent record |
| `receipt_mismatch` | Request, grant, ownership attempt, terminal phase or known result differs |
| `effect_unsettled` | The original effect exists but its outcome/quiescence is unresolved |
| `resource_not_quiescent` | The service still has in-flight or uncertain work |
| `resource_missing`, `endpoint_missing` | The supplied connections do not cover all independently enrolled or checkpoint-referenced resources |

The report is `matched` only when there are no findings. `complete` requires full resource coverage and successful page/final
verification. A failed collection has phase `failed`, status `blocked` and `complete: false`; it is not partial clearance.
An original command definitively refused before dispatch may have no endpoint receipt. An exactly acknowledged, quiescent
world revocation can match its disabled successor grant epoch without authorizing that successor. Changed command exit
results and publication external receipts remain conflicts. Settled status accounts for quiescence and explicit independent
reconciliation; it does not assert that a command or task succeeded.

Unknown publication outcomes require existing independent `receipt.observe` or administrator reconciliation, followed by a
fresh audit. Audit itself never contacts the external provider or sends a message. Missing, conflicting and unrecorded effects
require investigation or a newer complete checkpoint; they are not automatically discarded, attributed to another task or
replayed. Do not delete independent receipts to make an old checkpoint pass.

Each service inventory is capped at 50,000 records. An audit accepts at most 256 endpoint connections and 100,000 total
checkpoint/remote items per side, keeps at most 1,000 finding details while retaining the full finding count, and has a
120-second cancellation deadline. Exceeding a collection bound fails the audit. Large-store throughput, archival and retention
need separate qualification; the caps are explicit limits rather than a claim of unbounded scale.

## Acceptance and remaining work

Deterministic tests use real endpoint and publisher HTTP with local provider contract servers. They cover matching receipts,
missing acknowledgements, late effects after capture, private payload exclusion, administrator scope, exact revoked worlds,
missing/changed records, incomplete coverage, unknown outcomes and later observation, revision races across pages, restart,
changed ownership, cancellation, service failure and tampered staged members. The installed-Harness qualification runs
repeated audits on real dedicated and managed model checkpoints. Its independent publication probes intentionally create
effects absent from coordinator history; the report must block those rather than silently accept them.

Qualification results are recorded after local, actual-model and native Linux checks complete.

This implements receipt inventory and comparison. Applying observed outcomes to executable state, reconciling administrative
command history and credential configuration, validating actual restored Session backends, world/workspace remapping, and
the activation transition remain required. Neither these inventories nor periodic checkpoints prove that no later input or
in-memory decision was lost; that needs an authoritative input/state recovery contract. A matched audit does not prove a
checkpoint is the latest state and does not remove the hold. Clean-host activation/failover, crash-boundary drills and all
remaining article and Agentic OS ledger capabilities remain active work.
