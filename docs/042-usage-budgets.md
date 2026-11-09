# 042 Managed model usage and budgets

The coordinator records model dispatch through Harness's public `llm/stream` middleware. It preserves Harness request,
provider and retry behavior and never rewrites frozen request options. Orchestrator and worker roots, including verified
descendants, share durable accounting in the existing SQLite Store. Worker ownership adds its mission, originating schedule
and explicit persona where available. Session ancestry is verified through active Sessions or the Session Controller and
cached as immutable root bindings. Cycles, missing ancestry and changed bindings fail before dispatch.

## Coverage and costs

Each admitted stream gets a unique call record before provider dispatch, with route, purpose, Session ownership,
configuration revision and reservation. Reported counters are accepted only from a completed stream. Missing, invalid,
overflowing or partial reports remain unknown. Process restart converts pending records to unknown while retaining their
reservations. Request contents, tool arguments, model text and credentials are not stored in this ledger.

Harness defines uncached input, cache read and cache write as disjoint counters. They are summed with output; reasoning
tokens are already included in output and are not added twice. An authoritative total larger than the classified sum is
preserved, with the unmatched amount priced at the largest configured token rate. Currency uses integer micro-USD with
BigInt arithmetic and upward rounding, avoiding floating-point accumulation. Prices are operator-configured USD per million
tokens for exact provider/model routes, with a source note and immutable configuration history. Every call captures its
original price; editing current prices never silently reprices history. There are no assumed/default provider prices.

Tracking starts when this ledger is first created. There is no historical backfill that could double count inherited Session
events. Unrelated root Sessions, rootless recovery probes, external account traffic and non-token provider fees are excluded.
This is managed coordinator usage, not an account-wide invoice. Unpriced calls remain visibly unpriced.

## Admission and uncertain outcomes

Limits can apply to the workspace, a mission, a schedule or a persona, with UTC day, UTC month or lifetime periods.
Every matching enabled limit is checked in the same Store transaction that persists admission. Call limits count each
admitted stream, including failed streams; refused attempts create no admitted call. Token reservations use the provider's
declared combined request/response context ceiling. Estimated spend reserves that ceiling at the largest configured rate.
Settled usage and unresolved reservations consume allowance together. Missing metadata, missing prices or prior calls with
unbounded liabilities prevent admission under the corresponding token/cost limit. Call-only limits still function without
metadata or prices. Period attribution follows the call's admission time, including calls settling in a later period.

These are conservative application reservations, not a guarantee on a provider invoice. The public stream hook does not
expose the exact prepared adapter generation's context metadata. Resolution observes current route metadata, which could
change between preparation and dispatch. Incorrect metadata, changing provider prices, non-token fees and provider-side
request retries can affect real charges. Call counts describe managed streams, not necessarily every HTTP wire attempt.
Exact prepared-generation metadata binding and broader provider accounting acceptance remain open requirements.

After a crash or incomplete report, no usage is inferred from text or an error message. An operator can record verified
provider counters, optional verified USD cost, and an evidence note. Calls without a captured price require an explicit
verified cost. Reconciliation preserves original reports and price snapshots, records the correction separately, and
releases the reservation only when the recorded result is complete. Pending or already reconciled calls cannot be rewritten.
Configuration and reconciliation commands retain request fingerprints; ambiguous-response retries reuse the original
request and revision. Stale edits and conflicting ID reuse are refused.

## Operator surface and API

The Usage tab shows tracking coverage, reported tokens, estimates, reservations, missing values and recent calls. It edits
limits and model prices and exposes evidenced reconciliation. Mission and schedule pages link directly to their usage and
limits. Call history links to execution and mission/persona scope. Controls use the existing bilingual panel, labeled form
fields, keyboard-capable buttons, alerts and bounded pagination. Limits take effect on the next stream admission; increasing
allowance does not automatically retry failed work. The operator retries from its mission or execution page.

Management routes inherit existing loopback, same-origin and coordinator ownership guards:

| Route | Purpose |
| --- | --- |
| `GET usage` | Scoped, paginated calls and period totals with current limits/configuration |
| `PUT usage` | Revision-bound price and limit configuration |
| `GET usage/versions/:version` | Historical configuration |
| `POST usage/calls/:id/reconcile` | Evidenced resolution of one uncertain or unpriced call |

## Qualification and remaining scope

Unit and rendered tests cover price arithmetic and snapshots, concurrent admission, overlapping scopes, unknown liabilities,
period rollover, SQLite reopen, immutable ancestry, real Harness middleware with a synthetic provider, incomplete streams,
shutdown, mission/schedule attribution, stale commands, lost responses and reconciliation through real API routes.
Installed-Harness qualification checks actual provider-reported scheduled usage, restart persistence and scoped refusal
before inference followed by an explicit retry after allowance changes. Qualification results are recorded after completion.

Provider invoice import, prepared-generation metadata, non-token charges, retention/index scaling, multi-workspace ownership,
speculative-work admission integration and broader providers remain open. This increment does not complete reflection,
recall budgets, host-verification evidence, managed endpoint launch, restored activation/failover, supervision UI, voice,
packaging or the rest of the full architecture/product ledgers. Browser layout/accessibility checks remain open while
browser use is disabled. See the earlier [Agentic OS architecture](010-agentic-os.md).
