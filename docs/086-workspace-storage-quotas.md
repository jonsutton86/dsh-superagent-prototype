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

### Listener crash recovery and installation prerequisite

The service now holds a separate root-private, single-link, non-followed listener lock for its entire
lifetime. The lock file remains in place after shutdown. A duplicate listener fails before opening the
host registry. A leftover socket is reclaimed only if its type, root owner, configured group and 0660
mode match, a bounded connect attempt returns ECONNREFUSED, and its identity/metadata are unchanged
when inspected again. A live listener, symlink, regular file, changed inode, wrong permissions, or
uncertain probe is refused. Reclaiming this transport socket does not remove or retry host operations.

Local deterministic listener tests exercise duplicate locking, unchanged lock inode, dead/live sockets,
foreign path types/modes and an uncertain probe. Ownership/protected-parent checks are mocked only in
that non-root fixture; native qualification checks the real root service separately. The native fixture
now includes an idle SIGKILL/restart and compares the entire host registry before/after, plus a duplicate
service startup refusal. This does not prove recovery during an in-flight quota mutation or machine reboot.

Installation design constraint: do not silently introduce a service-private mount namespace before
mount-identity recovery is defined and qualified. Existing observation reconciliation pins mount IDs;
service isolation options that change the visible mount topology may invalidate those observations.
Systemd documents filesystem namespace behavior and persistent/runtime directory lifecycle in its
[official execution manual](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html).
Supported installation assets and a native systemd lifecycle test remain required; this increment
implements their stale-socket recovery prerequisite and does not install or activate a service.

VERIFIED at `9dba3cf965cc374dbb7396f2c3a32d486164ee2e`: native
[run 43695915638](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43695915638)
passed typecheck, seven builds, 13 native Vitest tests, four listener contracts, three transport
contracts, and the XFS mechanism/host/service fixtures. The native service reported both
`crashRestartPreservedRegistry: true` and `duplicateListenerRefused: true`.
Exact scope and source hashes: [listener evidence](evidence/086-storage-listener-recovery.json).
No full matrix was run and no running user installation was changed.

### Explicit privileged service installation

`scripts/agentic_storage_install.py` creates a root-owned installation containing the service/library
snapshot, private host configuration, matching endpoint storage settings, a systemd unit and SHA-256
manifest. It never invokes systemctl or starts a process. Existing files must exactly match the supplied
configuration and current source snapshot; changed or incomplete installations are preserved and refused.
No automatic upgrade, overwrite, uninstall, registry deletion, or partial-install repair is provided.

Operator sequence (deployment approval and a prepared Linux host are required before executing):

1. Prepare a dedicated XFS mount with project quota accounting/enforcement and root-owned protected
   parent directories. Reserve an exclusive project-ID range. All managed services on a filesystem must
   use one shared host registry; separately managed quotas still require administrator coordination.
2. Prepare a root-owned mode-0600 JSON file with exactly `endpointId`, non-root numeric `uid` and `gid`,
   and `policy` matching the endpoint configuration above. The UID/GID belong to the Harness endpoint.
   The service configuration contains no model or provider credentials.
3. As root, run `python3 scripts/agentic_storage_install.py --directory /opt/agentic-storage/ENDPOINT
   --registry /var/lib/agentic-os-storage --config /etc/agentic-storage/ENDPOINT.json`, substituting
   real canonical paths. Parent directories must already be root-owned and protected. The installation,
   registry and quota mount must be separate non-overlapping paths. This installs files only.
4. Review the returned `unitFile` and manifest. Separately link/enable that exact unit with systemctl,
   reload the manager and start it. Activation is an explicit operator action. The unit runs the root
   host service with a fixed config/registry and a per-endpoint `/run` socket. Automatic restart is off;
   manual restart must inspect uncertain effects rather than resubmit writes.
5. Copy the generated `endpoint-storage.json` settings into the endpoint's private `--endpoint-config`
   input, retaining any existing resource/ownership settings. Start the Harness endpoint as its configured
   non-root UID. Its startup proof verifies real quota operations and confinement; service-manager active
   status alone is not endpoint readiness.

The unit uses control-group termination and a 120-second stop timeout. Its runtime directory may be
removed by systemd after a stopped/failed unit, but the host registry and quota roots remain outside that
runtime directory. It deliberately avoids changing filesystem namespaces while mount IDs are pinned.
The installer requires Linux root; pure planning tests run without privileges. Systemd lifecycle tests
run only in the disposable GitHub Linux fixture, never against the user's running application.

VERIFIED at `3ca345e28740e7505b75c9f8749dc8f621e3896c`: native Linux
[run 43696255462](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43696255462)
passed the actual systemd installation lifecycle. The fixture verified the generated unit, installed
and started it, provisioned one original quota operation as the configured non-root peer, killed the
service, restarted it and observed that same operation. Directory and mount identities and the complete
host registry remained unchanged. Unchanged reinstall preserved file timestamps; changed configuration
and a partial installation were refused. Cleanup stopped and unlinked only the fixture's unit.

The same run passed nine Python contract tests, 13 native Vitest tests, the existing XFS mechanism,
host and service fixtures, typecheck and seven builds. Two planning tests also passed locally without
root. CodeGraph identified the installation fixtures (and a generic-name delegation false positive);
direct inspection selected the storage scope. Exact source hashes and limits are in
[installation evidence](evidence/086-storage-installation.json).

This closes first-install/service-lifecycle qualification for the tested Linux configuration. It does
not close the combined managed Harness launcher journey, machine reboot/clean-host recovery, in-flight
quota mutation recovery, explicit upgrades/uninstall/partial-install reconciliation, storage export and
restore, volume headroom, workspace controls, or final whole-system qualification. No user-host deployment
or default/provider model change occurred.

### Combined managed Harness launch qualification

The scoped storage workflow now installs pinned Harness `0.2.1-rc.3` and SSH tooling. A root fixture
installs/starts a fresh storage service, then runs the existing real endpoint/coordinator/SSH launcher
journey as the configured non-root UID. Optional storage input preserves the existing no-storage test
path. The storage variant checks launcher and SSH enrollment policy, the assigned protected workspace
root, absence of the old private-installation workspace directory, and that both the admin credential
and privileged storage socket are hidden from the worker. It exercises a real command, transport loss,
endpoint restart, coordinator restart, retained output and original request reuse. Afterward the root
fixture checks that the host registry contains only the original startup and worker allocations.

This test does not use inference, publish to another repository, or change the user's running app.
It is an integration qualification of the supported launcher path, not a machine-reboot or clean-host
restore test. Local typecheck passed; native results must be tied to the run/revision recorded below.

