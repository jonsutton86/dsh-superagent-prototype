# 051 Coordinator routing authority

This increment closes the remaining broad coordinator tool surface in the two-level design. DeepSeek Harness stays the
runtime. The coordinator uses typed routing, source, review and configuration tools; authorized ticket workers perform
investigation and execution, including their own local teams. The Engine's admission, subscriptions, ownership, handback,
asynchronous steering and independent publication gates remain authoritative.

## Enforcement and context

The coordinator Session ID determines its authority. An inherited tool restriction exposes only the skill tool plus
registered host tools. A monotonic guard after Harness's extensible pre-execution policy permits the exact host tool names,
skills and Harness's sandboxed tool-composition transport. All nested calls through that transport still face the same
guard. Arbitrary tools registered later in the coordinator's own scope are denied too. Generic shell, filesystem, web,
background-job, direct subagent and unrelated plugin tools cannot run, even when a legacy Session uses `standard`, a person
selects another preset, or a prompt override requests broader powers.

The local router preset now matches the existing remote router's role: time context, skill loading and compaction, with
no shell, file/job tools, delegation, filesystem skill discovery or local agent-instruction scanning. Worker presets,
persona/environment permissions and worker-local delegation remain available within existing task gates.

Routing context remains available through `orchestrator_read`, `orchestrator_eval_read`, `workspace_search` and
`workspace_read`. New coordinator-only repository resources are `repository/file/<path>` and `repository/directory/<path>`;
an empty directory path means the configured GitHub repository root. The host issues fixed read API calls, rejects hidden,
parent and dependency paths, caps content at 64 KiB and paginates one timestamped observation. Later offsets reuse that
observation; offset zero refreshes it. Directory results are subject to the provider's listing limits. These default-branch
reads are untrusted context, not a worker snapshot or verification proof. They require a configured GitHub repository;
local-file investigation belongs to a ticket worker. Source text, thread context and images retain their existing typed
readers, scopes and bounds.

## Upgrade and recovery

The deny guard is installed before asynchronous preparation. Concurrent decoration shares one preparation promise.
During Harness's serial `agent/created` callback, its creation barrier already holds queued input; the listener must not
wait for its own agent to become idle. Preparation uses that barrier for the newly created coordinator while still
retiring tracked jobs and descendants. An already loaded coordinator is cancelled and awaited normally.
The host cancels an active legacy coordinator turn while retaining inbox input, waits for that turn to settle, inventories
its known descendants, and records their coordinator lineage before retiring their tracked jobs. Loaded descendants receive
deny guards, and `session-router-owner:` anchors retain that classification across resume with unloaded parents. Worker-owned
jobs are unaffected. The existing Harness job/child lifecycle is used rather than introducing another executor.

Preparation has one 15-second deadline and an inventory bound of 1,024 Sessions including the coordinator. A stop request,
timeout or unavailable inventory is not evidence of termination. Routing stays held if the original jobs/turns remain live;
inspect those original records and restart after resolving them. A failed preparation stays denied in that runtime instance.
This upgrade does not silently detach unknown work or dispatch replacement execution.

The boundary controls model tool calls inside trusted Harness code. It is not process isolation against a malicious plugin,
does not prove that untracked processes have stopped, and does not remove credentials from every existing local worker.
Role-specific host settings, policy and prompt controls are still typed control-plane capabilities under their existing
authorization rules. Broader credential separation, external-account enforcement and clean-host failure qualification remain
part of the full architecture work.

## Qualification

Tests cover actual Harness tool guards and inherited/late scoped tool dispatch, a permissive pre-policy listener, typed
context reads, independent worker execution, original-job quiescence and persistent descendant classification. Runtime tests
cover legacy/custom presets and the unchanged admission/routing/worker paths. Bundle tests verify that the router no longer
loads execution or local instruction-discovery plugins. Repository context tests cover pagination stability, explicit refresh,
size/path bounds, directory filtering and worker denial.

Installed-Harness scenarios register a disposable late coordinator tool whose only possible effect would be writing a test
canary. They assert that the tool is denied, the canary is absent and typed context reads work before and after restart,
while real configured-model workers complete their existing environment, evidence, publication and recovery scenarios.
The first runtime revision, `7ef66e2`, passed the local suite but failed installed-Harness startup: preparation waited for
the coordinator's own `whenIdle()` inside the serial `agent/created` callback. Harness holds its input queue behind that
creation barrier, so the wait could not complete. Revision `249ba5b22b671376b8fee3dd9571bdee1e583070` fixes that lifecycle
error and adds a regression that refuses any own-agent idle wait during creation. This was a runtime defect, not a
qualification-fixture failure.

On the corrected revision, typechecking and all five builds passed. The full local suite passed 1,826 tests with 13 skipped
across 120 passing and two skipped files in 112.15 seconds. The dedicated installed-Harness / DeepSeek Flash scenario passed
in 73.50 seconds; both owned scenarios passed in 315.85 seconds. Those scenarios exercise actual model-created results,
the router canary and typed reads before and after restart, existing check/mission/publication evidence, managed worlds,
schedules, usage refusal/retry, ownership and held recovery. Provider message/review effects stay on local contract servers.
The same corrected revision passed 1,833 tests with seven skipped across 120 passing and two skipped files on Linux /
Node 24 with native confinement in 224.05 seconds, together with typechecking and all five builds in
[run 42642436513](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42642436513).
The original app remains running.

These tests do not replace cross-host, long-horizon or operator UI acceptance for the complete Agentic OS.
