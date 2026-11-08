# Durable memory and artifacts

This increment implements the library portion of the [Agentic OS workspace](010-agentic-os.md), retaining DeepSeek Harness
for execution. The same service backs the management panel and Session tools; there is no separate UI-only artifact store.

## Storage and provenance

`workspace_library` contains immutable record metadata and mutable archival revision, `workspace_blob` stores SHA-256-addressed
bytes, `workspace_library_edge` stores typed provenance, and an FTS5 index supports text search. All live in the existing
orchestration SQLite database. Blobs, metadata, edges, search entries and request receipts commit in one transaction. Replay
after a lost response or reopened database returns the existing record; changed payloads under the same request ID fail.

Every record has a kind (`memory` or `artifact`), title, summary, scope, MIME type, filename, content hash/size, creation time,
optional normalized expiry, and host-assigned provenance. Worker provenance records the ticket, Session, assignment observed
at publication, and original trigger ID/hash. Trust is `agent_submission` or `operator_submission`. Both remain
`not_verified`: byte integrity is checked by the host, but factual correctness and task success require separate evidence.

Content is immutable. A revision is a new record linked with `supersedes`; the old content stays addressable. Other edge
types are `derived_from`, `supports`, `contradicts` and `references`. Links carry the target's immutable content hash.
The UI exposes these links, conflicts, expiry, supersession and stale direct sources. Archival changes visibility while
preserving history and bytes; it is not a deletion/retention implementation.

## Access boundary

The local operator may read all records and save in a workspace, mission or ticket scope. A worker's scope is derived from
its persisted ticket and originating mission; models cannot supply an actor or scope. A worker reads its mission (or its
own non-mission ticket) plus explicitly shared workspace records. The router reads only shared workspace records and has
no publication tool. Search, direct reads, outgoing references and inverse provenance links use the same scope boundary.

Workers publish only within their current active ticket/mission. A disabled source, ended ticket or obsolete mission run
cannot publish new records. A committed receipt remains replayable after completion. Supersession stays within one scope;
other provenance may point to that scope or shared workspace records. A shared record cannot reference a private source.
This prevents sharing a title, hash or provenance ID from widening access implicitly.

This is application-level tool authorization in a local single-owner deployment. It is **not** an OS sandbox against a
worker with unrestricted shell/filesystem access, nor multi-user authentication. Enrolled environments, capability isolation
and authenticated remote access remain requirements in the article tracker.

## Recall and capacity

Search uses quoted Unicode word tokens, at most 16 from a 256-character query. It returns up to 50 metadata records per page.
Active search omits archived, expired and superseded records by default. Explicit references still show their state.
Reads return up to 8,000 text characters (4,000 by default), a next offset, and up to 50 inverse provenance links. Tools
describe a five-page/two-hop recall guideline; total per-question time/token/graph budgets are not yet enforced by a host
recall planner. Direct-source freshness does not implement arbitrary transitive conflict resolution.

Memory is UTF-8 text/Markdown up to 64 KiB. Artifact ingestion accepts UTF-8 or canonical base64 up to 512 KiB. The library
currently caps stored distinct bytes at 512 MiB and records at 50,000. Only the first 65,536 text characters enter full-text
indexing; binary artifacts are searchable by title/summary. Reads verify stored bytes against SHA-256. Limits are explicit
refusals, never silent content truncation during ingestion.

Content is submitted through a worker tool or operator form/file picker. No arbitrary host paths are read on behalf of
remote workers. Large files, streaming/chunked ingestion, matched-environment file imports, directory synchronization,
document text extraction, lifecycle retention and embeddings remain later integrations.

## Product and API

The **Memory & artifacts** tab supports search, type filters, inactive history, text creation, file upload, revisions,
archive/restore, preview/download and provenance navigation. Missions link to their own library scope. Records link back to
their execution and Harness Session. HTML previews remove executable/navigation markup and use a script-free sandbox with
a restrictive content security policy; plain text renders literally. Images render from object URLs. PDF/unknown formats
are downloadable. Downloads preserve original bytes and are separate from the inert preview.

| API relative to `/orchestrator/api/` | Purpose |
| --- | --- |
| `GET library?q=&scope=&kind=&offset=0&limit=20&includeInactive=false` | Scoped, paginated full-text search |
| `POST library` | Idempotent record publication; operator chooses scope |
| `GET library/:id?offset=0&limit=4000` | Metadata, bounded text and provenance |
| `GET library/:id/content` | Integrity-checked original bytes as bounded base64 JSON |
| `PUT library/:id` | Idempotent archive/restore against current revision |

Routes inherit the existing loopback host, origin and request-header guard. Publication request bodies have a 1 MiB limit.
Harness tools are `workspace_search`, `workspace_read` and worker-only `workspace_publish`. Returned content is explicitly
context, not instructions or authorization; model outputs do not become policy or execute through library reads.

Mission acceptance now includes the publication set and archival/expiry revisions, plus direct provenance neighbors, in
its execution snapshot. Archiving evidence, replacing it, or introducing a contradiction invalidates a prior review. This
does not implement command-exit evidence, exact Git-tree verification, external delivery receipts or automatic success.

## Verification and remaining work

2026-11-08: `pnpm check` passed TypeScript, 66 test files / 1,249 tests, and all server/client builds on Node 25.9.0.
Sixteen new service/DOM tests cover this increment. Library tool definitions have independent model-context size ceilings;
the original orchestration prompt/tool budget remains unchanged.

Service and Runtime tests cover SQLite reopening, replay, transactional rollback, deduplicated blobs, integrity failures,
bounded reads, expiry, scope denial, inverse-link privacy, host-minted provenance, source disablement, immutable revisions,
stale mission review and actual management routes. DOM tests exercise authoring/revision/archive and a worker-produced HTML
artifact through those routes, including preview isolation and download URL cleanup.

Tests use the existing simulated Harness provider; no live-model or real-browser acceptance is claimed. The whole product
still requires the local execution setup, integrated conversations, personas, schedules/reflection, budgets, remote
execution, host-collected verification, backup/restore drills and deployment qualification described in the trackers.
