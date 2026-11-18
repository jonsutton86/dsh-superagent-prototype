# 014 Mission plans and proposals

This increment adds versioned plans to the [Agentic OS workspace](010-agentic-os.md), preserving its
[local execution](012-local-execution.md), [Inbox](013-inbox.md) and DeepSeek Harness runtime.

## Workflow

A mission has a current plan version independent of its operational revision. A plan contains the objective, acceptance
criteria, actions, ownership and dependency graph. Creating a mission and adding an action record immutable versions;
running, steering or reviewing execution does not rewrite plan history.

**Edit plan** opens a complete draft with editable actions and dependencies. Submitting it creates a candidate proposal.
The review view displays both the current and proposed definitions, the rationale, proposer and base version. Approval
requires a review note and applies the exact proposal; rejection preserves it with the reason. Approval never starts
the proposed actions. Dispatch continues through the mission's existing Run action control and Engine authorization.

**Ask agent to plan** creates and dispatches one explicit planning assignment under the mission. Its instructions require
the worker to read the current plan, submit a candidate, and report ready without executing proposed steps. Only mission
workers receive `workspace_plan_read` and `workspace_plan_propose`. Their scope and attribution come from the host-bound
ticket, not model-supplied actor or mission fields. There is no worker approval tool. A proposal's content is untrusted
planning context and cannot broaden the worker's original mandate.

Historical definitions can be used as new drafts against the current version. This produces a new proposal and, if
approved, a new immutable version. It does not overwrite history. Reintroduced or new action references receive new
host-generated IDs, preventing old dispatch receipts from accidentally reopening a removed execution.

## Consistency and execution

The existing SQLite store holds `workspace_plan_version`, `workspace_plan_proposal`, `workspace_plan_command` and
`workspace_planning_request`. Approval, mission changes, history and command receipts commit in one transaction. Planner
dispatch includes its action creation and execution receipt in one transaction; disabled or paused execution leaves no
partial action. Identical request retries return the committed result. Reusing an ID with changed content is rejected.
The UI retains the original request and revision after ambiguous failures.

An approval checks both the proposal's base plan version and the rendered mission revision. A stale proposal can be
rejected or copied into a new draft; it is never silently rebased. Dependencies must refer to existing proposal actions,
have unique IDs and edges, and contain no cycle. Plans permit 200 actions and at most 128,000 serialized characters.
History and proposal indexes are paginated; complete definitions are fetched individually.

Changed/removed actions and their downstream dependents form the affected set. Changing the mission title, objective or
acceptance criteria affects every existing action. Approval refuses changes that affect live execution or a queued
follow-up. Independent additions can be approved while unaffected work continues. Changed results lose acceptance;
their retained old execution is marked outdated and cannot be steered or accepted as the new result. A fresh dispatch
records the current action definition revision in its mandate. Policy revalidation refuses superseded definitions.
Removed executions remain in the Engine store and Inbox with their original mission link.

Existing missions migrate once to a baseline version without changing their operational revision or accepted results.
Legacy action definitions and mandates count as definition revision 1. History and proposals are retained indefinitely
in this increment; retention and multi-workspace ownership remain in the full architecture ledger.

| API relative to `/orchestrator/api/` | Purpose |
| --- | --- |
| `GET missions/:id/plans` | Paged version and proposal metadata |
| `GET missions/:id/plans/:version` | One immutable definition |
| `GET missions/:id/proposals/:proposal` | Complete proposal and review |
| `POST missions/:id/proposals` | Submit a complete plan against `baseVersion` |
| `POST missions/:id/proposals/:proposal` | Approve/reject with proposal and mission revisions |
| `POST missions/:id/plan-request` | Authorize a planning assignment with optional guidance |

These endpoints inherit the existing loopback/origin/header guard. They do not provide remote multi-user authentication.
The host protects application-level authority; a local profile with broad shell access is not an OS security sandbox.

## Verification

Tests cover immutable history and review replay after reopening SQLite; malformed/cyclic/oversized definitions; concurrent
mission changes; stale proposals; independent changes alongside running work; transitive result invalidation; reruns under
new mandates; historical restoration with fresh identities; ownership changes; real registered planning tools and scope
refusals; atomic planner dispatch rollback; and legacy migration. Rendered forms exercise editing, approval, rejection,
history drafts, quoted HTML text, lost proposal responses and stale planner proposals through actual management routes.
Planning tools have a separate 4,000-character schema/description ceiling; existing orchestration and library budgets
remain unchanged. Browser/desktop acceptance and the remaining full architecture requirements are not implied by these tests.

2026-11-08: TypeScript, 71 test files / 1,278 tests and the server/client builds passed. The actual
`@deepseek-ai/dsh@0.2.1-rc.3` host with `deepseek-official/deepseek-flash` also completed the following local qualification:

| Evidence | Identity / value |
| --- | --- |
| Mission | `8cd32a7a-f21b-4fa8-92bf-d4172fc5e94a` |
| Planning ticket | `87cea26ab4a8071beb2b96ab70a06894` |
| Model-submitted proposal | `1d597286-7f4b-448b-9958-7f3a953be651` |
| Approved definition | Version 3; one agent action and one dependent person action |
| Explicitly dispatched execution | `bd451820122b51dafac8e03e122b5f39` |
| Published artifact | `73f1ceea-842d-4b6c-b351-720524c49c85` |
| Exact JSON | `{"values":[3,6,9],"total":18,"count":3}` (39 bytes, no trailing newline) |
| SHA-256 | `4defe98c2981a5e25077ec3497ce7a02464d1e8be6de6a7b52645eb6e5b8b764` |

Before approval, the original plan remained at version 2, the result file did not exist and the mission library was empty.
Approval created two actions with no runs. Explicit dispatch created the execution ticket; the person action remained
waiting until the agent result was accepted. The qualification driver independently read and parsed the local JSON,
recomputed sum/count, and compared the published bytes and hash. It then simulated operator review through the management
API to exercise the human action and mission completion. The recorded note explicitly identifies this as automated
qualification rather than actual human inspection; the artifact's model-submission trust classification was not promoted.

A real process stop/restart preserved the immutable versions, approved proposal, both completed actions and artifact
content/hash. Replaying the original planner request, approval and action dispatch left mission state unchanged and retained
exactly one assignment per ticket. Existing completed Inbox missions also migrated to baseline version 1 without losing
their accepted state. This is one small live planning workflow, not broad planning-quality or unattended-operation acceptance.
