# 034 Execution configuration during recovery

Receipt history does not establish that a stopped coordinator still has usable execution credentials. A valid public
credential catalog can also outlive a deleted or altered private vault file. [Receipt audit](030-recovery-receipt-audit.md)
and [held preparation](031-recovery-receipt-preparation.md) now check the original execution configuration for every world
that has no original revocation intent. Worlds exempted by an intent still require the independent proof specified in
[revocation recovery](033-revocation-recovery.md); a missing proof keeps recovery blocked.

## Credential selection

Managed worlds use the authenticated coordinator catalog's endpoint connection, credential-file path and original private
credential pin. The catalog must match the journal's immutable world binding and local enabled/revocation state. A missing
journal or contradictory revocation state is refused. A saved grant credential cannot be silently replaced by a different
value, even when the supplied file is otherwise well formed.

Dedicated worlds supply `audit.worlds` entries to `audit-receipts` and `prepare-receipts`:

```json
{
  "binding": "<original 64-character world binding>",
  "endpointId": "<original endpoint UUID>",
  "url": "https://execution.example",
  "credentialFile": "/private/operator/original-grant.token"
}
```

An entry can also select a relocated copy of a managed world's original credential. The original private pin still applies.
Inputs must identify unique worlds present in the authenticated checkpoint. They cannot add an environment, replace a grant
or change a Session's world. This checks connection material; it does not rewrite stored runtime paths or perform remapping.
Endpoint administrator connections remain in `audit.endpoints`; a workspace grant cannot substitute for them.

Every selected grant file must be an absolute, stable, private regular file owned by the coordinator user, with no symlinks
or extra hard links. It must remain outside execution workspaces. Its content is pinned in memory and rechecked after the
remote observation. File contents and private digests are never added to the audit, maintenance completion receipt or prepared
manifest. The credential itself is sent only as authentication to its pinned endpoint, never as an RPC body or model input.

## Read-only endpoint proof

`recovery.world` accepts the exact inventory revision and requires the original workspace grant credential. Administrator
credentials cannot provide this proof. The endpoint authenticates the grant principal, requires the same enabled and
unexpired generation, and verifies that filesystem reads and process execution remain authorized. No ownership lease is
acquired or renewed. An expired grant requires explicit resolution; recovery cannot manufacture replacement authority.

The endpoint verifies the original root identity and canonical path, then each selected private credential snapshot. The vault must remain an
owned private directory with no symbolic links. Each snapshot must be a stable private regular file with no links, match
the catalog's private integrity digest and retain its original public version/variable/mode binding. Temporary byte buffers
are cleared after verification. Normal command mounting now uses the same verification routine.

The response contains only public endpoint/grant metadata and successful root/private-binding verification flags. It excludes
vault paths, credential values and private digests. The caller checks endpoint identity, ownership authority/resource binding,
qualified Linux confinement, paired-provider capabilities and the full original world binding. The endpoint rechecks inventory
revision after asynchronous file reads and requires the resource to be quiescent.

## Fresh observations and held images

Audit checks execution credentials after collecting the independent inventories and repeats successful checks before its
final revision/ownership verification. Missing connections produce `configuration_missing`; mismatched bindings produce
`configuration_mismatch`; unavailable private files, credentials, roots or grants produce `configuration_unavailable`.
Transport/protocol failures fail the audit. None of these outcomes authorizes retrying work or changing credentials.

Preparation performs the checks independently and repeats them before image publication. This repetition matters because
raw credential-file changes do not increment SQLite inventory revisions. A changed file aborts preparation and removes the
unfinished image. The original source remains held and unchanged. An authenticated image records only the checked world
and public credential-binding counts in `executionConfiguration`.

The optional manifest field preserves verification of older images. Original-ID preparation retries still return their
original authenticated image, rather than pretending to perform a new validation. Any later activation must freshly validate
private files, resource revisions and authority; this evidence is a point-in-time observation, never a reusable execution
permit. Both source and prepared holds remain enforced.

Confirmed revoked worlds can retain historical private bindings whose files have been removed. They stay revoked and are
not included in active execution-credential counts. An active world sharing a credential still needs its own successful check.

## Acceptance and remaining scope

Tests use synthetic credentials and real HTTP. They cover original grant authentication, administrator-role refusal, private
payload exclusion, missing/duplicated/unrelated selections, managed private pins, missing/changed/linked or public files,
workspace exposure, expiry, vault changes without catalog revision changes, changes after audit and during preparation,
source holds and retired credentials for independently revoked worlds. The installed-Harness managed scenario retains an
active credential-bound world while reconciling two revoked worlds, including one lost acknowledgement.

This establishes private execution credential integrity and original execution bindings. It does not prove external service
account permissions or validate all inference, connector, publication and ownership-claimant configuration. Those checks,
authoritative input/state recovery, actual Session-backend validation, stored path remapping, restored activation and clean-host
failure qualification remain open in the full article and Agentic OS ledgers.

The focused recovery/credential run passed 80 tests with one native opt-in case skipped. Full local checks passed; installed-Harness
and native Linux qualification are pending.
