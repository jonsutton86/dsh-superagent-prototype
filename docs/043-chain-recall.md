# 043 Bounded Chain of Recall

The existing `workspace_search` and `workspace_read` tools now use a host retrieval planner. This extends the scoped
[library](011-library.md) and complements [inference usage limits](042-usage-budgets.md), without a second agent runtime.
Retrieval follows immutable record references and preserves each record's trust, content hash, provenance and source state.
Returned text remains context, not instructions, execution authority or proof of factual correctness.

## Durable allowances

A worker's allowance belongs to its persisted ticket and current assignment. Changing queries, re-registering tools,
compaction or process restart cannot create a fresh allowance for that assignment. A newly authorized assignment gets a
separate allowance. The single coordinator/router shares a UTC-day allowance. There is no model-selected budget identity,
reset tool or allowance-changing library tool. Operator browsing remains outside agent retrieval accounting.

Defaults are 100 calls, 200 pages, 1 MiB of returned UTF-8 JSON, 20,000 inspected source nodes and 20,000 milliseconds per
owner. Each retrieval is limited to five pages, 64 KiB of returned JSON, 512 inspected nodes, 100 milliseconds and two
content-link levels. Operator configuration can change these within bounded schema ceilings. A `depth` read argument can
reduce traversal; the host clips a larger request to the current policy. Text pages retain their existing 4,000-character
default and 8,000-character maximum. Every read result returns its charge, remaining allowance and incompleteness flag.

Admission and the full conservative reservation commit in one SQLite transaction before reading. Concurrent calls cannot
spend the same remaining allowance. Successful retrievals settle against actual pages, unique source nodes, measured time
and serialized UTF-8 bytes; unused reservation is released. Failed reads still consume a call and performed work. A process
loss leaves its full reservation charged, preventing a restart from inventing unused capacity. Configurations have immutable
revisions and original-request fingerprints; lost responses replay without applying a second edit. Policy changes do not
erase prior charges. Raising a ceiling enables further retrieval against the same recorded usage.

The output byte ceiling includes record metadata, links and the accounting receipt. Search trims whole records and adjusts
its continuation offset. Reads trim linked pages first, then shorten the root excerpt with a correct continuation offset.
An allowance too small for one record's metadata is refused. Invalid input and a pre-aborted signal are rejected before
reservation. Scope-denied reads expose no private content and still consume an admitted attempt.

Time is checked between local operations and measured work is charged even after an overrun. A synchronous SQLite query,
hash operation or serialization cannot be preempted by this clock check. Node, page, depth and output-byte ceilings provide
separate bounded work/output controls. These are retrieval context bytes, not exact model tokens; the managed inference
ledger accounts provider-reported tokens. Tokenizer-specific selection and broader workload measurements remain open.

## Graph traversal and freshness

Reads return the root page plus a breadth-first chain of outgoing source records and visible incoming supersession or
contradiction records. Every node uses the same worker/router scope checks as direct reads. Visited identities prevent
duplicate delivery and cycles. Binary records return metadata; they are not silently extracted or interpreted. Text excerpts
retain their own pagination. Limits, unavailable nodes and incomplete source inspection are explicit in the response.

Freshness inspection follows outgoing source dependencies transitively. It checks archival, expiry, visible supersession,
contradictions and each recorded source content hash. Missing/inaccessible sources, cycles or exhausted inspection limits
produce `unknown`, not a clean result. Issues contain only accessible record identities; an unavailable source is described
against its accessible parent. The bounded display inspection checks at most 512 nodes and 32 source levels by default,
with a 100 ms operation-check deadline. Agent retrieval shares its stricter remaining node/time allowance across inspected
records. Source lists and operator detail views expose changed, contested or incomplete chains and links to the cause.

This state describes stored library provenance. It does not establish semantic truth, solve contradictions, refresh an
external website automatically or authenticate every source claim. Imports and connector-specific freshness remain work.
Application tool scoping also does not replace OS/network confinement for a worker with broad host access.

## Review integrity

Mission acceptance fingerprints the complete accessible outgoing dependency closure of its submitted records, including
visible incoming supersession/contradiction records and their dependencies. The recursive SQL uses identity deduplication,
terminates on cycles and is bounded by the library's 50,000-record storage capacity. It includes immutable hashes/source
links, archival revisions and expiry states. Display limits cannot hide a distant change from review invalidation.
An unrelated library record does not invalidate the fingerprint. Existing acceptance fingerprints may require re-review
after this stronger fingerprint is introduced; the upgrade never silently upgrades a prior review's evidence claim.

The operator may inspect and review a result even when a bounded display inspection is incomplete; review still binds the
complete accessible closure. Source changes invalidate that review. Artifact publication additionally requires a complete,
current source inspection; unknown, stale and contested chains cannot pass its existing delivery gate. This is not a replacement for host-collected command
checks, Git/environment revision binding or human assessment of factual correctness. Large-graph indexing, caching and
retention need workload measurement before claiming production-scale latency.

## Operator surface and qualification

The library's **Recall limits and history** controls edit cumulative and per-retrieval limits and show persisted charges,
unfinished reservations, truncation and execution links. Forms preserve the original revision/request after response loss.
All endpoints inherit existing loopback, same-origin and ownership checks:

| Route | Purpose |
| --- | --- |
| `GET recall` | Current configuration and paginated retrieval receipts |
| `PUT recall` | Revision-bound operator policy update |
| `GET recall/versions/:version` | Original configuration snapshot |

Deterministic checks cover concurrent admission, SQLite reopen, lost-process reservations, UTF-8 byte accounting, clipping
and continuation, scopes, expiry/conflict propagation, missing/mismatched sources, corrupted cycles, complete review
invalidation beyond display depth and no invalidation from unrelated records. Rendered checks cover policy editing,
ambiguous responses, preserved charges and navigation to a distant stale source. Existing prompt/tool definition size
ceilings remain unchanged. Installed-Harness qualification reads a fresh verification code through three linked records,
checks the actual model report and retrieval receipt, then restarts to verify the same persisted charges.

Qualification results are recorded after these checks finish. Automatic reflection/proposals, retrieval-quality and
long-horizon evaluations, external imports/freshness, retention, multi-workspace, speculative admission, remote deployment,
restored activation/failover, host verification, supervision UI, voice, packaging and the remaining architecture/product
requirements remain open. Browser layout/accessibility verification remains open while browser use is disabled.
