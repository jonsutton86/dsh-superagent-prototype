# Managed execution endpoint launch

The persistent launcher in [066 Persistent launcher](066-persistent-launcher.md) now has a Linux execution-endpoint role.
It installs and starts the actual DeepSeek Harness endpoint from [016 Remote execution](016-remote-execution.md), then
exports the identity and private credential path needed by [020 Endpoint administration](020-endpoint-administration.md).
It preserves the existing paired filesystem/process boundary and supports the existing independent ownership binding.

## Prepare the Linux execution host

Use a dedicated Linux host or account, Python 3.9+, the checkout's supported Node.js version, npm, bubblewrap, and a built
checkout. Node must resolve inside a system runtime mount, such as `/usr/local/bin/node`, so confined helpers can execute
without mounting the host's home directory. Linux / Node 24 is the native CI qualification target. Installation refuses
macOS and missing bubblewrap; there is no unconfined production fallback. Namespace support and the actual filesystem/
process boundary are tested by the endpoint itself before its RPC handler becomes ready.

From the built checkout on that host:

```sh
python3 scripts/agentic-os init --role endpoint
python3 scripts/agentic-os start --role endpoint
python3 scripts/agentic-os status --role endpoint
python3 scripts/agentic-os enrollment --role endpoint
```

The default installation directory is `$XDG_DATA_HOME/agentic-os-endpoint`, or `~/.local/share/agentic-os-endpoint`.
The profile is `agentic-endpoint` and the default listener is `127.0.0.1:3084`. `--directory`, `--profile`, `--port`,
`--checkout` and the pinned `--dsh` selection follow the workspace launcher's rules. Use `--role endpoint` to select the
endpoint's default directory on subsequent commands; an explicit `--directory` can select its saved role directly.
The launcher installs Harness `0.2.1-rc.3` unless a matching installed CLI is supplied.

The generated patch disables the coordinator and GitHub/Feishu Sources in this profile and inserts the real execution
endpoint plugin. `state/` holds its journal, signing key and administrator token; `workspaces/` holds granted execution
directories. These are separate siblings. Control directories and ownership credentials cannot reside inside granted
workspaces or system runtime mounts. `home/`, `runtime/` and `logs/` stay private to the installation. No model API key is
copied to the endpoint or required there; inference remains on the coordinator.

## Readiness and enrollment

Readiness requires the actual owned Harness process and an authenticated RPC identity matching the UUID in its private
local journal. The response must advertise Linux, bubblewrap, filesystem/process services, effect ownership, administrative
operations, credential bindings and snapshot verification. Optional ownership identities must match the configured binding.
The first successful explicit start persists the endpoint UUID and an administrator-credential fingerprint. Subsequent
starts cannot silently adopt a replaced journal, changed token or weaker confinement. A mismatch leaves the process
intact but refuses readiness and enrollment; it does not create replacement authority or repair lost state automatically.

`enrollment` writes mode-0600 `enrollment.json` and prints the endpoint UUID, loopback origin, private administrator-file
path and configured command/output limits. It never prints the token. This command requires a running verified endpoint.
The endpoint role is headless; `access` and `open` direct the operator to enrollment instead of opening a workspace page.

For a coordinator on another machine, provide HTTPS termination or an authenticated tunnel to the endpoint's loopback
listener. For example, with an already trusted SSH connection, a coordinator-side tunnel can use:

```sh
ssh -N -L 127.0.0.1:4084:127.0.0.1:3084 user@linux-host
```

Transport the administrator file from the exact endpoint path into a private, owner-only regular file on the coordinator
through that trusted provisioning channel. Do not paste its contents into the app. Register the exported UUID in
Environments → Remote endpoint administration, using `http://127.0.0.1:4084` for this example and the **coordinator's** private
credential-file path. The endpoint's own filesystem path is not automatically a path on another machine.

Create a grant through the existing administration controls, then activate it as a managed world. Each task retains its
reviewed world/grant binding. The dedicated-profile path remains available when the whole Harness profile should execute
in that environment. Exporting enrollment details does not register a coordinator, create a grant or dispatch a task.

## Limits, ownership and lifecycle

An optional `init --endpoint-config /absolute/private/endpoint.json` accepts only `allowedEnv`, `maxRunning`,
`outputMaxBytes` and `ownership`. Defaults match the endpoint: no additional environment names, eight running commands,
and 8 MiB retained output per stream. Bounds are 1–32 commands and 64 KiB–64 MiB output. These are concurrency and output
retention limits, not CPU/memory/disk quotas. Ownership accepts the existing complete authority URL/UUID, coordinator ID,
resource ID, private credential-file path and bounded timeout; raw secret values and arbitrary profile overrides are rejected.
Repeated initialization refuses different settings and preserves existing files. The generated launch patch remains pinned.

```sh
python3 scripts/agentic-os restart --role endpoint
python3 scripts/agentic-os stop --role endpoint
python3 scripts/agentic-os start --role endpoint --respect-stop
```

The same exact-process identity checks, operation lock, graceful SIGINT, private log retention, intentional-stop marker and
timeout behavior apply as in 066. Restart preserves the journal, UUID, credentials, workspaces and original effect receipts.
It does not revive expired/revoked grants or convert unknown work into success. The daemon's normal shutdown and startup
reconciliation remain authoritative for job quiescence. No forced kill or state-directory replacement is performed.

## Verification and remaining deployment scope

Fixture-process tests cover role-specific patch construction, private enrollment output, identity persistence, credential
changes, weaker confinement and unsupported-host refusal alongside the existing workspace controls. An opt-in native test
starts actual pinned Harness endpoint and coordinator profiles, registers the endpoint through the real management API,
activates a managed world, runs a native confined command, checks filesystem access, and verifies original receipts and
world identity through both daemon restarts. It requires no model credential or external publication. Native CI installs
the pinned Harness and runs this test with the full confinement suite. Local focused checks passed 25 tests (three
platform/native cases skipped). Local `pnpm check` passed typechecking, all six builds and 2,005 tests (19 skipped;
139 passing test files and four skipped; 136.55 seconds). Native installed-Harness results are pending. The pushed runtime
revision is `8de414a1465ff1cdb38d2d9e9beaed6e16c5e1b8`; GitHub lists no checks for that commit, and an explicit workflow
dispatch returned HTTP 422, "Actions has been disabled for this repository." Earlier successful Linux runs do not qualify
this new endpoint launcher. Enable repository Actions or run the opt-in qualification on a prepared Linux host before
treating the installed endpoint/coordinator drill as verified.

This implements endpoint installation and daemon lifecycle on a prepared Linux host. Automatic cloud-machine provisioning,
fleet capacity management, managed tunnel/TLS setup, login/boot services, CPU/memory/disk quotas, cross-host qualification,
credential rotation, repository preparation and clean-host recovery remain in the full architecture. Passing a same-host
native endpoint/coordinator drill does not establish those separate deployment guarantees.
