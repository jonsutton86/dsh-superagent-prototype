# 084 Global emergency stop and operator audit

**Status:** implemented backend increment; no deployment, UI control or release qualification. It extends, and does not
replace, the existing processing pause and original-stop machinery.

## Distinction from the pause

Processing pause (`settings.paused`) holds evaluation, launches, delivery and schedules while leaving the coordinator
recoverable. The emergency stop is a **separate durable state** that additionally:

- halts every open assignment through the existing original-stop receipts, cancelling turns and stopping jobs;
- refuses new admissions (`Configure execution and resume the executor...`) at the existing workspace boundary;
- survives restart in the Store KV record (`runtime:emergency`), so no worker service needs to be loaded first;
- requires an explicit, reasoned release by a named actor.

Release **does not** clear an independent pause, and engaging does not set `settings.paused`. The two conditions are
composed in the Runtime's `paused()` predicate, so a paused coordinator stays paused after an emergency release.

## Persist-first ordering

Engagement writes the engaged record before any cancellation. A crash during the halt therefore restarts engaged, never
silently resumed. Halt failures do not unlatch: the state stays engaged and a failure fact is appended to the audit log.
A replayed engagement is idempotent — one operator decision produces one state revision and one audit entry.

## Operator audit

`audit_event` is additive beside the existing tables. Entries carry a monotonic sequence, actor, action, resource,
outcome, redacted detail, and a SHA-256 hash chained over the previous hash. `AuditLog.verify()` recomputes every link,
so an edited or truncated history is detectable. Secret-shaped keys (token, password, authorization, API key, credential,
cookie) are replaced before persistence, and depth/size are bounded.

Audit writes are best-effort with respect to the emergency state: an audit failure is not allowed to unlatch the stop or
block it, and the state record remains authoritative. That trade-off is deliberate and should be revisited when the
health board exposes audit-write failures.

## Management API

| Route | Purpose |
| --- | --- |
| `GET emergency` | current durable state (never secret) |
| `POST emergency` | `{ requestId, action: engage \| release, reason, actor }`; idempotent by state |

Both routes use the existing loopback/same-origin mutation authorization. They are not a multi-user authentication
system; role-based administration remains open.

## Qualification

`tests/emergency.spec.ts` covers: engagement halting a running worker; admission refusal while engaged; durable read
through a fresh service instance; idempotent replay; release waking new dispatch; independent pause preservation; audit
chain verification, redaction and tamper detection. Existing stop, pause, environment and runtime suites remain the
regression boundary and pass in the full check.

## Remaining gaps

- No dashboard control or confirmation dialog yet; the API is the only operator path.
- No role-based access control or per-connector permissions; loopback/same-origin remains the only management boundary.
- No audit export/retention policy and no audit-failure health state.
- Emergency halt follows the existing original-stop semantics; an unknown remote receipt still holds (by design) and is
  surfaced through the stop records.
