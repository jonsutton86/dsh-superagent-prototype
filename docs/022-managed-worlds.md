# Managed execution worlds

One personal/local coordinator can maintain several explicitly activated remote execution worlds. Each agent action selects
an exact world; the existing Engine dispatches its worker through DeepSeek Harness. The coordinator keeps its normal local
services. Filesystem and process services for each remote worker are mounted together in a Harness preset scope.

This extends [020 Endpoint administration](020-endpoint-administration.md), [017 Remote missions](017-remote-missions.md)
and [018 Execution ownership](018-execution-ownership.md). The remote endpoint, leased grants and Linux confinement remain
the execution boundary. Activating a world does not provision a machine or launch an endpoint.

## Operator workflow

1. Use a personal/local execution profile and an already running remote endpoint. Register the endpoint through the
   Environments page, verify its identity and issue a grant with the required operations and credential bindings.
2. In the confirmed grant receipt, choose **Activate in this coordinator** and name the world. Activation verifies the
   pinned administrator credential, endpoint identity, native confinement, current grant generation, root and operation set.
   It persists a private connection and immutable authority reference before opening providers. A failed activation remains
   visible for explicit retry; it does not redirect work elsewhere.
3. Stop any dedicated profile using that grant's state directory before activation. Both paths use the same exclusive world
   journal lock. One world cannot have two coordinator owners using that state directory concurrently.
4. Choose **Execution environment** when adding an agent action or editing a mission plan. An omitted selection retains the
   profile's default environment. The selection records the complete authority ID, not a friendly name or mutable endpoint
   alias. Catalog changes and pagination cannot substitute another generation. Person-owned actions cannot select a world.
5. Run the reviewed action. The host verifies the selected world before creating the ticket and again during preparation and
   tool dispatch. The task directory, execution grant, immutable Session preset and actual mounted filesystem/process pair
   must agree. A local executor directory override cannot relocate a selected remote action.
6. Inspect world-specific execution receipts or the task's receipts. **Retry or refresh original world** rechecks the pinned
   connection and original receipts. **Revoke this execution world** stops its open tasks and persists revocation before the
   endpoint request. Endpoint acknowledgement and confirmed quiescence are separate facts. Other worlds remain usable.

Revocation is irreversible for that world generation. Issue and activate a newly authorized generation for new work.
Changing or removing an action's world through plan review increments its definition and invalidates affected downstream
acceptance. Existing Sessions never migrate to that new world; create a new run after the old run is stopped or finished.

## Runtime composition

`WorldPool` is a Cordis service owned by the existing Runtime. It persists world records and idempotent command receipts in
the existing coordinator Store. Each open member owns one `RemoteWorld` journal, one paired host filesystem/process view,
a `RemoteWorkspace` and authority-specific child, worker and router presets. There is no new workflow engine or database
service. World catalogs are paginated in SQL, at 100 metadata records per page.

Remote presets use a `cordis:group` that isolates both `fs` and `subprocess`. The exported `dsh-superagent/scoped-world`
plugin borrows the exact already-open world and supplies its paired providers. It does not open another journal per Session.
Other Harness services, model routing, persistence, tool execution, compaction and delegation remain Harness-owned.
The pool checks the actual mounted services using the public `agentPresets.serviceFor` API, in addition to checking the
persisted preset label. Managed activation requires this API; this composition is qualified against Harness 0.2.1-rc.3.

The mission definition and source authorization compare the exact environment reference. The executor reads selection only
from the authorized workspace trigger, stores the world's revision and epoch in the execution, and creates a directory below
that grant's root. Generic model text cannot change the selection. `workspace_environments` exposes bounded metadata for
candidate plans; it cannot activate authority, approve a plan, move its own Session or dispatch another action.

Worker and child tools retain assignment ownership, scope and persona guards. Remote search uses the selected process
provider. PowerShell is denied because these presets supply a paired POSIX shell rather than a remote PowerShell provider.
Embedded operational skills avoid local coordinator resource paths. Session restoration uses Harness's persisted preset
selection and rechecks the actual pair before admitting tools. Unknown, unavailable, revoked or mismatched worlds fail closed.

## Recovery and authority

Activation pins the private credential's content and the complete grant identity before first startup. A changed credential
or authorized generation cannot be adopted implicitly, including when no previous world journal exists. A failed member
does not prevent independent members from opening. Explicit refresh retries the same connection and authority.

