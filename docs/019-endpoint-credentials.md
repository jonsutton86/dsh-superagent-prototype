# Endpoint credential bindings

The [remote mission world](017-remote-missions.md) can now use service credentials owned by its execution endpoint.
The inference provider credential remains on the coordinator. Endpoint service credentials are imported locally into
private immutable snapshots and explicitly bound to a grant by version. The existing Harness process provider, Engine,
grant generations and [execution receipts](018-execution-ownership.md) remain the execution path.

## Credential and execution contract

Only endpoint administrators can list, import or revoke credential records. RPC accepts an import **filename**, not a
credential value or an arbitrary host path. The endpoint reads it from `STATE/credential-imports/`: a private regular file
owned by its service user, without symlinks or additional hard links, no group/other permissions, at most 64 KiB. Environment
credentials additionally require 1–8192 bytes of nonempty UTF-8 text without NUL. One final LF/CRLF is removed for environment
injection; file credentials retain exact bytes. Importing a new version never reads the source file again for that version.

The endpoint writes a mode-0600 snapshot under `STATE/credential-vault/`, syncs the file and directory, then commits its
version record and idempotency receipt in SQLite. Its private checksum is verified before command dispatch. Public records
contain ID, variable name, mode (`env` or `file`), random immutable version, revision, enabled state and timestamps. They
exclude secret bytes, private checksums and source filenames. A command may bind at most 16 credentials; duplicate IDs or
variables are refused. Bindings cannot overwrite runtime, shell, loader, Node, Harness or coordinator environment settings.

`grant.create` and administrator `grant.change` accept explicit `{id, version}` references. The endpoint resolves them into
immutable binding metadata. Grants with credentials require process permission and the endpoint's `credentialBindings`
capability. A worker cannot import, revoke or replace credentials, add a binding through command arguments, or override a
bound variable through its environment overrides. The world fingerprint includes nonempty credential bindings; existing
credential-free fingerprints are unchanged. Command receipts record the exact bound versions without secret values.

At dispatch the endpoint checks authority, reads and validates only the selected snapshots, then mounts them read-only
under `/run/dsh-credentials/ID` inside bubblewrap. It mounts the self-contained command launcher at `/run/dsh-command.mjs`.
The launcher's configuration contains paths, variable names and ordinary command arguments; **no credential values enter
the provider's argv, environment, stdin, command request or receipt metadata**. Inside the namespace the launcher loads
environment credentials, sets file-credential variables to their read-only paths, and replaces itself with the requested
program using POSIX `execve`. Stdin/stdout/stderr and the provider's managed process range are preserved. File RPC helpers
do not mount these credentials. Authority is revalidated again after asynchronous confinement preparation and before spawn.

These are explicit process capabilities. All commands under a credential-bearing grant, including workspace preparation,
can access its credentials. Authorized code can print them, copy them into artifacts, or send them over a permitted network;
output remains ordinary durable command output. This is not a secret-exfiltration filter or a claim that arbitrary agent
code cannot disclose secrets. Use narrow service accounts/tokens and separate grants for distinct authority. The current
profile shares one grant across its tasks. A broker that performs service-specific requests without releasing credential
bytes, per-command selection, dynamic cloud identity and a managed secret-store adapter remain separate extensions.

## Rotation, revocation and recovery

Importing the same ID at its current revision creates a fresh version. Revocation disables the current record. The catalog
commit immediately fences new use of old bindings; the endpoint then disables affected grants, advances their authorization
epochs, records the reason and requests cancellation of their processes. Grant status and renewal validate credential
bindings too. Startup checks this state before exposing execution, so a crash between catalog commit and grant cancellation
cannot silently restore old credential authority. Quiescence is still observed independently through original command IDs;
revocation acknowledgement alone is not proof that every process stopped.
This removes endpoint execution authority; invalidating the service token at its issuer is a separate operator action.

Replaying the original import/revoke request ID does not rotate again and cannot revoke a subsequently authorized version.
Replaying an import also does not read a changed import file. Reusing an ID with changed payload is refused. An old grant
cannot renew itself into a new credential version. To reuse its workspace, an administrator must supply current credential
references (or explicitly remove them with `credentials: []`) in `grant.change`, which advances the epoch and issues a new
grant credential. Compose a new coordinator world/profile for that authority; existing Sessions never inherit it.

