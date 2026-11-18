# 077 Independent operator alert routing

This increment implements the next open item in the article tracker's supervision work: opt-in outbound alerts from the
independent Harness watchdog. It extends [052's console](052-supervision-console.md), retaining the separate profile,
restricted assessor Session, process lock and watchdog SQLite database. It does not grant the model new tools, retry
tasks, restart workers, change permissions or turn receiver acceptance into incident acknowledgement.

## Evidence and scope

The implementation tracker explicitly left external alert routing open. Source investigation confirmed that the existing
monitor's `Assessor.send` and journal delivery reservations enqueue model assessments, not operator notifications. The
selected REA baseline covers `plugin.ts`, `monitor.ts`, `journal.ts` and `http.ts`; the independent source and executable
checks are recorded in the [evidence receipt](evidence/077-supervision-alerts.json). Codegraph supplies structural context and pinned Fabric `review_design`/`review_code`
patterns use the repository's evidence wrapper. Neither a static relationship nor a model assessment proves delivery.

The versioned receipt-aware webhook contract below is a proposed interface implemented by this increment; it is not a
claim that Slack, email, Discord or any other service already implements it. A host-controlled receiver must implement
this contract and its own durable downstream delivery. No live destination is configured by this change. Live operator
destination acceptance, diagnosis quality and the other architecture requirements remain open.

## Configuration and disclosure

`dsh-superagent-watchdog.config.alertRoutes` defaults to `[]`. An operator may configure up to 16 routes in the watchdog
host profile. Each route has an immutable ID, display name, fixed URL, absolute owner-only bearer-token file and cooldown.
The minimum cooldown is one second, maximum one day, and default five minutes. HTTPS is required except literal
loopback HTTP for local receivers. URL credentials, query strings, fragments and redirects are refused. Credentials are
read immediately before I/O from a regular owner-only file and never stored in receipts or model context.

```yaml
alertRoutes:
  - id: operations
    name: Operations receiver
    url: https://receiver.example/agentic-alerts
    tokenFile: /absolute/private/operations-alert.token
    cooldownMs: 300000
```

Configuring a route authorizes sending bounded incident titles, finding, evidence, subject identity and timestamps to
that receiver. Treat these fields as potentially private task data. Service-failure alerts use fixed explanatory text,
not exception bodies. Destination URLs and credential paths stay out of the operator API, audit receipts and model tools.
Route IDs/names and destination hashes are visible for review. The optional routes do not change any model selection.

## Receiver protocol

The watchdog persists an original UUID, immutable payload, its SHA-256 digest and the destination hash before dispatch.
It sends one authenticated `POST` to the configured URL with `Idempotency-Key` equal to that original UUID:

```json
{
  "version": 1,
  "id": "original-alert-uuid",
  "payloadHash": "sha256-of-serialized-payload",
  "payload": {
    "subjectId": "incident:original-incident-id",
    "incidentId": "original-incident-id",
    "evidenceRevision": "immutable-alert-evidence-digest",
    "title": "Bounded incident title",
    "finding": "blocked",
    "evidence": "Bounded untrusted observation",
    "observedAt": 1794334304000,
    "trust": "untrusted-observation"
  }
}
```

`payloadHash` hashes the UTF-8 `JSON.stringify(payload)` bytes sent by the watchdog, including property order. The receiver
must bind the ID to that payload hash durably and refuse any conflicting reuse. A matching successful HTTP response must
contain exactly `{version:1,id,payloadHash,status}` where status is `accepted`, `rejected` or `pending`. The first two are
terminal receiver outcomes. `pending` remains unknown. A generic HTTP 2xx without the matching receipt proves nothing.
An accepted receipt means that this receiver accepted responsibility; it does not prove downstream delivery or human review.

Observation performs an authenticated `GET` to the same URL with `?alertId=<original UUID>`. It requires the same matching
receipt and never issues another POST. Missing, malformed, oversized, mismatched, failed or pending responses retain an
unknown outcome. The response is limited to 8 KiB and each I/O has a five-second timeout. The receiver must retain original
receipts long enough for recovery; a missing receipt is never permission to replay. Alert I/O has a separate bounded
in-flight poll, so a slow receiver cannot delay main-service observations or assessor deadline cancellation. Shutdown
aborts and drains outstanding alert requests before closing the journal.

## Persistence and recovery

Alert intents, source deduplication state and receipts share the watchdog database. Schema three preserves the earlier
incident/audit/review records. Older watchdog binaries refuse schema three; retain an offline backup of the original
watchdog state before upgrade if rollback is required. There is no second independent alert store. The dispatch transition commits before network
I/O; a crash with `sending` becomes `unknown` on reopen. Only an unchanged `prepared` record may dispatch. Unknown
records cannot be cancelled or resent and block another alert for that subject/route until their original outcome settles.

Host policy selects human-attention incidents, non-progressing assessments, exhausted assessment attempts, main-service
outages and assessment-service errors. Evidence changes can produce another alert only after cooldown and after any
unsettled original alert is resolved. Acknowledgement, closure, changed evidence or changed configuration cancels an
undispatched stale intent. Cancellation keeps its original reservation so the next poll does not recreate it.

No credential or token-file error crosses the dispatch boundary. These records remain prepared with a visible reason and
require explicit retry after the operator fixes configuration. Destination replacement cannot retarget an existing alert:
observation and dispatch require its original destination hash. Rotating the token contents at the same protected path
does not retarget the destination. Renaming a route or changing its URL/path requires reviewing the original receipts first.

Receipts have a 1,000-record admission limit; active/unknown outcomes are never pruned to admit new work. Terminal receipts
are retained for 30 days and cleanup is bounded. Capacity exhaustion remains visible and does not discard uncertain effects.
Source identities and deduplication reservations each have a separate 1,000-record limit, exposed alongside receipt usage
in the console. Disabled routing creates no new metadata. Active deduplication floors survive terminal receipt expiry and
route disable/re-enable, preventing retention from turning an unchanged incident into another send. An inactive source
can be pruned only after 30 days without an associated receipt; each cleanup removes at most 100 rows per category.

## Operator controls

The watchdog console lists configured destination names, retained capacity, immutable alert/evidence identities and phases.
It offers **Check receipt** for unknown outcomes, and **Retry unsent alert**/**Cancel unsent alert** only before dispatch.
All commands address the original durable alert ID. A lost browser response is followed by reading that same receipt;
there is no automatically generated replacement operation or resend after remount. Errors stay visible and stale actions
are revalidated by the host. All observed labels are rendered as text.

The existing literal loopback Host, same-origin and management-header checks protect these endpoints:

| Path under `/watchdog/api/` | Operation |
| --- | --- |
| `GET alerts?cursor=…` | Bounded receipt page, destination names and capacity |
| `GET alerts/:id` | Original receipt |
| `POST alerts/:id/observe` | Receiver GET only; empty JSON object required |
| `POST alerts/:id/retry` | Dispatch only a still-prepared original intent |
| `POST alerts/:id/cancel` | Cancel only before dispatch |

## Qualification status

Typecheck, all seven builds and 70 focused tests across nine files passed during integration. The source subsequently
adds an explicit schema-two migration case and improves human-readable outcome labels; the full qualification must cover
that final committed revision. The independent review identified and corrected unbounded disabled-route metadata and
misleading HTTP-500 refusal wording. The actual served console was exercised in Chrome with a synthetic authenticated
loopback receiver: its lost POST response appeared as unknown, and **Check receipt** recovered acceptance using exactly
one GET for the same ID, with no second POST. Direct cross-site navigation remained blocked; a local test entry page
provided same-origin navigation without changing the production management guard. Disposable fixtures were stopped.

No live operator destination was enabled and the existing app was not started or restarted. Live destination acceptance,
broader diagnosis quality and productive long-running-job evaluations, incident recovery policies, clean-host failover and
the remaining tracker items stay open. The project's deployment and completion gates remain with the owner.

Final runtime/test revision **`8b1c2ca72e11335460e85bfbee74d8466b527fef`** passed typechecking and all seven builds on both
macOS ARM64 and native Ubuntu 22.04 x64. macOS passed 2,167 tests (25 skipped; 239.94 seconds), and
[hosted Linux CI](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42876345111) passed 2,180 (14 skipped;
238.62 seconds). Installed publisher and Abliteration adapter boundary tests executed on both platforms. Native macOS
service/SSH checks passed 16 tests with one platform skip; Linux native/installed/delegated service and SSH checks passed
30 tests. The [qualification receipt](evidence/077-qualification.json) records versions, flags, exact source/archive identity,
log hashes and remaining boundaries. All provider qualification traffic in this pass used local synthetic receivers.