Revocation records the original request ID and reason before contacting the endpoint, immediately closes local admission,
and stops only tasks bound to that world. A disconnected response remains pending. Retrying sends the same revocation,
without creating a new grant or claiming remote work stopped. Reusing a request ID with a different payload is rejected.
Successful or failed activation replay returns the current view of the same world; it does not create another activation.

On restart the pool opens before managed Session recovery. Revoked members retain their old world identity and receipt
journal even when the endpoint has advanced the grant epoch. That path permits receipt observation and cancellation only;
it never adopts new execution authority. Unresolved receipts continue to block new effects under the existing recovery
rules. Closing a coordinator releases providers and journals; it is not evidence that every remote effect is quiescent.

Cordis plugin activation finishes before asynchronous Runtime restoration. Harness preset diagnostics can wait for the Host
Loader tree to settle, so waiting for restoration inside that same plugin activation would create a startup cycle. Sources
still await `SourceHost.ready`; runtime admission remains closed until initialization completes. The management API remains
available during startup or a reported initialization error. Readiness checks use `health.runtime.state`, not merely a
verified default environment. Closing during pool restoration prevents subsequent Session creation.

## Management API

Paths are relative to `/orchestrator/api/` and retain the existing single-operator management protections.

| Method/path | Purpose |
| --- | --- |
| `GET worlds?offset=0` | Paginated metadata and availability; no private connection or credential contents |
| `POST worlds` | Activate a confirmed endpoint grant using `requestId`, `endpointId`, `commandId`, `name` |
| `POST worlds/:id/refresh` | Retry the same pinned world and reconcile original receipts |
| `POST worlds/:id/revoke` | Persist and send revocation using `requestId`, current `revision`, `reason` |
| `GET worlds/:id/execution` | Paginated effects owned by this world |
| `POST worlds/:id/execution/refresh` | Read-only original-ID receipt reconciliation |
| `POST worlds/:id/execution/:effect/cancel` | Same-ID cancellation of a command owned by this world |

Existing `tickets/:id/execution` routes resolve the ticket's exact execution world. They cannot fall back to another world
or the coordinator's local services. Mission action and plan schemas accept `environment` as a 64-character authority hash.

## Qualification and remaining scope

The deterministic tests exercise two real HTTP endpoints, separate paired providers, exact per-action dispatch, actual preset
service checks, selected-world directory precedence, isolated revocation, offline revocation replay, changed-credential
refusal, explicit recovery and revoked-journal reopening. Rendered UI checks cover lost activation/revocation replies,
preserved request IDs and revisions, exact generation selection and world-specific receipt routes. The opt-in Harness test
covers both the existing dedicated profile and managed composition using the configured model.

Qualification on 2026-11-08: code commit `cecfde32924209bca220bcf01fd9ac3b28aedabd` passed local `pnpm check` with
1,376 tests, typechecking and all four builds. Five cases were skipped locally: three platform-dependent cases and the two
opt-in Harness cases. The latter passed separately using Harness 0.2.1-rc.3 and `deepseek-official/deepseek-flash` (117.57s).
Managed qualification restored both worlds before work, produced task-provenance-matched artifacts in each, proved a
child-owned command under the second world without the first world's service credential, revoked only the first world,
restarted again, inspected its old receipts and continued the second worker in its original Session/world with a new artifact.
The dedicated-profile case also retained the existing persona, credential, artifact and restart checks.

The same code commit passed [Linux run 42528377954](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42528377954):
1,378 tests, typechecking and all four builds on Ubuntu 22.04/Node 24, including native filesystem/process confinement,
remote mission dispatch and private credential mount/revocation cancellation. Three cases were skipped there, including
the two separately qualified configured-model cases. Cross-host deployment and native Linux configured-model composition
remain distinct from the local Harness qualification.

Local endpoint fixtures on macOS use explicitly test-only unconfined providers. They qualify composition, transport and
ownership; native Linux confinement is checked separately. Browser/desktop layout is not qualified by DOM tests.

Remaining architecture work includes managed machine/endpoint provisioning, remote Git/repository workflows, cross-host
deployment drills, distributed coordinator ownership and failover, checkpoint/backup restore, quotas and cost reservations,
stronger multi-workspace boundaries, richer supervision and the other open product requirements. Managed worlds currently
require personal/local execution mode. Endpoint credential bindings can support worker code, but do not by themselves
complete the repository credential and Git lifecycle. The full article and Agentic OS implementation remains in progress.
