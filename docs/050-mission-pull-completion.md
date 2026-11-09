# 050 Mission PR targets and fresh completion

This increment connects [checked PR observations](049-pull-review-approvals.md) to mission plans and completion.
DeepSeek Harness remains the execution runtime. A final repository result can require a specific PR identity and
provider-observed head, while completing a mission freshly verifies every accepted checked result in its original world.
This is a point-in-time completion decision, not a merge receipt or continuous filesystem/provider lock.

## Operator workflow

1. Configure an independent publisher with a `github-pr-review` destination. In an active mission, inspect its PR
   and explicitly bind an agent action to that target before dispatch. Existing affected executions must stop or finish.
2. The approved plan, action mandate and worker context carry the immutable target reference. Changing or removing
   it revises the plan and invalidates affected actions and their dependent results. It grants no provider credentials,
   external publication permission or merge authority.
3. Produce artifacts and run host checks in the selected execution world. Inspect the current PR head in result review,
   select matching successful checks for every artifact, and explicitly accept. The host reads the head before capture
   and again afterward. Captured commit, tree, reconstructed content tree and empty Git status must match the PR.
4. Finish the mission. Every checked action receives a new source capture using its original check world; this does
   not rerun the check command. Required PR heads are read again. One final transaction validates unchanged mission
   revision and plan, artifact/check authority, all fresh seals and exact accepted PR observations before completion.
5. If interrupted, use the original completion attempt shown in the mission. Its per-action evidence review IDs and
   capture receipts survive reload/restart. A competing replacement for the same mission revision is refused. Unknown
   captures require observation/reconciliation of their original IDs before another source capture may begin.

Bind final repository deliverables, rather than every intermediate step of a sequential PR workflow: an accepted PR
result must match the current head at closure. This implementation does not interpret older accepted heads as ancestral
checkpoints. Intermediate actions can use ordinary checked artifacts. A new head or PR state requires explicit reacceptance;
closed, unmerged PRs cannot satisfy the binding. An already merged PR can satisfy checked-result completion, but this
does not establish who merged it, branch-policy compliance or merge authorization.

## Durable state and boundaries

`mission_pull_target` retains the operator-selected destination digest, numeric PR/repository identities, author and
head/base refs. Commits can advance during work without rebinding; changing stable identity or refs requires new consent.
Each read increments an observation revision. Delayed older replies cannot overwrite newer observations. Pending or
failed reads invalidate claims of a currently observed accepted result; successful unchanged reads restore that knowledge.
Historical accepted state does not expire merely because time passes, and reading a mission does not poll GitHub.
Explicit result review and whole-mission completion require fresh reads. Shutdown drains mission PR reads before closing
the Store. The independent publisher applies its existing ownership fencing and read-only PR protocol.

`mission_completion` persists the original command, mission target hash and deterministic per-action evidence review IDs
before dispatch. Attempts are preparing, held or completed; successful status is committed in the same transaction as the
mission change. The mission stores review IDs, seal digests, check counts and PR observations. Full seals and capture
history stay in `verification_review`, avoiding a second complete evidence copy inside every mission revision.

Up to four actions prepare concurrently, with the existing maximum 200 actions per plan. Each action retains the existing
32 selected-check / eight distinct-source review bounds. Every final seal and PR observation must still fit the 60-second
freshness window. Large/slow missions can fail this window; the system does not silently weaken it. Journals are bounded
at 10,000 targets / 64 MiB and 10,000 completion attempts / 256 MiB; retention/compaction is separate unfinished work.
The UI lists the latest 100 completion attempts. Human-reviewed actions without file artifacts remain explicitly human
reviewed and record zero automated checks. Mixed missions retain both kinds of evidence.

No read/capture can freeze all remote branches and files atomically. Concurrent changes after the last observation remain
possible. Completion does not push code, submit reviews/messages, provision remote Git credentials, merge PRs, enforce CI
or implement branch protection. The existing independent publication gate remains separate. Updating coordinator and UI
together is required for the new management routes; old missions without targets remain valid, while checked completion
now uses fresh capture through the reviewed route.

## Qualification

Tests exercise real Git bytes and host check subprocesses against a local GitHub contract server. They cover final-head
acceptance, all-action closure, mutation during capture, changed source/head/identity/state, out-of-order observations,
interrupted completion and original unknown capture recovery after restart. The rendered UI uses a managed execution
world and management routes and loses a successful completion response before refreshing the durable receipt.
An additional Linux-only case requires actual native confinement. Installed-Harness scenarios bind a PR before execution,
accept its checked output, complete all checked mission actions, reopen for subsequent recovery work and inspect the
completion receipt after restart. Qualification results are recorded below after execution.

## Remaining architecture

Remote Git provisioning, branch-policy/CI and merge integration, continuous freshness, broader router authority separation,
long-horizon speculation/recall measurements, managed machine launch, cross-host recovery and failover, supervision UI,
voice, packaging/onboarding and the other full Agentic OS acceptance requirements remain open.
