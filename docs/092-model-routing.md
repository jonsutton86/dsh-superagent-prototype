# 092 Deterministic model-provider routing (Phase 3 groundwork)

**Status:** Phase 3 groundwork produced via GoalForge and reviewed/applied here. Pure local selection only: no provider
call, no network, no credential use, no capability verification. It does not complete multi-model orchestration.

## Contract

`src/security/model-routing.ts` exposes:

- `TaskKind` — `reasoning`, `coding`, `summarize`, `fast` (zod-validated);
- `routeCandidates(providers, task, { monthlyBudgetUsd? })` — every eligible provider/model in configured order, or a
  `RouteRefusal` (`invalid_task`, `no_providers`, `no_eligible_provider`);
- `routeProvider(...)` — the first candidate, kept for single-selection callers;
- `ProviderRegistry.route(...)` — the same ordered candidates through the existing read-only registry.

The operator API exposes the ordered list without calling anything:
`GET model-route?task=coding&monthlyBudgetUsd=5` (`runtime:read`, same-origin) returns either
`{ ok: true, task, candidates: [{ provider, model, monthlyBudgetUsd }], verified: false }` or the refusal with
`verified: false`. Provider credentials are not included in this view.

## Recorded-spend enforcement

`Usage.providerSpend(provider, from)` aggregates the existing `usage_call` facts for one provider since a boundary,
including reserved and unknown costs (micro-USD). The routing endpoint derives month-to-date spend and passes it to
`routeCandidates` as `spentUsd`:

- a provider whose recorded spend has reached its declared `monthlyBudgetUsd` is skipped;
- if a provider has unknown-cost calls, its spend is treated as exhausted (fail closed);
- providers without a declared budget are unaffected;
- this is still selection-only: nothing reserves budget or dispatches a model call. Actual reservation must go through
  `Usage.begin` before a future provider invocation.

Selection is deliberately conservative and deterministic:

- a provider with `models.length === 0` or `monthlyBudgetUsd === 0` is skipped (zero means no spend allowed);
- when a ceiling is supplied and the provider declares `monthlyBudgetUsd`, the provider budget must be `<=` the
  ceiling; providers without declared budget remain eligible and report `monthlyBudgetUsd: null`;
- invalid, negative, NaN or infinite ceilings are ignored;
- the first eligible provider in configured order wins; `model = defaultModel ?? models[0]`;
- the task label is recorded but does **not** change selection — there is no capability assumption;
- no exception is thrown for an invalid task; a refusal is returned.

## Why this shape

Provider configuration already requires operator-confirmed endpoints and model identifiers and always reports
`verified: false`. Routing therefore never asserts capability, quality or availability; it only applies explicit local
budget constraints and configuration order. Verification, fallback execution, cost accounting and capability-aware
routing remain Phase 3 work and require live credentials.

## Qualification

`tests/model-routing.spec.ts` (25 tests) covers invalid tasks, empty providers, zero-budget and ceiling skipping,
boundary inclusion, default-model preference, first-model fallback, ordered fallback candidates, deterministic order,
undeclared budgets, invalid ceilings and all task labels. `tests/credentials.spec.ts` also checks the operator route's
selection, refusal status codes and viewer read access. GoalForge returned the isolated changes with passing `tsc`, focused Vitest and
file-existence checks; the changes were reviewed and applied to the feature branch.

## Remaining work

- Capability/quality-aware routing after measured evaluation, not assumptions.
- Executing the ordered fallback chain, retries and unknown-outcome handling tied to the existing executor stop
  semantics; the current list is selection-only.
- Usage/budget enforcement wiring (the current routing only compares declared metadata).
- Codex delegation and worker specialization against verified interfaces.
