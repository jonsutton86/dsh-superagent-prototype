# 036 Control credentials and publisher configuration

[Execution credentials](034-execution-configuration-recovery.md) and [destination Session history](035-session-backend-recovery.md)
do not prove that a restored coordinator can authenticate to its ownership authority or publisher. Receipt audit and held
preparation now verify those control credentials separately. They also check the publisher's pinned provider account and
destination access without sending a message or acquiring a coordinator lease.

Upgrade the maintenance bundle, independent ownership authority and publication service together before using these checks.
An older authority or publisher that does not implement the new read-only operations cannot qualify recovery; maintenance
refuses its unsupported response instead of treating it as valid configuration.

## Reserved claimant proof

`recovery.claimant` is a read-only ownership operation restricted to the current recovery claimant. Administrator, resource
and lease credentials cannot substitute for it. An original pre-recovery claimant or a superseded recovery generation is
refused. The authority returns its public ownership view and does not create an intent, advance an epoch, acquire or renew
a lease, or acknowledge any resource.

Recovery uses the replacement private credential already published by the selected reservation. Its view must match the
authenticated checkpoint selection, generation, vacant epoch, coordinator and complete independently audited resource set.
The private file remains outside all recorded execution workspaces and world roots; stable private ownership, no links and
an in-memory content pin are required. File state is checked again after the asynchronous authority response.

## Coordinator publisher selection

`audit.publication` remains the independent administrator connection for receipt inventory and reconciliation. The
coordinator connection defaults to that service's origin and the credential-file path in the authenticated
`KV.runtime.publication` binding. It must authenticate as the publisher's client role. A valid administrator token cannot
serve as runtime client proof.

When a credential has moved, or an older checkpoint lacks the private path, supply an explicit `audit.publicationClient`:

```yaml
publicationClient:
  url: https://publication.example
  serviceId: <original-publication-service-uuid>
  credentialFile: /private/operator/publication-client.token
```

The service identity, ownership resource binding and audit revision still have to match. This selects connection material;
it does not rewrite stored runtime configuration. The explicit selection is bound into a preparation request's fingerprint.
Only the original selection can be retried under that request ID. Client credentials receive the same private-file and
workspace-exclusion checks as the claimant credential. A coordinator with no publisher needs only the claimant proof.

## Provider preflight without delivery

The client-only `recovery.destination` operation selects an exact configured destination hash and inventory revision. The
publication service requires quiescence, runs its provider preflight, then rechecks the inventory and quiescence. A revision
change or new unsettled work invalidates the observation. Responses include only public resource/destination identities,
revision and successful account/target check flags; credentials, paths, provider diagnostics and message contents are absent.

Recovery checks the publisher's complete configured destination catalog, bounded to 100 entries. Each provider implements a
dedicated `check` method sharing the preflight used by normal publication. GitHub verifies the configured login and reads
the pinned issue or review root. Feishu/Lark obtains an in-memory tenant token, verifies the configured bot and reads the
pinned root message in its chat. Token exchange is an authentication request; there is no reply/comment creation request,
publication intent or `send` closure in the recovery path. Providers recheck their private credential file after preflight.
Adapters without configuration checking are refused during recovery.

These checks establish account identity and target readability. They do not prove a future write will be accepted, reserve
provider permissions or validate inference/source connectors. Actual delivery still performs its own preflight, ownership
verification, one send and durable outcome handling. A provider can revoke access after any successful observation.

## Audits, held images and retries

Audit records safe `configuration_missing`, `configuration_mismatch` or `configuration_unavailable` findings with
`kind: configuration` and `id: claimant` or `publication`. It repeats successful checks before final inventory and authority
validation. Transport/protocol failures fail the audit; they cannot be interpreted as valid configuration.

Preparation independently verifies control configuration and repeats it immediately before final resource/Session checks
and image publication. Missing files, changed accounts, wrong roles or changed private pins leave both execution holds
intact and remove the unfinished image. No workspace grant or ownership lease is renewed, and no credential file is substituted.

New signed images append `controlConfiguration: { claimant: true, publication: boolean, destinations: number }`. The optional
field preserves verification of older images without inventing missing evidence. An original-ID retry returns its original
authenticated historical result, even if credentials later disappear. Every future activation must freshly verify its
actual control configuration; a signed image is not an execution permit.

## Acceptance and remaining scope

Real HTTP tests cover the original claimant generation and role boundary, all three publication destination types, provider
account/target mismatches, private files, administrator substitution, explicit client selection, changes during asynchronous
preflight, inventory drift, changes after audit and during preparation, original-ID retry and continued holds. Installed
Harness qualification checks the signed control summary after actual model-driven work, checkpoint import and held recovery.

Inference and source-connector configuration, authoritative input/state reconciliation, explicit runtime/path remapping,
coordinated restored activation and clean-host failure qualification remain required. The full article and Agentic OS
implementation ledgers remain active.

Code `56adf6dc2243fe40e41b8491a885623293a77762` passed 1,591 local tests (seven skipped), typechecking and all four
builds. Focused runs passed 92 recovery tests and 43 ownership/publication tests. The full run also verified that an
unsettled publication prevents a configuration probe before it reaches the provider.

The same code passed 1,593 tests with native Linux confinement (five skipped), typechecking and all builds in
[run 42564344905](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42564344905).

Both owned installed-Harness / DeepSeek Flash scenarios passed in 224.07 seconds. Managed recovery verified the current
reserved claimant, actual coordinator publication credential and pinned provider account/target, then authenticated its
control summary and original-ID retry. The dedicated case retained its expected refusal for unrecorded publication probes.
Inference used the configured model API; provider-message traffic remained on local contract servers. The original app
remained running. This qualifies held control-configuration checks, not restored activation or future provider write access.
