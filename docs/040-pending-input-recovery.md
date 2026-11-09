# 040 Pending input delivery across interruption

Every current ticket input kind now shares delivery and consumption acknowledgement fields. Trigger messages, policy
changes, resume notices, text instructions and orchestrator notes record the assignment that accepted them and remain
`readAt: null` until the worker admits their message to Session history. This extends the trigger-only bookkeeping used
previously. Historical `reopen` records still produce no message and receive no delivery/read fields. Optional fields keep
older Store records readable without inventing their missing delivery history.

## Restart and retry

When an assignment is replaced, the Engine requeues its accepted but unread inputs ahead of newer waiting work, in original
input order. It excludes already consumed inputs, inputs attributed to an earlier assignment, historical reopen records and
legacy inputs without explicit unread evidence. The replacement launch removes a retained inbox copy before delivering its
replacement under the same stable input identity. Claiming an input and then losing the step before `user/message` does not
mark it consumed; a later successful step supplies the read acknowledgement.

A settled waiting/blocked/failed report does not prove every earlier accepted input was read. On interruption, the Engine
also recovers unread inputs for that existing assignment without starting a new one. Automated notes and non-human trigger
inputs remain held when `waitsForPerson` applies; the attention state, report and original mandate stay unchanged. Inputs
that were deliberately held before delivery have no accepted/unread acknowledgement and are not inferred to need replay.

`AgentDelivery.send` and `Sessions.prompt` now return a consumption boolean after persistence flush. A retry that finds its
message already in history sends no second copy and lets the executor repair a lost Store read acknowledgement. Pending
inbox presence alone returns false. Existing relay, assessment and background callers discard this result. Normal live
`user/message` handling records reads for every current input kind, and acknowledgements arriving before the delivery
callback are preserved by that callback.

## Held recovery and limits

[Consumed-input reconciliation](038-consumed-input-recovery.md) now repairs missing read markers for every current input
kind in the private held image and refuses any modern marker unsupported by authenticated worker history. It retains the
existing transactional rollback, inherited-prefix exclusion, producer attribution and ended-ticket protections. Historical
reopen records remain unchanged. The signed consumption-summary counters now include repaired non-trigger read markers;
the manifest format and authentication of older images remain compatible.

These changes preserve pending work with explicit delivery provenance. They do not infer whether an old non-trigger input
without delivery/read fields was queued, deliberately held, discarded or consumed. Reconciliation of that legacy ambiguity,
the broader assignment/thread/evaluation/effect graph, connector cursors, deployment binding and supported restored
activation remains open. No recovery hold is cleared, and no new authority is created. The complete architecture and product
requirements remain in the implementation ledger.

## Qualification

Domain tests cover all current input kinds, consumed and earlier-assignment exclusions, unknown legacy state, retries and
settled reports with held automation. Runtime tests exercise retained and cut-off note delivery, exactly one later
consumption, and lost Store acknowledgement repair without a second send. The shared runtime fixture now removes claimed
messages from its pending lists, matching Harness inbox semantics; it no longer retains consumed/claimed messages as if
they were pending. Recovery tests authenticate generic consumption and reject unsupported modern read claims.

Code `bc50b29cd3eccbf41c667e25d5cb62a3e75f9943` passed 1,665 local tests (seven skipped), typechecking and all
four builds. The focused domain/runtime/delivery/recovery/documentation run passed 224 tests. The same code passed
1,667 tests (five skipped), typechecking and all four builds with native Linux confinement in
[run 42575419242](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42575419242).

Both owned installed-Harness / DeepSeek Flash scenarios passed in 213.61 seconds. Managed recovery verified that the
actual workload recorded non-trigger reads in its original Store, checked consumption against authenticated worker history,
and retrieved the same held image on retry. The dedicated case retained its expected refusal for unrecorded publication
probes. External channel traffic stayed on fixture servers; the configured inference API was real. The original app process
remained running. These checks do not establish restored activation or complete the remaining architecture/product scope.
