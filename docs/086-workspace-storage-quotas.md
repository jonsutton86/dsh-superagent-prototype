# 086 — Workspace storage quotas (design checkpoint)

Status: quota-backed endpoint startup, grants, filesystem/process execution and verification are integrated and native-tested. Operator configuration/install, recovery export, capacity headroom and full qualification remain unfinished. This increment does not advertise
storage protection in endpoint capabilities. Harness remains the executor and existing provider defaults are unchanged.

## Observed write boundaries

At revision `8d1d78b4596bd6fdd19d0676791c3c3c4e74148b`, endpoint enrollment creates each workspace below its configured
root and persists its canonical root identity in the existing grant. Bubblewrap exposes that workspace writable for ordinary
commands and mounts a separate `/tmp` tmpfs. Verification uses `stateDir/verification/<job>/workspace` and `scratch`;
its captured copy is outside the original workspace. The endpoint SQLite journal retains bounded output per stream,
but its overall retention is not a workspace filesystem quota. Existing snapshot reservations bound admission estimates;
they do not enforce arbitrary writes by a verification command. CodeGraph identifies both local verification service and
remote endpoint callers of `runCapturedCheck`; changes to that shared runner must preserve both paths.

## Proposed enforcement contract

Use a prepared Linux XFS volume with project quotas as the first supported storage backend. XFS documents separate
accounting and enforcement, hard block/inode limits, and inherited project membership across directory trees. A project
can cover multiple roots. See the upstream [xfs_quota manual](https://www.man7.org/linux/man-pages/man8/xfs_quota.8.html),
Quota Administration and Directory Tree Quota. Do not infer support for ext4, APFS, or nested aggregate project limits.

Design decisions (not implemented):

- Bind a nonzero project ID to endpoint identity and authenticated workspace identity in the existing endpoint journal.
  Never derive it solely from a truncated hash or accept an agent-provided ID. A host-controlled allocation range must
  prevent collisions with other endpoints and unrelated projects on the same filesystem.
- Charge the original workspace and its verification copies/scratch to the same project on the same filesystem.
  Keep journal, credentials and recovery metadata outside agent-writable quota roots. A configured verification location
  on another filesystem must be rejected or explicitly provisioned; do not silently leave it unmetered.
- Pin byte and inode hard limits plus filesystem/root identity. Separate privileged host preparation from unprivileged
  agent execution. Confirm enforcement and membership before admitting work; configured-but-unverifiable means unavailable.
  Startup inspection alone is insufficient: trusted pre-exec checks and protection against membership changes are required.
- Project quotas are not the hierarchical cgroup policy. Bound pool allocations through serialized, durable reservations
  of each workspace hard limit against a host storage budget. Protect control-state headroom separately. Specify this as
  allocation admission, not a kernel aggregate pool quota; account for unrelated host usage and fail closed on uncertainty.
- Preserve original grant/job/operation IDs. Record provisioning intent before host effects; inspect an uncertain outcome
  instead of allocating a replacement project or repeating recursive changes. Do not reuse IDs while files, open deleted
  files, retained evidence, or unknown cleanup may remain. Grant revocation does not imply released disk space.
- `/tmp` remains a distinct memory-backed boundary: verify it is charged to existing memory limits and cannot become an
  unbounded host disk escape. Describe its limit separately in the UI. Retained journal/output storage needs its own
  retention and capacity policy; workspace quota success does not imply whole-host storage protection.

## Implementation sequence and gates

1. Capture native XFS behavior in an isolated Linux fixture: quota enabled versus accounting-only, exact block/inode
   units, inheritance, two roots sharing a project, hard-link restrictions, and project-ID mutation permissions for the
   actual sandbox UID/capabilities. Verify deleted-open files stay charged. Do not change the operator's mounts.
2. Implement strict optional storage policy and trusted host probe/helper. Test absent-policy compatibility, malformed or
   partial probe output, unsupported filesystem, changed mount/root, missing enforcement, zero ID, and limit mismatch.
3. Add journal-backed allocation/provisioning recovery and enrollment integration. Crash at each effect/receipt boundary;
   prove restart preserves original project and no colliding allocation. Existing roots require explicit migration and
   quiescence, not recursive mutation while jobs run.
4. Integrate every writable remote path, especially shared verification runner copies, without changing local verification
   defaults. Test concurrent commands and filesystem RPCs exhausting one workspace while another remains usable; both
   byte and inode exhaustion must be kernel observed. Test snapshot-write exhaustion and cleanup after uncertain stop.
5. Connect launcher policy pinning, health and workspace controls. Expose unsupported/unverified/ready/full states accurately.
   Update architecture inventory, focused tests and typecheck; run a focused native storage workflow. Reserve the full
   macOS/Linux matrix for the final revision under the current testing policy.

No new runtime feature, storage migration, host provisioning, or native storage test is claimed by this document.

## Focused native mechanism result

The hosted Ubuntu 22.04 storage-only workflow passed at `bcfd859dee5d0b52c70be7f07bdbd7b79317f157`:
[run 43691070339](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43691070339).
The fixture creates a disposable 512 MiB XFS image with project quotas, runs unprivileged processes in capability-dropped
bubblewrap namespaces, and unmounts/removes the image on exit. It does not format existing devices or change application
configuration. The full runtime job is intentionally skipped for manual `scope=storage`.

VERIFIED in this fixture: two trees share a 16 MiB/128-inode project; a second project remains writable when the first
is exhausted; newly created files inherit membership; cross-project hard links and sandbox project-ID changes fail;
deleted-but-open allocation remains charged; release is observed after the final close; 126 empty files exhaust the
128-inode budget that already contains two directory roots. With accounting still on and enforcement disabled, a
20 MiB allocation succeeds despite the configured 16 MiB hard limit. Accounting alone cannot prove protection.

Two failed discovery runs are retained as evidence, not hidden: `43690904775` expected EDQUOT but observed ENOSPC;
`43690969472` assumed immediate quota release after close and failed. The passing revision uses the observed project-quota
error and a bounded release observation. The upstream kernel's project-quota error path also returns ENOSPC:
[xfs_trans_dquot.c](https://kernel.googlesource.com/pub/scm/linux/kernel/git/mic/linux/+/7db06e329af30dcb170a6782c1714217ad65033d/fs/xfs/xfs_trans_dquot.c).
Do not classify every ENOSPC as quota exhaustion without matching filesystem/quota evidence.

This supersedes the earlier unrun-native status for these specific mechanism checks only. Harness endpoint integration,
provisioning recovery, concurrent admission, migration, filesystem identity checks, tmpfs accounting, retained control-state
capacity, clean-host recovery and full qualification remain unimplemented or unverified. No TypeScript source changed;
only fixture syntax and this native mechanism gate ran, not typecheck/build or the broader matrix.

## Durable allocation backend checkpoint

Implemented at `09d38200bae2574e95e3737173abf8c388e8443a`: strict optional-policy types and a `StorageReservations` component in the existing endpoint
SQLite database. This component is not yet wired into enrollment. It pins the filesystem/project-range/budget policy,
reserves both bytes and inodes, assigns monotonically increasing project IDs, and journals the original request identity
before provisioning. Only the first transition into `provisioning` permits a future host effect; a replay returns false
and requires observation. Reservations have no release API, because neither revocation nor unlink proves reclaimed storage.
Policy objects are frozen; missing policy with retained rows, corrupt row identity, changed policy, and implicit adoption
of existing endpoint grants/jobs/operations fail closed. Audit failure rolls back allocation atomically.

The endpoint constructor now refuses a persisted storage policy until enforcement integration exists. This intentional
WIP guard prevents running a partially provisioned endpoint without its pinned protection. Existing endpoints with no
storage policy retain their behavior. No configuration is installed into the running application.

Validation: 48 tests passed across storage-journal, remote, and stop-view suites; two native-only remote cases skipped on
macOS; typecheck passed. The adjacent remote mission fixture initially expected review while a command was still running.
A focused reproduction and source inspection confirmed the canonical stop ledger deliberately exposes a hold; the test
now asserts blocked plus stopHold, and continues through actual command cancellation and endpoint revocation. The repaired
focused case and the final three-suite run passed without unhandled errors. No runtime stop behavior was relaxed.

Next: implement a trusted filesystem/quota observation and provisioning boundary, bind the existing reservations to actual
host effects, integrate enrollment and verification roots, and remove the WIP startup guard only when dispatch enforces
those pinned records. Local project uniqueness does not establish host-wide exclusivity of the configured ID range.

## Read-only Harness host probe

`src/remote/storage-probe.ts` now observes the real host filesystem through bounded, time-limited Harness subprocesses.
It requires the pinned XFS UUID and mount root, matching numeric mount identity for every supplied directory, canonical
non-symlink paths, directory identity before/after observation, inherited project membership, no realtime allocation flags,
and exact configured byte/inode hard limits with both accounting and enforcement enabled. It rejects empty, duplicate,
truncated, unsafe-number, unit-suffixed or wrong-project quota output. Locale is fixed; external diagnostic text is not
used as a readiness decision. The probe neither escalates privileges nor modifies the filesystem/quota policy.

Native evidence at `65f346e4fcde9d5c2de9bff32f6923e648252641`: [run 43691750911](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43691750911)
passed all 12 probe tests, none skipped, plus the existing native mechanism fixture. The real Harness subprocess adapter
read the two prepared roots, and rejected disabled enforcement, a changed hard byte limit, and the independent project's
root. The fixture runs with root privileges to read quota state; this does not establish the production endpoint user's
permission to run quota inspection. A narrowly scoped trusted host boundary remains required.

Local parser checks passed 11 tests with the native case skipped. Typecheck initially caught the test using `ctx.dispose`
instead of Harness `ctx.fiber.dispose`; the first dispatch (`43691714594`) was cancelled, confirmed terminal, and is not
acceptance evidence. Typecheck passed after correction. No full-suite, build, deployment or provider request ran.

The returned observation is point-in-time evidence only: concurrent path/mount changes, existing descendant membership,
host-wide project ownership, and changes after observation are not proven safe by it. Do not persist a ready state or
remove the endpoint startup guard solely because this probe succeeds. Provisioning must establish protected roots and
execution must revalidate/fence the bound storage identity. Enrollment, recovery reconciliation and dispatch integration
remain unfinished; this preserves the original full storage scope.

## Provisioning orchestration and response-loss recovery

At `13eb4e5ce068230c48f7e69a84476c9ab949b1b4`, `StorageProvisioning` serializes preparation through a trusted host adapter, records the provisioning intent
before its first host effect, and always obtains a new observation before recording completion. A replay after response
loss only inspects the original project/roots. It never automatically repeats the provisioning call or allocates another
project. The original journal row now records a strictly validated `provisioned` observation; this records historical
provisioning, not authorization to dispatch. The startup guard remains.

Root plans derive from the pinned mount, endpoint UUID and workspace ID under separate workspaces/verification parents.
Stored observations must match both roots, exact quota policy and original project; later observations cannot replace
previously bound root device/inode or mount identity. Audit/receipt failure rolls back the observed state, leaving the
original provisioning intent recoverable. Reopen rejects corrupted observation identity or limits. No release path was added.

Validation: 28 checks passed across storage journal/probe before the final corruption assertion (one native skip); the
final journal suite passed all 18 tests and typecheck passed. These use actual SQLite restart and an explicit simulated
host adapter; they are not evidence of production privileged provisioning. The additional native sandbox inheritance
attack passed at `745f3bc6a6e447b9df5aaf680ff15969f97a5c57` in [run 43691948723](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43691948723),
alongside the existing mechanism checks and 12 native probe tests. Sandbox `chattr -P` was refused and the root's actual
project-inherit flag remained set. This is mechanism evidence at that revision, not native testing of the later orchestration.

Next required work: implement the narrowly scoped privileged host adapter with protected parent ownership, host-wide
project-range exclusivity, identity-pinned empty-root creation and recoverable partial provisioning; connect endpoint
enrollment and snapshot roots; validate/fence dispatch; add operator configuration and recovery paths. The new `StorageHost`
interface has no production implementation yet. Neither this checkpoint nor a `provisioned` journal row means storage
protection has been integrated or deployed.

## Privileged host library and native creation/recovery

`scripts/agentic_storage.py` implements the privileged host primitive. It is an importable library, not a setuid program,
installed service, agent tool, or public endpoint. Its caller must already be an authenticated privileged service with a
fixed administrator-owned configuration and a single shared root-private registry. No caller-supplied configuration may
be exposed through an eventual endpoint transport.

The host registry pins each endpoint's policy and OS uid/gid, refuses overlapping ranges for the same filesystem UUID,
and maintains unique project/workspace/request claims. This separate registry is required by the privilege boundary:
the unprivileged endpoint journal cannot authoritatively claim host-wide ranges or attest which root inodes a privileged
process created. It does not allocate replacement IDs or release uncertain capacity. A root-owned flock serializes
host operations; SQLite FULL commits the original intent before filesystem effects. Host quota tools use fixed system
paths, a clean locale/environment, no shell and no retries.

Provisioning checks the actual XFS mount and enforcement, rejects preexisting nonzero quota usage/limits, creates roots
under root-owned parents, records their device/inode identities, applies membership and exact limits, and only then
assigns the configured endpoint uid/gid. It never recursively adopts an existing tree. A duplicate request is observation
only. Missing/partial original identities require operator reconciliation; they do not cause another creation attempt.
Observation checks protected ancestors, root identity and ownership, membership/inheritance, mount identity and hard limits.
Host-managed range exclusion does not protect against an administrator assigning the same IDs outside this registry;
exclusive range assignment remains a prepared-host requirement.

Native validation passed at `b1ab8c0f68b4ee41327c96ca6ccd397d82a356de` in [run 43692647748](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43692647748).
The real library created two roots with enforced 16 MiB/128-inode limits; reopening the registry and repeating the original
request performed no quota-setting commands. Forged endpoint IDs, traversal, out-of-range projects, overlapping endpoint
ranges, changed request hashes, an uncertain intent with no created roots, exhausted capacity and root replacement were
refused. Rejected registration released its flock descriptor, and all host descriptors closed after final shutdown.
The existing sandbox mechanism fixture and all 12 native Harness probe tests also passed at that revision.

An earlier cleanup assertion failed in run `43692529615`: it counted shared SQLite descriptors while the first connection
remained open. The corrected test checks immediate flock cleanup separately and requires total descriptor return to the
baseline after all connections close. The preceding initial host-library run `43692375225` passed but is superseded by
this final revision. No TypeScript changed, so no additional typecheck/build or full matrix was run for this slice.

Remaining: authenticated local host-service transport and its fixed configuration/install path, normalization to the
TypeScript StorageHost observation contract, endpoint enrollment and snapshot-root wiring, fresh pre-exec fencing,
whole-volume/control-state headroom, operator reconciliation for partial native creation, migration and clean-host/reboot
acceptance. The endpoint startup guard remains. This library was exercised only on the disposable CI volume; it has not
been installed or activated on the operator's app or any persistent host.

## Authenticated local service and endpoint client

The root-side `scripts/agentic_storage_service.py` and TypeScript `LocalStorageHost` now connect the provisioning
orchestrator to the native host library. Configuration is a root-owned, single-link, owner-only regular file below
protected parents. The caller cannot submit policy, uid/gid or filesystem paths. Requests contain only a fixed operation
and the original endpoint/request/hash/workspace/project identity. The service accepts the configured endpoint UID using
Linux SO_PEERCRED, not user-supplied identity fields. Its pathname socket is root-owned mode 0660 under a protected parent;
the client checks those properties and socket identity before/after the exchange. No TCP listener or bearer secret is added.

The service reads at most 4096 request bytes, requires EOF for one complete JSON message, has a per-read timeout, and emits
only a fixed refusal on malformed input/host failure. Replies bind original IDs/hash and normalize observations to the
existing schema. The client bounds responses, applies an overall timeout/cancellation, validates policy and assigned roots,
and never retries a transport failure. The host retains committed operations after a lost connection. Shutdown removes
only the socket inode this process bound; startup refuses an existing/stale socket rather than blindly unlinking it.

Native validation at `d8cdf02909fd14ae57ad2a50583cd22e40f1f61b`: [run 43693280862](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43693280862)
passed the real root service with the TypeScript client running as the configured non-root endpoint user. The test used
the actual endpoint SQLite journal and StorageProvisioning, created protected roots, reopened the journal, observed the
original allocation, and rejected forged endpoint IDs, unassigned roots and cancelled calls. A root client that could
open the socket was still refused by peer-UID authentication. Authorized peers sending extra configuration, concatenated
JSON or oversized frames received only the fixed refusal. Service shutdown removed its own socket. The 12 native probe
tests and host/mechanism fixtures also passed; this is 13 Vitest tests plus the explicit Python fixture assertions.

The first service run (`43693089132`) stopped before client execution because an earlier root Vitest invocation created
an unwritable tooling cache. The fixture now runs the unprivileged client first; it does not elevate the client or loosen
application permissions. Run `43693160017` passed that repair; the final run also covers refusing non-Linux hosts before
host effects. Local typecheck passed. No build or whole-system matrix was run.

Still required: supported root-owned installation/systemd assets and fixed registry policy, endpoint enrollment and snapshot
paths, dispatch fencing and namespace isolation of the service socket, stale-socket/partial-creation operator recovery,
whole-volume/control-state headroom, service endurance/adversarial framing acceptance, migration and clean-host/reboot
qualification. A live observation and historical provisioned row still do not authorize general endpoint execution.
The storage startup guard remains; this service was started only in disposable CI and is not installed on the user's app.

## Bounded request lifetime and integration prerequisites

The service now uses one monotonic five-second deadline for the entire request body, rather than a fresh timeout for each
read. Replies have a separate one-second send deadline. Duplicate JSON fields are refused recursively for requests and
administrator configuration. A slow peer therefore cannot keep extending its service slot by sending individual bytes.
Three deterministic transport tests pass without privileges; they verify the shrinking remaining timeout and that no host
operation runs on slow or duplicate-field requests.

Native [run 43693592028](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43693592028) passed at `3e2e5b2a99aee91a9b01aaa0136c35c1a147196c`:
the authorized peer repeatedly sent bytes without ending its request, received the fixed refusal within the bounded window,
and a subsequent connection succeeded. The native client/probe tests (13 total), privileged host fixture, mechanism fixture,
and three deterministic transport tests also passed. No TypeScript changed in this slice; no repeated typecheck/build or
whole-system qualification was run.

VERIFIED source prerequisites for endpoint integration: `RemoteJournal` currently creates/canonicalizes the workspace
parent during construction, while storage root plans include that journal's endpoint UUID. `RemoteEndpoint.start()` calls
`verifyLocalWorkspace` on the parent, which writes a nonce file; `verifyIsolation` creates a temporary child below it.
The new host-owned parent must not be made writable merely to preserve these probes. Integration must initialize/bind the
original endpoint identity before host namespace preparation, and run startup proofs in an explicitly owned test root while
preserving quota and cleanup accounting. Enrollment currently performs its own mkdir before grant persistence; it must use
the original storage intent and verified host root instead. Verification currently uses `stateDir/verification`; it must
move to the workspace's assigned verification root, including cleanup/restart paths. These are concrete code changes still
required, not accomplished by the service tests or a reason to bypass the startup guard.

## Prepared namespace and initial endpoint identity

The host registry now records a namespace-creation intent before creating the endpoint base and its workspaces/verification
parents. Each root-owned parent is explicitly mode 0755 independent of service umask, synced, and bound to its observed
device/inode in the host registry. Restart validates those identities and permissions; partial namespace records, foreign
existing directories and root-owned replacement directories are not adopted or automatically recreated. Provisioning uses
these prepared parents rather than creating them late. This closes the parent-directory ordering gap for journal startup.

`RemoteJournal` accepts an optional administrator-assigned canonical endpoint UUID on first creation. If an original ID is
already present, a different configured ID is rejected; the existing default UUID behavior remains unchanged. The native
endpoint-client fixture now uses this supported constructor path with the real protected parent, rather than modifying
its metadata table to install the fixture ID. It explicitly proves the endpoint user cannot write into that parent.

Validation at `aded64bceaa006f00f11f22c64292063e37e9d31`: [run 43694039867](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43694039867)
passed 13 native client/probe tests, the host namespace/recovery checks, slow-request/authentication checks, and existing
mechanism fixture. The host fixture starts with umask 0077, verifies searchable protected parents, rejects an unfinished
namespace intent without creating its directories, and rejects a replaced base directory. Local adjacent storage/remote
checks passed 52 tests with two native skips before adding two explicit identity assertions; the final storage journal
suite passed all 20 tests and typecheck passed. No full matrix/build/deployment was run.

Next integration design: preserve this assigned ID through launcher/profile configuration; run startup filesystem and
namespace proofs in an explicit quota allocation (do not grant write permission to the protected parent); bind enrollment
to the original StorageProvisioning request; use the assigned per-workspace verification root; reobserve pinned storage
at each execution boundary. Any persistent startup allocation must be visible in capacity accounting and reused by its
original identity after restart. The endpoint's existing storage startup refusal remains until these paths are connected.

## Endpoint backend integration

At `d893a3ba7222f4f177dc01f5febe520d28741a77`, `EndpointStorageManager` connects the original reservation/provisioning flow to `RemoteEndpoint`. Storage
is supplied only through the programmatic EndpointHost configuration for now; the shipped plugin/launcher/UI does not yet
offer this option. Endpoints without storage retain the existing path. Endpoints with a persisted storage policy still
refuse startup when the storage configuration is absent; configured storage requires confined process and filesystem paths.

Startup allocates the reserved `__dsh_startup` workspace using one stable intent and the assigned endpoint identity. The
filesystem/world and namespace proofs run inside that allocation, without making the protected parent writable. The
startup allocation persists and consumes the same pool budget; configuration must fit startup plus at least one worker
workspace. User enrollment cannot claim that reserved workspace. Grant enrollment uses its original request/hash to
provision/observe the root before committing the grant, so lost enrollment responses cannot select another project.

Filesystem helper boundaries, ordinary process dispatch and verification authorization reobserve the original storage
allocation and validate its pinned root/policy. Snapshot containers and cleanup now use the workspace's assigned
verification root, sharing its quota with source files. Cleanup refuses mismatched storage instead of deleting through
an unverified root. Startup/restart reuse original allocations, and no release/recycling shortcut was introduced.

Recovery limits remain explicit: unfinished storage reservations prevent ownership quiescence; storage table mutations
invalidate recovery inventory revisions. The old `recovery.world` export is refused for storage endpoints because it does
not yet carry quota policy and host-registry state. This is an unfinished required recovery feature, not an owner-deferred
requirement or a successful recovery claim. Full inventory/restore/profile integration must replace that refusal.

Native [run 43694832290](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43694832290) passed at the exact
revision above, including typecheck and all seven builds. The unprivileged endpoint starts against the real root service,
creates a grant, writes/reads files via confined helpers, executes a command, verifies a captured copy and releases it,
observes real quota exhaustion with a failing allocation command, confirms the privileged service socket is absent from
the worker namespace, stops/reopens the actual journal, and reuses the original grant and two allocations. It also confirms
that the incomplete recovery export refuses the request. All 13 native client/probe tests and the host, transport and
mechanism fixtures passed. Local adjacent remote/storage/verification suites passed 66 tests with four native skips; the
final storage journal suite passed 21 tests and typecheck passed. Earlier native integration run `43694640813` also passed,
before the recovery refusal and explicit startup-capacity validation were added.

Remaining work includes launcher/plugin/UI configuration and storage status, root-owned supported installation, ownership
inventory/backup/restore/migration for both endpoint and host records, whole-volume/control-state headroom, operator
reconciliation of partial effects, service/endpoint reboot and clean-host acceptance, and final whole-system qualification.
The backend is not deployed to the running app; default models and provider routing were not changed.

### Harness plugin configuration

Source revision `c8592a3` exposes optional endpoint `storage: { endpointId, socketPath, policy }`.
The policy is the strict `EndpointStorage` schema above. The endpoint ID and policy must match the
administrator's root-owned storage-service configuration; the workspace parent must be
`<mountRoot>/dsh-<endpointId>/workspaces`. The socket must be a canonical absolute pathname shorter
than 104 bytes. Runtime checks additionally enforce the existing root-owned socket and parent contract.
The plugin constructs `LocalStorageHost`; it does not launch or install a privileged service.
Omitting storage preserves the existing endpoint behavior. Invalid connection/policy configuration
is rejected before accessing subprocess services or constructing the endpoint journal.

Validation of this source tree: 28 focused plugin/journal tests passed, typecheck passed, and all seven
builds passed. Native storage evidence above remains tied to its earlier revision; it was not rerun
for this configuration-only increment. Launcher/UI configuration, supported service installation,
storage recovery export/restore, headroom and reboot/clean-host qualification remain incomplete.
No running application was restarted and no model defaults or provider routing were changed.

### Managed launcher and transport policy binding

Source revision `93d17fa` adds storage to the existing `--endpoint-config` input. Initialization and
restart derive the workspace parent from the configured mount and endpoint ID, and do not create or
change the permissions of the protected quota namespace. The control installation must be separate
from the storage mount. Configuration validates canonical IDs/paths, integer budgets, and capacity
for startup plus at least one worker. Existing installation equality checks pin these settings.

For example, the following is a configuration shape, not an installed host or usable filesystem ID:

```json
{
  "storage": {
    "endpointId": "11111111-1111-4111-8111-111111111111",
    "socketPath": "/run/agentic-storage/endpoint.sock",
    "policy": {
      "kind": "linux-xfs-project",
      "filesystemUUID": "22222222-2222-4222-8222-222222222222",
      "mountRoot": "/srv/agentic-quota",
      "projectIds": { "first": 10000, "last": 10099 },
      "pool": { "bytes": 10737418240, "inodes": 100000 },
      "workspace": { "bytes": 1073741824, "inodes": 10000 }
    }
  }
}
```

The endpoint identity and coordinator metadata now retain `storage: { policy }`. This is pinned
configuration, not a live usage sample or a capacity guarantee. Runtime operations still obtain
fresh host observations. Launcher health requires the configured endpoint ID and exact policy;
SSH enrollment retains that policy and refuses missing, unexpected or changed policy during health
checks. Enrollment does not export the privileged socket path. Omitting storage retains the old
workspace layout and refuses unexpected storage on the connected endpoint.

VERIFIED: focused launcher health contract passes after fixing a fixture name collision; transport
and storage-plugin suites pass 15 tests with one native skip after fixing a fixture tuple-access
error. Adjacent remote/endpoint/transport suites passed 50 tests with three native skips. The earlier
launcher/journal/plugin/transport run had 47 passes, three skips and that repaired fixture failure.
Typecheck and all seven builds passed; production sources were unchanged after the build except
Python whitespace. These are local configuration/contract checks, not native installed-launcher
qualification. CodeGraph sync completed; its affected-file output was supplemented with the launcher,
transport, coordinator endpoint and remote suites based on direct call-path inspection.

UNKNOWN/unqualified: actual storage-backed managed Harness/SSH launch and reboot. Supported privileged
service installation, UI storage controls/status, complete storage backup/restore, volume headroom,
partial-effect reconciliation and final clean-host/full-system qualification remain open. No service
was installed or restarted and no provider/default model changes were made by this increment.
