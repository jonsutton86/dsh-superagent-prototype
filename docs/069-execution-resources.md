# Execution resource enforcement

Prepared Linux endpoints can enforce CPU, memory/swap and process/thread ceilings for the worker pool and each
spawned process tree. DeepSeek Harness remains the subprocess runtime. Resource control wraps that runtime before its
existing bubblewrap namespace launcher; it does not replace workspace grants, credential bindings, ownership fencing or
durable effect receipts. Native kernel qualification is pending; the local tests use an explicit simulated kernel.

## Runtime contract

`resources` is an optional, strictly validated endpoint configuration. When configured, startup requires an owned,
canonical cgroup v2 domain with delegated `cpu`, `memory` and `pids` controllers and no direct processes. No unsupported-host
or unavailable-controller fallback executes unbounded work. The endpoint creates `dsh-<endpoint UUID>` beneath that root,
sets pool limits and creates a child group for every subprocess, including filesystem helpers and verification stages.
Control-plane Harness runs outside the worker pool. Limits are ceilings, not dedicated CPU reservations or a throughput
promise. Ancestor limits and other workloads can reduce available capacity further.

The trusted standalone `remote-resource-worker.js` verifies both groups' exact limits, joins its own PID to the limited
child, verifies membership and execs the original command. Untrusted command code starts only after this gate. Descendants
inherit membership. The resource helper runs outside bubblewrap; the command then enters the existing namespace with no
cgroup filesystem mounted. Trusted command/resource/snapshot helpers must be outside granted workspaces. The helper
suppresses inherited Node preload configuration and never prints argv, environment contents or credentials.
Its trusted Node initialization runs briefly before group entry; that startup overhead and control-plane work are not
part of the worker receipts. The limit is enforced before the original command is execed.

`cpuPercent: 100` permits one CPU's time per 100 ms period; it does not pin a core. `memory.max` is the memory ceiling and
`memory.swap.max` is zero. Each command uses group OOM handling; the shared pool does not request whole-pool OOM killing.
The `processes` field maps to `pids.max`, which counts kernel tasks including threads. Pool pressure can still affect
several commands. These budgets do not isolate the trusted control plane from every possible kernel or host failure.

Cancellation first uses the original Harness termination behavior, then `cgroup.kill` after the requested grace. A process
outcome alone is not quiescence: the managed process range must exit and the kernel group must report no live descendants.
Only empty groups are removed with atomic directory removal. Failed cancellation or uncertain kernel state remains
unresolved. Restart preserves populated groups and refuses to reconcile a job/mutation while its matching group is live.
It never automatically replays an uncertain effect or kills an unclaimed process tree.

The journal pins the complete resource policy after startup verification. It cannot silently be removed or changed on a
later start; adding it to an existing endpoint requires all earlier uncertain effects to be reconciled. The kernel pool
is checked before each spawn and again in the helper. Changing a pinned budget/root is not yet a supported migration.

## Host setup

The existing endpoint launcher accepts `resources` in its private `--endpoint-config` JSON. For example, an initial
4-vCPU/8-GiB host could reserve a three-CPU/6-GiB worker pool and one-CPU/2-GiB command ceilings:

```json
{
  "maxRunning": 4,
  "resources": {
    "cgroupRoot": "/sys/fs/cgroup/DEDICATED-UNIT/worker-pool",
    "pool": { "cpuPercent": 300, "memoryBytes": 6442450944, "processes": 512 },
    "command": { "cpuPercent": 100, "memoryBytes": 2147483648, "processes": 128 }
  }
}
```

The path above is a placeholder, not a directory to create arbitrarily. A host administrator must establish a dedicated
systemd unit with `Delegate=cpu memory pids`, place the supervising process in a separate control subgroup and provide an
empty worker subtree. The endpoint and its helpers must remain within that delegated hierarchy with permission to migrate
between those subgroups. Merely owning the destination directory is insufficient if the common ancestor is not delegated.
All these directories must remain outside worker namespace mounts. Use the actual stable subtree path in configuration.
The launcher verifies reported resource policy/readiness before returning a healthy status or enrollment record.

`service-install` from increment 068 does **not** yet create this delegated topology. Automatic delegation, stable boot
setup, reboot qualification and resource-policy migration are still required. An ordinary SSH process or an unmodified
user service must not be assumed capable of entering an unrelated delegated group. The implementation refuses such a
launch instead of dropping the limits. No host, cloud account, tunnel or service is provisioned by this increment.

## Receipts and operator view

Before removing each completed group, the endpoint captures CPU microseconds, throttled periods, OOM kills and process
limit events. Multi-stage verification aggregates its scopes under the original job. Command and mutation receipts persist
these numeric observations with the effect, and authenticated administration projects them without payloads or secrets.
The Environments UI shows configured pool/command limits and receipt counters. Registration metadata is a snapshot, so the
UI does not present its memory/process counters as current live telemetry. Missing counters remain unknown and incomplete;
lost observations after abrupt death are not manufactured or recovered from unrelated groups. These are kernel workload
observations, not model token billing or invoice estimates.

## Verification and remaining acceptance

Focused local integration passed 32 tests, with three native/platform cases skipped. Tests cover policy rejection,
pre-dispatch limits, preserved stdin/outcomes, cancellation, retained process groups, original receipt reconciliation,
restart policy pinning, helper placement, launcher health-policy mismatches and actual API-to-rendered-UI projection.
The simulated cgroup fixture makes no claim of kernel enforcement. Local checks cannot establish Linux process migration,
controller behavior, OOM containment or real host recovery.

Final local `pnpm check` passed TypeScript checking, 2,022 tests (23 skipped; 141 passing test files and four skipped;
128.63 seconds) and all seven builds. The additional failed-configuration regression verifies that rejecting resource
policy changes cannot persist a new ownership binding. The existing operator app remained running and returned HTTP 200
with runtime ready and execution unpaused after the build. No browser interaction, API-key change or host provisioning
was needed for this increment.

The opt-in `DSH_RESOURCE_QUALIFICATION_ROOT` case uses real local Harness services, bubblewrap and the built helper. It
requires actual throttling, process-limit and OOM kernel counters; a nonzero exit alone cannot satisfy those checks. It
also checks confined file access and original command/resource receipt replay after endpoint restart. The Linux workflow
builds first and runs the suite in a dedicated transient delegated systemd unit using
`tests/fixtures/resource-qualification.sh`; that script moves only its own process into the control subgroup. It never
modifies an unrelated process group. Run only on a dedicated test host with the specified controllers and cgroup v2.

Runtime revision `bb5f3c0d2af61038f5a671dbbaa39371972d51ba` is pushed to `feat/full-superagent-architecture`. GitHub returned
no workflow runs for that exact SHA. Explicit `remote-execution.yml` dispatch returned HTTP 422, "Actions has been disabled
for this repository." New native qualification remains pending. Earlier successful
Linux revisions do not establish this increment's behavior. Disk/storage quotas, per-workspace aggregate allocation and
fairness, automated machine/fleet and transport setup, supported budget changes, clean-host restore/failover and the rest
of the complete architecture remain open.

Kernel semantics follow [cgroup v2 documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html) and
[systemd resource control and delegation](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html).
