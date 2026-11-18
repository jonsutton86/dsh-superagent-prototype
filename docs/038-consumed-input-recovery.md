# 038 Consumed input acknowledgements in recovery

[Held preparation](031-recovery-receipt-preparation.md) now reconciles missing Store acknowledgements against authenticated
Harness history. The worker can commit a `user/message` before the coordinator saves its `readAt` or removes an input from
`undelivered`. Leaving that mismatch in a restored image can incorrectly describe consumed work as unread.

## Evidence and repairs

Preparation holds the destination Session writers using [the existing backend comparison](035-session-backend-recovery.md).
The reconciler scans each ticket's authenticated `worker-<ticket-id>` archive in bounded pages. It uses the same hashed
request identity and current/legacy producer attribution as normal agent delivery. Only a matching `user/message` outside
the inherited prefix proves that this worker consumed the input. Inbox insertion, claim or cancellation alone does not;
neither does an ordinary user message with a coincidentally matching ID. Session history is never rewritten.

For live tickets, that evidence fills missing trigger `readAt` from the recorded event time and removes consumed IDs from
`undelivered`. Other input kinds, including legacy `reopen`, only receive queue acknowledgement. Existing read times,
assignments, delivery attribution, application timestamps, authority and ticket outcomes remain unchanged. Ended tickets
are checked but not repaired. Legacy absent read markers are not themselves evidence of either consumption or corruption.
An unread input whose worker Session has not yet been created remains pending.

A modern read marker without a matching worker receipt is contradictory and blocks preparation. Duplicate consumed
receipts, duplicate input/queue identities, unknown queue references and malformed relevant fields also fail. A savepoint
rolls back the entire reconciliation batch if any later archive, ticket or cancellation fails. Each complete archive must
authenticate before its ticket changes. These updates affect only the private image; original checkpoint and held source
Store remain unchanged. Reconciliation precedes billable inference probes.

## Signed evidence and limits

The appended optional `consumedInputs` image field records ticket/input counts, matched consumption receipts, repaired read
markers and removed queue entries. It contains no message bodies or credentials. Older signed images still authenticate;
absence of this field is absence of consumption-reconciliation evidence. Original-ID retries return their historical image
without repeating repairs or requiring inference availability. The prepared image retains its execution hold.

This is consumption acknowledgement reconciliation, not full authoritative-state recovery. It does not establish whether
queued, claimed or canceled work should resume, infer model/tool completion from a user message, revive ended tickets,
validate source/plugin configuration, reconcile all thread/evaluation/disposition/effect relationships, remap runtimes or
activate a restored coordinator. Those requirements, supported ownership handoff and clean-host failure qualification remain
open, alongside the full architecture and product ledger. Existing assignment-interruption recovery remains responsible
for restarting interrupted work after a supported activation path is implemented.

## Qualification

Focused tests use real Harness JSONL persistence and SQLite. They exercise producer attribution, inherited boundaries,
multi-page archives, unread inbox states, legacy inputs, contradictory markers, ended outcomes and transactional rollback.
Pipeline tests verify that only the signed private image changes, source holds remain, invalid state fails before inference,
and historical retries and older manifests remain supported. Installed-Harness qualification checks the signed summary
against real consumed ticket inputs; it does not claim a synthetic missing-acknowledgement repair happened in that live run.

Consumed-input recovery code `679a97ad8f290f060c07a332ba4de3a0bad690f7` passed 1,640 local tests, typechecking and all
four builds. The same code passed 1,642 tests with native Linux confinement, typechecking and all builds in
[run 42570416549](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42570416549).
Both owned installed-Harness / DeepSeek Flash scenarios passed in 197.68 seconds. Managed recovery verified the signed
consumption summary against actual worker inputs and returned the same held image on retry; the dedicated case retained
its expected refusal for unrecorded publication probes. The focused recovery/delivery run passed 133 tests. Provider-message
traffic stayed local and the original app remained running. Source configuration, broader authoritative-state reconciliation,
supported activation and the remaining full architecture/product requirements remain open.
