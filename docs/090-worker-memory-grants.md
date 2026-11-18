# 090 Worker memory grants

**Status:** Phase 2 increment 3. Explicit, operator-controlled memory sharing with a worker ticket. Workers remain
deny-by-default: no grants means no memory tools and no automatic memory.

## Grants

`memory_grant` stores `(ticket, scope)` rows. An operator replaces a ticket's grants through:

`PUT /orchestrator/api/tickets/:id/memory-grants` — body `{ requestId, scopes: ["business", "project:alpha"] }`,
capability `memory:write`; returns the normalized scopes. `GET` on the same path (`memory:read`) returns them.
Every scope is parsed and validated; malformed values fail with 400. Replacement revokes scopes omitted from the new
set, and the change is audited (`memory.grant`) without content.

Grants persist across restarts and are independent of the worker's own writes. The service refuses a grant the caller's
own `MemoryAccess` does not allow, so an operator cannot grant a scope they cannot read.

## Worker tools

A worker Session receives `memory_search` and `memory_write` **only** when its ticket has at least one grant. Both tools
are built from `MemoryAccess(grants)`:

- `memory_search({ query?, kinds?, limit })` searches only granted scopes and returns bounded records (identity, kind,
  scope, subject, content/summary, tags, update time). Tool output is labeled untrusted context.
- `memory_write({ kind, scope, subject?, content, summary?, tags?, sensitivity? })` writes only inside a granted scope,
  records source `agent` with the ticket ID as reference, and refuses any other scope.

No tool lists grants, revokes them, or reaches the owner's full-scope access. A worker cannot widen its own grants.

## Isolation properties

- No grants → `memoryTools` returns an empty list; the model cannot discover or call memory tools.
- Search enforces scope through SQL filters; a granted personal scope does not reveal business or project records.
- Writes outside grants throw `MemoryError(403)` and are audited as memory mutations.
- Automatic prompt memory remains main-Session only; granting a worker scopes does not inject memory into its prompt.
- Memory content is data: prompt text and tool descriptions explicitly deny it authority.

## Qualification

`tests/memory.spec.ts` covers: no tools without grants; tool registration with grants; scoped search excluding other
scopes; worker write provenance and refusal outside grants; grant validation/authorization; grant persistence and
revocation across a Store restart; management API read/replace with 404/400 handling and audit; viewer write denial.

## Remaining gaps

- No dashboard control or CLI for grants; the API is the only operator path.
- Grants are not automatically revoked when a ticket ends; operators should revoke explicitly (a retention policy is
  still open).
- No per-agent prompt summary of granted memory and no automatic recall for workers; retrieval is tool-driven.
- Summarization/consolidation and import ingestion remain future Phase 2 work.