VERIFIED at `638b8fd814ffc0b2e07d5936546f7fd1c2a8d712`: native
[run 43696531434](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43696531434)
passed the combined journey using the installed service and pinned Harness. The fixture reported
`realHarness`, `sshEnrollment`, `endpointAndCoordinatorRestart`, and `originalAllocationsRetained`
all true. The scoped run passed 14 native Vitest tests, nine Python contract tests, the existing
mechanism/host/service/systemd fixtures, typecheck and seven builds. No native tests were skipped
inside this selected storage scope. The full workflow's unrelated Linux matrix job was deliberately
skipped. CodeGraph selected the existing endpoint-launcher suite; the root fixture supplied the real
storage installation rather than replacing that journey with a synthetic health response.

See [managed-launcher evidence](evidence/086-storage-managed-launcher.json). Remaining storage work:
whole-machine reboot and clean-host recovery, in-flight quota mutation recovery, backup/export/restore
and migration, explicit upgrade/uninstall/partial-install reconciliation, volume/control-state headroom,
workspace controls and live usage, and final full-system qualification. The user's app was not deployed
or restarted and model defaults remain unchanged.

### Workspace disk-policy display

At `2ac63a3`, endpoint cards display the registered allocation pool and per-workspace byte/inode limits
in English and Chinese. The wording identifies verification copies as part of the workspace limit,
startup qualification as a reserved allocation, and retained workspaces as still consuming allocation
capacity. It explicitly labels these figures as configuration recorded at registration, not current
usage or free space. Endpoints without storage metadata say that no managed quota was reported; this
does not claim that the host has no other filesystem limits. Internal mount paths are not displayed.

VERIFIED: four endpoint UI tests passed, including quota display, absent-metadata wording and retaining
the existing grant/retry workflows. Nine adjacent client/environment UI tests passed. Typecheck and all
seven builds passed. CodeGraph selected the endpoint/client/environment suites; the fixture file and
unrelated recovery-source match were inspected as indirect context rather than additional changed
behavior. React review found no new effects, subscriptions, async requests, interactive controls or
expensive derived state. These are rendered DOM tests, not a deployed browser or visual-layout claim.

This implements policy visibility only. Live allocation/usage queries, freshness/error handling,
operator reconciliation and storage recovery remain unfinished. The running user app was not restarted.

### Read-only quota observation RPC

At `1869721`, administrator RPC `storage.status` with a workspace identifier reports either
`configured: false` or the configured policy, reservation snapshot time, reserved/unreserved allocation
counts, and the selected workspace's state. Allocation counts include startup, retained and uncertain
reservations; unreserved allocations are policy capacity, not physical free space. An absent allocation
reports `unallocated`; a reserved intent reports `not-provisioned` without calling the host. For an intent
whose provisioning began, the endpoint obtains and validates a fresh host observation and returns quota
usage/limits plus observation time, or `unavailable` without stale quota data or host diagnostic text.
The original durable phase is returned separately: fresh observation of a provisioning intent does not
mean its receipt was committed or its grant is ready.

Status validates quota policy, assigned roots and previous root/mount identity using the same checks as
execution. It does not provision, settle an intent, persist observations or append audits. Tests verify
that SQLite total_changes remains unchanged. Aborts propagate; requests have a 30-second host bound.
Worker grant credentials cannot call this RPC. As a read-only recovery observation, it does not require
active coordinator ownership, while administrator authentication still applies.

VERIFIED locally: 23 storage journal/provisioning/status tests passed; final adjacent remote, endpoint,
ownership and verification suites passed 62 tests with four native skips. Typecheck and seven builds
passed. An earlier combined journal/remote run passed 58 with two native skips before the final
ownership-read classification change; that change was covered by the final adjacent run. CodeGraph
reported broad transitive matches through shared endpoint/protocol modules; direct call-path inspection
selected the bounded adjacent suites above. No full qualification matrix was repeated.

This is a locally tested backend increment. Coordinator response validation, workspace controls,
native end-to-end status qualification and freshness/error presentation remain unfinished. Existing
native evidence above does not claim coverage of this new RPC. Storage recovery/export/restore,
headroom, reboot/clean-host qualification and final project acceptance remain open.

### Coordinator and workspace observation path

The coordinator now validates a strict storage-status union, policy-derived allocation counts,
workspace hard limits, and observation state/phase combinations. It matches replies to the requested
workspace and the registered policy and rejects a registration revision change during the request.
An unavailable result cannot carry old quota fields. Missing storage must agree with registration.
`GET endpoints/:id/storage?workspace=...` uses the existing administrator credential and adds a local
receipt timestamp; invalid/missing workspace inputs are refused. The status call is read-only and
is not placed in the durable operator mutation queue.

Each workspace card has an on-demand “Check storage status” button. Refresh clears the old reading
before issuing a request. Failures display a generic verification failure without host diagnostics.
Successful views distinguish quota usage from policy reservation capacity, label observation times as
samples rather than continuous monitoring, and display an incomplete-provisioning notice even when a
fresh host observation succeeds. English and Chinese labels are included. No automatic polling or
background host effects were introduced.

Local validation: 33 storage/coordinator tests passed; final coordinator and adjacent client/environment/
endpoint UI suites passed 24 tests, typecheck and seven builds passed. Initial typechecking caught missing
route declarations; the first UI integration attempt caught an API parameter-shape mismatch. Both were
fixed and the final runs above passed. React review checked that the new state is event-driven, the action
is disabled while pending, stale readings are cleared, failures have alert semantics, and pending feedback
has status semantics. These DOM tests do not claim deployed browser visual validation.

The native managed-launcher fixture now requests storage status through the real coordinator after
endpoint/coordinator restart, checking positive usage, exact hard limits, timestamps and the original two
allocations. Its result must be matched to the recorded native revision below.

VERIFIED at `00b197d6454c65c45d793812cea1564d4a1e8bf3`: native
[run 43697502068](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43697502068)
passed 14 native Vitest tests, nine Python contracts, the existing service/systemd/host fixtures,
typecheck and seven builds. The real coordinator status request after restart returned observed quota
usage with positive used bytes, exact workspace hard limits, observation/receipt timestamps and two
reserved/zero unreserved allocations. The existing root-fixture check confirmed the original two host
operations remained. Source hashes and scoped evidence are in
[workspace-status evidence](evidence/086-storage-workspace-status.json).

This closes on-demand quota status integration and its local DOM/native backend checks. It does not
close deployed browser acceptance, in-flight mutation recovery, whole-machine reboot, clean-host
restore, backup/export/migration, upgrade/uninstall/reconciliation, volume headroom or final complete
architecture qualification. No model defaults changed and no user-host service was deployed.

