# Context and budget state in held recovery images

This increment extends [registry recovery](057-registry-authority-recovery.md) to scheduled reflection, cumulative recall,
managed model usage and speculative allocations. These are recorded product graphs inside the existing DeepSeek Harness
coordinator Store. The validators construct no service, call no provider, dispatch no worker, approve no proposal and
release no reservation. Product constructors deliberately perform some restart mutations, so recovery reads their tables
directly while the staged checkpoint remains held.

## Reflection evidence and recall charges

Each reflection run resolves its original occurrence, schedule version and mission. The fixed snapshot must reproduce its
hash and UTF-8 byte count, guidance, selection scopes and selected limits. New captures use one timestamp for capture and
lookback and carry `captureVersion: 1`; older snapshots retain their original timestamps and are counted explicitly.
Captured mission definitions resolve to historical plan versions, and captured events retain their original IDs and content.
Later plan edits do not substitute today's definition for the captured one. Captured library metadata, scoped incoming links,
content prefixes and full original blob hashes are checked without recomputing historical freshness against today's clock.
Omission/freshness metadata remains a captured observation, not proof that every possible item was selected or that a claim
is semantically true.

All pending, approved and rejected candidates resolve their original worker assignment and captured evidence. Submission
and review commands reproduce their original request fingerprints, including their actor and revision. Promotion results
remain subject to the separate artifact/plan/completion evidence checks. Per-assignment snapshot-read counters resolve to
the original reflection worker, remain within their persisted call/byte allowance and are never reset. Those aggregate
counters are recorded host observations; individual historical page responses were not retained.

Recall configuration history is contiguous, and its command requests are reconstructed exactly even for older receipts.
Attempts retain the original worker assignment or router UTC day. The validator replays cumulative charge arithmetic in
stored order under each attempt's recorded policy to verify its original reservation. A reserved attempt keeps its full
reservation; failed retrieval retains its recorded work charge and zero returned bytes. Complete retrieval preserves its
bounded output charge and truncation flag. Synchronous work can exceed a checked time deadline; observed elapsed overruns
are counted, not clipped or refunded. No search, source refresh or model context reconstruction runs during verification.

## Model accounting and speculative allocations

Usage configurations retain their original tracking start, prices and scoped limits. Calls resolve their original Session
ancestry, owning task/assignment, mission/schedule/persona and price snapshot. Recorded token totals and estimated costs
are recomputed with the same pure pricing function as normal accounting. Unknown and pending calls retain reservations;
unpriced reports remain explicitly unpriced. Operator reconciliation retains the original provider report and uses its
separate recorded token/cost evidence. Historical calls are not rejected merely because today's limits are lower.

Speculative runs resolve their inferred mandate and original assignment, owner, environment and execution location. New
queued allocations retain `queuedPolicyRevision` and derive expiry from their single saved creation timestamp. Admission
deadlines likewise derive from the saved admission timestamp. Saved allowance/provider/deadline bindings are checked against
the admitted policy. Old allocations lacking policy references are counted explicitly and never supplied today's policy.
Held and released allocations remain distinct; a released run cannot have pending or unknown attributed model calls.
Promotion and exact-message publication commands retain their separate authority. Later expiry or cancellation does not
erase historical review, usage or receipt evidence.

These checks authenticate recorded arithmetic and relationships. They do not independently verify a provider invoice,
prove past process quiescence anew, or replay every historical quota decision from an unavailable event timeline. Existing
runtime guards continue to enforce future admission, deadline, process/endpoint quiescence and publication requirements.
Legacy assignment/policy/header gaps stay visible in the signed summary. They are not permission to execute after restore.

## Durable command evidence and compatibility

New usage, recall, reflection and speculation commands save their normalized request alongside the existing fingerprint
and result. The nullable column is added without changing old receipts or their idempotent replay behavior. Reflection
and recall requests can be reconstructed from retained histories. Legacy usage requests are matched to their exact
configuration or reconciliation facts under the validator's relationship bound. Legacy speculative configuration responses
also retain enough data to reconstruct their commands. Old speculative review/message receipts only retain a result run ID;
their missing request payloads are counted, and references remain bound to that run. No missing payload is fabricated.

The optional signed `contextState` and `budgetState` summaries report inspected records, snapshots, reads/recall charges,
model liabilities, speculative holds/releases and evidence gaps, with deterministic SHA-256 digests. They contain no prompt
text, request bodies, credentials or paths. Old prepared manifests remain readable without acquiring the new proofs.
Original-ID preparation returns the same authenticated image. Contradiction discards the unpublished image before inference,
preserving the staged checkpoint and execution hold.

Each validator allows at most 250,000 charged records, 256 MiB of inspected serialized data, 8 MiB per charged value and two
million relationships. Repeated inspections and legacy request matching count toward these bounds. Scans yield and observe
cancellation. These are validation bounds, not measured deployment capacity.

## Qualification and remaining work

Tests use actual Library, Recall, Workspace, Reflection, Usage, Speculation and Engine transactions. They cover historical
source edits/archive, approvals, exact snapshot charges, failed/reserved recall, unpriced and reconciled calls, changed
prices and lower limits, descendant ownership, uncertain speculative holds, separate promotion/message approval, original-ID
signed-image retrieval, legacy evidence, corruption refusal, cancellation and bounded diagnostics. Installed-Harness
qualification requires nonempty signed recall/model evidence and, for the managed-world reflection scenario, captured
snapshots, proposals and read charges, without legacy accounting gaps.

Full local, native Linux and installed-Harness qualification results will be recorded after verification. Remaining
publication and registry cross-references, deployment binding/remapping, actual restored activation/ownership handoff and
clean-host failover remain open, alongside every other uncompleted architecture/product requirement. The full standalone
Agentic OS objective is unchanged.
