# 082 Sustained supervision qualification

This increment continues the supervision acceptance work with an explicit operator runner for a sustained, artifact-producing
local workload. It uses the existing main Agentic OS and independent watchdog in actual installed DeepSeek Harness processes.
The model responses are scripted on loopback; no live provider credentials or paid inference are needed. The normal workspace,
default model and optional Abliteration route are unchanged.

[078](078-supervision-failures.md) established a thirty-second productive fixture and process-failure boundaries.
[081](081-supervision-evaluation.md) added curated static observations and evaluation accounting. Neither establishes
overnight duration. This runner records requested duration separately from actual worker execution, observation coverage
and recovery outcomes. A short acceptance run verifies the runner's path, not an eight-hour result.

## Source evidence and scope

The checkout was clean at `5efa7bd87dfca808bab1d84fb2f3b789cecfbc10` before this increment; Codegraph was synchronized before
investigation. REA 6.8.0 parsed seven selected sources without parse failures. Exact project baseline sources and installed
Harness rc.3 artifacts were captured separately from concurrent worktree edits. The compact
[source evidence record](evidence/082-endurance-contract.json) retains hashes, observed contracts, selected-analysis limits
and the pinned Fabric review operation. It is source evidence, not a runtime trace.

The installed `job_output` package permits waits of up to 600,000 milliseconds, but Agentic OS's actual bundle and managed
presets override that limit to **5,000 milliseconds**. The first installed preflight exposed this distinction. The worker
prompt explicitly says to end the turn while a background job runs; its completion wakes the worker. Repeated five-second
polling would exercise behavior the production prompt forbids and would greatly increase model traffic.

The executor also limits background work to thirty minutes after a worker turn ends. The sustained mission therefore uses
sequential jobs bounded to twenty minutes, under one assignment and one checked output history. It uses native completion
notifications rather than overriding either production limit. The installed acceptance test completes two sixty-second
jobs; the default eight-hour plan completes twenty-four twenty-minute jobs with individually verified invocation identities. This does not establish support for a single arbitrary eight-hour
command. The main process stays alive throughout productive work. Restarting it mid-job would test a different, unfinished
recovery boundary because the local job registry is in memory.

The ordinary one-hour watchdog review interval legitimately renews its three-delivery budget. Changed execution observations
alone do not renew it. Restart comparisons must bind the same main instance, task episode and review cycle; they cannot
require one current delivery ID to remain unchanged through every legitimate hourly review. Original acknowledgement and
delivery evidence remain distinct from the currently displayed assessment.

Background shell processes have their own process group. A forced main-process exit bypasses the provider's graceful
termination path, so main PID exit is insufficient proof of worker quiescence. The runner must retain unfinished evidence
when it cannot establish the owned test worker has stopped. This qualification does not grant the application new retry,
restart or recovery authority.

## Operator contract

The command is plan-only by default and requires explicit execution with a new private output directory. The planned
duration defaults to eight hours; existing output is never automatically resumed or replayed. Status inspection is read-only
and distinguishes report age from independently established process liveness.

Each run preserves its original identity before dispatch and uses fresh profiles and private homes. Production artifacts
and checkout dependencies are copied into its owned snapshot so subsequent checkout builds do not change the running code.
The separately installed pinned Harness and resolved Python executable remain recorded dependencies, not a claim of a
fully hermetic runtime. Credentials
are synthetic and local. Source identity, copied-artifact hashes, actual Harness version and applied timing limits belong
to the report.

The controlled worker starts each bounded job once, produces sequential hash samples and an exact proof artifact, and reaches
review through the normal Agentic OS/Harness path. Independent host checks verify the output, invocation identities, original assignment and
artifact provenance. Each native completion notification permits exactly one nonwaiting output read; the observed output
must confirm completion and exit code zero before advancing. Model text and emitted tool requests alone cannot prove those
effects occurred. Worker leases expire after sixty seconds without an operator heartbeat, and terminal success also requires
independent process-group absence and unchanged output digests after cleanup.

The runner injects a provider error, a hung response and recovery of an accepted assessment while the worker remains active.
It later restarts the watchdog and checks the original acknowledgement and applicable cycle identity. Main-process restart
occurs only after the job and artifact settle. This is post-settlement recovery, not active-worker resumption or physical
cross-host failover.

Requested elapsed time is not sufficient acceptance. Worker wall/monotonic timestamps, sample gaps and operator observation
gaps identify interrupted coverage, including host sleep. Planned watchdog outages are recorded separately from unexplained
gaps. Current, historical and absent assessments remain distinct; observation activity is not proof of useful task progress.
Resource and directory-size samples establish measured growth and sampled stop thresholds, not kernel memory/disk quotas.

Provider buffers, diagnostics and retained observations have explicit bounds. An exceeded bound or missing measurement must
fail or leave the run incomplete rather than truncate evidence into a passing result. Signals stop only owned test processes;
abrupt interruption preserves a partial or unknown outcome. Private reports and original IDs are retained for inspection.

## Commands and retained evidence

Build the checkout and inspect the plan without launching a model or worker:

```sh
pnpm build
node scripts/supervision-endurance.mjs
node scripts/supervision-endurance.mjs --duration-seconds 120 --chunk-seconds 60
```

Explicit execution supports 120–86,400 seconds of requested productive duration. `--chunk-seconds` accepts 60–1,200
seconds (default 1,200); the final remainder may be shorter. Use a new private directory each time:

```sh
node scripts/supervision-endurance.mjs --execute \
  --dsh /absolute/path/to/installed/dsh \
  --duration-seconds 28800 \
  --output /private/path/new-endurance-run
```

Inspect saved progress without dispatching or resuming anything:

```sh
node scripts/supervision-endurance.mjs --status /private/path/new-endurance-run
```

The report's heartbeat age is a freshness observation, not proof that its recorded process IDs remain alive. Keep the run
directory private: it retains its copied runtime, local profiles, Sessions, original acknowledgement, observed metadata and
worker outputs. An interrupted run requires inspection of those original records. Reusing its output directory is refused.
The operator can request cancellation with SIGINT/SIGTERM; cleanup uncertainty remains visible instead of becoming success.

## Qualification status

The first installed preflight passed a 120-second workload and a separate cancellation check in 143.70 seconds. It also
exposed the effective five-second job wait and used repeated polling, so it is not validation of the revised asynchronous
workload. The replacement asynchronous preflight passed in 151.46 seconds: two sixty-second chunks, two native wakes,
two nonwaiting reads and 122 independently checked samples, plus cancellation cleanup. This preflight precedes the final
exit-code-zero guard; six final unit tests and typechecking passed afterward. Full exact-revision macOS/Linux qualification
is pending. No eight-hour result is claimed yet. The final receipt must identify the exact tested revision, observed start/end and duration, coverage gaps, faults actually exercised, output
verification, process cleanup and platform. An in-progress run remains in progress even if its plan or deadline has elapsed.

Real-model diagnosis quality, manual evidence review, live operator alert acceptance, active-job crash recovery,
cross-host failover and the remaining full Agentic OS architecture remain open. No running user app is deployed or restarted
by this tooling, and no new model-provider spend is incurred.