### Process-loss provisioning boundaries

The native crash fixture forks with no inherited database/lock connection, opens the real privileged
host library, and uses test-only hooks to terminate that child with SIGKILL at eight boundaries:
committed intent before mkdir; first root created before its identity is recorded; first identity
recorded before project setup; first project setup complete; both project setups complete; hard limits
applied; first root ownership changed; and full verification complete before returning a result.
The parent requires an actual SIGKILL exit, reopens the original registry and uses the same request ID,
hash, workspace and project. No production fault hooks or retry logic are introduced.

The assertions require retained original intent, unchanged registry and root identities across replay,
no repeated project/limit mutation, refusal of incomplete work, and read-only observation when the
original work finished before its response was lost. A changed request hash must be refused. A second
allocation may fill the two-allocation pool, but a third must be refused: interrupted work is not free
capacity. Each boundary uses distinct assigned IDs in one shared crash-test registry.

This experiment covers process termination at known completed syscall/command boundaries. It does not
simulate machine power loss, a kill during an external xfs_quota command, storage-device faults or a
filesystem remount. Safe refusal of incomplete provisioning is not repair or completed recovery;
operator reconciliation of those retained effects remains required. Native result/revision follows.

VERIFIED at `e7084be23cac2ed81f83e86959d1ea40a420232c`: native
[run 43697912564](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43697912564)
passed all eight real process-loss cases. Seven incomplete stages refused observation and duplicate
provisioning without mutation. The completed-before-reply stage was observed successfully without
repeating effects. Every case retained the original intent and capacity, and refused a changed hash.
The full case results and source hashes are saved in
[provisioning-crash evidence](evidence/086-storage-provisioning-crashes.json).

The scoped workflow also passed its existing storage/managed Harness/systemd checks, typecheck and
builds. Production code did not change in this increment. Partial-effect operator repair, interruption
inside an external quota command, power loss, machine reboot, clean-host restoration, storage export/
backup/migration, headroom and final whole-system qualification remain required. The running app and
provider defaults were unchanged.

### Partial-provisioning inspection evidence

The privileged host library now has an internal `inspect(originalRequest)` method for the repair
workflow. Under the existing host lock it validates the namespace, original persisted intent and live
mount, then reports each root as missing, unrecorded, not-directory, identity-mismatch or recorded.
Unrecorded/replaced/non-directory paths are not adopted or traversed. Recorded directories include
current owner/group/mode, inode/device identity, modification/change timestamps, project membership,
inheritance/realtime flags and a bounded emptiness check. Metadata is rechecked after reading a
recorded root. Exact project quota observations are included independently of provisioning completion.

A SHA-256 snapshot binds the original request, policy, mount identity, root evidence and quota fields.
It is evidence for a future fresh-comparison repair step, not authorization: the result explicitly says
`authorizesRepair: false`. Inspection neither writes SQLite nor changes filesystem ownership, quota
membership or limits. The snapshot does not prove process quiescence and is not a machine-reboot
migration record. The method is not added to the endpoint peer socket protocol or model tools.

The crash fixture now checks the expected root classifications at all eight interruption boundaries,
unchanged registry content and a stable repeated snapshot on an idle filesystem. It checks the distinct
first-owner-only state and hard-limit evidence. The host fixture separately checks a replaced root and
a symlink. A native run/revision is required before claiming those checks passed.

VERIFIED at `04b2a1726dbee5a6e3535bbae6ab636f44118eba`: native
[run 43698291854](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43698291854)
passed all eight inspection/classification cases without changing the registry, plus the replaced-root
and symlink checks. Stable snapshots were confirmed for repeated reads of each idle state. The existing
scoped storage/Harness/systemd checks, typecheck and builds also passed. See
[repair-inspection evidence](evidence/086-storage-repair-inspection.json) for source hashes and cases.

This is internal repair evidence, not an exposed repair command. Repair intent journaling, fresh
snapshot matching, quiescence/fencing, explicit actions for admissible partial states and operator
reconciliation remain open, as do backup/migration, headroom, power-loss/reboot/clean-host testing and
final architecture qualification. No user-host deployment or provider/model changes occurred.

### Evidence-bound privileged repair intents

The host library now implements internal `repair(originalRequest, repairId, expectedSnapshotHash)`.
It keeps the original provisioning request/identity and records a separate repair intent in the same
host SQLite registry, unique per endpoint/repair ID and original request. Repair checks a fresh
inspection under the host lock, and commits `started` before any filesystem effect. A repeated repair
must match its original snapshot/request and only observes the result. It can mark a previously started
repair complete after successful observation, but never reruns its filesystem actions. A new repair ID
cannot bypass a retained original repair intent.

The currently admissible states are missing roots that never had recorded identities, or recorded roots
that still match, are empty, root-owned mode 0700, have no realtime flags, and have project ID zero or the
assigned project. Existing hard limits must be zero or the exact configured limits, and quota inode usage
must not exceed the recorded assigned roots. Lost recorded roots, unrecorded/orphan trees, replacement
identities, nonempty trees and roots already handed to the endpoint UID are refused. This prevents the
repair from acting on ordinary worker-owned/live workspaces. It does not claim general quiescence of
arbitrary user-owned trees; those require another reconciliation/fencing path.

For admitted repairs, missing root identities are committed before project setup. Project membership,
hard limits and final UID/GID are applied to those exact roots, followed by the normal full observation
checks before the repair receipt becomes complete. Original allocations remain charged; no IDs are
recycled and no trees are deleted. Inspection and repair share the same lock without nested unlocks.
The repair method is not added to the endpoint peer socket or model tools.

Native qualification extends the eight provisioning interruptions with explicit repair admission/refusal,
stale-hash refusal, original-intent preservation and read-only duplicate repair checks. Two additional
SIGKILL cases interrupt repair after hard limits and after full verification before its receipt. They
must retain `started`, refuse partial replay/new-ID bypass, and finish a receipt only from verified
completed effects. This is an internal repair backend; operator command/UI integration and broader
reconciliation remain unfinished. Native result/revision follows.

VERIFIED at `e7a1d8d44c63cedfe7339273b7c75ea06987ceff`: native
[run 43698787968](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43698787968)
passed five admissible root-private/missing-root repair cases, refusal of unrecorded/endpoint-owned
states, stale snapshot rejection, original identity/capacity preservation and duplicate-repair observation.
Both additional repair SIGKILL cases passed: incomplete repair stayed unresolved without replay, while
completed effects were observed before marking the original repair complete. A replacement ID could
not bypass either retained repair. The existing scoped Harness/storage/systemd checks, typecheck and
builds also passed. Two local installation-planning tests passed before native qualification.

