# Durable execution ownership

The [remote mission composition](017-remote-missions.md) now records every command and file mutation made through its
paired Harness providers before sending it to the endpoint. This connects the endpoint's durable effect ID to the
coordinator's mission task, assignment, Session and tool call. DeepSeek Harness continues to own the inference/tool loop;
the existing Engine owns authorization and assignments. No additional workflow runtime or database service is introduced.

## Dispatch and authority

`ExecutionEffects` shares the single-writer, FULL-synchronous WAL database in the remote world's private state directory.
A receipt contains the immutable world binding, grant/generation, endpoint request fingerprint, effect ID, timestamps,
operation, target and executable name. It does not copy command arguments, stdin, environment variables or file content
into the operator journal. Paths, executable names and endpoint diagnostic text remain visible to the local operator and
may contain sensitive application data; this is not a generalized secret-redaction boundary.

The public Harness `tools/execute` waterfall establishes an asynchronous ownership scope from the verified Session's
owning task and current assignment. Child Sessions use the same verified parent chain as mission dispatch. Workspace
preparation has explicit assignment ownership; other trusted host operations are identified as coordinator maintenance.
Concurrent calls retain independent scopes. Worker arguments, shell text and environment variables cannot override the
owner. Assignment, mission, Session world and permission validity are checked again at actual effect dispatch, including
same-ID transport retries. The journal commits ownership before the first network request.

Ownership is provenance, not a new security principal: one profile's tasks still share one grant. The endpoint's existing
authentication, generation, lease, allowed operations and Linux confinement remain the execution authority. The endpoint
stores the owner as part of the request fingerprint and receipt. A composed world requires the endpoint's negotiated
`effectOwnership` capability. Update the endpoint before deploying this coordinator version. Standalone protocol clients
may omit ownership for compatibility; existing unowned endpoint records are never retroactively attributed to a task.

## Outcomes, restart and uncertainty

Receipts distinguish `pending`, `accepted`, `started`, `settled`, `refused` and `unknown`. Quiescence is a separate field:
`true` means the effect is confirmed stopped, `false` means it is not yet confirmed stopped, and `null` means the coordinator
cannot establish termination. A settled receipt can contain a failed exit or file error. A stopped command with an unknown
outcome is not shown as successful, and receipts do not independently establish mission acceptance or artifact validity.

A lost acknowledgement retries the identical request with its original ID and captured owner. A second unconfirmed
response preserves uncertainty. A deterministic first-attempt protocol refusal can establish that execution was denied;
a refusal after an unconfirmed first attempt cannot establish that earlier work did not happen. Conflicting receipt IDs,
owners, generations or fingerprints are rejected. Late observations cannot undo already confirmed quiescence.

After coordinator restart, every unfinished receipt is marked recovered/unknown. Startup and subsequent maintenance
observe the original IDs using `job.get` or `operation.get`; they do not replay command or file-write bodies. Recovery
queries at most 16 pending receipts per pass, fairly ordered by last observation. Newly issued commands can run together
normally. Unknown effects and recovered effects that are not quiescent block new execution in this world. Leases continue
to renew while an operator investigates, and durable revocation takes priority over observation/renewal.

An unknown/missing receipt may mean a request never arrived, its acknowledgement was lost, or a remote effect outlived a
process. Absence is not proof of no execution. Observe the endpoint, cancel a known command, or use the existing endpoint
administrator reconciliation after independently establishing termination. Only acknowledged **quiescent whole-grant
revocation** can fence possibly delayed requests without locating their individual receipts. It leaves their outcomes
unknown and never re-enables the old world. Administrator reconciliation of file effects is not exposed as a casual
"mark successful" action in the panel.

## Operator interface

The Environments page displays the current world's paginated receipts, including coordinator operations. Remote task
details display only their bound receipts. Both retain access while execution is unavailable or the task has ended.
Records show ownership, outcome, quiescence, diagnostic text and any administrator reconciliation. "Check remote status"
only observes existing IDs. "Cancel this command" targets the original command and preserves the cancellation request
ID through an ambiguous UI response. File writes do not receive a misleading rollback/cancel control.

All routes inherit the existing loopback host, origin and management-header checks. This is a local single-owner operator
API, not a public multi-tenant API. Task routes require the task's persisted execution-world binding to match the current
profile; a task-scoped cancellation cannot target another task's receipt.

| API relative to `/orchestrator/api/` | Behavior |
| --- | --- |
| `GET execution?offset=0&limit=20` | Current world metadata, up to 100 per page, total, next offset and world-wide blocked count |
| `POST execution/refresh` | Observe a bounded batch of original receipts |
| `POST execution/:effect/cancel` | Cancel a tracked command with `{requestId}` |
| `GET tickets/:id/execution` | Same paginated metadata restricted to one bound task |
| `POST tickets/:id/execution/refresh` | Observe pending effects; return this task's first page |
| `POST tickets/:id/execution/:effect/cancel` | Ownership-checked command cancellation with `{requestId}` |

If unresolved recovery held startup in setup, resolve the receipts and use the existing setup recheck to resume dispatch.
The global blocked count may include effects outside the current task; inspect the Environments page for those records.
Operator observation does not resume failed tasks or mark them complete on its own.

## Qualification and remaining scope

Automated acceptance covers durable ownership before endpoint dispatch, one effect after acknowledgement loss, concurrent
scope isolation, file ownership, assignment changes during transport retry, running and missing receipts across restart,
cancellation ownership, administrator revocation, conflicting ownership and endpoint capability negotiation. The integrated
mission test uses the actual public Harness tool waterfall for child and worker calls and checks the management routes.
Rendered component tests cover pagination and lost cancellation responses without converting unknown outcomes to success.
The opt-in configured-model Harness qualification checks command ownership and its persistence through coordinator restart.

Local verification on 2026-11-08: `pnpm check` passed typechecking, all builds and 1,336 tests across 76 files; two native
Linux cases and the opt-in model test were skipped in the ordinary macOS suite. The model test passed separately on the
final build against Harness `0.2.1-rc.3` and `deepseek-official/deepseek-flash`: actual tool ownership matched the mission,
assignment, Session and call, and persisted through a real coordinator restart. This composition test uses the explicitly
injected macOS test endpoint; native Linux confinement requires its own CI receipt.

Native Linux qualification passed for code commit `5ca3cbce579c0a96208ec1276eedefefb2cc11e6` in
[run 42517702121](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42517702121), job `128844243646`.
Typechecking, all builds and 1,337 tests passed across 76 files, including the native remote mission with child/tool ownership,
task receipt API, cancellation after task completion and revocation. The configured-model test and non-Linux refusal case
were skipped. The Ubuntu 22.04 runner used bubblewrap 0.6.1 and ripgrep 13.0.0. This establishes the exercised Linux
confinement and application integration; it does not establish cross-host deployment or whole-product completion.

Cross-host transport deployment, endpoint credential bindings, operator enrollment, quotas, per-action worlds/personas,
state backup/restore and failover remain separate work. These receipts do not certify external publication, grant a child
independent authority, prove that an artifact fulfills its task, or eliminate the need for administrator investigation of
unknown endpoint effects. Visual browser/desktop acceptance remains unperformed in this increment.
