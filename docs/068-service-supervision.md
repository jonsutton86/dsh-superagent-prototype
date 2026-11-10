# Login, boot and process supervision

The [persistent launcher](066-persistent-launcher.md) and [Linux endpoint role](067-managed-endpoint-launch.md) now support
an opt-in foreground supervisor and per-user launchd/systemd installation. They continue to run the existing DeepSeek
Harness, with the same state, Sessions, credentials, world identity, ownership checks and graceful shutdown path.
This does not migrate an older ad hoc profile into a launcher installation or replace the article's independent watchdog.

## Install and control

After initializing a launcher-managed installation:

```sh
python3 scripts/agentic-os service-install
python3 scripts/agentic-os service-status
python3 scripts/agentic-os status
```

Add `--directory /absolute/private/installation` to select an existing custom directory. For the Linux execution endpoint,
use `--role endpoint` on each command instead, or its explicit directory. Service installation preserves an intentional
stop and an automatic-recovery hold. A successful explicit `start` or `restart` resumes it; installing the service itself
does not override those decisions. Installing while the exact Harness process is already running adopts its lifecycle
without starting a duplicate. A foreign command, occupied port or changed endpoint identity cannot establish readiness.

On macOS the launcher registers a uniquely named plist in `~/Library/LaunchAgents` and bootstraps it in the current GUI
login domain. It runs while that user is logged in and starts at subsequent logins; this is not a pre-login system daemon.
On Linux it installs a uniquely named unit in `$XDG_CONFIG_HOME/systemd/user` (or `~/.config/systemd/user`) and enables it
through `systemctl --user`. To keep that user manager running after logout and start it at boot, enable lingering for the
dedicated host account, subject to that host's administrator policy:

```sh
loginctl enable-linger "$USER"
loginctl show-user "$USER" --property=Linger
```

The launcher does not run sudo or change lingering automatically. It reports user-session scope rather than claiming boot
readiness merely because a unit was enabled. Systemd must be available, and endpoint hosts must still satisfy the Linux,
bubblewrap, Node runtime-mount and native confinement checks in 067. A container without a user service manager can run
`python3 scripts/agentic-os supervise --directory /absolute/private/installation` under its own process manager.

```sh
python3 scripts/agentic-os stop
python3 scripts/agentic-os start
python3 scripts/agentic-os service-remove
```

`stop` records a persistent intentional stop. A live supervisor stays idle and preserves that stop through its own restart
or the next login/boot. `start` resumes the exact installation. `service-remove` first stops Harness gracefully and records
the stop, unloads/disables the owned service, observes supervisor removal, then removes its exact definition and receipt.
It keeps the installation, credentials, data, logs and copied launcher runtime. A stop timeout preserves the process and
service definition for inspection. Reinstallation respects the retained stop. The usual `access`/`open` commands still
apply to workspaces; the endpoint remains headless and uses `enrollment`.

## Recovery behavior and limits

One OS lock permits only one foreground supervisor per installation. Observing a healthy or unhealthy live process does
not hold the operation lock; actual starts/stops remain serialized with explicit launcher commands. `status` remains a
read-only current-state observation while an operation runs. Its `supervision` field reports the current supervisor
identity/liveness, phase, matched Harness process and a bounded reason code. A service manager reporting an active service
does not prove application readiness: the supervisor can be holding or honoring a manual stop.

When the matching Harness process disappears, the supervisor can start the same persisted installation. By default it
allows five automatic starts in a rolling ten-minute window, with at least ten seconds between starts. Each attempt is
recorded before launch; the budget survives supervisor replacement. Exhaustion, malformed budget data, a backwards clock,
changed configuration/identity, ambiguous processes or failed startup places recovery on hold. A live process is never
killed merely because its health endpoint, model catalog or provider is unhealthy. Only a successful explicit `start` or
`restart` clears a hold and resets the automatic-start budget; `--respect-stop` does not.

`--timeout`, `--stop-timeout`, `--restart-delay`, `--restart-limit` and `--restart-window` configure `supervise` or the initial
`service-install`. Default startup and graceful-stop limits are 60 and 300 seconds. Repeated service installation refuses
changed settings. Remove/reinstall the service to apply a reviewed lifecycle configuration change.