Full case details/source hashes: [repair evidence](evidence/086-storage-repair.json). Internal backend
repair is implemented for the proven states above; it is not an operator CLI/UI workflow. Orphan adoption,
worker-owned partial states, general quiescence, interrupted-repair manual reconciliation, backup/restore/
migration, headroom, reboot/clean-host recovery and final architecture qualification remain open. The new
`repairs` table is part of the host registry and must be included by future backup/migration support.
No running user-host service was changed.

### Local operator inspection and repair command

The root-owned installation now includes `agentic_storage_admin.py`. It supports `inspect` and `repair`
locally on the execution host; no peer-socket operation, model tool or remote root privilege is added.
Both commands open the original registry in existing-only mode: its private lock/database, WAL mode,
required tables, pinned endpoint configuration and namespace must already exist. This mode does not
create a registry, migrate schema, enroll an endpoint or initialize a namespace. An older/incomplete
registry must be handled explicitly rather than silently upgraded by inspection.

Operator sequence, after the separate deployment/installation action:

1. Copy the original five-field host request (`endpointId`, `requestId`, `requestHash`, `workspace`,
   `projectId`) from retained records into a root-owned mode-0600 JSON file under a protected directory.
   Do not invent a replacement request ID or project ID.
2. Run `/usr/bin/python3 -E -s -B /opt/agentic-storage/ENDPOINT/agentic_storage_admin.py
   --config /opt/agentic-storage/ENDPOINT/host.json --registry /var/lib/agentic-os-storage
   inspect --request /root/storage-request.json`, using the actual installation/registry paths.
3. Review the returned inspection, including root identities, ownership, quota state and `snapshotHash`.
   Inspection never authorizes repair by itself. If `repair` is non-null, preserve that original
   `repairId` and `originalSnapshotHash`: these reconstruct the original approval when its file was lost.
   Do not replace the original snapshot with the current inspection hash. Repeating that original repair
   only observes existing effects; an incomplete repair remains held for further explicit reconciliation.
   A recorded `complete` phase is historical, not fresh proof of healthy storage. If `repair` is null,
   for an intended new repair prepare a separate root-owned
   mode-0600 JSON file containing exactly `request` (the same original five fields), `repairId` (a stable
   unique operator operation ID), and `snapshotHash` (the reviewed hash).
4. Run the same command prefix with `repair --approval /root/storage-repair.json`. The backend obtains
   fresh evidence and refuses any mismatch or inadmissible state before committing a repair intent.
   On response loss, preserve the exact request, repair ID and approval file; the same repair only
   observes existing effects and cannot blindly repeat them. Do not substitute a new ID to bypass refusal.

Successful commands emit structured JSON. Refusal exits nonzero with `state: unverified` and a generic
message, preserving retained records. Python bytecode writing is disabled so operator imports do not
modify the immutable installed bundle. The command does not enable/restart services or change provider
credentials. Original endpoint-side grant/receipt recovery is a separate step after a host repair.

Native tests now invoke the operator command to inspect all crash states and perform the five admissible
repairs, exercise the installed command against a live service, verify unchanged reinstall afterward,
and require a missing registry to remain empty. Run/revision evidence follows.

VERIFIED at `6d03d95547afba39047fecb5e5d201769ab758fe`: native
[run 43699200686](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43699200686)
passed operator inspection across ten interruption states and all five supported repairs through actual
CLI processes. The installed command inspected a live service registry, and unchanged reinstall afterward
confirmed no extra bundle files. Missing-registry inspection failed without creating files. Existing
scoped storage/Harness/systemd checks, typecheck and builds passed. Local installation-planning tests
also passed. Exact cases/source hashes: [operator command evidence](evidence/086-storage-operator-command.json).

This closes local root command packaging and its tested inspection/repair journey. It does not close
endpoint receipt recovery after host repair, orphan/worker-owned partial-state reconciliation,
interrupted-repair manual resolution, storage backup/export/migration, headroom, machine reboot/clean-host
recovery or final architecture qualification. No user-host service was installed, restarted or upgraded.

### Endpoint receipt recovery after root repair

A new disposable native journey starts the real root storage service with a fixture-only fault at the
worker allocation's first project setup. Startup qualification is unaffected. The non-root endpoint
submits its original grant request; the service dies after recording the root identity but before
project setup. The endpoint must retain a `provisioning` storage reservation and publish no grant.

The root fixture reads the original request from the host registry, inspects it through the operator
command, and repairs the recorded/missing-root state with an explicit snapshot-bound repair ID. It
then starts the normal unmodified service. The endpoint is stopped/reopened before retry: its original
pending reservation must be unchanged. Retrying the same grant request observes the repaired host
allocation, commits the endpoint receipt and continues the existing native file/process/verification,
quota-exhaustion and restart checks. The root fixture requires exactly the original startup and worker
allocations and one completed repair bound to the original request.

This is an actual root service/operator CLI/non-root endpoint journey using Harness filesystem and
subprocess implementations. It does not add production fault hooks or claim coordinator-UI repair,
power-loss recovery, or an installed Harness launcher failure/retry journey. Local typecheck passed;
recorded native results follow.

VERIFIED at `22c1c403352f5b02416d86db47863097a20b142f`: native
[run 43699646579](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43699646579)
passed the new endpoint/root-operator recovery journey. The endpoint preserved the failed provisioning
intent without publishing a grant, retained it unchanged across restart after repair, and completed the
same original request. Native file/process/verification/quota-exhaustion checks then passed. The host
retained exactly two allocations and one completed repair tied to the original request.

The scoped run passed 15 native Vitest test executions (including normal and repaired variants of the
endpoint test), the existing Python contracts and crash/systemd/Harness fixtures, typecheck and builds.
Source hashes and exact scope: [endpoint repair journey evidence](evidence/086-storage-endpoint-repair-journey.json).
This proves endpoint receipt recovery for the tested recorded/missing-root state, not every partial
state, coordinator-UI repair, managed-launcher failure/retry, power loss, reboot or clean-host restore.
Backup/export/migration, broader reconciliation, headroom and final architecture qualification remain open.

### Pending workspace request inspection

Administration receipts for pending/unknown grant creation now expose the existing read-only storage
status control, using the original request's workspace identifier even when no grant was published.
Inspection does not retry creation, settle the receipt, or generate a replacement request ID. The
existing explicit original-request retry remains available. This closes the UI visibility gap for
failed provisioning; privileged repair still requires the local operator workflow.

