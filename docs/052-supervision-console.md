# 052 Independent supervision console

The watchdog now serves its own operator console at `/watchdog` on its existing loopback port. It does not depend on the
main Runtime, the main panel, a CDN or another web framework. Its browser bundle contains React and is shipped with the
existing Harness package. The main process and watchdog still use independent profiles, Sessions, locks and SQLite stores.

## Operator workflow

The console shows main-service reachability, observation age, setup/pause state, component health, assessment failures and
open/unacknowledged counts. Overdue observations are distinct from a current healthy response. Operators can filter open,
unacknowledged, closed or all retained incidents; inspect scope, worker reports, model evidence and progress-request
receipts; review paginated audit history; and acknowledge the specific evidence with an optional note. Text is rendered
as text, including task content and raw receipt details. The console links to the configured main application origin.
Tasks waiting for a human answer are included as operator-attention incidents with their bounded question. They are never
eligible for an automated status nudge. The first complete live flow exposed their omission from the older watchdog filter;
the regression covers visibility, refusal to nudge and closure when a human reply returns work to active execution.

Acknowledgement means an operator reviewed evidence. It never closes an incident, suppresses the monitor, changes a mandate,
retries a task or restarts a process. New observations, assessment findings, intervention outcomes and exhausted assessment
delivery budgets change the operator evidence revision and make old acknowledgements visibly stale. Existing model assessment
revisions and the main service's independent intervention fences are unchanged. The watchdog model retains exactly its three
existing observation/assessment/status-request tools; it receives no acknowledgement or retention capability.

Operator commands use strict schemas, a host-minted `local-operator` actor, an exact evidence revision and a timestamped
request ID. Receipt lookup precedes current-evidence checks, so a lost response can recover its original result even after
new evidence or resolution. Reusing a request ID with different content fails. New requests more than 24 hours old or more
than one minute in the future fail. A receipt is eligible for cleanup only after its request has expired; a removed receipt
can therefore never turn an old request into a new acknowledgement. No model text creates this authority.
The persisted cleanup time also forms an expiry floor, so moving the host clock backwards cannot revive a pruned request.

The browser stores the original command in session storage before sending. Unconfirmed responses retain its exact request
ID, revision and note through refresh/remount, and expose an explicit retry. The browser never automatically resubmits a
pending command. A storage failure prevents the initial send. A definitive validation/conflict response clears that pending
command and asks the operator to review current evidence.

## Transport, history and retention

The page/assets require the configured literal loopback Host and same-origin navigation. JSON reads and mutations also
require the existing management header; cross-site requests, cross-origin requests, duplicate query keys, unknown fields
and overlarge request bodies are refused. There is no CORS opening. Responses disable caching and MIME sniffing. A content
security policy limits scripts/connections to this origin, disables embedding/base URLs and external form submission.
This remains a trusted single-OS-user local management surface, not multi-user authentication or malicious-plugin isolation.

`GET /watchdog/api/status` retains its original bounded response and adds counts, poll interval, server time and retention
metadata. `GET /watchdog/api/incidents?state=…` returns at most 50 incidents per operator page; the detail endpoint is
`GET /watchdog/api/incidents/<id>`. Incident cursor pages bind the journal revision and fail after a concurrent change.
`GET /watchdog/api/history?incident=…` pins an audit high-water mark, so newer events do not disturb older pages. Cleanup
invalidates old history cursors explicitly. `POST /watchdog/api/acknowledgements` performs the bounded review command.

Journal schema two preserves schema-one data and introduces monotonic audit sequence/revision metadata and acknowledgement
receipts. It updates incident rows without changing their insertion positions. The list contains each task/assignment's
latest episode; earlier observations and reopenings remain in retained audit history. This is bounded history, not an archive.

Default retention keeps closed incidents for 30 days/up to 5,000 records and audit entries for 90 days/up to 50,000 records.
Configured bounds apply by age or count. Active incidents are never removed. Each sweep removes at most 1,000 closed
incidents, 1,000 audit entries and 1,000 expired receipts; sweeps run no more than once per minute after a monitor poll,
including failed observations. A large backlog can take multiple sweeps to reach configured limits. Closed records are
selected by closure time. The audit sequence never reuses deleted IDs. SQLite reuses freed pages; this does not promise
immediate filesystem shrinkage. Retained history is visible in the console and defaults are in the example profile.

## Qualification and remaining scope

Focused journal, real HTTP, Cordis lifecycle and rendered DOM tests pass, including schema-one migration, stale review,
original-receipt retry after new evidence/restart, changed-page refusal, retention limits and untrusted text escaping.
The installed-Harness qualification uses a real configured-model worker and independent model assessor, abruptly stops only
its disposable main/watchdog processes, waits for their original locks to expire, and checks offline visibility, durable
review receipts, re-observation and eventual closure. Final local, native Linux and live results will be recorded after execution.

External alert routing, broader diagnosis quality, productive long-running-job evaluation, incident-driven recovery policy,
cross-host transport/failover, browser/desktop visual acceptance and the remaining full Agentic OS architecture stay open.
The original app is not part of the disposable process-failure drill.
