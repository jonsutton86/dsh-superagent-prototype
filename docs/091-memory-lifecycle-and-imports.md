# 091 Memory lifecycle and opt-in imports

**Status:** Phase 2 increment 4. Configurable retention, deterministic extractive consolidation, profile editing, and
consent-gated import of operator-provided exports/documents. **PDF extraction is not implemented in this increment** and
is not faked.

## Retention

`DSH_ORCHESTRATOR_MEMORY_RETENTION` is a JSON object:

```json
{ "conversation": 200 }
```

The value is validated (10–5000, default 200), read at Runtime construction, and applied to conversation capture:
after each captured turn, the oldest turns beyond the limit are hard-deleted with `memory_event` deletion facts.
Malformed configuration fails startup without echoing content. Other kinds currently have no automatic retention; their
deletion is explicit through the API.

## Consolidation (extractive, no model)

`POST /orchestrator/api/memory/consolidate` (`memory:write`) with `{ requestId, sessionId, maxChars? }` builds a
deterministic digest of that session's captured turns: the first sentence of each turn (up to 200 characters), bounded
by `maxChars` (200–4000, default 800), stored as a **private** `conversation` record with subject `digest:<sessionId>`
and source `system`.

It is explicitly labelled *extractive digest (no model synthesis)*. Raw turns remain searchable until retention removes
them, and the digest is **never** auto-injected into prompts (private sensitivity is excluded). Model-based
summarization belongs to Phase 3, where provider routing and budget enforcement exist.

## Profiles

- `GET /orchestrator/api/memory/profiles` (`memory:read`) returns the personal and business profile records (or null).
- `PUT /orchestrator/api/memory/profiles/:type` (`memory:write`, type personal/business) upserts the single profile for
  that scope: subject is fixed to the type, revision increments, provenance is operator, and `memory_event` records the
  update. Profiles cannot fork under a different subject.

## Imports (explicit consent)

`POST /orchestrator/api/memory/import` (`memory:write`) accepts operator-provided content only — no paths:

```json
{ "requestId": "import-1", "format": "chatgpt", "consent": true,
  "scope": { "type": "business" }, "title": "ChatGPT export", "sensitivity": "private" }
```

Supported formats:

| Format | Shape | Stored kind |
| --- | --- | --- |
| `markdown`, `text` | the document text itself | `document` |
| `chatgpt` | export array or `{conversations:[...]}`; `mapping.*.message` or `messages` array | `conversation` |
| `claude` | array or `{conversations:[...]}`; `chat_messages`/`messages` | `conversation` |
| `codex-jsonl` | one JSON object per line with role and content | `conversation` |

Properties:

- `consent: true` is required literally; otherwise the request is rejected (400).
- Each message/document is chunked at ≤8,000 characters on line boundaries; at most 200 items per import.
- Every record carries source `import`, a source reference (operator-provided or item title), tags `import` + format,
  and the requested sensitivity (default private).
- Identical content deduplicates through the existing content identity; the response reports `imported`/`skipped`.
- The audit fact `memory.import` records format, scope and counts only — never imported content.
- Imported records are ordinary scoped memory: searchable and subject to the same access/deletion rules. Imports are
  never auto-injected; private sensitivity keeps them out of automatic context.
- Malformed JSON/JSONL or an unsupported shape returns 400 with a format-specific message.

**PDF:** no PDF parser is bundled. PDFs are not accepted as a format and the API returns a schema error rather than
claiming success. A future increment may add a vetted local extractor with provenance and consent.

## Qualification

`tests/memory.spec.ts` covers retention parsing/clamping and capture pruning, digest content/provenance/private
exclusion, profile upsert via API, import parsing for all four formats, consent rejection, malformed input, dedup,
chunking, provenance/tags, scope isolation, audit without content, and continuation of existing memory tests.

## Remaining gaps

- No model-based summarization, semantic retrieval, dashboard memory UI, or import progress UI.
- No PDF extraction, OCR, or archive/zip handling of large exports.
- Retention applies only to conversation turns; other kinds have explicit-only deletion.
