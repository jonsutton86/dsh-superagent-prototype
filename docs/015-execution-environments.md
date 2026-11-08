# Execution environment enrollment

DeepSeek Harness owns the filesystem and subprocess services. This increment enrolls the **local execution world** used
by the current profile and binds accepted tasks to a durable execution grant. It extends
[local execution](012-local-execution.md) and the [Agentic OS ledger](010-agentic-os.md).

## Enrollment and proof

The initially configured profile enrolls its local root during startup. Later changes to the configured root or execution
mode require explicit enrollment from the Environments tab. The operator submits the root and mode displayed for review;
a changed profile is refused both before verification and before committing the enrollment.

An enrollment records a UUID, display name, configured and canonical roots, mode, an identity marker, enabled state,
revision and authorization generation. Startup and each launch verify the canonical root, read the persistent marker,
then use a temporary random nonce to prove that host writes, Harness filesystem reads and subprocess reads see the same
file. Temporary proof files are removed on success or failure. The marker is created with mode `0600` and is omitted from
management responses. It is a directory consistency marker, not a secret credential or hardware identity.

The Environments tab shows the configured root, current enrollment, proof status, open task count, grant generation and
local capability limits. It can recheck the directory, revoke execution, authorize new work, or replace an enrollment when
a directory has moved or lost its marker. Execution controls show when environment readiness blocks dispatch.

## Task authority and revocation

New tasks capture `{ environmentId, revision, epoch }` in both their immutable mandate and execution record. Admission
requires a verified and authorized current enrollment. Launch validates that exact grant and assigned directory before
preparation and again before creating the worker session. Symlinks to another task or outside the assigned location are
refused. A task retains its original environment when a new default root is enrolled.

Revocation commits a new grant revision/generation and stops open tickets through the existing Engine, including tickets
waiting for a person's answer and matching legacy executions. Cancellation uses the Harness executor's existing stop and
background-work drain path; the API response records the stop request, not proof that every process has already exited.
Reauthorization creates another generation. It permits newly accepted tasks and never resurrects tasks carrying old grants.
Replacement permanently retires the old enrollment, stops its open tasks and creates a separate enrollment. Existing
tasks are not migrated or silently reauthorized. Stopped results and historical plans remain visible.

Legacy tickets receive a grant on their next launch if their execution matches the current authorized root. Their historical
mandate is preserved. An incompatible legacy directory needs operator remediation; startup does not rewrite execution paths.

All mutations record a fingerprinted request receipt with their state changes. Reused IDs with different payloads fail;
identical retries return current state without repeating cancellation or enrollment. Exact revisions prevent conflicting
grant changes. The UI retains the original request and revision after an ambiguous response, and provides an explicit
retry even after a poll shows newer state. Enrollment, grant and stop changes share SQLite transactions. Audit rows preserve
grant revision, generation, enabled state, timestamp and operator reason.

| API relative to `/orchestrator/api/` | Contract |
| --- | --- |
| `GET environments` | Enrollments, current configured root/mode and enrollment requirement |
| `POST environments` | Verify/enroll `{requestId,name,root,mode}`; replace with `replaceId` and its exact `revision` |
| `PUT environments/:id` | Change grant using `{requestId,revision,enabled,reason}` |
| `GET state` | `environment.ready` and environment health alongside runtime state |

Routes inherit the existing loopback management boundary. Workers do not receive enrollment or grant-management tools.

## Boundaries and remaining architecture

This is a local control-plane authorization boundary, **not OS isolation**. A process with broad local filesystem rights can
copy a marker or race filesystem checks. Neither marker identity nor grant generation supplies remote authentication,
distributed ownership fencing, a lease, or crash-proof exactly-once external effects. Readiness reflects the last check;
files may change between checks, and every launch validates again. Revocation cannot undo side effects already performed.

Remote execution remains open work: paired remote filesystem/process providers in a separately composed Harness world,
authenticated endpoint enrollment, operation scopes, reconnectable process receipts, offline reconciliation, job ownership,
lease fencing and independent endpoint enforcement. An ordinary agent scope cannot replace the shared Cordis services.
Per-action environment selection, stronger sandbox profiles, remote reachability and a paginated audit history UI also remain.

## Verification

Runtime and management-route tests cover initial proof and hidden markers, new-root enrollment, grant binding, provider
mismatch, proof-file cleanup, revocation of running/follow-up/legacy tasks, authorization generations, invalid roots,
symlink substitutions, profile-change and revocation races, replacement, SQLite reopen and idempotent receipts. DOM tests
exercise enrollment, proof failure/recovery, replacement, and exact retry after a committed response is lost and the UI
has refreshed. Browser/desktop layout and remote endpoint acceptance are separate outstanding checks.

2026-11-08: `pnpm check` passed TypeScript, 73 test files / 1,294 tests, and server/client builds on Node 25.9.0.
The lockfile adds only the direct Harness filesystem dependency; existing transitive versions remain pinned.

The actual Harness `0.2.1-rc.3` local profile, using the configured DeepSeek Flash provider, enrolled environment
`19c19ab1-3b84-40eb-9572-ac7f616f2ca8`. Worker `c95c0222214510eb6dbfa92ddc1bd39a` asked a question under generation 1.
Revocation moved the grant to generation 2, stopped that waiting task, and refused new Inbox admission with HTTP 409.
Reauthorization produced generation 3; the old task remained stopped. New worker
`f7f276188d964975d22f9f160291d086` wrote and read `grant-check.json`, published artifact
`b19d4e11-ccc6-4558-b61f-b6a846a03a05`, and ended with a ready report. Its mission remains awaiting operator acceptance.

The qualification driver independently compared the task file, stored artifact and expected 40 bytes:
`{"values":[4,8,12],"total":24,"count":3}` with no trailing newline. SHA-256:
`fc7ab8ed763d2bc29b96bb0e7ca513163210100bad490973236a1ceb5d8c6c69`.
After a process restart, the environment was reverified, both task grants persisted, the revoked task stayed stopped,
and replaying enrollment/grant and task receipts created no additional assignments. The store retained one enrollment,
three grant command receipts and three audit events. The prior accepted planning qualification mission remained completed
at plan version 3. The local qualification directory retains `environment-receipts.json` with these checks; it contains no
provider credentials. These checks establish the exercised local lifecycle, not remote isolation or whole-product completion.
