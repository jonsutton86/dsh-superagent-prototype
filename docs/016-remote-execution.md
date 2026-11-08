# 016 Remote execution transport

This increment implements an independent endpoint and paired DeepSeek Harness filesystem/process services. It builds on
[015 Execution environments](015-execution-environments.md) and preserves Harness as the execution framework. It does not
yet enable remote selection in the mission UI: the existing Runtime still admits its verified local environment. Remote
world composition, command-to-assignment ownership, restore and operator enrollment/reconciliation remain integration work.

## Components and authority

`dsh-superagent/remote-endpoint` is a Harness plugin on a dedicated Linux host with local `fs`, `subprocess` and `webServer`
services. Its listener must be `127.0.0.1`; HTTPS termination or an authenticated tunnel is outside the plugin. Both command
execution and filesystem RPC run inside bubblewrap. There is no production unconfined fallback.

`dsh-superagent/remote-world` supplies both `FileSystem` and `SubprocessRuntime` in one dedicated Harness execution-world
scope. Remove that scope's local providers; installing a remote shell alone does not create a remote world. Do not replace
the coordinator's global services or mount this into an ordinary worker scope that cannot override those services. This
plugin requires a pinned endpoint identity, a grant credential file outside worker workspaces and `fs.read`/`process.spawn`.
It renews the same grant generation at startup and once per minute for a maximum five-minute lease. Revocation or lease
expiry cannot be undone by renewal. Loss of the coordinator eventually stops endpoint work through lease expiry.

`dsh-superagent/remote-client` exports the host administration client and typed protocol. It is not a worker tool. Endpoint
identity is a persistent UUID; credentials are bearer secrets protected by TLS/tunnel, not certificate pins. The endpoint
creates a private administration token and HMAC signing key in its control directory. Only administrators create/change
grants or reconcile unknown effects. Each grant credential binds its ID and authorization epoch. Old credentials can inspect
their own old receipts and cancel their own old commands, but cannot submit work or obtain replacement credentials.
Composed providers pin their credential: overwriting its file cannot transfer a replacement generation's authority into an
existing world. Compose a new world with the newly authorized grant instead.

