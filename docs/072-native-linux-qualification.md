# Native Linux and boot qualification

A dedicated Ubuntu 22.04 ARM64 VM now exercises the Linux execution, cgroup, user-service and SSH paths locally when
GitHub Actions is unavailable. This is real Linux kernel and systemd behavior on an isolated VM, not a simulated kernel.
It does not prove cloud networking, x86-64 compatibility of new changes, physical-host failure recovery or clean-host
checkpoint failover. DeepSeek Harness remains the execution runtime; no model-provider credential is needed for these drills.

## Reproducible test host

`scripts/qualification/ubuntu-22.04-arm64.yaml` pins the Ubuntu image and SHA-256 for Apple Silicon with Lima 2.2.1 or later,
4 CPUs, 6 GiB RAM and a 24 GiB virtual disk. Plain mode disables host mounts, dynamic application port forwarding, containerd
and agent forwarding. The guest receives a source archive and its own dependencies, without the Mac's application state,
provider credentials, Git credentials or personal directories. The VZ driver uses macOS virtualization support.

```sh
limactl start --name=agentic-os-qualification --tty=false scripts/qualification/ubuntu-22.04-arm64.yaml
git archive HEAD --output=/tmp/dsh-agentic-linux-source.tar
limactl copy /tmp/dsh-agentic-linux-source.tar scripts/qualification/prepare-linux.sh agentic-os-qualification:/tmp/
limactl shell --workdir=/ agentic-os-qualification env DSH_DISPOSABLE_QUALIFICATION=1 bash /tmp/prepare-linux.sh
```

Inside the guest, extract the archive into a dedicated checkout, install the locked dependencies, and install the pinned
Harness in a separate directory. Use actual absolute guest paths for the remaining commands:

```sh
pnpm install --frozen-lockfile
npm install --prefix /absolute/guest/qualification-harness --no-audit --no-fund @deepseek-ai/dsh@0.2.1-rc.3
DSH_DISPOSABLE_QUALIFICATION=1 \
  DSH_ENDPOINT_QUALIFICATION_CLI=/absolute/guest/qualification-harness/node_modules/.bin/dsh \
  bash scripts/qualification/run-linux.sh
```

`prepare-linux.sh` is explicitly restricted to a disposable Ubuntu 22.04 test user. It installs native dependencies,
checksum-verified Node 24.22.2 and a pinned pnpm bootstrap, enables linger, and configures CPU/memory/pids delegation for
that user manager. It stops that manager and waits for its old cgroup to disappear before starting it. This operation
interrupts all user services and must not be run against a production or personal-service account. The repository's
`packageManager` setting selects the project pnpm version during installation and tests.

`run-linux.sh` runs typechecking and all builds, then the full suite under a dedicated systemd unit with real cgroup
delegation, bubblewrap isolation, installed Harness endpoint/coordinator launch and native SSH. It subsequently runs the
delegated endpoint, transport and installed-Harness service tests against the actual user manager. The full suite limits
Vitest to four workers. Fixtures remove their own services; the VM can be stopped afterward and reused for later tests.
No repository Actions configuration or billing setting is changed by this local qualification.

## Defects exposed by native acceptance

Ubuntu 22.04/systemd 249 reports an empty `ControlGroup` on its synthetic `init.scope` unit. The launcher now obtains the
user manager's own `ControlGroup` property instead, validates that kernel domain and derives the service path beneath it.
Controller absence and unrelated topology still fail closed. The local regression retains the actual manager response shape.

Changing delegation and immediately restarting that user manager also exposed a cgroup cleanup race: systemd could fail
with `219/CGROUP` while trying to attach to the old group. The qualification bootstrap and CI now stop, observe disappearance
of the old group, and start; they never remove a live group or move unrelated PIDs. The administrator guide is corrected.

An abrupt VM power interruption exposed another startup gap. The 30-second `proper-lockfile` heartbeat directory survived
the interruption. A fast boot attempted plugin activation before that lock expired, leaving Harness alive with an inactive
endpoint plugin and a supervisor hold. The launcher now waits within its startup timeout while its private state lock is
recent. It does not touch or delete that lock. Heartbeats extend the wait; a timeout refuses to spawn. After expiry, the
runtime still performs its own authoritative lock acquisition. A one-second margin covers mtime precision rounding.
This preserves the existing lock policy rather than asserting that a lock age proves a process dead.

