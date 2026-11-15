# 086 — Workspace storage quotas (design checkpoint)

Status: source and focused native mechanism investigation complete; endpoint implementation pending. This increment does not advertise
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
