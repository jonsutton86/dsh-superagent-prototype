# 041 Persistent mission schedules

Schedules turn an operator-approved mission definition into recurring work through the existing Workspace, Engine,
Harness Sessions and durable effect queue. They do not introduce a second agent runner. A schedule captures the complete
plan, including human actions, dependencies, persona versions and execution-world selections. Each occurrence creates a
new mission with fresh action IDs and a recorded schedule/version/due-time origin. Editing the source mission later does
not change that captured authorization.

## Timing and missed runs

Supported cadences are an exact one-off timestamp, an elapsed interval anchored to an exact start, and selected weekdays
at a local time in a named timezone. Selecting all seven days gives daily execution. Calendar calculations use the pinned
`@js-temporal/polyfill` dependency. The explicit `compatible` disambiguation shifts a nonexistent clock time forward by
the gap and chooses the earlier repeated time. A repeated local clock hour therefore does not create a second occurrence.
These semantics follow [Temporal's timezone documentation](https://tc39.es/proposal-temporal/docs/timezone.html).
The host's timezone database supplies timezone rules; future government rule changes can change future calculated instants.
Already reserved due instants and identities are preserved.

The operator chooses `skip`, `latest` or `all` after a missed interval. `skip` admits the most recent occurrence only
within the configured grace window. `latest` coalesces missed work into the most recent occurrence. Both record the skipped
range and calculate its end directly, without walking an unbounded outage. `all` advances one due occurrence per selected
schedule per pass, preserving order under the configured run/open-mission limits. Clock rollback cannot repeat an already
advanced occurrence. Disabled schedules and global execution pause retain their cursor until execution resumes.

## Transactions, authorization and limits

Definitions and pause/resume commands have optimistic revisions and durable request fingerprints. Repeating a successful
request returns current state; changing its payload under that ID is refused. Every definition revision is preserved.
Editing timing or a plan authorizes future occurrences from the later of now and the existing cursor. Pause/resume retains
missed work instead. Existing occurrences continue from their original captured plan.

An occurrence reservation, its stable identity, run counter and next-time cursor commit atomically. Dispatch creates its
mission and Engine work inside nested Store transactions, with effects released only after the outer commit. A failure
rolls back uncommitted missions, tickets and effects, and records a blocked reservation. An explicit retry resumes that
same reservation without charging a second run. Restart resumes active reservations, including a crash before mission
creation. Scheduled triggers carry standing-authorization provenance and `human: false`; the Workspace validates their
recorded origin before granting explicit admission. They are not fabricated new human messages.

Lifetime run limits survive restarts and edits. A run is charged when reserved, including a blocked reservation. The
maximum-open-missions limit includes work waiting for a person or review. An archived mission or fully reviewed result
releases its slot. Each Runtime pass visits at most eight due schedules and eight active occurrences, dispatching at most
four eligible actions per occurrence. Checked-time ordering rotates the working set. Engine worker concurrency and
execution-world admission remain authoritative. These are work-count limits; provider token/cost accounting remains a
separate open requirement.

Only untouched, unstarted agent actions whose dependencies are reviewed can start automatically. Human actions remain
human. Stopped, failed, outdated or already-started work is never automatically retried, and results are never automatically
accepted. Editing an occurrence's mission plan blocks further automatic dispatch for that occurrence. Pausing a schedule
prevents additional automatic dispatch; already-started tickets remain controllable from the mission and execution pages.
Restored checkpoint images remain held under the existing recovery controls; adding schedules does not activate a restore.

## Operator surface

Open a mission and choose **Schedule this plan** to inspect its captured plan and choose cadence, timezone, weekdays,
missed-run behavior, total runs and open-mission limit. Automatic execution requires the form's explicit enable choice.
The Schedules tab shows limits and due times; details expose pause/resume, timing/limit edits, occurrence history, blocked
dispatch retry and mission links. Original submitted revisions and request IDs survive ambiguous HTTP responses. The form
and controls use the existing bilingual panel, labels, keyboard-capable controls, alerts and pagination.

Management routes under `/orchestrator/api/` inherit the existing loopback, same-origin and ownership checks:

| Route | Purpose |
| --- | --- |
| `GET/POST schedules` | Paginated summaries or create a complete plan snapshot |
| `GET/PUT schedules/:id` | Paginated occurrence history or replace future configuration |
| `GET schedules/:id/versions/:version` | Original authorization snapshot |
| `POST schedules/:id/enabled` | Revision-bound pause/resume |
| `POST schedules/:id/occurrences/:occurrence/retry` | Resume one blocked reservation under its original definition |

## Qualification and remaining scope

Deterministic tests cover calendar DST transitions, fractional offsets, long outages, all missed-run policies, SQLite
reopen, deduplication, standing authorization, limits, changed plans, stopped work, reviewed dependencies and rollback after
partial dispatch. Runtime/API and rendered-form tests cover global pause, lost HTTP responses, enable/disable and occurrence
navigation. Installed-Harness qualification also exercises an actual scheduled worker, independent file/artifact checks,
and real restarts before enabling and after completion. Results are recorded after these checks finish.

Overnight reflection can use a scheduled mission, but automatic context selection and durable reflection proposals are
not yet implemented. Provider spend budgets, retention, multi-workspace ownership, cross-host restored activation,
supervision UI, voice, packaging and the remaining full architecture/product requirements stay open. Browser layout and
accessibility qualification also remain open while browser use is disabled.
