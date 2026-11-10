# Delegated endpoint service

The persistent launcher can initialize an endpoint with `--service-resources BUDGETS.json`. It records a systemd user
service and a stable cgroup path, generates the exact endpoint policy and installs a controller-delegated service.
The supervisor creates its control and worker subgroups before starting Harness. This removes manual preparation of
the endpoint's cgroup directories. Native Linux service/kernel acceptance is still pending.

DeepSeek Harness, namespace isolation, private endpoint identity, ownership fencing and original effect receipts remain
the execution foundation. This increment does not provision a cloud machine, connect a tunnel, grant system privileges,
migrate existing resource policies or qualify reboot/failover.

## Host prerequisite

Use a dedicated Linux service account, cgroup v2, a systemd user manager, and the Node/bubblewrap prerequisites in
`067-managed-endpoint-launch.md`. The administrator must delegate `cpu`, `memory` and `pids` to that account's user manager.
Some distributions only delegate memory and pids by default; upstream systemd 249's `user@.service` does so. The launcher
checks actual kernel controller availability and refuses initialization if any required controller is missing.

For a new service account named `agentic`, an administrator can configure an account-specific drop-in at
`/etc/systemd/system/user@UID.service.d/agentic-resources.conf`, replacing UID with `id -u agentic`:

```ini
[Service]
Delegate=cpu memory pids
```

After reviewing the existing configuration, reload systemd and enable persistent user services:

```sh
sudo systemctl daemon-reload
sudo loginctl enable-linger agentic
```

If that user manager was already running without the required delegation, apply the change during maintenance by
restarting `user@UID.service`. This affects all services of that account, which is why the installation uses a dedicated
account. The launcher does not perform this privileged operation. Do not assume `systemctl set-property ... Delegate=...`
works on existing systemd 249 services: that version exposes delegation assignment for transient construction, not general
live updates. The CI fixture uses a runtime drop-in and restarts only its disposable test user manager.

Log in as the service account. The user manager must expose its `init.scope` control group through `systemctl --user show`.
The launcher derives the endpoint's sibling `app.slice/<owned unit>/worker-pool` path from this observation, rather than
assuming the host's UID path or trusting a shell-supplied resource directory. Unsupported topologies are refused.

## Installation and control

Create a private budget file. These example ceilings fit an initial 4-vCPU/8-GiB worker host; they are not a workload
capacity guarantee. `processes` counts processes and threads, and CPU percentages are relative to one logical CPU.

```sh
umask 077
cat > "$HOME/agentic-worker-budgets.json" <<'JSON'
{
  "pool": { "cpuPercent": 300, "memoryBytes": 6442450944, "processes": 512 },
  "command": { "cpuPercent": 100, "memoryBytes": 2147483648, "processes": 128 }
}
JSON
agentic_checkout="/home/agentic/dsh-superagent-prototype"
agentic_installation="/home/agentic/.local/share/agentic-os-endpoint"
python3 "$agentic_checkout/scripts/agentic-os" init --role endpoint \
  --checkout "$agentic_checkout" --directory "$agentic_installation" \
  --service-resources "$HOME/agentic-worker-budgets.json"
python3 "$agentic_checkout/scripts/agentic-os" service-install --directory "$agentic_installation"
python3 "$agentic_checkout/scripts/agentic-os" status --directory "$agentic_installation"
python3 "$agentic_checkout/scripts/agentic-os" enrollment --directory "$agentic_installation"
```

The checkout must already be built. `init` installs the pinned Harness when `--dsh` is omitted. An optional
`--endpoint-config` may still configure ownership, environment-name allowances and command/output limits, but cannot
also specify `resources`. Existing installations are not converted in place. Repeat initialization with the same settings
preserves identity, credentials and configuration; changed budgets, roots or service bindings are refused.