Validation: endpoint UI/coordinator suites passed 16 tests; optional-provider contracts passed 12
with the separately gated Harness integration test skipped. Typecheck and all build targets passed.
No running app restart, live provider inference, or new native Linux qualification was performed for
this UI-only change. Full architecture and broader recovery gates remain open.


### Coordinator recovery after root repair — verified

At `c6c314c03038cd0089e9dda9de0cac5295bc96c5`, the native repair journey now submits the original
workspace request through the production coordinator and authenticated endpoint HTTP. The root service
is killed during provisioning; the coordinator retains an unknown request across its own restart.
After explicit root CLI repair and endpoint restart, coordinator storage inspection observes repaired
roots while leaving both the administration receipt and pending reservation unsettled. Explicit retry
then completes the original command, and a repeated retry returns the same receipt. Exactly two host
allocations and the original repair remain.

[Run 43700326077](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43700326077)
passed the scoped Linux storage workflow (15 native Vitest executions, existing Python/service/systemd/
crash fixtures, typecheck and builds). See [recorded evidence](evidence/086-storage-coordinator-repair.json).
This adds coordinator receipt recovery evidence, not browser acceptance, a managed-launcher failure/repair
journey, general orphan reconciliation, backup/restore, power loss or reboot qualification. No app deployment.


### Retained repair approval inspection

VERIFIED at `7b436422261bbb1f0160c42f2b5da800f92612e6`: inspection includes nullable `repair`, with
`repairId`, recorded `phase`, and `originalSnapshotHash`. It validates the saved repair against the
original host request and refuses malformed records. This is read-only evidence for reconstructing
a lost approval file; it does not authorize a new repair, resume partial effects, or prove present health.
The snapshot digest includes this retained record, so receipt changes invalidate an earlier inspection.

Three SQLite contracts passed locally and in Linux CI. Native operator inspection after both repair
SIGKILL boundaries recovered the exact original approval without changing the registry. Scoped
[run 43700712481](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43700712481)
passed the existing storage/endpoint/coordinator/installation/crash checks, typecheck and builds.
See [evidence](evidence/086-storage-repair-receipts.json). Incomplete repair reconciliation, broader
orphan handling and backup/restore remain open; no deployment or full architecture qualification.

### Explicit ownership handoff after an interrupted repair

`finish-repair --approval FILE` is a distinct root-operator action for a retained repair that stopped
before handing ownership to the endpoint. The root-private approval JSON contains exactly `request`,
`repairId`, `snapshotHash` (the original repair approval), and `finishSnapshotHash` (the newly reviewed
inspection hash). It uses the same installation/config/registry command prefix as `repair`.

Admission requires the original repair in `started`, both recorded roots still empty/root-owned/mode
0700, exact assigned project IDs with inheritance and no realtime flags, exact hard limits, and quota
inode usage matching the two roots. It does not create directories, apply projects, reset limits,
adopt orphan trees or touch endpoint-owned trees. It appends the handoff snapshot to the original
repair intent and commits `finishing` before changing ownership. Original request/repair IDs and
original approval hash remain unchanged; inspection exposes the additional `finishSnapshotHash`.

Repeating the same handoff approval only observes. A fully applied handoff whose reply was lost can
be confirmed and marked complete. A handoff interrupted between the two ownership changes remains
unverified; neither a fresh snapshot nor a new repair ID bypasses the retained action. Original
`repair` replay likewise remains observation-only. Older host code refuses the extended repair intent
rather than silently replaying it. Installation upgrade remains a separate unresolved workflow.

This addresses the recorded empty/root-private post-quota interruption state. Earlier project-setup
interruptions, unrecorded roots, endpoint-owned partial states, general reconciliation, backup/restore,
whole-machine restart and final qualification remain open. Native results will be recorded separately.


VERIFIED at `5d654998f64bab23fc3c83876c45704afc2578b5`: scoped Linux
[run 43701133532](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43701133532)
passed the explicit root CLI handoff, original identity/snapshot refusal checks, and twelve native
crash cases. SIGKILL after the first ownership change remained held without replay; SIGKILL after
complete handoff recovered by observation. Repeated approvals preserved inode/ctime. Four SQLite
receipt contracts, existing scoped storage integration, typecheck and builds passed. See
[handoff evidence](evidence/086-storage-repair-finish.json). No deployment or full qualification.

### Privileged registry snapshot component

The root operator CLI now accepts `backup --output /root/agentic-backups/host-UNIQUE.sqlite`, using
the installed command/config/registry prefix above. The output parent must already be root-private
under protected ancestors and outside both the active registry and this endpoint's quota mount.
The destination must not exist. The command never overwrites, deletes or silently replaces an output;
a failed or lost-response output remains unverified and must be preserved for inspection.

Under the shared host lock, SQLite backup captures the committed registry, including all endpoint
configurations/ranges, namespace identities, original operation records and repair/handoff approvals.
It refuses a pending source transaction, uses a bounded backup deadline, verifies SQLite integrity,
converts the output to standalone DELETE-journal format, and synchronizes the file and parent before
returning its SHA-256, size and table counts. Output permissions are 0600; no row contents are printed.
The source database and filesystem quota state are not changed. This is a root-only local operation,
not an endpoint RPC or model tool. A consistent registry snapshot does not require stopping workers.

The receipt explicitly reports `workspaceFilesIncluded: false` and `restoreVerified: false`. This
component does not capture endpoint/coordinator journals, workspace contents, live quota accounting,
or a globally quiescent system epoch. Restoring the host registry alone could roll back allocation
ownership and must not be used as a recovery procedure. Coordinated inventory/export, fencing,
manifest validation and an explicit restore/import workflow remain required. No backup is created on
the user's host by this development change. Native evidence is recorded separately below.


VERIFIED at `dbd6386980bb2a0475922cd0c644809ed435ff24`: scoped Linux
[run 43701534066](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43701534066)
passed the root CLI backup of the native crash registry: all 12 endpoints, 24 operations and repair
records (including unresolved `finishing`) matched the source SQL dump. Hash, root-private permissions,
standalone SQLite and overwrite refusal passed. Three local SQLite/WAL contracts and the existing
scoped native integration/crash/systemd/Harness checks, typecheck and builds passed. See
[registry backup evidence](evidence/086-storage-registry-backup.json). Coordinated export/restore,
fencing and clean-host recovery remain open; this snapshot alone is not a restore procedure.

### Offline registry artifact verification

