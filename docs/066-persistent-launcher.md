# Persistent local launcher

`scripts/agentic-os` installs and operates a private macOS/Linux workspace using the existing DeepSeek Harness CLI.
It supplies the local launch path for [010 Agentic OS](010-agentic-os.md) and the operator guide in
[065 Guided setup](065-guided-setup.md). It requires Python 3.9+, Node.js supported by this checkout, npm, and a built
checkout. It does not require tmux. This is a source-checkout installation, not a signed desktop distribution.

## First installation

From the checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
python3 scripts/agentic-os init
python3 scripts/agentic-os start
python3 scripts/agentic-os open
```

`init` installs Harness `0.2.1-rc.3` into a private runtime directory, creates a new web profile and links the built bundle.
Alternatively, `init --dsh /absolute/path/to/dsh` uses an existing CLI after verifying that exact version. The default
installation directory is `~/Library/Application Support/Agentic OS` on macOS and `$XDG_DATA_HOME/agentic-os` or
`~/.local/share/agentic-os` on Linux. Use `--directory /absolute/private/path` on every command to select another installation.
`--checkout`, `--profile` and `--port` apply only to `init`; default profile is `agentic-os`, port 3083. Separate installations
need distinct available loopback ports.

This creates a new workspace. It does not adopt or overwrite an existing application directory, import its credential
store, or recover a removed installation's history. Keep existing installations running while preparing a new one on a
different port. Use the existing recovery procedure for a state migration; copying just the coordinator folder is not
sufficient. Repeated `init` preserves a ready profile and its credentials. An interrupted plugin installation can be
resumed with `init`; partially created profile files are preserved for diagnosis instead of being recreated destructively.

The generated launch patch binds the web server to loopback, selects local execution, disables the GitHub/Feishu Sources,
and gives coordinator state, Session JSONL and attachments persistent locations under the installation directory.
It disables model-generated Session titles. It does not configure a key, submit a task or enable a schedule. Open Harness
Settings → Models to enter the provider key privately, then use Start here. A model appearing in the catalog does not
prove a successful inference request.

## Start, stop and recovery

```sh
python3 scripts/agentic-os status
python3 scripts/agentic-os stop
python3 scripts/agentic-os start
python3 scripts/agentic-os restart
```

The detached process survives closing Terminal. Startup waits for the management API and verifies that it reports this
installation's exact state directory. An occupied port, redirected health response or another application's response
cannot establish readiness. `status` reports the matched process, runtime readiness, component error names and setup
problem code/place. Its exit status is 0 when ready, 1 when unavailable, 2 for component errors and 3 for a setup problem.
Runtime readiness does not assert provider, full product or task-result correctness.

Ownership uses the current user's exact executable/profile/absolute launch-patch command and process start identity.
The PID receipt is advisory: a missing receipt does not spawn a duplicate, and a forged/stale receipt cannot select a
different installation for shutdown. Multiple matching processes cause refusal. Linux uses a pidfd when available;
macOS rechecks the command and start time before signaling, with the small OS-level check/signal race that implies.
A private operation lock prevents simultaneous launcher mutations. These controls assume a trusted local user account;
they are not isolation from another process running as that same user.

`stop` sends SIGINT for Harness's graceful shutdown and records an intentional-stop marker. It never sends a forced kill.
Timeout leaves the process and data intact. `restart` waits for that process to exit before starting another. The port
probe permits TCP TIME_WAIT reuse for immediate restarts without permitting a second active listener. Startup timeout
also leaves a still-running process intact; inspect `status` and the private log before retrying. Default startup timeout
is 60 seconds and graceful stop timeout is 300 seconds; `--timeout` and `--stop-timeout` can change them up to one hour.

An explicit `start` or `restart` clears the intentional-stop marker. `start --respect-stop` and `restart --respect-stop`
preserve it for a future supervisor. This increment does not register launchd/systemd services or start at login/boot.
After reboot, run `start` manually. Automatic crash recovery, supervised upgrades and desktop packaging remain open.

## Private access and files

`access` writes `Open Agentic OS.html`, a private link to Harness's authenticated local page, and prints only the shortcut's
path. `open` explicitly opens the same page in the default browser. The access token is taken from the current private
startup log, never printed to Terminal. The shortcut and logs are credentials-bearing local files; do not publish them.

Installation/control files and logs are owner-only. The launcher rejects symbolic-link control files, an unowned or
group/world-readable installation root, and changes to the generated `launch.json`. Operator provider settings belong
in the Harness profile, not in that immutable launch overlay. The installation manifest records the checkout and CLI;
relocating these paths is not a supported upgrade operation. It is not an integrity sandbox for a writable source checkout.

Logs live in `logs/`; the newest 20 launcher-named startup logs are retained. Installation commands use private
`install.log`. Retention affects only launcher logs, not task/Session/state data. Secrets are never accepted as launcher
arguments. Backup/restore must include the documented coordinator/Session/world/ownership requirements and handle
credentials separately; a launch manifest alone is not a backup.

## Verification

Process-level tests use actual detached fixture servers and operating-system locks. They cover two installations with
the same profile name, paths with spaces, private files, interrupted installation, credential/profile preservation,
missing/forged PID receipts, duplicate start, immediate restart, intentional stop, slow shutdown, changed launch patches,
occupied ports, wrong health identity, redirects and private authenticated shortcuts. These tests do not make inference
calls. The launcher and existing control-script checks passed 24 tests. Against installed Harness `0.2.1-rc.3`, a fresh
isolated profile passed initialization, duplicate-start identity, authenticated HTTP 200, graceful restart with a persisted
executor pause, intentional-stop handling and final shutdown. The existing user application remained running. The live
drill made no model calls and does not substitute for inference/recovery qualification. Local `pnpm check` passed
typechecking, all six builds and 2,003 tests (16 skipped; 138 passing test files and three skipped; 133.16 seconds).
Native Linux results are recorded in the implementation ledger when completed.

The full architecture in 010 remains active. Supported recovery activation, broader deployment packaging, real browser
acceptance and long-running operational evidence are separate requirements.