The generated unit uses `Slice=app.slice` and `Delegate=cpu memory pids`. Its supervisor verifies the actual cgroup v2
mount, canonical directory ownership, domain type, controller availability and exact current group. It moves only its
own PID to `control`, verifies the move, enables subtree controllers and prepares `worker-pool`. Unexpected direct parent
processes cause refusal; none are moved or killed. Existing endpoint worker descendants and limits are left for the
endpoint resource controller to validate. Harness and its trusted supervisor remain in `control`; bounded worker trees
run below `worker-pool`. A matching Harness process outside this topology is not automatically adopted or restarted.

Use the normal `start`, `restart`, `stop` and `--respect-stop` commands. For this mode, Start/Restart records a private
durable request consumed under the supervisor's operation lock. It never launches Harness from the caller's SSH/Terminal
session. A lost observation keeps the original pending request ID; repeating the same action waits for that request.
A conflicting Start/Restart action is refused while the original remains pending. Caller timeout changes the observation
window, not the service's configured startup timeout, and does not cancel an accepted request.

Stop records a unique persistent marker and cancels an outstanding start request. Each start request captures the marker
it follows, so a newer Stop fences it even if interruption prevents updating the request receipt. A corrupt auxiliary
request does not prevent graceful Stop; restoring an older pending request cannot revive it past the newer stop marker.
Successful explicit startup clears
the automatic-start hold/budget. Failed or cancelled request receipts also fence automatic startup if a crash preceded
their companion hold/stop file. Readiness failure leaves any live process intact. `status` and `service-status` expose the
request phase and delegation binding without credentials. `delegation-observed.json` is an observation, not authority
to move another PID or reconstruct endpoint receipts.

Service removal requires the supervisor to stop and the kernel service group to be empty or absent on the verified
cgroup mount. Unknown/live descendants retain the service definition and receipt for inspection; no recursive cgroup
deletion or forced kill is used. Removing the service preserves installation data and the manual stop. Reinstallation
with the same settings remains stopped until an explicit Start. The copied service runtime now includes four Python
files; verification still accepts unchanged three-file services from increment 068. That compatibility does not implement
automatic runtime upgrades or conversion to delegated mode.

## Evidence and remaining acceptance

`tests/delegated-service.spec.ts` covers topology/policy mismatches, controller absence, wrong domains, unrelated processes,
idempotent subgroup setup, retained worker groups, unknown drainage, durable request replay/conflicts, explicit startup
success/failure, manual stop, corrupted-request stop and failed/cancelled intent recovery. Ten local control cases pass,
with an explicit simulated kernel for cgroup behavior. The combined local control and actual native macOS service-manager /
pinned Harness run passed 18 tests (two platform cases skipped; 21.56 seconds). Those native macOS drills establish
compatibility of shared service code, not Linux delegation or reboot acceptance.

Final local `pnpm check` passed typechecking, seven builds and 2,032 tests (24 skipped; 142 test files passed and four
skipped; 129.04 seconds). All four workflow shell blocks passed Bash syntax checking. The existing user app returned
HTTP 200 with its runtime ready and unpaused; no temporary macOS service definitions or loaded test jobs remained.

The `DSH_DELEGATED_SERVICE_QUALIFICATION=1` test installs the actual pinned Harness under a real user service. It checks
the Harness PID's kernel group, confined execution and usage receipts, endpoint identity and receipt replay through
Restart, manual-stop preservation, service removal/reinstallation and explicit Start afterward. It removes its own unit
and private fixture after successful drainage. The Linux workflow prepares an ephemeral user manager and enables this
test after the complete native suite. This new qualification has not run while GitHub Actions dispatch remains unavailable.

Actual Linux user-manager/controller behavior, logout/reboot/power loss, cross-machine recovery, supported policy/path
migrations, disk quotas, workspace aggregate allocation, cloud/fleet and tunnel setup, supported upgrades and the remaining
full Agentic OS architecture remain open.

Design references: [systemd cgroup delegation](https://systemd.io/CGROUP_DELEGATION/),
[resource controls](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html), and the
systemd 249 [user-manager unit](https://github.com/systemd/systemd/blob/v249/units/user%40.service.in) and
[property-assignment implementation](https://github.com/systemd/systemd/blob/v249/src/core/dbus-cgroup.c).