Import files and old immutable snapshots are retained privately. Do not remove snapshots referenced by uncertain jobs or
discard deduplication state to unblock execution. Automated retention, encrypted storage/KMS integration, backup/restore
and secure deletion are not supplied by this increment. Protect and back up the private control directory as endpoint state.

## Provisioning and administration

Build and install the updated endpoint package; `lib/remote-command-worker.js` is included alongside the filesystem helper.
The production endpoint remains Linux-only and requires bubblewrap, namespaces and a supported Node runtime. Run it under
a dedicated service account with control state separate from worker and runtime directories. The endpoint creates
`credential-imports/` and `credential-vault/` with mode 0700. Place the service credential in a mode-0600 file in the import
directory using your normal secret provisioning channel; do not place its value in shell arguments, repository files or
coordinator prompts.

Use the host-only administration client through the pinned endpoint's TLS connection or authenticated loopback tunnel:

```js
import { writeFileSync } from 'node:fs'
import { RemoteClient } from 'dsh-superagent/remote-client'

const admin = new RemoteClient({
  url: 'http://127.0.0.1:3083',
  endpointId: 'THE-PINNED-ENDPOINT-UUID',
  credentialFile: '/private/operator/endpoint-admin.token',
})
const credential = await admin.intent({
  op: 'credential.import', requestId: 'service-import-1', id: 'service', revision: 0,
  file: 'service-token', variable: 'SERVICE_API_KEY', mode: 'env',
  reason: 'Authorize this service account for the research workspace',
})
const receipt = await admin.intent({
  op: 'grant.create', requestId: 'research-grant-1', owner: 'coordinator', workspace: 'research',
  operations: ['fs.read', 'fs.write', 'process.spawn', 'network'], leaseMs: 300000,
  credentials: [{ id: credential.id, version: credential.version }],
})
writeFileSync('/private/operator/research-grant.token', receipt.credential, { flag: 'wx', mode: 0o600 })
```

For a JSON/service configuration file use `mode: 'file'` and the environment variable your CLI expects to contain its path.
Omit `network` for offline credentials/workflows; credential bindings do not independently enable networking. Install any
required service CLI in the endpoint's trusted runtime. This does not enable the coordinator's repository/account adapters
on remote profiles; those still require separate command/connector policies and acceptance.

| RPC | Administrator operation |
| --- | --- |
| `credential.list`, optional `offset` | Up to 100 public credential records per page |
| `credential.import` | Create (`revision: 0`) or rotate against the current revision, with a stable request ID and reason |
| `credential.revoke` | Disable against the current revision, with a stable request ID and reason |
| `grant.create`, optional `credentials` | Bind exact current versions during enrollment |
| `grant.change`, optional `credentials` | Explicitly authorize replacement bindings under a new grant epoch |

The coordinator Environments page displays the bound IDs, variables, modes and pinned versions. It does not collect or
reveal their values. Full endpoint enrollment/administration in the operator UI remains the next integration step.

## Acceptance

Tests exercise real HTTP and Harness process providers: environment/file loading, preserved stdin, no automatic secret
copies in argv/receipts, caller authorization, override denial, import-file validation, version rotation, explicit rebinding,
idempotent replay, cancellation while confinement is being prepared, restart persistence and mutated snapshot refusal.
The opt-in native Linux case verifies read-only mounts, hidden endpoint control state, credential use and cancellation.
The real-model Harness qualification uses a synthetic service credential to verify its hash inside an ordinary worker
command, publishes the resulting artifact and preserves the credential-bearing world through coordinator restart. It never
uses the operator's inference key as a worker service credential.

Local verification on 2026-11-08: `pnpm check` passed typechecking, all builds and 1,345 tests in 77 files; the three native
Linux cases and opt-in model case were skipped in that ordinary macOS run. The real-model test passed separately against
Harness `0.2.1-rc.3` and `deepseek-official/deepseek-flash`, using the explicitly injected macOS test endpoint. This verifies
the credential-bearing Harness path and restart behavior; native confinement is qualified separately on Linux.

Cross-host deployment, grant/persona selection per action, broader service integrations and all other unfinished Agentic OS
requirements remain in scope. Passing these cases is evidence for this credential execution path, not whole-product completion.
