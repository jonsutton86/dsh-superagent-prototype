# 088 Persistent memory foundation

**Status:** Phase 2 increment 1. Typed, scoped, persistent memory with full-text search, provenance, dedup/upsert and hard
deletion. It extends the existing SQLite Store; it does not add a second database or replace the Library.

## Model

A memory record has:

- `kind`: `fact`, `preference`, `goal`, `decision`, `conversation`, `project` or `profile`;
- `scope`: `personal`, `business`, or `project:<name>`;
- `subject`: a stable display/upsert key (profile name, goal name, project), optional;
- `content`, optional `summary`, tags and a sensitivity marker;
- provenance: source (`operator`, `agent`, `conversation`, `import`, `system`), time, actor and optional reference;
- `revision`, timestamps and a content hash.

Records live in `memory_record`; an append-only `memory_event` table records `created`, `updated` and `deleted` facts, and
`memory_fts` (FTS5) indexes content, subject/summary and tags. Tables are created additively beside the existing Store
tables, so opening an existing database requires no data-shape migration.

## Behaviour

- **Scopes:** reads and writes require a `MemoryAccess` grant. Exact scope keys, `project:*` and `*` are supported;
  deny-by-default. A read for an ungranted scope returns nothing rather than revealing existence.
- **Dedup:** an identical `(scope, kind, subject, normalized content)` returns the existing record (`created: false`).
- **Upsert:** for `profile`, `goal`, `preference`, `decision` and `project` with a subject, a changed value updates the
  same record, increments `revision`, replaces the FTS row and appends an `updated` event.
- **Search:** FTS5 with every query token quoted (operators cannot restructure the query); scope and kind filters;
  newest-first ordering and cursor pagination. A LIKE fallback covers FTS syntax edge cases.
- **Deletion is real:** the record and FTS row are removed; the append-only deletion event retains only identity/kind/
  scope metadata, not content. No soft-delete resurrection path is provided.
- **Provenance:** the latest source is on the record and every mutation remains in `memory_event`; audit logging records
  create/update/delete by identity, kind and scope — never content.

## Management API

| Route | Capability | Behavior |
| --- | --- | --- |
| `GET /orchestrator/api/memory/search` | `memory:read` | `q`, `scope`, `kinds`, `limit`, `cursor`; always scope-filtered |
| `POST /orchestrator/api/memory` | `memory:write` | typed record; returns `{record, created}` |
| `GET /orchestrator/api/memory/:id` | `memory:read` | record + provenance events |
| `DELETE /orchestrator/api/memory/:id` | `memory:write` | hard deletion; returns `{deleted}` |

`owner` has all capabilities; `operator` has memory read/write; `viewer` has read only. The existing bearer-token,
loopback/same-origin and audit rules apply. HTTP callers currently use owner-level access; per-agent grants are passed
explicitly to the service and will be bound to tickets/sessions when retrieval is wired into execution.

## Qualification

`tests/memory.spec.ts` covers persistence across a Store restart, full-text search, tag search, scope isolation and
write refusal, identical dedup, subject upsert with revision/events, kind filters, hard deletion removing the search
row, deletion-event retention, API create/search/detail/delete, audit without content, and viewer write denial.

## Remaining Phase 2 work

- Automatic retrieval during conversations and controlled cross-agent sharing bound to ticket/session grants.
- Short-term conversation capture and conversation summarization/consolidation policies.
- Personal/business profile surfaces and editing UI.
- Opt-in imports (ChatGPT/Claude exports, Codex sessions, Markdown, PDF) with provenance and dedup.
- Semantic retrieval only after a measured baseline justifies it.
- Retention policies, export and deletion confirmation UI, and dashboard memory views.
