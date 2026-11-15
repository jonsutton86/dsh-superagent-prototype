# 086 — Workspace storage quotas (design checkpoint)

Status: source investigation complete; implementation and native enforcement pending. This increment does not advertise
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
