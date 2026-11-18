# 023 Checkpoint recovery

This increment implements offline encrypted checkpoints and staged recovery on top of the existing coordinator Store,
Harness Session persistence and execution-world journals. It preserves the boundaries in
[018 Execution ownership](018-execution-ownership.md) and [022 Managed worlds](022-managed-worlds.md).
A staged coordinator refuses startup. Importing its Sessions does not remove that hold or grant execution ownership.
Distributed ownership, endpoint fencing, receipt reconciliation and activation are still required before failover is supported.

## Capture contract

Stop the coordinator, its worker agents, source writers, watchdog interventions and every dedicated or managed world provider
that owns the selected journals. The maintenance profile loads the same Harness Session-persistence backend and root but no
coordinator or execution-world plugin. Capture acquires the coordinator state lock, every selected world lock and all selected
Session writer handles before exporting any data. The maintenance host must load the same compatible Session-event schemas
as the source host, including plugin events. Older or minimal readers refuse unknown non-ignorable events. It refuses an active owner. Locks use the existing local cooperative
single-writer mechanism; they are not distributed leases. A custom persistence backend must enforce writer exclusion across
all processes that can access its data. An in-process-only write handle cannot establish that property on its own.

The capture includes:

- A SQLite backup of the entire coordinator database: tasks, assignments, input/effect queues, artifacts, knowledge,
  environment registrations, management receipts, persona versions and their immutable references.
- Each managed world journal and explicitly supplied dedicated world journal, including authority generation, revocation
  intent/acknowledgement and original execution receipts. An unresolved receipt remains unresolved.
- Logical exports of the main Session, worker Sessions, Sessions named by trusted execution receipts and their transitive descendants through Harness's public persistence
  API. Each export contains the immutable header, exact inherited-prefix count, contiguous events, event count and digest.
- An authenticated manifest connecting these members, their digests and world identities, with known workspace paths and
  managed endpoint/grant credential-file requirements. Missing referenced Sessions or worlds make capture fail.

A task rejected before its Session was created need not have a Session. Persisted prompt, delivery, idle or report evidence
requires its recorded history. The main Session is always required. Capture does not run a model or repair Session semantics.

SQLite backups use the database API, including committed WAL state. Session exports read held handles in 128-event pages.
The completed checkpoint directory appears by atomic rename after every encrypted file, envelope and directory is synced.
Writer handles close before outer locks are released. Failed captures do not publish a completed checkpoint directory.

## Encryption and storage

Each member and the manifest use AES-256-GCM with independent random nonces and authenticated checkpoint/member identities.
SHA-256 digests and exact byte lengths are authenticated inside the encrypted manifest. The public envelope contains only
format version, checkpoint ID and encrypted-manifest authentication metadata. The 32-byte random key is a separate private
file encoded as 64 lowercase hexadecimal characters. `createRecoveryKey(path)` refuses to replace an existing key file.
Keep it outside coordinator state, backup output and registered execution workspaces; retain it separately from backups.

All members and key files must be owned, private regular files without additional hard links. Stream inputs refuse symlinks
and special files. Output directories are private. Plaintext scratch data stays in private OS temporary directories outside
the backup output; normal success, error and cancellation paths remove it. A process or host crash can leave private scratch
data behind. Use encrypted local storage and an operator cleanup/retention policy; deletion is not a secure-erasure guarantee.
No key management service or off-host backup transport is supplied by this increment.

The checkpoint contains neither raw execution-workspace contents nor endpoint daemon databases/process state. It also omits
inference credentials, provider configuration, credential-file contents, private keys and application installation files.
Session history or stored artifacts may themselves contain sensitive text, which is why the entire checkpoint is encrypted.
The required-file inventory is not exhaustive for dedicated profiles or provider setup. Preserve the operator's profile,
credential inventory, endpoint state and workspace snapshots through their own documented recovery procedures.

## Operator workflow

The host-only entry `dsh-superagent/recovery` supplies four modes. It exposes no model tools or management HTTP mutation.
Use a separate maintenance profile with source adapters, coordinator, watchdog and execution-world providers disabled.
Its Session backend must point to the stopped source backend for capture. The JSONL backend is the qualified implementation;
other backends use the same public interface but need their own deployment qualification.

An overlay for the maintenance profile can add:

