# Scheduled reflection and reviewed proposals

Reflection extends the existing [scheduler](041-schedules.md), [workspace](010-agentic-os.md), versioned plans and
[library](011-library.md). The Engine and DeepSeek Harness still own dispatch, execution, usage accounting and recovery.
It is not a second autonomous runner. An operator enables a reflection schedule with context selectors, bounded limits,
guidance and optional exact persona/environment references. The scheduler stores the canonical reflection plan, ignoring
caller-supplied alternative execution instructions for this schedule type.

## Context captured before dispatch

Each occurrence creates one reflection mission and one immutable context snapshot in the same SQLite transaction, before
the executor's after-commit effects. Failed capture rolls back the mission/effects and blocks the existing occurrence.
Explicit retry uses that occurrence and its original schedule version. Restart and later schedule edits cannot recapture
an existing run. Snapshot hashes and byte counts are verified before agent reads or approval.

Selection uses recent mission definition, event and ticket activity. An optional mission allowlist restricts that pool;
other reflection missions are excluded. Defaults are seven days, five missions, ten records and 64 KiB of UTF-8 JSON.
The schema permits up to ten missions, twenty records and 256 KiB, with a one-hour to one-year lookback. Selected mission
plans, action states/reports and ten recent operator events are captured together. Oversized missions are omitted whole.
Library selection includes shared records and records private to captured missions. Incoming links and source inspection
use those same scopes; unrelated private relationships are not disclosed. Records include provenance, freshness state,
hashes and a 4,000-character excerpt; binary content is not extracted. Recent library selection uses creation time.

Counts, UTF-8 size, unavailable records, partial records and lower-bound omission counts are explicit. Selection checks a
200 ms deadline between operations, and source inspection shares the library's bounded inspector. A synchronous database
query or hash operation cannot be preempted; this is not a hard wall-clock guarantee. The metadata selection query still
needs workload-scale indexing/measurement. Context is evidence, never an instruction or expanded execution authority.

`workspace_reflection_read` pages the fixed JSON snapshot in chunks of at most 6,000 characters. The host derives ownership
from the current authorized ticket/assignment. Persisted read charges allow at most 100 calls and the larger of 64 KiB or
eight times the snapshot's bytes per assignment. Exact returned JSON bytes are charged before return; response loss does not
refund them. A separately authorized retry assignment gets its own allowance. Other workers' ordinary library reads retain their
[Chain of Recall](043-chain-recall.md) policy, and inference retains [model usage budgets](042-usage-budgets.md).
These snapshot bytes are not exact model tokens. Operators may inspect the captured snapshot without agent read charges.

## Candidates and review

`workspace_reflection_propose` accepts at most ten candidates per occurrence, each with rationale and captured evidence IDs:

| Candidate | Effect of operator approval |
| --- | --- |
| Memory | Publish immutable shared or explicitly selected mission-scoped memory, retaining original agent authorship, source links and reflection/review identifiers |
| Mission plan change | Apply a complete plan to a cited captured mission through Workspace's existing revision, dependency and active-work checks |
| New mission draft | Create a mission and apply its proposed plan atomically; all actions remain undispatched |

Reflection workers cannot select another run or impersonate an operator. Paused execution, closed/superseded workers,
disabled workspace sources and unavailable execution authority refuse further reads/proposals. Their tool registration
omits ordinary library tools and plan-proposal tools, so these tools cannot read beyond the selected snapshot or publish
directly. Candidate submission has no publication or plan side
effect. The operator review endpoint is the only reflection promotion path. Existing broad host/shell capabilities are
not an OS security boundary; router authority separation and confined deployment acceptance remain work.

Approvals recheck every cited mission fingerprint, including action execution and evidence revisions. Every cited library
record must retain its metadata revision/hash and have a complete current source inspection in the original capture scopes.
Changed, expired, archived, conflicting or unknown evidence refuses approval; a new reflection is needed. Rejection remains
available for stale candidates. Scope checks prevent private source references from being published into another scope.
An operator can explicitly approve a new shared-memory candidate derived from captured mission text; its destination is
displayed before approval. Agent submissions remain unverified claims after approval.
Mission citations remain in the immutable reflection record; promoted memory does not automatically track subsequent
changes to mission text. Library source links continue to participate in ordinary transitive freshness checks.

Review revisions, idempotency fingerprints, promotion and receipts commit together. A lost response retries the original
request without a second memory, mission or plan version. Active affected actions must stop or finish before plan changes;
approval cannot bypass those Workspace checks. Plan history records the reflection proposal ID, and memory records link
back to the reflection review. No candidate approval starts work, widens policy, enables a schedule or posts externally.
The occurrence mission still requires ordinary result acceptance; pending review counts against the schedule's open-run
limit, including when a reflection returns no useful candidates.

## Operator surface and verification

The Reflections tab offers a guided schedule form with timezone/cadence, missed-run policy, run/open limits, automatic or
selected mission context, persona/environment selection and explicit enable. It shows captured evidence, omission bounds,
proposal contents/destinations, review notes and links to current evidence, schedules, conversations and promoted results.
Existing schedule edits retain reflection configuration. Review forms preserve the original payload after response loss.
All endpoints inherit the existing loopback/origin/ownership guards:

| Route | Purpose |
| --- | --- |
| `POST schedules`, `PUT schedules/:id` | Existing schedule commands with optional `definition.reflection` |
| `GET reflections` | Paginated runs and pending proposal counts |
| `GET reflections/:id` | Exact captured evidence and proposals |
| `POST reflections/:id/proposals/:proposal/review` | Revision-bound approval/rejection with a review note |

Deterministic qualification covers scope filtering, snapshot pagination/bounds/integrity, activity selection, SQLite reopen,
capture rollback, stale and private evidence, active-work protection, durable allowances, proposal limits and duplicate
commands. Rendered qualification creates a schedule and reviews a proposal through real API routes, including approval
response loss. Installed-Harness qualification supplies a fresh verification value only in captured evidence, checks a
real agent's pending candidate, verifies no direct publication, approves once and restarts to check unchanged snapshots,
receipts and dispatch counts.

Code `b53a3fd2d268a23175f85bb024660f4ae5567ec1` passed the full local check: 1,718 tests (seven skipped),
typechecking and all four builds; the test phase took 108.25 seconds. The initial full run exposed two existing navigation
assertions needing the added Reflections tab; the corrected full run passed. The focused reflection/schedule/locale run
passed 32 tests, including both rendered flows. Exact-code Linux
[run 42591703174](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42591703174), job `129074607888`,
passed 1,720 tests (five skipped), typechecking and all builds; its test phase took 173.06 seconds.
Both owned installed-Harness / DeepSeek Flash scenarios passed in 289.10 seconds (two passed, two unselected cases skipped).
They retained the existing artifact, usage-limit/retry, Chain of Recall, scheduled execution and held-recovery checks;
the managed-world schedule flow additionally verified a real reflection candidate against captured-only evidence,
operator-only publication, source/agent provenance, usage attribution, identical approval replay and snapshot/dispatch
preservation after restart. GitHub/Feishu traffic used fixture services. The operator's inference credential was used
without displaying it. The original app process remained running throughout.

This completes the scheduled reflection/proposal path, not the full Agentic OS objective. Reflection quality and long-horizon
evaluation, semantic source verification, tokenizer-aware selection, external refresh/imports, retention/scaling,
multi-workspace ownership, speculative admission/promotion, managed machine launch, host-collected verification, clean-host
activation/failover, supervision, voice, packaging and onboarding remain in the full implementation ledger.
