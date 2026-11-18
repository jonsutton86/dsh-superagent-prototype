# 054 Connector state in held recovery

Prepared recovery images now include a read-only check of the built-in GitHub/Feishu cursor families and owned conversation
listener state. It runs after [core Engine reconciliation](053-engine-state-reconciliation.md), before the private image is
signed. Configuration and provider-account checks remain the separate [source contract](039-source-contract-recovery.md)
and [control configuration](036-control-configuration-recovery.md) checks. No listener is started by this operation.

## Cursor preservation

The check reads only the KV families owned by the built-in adapters: GitHub notification time, retry map, per-item read
times, stream starts/ETags and CI baselines/revisions; Feishu chat/history/topic state, per-thread seen-message IDs and
initialization flags. It validates their bounded shapes and timestamps, including retained state for disabled adapters.
Feishu thread checkpoints must reference their original Feishu thread. Duplicate CI check names remain legal; duplicate
seen-message identities do not. Unknown plugin keys remain opaque and outside this proof.

No cursor is advanced or rewound, no ETag or baseline is reset, and no deduplication record is dropped. Existing adapter
overlap windows, initial-context suppression, retry limits and polling horizons retain their existing behavior. A retained
cursor is not proof that a provider still accepts it or retains every old message. The existing explicit rescan operation
remains available after normal activation; preparation never invokes it or claims complete provider history.

## Owned conversations

The validator checks every listener revision and its historical receipts. Listener identity, physical mission index,
revision succession, revocation of replaced listeners and normalized participant IDs must agree. Enabled listener records
retain the exact original mission, delivery grant, destination metadata/hash and ticket origin/channel. A historical grant
or listener can remain revoked, and an old plan can remain superseded; validation does not reactivate them. Two unrevoked
listeners cannot claim the same physical conversation.

The watermark cannot precede the listener's authorization start. An in-progress page cycle retains its exact start and
watermark, bounded unique cursor hashes and the hash of its last recorded cursor. These relationships detect substituted
pagination state without sending a provider request. Destination metadata is checked against its content hash, including
when both listener and grant contain the same substituted destination.

Each received message keeps its original listener, authorized participant, task, time and deduplication identity. Its
conversation Trigger must match the receipt, original task's threads/channel, human actor and directed disposition.
Conversely, every conversation Trigger needs its original received-message receipt. Unsupported content retains its
non-executing receipt and problem marker. Per-listener receipt counts must agree with the retained history; a mismatch fails
preparation rather than repairing away evidence of missing history.

New receipts retain the provider's native message ID. Recovery recomputes their deduplication identity from that ID and the
physical conversation. For supported received messages, it also reconstructs the canonical provider message from the
original Trigger/receipt fields and checks the original content hash. Older receipts without native IDs remain unchanged
and are counted separately; their missing native/content evidence is not invented. Unsupported content keeps its original
observation hash without reconstructing a body that was intentionally not admitted. No provider reread is performed.

## Evidence and limits

The optional signed `connectorState` version 1 records the inspected record count, GitHub/Feishu key counts, listener/message
counts, native-ID/legacy receipt counts, partial-cycle count and a deterministic SHA-256 over the inspected rows and referenced state. It exposes no cursor,
message body, participant list or credential. The complete image still has its existing file hashes and manifest HMAC.
Original-ID retries return the original authenticated image. Older images remain readable without receiving a proof they
never had.

The validator performs no writes or network calls. It yields during scans and observes cancellation, with refusal bounds
of 250,000 inspected records, 128 MiB of serialized values, 4 MiB per record and smaller array/field bounds. Counts include
references and repeated checks of the same row; these are validation limits, not a demonstrated deployment capacity.
The existing preparation cleanup removes any unpublished temporary image on failure. Source/staged core state, cursors,
receipts and the execution hold remain unchanged; normal preparation-intent bookkeeping still applies.

This qualifies recorded built-in connector consistency and preservation. It does not restore provider retention, validate
unknown plugin state, enable the legacy watchers in owned mode, or prove future connectivity. Workspace plans, schedules,
artifacts and other product-extension graphs still need their own authority checks. Actual deployment binding/remapping,
activation/ownership handoff and clean-host failover remain open with the full architecture/product objective.

## Qualification

Tests use the actual owned Runtime, publication service and GitHub-comment, GitHub-review and Feishu adapters against local
provider servers. They verify authorized/unsupported receipts, historical replacement/disablement, a partial 47-message
backlog, reconstruction of the listener component under the existing fixture owner, consumption of only the remaining
seven messages, and deduplication after rescan. This component reconstruction is not held-coordinator activation.
Corruption cases cover participant/task/destination substitution, revision and watermark changes, cursor/hash disagreement,
missing receipts, native identity/content mismatches, altered Trigger/channel/disposition authority and physical grant indexes. Legacy-family tests cover
byte-preserving validation, unknown plugin exclusion, duplicate/blank CI names, invalid cursors, missing Feishu threads, limits
and cancellation. Pipeline checks cover signed proof, historical manifests, original-ID retry and unpublished-image cleanup.
Installed-Harness managed recovery requires nonempty listener/message evidence from the actual workload.

Local verification passed 1,869 tests (14 conditional skips), typechecking and all six builds; the final legacy-cursor
regression also passed. Runtime/test revision `5383677d65bfe845b2797fc91d0216bb5ad26257` passed 1,876 tests (eight
conditional skips), typechecking and all six builds on Linux / Node 24 with native confinement in
[run 42659022305](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42659022305).
The same revision passed the installed-Harness / DeepSeek Flash owned-managed recovery scenario in 207.46 seconds. Its
signed prepared image contained nonempty listener/message evidence, native IDs for every captured inbound receipt and
zero legacy receipts. Original-ID retry retrieved the same held image. Inference used the configured real API; external
provider operations stayed on local contract servers. The original app remained running. These results qualify the held
connector checks and receipt preservation, not restored activation or completion of the full architecture/product goal.