The control directory, workspace parent and system runtime mounts must be disjoint. Every grant pins a canonical workspace
and its device/inode/birth identity. Production workers see read-only system runtime directories, a minimal `/etc`, their own
workspace, isolated `/proc`, `/dev` and temporary storage. Network access is disabled unless the grant includes `network`.
Environment overrides are allowlisted and applied after entering confinement; launcher credentials never enter a worker.
`process.spawn` permits arbitrary code and writes within that workspace, even without the separate `fs.write` RPC permission.
Use a dedicated Linux service account or VM with no secrets in the mounted runtime trees. Bubblewrap is a namespace boundary,
not a VM, resource quota or protection against kernel exploits.
The namespace, mount and environment flags follow the [bubblewrap manual](https://github.com/containers/bubblewrap/blob/main/bwrap.xml).

## Durable effects and recovery

The endpoint uses its own locked SQLite journal with WAL and FULL synchronization. It records `accepted` before responding
to a command and `started` before invoking the local process provider. Duplicate command IDs replay their recorded state;
a changed payload under the same ID is refused. Disconnects reconnect by command ID and byte offset. The client never
submits replacement work merely because an acknowledgement was lost.

Restarted `started` commands and commands lacking confirmed managed-range exit become `unknown`. Started file mutations
also become `unknown`. They are not automatically rerun. Uncertain effects hold new mutations until an administrator records
what happened; reconciliation records a note and quiescence attestation, and does not manufacture a successful exit code.
Accepted commands may launch after restart only if their original grant still authorizes them. Revocation, expiry, cancellation
and replacement generations fence commands again immediately before dispatch. A replacement provider refuses to launch over
an unreconciled command owned by a previous provider instance.

Cancellation is durable before signalling. The endpoint owns the local provider's managed process range and observes its exit
independently of HTTP connections. Client output backpressure does not stop cancellation or exit observation. Endpoint shutdown
requests cancellation, drains with a bound and preserves uncertainty when exit cannot be established. An unread pipe produces
an explicit output failure after the process range exits; it never becomes an implicit claim that output was fully delivered.

Filesystem writes and edits use durable operation IDs, serialized RPC mutations, version guards and atomic publication.
Create-if-absent uses atomic linking; stale versions are refused. Filesystem reads/writes execute through a standalone helper
inside the same confinement as commands, because host-side path checks cannot prevent concurrent symlink substitution.
Guards detect observed changes; they are not locks against independent process writers between the final check and rename.
Transport loss or an ambiguous helper failure preserves an operation ID for reconciliation.

## Limits and capability negotiation

| Surface | Current contract |
| --- | --- |
| Transport | Protocol 1, POST `/execution/v1`, bearer authentication, endpoint pin, no redirects or browser Origin/Fetch requests |
| Workspaces | One endpoint-owned directory per grant; another authorization generation supersedes the old one |
| Leases | 1–300 seconds, endpoint-clock admission, expiry sweep every 250 ms; renewal changes revision without changing epoch |
| Commands | Bounded argv, batch stdin, explicit cwd, allowed environment overrides; default 8 active commands, configurable to 32 |
| Output | 64 KiB windows; durable prefix capped at 8 MiB per stream by default, configurable to 64 MiB; explicit cursor gaps after retention loss |
| Text mutations | UTF-8, at most 512 KiB; binary text replacement allowed with no text diff basis; edits require text |
| File reads | Bounded byte windows and streamed text; direct text reads at most 512 KiB; listings at most 2,000 entries |
| Interactive features | PTY, streaming stdin and control channels explicitly unsupported; batch shell execution is available |
| Spill recovery | Retained output available by RPC; Harness `spillPath` files are not provided yet; output beyond endpoint retention is explicitly lossy |

The journal currently retains command/operation receipts and audit records indefinitely. Automated archival, receipt tombstones,
disk quotas, cgroup resource limits, endpoint-owned credential bindings, coordinator ownership epochs and backup restoration
are outstanding. A lease is endpoint authority, not a distributed coordinator ownership protocol. Do not garbage-collect
deduplication receipts without a design that prevents replaying old effects.

## Deployment and administration

Build with `pnpm install --frozen-lockfile && pnpm build`. Install the built bundle in a dedicated Linux Harness profile,
using the installation procedure in [006 Deployment](006-deployment.md). Disable the superagent, GitHub, Feishu and watchdog
plugins in that endpoint profile. Keep its local filesystem/process providers and add `dsh-superagent/remote-endpoint` with:

```yaml
stateDir: /var/lib/dsh-execution/control
workspaceRoot: /var/lib/dsh-execution/workspaces
allowedEnv: []
maxRunning: 8
outputMaxBytes: 8388608
```

Node must be available inside the mounted runtime (for example `/usr/bin/node` or `/usr/local/bin/node`), and bubblewrap/user
namespaces must work for the service account. Startup performs a confined file/process proof and checks that endpoint control
state is hidden before registering the listener. The build emits a self-contained `lib/remote-fs-worker.js`; it must remain
next to the endpoint plugin. Startup logs the endpoint UUID and administration-token path, never the token. Pin that UUID
and securely place an administration token file on the administering host outside all worker roots. Do not log grant receipts
containing credentials. Example host-side enrollment:

```js
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { RemoteClient } from 'dsh-superagent/remote-client'

const admin = new RemoteClient({
  url: 'http://127.0.0.1:60668', // Authenticated tunnel to the endpoint.
  endpointId: '<UUID obtained from the trusted endpoint host>',
  credentialFile: '/private/coordinator/endpoint-admin.token',
})
const receipt = await admin.intent({
  op: 'grant.create', requestId: randomUUID(), owner: 'coordinator', workspace: 'mission-one',
  operations: ['fs.read', 'fs.write', 'process.spawn'], leaseMs: 300000,
})
writeFileSync('/private/coordinator/mission-one.token', receipt.credential, { flag: 'wx', mode: 0o600 })
```

Configure the paired provider with the same URL/UUID and `credentialFile: /private/coordinator/mission-one.token` in its
dedicated world. This is a developer composition API; it is not yet a supported remote mission deployment recipe.
For administration use `job.list`, `job.get`, `job.output`, `job.cancel`, `grant.change`, `job.reconcile` and
`operation.reconcile`. Preserve request IDs across uncertain responses. Inspect the endpoint and effects independently before
attesting quiescence; a model statement is insufficient. Revocation increments the epoch, so reauthorization requires installing
the replacement credential and composing a new world. Never copy endpoint control state into a worker workspace.

## Verification and outstanding acceptance

`tests/remote.spec.ts` exercises real Harness local providers and real HTTP. Its test-only passthrough confinement is injected
directly and is unavailable through the production plugin. Tests cover paired file/process visibility, lost acknowledgements,
conflicting guards, binary replacement, UTF-8 cursor boundaries, reconnects, backpressure cancellation, offline revocation,
lease expiry with a child process, stale credential fencing, replaced roots, pre-dispatch revocation, restart uncertainty and
operator reconciliation. These establish transport and lifecycle behavior, not Linux namespace isolation.

The `Remote execution qualification` GitHub Actions workflow builds the helper and enables the native gate on Ubuntu 22.04
with Node 24 installed in the mounted runtime. It runs the full suite with `DSH_REMOTE_ISOLATION=1`; its native test also checks
that host loopback is unreachable without a network grant and that a detached child cannot write after offline revocation.
Workflow configuration is not itself a passing run; record the exact commit and result before claiming Linux acceptance.

Run `pnpm test:remote-linux` on the intended Linux host to exercise the built helper and actual bubblewrap boundary. That gate
requires Node in the mounted runtime and user namespaces; it fails on an unsupported host. Native Linux acceptance has not
been run on this macOS development host. Cross-host TLS/tunnel failures, native child-process termination, hostile filesystem
races, coordinator restore/failover and full mission dispatch remain separate required acceptance work. The full article and
Agentic OS objective remain open.

Local verification on 2026-11-08: typecheck, all builds and 74 test files / 1,314 tests passed, with the native Linux case
explicitly skipped. Built endpoint/world/client imports and a standalone built-helper write/read proof passed separately.
The existing local Harness instance answered HTTP 200, reported its environment ready and had zero running or queued work.
No local mission or provider credential was changed by this transport increment.