The next interruption left both endpoint credential files empty. `RemoteJournal` previously created them with ordinary
writes, which could be acknowledged without their bytes reaching durable storage. Credentials now use synced private
temporary files, atomic publication and parent-directory sync before the database can accept work. Existing credentials
are also synced without replacing their values. A missing credential beside an existing journal, an empty credential,
or a linked credential refuses startup; recovery requires the original identity, never silent credential generation.
Fault-injection tests refuse readiness on file or directory sync failure and verify retry without identity replacement.

A subsequent interruption preserved both credentials but exposed an empty Harness-generated profile overlay. Initial
profile creation and plugin installation now sync their owned files and directories before publishing installation readiness.
Linked packages/checkouts are not traversed, no credential bytes are inspected, and a sync error leaves initialization
incomplete. A privately installed Harness runtime is synced too; an externally supplied runtime remains an administrator
dependency. This installation boundary does not claim to make every future upstream Harness settings write crash-safe.

Early-boot clock adjustment also changed `ps lstart` for a live supervisor. Linux process identity now combines the kernel
boot ID and `/proc/PID/stat` start ticks; wall-clock correction no longer makes the same process appear to be a different one.
PID reuse or a replacement boot still differs. macOS retains its existing process identity path. Existing installed services
retain their pinned runtime copy until an explicit owned removal/reinstallation; no live service is silently upgraded.

The launcher regression checks a recent lock aging without inode/mtime changes and a continuously refreshed lock refusing
startup while Stop remains usable. An existing live Harness is preserved as before. This change addresses the managed
launcher path; independently started profiles still need their own retry policy when they encounter a recent lock.

## Power-interruption drill

Create a dedicated resource-bound endpoint in the VM using the launcher and enable its user service, following
[delegated endpoint setup](070-delegated-endpoint-service.md). The recorded drill used a pool budget of 200% CPU,
1 GiB memory and 128 processes, and a command budget of 100% CPU, 256 MiB and 32 processes. Save those pool/command
objects in a private budget JSON file, then from the guest checkout use absolute paths:

```sh
python3 scripts/agentic-os init --role endpoint --directory /absolute/guest/test-endpoint \
  --checkout "$PWD" --dsh /absolute/guest/qualification-harness/node_modules/.bin/dsh \
  --service-resources /absolute/guest/budgets.json
python3 scripts/agentic-os service-install --directory /absolute/guest/test-endpoint --timeout 60 --stop-timeout 30
python3 scripts/agentic-os status --directory /absolute/guest/test-endpoint
python3 scripts/agentic-os enrollment --directory /absolute/guest/test-endpoint
```

Wait for status to report ready with the supervisor running before exporting enrollment and starting the drill:

```sh
DSH_DISPOSABLE_QUALIFICATION=1 node scripts/qualification/boot-linux.mjs begin /absolute/guest/test-endpoint
```

The driver persists its original grant and command identities, starts a confined command that appends one marker and
fsyncs both file and directory, and confirms that the command is still running. The command intentionally stays alive.
Only after that proof, forcibly stop this dedicated test VM from the Mac and observe it as stopped:

```sh
limactl stop --force agentic-os-qualification
limactl list agentic-os-qualification --format '{{.Status}}'
limactl start --tty=false agentic-os-qualification
```

Wait for the existing endpoint to become ready automatically. Do not manually restart it to turn a failed boot into a
passing boot test. Within the grant's five-minute lease, run in the guest:

```sh
DSH_DISPOSABLE_QUALIFICATION=1 node scripts/qualification/boot-linux.mjs verify /absolute/guest/test-endpoint
```

Verification requires a different OS boot ID, the original endpoint UUID and resource policy, an unknown original command,
an original-ID replay that does not execute again, and exactly one durable marker. New work must be refused before explicit
reconciliation. The qualification driver then records a scoped administrator reconciliation after observing reboot and the
endpoint's kernel population check. The interrupted outcome remains unknown; it is not converted into success. A separate
new command must subsequently complete. This is explicit test-driver review, not a claim that a human accepted the result.