The installed root CLI accepts `verify-backup --input /root/agentic-backups/host-UNIQUE.sqlite
--sha256 EXPECTED_HASH` without `--config` or `--registry`. The expected hash must come from the
retained, independently trusted backup receipt. Computing a new hash from an unknown file and approving
it does not establish provenance. No live host, mount, namespace or registry is opened by this command.

Verification requires a private root-owned single-link regular file under protected parents, rejects
SQLite sidecars and WAL-format headers, checks the expected hash and SQLite integrity, and requires
the current four registry tables with the expected columns and no views/triggers. It opens SQLite
immutable/read-only with trusted schema disabled, bounds verification time, and checks file identity,
size and timestamps afterward. It prints counts and `artifactVerified: true`, while retaining
`restoreVerified: false`. This is artifact integrity/format verification, not semantic reconciliation
of individual grants, allocations, quotas, root identities or ownership epochs.

Source investigation for the next integration step: `src/remote/endpoint.ts` still explicitly refuses
`recovery.world` when managed storage is configured. Otherwise that path verifies the original grant,
root identity, credentials, independent ownership, inventory revision and quiescence. Its consumer,
`src/recovery/configuration.ts`, pins the original world and credential binding. `WorldConfigurationObservation`
in `src/remote/recovery.ts` has no storage registry artifact binding, and the receipt image in
`src/recovery/image.ts` has no storage-host snapshot member. Removing the refusal before adding those
bindings would bypass current recovery invariants. CodeGraph context and direct source inspection
confirm this gap; no storage-backed restore is enabled by the offline verifier.

Remaining integration requires an authenticated image member for the host snapshot, a frozen endpoint
storage inventory tied to the same original requests/project IDs/root identities, explicit preservation
of reserved/uncertain allocations and repair approvals, fencing of the old host, and restore validation
against the target filesystem before any endpoint may execute. A standalone SQLite hash alone cannot
prove those properties. No default provider, runtime or live app configuration changes.


VERIFIED at `61a96410567661009efd5d0a3c32d41ff11b9c2a`: scoped Linux
[run 43702016501](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43702016501)
passed offline root CLI verification without a live config/registry argument, expected-hash refusal,
and unchanged native snapshot bytes/counts. Five local SQLite backup/verification contracts, the
existing scoped native storage workflow, typecheck and builds passed. See
[artifact verification evidence](evidence/086-storage-backup-verification.json). This verifies artifact
integrity/format, not allocation semantics, filesystem restoration or clean-host recovery.

### Offline retained-record binding audit

`audit-backup --input SNAPSHOT --sha256 EXPECTED_HASH` first performs the offline artifact checks,
then validates registry relationships without a live host. Endpoint configuration must agree with its
stored UUID, filesystem and project range; ranges may not overlap on a filesystem. Policy budgets,
IDs, root identity shapes and duplicate JSON keys are checked. Allocation rows must match the exact
original request, belong to a registered endpoint with a completed namespace record, use a unique
workspace/request/project, and fit the pinned pool budget. Repair approvals must refer to their
original allocation and preserve the original snapshot, repair ID, phase and any handoff approval.
Duplicate repair IDs or multiple repairs for one original request are refused.

The audit preserves and counts missing recorded roots and unresolved repairs. It returns
`recordBindingsVerified: true` only for internally consistent retained records, with
`liveFilesystemVerified: false` and `restoreVerified: false`. Historical identities are not compared
with a current filesystem; `complete` repair records are not converted into live health evidence.
Neither this command nor `verify-backup` initializes an endpoint, imports a database, changes quotas,
issues credentials, clears uncertainty, or permits the currently refused storage-backed recovery path.

This establishes the host-snapshot side of the recovery contract. The snapshot still needs an
authenticated recovery-image member and a cross-check against the original endpoint `remote_storage`
rows, grant roots, inventory revision and independently fenced ownership before restore can proceed.


VERIFIED native audit at `519725e7db10ebe4c27f7d10be0a4682c4798460`: scoped Linux
[run 43702462270](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43702462270)
passed the root CLI binding audit of the native crash snapshot, retaining one unresolved handoff.
The existing scoped storage workflow, typecheck and builds passed at that revision. A subsequent
pure validation tightening at `174848ffc8e6f049754df3af758bf4b3da3e1921` rejects complete/finishing
repairs without both original root identities; three binding contracts and five backup contracts
passed locally. Native qualification was not repeated for that tightening and is not attributed to
it. See [binding evidence](evidence/086-storage-backup-bindings.json). Endpoint-image cross-binding,
live filesystem/fencing proof, coordinated restore and full qualification remain open.


### Endpoint/host allocation cross-check component

`src/recovery/storage.ts` now validates normalized endpoint and host records together. Policies and
endpoint IDs must match; request IDs/hashes, workspace and project IDs remain original and unique.
Reserved endpoint intents cannot already have a host allocation. Provisioning may have no host intent
(the persisted-before-send interruption window), and that uncertainty is retained as `hostMissing`.
Provisioned entries require matching host root identities, recorded quota limits, filesystem policy
and both expected workspace/verification paths. Extra host allocations or a provisioned endpoint
allocation absent from the host snapshot are refused. Grant roots must point to the matching
provisioned allocation with the recorded device/inode; birthtime still needs live identity proof.

The helper returns counts with `recordBindingsVerified: true`, `liveFilesystemVerified: false` and
`restoreVerified: false`, without mutating inputs. Both catalogs are bounded to 20,000 entries. It is
not yet called by recovery export/restore: authenticated artifact readers must validate original SQL
row keys against JSON values and bind these normalized inputs to their snapshot hashes/inventory
revisions. No storage recovery refusal is removed by adding this component.

VERIFIED at `6c8e0fe82022be23f858bcd6e3e0869b02ab6618`: 34 tests across the new cross-binding suite and
existing storage-journal suite passed, plus typecheck. CodeGraph selected the new suite as affected;
the journal suite supplied adjacent coverage. No native/full qualification was rerun for this pure
backend helper. [Evidence](evidence/086-storage-cross-binding.json). Artifact readers, authenticated
image integration, ownership fencing and restore remain open.


### Bounded original-row readers

The storage recovery component now includes `readEndpointStorageSnapshot` and
`readHostStorageSnapshot`, using the existing `StateReader` byte/record limits, cancellation checks
and capture digests. They accept already-authenticated frozen SQLite handles, never paths, and do
not construct product services. Endpoint metadata, reservation SQL keys and grant SQL keys must agree
with their saved JSON. Host endpoint configuration and operation SQL keys must likewise agree with
original intent and policy. Required tables cannot silently disappear. Reads preserve source journals.