```yaml
- insert:
    - id: recovery
      name: dsh-superagent/recovery
      config:
        mode: checkpoint
        stateDir: /private/operator/coordinator
        outputDir: /private/backups
        keyFile: /private/recovery-keys/coordinator.key
        worldDirectories:
          - /private/operator/dedicated-world
```

These paths are examples. Generate the key once through the exported `createRecoveryKey` helper from an installed bundle,
and keep its parent directory private. Run the maintenance profile with `dsh --profile maintenance --patch recovery.yml --no-open`.
Set optional `receiptFile` to a new absolute private path for a durable completion record (mode, checkpoint ID, time and
`executionOwnership: false`). It contains no key or Session contents. Stop the maintenance host after its receipt or
completion log before changing modes. Do not load the normal coordinator into this profile.

| Mode | Required configuration | Result |
| --- | --- | --- |
| `checkpoint` | `stateDir`, `outputDir`, `keyFile`; dedicated `worldDirectories` when applicable | Publishes `outputDir/<checkpoint-id>` |
| `verify` | `checkpoint` directory, `keyFile` | Authenticates every member, SQLite integrity, references and complete Session histories |
| `stage` | `checkpoint`, `keyFile`, absolute `destination` | Publishes a new private directory with a persistent execution hold; existing destinations are refused |
| `import-sessions` | `checkpoint`, `keyFile`, matching staged `destination`; maintenance backend set to the recovery Session root | Imports history through Harness and retains the hold |

Stage verifies everything before exposing its destination. It restores the coordinator database as `orchestrator.sqlite`,
keeps world and Session members under the manifest's filenames, and writes `restore-manifest.json`. Original paths and world
authority are not silently remapped. A staged directory is for recovery inspection and later reconciliation, not a runnable
replacement installation. Runtime rejects its hold before constructing any environment, worker or effect dispatcher.

Session import requires the matching held coordinator under its state lock. It never overwrites or truncates destination
history: immutable metadata must match, existing events must be an exact prefix, and newer/divergent histories are refused.
The documented absent/zero delegation-depth default is equivalent; other header differences remain conflicts. A private
snapshot is fully validated before any Session mutation. Interrupted exact-prefix imports can be retried. The inherited fork
prefix and its boundary enter the backend in one append, so import memory scales with that prefix plus one normal event
page; ordinary tails use 128-event pages. The backend must provide its own atomic append/durability guarantees. A successful
import still leaves the coordinator held and performs no execution or remote command replay.

## Qualification and remaining work

Deterministic tests use the official JSONL backend and real remote HTTP execution. They cover encrypted round trips,
transitive Session selection, active-owner refusal, cancellation, digest/framing corruption, wrong keys, symbolic links,
partial/exact imports, fork prefixes spanning pages, conflicting/newer history, missing task/receipt references, and preservation of
settled/pending receipts and revoked authority. The opt-in installed-Harness qualification extends real configured-model
missions with maintenance-plugin capture, verify, stage and two imports into a fresh backend, while retaining the hold.
Qualification on 2026-11-08: code commit `aef82a2ce95666a58cd7892487d3bb3e0ab35175` passed local `pnpm check`:
1,386 tests, typechecking and all four builds; five cases were skipped locally, including two opt-in model cases.
Those two cases passed separately against Harness 0.2.1-rc.3 and `deepseek-official/deepseek-flash` in 139.87 seconds.
Both dedicated and managed deployments completed real missions, stopped their coordinator, captured their real Session and
world state, verified and staged the checkpoint through the installed Harness loader, and imported Sessions twice into a
fresh backend. Managed qualification included child-owned execution receipts and independently revoked authority. Each
restored coordinator retained its execution hold. The private maintenance completion receipts, not stdout, signaled success.

The same code passed [Linux run 42531703951](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42531703951):
1,388 tests, typechecking and all four builds on Ubuntu 22.04/Node 24 with native confinement enabled. Three cases were
skipped, including the separately qualified model cases. This is evidence for checkpoint/staged import and existing native
confinement; it is not evidence for a running clean-host failover or distributed ownership transfer.

Remaining requirements in the full implementation plan include an authoritative ownership handoff and epoch protocol,
endpoint and publication fencing against stale coordinators, original-ID receipt reconciliation, workspace/endpoint recovery,
configuration and credential remapping, clean-host activation, crash injection at dispatch boundaries and failover drills.
The current local filesystem locks do not prevent two restored copies on different hosts from attempting ownership.
No activation command exists until those checks can be enforced. Do not remove the hold manually to simulate recovery.
