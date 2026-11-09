# 025 Runtime ownership

The coordinator now uses the independent authority and endpoint fencing from
[024 Ownership and resource fencing](024-ownership-fencing.md). A configured Runtime acquires its process lease before
setup, world preparation, Session recovery or effect dispatch. The same in-memory proof reaches endpoint administration,
dedicated providers and every managed world. DeepSeek Harness still owns inference, tools and Sessions.

## Deployment

Enroll the stable coordinator identity and every enforcing endpoint with the independent authority first. Install the
resource credential on each endpoint and the claimant credential on the coordinator, in private files outside worker
workspaces. Keep authority storage and resource credentials independent of the coordinator. The authority and endpoint
deployment, identity pins, transport and single-writer limitations in the preceding document still apply.

Configure the coordinator plugin:

```yaml
- id: dsh-superagent
  config:
    executionMode: local
    stateDir: /private/agentic-os/application
    ownership:
      url: http://127.0.0.1:61000
      authorityId: <pinned-authority-uuid>
      coordinatorId: personal-agent
      credentialFile: /private/agentic-os/claimant.token
      timeoutMs: 5000
      leaseMs: 30000
      prepareTimeoutMs: 60000
```

Here `local` means general-mission mode rather than repository mode. Owned workers execute only in matching enrolled
remote worlds; the coordinator's local filesystem/process providers cannot serve as a fallback. A managed coordinator
initially has no executable environment. Register an endpoint, create its grant, activate the paired world, and select
that world on each mission action. Endpoint registration rejects resources with absent or different ownership bindings.

Generated dedicated profiles include the complete coordinator ownership configuration and only authority/coordinator IDs
on the remote provider. They reference the claimant file; they do not contain its value. A dedicated profile shares the
coordinator identity, so stop the incumbent before launching it. It is not an additional concurrent worker coordinator.
Both profiles must have the referenced credential paths available on their actual hosts.

The dedicated provider first mounts read-only identity, grant and receipt observations, before Runtime exists. It defers
renewal and pending revocation replay until Runtime supplies a live proof. This avoids a provider/startup dependency cycle.
Acquisition still requires acknowledgement from every enrolled resource, including resources not currently selected by a
mission. Unavailable resources prevent activation; a timeout does not remove them from the barrier.

## Lifecycle and receipts

Runtime records its authority/coordinator binding under its existing exclusive state lock. A restart cannot remove or
replace that binding. Each process receives a different instance ID and a later authority epoch; workspace grant IDs,
world bindings and original effect receipts remain unchanged. Claimant files are checked against the dedicated root and
each managed root before mounting it. Legacy profiles without ownership continue to load; an explicitly incomplete
ownership block is rejected.

Ownership loss is terminal for a Runtime instance. It aborts the lifetime, stops passes, cancels the router and workers,
and drains worker background jobs and descendants. Session/tool guards and remote endpoint verification deny new effects.
Management mutations require a live lease, including after request-body reads. The existing receipt-refresh POST routes
remain available because they only observe remote receipts and update local diagnostics; cancellation still requires ownership.
`/orchestrator/api/state` remains available
during acquisition and after loss, exposing non-secret owner metadata and health. Other read routes remain available after
successful initialization. Remote receipt observation is still independently available with existing endpoint credentials.
Initialization failure releases any acquired lease; normal shutdown shares the work-drain promise and closes local stores
before releasing the local state lock.

The authority/resource barrier, not a coordinator's cancellation request or release response, establishes remote
quiescence. An unknown command or file effect must be observed or explicitly reconciled before handoff. A restarted
coordinator cannot replay an old effect under a new generation to produce a second effect.

## Remaining architecture

This increment supports ownership-controlled general missions. External GitHub/Feishu publication still needs an
independently fenced service and durable destination receipts. Owned profiles therefore reject repository mode and host
account CLI configuration, and expose only the workspace source. Existing unowned channel workflows remain supported.
This restriction is an implementation boundary to remove through the publication integration, not a reduction of scope.

The [checkpoint recovery hold](023-checkpoint-recovery.md) remains mandatory and is checked before any ownership acquisition.
There is no restored-state activation command yet. A lease does not establish that an older Store and Session snapshot is
current, or reconcile missing external delivery. Clean-host activation, authority disaster recovery, automatic failover,
publication fencing and the other article/product requirements remain open. Local diagnostic state changes after loss do
not constitute shared distributed storage or a consensus protocol.

## Qualification

`tests/ownership-runtime.spec.ts` exercises actual HTTP authority/resource ownership with the simulated Harness host:
managed command attribution, authority restart during a command, terminal dispatch denial, read-only inspection, competing
coordinators with separate state directories, startup failure release, configuration compatibility and staged-restore
refusal. Linux runs use native bubblewrap for these endpoints.

The opt-in `tests/remote-harness.spec.ts` includes owned dedicated and managed variants. They run actual installed Harness
with the configured model, reject the bootstrap owner's stale proof, retain persona/Session/world bindings across owner
changes, inspect original receipt stamps, resume a surviving managed world and preserve held checkpoint/import behavior.
macOS qualification tests composition with a test-only unconfined endpoint; production confinement requires Linux.

Verification on 2026-11-08: code `ba17edd5fe09d9276b8d27168188f7f6d9b83abe` passed local `pnpm check` with
1,406 tests, typechecking and all four builds. The same code passed
[Linux run 42537715231](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42537715231) with
1,408 tests, including all six Runtime ownership cases with native endpoint confinement, typechecking and all builds.
The installed Harness 0.2.1-rc.3 / DeepSeek Flash qualification passed all four dedicated/managed variants in 306.08 seconds.
Both ownership-enabled variants passed again against the committed build in 132.91 seconds, including real persona work,
child execution, ownership changes, managed-world resume and held checkpoint/Session import. These results qualify this
increment; they do not qualify restored activation or external publication fencing.
