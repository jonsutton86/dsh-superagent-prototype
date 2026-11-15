# 094 Ordered fallback execution

**Status:** Phase 3 groundwork. Pure orchestration over an injected transport: no real provider client, endpoint,
credential or network call is implemented here. It executes the ordered candidates produced by
`src/security/model-routing.ts` and settles caller-provided reservations, so a future provider adapter can be added
without changing fallback semantics.

## Contract

`src/security/provider-execution.ts` exports:

- `executeRoute(candidates, { task, input }, transport, { signal?, reserve?, onAttempt? })`;
- `ExecutionTransport.execute(candidate, request, signal)` — injected by the caller and responsible for any real
  provider protocol;
- `ExecutionReservation.settle(outcome, reported?)` — supplied by `reserve`, typically wrapping `Usage.begin`;
- `ExecutionOutcome` — `{ ok: true, candidate, result, attempts }` or
  `{ ok: false, detail: 'no_candidates' | 'aborted' | 'exhausted', attempts }`.

Behavior:

- candidates are attempted in configured order; the first success returns and later candidates are not called;
- a failed attempt settles its reservation with `failed` and continues; no candidate is retried;
- an abort before an attempt returns `aborted` with no attempt; an abort during an attempt settles `failed` and returns
  `aborted`;
- reservations are settled exactly once for every attempted candidate, success or failure;
- transport errors are returned in `attempts` rather than thrown.

## Integration boundary

The runtime does not yet wire a transport. When a provider client exists, the caller must:

1. resolve routing with recorded-spend filtering (`GET model-route` / `ProviderRegistry.route`);
2. reserve spend through `Usage.begin` before each attempt;
3. pass a transport that performs the provider request with the existing stop/abort signal;
4. settle reported tokens into usage; uncertain outcomes remain held by the existing accounting rules.

No capability, quality, availability or budget claim is made by this module. It is selection and settlement plumbing
only.

## Qualification

`tests/provider-execution.spec.ts` covers first-success, ordered fallback, exhausted, no-candidates, pre-abort,
mid-attempt abort and per-attempt callbacks.
