# Remote repository workspaces

A managed execution world can now select one immutable HTTPS Git source. When an Agentic OS mission action starts in
that world, the existing DeepSeek Harness executor prepares a task checkout on the endpoint before creating the worker
Session. The coordinator does not clone the repository or interpret its remote path as a local path. General missions,
personas, grants, command receipts, verification and review continue through the existing architecture.

## Operator setup

Prepare and enroll a Linux endpoint using [managed endpoint launch](067-managed-endpoint-launch.md), optionally through
[managed SSH transport](071-managed-ssh-transport.md). The endpoint needs Git with HTTPS support, Python 3, Node in its
system runtime mounts, bubblewrap and a filesystem supporting atomic no-replace directory renames. The Ubuntu qualification
host provides these dependencies. The production endpoint still requires Linux confinement; the macOS fixture is explicitly
unconfined test infrastructure.

In **Environments → Remote endpoint administration**, import a repository credential into the endpoint's private credential
store when the repository is private. Bind its exact version to a new grant with `fs.read`, `fs.write`, `process.spawn` and
`network`. A read-only repository token is recommended. Provider-side scopes must be configured at the provider; Agentic OS
cannot infer that a token is read-only. Credentials already bound to a grant are available to authorized worker commands,
so this feature does not provide a separate worker/publication credential boundary.

Activate that grant in the coordinator, enable **Prepare a Git repository for new tasks**, and enter:

- The HTTPS Git URL, without embedded credentials, query parameters or a fragment.
- A full immutable lowercase commit ID (40 hexadecimal characters, or 64 for a SHA-256 repository).
- The ID of the already-bound repository credential, if required. Enter an ID, never the secret value.
- The provider's HTTPS username, defaulting to `x-access-token`.

An explicitly bound file credential named by the `GIT_SSL_CAINFO` environment variable can supply a private CA. The Git
preparation process does not inherit ambient proxy, credential-helper, trace or Git configuration settings. Use the
repository's canonical HTTPS URL: redirects are disabled. The remote server must permit fetching the selected commit by
its full ID; an inaccessible commit fails preparation rather than falling back to a branch tip.

The selected source appears on the world card. Select this exact world when adding a mission action. World readiness checks
the execution endpoint; it does not fetch the repository. Repository reachability and commit availability are checked when
the task is prepared. A lost activation response retries the same submitted source and request ID, even after form edits.

The source is immutable for that grant generation. Changing the URL, commit or credential selection requires explicitly
authorizing and activating a new grant generation. Existing tasks remain attached to their original world and files.

## Preparation and task lifecycle

Preparation uses a deterministic command identity derived from the world binding and ticket ID. It runs through the paired
remote subprocess provider, retaining its admission checks, ownership attribution, leases, resource limits, cancellation,
output collection and durable receipts. The source, selected credential metadata and command enter the receipt; credential
bytes do not enter the command arguments, Git configuration or preparation diagnostics.

The endpoint creates a fresh private staging directory, initializes Git without templates or hooks, and shallow-fetches the
exact commit. It verifies that commit, checks the objects, and checks out branch `agentic/<ticket-id>`. It syncs files and
directories without following checkout symlinks, then atomically renames the staging directory without replacing an existing
destination. Linux uses `renameat2(RENAME_NOREPLACE)` through Python's standard-library libc binding. An unsupported syscall
or filesystem refuses publication; there is no overwrite fallback. The macOS test fixture uses `renamex_np(RENAME_EXCL)`.

The original task's worker starts only after the preparation command succeeds, is quiescent, and the checkout and `.git`
directories resolve to their assigned locations. Its initial assignment includes the original URL, base commit and task
branch. This is a separate directory and branch per task, not a separate kernel isolation boundary inside one shared grant.
Workers authorized for a shared root can access that root according to its existing grant.

Every subsequent launch checks the original receipt. A successful earlier checkout is reused without resetting files,
refetching an advancing upstream or discarding task commits. An existing directory alone is never accepted as proof of
preparation. A mismatched receipt, missing checkout, unknown outcome or failed preparation refuses launch. Staging files and
existing task work remain available for inspection; retry does not invent another preparation ID or delete partial work.

Stopping a task while it fetches requests cancellation through the existing remote process handle and prevents worker
creation. Coordinator shutdown aborts pending preparation too. Remote quiescence and unknown-result rules still apply:
loss of a reply is not proof that a fetch stopped. Original-ID observation resumes across coordinator replacement. Generic
diagnostics identify the failing stage without relaying Git/provider stderr or credential values.

## Boundaries and remaining architecture

This implements repository preparation for managed worlds in the general-mission profile. It does not enable the legacy
global repository execution mode under ownership fencing, alter its safety guard, or create an independent branch/PR
publication service. Branch pushing, PR creation/update, CI and branch-policy integration, merge authorization and complete
remote Git recovery remain required. Existing explicit-commit PR review and host Git-tree verification remain separate
capabilities, not evidence that publication is complete.

The initial fetch is shallow. Submodules are not recursively cloned and Git LFS objects are not downloaded. Builds that
need these inputs or more history require explicitly authorized provisioning work. The HTTPS preparation path is bounded
to 180 seconds, with a 120-second limit per Git subprocess. Disk quotas, workspace aggregate budgets, credential scope
separation/rotation, fleet provisioning, cloud deployment and clean-host failover remain in the full Agentic OS ledger.

## Verification

The integration fixture uses real Git and a private authenticated smart-HTTPS server with a generated token and CA. It
never accesses a user's repository credential or external Git host. Contract tests cover the pinned commit after upstream
advances, independent task branches, continued task commits, coordinator replacement, lost spawn acknowledgement,
interrupted fetch cancellation, existing/concurrently created directories, unknown receipts, registry recovery and UI retry
identity. The unknown-receipt case is explicit fault injection, not a physical crash test. Linux qualification uses actual
bubblewrap; local macOS fixture results do not establish confinement or cloud behavior.

Validation on 2026-11-09 (America/New_York):

| Check | Result |
| --- | --- |
| Focused repository, world-pool and rendered UI checks | 22 passed |
| Registry recovery and documentation checks | 15 passed |
| Full macOS `pnpm check` | Typechecking, seven builds and 2,063 tests passed; 25 skipped; 177.81 seconds for tests |
| Full Ubuntu 22.04 ARM64 / Node 24 suite with native confinement and installed Harness | Typechecking, seven builds and 2,076 tests passed; 14 skipped; 190.44 seconds for tests |
| Linux delegated endpoint, native systemd/Harness and SSH service checks | 30 passed; 14.53 seconds |

All 12 repository cases ran in the Linux suite with real bubblewrap, Git and private HTTPS. The SHA-1 path is qualified;
the accepted SHA-256 format has not received an end-to-end provider qualification. Worker model responses in the repository
mission tests are fixtures; these tests establish dispatch and actual remote checkout behavior, not model coding quality.
No external Git repository or model provider was contacted. The existing app remained HTTP 200, ready and unpaused.
No owned test service files or loaded test units remained on Linux after the checks. Cloud and cross-machine acceptance,
native browser journeys and the complete architecture remain outstanding.

Sources: Git [fetch](https://git-scm.com/docs/git-fetch), [configuration](https://git-scm.com/docs/git-config),
[credentials](https://git-scm.com/docs/gitcredentials), and Linux [rename semantics](https://man7.org/linux/man-pages/man2/rename.2.html).
