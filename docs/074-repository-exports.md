# Reviewed repository exports

Managed repository tasks can now prepare a Git bundle of their original commits after the pinned base. The bundle is
stored in resumable, hash-checked chunks in the coordinator's existing SQLite Store and can be downloaded from the
artifact card. It preserves commit identities and binary objects. It is the transfer input for independent repository
publication; pushing branches and creating pull requests remain separate, unfinished work.

## Operator workflow

Use a world configured with a [pinned remote repository](073-remote-repositories.md), let the task commit its changes,
and publish its result artifact. Run an enabled host-authored artifact check that captures the entire repository. In the
artifact's **Repository export** section, select passed checks and choose **Prepare reviewed Git bundle**. Every selected
check must identify the same artifact revision/hash, original assignment/world, clean SHA-1 commit and complete content
tree. The source commit must differ from the pinned base. Dirty, partially captured, unrelated or unbound work is refused.

The card displays the base, checked commit, transferred bytes, bundle digest and retained evidence review. A ready bundle
is downloadable. **Resume original export** observes the existing command and continues at the last stored byte; it does
not rerun a failed command. **Retry original request** preserves the submitted request ID and checks when a response was
lost, even if the displayed artifact changes. Cancelling releases coordinator chunks after the original command's stop is
observed, or it is confirmed absent. An unknown outcome remains held for reconciliation. Endpoint files are preserved.

## Execution and persistence

The coordinator records a UUID request, its fingerprint and exact source/check bindings before dispatch. A deterministic
`repository-export-<UUID>` job runs through the original world's paired Harness process provider, retaining its grant,
ownership attribution, lease, cancellation and resource accounting. It runs a host-selected helper, never a command from
the artifact or model. The helper disables network protocols, ambient Git configuration, hooks, prompts and lazy fetches.
It checks the source's HEAD, tree, clean status and base ancestry, creates one private sibling export directory without
replacement, writes and verifies the bundle, checks the source again, hashes and syncs the bytes and directories, and
returns only bounded metadata. Errors retain files and use generic stage diagnostics rather than Git stderr.

The coordinator checks the original job identity, grant generation and exact command. Only a successful quiescent job
can supply bundle metadata. Unknown, mismatched and failed original jobs cannot be replaced by retry. Paired remote
filesystem reads stream 64 KiB chunks into `repository_export_chunk`; offset and digest commit atomically with the
`repository_export` receipt. No endpoint path is read through the coordinator's local filesystem.

After transfer, a new host freshness capture must still match the selected checks and original source. Only then does the
receipt become `ready`. A ready bundle is immutable historical reviewed content: later source edits do not rewrite it.
A future publisher must separately validate its publication approval and destination; an export is not permission to
push. Downloads verify all stored chunks and the complete hash before sending headers, and check again while streaming.
The download route retains the existing management origin/authentication/header guard and disables caching.

Coordinator restart turns interrupted preparation into a held receipt without dispatch. Explicit resume observes the
original job and retains already stored chunks. Runtime shutdown aborts active preparations. Cancellation cannot overlap
another resume and refuses unresolved remote work. Historical cancelled receipts remain for request replay.

Exports reserve at most 256 MiB each, 2 GiB in total and 128 active receipts. There is a separate 10,000-receipt audit bound.
The list prioritizes all active receipts and then recent cancelled history, capped at 128. Limits are admission bounds,
not endpoint disk quotas: Git can temporarily write an oversized bundle before its size is rejected. Automatic endpoint
cleanup and audit-history compaction are not implemented.

## Recovery contract

Held-image publication validation checks request fingerprints, original managed source/world, artifact and check bindings,
review attempts and recorded freshness seals, chunk ordering/size/hash, received offsets and complete bundle digests.
Orphan chunks and substituted authority are rejected. Bytes stream through a separate 2 GiB bound; only bounded metadata
enters the general recovery reader. This inspection does not contact a provider, dispatch a job, renew evidence or change
the Store. Existing world-effect inventory/reconciliation remains responsible for unresolved endpoint commands. Restoring
these records does not itself qualify clean-host remapping or failover.

## API

Paths below are relative to `/orchestrator/api/`.

| Method and path | Result |
| --- | --- |
| `GET library/:id/repository-exports` | Active and recent export receipts for an artifact |
| `POST library/:id/repository-exports` | Prepare with UUID `requestId`, artifact `revision`, `hash` and selected `checks` |
| `GET repository-exports/:id` | Original export receipt |
| `POST repository-exports/:id/retry` | Observe and resume the same intent |
| `POST repository-exports/:id/cancel` | Observe cancellation and release coordinator chunks |
| `GET repository-exports/:id/download` | Authenticated verified binary Git bundle |

## Qualification and remaining work

Tests use actual Git and the private authenticated HTTPS repository fixture, without external Git credentials or model
calls. They reconstruct the exact original commit and parent in a separate repository; exercise multi-chunk transfer,
partial-transfer restart, lost spawn acknowledgement, source changes during transfer, explicitly simulated unknown jobs,
cancel/retry, corrupted bytes, read-only recovery authority validation and rendered lost-response retry. Native Linux
qualification uses actual bubblewrap; macOS uses explicitly labelled host-process test infrastructure.

Validation on 2026-11-09 (America/New_York):

| Check | Result |
| --- | --- |
| Full macOS `pnpm check` | Typechecking, seven builds and 2,070 tests passed; 25 skipped; 147.95 seconds for tests |
| Full Ubuntu 22.04 ARM64 / Node 24 suite with native confinement and installed Harness | Typechecking, seven builds and 2,083 tests passed; 14 skipped; 172.51 seconds for tests |
| Linux delegated endpoint, native systemd/Harness and SSH service checks | 30 passed; 14.58 seconds |
| Additional authenticated download / exact-commit reconstruction case | Passed on macOS and native Linux after adding HTTP byte/header/origin assertions |
| Rendered publication controls and documentation checks | 9 passed |

A final streaming-integrity guard also rejects unexpected negative-offset chunks. After that change, macOS typechecking,
all seven builds and the focused export/UI/documentation suite passed (15 tests; 48.78 seconds). The full-suite figures
above precede that final defensive guard; the authenticated HTTP case was separately checked on both systems.

All six export integration cases ran under real Linux confinement. The existing app remained HTTP 200, ready and unpaused
without a restart. No external Git provider or model call was made. Linux reported no remaining owned test unit files or
loaded test units after qualification. Physical/cloud execution, live provider publication and clean-host failover remain
unqualified; the native results cover the recorded local VM configuration.

Runtime/test revision `dd1b3fe2469b8e63f71d09aaa8814b3b4e68bae5` is pushed to `feat/full-superagent-architecture`.
GitHub returned zero workflow runs for that SHA and rejected explicit dispatch with HTTP 422: Actions is disabled for
this repository. No repository or billing settings were changed. Local Linux qualification is independent of CI, and the
test VM was stopped normally after cleanup. The running app was not restarted to load this increment.

Next, the independent publisher needs resumable chunk ingestion, base/object verification, write credentials isolated from
workers, an ownership check and durable uncertainty boundary before each branch push and PR mutation, exact provider
observation after response loss, explicit partial-result recovery, operator destination review, and recovery inventory
coverage. CI/branch policies and merge authorization follow that path. The legacy repository-mode ownership guard stays
in place. SHA-256 exports, submodule/LFS provisioning, endpoint disk quotas, fleet setup, cloud acceptance and the rest of
the full Agentic OS architecture remain open; this increment does not narrow that scope.