The private `boot-result.json` contains the evidence summary, without credentials. Repeat `begin` only on its original boot;
it refuses to issue replacement work after reboot. Preserve failed fixtures for diagnosis until their service is safely
removed. Finally test a manual stop through another reboot, remove the test service and stop the VM. A graceful VM reboot
and abrupt interruption are different cases and must be recorded separately.

## Acceptance scope

The environment uses Ubuntu 22.04, Linux 5.15.0-198-generic, ARM64, systemd 249, Node 24.22.2 and Harness 0.2.1-rc.3.
The native resource test exercises real CPU/process ceilings, OOM containment, usage receipts and durable replay. The SSH
test routes real Harness enrollment and a native job through a private SSH server, interrupts the connection, and verifies
one invocation and original receipts through transport and daemon restarts. Native service tests exercise Linux systemd
installation, manual stops, restart and replacement.

The passing forced-power-off drill retained endpoint `3cef20ca-e240-47fa-83d6-dc658869a9cd`, changed OS boot ID from
`5424ba27-f743-4628-9c55-4b645867ad49` to `6297024c-d19c-4d07-bdd5-0e7967379c56`, and recovered automatically.
Original command `boot-command-dbbc1d86-80d6-4927-a23f-1ab68b943161` remained unknown with exactly one durable marker.
Replay retained that command ID. New work was denied before the explicit test-driver reconciliation, then a separate
new command completed. The supervisor's kernel-based identity remained valid after boot-time clock correction.

A separate graceful reboot to `3facc5a7-fa4c-4cb0-8f6e-7f8ccb20c995` preserved an intentional manual Stop: the supervisor
was running in `manually-stopped` phase, the stop marker was unchanged, and no Harness process existed. Owned service
removal subsequently succeeded while retaining its journal. The preceding failed fixtures were also retired, with their
data retained; none was converted into a passing receipt by manually restarting it.

Final validation on 2026-11-09 (America/New_York):

| Check | Result |
| --- | --- |
| Full native Ubuntu ARM64 suite with installed Harness, bubblewrap and delegated kernel resources | 2,063 passed, 14 skipped; 145 files passed, 3 skipped; 136.04 seconds |
| Native Linux delegated endpoint, systemd/Harness service and SSH service checks | 30 passed; 14.52 seconds |
| macOS `pnpm check` | Typechecking, seven builds and 2,050 tests passed; 25 skipped; tests took 135.63 seconds |
| Native macOS pinned Harness/launchd and SSH checks | 16 passed, one Linux-only skip; 23.49 seconds |
| Forced VM power interruption and separate intentional-stop reboot | Passed, with original identities and receipts above |
| Disposable bootstrap replay after owned services were removed | Passed the stop/wait/start user-manager sequence |
| Cleanup | No owned test service files, loaded test services or native SSH fixtures remained on either host |

The user's existing Mac app remained HTTP 200, ready and unpaused. The qualification VM was stopped normally after testing
to release its memory; its disk and private evidence remain available for future qualification. These results do not depend
on GitHub Actions being available. The shell workflow blocks, qualification scripts and documentation checks also passed.

Runtime/test revision `c3747d3d2e00e7ee6b8e0eb020d4178dd7a0814a` is pushed to `feat/full-superagent-architecture`.
GitHub reported zero workflow runs for that exact SHA and rejected explicit workflow dispatch with HTTP 422 because
Actions is disabled for this repository. No Actions settings or billing settings were changed. The local native Linux
receipts above remain valid; this increment does not claim a GitHub-hosted x86-64 CI pass.

Cloud/fleet provisioning, physical cross-machine qualification, clean-host restore/failover and credential/path remapping,
broader/reverse transport, disk quotas, workspace allocation, supported upgrades, browser journeys and the rest of the full
Agentic OS architecture remain open. Passing native infrastructure tests does not complete those product requirements.

Sources: Lima [installation](https://lima-vm.io/docs/installation/),
[VZ driver](https://lima-vm.io/docs/config/vmtype/vz/), [plain mode](https://lima-vm.io/docs/config/plain/),
the [upstream image manifest](https://github.com/lima-vm/lima/blob/master/templates/_images/ubuntu-22.04.yaml),
and Node's [release checksums](https://nodejs.org/dist/v24.22.2/SHASUMS256.txt).
