# 105 Read-only calendar connector

**Status:** Local iCalendar ingestion only. No account, network fetch, OAuth, write or event-triggered mission is
implemented.

## Configuration

Set `DSH_ORCHESTRATOR_CALENDAR_ICS` to an absolute local `.ics` file path (for example an exported iCloud/Google
calendar) before starting DSH. The file is read per request; nothing is written or uploaded.

## API

`GET calendar?days=7&limit=20` (`runtime:read`, same-origin):

- `{ configured: false, generatedAt, items: [] }` when unset;
- `{ configured: true, generatedAt, items: [{ uid, summary, description?, start, end, allDay }] }` otherwise,
  showing events whose end is not before now and whose start is within the next 1–31 days, sorted by start;
- `409` when the configured file is missing, too large (>5 MB) or invalid.

Parsing handles folded lines, escaped text, UTC/date-only DTSTART, DTEND defaults, `STATUS:CANCELLED` and the event
window. Floating local times are treated as UTC; this is documented, not inferred per system zone.

## Limits

- Read-only display/API only: no calendar-triggered missions, reminders or writes.
- No remote feed URL or credential; secret-bearing feeds need a local export path or a separately reviewed connector.
- Email and MCP connectors remain unauthorized/unimplemented.
- Tests cover parser and API behavior with a temporary local file; no external calendar account was used.