The selected endpoint's normalized host view includes original allocation/root records; the capture
digest also accounts for other host rows, namespace records and repair approvals. Full host artifact
audit remains a prerequisite, not an inferred result of normalizing the selected endpoint. The readers
feed the pure cross-check but are not yet wired into a recovery image or restore command. Snapshot
provenance, frozen-epoch ownership and live filesystem proof still belong to the caller/integration.

VERIFIED at `d46eabc97b258e6558d267f22d490c7e8735514d`: 41 focused/adjacent tests passed before a
type-only narrowing correction; typecheck and all 18 recovery-storage tests then passed after that
correction. Tests cover direct SQLite normalization, unchanged mutation counters, mismatched keys,
missing tables, cancellation and repair-row digest changes. No native/full suite was rerun for these
read-only readers. [Evidence](evidence/086-storage-row-readers.json). Full recovery integration remains open.


### Verified private artifact copies

`src/recovery/storage-artifacts.ts` composes expected-hash/size verification, private input checks,
isolated snapshot copies, bounded original-row readers and the endpoint/host cross-check. It uses the
existing recovery `privateInput` boundary, creates a private temporary directory, streams into exclusive
0600 files with bounded size and cancellation, and refuses non-standalone SQLite headers. Only the
verified copies are opened read-only, with trusted schema and extension loading disabled. Temporary
copies are removed on success or failure; original artifact files are not modified.

The result includes expected file hashes/sizes and captured record digests, keeps live-filesystem and
restore verification false, and explicitly reports `hostRegistryAuditRequired: true`. Expected hashes
must come from the existing authenticated recovery manifest; the helper does not authenticate arbitrary
caller-supplied hashes or create a parallel approval envelope. Manifest membership, the full root-registry
audit, ownership/frozen-epoch checks and recovery integration remain unfinished. No existing storage
restore refusal is removed.

VERIFIED at `9e21316fa56de091a41a4ad8224e1b33b8160088`: final typecheck and 42 focused/adjacent tests
passed, including real SQLite file copies, input immutability, hash/size refusal, cancellation,
non-private files and WAL-header rejection. The initial extension-option spelling was corrected against
the installed Node type definition before final validation. [Evidence](evidence/086-storage-artifact-copies.json).
No native/full qualification or deployment for this read-only pipeline.


### Authenticated held-image storage membership

`ReceiptImage` now supports `storage-host` and `storage-endpoint` members plus explicit endpoint/member
pairs. The existing receipt-image HMAC covers these fields; there is no second signing or approval
system. Each endpoint must appear in the original image resource inventory. Endpoint members cannot
be shared, host members may be shared by endpoints in one registry, and unbound/duplicate/wrong-role
members are refused. After authentication and file verification, the existing private-copy pipeline
checks the pair's saved allocation/grant bindings using hashes from the authenticated manifest.

These are held evidence members. `installCheckpoint` and `readInstallation` explicitly refuse images
containing storage until full host auditing, frozen-epoch fencing and restore integration are available.
Older strict readers reject the new enum/field rather than treating storage as an ordinary world.
Checkpoint capture and receipt preparation do not yet produce these members automatically; the tested
path is construction/sealing/verification of a held image, not a deployed backup or restore workflow.

VERIFIED at `c5e54b4087fcaa675feb65e76b711f07ffe392d8`: authenticated storage-image verification and
installation refusal passed; final typecheck and all seven builds passed for this production source.
The broader recovery ring initially passed 321 tests and failed four stale fixture cases: three expected
three built-in sources where the catalog now registers five, and one expected speculative release
while its simulated reporting turn remained running. Isolation and the adjacent speculation runtime
suite reproduced the latter fixture omission. Fixtures now explicitly end the turn with Harness's idle
event, assert the allocation stays held beforehand, and preserve the production stop guard.

Focused retests passed all three affected source cases plus 31 storage/recovery-resource/speculation
runtime tests. The entire broad ring was not repeated after test-only corrections; no full final matrix
or native qualification is claimed. [Evidence](evidence/086-storage-image-members.json).


### Whole-host audit integrated into signed storage verification

The TypeScript host reader now audits all four registry tables before selecting the endpoint view.
It refuses unknown tables/columns, views/triggers, invalid host IDs/paths/configurations, overlapping
filesystem project ranges, duplicate allocation identities, capacity overflow, allocations without
completed namespace records, and orphan/duplicate/mismatched repair approvals. Complete/finishing
repairs require their original root identities; handoff phase and approval fields must agree. This
runs on the verified private copy reached through existing signed-image membership, including records
belonging to other endpoints in the shared registry.

`hostRegistryAuditRequired` is superseded by `hostRegistryAudit`, containing verified historical
binding counts, incomplete root/namespace counts and unresolved repair counts. An uninitialized
namespace with no admitted operation remains a retained partial state, not a successful namespace.
Both live-filesystem and restore verification remain false. No standalone audit status is accepted
as a substitute for reading the authenticated snapshot itself.

VERIFIED at `7b2ba83dd0af1421eaba50e23c51745c6035fb04`: final 28 storage-recovery tests, typecheck and
all seven builds passed. Earlier focused/adjacent coverage passed 49 tests before additional
namespace/schema assertions. Tests exercise corruption outside the selected endpoint, overlapping
ranges, capacity excess, missing namespaces and invalid/orphan/duplicate repairs, plus signed-image
integration and retained uncertainty. [Evidence](evidence/086-storage-image-host-audit.json).
Automatic capture/preparation, frozen-epoch fencing, live filesystem validation, target import/restore
and final platform qualification remain open. Installation of storage-bearing images stays refused.

### Explicit storage artifacts in encrypted checkpoints

The offline Harness recovery profile now accepts `storageArtifacts`, an array of
`{ endpointId, endpoint: { path, bytes, sha256 }, host: { path, bytes, sha256 } }`.
Paths must identify private standalone SQLite snapshots. Capture checks original
registered endpoint IDs, rejects duplicate pairs, verifies both artifact hashes,
audits the entire shared host registry, and crosschecks endpoint allocations.
It encrypts the verified private copies directly, avoiding a second read of the
caller-owned paths. Checkpoint verification repeats the record checks, rejects
unbound storage members, and staging retains the execution hold. Preparation
preserves the authenticated storage member bindings.

This is explicit evidence capture, not coordinated live capture or filesystem
backup. Supplied hashes do not establish a globally frozen capture epoch. Storage
installation remains refused pending live filesystem validation and ownership
fencing; no storage restore or deployed capability is claimed.

