# 013 Inbox and conversations

The Inbox brings managed agent conversations, pending questions, unread updates and results awaiting review into the
workspace. It builds on [010 Agentic OS](010-agentic-os.md), [011 Library](011-library.md) and
[012 Local execution](012-local-execution.md), retaining DeepSeek Harness as the conversation and execution runtime.

## Operator workflow

Start a task by describing the result you need. One transaction creates its mission, agent action, Engine ticket and
dispatch effects. The mission remains available for dependencies, acceptance and later planning. If execution is paused
or authorization fails, no partial mission or dispatch survives. Repeating a request after a lost response returns the
original conversation rather than starting another agent.

Inbox filters cover all conversations, unread updates, questions, review and working tasks. Search matches titles,
current previews and mission names. Every managed ticket can appear, including repository work. A conversation shows
the original request, follow-ups, visible Harness text, status reports, a current question and linked library records.
Mission, execution and full Harness Session navigation remain available.

Replies to the current action of an active local mission enter through the same Workspace/Engine authorization path
as mission steering. A follow-up on a result resumes its existing ticket under the original mandate; it does not grant
broader scope or start a second worker. While a follow-up waits, the earlier result cannot be accepted or the mission
archived or launched again. The mission and execution controls can stop a queued follow-up even while processing is paused;
this withdraws its mandate and cancels those pending messages without rerouting them into new work. Explicitly stopped
tickets remain stopped. Closed missions must be reopened, and older runs or externally
originated conversations use their mission or original Session rather than acquiring a fabricated external identity.

Reading a conversation does not send a message, clear a question, accept a result or restart work. **Mark read** records
the exact update revision displayed. A late acknowledgement cannot hide a newer message or question, and reading a
question does not resolve it. Completion still requires explicit review in the mission.

## Persistence and boundaries

The existing SQLite database holds `workspace_inbox_read`, `workspace_inbox_command` and
`workspace_inbox_message`. Mutation receipts commit with the Workspace and Engine transaction. A reused request ID with
different content is refused; retries check the receipt before the current revision, covering a response lost after commit.
The UI retains the original request body and ID across ambiguous failures even when polling sees a newer revision.

Harness remains authoritative for Sessions. The inbox stores a display projection of append-origin assistant text and
direct user text, deduplicated by message identity. Message identity also distinguishes new messages if a lost Session is
recreated with sequence numbers starting over. Tool payloads, reasoning, injected system context and compaction
replacements are omitted. Original source inputs and current assignment reports come from the Engine store.

Visible messages are captured from Harness events. The first conversation read after process startup backfills persisted
history through the Harness controller; concurrent readers share that request, and successful backfills are not repeated
on each poll. The controller inspection has a 15-second deadline. If it fails, domain state and saved message projections
remain readable and the UI reports unavailable history. A later read retries. This is a projection, not a second agent
runtime or a separate source of authorization.

Responses contain at most 50 messages, with 8,000 characters per message and explicit truncation markers. Full messages
and tool history remain in the Harness Session. Older pages use an `(at, id)` cursor so newer arrivals do not shift an
offset-based history window. The current status report may change as work advances. Lists contain at most 50 rows; the
current implementation filters managed ticket state in memory and the initial Harness inspection reads the full log.
Large histories, projection retention, indexed search across all messages, cross-workspace enrollment and remote users
remain scalability/product work; the loopback single-owner API is not multi-user authentication.

| API relative to `/orchestrator/api/` | Purpose |
| --- | --- |
| `GET inbox?filter=questions&q=brief` | Filtered/paged conversations and unread/question/review counts |
| `POST inbox` | Atomically create and run a task from `text`, optional `title`, and `requestId` |
| `GET inbox/:id?before=...&limit=30` | Conversation text, current state, history cursor and artifact links |
| `POST inbox/:id/read` | Mark the supplied `revision` read without changing the work |
| `POST inbox/:id/reply` | Authorized steering using `requestId`, rendered `revision`, and `text` |

## Verification

Tests exercise actual management routes and the Harness adapter with simulated inference: atomic dispatch, database
reopening, exact read receipts, newer questions, reply replay, stopped/disabled work, ready-result follow-ups, queued
follow-up review/cancellation protection, history paging, text projection and unavailable history. Rendered form tests start a task,
answer a question through a deliberately lost HTTP response, verify one committed reply, and navigate to the published
artifact and mission. They also check literal HTML handling and stopped-work controls.

Actual provider and process qualification is recorded in the Agentic OS ledger. DOM tests do not establish browser or
desktop layout acceptance, and this increment does not complete the full architecture.

2026-11-08 live qualification used the actual `@deepseek-ai/dsh@0.2.1-rc.3` host with
`deepseek-official/deepseek-flash` in local mode. Mission `53aa8cb5-368a-44a9-a5b9-c72565b338b4` and ticket
`78fc7b6273c6311d1f06ecb8ba4d1ed6` exercised a model-generated JSON-or-Markdown question, mark-read without clearing
the question, an idempotently replayed JSON answer, and a follow-up on the completed result. The original file contained
values `[2,4,6]`, total `12` and format `json`; the revision added count `3` under the same ticket's second assignment.

| Evidence | Identity / SHA-256 |
| --- | --- |
| Original artifact | `964193c4-2d7e-4a4e-be92-7a31cc338a8b` |
| Original exact bytes | `eb295dfd2d585e6bd806cf1233020202e8f262252ff41649604e5946b730df7a` |
| Revised artifact, superseding the original | `2e43d553-defe-40de-81ca-fcd1988e2d80` |
| Revised exact bytes | `45f5316f2596d094e30c992d3f280528bdb2f7d83a7bea453436d34bec41506f` |

An independent check read the local JSON and compared it byte-for-byte with the publication, checked its SHA-256 and
revision provenance, then accepted the action and completed the mission through the management API. With the executor
idle, the process was stopped and restarted against the same profile. The eight conversation messages, exact read
revision, completed mission and artifact content/hash survived. Replaying both prior reply requests returned the same
conversation without starting a third assignment. This qualifies one provider and a small local workflow; it does not
establish remote execution, multi-user isolation, large-history capacity or browser layout acceptance.
