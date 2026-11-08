# Endpoint administration and dedicated profiles

The Environments page now manages remote endpoints independently of its current execution world. It registers a trusted
endpoint connection, lists grants and credential metadata, submits durable administrator requests, reconciles uncertain
effects, and generates the complete dedicated Harness profile overlay described in [017 Remote missions](017-remote-missions.md).
It uses the existing endpoint protocol and [credential bindings](019-endpoint-credentials.md), retaining DeepSeek Harness
as the process, filesystem, Session and model runtime.

## Operator workflow

1. Deploy the supported Linux endpoint using [016 Remote execution](016-remote-execution.md). Keep its control directory
   separate from execution workspaces. Obtain its UUID through your trusted provisioning channel and transport its
   administrator credential to a private file owned by the coordinator service user. Use HTTPS or an authenticated tunnel
   exposing a loopback HTTP origin. The administration service does not create the tunnel or provision a server.
2. Open **Environments → Remote endpoint administration → Register endpoint**. Enter a name, pinned UUID, origin, and the
   local administrator credential **path**. Registration verifies the pinned identity and an administrator-only catalog
   request before committing. The panel never accepts a raw bearer token.
3. Open **Manage endpoint**. Create a workspace grant with an owner, workspace identifier, allowed operations and lease
   duration. A paired Harness world requires filesystem reads and process execution. Network permission is optional.
   Leases are at most five minutes; a running world renews its own lease. Merely opening the administration page does not
   extend a grant or restore revoked authority.
4. Optionally provision service credentials under the endpoint's private `credential-imports/` directory, then import
   their filenames and select exact versions when creating a grant. Rotate or revoke existing credentials from their
   records. Rotation invalidates old bindings and requests cancellation, as documented in the credential contract.
5. For a confirmed enabled grant request, select an unused loopback port and choose **Generate remote Harness profile**.
   Inspect the generated configuration. Start a **dedicated** Harness profile with this bundle installed using the displayed
   `dsh --profile … --patch … --no-open` command, replacing the profile-name placeholder. Start before the lease expires.
   Profile generation saves configuration; it does not launch a daemon or move running Sessions.
6. Reauthorization explicitly creates a new grant generation, cancels work under the old generation and requires a new
   execution world. Existing Sessions and tasks retain their old bindings. A new generation can retain valid credential
   bindings, replace them with selected current versions, or remove all bindings explicitly.

The overlay disables the standard local filesystem/process providers and generic agent presets, configures the endpoint
grant as the execution boundary, inserts the paired `remote-world` provider, and gives each endpoint/grant generation its
own persistent world and application directories. It preserves the dedicated profile's inference/model configuration.
Provider credentials remain on the coordinator. The local port is validated but not reserved. Custom profiles must not add
other execution providers that conflict with these replacements. Runtime world startup performs its own authority checks.

## Durable administration

Registration metadata and administration requests live in the coordinator's existing single-writer SQLite Store. Each
request records the exact normalized RPC, original request ID, registration revision, pinned connection and credential
digest **before** remote mutation. Administrative actions are serialized locally. Runtime shutdown aborts outstanding
transport and drains the writer before closing the database. Startup never automatically dispatches pending requests.

A lost endpoint response leaves a visible `unknown` request. A crash may leave `pending`; both can be retried explicitly
from the saved receipt after restart. Retry uses the same RPC and ID at the original endpoint binding. Re-submitting the
original panel form observes its existing receipt instead of issuing a new effect. Conflicting payloads under an existing
ID are refused. A protocol refusal before a first acknowledgement is distinguished from an unconfirmed transport outcome.
An ambiguous earlier delivery remains unconfirmed when a later retry is itself refused.

Endpoint grant idempotency receipts return the grant's **current** metadata. Therefore the coordinator captures the intended
authorization epoch before dispatch and validates it on response. An old creation/change replay that returns a later epoch
is marked `superseded`; its token is never saved or used to compose a world. Reauthorization requires a fresh explicit
request using the current grant revision. Grant creation also verifies workspace, owner, operations and credential versions;
changes preserve root identity and the intended authority. Profile generation rechecks that the recorded epoch remains
enabled and unexpired before publishing configuration.

