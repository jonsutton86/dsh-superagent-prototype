# 098 Operator briefings

**Status:** Phase 6 starts with a credential-free briefing read model. No calendar/email/MCP connector is connected yet;
nothing here calls an external service.

## Contract

`GET briefing` returns:

- `at` — generation time;
- `overview` — the same read-only overview the panel uses (problems, tickets awaiting a person, executor load, 24-hour
  flow, policy version);
- `upcoming` — the first five schedule summaries the schedule service reports (`id`, `title`, `nextAt`, `enabled`,
  `open`).

The composer (`src/app/views/briefing.ts`) adds no source, no scheduler, no persistence and no external request. A
schedule without a next run reports `nextAt: null`; it is not predicted.

## Tests

`tests/briefing.spec.ts` checks the HTTP response through the real Runtime host (a host with no schedules returns an
empty `upcoming`) and the pure mapping from schedule summaries.

## Limits

- The briefing is a snapshot, not a background job or delivery: it does not send email/Slack, write memory or admit work.
- Calendar, email and MCP connectors remain future Phase 6 increments and need operator credentials and explicit
  authorization.
- No briefing quality claim: it copies host-reported counts only.