The supervisor handles SIGTERM/SIGINT through Harness's exact-process graceful SIGINT path. It does not set a new manual
stop merely because the OS is shutting down. Systemd uses mixed termination with forced SIGKILL disabled: if old processes
survive, systemd may refuse to restart the service until they are resolved. Launchd does not sweep the supervisor's process
group; Harness is separately detached. OS shutdown, power loss and externally forced termination can still interrupt work.
These services do not prove clean-host recovery, quiescence of unknown effects or cross-machine failover; existing journals,
ownership fencing and checkpoint/reconciliation requirements remain authoritative.

## Files and ownership

The service name is derived from the absolute installation path. The launcher preserves unclaimed definitions and loaded
jobs, verifies the installed definition and copied runtime hashes before management/removal, and refuses changed files.
The mode-0600 `service.json` receipt records paths, arguments, PATH and hashes. The three Python launcher files are copied
into the private `service-runtime/` directory so the OS can launch that entry point independently of a Terminal session.
Harness still uses the recorded CLI and source checkout; moving them is not a supported upgrade.

Only an absolute PATH snapshot and Python output-buffering setting are exported. Relative PATH entries added by tools such
as pnpm are resolved when installing, never against the service's later working directory. Provider keys and other shell
environment variables are not copied into the definition. Keep credentials in the private Harness profile/store. Commands
use argument arrays rather than a shell; systemd command-variable and specifier escaping preserves literal dollar signs
and percent signs. Working-directory/output paths use systemd's path syntax rather than shell quoting.

Supervisor output uses private `service.log`; service-manager failures use private `service-manager.log`. Actual Harness
output remains in private `logs/` with the existing twenty-startup-log retention. `supervision.json` is an observation,
not authority to signal a PID; current command/start identity is still checked. The lock, stop marker, budget and hold are
private local control files. This assumes a trusted local account and is not a boundary against that same account editing
its own installation or source checkout. Native macOS privacy restrictions may also require the chosen checkout/runtime
to be accessible to a background agent; the installer does not grant additional OS permissions.

## Verification

Process-level tests exercise actual fixture servers: crash/restart with preserved state, stop persistence across supervisor
replacement, duplicate-supervisor refusal, live unhealthy-process preservation, bounded retry holds, failed-start holds,
graceful shutdown and timeout without a forced kill. Definition tests inspect both platform formats and verify that
synthetic provider secrets are absent. Linux additionally runs the native `systemd-analyze --user verify` parser when
available in the supported CI environment; native Linux execution remains pending. For pushed runtime revision
`017f880a00b7176ad71a6f4bd7917c25b4e3784c`, explicit workflow dispatch again returned HTTP 422, "Actions has been disabled
for this repository." The repository permissions endpoint separately reports `enabled: true`, so the underlying cause of
that dispatch refusal is not established. No native Linux result is claimed from either setting or earlier successful runs.

The opt-in `DSH_NATIVE_SERVICE_QUALIFICATION=1` test actually installs and removes an isolated native user service, kills its
fixture Harness process, observes recovery, preserves manual stop and refuses a changed definition without stopping its
process. `DSH_INSTALLED_SERVICE_QUALIFICATION=1` plus `DSH_SERVICE_QUALIFICATION_CLI` starts actual pinned Harness under the
native manager, pauses the executor through its management API, removes/reinstalls the service and verifies the persisted
pause after an explicit restart. Neither drill makes model calls or publishes externally. Both passed on macOS, alongside
the six foreground/definition tests (eight passed in 22.32 seconds). These are service lifecycle drills, not an actual
logout/reboot or power-loss test. The existing user application remained running throughout. Local `pnpm check` passed
typechecking, all six builds and 2,011 tests (22 skipped; 140 passing test files and four skipped; 145.74 seconds). The
temporary native services were unloaded and their definitions removed after qualification. Linux user-manager/boot
qualification, remote host tests, supervised upgrades and packaging remain open.

Service-manager semantics follow [Apple's launchd guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html),
the installed macOS `launchd.plist` manual, and systemd's
[service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html),
[termination](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html),
[execution](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html) and
[loginctl](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html) documentation.