Grant bearer values are written only to mode-0600 files under private mode-0700 generation directories. Publication writes
and syncs a temporary file, atomically renames it under the Runtime's single-writer lock, then syncs the directory before
recording success. Replays accept an existing file only when its complete content and private-file properties match.
Interrupted staging may leave an unreferenced private temporary file; cleanup/retention is not automatic. API responses,
command journals and generated patches contain metadata and paths, never bearer values.

Administrator files must be owned regular files with one hard link and no group/other access. Registration rejects a
symbolic-link file and persists the canonical parent path. Reads use no-follow/nonblocking opens, file-stability checks and
a content pin on every request. Replacing the administrator file requires explicit registration update at its current
revision. Older pending requests retain their original connection and file pin; updating registration does not redirect
them or silently reauthorize them. Restore the original private credential when retrying those requests, or investigate the
original endpoint independently. Keep registration snapshots, Store backups and grant files together during recovery.

Known local execution workspace roots cannot enclose administrator or generated control files. This is an accidental
placement guard, not OS isolation for local arbitrary code. The management API remains same-origin and loopback-only,
within a single trusted operator/service-account boundary. Administrator authority is not exposed as an agent tool.
Multiuser authentication, credential brokers and isolation of local coordinators remain separate requirements.

## Reconciliation and catalog

Administrator-only `grant.list`, `grant.get`, `job.catalog` and `operation.list` complement existing credential and command APIs.
Catalogs use bounded 100-record pages. The endpoint projects command metadata before transport and omits argv, stdin, environment,
output and file-effect payloads. Grant catalog responses never include grant bearer credentials. The UI can cancel an
original command or submit explicit reconciliation of an unknown command/file operation with a verification note.

Before reconciliation, independently inspect endpoint process ranges and resulting file state. The UI requires an
affirmation that the operation can produce no further effects. This records operator evidence and clears the endpoint's
recovery fence; it does not convert the unknown outcome into a successful execution receipt. Reconcile through the
administrator control plane, then refresh the originating world's execution receipts and setup state as needed.

## Qualification and remaining work

The tests exercise actual endpoint HTTP, coordinator Store reopen, Runtime management routes and rendered operator forms.
They cover original-ID recovery after both endpoint and panel response loss, superseded generation refusal, pinned-file
changes, unsafe file placement, credential binding and rotation, private profile generation, typed administration-only
requests, explicit reconciliation, and payload-heavy catalogs exceeding the transport cap before endpoint projection. The opt-in real-model Harness test now registers the endpoint, imports a synthetic
service credential, obtains its grant through this administration service and launches the **unchanged generated overlay**.
The temporary base profile selects the qualification model. It verifies endpoint credential use, owned execution receipts,
an artifact and retained task/world identity across a coordinator restart.

Local verification on 2026-11-08: `pnpm check` passed typechecking, all four builds and 1,356 tests across 79 files;
the three native Linux cases and opt-in model case were skipped in that ordinary macOS run. The separate configured-model
qualification passed against Harness `0.2.1-rc.3` and `deepseek-official/deepseek-flash`, completing credential use, artifact
publication, execution attribution and coordinator restart from the generated profile. Native Linux confinement and
real-model composition remain separate acceptance boundaries; the macOS test endpoint does not qualify OS isolation or
cross-host transport.

Native Linux qualification passed for code commit `0c07ac80126d4aa9c0fbefd5047fcc96742eda37` in
[run 42522276793](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42522276793), job `128858164276`.
Typechecking, all four builds and 1,358 tests passed across 79 files. All three native confinement cases ran: filesystem and
process confinement, remote mission dispatch, and private credential mounts/cancellation. The real-model and non-Linux
refusal cases were skipped in CI. The runner used Ubuntu 22.04, Node 24, bubblewrap 0.6.1 and ripgrep 13.0.0. The separate
configured-model qualification passed twice, including on the release build for `9faef224704e2c08504698e11194f64ed228b9d0`;
the subsequent catalog-only fix leaves that generated-profile execution path unchanged.

Per-action environment/persona selection, managed runtime pooling/launch, endpoint provisioning, cross-host deployment,
quotas, retention, persistent-state ownership and restore/failover remain in scope, alongside the other article and Agentic
OS product requirements. This increment makes endpoint authority operable from the app; it is not whole-product completion.
