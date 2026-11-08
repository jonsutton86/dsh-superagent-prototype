# 024 Ownership and resource fencing

An independent Harness authority now assigns one live execution owner to a coordinator identity. Every registered resource
must drain prior work before that owner can execute. The endpoint enforces ownership separately from the immutable workspace
grant described in [018 Execution ownership](018-execution-ownership.md). A successor retains the same grant, world binding,
Sessions and original effect IDs; its ownership generation changes. This document describes the host API and endpoint
increment; subsequent Runtime integration is tracked in the implementation ledger. External publication remains open, and the
[checkpoint recovery hold](023-checkpoint-recovery.md) remains mandatory. It does not enable restored-coordinator activation.

## Authority and handoff

Deploy `dsh-superagent/ownership-authority` in a dedicated Harness profile with a loopback web server and an absolute private
`stateDir`. Use authenticated tunnels or TLS for cross-host transport. Keep this process and its storage independent of the
coordinator being replaced. The plugin exposes `/ownership/v1`; it registers no model tools. Its directory contains a durable
authority UUID, SQLite state, private signing key and private admin token. Startup logs the UUID and token path, never the token.

This authority is one writer protected by a local process lock. It is not a consensus cluster, and cloning its live database
or signing key onto competing authority hosts is unsupported. SQLite on a shared filesystem does not establish safe HA.
Every authority restart invalidates all live leases before serving requests; counters persist. A new generation and resource
barrier are required. Do not restore an older authority snapshot into service. Resources retain a generation/nonce floor
and refuse observed regression, but that check is not a complete authority disaster-recovery protocol.

An administrator uses `coordinator.create` with a stable coordinator ID and the complete list of resource IDs. It returns
one acquisition credential and one credential per resource. The host must distribute them through private files outside
worker workspaces. `resources.add` is additive, limited to 256 total resources, and allowed only while ownership is vacant
at an expected generation. There is no resource-removal bypass, key-rotation workflow or automatic re-enrollment.

| Credential | Permitted role |
| --- | --- |
| Authority administrator | Enroll coordinator identities and add resource IDs |
| Coordinator claimant | Acquire a process-instance lease and inspect its coordinator |
| Current lease | Renew, activate, release and inspect its coordinator |
| Individual resource | Inspect its coordinator, verify an incoming lease and acknowledge that exact owner |

Resource acknowledgements are trusted host assertions. A resource credential must stay on its enforcing host and never be
given to a worker or claimant. Possessing the coordinator claimant alone cannot acknowledge resources. Raw proof credentials
travel in authenticated control requests; they are not stored in command arguments, model tools, command receipts or journals.
Host-side credential files are private owned regular files and are pinned against replacement for the process lifetime.
Each resource ID represents one enforcing endpoint and its execution journal. Copying its credential to a standby that
acknowledges without fencing the original endpoint is unsupported; endpoint-host replacement requires its own recovery proof.

Acquisition allocates a strictly increasing safe-integer epoch, random nonce and process instance UUID. It initially enters
`preparing`. In that state the owner may renew but may not execute. Each resource observes the new owner, cancels prior work,
waits for actual quiescence, and acknowledges the exact stamp. `lease.activate` requires every enrolled acknowledgement.
Unavailable resources keep activation closed. A timed-out preparation does not authorize dropping that resource.

Leases are 1–60 seconds. Live expiry uses the authority's monotonic clock; persisted wall-clock times are diagnostic only.
Clients calculate a conservative deadline from the request start plus server remaining duration, subtracting the whole
round trip. A delayed response cannot extend authority. Renewal retries with the same request ID do not extend a lease
twice. Acquisition retries preserve the original process and request identity; they cannot silently mint a replacement
generation after the original expires. An old release replay cannot release a newer owner.

`CoordinatorOwnership` renews an active lease and exposes a proof only while its local deadline is valid. Loss aborts its
signal and is terminal for that instance. The host must stop dependent dispatch when that signal aborts. `close()` stops
local admission before best-effort release. Release acknowledgement alone is not proof that all remote work stopped; the
next owner still passes the resource barrier.

## Endpoint enforcement

The Linux endpoint accepts optional `ownership` configuration:

```yaml
ownership:
  url: http://127.0.0.1:61000
  authorityId: <pinned-authority-uuid>
  coordinatorId: personal-agent
  resourceId: linux-workspace-host
  credentialFile: /private/endpoint/resource.token
  timeoutMs: 5000
```

The example URL is a loopback tunnel endpoint. Keep the resource key outside the entire workspace parent and system runtime
mounts. The endpoint persists its authority/coordinator/resource binding; removing or replacing the configuration is refused.
Existing grants must belong to that coordinator. Its persistent generation/nonce floor is written before admission.

Protected RPCs carry `x-dsh-owner` in addition to their existing endpoint administrator or workspace-grant credential.
Ownership adds a requirement; it does not grant filesystem, process, network or administration permissions. Verification is
online for each protected call. Asynchronous command/file preparation is revalidated before the effect boundary, and queued
administration and credential publication revalidate before committing. The resource polls at 500 ms and cancels on loss,
expiry, authority uncertainty or a changed owner. A rejected stale proof cannot cancel a different valid owner's work.

