# 093 JARVIS dashboard

The JARVIS tab is a read-only dashboard over the management views that already exist. It adds no backend route, no
mutation and no new source of truth: every number it shows is taken from an existing `GET` response, and a section
whose endpoint refuses says so instead of showing an estimate. It never claims that a provider, credential, endpoint
or value was verified.

The page lives in `src/client/jarvis.tsx`; `src/client/route.ts` carries the `jarvis` tab and route, and
`src/client/app.tsx` renders the page. It uses only the panel's existing controls, sections and styles.

## Sections and their reads

| Section | Read | Shows |
| --- | --- | --- |
| Overview | `GET overview`, plus the ordinary `GET state` poll for the pause flag | The host's own counts: pending Tickets, system problems, Executor load and the 24-hour flow |
| Memory | `GET memory/search` with `limit=5` | The first five records the search endpoint returns: kind, scope, update time and any summary |
| Agents | `GET state` | Executor load (`running`, `queued`, `maxWorkers`), the main Session id and whether processing is paused |
| Goals | `GET missions` | Mission title, status, completed/total actions, review flag and update time from the first page |
| Connections | `GET providers`, `GET credentials` | Provider id, base URL, models and credential presence; credential names and metadata only, never values |
| Analytics | `GET usage` with `scope=workspace` | Recorded workspace totals, reservations, unknown usage, pending calls, limit count and tracking start |
| Voice | `GET voice` | Configured input/output modes and the configured limits; no live speech check |

Each section is wrapped in a `data-jarvis="<name>"` area so its own availability can be read on its own.

## Read-only guarantees

- Only `GET` requests are issued; the page has no form, button or action that changes state.
- An empty list is named as empty; an area whose endpoint answers with a refusal or is unreachable renders
  `jarvis.unavailable` with the endpoint's own message.
- Counts and totals are the values the host returned. The page does not add, infer or cache numbers of its own beyond
  the panel's ordinary poll, and it does not display a total when the underlying response is missing.
- The Connections section repeats the providers view's `verified: false` as an explicit "not verified" statement.
  Analytics names costs as estimates that are not reconciled against provider invoices, and Voice names its limits as
  configuration rather than a completed check. The page never presents any of them as verification.

## Tests

`tests/jarvis-ui.spec.tsx` mounts the whole panel on the JARVIS route against the shared fake management API in
`tests/fixtures/panel-server.ts`:

- the seven section titles and their `data-jarvis` areas, in order;
- the overview counts and agent load exactly as the fixture host reports them;
- the explicit empty states for memory, goals, providers and credentials;
- populated records for memory, goals, connections and analytics, with only credential names and metadata rendered;
- the unavailable state for the analytics endpoint that the fixture refuses, and for every section while the host
  is not answering, with no partial-looking numbers;
- only `GET` requests, and the "not verified"/configuration-only wording.

## Limits

The page is a summary, not a replacement for the detailed pages. Memory and goals show only their first page,
Analytics shows only workspace scope, and there is no chart, history or drill-down. Selecting the ordinary tabs remains
the way to act on what the dashboard reports. See [007 Architecture](007-architecture.md) for the module and test
tables and [005 The panel](005-panel.md) for the panel's conventions.