Validation: the checkpoint/storage/installation suites passed 80 tests before the
maintenance-profile forwarding change. Optional-provider checks passed 12 tests;
the installed-Harness test was skipped in that invocation. Typecheck passed after
profile wiring. No external inference or default-model changes were performed.

### Archived storage authority verification

Revision `5c43ca97cd06e65ed81e812051f42abeb98dc1ee` also checks storage endpoint membership against the
authenticated coordinator registrations and execution-world records during every
verification/staging operation. A validly re-sealed archive whose source registration
has been removed is rejected; encryption alone does not prove this relationship.
The affected checkpoint/storage suites passed 63 tests and typecheck passed.
See [evidence](evidence/086-storage-source-authority.json). Live capture and restore
qualification remain open.

### Offline endpoint snapshot command

Build the checkout, then run as the endpoint's service user while its server is
stopped (the command refuses its active writer lock):

```sh
pnpm build
node scripts/endpoint-storage-snapshot.mjs /absolute/endpoint-state /absolute/new-snapshot-directory
```

The destination's parent must already be a private directory owned by that user.
The destination must be new and outside endpoint state. The command opens the
original database read-only without constructing an endpoint or changing operation
phases. It creates a standalone private SQLite backup, validates storage records,
and writes `snapshot.json` containing `endpointId` and the `{path, bytes, sha256}`
endpoint descriptor required by the checkpoint profile's `storageArtifacts` entry.
Combine that descriptor with the separately verified host-registry backup descriptor.
Keep these state artifacts private; the command prints metadata, not database rows
or credentials. Failure retains any partial output for inspection; never infer
success from an output directory's existence or overwrite it on retry.

Holding the endpoint writer lock does not prove worker-process quiescence or a
shared host/endpoint capture epoch. The receipt explicitly reports no workspace
files, no host registry, no verified execution quiescence and no verified restore.
Those remaining boundaries must be resolved before live storage installation.

The focused storage suite passed 30 tests, typecheck and build passed, and the
built Node command successfully exported a private SQLite fixture. The tested
implementation revision is recorded in [evidence](evidence/086-endpoint-snapshot.json).

### WAL retention and Linux qualification

The exporter now has regression coverage for committed SQLite WAL records and
uncertain original operation IDs, with no source changes or operation settlement.
A malformed storage source leaves a retained output without `snapshot.json`, releases
the writer lock, and refuses reuse of the destination.

At `fb2c4b3e74558750b0c9df5415bbfcb77060e98a`, the focused Linux storage
[run](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43705671144)
passed typecheck/build, 32 recovery/storage tests, 12 XFS probe tests, native service,
Harness launcher and coordinator repair journeys, installation contracts and 12
crash boundaries. The shared registry backup preserved uncertain repair records
and passed offline binding audit. [Receipt](evidence/086-storage-snapshot-native.json).
This is focused qualification, not the final full-system or clean-host restore gate.

### Paired capture lock boundary (operator integration unfinished)

`StorageHost.capture_pair` now holds the shared registry lock continuously across
its host backup and a trusted local endpoint-capture callback. The inner backup
routine does not reacquire/release the same flock, so it cannot accidentally expose
a gap before endpoint capture. Competing-lock tests prove exclusion during the
callback and release on success/failure; failed outputs remain retained and cannot
be overwritten. Seven backup and three binding tests passed at the revision in
[this receipt](evidence/086-paired-capture-lock.json).

The next integration step is an explicit operator command that invokes the existing
endpoint exporter as its configured service user while this host lock remains held,
then verifies both returned artifacts and emits a pair receipt. That command is not
implemented yet. The callback primitive alone does not prove an endpoint lock was
acquired, establish whole-system capture consistency, or permit live restore.

### Paired capture operator command

The root operator CLI now invokes the endpoint snapshot exporter as the configured
endpoint UID/GID, with no supplementary groups, inherited credentials or shell.
The endpoint must already be stopped; its writer lock is still mandatory. Build
the Agentic OS checkout first and supply absolute, canonical paths:

```sh
python3 scripts/agentic_storage_admin.py \
  --config /root/storage/host.json --registry /root/storage/registry \
  capture-pair --output /root/storage/backups/new-host.sqlite \
  --node /usr/local/bin/node \
  --exporter /opt/agentic-os/scripts/endpoint-storage-snapshot.mjs \
  --endpoint-state /var/lib/agentic-endpoint/state \
  --endpoint-output /var/lib/agentic-endpoint/backups/new-snapshot
```

The host destination parent is root-owned/private; the endpoint destination parent
is private to its service user. Both outputs must be new. The exporter and its built
bundle must be readable by that user. This command does not install or start either
service. Existing installations need an explicitly reviewed package update to gain
the new helper; this development work does not update a running installation.

The shared host registry lock stays held from its backup through endpoint capture
and artifact validation. Endpoint subprocess output is bounded to 64 KiB, with a
120-second deadline, and failure terminates its process group. The parent checks
the returned original endpoint ID, file ownership/mode/link count, bounded size,
SHA-256, standalone SQLite header and stable file identity. Only validated metadata
is returned. Failure retains partial artifacts, emits no successful pair, and never
retries or overwrites a prior capture.

The JSON result contains `pair.host` (including its path) and
`pair.endpoint.endpoint`, which supply the checkpoint profile's two artifact
descriptors. Capturing under overlapping locks establishes a stable control-record
interval; it does not copy workspace contents, stop orphan worker processes, or
prove their quiescence. `recordBindingsVerified` remains false here: checkpoint
capture must still run the complete endpoint/host record crosscheck. Transfer the
artifacts privately to the checkpoint operator with the required ownership and
original hashes; do not grant the endpoint user access to the live root registry.

The focused Linux [run](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/43706252687)
passed at `f4c9ae55eebcac657b4659e7e32a4565384d0ca8`: real root CLI to
unprivileged Node exporter, source preservation, matching hashes and overwrite
refusal. It also passed 32 recovery tests, 12 quota probes, the existing native
launcher/repair/installation journeys, and 12 crash boundaries. The paired fixture
seeds endpoint storage records from retained host intents; a full live-endpoint
capture-to-checkpoint journey is still required. [Evidence](evidence/086-paired-capture-native.json).

Paired exporter validation additionally rejects duplicate JSON fields, altered
endpoint IDs/hashes/sizes, public artifact permissions, false restore claims,
oversized output and failed subprocesses. Two local subprocess tests (eight
rejection cases) and seven backup tests passed at the revision in
[this receipt](evidence/086-capture-receipt-refusals.json). The local tests assert
privilege-drop arguments but mock that OS boundary; preceding native CI provides
its separate evidence. These contracts now run in the Linux storage job as well.