Handoff waits for all protected RPCs and pending command preparation to leave, all commands to have confirmed exit, and all file operations to settle or be
explicitly reconciled. A `started`/unknown command is not presumed stopped. An uncertain file operation stays behind the
barrier. Endpoint administrator reconciliation remains available without a lease; it is an explicit operator assertion after
independently establishing quiescence, not an automatic model decision. Native filesystem helpers and subprocess descendants
retain their existing confinement/cancellation contracts.

Read-only identity, grant status/catalogs and receipt/output observation remain available without a live ownership proof.
They still require their existing role credential. Reconciliation is administrator-only. Reads of workspace files, new work,
cancellation, grant changes and credential changes require a live owner. This lets operators inspect a stopped coordinator
without letting it mutate its successor's work.

Command and file receipts carry a non-secret ownership stamp: coordinator ID, epoch, nonce and instance ID. Paired worlds
persist that stamp and validate subsequent observations. Missing/malformed or substituted required stamps are refused.
Retries of an original effect ID after handoff observe its original receipt rather than changing its stamp or rerunning it.
World identity and workspace-grant epoch do not change merely because the coordinator ownership changes.

## Host composition

`dsh-superagent/ownership` exports `CoordinatorOwnership`, `OwnershipClient` and `OwnershipGate` for trusted host composition.
`dsh-superagent/remote-world` exports `RemoteWorld` in addition to the existing paired-provider plugin. For example, a host
that already manages its own lifecycle can acquire ownership and construct a world:

```ts
import { CoordinatorOwnership } from 'dsh-superagent/ownership'
import { RemoteWorld } from 'dsh-superagent/remote-world'

const ownership = new CoordinatorOwnership({
  url: authorityOrigin, authorityId, coordinatorId,
  credentialFile: claimantCredentialFile, leaseMs: 30_000,
})
await ownership.start() // Waits for every registered resource to drain and acknowledge.
const world = new RemoteWorld({
  url: endpointOrigin, endpointId, credentialFile: workspaceGrantFile,
  stateDir: worldStateDirectory, ownership,
})
try {
  await world.start()
  // Bind both Harness filesystem and subprocess services to this world in the host's execution scope.
  // Stop dependent dispatch on ownership.signal; do not substitute local providers after ownership loss.
} finally {
  await world.close()
  await ownership.close()
}
```

The example assumes prior operator enrollment, resource startup and private credential distribution. Configuration files
cannot contain the in-memory `proof()` function. Subsequent Runtime integration injects that proof through the shared
lease lifecycle. This API must not be used to bypass a staged recovery hold. Source delivery and external
publication still need their own resource participation and fencing before full restored-coordinator operation is safe.

## Qualification and remaining integration

`tests/ownership.spec.ts` uses real HTTP authority requests and real Harness local providers. It exercises competing owners,
all-resource activation, role separation, same-ID acquisition/renewal/release, monotonic expiry despite wall-clock rollback,
authority restart, real running-command cancellation, delayed file preparation, uncertain-file reconciliation, paired-world
reopening, immutable receipt stamps, authority outages, delayed stale authorization responses, private key placement and
persisted binding/generation-floor refusal. The installed-Harness test additionally loads the authority plugin in its own
process, stops/restarts that process while a command is running, and transfers the unchanged grant to a new generation.
With `DSH_REMOTE_ISOLATION=1`, endpoint cases run through native Linux bubblewrap and the standalone filesystem helper.
Local passthrough fixtures are test-only; they are not evidence of macOS production confinement.

Local verification on 2026-11-08: `pnpm check` passed typechecking, all four builds and 1,400 tests, with five cases skipped
(including the two opt-in installed-Harness cases). The 14 ownership tests passed. Built public ownership, authority and
remote-world entry points also imported successfully. Installed-Harness and native Linux results are recorded separately;
the local result alone does not qualify cross-host deployment.

Code `7e2a33cc4ff662188eee52417056900b4c21e0c4` passed both installed-Harness cases in 149.84 seconds using
Harness 0.2.1-rc.3 and the configured `deepseek-official/deepseek-flash` provider. Dedicated and managed model missions,
persona/child execution, restart, checkpoint verification, staging and repeated Session import passed. The dedicated case
also loaded the independent authority plugin, stopped its real process during endpoint execution, restarted it with the
same identity, rejected the old proof and ran a successor under epoch 2 with the unchanged workspace grant. Model missions
still use the existing coordinator integration; this does not claim an ownership-fenced Runtime or restored activation.

The same code passed [Linux run 42535557440](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42535557440)
on Ubuntu 22.04/Node 24: 1,402 tests passed, three were skipped, typechecking and all four builds passed. All 14 ownership
tests passed with native confinement enabled, alongside the existing namespace, mission dispatch and credential-mount
qualification. This combines native endpoint enforcement with separately exercised installed-Harness authority hosting;
it does not establish a cross-host failover deployment.

Beyond the subsequent Runtime/managed-pool and dedicated-profile lifecycle wiring, the full implementation requires fencing every external
publication destination, held-restore validation/activation, credential/configuration remapping, endpoint/workspace recovery,
clean-host drills and failures around each dispatch boundary. Authority replication and safe authority backup recovery are
separate work. None is replaced by the current cooperative coordinator lock or by a successful endpoint handoff test.
