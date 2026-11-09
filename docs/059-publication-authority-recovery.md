# Publication authority in held recovery images

This increment extends [context and budget recovery](058-context-budget-recovery.md) to the coordinator's artifact
publication and mission delivery records. Independent service receipts already establish the original external outcome.
The new read-only validator also links that outcome to the original local approval, artifact bytes, selected host checks,
mission plan, delivery grant and Outbox message. It runs before receipt application can settle or recreate a message, and
again after reconciliation to require settled outcomes in the signed image. It never sends, observes a provider, refreshes
evidence, reauthorizes a grant or removes the execution hold.

## Artifact authority

New approvals retain their normalized request and the complete public destination snapshot. Both remain private coordinator
record fields rather than additional fields in the publication UI response. The snapshot contains no credential. Its digest,
destination limit and supported publication type are checked against the original intent. Approval fingerprints retain the
operator's original check ordering and distinguish an omitted selection from an explicitly empty selection.

The approved artifact must resolve to its immutable library record and exact stored text bytes. A later archive or source
change does not substitute a new artifact or invalidate the fact that an older publication occurred. The validator checks
the saved revision against retained history; it does not call the current eligibility or freshness gate.

Worker artifacts resolve their selected successful host checks. Checked publications retain the original review purpose,
approval fingerprint, check selections, successful review attempt and capture-bound seals. The original check/capture
binding and freshness window arithmetic are verified without extending the window. A later review attempt may have new
seals; it cannot replace the successful attempt used for an earlier publication. PR reviews also retain the exact inspected
head and captured clean Git tree. Selection comparison follows the review service's ordering while request hashing preserves
the original operator request.

## Mission delivery and independent outcomes

Delivery grants retain a contiguous per-mission revision history and their exact original plan version. Replacement preserves
the preceding grant's revocation timestamp. New grants store the normalized configure request in a nullable command column,
including the mission revision selected by the operator. Enabling a grant binds its destination snapshot; disabling delivery
does not erase the old grant or an unresolved send. Historical plan changes, closure and revocation are not new authority.

Each channel publication resolves its original mission, grant, task and workspace Trigger. Its destination, text, message ID,
task ID, plan binding and original Outbox fields must agree. Withdrawn uncertain sends stay distinct from unsent messages.
An older withdrawn intent with a missing Outbox row may retain that gap before reconciliation; only its authenticated original
receipt can recreate the original row. The final image requires the corresponding sent/dropped outcome and forbids unresolved
or missing message receipts. The source checkpoint remains unchanged.

All publication subjects, exact content hashes/byte counts and ownership attempts match their retained independent receipt.
Sent outcomes require the external receipt. Where a destination snapshot is retained, its external URL and marked provider
body hash are checked against the original destination and payload. PR receipts bind the approved commit and review event;
a later dismissed review remains historical evidence. These are checks of retained provider observations, not a fresh query
of today's remote content, permissions or branch policy. The existing independent receipt audit and configuration probes
remain required separately.

## Compatibility, bounds and qualification

Older artifact approval requests can be reconstructed from retained fields, including the explicit-empty-checks variant.
Missing destination snapshots, grant request bodies, original Trigger plan stamps and immutable review seals are counted
separately. A legacy review seal still has to resolve to the original successful check and capture. No missing request or
destination is fabricated. Old prepared image manifests remain readable without acquiring a new proof.

The optional signed `publicationState` summary contains record counts, historical/uncertain outcomes, evidence-gap counts
and a deterministic digest. It contains no messages, approval bodies, credentials or destination paths. Each inspection uses
the bounded product-state reader: 250,000 charged records, 256 MiB of inspected serialized data, 8 MiB per charged value and
two million relationships, with cancellation. These are inspection limits, not a measured capacity claim.

Tests exercise actual Runtime, Library, Workspace, Engine, publication service, provider contract servers, host subprocess
checks and Git captures. They cover archival, grant replacement, later plan edits, original-ID replay, uncertain withdrawal,
receipt recreation, multiple-check ordering, historical review attempts, PR review events, substituted authority/content,
legacy evidence and refusal before receipt application or inference. Live installed-Harness recovery requires nonempty
signed checked-publication and mission-delivery evidence with no legacy gaps.

Full local, native Linux and installed-Harness qualification results will be recorded after verification. Deployment
binding/remapping, restored activation, ownership handoff and clean-host failover remain unfinished. All remaining full
architecture and Agentic OS product requirements stay in scope.
