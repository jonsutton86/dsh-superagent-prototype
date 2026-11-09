# Speculative preparation, reservations and promotion

This increment adds an explicit lifecycle to existing inferred mandates, without introducing a second executor or replacing
DeepSeek Harness. The source admission matrix, enabled matching rules and `auto` evaluation mode remain prerequisites.
An inferred assignment is proposed, admitted for background preparation, evidence-ready, promoted, expired or cancelled.
Explicit requests continue through the Engine and have priority over speculative preparation.

## Durable admission and accounting

Before the executor prepares a workspace or starts a worker, SQLite reserves a complete run allowance against workspace,
owner, provider and environment quotas. Owner means the mandate actor's source and ID. Environment means its immutable
execution environment ID, or local. Each dimension has one configurable quota applied independently to each matching
identity. Concurrency, daily run count, calls, tokens, execution seconds and optional estimated micro-USD cost are bounded.
Quota usage is UTC-day spend plus unused outstanding reservations; concurrency remains held across day boundaries.
Per-run allowances and policy revision are captured at admission. Policy changes govern new admissions and enabling;
they do not silently replace the captured allowance of an active run. Disabling preparation withdraws active authority.

Defaults allow one concurrent preparation in each dimension, ten calls, two million tokens and ten minutes per run,
with a 24-hour result expiry. Each dimension permits 20 admissions, 200 calls, 50 million tokens and 7,200 execution
seconds per UTC day. Costs are unlimited unless configured; cost enforcement also needs current model price records.
The token ceiling must accommodate the selected model's declared context reservation. Expiry starts when proposed.
The execution deadline starts at admission. A waiting proposal therefore cannot acquire a fresh lifetime by retrying.

The existing Harness `llm/stream` accounting hook derives worker/assignment ownership from managed Session lineage.
Calls and descendants consume the same allocation. Actual provider changes reserve an additional full provider allowance
before a stream starts; the earlier provider reservation remains conservative. The call insert and reservation change are
one transaction. Missing context metadata or unpriced calls cannot bypass a configured token/cost allowance. Reported
usage, retained unknown-call reservations and evidenced reconciliation retain their existing accounting semantics.
This is declared-context admission control and estimated spend, not an invoice cap or hard process execution deadline.

## Preemption, cancellation and recovery

Explicit queued work preempts enough admitted preparations to fit the executor's worker capacity. It waits for those
reservations to become quiescent before starting. Preemption reports a blocked preparation, retains its files and Session,
and does not manufacture a human cancellation. An operator retry creates a new assignment/allocation; already spent
usage remains charged. Cleanup names the original assignment so it cannot cancel the retry's queued launch.

Tool, model and new-publication guards check authorization/expiry synchronously, independent of the periodic pass.
The pass inspects at most 16 lifecycle rows per iteration. It stops work through the existing executor and releases a
reservation only after checking startup/stop activity, the root worker, up to 128 descendants, owned jobs and all original
remote effect receipts. Child enumeration and endpoint refresh have two-second waits. Original execution bindings remain
captured even when a later assignment changes. Unknown model calls continue to hold the allocation after process quiet.
A failed stop, incomplete enumeration or unresolved remote outcome is not evidence of quiescence.

On restart, unreleased allocations are marked recovered. Missing local processes do not prove their original host stopped:
an operator must record evidence of inspection. This attestation cannot override unknown model usage or remote effect
receipts. Older active inferred assignments without a ledger enter a held legacy state; an unknown provider blocks new
speculative admission until reconciled. All previously unallocated calls for that legacy ticket are conservatively
attributed to its recovered allocation, because old calls lack assignment ownership. The release evidence is separate from the original cancellation reason.
A recovered admitted allocation closes instead of silently restarting with a new budget. Runs and spent usage survive
SQLite reopen. History currently caps at 10,000 assignments; operational retention/archiving remains future work.

## Review and publication

After a ready report, execution stops and its remaining model/effect outcomes settle. The resulting evidence fingerprint
binds the ticket/assignment state and library evidence revision, including transitive freshness. Operator promotion checks
that exact fingerprint, quiescence, result expiry and current source authority. It changes review authority only: it does
not rerun the worker, copy artifacts or replace their agent provenance. Changed evidence requires renewed preparation and
review; an old fingerprint cannot authorize publication. Expired/withdrawn/replaced preparation cannot publish.

Promotion and sending are separate commands. Each outbox message needs approval of its exact ID, text, kind and destination.
Artifact publication still uses its existing artifact-specific review and adds the speculative promotion check. New outbox
dispatch checks authority after asynchronous observation. Already accepted external requests are observed and settled;
expiry cannot retract a request already accepted by a destination. Existing ownership and publication fencing still apply.

The Speculation panel exposes policy fields, lifecycle, reservation status, actual/reserved usage, evidence, report,
process reconciliation and individual message approval. Review notes, optimistic revisions and request IDs make a lost
response retry the original command. The API provides list/detail, immutable policy versions, configuration, review and
message approval under the existing loopback/origin/ownership checks. Usage and Environments remain the reconciliation
surfaces for model calls and endpoint effects.

## Qualification and remaining boundaries

Focused tests exercise competing admissions, independent dimensions, provider changes, model ceilings, assignment races,
explicit preemption, daily rollover, unknown-call/local reconciliation, legacy holds, stale evidence, expiry, message
fingerprints, lost-response UI retries, real Runtime/HTTP/outbox wiring and old-assignment cancellation.
The opt-in installed-Harness test supplies only a deterministic synthetic source assessment. Its inferred worker uses the
configured real API to create a file and library artifact. It checks actual usage, held publication, separate approval,
original artifacts and receipts across restart. The message destination is an isolated fixture, not GitHub or Feishu.
Qualification results and exact code revision are recorded in the implementation ledger after execution.

Broad shell/host access remains an authority boundary of the underlying execution profile. These managed tool/publication
gates are not an OS or network sandbox and do not prove that arbitrary shell commands cannot communicate externally.
In-flight commands/provider requests can outlive a deadline while cancellation settles; their usage stays charged.
Long-horizon speculative quality/waste measurements, billing reconciliation across providers, retention and scale tests,
stronger router/worker confinement and all remaining Agentic OS architecture requirements stay open.

Code `6f27667b1d6f6ca4572fbad02e4aa06e830ffdbb` passed the final local `pnpm check`: 1,738 tests passed, eight skipped,
109 test files passed and two skipped, in 108.54 seconds, with typechecking and all four builds successful. The installed
Harness / DeepSeek Flash speculative scenario passed against the final built artifact in 21.98 seconds. It verified a
real file and library artifact, nonzero reported model usage, no send before promotion and exact message approval, and
unchanged result/evidence/usage plus a single delivery after restart and repeated original approval requests.

The same code passed Ubuntu / Node 24 with native confinement enabled in
[run 42599700832](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42599700832): 1,740 tests passed,
six skipped, 109 files passed and two skipped, in 175.89 seconds, with typechecking and all four builds successful.

Both owned installed-Harness / DeepSeek Flash scenarios passed against the final built artifact in 262.56 seconds,
including managed-world scheduled reflection, usage refusal/retry, artifacts and held recovery. The original app process
remained running. These checks qualify this increment; they do not close the remaining full Agentic OS requirements.
